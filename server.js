/**
 * server.js — Node 混合端：静态页面 + MySQL 数据注入
 *
 * 背景：原先纯静态 HTML 靠 <script src="*.json.js?t=..."> 加载数据，
 * 每次打开页面都要额外请求 300KB~800KB 的 JSON 脚本（无压缩、多次往返），加载很慢。
 *
 * 改为 Node 服务后：
 *   1. HTML/CSS/JS/图片仍按静态文件提供，file:// 双击打开照常可用；
 *   2. 数据存 MySQL 8.0（schema.sql 建表），启动时从库读出并按源 JSON 的
 *      形状逐字节重建（data-service.js），响应页面时直接内联注入
 *      <script>window.XXX = {...}</script>，页面只需一次请求；
 *   3. 文本响应 gzip 压缩（大 JSON 压缩率约 85%），静态资源带 ETag 缓存头；
 *   4. 每 5 秒轮询 dataset_meta 表：爬虫（data.js / account-info.js /
 *      waigua-info.js 等）写入新数据并 bump 元信息后，自动重建注入文本，
 *      页面下次请求即为新数据。读取失败保留旧数据继续服务，不会因坏数据下线。
 *   5. OCR 识别已拆分到独立服务 ocr_worker.js（默认 127.0.0.1:3002）：
 *      本进程只负责接收图片、转交任务并立即返回任务号，排队与识别全部
 *      发生在 OCR 进程内，页面请求不再被识别拖住。
 *   6. shenmi 专属接口（/api/ocr*、/api/price）统一要求暗号头 X-Shenmi-Code，
 *      防止绕过 shenmi.html 直接刷接口；暗号由环境变量 SHENMI_CODE 配置，
 *      默认 zhuzhu（页面解锁校验走 /api/shenmi/verify）。
 *   7. 站点累计统计存 site_stats 表：GET /api/stats 读内存副本，
 *      每次识别请求内存 +1 并异步 UPDATE 落库（原子自增，免整文件写）。
 *   8. 经验收益上报：PC 端挂机程序每段采集结束 POST /api/exp/report 一次，
 *      存 exp_reports 表（INSERT 成功才进内存，内存=库一致；含 snapshot 原始体）；
 *      exp.html 轮询 GET /api/exp/reports 展示。防刷靠按设备/IP 限频、
 *      字段校验、服务端重算每小时收益（不信任客户端算好的 expPerHour 等）。
 *   9. 经验上报 v2（/api/v2/exp/*）：新版工具协议，体精简为经验/h+地图等，
 *      新增备注/攻击力，不再上报金币/药水；JWT 鉴权（HS256，sub=设备ID，2h），
 *      服务端签发（EXP_JWT_SECRET 验签 + EXP_DEVICE_SECRET 换 token）。
 *      exp.html 带 ?token= 打开可编辑/删除「本设备」上报的记录（PATCH/DELETE /api/v2/exp/report）。
 *
 * 用法：node server.js（PORT 环境变量可改端口，默认 3001）+ node ocr_worker.js（OCR 服务）
 * 连接：MYSQL_HOST/PORT/USER/PASSWORD/DATABASE 环境变量（服务器在 pm2 env 配置），
 *       本地未设置时走 db.js 的开发默认值。首次启动前先跑 schema.sql 建库。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { searchGoodsAll } from "./gmmsj.mjs";
import { q, qOne, tx, bulkUpsert, toDbVal } from "./db.js";
import { loadDatasetText, rowToExpReport } from "./data-service.js";
import { EXP_COLS, toExpRow, PRICE_COLS, PRICE_UPD, toPriceRow } from "./db-rows.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || "0.0.0.0"; // 部署时经 nginx 反代应设为 127.0.0.1（见 ecosystem.config.cjs）
const SHENMI_CODE = process.env.SHENMI_CODE || "zhuzhu"; // shenmi 暗号：页面解锁与 /api/ocr*、/api/price 校验用

/* ---------------- MySQL 数据源 ---------------- */

/** 数据集注册表：dataset 名 → 注入浏览器的全局变量名（与 *.json.js 里的变量名一致） */
const DATA_FILES = {
  mobs: "RANK_DATA",
  mob_drops: "RANK_EQUIPMENT",
  accounts: "ACCOUNT_DATA",
  waigua_history: "WAIGUA_HISTORY",
  waigua_today: "WAIGUA_TODAY",
};

/** 每个页面注入哪些数据（顺序即注入顺序） */
const PAGE_INJECTS = {
  "rank.html": ["mobs", "mob_drops"],
  "account.html": ["accounts"],
  "waigua.html": ["waigua_history", "waigua_today"],
};

/** 内存缓存：dataset → { global, text, updatedAt, metaUpdatedAt } */
const store = new Map();

const REFRESH_INTERVAL_MS = 5000; // dataset_meta 轮询间隔：小时级更新数据 5s 足够

/**
 * 从库重建全部注入数据集的文本。只重载 dataset_meta.updated_at 有变化的数据集；
 * 载入失败保留旧数据继续服务（与旧 watchFile 时代「坏文件不下线」同一哲学）。
 */
async function refreshDatasets() {
  let metas;
  try {
    metas = await q(`SELECT dataset, updated_at FROM dataset_meta`);
  } catch (err) {
    console.error(`[data] dataset_meta 查询失败：${err.message}`);
    return;
  }
  for (const [dataset, global] of Object.entries(DATA_FILES)) {
    const meta = metas.find((m) => m.dataset === dataset);
    const metaTs = meta ? new Date(meta.updated_at).getTime() : 0;
    const cached = store.get(dataset);
    if (cached && cached.metaUpdatedAt === metaTs) continue;
    try {
      const text = await loadDatasetText(dataset);
      store.set(dataset, { global, text, updatedAt: Date.now(), metaUpdatedAt: metaTs });
      console.log(
        `[data] ${dataset} → window.${global} 已载入内存` +
        `（注入文本 ${(text.length / 1024).toFixed(0)} KB）`,
      );
    } catch (err) {
      console.error(
        `[data] ${dataset} 载入失败：${err.message} —— ` +
        (cached ? "继续使用内存中的旧数据" : "该数据暂不可用"),
      );
    }
  }
}

await refreshDatasets(); // 启动即全量载入
setInterval(refreshDatasets, REFRESH_INTERVAL_MS);

/* ---------------- HTTP 服务 ---------------- */

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
};

/** 可 gzip 的内容类型（在 respond 里按类型判断） */
const COMPRESSIBLE = new Set([
  ".html",
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".map",
  ".svg",
  ".txt",
  ".log",
]);

/** 缓存策略：
 *  html 内联数据必须每次重验证（ETag 命中 → 304，开销极小）；
 *  图片基本不变缓存一天；css/js/json 改动频繁，no-cache 每次都重验证 */
function cacheControlFor(ext) {
  if (ext === ".html") return "no-cache";
  if (ext === ".png" || ext === ".ico" || ext === ".svg") return "public, max-age=86400";
  // 静态代码文件改动频繁：no-cache 让浏览器每次都拿 ETag 重验证
  //（未变则 304 不传内容，变了立刻生效），不会再出现「改了文件刷新还是旧的」
  return "no-cache";
}

/** 页面 gzip 产物缓存（页面只有 3 个，按 ETag 复用压缩结果，避免每次请求重复压缩大 JSON） */
const gzipCache = new Map();

/* ---------------- OCR（转交独立服务 ocr_worker.js） ----------------
 * 原来 OCR 在本进程内排队执行：排队期间 HTTP 请求一直挂起（浏览器 Pending），
 * 且 python + onnxruntime 的 CPU/内存压力与页面服务同进程，高峰时站点整体变卡。
 * 现已拆分：本进程只负责接收图片、转交独立 OCR 服务（默认 127.0.0.1:3002）并
 * 立即返回任务号，页面轮询 /api/ocr/result 拿结果；排队与识别完全发生在
 * OCR 进程内，不再影响页面/数据请求的响应速度。 */

const OCR_HOST = "127.0.0.1"; // OCR 独立服务地址（同机 ocr_worker.js，不对外）
const OCR_PORT = Number(process.env.OCR_PORT) || 3002; // 与 ocr_worker.js 的 PORT 对应
const OCR_LIMIT = 10 * 1024 * 1024; // 图片上限 10MB（上传到本进程时先拦一道）

/** /api/* 接口的 CORS 头：file:// 双击打开页面时也能跨域调用本地服务 */
const API_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS", // PATCH/DELETE 供 exp v2 编辑/删除上报用
  // Authorization 参与预检：exp v2 的 JWT 鉴权（file:// 跨域需要）
  "Access-Control-Allow-Headers": "Content-Type, X-Shenmi-Code, Authorization, X-Exp-Device-Secret",
};

/** 校验请求携带的 shenmi 暗号头是否与配置一致 */
function checkShenmiCode(req) {
  return req.headers["x-shenmi-code"] === SHENMI_CODE;
}

/** 暗号不匹配的统一 403 应答 */
function rejectShenmiCode(req, res) {
  respond(req, res, {
    status: 403,
    type: "application/json; charset=utf-8",
    headers: API_CORS,
    body: Buffer.from(JSON.stringify({ ok: false, error: "暗号错误" })),
  });
}

/** GET /api/shenmi/verify：页面解锁前用它确认暗号（本接口本身不校验暗号，避免死锁） */
function handleShenmiVerify(req, res) {
  respond(req, res, {
    type: "application/json; charset=utf-8",
    headers: API_CORS,
    body: Buffer.from(JSON.stringify({ ok: checkShenmiCode(req) })),
  });
}

/** 读请求体（限长，超限即断连） */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`图片过大（上限 ${Math.round(limit / 1024 / 1024)}MB）`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** 调用 OCR 服务（JSON 接口，超时即失败）；返回 { status, body } */
function ocrServiceRequest(pathname, { method = "GET", body = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (body) {
      headers["Content-Type"] = "application/octet-stream";
      headers["Content-Length"] = String(body.length);
    }
    const req = http.request(
      { host: OCR_HOST, port: OCR_PORT, path: pathname, method, headers },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > 1024 * 1024) {
            // 响应只是几百字节的 JSON，超 1MB 视为异常
            req.destroy();
            return reject(new Error("OCR 服务响应异常"));
          }
          chunks.push(c);
        });
        res.on("end", () => {
          let j;
          try {
            j = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          } catch {
            return reject(new Error("OCR 服务响应解析失败"));
          }
          resolve({ status: res.statusCode, body: j });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("OCR 服务响应超时")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 把 OCR 服务的响应原样回给浏览器（status 一并透传） */
function relayOcr(req, res, r) {
  respond(req, res, {
    status: r.status,
    type: "application/json; charset=utf-8",
    headers: API_CORS,
    body: Buffer.from(JSON.stringify(r.body)),
  });
}

/** OCR 服务不可用（进程没起 / 超时）时的统一 502 应答 */
function respondOcrDown(req, res, err) {
  console.error(`[ocr] OCR 服务调用失败：${err.message}`);
  respond(req, res, {
    status: 502,
    type: "application/json; charset=utf-8",
    headers: API_CORS,
    body: Buffer.from(
      JSON.stringify({ ok: false, error: "OCR 识别服务不可用" }),
    ),
  });
}

/** POST /api/ocr：接收图片 → 转交 OCR 服务入队 → 立即返回任务号（页面轮询结果） */
function handleOcr(req, res) {
  readBody(req, OCR_LIMIT)
    .then((buf) => {
      if (!buf.length) throw Object.assign(new Error("请求体为空"), { status: 400 });
      return ocrServiceRequest("/task", { method: "POST", body: buf }).then((r) => {
        // OCR 服务入队成功（拿到任务号）才算一次识别请求
        if (r.status === 200 && r.body && r.body.ok) bumpTotalRequests();
        relayOcr(req, res, r);
      });
    })
    .catch((err) => {
      if (err.status || err.message.includes("图片过大")) {
        // 本地校验失败（空请求体 / 图片过大），与 OCR 服务无关
        return respond(req, res, {
          status: err.status || 413,
          type: "application/json; charset=utf-8",
          headers: API_CORS,
          body: Buffer.from(JSON.stringify({ ok: false, error: err.message })),
        });
      }
      respondOcrDown(req, res, err);
    });
}

/** GET /api/ocr/result?id=：查询任务结果（queued 排队中 / running 识别中 / done 完成 / error 失败） */
function handleOcrResult(req, res) {
  const id = new URL(req.url, "http://localhost").searchParams.get("id") || "";
  ocrServiceRequest("/task?id=" + encodeURIComponent(id)).then(
    (r) => relayOcr(req, res, r),
    (err) => respondOcrDown(req, res, err),
  );
}

/** GET /api/ocr/queue：查询 OCR 全局队列状态（是否识别中 / 几人排队） */
function handleOcrQueue(req, res) {
  ocrServiceRequest("/queue").then(
    (r) => relayOcr(req, res, r),
    (err) => respondOcrDown(req, res, err),
  );
}

/* ---------------- 询价（GET /api/price?keyword=，gmmsj 商品搜索） ---------------- */

// MySQL 当缓存库：30 分钟内的查询直接读缓存，不再翻页轰炸 gmmsj；
// 持久化到 price_cache 表，重启服务后启动时读回 TTL 内的记录继续生效。
// 写库策略：内存 LRU 为主、变更标脏，周期批量 upsert（本质是缓存，
// 最坏丢一个周期 30s）；LRU 淘汰只删内存，表内过期行由 TTL 过滤天然忽略。
const PRICE_CACHE_TTL_MS = 30 * 60 * 1000; // 缓存有效期 30 分钟
const PRICE_CACHE_MAX = 200; // 内存上限，超出时先清过期、再丢最旧的
const PRICE_FLUSH_INTERVAL_MS = 30 * 1000; // 落库周期
const priceCache = new Map(); // keyword → { t, lowest, avg, count, totalPage }
let priceCacheDirty = false; // 有变更待落库

/** 启动时读回库内缓存（仅保留 30 分钟内的记录） */
async function loadPriceCache() {
  try {
    const rows = await q(
      `SELECT keyword, t, lowest, avg, count, total_page FROM price_cache WHERE t > ?`,
      [Date.now() - PRICE_CACHE_TTL_MS],
    );
    for (const r of rows) {
      priceCache.set(r.keyword, {
        t: Number(r.t),
        lowest: r.lowest == null ? null : Number(r.lowest),
        avg: r.avg == null ? null : Number(r.avg),
        count: r.count,
        totalPage: r.total_page,
      });
    }
    console.log(`[price] 询价缓存载入 ${priceCache.size} 条（30 分钟内直接复用）`);
  } catch (err) {
    console.error(`[price] price_cache 读取失败：${err.message}，从空缓存开始`);
  }
}

/** 批量落库（幂等 upsert；失败标回脏，下个周期再试） */
async function flushPriceCache() {
  if (!priceCacheDirty || !priceCache.size) return;
  priceCacheDirty = false;
  try {
    const rows = [...priceCache.entries()].map(([k, v]) => toPriceRow(k, v));
    await tx((conn) => bulkUpsert(conn, "price_cache", PRICE_COLS, rows, PRICE_UPD));
  } catch (err) {
    priceCacheDirty = true; // 下个周期再试
    console.error(`[price] 缓存落库失败：${err.message}`);
  }
}

/** 聚合某个关键词的全部在售：最低价 / 均价 / 在售数量 */
async function queryPrice(keyword) {
  const hit = priceCache.get(keyword);
  if (hit && Date.now() - hit.t < PRICE_CACHE_TTL_MS) return hit; // 缓存命中，直接返回

  const { goodsList, totalPage } = await searchGoodsAll(keyword);
  const prices = goodsList
    .map((g) => Number(String(g.price ?? "").replace(/[^\d.]/g, ""))) // "1,750.00" → 1750
    .filter((n) => Number.isFinite(n) && n > 0);
  const data = {
    t: Date.now(),
    lowest: prices.length ? Math.min(...prices) : null,
    avg: prices.length ? Math.round((prices.reduce((s, n) => s + n, 0) / prices.length) * 100) / 100 : null,
    count: goodsList.length,
    totalPage,
  };
  priceCache.set(keyword, data);
  priceCacheDirty = true; // 周期批量落库，不在此处阻塞接口
  // 上限维护：先清过期，仍超则丢最旧的
  for (const [k, v] of priceCache) {
    if (Date.now() - v.t >= PRICE_CACHE_TTL_MS) priceCache.delete(k);
  }
  if (priceCache.size > PRICE_CACHE_MAX) {
    const oldest = [...priceCache.entries()]
      .sort((a, b) => a[1].t - b[1].t)
      .slice(0, priceCache.size - PRICE_CACHE_MAX);
    for (const [k] of oldest) priceCache.delete(k);
  }
  return data;
}

await loadPriceCache(); // 启动即读回缓存（模块加载顺序上位于各函数定义之后）
setInterval(flushPriceCache, PRICE_FLUSH_INTERVAL_MS);
// 进程退出前同步 flush 一次（幂等 upsert，pm2 重启场景少丢缓存）
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    flushPriceCache().finally(() => process.exit(0));
  });
}

/** 并发受控队列：一张图最多 5 个装备同时询价，并发 3 个对接口保持克制 */
let priceActive = 0;
const PRICE_CONCURRENCY = 3;
const priceQueue = [];
function enqueuePrice(keyword) {
  return new Promise((resolve, reject) => {
    priceQueue.push({ keyword, resolve, reject });
    pumpPrice();
  });
}
function pumpPrice() {
  while (priceActive < PRICE_CONCURRENCY && priceQueue.length) {
    const { keyword, resolve, reject } = priceQueue.shift();
    priceActive++;
    queryPrice(keyword)
      .then(resolve, reject)
      .finally(() => {
        priceActive--;
        pumpPrice();
      });
  }
}

function handlePrice(req, res) {
  const keyword = (new URL(req.url, "http://localhost").searchParams.get("keyword") || "").trim();
  if (!keyword) {
    return respond(req, res, {
      status: 400,
      type: "application/json; charset=utf-8",
      headers: API_CORS,
      body: Buffer.from(JSON.stringify({ ok: false, error: "缺少 keyword 参数" })),
    });
  }
  enqueuePrice(keyword)
    .then((data) => {
      respond(req, res, {
        type: "application/json; charset=utf-8",
        headers: API_CORS,
        body: Buffer.from(JSON.stringify({ ok: true, keyword, ...data })),
      });
    })
    .catch((err) => {
      console.error(`[price] 询价失败（${keyword}）：${err.message}`);
      respond(req, res, {
        status: 502,
        type: "application/json; charset=utf-8",
        headers: API_CORS,
        body: Buffer.from(JSON.stringify({ ok: false, error: err.message })),
      });
    });
}

/* ---------------- 经验收益上报（PC 端 → POST /api/exp/report） ----------------
 * PC 端挂机程序（nodejs）每结束一段采集周期就 POST 一次收益快照，存进
 * exp_reports 表当数据库（含 snapshot 原始上报体）；exp.html 轮询
 * GET /api/exp/reports 展示表格。防刷两道闸：
 *   1. 同设备 / 同 IP 两次上报的最短间隔限频（EXP_MIN_INTERVAL_MS）；
 *   2. 服务端重算：不信任客户端算好的 expPerHour / goldPerHour，只取 delta
 *      原始差值按上报的实际刷怪时长（暂停不计入）自己换算，并对时长、
 *      时间戳、每小时收益上限做边界校验，异常数据直接拒绝。 */

const EXP_BODY_LIMIT = 64 * 1024; // 上报体上限 64KB（正常一帧约 1.5KB）
const EXP_MIN_INTERVAL_MS = 5000; // 同设备 / 同 IP 两次上报的最短间隔
const EXP_MAX_DURATION_S = 6 * 3600; // 单段采集时长上限 6 小时
const EXP_MAX_PER_HOUR = 1e9; // 每小时经验上限（伪造兜底，正常值远低于此）
const GOLD_MAX_PER_HOUR = 1e10; // 每小时金币上限
const POTION_MAX_PER_HOUR = 1e9; // 每小时药水钱上限

/** 单条上报落库（INSERT 成功才算入库，内存数组与库保持一致） */
async function insertExpReport(report, snapshotObj) {
  const cols = EXP_COLS.join(", ");
  const marks = EXP_COLS.map(() => "?").join(",");
  await q(
    `INSERT INTO exp_reports (${cols}) VALUES (${marks})`,
    toExpRow(report, snapshotObj), // snapshot 存校验前的原始上报体
  );
}

let expReports = []; // 最新在数组尾；与 exp_reports 表 ORDER BY seq 同序
const expLastDevice = new Map(); // deviceId → 上次成功上报的时间戳
const expLastIp = new Map(); // 来源 IP → 上次成功上报的时间戳

/** 生成单条记录的唯一 id（分享链接用）：时间戳 36 进制 + 随机后缀，撞了重生成 */
function newExpId() {
  let id;
  do {
    id = Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
  } while (expReports.some((r) => r.id === id));
  return id;
}

/** 启动时读回库内上报记录（seq 自增序即源数组顺序） */
async function loadExpReports() {
  try {
    const rows = await q(`SELECT * FROM exp_reports ORDER BY seq ASC`);
    expReports = rows.map(rowToExpReport); // 全部保留，不设上限（量大卡顿再优化）
    console.log(`[exp] 载入历史上报 ${expReports.length} 条`);
  } catch (err) {
    console.error(`[exp] exp_reports 读取失败：${err.message}，从空库开始`);
  }
}

/** 限频表简单上限：条目过多（大量伪造 deviceId）时整体清空，防内存膨胀 */
function pruneRateMap(map) {
  if (map.size > 5000) map.clear();
}

/** 字段校验 + 服务端重算每小时收益；返回 { ok, error?, report? } */
function buildExpRecord(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "请求体不是对象" };
  const str = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
  const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  const num = (v, min) => typeof v === "number" && Number.isFinite(v) && v >= min;

  if (!str(body.deviceId, 64) || !/^[0-9a-zA-Z_-]+$/.test(body.deviceId)) return { ok: false, error: "deviceId 非法" };
  if (!int(body.level, 1, 300)) return { ok: false, error: "level 非法" };
  if (!str(body.job, 32)) return { ok: false, error: "job 非法" };
  if (!int(body.mapId, 0, 1e9)) return { ok: false, error: "mapId 非法" };
  if (!str(body.mapName, 64)) return { ok: false, error: "mapName 非法" };
  if (!/^[a-z]{1,16}$/i.test(String(body.partyMode || ""))) return { ok: false, error: "partyMode 非法" };

  // v1 兼容 v2 新增的可选属性（备注 / 攻击力-魔法力）：公共页手录可填，空串视为无
  const np = validateNotePower(body);
  if (!np.ok) return np;

  const start = Date.parse(body.startTime);
  const end = Date.parse(body.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { ok: false, error: "时间格式非法" };
  if (end <= start) return { ok: false, error: "endTime 必须晚于 startTime" };
  if (end - Date.now() > 5 * 60 * 1000) return { ok: false, error: "结束时间在未来" };

  const duration = body.durationSeconds;
  if (!num(duration, 1) || duration > EXP_MAX_DURATION_S) return { ok: false, error: "durationSeconds 非法" };
  // 暂停功能：客户端暂停时墙钟时间（时间戳差值）会大于实际刷怪时长，
  // 二者不一致属正常，不再比对；只要求时间戳差值本身 ≥ 1 秒（防垃圾数据）
  const realSeconds = (end - start) / 1000;
  if (realSeconds < 1) return { ok: false, error: "时间戳间隔过短" };

  const d = body.delta || {};
  if (!num(d.gold, 0)) return { ok: false, error: "delta.gold 非法" };
  if (!int(d.hpPotionUsed, 0, 1e6)) return { ok: false, error: "delta.hpPotionUsed 非法" };
  if (!int(d.mpPotionUsed, 0, 1e6)) return { ok: false, error: "delta.mpPotionUsed 非法" };
  if (!num(d.expGained, 0)) return { ok: false, error: "delta.expGained 非法" };
  if (!int(d.levelsGained, 0, 100)) return { ok: false, error: "delta.levelsGained 非法" };

  // 客户端新增字段：分瓶种药水花费；旧版客户端缺省按 0
  const p = body.profit || {};
  const potionHpValue = p.potionHpValue === undefined ? 0 : p.potionHpValue;
  const potionMpValue = p.potionMpValue === undefined ? 0 : p.potionMpValue;
  if (!num(potionHpValue, 0) || !num(potionMpValue, 0)) return { ok: false, error: "profit 药水金额非法" };
  const potionValue = num(p.potionValue, 0) ? p.potionValue : potionHpValue + potionMpValue;

  // 服务端重算每小时收益（不信任客户端算好的 expPerHour / goldPerHour）；
  // 统一用上报的实际刷怪时长（暂停不计入），墙钟时间不可靠
  const perHour = (v) => Math.round((v / duration) * 3600);
  const expPerHour = perHour(d.expGained);
  const goldPerHour = perHour(d.gold);
  const potionHpPerHour = perHour(potionHpValue);
  const potionMpPerHour = perHour(potionMpValue);

  // 伪造兜底：每小时收益超过物理上限的一律拒绝
  if (expPerHour > EXP_MAX_PER_HOUR) return { ok: false, error: "经验/h 超出上限" };
  if (goldPerHour > GOLD_MAX_PER_HOUR) return { ok: false, error: "金币/h 超出上限" };
  if (potionHpPerHour > POTION_MAX_PER_HOUR || potionMpPerHour > POTION_MAX_PER_HOUR) {
    return { ok: false, error: "药水钱/h 超出上限" };
  }

  return {
    ok: true,
    report: {
      id: newExpId(), // 单条记录唯一 id：客户端分享 exp.html?id=xxx 只看这一条
      deviceId: body.deviceId,
      level: body.level,
      job: body.job,
      mapId: body.mapId,
      mapName: body.mapName,
      partyMode: body.partyMode,
      startTime: body.startTime,
      endTime: body.endTime,
      durationSeconds: duration, // 入库实际刷怪时长（客户端上报，暂停不计入）
      delta: {
        gold: d.gold,
        hpPotionUsed: d.hpPotionUsed,
        mpPotionUsed: d.mpPotionUsed,
        expGained: d.expGained,
        levelsGained: d.levelsGained,
      },
      profit: {
        expPerHour,
        goldPerHour,
        potionValue,
        potionHpValue,
        potionMpValue,
        potionHpPerHour,
        potionMpPerHour,
      },
      note: np.note,
      power: np.power,
      serverTime: new Date().toISOString(),
    },
  };
}

/** 可选属性校验（v1/v2 共用）：备注 note(≤500，空串→null) + 攻击力/魔法力 power(int 0~1e9，可缺省) */
function validateNotePower(body) {
  let note = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== "string" || body.note.length > 500) return { ok: false, error: "note 非法" };
    note = body.note.trim() === "" ? null : body.note;
  }
  let power = null;
  if (body.power !== undefined && body.power !== null) {
    if (!Number.isInteger(body.power) || body.power < 0 || body.power > 1e9) return { ok: false, error: "power 非法" };
    power = body.power;
  }
  return { ok: true, note, power };
}

/** POST /api/exp/report：PC 端上报一段采集周期的收益（限频 + 校验重算） */
function handleExpReport(req, res) {
  const reply = (status, payload) =>
    respond(req, res, {
      status,
      type: "application/json; charset=utf-8",
      headers: API_CORS,
      body: Buffer.from(JSON.stringify(payload)),
    });

  // IP 限频放在读体之前：同 IP 高频请求连体都不读，直接拒
  const ip = req.socket.remoteAddress || "";
  const now = Date.now();
  if (now - (expLastIp.get(ip) || 0) < EXP_MIN_INTERVAL_MS) {
    console.log(`[exp] 拒绝：IP 限频 ip=${ip}（距上次成功上报 ${now - expLastIp.get(ip)}ms，最小间隔 ${EXP_MIN_INTERVAL_MS}ms）`);
    return reply(429, { ok: false, error: "上报过于频繁" });
  }

  readBody(req, EXP_BODY_LIMIT)
    .then(async (buf) => {
      let body;
      try {
        body = JSON.parse(buf.toString("utf-8"));
      } catch {
        console.log(`[exp] 拒绝：请求体不是合法 JSON ip=${ip} | 前 120 字符=${JSON.stringify(buf.toString("utf-8").slice(0, 120))}`);
        return reply(400, { ok: false, error: "请求体不是合法 JSON" });
      }
      const r = buildExpRecord(body);
      if (!r.ok) {
        // 调试日志：失败原因 + 原始请求体（截断 400 字符），方便排查客户端问题
        console.log(`[exp] 拒绝：${r.error} ip=${ip} | 请求体=${JSON.stringify(body).slice(0, 400)}`);
        return reply(400, { ok: false, error: r.error });
      }

      // 设备限频放在校验通过后：伪造 deviceId 过不了校验，连不上限频记录
      const lastDevice = expLastDevice.get(r.report.deviceId) || 0;
      if (now - lastDevice < EXP_MIN_INTERVAL_MS) {
        console.log(`[exp] 拒绝：设备限频 deviceId=${r.report.deviceId}（距上次成功上报 ${now - lastDevice}ms，最小间隔 ${EXP_MIN_INTERVAL_MS}ms）`);
        return reply(429, { ok: false, error: "上报过于频繁" });
      }

      // 先落库，成功才进内存（内存=库一致）；snapshot 存校验前的原始上报体供审计
      try {
        await insertExpReport(r.report, body);
      } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
          // 极低概率撞 id：重生成重试一次
          r.report.id = newExpId();
          try {
            await insertExpReport(r.report, body);
          } catch (err2) {
            console.error(`[exp] 落库失败（重试后）：${err2.message} ip=${ip}`);
            return reply(500, { ok: false, error: "上报存储失败" });
          }
        } else {
          console.error(`[exp] 落库失败：${err.message} ip=${ip}`);
          return reply(500, { ok: false, error: "上报存储失败" });
        }
      }
      expReports.push(r.report);
      expLastDevice.set(r.report.deviceId, now);
      expLastIp.set(ip, now);
      pruneRateMap(expLastDevice);
      pruneRateMap(expLastIp);
      console.log(
        `[exp] 入库：${r.report.id} ${r.report.deviceId} Lv${r.report.level} ${r.report.mapName} ` +
        `+${r.report.delta.expGained}经验 +${r.report.delta.gold}金币（${r.report.durationSeconds}s）`,
      );
      // id 是本条记录的唯一 id：客户端拼分享链接 exp.html?id=xxx，只看这一条
      reply(200, { ok: true, id: r.report.id, report: r.report });
    })
    .catch((err) => {
      console.error(`[exp] 上报处理失败：${err.message} ip=${ip}`);
      if (!res.headersSent) reply(413, { ok: false, error: "请求体过大或连接中断" });
    });
}

/* ---------------- 经验上报 v2（/api/v2/exp/*：JWT 鉴权，sub=设备ID） ----------------
 * v2 是新版 PC 工具协议：上报体精简为「经验/h + 职业/等级/地图/组队 + 备注/攻击力/测试时长」，
 * 不再上报金币与药水（对应 DB 列留 NULL）；鉴权用服务端签发的 JWT（HS256，默认 2h，
 * payload.sub = 设备ID）。endpoints：
 *   POST /api/v2/exp/token   设备密钥头 X-Exp-Device-Secret 换 JWT（PC 工具内置该密钥）
 *   GET  /api/v2/exp/session  校验 JWT → sub（exp.html 据此点亮对应设备行的编辑按钮）
 *   POST /api/v2/exp/report   用 JWT 上报一条 v2 记录（device_id 取 sub，不信 body）
 *   PATCH /api/v2/exp/report  用 JWT 编辑一条「本设备」上报的记录（id/device/时间/审计不可改）
 * 密钥来自环境变量，缺省为开发值并告警——生产务必在 server.env 设置强随机密钥。 */
const EXP_JWT_SECRET = process.env.EXP_JWT_SECRET || "dev-exp-jwt-secret";
const EXP_DEVICE_SECRET = process.env.EXP_DEVICE_SECRET || "zhuzhu";
const EXP_TOKEN_TTL_S = 2 * 3600; // JWT 有效期 2 小时
const EXP_V2_BODY_LIMIT = 32 * 1024; // v2 上报体上限（精简体）
if (EXP_JWT_SECRET === "dev-exp-jwt-secret" || EXP_DEVICE_SECRET === "zhuzhu") {
  console.warn("[exp] ⚠️ 正在使用开发默认 EXP_JWT_SECRET / EXP_DEVICE_SECRET，生产请在 server.env 设置强随机密钥");
}

/** base64url 编解码（Node 16+ Buffer 原生支持） */
function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}
function b64urlToBuf(str) {
  return Buffer.from(str, "base64url");
}

/** 签发 JWT：sub=deviceId，默认 2 小时有效，HS256 签名 */
function signExpToken(deviceId, ttlS = EXP_TOKEN_TTL_S) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ sub: deviceId, iat: now, exp: now + ttlS }));
  const sig = crypto.createHmac("sha256", EXP_JWT_SECRET).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64url(sig)}`;
}

/** 验签 JWT → payload 或 null（三段结构 / 算法 / 常量时间比对 / 有效期 / sub 形状） */
function verifyExpToken(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(b64urlToBuf(parts[0]).toString("utf-8"));
    payload = JSON.parse(b64urlToBuf(parts[1]).toString("utf-8"));
  } catch {
    return null;
  }
  if (!header || header.alg !== "HS256") return null;
  const sig = crypto.createHmac("sha256", EXP_JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest();
  const given = b64urlToBuf(parts[2]);
  if (sig.length !== given.length || !crypto.timingSafeEqual(sig, given)) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;
  if (typeof payload.sub !== "string" || !/^[0-9a-zA-Z_-]{1,64}$/.test(payload.sub)) return null;
  return payload;
}

/** 从 Authorization: Bearer <token> 验签 → payload 或 null */
function authExpBearer(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  return verifyExpToken(m[1].trim());
}

/** v2 系列 handler 的 JSON 应答统一出口 */
function v2Reply(req, res, status, payload) {
  respond(req, res, {
    status,
    type: "application/json; charset=utf-8",
    headers: API_CORS,
    body: Buffer.from(JSON.stringify(payload)),
  });
}

/** 校验 + 组装 v2 上报记录（deviceId 取 JWT sub；金币/药水等 v2 不涉及的字段一律 null） */
function buildExpV2Record(sub, body) {
  const str = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
  const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  const num = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

  if (!int(body.level, 1, 300)) return { ok: false, error: "level 非法" };
  if (!str(body.job, 32)) return { ok: false, error: "job 非法" };
  if (!str(body.map, 64)) return { ok: false, error: "map 非法" };
  if (!/^[a-z]{1,16}$/i.test(String(body.mode || ""))) return { ok: false, error: "mode 非法" };
  if (!num(body.exp_per_hour, 0, EXP_MAX_PER_HOUR)) return { ok: false, error: "exp_per_hour 非法" };
  if (!num(body.test_seconds, 0, EXP_MAX_DURATION_S)) return { ok: false, error: "test_seconds 非法" };
  const np = validateNotePower(body);
  if (!np.ok) return np;

  return {
    ok: true,
    report: {
      id: newExpId(),
      deviceId: sub,
      level: body.level,
      job: body.job,
      mapId: null, // v2 只上报地图名，map_id 不参与
      mapName: body.map,
      partyMode: String(body.mode).toLowerCase(),
      startTime: null,
      endTime: null,
      durationSeconds: body.test_seconds,
      delta: { gold: null, hpPotionUsed: null, mpPotionUsed: null, expGained: null, levelsGained: null },
      profit: {
        expPerHour: Math.round(body.exp_per_hour),
        goldPerHour: null, potionValue: null,
        potionHpValue: null, potionMpValue: null,
        potionHpPerHour: null, potionMpPerHour: null,
      },
      note: np.note,
      power: np.power,
      serverTime: new Date().toISOString(),
    },
  };
}

/** POST /api/v2/exp/token：设备密钥（全工具共用，内置在 PC 客户端）换 2 小时 JWT */
function handleExpV2Token(req, res) {
  if (req.headers["x-exp-device-secret"] !== EXP_DEVICE_SECRET) {
    return v2Reply(req, res, 403, { ok: false, error: "设备密钥错误" });
  }
  readBody(req, EXP_V2_BODY_LIMIT)
    .then((buf) => {
      let body;
      try {
        body = JSON.parse(buf.toString("utf-8"));
      } catch {
        return v2Reply(req, res, 400, { ok: false, error: "请求体不是合法 JSON" });
      }
      const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
      if (!/^[0-9a-zA-Z_-]{1,64}$/.test(deviceId)) return v2Reply(req, res, 400, { ok: false, error: "deviceId 非法" });
      const token = signExpToken(deviceId);
      console.log(`[exp] 签发 token：sub=${deviceId}（${EXP_TOKEN_TTL_S}s 有效）`);
      v2Reply(req, res, 200, { ok: true, token, sub: deviceId, expiresIn: EXP_TOKEN_TTL_S });
    })
    .catch((err) => {
      console.error(`[exp] 签发失败：${err.message}`);
      if (!res.headersSent) v2Reply(req, res, 413, { ok: false, error: "请求体过大或连接中断" });
    });
}

/** GET /api/v2/exp/session：校验 JWT → sub（exp.html 打开 ?token= 链接后用其确认可编辑的设备） */
function handleExpV2Session(req, res) {
  const payload = authExpBearer(req);
  if (!payload) return v2Reply(req, res, 401, { ok: false, error: "token 无效或已过期" });
  v2Reply(req, res, 200, {
    ok: true,
    sub: payload.sub,
    exp: payload.exp,
    ttl: Math.max(0, payload.exp - Math.floor(Date.now() / 1000)),
  });
}

/** POST /api/v2/exp/report：v2 工具用 JWT 上报一条精简记录（金币/药水不参与，限频沿用 v1 表） */
function handleExpV2Report(req, res) {
  const payload = authExpBearer(req);
  if (!payload) return v2Reply(req, res, 401, { ok: false, error: "token 无效或已过期" });
  const sub = payload.sub;
  const ip = req.socket.remoteAddress || "";
  const now = Date.now();
  if (now - (expLastIp.get(ip) || 0) < EXP_MIN_INTERVAL_MS) {
    return v2Reply(req, res, 429, { ok: false, error: "上报过于频繁" });
  }
  readBody(req, EXP_V2_BODY_LIMIT)
    .then(async (buf) => {
      let body;
      try {
        body = JSON.parse(buf.toString("utf-8"));
      } catch {
        console.log(`[exp] v2 拒绝：请求体不是合法 JSON ip=${ip}`);
        return v2Reply(req, res, 400, { ok: false, error: "请求体不是合法 JSON" });
      }
      const r = buildExpV2Record(sub, body);
      if (!r.ok) {
        console.log(`[exp] v2 拒绝：${r.error} ip=${ip} | 请求体=${JSON.stringify(body).slice(0, 300)}`);
        return v2Reply(req, res, 400, { ok: false, error: r.error });
      }
      const lastDevice = expLastDevice.get(r.report.deviceId) || 0;
      if (now - lastDevice < EXP_MIN_INTERVAL_MS) {
        console.log(`[exp] v2 拒绝：设备限频 deviceId=${r.report.deviceId}`);
        return v2Reply(req, res, 429, { ok: false, error: "上报过于频繁" });
      }
      try {
        await insertExpReport(r.report, body); // toExpRow 已带 note/power；snapshot 存原始 body
      } catch (err) {
        if (err.code === "ER_DUP_ENTRY") {
          r.report.id = newExpId();
          try {
            await insertExpReport(r.report, body);
          } catch (err2) {
            console.error(`[exp] v2 落库失败（重试后）：${err2.message} ip=${ip}`);
            return v2Reply(req, res, 500, { ok: false, error: "上报存储失败" });
          }
        } else {
          console.error(`[exp] v2 落库失败：${err.message} ip=${ip}`);
          return v2Reply(req, res, 500, { ok: false, error: "上报存储失败" });
        }
      }
      expReports.push(r.report);
      expLastDevice.set(r.report.deviceId, now);
      expLastIp.set(ip, now);
      pruneRateMap(expLastDevice);
      pruneRateMap(expLastIp);
      console.log(`[exp] v2 入库：${r.report.id} ${r.report.deviceId} Lv${r.report.level} ${r.report.mapName} +${r.report.profit.expPerHour}/h`);
      v2Reply(req, res, 200, { ok: true, id: r.report.id, report: r.report });
    })
    .catch((err) => {
      console.error(`[exp] v2 上报处理失败：${err.message} ip=${ip}`);
      if (!res.headersSent) v2Reply(req, res, 413, { ok: false, error: "请求体过大或连接中断" });
    });
}

/** 组装编辑结果：校验 body（snake_case，键缺省沿用原值；id/device/时间/审计一律不动） */
function buildExpEdit(rec, body) {
  const str = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
  const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  const num = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
  const seg = (perHour, durS) => Math.round((perHour * durS) / 3600);

  if (!int(body.level, 1, 300)) return { ok: false, error: "level 非法" };
  if (!str(body.job, 32)) return { ok: false, error: "job 非法" };
  if (!str(body.map, 64)) return { ok: false, error: "map 非法" };
  if (!/^[a-z]{1,16}$/i.test(String(body.mode || ""))) return { ok: false, error: "mode 非法" };
  if (!num(body.exp_per_hour, 0, EXP_MAX_PER_HOUR)) return { ok: false, error: "exp_per_hour 非法" };
  if (body.map_id !== undefined && body.map_id !== null && !int(body.map_id, 0, 1e9)) {
    return { ok: false, error: "map_id 非法" };
  }

  const next = Object.assign({}, rec, {
    level: body.level,
    job: body.job,
    mapName: body.map,
    mapId: body.map_id !== undefined && body.map_id !== null ? body.map_id : rec.mapId,
    partyMode: String(body.mode).toLowerCase(),
    profit: Object.assign({}, rec.profit || {}),
    delta: Object.assign({}, rec.delta || {}),
  });

  // 备注/攻击力：键缺省沿用原值；note 空串或 power null 表示清空
  if (body.note !== undefined) {
    if (typeof body.note !== "string" || body.note.length > 500) return { ok: false, error: "note 非法" };
    next.note = body.note.trim() === "" ? null : body.note;
  }
  if (body.power !== undefined) {
    if (body.power === null) next.power = null;
    else if (!Number.isInteger(body.power) || body.power < 0 || body.power > 1e9) {
      return { ok: false, error: "power 非法" };
    } else next.power = body.power;
  }

  // 经验/h：直接写 profit 列；v1 语义行（有 delta）同步反推 delta 差值与药水金额，保持库内自洽
  next.profit.expPerHour = Math.round(body.exp_per_hour);
  const durS = Number(next.durationSeconds) || 1;
  if (rec.delta && rec.delta.gold != null) {
    next.delta.expGained = seg(body.exp_per_hour, durS);
    if (body.gold_per_hour !== undefined) {
      if (!num(body.gold_per_hour, 0, GOLD_MAX_PER_HOUR)) return { ok: false, error: "gold_per_hour 非法" };
      next.delta.gold = seg(body.gold_per_hour, durS);
      next.profit.goldPerHour = Math.round(body.gold_per_hour);
    }
    if (body.potion_hp_per_hour !== undefined) {
      if (!num(body.potion_hp_per_hour, 0, POTION_MAX_PER_HOUR)) return { ok: false, error: "potion_hp_per_hour 非法" };
      next.profit.potionHpPerHour = Math.round(body.potion_hp_per_hour);
      next.profit.potionHpValue = seg(body.potion_hp_per_hour, durS);
    }
    if (body.potion_mp_per_hour !== undefined) {
      if (!num(body.potion_mp_per_hour, 0, POTION_MAX_PER_HOUR)) return { ok: false, error: "potion_mp_per_hour 非法" };
      next.profit.potionMpPerHour = Math.round(body.potion_mp_per_hour);
      next.profit.potionMpValue = seg(body.potion_mp_per_hour, durS);
    }
  }
  return { ok: true, next };
}

/** 编辑落库：只改本设备行，WHERE 再带 device_id 兜底；不碰 id/device/时间/snapshot */
async function updateExpReport(id, deviceId, r) {
  await q(
    `UPDATE exp_reports SET
       level=?, job=?, map_id=?, map_name=?, party_mode=?, duration_seconds=?,
       delta_gold=?, delta_hp_potion_used=?, delta_mp_potion_used=?, delta_exp_gained=?, delta_levels_gained=?,
       profit_exp_per_hour=?, profit_gold_per_hour=?, profit_potion_value=?,
       profit_potion_hp_value=?, profit_potion_mp_value=?,
       profit_potion_hp_per_hour=?, profit_potion_mp_per_hour=?,
       note=?, power=?
     WHERE id=? AND device_id=?`,
    [
      toDbVal(r.level), toDbVal(r.job), toDbVal(r.mapId), toDbVal(r.mapName), toDbVal(r.partyMode),
      toDbVal(r.durationSeconds),
      toDbVal(r.delta ? r.delta.gold : null),
      toDbVal(r.delta ? r.delta.hpPotionUsed : null),
      toDbVal(r.delta ? r.delta.mpPotionUsed : null),
      toDbVal(r.delta ? r.delta.expGained : null),
      toDbVal(r.delta ? r.delta.levelsGained : null),
      toDbVal(r.profit ? r.profit.expPerHour : null),
      toDbVal(r.profit ? r.profit.goldPerHour : null),
      toDbVal(r.profit ? r.profit.potionValue : null),
      toDbVal(r.profit ? r.profit.potionHpValue : null),
      toDbVal(r.profit ? r.profit.potionMpValue : null),
      toDbVal(r.profit ? r.profit.potionHpPerHour : null),
      toDbVal(r.profit ? r.profit.potionMpPerHour : null),
      toDbVal(r.note), toDbVal(r.power),
      id, deviceId,
    ],
  );
}

/** PATCH /api/v2/exp/report：编辑「本设备」上报的记录（DB 先行，成功才改内存权威数组） */
function handleExpV2ReportUpdate(req, res) {
  const payload = authExpBearer(req);
  if (!payload) return v2Reply(req, res, 401, { ok: false, error: "token 无效或已过期" });
  const sub = payload.sub;
  readBody(req, EXP_V2_BODY_LIMIT)
    .then(async (buf) => {
      let body;
      try {
        body = JSON.parse(buf.toString("utf-8"));
      } catch {
        return v2Reply(req, res, 400, { ok: false, error: "请求体不是合法 JSON" });
      }
      const id = typeof body.id === "string" ? body.id.trim() : "";
      const rec = expReports.find((x) => x.id === id);
      if (!rec) return v2Reply(req, res, 404, { ok: false, error: "记录不存在" });
      if (rec.deviceId !== sub) return v2Reply(req, res, 403, { ok: false, error: "无权修改该记录" });

      const r = buildExpEdit(rec, body);
      if (!r.ok) {
        console.log(`[exp] v2 拒绝修改：${r.error} sub=${sub} id=${id} | body=${JSON.stringify(body).slice(0, 300)}`);
        return v2Reply(req, res, 400, { ok: false, error: r.error });
      }
      try {
        await updateExpReport(id, sub, r.next); // 先落库，成功才算修改
      } catch (err) {
        console.error(`[exp] v2 修改落库失败：${err.message} id=${id} sub=${sub}`);
        return v2Reply(req, res, 500, { ok: false, error: "修改存储失败" });
      }
      const idx = expReports.indexOf(rec);
      if (idx >= 0) expReports[idx] = r.next; // 内存权威数组原地替换，GET/轮询下次即新值
      console.log(`[exp] v2 修改：${id} ${sub} Lv${r.next.level} ${r.next.mapName} +${r.next.profit.expPerHour}/h`);
      v2Reply(req, res, 200, { ok: true, report: r.next });
    })
    .catch((err) => {
      console.error(`[exp] v2 修改处理失败：${err.message}`);
      if (!res.headersSent) v2Reply(req, res, 413, { ok: false, error: "请求体过大或连接中断" });
    });
}

/** DELETE /api/v2/exp/report：删除「本设备」上报的记录（DB 先行，成功才移出内存权威数组）
 *  鉴权/归属规则与 PATCH 编辑一致：Bearer token 的 sub=设备ID，只能删本设备行 */
function handleExpV2ReportDelete(req, res) {
  const payload = authExpBearer(req);
  if (!payload) return v2Reply(req, res, 401, { ok: false, error: "token 无效或已过期" });
  const sub = payload.sub;
  readBody(req, EXP_V2_BODY_LIMIT)
    .then(async (buf) => {
      let body;
      try {
        body = JSON.parse(buf.toString("utf-8"));
      } catch {
        return v2Reply(req, res, 400, { ok: false, error: "请求体不是合法 JSON" });
      }
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id) return v2Reply(req, res, 400, { ok: false, error: "id 缺失" });
      const rec = expReports.find((x) => x.id === id);
      if (!rec) return v2Reply(req, res, 404, { ok: false, error: "记录不存在" });
      if (rec.deviceId !== sub) return v2Reply(req, res, 403, { ok: false, error: "无权删除该记录" });
      try {
        const r = await q(`DELETE FROM exp_reports WHERE id = ? AND device_id = ?`, [id, sub]);
        // 内存里有但库里没有：重启窗口内被别处清库等，按不存在处理
        if (!r || r.affectedRows !== 1) {
          return v2Reply(req, res, 404, { ok: false, error: "记录不存在" });
        }
      } catch (err) {
        console.error(`[exp] v2 删除落库失败：${err.message} id=${id} sub=${sub}`);
        return v2Reply(req, res, 500, { ok: false, error: "删除存储失败" });
      }
      const idx = expReports.indexOf(rec);
      if (idx >= 0) expReports.splice(idx, 1); // 移出内存权威数组，GET/统计下次即更新
      console.log(`[exp] v2 删除：${id} ${sub} Lv${rec.level} ${rec.mapName} +${rec.profit ? rec.profit.expPerHour : 0}/h`);
      v2Reply(req, res, 200, { ok: true, id });
    })
    .catch((err) => {
      console.error(`[exp] v2 删除处理失败：${err.message}`);
      if (!res.headersSent) v2Reply(req, res, 413, { ok: false, error: "请求体过大或连接中断" });
    });
}

/** 职业别名归一：枪骑士与枪战士同义，统一显示为枪战士
 *  （数据原样保留，只影响职业统计的分组与前端展示） */
const JOB_ALIASES = { 枪骑士: "枪战士", 冰雷: "冰雷法师" };

/** 全量数据按维度聚合的平均值（exp.html 的地图/职业均值面板用；简单算术平均）
 *  值为 0 视为未记录：该指标不进平均（分母单独计数），全部缺失则该指标为 null（页面显示 -） */
function buildGroupStats(list, keyOf) {
  const byGroup = new Map();
  for (const r of list) {
    if (!r.profit) continue;
    const key = keyOf(r);
    if (!key) continue;
    let m = byGroup.get(key);
    if (!m) {
      m = { key, count: 0, exp: 0, expN: 0, gold: 0, goldN: 0, hp: 0, hpN: 0, mp: 0, mpN: 0 };
      byGroup.set(key, m);
    }
    m.count += 1;
    if (r.profit.expPerHour > 0) {
      m.exp += r.profit.expPerHour;
      m.expN += 1;
    }
    if (r.profit.goldPerHour > 0) {
      m.gold += r.profit.goldPerHour;
      m.goldN += 1;
    }
    if (r.profit.potionHpPerHour > 0) {
      m.hp += r.profit.potionHpPerHour;
      m.hpN += 1;
    }
    if (r.profit.potionMpPerHour > 0) {
      m.mp += r.profit.potionMpPerHour;
      m.mpN += 1;
    }
  }
  return [...byGroup.values()]
    .map((m) => ({
      group: m.key,
      count: m.count,
      avgExpPerHour: m.expN ? Math.round(m.exp / m.expN) : null,
      avgGoldPerHour: m.goldN ? Math.round(m.gold / m.goldN) : null,
      avgPotionHpPerHour: m.hpN ? Math.round(m.hp / m.hpN) : null,
      avgPotionMpPerHour: m.mpN ? Math.round(m.mp / m.mpN) : null,
    }))
    .sort((a, b) => (b.avgExpPerHour || 0) - (a.avgExpPerHour || 0)); // 平均经验/h 高的在前
}

/** GET /api/exp/reports?limit=&id=：表格页读取（公开只读无需密钥；最新在前）
 *  id 可选：传记录 id 则只返回那一条（客户端分享 exp.html?id=xxx 链接用）
 *  响应带 mapStats：全量数据按地图聚合的平均值（地图均值面板用） */
function handleExpReports(req, res) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const recordId = (q.get("id") || "").trim();
  const list = recordId ? expReports.filter((r) => r.id === recordId) : expReports;
  let limit = Number(q.get("limit")) || 200;
  limit = Math.max(1, Math.min(500, Math.floor(limit)));
  const reports = list.slice(-limit).reverse();
  respond(req, res, {
    type: "application/json; charset=utf-8",
    headers: API_CORS,
    compress: true,
    body: Buffer.from(
      JSON.stringify({
        ok: true,
        id: recordId || null,
        count: reports.length,
        total: list.length,
        serverTime: new Date().toISOString(),
        reports,
        mapStats: buildGroupStats(list, (r) => r.mapName),
        jobStats: buildGroupStats(list, (r) => JOB_ALIASES[r.job] || r.job),
      }),
    ),
  });
}

await loadExpReports(); // 启动即读回（模块加载顺序上位于各函数定义之后）

/* ---------------- 站点统计（site_stats 表） ----------------
 * 站点累计统计：以后所有需要落盘的计数都往这张表里放。
 * 启动时读入内存，识别请求 +1 时内存先自增，再异步 upsert 落库
 * （首次插入内存值、之后原子自增；并发安全，落库失败仅日志）。 */

let stats = { totalRequests: 0 }; // 累计识别请求次数

async function loadStats() {
  try {
    const row = await qOne(`SELECT total_requests FROM site_stats WHERE id = 1`);
    if (row) stats = { totalRequests: Number(row.total_requests) };
    console.log(`[stats] 载入统计：累计识别请求 ${stats.totalRequests} 次`);
  } catch (err) {
    console.error(`[stats] site_stats 读取失败：${err.message}，从 0 开始统计`);
  }
}

/** 识别请求 +1 并落库（fire-and-forget，不阻塞 OCR 响应） */
function bumpTotalRequests() {
  stats.totalRequests += 1;
  q(
    `INSERT INTO site_stats (id, total_requests) VALUES (1, ?)
     ON DUPLICATE KEY UPDATE total_requests = total_requests + 1`,
    [stats.totalRequests],
  ).catch((err) => {
    console.error(`[stats] 落库失败：${err.message}`);
  });
}

/** GET /api/stats：站点累计统计（当前含累计识别请求次数） */
function handleStats(req, res) {
  respond(req, res, {
    type: "application/json; charset=utf-8",
    headers: API_CORS,
    body: Buffer.from(JSON.stringify({ ok: true, ...stats })),
  });
}

await loadStats(); // 启动即读入（模块加载顺序上位于各函数定义之后）

function respond(req, res, { status = 200, type = "text/plain; charset=utf-8", cache = "no-cache", etag, headers = {}, body, compress = false }) {
  const h = { "Content-Type": type, "Cache-Control": cache, ...headers };
  if (etag) {
    h.ETag = etag;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, h);
      res.end();
      return;
    }
  }
  let payload = body;
  if (
    compress &&
    body.length > 1024 &&
    /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""))
  ) {
    let gz = etag ? gzipCache.get(etag) : null;
    if (!gz) {
      gz = zlib.gzipSync(body);
      if (etag) {
        if (gzipCache.size > 16) gzipCache.clear(); // 简单上限，防内存膨胀
        gzipCache.set(etag, gz);
      }
    }
    h["Content-Encoding"] = "gzip";
    h.Vary = "Accept-Encoding";
    payload = gz;
  }
  res.writeHead(status, h);
  res.end(payload);
}

/** 页面：读 HTML，把内存中的 JSON 内联注入 <head>（紧跟 charset，保证先于页面脚本执行） */
function servePage(req, res, filePath, injects) {
  const html = fs.readFileSync(filePath, "utf-8");
  const tags = [];
  for (const rel of injects) {
    const data = store.get(rel);
    if (!data) continue; // 加载失败的文件跳过，页面会用 document.write 回退到 *.json.js
    // 转义 "</" 防止 JSON 内容提前闭合 <script>
    tags.push(`window.${data.global} = ${data.text.replace(/<\//g, "<\\/")};`);
  }
  const stat = fs.statSync(filePath);
  // ETag 由页面文件 mtime + 各数据源的 updatedAt 组成：任一方变化，客户端就会重新拉取
  const etag = `W/"${stat.mtimeMs.toString(16)}-${injects.map((r) => store.get(r)?.updatedAt || 0).join(".")}"`;
  const injected = html.replace(
    '<meta charset="UTF-8" />',
    `<meta charset="UTF-8" />\n    <script>\n      // server.js 注入的内存数据（JSON 变化时服务端自动重载，页面无需请求 *.json.js）\n      ${tags.join("\n      ")}\n    </script>`,
  );
  respond(req, res, {
    type: TYPES[".html"],
    cache: cacheControlFor(".html"),
    etag,
    body: Buffer.from(injected, "utf-8"),
    compress: true,
  });
}

/** 静态文件：ETag + 按扩展名缓存策略 */
function serveStatic(req, res, filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return respond(req, res, { status: 404, body: Buffer.from("404 Not Found\n") });
  }
  if (!stat.isFile()) {
    return respond(req, res, { status: 404, body: Buffer.from("404 Not Found\n") });
  }
  const ext = path.extname(filePath).toLowerCase();
  const etag = `W/"${stat.mtimeMs.toString(16)}-${stat.size.toString(16)}"`;
  // data/ 下的 JSON（jobs/maps 等）加 CORS 头：file:// 打开页面时手动录入表单跨域读取选项用
  const cors = filePath.startsWith(path.join(ROOT, "data") + path.sep);
  respond(req, res, {
    type: TYPES[ext] || "application/octet-stream",
    cache: cacheControlFor(ext),
    etag,
    headers: cors ? API_CORS : {},
    body: fs.readFileSync(filePath),
    compress: COMPRESSIBLE.has(ext),
  });
}

function handle(req, res) {
  // 目录穿越硬拦截：URL 解析器会把字面 /../ 归一化掉（编码的 %2e%2e 不会），
  // 这里直接对原始请求串检查，两种写法一律 404
  const rawPath = req.url.split("?")[0].split("#")[0];
  if (/\/\.\.($|\/)/.test(rawPath) || /%2e%2e/i.test(rawPath)) {
    return respond(req, res, { status: 404, body: Buffer.from("404 Not Found\n") });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    return respond(req, res, { status: 400, body: Buffer.from("400 Bad Request\n") });
  }

  // API 接口：OPTIONS 应答 CORS 预检（file:// 页面跨域用）
  if (pathname.startsWith("/api/")) {
    if (req.method === "OPTIONS") {
      return respond(req, res, { status: 204, headers: API_CORS, body: Buffer.alloc(0) });
    }
    if (pathname === "/api/shenmi/verify" && req.method === "GET") return handleShenmiVerify(req, res);
    // 经验收益上报：PC 端专用接口，免密钥，不经过 shenmi 暗号
    if (pathname === "/api/exp/report" && req.method === "POST") return handleExpReport(req, res);
    if (pathname === "/api/exp/reports" && req.method === "GET") return handleExpReports(req, res);
    // 经验上报 v2：JWT 鉴权（sub=设备ID），自带密钥/令牌校验，不经过 shenmi 暗号
    if (pathname === "/api/v2/exp/token" && req.method === "POST") return handleExpV2Token(req, res);
    if (pathname === "/api/v2/exp/session" && req.method === "GET") return handleExpV2Session(req, res);
    if (pathname === "/api/v2/exp/report" && req.method === "POST") return handleExpV2Report(req, res);
    if (pathname === "/api/v2/exp/report" && req.method === "PATCH") return handleExpV2ReportUpdate(req, res);
    if (pathname === "/api/v2/exp/report" && req.method === "DELETE") return handleExpV2ReportDelete(req, res);
    // 其余 shenmi 专属接口统一过暗号：防止绕过页面直接刷接口
    if (!checkShenmiCode(req)) return rejectShenmiCode(req, res);
    if (pathname === "/api/ocr" && req.method === "POST") return handleOcr(req, res);
    if (pathname === "/api/ocr/result" && req.method === "GET") return handleOcrResult(req, res);
    if (pathname === "/api/ocr/queue" && req.method === "GET") return handleOcrQueue(req, res);
    if (pathname === "/api/stats" && req.method === "GET") return handleStats(req, res);
    if (pathname === "/api/price" && req.method === "GET") return handlePrice(req, res);
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return respond(req, res, { status: 405, body: Buffer.from("405 Method Not Allowed\n") });
  }

  // 目录穿越 / 隐藏文件（.git 等）防护
  const segments = pathname.split("/");
  if (segments.some((s) => s === ".." || s.startsWith("."))) {
    return respond(req, res, { status: 404, body: Buffer.from("404 Not Found\n") });
  }

  const filePath = path.join(ROOT, pathname === "/" ? "rank.html" : pathname);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    return respond(req, res, { status: 403, body: Buffer.from("403 Forbidden\n") });
  }

  const page = PAGE_INJECTS[path.basename(filePath)];
  if (page) return servePage(req, res, filePath, page);
  return serveStatic(req, res, filePath);
}

const server = http.createServer((req, res) => {
  // 响应完成后再打日志：异步接口（ocr/exp 等）处理完成前 statusCode 还是默认值，
  // 提前打印会把 400/429 误报成 200，误导排查
  res.on("finish", () => {
    // 访问日志对 token 打码：JWT 会出现在 exp.html?token=… 链接里，避免整串进 pm2 日志
    const logUrl = (req.url || "").replace(/([?&]token=)[^&]*/g, "$1***");
    console.log(`[http] ${req.method} ${logUrl} → ${res.statusCode}`);
  });
  try {
    handle(req, res);
  } catch (err) {
    console.error(`[http] ${req.method} ${req.url} 出错：`, err.message);
    if (!res.headersSent) {
      respond(req, res, { status: 500, body: Buffer.from("500 Internal Server Error\n") });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n🚀 mxd-helper 混合端已启动：http://${HOST}:${PORT}/（默认 rank.html）`);
  console.log(`   MySQL 数据源：${Object.keys(DATA_FILES).join("、")}（dataset_meta 轮询 ${REFRESH_INTERVAL_MS / 1000}s 热重载）`);
  console.log(`   OCR 转交：http://${OCR_HOST}:${OCR_PORT}/（独立服务 ocr_worker.js，需另行启动）`);
  console.log("   shenmi 暗号：已启用（环境变量 SHENMI_CODE 可修改，默认 zhuzhu）");
  console.log("   经验上报：POST /api/exp/report（免密钥，防刷靠限频+校验重算）");
  console.log("   经验上报 v2：/api/v2/exp/token|session|report（JWT 鉴权，sub=设备ID；PATCH/DELETE 供 exp.html 编辑/删除）\n");
});

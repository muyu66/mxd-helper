// account-info.js — 抓取「冒险岛怀旧服-交易账号」列表并落盘 JSON
//
// 用法:
//   node account-info.js            单次抓取（供 Windows 计划任务定时调用）
//
// 数据源: gmmsj 商品搜索分页接口 searchgoodslistV2（每页 limit=15）
// 输出: account-info.json — 记录数组，每条结构为
//   { book_id, goods_list_sub_title, goods_list_title, update_time, price,
//     server, job, level }
//       account-info.json.js — 上者的脚本包装（window.ACCOUNT_DATA），供
//       account.html 以 <script src> 加载：浏览器在 file:// 下禁用 fetch，
//       脚本引用则不受限，双击打开页面也能读到数据
//   后 3 个字段为每次抓取后从标题派生的细节数据：
//   server: goods_list_sub_title 最后一段（如 "冒险岛怀旧服-蘑菇仔-蘑菇仔" → "蘑菇仔"）
//   job:    goods_list_title 第一个 [..] 内职业名（如 "[冰雷法师 51级]" → "冰雷法师"）
//   level:  同一 [..] 内的等级数字（"51级" → 51），取不到时为 ""
//
// 接口校验（实测）:
//   接口要求「新鲜的 app_tst + 与之匹配的 X-Nonce 签名头 + 有效会话 cookie」，
//   三者缺一返回 -403。X-Nonce 由站点前端同款 WASM 模块按 app_tst 实时计算，
//   cookie 通过先访问列表页、再探测两个站点接口的方式在本地构建，全程无需浏览器。
//
// 更新语义:
//   每次执行先拉取全部分页，再以 book_id 作为区别项与本地已有数据合并：
//   同 book_id 用本次数据覆盖，本地已有而本次未出现的记录保留，
//   新出现的 book_id 追加。因此文件只增不减，可当作累积快照使用。
//
// 失败策略:
//   任何一页在重试后仍失败，则本次不写入（保留上一份好数据），退出码 1，
//   便于计划任务判断本次是否抓取成功。

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "account-info.json");
const DATA_JS_FILE = path.join(__dirname, "account-info.json.js"); // account.html 的脚本版数据源

const BASE_URL = "https://www.gmmsj.com/api/consigntradeapi/goods/searchgoodslistV2";
const SITE_VERSION = "1.0.0.269439"; // 站点前端版本（签名模块与其配套）
const GAME_ID = "791001093";
const DEVICE_ID = "v2_2XzggnwIp0GU1j1MZtwjVGjhnPJjB8hY"; // 与接口 device_id 参数一致

const PAGE_LIMIT = 15; // 与接口 limit 一致
const MAX_PAGES = 300; // 安全上限，防止异常时无限翻页
const MAX_RETRIES = 3;
const REQUEST_DELAY_MS = 250; // 翻页间隔，对服务器保持克制
const TIMEOUT_MS = 30_000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0";

// 浏览器抓包常见的固定 header（x-nonce 每次请求现算，不在此列）
const COMMON_HEADERS = {
  accept: "application/json, text/javascript, */*; q=0.01",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
  "cache-control": "no-cache",
  pragma: "no-cache",
  "sec-ch-ua": '"Not=A?Brand";v="99", "Microsoft Edge";v="151", "Chromium";v="151"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "x-requested-with": "XMLHttpRequest",
  referer: "https://www.gmmsj.com/",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// 签名器：加载站点前端同款 WASM 模块，按 app_tst 计算 X-Nonce
// ============================================================

let signTs = null; // initSigner() 后可用：signTs(ts) → { 签名头名: 签名值 }
let docCookie = ""; // WASM 内部 _js_get_cookies 返回的 document.cookie

async function initSigner() {
  // 1. 取站点前端签名模块，提取内嵌 base64 wasm
  const src = await (
    await fetch(`https://profile.gmmsj.com/pc/all/libs/gmmbiz.js?version=${SITE_VERSION}`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  ).text();
  const m = src.match(/wasmBinaryFile="data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)"/);
  if (!m) throw new Error("gmmbiz.js 中未找到内嵌 wasm");
  const wasmBytes = Buffer.from(m[1], "base64");

  // 2. 实现 wasm 导入（模块名 "a"，映射自站点胶水代码的 wasmImports）
  let memory = null;
  let s_f = null, s_t = null;
  const td = new TextDecoder();
  const te = new TextEncoder();
  let mallocFn = null, freeFn = null, gmbiztFn = null;

  const readStr = (ptr) => {
    const u8 = new Uint8Array(memory.buffer);
    let end = ptr;
    while (u8[end] !== 0) end++;
    return td.decode(u8.subarray(ptr, end));
  };
  const writeStr = (s) => {
    const bytes = te.encode(s + "\0");
    const ptr = mallocFn(bytes.length);
    new Uint8Array(memory.buffer).set(bytes, ptr);
    return ptr;
  };

  // asm-const 回调表（与站点胶水代码一致）：5347 输出签名头名与值
  const ASM_CONSTS = {
    5319: () => {},
    5347: ($0, $1) => { s_t = readStr($0); s_f = readStr($1); },
    5399: ($0, $1) => { s_f = readStr($1); },
    5451: () => {},
  };

  const importObj = {
    a: {
      // _emscripten_asm_const_int(code, sigPtr, argbuf)：按签名串解析参数后分派
      a: (code, sigPtr, argbuf) => {
        const u8 = new Uint8Array(memory.buffer);
        const u32 = new Uint32Array(memory.buffer);
        const f64 = new Float64Array(memory.buffer);
        const args = [];
        let p = sigPtr, buf = argbuf;
        while (u8[p] !== 0) {
          const ch = u8[p++];
          const wide = ch !== 105 && ch !== 112; // 'i'/'p' 4 字节槽，其余 8 字节对齐
          if (wide && buf % 8) buf += 4;
          args.push(ch === 112 ? u32[buf >> 2] : ch === 105 ? (u32[buf >> 2] | 0) : f64[buf >> 3]);
          buf += wide ? 8 : 4;
        }
        return ASM_CONSTS[code](...args);
      },
      b: () => {},
      c: () => { throw new Error("wasm __cxa_throw"); },
      d: () => writeStr(docCookie), // _js_get_cookies → document.cookie
      e: () => 0, f: () => 0, g: () => 0, h: () => 0, i: () => 0, j: () => 0,
      k: (_clockId, ptr) => {
        new DataView(memory.buffer).setBigUint64(ptr, BigInt(Date.now()) * 1000000n, true);
        return 0;
      },
      l: () => { throw new Error("wasm __abort_js"); },
      m: () => 0,
    },
  };

  // 3. 实例化（bytes 版本返回 {module, instance}）
  const { instance } = await WebAssembly.instantiate(wasmBytes, importObj);
  memory = instance.exports.n;
  mallocFn = instance.exports.w;
  freeFn = instance.exports.u;
  gmbiztFn = instance.exports.q;
  try { instance.exports.o?.(); } catch { /* 构造函数无副作用则忽略 */ }

  // 4. 对外：给定 app_tst，返回 { X-Nonce: 签名值 }
  signTs = (ts) => {
    s_f = s_t = null;
    const ptr = writeStr(ts);
    gmbiztFn(ptr);
    freeFn(ptr);
    if (!s_f || !s_t) throw new Error("WASM 签名计算失败");
    return { [s_f]: s_t };
  };
}

// ============================================================
// 会话：在本地构建一组接口可接受的 cookie（无需浏览器）
// ============================================================

const jar = new Map([
  ["deviceId", DEVICE_ID], // 与接口 device_id 参数一致（浏览器端生成的固定值）
  ["device_id", DEVICE_ID],
]);

function absorb(res) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1);
    if (!v) jar.delete(k);
    else jar.set(k, v);
  }
}
const cookieStr = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

async function get(url, headers = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Cookie: cookieStr(), ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  absorb(res);
  return res;
}

// 构建会话：列表页下发 WAF/JSESSIONID，两个站点接口补 GMMSESSID/PHPSESSID
async function buildSession() {
  await get(`https://www.gmmsj.com/dy/${GAME_ID}_zh.shtml`, {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  });
  await get("https://www.gmmsj.com/gmmts.ms");
  await get(`https://www.gmmsj.com/gatew/CfgGW/getGameAreaGroupList?game_id=${GAME_ID}&type=1&count=1000`);
  await get("https://www.gmmsj.com/gate/frontconfigapi/GetVersion");
  if (!jar.has("GMMSESSID") || !jar.has("PHPSESSID")) {
    throw new Error(`会话构建不完整（当前 cookie: ${[...jar.keys()].join(", ")}）`);
  }
}

// ============================================================
// 抓取
// ============================================================

function pageUrl(page, appTst) {
  const params = new URLSearchParams({
    app_version: SITE_VERSION,
    device_id: DEVICE_ID,
    system_deviceId: DEVICE_ID,
    app_channel: "chrome",
    src_code: "7",
    keyword: "",
    goods_types: "10",
    game_id: GAME_ID,
    page: String(page),
    limit: String(PAGE_LIMIT),
    safe_type: "",
    item_type: "10",
    app_tst: appTst,
  });
  return `${BASE_URL}?${params}`;
}

async function fetchPage(page, retries = MAX_RETRIES) {
  for (let attempt = 1; ; attempt++) {
    try {
      const ts = String(Date.now());
      docCookie = cookieStr(); // 签名与请求使用同一份 cookie
      const res = await fetch(pageUrl(page, ts), {
        headers: {
          "User-Agent": UA,
          Cookie: cookieStr(),
          ...COMMON_HEADERS,
          ...signTs(ts),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      absorb(res); // 服务器若轮换 cookie，及时更新 jar
      const json = await res.json();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (json.return_code !== 0) {
        throw new Error(`接口返回 ${json.return_code}: ${json.return_message}`);
      }
      return json;
    } catch (err) {
      if (attempt >= retries) throw new Error(`第 ${page} 页抓取失败: ${err.message}`);
      await sleep(500 * attempt); // 退避重试
    }
  }
}

// ============================================================
// 解析与派生
// ============================================================

// 服务器名：取 goods_list_sub_title 最后一段
// "冒险岛怀旧服-蘑菇仔-蘑菇仔" → "蘑菇仔"
function deriveServer(subTitle) {
  const parts = String(subTitle || "").split("-");
  return parts[parts.length - 1] || "";
}

// 职业与等级：取 goods_list_title 第一个 [..] 的内容
// "[冰雷法师 51级]" → { job: "冰雷法师", level: 51 }
// 方括号内没有 "N级" 时 job 取整个括号内容、level 置空
function deriveJobLevel(title) {
  const m = String(title || "").match(/\[([^\]]*)\]/);
  if (!m) return { job: "", level: "" };
  const content = m[1].trim();
  const lv = content.match(/(\d+(?:\.\d+)?)\s*级\s*$/);
  if (lv) {
    const n = Number(lv[1]);
    return { job: content.slice(0, lv.index).trim(), level: Number.isFinite(n) ? n : lv[1] };
  }
  return { job: content, level: "" };
}

// 给记录补齐派生的 server/job/level（新旧记录统一处理）
function deriveRecord(r) {
  return { ...r, ...deriveJobLevel(r.goods_list_title), server: deriveServer(r.goods_list_sub_title) };
}

// 单条记录 → 目标结构，缺字段置空；没有 book_id 的记录丢弃
function normalizeRecord(item) {
  if (!item || item.book_id === undefined || item.book_id === null) return null;
  return deriveRecord({
    book_id: item.book_id,
    goods_list_sub_title: item.goods_list_sub_title ?? "",
    goods_list_title: item.goods_list_title ?? "",
    update_time: item.update_time ?? "",
    price: item.price ?? "",
  });
}

// 抓取全部分页：先从第 1 页取 totalPage，再逐页抓取
async function crawlAll() {
  const first = await fetchPage(1);
  const totalPage = Number(first?.data?.totalPage);
  if (!Number.isInteger(totalPage) || totalPage < 1) {
    throw new Error("无法从第 1 页解析总页数 totalPage");
  }
  if (totalPage > MAX_PAGES) throw new Error(`总页数 ${totalPage} 超过安全上限 ${MAX_PAGES}`);

  const byId = new Map(); // 单次运行内按 book_id 去重
  const firstRecords = (first?.data?.goodsList ?? []).map(normalizeRecord).filter(Boolean);
  for (const r of firstRecords) byId.set(String(r.book_id), r);

  for (let page = 2; page <= totalPage; page++) {
    const json = await fetchPage(page);
    const records = (json?.data?.goodsList ?? []).map(normalizeRecord).filter(Boolean);
    for (const r of records) byId.set(String(r.book_id), r);
    await sleep(REQUEST_DELAY_MS);
    if (page % 30 === 0) console.log(`  进度 ${page}/${totalPage} 页`);
  }
  return { records: [...byId.values()], totalPage };
}

// ============================================================
// 落盘
// ============================================================

function loadExisting() {
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return Array.isArray(data.records) ? data.records : [];
  } catch {
    return []; // 首次运行或文件损坏时从空开始
  }
}

// 以 book_id 为区别项合并：本次数据覆盖同 key 的旧记录，旧记录保留；
// 合并后对所有记录统一重算 server/job/level，让旧数据也补齐新字段
function merge(existing, fresh) {
  const byId = new Map(existing.map((r) => [String(r.book_id), r]));
  for (const r of fresh) byId.set(String(r.book_id), r);
  return [...byId.values()].map(deriveRecord).sort(
    (a, b) =>
      String(b.update_time).localeCompare(String(a.update_time)) ||
      String(a.book_id).localeCompare(String(b.book_id)),
  );
}

function atomicWrite(file, content) {
  fs.writeFileSync(file + ".tmp", content);
  fs.renameSync(file + ".tmp", file);
}

// 序列化为可内嵌 <script> 的安全 JSON：防止内容里的 </script 提前闭合
function safeJson(obj) {
  return JSON.stringify(obj).replace(/<\//g, "<\\/");
}

// ============================================================
// 单次运行
// ============================================================

async function main() {
  const started = Date.now();
  console.log("初始化签名器 ...");
  await initSigner();
  console.log("构建会话 cookie ...");
  await buildSession();

  const { records, totalPage } = await crawlAll(); // 失败会抛异常，不写入本地文件

  const existing = loadExisting();
  const merged = merge(existing, records);

  const data = {
    updatedAt: new Date().toISOString(),
    source: BASE_URL,
    totalPages: totalPage,
    count: merged.length,
    records: merged,
  };
  atomicWrite(DATA_FILE, JSON.stringify(data, null, 2));

  // 页面版数据：只保留 account.html 用到的字段（标题两个长字段不展示，
  // 剔除后体积约省 40%），网页加载更快
  const pageRecords = merged.map((r) => ({
    book_id: r.book_id,
    server: r.server,
    job: r.job,
    level: r.level,
    price: r.price,
    update_time: r.update_time,
  }));
  atomicWrite(
    DATA_JS_FILE,
    `window.ACCOUNT_DATA = ${safeJson({ ...data, records: pageRecords })};`,
  );

  const added = merged.length - existing.length;
  console.log(
    `✓ 抓取完成: ${totalPage} 页共 ${records.length} 条，合并后共 ${merged.length} 条` +
      (added > 0 ? `（新增 ${added} 条）` : "") +
      `，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s → ${DATA_FILE}`,
  );
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  console.error("  本次未写入，保留上一份数据");
  process.exitCode = 1;
});

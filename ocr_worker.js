/**
 * ocr_worker.js — OCR 识别独立服务（与 server.js 分离，避免拖慢页面后端）
 *
 * 背景：原来 OCR 由 server.js 内置处理——请求排队期间 HTTP 连接一直挂起
 * （浏览器长时间 Pending），且 python + onnxruntime 的 CPU/内存压力与页面服务
 * 同进程，高峰时整个站点变卡。拆成独立进程后：
 *   1. server.js 只负责页面/数据展示，收到图片立即转交本服务并返回任务号；
 *   2. 本服务按队列逐个识别（一个 python 常驻进程，同一时间只处理一张图）；
 *   3. 排队期间的图片缓冲只占本进程内存，页面后端不受任何影响。
 *
 * HTTP API（默认仅监听 127.0.0.1:3002，只供同机 server.js 调用，不对外）：
 *   POST /task       请求体=图片二进制 → { ok:true, id }（立即返回，图片入队）
 *   GET  /task?id=xx → { ok:true, status:"queued"|"running"|"done"|"error",
 *                        waiting, items?, error? }
 *   GET  /queue      → { ok:true, active, waiting }（全局队列状态）
 *
 * 用法：node ocr_worker.js（PORT / HOST 环境变量可改，默认 3002 / 127.0.0.1；
 *      server.js 侧用 OCR_PORT 环境变量对应修改）
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3002;
const HOST = process.env.HOST || "127.0.0.1"; // 只给 server.js 用，不对外

const OCR_LIMIT = 10 * 1024 * 1024; // 图片上限 10MB
const OCR_TIMEOUT_MS = 60000; // python 识别超时（含模型初始化约 0.5s + 识别 1~2s）
const MAX_QUEUE = 20; // 排队上限：每张图缓冲 ≤10MB，超限直接拒绝，防内存无界增长

/* ---------------- 日志：统一带时间戳（HH:MM:SS），便于与 server.js 日志对照排查 ---------------- */

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...args) => console.log(`[ocr] ${ts()}`, ...args);
const logErr = (...args) => console.error(`[ocr] ${ts()}`, ...args);

/* ---------------- python 解释器定位（与旧 server.js 逻辑一致） ---------------- */

/** 定位 python 解释器（优先选「装好了 rapidocr_onnxruntime」的那个）：
 *  - Linux（Ubuntu 服务器）：默认只有 python3，没有 python 命令（可用 env.PYTHON 覆盖）
 *  - Windows：env.PYTHON 显式指定 > 常见安装目录探测 > py 启动器 > PATH 回退
 *    （pm2 服务启动时 PATH 常缺 Python，所以显式探测安装目录；
 *      一台机器可能装多个 Python，故逐个试 import，而不是只看路径存在） */
function findPython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const candidates = [];
  // 项目内虚拟环境最优先（Ubuntu 24.04 全局 pip 受限，推荐部署方式：
  //   python3 -m venv .venv && .venv/bin/pip install rapidocr_onnxruntime）
  if (process.platform === "win32") {
    candidates.push(path.join(ROOT, ".venv", "Scripts", "python.exe"));
  } else {
    candidates.push(path.join(ROOT, ".venv", "bin", "python3"), path.join(ROOT, ".venv", "bin", "python"));
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local) {
      // 用户级安装（python.org 安装器默认目录）
      for (let v = 13; v >= 7; v--) {
        candidates.push(path.join(local, "Programs", "Python", `Python3${v}`, "python.exe"));
      }
    }
    // 全盘安装 / 常见盘符
    for (const root of ["C:\\", "D:\\"]) {
      for (let v = 13; v >= 7; v--) candidates.push(path.join(root, `Python3${v}`, "python.exe"));
    }
    candidates.push("C:\\Windows\\py.exe"); // Windows py 启动器
  } else {
    candidates.push("python3", "python");
  }

  // 第一轮：逐个实测能否 import rapidocr，能者优先（会多花 1~2 秒，仅启动时一次）
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    try {
      const r = spawnSync(c, ["-c", "import rapidocr_onnxruntime"], { timeout: 30_000 });
      if (r.status === 0) return c;
    } catch {
      /* 试下一个 */
    }
  }
  // 第二轮：都没有装好依赖，退回第一个存在的（启动自检会提示缺什么）
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return process.platform === "win32" ? "python" : "python3";
}

const PYTHON = findPython();

/** 启动自检：解释器可用 + rapidocr 已装（部署新机器需 pip install rapidocr_onnxruntime） */
function checkPython() {
  try {
    const r = spawnSync(PYTHON, ["-c", "import rapidocr_onnxruntime"], { timeout: 30_000 });
    if (r.status === 0) {
      log("python 就绪：" + PYTHON);
      return;
    }
    logErr(
      `${PYTHON} 缺少 rapidocr_onnxruntime，识别不可用 —— 推荐用项目内虚拟环境安装：` +
        `python3 -m venv .venv && .venv/bin/pip install rapidocr_onnxruntime` +
        (process.platform === "linux"
          ? `（会自动使用 .venv；另需系统库：sudo apt install python3-venv libgomp1 libgl1）`
          : ""),
    );
  } catch (err) {
    logErr(
      `python 不可用（${err.message}），识别接口将报错 —— ` +
        (process.platform === "linux"
          ? `请先 sudo apt install python3 python3-pip，或在 ecosystem.config.cjs 的 env.PYTHON 指定解释器`
          : `请在 ecosystem.config.cjs 的 env.PYTHON 指定解释器路径`) +
        `后重启`,
    );
  }
}
setTimeout(checkPython, 1000); // 延后执行，避免拖慢启动日志

/* ---------------- 常驻 python OCR 进程管理 ----------------
 * 2核2G 小服务器适配：python + onnxruntime 模型只加载一次、进程长期存活，
 * 避免每次识别都新起进程（单次峰值约 600MB，重复加载会把小内存服务器压到 OOM）。
 * 协议：4 字节小端长度前缀 + 图片二进制 → 4 字节长度前缀 + JSON（见 ocr_service.py） */

let ocrProc = null; // 长驻 python 进程（懒启动；异常退出后下次请求自动重建）
let ocrPending = null; // { resolve, reject, timer } 同一时间只等一个响应
let ocrBuf = Buffer.alloc(0); // stdout 粘包缓冲

/** 拉起常驻进程 */
function ensureOcrProc() {
  if (ocrProc && ocrProc.exitCode === null) return ocrProc;
  const py = spawn(PYTHON, ["-X", "utf8", path.join(ROOT, "ocr_service.py")], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  ocrProc = py;
  log("拉起常驻 python 进程：" + PYTHON);
  py.stdin.on("error", () => {}); // 进程启动失败时 write 会触发 EPIPE，吞掉
  py.stderr.on("data", (d) => logErr("python: " + String(d).trim()));
  py.stdout.on("data", (d) => {
    ocrBuf = Buffer.concat([ocrBuf, d]);
    while (ocrPending && ocrBuf.length >= 4) {
      const n = ocrBuf.readUInt32LE(0);
      if (ocrBuf.length < 4 + n) break;
      const payload = ocrBuf.subarray(4, 4 + n).toString("utf-8");
      ocrBuf = ocrBuf.subarray(4 + n);
      const p = ocrPending;
      ocrPending = null;
      clearTimeout(p.timer);
      try {
        const j = JSON.parse(payload);
        if (j.ok) p.resolve(j.items);
        else p.reject(new Error(j.error || "OCR 失败"));
      } catch {
        p.reject(new Error("OCR 输出解析失败"));
      }
    }
  });
  py.on("error", (e) => {
    failOcr(
      new Error(
        `无法启动 python（${e.message}）—— 请确认服务器已安装 Python 并执行过 ` +
          `python3 -m venv .venv && .venv/bin/pip install rapidocr_onnxruntime；` +
          `如解释器路径特殊，可在 ecosystem.config.cjs 的 env.PYTHON 指定后重启`,
      ),
    );
  });
  py.on("close", (code, signal) => {
    logErr(
      `识别进程退出（code ${code}${signal ? "，信号 " + signal : ""}），下次请求自动重新拉起`,
    );
    ocrProc = null; // 下次请求自动重新拉起
    failOcr(new Error(`识别进程异常退出（${code}）`));
  });
  return ocrProc;
}

function failOcr(err) {
  if (ocrPending) {
    const p = ocrPending;
    ocrPending = null;
    clearTimeout(p.timer);
    p.reject(err);
  }
  ocrBuf = Buffer.alloc(0);
}

/** 发送一张图给常驻进程（4 字节长度前缀 + 图片），超时杀掉进程重来 */
function runOcr(imageBuf) {
  return new Promise((resolve, reject) => {
    const py = ensureOcrProc();
    if (ocrPending) {
      logErr("OCR 忙（上一张未完成），拒绝新任务");
      return reject(new Error("OCR 忙，请稍后重试"));
    }
    const timer = setTimeout(() => {
      logErr(`识别超时（${OCR_TIMEOUT_MS}ms），杀掉 python 进程`);
      py.kill();
      failOcr(new Error("OCR 超时"));
    }, OCR_TIMEOUT_MS);
    ocrPending = { resolve, reject, timer };
    const head = Buffer.alloc(4);
    head.writeUInt32LE(imageBuf.length);
    py.stdin.write(Buffer.concat([head, imageBuf]));
  });
}

/* ---------------- 任务队列：同一时间只识别一张图，其余排队 ---------------- */

let activeTask = null; // 正在识别的任务 id（null 表示空闲）
const tasks = new Map(); // id → { id, status, waiting, buf, items, error, createdAt, startedAt }
const queue = []; // 排队中的任务 id（FIFO）

function newId() {
  return Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
}

/** 入队并立即返回任务号（页面此后轮询 GET /task?id=） */
function enqueueTask(buf) {
  const id = newId();
  tasks.set(id, {
    id,
    status: "queued",
    waiting: queue.length, // 排在此任务前面的人数
    buf,
    items: null,
    error: null,
    createdAt: Date.now(),
  });
  queue.push(id);
  pump();
  return id;
}

/** 串行泵：当前无识别中任务时，取队首开始识别 */
function pump() {
  if (activeTask || !queue.length) return;
  const id = queue.shift();
  activeTask = id;
  const t = tasks.get(id);
  t.status = "running";
  t.waiting = 0;
  t.startedAt = Date.now();
  log(
    `开始识别 ${id}（图片 ${Math.round(t.buf.length / 1024)}KB，` +
      `排队等待 ${t.startedAt - t.createdAt}ms，队列还剩 ${queue.length} 人）`,
  );
  // 队列前移一位：逐个刷新剩余任务的「前面还有几人」
  queue.forEach((qid, i) => {
    const qt = tasks.get(qid);
    if (qt) qt.waiting = i;
  });
  runOcr(t.buf)
    .then(
      (items) => {
        t.status = "done";
        t.items = items;
        log(
          `识别完成 ${id}：${items.length} 个词条，耗时 ${Date.now() - t.startedAt}ms` +
            (items.length
              ? " → " + items.map((i) => i.text).join(" | ").slice(0, 200)
              : ""),
        );
      },
      (err) => {
        t.status = "error";
        t.error = err.message;
        logErr(`识别失败 ${id}：${err.message}（耗时 ${Date.now() - t.startedAt}ms）`);
      },
    )
    .finally(() => {
      t.buf = null; // 立即释放图片缓冲（只保留识别结果）
      activeTask = null;
      pump(); // 当前完成立即放行下一个
    });
}

/** 结果只保留 5 分钟（页面轮询在秒级完成），到点清理，防任务表无限增长 */
setInterval(() => {
  const now = Date.now();
  let purged = 0;
  for (const [id, t] of tasks) {
    if (t.status !== "queued" && t.status !== "running" && now - t.createdAt > 5 * 60 * 1000) {
      tasks.delete(id);
      purged++;
    }
  }
  if (purged) log(`清理过期任务 ${purged} 个（任务表剩余 ${tasks.size} 个）`);
}, 60 * 1000).unref();

/* ---------------- HTTP 服务 ---------------- */

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

function respond(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(Buffer.from(JSON.stringify(body)));
}

/** POST /task：图片入队，立即返回任务号（识别结果另行轮询） */
function handlePostTask(req, res) {
  readBody(req, OCR_LIMIT)
    .then((buf) => {
      if (!buf.length) return respond(res, 400, { ok: false, error: "请求体为空" });
      if (queue.length >= MAX_QUEUE) {
        log(`排队已满（上限 ${MAX_QUEUE}），拒绝新任务`);
        return respond(res, 429, { ok: false, error: "排队人数过多，请稍后再试" });
      }
      const id = enqueueTask(buf);
      log(`收到图片 ${Math.round(buf.length / 1024)}KB → 任务 ${id}（前方排队 ${queue.length - 1} 人）`);
      respond(res, 200, { ok: true, id });
    })
    .catch((err) => {
      respond(res, err.message.includes("图片过大") ? 413 : 400, { ok: false, error: err.message });
    });
}

/** GET /task?id=：查询任务状态（queued 排队中 / running 识别中 / done 完成 / error 失败） */
function handleGetTask(req, res) {
  const id = (new URL(req.url, "http://localhost").searchParams.get("id") || "").trim();
  const t = tasks.get(id);
  if (!t) return respond(res, 404, { ok: false, error: "任务不存在或已过期，请重新上传" });
  if (t.status === "done") return respond(res, 200, { ok: true, status: t.status, waiting: 0, items: t.items });
  if (t.status === "error") return respond(res, 200, { ok: true, status: t.status, waiting: 0, error: t.error });
  respond(res, 200, { ok: true, status: t.status, waiting: t.waiting });
}

/** GET /queue：全局队列状态 */
function handleQueue(req, res) {
  respond(res, 200, { ok: true, active: !!activeTask, waiting: queue.length });
}

const server = http.createServer((req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (req.method === "POST" && pathname === "/task") return handlePostTask(req, res);
    if (req.method === "GET" && pathname === "/task") return handleGetTask(req, res);
    if (req.method === "GET" && pathname === "/queue") return handleQueue(req, res);
    respond(res, 404, { ok: false, error: "Not Found" });
  } catch (err) {
    logErr(`${req.method} ${req.url} 出错：` + err.message);
    if (!res.headersSent) respond(res, 500, { ok: false, error: err.message });
    else res.end();
  }
});

// 退出时清理常驻 python 子进程，避免 pm2 重启后留下孤儿进程
process.on("exit", () => {
  try {
    ocrProc?.kill();
  } catch {
    /* 忽略 */
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n🎯 OCR 识别服务已启动：http://${HOST}:${PORT}/（只供 server.js 调用，不对外）`);
  console.log(`   队列串行识别：同一时间只处理一张图，排队上限 ${MAX_QUEUE} 人`);
  console.log("   接口：POST /task 提交图片；GET /task?id= 查结果；GET /queue 查队列\n");
});

/**
 * server.js — Node 混合端：静态页面 + 内存 JSON 数据注入
 *
 * 背景：原先纯静态 HTML 靠 <script src="*.json.js?t=..."> 加载数据，
 * 每次打开页面都要额外请求 300KB~800KB 的 JSON 脚本（无压缩、多次往返），加载很慢。
 *
 * 改为 Node 服务后：
 *   1. HTML/CSS/JS/图片仍按静态文件提供，file:// 双击打开照常可用；
 *   2. JSON 在启动时读入内存，响应页面时直接内联注入
 *      <script>window.XXX = {...}</script>，页面只需一次请求，且服务端
 *      把带缩进的 JSON 紧凑化（account-info.json 826KB → 331KB）；
 *   3. 文本响应 gzip 压缩（大 JSON 压缩率约 85%），静态资源带 ETag 缓存头；
 *   4. fs.watchFile 轮询监控 JSON 文件：抓取脚本（data.js / account-info.js /
 *      waigua-info.js）更新文件后，自动重新读入内存，页面下次请求即为新数据。
 *      抓取脚本可能非原子写入（读到半截文件），解析失败会短延时重试，
 *      重试仍失败则保留旧数据继续服务，不会因坏文件下线。
 *
 * 用法：node server.js（PORT 环境变量可改端口，默认 3000）
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0"; // 部署时经 nginx 反代应设为 127.0.0.1（见 ecosystem.config.cjs）

/* ---------------- 内存 JSON 数据源 ---------------- */

/** 数据文件注册表：相对路径 → 注入浏览器的全局变量名（与 *.json.js 里的变量名一致） */
const DATA_FILES = {
  "data.json": "RANK_DATA",
  "equipment.json": "RANK_EQUIPMENT",
  "account-info.json": "ACCOUNT_DATA",
  "waigua-info/history.json": "WAIGUA_HISTORY",
  "waigua-info/today.json": "WAIGUA_TODAY",
};

/** 每个页面注入哪些数据（顺序即注入顺序） */
const PAGE_INJECTS = {
  "rank.html": ["data.json", "equipment.json"],
  "account.html": ["account-info.json"],
  "waigua.html": ["waigua-info/history.json", "waigua-info/today.json"],
};

/** 内存缓存：relPath → { global, text, mtimeMs, size, updatedAt } */
const store = new Map();

const RELOAD_RETRIES = 2; // JSON 解析失败后的重试次数
const RETRY_DELAY_MS = 300; // 重试间隔（毫秒）

/** 读取并解析一个 JSON 文件到内存；解析失败自动重试（应对非原子写入） */
function loadFile(rel, attempt = 0) {
  const abs = path.join(ROOT, rel);
  try {
    const raw = fs.readFileSync(abs, "utf-8");
    const parsed = JSON.parse(raw);
    const stat = fs.statSync(abs);
    store.set(rel, {
      global: DATA_FILES[rel],
      text: JSON.stringify(parsed), // 紧凑化，去掉源文件的缩进
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      updatedAt: Date.now(), // 每次重载自增，参与页面 ETag
    });
    console.log(
      `[data] ${rel} → window.${DATA_FILES[rel]} 已载入内存` +
        `（磁盘 ${(stat.size / 1024).toFixed(0)} KB → 紧凑 ${(store.get(rel).text.length / 1024).toFixed(0)} KB）`,
    );
    return true;
  } catch (err) {
    if (attempt < RELOAD_RETRIES && err instanceof SyntaxError) {
      // 可能是写入到一半被读到（如 data.js 直接 writeFileSync 覆盖），稍后重试
      setTimeout(() => loadFile(rel, attempt + 1), RETRY_DELAY_MS);
      return false;
    }
    console.error(
      `[data] ${rel} 加载失败：${err.message} —— ` +
        (store.has(rel) ? "继续使用内存中的旧数据" : "该数据暂不可用"),
    );
    return false;
  }
}

// 启动时全量载入
for (const rel of Object.keys(DATA_FILES)) loadFile(rel);

// 监听变化：watchFile 按 mtime/size 轮询，兼容「写 .tmp 再 rename」和「直接覆盖」
// 两种写入方式，也兼容编辑器保存产生的连续多次写入（轮询天然防抖）。
// 间隔 2s 对小时级更新的数据足够；如需更快可调小 interval。
for (const rel of Object.keys(DATA_FILES)) {
  fs.watchFile(path.join(ROOT, rel), { interval: 2000 }, (curr, prev) => {
    const cached = store.get(rel);
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
    if (cached && curr.mtimeMs === cached.mtimeMs && curr.size === cached.size) return;
    console.log(`[data] 检测到 ${rel} 变化，重新载入...`);
    loadFile(rel);
  });
}

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
 *  图片基本不变缓存一天；css/js/json 可能被修改，缓存 5 分钟 */
function cacheControlFor(ext) {
  if (ext === ".html") return "no-cache";
  if (ext === ".png" || ext === ".ico" || ext === ".svg") return "public, max-age=86400";
  return "public, max-age=300";
}

/** 页面 gzip 产物缓存（页面只有 3 个，按 ETag 复用压缩结果，避免每次请求重复压缩大 JSON） */
const gzipCache = new Map();

function respond(req, res, { status = 200, type = "text/plain; charset=utf-8", cache = "no-cache", etag, body, compress = false }) {
  const headers = { "Content-Type": type, "Cache-Control": cache };
  if (etag) {
    headers.ETag = etag;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
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
    headers["Content-Encoding"] = "gzip";
    headers.Vary = "Accept-Encoding";
    payload = gz;
  }
  res.writeHead(status, headers);
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
  respond(req, res, {
    type: TYPES[ext] || "application/octet-stream",
    cache: cacheControlFor(ext),
    etag,
    body: fs.readFileSync(filePath),
    compress: COMPRESSIBLE.has(ext),
  });
}

function handle(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return respond(req, res, { status: 405, body: Buffer.from("405 Method Not Allowed\n") });
  }
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
  try {
    handle(req, res);
    console.log(`[http] ${req.method} ${req.url} → ${res.statusCode}`);
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
  console.log(`   内存数据源：${Object.keys(DATA_FILES).join("、")}`);
  console.log("   监控中：JSON 文件变化后自动重载入内存\n");
});

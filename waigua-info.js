// waigua-info.js — 每小时抓取「冒险岛怀旧服-视频举报」列表并落盘 JSON
//
// 用法:
//   node waigua-info.js            单次抓取（供 Windows 计划任务每小时调用）
//   node waigua-info.js --watch    常驻模式，每 60 分钟自动执行一次
//
// 输出（均在 waigua-info/ 目录，waigua.html 直接读取）:
//   waigua-data.json   最新全量记录（按记录 id 去重），waigua.html 的数据源
//   today.json         当日（北京时间）概况：总数 + 按 服务器×处理结果 聚合，
//                      页面默认视图优先读它，无需加载体积不断增长的全量文件
//   history.json       每小时一次的聚合快照（按 日期×服务器×处理结果 计数），
//                      保留最近 90 天，用于追溯历史变化
//   today.json.js / history.json.js
//                      上述两个 JSON 的脚本包装（window.WAIGUA_TODAY / WAIGUA_HISTORY），
//                      供 waigua.html 以 <script src> 加载：浏览器在 file:// 下禁用
//                      fetch，脚本引用则不受限，双击打开页面也能读到数据
//   run.log            运行日志（最近若干次运行摘要）
//
// 目标页为分页 HTML: index.asp?page=N&serch=true&myjb=0
// 每页 10 条，末页页码从第 1 页解析得到；任何一页抓取失败则本次运行放弃写入
//（保留上一份好数据），退出码非 0 便于计划任务告警。

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "waigua-info");
const DATA_FILE = path.join(OUT_DIR, "waigua-data.json");
const TODAY_FILE = path.join(OUT_DIR, "today.json");
const TODAY_JS_FILE = path.join(OUT_DIR, "today.json.js");
const HISTORY_FILE = path.join(OUT_DIR, "history.json");
const HISTORY_JS_FILE = path.join(OUT_DIR, "history.json.js");
const LOG_FILE = path.join(OUT_DIR, "run.log");

const BASE = "https://mxdcact.web.sdo.com/project/mxdts";
const pageUrl = (p) => `${BASE}/index.asp?page=${p}&serch=true&myjb=0`;

const CONCURRENCY = 6; // 并发页数，对 CDN 保持克制
const REQUEST_DELAY_MS = 250; // 每个 worker 两次请求间的间隔
const MAX_RETRIES = 3;
const TIMEOUT_MS = 30_000;
const HOUR_MS = 60 * 60 * 1000;
const HISTORY_KEEP_DAYS = 90;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36 mxd-helper/1.0";

// ---------- 抓取 ----------

async function fetchPageHtml(page, retries = MAX_RETRIES) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(pageUrl(page), {
        headers: {
          "User-Agent": UA,
          Accept: "text/html, */*; q=0.8",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt >= retries) throw new Error(`第 ${page} 页抓取失败: ${err.message}`);
      await sleep(500 * attempt); // 退避重试
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 解析 ----------

// 单条 <li> → 记录对象（字段取不到时为 "-"）
function parseRecord(liHtml) {
  const tds = {};
  const tdRe = /<div class="td td(\d+)">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = tdRe.exec(liHtml)) !== null) {
    tds[m[1]] = cleanText(m[2]);
  }
  const idM = liHtml.match(/pop-info\.asp\?id=(\d+)/);
  const id = idM ? Number(idM[1]) : 0;
  return {
    id,
    date: normDate(tds["1"]), // 举报发起时间
    area: tds["2"], // 大区
    server: tds["3"], // 服务器（如 "1蓝蜗牛"）
    result: tds["7"], // 处理结果
    processDate: normDate(tds["8"]), // 处理时间
  };
}

function cleanText(s) {
  return (s || "")
    .replace(/<[^>]*>/g, "") // 去内嵌标签（如 td4 的 <a>）
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "2026/08/14" → "2026-08-14"，非法值保持原样
function normDate(s) {
  const m = (s || "").match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s || "";
}

// 整页 → { records, lastPage?, totals? }
function parsePage(html) {
  const records = [];
  const liRe = /<li>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRe.exec(html)) !== null) records.push(parseRecord(m[1]));

  let lastPage = null;
  const lastM = html.match(/page=(\d+)[^>]*>\s*末页\s*</);
  if (lastM) lastPage = Number(lastM[1]);
  else {
    const alt = html.match(/\/\s*(\d+)\s*<\/span>/);
    if (alt) lastPage = Number(alt[1]);
  }

  // 底部统计总览: 举报总数 / 举证属实违规数 / 恶意举报人数
  let totals = null;
  const totM = html.match(
    /<td width="346">(\d+)<\/td>\s*<td width="414">(\d+)<\/td>\s*<td>(\d+)<\/td>/,
  );
  if (totM) {
    totals = {
      total: Number(totM[1]),
      violated: Number(totM[2]),
      malicious: Number(totM[3]),
    };
  }
  return { records, lastPage, totals };
}

// ---------- 并发抓取全部分页 ----------

async function crawlAll() {
  const page1 = await fetchPageHtml(1);
  const first = parsePage(page1);
  if (!first.lastPage) throw new Error("无法从第 1 页解析末页页码");

  const pages = Array.from({ length: first.lastPage - 1 }, (_, i) => i + 2);
  const returnRecords = []; // worker 共享收集（单线程事件循环，无竞争）
  const failed = [];
  let done = 0;

  async function worker() {
    while (pages.length) {
      const p = pages.shift();
      await sleep(REQUEST_DELAY_MS);
      try {
        const html = await fetchPageHtml(p);
        const { records } = parsePage(html);
        returnRecords.push(...records); // worker 共享写入（单线程事件循环，安全）
      } catch (err) {
        failed.push(String(err.message || err));
      }
      done++;
      if (done % 200 === 0) log(`  进度 ${done}/${pages.length + done} 页`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  return {
    records: [...first.records, ...returnRecords],
    totals: first.totals,
    lastPage: first.lastPage,
    failed,
  };
}

// ---------- 数据落盘 ----------

function mergeRecords(records) {
  const byId = new Map();
  for (const r of records) byId.set(r.id, r); // 同 id 后者覆盖
  return [...byId.values()].sort((a, b) => (b.id - a.id) || a.date.localeCompare(b.date));
}

// 按 日期×服务器×处理结果 聚合（历史快照用，与 waigua.html 口径一致）
function aggregate(records) {
  const byDate = {};
  for (const r of records) {
    if (!r.date) continue;
    const d = (byDate[r.date] ||= {});
    const s = (d[r.server] ||= {});
    s[r.result] = (s[r.result] || 0) + 1;
  }
  return byDate;
}

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return { entries: [] };
  }
}

function appendHistory(records, nowIso) {
  const history = loadHistory();
  const cutoff = Date.now() - HISTORY_KEEP_DAYS * 24 * HOUR_MS;
  history.entries = history.entries.filter((e) => Date.parse(e.at) >= cutoff);
  history.entries.push({
    at: nowIso,
    recordCount: records.length,
    byDate: aggregate(records),
  });
  atomicWrite(HISTORY_FILE, JSON.stringify(history));
  atomicWrite(HISTORY_JS_FILE, `window.WAIGUA_HISTORY = ${safeJson(history)};`);
}

// 当前北京时间日期 "YYYY-MM-DD"（UTC+8，与记录 date 字段口径一致）
const beijingDate = (ms) => new Date(ms + 8 * HOUR_MS).toISOString().slice(0, 10);

function atomicWrite(file, content) {
  fs.writeFileSync(file + ".tmp", content);
  fs.renameSync(file + ".tmp", file);
}

// 序列化为可内嵌 <script> 的安全 JSON：防止内容里的 </script 提前闭合
function safeJson(obj) {
  return JSON.stringify(obj).replace(/<\//g, "<\\/");
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
}

// 日志裁剪：只保留最近 200 行
function trimLog() {
  try {
    const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
    if (lines.length > 200)
      fs.writeFileSync(LOG_FILE, lines.slice(-200).join("\n") + "\n");
  } catch {
    /* 忽略 */
  }
}

// ---------- 单次运行 ----------

async function runOnce() {
  const started = Date.now();
  const { records, totals, lastPage, failed } = await crawlAll();

  if (failed.length > 0) {
    // 严格模式：任何一页失败都可能漏掉记录（记录会随新举报换页），
    // 保留上一份好数据，本次不写入
    log(`✗ 本次抓取不完整（${failed.length}/${lastPage} 页失败），保留上一份数据`);
    for (const f of failed.slice(0, 5)) log(`  · ${f}`);
    process.exitCode = 1;
    return;
  }

  const merged = mergeRecords(records);
  const nowIso = new Date().toISOString();
  const local = new Date(Date.now() + 8 * HOUR_MS)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19); // 北京时间

  const data = {
    updatedAt: nowIso,
    localTime: local + " (UTC+8)",
    source: `${BASE}/index.asp`,
    totalPages: lastPage,
    siteTotals: totals, // 页面上官方口径的统计，供核对
    recordCount: merged.length,
    records: merged,
  };

  atomicWrite(DATA_FILE, JSON.stringify(data));

  // 当日概况单独落盘：页面默认视图（今日举报）只读这个小文件，避免加载全量 JSON
  const today = beijingDate(Date.now());
  const todayRecords = merged.filter((r) => r.date === today);
  const todayData = {
    updatedAt: nowIso,
    localTime: local + " (UTC+8)",
    date: today,
    source: `${BASE}/index.asp`,
    siteTotals: totals,
    recordCount: todayRecords.length,
    byDate: aggregate(todayRecords), // 与 history.json 聚合口径一致
  };
  atomicWrite(TODAY_FILE, JSON.stringify(todayData));
  atomicWrite(TODAY_JS_FILE, `window.WAIGUA_TODAY = ${safeJson(todayData)};`);

  appendHistory(merged, nowIso);
  trimLog();

  const distinct = {};
  for (const r of merged) distinct[r.result || "(空)"] = (distinct[r.result || "(空)"] || 0) + 1;

  log(
    `✓ 抓取完成: ${merged.length} 条记录（今日 ${todayRecords.length} 条）/ ${lastPage} 页，` +
      `站点口径 举报总数=${totals?.total} 违规属实=${totals?.violated}，` +
      `耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  log(`  处理结果分布: ${Object.entries(distinct).map(([k, v]) => `${k}×${v}`).join(", ")}`);
}

// ---------- 入口 ----------

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const watch = process.argv.includes("--watch");
  log(watch ? "启动常驻模式（每 60 分钟抓取一次）" : "启动单次抓取");
  do {
    try {
      await runOnce();
    } catch (err) {
      log(`✗ 运行异常: ${err.message}`);
      if (!watch) process.exitCode = 1;
    }
    if (!watch) return;
    const jitter = Math.round(120_000 * Math.random()); // ±2 分钟抖动，避免整点洪峰
    log(`下次抓取: ${new Date(Date.now() + HOUR_MS + jitter).toISOString()}`);
    await sleep(HOUR_MS + jitter);
  } while (true);
}

main();

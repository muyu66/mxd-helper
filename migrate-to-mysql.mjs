/**
 * migrate-to-mysql.mjs — 存量 JSON 数据迁移脚本（服务器/本地两源合并，幂等可重跑）
 *
 * 背景：服务器上 account-info.json / waigua-info/* 由 pm2 每小时更新（不进 git、内容最新），
 *       本地 data.json / equipment.json 由手动爬虫维护走 git（内容最新），两边互有新旧。
 * 本脚本把两套 JSON 按各数据集的语义合并进 MySQL（schema.sql 建的表），可反复执行。
 *
 * 用法：
 *   node migrate-to-mysql.mjs --server-dir /var/www/mxd-helper \
 *        --local-dir /var/www/mxd-helper/.migrate-src --dry-run    # 演练：只看计划不写库
 *   node migrate-to-mysql.mjs --server-dir ... --local-dir ... --apply   # 执行
 *   （本地自测：--server-dir . --local-dir . 即两个目录指同一处）
 *
 * 可选参数：
 *   --apply             执行迁移（默认 dry-run 只打印计划与现库行数）
 *   --union-drops       mob_drops 不整包替换，改为两源 (mobid,item_id) 并集 upsert
 *   --with-price-cache  顺带迁入 price-cache.json（默认跳过：TTL 30 分钟重启自然回填）
 *   --fix-exp-mojibake  对已知乱码样本做词表替换（词表外一律不碰）
 *
 * 合并规则（与爬虫语义一一对应）：
 *   mobs          整包覆盖型：取 crawledAt 最新的源，DELETE + 全量 INSERT
 *   mob_drops     整包覆盖型：取文件 mtime 最新的源（equipment.json 无时间戳字段，
 *                 只能以 mtime 判定，报告中显式标注）；--union-drops 改并集 upsert
 *   accounts      主键合并型：两源逐条 upsert（服务器最后执行，同 book_id 服务器胜），无 DELETE
 *   waigua 明细   主键合并型：两源按 id 并集 upsert（官方处理结果可能变 → 覆盖）
 *   waigua 快照   history 按 (kind,at) upsert；today 各插一行（服务器后执行覆盖同 at）；
 *                 最后统一按 max(at) 前 90 天裁剪 kind='history'
 *   exp_reports   主键合并型：按 id 并集 upsert，服务器优先；snapshot 存该条记录原始形态
 *   stats         服务器 stats.json 优先（线上累计真实），无则本地；直接赋值不叠加
 *   price_cache   默认不迁；--with-price-cache 时 upsert（保留 null 语义）
 */
import fs from "node:fs";
import path from "node:path";
import { getPool, q, bulkInsert, bulkUpsert, bumpDatasetMeta } from "./db.js";
import { loadDatasetText, rowToExpReport, canonicalizeMobs, canonicalizeExpReport } from "./data-service.js";
import {
  MOB_COLS, toMobRow,
  DROP_COLS, toDropRow,
  ACC_COLS, ACC_UPD, toAccountRow,
  WAIGUA_COLS, WAIGUA_UPD, toWaiguaRow,
  SNAP_COLS, SNAP_UPD, toSnapshotRow,
  EXP_COLS, EXP_UPD, toExpRow,
  PRICE_COLS, PRICE_UPD, toPriceRow,
} from "./db-rows.js";

/* ---------------- 参数解析 ---------------- */

const ARGS = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    if (eq > 0) {
      ARGS[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (i + 1 < process.argv.length && !process.argv[i + 1].startsWith("--")) {
      ARGS[a.slice(2)] = process.argv[++i]; // "--key value" 形式
    } else {
      ARGS[a.slice(2)] = true;
    }
  }
}
const SERVER_DIR = ARGS["server-dir"] || ARGS.serverDir || ".";
const LOCAL_DIR = ARGS["local-dir"] || ARGS.localDir || ".";
const APPLY = !!ARGS.apply;
const UNION_DROPS = !!ARGS["union-drops"];
const WITH_PRICE_CACHE = !!ARGS["with-price-cache"];
const FIX_EXP_MOJIBAKE = !!ARGS["fix-exp-mojibake"];

/* ---------------- 工具 ---------------- */

function readJson(abs) {
  return JSON.parse(fs.readFileSync(abs, "utf-8"));
}

function fileOf(dir, rel) {
  const abs = path.join(dir, rel);
  return fs.existsSync(abs) ? abs : null;
}

/**
 * 探测一个数据目录里可用的数据集文件（含新鲜度证据）。
 * 返回 { dir, files: { dataset: { path, mtimeMs, crawledAt? } | null } }
 */
function detectSource(dir) {
  const stat = (rel) => {
    const abs = fileOf(dir, rel);
    if (!abs) return null;
    const s = fs.statSync(abs);
    const src = { path: abs, mtimeMs: s.mtimeMs };
    return src;
  };
  const files = {
    mobs: stat("data.json"),
    mob_drops: stat("equipment.json"),
    accounts: stat("account-info.json"),
    waigua_data: stat("waigua-info/waigua-data.json"),
    waigua_history: stat("waigua-info/history.json"),
    waigua_today: stat("waigua-info/today.json"),
    exp_reports: stat("exp-reports.json"),
    stats: stat("stats.json"),
    price_cache: stat("price-cache.json"),
  };
  if (files.mobs) files.mobs.crawledAt = readJson(files.mobs.path).crawledAt || "";
  return { dir, files };
}

const mojibakeHit = (v) => typeof v === "string" && /[�]/.test(v);

/** 已知乱码样本词表（仅覆盖本地 exp 调试期那一条；词表外一律不碰） */
function fixExpMojibakeRow(row) {
  // 唯一已知乱码记录：同一 deviceId 的后续正常记录显示为 枪骑士 / 龙族打猎场
  if (mojibakeHit(row.job)) row.job = "枪骑士";
  if (mojibakeHit(row.map_name)) row.map_name = "龙族打猎场";
  return row;
}

/* ---------------- 行转换：统一来自 db-rows.js（与爬虫/迁移共用同一口径） ---------------- */

/* ---------------- 各数据集迁移步骤 ---------------- */

/** mobs：整包覆盖型，取 crawledAt 最新的源 */
async function migrateMobs(conn, srcs) {
  const candidates = srcs.filter(Boolean);
  if (!candidates.length) return { dataset: "mobs", skip: "两目录都没有 data.json" };
  const winner = candidates.sort((a, b) => Date.parse(b.crawledAt) - Date.parse(a.crawledAt))[0];
  const data = readJson(winner.path);
  await conn.execute(`DELETE FROM mobs`);
  await bulkInsert(conn, "mobs", MOB_COLS, data.items.map(toMobRow));
  await bumpDatasetMeta(conn, "mobs", {
    source: data.source || "",
    extraJson: { crawledAt: data.crawledAt, world: data.world },
    recordCount: data.items.length,
  });
  return {
    dataset: "mobs",
    winner: path.basename(path.dirname(winner.path)) + "/data.json",
    crawledAt: data.crawledAt,
    rows: data.items.length,
  };
}

/** mob_drops：整包覆盖型（equipment.json 无时间戳，以文件 mtime 判新旧） */
async function migrateMobDrops(conn, srcs, union) {
  const candidates = srcs.filter(Boolean);
  if (!candidates.length) return { dataset: "mob_drops", skip: "两目录都没有 equipment.json" };
  const sorted = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const winner = sorted[0];
  const rows = [];
  const pushed = new Set();
  if (union) {
    // 并集：两源按 (mobid,item_id) 去重合并 upsert（旧 mob 的掉落行保留，仅防误删）
    for (const src of sorted) {
      for (const d of readJson(src.path)) {
        const key = `${d.mobid}:${d.id}`;
        if (pushed.has(key)) continue;
        pushed.add(key);
        rows.push(toDropRow(d, rows.length));
      }
    }
    await bulkUpsert(conn, "mob_drops", DROP_COLS, rows,
      [`equipment_name`, `level`, `rate`, `money`, `seq`]);
  } else {
    await conn.execute(`DELETE FROM mob_drops`);
    const data = readJson(winner.path);
    await bulkInsert(conn, "mob_drops", DROP_COLS, data.map(toDropRow));
    rows.push(...data.map(toDropRow));
  }
  await bumpDatasetMeta(conn, "mob_drops", { source: "", recordCount: rows.length });
  return {
    dataset: "mob_drops",
    mode: union ? "union" : "replace",
    winner: `${path.basename(path.dirname(winner.path))}/equipment.json (mtime ${new Date(winner.mtimeMs).toISOString()})`,
    rows: rows.length,
  };
}

/** accounts：主键合并型，本地先、服务器后（同 book_id 服务器胜），无 DELETE */
async function migrateAccounts(conn, srcs) {
  const [local, server] = srcs;
  if (!local && !server) return { dataset: "accounts", skip: "两目录都没有 account-info.json" };
  let count = 0;
  let metaSrc = null;
  for (const [label, src] of [["本地", local], ["服务器", server]]) {
    if (!src) continue;
    const data = readJson(src.path);
    await bulkUpsert(conn, "accounts", ACC_COLS,
      data.records.map(toAccountRow), ACC_UPD);
    count += data.records.length;
    metaSrc = { label, data };
  }
  const [total] = await conn.execute(`SELECT COUNT(*) AS n FROM accounts`);
  await bumpDatasetMeta(conn, "accounts", {
    source: metaSrc.data.source || "",
    extraJson: { updatedAt: metaSrc.data.updatedAt, totalPages: metaSrc.data.totalPages },
    recordCount: total[0].n,
  });
  return { dataset: "accounts", sources: [local && "本地", server && "服务器"].filter(Boolean).join("+"), rows: total[0].n };
}

/** waigua 明细：按 id 并集 upsert */
async function migrateWaiguaData(conn, srcs) {
  const [local, server] = srcs;
  if (!local && !server) return { dataset: "waigua_reports", skip: "两目录都没有 waigua-data.json" };
  const seen = new Set();
  const rows = [];
  for (const [label, src] of [["本地", local], ["服务器", server]]) {
    if (!src) continue;
    const data = readJson(src.path);
    for (const r of data.records) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      rows.push(toWaiguaRow(r));
    }
  }
  await bulkUpsert(conn, "waigua_reports", WAIGUA_COLS, rows, WAIGUA_UPD);
  return { dataset: "waigua_reports", rows: rows.length };
}

/** waigua 快照：history 两源按 (kind,at) upsert；today 各插一行；最后统一 90 天裁剪 */
async function migrateWaiguaSnapshots(conn, srcs) {
  const [localH, serverH, localT, serverT] = srcs;
  let historyRows = 0;
  let todayRows = 0;
  const hSeen = new Set();
  for (const src of [localH, serverH].filter(Boolean)) {
    const data = readJson(src.path);
    const rows = [];
    for (const e of data.entries) {
      const key = `history:${e.at}`;
      if (hSeen.has(key)) continue;
      hSeen.add(key);
      rows.push(toSnapshotRow("history", { at: e.at, recordCount: e.recordCount, byDate: e.byDate }));
    }
    await bulkUpsert(conn, "waigua_snapshots", SNAP_COLS, rows, SNAP_UPD);
    historyRows += rows.length;
  }
  for (const src of [localT, serverT].filter(Boolean)) {
    const t = readJson(src.path);
    await bulkUpsert(conn, "waigua_snapshots", SNAP_COLS, [
      toSnapshotRow("today", {
        at: t.updatedAt, date: t.date, localTime: t.localTime,
        recordCount: t.recordCount, siteTotals: t.siteTotals, byDate: t.byDate,
      }),
    ], SNAP_UPD);
    todayRows += 1;
  }
  await conn.execute(`DELETE FROM waigua_snapshots WHERE kind = 'history' AND at < UTC_TIMESTAMP(3) - INTERVAL 90 DAY`);
  // today 的 meta.source 用最新 today 源；history 无外壳
  const tSrcs = [localT, serverT].filter(Boolean);
  if (tSrcs.length) {
    const newest = tSrcs[tSrcs.length - 1];
    await bumpDatasetMeta(conn, "waigua_today", { source: readJson(newest.path).source || "", recordCount: 1 });
  }
  await bumpDatasetMeta(conn, "waigua_history", { recordCount: historyRows });
  return { dataset: "waigua_snapshots", historyRows, todayRows };
}

/** exp_reports：按 id 并集 upsert，服务器后执行覆盖；乱码检测/可选修复 */
async function migrateExpReports(conn, srcs, fixMojibake) {
  const [local, server] = srcs;
  if (!local && !server) return { dataset: "exp_reports", skip: "两目录都没有 exp-reports.json" };
  const mojibakeById = new Map();
  for (const [label, src] of [["本地", local], ["服务器", server]]) {
    if (!src) continue;
    const data = readJson(src.path);
    const rows = [];
    for (const r of data.reports) {
      if (!r.id) continue; // 旧记录无 id：迁移后不可重建分享链接，跳过并报告
      if (mojibakeHit(r.job) || mojibakeHit(r.mapName)) {
        mojibakeById.set(r.id, { id: r.id, job: r.job, mapName: r.mapName, source: label });
      }
      const row = fixMojibake ? fixExpMojibakeRow(toExpRow(r)) : toExpRow(r);
      rows.push(row);
    }
    await bulkUpsert(conn, "exp_reports", EXP_COLS, rows, EXP_UPD);
  }
  const [cnt] = await conn.execute(`SELECT COUNT(*) AS n FROM exp_reports`);
  return { dataset: "exp_reports", rows: cnt[0].n, mojibakeFound: [...mojibakeById.values()] };
}

/** stats：服务器优先直接赋值（不叠加） */
async function migrateStats(conn, srcs) {
  const [local, server] = srcs;
  const src = server || local;
  if (!src) return { dataset: "site_stats", skip: "两目录都没有 stats.json" };
  const data = readJson(src.path);
  const total = Number(data.totalRequests) || 0;
  await conn.execute(
    `INSERT INTO site_stats (id, total_requests) VALUES (1, ?)
     ON DUPLICATE KEY UPDATE total_requests = VALUES(total_requests)`,
    [total],
  );
  return { dataset: "site_stats", totalRequests: total, source: server ? "服务器" : "本地" };
}

/** price_cache：可选迁入（默认跳过：TTL 30 分钟重启自然回填） */
async function migratePriceCache(conn, srcs) {
  const [local, server] = srcs;
  const src = server || local;
  if (!src) return { dataset: "price_cache", skip: "无 price-cache.json" };
  const data = readJson(src.path);
  const rows = Object.entries(data).map(([k, v]) => toPriceRow(k, v));
  await bulkUpsert(conn, "price_cache", PRICE_COLS, rows, PRICE_UPD);
  return { dataset: "price_cache", rows: rows.length };
}

/* ---------------- 验证 ---------------- */

/** 整包覆盖型：DB 重建文本与规范化后的源比对（mobs 数值字符串 → 数字、total 按行数重算） */
async function verifyReplace(dataset, srcPath) {
  const srcObj = readJson(srcPath);
  const canon = dataset === "mobs" ? canonicalizeMobs(srcObj) : srcObj;
  const norm = JSON.stringify(canon);
  const rebuilt = await loadDatasetText(dataset);
  return { ok: rebuilt === norm, dataset };
}

/** 合并型验证（accounts）：服务器源记录集合 ⊆ DB 注入重建，且同 book_id 字段逐键相等 */
async function verifyAccounts(srcPath) {
  const srcObj = readJson(srcPath);
  const rebuilt = JSON.parse(await loadDatasetText("accounts"));
  const dbMap = new Map(rebuilt.records.map((r) => [r.book_id, r]));
  let missing = 0;
  let mismatch = 0;
  for (const s of srcObj.records) {
    const d = dbMap.get(s.book_id);
    if (!d) { missing++; continue; }
    if (JSON.stringify(s) !== JSON.stringify(d)) mismatch++;
  }
  return { ok: missing === 0 && mismatch === 0, dataset: "accounts", missing, mismatch };
}

/** 合并型验证（exp_reports，不走注入）：服务器源记录集合 ⊆ DB 表，且同 id 字段相等（键序规范化后比） */
async function verifyExpReports(srcPath) {
  const srcObj = readJson(srcPath);
  const rows = await q(`SELECT * FROM exp_reports`);
  const dbMap = new Map(rows.map(rowToExpReport).map((r) => [r.id, r]));
  let missing = 0;
  let mismatch = 0;
  for (const s of srcObj.reports) {
    const d = dbMap.get(s.id);
    if (!d) { missing++; continue; }
    if (JSON.stringify(canonicalizeExpReport(s)) !== JSON.stringify(canonicalizeExpReport(d))) mismatch++;
  }
  return { ok: missing === 0 && mismatch === 0, dataset: "exp_reports", missing, mismatch };
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const server = detectSource(SERVER_DIR);
  const local = detectSource(LOCAL_DIR);
  const plan = [
    { name: "mobs", server: server.files.mobs, local: local.files.mobs },
    { name: "mob_drops", server: server.files.mob_drops, local: local.files.mob_drops },
    { name: "accounts", server: server.files.accounts, local: local.files.accounts },
    { name: "waigua_reports", server: server.files.waigua_data, local: local.files.waigua_data },
    { name: "waigua_snapshots", server: server.files.waigua_history, local: local.files.waigua_history,
      serverT: server.files.waigua_today, localT: local.files.waigua_today },
    { name: "exp_reports", server: server.files.exp_reports, local: local.files.exp_reports },
    { name: "site_stats", server: server.files.stats, local: local.files.stats },
    { name: "price_cache", server: server.files.price_cache, local: local.files.price_cache },
  ];

  const pool = getPool();
  const counts = {};
  for (const t of [`mobs`, `mob_drops`, `accounts`, `waigua_reports`, `waigua_snapshots`, `exp_reports`, `site_stats`, `price_cache`]) {
    const [rows] = await pool.execute(`SELECT COUNT(*) AS n FROM ${t}`);
    counts[t] = rows[0].n;
  }

  console.log(`\n=== 迁移计划（${APPLY ? "执行" : "DRY-RUN，仅演练不写库"}） ===`);
  console.log(`服务器目录: ${path.resolve(SERVER_DIR)}`);
  console.log(`本地目录:   ${path.resolve(LOCAL_DIR)}`);
  console.log(`mob_drops 模式: ${UNION_DROPS ? "并集 upsert" : "整包替换（按 mtime 取新源）"}`);
  console.log(`price_cache: ${WITH_PRICE_CACHE ? "迁入" : "跳过"}`);
  console.log(`乱码修复: ${FIX_EXP_MOJIBAKE ? "开启" : "关闭（仅检测报告）"}`);
  console.log(`\n现库行数: mobs=${counts.mobs} mob_drops=${counts.mob_drops} accounts=${counts.accounts}` +
    ` waigua_reports=${counts.waigua_reports} waigua_snapshots=${counts.waigua_snapshots}` +
    ` exp_reports=${counts.exp_reports} site_stats=${counts.site_stats} price_cache=${counts.price_cache}`);
  for (const p of plan) {
    console.log(`  ${p.name}: 服务器=${p.server ? path.relative(SERVER_DIR, p.server.path) + " ✅" : "无"}` +
      `  本地=${p.local ? path.relative(LOCAL_DIR, p.local.path) + " ✅" : "无"}`);
  }

  if (!APPLY) {
    console.log(`\n确认无误后加 --apply 执行。`);
    process.exit(0);
  }

  const results = [];
  const step = async (fn, ...args) => {
    const t0 = Date.now();
    const r = await fn(...args);
    r.elapsedMs = Date.now() - t0;
    results.push(r);
    console.log(`\n[${r.dataset}] ${r.skip ? `跳过: ${r.skip}` : JSON.stringify(r)}`);
    return r;
  };

  await step(migrateMobs, pool, [plan[0].local, plan[0].server]);
  await step(migrateMobDrops, pool, [plan[1].local, plan[1].server], UNION_DROPS);
  await step(migrateAccounts, pool, [plan[2].local, plan[2].server]);
  await step(migrateWaiguaData, pool, [plan[3].local, plan[3].server]);
  await step(migrateWaiguaSnapshots, pool, [
    plan[4].local, plan[4].server, plan[4].localT, plan[4].serverT,
  ]);
  const expR = await step(migrateExpReports, pool, [plan[5].local, plan[5].server], FIX_EXP_MOJIBAKE);
  await step(migrateStats, pool, [plan[6].local, plan[6].server]);
  if (WITH_PRICE_CACHE) {
    await step(migratePriceCache, pool, [plan[7].local, plan[7].server]);
  } else {
    console.log(`\n[price_cache] 跳过（默认不迁，TTL 30 分钟重启自然回填；--with-price-cache 可迁入）`);
  }

  // 乱码检测报告
  if (expR.mojibakeFound?.length) {
    console.log(`\n⚠ 发现 ${expR.mojibakeFound.length} 条含乱码(U+FFFD)的 exp 记录:`);
    for (const m of expR.mojibakeFound) {
      console.log(`  ${m.id} (${m.source}): job=${JSON.stringify(m.job)} mapName=${JSON.stringify(m.mapName)}` +
        (FIX_EXP_MOJIBAKE ? " → 已按词表修复" : "（原样入库；--fix-exp-mojibake 可修复）"));
    }
  }

  // 一致性验证：整包覆盖型比对重建文本；合并型比对「服务器源 ⊆ DB」
  console.log(`\n=== 一致性验证 ===`);
  const verifies = [];
  if (plan[0].local || plan[0].server) {
    const winner = [plan[0].local, plan[0].server].filter(Boolean)
      .sort((a, b) => Date.parse(b.crawledAt) - Date.parse(a.crawledAt))[0];
    verifies.push(await verifyReplace("mobs", winner.path));
  }
  if (plan[1].local || plan[1].server) {
    const winner = [plan[1].local, plan[1].server].filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    verifies.push(await verifyReplace("mob_drops", winner.path));
  }
  if (plan[2].server) verifies.push(await verifyAccounts(plan[2].server.path));
  if (plan[5].server) verifies.push(await verifyExpReports(plan[5].server.path));
  for (const v of verifies) {
    console.log(`  ${v.dataset}: ${v.ok ? "✅ 一致" : `❌ 不一致 ${JSON.stringify(v)}`}`);
  }

  // 幂等提示
  console.log(`\n=== 幂等检查 ===`);
  console.log(`  再次执行同一命令，各 merge 型数据集应为全 0 变化（replace 型重删重插后行数不变）。`);

  const report = [
    `migrate-to-mysql 执行报告 ${new Date().toISOString()}`,
    `服务器目录: ${path.resolve(SERVER_DIR)}`,
    `本地目录:   ${path.resolve(LOCAL_DIR)}`,
    ``,
    ...results.map((r) => JSON.stringify(r)),
    ``,
    `验证: ${JSON.stringify(verifies)}`,
    ``,
  ].join("\n");
  fs.writeFileSync("migrate-report.txt", report, "utf-8");
  console.log(`\n报告已写入 migrate-report.txt`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`迁移失败: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

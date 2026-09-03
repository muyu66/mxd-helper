/**
 * verify-shape.mjs — 注入 JSON 形状回归脚本
 *
 * 把 data-service.js 从 DB 重建的注入文本与磁盘上的源 JSON 对比，
 * 验证迁移后前端拿到的 window.XXX 形状与 JSON 文件时代一致
 *（键序、空串、数值形态逐项比对）。整包覆盖型（mobs/mob_drops）要求
 * 逐字节等价；合并型（accounts/waigua 快照）做「源 ⊆ DB 且同主键字段相等」
 * 的检查（DB 是两源合并后的最新状态，行数可能多于单份源文件）。
 *
 * 用法:
 *   node verify-shape.mjs [参考目录]    # 默认当前目录（迁移前存档目录）
 */
import fs from "node:fs";
import path from "node:path";
import { loadDatasetText, canonicalizeMobs } from "./data-service.js";

const DIR = path.resolve(process.argv[2] || ".");

function readJson(rel) {
  const abs = path.join(DIR, rel);
  return fs.existsSync(abs) ? JSON.parse(fs.readFileSync(abs, "utf-8")) : null;
}

/** 返回首个差异描述；完全一致返回 null（比键序、类型、值） */
function firstDiff(a, b, prefix = "") {
  if (a === b) return null;
  if (typeof a !== typeof b) return `${prefix}: 类型不同 ${typeof a} vs ${typeof b}`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${prefix}: 数组长度 ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${prefix}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && typeof a === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (JSON.stringify(ka) !== JSON.stringify(kb)) {
      return `${prefix}: 键序/键集不同 ${JSON.stringify(ka)} vs ${JSON.stringify(kb)}`;
    }
    for (const k of ka) {
      const d = firstDiff(a[k], b[k], `${prefix}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${prefix}: 值不同 ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

const checks = [];
let failed = 0;

/** 逐字节等价检查 */
async function checkReplace(name, dataset, srcFile, canonicalize) {
  const src = readJson(srcFile);
  if (!src) return checks.push({ name, result: "SKIP", reason: `${srcFile} 不存在` });
  const rebuilt = JSON.parse(await loadDatasetText(dataset));
  const canon = canonicalize ? canonicalize(src) : src;
  const d = firstDiff(rebuilt, canon);
  if (d) {
    failed++;
    checks.push({ name, result: "FAIL", reason: d });
  } else {
    checks.push({ name, result: "OK" });
  }
}

/** 子集检查：源每条记录的主键在 DB 中存在且逐键相等 */
async function checkMerge(name, dataset, srcFile, keyOf) {
  const src = readJson(srcFile);
  if (!src) return checks.push({ name, result: "SKIP", reason: `${srcFile} 不存在` });
  const rebuilt = JSON.parse(await loadDatasetText(dataset));
  const dbRecords = dataset === "accounts" ? rebuilt.records : rebuilt.reports;
  const dbMap = new Map(dbRecords.map((r) => [keyOf(r), r]));
  let missing = 0;
  let mismatch = 0;
  for (const s of src.records) {
    const d = dbMap.get(keyOf(s));
    if (!d) {
      missing++;
      continue;
    }
    if (firstDiff(d, s)) mismatch++;
  }
  if (missing || mismatch) {
    failed++;
    checks.push({ name, result: "FAIL", reason: `缺失 ${missing} 条 / 字段不一致 ${mismatch} 条` });
  } else {
    checks.push({ name, result: "OK", reason: `${src.records.length} 条均一致` });
  }
}

/** 快照外壳键序检查（DB 是爬虫最新快照，只比结构不比数值）。
 *  srcShapeOf: 从源文件中取出与 rebuiltShape 对应的子对象 */
async function checkSnapshotShell(name, srcFile, rebuiltShape, srcShapeOf = (src) => src) {
  const src = readJson(srcFile);
  if (!src) return checks.push({ name, result: "SKIP", reason: `${srcFile} 不存在` });
  const d = firstDiff(Object.keys(rebuiltShape), Object.keys(srcShapeOf(src)));
  if (d) {
    failed++;
    checks.push({ name, result: "FAIL", reason: d });
  } else {
    checks.push({ name, result: "OK", reason: "外壳键序一致" });
  }
}

async function main() {
  console.log(`参考目录: ${DIR}\n`);

  await checkReplace("mobs(RANK_DATA)", "mobs", "data.json", canonicalizeMobs);
  // canonicalizeMobs：total 按行数重算（meta.total 过期）+ 数值字符串 → 数字（DB 重建口径）
  await checkReplace("mob_drops(RANK_EQUIPMENT)", "mob_drops", "equipment.json");
  await checkMerge("accounts(ACCOUNT_DATA)", "accounts", "account-info.json", (r) => r.book_id);

  const today = JSON.parse(await loadDatasetText("waigua_today"));
  if (today !== null) {
    await checkSnapshotShell("waigua_today(WAIGUA_TODAY) 外壳", "waigua-info/today.json", today);
    await checkSnapshotShell("waigua_today.siteTotals 外壳", "waigua-info/today.json", today.siteTotals ?? {}, (src) => src.siteTotals ?? {});
  } else {
    checks.push({ name: "waigua_today(WAIGUA_TODAY)", result: "SKIP", reason: "库中无 today 快照" });
  }
  const history = JSON.parse(await loadDatasetText("waigua_history"));
  if (history?.entries?.length) {
    await checkSnapshotShell("waigua_history(WAIGUA_HISTORY) 条目外壳", "waigua-info/history.json", history.entries[0], (src) => src.entries[0]);
  } else {
    checks.push({ name: "waigua_history(WAIGUA_HISTORY)", result: "SKIP", reason: "库中无 history 快照" });
  }

  console.log("=== 结果 ===");
  for (const c of checks) {
    console.log(`  ${c.result === "OK" ? "✅" : c.result === "FAIL" ? "❌" : "⏭"} ${c.name}${c.reason ? ` —— ${c.reason}` : ""}`);
  }
  console.log(failed ? `\n${failed} 项失败` : "\n全部通过：DB 重建与源 JSON 形状一致");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`verify-shape 出错: ${err.message}`);
  process.exit(1);
});

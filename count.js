/**
 * 怪物地图最大刷新数量采集
 * 根据 data.json 中的 mobid，抓取每个怪物的详情页，解析最大怪物数量
 */

import { readFileSync, writeFileSync } from "fs";

const DATA_FILE = "data.json";
const BASE_URL = "https://mxdc.dvg.cn/mob_info.php";
const DELAY_MS = 500; // 请求间隔
const MAX_RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 请求 mob_info 页面，失败自动重试
 */
async function fetchPage(mobid, retries = MAX_RETRIES) {
  const url = `${BASE_URL}?id=${mobid}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(1000);
    }
  }
}

/**
 * 解析 HTML，提取所有刷怪数量，返回最大值
 */
function parseMaxSpawn(html) {
  const re = /booklet-mob-map-row-spawns">(\d+)\s*只</g;
  let max = 0;
  let match;
  while ((match = re.exec(html)) !== null) {
    const n = parseInt(match[1], 10);
    if (n > max) max = n;
  }
  return max;
}

async function main() {
  console.log("📂 读取 data.json ...");
  const data = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
  const items = data.items;
  let total = items.length;

  console.log(`🔍 共 ${total} 个怪物，开始逐个查询刷怪数量...\n`);

  let updated = 0;
  let failed = 0;

  for (let i = 0; i < total; i++) {
    const m = items[i];
    const pct = `[${i + 1}/${total}]`;

    try {
      const html = await fetchPage(m.mobid);
      const maxCount = parseMaxSpawn(html);
      m.maxMonsterCount = maxCount;
      updated++;
      console.log(`${pct} ${m.mobname.padEnd(10)}  mobid=${m.mobid}  maxSpawn=${maxCount}`);
    } catch (err) {
      m.maxMonsterCount = 0;
      failed++;
      console.warn(`${pct} ${m.mobname.padEnd(10)}  mobid=${m.mobid}  ❌ ${err.message}`);
      await sleep(1000);
      continue;
    }

    // 请求间隔
    if (i < total - 1) await sleep(DELAY_MS);
  }

  // 写入
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");

  console.log(`\n✅ 完成！成功: ${updated}, 失败: ${failed}, 已保存至 ${DATA_FILE}`);
}

main().catch((err) => {
  console.error("\n❌ 错误:", err.message);
  process.exit(1);
});

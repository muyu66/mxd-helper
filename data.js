/**
 * MXD 怪物数据分页爬虫
 * 从 mxdc.dvg.cn 爬取冒險島怪物数据，支持分页，保存为本地 data.json
 */

const BASE_URL = "https://mxdc.dvg.cn/api/mob-list.php";
const WORLD = "victoria";
const PAGE_SIZE = 100;
const OUTPUT_FILE = "data.json";

// 请求间隔（毫秒），避免请求过快
const DELAY_MS = 300;
// 最大重试次数
const MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 请求单页数据，失败自动重试
 */
async function fetchPage(page, retries = MAX_RETRIES) {
  const url = `${BASE_URL}?world=${WORLD}&page=${page}&pageSize=${PAGE_SIZE}&sortKey=mobid&sortDir=asc`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const json = await res.json();

      if (!json.ok) {
        throw new Error(`API 返回 ok=false，page=${page}`);
      }

      return json;
    } catch (err) {
      if (attempt === retries) {
        throw new Error(
          `第 ${page} 页请求失败（重试 ${retries} 次后）: ${err.message}`
        );
      }
      console.warn(`  ⚠ 第 ${page} 页第 ${attempt} 次失败，${1}s 后重试...`);
      await sleep(1000);
    }
  }
}

/**
 * 主流程
 */
async function crawl() {
  console.log("🚀 开始爬取怪物数据...\n");

  // 第一步：请求第 1 页，获取分页信息
  console.log(`📡 请求第 1 页（获取分页信息）...`);
  const firstPage = await fetchPage(1);
  const { total, totalPages, pageSize } = firstPage.meta;

  console.log(`   total: ${total} 条, totalPages: ${totalPages}, pageSize: ${pageSize}\n`);

  // 收集所有 items
  const allItems = [...firstPage.items];

  // 第二步：爬取剩余页面
  if (totalPages > 1) {
    for (let page = 2; page <= totalPages; page++) {
      console.log(`📡 请求第 ${page}/${totalPages} 页...`);
      const data = await fetchPage(page);
      allItems.push(...data.items);

      // 请求间隔
      if (page < totalPages) {
        await sleep(DELAY_MS);
      }
    }
  }

  // 第三步：保存到本地
  const output = {
    crawledAt: new Date().toISOString(),
    source: BASE_URL,
    world: WORLD,
    total: allItems.length,
    items: allItems,
  };

  const fs = await import("fs");
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf-8");
  // 同步生成 rank.html 的脚本版数据（file:// 双击可用）
  const safeJson = JSON.stringify(output).replace(/<\//g, "<\\/");
  fs.writeFileSync(OUTPUT_FILE + ".js", `window.RANK_DATA = ${safeJson};`, "utf-8");

  console.log(`\n✅ 完成！共 ${allItems.length} 条数据，已保存至 ${OUTPUT_FILE}`);
}

crawl().catch((err) => {
  console.error("\n❌ 爬取失败:", err.message);
  process.exit(1);
});

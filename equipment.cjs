const fs = require("fs");
const path = require("path");
const https = require("https");

const BASE = "https://mxdc.dvg.cn/mob_info.php";
const DATA_FILE = path.join(__dirname, "data.json");
const OUTPUT_FILE = path.join(__dirname, "equipment.json");
const CACHE_FILE = path.join(__dirname, "equipment_cache.json"); // 断点续传缓存
const CONCURRENCY = 3;
const DELAY_MS = 500; // 每次请求间隔

// ---------- 工具函数 ----------

function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          https.get(res.headers.location, (r2) => {
            let body = "";
            r2.on("data", (c) => (body += c));
            r2.on("end", () => resolve(body));
          }).on("error", reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${url}`));
          return;
        }
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- HTML 解析 ----------

function parseEquipGroup(html) {
  // 找到 class="booklet-mob-drop-group is-equip" 的开始位置
  const equipStart = html.indexOf('class="booklet-mob-drop-group is-equip"');
  if (equipStart === -1) return [];

  // 从这个位置往后，找下一个 class="booklet-mob-drop-group（排除当前的 is-equip）
  const searchFrom = equipStart + 50;
  const nextGroupIdx = html.indexOf('class="booklet-mob-drop-group is-', searchFrom);
  const section = nextGroupIdx === -1
    ? html.substring(equipStart)
    : html.substring(equipStart, nextGroupIdx);

  // 匹配每个 <a class="booklet-mob-drop-item"> 中的装备条目
  const itemRegex = /<a class="booklet-mob-drop-item"[^>]*>([\s\S]*?)<\/a>/g;
  const results = [];
  let m;
  while ((m = itemRegex.exec(section)) !== null) {
    const block = m[1];
    const nameMatch = /<span class="booklet-mob-drop-name"[^>]*>([^<]+)<\/span>/.exec(block);
    const idLevelMatch = /<small>ID\s*(\d+)\s*·\s*Lv\.(\d+)<\/small>/.exec(block);
    const rateMatch = /<span class="booklet-mob-drop-rate">([\d.]+)%<\/span>/.exec(block);
    if (nameMatch && idLevelMatch && rateMatch) {
      results.push({
        equipmentName: nameMatch[1].trim(),
        id: parseInt(idLevelMatch[1], 10),
        level: parseInt(idLevelMatch[2], 10),
        rate: parseFloat(rateMatch[1]),
      });
    }
  }
  return results;
}

function parseEquipments(html) {
  return parseEquipGroup(html);
}

// ---------- 主流程 ----------

function loadMobIds() {
  const raw = fs.readFileSync(DATA_FILE, "utf-8");
  const data = JSON.parse(raw);
  const ids = new Set();
  for (const item of data.items) {
    if (item.mobid) ids.add(item.mobid);
  }
  return Array.from(ids);
}

async function main() {
  console.log("读取 data.json ...");
  const mobIds = loadMobIds();
  console.log(`共 ${mobIds.length} 个唯一 mobid\n`);

  // 读取缓存（断点续传）
  let doneMap = {};
  let results = [];
  if (fs.existsSync(CACHE_FILE)) {
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    results = cache.results || [];
    doneMap = cache.doneMap || {};
    console.log(`从缓存恢复: 已完成 ${results.length} 条\n`);
  }

  const pending = mobIds.filter((id) => !doneMap[id]);
  console.log(`待抓取: ${pending.length} 个\n`);

  let count = 0;
  const queue = [...pending];

  async function worker() {
    while (queue.length > 0) {
      const mobid = queue.shift();
      const url = `${BASE}?id=${mobid}`;
      try {
        const html = await fetchHTML(url);
        const items = parseEquipments(html);
        for (const item of items) {
          results.push({ mobid, ...item });
        }
        doneMap[mobid] = true;
        count++;
        const n = items.length;
        process.stdout.write(
          `\r[${count}/${pending.length}] mobid=${mobid} → ${n} 件装备`
        );
      } catch (err) {
        doneMap[mobid] = true; // 标记为已处理，避免死循环
        count++;
        process.stdout.write(
          `\r[${count}/${pending.length}] mobid=${mobid} ❌ ${err.message}`
        );
      }

      // 每 10 个存一次缓存
      if (count % 10 === 0) {
        fs.writeFileSync(
          CACHE_FILE,
          JSON.stringify({ results, doneMap }, null, 2),
          "utf-8"
        );
      }

      await sleep(DELAY_MS);
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  // 写入最终结果
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2), "utf-8");
  console.log(`\n\n完成！共 ${results.length} 条装备掉落记录 → equipment.json`);

  // 清理缓存
  if (fs.existsSync(CACHE_FILE)) {
    fs.unlinkSync(CACHE_FILE);
  }
}

main().catch((err) => {
  console.error("脚本出错:", err);
  process.exit(1);
});

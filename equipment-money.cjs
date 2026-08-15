const fs = require("fs");
const path = require("path");
const https = require("https");

const BASE = "https://mxdc.dvg.cn/api/tip.php";
const EQUIP_FILE = path.join(__dirname, "equipment.json");
const CACHE_FILE = path.join(__dirname, "equipment_money_cache.json");
const CONCURRENCY = 5;
const DELAY_MS = 300;

// ---------- 工具 ----------

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${url}`));
          return;
        }
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- 解析 ----------

function parseMoney(html) {
  const match = /出售价格:\s*([\d,]+)/.exec(html);
  if (!match) return null;
  return parseInt(match[1].replace(/,/g, ""), 10);
}

// ---------- 主流程 ----------

async function main() {
  console.log("读取 equipment.json ...");
  const equipData = JSON.parse(fs.readFileSync(EQUIP_FILE, "utf-8"));
  console.log(`共 ${equipData.length} 条装备记录`);

  // 收集唯一装备 id
  const ids = [...new Set(equipData.map((e) => e.id))];
  console.log(`唯一装备 ${ids.length} 个\n`);

  // 读缓存
  let moneyMap = {};
  let doneCount = 0;
  if (fs.existsSync(CACHE_FILE)) {
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    moneyMap = cache.moneyMap || {};
    doneCount = Object.keys(moneyMap).length;
    console.log(`从缓存恢复: 已查询 ${doneCount} 个\n`);
  }

  const pending = ids.filter((id) => moneyMap[id] == null);
  console.log(`待查询: ${pending.length} 个\n`);

  let count = doneCount;
  const queue = [...pending];

  async function worker() {
    while (queue.length > 0) {
      const id = queue.shift();
      const url = `${BASE}?id=${id}&type=item`;
      try {
        const json = await fetchJSON(url);
        const money = json.ok ? parseMoney(json.html) : null;
        moneyMap[id] = money;
        count++;
        process.stdout.write(
          `\r[${count}/${ids.length}] id=${id} → ${money != null ? money.toLocaleString() : "无价格"}`
        );
      } catch (err) {
        moneyMap[id] = null;
        count++;
        process.stdout.write(
          `\r[${count}/${ids.length}] id=${id} ❌ ${err.message}`
        );
      }

      if (count % 20 === 0) {
        fs.writeFileSync(
          CACHE_FILE,
          JSON.stringify({ moneyMap }, null, 2),
          "utf-8"
        );
      }

      await sleep(DELAY_MS);
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  // 写入最终缓存
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ moneyMap }, null, 2), "utf-8");

  // 更新 equipment.json
  let updated = 0;
  for (const e of equipData) {
    const money = moneyMap[e.id];
    if (money != null) {
      e.money = money;
      updated++;
    }
  }
  fs.writeFileSync(EQUIP_FILE, JSON.stringify(equipData, null, 2), "utf-8");
  // 同步生成 rank.html 的脚本版数据（file:// 双击可用）
  const safeJson = JSON.stringify(equipData).replace(/<\//g, "<\\/");
  fs.writeFileSync(EQUIP_FILE + ".js", `window.RANK_EQUIPMENT = ${safeJson};`, "utf-8");

  console.log(`\n\n完成！共 ${updated} 条补充了价格 → equipment.json`);
  console.log(`有价格的装备: ${Object.values(moneyMap).filter((v) => v != null).length}/${ids.length}`);
}

main().catch((err) => {
  console.error("脚本出错:", err);
  process.exit(1);
});

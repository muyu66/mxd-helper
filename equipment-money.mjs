import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { q, tx, touchDatasetMeta } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE = "https://mxdc.dvg.cn/api/tip.php";
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
  console.log("读取装备列表（MySQL mob_drops 表）...");
  const dropRows = await q(`SELECT DISTINCT item_id AS id FROM mob_drops`);
  console.log(`共 ${dropRows.length} 个唯一装备 id\n`);

  // 收集唯一装备 id
  const ids = [...new Set(dropRows.map((e) => e.id))];
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

  // 按 item_id 回填 mob_drops.money（touch 只改 updated_at，触发 server.js 热重载）
  let updated = 0;
  await tx(async (conn) => {
    for (const [idStr, money] of Object.entries(moneyMap)) {
      if (money == null) continue;
      const [result] = await conn.execute(
        `UPDATE mob_drops SET money = ? WHERE item_id = ?`,
        [money, Number(idStr)],
      );
      updated += result.affectedRows;
    }
    await touchDatasetMeta(conn, "mob_drops");
  });

  console.log(`\n\n完成！共 ${updated} 条掉落记录补充了价格 → mob_drops.money`);
  console.log(`有价格的装备: ${Object.values(moneyMap).filter((v) => v != null).length}/${ids.length}`);
}

main().catch((err) => {
  console.error("脚本出错:", err);
  process.exit(1);
});

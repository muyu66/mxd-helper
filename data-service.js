/**
 * data-service.js — DB 行 → 注入 JSON 文本的形状重建层
 *
 * 迁移契约:server.js 把本模块产出的 text 原样内联为 window.XXX,前端零改动。
 * 因此对象字面量必须严格按源 JSON 文件的键序书写,且遵守与 schema.sql 头注释
 * 配套的转换约定:空串存 NULL、读出还原 "";数值列读出 Number 化;嵌套结构
 * 存 TEXT(JSON 原文)读出 JSON.parse。
 *
 * 单次载入用同一连接完成 meta + 数据查询,避免轮询窗口期读到新旧混合的数据。
 */
import { getPool } from "./db.js";

/* ---------------- 通用转换(与 db.js 的 toDbVal 互逆) ---------------- */

const s = (v) => (v == null ? "" : v); // 字符串列:NULL → ""
const n = (v) => (v == null ? "" : Number(v)); // 数值形态字符串列:NULL → "",否则数字
const i = (v) => (v == null ? null : Number(v)); // 原生 number 列:NULL → null(异常数据兜底)
const jArr = (v) => (v ? JSON.parse(v) : []); // JSON 数组原文列
const jObj = (v) => (v ? JSON.parse(v) : null); // JSON 对象原文列

/** 同一连接上执行 fn(conn),结束释放 */
async function withConn(fn) {
  const conn = await getPool().getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

async function getMeta(conn, dataset) {
  const [rows] = await conn.execute(
    `SELECT source, extra_json FROM dataset_meta WHERE dataset = ?`,
    [dataset],
  );
  const meta = rows[0] ?? null;
  return {
    source: meta ? meta.source ?? "" : "",
    extra: meta && meta.extra_json ? JSON.parse(meta.extra_json) : {},
  };
}

/* ---------------- mobs(← data.json,外壳 {crawledAt, source, world, total, items}) ---------------- */

/** 行转换:严格按 data.json 行的键序 */
function rowToMob(r) {
  return {
    mobid: i(r.mobid),
    mobname: s(r.mobname),
    level: i(r.level),
    category: s(r.category),
    categoryLabel: s(r.category_label),
    boss: i(r.boss),
    elemAttr: s(r.elem_attr),
    elementTags: jArr(r.element_tags),
    icon: s(r.icon),
    hp: n(r.hp),
    mp: n(r.mp),
    exp: n(r.exp),
    hpExp: n(r.hp_exp),
    physHpExp: n(r.phys_hp_exp),
    magHpExp: n(r.mag_hp_exp),
    pad: n(r.pad),
    pdd: n(r.pdd),
    pdr: n(r.pdr),
    madr: n(r.madr),
    mad: n(r.mad),
    mdd: n(r.mdd),
    acc: n(r.acc),
    eva: n(r.eva),
    speed: n(r.speed),
    undead: s(r.undead),
    locationCount: i(r.location_count),
    attributeTags: jArr(r.attribute_tags),
    elemText: s(r.elem_text),
    updated: s(r.updated),
    maxMonsterCount: i(r.max_monster_count),
  };
}

async function loadMobsText() {
  return withConn(async (conn) => {
    const meta = await getMeta(conn, "mobs");
    const [rows] = await conn.execute(
      `SELECT mobid, mobname, level, category, category_label, boss, elem_attr, element_tags,
              icon, hp, mp, exp, hp_exp, phys_hp_exp, mag_hp_exp, pad, pdd, pdr, madr, mad, mdd,
              acc, eva, speed, undead, location_count, attribute_tags, elem_text, updated,
              max_monster_count
       FROM mobs ORDER BY seq`,
    );
    return JSON.stringify({
      crawledAt: meta.extra.crawledAt ?? "",
      source: meta.source,
      world: meta.extra.world ?? "victoria",
      total: rows.length, // 源文件的 meta.total 已过期(100≠实际),以行数重算
      items: rows.map(rowToMob),
    });
  });
}

/* ---------------- mob_drops(← equipment.json,顶层裸数组) ---------------- */

/** 行转换:严格按 equipment.json 行的键序 */
function rowToDrop(r) {
  return {
    mobid: i(r.mobid),
    equipmentName: s(r.equipment_name),
    id: i(r.item_id),
    level: i(r.level),
    rate: i(r.rate),
    money: r.money == null ? null : Number(r.money), // equipment-money 回填后才存在
  };
}

async function loadMobDropsText() {
  return withConn(async (conn) => {
    const [rows] = await conn.execute(
      `SELECT mobid, item_id, equipment_name, level, rate, money FROM mob_drops ORDER BY seq`,
    );
    return JSON.stringify(rows.map(rowToDrop));
  });
}

/* ---------------- accounts(← account-info.json,外壳 {updatedAt, source, totalPages, count, records}) ---------------- */

/** 行转换:严格按 account-info.json 行的键序(页面注入完整版,含两个 title 长字段) */
function rowToAccount(r) {
  return {
    book_id: s(r.book_id),
    goods_list_sub_title: s(r.goods_list_sub_title),
    goods_list_title: s(r.goods_list_title),
    update_time: s(r.update_time),
    price: s(r.price),
    job: s(r.job),
    level: n(r.level), // 源中 level 有数字 50 与空串 "" 两种形态,NULL → ""
    server: s(r.server),
  };
}

async function loadAccountsText() {
  return withConn(async (conn) => {
    const meta = await getMeta(conn, "accounts");
    const [rows] = await conn.execute(
      `SELECT book_id, goods_list_sub_title, goods_list_title, update_time, price, job, level, server
       FROM accounts ORDER BY update_time DESC, book_id ASC, seq ASC`,
    );
    return JSON.stringify({
      updatedAt: meta.extra.updatedAt ?? "",
      source: meta.source,
      totalPages: meta.extra.totalPages ?? 0,
      count: rows.length,
      records: rows.map(rowToAccount),
    });
  });
}

/* ---------------- waigua(快照表 → WAIGUA_HISTORY / WAIGUA_TODAY) ---------------- */

async function loadWaiguaHistoryText() {
  return withConn(async (conn) => {
    const [rows] = await conn.execute(
      `SELECT at, record_count, by_date FROM waigua_snapshots WHERE kind = 'history' ORDER BY at ASC`,
    );
    return JSON.stringify({
      entries: rows.map((r) => ({
        at: new Date(r.at).toISOString(),
        recordCount: r.record_count,
        byDate: JSON.parse(r.by_date),
      })),
    });
  });
}

async function loadWaiguaTodayText() {
  return withConn(async (conn) => {
    const [rows] = await conn.execute(
      `SELECT at, date, local_time, record_count, site_totals, by_date
       FROM waigua_snapshots WHERE kind = 'today' ORDER BY at DESC LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return JSON.stringify(null); // 尚无今日快照:与旧行为「文件不存在则跳过注入」等价
    const meta = await getMeta(conn, "waigua_today");
    return JSON.stringify({
      updatedAt: new Date(row.at).toISOString(),
      localTime: s(row.local_time),
      date: s(row.date),
      source: meta.source,
      siteTotals: jObj(row.site_totals),
      recordCount: row.record_count,
      byDate: JSON.parse(row.by_date),
    });
  });
}

/* ---------------- exp(行转换供 server.js 使用,不经注入) ---------------- */

/** DB 行 → /api/exp/reports 的记录形状(与 server.js buildExpRecord 产出的结构一致) */
export function rowToExpReport(row) {
  return {
    id: row.id,
    deviceId: row.device_id,
    level: row.level,
    job: row.job,
    mapId: row.map_id,
    mapName: row.map_name,
    partyMode: row.party_mode,
    startTime: row.start_time ? new Date(row.start_time).toISOString() : null,
    endTime: row.end_time ? new Date(row.end_time).toISOString() : null,
    durationSeconds: Number(row.duration_seconds),
    delta: {
      gold: Number(row.delta_gold),
      hpPotionUsed: row.delta_hp_potion_used,
      mpPotionUsed: row.delta_mp_potion_used,
      expGained: Number(row.delta_exp_gained),
      levelsGained: row.delta_levels_gained,
    },
    profit: {
      expPerHour: Number(row.profit_exp_per_hour),
      goldPerHour: Number(row.profit_gold_per_hour),
      potionValue: Number(row.profit_potion_value),
      potionHpValue: Number(row.profit_potion_hp_value),
      potionMpValue: Number(row.profit_potion_mp_value),
      potionHpPerHour: Number(row.profit_potion_hp_per_hour),
      potionMpPerHour: Number(row.profit_potion_mp_per_hour),
    },
    serverTime: row.server_time ? new Date(row.server_time).toISOString() : null,
  };
}

/* ---------------- 源 JSON 规范化（验证用：把源按与 DB 重建相同的转换规则重写） ---------------- */

const MOB_NUM_COLS = ["hp", "mp", "exp", "hpExp", "physHpExp", "magHpExp", "pad", "pdd", "pdr", "madr", "mad", "mdd", "acc", "eva", "speed"];

/** 怪物行规范化：数值形态字符串 → 数字（"" 保持 ""），键序按源文件顺序 */
export function canonicalizeMobItem(item) {
  const out = {};
  for (const k of Object.keys(item)) {
    out[k] = MOB_NUM_COLS.includes(k) ? (item[k] === "" ? "" : Number(item[k])) : item[k];
  }
  return out;
}

/** mobs 源规范化：total 按行数重算（源 meta.total 已过期），items 逐行规范化 */
export function canonicalizeMobs(src) {
  return { ...src, total: src.items.length, items: src.items.map(canonicalizeMobItem) };
}

/** exp 记录规范化：按 server.js 产出的固定键序重排（源文件中 id 位置不统一，比较时忽略键序差异） */
export function canonicalizeExpReport(r) {
  return {
    id: r.id,
    deviceId: r.deviceId,
    level: r.level,
    job: r.job,
    mapId: r.mapId,
    mapName: r.mapName,
    partyMode: r.partyMode,
    startTime: r.startTime,
    endTime: r.endTime,
    durationSeconds: r.durationSeconds,
    delta: {
      gold: r.delta.gold,
      hpPotionUsed: r.delta.hpPotionUsed,
      mpPotionUsed: r.delta.mpPotionUsed,
      expGained: r.delta.expGained,
      levelsGained: r.delta.levelsGained,
    },
    profit: {
      expPerHour: r.profit.expPerHour,
      goldPerHour: r.profit.goldPerHour,
      potionValue: r.profit.potionValue,
      potionHpValue: r.profit.potionHpValue,
      potionMpValue: r.profit.potionMpValue,
      potionHpPerHour: r.profit.potionHpPerHour,
      potionMpPerHour: r.profit.potionMpPerHour,
    },
    serverTime: r.serverTime,
  };
}

/* ---------------- 入口 ---------------- */

/** 注入数据集注册表:dataset 名 → loader(与 server.js 的 DATA_FILES 对应) */
export const LOADERS = {
  mobs: loadMobsText,
  mob_drops: loadMobDropsText,
  accounts: loadAccountsText,
  waigua_history: loadWaiguaHistoryText,
  waigua_today: loadWaiguaTodayText,
};

/** 载入单个数据集的注入文本(server.js 热重载用) */
export async function loadDatasetText(dataset) {
  const loader = LOADERS[dataset];
  if (!loader) throw new Error(`未知数据集:${dataset}`);
  return loader();
}

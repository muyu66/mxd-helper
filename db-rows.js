/**
 * db-rows.js — JSON 记录 → DB 行参数的共享转换层
 *
 * 迁移脚本（migrate-to-mysql.mjs）与各爬虫（data.js / equipment.mjs /
 * account-info.js / waigua-info.js / server.js 的 exp 上报）共用同一份
 * 行转换与列定义，保证写入口径唯一。列序与 schema.sql 对应表一致。
 * 值规范统一走 db.js 的 toDbVal（"" → null、数组/对象 → JSON 原文）。
 */
import { toDbVal } from "./db.js";

/** 逗号分隔列清单 → 数组（列序与 schema.sql 对应表一致） */
const cols = (s) => s.split(",").map((c) => c.trim());

/* ---------------- mobs ---------------- */

export const MOB_COLS = cols(`mobid, seq, mobname, level, category, category_label, boss, elem_attr, element_tags,
  icon, hp, mp, exp, hp_exp, phys_hp_exp, mag_hp_exp, pad, pdd, pdr, madr, mad, mdd,
  acc, eva, speed, undead, location_count, attribute_tags, elem_text, updated, max_monster_count`);

export function toMobRow(item, seq) {
  return [
    item.mobid, seq, toDbVal(item.mobname), toDbVal(item.level), toDbVal(item.category),
    toDbVal(item.categoryLabel), toDbVal(item.boss), toDbVal(item.elemAttr),
    toDbVal(item.elementTags), toDbVal(item.icon), toDbVal(item.hp), toDbVal(item.mp),
    toDbVal(item.exp), toDbVal(item.hpExp), toDbVal(item.physHpExp), toDbVal(item.magHpExp),
    toDbVal(item.pad), toDbVal(item.pdd), toDbVal(item.pdr), toDbVal(item.madr),
    toDbVal(item.mad), toDbVal(item.mdd), toDbVal(item.acc), toDbVal(item.eva),
    toDbVal(item.speed), toDbVal(item.undead), toDbVal(item.locationCount),
    toDbVal(item.attributeTags), toDbVal(item.elemText), toDbVal(item.updated),
    toDbVal(item.maxMonsterCount),
  ];
}

/* ---------------- mob_drops ---------------- */

export const DROP_COLS = cols(`mobid, item_id, seq, equipment_name, level, rate, money`);

export function toDropRow(d, seq) {
  return [d.mobid, d.id, seq, toDbVal(d.equipmentName), toDbVal(d.level), toDbVal(d.rate), toDbVal(d.money)];
}

/* ---------------- accounts ---------------- */

export const ACC_COLS = cols(`book_id, seq, goods_list_sub_title, goods_list_title, update_time, price, server, job, level`);
export const ACC_UPD = [`goods_list_sub_title`, `goods_list_title`, `update_time`, `price`, `server`, `job`, `level`];

export function toAccountRow(r, seq) {
  return [
    r.book_id, seq, toDbVal(r.goods_list_sub_title), toDbVal(r.goods_list_title),
    toDbVal(r.update_time), toDbVal(r.price), toDbVal(r.server), toDbVal(r.job),
    toDbVal(r.level),
  ];
}

/* ---------------- waigua 明细 ---------------- */

export const WAIGUA_COLS = cols(`id, date, area, server, result, process_date`);
export const WAIGUA_UPD = [`date`, `area`, `server`, `result`, `process_date`];

export function toWaiguaRow(r) {
  return [r.id, toDbVal(r.date), toDbVal(r.area), toDbVal(r.server), toDbVal(r.result), toDbVal(r.processDate)];
}

/* ---------------- waigua 快照 ---------------- */

export const SNAP_COLS = cols(`kind, at, date, local_time, record_count, site_totals, by_date`);
export const SNAP_UPD = [`date`, `local_time`, `record_count`, `site_totals`, `by_date`];

/** kind=history 的 date/local_time/site_totals 传 undefined → NULL */
export function toSnapshotRow(kind, { at, date, localTime, recordCount, siteTotals, byDate }) {
  return [
    kind, at ? new Date(at) : null, toDbVal(date), toDbVal(localTime),
    recordCount, toDbVal(siteTotals), JSON.stringify(byDate),
  ];
}

/* ---------------- exp_reports ---------------- */

export const EXP_COLS = cols(`id, device_id, level, job, map_id, map_name, party_mode,
  start_time, end_time, duration_seconds,
  delta_gold, delta_hp_potion_used, delta_mp_potion_used, delta_exp_gained, delta_levels_gained,
  profit_exp_per_hour, profit_gold_per_hour, profit_potion_value,
  profit_potion_hp_value, profit_potion_mp_value,
  profit_potion_hp_per_hour, profit_potion_mp_per_hour,
  server_time, snapshot, note, power, vip`);
export const EXP_UPD = EXP_COLS.filter((c) => c !== "id");

/**
 * 上报记录 → exp_reports 一行参数。
 * snapshot 缺省存该条记录本身（迁移场景：exp-reports.json 的记录即原始形态）；
 * server.js 实时上报时显式传入客户端原始 body（校验前原文，供审计）。
 * 时间字段传 Date，mysql2 按连接时区 +00:00 序列化。
 */
export function toExpRow(r, snapshot = r) {
  return [
    r.id, toDbVal(r.deviceId), toDbVal(r.level), toDbVal(r.job), toDbVal(r.mapId),
    toDbVal(r.mapName), toDbVal(r.partyMode),
    r.startTime ? new Date(r.startTime) : null, r.endTime ? new Date(r.endTime) : null,
    toDbVal(r.durationSeconds),
    toDbVal(r.delta?.gold), toDbVal(r.delta?.hpPotionUsed), toDbVal(r.delta?.mpPotionUsed),
    toDbVal(r.delta?.expGained), toDbVal(r.delta?.levelsGained),
    toDbVal(r.profit?.expPerHour), toDbVal(r.profit?.goldPerHour), toDbVal(r.profit?.potionValue),
    toDbVal(r.profit?.potionHpValue), toDbVal(r.profit?.potionMpValue),
    toDbVal(r.profit?.potionHpPerHour), toDbVal(r.profit?.potionMpPerHour),
    r.serverTime ? new Date(r.serverTime) : null,
    JSON.stringify(snapshot),
    toDbVal(r.note), toDbVal(r.power),
    vipToDb(r.vip), // 会员加成:布尔 → 0/1，null/缺省 → NULL(未知)
  ];
}

/** vip 布尔转库值:null/undefined → NULL,true → 1,false → 0（共享给 server.js 的 PATCH 落库） */
export function vipToDb(v) {
  if (v === undefined || v === null) return null;
  return v ? 1 : 0;
}

/* ---------------- price_cache ---------------- */

export const PRICE_COLS = cols(`keyword, t, lowest, avg, count, total_page`);
export const PRICE_UPD = [`t`, `lowest`, `avg`, `count`, `total_page`];

export function toPriceRow(k, v) {
  return [k, v.t, v.lowest == null ? null : v.lowest, v.avg == null ? null : v.avg, v.count, v.totalPage];
}

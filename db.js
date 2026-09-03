/**
 * db.js — MySQL 8.0 数据访问层（mysql2/promise 连接池）
 *
 * 连接配置：环境变量 MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD /
 * MYSQL_DATABASE 优先（服务器在 ecosystem.config.cjs 的 pm2 env 里配置）。
 * 未设置时回退到本地开发默认值 127.0.0.1 / root / 123456 / mxd_helper
 * ——仅本地开发用，生产一律走环境变量，勿把生产口令写进代码。
 *
 * 全局约定：
 *   - timezone 固定 "+00:00"：TIMESTAMP 读写统一 UTC，保证 ISO "Z" 字符串往返。
 *   - DECIMAL 列 mysql2 读回为字符串，数值列统一经 Number() 转换（见 data-service.js）。
 *   - 首次连接失败会抛出带排障指引的错误（先跑 schema.sql 建库，再跑迁移脚本）。
 */
import mysql from "mysql2/promise";

export const DB_CONFIG = {
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "123456",
  database: process.env.MYSQL_DATABASE || "mxd_helper",
  charset: "utf8mb4",
  timezone: "+00:00",
  dateStrings: false,
  supportBigNumbers: true,
  bigNumberStrings: false,
  waitForConnections: true,
  connectionLimit: Number(process.env.MYSQL_POOL_SIZE || 8),
};

let pool = null;

/** 惰性创建连接池；连接失败抛清晰错误（含排障指引） */
export function getPool() {
  if (!pool) pool = mysql.createPool(DB_CONFIG);
  return pool;
}

/** 查询多行 */
export async function q(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

/** 查询单行（无结果返回 null） */
export async function qOne(sql, params = []) {
  const rows = await q(sql, params);
  return rows[0] ?? null;
}

/** 事务：begin → fn(conn) → commit / rollback，结束释放连接 */
export async function tx(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const r = await fn(conn);
    await conn.commit();
    return r;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** 批量 INSERT（conn 传入以复用事务连接）；每 chunkSize 行一组参数化 VALUES */
export async function bulkInsert(conn, table, cols, rows, chunkSize = 500) {
  if (!rows.length) return;
  const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES ?`;
  for (let i = 0; i < rows.length; i += chunkSize) {
    await conn.query(sql, [rows.slice(i, i + chunkSize)]);
  }
}

/** 批量 UPSERT：INSERT ... VALUES ? ON DUPLICATE KEY UPDATE updateCols=VALUES(...) */
export async function bulkUpsert(conn, table, cols, rows, updateCols, chunkSize = 500) {
  if (!rows.length) return;
  const upd = updateCols.map((c) => `${c}=VALUES(${c})`).join(", ");
  const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES ? ON DUPLICATE KEY UPDATE ${upd}`;
  for (let i = 0; i < rows.length; i += chunkSize) {
    await conn.query(sql, [rows.slice(i, i + chunkSize)]);
  }
}

/**
 * 值规范（JSON → DB 的统一转换，与 schema.sql 头注释的约定配套）：
 *   "" / undefined → null；数组/对象 → JSON.stringify 原文；其余原样。
 *   注意 null 原样保留（price_cache.lowest 的 null 语义要靠它区分于空串）。
 */
export function toDbVal(v) {
  if (v === undefined || v === "") return null;
  if (Array.isArray(v) || (v && typeof v === "object")) return JSON.stringify(v);
  return v;
}

/** 事务内 bump 数据集元信息：server.js 靠 updated_at 变化感知热重载（upsert，首次写入自动建行） */
export async function bumpDatasetMeta(conn, dataset, { source = "", extraJson = null, recordCount = 0 } = {}) {
  await conn.execute(
    `INSERT INTO dataset_meta (dataset, updated_at, source, extra_json, record_count)
     VALUES (?, UTC_TIMESTAMP(3), ?, ?, ?)
     ON DUPLICATE KEY UPDATE updated_at = UTC_TIMESTAMP(3), source = VALUES(source),
       extra_json = VALUES(extra_json), record_count = VALUES(record_count)`,
    [dataset, source, extraJson == null ? null : JSON.stringify(extraJson), recordCount],
  );
}

/** 仅触发热重载（只改 updated_at，不动 source/extra_json/record_count）。
 *  用于 count.js / equipment-money.mjs 这类「回填个别字段」的写入方。
 *  要求 dataset_meta 行已存在（先跑过整包写入或迁移脚本），行不存在时无效果。 */
export async function touchDatasetMeta(conn, dataset) {
  await conn.execute(`UPDATE dataset_meta SET updated_at = UTC_TIMESTAMP(3) WHERE dataset = ?`, [dataset]);
}

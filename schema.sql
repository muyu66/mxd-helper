-- schema.sql — mxd-helper MySQL 8.0 表结构
--
-- 用法:
--   本地:mysql -uroot -p123456 < schema.sql
--   服务器:mysql -uroot -p < schema.sql
--
-- 服务器应用账号(部署时按需执行一次,口令自定):
--   CREATE USER 'mxd'@'localhost' IDENTIFIED BY '<随机强口令>';
--   GRANT SELECT,INSERT,UPDATE,DELETE ON mxd_helper.* TO 'mxd'@'localhost';
--
-- 设计约定(与 data-service.js / db.js 的转换规则配套):
--   1. 源 JSON 的空串 "" 一律存 NULL,重建时还原 ""(数值列同理:NULL→"")。
--   2. 源中数值形态字符串(如 "8"、"2.67")存入 DECIMAL/BIGINT,重建输出 JSON number。
--   3. 嵌套数组/对象存 TEXT(JSON.stringify 原文,键序保真,不用 MySQL JSON 类型);
--      唯一例外 exp_reports.snapshot 用 JSON 列(纯审计存档,不参与形状重建)。
--   4. 全部表 ENGINE=InnoDB,默认 utf8mb4_0900_ai_ci。

CREATE DATABASE IF NOT EXISTS mxd_helper CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE mxd_helper;

-- 注入页面数据集的版本元信息:server.js 轮询本表判定热重载,只信任 updated_at 变化
CREATE TABLE dataset_meta (
  dataset      VARCHAR(48)  NOT NULL COMMENT 'mobs/mob_drops/accounts/waigua_history/waigua_today',
  updated_at   DATETIME(3)  NOT NULL COMMENT '源数据最新写入时刻(UTC),由写入方事务内 bump',
  source       VARCHAR(255) NOT NULL DEFAULT '' COMMENT '数据来源 URL 或说明',
  extra_json   TEXT         NULL COMMENT '数据集外壳字段:{crawledAt,source,world}|{updatedAt,localTime,date,totalPages} 等',
  record_count INT          NOT NULL DEFAULT 0,
  payload_md5  CHAR(32)     NOT NULL DEFAULT '' COMMENT '重建注入文本的 md5(变更检测辅助,可后补)',
  PRIMARY KEY (dataset)
) COMMENT='注入页面数据集的版本元信息';

-- 怪物明细(data.json.items,65 条,整包覆盖型)
CREATE TABLE mobs (
  mobid              INT           NOT NULL COMMENT '怪物 id(源主键)',
  seq                INT           NOT NULL COMMENT '源数组顺序,重建保序',
  mobname            VARCHAR(64)   NULL,
  level              SMALLINT      NULL,
  category           VARCHAR(64)   NULL COMMENT '源中全为 ""',
  category_label     VARCHAR(64)   NULL,
  boss               TINYINT       NULL,
  elem_attr          VARCHAR(128)  NULL,
  element_tags       TEXT          NULL COMMENT 'JSON 数组原文(键序保真)',
  icon               VARCHAR(255)  NULL,
  hp                 DECIMAL(24,6) NULL COMMENT '以下数值形态列:源为字符串/空串,空串→NULL',
  mp                 DECIMAL(24,6) NULL,
  exp                DECIMAL(24,6) NULL,
  hp_exp             DECIMAL(24,6) NULL,
  phys_hp_exp        DECIMAL(24,6) NULL,
  mag_hp_exp         DECIMAL(24,6) NULL,
  pad                DECIMAL(24,6) NULL,
  pdd                DECIMAL(24,6) NULL,
  pdr                DECIMAL(24,6) NULL,
  madr               DECIMAL(24,6) NULL,
  mad                DECIMAL(24,6) NULL,
  mdd                DECIMAL(24,6) NULL,
  acc                DECIMAL(24,6) NULL,
  eva                DECIMAL(24,6) NULL,
  speed              DECIMAL(24,6) NULL COMMENT '允许负数 "-65"',
  undead             VARCHAR(16)   NULL COMMENT '源为 "否"',
  location_count     INT           NULL,
  attribute_tags     TEXT          NULL COMMENT 'JSON 数组原文',
  elem_text          VARCHAR(255)  NULL,
  updated            VARCHAR(32)   NULL COMMENT '"2026-08-04 09:28:24" 原样字符串',
  max_monster_count  INT           NULL COMMENT 'count.js 回填',
  PRIMARY KEY (mobid)
) COMMENT='怪物明细:data.json.items 整包覆盖型';

-- 装备掉落(equipment.json,顶层裸数组 773 行,整包覆盖型;单表 1:1 不归一化)
CREATE TABLE mob_drops (
  mobid          INT           NOT NULL,
  item_id        INT           NOT NULL COMMENT '源字段名 id(装备唯一 id)',
  seq            INT           NOT NULL COMMENT '源数组顺序',
  equipment_name VARCHAR(128)  NULL,
  level          SMALLINT      NULL,
  rate           DECIMAL(10,6) NULL COMMENT '0.09 → 0.090000,重建 Number→0.09',
  money          DECIMAL(20,2) NULL COMMENT 'equipment-money 按 item_id 回填',
  PRIMARY KEY (mobid, item_id),
  KEY idx_drop_item (item_id)
) COMMENT='装备掉落:equipment.json 顶层裸数组,整包覆盖型';

-- 挂售账号(account-info.json.records,2198 条,book_id 合并型,只增不减)
CREATE TABLE accounts (
  book_id              VARCHAR(40)   NOT NULL COMMENT '32 位数字串,唯一键',
  seq                  INT           NOT NULL DEFAULT 0 COMMENT '首次导入顺序,排序兜底',
  goods_list_sub_title VARCHAR(255)  NULL,
  goods_list_title     VARCHAR(1000) NULL COMMENT '页面完整注入需要(≠ .json.js 精简版)',
  update_time          VARCHAR(19)   NULL COMMENT '"2026-08-15 12:23:55" 原样,避免 DATETIME 时区归一化',
  price                VARCHAR(24)   NULL COMMENT '"388.00" 原样保留显示形态',
  server               VARCHAR(64)   NULL COMMENT 'deriveServer 派生',
  job                  VARCHAR(64)   NULL COMMENT 'deriveJob 派生;取不到为 "" → NULL',
  level                SMALLINT      NULL COMMENT '2197 条数字 + 1 条 "" → NULL',
  first_seen_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (book_id),
  KEY idx_account_update (update_time)
) COMMENT='挂售账号:book_id 主键 upsert 合并,永不删除';

-- 举报明细(waigua-data.json.records,9209 条持续增长,id 合并型)
CREATE TABLE waigua_reports (
  id            INT         NOT NULL COMMENT '官方记录 id',
  date          VARCHAR(10) NULL COMMENT '"2026-08-14"',
  area          VARCHAR(16) NULL,
  server        VARCHAR(64) NULL COMMENT '"1蓝蜗牛"',
  result        VARCHAR(128) NULL COMMENT '处理结果文案,最长 30+ 中文字符',
  process_date  VARCHAR(10) NULL COMMENT '可为 ""',
  first_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_wg_date (date),
  KEY idx_wg_server (server)
) COMMENT='举报明细:官方处理结果可能变→upsert 覆盖,只增不减';

-- 聚合快照(today.json 一行 + history.json.entries 多行;页面消费的是爬虫聚合口径,DB 不重聚合)
CREATE TABLE waigua_snapshots (
  id           BIGINT UNSIGNED AUTO_INCREMENT,
  kind         VARCHAR(10)  NOT NULL COMMENT "'history' | 'today'",
  at           DATETIME(3)  NOT NULL COMMENT 'history: entry.at / today: updatedAt(UTC)',
  date         CHAR(10)     NULL COMMENT '仅 today 用(北京时间日)',
  local_time   VARCHAR(64)  NULL COMMENT '仅 today 用:"2026-08-14 22:56:12 (UTC+8)"',
  record_count INT          NOT NULL,
  site_totals  TEXT         NULL COMMENT 'JSON {"total":9209,...} 原文',
  by_date      TEXT         NOT NULL COMMENT 'JSON 三层嵌套原文(日期→服务器→结果→计数,键序保真)',
  PRIMARY KEY (id),
  UNIQUE KEY uk_snap (kind, at)
) COMMENT='聚合快照:90 天裁剪只删 kind=history';

-- 经验上报(exp-reports.json.reports,29 条,append-only;delta/profit 全展平)
CREATE TABLE exp_reports (
  id              VARCHAR(32)    NOT NULL COMMENT '"mt8atfozed2c61"(base36 时间戳+hex)',
  seq             BIGINT UNSIGNED AUTO_INCREMENT COMMENT '追加序:文件数组顺序与新增顺序',
  device_id       VARCHAR(64)    NOT NULL,
  level           SMALLINT       NULL,
  job             VARCHAR(64)    NULL COMMENT '历史乱码原样入库',
  map_id          INT            NULL,
  map_name        VARCHAR(255)   NULL COMMENT '历史乱码原样入库',
  party_mode      VARCHAR(16)    NULL,
  start_time      TIMESTAMP(3)   NULL COMMENT '连接时区固定 +00:00,重建 toISOString() 还原 "Z" 串',
  end_time        TIMESTAMP(3)   NULL,
  duration_seconds DECIMAL(10,3) NULL COMMENT '有小数(实测 1.277),DECIMAL 保精度',
  delta_gold          BIGINT      NULL,
  delta_hp_potion_used  INT       NULL,
  delta_mp_potion_used  INT       NULL,
  delta_exp_gained     BIGINT     NULL,
  delta_levels_gained  SMALLINT   NULL,
  profit_exp_per_hour  BIGINT     NULL,
  profit_gold_per_hour BIGINT     NULL,
  profit_potion_value  BIGINT     NULL,
  profit_potion_hp_value BIGINT   NULL,
  profit_potion_mp_value BIGINT   NULL,
  profit_potion_hp_per_hour BIGINT NULL,
  profit_potion_mp_per_hour BIGINT NULL,
  server_time      TIMESTAMP(3)   NULL,
  snapshot         JSON           NULL COMMENT '客户端上报的原始请求体(校验前 body 原文),审计/回溯用',
  note             VARCHAR(500)   NULL COMMENT '备注(客户端可选,空串存 NULL)',
  power            INT            NULL COMMENT '攻击力/魔法力(客户端可选)',
  vip              TINYINT(1)     NULL DEFAULT NULL COMMENT '会员加成:1=有会员/0=无会员/NULL=未知(v2上报属性,布尔转存)',
  PRIMARY KEY (id),
  UNIQUE KEY uk_exp_seq (seq),
  KEY idx_exp_device (device_id),
  KEY idx_exp_server_time (server_time)
) COMMENT='经验上报:append-only,不回写不删除';

-- 询价缓存持久层(内存 LRU 为主,DB 仅持久化;只增改不删)
CREATE TABLE price_cache (
  keyword    VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '精确字节键',
  t          BIGINT        NOT NULL COMMENT 'Date.now() 毫秒',
  lowest     DECIMAL(20,2) NULL COMMENT 'JSON null → NULL → 重建 null(注意:不是空串语义)',
  avg        DECIMAL(20,2) NULL,
  count      INT           NOT NULL DEFAULT 0,
  total_page INT           NOT NULL DEFAULT 0,
  PRIMARY KEY (keyword)
) COMMENT='询价缓存持久层:启动加载 TTL 内行';

-- 站点统计(stats.json 迁移;原子计数免整文件写)
CREATE TABLE site_stats (
  id             TINYINT NOT NULL DEFAULT 1,
  total_requests BIGINT  NOT NULL DEFAULT 0 COMMENT '累计识别请求次数',
  PRIMARY KEY (id),
  CONSTRAINT chk_single CHECK (id = 1)
) COMMENT='站点统计:单行表';

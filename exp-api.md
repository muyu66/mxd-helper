# 挂机收益上报接口文档（PC 端对接）

PC 端挂机程序每结束一段采集周期，向服务端 POST 一次收益快照。服务端校验通过后存入 `exp-reports.json`，网站页面 `exp.html` 每 15 秒轮询展示（等级 / 职业 / 地图 / 组队 / 经验/h / 金币收益/h / 血瓶钱/h / 蓝瓶钱/h）。

---

## 1. 接口地址

| 项目 | 值 |
|---|---|
| 方法 | `POST` |
| 地址 | `https://你的域名/api/exp/report`（本地开发：`http://127.0.0.1:3001/api/exp/report`） |
| `Content-Type` | `application/json` |
| 请求体上限 | 64 KB（正常一帧约 1.5 KB，无需担心） |

**无鉴权**：不需要任何密钥或签名头，直接 POST 即可（防刷由服务端的限频与数据校验兜底）。

---

## 2. 上报时机与频率

- **每段采集周期结束上报一次**（开始采集记一次快照，结束采集记一次快照，求差值得 delta）。
- **同一设备 / 同一公网 IP 两次成功上报的最短间隔为 5 秒**，更快会收到 `429`。
  如果采集周期可能短于 5 秒，客户端应自行聚合：攒够 5 秒或等下一段结束后合并上报，而不是每段都发。
- 失败重试建议：间隔 ≥5 秒，指数退避（5s → 10s → 20s），连续失败可丢弃本段（下段照常上报）。
- 本机时钟要求：`endTime` 最多允许比服务器当前时间快 5 分钟，超出会被拒。
  客户端时钟落后无影响，**时钟快于服务器 5 分钟以上会导致上报被拒**，建议系统开启时间同步。

---

## 3. 请求体结构

### 3.1 完整示例

```json
{
  "deviceId": "004abf2e-bbaa-429f-ab0b-14575f9118c1",
  "level": 55,
  "job": "枪骑士",
  "mapId": 105080000,
  "mapName": "龙族打猎场",
  "partyMode": "solo",
  "startTime": "2026-08-25T05:50:39.269Z",
  "endTime": "2026-08-25T05:50:47.269Z",
  "durationSeconds": 8,
  "delta": {
    "gold": 4000,
    "hpPotionUsed": 30,
    "mpPotionUsed": 200,
    "expGained": 3000,
    "levelsGained": 0
  },
  "profit": {
    "potionValue": 41500,
    "potionHpValue": 1500,
    "potionMpValue": 40000
  }
}
```

### 3.2 字段表（★ = 必填，服务端校验后入库；✎ = 可选）

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `deviceId` ★ | string | 1~64 字符，只允许字母/数字/`_`/`-` | 设备唯一标识（UUID 即可），兼作限频依据 |
| `level` ★ | integer | 1 ~ 300 | 本段结束时的角色等级 |
| `job` ★ | string | 1~32 字符 | 职业名，如 `枪骑士` |
| `mapId` ★ | integer | 0 ~ 1000000000 | 地图 ID |
| `mapName` ★ | string | 1~64 字符 | 地图名 |
| `partyMode` ★ | string | 1~16 个**英文字母**（建议 `solo` / `party`） | 是否组队。服务端只存值不解释，但中文会被拒 |
| `startTime` ★ | string | ISO 8601 时间（`new Date().toISOString()` 格式） | 本段采集开始时间 |
| `endTime` ★ | string | ISO 8601；必须晚于 `startTime`；不得超前服务器时间 5 分钟 | 本段采集结束时间 |
| `durationSeconds` ★ | number | 1 ~ 21600（6 小时） | 本段**实际刷怪时长**（秒，暂停时间不计入）。入库与每小时换算都用它；服务端不再与时间戳比对（有暂停功能时二者不一致是正常的），仅要求时间戳差值本身 ≥ 1 秒 |
| `delta.gold` ★ | number | ≥ 0 | 本段获得金币（end 金币 - start 金币） |
| `delta.hpPotionUsed` ★ | integer | 0 ~ 1000000 | 本段消耗血瓶数量 |
| `delta.mpPotionUsed` ★ | integer | 0 ~ 1000000 | 本段消耗蓝瓶数量 |
| `delta.expGained` ★ | number | ≥ 0 | 本段获得经验 |
| `delta.levelsGained` ★ | integer | 0 ~ 100 | 本段升级数 |
| `profit.potionValue` ✎ | number | ≥ 0 | 本段药水总花费（金币）。不传时按 `potionHpValue + potionMpValue` 计算 |
| `profit.potionHpValue` ✎ | number | ≥ 0 | 本段血瓶总花费（金币）。不传按 0 |
| `profit.potionMpValue` ✎ | number | ≥ 0 | 本段蓝瓶总花费（金币）。不传按 0 |
| `start` / `end` 快照 ✎ | object | 不校验 | 原始完整快照可以照发，服务端直接丢弃，不影响入库 |
| `profit.expPerHour` / `profit.goldPerHour` 等 ✎ | — | 不校验、不信任 | **服务端会按 `delta` 原始差值自己重算每小时收益**，客户端算不算、传不传都无所谓 |

> 注意：`hpPotionUsed`/`mpPotionUsed`/`levelsGained` 要求整数；`gold`/`expGained`/药水金额允许小数；`durationSeconds` 允许小数但建议取整或保留与时间戳一致的真实值。

---

## 4. 服务端校验规则（哪些数据会被拒绝，返回 400）

按校验顺序，命中即拒绝：

1. 请求体不是合法 JSON → `请求体不是合法 JSON`
2. 字段类型/范围不符 → 对应字段报错，如 `level 非法`、`deviceId 非法`
3. 时间：格式非法 / `endTime` 不晚于 `startTime` / 超前服务器 5 分钟以上
4. 时间戳间隔 < 1 秒（`endTime-startTime` 本身要 ≥ 1 秒）；`durationSeconds` 与时间戳不一致**不会**被拒（暂停功能会导致不一致，属正常）
5. 差值字段为负数（说明快照方向反了或数值异常）
6. **每小时收益超上限**（防伪造兜底，按本段时长换算，正常挂机远达不到）：
   - 经验/h ≤ 1,000,000,000
   - 金币/h ≤ 10,000,000,000
   - 血瓶钱/h、蓝瓶钱/h ≤ 1,000,000,000

服务端重算公式（客户端无需实现，仅供参考对齐口径）：

```
每小时值 = round(本段差值 / durationSeconds × 3600)   ← 实际刷怪时长（暂停不计入），由客户端上报
```

---

## 5. 响应

### 5.1 成功 `200`

```json
{
  "ok": true,
  "id": "mj8v3x2a1b9c",
  "report": {
    "id": "mj8v3x2a1b9c",
    "deviceId": "004abf2e-bbaa-429f-ab0b-14575f9118c1",
    "level": 55,
    "job": "枪骑士",
    "mapId": 105080000,
    "mapName": "龙族打猎场",
    "partyMode": "solo",
    "startTime": "2026-08-25T05:50:39.269Z",
    "endTime": "2026-08-25T05:50:47.269Z",
    "durationSeconds": 8,
    "delta": {
      "gold": 4000,
      "hpPotionUsed": 30,
      "mpPotionUsed": 200,
      "expGained": 3000,
      "levelsGained": 0
    },
    "profit": {
      "expPerHour": 1350000,
      "goldPerHour": 1800000,
      "potionValue": 41500,
      "potionHpValue": 1500,
      "potionMpValue": 40000,
      "potionHpPerHour": 675000,
      "potionMpPerHour": 18000000
    },
    "serverTime": "2026-08-25T05:50:48.123Z"
  }
}
```

`report` 即服务端最终入库的记录（`profit` 内的每小时值为服务端重算结果）。

**分享链接**：返回的 `id` 是**本条记录**的唯一 id（由服务端生成，与 `deviceId` 无关），客户端可展示分享链接 `https://你的域名/exp.html?id=<id>`——打开后页面只显示这一条上报记录；不带 id 打开则看全站最新数据。

### 5.2 失败

统一格式 `{"ok": false, "error": "<原因>"}`，按状态码处理：

| 状态码 | error | 客户端处理 |
|---|---|---|
| 400 | `请求体不是合法 JSON` / 各字段校验文案（见第 4 节） | 检查本段数据，修正后重试（或丢弃本段，下段照常） |
| 413 | `请求体过大或连接中断` | 请求体超 64KB 或连接中途断开，缩小报文重试 |
| 429 | `上报过于频繁` | 距上次成功上报不足 5 秒，等待后重试 |

---

## 6. Node.js 示例代码（fetch，Node 18+ 自带）

```js
const API = "https://你的域名/api/exp/report";

async function report(session) {
  // session = { deviceId, level, job, mapId, mapName, partyMode,
  //             startTime, endTime, durationSeconds, delta, profit }
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(session),
    });
    const j = await res.json().catch(() => null);
    if (res.ok) {
      console.log("上报成功:", j.report.profit);
      console.log("分享链接（只显示这一条记录）:", "https://你的域名/exp.html?id=" + j.id);
      return true;
    }
    if (res.status === 429) {
      console.log("限频，稍后重试");
      return false; // 按 ≥5 秒节拍重试
    }
    console.error(`上报失败 [${res.status}]:`, j && j.error);
    return false;
  } catch (err) {
    console.error("网络错误:", err.message);
    return false;
  }
}

// 构造一次上报（推荐用 new Date().toISOString() 记录时间戳）
const start = new Date();            // 采集开始时刻
const end = new Date();              // 采集结束时刻
await report({
  deviceId: "004abf2e-bbaa-429f-ab0b-14575f9118c1",
  level: 55,
  job: "枪骑士",
  mapId: 105080000,
  mapName: "龙族打猎场",
  partyMode: "solo",
  startTime: start.toISOString(),
  endTime: end.toISOString(),
  durationSeconds: Math.round((end - start) / 1000),
  delta: { gold: 4000, hpPotionUsed: 30, mpPotionUsed: 200, expGained: 3000, levelsGained: 0 },
  profit: { potionValue: 41500, potionHpValue: 1500, potionMpValue: 40000 },
});
```

---

## 7. 联调自测

**查看已入库记录**（返回最新在前，`limit` 最大 500）：

```bash
curl "https://你的域名/api/exp/reports?limit=50"
```

**按记录 id 查看单条**（分享链接 `exp.html?id=xxx` 的底层接口，id 取上报响应里的 `id` 字段）：

```bash
curl "https://你的域名/api/exp/reports?limit=50&id=mj8v3x2a1b9c"
```

**提交失败排查**：失败时响应是 `{"ok":false,"error":"<原因>"}`，服务端日志同时会打印 `[exp] 拒绝：<原因> | 请求体=…`（含截断的原始请求体）。客户端调试时务必把完整响应原样打印（状态码 + 响应体），常见失败原因：`429 上报过于频繁`（两次成功上报间隔 <5 秒）、`结束时间在未来`（本机时钟超前服务器 5 分钟以上）、`时间戳间隔过短`（`endTime-startTime` < 1 秒）、`partyMode 非法`（只能英文字母 `solo`/`party`，不能是中文「组队」）、连接被拒（服务端没启动或地址/端口不对）。

**地图/职业均值**：`GET /api/exp/reports` 响应自带 `mapStats` 与 `jobStats` 字段——全量数据分别按地图、职业聚合的算术平均值（`group` / `count` / `avgExpPerHour` / `avgGoldPerHour` / `avgPotionHpPerHour` / `avgPotionMpPerHour`），按平均经验/h 降序；值为 0 的记录视为「未记录」，不计入该指标的平均，某指标全部缺失时该字段为 `null`（页面显示 -）；jobStats 按归一化后的职业名分组（枪骑士统一为枪战士）；exp.html 顶部的两个均值面板直接使用，客户端无需关心。

**curl 模拟一次上报**：

```bash
curl -X POST "https://你的域名/api/exp/report" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "004abf2e-bbaa-429f-ab0b-14575f9118c1",
    "level": 55,
    "job": "枪骑士",
    "mapId": 105080000,
    "mapName": "龙族打猎场",
    "partyMode": "solo",
    "startTime": "2026-08-25T05:50:39.269Z",
    "endTime": "2026-08-25T05:50:47.269Z",
    "durationSeconds": 8,
    "delta": { "gold": 4000, "hpPotionUsed": 30, "mpPotionUsed": 200, "expGained": 3000, "levelsGained": 0 },
    "profit": { "potionValue": 41500, "potionHpValue": 1500, "potionMpValue": 40000 }
  }'
```

---

## 8. 常见坑速查

1. **429 上报过于频繁**：两段采集间隔 <5 秒时不要逐段发，聚合后再发。
2. **`结束时间在未来`**：客户端时钟快于服务器 5 分钟以上，做系统时间同步。
3. **暂停功能**：`durationSeconds` 填实际刷怪时长（暂停不计入），与时间戳墙钟不一致是正常的，服务端不校验二者一致性；每小时收益按 `durationSeconds` 换算。
4. **`partyMode 非法`**：只能英文字母（`solo` / `party`），不要填中文「组队」。
5. **`金币/h 超出上限`** 等：先核对 delta 差值方向（end - start），负值必拒；差值本身异常大时检查取数逻辑。
6. **每小时值被服务端改写**：正常现象——服务端不信任客户端算的 `expPerHour`/`goldPerHour`，一律按 `delta` 与 `durationSeconds` 重算。

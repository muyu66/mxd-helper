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

---

# v2 协议（新版 PC 工具 / exp.html 编辑授权）

v1（上文 §1~§8）服务端全权重算、上报即快照、只增不改。v2 面向**新版精简协议**与**页面编辑**：

- 上报体是 snake_case 的**每小时值直接上报**（`exp_per_hour` 等），不再发金币/药水（入库对应列留 NULL，页面显示 `-`），新增 **备注** 与 **攻击力/魔法力** 两个可选字段。
- 鉴权用 **JWT**：客户端先拿设备密钥换 2h token，之后所有请求带 `Authorization: Bearer <token>`；JWT 的 `sub` 即**设备ID**，服务端以它为 device_id 落库（不信 body 里的设备字段）。
- **编辑能力**：`exp.html` 通过带 `?token=` 的链接打开后，前端调 session 接口确认授权设备，该设备上报的行出现可点的「编辑」按钮，走 PATCH 就地修改。token 只授权修改**本设备**的记录。

四种接口：`POST /api/v2/exp/token`、`GET /api/v2/exp/session`、`POST /api/v2/exp/report`、`PATCH /api/v2/exp/report`。均不经过 shenmi 暗号，自带密钥/JWT 校验。

---

## 9. 换 token（PC 工具内置设备密钥，启动/到期时调一次）

| 项 | 值 |
|---|---|
| 方法 / 地址 | `POST /api/v2/exp/token` |
| 请求头 | `X-Exp-Device-Secret: <设备密钥>`（新 PC 工具内置的共享密钥；服务端环境变量 `EXP_DEVICE_SECRET`） |
| 请求体 | `{"deviceId": "my-device-uuid"}`（1~64 位，只允许字母/数字/`_`/`-`） |

响应 `200`：

```json
{ "ok": true, "token": "eyJhbGciOiJIUzI1NiIs...", "sub": "my-device-uuid", "expiresIn": 7200 }
```

- token 为 HS256 JWT，**2 小时**有效（服务端环境变量 `EXP_JWT_SECRET` 验签，客户端不关心算法实现）。
- 密钥错误 → `403 {"ok":false,"error":"设备密钥错误"}`；`deviceId` 非法 → `400`。
- 临近过期（剩 <10 分钟）建议客户端提前换新；接口幂等，随时可重调。

---

## 10. 校验会话（exp.html 打开授权链接时用；客户端一般不需要）

`GET /api/v2/exp/session`，请求头 `Authorization: Bearer <token>`。

```json
{ "ok": true, "sub": "my-device-uuid", "exp": 1788481788, "ttl": 7200 }
```

`sub` = 可编辑的设备ID；`exp` = 过期 Unix 秒；`ttl` = 剩余秒。token 无效/过期 → `401`。

---

## 11. v2 上报（新 PC 工具每段结束上报）

| 项 | 值 |
|---|---|
| 方法 / 地址 | `POST /api/v2/exp/report` |
| 请求头 | `Authorization: Bearer <token>`、`Content-Type: application/json` |

请求体示例：

```json
{
  "exp_per_hour": 123456,
  "job": "剑客",
  "level": 22,
  "map": "巫婆森林Ⅰ",
  "mode": "solo",
  "note": "免费测试期",
  "power": 122,
  "test_seconds": 1800
}
```

字段表：

| 字段 | 类型 | 约束 | 入库列 | 说明 |
|---|---|---|---|---|
| `exp_per_hour` ★ | number | 0 ~ 1e9（**0 合法**，样例即 0） | `profit_exp_per_hour` | 每小时经验（客户端算好直接给，服务端不再换算） |
| `job` ★ | string | 1~32 字符 | `job` | 职业名 |
| `level` ★ | integer | 1 ~ 300 | `level` | 角色等级 |
| `map` ★ | string | 1~64 字符 | `map_name` | 地图名（**只存名字**，v2 无 map_id） |
| `mode` ★ | string | 英文字母 `solo`/`party` | `party_mode` | 组队与否（中文会被拒） |
| `note` ✎ | string | ≤500 字符，空串按无 | `note`（新列） | 备注 |
| `power` ✎ | integer | 0 ~ 1e9 | `power`（新列） | 攻击力/魔法力 |
| `test_seconds` ★ | number | 0 ~ 21600（**0 合法**） | `duration_seconds` | 本次测试/刷怪秒数 |

服务端校验通过后以 JWT `sub` 为 device_id 落库，delta/金币/药水相关列一律 NULL。成功 `200`：

```json
{ "ok": true, "id": "mtm3...", "report": { "id": "mtm3...", "deviceId": "my-device-uuid", "level": 22, "job": "剑客", "mapId": null, "mapName": "巫婆森林Ⅰ", "partyMode": "solo", "startTime": null, "endTime": null, "durationSeconds": 1800, "delta": { "gold": null, "hpPotionUsed": null, "mpPotionUsed": null, "expGained": null, "levelsGained": null }, "profit": { "expPerHour": 123456, "goldPerHour": null, "potionValue": null, "potionHpValue": null, "potionMpValue": null, "potionHpPerHour": null, "potionMpPerHour": null }, "note": "免费测试期", "power": 122, "serverTime": "2026-08-25T05:50:48.123Z" } }
```

无 token / token 失效 → `401`；限频同 v1（同设备或同 IP 5 秒内只收一条，`429`）。

---

## 12. 编辑一条「本设备」的上报记录（exp.html 授权后）

| 项 | 值 |
|---|---|
| 方法 / 地址 | `PATCH /api/v2/exp/report` |
| 请求头 | `Authorization: Bearer <token>`、`Content-Type: application/json` |

请求体（snake_case；`id` 为要改的记录，取自上报响应的 `id` 或 GET reports）：

```json
{
  "id": "mtm3ld6o1b5d9c",
  "exp_per_hour": 888888,
  "job": "剑客",
  "level": 23,
  "map": "巫婆森林Ⅱ",
  "mode": "party",
  "map_id": null,
  "note": "改过的备注",
  "power": 500
}
```

行为约定：

- **只能改 `deviceId === token.sub` 的记录**：无权 → `403 {"ok":false,"error":"无权修改该记录"}`；记录不存在 → `404`。
- `level/job/map/mode/exp_per_hour` 必填（前端每次带全量当前值）；`map_name` 以 `map` 文本为准。
- `map_id` 可选：传数字则更新；`null`/缺省 = **沿用原 map_id**（v2 行本就是 NULL，编辑 v1 行且地图名不在站点数据集时传 null 不会丢原 map_id）。
- `note`：空串 → 清空；`power`：`null` → 清空；键缺省 = 不动该项。
- 编辑**有金币/药水数据（v1 型）的行**时，可随传 `gold_per_hour` / `potion_hp_per_hour` / `potion_mp_per_hour`（number，≥0），服务端按该行时长反推 delta 差值并同步每小时值，保证库内自洽；不传 = 该项不改。
- `id / device_id / start_time / end_time / server_time / snapshot` 一律不可改。落库成功才更新内存（GET/轮询下次即见新值）。

成功 `200`：`{ "ok": true, "report": <更新后的完整记录> }`。

### 编辑授权链接（给页面用）

要让某设备的所有者能编辑 TA 上报的记录，服务端或管理员把 token 拼到页面 URL：

```
https://你的域名/exp.html?token=<上一步换到的 JWT>
```

前端行为：
- 打开后调 `GET /api/v2/exp/session` 校验，通过则顶部出现横幅「🔑 已获得 <设备ID> 的编辑/删除权限」，该设备行的「编辑」「删除」图标点亮；随后**自动从地址栏移除 token**（防误分享/进日志）。
- 无 token 或 token 失效：横幅提示，「编辑」「删除」图标全部置灰。
- 点「编辑」打开与「手动录入」同一弹窗（预填等级/职业/地图/经验/h/备注/攻击力；v2 行没有金币/药水，那三项禁用）。保存走上方 PATCH；401/403 会撤销权限并把按钮置灰。
- 「手动录入」同样能填备注/攻击力（走 v1，可选），新加的两列在表格展示，v2 行金币/净收入等显示 `-`。

---

## 13. 删除一条「本设备」的上报记录（exp.html 授权后）

| 项 | 值 |
|---|---|
| 方法 / 地址 | `DELETE /api/v2/exp/report` |
| 请求头 | `Authorization: Bearer <token>`、`Content-Type: application/json` |

请求体只需记录 id（取自上报响应的 `id` 或 GET reports）：

```json
{ "id": "mtm3ld6o1b5d9c" }
```

行为约定：

- **只能删 `deviceId === token.sub` 的记录**：无权 → `403 {"ok":false,"error":"无权删除该记录"}`；记录不存在 → `404`（库内无该行也按 404 处理，页面刷新列表）。
- token 失效/非法 → `401`；`id` 缺失或非字符串 → `400`。
- **硬删除、不可恢复**：先从 `exp_reports` 表 DELETE（`WHERE id=? AND device_id=?`），成功才移出服务端内存权威数组；GET 报表与地图/职业平均值随之同步更新。
- 成功 `200`：`{ "ok": true, "id": "mtm3ld6o1b5d9c" }`。

前端：授权后每行操作栏为「编辑 / 分享 / 删除」三个图标按钮；删除需二次确认，删除失败时 401/403 撤销权限，404 自动刷新列表。

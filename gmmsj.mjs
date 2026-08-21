// gmmsj.mjs — gmmsj.com（冒险岛怀旧服交易平台）接口客户端
//
// 从 account-info.js 抽出的公共部分（签名器 + 会话 + 搜索接口），供 server.js
// 的 /api/price 使用。account-info.js 目前未切换到此模块，两处逻辑保持一致；
// 若接口报 -403，优先对照 account-info.js 检查签名/会话是否有变化。
//
// 接口校验（实测）:
//   接口要求「新鲜的 app_tst + 与之匹配的 X-Nonce 签名头 + 有效会话 cookie」，
//   三者缺一返回 -403。X-Nonce 由站点前端同款 WASM 模块按 app_tst 实时计算，
//   cookie 通过先访问列表页、再探测两个站点接口的方式在本地构建，全程无需浏览器。
//
// 用法：
//   import { searchGoodsAll } from "./gmmsj.mjs";
//   const { goodsList, totalPage } = await searchGoodsAll("小天使翅膀");

const BASE_URL = "https://www.gmmsj.com/api/consigntradeapi/goods/searchgoodslistV2";
const SITE_VERSION = "1.0.0.269439"; // 站点前端版本（签名模块与其配套）
const GAME_ID = "791001093";
const DEVICE_ID = "v2_2XzggnwIp0GU1j1MZtwjVGjhnPJjB8hY"; // 与接口 device_id 参数一致
// 装备搜索的 goods_types（浏览器抓包值；账号搜索为 "10" + item_type=10）
const EQUIP_GOODS_TYPES = "1,2,5,9,10,12,19,31,35";

const PAGE_LIMIT = 15; // 与接口 limit 一致
const MAX_PAGES = 300; // 安全上限，防止异常时无限翻页
const MAX_RETRIES = 3;
const REQUEST_DELAY_MS = 250; // 翻页间隔，对服务器保持克制
const TIMEOUT_MS = 30_000;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0";

// 浏览器抓包常见的固定 header（x-nonce 每次请求现算，不在此列）
const COMMON_HEADERS = {
  accept: "application/json, text/javascript, */*; q=0.01",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
  "cache-control": "no-cache",
  pragma: "no-cache",
  "sec-ch-ua": '"Not=A?Brand";v="99", "Microsoft Edge";v="151", "Chromium";v="151"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "x-requested-with": "XMLHttpRequest",
  referer: "https://www.gmmsj.com/",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// 签名器：加载站点前端同款 WASM 模块，按 app_tst 计算 X-Nonce
// ============================================================

let signTs = null; // initSigner() 后可用：signTs(ts) → { 签名头名: 签名值 }
let docCookie = ""; // WASM 内部 _js_get_cookies 返回的 document.cookie

async function initSigner() {
  // 1. 取站点前端签名模块，提取内嵌 base64 wasm
  const src = await (
    await fetch(`https://profile.gmmsj.com/pc/all/libs/gmmbiz.js?version=${SITE_VERSION}`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  ).text();
  const m = src.match(/wasmBinaryFile="data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)"/);
  if (!m) throw new Error("gmmbiz.js 中未找到内嵌 wasm");
  const wasmBytes = Buffer.from(m[1], "base64");

  // 2. 实现 wasm 导入（模块名 "a"，映射自站点胶水代码的 wasmImports）
  let memory = null;
  let s_f = null, s_t = null;
  const td = new TextDecoder();
  const te = new TextEncoder();
  let mallocFn = null, freeFn = null, gmbiztFn = null;

  const readStr = (ptr) => {
    const u8 = new Uint8Array(memory.buffer);
    let end = ptr;
    while (u8[end] !== 0) end++;
    return td.decode(u8.subarray(ptr, end));
  };
  const writeStr = (s) => {
    const bytes = te.encode(s + "\0");
    const ptr = mallocFn(bytes.length);
    new Uint8Array(memory.buffer).set(bytes, ptr);
    return ptr;
  };

  // asm-const 回调表（与站点胶水代码一致）：5347 输出签名头名与值
  const ASM_CONSTS = {
    5319: () => {},
    5347: ($0, $1) => { s_t = readStr($0); s_f = readStr($1); },
    5399: ($0, $1) => { s_f = readStr($1); },
    5451: () => {},
  };

  const importObj = {
    a: {
      // _emscripten_asm_const_int(code, sigPtr, argbuf)：按签名串解析参数后分派
      a: (code, sigPtr, argbuf) => {
        const u8 = new Uint8Array(memory.buffer);
        const u32 = new Uint32Array(memory.buffer);
        const f64 = new Float64Array(memory.buffer);
        const args = [];
        let p = sigPtr, buf = argbuf;
        while (u8[p] !== 0) {
          const ch = u8[p++];
          const wide = ch !== 105 && ch !== 112; // 'i'/'p' 4 字节槽，其余 8 字节对齐
          if (wide && buf % 8) buf += 4;
          args.push(ch === 112 ? u32[buf >> 2] : ch === 105 ? (u32[buf >> 2] | 0) : f64[buf >> 3]);
          buf += wide ? 8 : 4;
        }
        return ASM_CONSTS[code](...args);
      },
      b: () => {},
      c: () => { throw new Error("wasm __cxa_throw"); },
      d: () => writeStr(docCookie), // _js_get_cookies → document.cookie
      e: () => 0, f: () => 0, g: () => 0, h: () => 0, i: () => 0, j: () => 0,
      k: (_clockId, ptr) => {
        new DataView(memory.buffer).setBigUint64(ptr, BigInt(Date.now()) * 1000000n, true);
        return 0;
      },
      l: () => { throw new Error("wasm __abort_js"); },
      m: () => 0,
    },
  };

  // 3. 实例化（bytes 版本返回 {module, instance}）
  const { instance } = await WebAssembly.instantiate(wasmBytes, importObj);
  memory = instance.exports.n;
  mallocFn = instance.exports.w;
  freeFn = instance.exports.u;
  gmbiztFn = instance.exports.q;
  try { instance.exports.o?.(); } catch { /* 构造函数无副作用则忽略 */ }

  // 4. 对外：给定 app_tst，返回 { X-Nonce: 签名值 }
  signTs = (ts) => {
    s_f = s_t = null;
    const ptr = writeStr(ts);
    gmbiztFn(ptr);
    freeFn(ptr);
    if (!s_f || !s_t) throw new Error("WASM 签名计算失败");
    return { [s_f]: s_t };
  };
}

// ============================================================
// 会话：在本地构建一组接口可接受的 cookie（无需浏览器）
// ============================================================

const jar = new Map([
  ["deviceId", DEVICE_ID], // 与接口 device_id 参数一致（浏览器端生成的固定值）
  ["device_id", DEVICE_ID],
]);

function absorb(res) {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1);
    if (!v) jar.delete(k);
    else jar.set(k, v);
  }
}
const cookieStr = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

async function get(url, headers = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Cookie: cookieStr(), ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  absorb(res);
  return res;
}

// 构建会话：列表页下发 WAF/JSESSIONID，两个站点接口补 GMMSESSID/PHPSESSID
async function buildSession() {
  await get(`https://www.gmmsj.com/dy/${GAME_ID}_zh.shtml`, {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  });
  await get("https://www.gmmsj.com/gmmts.ms");
  await get(`https://www.gmmsj.com/gatew/CfgGW/getGameAreaGroupList?game_id=${GAME_ID}&type=1&count=1000`);
  await get("https://www.gmmsj.com/gate/frontconfigapi/GetVersion");
  if (!jar.has("GMMSESSID") || !jar.has("PHPSESSID")) {
    throw new Error(`会话构建不完整（当前 cookie: ${[...jar.keys()].join(", ")}）`);
  }
}

// ============================================================
// 就绪管理：懒初始化，-403 时可强制重建会话
// ============================================================

let ready = null;
function ensureReady() {
  if (!ready) {
    ready = (async () => {
      await initSigner();
      await buildSession();
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}
function invalidate() {
  ready = null; // 会话疑似过期：下次调用重新走 initSigner + buildSession
}

// ============================================================
// 搜索接口
// ============================================================

function pageUrl(keyword, page, appTst) {
  const params = new URLSearchParams({
    app_version: SITE_VERSION,
    device_id: DEVICE_ID,
    system_deviceId: DEVICE_ID,
    app_channel: "chrome",
    src_code: "7",
    keyword,
    goods_types: EQUIP_GOODS_TYPES,
    game_id: GAME_ID,
    page: String(page),
    limit: String(PAGE_LIMIT),
    safe_type: "",
    app_tst: appTst,
  });
  return `${BASE_URL}?${params}`;
}

/** 抓单页：每次请求现算 app_tst + 签名；遇 -403 重建会话后重试 */
async function fetchPage(keyword, page, retries = MAX_RETRIES) {
  for (let attempt = 1; ; attempt++) {
    try {
      await ensureReady();
      const ts = String(Date.now());
      docCookie = cookieStr(); // 签名与请求使用同一份 cookie
      const res = await fetch(pageUrl(keyword, page, ts), {
        headers: {
          "User-Agent": UA,
          Cookie: cookieStr(),
          ...COMMON_HEADERS,
          ...signTs(ts),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      absorb(res); // 服务器若轮换 cookie，及时更新 jar
      const json = await res.json();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (json.return_code !== 0) {
        if (json.return_code === -403) invalidate(); // 会话过期标记，下一轮重建
        throw new Error(`接口返回 ${json.return_code}: ${json.return_message}`);
      }
      return json;
    } catch (err) {
      if (attempt >= retries) throw new Error(`第 ${page} 页抓取失败: ${err.message}`);
      await sleep(500 * attempt); // 退避重试
    }
  }
}

/**
 * 按 keyword 搜索全部在售商品（翻页到底，book_id 去重）。
 * @returns {{ goodsList: object[], totalPage: number }}
 */
export async function searchGoodsAll(keyword) {
  const first = await fetchPage(keyword, 1);
  const totalPage = Number(first?.data?.totalPage);
  // 无结果时接口不返回 totalPage（或为 0）：按 0 件在售处理
  if (totalPage === 0) return { goodsList: [], totalPage: 0 };
  if (!Number.isInteger(totalPage) || totalPage < 1) {
    throw new Error("无法从第 1 页解析总页数 totalPage：" + JSON.stringify(first?.data).slice(0, 300));
  }
  if (totalPage > MAX_PAGES) throw new Error(`总页数 ${totalPage} 超过安全上限 ${MAX_PAGES}`);

  const byId = new Map();
  for (const r of first?.data?.goodsList ?? []) {
    if (r?.book_id !== undefined && r.book_id !== null) byId.set(String(r.book_id), r);
  }
  for (let page = 2; page <= totalPage; page++) {
    const json = await fetchPage(keyword, page);
    for (const r of json?.data?.goodsList ?? []) {
      if (r?.book_id !== undefined && r.book_id !== null) byId.set(String(r.book_id), r);
    }
    await sleep(REQUEST_DELAY_MS);
  }
  return { goodsList: [...byId.values()], totalPage };
}

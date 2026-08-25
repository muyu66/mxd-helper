// header.js — 各工具页共享的顶栏（冒险岛怀旧服工具箱）
//
// 以 <script src="header.js"> 方式注入：浏览器在 file:// 下禁用 fetch，
// 脚本引用则不受限，双击打开页面也能生效。改这一处，所有页面同步更新。
(function () {
  "use strict";
  // 根据当前文件名高亮对应工具按钮
  var page = (location.pathname.split("/").pop() || "").split("?")[0];
  var active = function (p) {
    return page === p ? " active" : "";
  };
  document.write(
    '<style>' +
    "/* 共享顶栏样式（自包含，不依赖各页面的 CSS 变量） */" +
    "/* position:relative + z-index 保证不被页面装饰层（如 rank 的渐变光斑）覆盖；字体显式声明不随页面 body 变化 */" +
    "/* 公告栏（置顶、不可关闭）：NEW 标签 + 公告文案 + 下载链接，随主题变色 */" +
    ".mh-banner{position:relative;z-index:2;background:#eaf2fd;border-bottom:1px solid rgba(42,120,214,.18);" +
    "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;}" +
    ".mh-banner-inner{max-width:720px;margin:0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;padding:7px 12px;}" +
    ".mh-new{display:inline-flex;align-items:center;height:18px;padding:0 6px;background:#e5484d;color:#fff;border-radius:4px;" +
    "font-size:11px;font-weight:700;letter-spacing:.5px;flex:none;}" +
    ".mh-banner-text{font-size:13px;color:#0b0b0b;}" +
    ".mh-banner-link{color:#2a78d6;font-weight:700;text-decoration:none;margin-left:4px;white-space:nowrap;}" +
    ".mh-banner-link:hover{text-decoration:underline;}" +
    ".mh-topbar{position:relative;z-index:2;background:#fcfcfb;border-bottom:1px solid rgba(11,11,11,.1);" +
    "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;}" +
    ".mh-inner{max-width:720px;margin:0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:9px 12px;}" +
    ".mh-brand{font-size:16px;font-weight:700;letter-spacing:.3px;color:#0b0b0b;margin-right:auto;}" +
    ".mh-nav{display:flex;gap:6px;}" +
    ".mh-btn{display:inline-flex;align-items:center;height:32px;padding:0 12px;border:1px solid rgba(11,11,11,.1);border-radius:16px;" +
    "background:#f9f9f7;color:#52514e;font-size:13px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;text-decoration:none;" +
    "cursor:pointer;user-select:none;touch-action:manipulation;transition:transform .08s ease,background-color .12s ease,color .12s ease;}" +
    ".mh-btn.active{border-color:#2a78d6;color:#0b0b0b;font-weight:600;}" +
    ".mh-btn:active{transform:scale(.92);background:#2a78d6;border-color:#2a78d6;color:#fff;}" +
    "@media (prefers-color-scheme:dark){:root:where(:not([data-theme=\"light\"])) .mh-banner{" +
    "background:#1a2130;border-bottom-color:rgba(57,135,229,.25);}" +
    ":root:where(:not([data-theme=\"light\"])) .mh-banner-text{color:#f5f4f0;}" +
    ":root:where(:not([data-theme=\"light\"])) .mh-banner-link{color:#3987e5;}" +
    ":root:where(:not([data-theme=\"light\"])) .mh-topbar{" +
    "background:#1a1a19;border-bottom-color:rgba(255,255,255,.1);}" +
    ":root:where(:not([data-theme=\"light\"])) .mh-brand{color:#fff;}" +
    ":root:where(:not([data-theme=\"light\"])) .mh-btn{background:#0d0d0d;border-color:rgba(255,255,255,.1);color:#c3c2b7;}" +
    ":root:where(:not([data-theme=\"light\"])) .mh-btn.active{border-color:#3987e5;color:#fff;}" +
    ":root:where(:not([data-theme=\"light\"])) .mh-btn:active{background:#3987e5;border-color:#3987e5;color:#fff;}}" +
    ":root[data-theme=\"dark\"] .mh-banner{background:#1a2130;border-bottom-color:rgba(57,135,229,.25);}" +
    ":root[data-theme=\"dark\"] .mh-banner-text{color:#f5f4f0;}" +
    ":root[data-theme=\"dark\"] .mh-banner-link{color:#3987e5;}" +
    ":root[data-theme=\"dark\"] .mh-topbar{background:#1a1a19;border-bottom-color:rgba(255,255,255,.1);}" +
    ":root[data-theme=\"dark\"] .mh-brand{color:#fff;}" +
    ":root[data-theme=\"dark\"] .mh-btn{background:#0d0d0d;border-color:rgba(255,255,255,.1);color:#c3c2b7;}" +
    ":root[data-theme=\"dark\"] .mh-btn.active{border-color:#3987e5;color:#fff;}" +
    ":root[data-theme=\"dark\"] .mh-btn:active{background:#3987e5;border-color:#3987e5;color:#fff;}" +
    "</style>" +
    '<div class="mh-banner">' +
    '<div class="mh-banner-inner">' +
    '<span class="mh-new">NEW</span>' +
    '<span class="mh-banner-text">猪猪冒险岛工具Bar v1.1 提供EXP效率计算、999打卡、商人刷新通知功能，体积更小只有3M。' +
    '<a class="mh-banner-link" href="mxd-bar.zip">立即下载</a></span>' +
    "</div>" +
    "</div>" +
    '<div class="mh-topbar">' +
    '<div class="mh-inner">' +
    '<div class="mh-brand">🗡️ Tools</div>' +
    '<nav class="mh-nav">' +
    '<a class="mh-btn' + active("rank.html") + '" href="rank.html">怪物排行</a>' +
    '<a class="mh-btn' + active("waigua.html") + '" href="waigua.html">举报分析</a>' +
    '<a class="mh-btn' + active("account.html") + '" href="account.html">卖号分析</a>' +
    '<a class="mh-btn' + active("shenmi.html") + '" href="shenmi.html">神秘商人</a>' +
    '<a class="mh-btn' + active("999.html") + '" href="999.html">计时提醒</a>' +
    '<a class="mh-btn' + active("exp.html") + '" href="exp.html">挂机收益</a>' +
    "</nav>" +
    "</div>" +
    "</div>",
  );
})();

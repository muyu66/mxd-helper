// footer.js — 三个工具页共享的底栏（参照 rank.html 原底栏）
//
// 以 <script src="footer.js"> 方式注入，file:// 双击打开同样生效。
// 改这一处，所有页面同步更新。
(function () {
  "use strict";
  document.write(
    '<style>' +
    "/* 共享底栏样式（自包含） */" +
    ".mh-footer{text-align:center;padding:26px 12px 44px;font-size:12.5px;line-height:1.8;color:#898781;" +
    "font-family:system-ui,-apple-system,'Segoe UI',sans-serif;}" +
    ".mh-footer a{color:inherit;text-decoration:underline;}" +
    "@media (prefers-color-scheme:dark){.mh-footer{color:#898781;}}" +
    "</style>" +
    '<div class="mh-footer">' +
    "Made by zhuzhu ❤️ 数据来源网络搜集<br />" +
    "皖ICP备2025106435号-1<br />" +
    '<a href="https://live.bilibili.com/1978986435" target="_blank" rel="noreferrer">B站直播间</a>' +
    "</div>",
  );
})();

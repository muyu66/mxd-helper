// 构建脚本：混淆 rank.js + 内联 CSS/tippy/JS → dist/index.html
// 用法: npm run build
import fs from "fs";
import path from "path";
import JavaScriptObfuscator from "javascript-obfuscator";

const DIST = "dist";

// ---- 1. 读取源文件 ----
const html = fs.readFileSync("rank.html", "utf8");
const css = fs.readFileSync("rank.css", "utf8");
const js = fs.readFileSync("rank.js", "utf8");
const tippyBundle = fs.readFileSync(
  "node_modules/tippy.js/dist/tippy-bundle.umd.min.js",
  "utf8",
);

// ---- 2. 混淆 rank.js ----
const obfuscated = JavaScriptObfuscator.obfuscate(js, {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: true,
  reservedNames: ["calc"], // HTML 里 onclick="calc()" 依赖这个名字
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.75,
  target: "browser",
}).getObfuscatedCode();

// 内联进 <script> 时防止 </script 提前闭合
function escapeScript(s) {
  return s.replace(/<\/script/gi, "<\\/script");
}

// 替换 <!-- build:xx --> ... <!-- /build:xx --> 标记区域
function replaceMarker(src, marker, replacement) {
  const re = new RegExp(
    `<!--\\s*build:${marker}\\s*-->[\\s\\S]*?<!--\\s*/build:${marker}\\s*-->`,
  );
  const out = src.replace(re, () => replacement);
  if (out === src) throw new Error(`rank.html 中找不到 build:${marker} 标记`);
  return out;
}

// ---- 3. 组装单页 HTML ----
let out = html;
out = replaceMarker(out, "css", `<style>\n${css}\n    </style>`);
out = replaceMarker(
  out,
  "libs",
  `<script>\n${escapeScript(tippyBundle)}\n    </script>`,
);
out = replaceMarker(out, "js", ""); // rank.js 移到 body 末尾执行
out = out.replace(
  "</body>",
  `    <script>\n${escapeScript(obfuscated)}\n    </script>\n  </body>`,
);

// ---- 4. 写入 dist/index.html（固定文件名，防缓存依赖页面内的 no-cache meta）----
fs.mkdirSync(DIST, { recursive: true });
// 清理旧的时间戳构建文件（迁移遗留）
for (const f of fs.readdirSync(DIST)) {
  if (/^index_\d+\.html$/.test(f)) fs.unlinkSync(path.join(DIST, f));
}
fs.writeFileSync(path.join(DIST, "index.html"), out);

// ---- 5. 复制运行时资源，dist/ 可整体部署 ----
fs.copyFileSync("data.json", path.join(DIST, "data.json"));
fs.copyFileSync("equipment.json", path.join(DIST, "equipment.json"));
fs.cpSync("dbsource", path.join(DIST, "dbsource"), { recursive: true });

console.log("✅ 构建完成:", path.join(DIST, "index.html"));

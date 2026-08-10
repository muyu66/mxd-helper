const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const BASE_URL = "https://mxdc.dvg.cn";
const DATA_FILE = path.join(__dirname, "data.json");
const OUTPUT_ROOT = __dirname; // 图片保存到当前目录，按 icon 的目录结构存放
const CONCURRENCY = 5; // 并发下载数

// 从 data.json 读取所有 icon 路径
function loadIconPaths() {
  const raw = fs.readFileSync(DATA_FILE, "utf-8");
  const data = JSON.parse(raw);
  const icons = new Set();
  for (const item of data.items) {
    if (item.icon) {
      icons.add(item.icon);
    }
  }
  return Array.from(icons);
}

// 确保目录存在
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// 下载单个文件
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;

    protocol
      .get(url, (res) => {
        // 处理重定向
        if (res.statusCode === 301 || res.statusCode === 302) {
          downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${url}`));
          return;
        }

        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
        file.on("error", (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
      })
      .on("error", reject);
  });
}

// 并发下载
async function downloadAll(iconPaths) {
  const total = iconPaths.length;
  let done = 0;
  let failed = [];

  const queue = [...iconPaths];

  async function worker() {
    while (queue.length > 0) {
      const iconPath = queue.shift();
      const url = BASE_URL + iconPath;
      const destPath = path.join(OUTPUT_ROOT, iconPath.replace(/\//g, path.sep));

      // 如果文件已存在则跳过
      if (fs.existsSync(destPath)) {
        done++;
        process.stdout.write(`\r[${done}/${total}] (跳过已存在) ${iconPath}`);
        continue;
      }

      ensureDir(path.dirname(destPath));

      try {
        await downloadFile(url, destPath);
        done++;
        process.stdout.write(`\r[${done}/${total}] 下载完成: ${iconPath}`);
      } catch (err) {
        done++;
        failed.push({ iconPath, error: err.message });
        process.stdout.write(`\r[${done}/${total}] 失败: ${iconPath} — ${err.message}`);
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  console.log("\n");

  if (failed.length > 0) {
    console.log(`\n失败 ${failed.length} 个:`);
    for (const f of failed) {
      console.log(`  - ${f.iconPath}: ${f.error}`);
    }
  } else {
    console.log(`全部 ${total} 个图标下载完成!`);
  }
}

// 主函数
async function main() {
  console.log("读取 data.json...");
  const iconPaths = loadIconPaths();
  console.log(`共找到 ${iconPaths.length} 个唯一图标\n`);

  await downloadAll(iconPaths);
}

main().catch((err) => {
  console.error("脚本出错:", err);
  process.exit(1);
});

// pm2 配置（.cjs 后缀：package.json 为 "type": "module"，CommonJS 配置需显式后缀）
// 用法:
//   pm2 start ecosystem.config.cjs       启动
//   pm2 save                             保存进程列表（配合 pm2-windows-startup 开机自启）
module.exports = {
  apps: [
    {
      name: "mxd-server",
      script: "server.js",
      cwd: __dirname,
      time: true, // 日志带时间戳
      env: {
        HOST: "127.0.0.1", // 只监听本机：公网流量统一走 nginx 反代，不暴露 3000 端口
        // OCR 已拆分到 mxd-ocr（ocr_worker.js）：本进程只转交任务，
        // server.js 的 OCR_PORT 与 mxd-ocr 的 PORT 默认一致（3002），不同时再单独配置
        SHENMI_CODE: "xiaozhu", // shenmi.html 暗号（页面解锁 + /api/ocr*、/api/price 校验），改这里后 pm2 restart mxd-server
        // MySQL 连接（部署时填真实口令；库结构见 schema.sql，上线前先跑迁移脚本）
        MYSQL_HOST: "127.0.0.1",
        MYSQL_USER: "mxd",
        MYSQL_PASSWORD: "CHANGE_ME",
        MYSQL_DATABASE: "mxd_helper",
      },
      max_memory_restart: "200M", // 注入数据缓存 + gzip 缓存，异常涨内存时兜底重启
      // 常驻 HTTP 服务，pm2 默认自动拉起；数据变化由 server.js 内部轮询 dataset_meta 重载
    },
    {
      name: "mxd-ocr",
      script: "ocr_worker.js",
      cwd: __dirname,
      time: true, // 日志带时间戳
      env: {
        HOST: "127.0.0.1", // 只服务同机 server.js，不对外；PORT 默认 3002（与 server.js 的 OCR_PORT 一致）
        // OCR 依赖 python3 + rapidocr_onnxruntime。Ubuntu 24.04 全局 pip 受限，推荐项目内虚拟环境：
        //   cd /var/www/mxd-helper && python3 -m venv .venv && .venv/bin/pip install rapidocr_onnxruntime
        // 会自动优先使用 .venv（无需配置这里）；特殊场景可手动指定，如 "PYTHON": "/usr/bin/python3"
        // PYTHON: "python3",
      },
      max_memory_restart: "200M", // 排队图片缓冲在 OCR 进程内（上限 20 张 ×10MB），异常涨内存时兜底重启
      // OCR 按队列串行识别（同一时间只处理一张图），页面后端不再被识别拖慢
    },
    {
      name: "waigua-info",
      script: "waigua-info.js",
      args: "--watch", // 传给脚本的参数：常驻模式，每 60 分钟抓取一次
      cwd: __dirname,
      max_memory_restart: "300M", // 异常涨内存时自动重启兜底
      time: true, // 日志带时间戳
      env: {
        MYSQL_HOST: "127.0.0.1",
        MYSQL_USER: "mxd",
        MYSQL_PASSWORD: "CHANGE_ME",
        MYSQL_DATABASE: "mxd_helper",
      },
      // 抓取循环在脚本内部实现，进程正常运行不会退出；
      // 若进程意外崩溃，pm2 默认自动拉起（autorestart 默认开启）
    },
    {
      name: "account-info",
      script: "account-info.js",
      cwd: __dirname,
      time: true, // 日志带时间戳
      env: {
        MYSQL_HOST: "127.0.0.1",
        MYSQL_USER: "mxd",
        MYSQL_PASSWORD: "CHANGE_ME",
        MYSQL_DATABASE: "mxd_helper",
      },
      // 单次执行脚本（抓完全部分页后正常退出），由 pm2 按 cron 每小时拉起一次：
      // 每小时第 7 分钟执行，避免与整点任务挤在同一时刻
      cron_restart: "7 * * * *",
      autorestart: false, // 执行完退出后不立即重启，等下一个 cron 时刻
      // 抓取失败（退出码 1）不写库，下一次 cron 自动重试
    },
  ],
};

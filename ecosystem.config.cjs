// pm2 配置（.cjs 后缀：package.json 为 "type": "module"，CommonJS 配置需显式后缀）
// 用法:
//   pm2 start ecosystem.config.cjs       启动
//   pm2 save                             保存进程列表（配合 pm2-windows-startup 开机自启）
module.exports = {
  apps: [
    {
      name: "waigua-info",
      script: "waigua-info.js",
      args: "--watch", // 传给脚本的参数：常驻模式，每 60 分钟抓取一次
      cwd: __dirname,
      max_memory_restart: "300M", // 异常涨内存时自动重启兜底
      time: true, // 日志带时间戳
      // 抓取循环在脚本内部实现，进程正常运行不会退出；
      // 若进程意外崩溃，pm2 默认自动拉起（autorestart 默认开启）
    },
  ],
};

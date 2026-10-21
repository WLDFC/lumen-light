// 发版面板独立服务：不依赖 LumenLight 主后端，双击「发版面板.bat」即用。
// 挂载 routes/releaseTools.js（打包/上传接口）+ 本目录 panel.html，
// 监听 127.0.0.1:8130（与主后端 8080 互不干扰），起服后自动开浏览器。
// 已有实例在跑时（端口占用）不开第二个服务，直接再开一次浏览器页面。

'use strict';

const express = require('express');
const path = require('path');
const { exec } = require('child_process');

const PORT = 8130;
const PANEL = path.join(__dirname, 'panel.html');
const URL = `http://localhost:${PORT}`;

const app = express();
app.use('/api/release-tools', require('../../routes/releaseTools')());
app.get('/', (req, res) => res.sendFile(PANEL));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`发版面板运行中: ${URL}（关闭本窗口即退出）`);
  exec(`start "" "${URL}"`);
}).on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('面板已在运行，直接打开页面…');
    exec(`start "" "${URL}"`);
  } else {
    console.error('启动失败:', e.message);
    process.exit(1);
  }
});

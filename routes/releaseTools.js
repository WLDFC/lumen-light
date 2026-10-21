// 发版工具后端（tools/release/panel.html 发版面板的数据端）。
// 复用 tools/release/ 下两个命令行工具（打包/上传），把它们的输出流式转发给
// 本地页面——本机开发者操作用，上传凭据取自 git 凭据管理器（工具内部处理）。
// 端点：
//   GET  /status          当前版本号 / 工作区脏文件清单 / dist 产物状态
//   POST /package         打更新包（跑 make-update-package.js，结束时返回全部输出）
//   GET  /upload?tag=vX   上传附件到 GitHub Release（SSE 流式转发工具输出，含上传进度）

'use strict';

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

module.exports = function createReleaseToolsRouter() {
  const router = express.Router();
  const ROOT = path.join(__dirname, '..');
  const TOOLS_DIR = path.join(ROOT, 'tools', 'release');

  // 打包/上传互斥（同一时刻只允许一个跑，避免 dist 读写打架）
  let busy = false;

  function readVersion() {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      return String(pkg.version || '');
    } catch {
      return '';
    }
  }

  function gitDirty() {
    try {
      const out = require('child_process').execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
      return out.trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  function distState() {
    const dir = path.join(ROOT, 'dist');
    const names = ['lumen-update.zip', 'version.json'];
    const files = [];
    for (const name of names) {
      const p = path.join(dir, name);
      files.push({
        name,
        exists: fs.existsSync(p),
        size: fs.existsSync(p) ? fs.statSync(p).size : 0,
      });
    }
    // 完整安装包（可能有历史版本号的多个，取文件名修改时间最新的一个）
    let fullZip = null;
    if (fs.existsSync(dir)) {
      const found = fs.readdirSync(dir)
        .filter((n) => /^lumen-light-full-.+\.zip$/.test(n))
        .map((n) => {
          const p = path.join(dir, n);
          return { name: n, exists: true, size: fs.statSync(p).size, mtime: fs.statSync(p).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      fullZip = found[0] || null;
    }
    // version.json 里的版本（存在时）
    let packagedVersion = '';
    const vj = path.join(dir, 'version.json');
    if (fs.existsSync(vj)) {
      try { packagedVersion = String(JSON.parse(fs.readFileSync(vj, 'utf8')).version || ''); } catch { }
    }
    return { files, fullZip, packagedVersion };
  }

  router.get('/status', (req, res) => {
    res.json({
      version: readVersion(),
      dirty: gitDirty(),
      busy,
      ...distState(),
    });
  });

  // 跑一个工具脚本，收集 stdout/stderr 行，结束时回调
  function runTool(script, args, onLine) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(TOOLS_DIR, script), ...args], { cwd: ROOT });
      let buffer = '';
      const feed = (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) if (line) onLine(line);
      };
      child.stdout.on('data', feed);
      child.stderr.on('data', feed);
      child.on('close', (code) => {
        if (buffer) onLine(buffer);
        resolve(code);
      });
      child.on('error', (e) => { onLine(`[异常] ${e.message}`); resolve(-1); });
    });
  }

  router.post('/package', async (req, res) => {
    if (busy) return res.status(409).json({ error: '已有打包/上传任务在运行' });
    busy = true;
    const full = req.query.full === '1';
    const lines = [];
    const code = await runTool('make-update-package.js', full ? ['--full'] : [], (line) => lines.push(line));
    busy = false;
    res.json({ ok: code === 0, code, output: lines });
  });

  // SSE：上传附件（tag 由前端按版本号拼好传入），行式转发工具输出
  router.get('/upload', async (req, res) => {
    const tag = String(req.query.tag || '').trim();
    if (!/^v?[0-9A-Za-z._-]+$/.test(tag)) return res.status(400).json({ error: 'tag 格式非法' });
    if (busy) return res.status(409).json({ error: '已有打包/上传任务在运行' });
    busy = true;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (type, text) => {
      res.write(`data: ${JSON.stringify({ type, text })}\n\n`);
    };

    const zipOk = fs.existsSync(path.join(ROOT, 'dist', 'lumen-update.zip'));
    if (!zipOk) {
      send('error', 'dist/lumen-update.zip 不存在，请先打包。');
      busy = false;
      return res.end();
    }

    let code = -1;
    try {
      // 附件清单：更新包 + 清单必传；full=1 时追加完整安装包（dist 里最新的那份）
      const files = ['dist/lumen-update.zip', 'dist/version.json'];
      if (req.query.full === '1') {
        const dir = path.join(ROOT, 'dist');
        const found = fs.readdirSync(dir)
          .filter((n) => /^lumen-light-full-.+\.zip$/.test(n))
          .map((n) => ({ n, m: fs.statSync(path.join(dir, n)).mtimeMs }))
          .sort((a, b) => b.m - a.m);
        if (!found.length) {
          send('error', 'dist 里没有完整安装包（lumen-light-full-*.zip），请先勾选「打包完整安装包」。');
          busy = false;
          return res.end();
        }
        files.push('dist/' + found[0].n);
      }
      code = await runTool('release-upload.js', [tag, ...files, '--replace'], (line) => {
        send('line', line);
      });
    } finally {
      busy = false;
    }
    send(code === 0 ? 'done' : 'error', code === 0 ? '上传完成，附件已核验。' : `上传失败（退出码 ${code}），可重试。`);
    res.end();
  });

  return router;
};

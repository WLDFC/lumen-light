// GitHub Release API 上传工具：创建/复用 release，并把本地附件传上去。
// 背景：浏览器端上传附件在本机网络下不稳定（附件大时反复报
// "Something went really wrong"），本工具走 API 上传——凭据复用
// git 凭据管理器里已存的 token（只在本机进程内使用，不回显不入日志）。
//
// 用法：node tools/release/release-upload.js <tag> <文件...> [--title x] [--notes x] [--draft] [--replace] [--repo x]
//   <tag>      目标 release 的 tag（如 v0.3.0.7）；不存在则创建（打在 main 最新提交）
//   <文件...>  要上传的附件，可多个，文件名即附件名（重名时按 --replace 处理）
//   --title    release 标题（仅创建时生效，缺省用 tag 名）
//   --notes    release 说明文字（仅创建时生效，中文安全——内部写 UTF-8 请求体）
//   --draft    创建为草稿（默认直接发布；草稿在网页 Releases 页可见可再编辑）
//   --replace  同名附件已存在时先删旧再传（默认跳过该文件并提示）
//   --repo     仓库覆盖（缺省 WLDFC/lumen-light）
//
// 示例（发版最后一步）：
//   node tools/release/make-update-package.js
//   node tools/release/release-upload.js v0.3.0.7 dist/lumen-update-0.3.0.7.zip dist/version.json --replace

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Transform } = require('stream');

const DEFAULT_REPO = 'WLDFC/lumen-light';
const API = 'https://api.github.com';

// ---- 参数解析 ----
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : null;
};
const repo = opt('--repo') || DEFAULT_REPO;
const draft = flag('--draft');
const replace = flag('--replace');
const title = opt('--title');
const notes = opt('--notes');
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (['--title', '--notes', '--repo'].includes(a)) { i++; continue; }
  if (['--draft', '--replace'].includes(a)) continue;
  positional.push(a);
}
if (positional.length < 1) fail('用法：node tools/release/release-upload.js <tag> <文件...> [--title x] [--notes x] [--draft] [--replace]');
const [tag, ...files] = positional;
for (const f of files) {
  if (!fs.existsSync(f)) fail(`文件不存在：${f}`);
}

// ---- 凭据：从 git 凭据管理器取已存 token（github.com）----
function getToken() {
  const r = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const m = (r.stdout || '').match(/^password=(.+)$/m);
  if (!m) fail('未取到 GitHub 凭据。请先成功执行过一次 git push（凭据管理器里存有 token），或手动配置 git 凭据。');
  return m[1].trim();
}

async function api(token, urlPath, options = {}) {
  const res = await fetch(API + urlPath, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'lumen-light-release-upload',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应原样带回去 */ }
  return { status: res.status, json, text };
}

// 上传附件：失败自动重试（每次重开文件流），全部失败才放弃。
// 进度：Transform 计数字节，同行刷新（\r）显示已传/总量/百分比/速度——
// 大文件（完整安装包数百 MB）不再像卡死一样干等。
async function uploadAsset(token, release, filePath) {
  const name = path.basename(filePath);
  const size = fs.statSync(filePath).size;
  const uploadUrl = release.upload_url.split('{')[0];
  const ctype = name.endsWith('.zip') ? 'application/zip'
    : name.endsWith('.json') ? 'application/json'
    : 'application/octet-stream';
  const totalMB = size / 1024 / 1024;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      let sent = 0;
      let lastLog = 0;
      const started = Date.now();
      const meter = new Transform({
        transform(chunk, enc, cb) {
          sent += chunk.length;
          const now = Date.now();
          if (now - lastLog > 700 || sent >= size) {
            lastLog = now;
            const mb = sent / 1048576;
            const sec = Math.max((now - started) / 1000, 0.1);
            process.stdout.write(`\r  已传 ${mb.toFixed(1)}/${totalMB.toFixed(1)} MB（${(sent / size * 100).toFixed(1)}%，${(mb / sec).toFixed(2)} MB/s）    `);
          }
          cb(null, chunk);
        },
      });
      const res = await fetch(`${uploadUrl}?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'lumen-light-release-upload',
          'Content-Type': ctype,
          'Content-Length': size,
        },
        body: fs.createReadStream(filePath).pipe(meter),
        duplex: 'half',
      });
      process.stdout.write('\n');
      const json = await res.json().catch(() => null);
      if (res.status === 201 && json && json.state === 'uploaded') {
        return json;
      }
      console.error(`  第 ${attempt} 次上传失败：HTTP ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
    } catch (e) {
      process.stdout.write('\n');
      console.error(`  第 ${attempt} 次上传异常：${e.message}`);
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 5000));
  }
  return null;
}

function fail(msg) {
  console.error(`[失败] ${msg}`);
  process.exit(1);
}

async function main() {
  const token = getToken();

  // 1. 找目标 release（含草稿；published 的走 /tags/ 精确查，草稿全列出来过滤）
  console.log(`查询仓库 ${repo} 的 release（tag=${tag}）…`);
  let release = null;
  const byTag = await api(token, `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  if (byTag.status === 200) release = byTag.json;
  if (!release) {
    const all = await api(token, `/repos/${repo}/releases?per_page=100`);
    if (all.status !== 200) fail(`查询 release 列表失败：HTTP ${all.status}（token 权限或网络问题）`);
    release = (all.json || []).find((r) => r.tag_name === tag) || null;
  }

  // 2. 不存在则创建
  if (!release) {
    console.log(`release 不存在，正在创建（${draft ? '草稿' : '直接发布'}，tag 打在 main 最新提交）…`);
    const created = await api(token, `/repos/${repo}/releases`, {
      method: 'POST',
      body: JSON.stringify({ tag_name: tag, target_commitish: 'main', name: title || tag, body: notes || '', draft }),
    });
    if (created.status !== 201) fail(`创建 release 失败：HTTP ${created.status} ${created.text.slice(0, 300)}`);
    release = created.json;
    console.log(`已创建 release id=${release.id}（${release.draft ? '草稿' : '已发布'}）`);
  } else {
    console.log(`复用已有 release id=${release.id}（${release.draft ? '草稿' : '已发布'}，附件 ${release.assets.length} 个）`);
  }

  // 3. 逐个上传附件（同名按 --replace 处理）
  for (const file of files) {
    const name = path.basename(file);
    const sizeMB = (fs.statSync(file).size / 1024 / 1024).toFixed(2);
    const existing = (release.assets || []).find((a) => a.name === name);
    if (existing) {
      if (!replace) {
        console.log(`跳过 ${name}：附件已存在（如需覆盖请加 --replace）`);
        continue;
      }
      const del = await api(token, `/repos/${repo}/releases/assets/${existing.id}`, { method: 'DELETE' });
      if (del.status !== 204) fail(`删除旧附件 ${name} 失败：HTTP ${del.status}`);
      console.log(`已删除旧附件 ${name}（${(existing.size / 1024 / 1024).toFixed(2)} MB），重新上传…`);
    }
    console.log(`上传 ${name}（${sizeMB} MB）…`);
    const asset = await uploadAsset(token, release, file);
    if (!asset) fail(`附件 ${name} 三次上传均失败，可重跑本命令续传其余文件。`);
    console.log(`  成功：${asset.name}（${(asset.size / 1024 / 1024).toFixed(2)} MB，state=${asset.state}）`);
  }

  // 4. 汇总核验：从服务器重新拉一遍附件清单，本地字节数逐一比对
  const check = await api(token, `/repos/${repo}/releases/${release.id}`);
  const assets = (check.json && check.json.assets) || [];
  console.log('');
  console.log(`核验（release ${tag}，${release.draft ? '草稿——记得去网页点 Publish' : '已发布'}）：`);
  let allOk = true;
  for (const f of files) {
    const name = path.basename(f);
    const remote = assets.find((a) => a.name === name);
    const local = fs.statSync(f).size;
    const ok = remote && remote.size === local && remote.state === 'uploaded';
    if (!ok) allOk = false;
    console.log(`  ${ok ? 'OK ' : '异常'} ${name} 本地 ${local} / 服务器 ${remote ? remote.size : '缺失'}`);
  }
  if (allOk) {
    console.log('');
    console.log(release.draft
      ? '全部附件就位。草稿发布后，latest/download 直链即生效。'
      : `全部附件就位。latest 直链：https://github.com/${repo}/releases/latest/download/<附件名>`);
  } else {
    process.exitCode = 1;
  }
}

main().catch((e) => fail(e.message));

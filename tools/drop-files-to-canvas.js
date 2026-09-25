/**
 * 进程内读取本地图片 → 经画布桥接 /api/canvas-bridge/command 下发 drop_image。
 * base64 只存在于进程内存与 HTTP 请求体，绝不打印到 stdout（遵守 AGENTS.md）。
 * 用法：node tools/drop-files-to-canvas.js <文件1> <文件2> ...
 */
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8080';
const MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp'
};

async function dropOne(file) {
    const ext = path.extname(file).toLowerCase();
    const mime = MIME[ext];
    if (!mime) return { file, ok: false, error: `不支持的格式 ${ext}` };
    const buf = fs.readFileSync(file);
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
    const name = path.basename(file);
    try {
        const resp = await fetch(`${BASE}/api/canvas-bridge/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: 'drop_image', params: { dataUrl, name } })
        });
        const json = await resp.json();
        return { file: name, ok: json.status === 'ok', error: json.message || null };
    } catch (e) {
        return { file: name, ok: false, error: e.message };
    }
}

(async () => {
    const files = process.argv.slice(2);
    if (!files.length) { console.error('未指定文件'); process.exit(1); }
    // 串行下发：避免同源连接池与画布执行顺序竞争
    const results = [];
    for (const f of files) results.push(await dropOne(f));
    // 只输出结论（文件名 + 成败），不输出任何 base64
    for (const r of results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.file}${r.error ? ' — ' + r.error : ''}`);
    process.exit(results.every(r => r.ok) ? 0 : 1);
})();

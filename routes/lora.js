/**
 * ==========================================================================
 * LoRA 管理接口（/api/lora）
 * 作用：为画布顶栏「LoRA 管理」窗口提供数据：
 *   - GET  /list     递归扫描 <comfy.root>/models/loras/，返回文件夹清单与
 *                    LoRA 文件清单（相对路径为唯一 id，与 Comfy 工作流里
 *                    写死的路径同源）
 *   - GET  /preview  按 sidecar 惯例取封面图（<同名>.preview.png/.jpg，
 *                    兜底 <同名>.png/.jpg），无图返回 404 由前端显示占位块
 *   - GET /POST /pins 置顶状态读写（data/lora-meta.json，文件相对路径做 key）
 *   - POST /delete  删除 lora（源文件 + sidecar 预览 + 置顶/触发词/备注记录）
 *   - POST /move    移动 lora 到另一文件夹（文件 + sidecar + meta 记录换 key）
 *   - POST /reveal  资源管理器打开所在文件夹并选中
 * 只读 Comfy 目录 + 写 data/ 元数据；删除/移动走显式确认（工作流 JSON 里
 * 路径写死，删/挪都会静默断链，风险由前端弹窗警示）。
 * ==========================================================================
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { execFile, exec } = require('child_process');
const civitai = require('../utils/civitai');

/** 识别为 LoRA 的扩展名（与 ComfyUI 支持一致） */
const LORA_EXTS = new Set(['.safetensors', '.sft', '.pt', '.ckpt', '.bin']);
/** sidecar 封面候选（按优先级） */
const PREVIEW_CANDIDATES = ['.preview.png', '.preview.jpg', '.preview.jpeg', '.png', '.jpg', '.jpeg'];
/** 封面 Content-Type */
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
/** 元数据文件（置顶等用户数据，key = lora 相对路径） */
const META_FILE = path.join(__dirname, '..', 'data', 'lora-meta.json');
/** 应用设置文件（自动检测命中后把 comfy.root 写回这里，与其他功能同源） */
const SETTINGS_FILE = path.join(__dirname, '..', 'data', 'settings.json');

/**
 * 创建 LoRA 管理路由
 * @param {Object} options
 * @param {Function} options.getComfyRoot - 读取 ComfyUI 根目录配置（实时，
 *        与 comfyTools 同源：data/settings.json 的 comfy.root）
 * @param {Function} [options.invalidateRootCache] - 写回 comfy.root 后调用，
 *        清掉 server.js 的 5 秒配置缓存，让随后的 /list 立即读到新值
 * @param {string} [options.comfyApiUrl] - ComfyUI API 地址（判断是否在运行）
 * @param {string} [options.metaFile] - 元数据文件路径（测试注入用，缺省
 *        data/lora-meta.json）
 * @returns {express.Router}
 */
function createLoraRouter({ getComfyRoot, invalidateRootCache, comfyApiUrl, metaFile } = {}) {
    const router = express.Router();
    const metaPath = metaFile || META_FILE;

    function fail(res, error, status = 500) {
        console.error('[lora]', error.message || error);
        res.status(status).json({ status: 'error', message: error.message || String(error) });
    }

    /** 把相对路径安全解析到 lorasDir 内，越界返回 null（路径穿越防护） */
    function safeResolve(lorasDir, relPath) {
        const p = path.resolve(lorasDir, relPath);
        if (p !== lorasDir && !p.startsWith(lorasDir + path.sep)) return null;
        return p;
    }

    /** 读元数据（置顶 + 触发词 + 备注；文件缺失/损坏按空处理） */
    async function readMeta() {
        try {
            const j = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
            return {
                pinned: Array.isArray(j.pinned) ? j.pinned : [],
                triggers: (j.triggers && typeof j.triggers === 'object')
                    ? j.triggers : {},
                notes: (j.notes && typeof j.notes === 'object')
                    ? j.notes : {},
                // Civitai 拉取记录（key = lora 相对路径）：
                // { modelName, versionName, baseModel, creator, pageUrl,
                //   sha256, coverFetched, fetchedAt }
                civitai: (j.civitai && typeof j.civitai === 'object')
                    ? j.civitai : {}
            };
        } catch {
            return { pinned: [], triggers: {}, notes: {}, civitai: {} };
        }
    }

    /** 原子写元数据（两个调用方各持整份结构，覆盖前先读避免互相清字段） */
    async function writeMeta(meta) {
        const tmp = metaPath + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf-8');
        await fs.rename(tmp, metaPath);
    }

    // ==================== 自动检测 ComfyUI 目录 ====================

    /** root 下的 models/loras 是否真实存在 */
    async function lorasDirExists(root) {
        try {
            return (await fs.stat(path.join(root, 'models', 'loras'))).isDirectory();
        } catch {
            return false;
        }
    }

    /** 把检测到的根目录写回 settings.json 的 comfy.root（原子写，保留其他字段） */
    async function writeComfyRoot(root) {
        let settings = {};
        try {
            settings = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf-8'));
        } catch { /* 文件缺失/损坏：从空对象开始建 */ }
        settings.comfy = settings.comfy || {};
        settings.comfy.root = root;
        const tmp = SETTINGS_FILE + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(settings, null, 2), 'utf-8');
        await fs.rename(tmp, SETTINGS_FILE);
        if (invalidateRootCache) invalidateRootCache();
    }

    /**
     * 从一行进程命令行里提取 ComfyUI 根目录（main.py 所在目录）。
     * 兼容带引号/带空格路径：从 main.py 往前找最后一个引号之外的盘符起点
     */
    function extractRootFromCmdline(line) {
        const i = line.toLowerCase().lastIndexOf('main.py');
        if (i === -1) return null;
        const m = /([A-Za-z]:\\)[^"]*$/.exec(line.slice(0, i));
        if (!m) return null;
        return line.slice(m.index, i).replace(/[\\/]+$/, '');
    }

    /** ComfyUI HTTP API 是否可达（区分"没开"和"开着但定位不到目录"） */
    async function comfyReachable() {
        if (!comfyApiUrl) return false;
        try {
            const r = await fetch(comfyApiUrl + '/system_stats', { signal: AbortSignal.timeout(2500) });
            return r.ok;
        } catch {
            return false;
        }
    }

    /**
     * 从运行中的 python 进程命令行反推 ComfyUI 根目录：
     * ComfyUI 跑起来是 python.exe ...main.py，命令行带着安装路径。
     * 多个候选时取第一个 models/loras 真实存在的
     */
    async function detectRootFromProcess() {
        if (process.platform !== 'win32') return null;
        const { stdout } = await new Promise((resolve) => {
            execFile('powershell.exe', ['-NoProfile', '-Command',
                "Get-CimInstance Win32_Process -Filter \"Name='python.exe' or Name='pythonw.exe'\" | Select-Object -ExpandProperty CommandLine"],
                { timeout: 8000 }, (err, out) => resolve({ err, stdout: out || '' }));
        });
        const lines = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        for (const line of lines) {
            const root = extractRootFromCmdline(line);
            if (root && await lorasDirExists(root)) return root;
        }
        return null;
    }

    // GET /detect：自动检测 ComfyUI 根目录（未配置/配置失效时由前端调用）
    router.get('/detect', async (req, res) => {
        try {
            // 1) 已配置且有效
            const configured = getComfyRoot();
            if (configured && await lorasDirExists(configured)) {
                return res.json({ status: 'ok', source: 'config', root: configured });
            }
            // 2) 进程反推（ComfyUI 在运行）；命中即写回配置永久记住
            const detected = await detectRootFromProcess();
            if (detected) {
                await writeComfyRoot(detected);
                console.log('[lora] 自动检测到 ComfyUI 目录并写入配置:', detected);
                return res.json({ status: 'ok', source: 'process', root: detected });
            }
            // 3) 区分"没开 ComfyUI"和"开着但定位不到"
            if (await comfyReachable()) {
                return res.json({ status: 'running-but-unknown' });
            }
            res.json({ status: 'not-running' });
        } catch (err) {
            fail(res, err);
        }
    });

    // ==================== GET /list：扫描 loras 目录 ====================

    /**
     * 递归扫描 lorasDir，返回 { folders, loras }（/list 与 Civitai 批量
     * 获取共用；loras 元素含 path/name/ext/folder/sizeBytes/mtime）
     */
    async function scanLoras(lorasDir) {
        const folders = new Set();
        const loras = [];
        // 手动递归（兼容旧 Node，readdir recursive 参数版本差异大）
        const walk = async (dir) => {
            let entries;
            try {
                entries = await fs.readdir(dir, { withFileTypes: true });
            } catch { return; }
            for (const e of entries) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    await walk(full);
                } else if (e.isFile() && LORA_EXTS.has(path.extname(e.name).toLowerCase())) {
                    const rel = path.relative(lorasDir, full).split(path.sep).join('/');
                    const relDir = path.dirname(rel);
                    const folder = relDir === '.' ? '' : relDir;
                    if (folder) folders.add(folder);
                    let s = null;
                    try { s = await fs.stat(full); } catch { /* 文件竞态：跳过尺寸 */ }
                    loras.push({
                        path: rel,                       // 唯一 id，Comfy lora_name 同源
                        name: path.basename(e.name, path.extname(e.name)),
                        ext: path.extname(e.name).toLowerCase(),
                        folder,                          // '' = 根目录
                        sizeBytes: s ? s.size : 0,
                        mtime: s ? s.mtimeMs : 0
                    });
                }
            }
        };
        await walk(lorasDir);
        loras.sort((a, b) => a.path.localeCompare(b.path));
        return { folders: [...folders].sort(), loras };
    }

    router.get('/list', async (req, res) => {
        try {
            const root = getComfyRoot();
            if (!root) {
                return res.status(400).json({ status: 'error', message: '尚未配置 ComfyUI 根目录（设置 → 通用）' });
            }
            const lorasDir = path.join(root, 'models', 'loras');
            let stat;
            try {
                stat = await fs.stat(lorasDir);
            } catch {
                return res.status(400).json({ status: 'error', message: `目录不存在：${lorasDir}` });
            }
            if (!stat.isDirectory()) {
                return res.status(400).json({ status: 'error', message: `不是目录：${lorasDir}` });
            }

            const { folders, loras } = await scanLoras(lorasDir);
            res.json({
                status: 'ok',
                lorasDir,
                folders,
                loras
            });
        } catch (err) {
            fail(res, err);
        }
    });

    // ==================== GET /preview：sidecar 封面图 ====================
    router.get('/preview', async (req, res) => {
        try {
            const root = getComfyRoot();
            const rel = String(req.query.path || '');
            if (!root || !rel) return res.status(404).end();
            const lorasDir = path.join(root, 'models', 'loras');
            const loraPath = safeResolve(lorasDir, rel);
            if (!loraPath) return res.status(403).json({ status: 'error', message: '路径越界' });

            const dir = path.dirname(loraPath);
            const base = path.basename(loraPath, path.extname(loraPath));
            for (const suffix of PREVIEW_CANDIDATES) {
                const img = path.join(dir, base + suffix);
                try {
                    const data = await fs.readFile(img);
                    res.set('Content-Type', MIME[path.extname(img).toLowerCase()] || 'image/png');
                    // 封面基本不变，浏览器缓存 1 天，省去每次开窗的重复请求
                    res.set('Cache-Control', 'private, max-age=86400');
                    return res.send(data);
                } catch { /* 试下一个候选 */ }
            }
            res.status(404).end();
        } catch (err) {
            fail(res, err);
        }
    });

    // ==================== POST /cover：上传/更新封面 ====================
    // 把前端传来的图片 data URL 写成 lora 同目录的 sidecar 预览文件
    //（<同名>.preview.<ext>），/preview 按候选顺序天然优先读到新图
    router.post('/cover', async (req, res) => {
        try {
            const root = getComfyRoot();
            if (!root) return res.status(400).json({ status: 'error', message: '尚未配置 ComfyUI 根目录' });
            const { path: rel, dataUrl } = req.body || {};
            if (typeof rel !== 'string' || !rel) {
                return res.status(400).json({ status: 'error', message: '缺少 path' });
            }
            if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
                return res.status(400).json({ status: 'error', message: 'dataUrl 必须是图片 data URL' });
            }
            const lorasDir = path.join(root, 'models', 'loras');
            const loraPath = safeResolve(lorasDir, rel);
            if (!loraPath) return res.status(403).json({ status: 'error', message: '路径越界' });

            const m = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
            if (!m) return res.status(400).json({ status: 'error', message: '仅支持 png/jpg/webp 格式' });
            const buf = Buffer.from(m[2], 'base64');
            if (!buf.length) return res.status(400).json({ status: 'error', message: '图片数据为空' });
            if (buf.length > 15 * 1024 * 1024) {
                return res.status(400).json({ status: 'error', message: '图片过大（上限 15MB）' });
            }
            const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
            const sidecar = path.join(
                path.dirname(loraPath),
                path.basename(loraPath, path.extname(loraPath)) + '.preview.' + ext
            );
            await fs.writeFile(sidecar, buf);
            res.json({ status: 'ok', sidecar: path.basename(sidecar) });
        } catch (err) {
            fail(res, err);
        }
    });

    // ==================== POST /delete：删除 lora ====================
    // 危险操作（前端有二次确认弹窗）：删除 lora 源文件 + 全部 sidecar
    // 预览候选 + 置顶记录。工作流 JSON 里写死的引用路径会因此断链，
    // 由确认弹窗警示用户
    router.post('/delete', async (req, res) => {
        try {
            const root = getComfyRoot();
            if (!root) return res.status(400).json({ status: 'error', message: '尚未配置 ComfyUI 根目录' });
            const { path: rel } = req.body || {};
            if (typeof rel !== 'string' || !rel) {
                return res.status(400).json({ status: 'error', message: '缺少 path' });
            }
            const lorasDir = path.join(root, 'models', 'loras');
            const loraPath = safeResolve(lorasDir, rel);
            if (!loraPath) return res.status(403).json({ status: 'error', message: '路径越界' });
            if (!LORA_EXTS.has(path.extname(loraPath).toLowerCase())) {
                return res.status(400).json({ status: 'error', message: '不是 lora 文件' });
            }
            try {
                await fs.access(loraPath);
            } catch {
                return res.status(404).json({ status: 'error', message: '文件不存在（可能已被删除）' });
            }
            await fs.unlink(loraPath);
            // 清 sidecar 预览（/preview 的全部候选名），不留孤儿图
            const dir = path.dirname(loraPath);
            const base = path.basename(loraPath, path.extname(loraPath));
            let removedPreviews = 0;
            for (const suffix of PREVIEW_CANDIDATES) {
                try {
                    await fs.unlink(path.join(dir, base + suffix));
                    removedPreviews++;
                } catch { /* 候选不存在属正常 */ }
            }
            // 清置顶/触发词/备注记录
            const meta = await readMeta();
            let dirty = false;
            if (meta.pinned.includes(rel)) {
                meta.pinned = meta.pinned.filter((p) => p !== rel);
                dirty = true;
            }
            for (const key of ['triggers', 'notes']) {
                if (meta[key][rel] !== undefined) {
                    delete meta[key][rel];
                    dirty = true;
                }
            }
            if (dirty) await writeMeta(meta);
            console.log('[lora] 已删除:', rel, `(含 ${removedPreviews} 个预览文件)`);
            res.json({ status: 'ok', removedPreviews });
        } catch (err) {
            fail(res, err);
        }
    });

    // ==================== POST /move：移动 lora 到另一文件夹 ====================
    // { paths: [rel...], target: ''（根目录）| '子/目录' }。
    // 移动 lora 文件 + 全部 sidecar 预览候选 + lora-meta 记录换 key
    // （置顶/触发词/备注/Civitai 记录跟着文件走）。目标已有同名文件时
    // 该只跳过不覆盖；移动后工作流 JSON 里写死的旧路径会断链，由前端
    // 确认弹窗警示（与 /delete 同款风险口径）
    router.post('/move', async (req, res) => {
        try {
            const root = getComfyRoot();
            if (!root) return res.status(400).json({ status: 'error', message: '尚未配置 ComfyUI 根目录' });
            const { paths, target } = req.body || {};
            if (!Array.isArray(paths) || !paths.length) {
                return res.status(400).json({ status: 'error', message: '缺少 paths' });
            }
            if (paths.length > 500) {
                return res.status(400).json({ status: 'error', message: '单次最多移动 500 个文件' });
            }
            // 目标目录校验：空串 = 根目录；否则反斜杠统一成斜杠、去首尾，
            // 逐段拒绝空段/点段/Windows 非法字符
            const targetFolder = typeof target === 'string'
                ? target.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
                : '';
            if (targetFolder) {
                const bad = targetFolder.split('/').some((seg) =>
                    !seg || seg === '.' || seg === '..' || /[\\:*?"<>|]/.test(seg));
                if (bad) return res.status(400).json({ status: 'error', message: '目标目录名不合法' });
            }
            const lorasDir = path.join(root, 'models', 'loras');
            const destDir = safeResolve(lorasDir, targetFolder || '.');
            if (!destDir) return res.status(403).json({ status: 'error', message: '目标目录越界' });

            const moved = [];
            const skipped = [];
            const failed = [];
            for (const rel of paths) {
                if (typeof rel !== 'string' || !rel) continue;
                const src = safeResolve(lorasDir, rel);
                if (!src) { failed.push({ path: rel, reason: '路径越界' }); continue; }
                if (!LORA_EXTS.has(path.extname(src).toLowerCase())) {
                    failed.push({ path: rel, reason: '不是 lora 文件' });
                    continue;
                }
                const dest = path.join(destDir, path.basename(src));
                if (path.resolve(dest) === path.resolve(src)) {
                    skipped.push({ path: rel, reason: '已在目标文件夹' });
                    continue;
                }
                try {
                    await fs.access(dest);
                    skipped.push({ path: rel, reason: '目标已有同名文件' });
                    continue;
                } catch { /* 目标不存在，可移动 */ }
                try {
                    await fs.mkdir(destDir, { recursive: true });
                    await fs.rename(src, dest);
                    // sidecar 预览候选一并搬走（/preview 同名约定），不留孤儿图
                    const srcBase = path.basename(src, path.extname(src));
                    const destBase = path.basename(dest, path.extname(dest));
                    let movedPreviews = 0;
                    for (const suffix of PREVIEW_CANDIDATES) {
                        try {
                            await fs.rename(path.join(path.dirname(src), srcBase + suffix), path.join(destDir, destBase + suffix));
                            movedPreviews++;
                        } catch { /* 候选不存在属正常 */ }
                    }
                    // meta 记录换 key（置顶/触发词/备注/Civitai 记录跟着文件走）
                    const newRel = targetFolder ? `${targetFolder}/${path.basename(src)}` : path.basename(src);
                    if (newRel !== rel) {
                        const meta = await readMeta();
                        let dirty = false;
                        if (meta.pinned.includes(rel)) {
                            meta.pinned = meta.pinned.filter((p) => p !== rel);
                            if (!meta.pinned.includes(newRel)) meta.pinned.push(newRel);
                            dirty = true;
                        }
                        for (const key of ['triggers', 'notes', 'civitai']) {
                            if (meta[key] && meta[key][rel] !== undefined) {
                                meta[key][newRel] = meta[key][rel];
                                delete meta[key][rel];
                                dirty = true;
                            }
                        }
                        if (dirty) await writeMeta(meta);
                    }
                    moved.push({ from: rel, to: newRel, movedPreviews });
                    console.log('[lora] 已移动:', rel, '->', newRel);
                } catch (err) {
                    failed.push({ path: rel, reason: err.message });
                }
            }
            res.json({ status: 'ok', moved: moved.length, skipped, failed });
        } catch (err) {
            fail(res, err);
        }
    });

    // ==================== POST /reveal：在资源管理器中打开所在文件夹 ====================
    // explorer /select,"路径"——打开 lora 所在文件夹并选中该文件
    router.post('/reveal', async (req, res) => {
        try {
            const root = getComfyRoot();
            if (!root) return res.status(400).json({ status: 'error', message: '尚未配置 ComfyUI 根目录' });
            const { path: rel } = req.body || {};
            if (typeof rel !== 'string' || !rel) {
                return res.status(400).json({ status: 'error', message: '缺少 path' });
            }
            const lorasDir = path.join(root, 'models', 'loras');
            const loraPath = safeResolve(lorasDir, rel);
            if (!loraPath) return res.status(403).json({ status: 'error', message: '路径越界' });
            try {
                await fs.access(loraPath);
            } catch {
                return res.status(404).json({ status: 'error', message: '文件不存在' });
            }
            if (process.platform === 'win32') {
                // explorer 的退出码恒为 1（非失败语义），忽略错误回调
                exec(`explorer /select,"${loraPath}"`, () => {});
            } else {
                execFile('xdg-open', [path.dirname(loraPath)], () => {});
            }
            res.json({ status: 'ok', fullPath: loraPath });
        } catch (err) {
            fail(res, err);
        }
    });

    // ==================== GET/POST /pins：置顶状态 ====================
    router.get('/pins', async (req, res) => {
        try {
            const meta = await readMeta();
            res.json({
                status: 'ok',
                pinned: meta.pinned,
                triggers: meta.triggers,
                notes: meta.notes,
                // Civitai 拉取记录（含 pageUrl，供信息窗「打开 C 站页面」按钮）
                civitai: meta.civitai
            });
        } catch (err) {
            fail(res, err);
        }
    });

    router.post('/pins', async (req, res) => {
        try {
            const { path: rel, pinned } = req.body || {};
            if (typeof rel !== 'string' || !rel) {
                return res.status(400).json({ status: 'error', message: '缺少 path' });
            }
            const meta = await readMeta();
            const set = new Set(meta.pinned);
            if (pinned) set.add(rel); else set.delete(rel);
            meta.pinned = [...set];
            await writeMeta(meta);
            res.json({ status: 'ok', pinned: meta.pinned });
        } catch (err) {
            fail(res, err);
        }
    });

    // ==================== POST /trigger 与 /note：文本元数据读写 ====================
    // { path, text }：text 非空保存、空串删除该条记录。
    // trigger → meta.triggers（触发词）；note → meta.notes（备注）
    for (const [route, field] of [['trigger', 'triggers'], ['note', 'notes']]) {
        router.post('/' + route, async (req, res) => {
            try {
                const { path: rel, text } = req.body || {};
                if (typeof rel !== 'string' || !rel) {
                    return res.status(400).json({ status: 'error', message: '缺少 path' });
                }
                if (typeof text !== 'string') {
                    return res.status(400).json({ status: 'error', message: '缺少 text' });
                }
                const meta = await readMeta();
                const trimmed = text.trim();
                if (trimmed) meta[field][rel] = trimmed;
                else delete meta[field][rel];
                await writeMeta(meta);
                res.json({ status: 'ok', text: trimmed });
            } catch (err) {
                fail(res, err);
            }
        });
    }

    // ==================== Civitai 一键获取（封面 + 触发词） ====================
    // 参考 ComfyUI-Lora-Manager 插件：以文件 SHA256 为身份查
    // civitai.red /model-versions/by-hash 拿版本数据。触发词写
    // meta.triggers，封面写 sidecar <同名>.preview.<ext>（现有 /preview
    // 读取链零改动），模型名/底模/作者/Civitai 链接等记 meta.civitai。

    /** lora 是否已有 sidecar 封面（判断「自定义封面」用） */
    async function sidecarCoverExists(loraPath) {
        const dir = path.dirname(loraPath);
        const base = path.basename(loraPath, path.extname(loraPath));
        for (const suffix of PREVIEW_CANDIDATES) {
            try {
                await fs.access(path.join(dir, base + suffix));
                return true;
            } catch { /* 试下一个候选 */ }
        }
        return false;
    }

    /** 触发词合并：中英文逗号统一拆分 + 去重，保持已有词在前 */
    function mergeTriggerText(cur, next) {
        const split = (s) => String(s || '').split(/[,，]+/).map((x) => x.trim()).filter(Boolean);
        return [...new Set([...split(cur), ...split(next)])].join(', ');
    }

    /**
     * 对单个 lora 执行 Civitai 获取（算哈希→by-hash→写触发词/封面/记录）
     * @param {string} relPath - lora 相对路径
     * @param {Object} opts - { onConflict: 'overwrite'|'merge'|'skip',
     *                          skipCustomCover: boolean, updateCover: boolean }
     * @returns {Promise<Object>} { status: 'ok'|'not-found'|'error', ... }
     */
    async function fetchCivitaiForLora(relPath, opts = {}) {
        const onConflict = opts.onConflict || 'merge';
        const skipCustomCover = opts.skipCustomCover !== false;

        const root = getComfyRoot();
        if (!root) return { status: 'error', error: '尚未配置 ComfyUI 根目录' };
        const lorasDir = path.join(root, 'models', 'loras');
        const abs = safeResolve(lorasDir, relPath);
        if (!abs) return { status: 'error', error: '路径越界' };
        let stat;
        try {
            stat = await fs.stat(abs);
        } catch {
            return { status: 'error', error: '文件不存在' };
        }

        // 1) SHA256（带缓存，size/mtime 变了才重算）
        let sha;
        try {
            sha = await civitai.getSha256(lorasDir, relPath, stat);
        } catch (err) {
            return { status: 'error', error: `计算哈希失败：${err.message}` };
        }

        // 2) by-hash 查询（代理 + 鉴权）
        const { apiKey } = await civitai.getCivitaiSettings();
        const proxyUrl = await civitai.resolveProxy();
        const dispatcher = civitai.getDispatcher(proxyUrl);
        let version;
        try {
            version = await civitai.fetchVersionByHash(sha, { apiKey, dispatcher });
        } catch (err) {
            if (err.code === 'NOT_FOUND') return { status: 'not-found', sha256: sha };
            return { status: 'error', error: `Civitai 查询失败：${err.message}` };
        }
        if (!version || typeof version !== 'object') {
            return { status: 'error', error: 'Civitai 返回数据格式异常' };
        }

        // 3) 触发词（trainedWords 数组 join；冲突按策略处理）
        const meta = await readMeta();
        const prev = (meta.civitai && meta.civitai[relPath]) || {};
        const words = (Array.isArray(version.trainedWords) ? version.trainedWords : [])
            .filter((w) => typeof w === 'string' && w.trim())
            .map((w) => w.trim());
        const fetchedTriggers = words.join(', ');
        let triggersUpdated = false;
        if (fetchedTriggers) {
            const cur = (meta.triggers[relPath] || '').trim();
            if (!cur) {
                meta.triggers[relPath] = fetchedTriggers;
                triggersUpdated = true;
            } else if (onConflict === 'overwrite') {
                meta.triggers[relPath] = fetchedTriggers;
                triggersUpdated = true;
            } else if (onConflict === 'merge') {
                const merged = mergeTriggerText(cur, fetchedTriggers);
                if (merged !== cur) {
                    meta.triggers[relPath] = merged;
                    triggersUpdated = true;
                }
            }
            // 'skip'：已有手填触发词则不动
        }

        // 4) 封面（自定义封面跳过判据：sidecar 存在且非上次拉取所得）
        const imgUrl = civitai.pickCoverImage(version);
        let coverUpdated = false;
        let coverSkipped = false;
        let coverError = null;
        if (imgUrl) {
            if (skipCustomCover && !prev.coverFetched && await sidecarCoverExists(abs)) {
                coverSkipped = true;
            } else {
                try {
                    const ext = civitai.pickCoverExt(imgUrl);
                    const sidecar = path.join(
                        path.dirname(abs),
                        path.basename(abs, path.extname(abs)) + '.preview.' + ext
                    );
                    await civitai.downloadPreview(imgUrl, sidecar, { dispatcher });
                    coverUpdated = true;
                } catch (err) {
                    coverError = err.message;
                }
            }
        }

        // 4.5) 模型页正文（/models/{id} 的模型描述，HTML 格式——与版本描述
        //      不同，这是 C 站模型页展示的正文。每个 LoRA 多一次 API 调用；
        //      失败置空不阻塞，重新「从 Civitai 获取」可补齐）
        let modelDesc = '';
        if (version.modelId) {
            modelDesc = await civitai.fetchModelDescription(version.modelId, { apiKey, dispatcher });
        }

        // 5) 记录拉取结果（元信息备查 + coverFetched 标记供下次判自定义封面）
        meta.civitai[relPath] = {
            modelName: (version.model && version.model.name) || '',
            versionName: version.name || '',
            baseModel: version.baseModel || '',
            creator: (version.creator && version.creator.username) || '',
            pageUrl: version.modelId
                ? `https://civitai.red/models/${version.modelId}?modelVersionId=${version.id}`
                : '',
            description: modelDesc,
            sha256: sha,
            coverFetched: !!(prev.coverFetched || coverUpdated),
            fetchedAt: new Date().toISOString()
        };
        await writeMeta(meta);

        return {
            status: 'ok',
            sha256: sha,
            triggersUpdated,
            triggers: meta.triggers[relPath] || '',
            coverUpdated,
            coverSkipped,
            coverError,
            info: meta.civitai[relPath]
        };
    }

    // 批量任务状态机（单实例后端，模块级即可；前端 1s 轮询 /civitai/progress）
    let batchState = {
        running: false, cancel: false, phase: '',   // phase: scan|work|done
        total: 0, done: 0, found: 0, notFound: 0, failed: 0, skipped: 0,
        current: '', lastError: ''
    };

    /** 批量获取主循环（不 await，由 fetch-all 路由即发即忘启动） */
    async function runFetchAll(options) {
        try {
            batchState = {
                running: true, cancel: false, phase: 'scan',
                total: 0, done: 0, found: 0, notFound: 0, failed: 0, skipped: 0,
                current: '', lastError: ''
            };
            const root = getComfyRoot();
            const lorasDir = path.join(root, 'models', 'loras');
            const { loras } = await scanLoras(lorasDir);
            batchState.total = loras.length;
            batchState.phase = 'work';

            for (const lora of loras) {
                if (batchState.cancel) break;
                batchState.current = lora.name;
                // 跳过已获取过的（meta.civitai 有 fetchedAt 记录）
                if (options.skipFetched) {
                    const meta = await readMeta();
                    if (meta.civitai[lora.path] && meta.civitai[lora.path].fetchedAt) {
                        batchState.skipped++;
                        batchState.done++;
                        continue;
                    }
                }
                try {
                    const r = await fetchCivitaiForLora(lora.path, options);
                    if (r.status === 'ok') batchState.found++;
                    else if (r.status === 'not-found') batchState.notFound++;
                    else {
                        batchState.failed++;
                        batchState.lastError = `${lora.name}: ${r.error || '未知错误'}`;
                    }
                } catch (err) {
                    batchState.failed++;
                    batchState.lastError = `${lora.name}: ${err.message}`;
                }
                batchState.done++;
                // 请求间隔防限速（ Civitai 无 key 时限额很严）
                await civitai.sleep(1200);
            }
        } catch (err) {
            batchState.lastError = err.message || String(err);
        } finally {
            try { await civitai.saveHashCache(); } catch { /* 落盘失败不影响结果 */ }
            batchState.running = false;
            batchState.phase = 'done';
            batchState.current = '';
        }
    }

    // GET /civitai/hash：取单个 lora 的本地 SHA256（带缓存，按需计算）
    // + C 站记录哈希（meta.civitai 有拉取记录时），match 供前端做比对标记
    router.get('/civitai/hash', async (req, res) => {
        try {
            const rel = String(req.query.path || '');
            const root = getComfyRoot();
            if (!root || !rel) {
                return res.status(400).json({ status: 'error', message: '缺少 path 或未配置 ComfyUI 根目录' });
            }
            const lorasDir = path.join(root, 'models', 'loras');
            const abs = safeResolve(lorasDir, rel);
            if (!abs) return res.status(403).json({ status: 'error', message: '路径越界' });
            let stat;
            try {
                stat = await fs.stat(abs);
            } catch {
                return res.status(404).json({ status: 'error', message: '文件不存在' });
            }
            const sha = await civitai.getSha256(lorasDir, rel, stat);
            const meta = await readMeta();
            const recorded = ((meta.civitai[rel] && meta.civitai[rel].sha256) || '').toLowerCase();
            res.json({
                status: 'ok',
                sha256: sha,
                civitaiSha256: recorded,
                match: recorded ? recorded === sha.toLowerCase() : null
            });
        } catch (err) {
            fail(res, err);
        }
    });

    // POST /civitai/fetch：单只获取 { path, onConflict, skipCustomCover }
    router.post('/civitai/fetch', async (req, res) => {
        try {
            if (batchState.running) {
                return res.status(409).json({ status: 'error', message: '批量获取进行中，请稍后再试' });
            }
            const { path: rel, onConflict, skipCustomCover } = req.body || {};
            if (typeof rel !== 'string' || !rel) {
                return res.status(400).json({ status: 'error', message: '缺少 path' });
            }
            const result = await fetchCivitaiForLora(rel, { onConflict, skipCustomCover });
            res.json({ status: result.status === 'error' ? 'error' : 'ok', ...result });
        } catch (err) {
            fail(res, err);
        }
    });

    // POST /civitai/fetch-all：启动批量获取（即发即忘，进度走 /civitai/progress）
    router.post('/civitai/fetch-all', async (req, res) => {
        try {
            if (batchState.running) {
                return res.status(409).json({ status: 'error', message: '批量获取已在进行中' });
            }
            const body = req.body || {};
            const options = {
                onConflict: ['overwrite', 'merge', 'skip'].includes(body.onConflict) ? body.onConflict : 'merge',
                skipCustomCover: body.skipCustomCover !== false,
                skipFetched: body.skipFetched !== false
            };
            const root = getComfyRoot();
            if (!root) {
                return res.status(400).json({ status: 'error', message: '尚未配置 ComfyUI 根目录' });
            }
            runFetchAll(options);   // 不 await：立即返回，后台慢慢跑
            res.json({ status: 'ok' });
        } catch (err) {
            fail(res, err);
        }
    });

    // GET /civitai/progress：批量进度快照（前端轮询）
    router.get('/civitai/progress', async (req, res) => {
        res.json({ status: 'ok', ...batchState });
    });

    // POST /civitai/open-page：用系统默认浏览器打开 Civitai 模型页。
    // 不用前端 window.open——应用若跑在 IDE 内置浏览器等独立 profile 里，
    // 没有用户日常浏览器的登录 Cookie；走系统默认浏览器才能带上登录态。
    // 统一在 civitai.red 域打开（用户登录/可访问的镜像站）；旧记录里存的
    // civitai.com 链接在此重写，仅放行这两个域，防任意 URL 注入
    router.post('/civitai/open-page', async (req, res) => {
        try {
            let { url } = req.body || {};
            if (typeof url !== 'string' || !/^https:\/\/civitai\.(com|red)\//.test(url)) {
                return res.status(400).json({ status: 'error', message: '仅支持 civitai 页面链接' });
            }
            url = url.replace(/^https:\/\/civitai\.com\//, 'https://civitai.red/');
            if (process.platform === 'win32') {
                // cmd start 的引号形式：空标题占位 + 带引号 URL（& 等字符安全）
                exec(`start "" "${url}"`, () => {});
            } else if (process.platform === 'darwin') {
                execFile('open', [url], () => {});
            } else {
                execFile('xdg-open', [url], () => {});
            }
            res.json({ status: 'ok' });
        } catch (err) {
            fail(res, err);
        }
    });

    // POST /civitai/cancel：请求停止批量任务（当前项完成后停）
    router.post('/civitai/cancel', async (req, res) => {
        if (batchState.running) batchState.cancel = true;
        res.json({ status: 'ok', cancelRequested: batchState.running });
    });

    return router;
}

module.exports = createLoraRouter;

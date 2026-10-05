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
 * 只读 Comfy 目录 + 写 data/ 元数据，不做重命名/删除（路径写死在工作流
 * JSON 里，改名会静默断链）。
 * ==========================================================================
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { execFile, exec } = require('child_process');

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
 * @returns {express.Router}
 */
function createLoraRouter({ getComfyRoot, invalidateRootCache, comfyApiUrl }) {
    const router = express.Router();

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
            const j = JSON.parse(await fs.readFile(META_FILE, 'utf-8'));
            return {
                pinned: Array.isArray(j.pinned) ? j.pinned : [],
                triggers: (j.triggers && typeof j.triggers === 'object')
                    ? j.triggers : {},
                notes: (j.notes && typeof j.notes === 'object')
                    ? j.notes : {}
            };
        } catch {
            return { pinned: [], triggers: {}, notes: {} };
        }
    }

    /** 原子写元数据（两个调用方各持整份结构，覆盖前先读避免互相清字段） */
    async function writeMeta(meta) {
        const tmp = META_FILE + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(meta, null, 2), 'utf-8');
        await fs.rename(tmp, META_FILE);
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
            res.json({
                status: 'ok',
                lorasDir,
                folders: [...folders].sort(),
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
                notes: meta.notes
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

    return router;
}

module.exports = createLoraRouter;

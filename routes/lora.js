/**
 * ==========================================================================
 * LoRA 管理接口（/api/lora）
 * 作用：为画布顶栏「LoRA 管理」窗口提供数据：
 *   - GET  /list     递归扫描 <comfy.root>/models/loras/，返回文件夹清单与
 *                    LoRA 文件清单（相对路径为唯一 id，与 Comfy 工作流里
 *                    写死的路径同源）
 *   - GET  /preview  按 sidecar 惯例取封面图（<同名>.preview.png/.jpg，
 *                    兜底 <同名>.png/.jpg），无图返回 404 由前端显示占位块
 *   - GET /POST /pins 置顶状态读写；GET /trigger /note POST 文本读写；
 *                    GET /civitai/info 单条全量 C 站记录——均存 per-LoRA
 *                    sidecar JSON（lora 旁 <同名>_lumen.json，信息跟文件走）
 *   - POST /delete  删除 lora（源文件 + sidecar 预览 + sidecar JSON）
 *   - POST /move    移动 lora 到另一文件夹（文件 + sidecar 全套跟着走）
 *   - POST /reveal  资源管理器打开所在文件夹并选中
 * 元数据存储（2026-11-12 起中央 lora-meta.json 退役）：置顶/触发词/备注/
 * Civitai 拉取记录全部写在 lora 旁 <同名>_lumen.json sidecar 里——带
 * _lumen 标识防与本地其他 LoRA 管理器（ComfyUI-Lora-Manager 等）生成的
 * <同名>.json 冲突；读写 O(1)（几千个 lora 无中央文件写放大）、单条损坏
 * 爆炸半径 1；后端内存缓存 + mtime 复验扛 /pins 聚合读。旧版中央 meta 在
 * 首个触点幂等迁出（lora 已不在的孤儿记录丢弃），原文件改名
 * lora-meta.json.migrated.bak 留档；更早试运行期的无标识 <同名>.json
 * sidecar 在首个 /list //pins 按 schema 认领改名为 _lumen（别家格式不动）。
 * 只读 Comfy 目录 + 写 sidecar；删除/移动走显式确认（工作流 JSON 里
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
/** 旧版中央元数据文件（仅作一次性迁移源，迁移后改名 .migrated.bak 留档） */
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
 * @param {string} [options.metaFile] - 旧版中央 meta 路径（迁移源；测试
 *        注入用，缺省 data/lora-meta.json）
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

    // ==================== per-LoRA sidecar JSON 存储层 ====================
    // 每个 lora 的全部状态写在 lora 旁 <同名>_lumen.json（_lumen 标识防与
    // 本地其他 LoRA 管理器的 <同名>.json 冲突）：
    // { triggers, note, pinned, civitai: {modelName, versionName, baseModel,
    //   creator, pageUrl, description, sha256, coverFetched, fetchedAt} }
    // 读走内存缓存（mtime 复验，外部手改可察觉），写走 tmp+rename 原子落盘。

    /** sidecar JSON 绝对路径（lora 旁 <同名>_lumen.json；lora 不在时无意义） */
    function sidecarPath(abs) {
        return path.join(path.dirname(abs), path.basename(abs, path.extname(abs)) + '_lumen.json');
    }

    /** 旧命名 sidecar（无 _lumen 标识的 <同名>.json，试运行期产物）路径 */
    function sidecarPathLegacy(abs) {
        return path.join(path.dirname(abs), path.basename(abs, path.extname(abs)) + '.json');
    }

    /** sidecar 内存缓存（key = lora 绝对路径）：读聚合与批量任务的主通道，
     *  mtime 不变直接复用，避免几千个文件的反复 stat+read+parse */
    const sidecarCache = new Map();

    /** 读单个 lora 的 sidecar（带缓存复验；无文件/损坏 → 空结构，不抛错） */
    async function readSidecar(abs) {
        let mtime = 0;
        try { mtime = (await fs.stat(sidecarPath(abs))).mtimeMs; } catch { /* 无 sidecar */ }
        const hit = sidecarCache.get(abs);
        if (hit && hit.mtime === mtime) return hit.data;
        const data = { triggers: undefined, note: undefined, pinned: undefined, civitai: null };
        if (mtime) {
            try {
                const j = JSON.parse(await fs.readFile(sidecarPath(abs), 'utf-8'));
                data.triggers = typeof j.triggers === 'string' ? j.triggers : undefined;
                data.note = typeof j.note === 'string' ? j.note : undefined;
                data.pinned = typeof j.pinned === 'boolean' ? j.pinned : undefined;
                data.civitai = (j.civitai && typeof j.civitai === 'object') ? j.civitai : null;
            } catch (err) {
                console.warn('[lora] sidecar JSON 损坏，按空处理:', sidecarPath(abs), err.message);
            }
        }
        sidecarCache.set(abs, { data, mtime });
        return data;
    }

    /** 原子写单个 lora 的 sidecar 并写穿缓存（patch 与缓存结构同形；
     *  值置 undefined 即删除该字段，JSON.stringify 丢弃 undefined 键） */
    async function writeSidecar(abs, data) {
        const sidecar = sidecarPath(abs);
        const tmp = sidecar + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
        await fs.rename(tmp, sidecar);
        const mtime = (await fs.stat(sidecar)).mtimeMs;
        sidecarCache.set(abs, { data, mtime });
    }

    /** 旧版中央 meta 是否已迁出（true 后不再检查；lorasDir 未配置时不置位，
     *  等 root 就绪的首个触点再迁） */
    let migrated = false;

    /**
     * 一次性迁移：旧版 data/lora-meta.json（pinned 数组 + triggers/notes/
     * civitai 三张以相对路径为 key 的表）逐条并入对应 sidecar。只填空字段
     * 不覆盖现有值（幂等，重跑无害）；lora 文件已不在的孤儿记录丢弃；
     * 迁完把中央文件改名 .migrated.bak 留档。所有 sidecar 触点先调它。
     * @param {string} lorasDir - loras 根目录（root 未配置时跳过不置位）
     */
    async function ensureMigrated(lorasDir) {
        if (migrated || !lorasDir) return;
        migrated = true;   // 先置位：并发请求不重复迁（合并语义幂等，重入无害）
        let legacy;
        try {
            legacy = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
        } catch { return; }   // 无旧文件：全新安装，直接 sidecar
        const pinnedSet = new Set(Array.isArray(legacy.pinned) ? legacy.pinned : []);
        const rels = new Set(pinnedSet);
        for (const k of ['triggers', 'notes', 'civitai']) {
            if (legacy[k] && typeof legacy[k] === 'object') {
                for (const rel of Object.keys(legacy[k])) rels.add(rel);
            }
        }
        let count = 0;
        for (const rel of rels) {
            const abs = safeResolve(lorasDir, rel);
            if (!abs) continue;
            try { await fs.access(abs); } catch { continue; }   // lora 已删：孤儿记录丢弃
            const cur = await readSidecar(abs);
            let dirty = false;
            if (cur.triggers === undefined && legacy.triggers && legacy.triggers[rel]) {
                cur.triggers = legacy.triggers[rel]; dirty = true;
            }
            if (cur.note === undefined && legacy.notes && legacy.notes[rel]) {
                cur.note = legacy.notes[rel]; dirty = true;
            }
            if (cur.pinned === undefined && pinnedSet.has(rel)) {
                cur.pinned = true; dirty = true;
            }
            if (!cur.civitai && legacy.civitai && legacy.civitai[rel]) {
                cur.civitai = legacy.civitai[rel]; dirty = true;
            }
            if (dirty) { await writeSidecar(abs, cur); count++; }
        }
        try { await fs.rename(metaPath, metaPath + '.migrated.bak'); } catch { /* 已不在则跳过 */ }
        console.log(`[lora] 旧版 lora-meta.json 已迁出为 per-LoRA sidecar JSON（${count} 条），原文件改名 .migrated.bak`);
    }

    /** 旧命名 <同名>.json 是否已收编（true 后不再扫——收编完后目录里再出现
     *  的 <同名>.json 是其他管理器新写的，不归本应用管） */
    let sidecarRenamed = false;

    /**
     * 一次性收编：试运行期的旧命名 <同名>.json sidecar 改名为
     * <同名>_lumen.json（加标识防与其他 LoRA 管理器冲突）。只认本应用
     * schema（triggers 字符串 / pinned 布尔 / note 字符串 / civitai 对象
     * 任一命中）——别家管理器格式不同，原样不动不误抢。须先于
     * ensureMigrated 跑（改名后的空字段才轮得到中央 meta 填充）。
     * @param {string} lorasDir - loras 根目录
     * @param {Array<{path: string}>} loras - scanLoras 产物（收编以 lora
     *        实存为准，孤儿 JSON 不碰）
     */
    async function ensureSidecarRenamed(lorasDir, loras) {
        if (sidecarRenamed) return;
        sidecarRenamed = true;
        let count = 0;
        for (const lora of loras) {
            const abs = path.join(lorasDir, lora.path);
            const legacy = sidecarPathLegacy(abs);
            let hasLegacy = false;
            try { await fs.access(legacy); hasLegacy = true; } catch { /* 无旧文件 */ }
            if (!hasLegacy) continue;
            // 只认本应用 schema（triggers 字符串 / pinned 布尔 / note 字符串 /
            // civitai 对象任一命中）——别家管理器格式不同，原样不动不误抢
            let legacyData = null;
            try {
                const j = JSON.parse(await fs.readFile(legacy, 'utf-8'));
                const ours = typeof j.triggers === 'string' || typeof j.pinned === 'boolean' ||
                    typeof j.note === 'string' || (j.civitai && typeof j.civitai === 'object');
                if (ours) legacyData = j;
            } catch { /* 损坏 JSON 不动，避免误收别家文件 */ }
            if (!legacyData) continue;
            let newExists = false;
            try { await fs.access(sidecarPath(abs)); newExists = true; } catch { /* 可直接改名 */ }
            if (!newExists) {
                await fs.rename(legacy, sidecarPath(abs));
                count++;
                continue;
            }
            // 双份并存（试运行期迁移已写过新名）：旧文件按填空并进新文件后
            // 删除——sidecar 现值优先，旧名只补空字段，绝不覆盖
            const cur = await readSidecar(abs);
            let dirty = false;
            if (cur.triggers === undefined && typeof legacyData.triggers === 'string') {
                cur.triggers = legacyData.triggers; dirty = true;
            }
            if (cur.note === undefined && typeof legacyData.note === 'string') {
                cur.note = legacyData.note; dirty = true;
            }
            if (cur.pinned === undefined && typeof legacyData.pinned === 'boolean') {
                cur.pinned = legacyData.pinned; dirty = true;
            }
            if (!cur.civitai && legacyData.civitai && typeof legacyData.civitai === 'object') {
                cur.civitai = legacyData.civitai; dirty = true;
            }
            if (dirty) await writeSidecar(abs, cur);
            await fs.unlink(legacy);
            count++;
        }
        if (count) console.log(`[lora] 旧命名 sidecar <同名>.json 已收编为 <同名>_lumen.json（${count} 个）`);
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
            await ensureSidecarRenamed(lorasDir, loras);   // 旧命名先收编
            await ensureMigrated(lorasDir);                // 中央 meta 再并入（填收编后的空字段）
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
            // 清 sidecar JSON（置顶/触发词/备注/Civitai 记录都在里面；
            // 新旧命名都试——旧命名可能是收编前遗留）
            try { await fs.unlink(sidecarPath(loraPath)); } catch { /* 本就没有 */ }
            try { await fs.unlink(sidecarPathLegacy(loraPath)); } catch { /* 本就没有 */ }
            sidecarCache.delete(loraPath);
            console.log('[lora] 已删除:', rel, `(含 ${removedPreviews} 个预览文件)`);
            res.json({ status: 'ok', removedPreviews });
        } catch (err) {
            fail(res, err);
        }
    });

    // ==================== POST /move：移动 lora 到另一文件夹 ====================
    // { paths: [rel...], target: ''（根目录）| '子/目录' }。
    // 移动 lora 文件 + 全部 sidecar 预览候选 + sidecar JSON（置顶/触发词/
    // 备注/Civitai 记录跟着文件走）。目标已有同名文件时该只跳过不覆盖；
    // 移动后工作流 JSON 里写死的旧路径会断链，由前端确认弹窗警示
    // （与 /delete 同款风险口径）
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
            await ensureMigrated(lorasDir);   // 旧 meta 先落 sidecar，才能跟着文件走

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
                    // sidecar JSON（置顶/触发词/备注/Civitai 记录）跟着文件走；
                    // 旧命名（无 _lumen）也一并收编成新命名
                    let movedMeta = false;
                    try {
                        await fs.rename(sidecarPath(src), sidecarPath(dest));
                        movedMeta = true;
                    } catch {
                        try { await fs.rename(sidecarPathLegacy(src), sidecarPath(dest)); movedMeta = true; }
                        catch { /* 本就没有，属正常 */ }
                    }
                    sidecarCache.delete(src);
                    sidecarCache.delete(dest);
                    const newRel = targetFolder ? `${targetFolder}/${path.basename(src)}` : path.basename(src);
                    moved.push({ from: rel, to: newRel, movedPreviews, movedMeta });
                    console.log('[lora] 已移动:', rel, '->', newRel, movedMeta ? '（含 sidecar JSON）' : '');
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

    // ==================== GET/POST /pins：置顶状态 + 聚合元数据 ====================
    // GET：全量聚合（扫 loras → 逐个读 sidecar 缓存）。civitai 记录剥离
    // description 大字段（几千个 lora 时 HTML 正文能把载荷抬到几十 MB；
    // 全量记录走 GET /civitai/info 单条按需取，信息窗打开时拉）
    router.get('/pins', async (req, res) => {
        try {
            const root = getComfyRoot();
            if (!root) {
                // root 未配置：给空结构让前端降级（LoraFileSelect 纯文件名显示）
                return res.json({ status: 'ok', pinned: [], triggers: {}, notes: {}, civitai: {} });
            }
            const lorasDir = path.join(root, 'models', 'loras');
            const { loras } = await scanLoras(lorasDir);
            await ensureSidecarRenamed(lorasDir, loras);   // 旧命名先收编
            await ensureMigrated(lorasDir);                // 中央 meta 再并入（填收编后的空字段）
            const pinned = [], triggers = {}, notes = {}, civitai = {};
            for (const lora of loras) {
                const d = await readSidecar(path.join(lorasDir, lora.path));
                if (d.pinned) pinned.push(lora.path);
                if (d.triggers) triggers[lora.path] = d.triggers;
                if (d.note) notes[lora.path] = d.note;
                if (d.civitai) {
                    const { description, ...small } = d.civitai;   // 大字段不进列表载荷
                    civitai[lora.path] = small;
                }
            }
            res.json({ status: 'ok', pinned, triggers, notes, civitai });
        } catch (err) {
            fail(res, err);
        }
    });

    router.post('/pins', async (req, res) => {
        try {
            const root = getComfyRoot();
            if (!root) return res.status(400).json({ status: 'error', message: '尚未配置 ComfyUI 根目录' });
            const { path: rel, pinned } = req.body || {};
            if (typeof rel !== 'string' || !rel) {
                return res.status(400).json({ status: 'error', message: '缺少 path' });
            }
            const lorasDir = path.join(root, 'models', 'loras');
            await ensureMigrated(lorasDir);
            const abs = safeResolve(lorasDir, rel);
            if (!abs) return res.status(403).json({ status: 'error', message: '路径越界' });
            const d = await readSidecar(abs);
            d.pinned = !!pinned;
            await writeSidecar(abs, d);
            res.json({ status: 'ok', pinned: !!pinned });
        } catch (err) {
            fail(res, err);
        }
    });

    // ==================== POST /trigger 与 /note：文本元数据读写 ====================
    // { path, text }：text 非空保存、空串删除该条记录。
    // trigger → sidecar.triggers（触发词）；note → sidecar.note（备注）
    for (const [route, field] of [['trigger', 'triggers'], ['note', 'note']]) {
        router.post('/' + route, async (req, res) => {
            try {
                const root = getComfyRoot();
                if (!root) return res.status(400).json({ status: 'error', message: '尚未配置 ComfyUI 根目录' });
                const { path: rel, text } = req.body || {};
                if (typeof rel !== 'string' || !rel) {
                    return res.status(400).json({ status: 'error', message: '缺少 path' });
                }
                if (typeof text !== 'string') {
                    return res.status(400).json({ status: 'error', message: '缺少 text' });
                }
                const lorasDir = path.join(root, 'models', 'loras');
                await ensureMigrated(lorasDir);
                const abs = safeResolve(lorasDir, rel);
                if (!abs) return res.status(403).json({ status: 'error', message: '路径越界' });
                const d = await readSidecar(abs);
                const trimmed = text.trim();
                if (trimmed) d[field] = trimmed;
                else d[field] = undefined;   // 空串清除该条
                await writeSidecar(abs, d);
                res.json({ status: 'ok', text: trimmed });
            } catch (err) {
                fail(res, err);
            }
        });
    }

    // ==================== Civitai 一键获取（封面 + 触发词） ====================
    // 参考 ComfyUI-Lora-Manager 插件：以文件 SHA256 为身份查
    // civitai.red /model-versions/by-hash 拿版本数据。触发词与拉取记录写
    // sidecar <同名>.json，封面写 sidecar <同名>.preview.<ext>（现有
    // /preview 读取链零改动）。

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

        // 3) 触发词（trainedWords 数组 join；冲突按策略处理）——写 sidecar
        await ensureMigrated(lorasDir);
        const d = await readSidecar(abs);
        const prev = d.civitai || {};
        const words = (Array.isArray(version.trainedWords) ? version.trainedWords : [])
            .filter((w) => typeof w === 'string' && w.trim())
            .map((w) => w.trim());
        const fetchedTriggers = words.join(', ');
        let triggersUpdated = false;
        if (fetchedTriggers) {
            const cur = (d.triggers || '').trim();
            if (!cur) {
                d.triggers = fetchedTriggers;
                triggersUpdated = true;
            } else if (onConflict === 'overwrite') {
                d.triggers = fetchedTriggers;
                triggersUpdated = true;
            } else if (onConflict === 'merge') {
                const merged = mergeTriggerText(cur, fetchedTriggers);
                if (merged !== cur) {
                    d.triggers = merged;
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

        // 5) 记录拉取结果（元信息备查 + coverFetched 标记供下次判自定义封面），
        //    写 sidecar JSON 落盘
        d.civitai = {
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
        await writeSidecar(abs, d);

        return {
            status: 'ok',
            sha256: sha,
            triggersUpdated,
            triggers: d.triggers || '',
            coverUpdated,
            coverSkipped,
            coverError,
            info: d.civitai
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
                // 跳过已获取过的（sidecar.civitai 有 fetchedAt 记录）
                if (options.skipFetched) {
                    const abs = safeResolve(lorasDir, lora.path);
                    const d = abs ? await readSidecar(abs) : null;
                    if (d && d.civitai && d.civitai.fetchedAt) {
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

    // GET /civitai/info：单条全量 C 站拉取记录（sidecar.civitai，含
    // description 大字段——/pins 聚合载荷不带它，信息窗打开时按需取）
    router.get('/civitai/info', async (req, res) => {
        try {
            const rel = String(req.query.path || '');
            const root = getComfyRoot();
            if (!root || !rel) {
                return res.status(400).json({ status: 'error', message: '缺少 path 或未配置 ComfyUI 根目录' });
            }
            const lorasDir = path.join(root, 'models', 'loras');
            await ensureMigrated(lorasDir);
            const abs = safeResolve(lorasDir, rel);
            if (!abs) return res.status(403).json({ status: 'error', message: '路径越界' });
            const d = await readSidecar(abs);
            if (!d.civitai) return res.json({ status: 'empty' });   // 未获取过：信息窗显示占位
            res.json({ status: 'ok', info: d.civitai });
        } catch (err) {
            fail(res, err);
        }
    });

    // GET /civitai/hash：取单个 lora 的本地 SHA256（带缓存，按需计算）
    // + C 站记录哈希（sidecar.civitai 有拉取记录时），match 供前端做比对标记
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
            await ensureMigrated(lorasDir);
            const d = await readSidecar(abs);
            const recorded = ((d.civitai && d.civitai.sha256) || '').toLowerCase();
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

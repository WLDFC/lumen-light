/**
 * ==========================================================================
 * LumenLight 漫画项目路由（ADR 071）
 * 作用：漫画编辑器的多项目管理——一本漫画 = data/manga/ 下一个独立文件夹，
 *       生成图与素材全部落在本项目文件夹内（交付独立：编辑器产物不再
 *       逐层落画布，画布只在显式导出时收到整页合成图）。
 * 目录布局：
 *   data/manga/
 *     m-20261107-a3f2/        项目 id = ASCII（m-日期-随机串），漫画名在
 *      │  project.json        元数据里（中文名不做文件夹名——路径/URL 编码坑）
 *      │    { id, name, createdAt, updatedAt, cover }
 *      ├─ draft.json          { draft, savedAt }（结构同 manga-draft.json）
 *      └─ images/             生图与素材（ASCII 文件名，原名进元数据）
 * 接口一览（挂载 /api/manga-projects）：
 *   GET    /                    项目列表（惰性迁移：旧全局 manga-draft.json
 *                               首次访问时迁为「默认漫画」项目，原文件保留不删）
 *   POST   /                    新建项目 { name }
 *   GET    /:id                 读项目（project + draft，draft 不存在为 null）
 *   PUT    /:id                 改名 { name }
 *   DELETE /:id                 删除项目（整文件夹递归删除——调用方必须先确认）
 *   PUT    /:id/draft           保存草稿 { draft }（形状校验同 mangaDraft）
 *   POST   /:id/images          转存图片 { dataUrl } 或 { url } → images/，
 *                               返回 { path }（项目内静态路径，图层 src 直用）
 *   GET    /:id/images/:file    取图片（路径白名单校验，防目录穿越）
 *   POST   /export-zip          页面合成图打包下载（ADR 079，编辑器「导出
 *                               本项目到本地」消费）：{ name, files:
 *                               [{name, dataUrl}] }——前端逐页渲染 PNG 后
 *                               base64 上传，后端落临时目录、archiver 流式
 *                               打包直出 attachment，响应结束即清理临时目录
 * 挂载方式：server.js 中以 DATA_DIR 创建并挂载到 /api/manga-projects。
 * ==========================================================================
 */

const express = require('express');
const fs = require('fs').promises;
const fss = require('fs');
const path = require('path');
const os = require('os');
const archiver = require('archiver');

/** 项目 id 白名单：m-日期-随机串（ASCII，防目录穿越） */
const ID_RE = /^m-\d{8}-[0-9a-z]{4,8}$/;
/** 图片文件名白名单 */
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;   // 单图上限 30MB

/** 单页草稿的最小形状校验（与 routes/mangaDraft.js 同口径，宽松） */
function isValidPageShape(draft) {
    return !!draft
        && typeof draft === 'object'
        && !Array.isArray(draft)
        && typeof draft.width === 'number'
        && Number.isFinite(draft.width)
        && typeof draft.height === 'number'
        && Number.isFinite(draft.height)
        && !!draft.summary
        && typeof draft.summary === 'object'
        && Array.isArray(draft.items);
}

function isValidDraftShape(draft) {
    if (isValidPageShape(draft)) return true;
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return false;
    if (!Array.isArray(draft.pages) || draft.pages.length < 1 || draft.pages.length > 500) return false;
    if (!Number.isInteger(draft.active) || draft.active < 0 || draft.active >= draft.pages.length) return false;
    return draft.pages.every(isValidPageShape);
}

function newProjectId() {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const rand = Math.random().toString(36).slice(2, 6);
    return `m-${ymd}-${rand}`;
}

function createMangaProjectsRouter({ dataDir }) {
    const router = express.Router();
    const root = path.join(dataDir, 'manga');
    let migrated = false;

    const projDir = (id) => path.join(root, id);

    async function readJson(file) {
        try { return JSON.parse(await fs.readFile(file, 'utf-8')); } catch { return null; }
    }

    async function writeJson(file, obj) {
        const tmp = file + '.tmp';
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8');
        await fs.rename(tmp, file);
    }

    /**
     * 惰性迁移（每次列表访问前执行一次）：旧全局 manga-draft.json 存在且
     * 项目根为空 → 迁为「默认漫画」项目；原文件保留不删（兜底）。迁移失败
     * 不阻塞列表（如实跳过，下次再试）。
     * 再同步（补遗三）：迁移项目带 migratedFromLegacy 标记——迁移后编辑器
     * 若仍兜底在旧全局草稿上编辑过（过渡窗口），旧草稿会比项目副本新，
     * 此时把较新的旧草稿盖回迁移项目并归集资源，避免两份内容分叉丢改动
     */
    async function ensureMigration() {
        if (migrated) return;
        migrated = true;
        try {
            await fs.mkdir(root, { recursive: true });
            const entries = await fs.readdir(root);
            const legacy = await readJson(path.join(dataDir, 'manga-draft.json'));
            if (!entries.some((e) => ID_RE.test(e))) {
                if (!legacy || !isValidDraftShape(legacy.draft)) return;
                const id = newProjectId();
                const dir = projDir(id);
                await fs.mkdir(path.join(dir, 'images'), { recursive: true });
                await writeJson(path.join(dir, 'draft.json'), { draft: legacy.draft, savedAt: legacy.savedAt || Date.now() });
                await writeJson(path.join(dir, 'project.json'), {
                    id, name: '默认漫画', createdAt: Date.now(), updatedAt: Date.now(), cover: null,
                    migratedFromLegacy: true
                });
                return;
            }
            if (!legacy || !isValidDraftShape(legacy.draft)) return;   // 已有项目且旧草稿无效：无事可做
            for (const id of entries.filter((e) => ID_RE.test(e))) {
                const meta = await readJson(path.join(projDir(id), 'project.json'));
                if (!meta || !meta.migratedFromLegacy) continue;
                const store = await readJson(path.join(projDir(id), 'draft.json'));
                if ((legacy.savedAt || 0) <= ((store && store.savedAt) || 0)) break;   // 项目不落后：不分叉
                const draft = legacy.draft;
                await consolidateDraftImages(id, draft);
                const referenced = await gcProjectImages(id, draft);
                await writeJson(path.join(projDir(id), 'draft.json'), { draft, savedAt: legacy.savedAt });
                meta.cover = referenced.length ? referenced[0] : null;
                meta.updatedAt = Date.now();
                await writeJson(path.join(projDir(id), 'project.json'), meta);
                break;   // 至多一个迁移项目
            }
        } catch (err) {
            console.error('[manga-projects] 迁移旧草稿失败:', err.message);
            migrated = false;   // 下次列表再试
        }
    }

    /** 项目是否存在（id 白名单校验前置） */
    async function projectExists(id) {
        if (!ID_RE.test(id)) return false;
        try { return fss.existsSync(path.join(projDir(id), 'project.json')); } catch { return false; }
    }

    /** 下一个可用图片文件名：images/<ts>-<n>.<ext> */
    async function nextImageFile(id, ext) {
        const dir = path.join(projDir(id), 'images');
        await fs.mkdir(dir, { recursive: true });
        const ts = Date.now();
        for (let n = 1; n < 10000; n++) {
            const file = `${ts}-${n}.${ext}`;
            try {
                await fs.access(path.join(dir, file));
            } catch {
                return file;   // 不存在即可用
            }
        }
        throw new Error('图片序号耗尽');
    }

    /**
     * 资源归集（ADR 071 补遗）：把草稿里指向项目外的图片引用收进本项目
     * images/ 并改写为项目内路径——项目文件夹因此自包含（整本拷走即迁移）。
     *   - /api/assets/file/<name> → 拷 data/assets/<name>（内容寻址名，目标
     *     已存在直接复用不重复拷；源缺失如实跳过保留原引用）；
     *   - data: URL → 解码落盘（复用 30MB 上限）；
     *   - 已在本项目内 / 远端 http(s) 引用不动（远端无法拥有）。
     * 覆盖面：drawLayers 图片层 src/fromSrc + 页背景引用。幂等：归集后
     * 再次保存零拷贝直接跳过
     */
    async function consolidateDraftImages(id, draft) {
        const pages = Array.isArray(draft.pages) ? draft.pages : [draft];
        const imgDir = path.join(projDir(id), 'images');
        await fs.mkdir(imgDir, { recursive: true });
        const pull = async (src) => {
            if (typeof src !== 'string' || !src) return src;
            let s = src;
            const i = s.indexOf('/api/');
            if (i > 0) s = s.slice(i);   // 绝对地址剥 origin
            let m = /^\/api\/manga-projects\/([^/]+)\/images\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(s);
            if (m) return m[1] === id ? s : src;   // 已是本项目内引用
            m = /^\/api\/assets\/file\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(s);
            if (m) {
                const name = m[1];
                const dest = path.join(imgDir, name);
                try {
                    await fs.access(dest);
                } catch {
                    try {
                        await fs.copyFile(path.join(dataDir, 'assets', name), dest);
                    } catch {
                        return src;   // 源缺失：保留原引用
                    }
                }
                return `/api/manga-projects/${id}/images/${name}`;
            }
            if (/^data:image\/(png|jpeg|jpg|webp);base64,/.test(s)) {
                const dec = decodeDataUrl(s);
                if (!dec) return src;
                const file = await nextImageFile(id, dec.ext);
                await fs.writeFile(path.join(imgDir, file), dec.buf);
                return `/api/manga-projects/${id}/images/${file}`;
            }
            return src;
        };
        for (const page of pages) {
            if (!page || typeof page !== 'object') continue;
            for (const layer of (Array.isArray(page.drawLayers) ? page.drawLayers : [])) {
                if (!layer || !layer.image) continue;
                if (typeof layer.image.src === 'string') layer.image.src = await pull(layer.image.src);
                if (typeof layer.image.fromSrc === 'string') layer.image.fromSrc = await pull(layer.image.fromSrc);
            }
            if (typeof page.background === 'string') page.background = await pull(page.background);
            else if (page.background && typeof page.background.src === 'string') {
                page.background.src = await pull(page.background.src);
            }
        }
        return draft;
    }

    /** dataUrl → { buf, ext }；仅收常见位图 mime */
    function decodeDataUrl(dataUrl) {
        const m = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/.exec(String(dataUrl || ''));
        if (!m) return null;
        const buf = Buffer.from(m[2], 'base64');
        if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
        return { buf, ext: m[1] === 'jpeg' ? 'jpg' : m[1] };
    }

    /**
     * 项目图垃圾回收（ADR 071 补遗二）：以整本文档（全部页）为引用基准，
     * images/ 根下不被引用的文件移入 images/.trash/（回收站，保留 7 天后
     * 真删）——删页/删层后本地孤儿图随自动保存清出项目夹，但撤销删页的
     * 窗口期内图片仍可达（GET 回退 .trash）且重新保存自动归位。只动
     * FILE_RE 白名单内的图片文件。返回按草稿顺序的引用文件名（封面跟随
     * 由此推导，不再独立钉住文件）
     */
    async function gcProjectImages(id, draft) {
        const imgDir = path.join(projDir(id), 'images');
        const trashDir = path.join(imgDir, '.trash');
        const referenced = [];
        const seen = new Set();
        const note = (src) => {
            if (typeof src !== 'string') return;
            const m = new RegExp('^/api/manga-projects/' + id + '/images/([A-Za-z0-9][A-Za-z0-9._-]*)$').exec(src);
            if (m && !seen.has(m[1])) { seen.add(m[1]); referenced.push(m[1]); }
        };
        const pages = Array.isArray(draft.pages) ? draft.pages : [draft];
        for (const page of pages) {
            if (!page || typeof page !== 'object') continue;
            for (const layer of (Array.isArray(page.drawLayers) ? page.drawLayers : [])) {
                if (!layer || !layer.image) continue;
                note(layer.image.src);
                note(layer.image.fromSrc);
            }
            if (typeof page.background === 'string') note(page.background);
            else if (page.background && typeof page.background.src === 'string') note(page.background.src);
        }
        await fs.mkdir(trashDir, { recursive: true });
        // 引用中的文件若已躺在回收站（删页后撤销的场景）：先归位
        const inTrash = new Set(await fs.readdir(trashDir).catch(() => []));
        for (const f of referenced) {
            if (inTrash.has(f)) {
                await fs.rename(path.join(trashDir, f), path.join(imgDir, f)).catch(() => {});
            }
        }
        // 根下不被引用的文件 → 回收站
        const files = await fs.readdir(imgDir).catch(() => []);
        const now = Date.now();
        for (const f of files) {
            if (f === '.trash' || !FILE_RE.test(f) || seen.has(f)) continue;
            let dest = path.join(trashDir, f);
            try {
                await fs.access(dest);
                dest = path.join(trashDir, `${now}-${f}`);
            } catch { /* 目标名可用 */ }
            await fs.rename(path.join(imgDir, f), dest).catch(() => {});
        }
        // 清理过期回收站（7 天）
        const trash = await fs.readdir(trashDir).catch(() => []);
        for (const f of trash) {
            const st = await fs.stat(path.join(trashDir, f)).catch(() => null);
            if (st && now - st.mtimeMs > 7 * 24 * 3600 * 1000) {
                await fs.rm(path.join(trashDir, f), { force: true }).catch(() => {});
            }
        }
        return referenced;
    }

    // ---- 列表（含惰性迁移） ----
    router.get('/', async (req, res) => {
        try {
            await ensureMigration();
            const entries = await fs.readdir(root).catch(() => []);
            const list = [];
            for (const id of entries) {
                if (!ID_RE.test(id)) continue;
                const meta = await readJson(path.join(projDir(id), 'project.json'));
                if (!meta || meta.id !== id) continue;
                const store = await readJson(path.join(projDir(id), 'draft.json'));
                const draft = store && store.draft;
                const pages = draft ? (Array.isArray(draft.pages) ? draft.pages.length : 1) : 0;
                list.push({
                    id, name: meta.name || id, cover: meta.cover || null,
                    createdAt: meta.createdAt || 0, updatedAt: meta.updatedAt || 0, pages
                });
            }
            list.sort((a, b) => b.updatedAt - a.updatedAt);
            res.json({ status: 'ok', projects: list });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    // ---- 新建 ----
    router.post('/', async (req, res) => {
        try {
            const name = String((req.body || {}).name || '').trim().slice(0, 50);
            if (!name) return res.status(400).json({ status: 'error', message: '项目名不能为空' });
            const id = newProjectId();
            const dir = projDir(id);
            await fs.mkdir(path.join(dir, 'images'), { recursive: true });
            const now = Date.now();
            await writeJson(path.join(dir, 'draft.json'), { draft: null, savedAt: 0 });
            await writeJson(path.join(dir, 'project.json'), { id, name, createdAt: now, updatedAt: now, cover: null });
            res.json({ status: 'ok', project: { id, name, cover: null, createdAt: now, updatedAt: now, pages: 0 } });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    // ---- 读项目（project + draft） ----
    router.get('/:id', async (req, res) => {
        try {
            const { id } = req.params;
            if (!(await projectExists(id))) return res.status(404).json({ status: 'error', message: '项目不存在' });
            const meta = await readJson(path.join(projDir(id), 'project.json'));
            const store = await readJson(path.join(projDir(id), 'draft.json'));
            res.json({ status: 'ok', project: meta, draft: store && isValidDraftShape(store.draft) ? store.draft : null });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    // ---- 改名 ----
    router.put('/:id', async (req, res) => {
        try {
            const { id } = req.params;
            if (!(await projectExists(id))) return res.status(404).json({ status: 'error', message: '项目不存在' });
            const name = String((req.body || {}).name || '').trim().slice(0, 50);
            if (!name) return res.status(400).json({ status: 'error', message: '项目名不能为空' });
            const meta = await readJson(path.join(projDir(id), 'project.json'));
            meta.name = name;
            meta.updatedAt = Date.now();
            await writeJson(path.join(projDir(id), 'project.json'), meta);
            res.json({ status: 'ok' });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    // ---- 删除（整文件夹递归——调用方必须先向用户确认） ----
    router.delete('/:id', async (req, res) => {
        try {
            const { id } = req.params;
            if (!ID_RE.test(id)) return res.status(400).json({ status: 'error', message: '项目 id 不合法' });
            const dir = projDir(id);
            if (!fss.existsSync(path.join(dir, 'project.json'))) {
                return res.status(404).json({ status: 'error', message: '项目不存在' });
            }
            await fs.rm(dir, { recursive: true, force: true });
            res.json({ status: 'ok' });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    // ---- 保存草稿（结构同 mangaDraft PUT） ----
    router.put('/:id/draft', async (req, res) => {
        try {
            const { id } = req.params;
            if (!(await projectExists(id))) return res.status(404).json({ status: 'error', message: '项目不存在' });
            const { draft } = req.body || {};
            if (!isValidDraftShape(draft)) {
                return res.status(400).json({ status: 'error', message: '草稿格式不合法' });
            }
            await consolidateDraftImages(id, draft);   // 资源归集：外部图片引用收进项目夹
            const referenced = await gcProjectImages(id, draft);   // 孤儿图回收（删页/删层后自动清，封面跟随推导）
            const savedAt = Date.now();
            await writeJson(path.join(projDir(id), 'draft.json'), { draft, savedAt });
            // 元数据 updatedAt 跟进（列表按最近使用排序）；封面跟随草稿首图
            // （不独立钉住文件——否则删层后孤儿图永远回收不掉）
            const meta = await readJson(path.join(projDir(id), 'project.json'));
            if (meta) {
                meta.updatedAt = savedAt;
                meta.cover = referenced.length ? referenced[0] : null;
                await writeJson(path.join(projDir(id), 'project.json'), meta);
            }
            res.json({ status: 'ok', savedAt });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    // ---- 转存图片（dataUrl 直存 / url 拉取转存） ----
    router.post('/:id/images', express.json({ limit: MAX_IMAGE_BYTES + 1024 * 512 }), async (req, res) => {
        try {
            const { id } = req.params;
            if (!(await projectExists(id))) return res.status(404).json({ status: 'error', message: '项目不存在' });
            const body = req.body || {};
            let buf = null, ext = 'png';
            if (body.dataUrl) {
                const dec = decodeDataUrl(body.dataUrl);
                if (!dec) return res.status(400).json({ status: 'error', message: 'dataUrl 不合法或超出 30MB' });
                buf = dec.buf; ext = dec.ext;
            } else if (body.url) {
                const u = String(body.url);
                let payload = null;
                if (u.startsWith('/api/assets/') || u.startsWith('/api/manga-projects/')) {
                    // 本地资源：直接读盘（同源代理回环绕开）
                    const local = path.join(dataDir, path.normalize(u.replace(/^\/api\//, '')).replace(/^(\.\.[/\\])+/, ''));
                    if (!local.startsWith(path.join(dataDir, 'assets')) && !local.startsWith(root)) {
                        return res.status(400).json({ status: 'error', message: '本地路径不合法' });
                    }
                    payload = await fs.readFile(local);
                } else if (/^https?:\/\//.test(u)) {
                    const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
                    if (!r.ok) throw new Error(`拉取失败 HTTP ${r.status}`);
                    payload = Buffer.from(await r.arrayBuffer());
                } else {
                    return res.status(400).json({ status: 'error', message: 'url 仅支持本站路径或 http(s)' });
                }
                if (!payload || !payload.length || payload.length > MAX_IMAGE_BYTES) {
                    return res.status(400).json({ status: 'error', message: '图片为空或超出 30MB' });
                }
                buf = payload;
                ext = (/\.jpe?g($|\?)/.test(u) ? 'jpg' : /\.webp($|\?)/.test(u) ? 'webp' : 'png');
            } else {
                return res.status(400).json({ status: 'error', message: '需要 dataUrl 或 url' });
            }
            const file = await nextImageFile(id, ext);
            await fs.writeFile(path.join(projDir(id), 'images', file), buf);
            // 封面缺省取首图
            const meta = await readJson(path.join(projDir(id), 'project.json'));
            if (meta && !meta.cover) { meta.cover = file; await writeJson(path.join(projDir(id), 'project.json'), meta); }
            res.json({ status: 'ok', file, path: `/api/manga-projects/${id}/images/${file}` });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    // ---- 取图片（静态服务，白名单防穿越；根下没有回退 .trash 回收站——
    //      删页后撤销的窗口期内图片仍可加载） ----
    router.get('/:id/images/:file', async (req, res) => {
        const { id, file } = req.params;
        if (!ID_RE.test(id) || !FILE_RE.test(file)) return res.status(400).end();
        // 根下优先，没有回退 .trash 回收站（删页后撤销的窗口期内图片仍可
        // 加载）——先探测后发送，避开 sendFile 错误回调里二次 sendFile 的
        // 响应状态坑
        const candidates = [
            path.join(projDir(id), 'images', file),
            path.join(projDir(id), 'images', '.trash', file)
        ].filter((p) => p.startsWith(path.join(root, id)));
        for (const p of candidates) {
            // dotfiles:'allow'——.trash 是点目录，send 默认 ignore 会无视
            // 存在的文件直接 404
            if (fss.existsSync(p)) {
                return res.sendFile(p, { dotfiles: 'allow' }, (err) => {
                    if (err && !res.headersSent) res.status(404).end();
                });
            }
        }
        res.status(404).end();
    });

    // 页面合成图打包下载（ADR 079「导出本项目到本地」）：
    // 前端逐页渲染 PNG（_composePageCanvas 所见即所得合成）→ base64 上传 →
    // 这里解码落临时目录、archiver 逐文件流式打包直出（不在内存拼整包）。
    // 与项目 id 无关（默认草稿也能导），name 只做 zip 文件名
    router.post('/export-zip', async (req, res) => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manga-export-'));
        res.on('close', () => {   // 正常结束/客户端中断都清理临时目录
            fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        });
        try {
            const { name, files } = req.body || {};
            if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
                return res.status(400).json({ status: 'error', message: 'zip 名须为 1~100 字字符串' });
            }
            if (!Array.isArray(files) || files.length < 1 || files.length > 500) {
                return res.status(400).json({ status: 'error', message: 'files 须为 1~500 个页面 PNG 的数组' });
            }
            // 逐个校验并落临时文件（坏条目直接 400 拒绝整包，不静默跳过）
            const entries = [];
            const usedNames = new Set();
            for (const f of files) {
                const raw = f && typeof f.name === 'string' ? f.name : '';
                let base = raw.replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/^\.+/, '').trim().slice(0, 80) || 'page.png';
                if (!base.toLowerCase().endsWith('.png')) base += '.png';
                while (usedNames.has(base)) base = base.replace(/(\.png)$/i, '(2)$1');
                const du = f && typeof f.dataUrl === 'string' ? f.dataUrl : '';
                const m = /^data:image\/png;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(du);
                if (!m) {
                    return res.status(400).json({ status: 'error', message: `「${base}」不是 PNG data URL` });
                }
                const buf = Buffer.from(m[1], 'base64');
                if (!buf.length || buf.length > MAX_IMAGE_BYTES) {
                    return res.status(400).json({ status: 'error', message: `「${base}」超出单图大小上限` });
                }
                const file = path.join(tmpDir, `${String(entries.length).padStart(3, '0')}.png`);
                await fs.writeFile(file, buf);
                usedNames.add(base);
                entries.push({ file, name: base });
            }
            // 流式打包直出（backup.js 同款；文件名中文走 RFC 5987 filename*）
            const safeName = String(name).replace(/[\\/:*?"<>|\r\n]+/g, '_').trim() || '漫画';
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition',
                `attachment; filename="pages.zip"; filename*=UTF-8''${encodeURIComponent(safeName)}.zip`);
            const archive = archiver('zip', { zlib: { level: 6 } });
            archive.on('warning', (e) => console.warn('页面导出打包 warning:', e.message));
            archive.on('error', (e) => {
                console.error('页面导出打包失败:', e);
                if (!res.headersSent) res.status(500).json({ status: 'error', message: e.message });
                else res.destroy();
            });
            archive.pipe(res);
            for (const en of entries) archive.file(en.file, { name: en.name });
            await archive.finalize();
        } catch (error) {
            if (!res.headersSent) res.status(500).json({ status: 'error', message: error.message });
            else res.destroy();
        }
    });

    return router;
}

module.exports = createMangaProjectsRouter;

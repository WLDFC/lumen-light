/**
 * 提示词收藏路由（tag 目录）
 *
 * 作用：提供图片提示词收藏的增删查接口，供前端"提示词"页面与画布工具栏的"保存提示词"按钮调用。
 *
 * 数据落盘结构（首次保存时自动创建）：
 *   tag/
 *   ├── tags.json       # 收藏元数据列表（提示词、图片尺寸、来源、可选生成参数
 *   │                   #   记录 genInfo 等）——唯一真相源
 *   ├── images/         # 原图（WebP，质量 95，按内容哈希命名）+ 同名 .txt 提示词
 *   │                   #   sidecar（标题/模型/时间头 + 正/负面提示词 + 生成参数
 *   │                   #   节——genInfo 有记录才有）——单向导出的检索视图：应用
 *   │                   #   只写不读，外部改动不回灌；旧数据首次 GET 时幂等补齐，
 *   │                   #   删除收藏连带删除
 *   └── thumbnails/     # 缩略图（WebP，480×480，质量 82）
 *
 * 接口一览：
 *   GET    /                       # 读取全部收藏列表（首次调用顺带为旧数据补齐 sidecar）
 *   POST   /                       # 保存一张图片及其提示词（按图片内容哈希去重）
 *   PUT    /:id                    # 更新收藏的名字 / 模型标签 / 提示词
 *   DELETE /:id                    # 删除指定收藏，并同步删除原图/缩略图/参考图文件
 *   POST   /reveal                 # 资源管理器打开收藏图片所在文件夹并选中文件（入参 { id }）
 *   GET    /models                 # 读取全部模型标签（预置 anima / gpt image / flux2 klein / krea2；
 *                                  #   记录含可选 parentId——树形层级，最多 3 级）
 *   POST   /models                 # 新建模型标签（{ name, parentId? }：parentId 可选，
 *                                  #   传了就挂为其子标签，父级已 3 级时拒绝；
 *                                  #   按名字去重，大小写不敏感，全表唯一）
 *   DELETE /models/:id             # 删除模型标签（只删标签本身，不级联——子标签
 *                                  #   上移一级挂到被删标签的原父级下；
 *                                  #   不影响已有收藏的 model 字段）
 *   POST   /:id/references         # 为收藏添加参考图（上限 5 张，存 tag/references/）
 *   DELETE /:id/references/:index  # 删除收藏的第 index 张参考图（含磁盘文件）
 *
 * 挂载方式：在 server.js 中以 TAGS_DIR（tag/）目录创建并挂载到 /api/tags，
 * 静态目录 /tag 用于对外提供图片访问。
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { exec, execFile } = require('child_process');

/**
 * 创建提示词收藏路由
 * @param {object} options
 * @param {string} options.tagsDir - 收藏数据根目录（项目下的 tag/ 文件夹）
 * @returns {express.Router}
 */
function createTagsRouter({ tagsDir }) {
    const router = express.Router();
    const metadataFile = path.join(tagsDir, 'tags.json');    // 元数据文件路径
    const imagesDir = path.join(tagsDir, 'images');          // 原图存放目录
    const thumbnailsDir = path.join(tagsDir, 'thumbnails');  // 缩略图存放目录
    const referencesDir = path.join(tagsDir, 'references');  // 参考图存放目录

    // ===== 提示词 sidecar（tag/images/<图片名>.txt，与原图同文件夹同名） =====
    // 定位是「单向导出的检索视图」：应用只写不读，tags.json 仍是唯一真相源，
    // 外部手工改动不回灌；文件丢失无碍应用，该条目下次被保存/编辑时重新生成。
    const SIDECAR_EXT = '.txt';
    let sidecarsSeeded = false;   // 旧数据补齐每进程只跑一次（首次 GET / 触发）

    /** 时间戳 → 「YYYY-MM-DD HH:mm:ss」本地时间文本（sidecar 头部用） */
    function formatSidecarTime(ts) {
        const d = new Date(ts || 0);
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }

    /**
     * 收藏条目的 sidecar 文件名（与原图同名只换扩展名）；imageHash 缺失时
     * 从 imageUrl 兜底推导（旧数据），两者都无返回 null 由调用方跳过
     */
    function sidecarNameOf(tag) {
        const base = tag.imageHash
            || path.basename(tag.imageUrl || '').replace(/\.webp$/i, '');
        return base ? `${base}${SIDECAR_EXT}` : null;
    }

    /**
     * 净化客户端提交的生成参数记录（genInfo，画布「生成同款」数据层）：
     * 白名单字段 + 类型钳制 + 截断——tags.json 是唯一真相源，坏载荷不得
     * 污染；非对象/缺 mode 等无效输入返回 null（条目不写字段，行为同旧数据）
     */
    function sanitizeGenInfo(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        if (!['comfy', 'api', 'rh'].includes(raw.mode)) return null;
        const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');
        const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        const info = {
            mode: raw.mode,
            time: num(raw.time),
            sourceNodeId: str(raw.sourceNodeId, 64) || null,
            sourceNodeTitle: str(raw.sourceNodeTitle, 120),
            workflowId: str(raw.workflowId, 200),
            workflowName: str(raw.workflowName, 200),
            positive: str(raw.positive),
            negative: str(raw.negative),
            model: str(raw.model, 300),
            provider: str(raw.provider, 120),
            size: str(raw.size, 32) || null,
            quality: str(raw.quality, 32),
            ratio: str(raw.ratio, 32),
            tier: str(raw.tier, 32),
            refCount: num(raw.refCount) || 0,
            resourceKind: str(raw.resourceKind, 32),
            resourceId: str(raw.resourceId, 120),
            resourceName: str(raw.resourceName, 200),
            instanceType: str(raw.instanceType, 64),
            params: null,
            loras: null,
            paramList: null
        };
        if (raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)) {
            const p = raw.params;
            info.params = {
                steps: num(p.steps),
                cfg: num(p.cfg),
                sampler: str(p.sampler, 120) || null,
                sizeW: num(p.sizeW),
                sizeH: num(p.sizeH),
                denoise: num(p.denoise)
            };
        }
        if (Array.isArray(raw.loras)) {
            info.loras = raw.loras
                .filter((l) => l && typeof l === 'object' && typeof l.file === 'string' && l.file)
                .slice(0, 50)
                .map((l) => ({
                    file: l.file.slice(0, 300),
                    strengthModel: num(l.strengthModel),
                    strengthClip: num(l.strengthClip)
                }));
        }
        if (Array.isArray(raw.paramList)) {
            info.paramList = raw.paramList
                .filter((p) => p && typeof p === 'object' && typeof p.label === 'string' && p.label)
                .slice(0, 50)
                .map((p) => ({
                    label: p.label.slice(0, 120),
                    value: String(p.value ?? '').slice(0, 300)
                }));
        }
        return info;
    }

    /**
     * 生成参数记录 → sidecar「生成参数」节行清单（无记录/无有效行返回空数组，
     * 调用方据此整节省略）。字段口径与前端 GenRecord.describeRows 一致：
     * 空值不占行；值内换行折叠为空格保持 txt 行结构
     */
    function describeGenInfoLines(info) {
        if (!info || typeof info !== 'object') return [];
        const lines = [];
        const push = (label, value) => {
            if (value === null || value === undefined || value === '') return;
            lines.push(`${label}: ${String(value).replace(/\r?\n+/g, ' ')}`);
        };
        const MODE_LABELS = { comfy: 'ComfyUI', api: 'API 生图', rh: 'RunningHub' };
        push('模式', MODE_LABELS[info.mode] || info.mode);
        push('生成时间', info.time ? formatSidecarTime(info.time) : null);
        if (info.mode === 'comfy') {
            push('工作流', info.workflowName || info.workflowId);
            push('主模型', info.model);
            const p = info.params || {};
            push('步数', p.steps);
            push('CFG', p.cfg);
            push('采样器', p.sampler);
            push('尺寸', p.sizeW && p.sizeH ? `${p.sizeW} × ${p.sizeH}` : null);
            push('去噪', p.denoise);
            if (Array.isArray(info.loras) && info.loras.length) {
                const text = info.loras
                    .filter((l) => l && l.file)
                    .map((l) => (l.strengthModel !== undefined && l.strengthModel !== null
                        && Number(l.strengthModel) !== 1)
                        ? `${l.file} (${Number(l.strengthModel)})`
                        : l.file)
                    .join('; ');
                if (text) lines.push(`LoRA: ${text}`);
            }
        } else if (info.mode === 'api') {
            // 下拉复合键 '厂商||模型ID'：展示取模型 ID 段（厂商段只在
            // 同名模型多中转站时才有区分意义，展示层不单列——记录里仍保留）
            const composite = String(info.model || '');
            push('模型', composite.includes('||') ? composite.split('||').pop() : composite);
            push('比例', info.ratio && info.tier ? `${info.ratio} / ${info.tier}` : info.ratio);
            push('尺寸', info.size);
            push('质量', info.quality);
            push('参考图', info.refCount ? `${info.refCount} 张` : null);
        } else if (info.mode === 'rh') {
            push('类型', info.resourceKind === 'app' ? '应用' : '工作流');
            push('资源', info.resourceName || info.resourceId);
            push('档位', info.instanceType);
            for (const p of info.paramList || []) push(p.label, p.value);
        }
        return lines;
    }

    /**
     * 写/覆盖一条收藏的提示词 sidecar。
     * 内容：标题/模型/时间三行头 + 正面提示词 + 负面提示词（空则整段省略）
     * + 生成参数节（genInfo 有记录才有——保存/编辑/补齐三写路径统一经此
     * 渲染，编辑重写不丢参数节的保障在 genInfo 随条目存在 tags.json）。
     */
    async function writePromptSidecar(tag) {
        const name = sidecarNameOf(tag);
        if (!name) return;
        const lines = [
            `标题: ${tag.name || '无题'}`,
            `模型: ${tag.model || ''}`,
            `时间: ${formatSidecarTime(tag.createdAt)}`,
            '',
            '── 正面提示词 ──',
            tag.prompt || ''
        ];
        if (tag.negativePrompt) {
            lines.push('', '── 负面提示词 ──', tag.negativePrompt);
        }
        const genLines = describeGenInfoLines(tag.genInfo);
        if (genLines.length) {
            lines.push('', '── 生成参数 ──', ...genLines);
        }
        await fs.mkdir(imagesDir, { recursive: true });
        await fs.writeFile(path.join(imagesDir, name), `${lines.join('\n')}\n`, 'utf8');
    }

    /** 旧数据补齐：为还没有 sidecar 的收藏逐条生成（幂等；单条失败不中断整批） */
    async function seedPromptSidecars(tags) {
        for (const tag of tags) {
            const name = sidecarNameOf(tag);
            if (!name) continue;
            try {
                await fs.access(path.join(imagesDir, name));
            } catch {
                try { await writePromptSidecar(tag); } catch { /* 坏条目跳过 */ }
            }
        }
    }

    /** 读取收藏列表；文件不存在时返回空数组 */
    async function readTags() {
        try {
            const data = JSON.parse(await fs.readFile(metadataFile, 'utf8'));
            return Array.isArray(data) ? data : [];
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
    }

    /** 将收藏列表写回 tags.json（必要时自动创建目录） */
    async function writeTags(tags) {
        await fs.mkdir(tagsDir, { recursive: true });
        await fs.writeFile(metadataFile, JSON.stringify(tags, null, 2), 'utf8');
    }

    /** 首次运行时预置的四个模型标签 */
    const DEFAULT_MODELS = ['anima', 'gpt image', 'flux2 klein', 'krea2'];
    const modelsFile = path.join(tagsDir, 'models.json'); // 模型标签清单存储文件

    /**
     * 读取模型标签清单；文件不存在时写入预置的四个标签并返回
     * 返回 [{ id, name, createdAt }]，保证每个标签有稳定 id 便于删除
     */
    async function readModels() {
        try {
            const data = JSON.parse(await fs.readFile(modelsFile, 'utf8'));
            return Array.isArray(data) ? data : [];
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            // 首次访问：写入预置标签，下次直接读取
            const models = DEFAULT_MODELS.map((name, index) => ({
                id: crypto.randomUUID(),
                name,
                createdAt: Date.now() + index
            }));
            await fs.mkdir(tagsDir, { recursive: true });
            await fs.writeFile(modelsFile, JSON.stringify(models, null, 2), 'utf8');
            return models;
        }
    }

    /** 将模型标签清单写回 models.json */
    async function writeModels(models) {
        await fs.mkdir(tagsDir, { recursive: true });
        await fs.writeFile(modelsFile, JSON.stringify(models, null, 2), 'utf8');
    }

    /** 按 id 查找模型标签 */
    function findModel(models, id) {
        return models.find(m => m.id === id);
    }

    /**
     * 计算模型标签层级（根 = 1，上限 3 级）。沿 parentId 上溯计数，
     * 父引用缺失或断链（父标签已被删）按已到顶端处理；visited 防脏数据
     * 成环时死循环。
     */
    function getModelDepth(models, model) {
        let depth = 1;
        let current = model;
        const visited = new Set([model.id]);
        while (current?.parentId) {
            if (visited.has(current.parentId)) break;
            const parent = findModel(models, current.parentId);
            if (!parent) break;
            visited.add(parent.id);
            current = parent;
            depth += 1;
        }
        return depth;
    }

    /**
     * 尝试把 Base64 Data URL 解码为图片 Buffer
     * @param {string} imageUrl - 图片地址（支持 png/jpeg/jpg/webp 的 Data URL）
     * @returns {Buffer|null} 非法格式返回 null
     */
    function decodeImage(imageUrl) {
        const match = String(imageUrl).match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
        if (!match) return null;
        return Buffer.from(match[2], 'base64');
    }

    /**
     * 根据图片地址获取图片 Buffer
     * 支持三种来源：Base64 Data URL、项目内相对路径、HTTP(S) 外链
     * @param {string} imageUrl - 图片地址
     * @returns {Promise<Buffer>}
     */
    async function fetchImage(imageUrl) {
        // 1) Base64 Data URL：直接解码
        const decoded = decodeImage(imageUrl);
        if (decoded) return decoded;

        // 2) 项目内相对路径（如 /save/xxx/images/a.png）：读取本地文件，并做越权路径校验
        if (!/^https?:\/\//i.test(imageUrl)) {
            const relativePath = decodeURIComponent(imageUrl.split('?')[0]).replace(/^\/+/, '');
            const absolutePath = path.resolve(process.cwd(), relativePath);
            const projectRoot = path.resolve(process.cwd());
            // 防止 ../ 之类的路径逃逸出项目根目录
            if (!absolutePath.startsWith(`${projectRoot}${path.sep}`)) {
                throw new Error('图片路径无效');
            }
            return fs.readFile(absolutePath);
        }

        // 3) HTTP(S) 外链：下载图片
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
    }

    /** GET / ：返回全部提示词收藏（首次调用顺带为旧数据补齐 sidecar） */
    router.get('/', async (req, res) => {
        try {
            const tags = await readTags();
            if (!sidecarsSeeded) {
                sidecarsSeeded = true;
                await seedPromptSidecars(tags);
            }
            res.json({ status: 'ok', tags });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    /**
     * POST / ：保存图片及提示词
     * 请求体：{ prompt, negativePrompt, imageUrl, source, name, model, genInfo? }
     *   name  - 用户在保存弹窗填写的名字（默认"无题"，可空）
     *   model - 用户选择的模型标签（anima / gpt image / flux2 klein / krea2，可空）
     *   genInfo - 生成参数记录（可选，画布「生成同款」数据层；经白名单净化，
     *     无记录/坏载荷不写字段）——存进条目（真相源）并渲染进 sidecar 参数节
     * 流程：校验入参 -> 获取图片 -> 计算内容哈希去重 -> 生成原图与缩略图 -> 写入元数据
     * 重复保存：同一图片已存在时不重复写文件，仅更新名字与模型标签（随带新
     * genInfo 时一并更新）
     */
    router.post('/', async (req, res) => {
        try {
            // 入参校验：正向提示词与图片地址必填，其余字段允许为空
            const prompt = typeof req.body.prompt === 'string' ? req.body.prompt.trim() : '';
            const negativePrompt = typeof req.body.negativePrompt === 'string' ? req.body.negativePrompt.trim() : '';
            const imageUrl = typeof req.body.imageUrl === 'string' ? req.body.imageUrl : '';
            const name = typeof req.body.name === 'string' && req.body.name.trim() ? req.body.name.trim() : '无题';
            const model = typeof req.body.model === 'string' ? req.body.model.trim() : '';
            const genInfo = sanitizeGenInfo(req.body.genInfo);
            if (!prompt || !imageUrl) {
                return res.status(400).json({ status: 'error', message: '图片和正向提示词不能为空' });
            }

            const imageBuffer = await fetchImage(imageUrl);
            const imageMetadata = await sharp(imageBuffer).metadata(); // 读取宽高等元信息
            const imageHash = crypto.createHash('sha256').update(imageBuffer).digest('hex'); // 内容哈希，用于去重与命名
            const tags = await readTags();

            // 同一张图片（内容完全一致）已收藏过：只更新名字与模型标签，不重写图片文件
            const existing = tags.find(item => item.imageHash === imageHash);
            if (existing) {
                existing.name = name;
                existing.model = model;
                if (genInfo) existing.genInfo = genInfo;   // 随带新记录就更新，旧记录保留
                await writeTags(tags);
                await writePromptSidecar(existing);   // 标题/模型可能变了，sidecar 一并重写
                return res.json({ status: 'ok', duplicated: true, tag: existing });
            }

            // 确保目录存在后再写文件
            await Promise.all([
                fs.mkdir(imagesDir, { recursive: true }),
                fs.mkdir(thumbnailsDir, { recursive: true })
            ]);

            // 原图与缩略图共用同一文件名（内容哈希），便于删除时对应清理
            const filename = `${imageHash}.webp`;
            await Promise.all([
                sharp(imageBuffer).webp({ quality: 95 }).toFile(path.join(imagesDir, filename)),
                sharp(imageBuffer).resize(480, 480, { fit: 'cover' }).webp({ quality: 82 }).toFile(path.join(thumbnailsDir, filename))
            ]);

            // 组装收藏记录：最新收藏插到列表最前面
            const tag = {
                id: crypto.randomUUID(),
                imageHash,
                name,
                model,
                prompt,
                negativePrompt,
                source: req.body.source === 'llm' ? 'llm' : 'comfy',
                // 生成参数记录（溯源/生成同款）：随条目进 tags.json（唯一真相
                // 源），sidecar 三写路径统一由条目渲染——编辑重写不丢参数节
                ...(genInfo ? { genInfo } : {}),
                width: imageMetadata.width || 0,
                height: imageMetadata.height || 0,
                imageUrl: `/tag/images/${filename}`,
                thumbnailUrl: `/tag/thumbnails/${filename}`,
                createdAt: Date.now()
            };
            tags.unshift(tag);
            await writeTags(tags);
            await writePromptSidecar(tag);   // 同名 .txt 提示词 sidecar（检索视图）
            res.json({ status: 'ok', duplicated: false, tag });
        } catch (error) {
            console.error('保存图片提示词失败:', error);
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    /**
     * PUT /:id ：更新指定收藏的元数据（名字 / 模型标签 / 正向提示词）
     * 请求体：{ name?, model?, prompt? }，只更新传入的字段
     * 仅写 tags.json，不涉及图片文件
     */
    router.put('/:id', async (req, res) => {
        try {
            const tags = await readTags();
            const tag = tags.find(tag => tag.id === req.params.id);
            if (!tag) return res.status(404).json({ status: 'error', message: '提示词收藏不存在' });

            // 逐字段校验更新：名字空值回退"无题"，模型允许清空（取消选择）
            if (typeof req.body.name === 'string') {
                tag.name = req.body.name.trim() || '无题';
            }
            if (typeof req.body.model === 'string') {
                tag.model = req.body.model.trim();
            }
            if (typeof req.body.prompt === 'string') {
                tag.prompt = req.body.prompt.trim();
            }
            tag.updatedAt = Date.now();
            await writeTags(tags);
            await writePromptSidecar(tag);   // 标题/模型/提示词可能变了，sidecar 一并重写
            res.json({ status: 'ok', tag });
        } catch (error) {
            console.error('更新提示词收藏失败:', error);
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    /**
     * POST /reveal ：在系统资源管理器中打开收藏图片所在文件夹并选中文件
     * （tag/images/<hash>.webp——同名 .txt 提示词 sidecar 就在旁边）。
     * 入参 { id }：按收藏 id 反查文件名，不接受客户端传路径，无越界面
     */
    router.post('/reveal', async (req, res) => {
        try {
            const { id } = req.body || {};
            if (typeof id !== 'string' || !id) {
                return res.status(400).json({ status: 'error', message: '缺少 id' });
            }
            const tags = await readTags();
            const tag = tags.find(t => t.id === id);
            if (!tag) return res.status(404).json({ status: 'error', message: '提示词收藏不存在' });

            // 文件名只取自 imageHash（十六进制）或 imageUrl 末段 basename——
            // 不可能含路径分隔符；引号/换行拒绝进 shell（兜底手工编辑的脏数据）
            const imageFile = tag.imageHash
                ? `${tag.imageHash}.webp`
                : path.basename(new URL(tag.imageUrl || '', 'http://localhost').pathname);
            if (!imageFile || /["\r\n]/.test(imageFile)) {
                return res.status(404).json({ status: 'error', message: '该收藏缺少有效的图片文件字段' });
            }
            const imagePath = path.join(imagesDir, imageFile);
            if (!imagePath.startsWith(`${imagesDir}${path.sep}`)) {
                return res.status(403).json({ status: 'error', message: '路径越界' });
            }
            try {
                await fs.access(imagePath);
            } catch {
                return res.status(404).json({ status: 'error', message: '图片文件不存在' });
            }

            if (process.platform === 'win32') {
                // explorer 的退出码恒为 1（非失败语义），忽略错误回调
                exec(`explorer /select,"${imagePath}"`, () => {});
            } else {
                execFile('xdg-open', [path.dirname(imagePath)], () => {});
            }
            res.json({ status: 'ok', fullPath: imagePath });
        } catch (error) {
            console.error('打开所在文件夹失败:', error);
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    /**
     * ===== 模型标签管理接口（左侧栏 / 保存弹窗共用） =====
     * 数据存于 tag/models.json，与收藏记录（tags.json）解耦：
     * 删除标签不影响已有收藏的 model 字段（卡片角标照常显示）。
     */

    /** GET /models ：返回全部模型标签 */
    router.get('/models', async (req, res) => {
        try {
            res.json({ status: 'ok', models: await readModels() });
        } catch (error) {
            console.error('读取模型标签失败:', error);
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    /**
     * POST /models ：新建模型标签
     * 请求体：{ name, parentId? }；parentId 传了就挂为该标签的子标签，
     * 最多 3 级（父级已是 3 级时拒绝）；重名时返回 409（按名字去重，
     * 大小写不敏感，全表唯一——收藏记录按名字引用标签，不分区级）
     */
    router.post('/models', async (req, res) => {
        try {
            const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
            if (!name) return res.status(400).json({ status: 'error', message: '标签名字不能为空' });
            if (name.length > 40) return res.status(400).json({ status: 'error', message: '标签名字过长（最多 40 字）' });

            const models = await readModels();

            // 可选父标签：存在性 + 层级校验（子标签深度 = 父深度 + 1，上限 3）
            const parentId = typeof req.body.parentId === 'string' && req.body.parentId ? req.body.parentId : null;
            let parent = null;
            if (parentId) {
                parent = findModel(models, parentId);
                if (!parent) return res.status(404).json({ status: 'error', message: '父标签不存在' });
                if (getModelDepth(models, parent) >= 3) {
                    return res.status(400).json({ status: 'error', message: '子标签最多 3 级，无法继续往下建' });
                }
            }

            if (models.some(m => m.name.toLowerCase() === name.toLowerCase())) {
                return res.status(409).json({ status: 'error', message: '同名标签已存在' });
            }

            const model = { id: crypto.randomUUID(), name, createdAt: Date.now() };
            if (parent) model.parentId = parent.id;
            models.push(model); // 新标签追加到末尾，与左侧栏新建的视觉顺序一致
            await writeModels(models);
            res.json({ status: 'ok', model });
        } catch (error) {
            console.error('新建模型标签失败:', error);
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    /**
     * DELETE /models/:id ：删除模型标签（只删标签本身，不级联删除——
     * 其子标签上移一级挂到被删标签的原父级下，父级为根则升为顶层，
     * 避免误删整棵子树）；已有收藏的 model 字段保持不变，卡片角标照常显示
     */
    router.delete('/models/:id', async (req, res) => {
        try {
            const models = await readModels();
            const index = models.findIndex(m => m.id === req.params.id);
            if (index === -1) return res.status(404).json({ status: 'error', message: '模型标签不存在' });

            const [removed] = models.splice(index, 1);
            for (const model of models) {
                if (model.parentId === removed.id) {
                    if (removed.parentId) model.parentId = removed.parentId;
                    else delete model.parentId;
                }
            }
            await writeModels(models);
            res.json({ status: 'ok' });
        } catch (error) {
            console.error('删除模型标签失败:', error);
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    /**
     * ===== 参考图管理接口（详情弹窗参考图槽位使用） =====
     * 参考图存于 tag/references/，以内容哈希命名（webp），
     * 记录字段 tag.referenceImages 保存 URL 数组，上限 5 张。
     */

    /**
     * POST /:id/references ：为指定收藏添加一张参考图
     * 请求体：{ imageUrl }，来源支持 Base64 Data URL / 本站路径 / HTTP 外链
     * 选完立即上传（前端约定），成功后返回更新后的完整 tag
     */
    router.post('/:id/references', async (req, res) => {
        try {
            const imageUrl = typeof req.body.imageUrl === 'string' ? req.body.imageUrl : '';
            if (!imageUrl) return res.status(400).json({ status: 'error', message: '参考图地址不能为空' });

            const tags = await readTags();
            const tag = tags.find(tag => tag.id === req.params.id);
            if (!tag) return res.status(404).json({ status: 'error', message: '提示词收藏不存在' });
            if ((tag.referenceImages || []).length >= 5) {
                return res.status(409).json({ status: 'error', message: '参考图最多 5 张' });
            }

            const imageBuffer = await fetchImage(imageUrl);
            const imageHash = crypto.createHash('sha256').update(imageBuffer).digest('hex');
            const filename = `${imageHash}.webp`;

            // 同一内容的参考图已存在则跳过写盘，仍计入列表（保持简单，不做去重拦截）
            await fs.mkdir(referencesDir, { recursive: true });
            const referencePath = path.join(referencesDir, filename);
            try {
                await fs.access(referencePath);
            } catch {
                await sharp(imageBuffer).webp({ quality: 95 }).toFile(referencePath);
            }

            tag.referenceImages = tag.referenceImages || [];
            tag.referenceImages.push(`/tag/references/${filename}`);
            tag.updatedAt = Date.now();
            await writeTags(tags);
            res.json({ status: 'ok', tag });
        } catch (error) {
            console.error('添加参考图失败:', error);
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    /**
     * DELETE /:id/references/:index ：删除指定位置的参考图
     * 同步删除磁盘文件；若该文件还被其他收藏引用（内容哈希同名）则保留
     */
    router.delete('/:id/references/:index', async (req, res) => {
        try {
            const index = parseInt(req.params.index, 10);
            const tags = await readTags();
            const tag = tags.find(tag => tag.id === req.params.id);
            if (!tag) return res.status(404).json({ status: 'error', message: '提示词收藏不存在' });
            if (!Array.isArray(tag.referenceImages) || index < 0 || index >= tag.referenceImages.length) {
                return res.status(404).json({ status: 'error', message: '参考图不存在' });
            }

            const [url] = tag.referenceImages.splice(index, 1);
            // 内容哈希命名的文件可能被其他收藏共用，确认无人引用后再删
            const stillUsed = tags.some(t => (t.referenceImages || []).includes(url));
            const removeFile = stillUsed ? Promise.resolve()
                : fs.rm(path.join(referencesDir, path.basename(url)), { force: true });

            tag.updatedAt = Date.now();
            await Promise.all([removeFile, writeTags(tags)]);
            res.json({ status: 'ok', tag });
        } catch (error) {
            console.error('删除参考图失败:', error);
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    /**
     * DELETE /:id ：删除指定收藏
     * 同步删除：tags.json 记录、原图文件、缩略图文件、参考图文件
     */
    router.delete('/:id', async (req, res) => {
        try {
            const tags = await readTags();
            const index = tags.findIndex(tag => tag.id === req.params.id);
            if (index === -1) return res.status(404).json({ status: 'error', message: '提示词收藏不存在' });

            // 从记录中取出待删除项，并从 URL 中提取文件名（防注入，只取最后一段）
            const [tag] = tags.splice(index, 1);
            const imageFilename = path.basename(new URL(tag.imageUrl, 'http://localhost').pathname);
            const thumbnailFilename = path.basename(new URL(tag.thumbnailUrl, 'http://localhost').pathname);

            // 参考图文件：仅当没有其他收藏引用同名文件时才删除
            const referenceRemovals = (tag.referenceImages || [])
                .filter(url => !tags.some(t => (t.referenceImages || []).includes(url)))
                .map(url => fs.rm(path.join(referencesDir, path.basename(url)), { force: true }));

            // sidecar 与原图一一对应（内容哈希去重保证不与其他条目共用），连带删除；
            // 防御性 still-used 检查兜住手工编辑 tags.json 造成的异常共用
            const sidecar = sidecarNameOf(tag);
            const sidecarUsed = sidecar && tags.some(t => sidecarNameOf(t) === sidecar);

            // 清理并行执行；force:true 表示文件不存在时不报错
            await Promise.all([
                fs.rm(path.join(imagesDir, imageFilename), { force: true }),
                fs.rm(path.join(thumbnailsDir, thumbnailFilename), { force: true }),
                ...(sidecar && !sidecarUsed ? [fs.rm(path.join(imagesDir, sidecar), { force: true })] : []),
                ...referenceRemovals,
                writeTags(tags)
            ]);
            res.json({ status: 'ok' });
        } catch (error) {
            console.error('删除提示词收藏失败:', error);
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    return router;
}

module.exports = createTagsRouter;

/**
 * 提示词收藏路由（tag 目录）
 *
 * 作用：提供图片提示词收藏的增删查接口，供前端"提示词"页面与画布工具栏的"保存提示词"按钮调用。
 *
 * 数据落盘结构（首次保存时自动创建）：
 *   tag/
 *   ├── tags.json       # 收藏元数据列表（提示词、图片尺寸、来源等）
 *   ├── images/         # 原图（WebP，质量 95，按内容哈希命名）
 *   └── thumbnails/     # 缩略图（WebP，480×480，质量 82）
 *
 * 接口一览：
 *   GET    /                       # 读取全部收藏列表
 *   POST   /                       # 保存一张图片及其提示词（按图片内容哈希去重）
 *   PUT    /:id                    # 更新收藏的名字 / 模型标签 / 提示词
 *   DELETE /:id                    # 删除指定收藏，并同步删除原图/缩略图/参考图文件
 *   GET    /models                 # 读取全部模型标签（预置 anima / gpt image / flux2 klein / krea2）
 *   POST   /models                 # 新建模型标签（按名字去重，大小写不敏感）
 *   DELETE /models/:id             # 删除模型标签（只删标签本身，不影响已有收藏的 model 字段）
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

    /** GET / ：返回全部提示词收藏 */
    router.get('/', async (req, res) => {
        try {
            res.json({ status: 'ok', tags: await readTags() });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    /**
     * POST / ：保存图片及提示词
     * 请求体：{ prompt, negativePrompt, imageUrl, source, name, model }
     *   name  - 用户在保存弹窗填写的名字（默认"无题"，可空）
     *   model - 用户选择的模型标签（anima / gpt image / flux2 klein / krea2，可空）
     * 流程：校验入参 -> 获取图片 -> 计算内容哈希去重 -> 生成原图与缩略图 -> 写入元数据
     * 重复保存：同一图片已存在时不重复写文件，仅更新名字与模型标签
     */
    router.post('/', async (req, res) => {
        try {
            // 入参校验：正向提示词与图片地址必填，其余字段允许为空
            const prompt = typeof req.body.prompt === 'string' ? req.body.prompt.trim() : '';
            const negativePrompt = typeof req.body.negativePrompt === 'string' ? req.body.negativePrompt.trim() : '';
            const imageUrl = typeof req.body.imageUrl === 'string' ? req.body.imageUrl : '';
            const name = typeof req.body.name === 'string' && req.body.name.trim() ? req.body.name.trim() : '无题';
            const model = typeof req.body.model === 'string' ? req.body.model.trim() : '';
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
                await writeTags(tags);
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
                width: imageMetadata.width || 0,
                height: imageMetadata.height || 0,
                imageUrl: `/tag/images/${filename}`,
                thumbnailUrl: `/tag/thumbnails/${filename}`,
                createdAt: Date.now()
            };
            tags.unshift(tag);
            await writeTags(tags);
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
            res.json({ status: 'ok', tag });
        } catch (error) {
            console.error('更新提示词收藏失败:', error);
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
     * 请求体：{ name }；重名时返回 409（按名字去重，大小写不敏感）
     */
    router.post('/models', async (req, res) => {
        try {
            const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
            if (!name) return res.status(400).json({ status: 'error', message: '标签名字不能为空' });
            if (name.length > 40) return res.status(400).json({ status: 'error', message: '标签名字过长（最多 40 字）' });

            const models = await readModels();
            if (models.some(m => m.name.toLowerCase() === name.toLowerCase())) {
                return res.status(409).json({ status: 'error', message: '同名标签已存在' });
            }

            const model = { id: crypto.randomUUID(), name, createdAt: Date.now() };
            models.push(model); // 新标签追加到末尾，与左侧栏新建的视觉顺序一致
            await writeModels(models);
            res.json({ status: 'ok', model });
        } catch (error) {
            console.error('新建模型标签失败:', error);
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    /**
     * DELETE /models/:id ：删除模型标签（只删标签本身）
     * 已有收藏的 model 字段保持不变，卡片角标照常显示
     */
    router.delete('/models/:id', async (req, res) => {
        try {
            const models = await readModels();
            const index = models.findIndex(m => m.id === req.params.id);
            if (index === -1) return res.status(404).json({ status: 'error', message: '模型标签不存在' });

            models.splice(index, 1);
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

            // 清理并行执行；force:true 表示文件不存在时不报错
            await Promise.all([
                fs.rm(path.join(imagesDir, imageFilename), { force: true }),
                fs.rm(path.join(thumbnailsDir, thumbnailFilename), { force: true }),
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

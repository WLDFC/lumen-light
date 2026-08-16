/**
 * ==========================================================================
 * LumenLight 存档管理路由
 * 作用：提供项目存档的列表、创建、读取 API，支持保存画布图片、提示词、
 *       视口状态等到 save/存档名/ 文件夹中，图片以原始质量复制到 images 子文件夹。
 * 路由：
 *   - GET  /api/saves           : 列出所有存档文件夹
 *   - POST /api/saves           : 创建新存档
 *   - GET  /api/saves/:name     : 读取指定存档内容
 * ==========================================================================
 */

const express = require('express');           // Express 路由
const fs = require('fs').promises;            // 基于 Promise 的文件系统 API
const path = require('path');                 // 路径处理模块
const https = require('https');               // HTTPS 下载模块
const http = require('http');                 // HTTP 下载模块

// 创建路由工厂函数，接收配置对象
function createSavesRouter({ savesDir, videosDir }) {
    const router = express.Router();

    /**
     * 确保目录存在，不存在则递归创建
     * @param {string} dir - 目录路径
     */
    async function ensureDir(dir) {
        await fs.mkdir(dir, { recursive: true });
    }

    /**
     * 递归删除目录（目录不存在时忽略）
     * @param {string} dir - 要删除的目录路径
     */
    async function removeDir(dir) {
        try {
            await fs.rm(dir, { recursive: true, force: true });
        } catch {
            // 忽略删除失败
        }
    }

    /**
     * 安全化文件夹名称，移除非法字符，限制长度
     * @param {string} name - 原始名称
     * @returns {string} 安全名称
     */
    function sanitizeFolderName(name) {
        return String(name || '')       // name 缺省时交由 generateDefaultName 兜底
            .replace(/[\\/:*?"<>|]/g, '_')   // 替换 Windows 非法字符
            .replace(/\s+/g, ' ')            // 合并连续空格
            .trim()
            .slice(0, 100);                  // 限制长度
    }

    /**
     * 生成唯一默认存档名：存档-YYYYMMDD-序号
     * @returns {string} 默认存档名
     */
    async function generateDefaultName() {
        const now = new Date();
        const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
        let index = 1;
        let name = `存档-${dateStr}-${String(index).padStart(3, '0')}`;
        let folderPath = path.join(savesDir, name);

        // 如果名称已存在，递增序号
        while (true) {
            try {
                await fs.access(folderPath);
                index++;
                name = `存档-${dateStr}-${String(index).padStart(3, '0')}`;
                folderPath = path.join(savesDir, name);
            } catch {
                break;
            }
        }

        return name;
    }

    /**
     * 确保文件名唯一：如果目标文件已存在，则在文件名后追加序号
     * @param {string} dir - 目标目录
     * @param {string} filename - 原始文件名
     * @returns {string} 可用文件名
     */
    async function getUniqueFilename(dir, filename) {
        const ext = path.extname(filename);
        const base = path.basename(filename, ext);
        let result = filename;
        let index = 1;

        while (true) {
            try {
                await fs.access(path.join(dir, result));
                result = `${base}_${index}${ext}`;
                index++;
            } catch {
                break;
            }
        }

        return result;
    }

    /**
     * 下载远程图片到本地，保持原始数据不变
     * @param {string} url - 图片 URL
     * @param {string} destPath - 目标路径
     * @returns {Promise<void>}
     */
    function downloadImage(url, destPath) {
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https:') ? https : http;
            const req = client.get(url, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`下载失败，状态码: ${res.statusCode}`));
                    return;
                }

                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', async () => {
                    try {
                        await fs.writeFile(destPath, Buffer.concat(chunks));
                        resolve();
                    } catch (err) {
                        reject(err);
                    }
                });
            });

            req.on('error', reject);
            req.setTimeout(30000, () => {
                req.destroy();
                reject(new Error('下载超时'));
            });
        });
    }

    /**
     * 保存单张图片到存档 images 目录
     * @param {Object} image - 图片对象
     * @param {string} imagesDir - 存档 images 目录
     * @returns {Promise<string>} 保存后的文件名
     */
    async function saveImageFile(image, imagesDir) {
        const { src, filename } = image;
        const safeFilename = filename || `image_${Date.now()}.png`;
        const uniqueFilename = await getUniqueFilename(imagesDir, safeFilename);
        const destPath = path.join(imagesDir, uniqueFilename);

        if (src.startsWith('data:image')) {
            // Base64 图片：直接解码写入，不压缩、不转换格式
            const base64Data = src.replace(/^data:image\/\w+;base64,/, '');
            await fs.writeFile(destPath, Buffer.from(base64Data, 'base64'));
        } else if (src.startsWith('http://') || src.startsWith('https://')) {
            // 远程 URL：下载原始数据写入
            await downloadImage(src, destPath);
        } else {
            // 本地相对路径：复制文件
            const srcPath = path.isAbsolute(src) ? src : path.join(__dirname, '..', src);
            await fs.copyFile(srcPath, destPath);
        }

        return uniqueFilename;
    }

    /**
     * 归档视频实体到存档 videos/ 子目录（保证存档自包含，不依赖共享的
     * data/videos/ 目录）。视频对象的封面图照常走 saveImageFile 入 images/，
     * 本函数只负责把 videoUrl 指向的真实视频文件复制进来。
     * 源文件不存在（被外部清理）或为 data:/blob: 地址时返回 null，
     * 恢复时按原 videoUrl 回退。
     * @param {string} videoUrl - 视频地址（如 /data/videos/xxx.mp4 或 save/xxx/videos/xxx.mp4）
     * @param {string} videosDir - 存档 videos 目录
     * @returns {Promise<string|null>} 归档后的文件名（失败为 null）
     */
    async function saveVideoFile(videoUrl, videosDir) {
        if (!videoUrl || typeof videoUrl !== 'string') return null;
        if (videoUrl.startsWith('data:') || videoUrl.startsWith('blob:')) return null;
        const rel = videoUrl.replace(/^\/+/, '');
        const srcPath = path.isAbsolute(rel) ? rel : path.join(__dirname, '..', rel);
        try {
            await fs.access(srcPath);
        } catch {
            return null;
        }
        await ensureDir(videosDir);
        const uniqueFilename = await getUniqueFilename(videosDir, path.basename(rel));
        await fs.copyFile(srcPath, path.join(videosDir, uniqueFilename));
        return uniqueFilename;
    }

    /**
     * GET /api/saves
     * 列出 save 目录下所有存档文件夹
     */
    router.get('/', async (req, res) => {
        try {
            await ensureDir(savesDir);
            const entries = await fs.readdir(savesDir, { withFileTypes: true });
            const saves = [];

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const projectPath = path.join(savesDir, entry.name, 'project.json');
                    let info = { name: entry.name, createdAt: null };

                    try {
                        const stat = await fs.stat(projectPath);
                        info.createdAt = stat.mtime.toISOString();
                    } catch {
                        // project.json 不存在则跳过创建时间
                    }

                    saves.push(info);
                }
            }

            // 按创建时间倒序排列
            saves.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

            res.json({ status: 'ok', saves });
        } catch (error) {
            console.error('列出存档失败:', error);
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    // 分批保存的会话状态（token -> 保存上下文），用于大批量图片分批上传
    const pendingSaves = new Map();

    /**
     * 清理超时（10 分钟）未完成的分批保存会话及其临时目录
     */
    function cleanupStalePending() {
        const now = Date.now();
        for (const [token, pending] of pendingSaves) {
            if (now - pending.createdAt > 10 * 60 * 1000) {
                pendingSaves.delete(token);
                if (pending.isOverwrite) removeDir(pending.tempImagesDir);
                console.log(`[保存] 清理过期的分批保存会话: ${token}`);
            }
        }
    }

    /**
     * 保存一批图片到目标目录，返回写入 project.json 的元数据数组。
     * 视频对象（source=video，携带 videoUrl）额外把视频实体归档进
     * videosDir，元数据记录 videoUrl（原地址，向后兼容）与 videoFile
     * （存档内副本文件名，恢复时优先指向它）
     * @param {Array} images - 图片对象数组（含 src/filename/位置/尺寸）
     * @param {string} imagesDir - 目标 images 目录
     * @param {string} [videosDir] - 目标 videos 目录（视频实体归档）
     * @returns {Promise<Array>} 已保存图片的元数据数组
     */
    async function saveImageBatch(images, imagesDir, videosDir) {
        const saved = [];
        for (const img of images) {
            if (!img.src) continue;

            const savedFilename = await saveImageFile(img, imagesDir);
            const entry = {
                id: img.id,                 // 画布图片唯一ID（保存后回写 src 映射用）
                filename: savedFilename,
                x: img.x,
                y: img.y,
                width: img.width,
                height: img.height,
                scale: img.scale,
                name: img.name,
                source: img.source,
                prompt: img.prompt || '',
                negativePrompt: img.negativePrompt || ''
            };

            // 视频对象：videoUrl 必须写入元数据（此前被丢弃，
            // 导致恢复后的视频对象没有播放地址）；实体同步归档进 videos/
            if (img.videoUrl) {
                entry.videoUrl = img.videoUrl;
                const videoFile = await saveVideoFile(img.videoUrl, videosDir);
                if (videoFile) entry.videoFile = videoFile;
            }

            saved.push(entry);
        }
        return saved;
    }

    /**
     * 提交保存：覆盖模式下替换原 images 目录，然后写入 project.json
     * @param {Object} pending - 保存上下文（目录、模式、已存图片、元数据）
     */
    async function commitSave(pending) {
        const { finalSaveDir, finalImagesDir, tempImagesDir, finalVideosDir, tempVideosDir, isOverwrite, savedImages, projectMeta } = pending;

        // 覆盖模式：新图片全部写入临时目录成功后，再替换原 images 目录，
        // 避免原图片被提前删除后保存又需要读取原图片导致 404。
        // videos 目录整体替换（本轮没存视频时旧视频也一并清掉，
        // 与 images 的全量替换语义一致）
        if (isOverwrite) {
            await removeDir(finalImagesDir);
            await fs.rename(tempImagesDir, finalImagesDir);
            let hasTempVideos = false;
            try { await fs.access(tempVideosDir); hasTempVideos = true; } catch { /* 本轮无视频 */ }
            await removeDir(finalVideosDir);
            if (hasTempVideos) await fs.rename(tempVideosDir, finalVideosDir);
        }

        const projectData = {
            version: '1.0',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            prompt: projectMeta.prompt || '',
            prompt2: projectMeta.prompt2 || '',
            negativePrompt: projectMeta.negativePrompt || '',
            viewport: projectMeta.viewport || null,
            // 图片连线数据 [{fromId, toId, order}]，id 对应 images/nodes 数组中的 id
            connections: Array.isArray(projectMeta.connections) ? projectMeta.connections : [],
            // 提示词节点数据 [{id, type, x, y, width, height, text}]
            nodes: Array.isArray(projectMeta.nodes) ? projectMeta.nodes : [],
            images: savedImages
        };

        await fs.writeFile(
            path.join(finalSaveDir, 'project.json'),
            JSON.stringify(projectData, null, 2),
            'utf-8'
        );

        // project.json 写入成功后清理视频工作区：本次保存已把画布引用的
        // 视频归档进存档 videos/，data/videos/ 中未被画布引用的文件
        // （已删除的视频、已归档的原件）一并回收。该目录完全归程序管理。
        await cleanupUnreferencedVideos(savedImages);
    }

    /**
     * 清理 data/videos 工作区：删除本次保存未引用的视频文件。
     * 引用判定 = 存档元数据里 videoUrl 指向 data/videos 的条目
     * （画布已删除的视频不在其中；指向存档副本的 videoUrl 不占引用）。
     * 清理失败只记日志，不影响保存结果。
     * @param {Array} savedImages - 本次保存的图片/视频元数据
     */
    async function cleanupUnreferencedVideos(savedImages) {
        if (!videosDir) return;
        try {
            const referenced = new Set(
                (Array.isArray(savedImages) ? savedImages : [])
                    .filter((img) => img.videoUrl && img.videoUrl.includes('data/videos'))
                    .map((img) => path.basename(img.videoUrl))
            );
            const entries = await fs.readdir(videosDir).catch(() => []);
            for (const name of entries) {
                if (referenced.has(name)) continue;
                try {
                    const stat = await fs.stat(path.join(videosDir, name));
                    if (!stat.isFile()) continue;
                    await fs.rm(path.join(videosDir, name));
                    console.log(`🧹 清理未引用的视频工作区文件: ${name}`);
                } catch {
                    // 单个文件清理失败不影响其余文件
                }
            }
        } catch (err) {
            console.error('清理视频工作区失败:', err);
        }
    }

    /**
     * POST /api/saves
     * 创建或覆盖存档，协议分三段（元数据与图片彻底解耦，任一侧为空均不影响另一侧）：
     *   1. init     : POST { name?, prompt, prompt2, negativePrompt, viewport?,
     *                        connections?, nodes?, overwrite? }
     *                 → 创建保存会话，返回 { token, name, overwrite }，不写任何图片
     *   2. 批次     : POST { token, images: [...] }（0 次或多次，空存档可跳过）
     *                 → 图片写入会话的临时目录
     *   3. finalize : POST { token, finalize: true }
     *                 → 提交保存（覆盖模式替换 images 目录 + 写入 project.json）
     */
    router.post('/', async (req, res) => {
        try {
            const { token } = req.body;

            // ---------- 保存会话的批次上传 ----------
            if (token) {
                const pending = pendingSaves.get(token);
                if (!pending) {
                    return res.status(400).json({
                        status: 'error',
                        message: '保存会话不存在或已过期，请重新保存'
                    });
                }

                const { images = [], finalize } = req.body;
                const saved = await saveImageBatch(images, pending.tempImagesDir, pending.tempVideosDir);
                pending.savedImages.push(...saved);
                console.log(`[保存] 分批写入完成，累计 ${pending.savedImages.length} 张`);

                // 非最后一批：继续等待后续批次
                if (!finalize) {
                    return res.json({ status: 'ok', token });
                }

                // 最后一批：提交保存
                await commitSave(pending);
                pendingSaves.delete(token);
                console.log(`✅ 存档已${pending.isOverwrite ? '覆盖' : '保存'}: ${pending.finalFolderName}（共 ${pending.savedImages.length} 张）`);

                return res.json({
                    status: 'ok',
                    name: pending.finalFolderName,
                    path: pending.finalSaveDir,
                    imageCount: pending.savedImages.length,
                    images: pending.savedImages,   // 图片ID→实际文件名映射
                    overwrite: pending.isOverwrite
                });
            }

            // ---------- init：创建保存会话（仅元数据，不含图片） ----------
            cleanupStalePending();

            const { name, prompt, prompt2, negativePrompt, viewport, connections, nodes, overwrite } = req.body;

            // 确定存档文件夹名称
            const folderName = sanitizeFolderName(name) || await generateDefaultName();
            const saveDir = path.join(savesDir, folderName);
            const imagesDir = path.join(saveDir, 'images');

            // 判断目标存档是否已存在
            let isOverwrite = false;
            let finalFolderName = folderName;
            let finalSaveDir = saveDir;

            console.log(`[保存] init 请求名称: ${name}, overwrite: ${overwrite}, folderName: ${folderName}`);

            try {
                const stat = await fs.stat(saveDir);
                if (stat.isDirectory()) {
                    console.log(`[保存] 文件夹已存在: ${saveDir}`);
                    // 文件夹已存在
                    if (overwrite) {
                        isOverwrite = true;
                        console.log(`[保存] 进入覆盖模式，使用临时目录保存`);
                    } else {
                        // 同名存档已存在且未指定覆盖：直接报错，由前端询问用户是否覆盖
                        console.log(`[保存] 同名存档已存在且未指定覆盖，拒绝保存: ${folderName}`);
                        return res.status(400).json({
                            status: 'error',
                            message: `存档「${folderName}」已存在`
                        });
                    }
                }
            } catch (err) {
                // 文件夹不存在，使用原始名称
                console.log(`[保存] 文件夹不存在，新建: ${saveDir}`);
            }

            const finalImagesDir = path.join(finalSaveDir, 'images');
            const tempImagesDir = isOverwrite ? path.join(finalSaveDir, 'images_tmp') : finalImagesDir;
            await ensureDir(tempImagesDir);
            // 视频实体归档目录（有视频对象时由批次阶段的 saveVideoFile
            // 按需创建；覆盖模式走临时目录，提交时整体替换）
            const finalVideosDir = path.join(finalSaveDir, 'videos');
            const tempVideosDir = isOverwrite ? path.join(finalSaveDir, 'videos_tmp') : finalVideosDir;

            const pending = {
                finalFolderName,
                finalSaveDir,
                finalImagesDir,
                tempImagesDir,
                finalVideosDir,
                tempVideosDir,
                isOverwrite,
                savedImages: [],
                projectMeta: { prompt, prompt2, negativePrompt, viewport, connections, nodes },
                createdAt: Date.now()
            };

            const newToken = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            pendingSaves.set(newToken, pending);
            console.log(`[保存] 开始保存会话: ${finalFolderName}${isOverwrite ? '（覆盖模式）' : ''}`);

            res.json({
                status: 'ok',
                token: newToken,
                name: finalFolderName,
                overwrite: isOverwrite
            });
        } catch (error) {
            console.error('保存存档失败:', error);
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    /**
     * GET /api/saves/:name
     * 读取指定存档内容，图片 src 转换为相对于存档 images 目录的 URL
     */
    router.get('/:name', async (req, res) => {
        try {
            const { name } = req.params;
            const saveDir = path.join(savesDir, name);
            const projectPath = path.join(saveDir, 'project.json');
            const imagesDir = path.join(saveDir, 'images');

            try {
                await fs.access(projectPath);
            } catch {
                return res.status(404).json({ status: 'error', message: '存档不存在' });
            }

            const projectData = JSON.parse(await fs.readFile(projectPath, 'utf-8'));

            // 把图片 filename 转换为前端可访问的相对 URL；
            // 视频对象优先指向存档内归档的副本（videoFile），
            // 旧存档没有 videoFile 时保留原 videoUrl（回退到 data/videos 等原路径）
            if (Array.isArray(projectData.images)) {
                projectData.images = projectData.images.map(img => {
                    const mapped = {
                        ...img,
                        src: `save/${encodeURIComponent(name)}/images/${encodeURIComponent(img.filename)}`
                    };
                    if (img.videoFile) {
                        mapped.videoUrl = `save/${encodeURIComponent(name)}/videos/${encodeURIComponent(img.videoFile)}`;
                    }
                    return mapped;
                });
            }

            res.json({ status: 'ok', data: projectData });
        } catch (error) {
            console.error('读取存档失败:', error);
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    return router;
}

module.exports = createSavesRouter;

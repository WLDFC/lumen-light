/**
 * ==========================================================================
 * LumenLight 备份导出/导入路由
 * 作用：把用户的恢复型数据（画布存档 / API 设置 / 聊天记录 / 提示词库）
 *       打包为一个 zip 备份文件下载，或从备份包导入合并回应用。
 *       文件菜单「备份导出 / 备份导入」两个入口（前端 BackupManager）。
 *
 * 包结构（backup-manifest.json 永远是包内第一个条目）：
 *   backup-manifest.json      # 格式版本 + 导出时间 + 勾选项清单（导入端据此分支）
 *   saves/<存档名>/...        # save/ 目录下各存档原样打包
 *   settings.json             # data/settings.json（可选脱敏：三种 API Key 置空）
 *   chat-history.json         # 聊天记录 IndexedDB 全量导出（由前端随请求带来）
 *   prompts/system-prompts.json  # data/prompts.json（系统提示词库）
 *   prompts/comfy-prompts.json   # data/comfy-prompts.json（Comfy 预设）
 *   tags/...                  # 收藏全套（images/thumbnails/references + 两份 json）
 *
 * 导入策略（底线：永不静默覆盖用户现有数据）：
 *   - 存档：同名自动改名「原名-导入YYYYMMDD-HHMMSS」，绝不覆盖；
 *   - API 设置：仅合并 api.providers——同名厂商整条以备份包覆盖，
 *     备份包没有的现有厂商原样保留；其余节（runninghub/mcp/comfy…）不动；
 *   - 收藏/标签/提示词库：按 id（标签按 name）并集合并，现有条目优先；
 *   - 聊天记录：整包替换（前端弹窗已显式警告，由前端写回 IndexedDB，
 *     后端不落盘，随响应 JSON 返回）。
 *
 * 接口一览：
 *   POST /export   JSON 请求体 { saves, settings, settingsIncludeKeys,
 *                                chat, chatData, prompts }
 *                  → zip 文件流下载（Content-Disposition: attachment）
 *   POST /import   原始二进制请求体（zip 文件字节），勾选项走查询串
 *                  ?saves=1&settings=1&chat=1&prompts=1
 *                  → JSON { summary, chat }（chat 为记录数组，前端写回 IndexedDB）
 *
 * 实现要点：
 *   - 导出用 archiver 流式打包直出响应，不在内存拼整包（存档可达数百 MB）；
 *   - 导入请求体不经 express.json（二进制），req 管道落盘到系统临时目录，
 *     yauzl 流式解包（zip-slip：条目名白名单校验，越界条目直接拒绝整个包）；
 *   - settings.json 等合并写入走原子写（tmp + rename）。
 * 挂载方式：server.js 中以 SAVES_DIR/DATA_DIR/TAGS_DIR 创建并挂到 /api/backup。
 * ==========================================================================
 */

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const archiver = require('archiver');
const yauzl = require('yauzl');

const FORMAT_VERSION = 1;
const MANIFEST_NAME = 'backup-manifest.json';

// settings.json 里所有「密钥」字段路径（脱敏勾选时全部置空）。
// 只做键级置空不搬运结构——结构与 routes/settings.js 的 getDefaultSettings 对齐
const SECRET_FIELDS = [
    s => { if (s.api && s.api.providers) { for (const p of Object.values(s.api.providers)) p.apiKey = ''; } },
    s => { if (s.runninghub) s.runninghub.apiKey = ''; },
    s => { if (s.civitai) s.civitai.apiKey = ''; }
];

/**
 * 备份包条目名安全校验（防 zip-slip）：
 * 拒绝绝对路径、盘符、.. 上跳段与反斜杠分隔；返回归一化相对路径，非法返回 null。
 * @param {string} name - zip 条目名
 * @returns {string|null}
 */
function sanitizeEntryName(name) {
    if (typeof name !== 'string' || name.length === 0) return null;
    if (name.includes('\\')) return null;                    // 统一正斜杠口径
    if (/^\/+/.test(name) || /^[A-Za-z]:/.test(name)) return null;  // 绝对路径/盘符
    const parts = name.split('/').filter(p => p.length > 0);
    if (parts.length === 0) return null;
    if (parts.some(p => p === '..' || p === '.')) return null;
    return parts.join('/');
}

/**
 * 脱敏一份设置对象（返回新对象，不改入参）
 */
function stripSecrets(settings) {
    const copy = JSON.parse(JSON.stringify(settings));
    for (const fn of SECRET_FIELDS) fn(copy);
    return copy;
}

/**
 * 合并 API 厂商配置：同名厂商整条以备份包为准，新增厂商追加。
 * @returns {{providers: Object, updated: number, added: number}}
 */
function mergeApiProviders(currentApi, backupApi) {
    const currentProviders = (currentApi && currentApi.providers) || {};
    const backupProviders = (backupApi && backupApi.providers) || {};
    const merged = JSON.parse(JSON.stringify(currentProviders));
    let updated = 0;
    let added = 0;
    for (const [name, conf] of Object.entries(backupProviders)) {
        if (Object.prototype.hasOwnProperty.call(merged, name)) {
            merged[name] = JSON.parse(JSON.stringify(conf));
            updated++;
        } else {
            merged[name] = JSON.parse(JSON.stringify(conf));
            added++;
        }
    }
    return { providers: merged, updated, added };
}

/** 收藏条目列表并集（按 id，现有优先）；备份侧无 id 的条目跳过不并入 */
function mergeTagEntries(currentList, backupList) {
    const byId = new Map();
    for (const item of (Array.isArray(currentList) ? currentList : [])) {
        if (item && item.id !== undefined) byId.set(item.id, item);
    }
    let added = 0;
    for (const item of (Array.isArray(backupList) ? backupList : [])) {
        if (!item || item.id === undefined || byId.has(item.id)) continue;
        byId.set(item.id, item);
        added++;
    }
    return { list: [...byId.values()], added };
}

/** 模型标签列表并集（按 name 全表唯一，现有优先） */
function mergeModelTags(currentList, backupList) {
    const byName = new Map();
    for (const item of (Array.isArray(currentList) ? currentList : [])) {
        if (item && item.name) byName.set(item.name, item);
    }
    let added = 0;
    for (const item of (Array.isArray(backupList) ? backupList : [])) {
        if (!item || !item.name || byName.has(item.name)) continue;
        byName.set(item.name, item);
        added++;
    }
    return { list: [...byName.values()], added };
}

/** 系统提示词库合并：prompts 按 id 并集（现有优先），active 启用状态保留现有 */
function mergeSystemPrompts(current, backup) {
    const merged = mergeTagEntries(current.prompts, backup.prompts);
    return {
        store: { prompts: merged.list, active: current.active || { chat: null, image: null } },
        added: merged.added
    };
}

/** Comfy 预设库合并：positive/negative 两库各自按 id 并集（现有优先） */
function mergeComfyPrompts(current, backup) {
    const store = {
        positive: Array.isArray(current.positive) ? current.positive : [],
        negative: Array.isArray(current.negative) ? current.negative : []
    };
    let added = 0;
    for (const kind of ['positive', 'negative']) {
        const r = mergeTagEntries(store[kind], backup[kind]);
        store[kind] = r.list;
        added += r.added;
    }
    return { store, added };
}

/** 原子写 JSON（先 .tmp 再 rename，防写一半进程死亡毁掉恢复型数据） */
async function writeJsonAtomic(filePath, data) {
    const tmp = filePath + '.tmp';
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await fsp.rename(tmp, filePath);
}

/** 读 JSON 文件（不存在/损坏时返回 fallback） */
async function readJsonSafe(filePath, fallback) {
    try {
        return JSON.parse(await fsp.readFile(filePath, 'utf-8'));
    } catch {
        return fallback;
    }
}

/** 目录是否存在 */
async function dirExists(p) {
    try {
        return (await fsp.stat(p)).isDirectory();
    } catch {
        return false;
    }
}

/** yauzl 单条目解包为 Promise */
function extractEntry(zipfile, entry, destDir, safeName) {
    return new Promise((resolve, reject) => {
        zipfile.openReadStream(entry, (err, readStream) => {
            if (err) return reject(err);
            const target = path.join(destDir, safeName);
            fsp.mkdir(path.dirname(target), { recursive: true })
                .then(() => {
                    const ws = fs.createWriteStream(target);
                    readStream.pipe(ws);
                    ws.on('finish', resolve);
                    ws.on('error', reject);
                    readStream.on('error', reject);
                })
                .catch(reject);
        });
    });
}

/**
 * 流式解包 zip 到目标目录（逐条目校验防 zip-slip，越界条目拒绝整个包）
 * @returns {Promise<{entries: number}>}
 */
function extractZip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
            if (err) return reject(new Error('无法读取备份包（不是有效的 zip 文件）'));
            let entries = 0;
            let failed = false;
            zipfile.readEntry();
            zipfile.on('entry', (entry) => {
                if (failed) return;
                const safeName = sanitizeEntryName(entry.fileName);
                if (!safeName) {
                    failed = true;
                    zipfile.close();
                    return reject(new Error(`备份包含非法条目（疑似篡改）：${entry.fileName}`));
                }
                entries++;
                if (entry.fileName.endsWith('/')) {
                    // 目录条目：只建目录
                    fsp.mkdir(path.join(destDir, safeName), { recursive: true })
                        .then(() => zipfile.readEntry())
                        .catch(reject);
                    return;
                }
                extractEntry(zipfile, entry, destDir, safeName)
                    .then(() => zipfile.readEntry())
                    .catch((e) => { failed = true; zipfile.close(); reject(e); });
            });
            zipfile.on('end', () => { if (!failed) resolve({ entries }); });
            zipfile.on('error', (e) => { if (!failed) { failed = true; reject(e); } });
        });
    });
}

/**
 * 同名冲突时生成不冲突的存档名：「原名-导入YYYYMMDD-HHMMSS」，仍冲突追加序号
 */
async function resolveImportSaveName(savesDir, name, timestamp) {
    const exists = async (n) => {
        try { await fsp.access(path.join(savesDir, n)); return true; } catch { return false; }
    };
    if (!(await exists(name))) return name;
    let candidate = `${name}-导入${timestamp}`;
    for (let i = 2; await exists(candidate); i++) {
        candidate = `${name}-导入${timestamp}-${i}`;
    }
    return candidate;
}

/**
 * 创建备份导出/导入路由
 * @param {Object} options - 依赖项
 * @param {string} options.savesDir - 画布存档目录（save/）
 * @param {string} options.dataDir  - 应用数据目录（data/）
 * @param {string} options.tagsDir  - 收藏目录（tag/）
 * @returns {express.Router}
 */
function createBackupRouter({ savesDir, dataDir, tagsDir }) {
    const router = express.Router();
    const settingsPath = path.join(dataDir, 'settings.json');
    const systemPromptsPath = path.join(dataDir, 'prompts.json');
    const comfyPromptsPath = path.join(dataDir, 'comfy-prompts.json');

    // ==================== 导出 ====================
    router.post('/export', async (req, res) => {
        const opts = req.body || {};
        const wantSaves = !!opts.saves;
        const wantSettings = !!opts.settings;
        const includeKeys = !!opts.settingsIncludeKeys;
        const wantChat = !!opts.chat;
        const wantPrompts = !!opts.prompts;
        const chatData = Array.isArray(opts.chatData) ? opts.chatData : null;

        if (!wantSaves && !wantSettings && !wantChat && !wantPrompts) {
            return res.status(400).json({ status: 'error', message: '至少选择一项要备份的内容' });
        }
        if (wantChat && !chatData) {
            return res.status(400).json({ status: 'error', message: '缺少聊天记录数据（chatData）' });
        }

        try {
            // 清点要打包的存档
            const saveNames = [];
            if (wantSaves) {
                for (const name of await fsp.readdir(savesDir)) {
                    if (await dirExists(path.join(savesDir, name))) saveNames.push(name);
                }
            }

            const manifest = {
                formatVersion: FORMAT_VERSION,
                app: 'lumen-light',
                exportedAt: new Date().toISOString(),
                items: {
                    saves: saveNames,
                    settings: wantSettings,
                    settingsIncludeKeys: includeKeys,
                    chat: wantChat ? { count: chatData.length } : null,
                    prompts: wantPrompts
                }
            };

            const timestamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
            const zipName = `lumen-backup-${timestamp}.zip`;
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

            const archive = archiver('zip', { zlib: { level: 6 } });
            archive.on('warning', (e) => console.warn('备份打包 warning:', e.message));
            archive.on('error', (e) => {
                console.error('备份打包失败:', e);
                if (!res.headersSent) res.status(500).json({ status: 'error', message: e.message });
                else res.destroy();
            });
            archive.pipe(res);

            // manifest 永远第一个条目
            archive.append(JSON.stringify(manifest, null, 2), { name: MANIFEST_NAME });

            for (const name of saveNames) {
                archive.directory(path.join(savesDir, name), `saves/${name}`);
            }

            if (wantSettings) {
                const raw = await readJsonSafe(settingsPath, null);
                if (raw) {
                    const payload = includeKeys ? raw : stripSecrets(raw);
                    archive.append(JSON.stringify(payload, null, 2), { name: 'settings.json' });
                }
            }

            if (wantChat) {
                archive.append(JSON.stringify(chatData), { name: 'chat-history.json' });
            }

            if (wantPrompts) {
                // 收藏全套（images/thumbnails/references/tags.json/models.json）
                if (await dirExists(tagsDir)) archive.directory(tagsDir, 'tags');
                const sysPrompts = await readJsonSafe(systemPromptsPath, null);
                if (sysPrompts) {
                    archive.append(JSON.stringify(sysPrompts, null, 2), { name: 'prompts/system-prompts.json' });
                }
                const comfyPrompts = await readJsonSafe(comfyPromptsPath, null);
                if (comfyPrompts) {
                    archive.append(JSON.stringify(comfyPrompts, null, 2), { name: 'prompts/comfy-prompts.json' });
                }
            }

            await archive.finalize();
        } catch (error) {
            console.error('备份导出失败:', error);
            if (!res.headersSent) {
                res.status(500).json({ status: 'error', message: error.message });
            } else {
                res.destroy();
            }
        }
    });

    // ==================== 导入 ====================
    // 请求体为原始 zip 字节（不经 express.json），勾选项走查询串
    router.post('/import', async (req, res) => {
        const flag = (k) => req.query[k] === '1' || req.query[k] === 'true';
        const wantSaves = flag('saves');
        const wantSettings = flag('settings');
        const wantChat = flag('chat');
        const wantPrompts = flag('prompts');

        const token = crypto.randomUUID();
        const tmpZip = path.join(os.tmpdir(), `lumen-backup-${token}.zip`);
        const extractDir = `${tmpZip}.dir`;

        const cleanup = async () => {
            await fsp.rm(tmpZip, { force: true });
            await fsp.rm(extractDir, { recursive: true, force: true });
        };

        try {
            if (!wantSaves && !wantSettings && !wantChat && !wantPrompts) {
                return res.status(400).json({ status: 'error', message: '至少选择一项要导入的内容' });
            }

            // 1. 请求体管道落盘（边收边写，不吃内存）
            await new Promise((resolve, reject) => {
                const ws = fs.createWriteStream(tmpZip);
                req.pipe(ws);
                ws.on('finish', resolve);
                ws.on('error', reject);
                req.on('error', reject);
            });

            // 2. 解包到临时目录（逐条目防穿越校验）
            await extractZip(tmpZip, extractDir);

            // 3. 校验 manifest
            const manifest = await readJsonSafe(path.join(extractDir, MANIFEST_NAME), null);
            if (!manifest || manifest.formatVersion !== FORMAT_VERSION) {
                return res.status(400).json({
                    status: 'error',
                    message: '不是有效的流光备份包（缺少 backup-manifest.json 或格式版本不符）'
                });
            }

            const summary = {
                savesImported: [],   // [最终名]（含自动改名后的）
                savesRenamed: 0,     // 因同名而改名的数量
                settingsUpdated: 0,  // 覆盖的同名厂商数
                settingsAdded: 0,    // 新增的厂商数
                tagsAdded: 0,        // 新增收藏条目数
                modelsAdded: 0,      // 新增模型标签数
                promptsAdded: 0,     // 新增系统/Comfy 预设数
                chatRecords: 0       // 返回给前端写回 IndexedDB 的记录数
            };
            let chatPayload = null;
            const timestamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');

            // 4. 存档：整目录复制，同名自动改名（绝不覆盖）
            if (wantSaves) {
                const srcSavesDir = path.join(extractDir, 'saves');
                if (await dirExists(srcSavesDir)) {
                    for (const name of await fsp.readdir(srcSavesDir)) {
                        const src = path.join(srcSavesDir, name);
                        if (!(await dirExists(src))) continue;
                        const finalName = await resolveImportSaveName(savesDir, name, timestamp);
                        await fsp.mkdir(savesDir, { recursive: true });
                        await fsp.cp(src, path.join(savesDir, finalName), { recursive: true });
                        if (finalName !== name) summary.savesRenamed++;
                        summary.savesImported.push(finalName);
                    }
                }
            }

            // 5. API 设置：只合并 api.providers（同名厂商以备份包为准，其余节不动）
            if (wantSettings) {
                const backupSettings = await readJsonSafe(path.join(extractDir, 'settings.json'), null);
                if (backupSettings && backupSettings.api) {
                    const current = await readJsonSafe(settingsPath, { api: { providers: {} } });
                    if (!current.api) current.api = {};
                    const merged = mergeApiProviders(current.api, backupSettings.api);
                    current.api.providers = merged.providers;
                    await writeJsonAtomic(settingsPath, current);
                    summary.settingsUpdated = merged.updated;
                    summary.settingsAdded = merged.added;
                }
            }

            // 6. 提示词库：收藏 + 模型标签 + 系统提示词 + Comfy 预设，各自按 id/name 并集
            if (wantPrompts) {
                const srcTagsDir = path.join(extractDir, 'tags');
                if (await dirExists(srcTagsDir)) {
                    // 目录级合并复制（内容哈希命名的图片天然幂等）
                    await fsp.mkdir(tagsDir, { recursive: true });
                    for (const entry of await fsp.readdir(srcTagsDir, { withFileTypes: true })) {
                        const src = path.join(srcTagsDir, entry.name);
                        const dest = path.join(tagsDir, entry.name);
                        if (entry.isDirectory()) {
                            await fsp.cp(src, dest, { recursive: true });
                        } else if (entry.name === 'tags.json') {
                            const current = await readJsonSafe(dest, []);
                            const backup = await readJsonSafe(src, []);
                            const merged = mergeTagEntries(current, backup);
                            await writeJsonAtomic(dest, merged.list);
                            summary.tagsAdded = merged.added;
                        } else if (entry.name === 'models.json') {
                            const current = await readJsonSafe(dest, []);
                            const backup = await readJsonSafe(src, []);
                            const merged = mergeModelTags(current, backup);
                            await writeJsonAtomic(dest, merged.list);
                            summary.modelsAdded = merged.added;
                        } else {
                            // 其他散文件（如有）不覆盖
                            try { await fsp.access(dest); } catch { await fsp.cp(src, dest); }
                        }
                    }
                }

                const sysBackup = await readJsonSafe(path.join(extractDir, 'prompts/system-prompts.json'), null);
                if (sysBackup && Array.isArray(sysBackup.prompts)) {
                    const current = await readJsonSafe(systemPromptsPath, { prompts: [], active: { chat: null, image: null } });
                    const merged = mergeSystemPrompts(current, sysBackup);
                    await writeJsonAtomic(systemPromptsPath, merged.store);
                    summary.promptsAdded += merged.added;
                }

                const comfyBackup = await readJsonSafe(path.join(extractDir, 'prompts/comfy-prompts.json'), null);
                if (comfyBackup && (comfyBackup.positive || comfyBackup.negative)) {
                    const current = await readJsonSafe(comfyPromptsPath, { positive: [], negative: [] });
                    const merged = mergeComfyPrompts(current, comfyBackup);
                    await writeJsonAtomic(comfyPromptsPath, merged.store);
                    summary.promptsAdded += merged.added;
                }
            }

            // 7. 聊天记录：不落盘，随响应返回由前端写回 IndexedDB
            if (wantChat) {
                const chat = await readJsonSafe(path.join(extractDir, 'chat-history.json'), null);
                if (Array.isArray(chat)) {
                    chatPayload = chat.filter(r => r && typeof r.key === 'string' && typeof r.html === 'string');
                    summary.chatRecords = chatPayload.length;
                }
            }

            res.json({ status: 'ok', summary, chat: chatPayload });
        } catch (error) {
            console.error('备份导入失败:', error);
            res.status(400).json({ status: 'error', message: error.message });
        } finally {
            await cleanup();
        }
    });

    return router;
}

// 纯函数与常量挂在工厂上供测试与外部复用
createBackupRouter.FORMAT_VERSION = FORMAT_VERSION;
createBackupRouter.sanitizeEntryName = sanitizeEntryName;
createBackupRouter.stripSecrets = stripSecrets;
createBackupRouter.mergeApiProviders = mergeApiProviders;
createBackupRouter.mergeTagEntries = mergeTagEntries;
createBackupRouter.mergeModelTags = mergeModelTags;

module.exports = createBackupRouter;

/**
 * ==========================================================================
 * LumenLight 设置管理路由
 * 作用：提供读写应用设置的 HTTP API，将设置持久化到项目目录下的 JSON 文件中。
 * 当前支持：API 提供商、端点地址、API Key 等配置项。
 * ==========================================================================
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');

/**
 * 创建设置管理路由
 * @param {Object} options - 依赖项
 * @param {string} options.dataDir - 设置文件存放目录
 * @returns {express.Router} Express 路由实例
 */
function createSettingsRouter({ dataDir }) {
    const router = express.Router();
    const settingsPath = path.join(dataDir, 'settings.json');

    /**
     * 确保数据目录存在
     */
    async function ensureDataDir() {
        await fs.mkdir(dataDir, { recursive: true });
    }

    /**
     * 读取设置文件
     * 如果文件使用旧版单套配置结构（api.provider/api.endpoint...），
     * 会自动迁移为新版按厂商分组结构（api.currentProvider/api.providers）。
     * @returns {Promise<Object>} 设置对象
     */
    async function readSettings() {
        try {
            const content = await fs.readFile(settingsPath, 'utf-8');
            const settings = JSON.parse(content);
            return migrateSettings(settings);
        } catch {
            // 文件不存在或解析失败时返回默认设置
            return getDefaultSettings();
        }
    }

    /**
     * 写入设置文件
     * @param {Object} settings - 设置对象
     */
    async function writeSettings(settings) {
        await ensureDataDir();
        await fs.writeFile(settingsPath, JSON.stringify(settings, null, 4), 'utf-8');
    }

    /**
     * 获取默认设置
     * 新版结构：按 API 厂商分组保存多套配置。
     * bindings 为「用途 → 模型」绑定（技能绑定已删除：技能模型选择
     * 迁移到提示词节点技能栏的模型下拉，2026-10）
     * @returns {Object} 默认设置
     */
    function getDefaultSettings() {
        return {
            api: {
                currentProvider: 'Deepseek',
                providers: {
                    Deepseek: { endpoint: '', apiKey: '', models: [] },
                    OpenAI: { endpoint: '', apiKey: '', models: [] },
                    Doubao: { endpoint: '', apiKey: '', models: [] }
                },
                bindings: {}
            },
            // RunningHub 云端工作流通道：apiKey/端点 + 工作流登记卡
            // （endpoint 空 = 用平台默认 https://www.runninghub.cn）
            runninghub: {
                apiKey: '',
                endpoint: '',
                workflows: []
            }
        };
    }

    /**
     * 兼容旧版 settings.json 结构
     * 旧版：api: { provider, endpoint, apiKey, models }
     * 新版：api: { currentProvider, providers: {...}, bindings: {...} }
     * 同时为缺少 bindings 的存量配置补上默认值
     * @param {Object} settings - 原始设置对象
     * @returns {Object} 迁移后的设置对象
     */
    function migrateSettings(settings) {
        if (!settings || typeof settings !== 'object' || !settings.api) {
            return getDefaultSettings();
        }

        const api = settings.api;

        // 如果连 providers 都没有，说明是最老的旧版结构，整段迁移
        if (!api.providers || typeof api.providers !== 'object') {
            const provider = api.provider || 'Deepseek';
            const defaults = getDefaultSettings();
            defaults.api.currentProvider = provider;
            defaults.api.providers[provider] = {
                endpoint: api.endpoint || '',
                apiKey: api.apiKey || '',
                models: Array.isArray(api.models) ? api.models : []
            };
            return defaults;
        }

        // 已有 providers：只补缺失的 bindings（保留用户已配置的值）
        if (!api.bindings || typeof api.bindings !== 'object') {
            api.bindings = getDefaultSettings().api.bindings;
        }
        // 存量配置里的 skill 绑定不再使用（技能模型已迁移到提示词节点
        // 技能栏），迁移时顺手清掉，避免无效数据长期滞留
        delete api.bindings.skill;

        // 为存量配置补 RunningHub 区块（不覆盖用户已登记的内容）
        if (!settings.runninghub || typeof settings.runninghub !== 'object') {
            settings.runninghub = getDefaultSettings().runninghub;
        }
        if (!Array.isArray(settings.runninghub.workflows)) {
            settings.runninghub.workflows = [];
        }
        return settings;
    }

    /**
     * 从 API 提供商获取模型列表
     * @param {string} endpoint - API 端点地址，例如 https://api.deepseek.com/v1
     * @param {string} apiKey - API Key
     * @returns {Promise<string[]>} 模型 ID 列表
     */
    async function fetchProviderModels(endpoint, apiKey) {
        const url = new URL(endpoint);
        const modelPath = (url.pathname.replace(/\/$/, '') || '') + '/models';

        const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: modelPath,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        };

        return new Promise((resolve, reject) => {
            const client = url.protocol === 'https:' ? https : http;
            const request = client.request(options, (response) => {
                let data = '';
                response.on('data', (chunk) => { data += chunk; });
                response.on('end', () => {
                    const statusCode = response.statusCode;

                    // 非 2xx：透传上游返回的原始错误信息，便于定位真实原因
                    // （例如中转站的 region_not_supported、额度不足、Key 无效等）
                    if (statusCode < 200 || statusCode >= 300) {
                        let message = `请求失败，HTTP ${statusCode}`;
                        try {
                            const json = JSON.parse(data);
                            const upstream = json.error?.message || json.message;
                            if (upstream) message += `：${upstream}`;
                        } catch {
                            // 上游返回的不是 JSON（如 HTML 错误页），截取前 200 字符
                            const text = data.trim().slice(0, 200);
                            if (text) message += `：${text}`;
                        }
                        return reject(new Error(message));
                    }

                    try {
                        const json = JSON.parse(data);
                        if (Array.isArray(json.data)) {
                            const ids = json.data.map((m) => m.id).filter(Boolean).sort();
                            return resolve(ids);
                        }
                        return reject(new Error('返回数据格式不正确'));
                    } catch (error) {
                        return reject(new Error('解析模型列表失败'));
                    }
                });
            });

            request.on('error', (error) => {
                // 网络层错误（DNS 解析失败、连接被拒、证书问题等），
                // 附带错误码便于区分是端点地址写错还是网络不可达
                const code = error.code ? `（${error.code}）` : '';
                reject(new Error(`无法连接到 ${url.hostname}${code}：${error.message}`));
            });

            request.end();
        });
    }

    /**
     * GET /api/settings
     * 获取当前设置
     */
    router.get('/', async (req, res) => {
        try {
            const settings = await readSettings();
            res.json({
                status: 'ok',
                settings
            });
        } catch (error) {
            console.error('读取设置失败:', error);
            res.status(500).json({
                status: 'error',
                message: error.message || '读取设置失败'
            });
        }
    });

    /**
     * POST /api/settings
     * 保存设置
     */
    router.post('/', async (req, res) => {
        try {
            const newSettings = req.body;

            if (!newSettings || typeof newSettings !== 'object') {
                return res.status(400).json({
                    status: 'error',
                    message: '设置数据格式不正确'
                });
            }

            // 与现有设置合并，保留未提交的字段。
            // api 做两层合并：前端 API 面板提交的 api 是整对象，
            // 直接浅合并会把其他字段（如 bindings）整个顶掉
            const currentSettings = await readSettings();
            const mergedSettings = {
                ...currentSettings,
                ...newSettings
            };

            if (newSettings && newSettings.api) {
                mergedSettings.api = {
                    ...currentSettings.api,
                    ...newSettings.api
                };
                // bindings 仅在请求显式携带时覆盖，否则保留现有值，
                // 防止不感知 bindings 的旧前端提交把它抹掉
                if (newSettings.api.bindings !== undefined) {
                    mergedSettings.api.bindings = newSettings.api.bindings;
                } else if (!mergedSettings.api.bindings) {
                    mergedSettings.api.bindings = getDefaultSettings().api.bindings;
                }
            }

            await writeSettings(mergedSettings);

            // 写入后立即读取验证，确保文件持久化成功
            const savedSettings = await readSettings();
            if (!savedSettings || typeof savedSettings !== 'object') {
                throw new Error('设置写入后验证失败，读取到的内容为空');
            }

            res.json({
                status: 'ok',
                settings: savedSettings
            });
        } catch (error) {
            console.error('保存设置失败:', error);
            res.status(500).json({
                status: 'error',
                message: error.message || '保存设置失败'
            });
        }
    });

    /**
     * POST /api/settings/models
     * 从 API 提供商获取模型列表
     */
    router.post('/models', async (req, res) => {
        try {
            const { endpoint, apiKey } = req.body;

            if (!endpoint || !apiKey) {
                return res.status(400).json({
                    status: 'error',
                    message: '缺少端点地址或 API Key'
                });
            }

            const models = await fetchProviderModels(endpoint, apiKey);

            res.json({
                status: 'ok',
                models
            });
        } catch (error) {
            console.error('获取模型列表失败:', error);
            res.status(500).json({
                status: 'error',
                message: error.message || '获取模型列表失败'
            });
        }
    });

    return router;
}

module.exports = createSettingsRouter;

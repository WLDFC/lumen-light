/**
 * ==========================================================================
 * 画布工作流模板路由
 * 作用：为「工作流模板」窗口（js/components/WorkflowTemplateLibrary.js）
 *       提供画布节点工作流模板的读取接口。模板存于
 *       workflows/canvas-templates/ 子目录（一模板一 JSON），与
 *       ComfyUI 工作流模板（workflows/ 根级 *.json，供 Comfy 生图节点
 *       下拉扫描）同仓不同层——列表扫描都是非递归 readdir，子目录
 *       不会混入 Comfy 工作流下拉。
 *
 *   - GET /api/canvas-templates          模板列表（元数据：名称/说明/节点数）
 *   - GET /api/canvas-templates/:id      模板全量数据（节点/连线/编组快照）
 *
 * 模板文件结构（kind 字段防误用）：
 *   { kind:'lumen-canvas-template', name, description, nodes[], connections:[{from,to,order}],
 *     groups[] } —— nodes 为节点 toJSON 快照（坐标相对模板包围盒左上角），
 *   connections 用 nodes 数组下标对表达（静态数据无 id 漂移问题）。
 * 模板文件目前由开发者/用户手工放置；窗口侧「存为模板」入口后续迭代接入
 * （届时在此补 POST 路由）。
 * ==========================================================================
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');

/** 模板 id 防路径穿越：只允许字母数字、连字符、下划线与中文 */
function isSafeTemplateId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 120 &&
        !/[\\/\0]/.test(id) && id !== '.' && id !== '..';
}

/**
 * 创建画布工作流模板路由
 * @param {Object} options - 依赖项
 * @param {string} options.templatesDir - 模板目录（workflows/canvas-templates）
 * @returns {express.Router} Express 路由实例
 */
function createCanvasTemplatesRouter(options) {
    const { templatesDir } = options;
    const router = express.Router();

    /**
     * GET /api/canvas-templates
     * 列出全部画布工作流模板（元数据，按更新时间倒序）
     */
    router.get('/', async (req, res) => {
        try {
            const files = await fs.readdir(templatesDir);
            const templates = [];
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                try {
                    const raw = JSON.parse(
                        await fs.readFile(path.join(templatesDir, file), 'utf-8'));
                    templates.push({
                        id: file.replace(/\.json$/, ''),
                        name: raw.name || file.replace(/\.json$/, ''),
                        description: raw.description || '',
                        nodeCount: Array.isArray(raw.nodes) ? raw.nodes.length : 0,
                        updatedAt: raw.updatedAt || raw.createdAt || 0
                    });
                } catch (e) {
                    // 单个模板文件损坏不阻塞整表（跳过并留痕）
                    console.error('[canvas-templates] 读取模板失败:', file, e.message);
                }
            }
            templates.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            res.json({ status: 'ok', templates });
        } catch (error) {
            // 目录不存在 = 尚无任何模板，按空表返回（不发版包首启场景）
            if (error.code === 'ENOENT') {
                return res.json({ status: 'ok', templates: [] });
            }
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    /**
     * GET /api/canvas-templates/:id
     * 读取单个模板全量数据（nodes/connections/groups 快照）
     */
    router.get('/:id', async (req, res) => {
        const id = req.params.id;
        if (!isSafeTemplateId(id)) {
            return res.status(400).json({ status: 'error', message: '非法模板 id' });
        }
        try {
            const raw = await fs.readFile(
                path.join(templatesDir, `${id}.json`), 'utf-8');
            const data = JSON.parse(raw);
            if (data.kind !== 'lumen-canvas-template') {
                return res.status(400).json({
                    status: 'error', message: '不是画布工作流模板文件'
                });
            }
            res.json({ status: 'ok', template: data });
        } catch (error) {
            const code = error.code === 'ENOENT' ? 404 : 500;
            res.status(code).json({ status: 'error', message: error.message });
        }
    });

    return router;
}

module.exports = createCanvasTemplatesRouter;

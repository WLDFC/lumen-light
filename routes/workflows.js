/**
 * ==========================================================================
 * 工作流管理路由
 * 作用：提供工作流文件的读取接口，包括：
 *   1. 获取所有工作流列表
 *   2. 获取单个工作流详情
 * ==========================================================================
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');

/**
 * 创建工作流管理路由
 * @param {Object} options - 依赖项
 * @param {string} options.workflowsDir - 工作流文件存储目录
 * @returns {express.Router} Express 路由实例
 */
function createWorkflowsRouter(options) {
    const { workflowsDir } = options;
    const router = express.Router();

    /**
     * GET /api/workflows
     * 获取所有工作流列表
     */
    router.get('/', async (req, res) => {
        try {
            const files = await fs.readdir(workflowsDir);
            const workflows = [];

            for (const file of files) {
                if (file.endsWith('.json')) {
                    try {
                        const content = await fs.readFile(path.join(workflowsDir, file), 'utf-8');
                        const data = JSON.parse(content);

                        // 检测工作流格式
                        // 格式1: 包装格式 { id, name, note, workflow: {...} }
                        // 格式2: 纯 ComfyUI 格式 { "1": {...}, "2": {...} }
                        const isWrappedFormat = data.workflow && typeof data.workflow === 'object';
                        const workflowData = isWrappedFormat ? data.workflow : data;

                        workflows.push({
                            id: file.replace('.json', ''),
                            name: data.name || file.replace('.json', ''),
                            note: data.note || '',
                            nodeCount: workflowData ? Object.keys(workflowData).length : 0,
                            updatedAt: data.updatedAt || Date.now()
                        });
                    } catch (e) {
                        console.error('读取工作流失败:', file, e.message);
                    }
                }
            }

            res.json({
                status: 'ok',
                workflows: workflows.sort((a, b) => b.updatedAt - a.updatedAt)
            });
        } catch (error) {
            res.status(500).json({
                status: 'error',
                message: error.message
            });
        }
    });

    /**
     * GET /api/workflows/:id
     * 获取单个工作流详情
     */
    router.get('/:id', async (req, res) => {
        try {
            const filePath = path.join(workflowsDir, `${req.params.id}.json`);
            const content = await fs.readFile(filePath, 'utf-8');
            const data = JSON.parse(content);

            // 检测工作流格式
            const isWrappedFormat = data.workflow && typeof data.workflow === 'object';

            if (isWrappedFormat) {
                // 已经是包装格式，直接返回
                res.json({
                    status: 'ok',
                    ...data
                });
            } else {
                // 纯 ComfyUI 格式，需要包装
                res.json({
                    status: 'ok',
                    id: req.params.id,
                    name: req.params.id,
                    note: '',
                    workflow: data,
                    updatedAt: Date.now()
                });
            }
        } catch (error) {
            res.status(404).json({
                status: 'error',
                message: '工作流不存在'
            });
        }
    });

    return router;
}

module.exports = createWorkflowsRouter;

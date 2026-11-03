/**
 * ==========================================================================
 * LumenLight 漫画编辑器分镜模板路由
 * 作用：漫画编辑器「分镜模板」弹窗（MangaTemplates 混入）的数据源——
 *       预设模板与用户自存模板的读取 / 保存 / 删除。一个模板一个 JSON
 *       文件，格子是归一化坐标（0~1 相对画幅），任何画幅都能套用。
 * 数据落盘（目录不存在视为空清单，首次保存自动创建，原子写 tmp+rename）：
 *   manga-templates/presets/*.json          内置预设（**根级目录**，ADR 078
 *                                           后记迁移——随发版包分发，放文件
 *                                           即生效，发版随包）
 *   data/manga-templates/user/*.json        「我的模板」（编辑器内保存落这里，
 *                                           用户数据，绝不入发行包）
 * 模板 JSON 形态：
 *   { "name": "九格节奏", "cells": [
 *       { "x": 0.04, "y": 0.04, "w": 0.28, "h": 0.28,
 *         "label": "object", "shot": "远景" }, ... ] }
 *   x/y = 格子左上角归一化坐标，w/h = 归一化宽高；label 可选
 *   （object/character/text，缺省 object）；shot 可选景别注记。
 * 接口一览：
 *   GET  /           清单（presets 与 user 两个数组，损坏文件跳过不拖垮）
 *   POST /           保存到 user/（{ name, cells }；同名覆盖，文件名由
 *                    名字净化而来）
 *   DELETE /user/:id 删除 user/ 模板（id = 文件名去 .json）
 * 挂载方式：server.js 中以 DATA_DIR 创建并挂载到 /api/manga-templates。
 * ==========================================================================
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');

const ITEM_LABELS = ['object', 'character', 'text'];
const MAX_CELLS = 200;      // 单模板格子数上限（分镜一页撑不到这么多）
const MAX_NAME_LEN = 40;

/**
 * 名字 → 安全文件名 id：仅保留中英数字/下划线/连字符，其余折叠为 '_'，
 * 首尾下标裁剪；同名天然同文件（保存即覆盖语义），空名回落 'template'
 */
function sanitizeTemplateId(name) {
    const cleaned = String(name || '')
        .replace(/[\\/:*?"<>|\s]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, MAX_NAME_LEN);
    return cleaned || 'template';
}

/** 单个格子的宽松校验（归一化坐标 0~1，宽高正数；label/shot 可选） */
function isValidCell(cell) {
    if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return false;
    for (const key of ['x', 'y', 'w', 'h']) {
        const v = cell[key];
        if (typeof v !== 'number' || !Number.isFinite(v)) return false;
        if (v < 0 || v > 1) return false;
    }
    if (cell.w <= 0 || cell.h <= 0) return false;
    if (cell.x + cell.w > 1 + 1e-9 || cell.y + cell.h > 1 + 1e-9) return false;
    if (cell.label !== undefined && !ITEM_LABELS.includes(cell.label)) return false;
    if (cell.shot !== undefined &&
        (typeof cell.shot !== 'string' || cell.shot.length > 20)) return false;
    return true;
}

/** 模板整体校验（POST 载荷的 cells 部分） */
function isValidCells(cells) {
    if (!Array.isArray(cells) || cells.length < 1 || cells.length > MAX_CELLS) return false;
    return cells.every(isValidCell);
}

/**
 * 创建漫画分镜模板路由
 * @param {Object} options - 依赖项
 * @param {string} options.dataDir - 数据文件存放目录（data/，user/ 模板落
 *                                  data/manga-templates/user/）
 * @param {string} [options.presetsDir] - 内置预设目录（根级 manga-templates/
 *                                  presets/，随发行包分发；缺省回落 data/
 *                                  manga-templates/presets/——迁移前位置，
 *                                  测试与旧调用兼容）
 * @returns {express.Router} Express 路由实例
 */
function createMangaTemplatesRouter({ dataDir, presetsDir }) {
    const router = express.Router();
    const rootDir = path.join(dataDir, 'manga-templates');
    const presetsDirAbs = presetsDir || path.join(rootDir, 'presets');
    const userDir = path.join(rootDir, 'user');

    /** 扫一个模板目录：坏文件跳过不拖垮清单；按 id 中文序排序 */
    async function readTemplateDir(dir) {
        let files;
        try {
            files = await fs.readdir(dir);
        } catch {
            return [];   // 目录不存在 = 空清单（首次使用/发版未带预设）
        }
        const list = [];
        for (const name of files) {
            if (!name.toLowerCase().endsWith('.json')) continue;
            try {
                const tpl = JSON.parse(await fs.readFile(path.join(dir, name), 'utf-8'));
                if (!tpl || typeof tpl !== 'object') continue;
                if (typeof tpl.name !== 'string' || !tpl.name.trim()) continue;
                if (!isValidCells(tpl.cells)) continue;
                list.push({ id: name.slice(0, -5), name: tpl.name, cells: tpl.cells });
            } catch {
                // 单个坏文件跳过
            }
        }
        list.sort((a, b) => a.id.localeCompare(b.id, 'zh'));
        return list;
    }

    /** 原子写（先 .tmp 再 rename，防写一半进程死亡毁掉数据） */
    async function writeTemplate(file, tpl) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(tpl, null, 2), 'utf-8');
        await fs.rename(tmp, file);
    }

    // 模板清单（预设 + 用户两组）
    router.get('/', async (req, res) => {
        try {
            const [presets, user] = await Promise.all([
                readTemplateDir(presetsDirAbs),
                readTemplateDir(userDir)
            ]);
            res.json({ status: 'ok', presets, user });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    // 保存用户模板（同名覆盖）
    router.post('/', async (req, res) => {
        try {
            const { name, cells } = req.body || {};
            if (typeof name !== 'string' || !name.trim() || name.trim().length > MAX_NAME_LEN) {
                return res.status(400).json({
                    status: 'error',
                    message: `模板名须为 1~${MAX_NAME_LEN} 字的非空字符串`
                });
            }
            if (!isValidCells(cells)) {
                return res.status(400).json({
                    status: 'error',
                    message: 'cells 须为 1~' + MAX_CELLS + ' 个格子的数组（x/y/w/h 均为 0~1 归一化数字，w/h 正数）'
                });
            }
            const cleanName = name.trim();
            const id = sanitizeTemplateId(cleanName);
            const file = path.join(userDir, id + '.json');
            // 路径防逸出（id 已净化，双保险）
            if (path.resolve(file).startsWith(path.resolve(rootDir) + path.sep) === false) {
                return res.status(400).json({ status: 'error', message: '模板 id 不合法' });
            }
            let overwritten = false;
            try {
                await fs.access(file);
                overwritten = true;
            } catch { /* 新模板 */ }
            await writeTemplate(file, { name: cleanName, cells });
            res.json({ status: 'ok', id, name: cleanName, overwritten });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    // 删除用户模板
    router.delete('/user/:id', async (req, res) => {
        try {
            const id = String(req.params.id || '');
            if (!id || sanitizeTemplateId(id) !== id) {
                return res.status(400).json({ status: 'error', message: '模板 id 不合法' });
            }
            const file = path.join(userDir, id + '.json');
            if (path.resolve(file).startsWith(path.resolve(rootDir) + path.sep) === false) {
                return res.status(400).json({ status: 'error', message: '模板 id 不合法' });
            }
            try {
                await fs.unlink(file);
            } catch {
                return res.status(404).json({ status: 'error', message: '模板不存在' });
            }
            res.json({ status: 'ok' });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });

    return router;
}

module.exports = createMangaTemplatesRouter;

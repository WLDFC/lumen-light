/**
 * ==========================================================================
 * LumenLight 网页桥接：站点适配器注册表（index）
 * ==========================================================================
 * 作用：收集全部站点适配器并提供查询。新增站点 = 新建适配器文件 +
 *       在下方 ADAPTERS 数组登记一项，设置界面与面板下拉自动出现。
 *
 * ready: false 表示"框架就绪、适配器尚未校准"——设置界面可见但置灰，
 * 面板不可选；首个目标站点（豆包）跑通后按同一契约逐站补齐。
 * ==========================================================================
 */

const doubao = require('./doubao');
const chatgpt = require('./chatgpt');
const gemini = require('./gemini');

/** 全部站点适配器（顺序即设置界面/下拉的展示顺序） */
const ADAPTERS = [
    doubao,
    chatgpt,
    gemini
    // 后续按 base.js 契约追加：chatglm……
];

/** 全部站点的展示清单（设置界面/面板下拉数据源） */
function listSites() {
    return ADAPTERS.map(({ id, name, homeUrl, ready }) => ({ id, name, homeUrl, ready: ready !== false }));
}

/** 按 id 取适配器；未登记返回 null */
function getAdapter(id) {
    return ADAPTERS.find((a) => a.id === id) || null;
}

module.exports = { listSites, getAdapter };

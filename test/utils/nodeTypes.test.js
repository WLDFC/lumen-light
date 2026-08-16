/**
 * ==========================================================================
 * NodeTypes 单元测试
 * 覆盖类型谓词集合的归属：面板节点、端口节点、生图节点、真实画布图片。
 * 被测文件是浏览器端经典脚本（顶层 const/class 依赖全局词法作用域，
 * require() 会把它们变成模块私有），这里用 vm 模块在同一个上下文中执行。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: {} };
vm.createContext(context);

const source = fs.readFileSync(
    path.join(__dirname, '../../js/utils/NodeTypes.js'), 'utf-8');
vm.runInContext(source, context, { filename: 'NodeTypes.js' });

const NT = context.window.NodeTypes;

describe('NodeTypes 谓词集合', () => {
    test('SOURCE 常量与既有画布对象 source 值保持一致（存档兼容）', () => {
        expect(NT.SOURCE.PROMPT_NODE).toBe('prompt-node');
        expect(NT.SOURCE.TEXT_NODE).toBe('text-node');
        expect(NT.SOURCE.IMAGE_GEN_NODE).toBe('image-gen-node');
        expect(NT.SOURCE.COMFY_GEN_NODE).toBe('comfy-gen-node');
        expect(NT.SOURCE.GENERATION_PLACEHOLDER).toBe('generation-placeholder');
    });

    test('isPanelNode 覆盖四类面板节点，排除图片与占位图', () => {
        expect(NT.isPanelNode(NT.SOURCE.PROMPT_NODE)).toBe(true);
        expect(NT.isPanelNode(NT.SOURCE.TEXT_NODE)).toBe(true);
        expect(NT.isPanelNode(NT.SOURCE.IMAGE_GEN_NODE)).toBe(true);
        expect(NT.isPanelNode(NT.SOURCE.COMFY_GEN_NODE)).toBe(true);
        expect(NT.isPanelNode('comfy')).toBe(false);
        expect(NT.isPanelNode('upscale')).toBe(false);
        expect(NT.isPanelNode(NT.SOURCE.GENERATION_PLACEHOLDER)).toBe(false);
        expect(NT.isPanelNode(undefined)).toBe(false);
    });

    test('isGenNode 只认两类生图节点', () => {
        expect(NT.isGenNode(NT.SOURCE.IMAGE_GEN_NODE)).toBe(true);
        expect(NT.isGenNode(NT.SOURCE.COMFY_GEN_NODE)).toBe(true);
        expect(NT.isGenNode(NT.SOURCE.PROMPT_NODE)).toBe(false);
        expect(NT.isGenNode('comfy')).toBe(false);
    });

    test('hasDomPorts 含提示词与生图节点，不含文本节点', () => {
        expect(NT.hasDomPorts(NT.SOURCE.PROMPT_NODE)).toBe(true);
        expect(NT.hasDomPorts(NT.SOURCE.IMAGE_GEN_NODE)).toBe(true);
        expect(NT.hasDomPorts(NT.SOURCE.COMFY_GEN_NODE)).toBe(true);
        expect(NT.hasDomPorts(NT.SOURCE.TEXT_NODE)).toBe(false);
        expect(NT.hasDomPorts('comfy')).toBe(false);
    });

    test('isRealCanvasImage：有图像数据的非节点非占位图对象', () => {
        const realImage = { img: { src: 'save/x.png' }, source: 'comfy' };
        expect(NT.isRealCanvasImage(realImage)).toBe(true);

        // 无图像数据的对象（面板节点）不可作为内容图片
        expect(NT.isRealCanvasImage({ img: null, source: NT.SOURCE.IMAGE_GEN_NODE })).toBe(false);
        expect(NT.isRealCanvasImage({ img: { src: 'x' }, source: NT.SOURCE.PROMPT_NODE })).toBe(false);
        // 占位图不可作为内容图片
        expect(NT.isRealCanvasImage({ img: { src: 'x' }, source: NT.SOURCE.GENERATION_PLACEHOLDER })).toBe(false);
        // 防御：空值与缺字段
        expect(NT.isRealCanvasImage(null)).toBe(false);
        expect(NT.isRealCanvasImage({ source: 'comfy' })).toBe(false);
        expect(NT.isRealCanvasImage({ img: {}, source: 'comfy' })).toBe(false);
    });
});

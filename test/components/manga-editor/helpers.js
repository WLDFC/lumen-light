/**
 * ==========================================================================
 * MangaEditor 测试共享装载层（2026-11-09 自 mangaEditor.test.js 拆分）
 * 作用：vm 同载主类 + 独立类 + 全部混入（加载顺序同 index.html），
 *       提供 context 桩（localStorage/fetch/document 由各测试按需覆盖）、
 *       MangaEditor/CoordinateLayout 引用与 makeInstance 工厂。
 * 每个分册测试文件 require 本文件——各自拿到全新 context，互不串扰。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = {
    console,
    window: {},
    // localStorage 桩：模型优先级链测试用（组件方法运行时读取）
    localStorage: {
        _s: {},
        getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
        setItem(k, v) { this._s[k] = String(v); },
        removeItem(k) { delete this._s[k]; }
    }
};
// 真实定时器常驻注入（组件防抖逻辑依赖；套件级桩覆盖后恢复到这里）
context.setTimeout = setTimeout;
context.clearTimeout = clearTimeout;
context.setInterval = setInterval;
context.clearInterval = clearInterval;
context.AbortController = AbortController;   // API 直连生成路径 new AbortController
// Image 桩：src 赋值即异步 onload（生成落图层路径要读结果图尺寸）；
// complete=true 供橡皮烘焙路径的就绪校验（真实 Image 加载完成后同为 true）
context.Image = class {
    constructor() { this.naturalWidth = 100; this.naturalHeight = 100; this.complete = true; }
    set src(v) { this._src = v; queueMicrotask(() => this.onload && this.onload()); }
    get src() { return this._src; }
};
vm.createContext(context);
// ImageData 最小 polyfill：MangaAdjustTool._processPipeline 在 vm 内构造
// 处理结果（Node 无浏览器 ImageData，测试断言从 Node 侧读 .data）
context.ImageData = class {
    constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
// rAF 最小桩：MangaAdjustTool 的预览节流/收尾清理引用（测试不走真帧调度）
context.requestAnimationFrame = () => 0;
context.cancelAnimationFrame = () => {};
// Path2D 最小桩：ShapeLayout.drawShapeContent 统一绘制原语内部构建路径
// 用（舞台渲染测试会经由 _drawShapeContent 命中）；路径方法全 no-op
context.Path2D = class {
    moveTo() {} lineTo() {} closePath() {}
    rect() {} ellipse() {} arcTo() {} quadraticCurveTo() {}
};
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../../js/components/MangaEditor.js'), 'utf-8'),
    context, { filename: 'MangaEditor.js' });
// 调色工具独立类（ADR 074）：主类构造器实例化消费，随主类加载
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../../js/components/manga-editor/MangaAdjustTool.js'), 'utf-8'),
    context, { filename: 'MangaAdjustTool.js' });
// 移除工具独立类（ADR 076）：主类构造器实例化消费，随主类加载
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../../js/components/manga-editor/MangaRemoveTool.js'), 'utf-8'),
    context, { filename: 'MangaRemoveTool.js' });
// 画布节点类型谓词（ADR 075 文件菜单过滤画布真实图片用）
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../../js/utils/NodeTypes.js'), 'utf-8'),
    context, { filename: 'NodeTypes.js' });
// 文字层共享纯函数层（ADR 067）：MangaText 委托消费，先于混入装载
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../../js/utils/TextLayout.js'), 'utf-8'),
    context, { filename: 'TextLayout.js' });
// 形状几何共享纯函数层（ADR 069）：MangaShape 委托消费，先于混入装载
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../../js/utils/ShapeLayout.js'), 'utf-8'),
    context, { filename: 'ShapeLayout.js' });
// 色板取色器共享预制件（ADR 068）：MangaTools setColor/pushRecentColor 消费
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../../js/components/LumenColorPicker.js'), 'utf-8'),
    context, { filename: 'LumenColorPicker.js' });
// 子模块混入文件同载（须后于主类——Object.assign 进 MangaEditor.prototype）
for (const f of ['MangaDom.js', 'MangaPanel.js', 'MangaStage.js', 'MangaGestures.js',
    'MangaTools.js', 'MangaLayers.js', 'MangaPageRender.js', 'MangaLayerPanel.js',
    'MangaHistory.js', 'MangaDraftStore.js', 'MangaAi.js',
    'MangaTemplates.js', 'MangaTemplateDetect.js', 'MangaPages.js', 'MangaGenerate.js', 'MangaText.js',
    'MangaShape.js', 'MangaProjects.js']) {
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, '../../../js/components/manga-editor/', f), 'utf-8'),
        context, { filename: f });
}
// CoordinateLayout 一并加载进同一上下文（景别剥离后的编译断言用；
// 组件运行时消费它，测试环境同样供给）
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../../js/utils/CoordinateLayout.js'), 'utf-8'),
    context, { filename: 'CoordinateLayout.js' });
const MangaEditor = context.window.MangaEditor;
const CoordinateLayout = context.window.CoordinateLayout;

/** 造一个绕开 DOM 的实例：只接纯逻辑方法，渲染/状态方法打桩 */
function makeInstance(items) {
    const inst = Object.create(MangaEditor.prototype);
    inst.draft = {
        width: 1024, height: 1024,
        bbox_coord_space: 'abs', bbox_format: 'xyxy',
        summary: { caption: '', canvas: 'single' },
        items: items.map((it) => ({ ...it }))
    };
    inst._undoStack = [];   // 景别/合并路径会入账历史
    inst._redoStack = [];
    inst.statusCalls = [];
    inst._status = (text, isError) => inst.statusCalls.push({ text, isError });
    inst._invalidateCompiled = () => {};
    inst._renderAll = () => {};
    inst._renderStage = () => {};
    return inst;
}

module.exports = { context, MangaEditor, CoordinateLayout, makeInstance };

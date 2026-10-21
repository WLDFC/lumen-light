/**
 * ==========================================================================
 * CanvasConnections 单元测试
 * 覆盖连线添加规则：生图节点单入替换、提示词节点多入、同对去重与非法连线。
 * 被测文件是浏览器端经典脚本（顶层 const/class 依赖全局词法作用域，
 * require() 会把它们变成模块私有），这里用 vm 模块在同一个上下文中
 * 按浏览器加载顺序执行源码，模拟 script 标签的加载行为。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: {} };
vm.createContext(context);

[
    '../../js/config.js',
    '../../js/utils/NodeTypes.js',
    '../../js/canvas/CanvasConnections.js'
].forEach((file) => {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf-8');
    vm.runInContext(source, context, { filename: file });
});

const CanvasConnections = context.window.CanvasConnections;

/** 构造测试用画布对象（只含 add/isValidLink 所需的字段） */
function makeCanvas(objects) {
    return {
        images: { images: objects, selectedIds: new Set() },
        viewport: { scale: 1 }
    };
}

// 测试对象：两个提示词节点、一个图片、一个 LLM 生图节点、一个 Comfy 生图节点
const OBJECTS = [
    { id: 'p1', source: 'prompt-node' },
    { id: 'p2', source: 'prompt-node' },
    { id: 'img1', source: 'comfy' },
    { id: 'gen', source: 'image-gen-node' },
    { id: 'cgen', source: 'comfy-gen-node' }
];

describe('CanvasConnections.add 生图节点单入替换', () => {
    test('第二个提示词节点连入生图节点时静默替换第一条连线', () => {
        const cc = new CanvasConnections(makeCanvas(OBJECTS));
        const first = cc.add('p1', 'cgen');
        expect(first).not.toBeNull();

        const second = cc.add('p2', 'cgen');
        expect(second).not.toBeNull();

        // 只保留最新连线：p1→cgen 被移除，p2→cgen 存在
        const toGen = cc.connections.filter(c => c.toId === 'cgen');
        expect(toGen).toHaveLength(1);
        expect(toGen[0].fromId).toBe('p2');
        expect(cc.connections).toHaveLength(1);
    });

    test('LLM 生图节点与 Comfy 生图节点规则一致', () => {
        const cc = new CanvasConnections(makeCanvas(OBJECTS));
        cc.add('p1', 'gen');
        cc.add('p2', 'gen');

        const toGen = cc.connections.filter(c => c.toId === 'gen');
        expect(toGen).toHaveLength(1);
        expect(toGen[0].fromId).toBe('p2');
    });

    test('重拖同一条连线视为无效操作，原线保持不变', () => {
        const cc = new CanvasConnections(makeCanvas(OBJECTS));
        const first = cc.add('p1', 'cgen');
        const again = cc.add('p1', 'cgen');

        expect(again).toBeNull();
        expect(cc.connections).toHaveLength(1);
        expect(cc.connections[0].id).toBe(first.id);   // 原线未被重建
    });

    test('替换只清生图节点入线，不影响链上的其他连线', () => {
        const cc = new CanvasConnections(makeCanvas(OBJECTS));
        cc.add('p1', 'p2');          // p1 → p2 串链
        cc.add('p2', 'cgen');        // 链尾接入 Comfy 生图节点
        cc.add('p1', 'cgen');        // p1 直连生图节点 → 应替换掉 p2→cgen

        // p1→p2 链线保留；cgen 入线换成 p1
        expect(cc.connections.some(c => c.fromId === 'p1' && c.toId === 'p2')).toBe(true);
        const toGen = cc.connections.filter(c => c.toId === 'cgen');
        expect(toGen).toHaveLength(1);
        expect(toGen[0].fromId).toBe('p1');
    });
});

describe('CanvasConnections.add 既有规则不回归', () => {
    test('提示词节点多入不受替换规则影响', () => {
        const cc = new CanvasConnections(makeCanvas(OBJECTS));
        cc.add('p1', 'p2');
        const second = cc.add('img1', 'p2');   // 图片连入提示词节点作参考素材

        expect(second).not.toBeNull();
        expect(cc.connections.filter(c => c.toId === 'p2')).toHaveLength(2);
    });

    test('图片连入生图节点仍被禁止', () => {
        const cc = new CanvasConnections(makeCanvas(OBJECTS));
        expect(cc.add('img1', 'cgen')).toBeNull();
        expect(cc.add('img1', 'gen')).toBeNull();
    });

    test('非法连线（占位图等）仍被拒绝', () => {
        const objects = OBJECTS.concat([{ id: 'ph', source: 'generation-placeholder' }]);
        const cc = new CanvasConnections(makeCanvas(objects));
        expect(cc.add('ph', 'cgen')).toBeNull();
    });
});

describe('CanvasConnections.hitTest 采样折线命中', () => {
    // 水平长曲线：锚点 (100,50)→(1000,50)（两端图片各 100×100）
    const makeHitCanvas = () => makeCanvas([
        { id: 'a', source: 'comfy', x: 0, y: 0, width: 100, height: 100 },
        { id: 'b', source: 'comfy', x: 1000, y: 0, width: 100, height: 100 }
    ]);
    const makeHitConnections = () => {
        const cc = new CanvasConnections(makeHitCanvas());
        cc.add('a', 'b');
        return cc;
    };

    test('长曲线两个采样点之间的位置也能命中（无采样盲区）', () => {
        const cc = makeHitConnections();
        expect(cc.connections).toHaveLength(1);
        // 点取在旧 24 点采样的两采样点正中（间隔 37.5px）、偏离曲线 5px：
        // 旧的按采样点判距约 19px 超容差点不到，按折线段判距=5px 命中
        expect(cc.hitTest(568.75, 55)).not.toBeNull();
    });

    test('远离曲线的坐标不误命中', () => {
        const cc = makeHitConnections();
        expect(cc.hitTest(568.75, 70)).toBeNull();
    });
});

describe('CanvasConnections API 视频节点连线规则', () => {
    // 视频节点 + 提示词节点 + 图片 + LoRA 节点的混合画布
    const makeVideoCanvas = () => makeCanvas([
        { id: 'v', source: 'video-gen-node' },
        { id: 'p1', source: 'prompt-node' },
        { id: 'img1', source: 'comfy' },
        { id: 'lora1', source: 'lora-node' }
    ]);

    test('提示词节点可连入视频节点（文生视频）', () => {
        const cc = new CanvasConnections(makeVideoCanvas());
        expect(cc.add('p1', 'v')).not.toBeNull();
    });

    test('图片直连视频节点被拒：首帧图必须先连入提示词节点', () => {
        const cc = new CanvasConnections(makeVideoCanvas());
        expect(cc.add('img1', 'v')).toBeNull();
        // LoRA 连入与 LoRA→API 生图同规则放行（文本透传语义，无害）
        expect(cc.add('lora1', 'v')).not.toBeNull();
    });

    test('视频节点单入：新入线静默替换旧入线', () => {
        const cc = new CanvasConnections(makeVideoCanvas());
        expect(cc.add('p1', 'v')).not.toBeNull();
        expect(cc.add('img1', 'p1')).not.toBeNull();   // 图片连提示词节点作首帧素材
        expect(cc.add('img1', 'v')).toBeNull();        // 直连仍被拒
        const ins = cc.connections.filter((c) => c.toId === 'v');
        expect(ins).toHaveLength(1);
        expect(ins[0].fromId).toBe('p1');
    });

    test('视频节点无输出端口，不能作为连线起点', () => {
        const cc = new CanvasConnections(makeVideoCanvas());
        expect(cc.add('v', 'p1')).toBeNull();
    });
});

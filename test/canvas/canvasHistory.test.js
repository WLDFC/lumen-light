/**
 * ==========================================================================
 * CanvasHistory 单元测试
 * 覆盖命令栈纪律：undo/redo 步进、新操作截断重做分支（淘汰回调）、
 * 上限淘汰、clear 全量淘汰、撤销执行期间的记账抑制、连线命令的
 * id 映射换算（节点重建后旧连线恢复指向新 id）。
 * 被测文件是浏览器端经典脚本（依赖全局 window/document），用 vm 模块
 * 在同一上下文中执行源码，模拟 script 标签的加载行为（同
 * imageProxyCache.test.js 的模式）。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** 加载 CanvasHistory.js 到隔离沙箱，返回 { CanvasHistory, sandbox } */
function loadHistory() {
    const sandbox = {
        console,
        // 最小 window/document 桩：栈逻辑只用到事件派发、createElement 与定时器
        CustomEvent: class CustomEvent {
            constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; }
        },
        window: {
            dispatchEvent: jest.fn()
        },
        document: {
            createElement: () => ({
                style: {}, classList: { add() {}, remove() {} },
                appendChild() {}, remove() {}, addEventListener() {}
            }),
            body: { appendChild() {} }
        },
        setTimeout: () => 0,
        clearTimeout: () => {},
        NodeTypes: {
            SOURCE: { PROMPT_NODE: 'prompt-node' },
            isPanelNode: () => false,
            isVideo: () => false,
            isAudio: () => false
        }
    };
    vm.createContext(sandbox);
    const src = fs.readFileSync(
        path.join(__dirname, '../../js/canvas/CanvasHistory.js'), 'utf-8');
    vm.runInContext(src, sandbox);
    return sandbox;
}

/** 造一个计数命令（do/undo/redo 各自翻转 flag，淘汰时记 onEvicted） */
function makeCmd(id, state) {
    return {
        label: 'cmd-' + id,
        undo: () => { state.log.push('undo:' + id); },
        redo: () => { state.log.push('redo:' + id); },
        onEvict: () => { state.evicted.push(id); }
    };
}

describe('CanvasHistory 栈纪律', () => {
    let sandbox;
    let H;                                   // vm 沙箱里的 CanvasHistory 类
    beforeEach(() => {
        sandbox = loadHistory();
        H = sandbox.window.CanvasHistory;    // class 声明经 window 挂载暴露
    });

    test('undo/redo 按 LIFO 步进，canUndo/canRedo 随之翻转', () => {
        const h = new H({ draw() {} });
        const state = { log: [], evicted: [] };
        expect(h.canUndo).toBe(false);
        expect(h.undo()).toBe(false);

        h.push(makeCmd('a', state));
        h.push(makeCmd('b', state));
        expect(h.canUndo).toBe(true);
        expect(h.canRedo).toBe(false);

        expect(h.undo()).toBe(true);
        expect(state.log).toEqual(['undo:b']);
        expect(h.canRedo).toBe(true);

        expect(h.redo()).toBe(true);
        expect(state.log).toEqual(['undo:b', 'redo:b']);
        expect(h.canRedo).toBe(false);

        expect(h.undo()).toBe(true);          // undo:b
        expect(h.undo()).toBe(true);          // undo:a
        expect(h.undo()).toBe(false);         // 栈空
        expect(state.log).toEqual(['undo:b', 'redo:b', 'undo:b', 'undo:a']);
    });

    test('撤销后压入新操作：重做分支被截断且被截断命令立即淘汰', () => {
        const h = new H({ draw() {} });
        const s1 = { log: [], evicted: [] };
        const s2 = { log: [], evicted: [] };
        h.push(makeCmd('a', s1));
        h.push(makeCmd('b', s1));
        h.undo();                              // 重做分支里有 b
        expect(h.canRedo).toBe(true);

        h.push(makeCmd('c', s2));              // 截断 → b 淘汰
        expect(h.canRedo).toBe(false);
        expect(s1.evicted).toEqual(['b']);
        expect(s2.evicted).toEqual([]);
    });

    test('超过栈上限时最旧命令被淘汰并触发回调', () => {
        H.MAX = 3;         // 测试用小上限
        const h = new H({ draw() {} });
        const seen = {};
        for (const id of ['a', 'b', 'c', 'd']) {
            seen[id] = { log: [], evicted: [] };
            h.push(makeCmd(id, seen[id]));
        }
        expect(h._undoStack).toHaveLength(3);
        expect(seen.a.evicted).toEqual(['a']); // a 被挤掉
        expect(seen.d.evicted).toEqual([]);
        // 撤销三步后栈空，只能退到 b
        h.undo(); h.undo(); h.undo();
        expect(h.canUndo).toBe(false);
    });

    test('clear() 全量淘汰并触发各命令回调', () => {
        const h = new H({ draw() {} });
        const s = { log: [], evicted: [] };
        h.push(makeCmd('a', s));
        h.push(makeCmd('b', s));
        h.undo();
        h.clear();
        expect(h.canUndo).toBe(false);
        expect(h.canRedo).toBe(false);
        expect(s.evicted.sort()).toEqual(['a', 'b']);
    });

    test('撤销执行期间压入被抑制（命令的 undo 内触发 push 不入栈）', () => {
        const h = new H({ draw() {} });
        const inner = { log: [], evicted: [] };
        h.push({
            label: 'outer',
            undo: () => h.push(makeCmd('inner', inner)),   // 撤销动作里试图记账
            redo: () => {}
        });
        h.undo();
        // inner 未入栈：撤销后栈里只剩 redo 分支中的 outer
        expect(h._undoStack).toHaveLength(0);
        expect(h._redoStack.map(c => c.label)).toEqual(['outer']);
        h.redo();
        // redo 执行期间同样抑制（outer.redo 未 push）
        expect(h._undoStack.map(c => c.label)).toEqual(['outer']);
    });

    test('视频淘汰接线：携带 videoUrls 的命令淘汰时逐个回调', () => {
        const h = new H({ draw() {} });
        const flushed = [];
        h.onFlushVideoFile = (url) => flushed.push(url);
        const cmd = {
            label: '删除', videoUrls: ['data/videos/a.mp4', 'data/videos/b.mp4'],
            undo() {}, redo() {},
            onEvict() { for (const url of cmd.videoUrls) h.onFlushVideoFile(url); }
        };
        h.push(cmd);
        h.undo();
        h.push({ label: '新操作', undo() {}, redo() {} });   // 截断 → 淘汰 cmd
        expect(flushed).toEqual(['data/videos/a.mp4', 'data/videos/b.mp4']);
    });

    test('连线命令执行期换算 id：节点重建映射后 redo 指向新 id', () => {
        const canvas = {
            draw() {},
            connections: { connections: [] }
        };
        const connList = () => canvas.connections.connections;
        const h = new H(canvas);
        h.recordConnectionAdd({ id: 'c1', fromId: 'imgA', toId: 'oldGen', order: 0 }, []);
        expect(connList()).toHaveLength(0);     // record 只记账不执行

        h.undo();                               // 撤销 = 移除（本就不在）
        expect(connList()).toHaveLength(0);
        h.redo();                               // 重做 = 放回（无映射，原 id）
        expect(connList()).toEqual([{ id: 'c1', fromId: 'imgA', toId: 'oldGen', order: 0 }]);

        h.undo();
        h._idRemap.set('oldGen', 'newGen');     // 模拟节点重建后的 id 映射
        h.redo();
        expect(connList()[0].toId).toBe('newGen'); // 重做时经映射指向新 id
    });

    test('recordConnectionAdd 的替换语义：undo 还原被挤掉的旧边，redo 再挤掉', () => {
        const canvas = { draw() {}, connections: { connections: [] } };
        const h = new H(canvas);
        const connList = () => canvas.connections.connections;
        const oldEdge = { id: 'old', fromId: 'B', toId: 'gen', order: 0 };
        const newConn = { id: 'new', fromId: 'A', toId: 'gen', order: 0 };
        // 模拟 add 的执行结果：旧边被挤掉、新边进入
        connList().push(newConn);
        h.recordConnectionAdd(newConn, [oldEdge]);

        h.undo();
        expect(connList()).toEqual([oldEdge]);              // 旧边还原
        h.redo();
        expect(connList()).toEqual([newConn]);              // 新边回到位
    });
});

describe('CanvasHistory.deleteObjects 画布图片删除联动事件（2026-11-04）', () => {
    /** 造带三张图的画布桩：images/connections/groups 最小契约 */
    function makeDeleteCanvas() {
        const imgs = [
            { id: 'img-a', source: 'http://x/a' },
            { id: 'img-b', source: 'http://x/b' }
        ];
        const canvas = {
            images: { images: imgs, selectedIds: new Set(), select() {} },
            connections: { connections: [] },
            groups: { groups: [], delete() {}, clearSelection() {} },
            draw() {}
        };
        return { canvas, imgs };
    }

    test('删除图片派发 lumenCanvasImageDeleted（detail.objs=被删的非节点对象）', () => {
        const sandbox = loadHistory();
        const { canvas, imgs } = makeDeleteCanvas();
        const target = imgs[0];   // 先留引用：deleteObjects 会把 imgs 数组 splice 掉
        const h = new sandbox.window.CanvasHistory(canvas);
        const ok = h.deleteObjects([target], [], { label: '删除' });
        expect(ok).toBe(true);
        expect(canvas.images.images).toEqual([imgs[0]]);   // 剩 img-b（原引用已前移）
        const types = sandbox.window.dispatchEvent.mock.calls.map((c) => c[0].type);
        expect(types).toContain('lumenCanvasImageDeleted');
        const ev = sandbox.window.dispatchEvent.mock.calls
            .map((c) => c[0]).find((e) => e.type === 'lumenCanvasImageDeleted');
        expect(ev.detail.objs).toEqual([target]);
    });

    test('剪切（fileCleanup:skip）跳过联动派发——图还要粘回来', () => {
        const sandbox = loadHistory();
        const { canvas, imgs } = makeDeleteCanvas();
        const h = new sandbox.window.CanvasHistory(canvas);
        const ok = h.deleteObjects([imgs[1]], [], { label: '剪切', fileCleanup: 'skip' });
        expect(ok).toBe(true);
        expect(canvas.images.images).toEqual([imgs[0]]);
        const types = sandbox.window.dispatchEvent.mock.calls.map((c) => c[0].type);
        expect(types).not.toContain('lumenCanvasImageDeleted');   // push 的 canvasHistoryChanged 无妨
    });

    test('面板节点删除不派发（联动只针对真实图片对象）', () => {
        const sandbox = loadHistory();
        const { canvas } = makeDeleteCanvas();
        const node = { id: 'node-1', source: 'panel-node', toJSON: () => ({ id: 'node-1' }), destroy() {} };
        const h = new sandbox.window.CanvasHistory(canvas);
        h.deleteObjects([node], [], { label: '删除' });
        const types = sandbox.window.dispatchEvent.mock.calls.map((c) => c[0].type);
        expect(types).not.toContain('lumenCanvasImageDeleted');
    });
});

/**
 * ==========================================================================
 * BookmarkNode 单元测试
 * 覆盖书签节点静态纯函数 collectShortcutAssignments 的快捷键分配契约：
 *   - 数字键 1-9、0 共 10 个名额，按 groups 数组顺序先到先得
 *   - 按组 id 全局去重（数字键属于组而非节点，多书签节点不重复分配）
 *   - 名额用尽后剩余组仅图标跳转（不进分配表）
 *   - 组删除后编号前移补位（分配实时按存活组派生）
 * 以及 NodeTypes 类型归属（isPanelNode / hasDomPorts）。
 * 被测文件是浏览器端经典脚本（依赖全局词法作用域），与 groupManager
 * 测试同款做法：用 vm 模块按浏览器加载顺序执行源码。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = {
    console,
    window: {}
};
vm.createContext(context);

[
    '../../js/utils/NodeTypes.js',
    '../../js/canvas/nodes/BaseCanvasNode.js',
    '../../js/canvas/nodes/BookmarkNode.js'
].forEach((file) => {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf-8');
    vm.runInContext(source, context, { filename: file });
});

const BookmarkNode = context.window.BookmarkNode;
const NodeTypes = context.window.NodeTypes;

/** 构造书签节点桩（静态分配只消费 source 与 seqId） */
function makeNode(seqId) {
    return { source: NodeTypes.SOURCE.BOOKMARK_NODE, seqId };
}

/** 构造测试用画布对象（只含 collectShortcutAssignments 所需字段） */
function makeCanvas(nodes = [], groups = []) {
    return {
        images: { images: nodes },
        groups: { groups }
    };
}

/** 构造组桩（只需 id/title，跳转目标几何不进分配逻辑） */
function makeGroup(id, title) {
    return { id, title: title || ('组' + id), type: 'group' };
}

describe('NodeTypes 类型归属', () => {
    test('书签节点归入 isPanelNode，无端口不入 hasDomPorts', () => {
        expect(NodeTypes.isBookmarkNode('bookmark-node')).toBe(true);
        expect(NodeTypes.isPanelNode('bookmark-node')).toBe(true);
        expect(NodeTypes.hasDomPorts('bookmark-node')).toBe(false);
        expect(NodeTypes.isGenNode('bookmark-node')).toBe(false);
    });
});

describe('collectShortcutAssignments 快捷键分配', () => {
    test('单节点：组按数组顺序分配 1-9、0，10 个封顶', () => {
        const groups = Array.from({ length: 12 }, (_, i) => makeGroup('g' + i));
        const canvas = makeCanvas([makeNode(1)], groups);
        const map = BookmarkNode.collectShortcutAssignments(canvas);

        expect(map.size).toBe(10);   // 名额封顶，第 11、12 组仅图标跳转
        const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
        digits.forEach((digit, i) => {
            expect(map.get(digit).group.id).toBe('g' + i);
        });
        // 超出名额的组不出现在任何数字键下
        expect([...map.values()].some((h) => h.group.id === 'g10')).toBe(false);
    });

    test('多节点按组 id 去重：同一组只占一个名额，不重复分配', () => {
        const groups = [makeGroup('a'), makeGroup('b'), makeGroup('c')];
        const canvas = makeCanvas([makeNode(1), makeNode(2)], groups);
        const map = BookmarkNode.collectShortcutAssignments(canvas);

        expect(map.size).toBe(3);   // 3 组 3 个键，第二个节点不复制条目
        const assignedIds = [...map.values()].map((h) => h.group.id);
        expect(new Set(assignedIds).size).toBe(3);
    });

    test('组删除后编号前移补位（实时按存活组派生）', () => {
        const groups = [makeGroup('a'), makeGroup('b'), makeGroup('c')];
        const canvas = makeCanvas([makeNode(1)], groups);
        // 删除中间组（b）后重新分配
        canvas.groups.groups = [groups[0], groups[2]];
        const map = BookmarkNode.collectShortcutAssignments(canvas);

        expect(map.get('1').group.id).toBe('a');
        expect(map.get('2').group.id).toBe('c');   // c 前移补位到 2
        expect(map.has('3')).toBe(false);
    });

    test('无书签节点时不分配（数字键不拦截）', () => {
        const groups = [makeGroup('a')];
        const canvas = makeCanvas([], groups);
        expect(BookmarkNode.collectShortcutAssignments(canvas).size).toBe(0);
    });

    test('无组时分配表为空', () => {
        const canvas = makeCanvas([makeNode(1)], []);
        expect(BookmarkNode.collectShortcutAssignments(canvas).size).toBe(0);
    });
});

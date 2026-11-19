/**
 * history 测试（2026-11-09 自 mangaEditor.test.js 按模块拆分）
 * 覆盖：MangaEditor 撤销/重做（快照式，ADR 017 决策十一）
 */

const { context, MangaEditor, CoordinateLayout, makeInstance } = require('./helpers');

describe('MangaEditor 撤销/重做（快照式，ADR 017 决策十一）', () => {
    const realSetTimeout = global.setTimeout;

    function makeHistInst() {
        const inst = Object.create(MangaEditor.prototype);
        inst.draft = {
            width: 1024, height: 1024,
            bbox_coord_space: 'abs', bbox_format: 'xyxy',
            summary: { caption: '', canvas: 'single' },
            items: [{ label: 'object', caption: 'A cup.', bbox: [64, 64, 512, 512] }]
        };
        inst.selected = -1;
        inst._clickBurst = null;
        inst._undoStack = [];
        inst._redoStack = [];
        inst._textHistPending = null;
        inst._histTimer = null;
        inst.statusCalls = [];
        inst._status = (text, isError) => inst.statusCalls.push({ text, isError });
        inst.renderCalls = 0;
        inst._renderAll = () => { inst.renderCalls++; };
        inst._renderItems = () => { inst.renderCalls++; };
        inst._renderStage = () => {};
        inst._scheduleSave = () => {};
        inst.compiled = null;
        inst.copyBtn = { disabled: false };
        inst.aiOutTa = { value: '' };
        inst.jsonNote = { textContent: '' };
        inst._outMode = '';
        return inst;
    }

    test('commit→undo→redo 序列：草稿状态与选择往返', () => {
        const inst = makeHistInst();
        const before = inst._histSnapshot();
        inst.draft.items[0].caption = 'A teapot.';
        inst._commitHistory(before, '输入文案');
        expect(inst._undoStack).toHaveLength(1);
        expect(inst._redoStack).toHaveLength(0);

        inst._undoHist();
        expect(inst.draft.items[0].caption).toBe('A cup.');
        expect(inst._undoStack).toHaveLength(0);
        expect(inst._redoStack).toHaveLength(1);
        expect(inst.statusCalls.at(-1).text).toContain('已撤销：输入文案');

        inst._redoHist();
        expect(inst.draft.items[0].caption).toBe('A teapot.');
        expect(inst._undoStack).toHaveLength(1);
        expect(inst.statusCalls.at(-1).text).toContain('已重做：输入文案');
    });

    test('空栈 undo/redo 提示不动；删了又改回原样不入账', () => {
        const inst = makeHistInst();
        inst._undoHist();
        expect(inst.statusCalls.at(-1).text).toContain('没有可撤销');
        expect(inst.renderCalls).toBe(0);
        const before = inst._histSnapshot();
        inst.draft.items[0].caption = 'x';
        inst.draft.items[0].caption = 'A cup.';
        inst._commitHistory(before, '输入文案');
        expect(inst._undoStack).toHaveLength(0);   // 与当前相同：跳过
    });

    test('commit 截断重做分支；超过 50 步裁剪最旧', () => {
        const inst = makeHistInst();
        const before = inst._histSnapshot();
        inst.draft.items[0].caption = 'v1';
        inst._commitHistory(before, 'a');
        inst._undoHist();
        expect(inst._redoStack).toHaveLength(1);
        const before2 = inst._histSnapshot();
        inst.draft.items[0].caption = 'v2';
        inst._commitHistory(before2, 'b');
        expect(inst._redoStack).toHaveLength(0);   // 新操作截断重做

        for (let i = 0; i < 60; i++) {
            const b = inst._histSnapshot();
            inst.draft.items[0].caption = `step-${i}`;
            inst._commitHistory(b, `s${i}`);
        }
        expect(inst._undoStack).toHaveLength(50);
        expect(inst._undoStack[0].label).toBe('s10');   // 最旧 10 步被裁
    });

    test('undo 后自动保存同步回滚（_invalidateCompiled 触发）', () => {
        const inst = makeHistInst();
        let invalidateCount = 0;
        inst._invalidateCompiled = () => { invalidateCount++; };
        const before = inst._histSnapshot();
        inst.draft.items[0].caption = 'changed';
        inst._commitHistory(before, '输入文案');
        inst._undoHist();
        expect(invalidateCount).toBe(1);   // 撤销即标脏 → 防抖自动保存回滚落盘
    });

    test('文本输入合并：input 首字符挂 pending、防抖到期一步入账', async () => {
        const inst = makeHistInst();
        inst._beginTextInputHist();
        expect(inst._textHistPending).not.toBeNull();
        expect(inst._undoStack).toHaveLength(0);   // 窗口内未入账
        inst.draft.summary.caption = 'poster';     // 连续输入复用同一 pending
        inst._beginTextInputHist();
        expect(inst._undoStack).toHaveLength(0);
        await new Promise((r) => realSetTimeout(r, 1100));
        expect(inst._undoStack).toHaveLength(1);   // 一步入账
        expect(inst._undoStack[0].label).toBe('输入文案');
        expect(inst._textHistPending).toBeNull();
    });

    test('blur 立即结算挂起的文本合并', () => {
        const inst = makeHistInst();
        inst._beginTextInputHist();
        inst.draft.summary.caption = 'poster';
        inst._flushTextInputHist();
        expect(inst._undoStack).toHaveLength(1);
        expect(inst._textHistPending).toBeNull();
    });

    test('undo 前先结算文本挂起（LIFO：撤销的是栈顶文本而非更早的移动）', () => {
        const inst = makeHistInst();
        const before = inst._histSnapshot();
        inst.draft.items[0].caption = 'moved box';
        inst._commitHistory(before, '移动');
        inst._beginTextInputHist();
        inst.draft.summary.caption = 'poster';
        inst._undoHist();
        // 挂起的文本先入账成为栈顶，本次 undo 撤销的就是它
        expect(inst.draft.summary.caption).toBe('');
        expect(inst.draft.items[0].caption).toBe('moved box');   // 移动结果保留
        expect(inst.statusCalls.at(-1).text).toContain('已撤销：输入文案');
        // 再撤销一次 → 回到移动前
        inst._undoHist();
        expect(inst.draft.items[0].caption).toBe('A cup.');
        expect(inst.statusCalls.at(-1).text).toContain('已撤销：移动');
    });

    test('_histKeyOwns：焦点在弹窗/body 归编辑器，外部放行', () => {
        const inst = makeHistInst();
        inst.dialog = { contains: (t) => t === 'editor-el' };
        expect(inst._histKeyOwns('editor-el')).toBe(true);
        expect(inst._histKeyOwns(null)).toBe(true);
        expect(inst._histKeyOwns('llm-input')).toBe(false);   // 并排面板内放行
        inst.dialog = null;
        expect(inst._histKeyOwns('llm-input')).toBe(true);    // 无弹窗兜底接管
    });

    test('_resetHistory 清空栈与挂起（新建/恢复草稿的新基线）', () => {
        const inst = makeHistInst();
        inst._undoStack.push({ label: 'x', snap: {} });
        inst._beginTextInputHist();
        inst._resetHistory();
        expect(inst._undoStack).toHaveLength(0);
        expect(inst._redoStack).toHaveLength(0);
        expect(inst._textHistPending).toBeNull();
    });
});

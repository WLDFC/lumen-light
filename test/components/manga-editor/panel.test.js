/**
 * panel 测试（2026-11-09 自 mangaEditor.test.js 按模块拆分）
 * 覆盖：MangaPanel 分区级眼睛（全部元素框一键隐藏/显示，2026-11-07 用户拍板）
 */

const { context, MangaEditor, CoordinateLayout, makeInstance } = require('./helpers');

describe('MangaPanel 分区级眼睛（全部元素框一键隐藏/显示，2026-11-07 用户拍板）', () => {
    function makeItemsEyeInst(items) {
        const inst = Object.create(MangaEditor.prototype);
        inst.draft = {
            width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy',
            summary: { caption: '', canvas: 'single' }, items, drawLayers: []
        };
        inst.selected = -1;
        inst._hiddenCids = new Set();
        inst.itemsEl = { innerHTML: '' };
        inst.itemCountEl = { textContent: '' };
        inst.itemsEyeEl = { innerHTML: '', title: '', isOff: null, classList: { toggle(c, v) { inst.itemsEyeEl.isOff = v; } } };
        inst._renderStageCalls = 0;
        inst._renderStage = () => { inst._renderStageCalls++; };
        inst.renderItemsCalls = 0;
        inst._renderItems = () => { inst.renderItemsCalls++; inst._syncItemsEyeUi(); };
        return inst;
    }
    const mkItem = (cid) => ({ cid, label: 'object', caption: '', bbox: [0, 0, 10, 10] });

    test('_toggleAllItemsHidden：混合态全隐 → 再点全显（视图态不进编译）', () => {
        const inst = makeItemsEyeInst([mkItem(0), mkItem(1), mkItem(2)]);
        inst._hiddenCids.add(1);   // 混合态：单卡已隐一个
        inst._toggleAllItemsHidden();
        expect([...inst._hiddenCids].sort()).toEqual([0, 1, 2]);   // 全隐
        expect(inst.renderItemsCalls).toBe(1);
        expect(inst._renderStageCalls).toBe(1);
        inst._toggleAllItemsHidden();
        expect(inst._hiddenCids.size).toBe(0);                     // 全显
    });

    test('_syncItemsEyeUi：聚合态切图标（划线眼=全隐）与提示文案', () => {
        const inst = makeItemsEyeInst([mkItem(0), mkItem(1)]);
        inst._syncItemsEyeUi();
        expect(inst.itemsEyeEl.innerHTML).toContain('M1 12s4-8');          // 普通眼
        expect(inst.itemsEyeEl.title).toContain('隐藏全部');
        expect(inst.itemsEyeEl.isOff).toBe(false);

        inst._hiddenCids.add(0);
        inst._syncItemsEyeUi();                                            // 混合态仍算可见
        expect(inst.itemsEyeEl.innerHTML).toContain('M1 12s4-8');

        inst._hiddenCids.add(1);                                           // 全隐
        inst._syncItemsEyeUi();
        expect(inst.itemsEyeEl.innerHTML).toContain('x2="23" y2="23"');    // 划线眼
        expect(inst.itemsEyeEl.title).toContain('显示全部');
        expect(inst.itemsEyeEl.isOff).toBe(true);

        const empty = makeItemsEyeInst([]);                                // 空页不算全隐
        empty._syncItemsEyeUi();
        expect(empty.itemsEyeEl.innerHTML).toContain('M1 12s4-8');
    });
});

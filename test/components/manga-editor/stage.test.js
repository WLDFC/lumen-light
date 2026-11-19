/**
 * stage 测试（2026-11-09 自 mangaEditor.test.js 按模块拆分）
 * 覆盖：MangaEditor 舞台滚轮缩放（MangaStage）
 */

const { context, MangaEditor, CoordinateLayout, makeInstance } = require('./helpers');

describe('MangaEditor 舞台滚轮缩放（MangaStage）', () => {
    /** 舞台视口纯几何用实例：只接 _computeStageView/_zoomAt 依赖的最小字段 */
    function makeStageInst(stageW, stageH, draftW, draftH) {
        const inst = Object.create(MangaEditor.prototype);
        inst.draft = { width: draftW, height: draftH, items: [] };
        inst.visible = true;
        inst._view = null;
        inst._zoom = 1;
        inst._panX = 0;
        inst._panY = 0;
        inst.stageCv = { parentElement: { clientWidth: stageW, clientHeight: stageH } };
        return inst;
    }

    test('zoom=1 即自适应铺满：受限轴贴 pad 走廊、另一轴居中（一期行为不变）', () => {
        const inst = makeStageInst(1000, 800, 832, 1216);
        const v = inst._computeStageView(1000, 800);
        // 高是受限轴：fit = min((1000-56)/832, (800-56)/1216)
        expect(v.scale).toBeCloseTo((800 - 56) / 1216, 10);
        expect(v.oy).toBeCloseTo(28, 6);                       // 受限轴贴走廊
        expect(v.ox).toBeCloseTo((1000 - 832 * v.scale) / 2, 6); // 宽裕轴居中
    });

    test('放大后围绕光标锚定：光标下的草稿点缩放前后屏幕位置不变', () => {
        const inst = makeStageInst(1000, 800, 832, 1216);
        inst._view = inst._computeStageView(1000, 800);
        const px = 300, py = 400;
        const before = inst._toDraft(px, py);
        expect(inst._zoomAt(px, py, 1.1)).toBe(true);
        inst._view = inst._computeStageView(1000, 800);
        const after = inst._toDraft(px, py);
        expect(after.x).toBeCloseTo(before.x, 6);
        expect(after.y).toBeCloseTo(before.y, 6);
    });

    test('倍率钳制 [1, 8]：铺满即最小，连滚不超上限', () => {
        const inst = makeStageInst(1000, 800, 832, 1216);
        inst._view = inst._computeStageView(1000, 800);
        expect(inst._zoomAt(100, 100, 0.5)).toBe(false);   // 已在 1：缩不动
        expect(inst._zoom).toBe(1);
        for (let i = 0; i < 40; i++) inst._zoomAt(100, 100, 1.1);
        expect(inst._zoom).toBe(8);
        expect(inst._zoomAt(100, 100, 1.1)).toBe(false);   // 顶格不再变化
    });

    test('放大后平移钳制：画幅四边不脱出 pad 走廊', () => {
        const inst = makeStageInst(1000, 800, 832, 1216);
        inst._view = inst._computeStageView(1000, 800);
        // 以左上角为锚放大：内容被拉向右下，钳制后左/上边贴走廊上界
        inst._zoomAt(1, 1, 4);
        const v = inst._computeStageView(1000, 800);
        expect(v.ox).toBeLessThanOrEqual(28 + 1e-6);
        expect(v.oy).toBeLessThanOrEqual(28 + 1e-6);
        expect(v.ox + 832 * v.scale).toBeGreaterThanOrEqual(1000 - 28 - 1e-6);
        expect(v.oy + 1216 * v.scale).toBeGreaterThanOrEqual(800 - 28 - 1e-6);
    });

    test('缩回 1 强制居中铺满：残留平移被归零', () => {
        const inst = makeStageInst(1000, 800, 832, 1216);
        inst._view = inst._computeStageView(1000, 800);
        inst._zoomAt(1, 1, 4);
        inst._zoom = 1;
        inst._panX = 50;
        inst._panY = -30;   // 模拟残留平移
        const v = inst._computeStageView(1000, 800);
        expect(inst._panX).toBe(0);
        expect(inst._panY).toBe(0);
        expect(v.oy).toBeCloseTo(28, 6);
        expect(v.ox).toBeCloseTo((1000 - 832 * v.scale) / 2, 6);
    });
});

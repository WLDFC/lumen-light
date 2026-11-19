/**
 * templates 测试（2026-11-09 自 mangaEditor.test.js 按模块拆分）
 * 覆盖：MangaEditor 分镜模板换算（MangaTemplates 混入，ADR 078）
 */

const { context, MangaEditor, CoordinateLayout, makeInstance } = require('./helpers');

describe('MangaEditor 分镜模板换算（MangaTemplates 混入，ADR 078）', () => {
    function makeTplInstance() {
        const inst = makeInstance([]);
        inst.draft.width = 1000;
        inst.draft.height = 500;
        inst._nextCid = 100;
        return inst;
    }

    test('_tplCellsToItems：归一化格子按画幅换算回绝对 xyxy，cid 就地分配', () => {
        const inst = makeTplInstance();
        const items = inst._tplCellsToItems([
            { x: 0.1, y: 0.2, w: 0.3, h: 0.4, label: 'character', shot: '中景' },
            { x: 0, y: 0, w: 0.5, h: 1 }
        ]);
        expect(items).toHaveLength(2);
        expect(items[0].bbox).toEqual([100, 100, 400, 300]);
        expect(items[0].label).toBe('character');
        expect(items[0].shot).toBe('中景');
        expect(items[0].caption).toBe('');
        expect(items[1].cid).toBe(items[0].cid + 1);   // cid 就地递增
        expect(items[1].label).toBe('object');         // 缺省 object
        expect(items[0]).not.toHaveProperty('title');   // 模板不带框标题
    });

    test('_tplCellsToItems：无效格子跳过不拖垮，越界坐标被 normalizeBox 钳进画幅', () => {
        const inst = makeTplInstance();
        const items = inst._tplCellsToItems([
            null,
            { x: 0.1, y: 0.1, w: 0, h: 0.5 },        // 宽为 0 无效
            { x: 0.9, y: 0.9, w: 0.5, h: 0.5 },      // 越界 → 钳到画幅内
            { x: 0.2, y: 0.2, w: 0.1, h: 0.1 }
        ]);
        expect(items).toHaveLength(2);
        const [x1, y1, x2, y2] = items[0].bbox;
        expect(x2).toBeLessThanOrEqual(1000);
        expect(y2).toBeLessThanOrEqual(500);
        expect(items[1].bbox).toEqual([200, 100, 300, 150]);
    });

    test('_tplItemsToCells：bbox 除以画幅归一化，只带走几何 + label/shot', () => {
        const inst = makeTplInstance();
        const cells = inst._tplItemsToCells([
            { label: 'character', shot: '前景', caption: '主角登场', title: '格 1',
              bbox: [50, 100, 550, 300] },
            { caption: '无 label', bbox: [0, 0, 1000, 500] },
            { bbox: 'bad' },
            { bbox: [100, 100, 100, 200] }   // 零面积无效
        ]);
        expect(cells).toHaveLength(2);
        expect(cells[0]).toEqual({
            x: 0.05, y: 0.2, w: 0.5, h: 0.4, label: 'character', shot: '前景'
        });
        expect(cells[0]).not.toHaveProperty('caption');
        expect(cells[0]).not.toHaveProperty('title');
        expect(cells[1]).toEqual({ x: 0, y: 0, w: 1, h: 1 });   // 缺 label 不写字段
    });

    test('_tplItemsToCells：越出画幅的框钳回 0~1（拖出界的元素框照存）', () => {
        const inst = makeTplInstance();
        const cells = inst._tplItemsToCells([
            { bbox: [-50, -50, 1200, 600] }
        ]);
        expect(cells).toHaveLength(1);
        expect(cells[0].x).toBe(0);
        expect(cells[0].y).toBe(0);
        expect(cells[0].w).toBe(1);   // 1200/1000 钳回 1
        expect(cells[0].h).toBe(1);
    });

    test('往返一致性：格子 → 元素框 → 格子，几何回到原值（画幅内）', () => {
        const inst = makeTplInstance();
        const origin = { x: 0.12, y: 0.24, w: 0.3, h: 0.4, label: 'object' };
        const items = inst._tplCellsToItems([origin]);
        const cells = inst._tplItemsToCells(items);
        expect(cells[0].x).toBeCloseTo(origin.x, 6);
        expect(cells[0].y).toBeCloseTo(origin.y, 6);
        expect(cells[0].w).toBeCloseTo(origin.w, 6);
        expect(cells[0].h).toBeCloseTo(origin.h, 6);
        expect(cells[0].label).toBe('object');
    });
});

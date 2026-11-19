/**
 * pages 测试（2026-11-09 自 mangaEditor.test.js 按模块拆分）
 * 覆盖：MangaEditor 多页文档：页面操作/切页/迁移/跨 kind 撤销
 */

const { context, MangaEditor, CoordinateLayout, makeInstance } = require('./helpers');

describe('MangaEditor 多页文档：页面操作/切页/迁移/跨 kind 撤销', () => {
    const mkPage = (w = 1024, h = 1024, caption = '') => ({
        width: w, height: h,
        bbox_coord_space: 'abs', bbox_format: 'xyxy',
        summary: { caption, canvas: 'single' },
        items: []
    });

    /** 双页文档实例：渲染/存档链路全部打桩，只留页面操作与历史真身 */
    function makeDocInst() {
        const inst = Object.create(MangaEditor.prototype);
        inst.pages = [mkPage(), mkPage()];
        inst.activePage = 0;
        inst.draft = inst.pages[0];
        inst._undoStack = [];
        inst._redoStack = [];
        inst._textHistPending = null;
        inst._histTimer = null;
        inst._status = () => {};
        inst._renderAll = () => {};
        inst._renderRail = () => {};
        inst._scheduleSave = () => {};
        inst._invalidateCompiled = () => {};
        return inst;
    }

    test('_switchPage：draft 换引用指向目标页；越界/同页不动', () => {
        const inst = makeDocInst();
        inst.pages[1].summary.caption = '第二页';
        expect(inst._switchPage(1)).toBe(true);
        expect(inst.draft).toBe(inst.pages[1]);
        expect(inst.activePage).toBe(1);
        expect(inst._switchPage(5)).toBe(false);
        expect(inst._switchPage(-1)).toBe(false);
        expect(inst._switchPage(1)).toBe(false);   // 同页
    });

    test('_addPage：空白页继承当前页画幅、插在活动页之后并切换', () => {
        const inst = makeDocInst();
        inst.pages[0].width = 832;
        inst.pages[0].height = 1216;
        inst._addPage();
        expect(inst.pages.length).toBe(3);
        expect(inst.activePage).toBe(1);
        expect(inst.draft).toBe(inst.pages[1]);
        expect(inst.draft.width).toBe(832);
        expect(inst.draft.height).toBe(1216);
        expect(inst.draft.items.length).toBe(0);
        inst._undoHist();                          // 文档级回滚
        expect(inst.pages.length).toBe(2);
        expect(inst.activePage).toBe(0);
        inst._redoHist();
        expect(inst.pages.length).toBe(3);
        expect(inst.activePage).toBe(1);
    });

    test('_copyPage：深拷贝插到其后；副本与原件互不影响', () => {
        const inst = makeDocInst();
        inst.pages[0].summary.caption = '原页';
        inst._copyPage(0);
        expect(inst.pages.length).toBe(3);
        expect(inst.activePage).toBe(1);
        expect(inst.draft.summary.caption).toBe('原页');
        inst.draft.summary.caption = '副本改';
        expect(inst.pages[0].summary.caption).toBe('原页');
    });

    test('_deletePage：最后一页拒绝；删活动页之前的页下标收拢；撤销整表恢复', () => {
        const inst = makeDocInst();
        inst.pages = [mkPage()];
        inst.activePage = 0;
        inst.draft = inst.pages[0];
        const errs = [];
        inst._status = (t, isErr) => { if (isErr) errs.push(t); };
        inst._deletePage(0);
        expect(inst.pages.length).toBe(1);         // 拒绝删除最后一页
        expect(errs.length).toBe(1);

        inst.pages = [mkPage(), mkPage(), mkPage()];
        inst.activePage = 2;
        inst.draft = inst.pages[2];
        inst._deletePage(0);
        expect(inst.pages.length).toBe(2);
        expect(inst.activePage).toBe(1);
        expect(inst.draft).toBe(inst.pages[1]);
        inst._undoHist();
        expect(inst.pages.length).toBe(3);
        expect(inst.activePage).toBe(2);           // 文档快照含 active，一并归位
    });

    test('_movePage：活动页跟随自身换位，内容不变', () => {
        const inst = makeDocInst();
        inst.pages[0].summary.caption = 'A';
        inst.pages[1].summary.caption = 'B';
        inst._movePage(0, 1);                      // A 下移
        expect(inst.pages[0].summary.caption).toBe('B');
        expect(inst.pages[1].summary.caption).toBe('A');
        expect(inst.activePage).toBe(1);           // 活动页（原 A）跟到下标 1
        inst._undoHist();
        expect(inst.pages[0].summary.caption).toBe('A');
        expect(inst.activePage).toBe(0);
    });

    test('混合撤销：页级内容编辑与文档级删页交替回滚各自归位', () => {
        const inst = makeDocInst();
        inst.pages[1].width = 832;
        inst._switchPage(1);
        // 页级编辑：第 2 页画一个框（快照 → 变更 → 入账）
        const before = inst._histSnapshot();
        expect(before.kind).toBe('page');
        expect(before.pageIdx).toBe(1);
        inst.draft.items.push({ cid: 0, label: 'object', caption: '', bbox: [0, 0, 100, 100] });
        inst._commitHistory(before, '画框');
        // 文档级：删除第 1 页
        inst._deletePage(0);
        expect(inst.pages.length).toBe(1);
        // 撤销删页 → 回到 2 页，active 归位第 2 页
        inst._undoHist();
        expect(inst.pages.length).toBe(2);
        expect(inst.activePage).toBe(1);
        expect(inst.pages[1].width).toBe(832);
        // 再撤销画框 → 页级回滚落在第 2 页，items 清空
        inst._undoHist();
        expect(inst.draft.items.length).toBe(0);
        expect(inst.pages[1].items.length).toBe(0);
    });

    test('_confirmDeletePage：最后一页直接拦下不弹确认；多页时走确认后删除', async () => {
        const inst = makeDocInst();
        inst.pages = [mkPage()];
        inst.activePage = 0;
        inst.draft = inst.pages[0];
        const errs = [];
        inst._status = (t, isErr) => { if (isErr) errs.push(t); };
        await inst._confirmDeletePage(0);
        expect(errs.length).toBe(1);               // 最后一页：状态栏报错，不弹框
        expect(inst.pages.length).toBe(1);

        inst.pages = [mkPage(), mkPage()];
        inst.activePage = 0;
        inst.draft = inst.pages[0];
        inst.pageConfirmDialog = { confirm: async () => false };   // 用户点取消
        await inst._confirmDeletePage(1);
        expect(inst.pages.length).toBe(2);         // 取消：不删
        inst.pageConfirmDialog = { confirm: async () => true };    // 用户确认
        await inst._confirmDeletePage(1);
        expect(inst.pages.length).toBe(1);         // 确认：删除
    });

    test('_normalizeDocument：旧单页草稿自动迁移；越界 active 钳制；垃圾返回 null', () => {
        const inst = makeDocInst();
        const legacy = mkPage(832, 1216);
        const doc = inst._normalizeDocument(legacy);
        expect(doc.pages.length).toBe(1);
        expect(doc.pages[0].width).toBe(832);
        expect(doc.active).toBe(0);

        const doc2 = inst._normalizeDocument({ pages: [mkPage(), mkPage()], active: 9 });
        expect(doc2.pages.length).toBe(2);
        expect(doc2.active).toBe(1);

        // 垃圾对象：normalizeDraft 宽松归一补默认值成空白页（与坐标编辑器
        // 恢复行为一致）；null 连对象都不是 → 整文档救不回返回 null
        const doc3 = inst._normalizeDocument({ foo: 1 });
        expect(doc3.pages.length).toBe(1);
        expect(doc3.pages[0].width).toBe(1024);
        expect(inst._normalizeDocument(null)).toBe(null);
    });
});

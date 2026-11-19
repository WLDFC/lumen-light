/**
 * projects 测试（2026-11-09 自 mangaEditor.test.js 按模块拆分）
 * 覆盖：MangaEditor 漫画项目管理（MangaProjects，ADR 071 交付独立）
 */

const { context, MangaEditor, CoordinateLayout, makeInstance } = require('./helpers');

describe('MangaEditor 漫画项目管理（MangaProjects，ADR 071 交付独立）', () => {

    function makeProjInst() {
        const inst = makeInstance([]);
        inst.pages = [inst.draft];
        inst.activePage = 0;
        inst.visible = false;
        inst.hideCalls = 0;
        inst.hide = function () { inst.hideCalls++; inst.visible = false; };
        inst._exportSnap = inst._docSnapshot();
        inst._layerImgCache = new Map();
        inst._nextLayerId = 1;
        inst._renderLayerPanel = () => {};
        inst._renderRail = () => {};
        inst._resetHistory = () => {};
        inst.projectBtn = { textContent: '项目', title: '' };
        return inst;
    }

    test('_applyLoadedDocument：项目态落位（id/名称/localStorage 记忆/面板重渲染/按钮标签）', () => {
        const inst = makeProjInst();
        const page = { width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy', summary: { caption: '', canvas: 'single' }, items: [] };
        inst._applyLoadedDocument({ pages: [page, page], active: 1 }, { id: 'm-20261107-abcd', name: '测试本' });
        expect(inst.currentProjectId).toBe('m-20261107-abcd');
        expect(inst.currentProjectName).toBe('测试本');
        expect(inst.pages).toHaveLength(2);
        expect(inst.activePage).toBe(1);
        expect(inst.draft).toBe(inst.pages[1]);
        expect(inst._selLayerId).toBe(null);
        expect(context.localStorage.getItem('lumenLight.mangaLastProject')).toBe('m-20261107-abcd');
        expect(inst.projectBtn.textContent).toContain('●');
        expect(inst.projectBtn.title).toContain('测试本');
    });

    test('_applyLoadedDocument：null 项目=默认草稿态，不写 localStorage，按钮无 ●', () => {
        const inst = makeProjInst();
        context.localStorage.setItem('lumenLight.mangaLastProject', 'm-20261107-old');
        const page = { width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy', summary: { caption: '', canvas: 'single' }, items: [] };
        inst._applyLoadedDocument({ pages: [page], active: 0 }, null);
        expect(inst.currentProjectId).toBe(null);
        expect(inst.currentProjectName).toBe(null);
        expect(inst.projectBtn.textContent).toBe('项目');
        expect(inst.projectBtn.title).toContain('默认草稿');
    });

    test('_transferGenImage：无项目原样返回；有项目转存成功换项目路径；失败回落原 src', async () => {
        const inst = makeProjInst();
        inst.currentProjectId = null;
        await expect(inst._transferGenImage('data:image/png;base64,AAA')).resolves.toBe('data:image/png;base64,AAA');

        inst.currentProjectId = 'm-20261107-abcd';
        context.fetch = async (url, opts) => ({
            ok: true,
            json: async () => ({ status: 'ok', path: '/api/manga-projects/m-20261107-abcd/images/1.png' }),
            url, opts
        });
        try {
            await expect(inst._transferGenImage('data:image/png;base64,AAA'))
                .resolves.toBe('/api/manga-projects/m-20261107-abcd/images/1.png');
        } finally {
            delete context.fetch;
        }

        context.fetch = async () => { throw new Error('网络炸了'); };
        try {
            await expect(inst._transferGenImage('data:image/png;base64,AAA'))
                .resolves.toBe('data:image/png;base64,AAA');   // 失败回落原 src
            expect(inst.statusCalls[inst.statusCalls.length - 1].isError).toBe(true);
        } finally {
            delete context.fetch;
        }
    });
});

/**
 * compile 测试（2026-11-09 自 mangaEditor.test.js 按模块拆分）
 * 覆盖：MangaEditor 景别辅助（item.shot）；MangaEditor._compile/_invalidateCompiled 输出框（右栏共用）
 */

const { context, MangaEditor, CoordinateLayout, makeInstance } = require('./helpers');

describe('MangaEditor 景别辅助（item.shot）', () => {
    test('选景别把词前缀进 caption；换景别换前缀；清除摘前缀并删字段', () => {
        const inst = makeInstance([{ label: 'object', caption: '', bbox: [0, 0, 100, 100] }]);
        inst._onShotChange(0, '前景', null);
        expect(inst.draft.items[0]).toMatchObject({ shot: '前景', caption: '前景，' });
        inst._onShotChange(0, '后景', null);
        expect(inst.draft.items[0]).toMatchObject({ shot: '后景', caption: '后景，' });
        inst._onShotChange(0, '', null);
        expect(inst.draft.items[0].caption).toBe('');
        expect('shot' in inst.draft.items[0]).toBe(false);
    });

    test('已有文案不重复加词；用户文案里已含该词则完全不动', () => {
        const inst = makeInstance([{ label: 'object', caption: '一杯奶茶', bbox: [0, 0, 100, 100] }]);
        inst._onShotChange(0, '前景', null);
        expect(inst.draft.items[0].caption).toBe('前景，一杯奶茶');
        inst._onShotChange(0, '前景', null);   // 重复选同值不叠加
        expect(inst.draft.items[0].caption).toBe('前景，一杯奶茶');
        const inst2 = makeInstance([{ label: 'object', caption: '中景的吧台与咖啡师', bbox: [0, 0, 100, 100] }]);
        inst2._onShotChange(0, '中景', null);
        expect(inst2.draft.items[0].caption).toBe('中景的吧台与咖啡师');
    });

    test('_draftForCompile：剥离 shot 后可编译（编辑器元数据不进 MOSS 产物）', () => {
        const inst = makeInstance([]);
        inst.draft.summary.caption = '海报。';
        inst.draft.items = [{ label: 'object', caption: '前景，奶茶', shot: '前景', bbox: [0, 0, 512, 512] }];
        const clean = inst._draftForCompile();
        expect('shot' in clean.items[0]).toBe(false);
        const r = CoordinateLayout.compileDraft(clean);
        expect(r.ok).toBe(true);
        expect(r.prompt).toContain('前景，奶茶');
        expect(r.prompt).not.toContain('"shot"');
        // 原始草稿（带 shot）直接编译应被拒——证明剥离是必要的
        expect(CoordinateLayout.compileDraft(inst.draft).ok).toBe(false);
    });
});

describe('MangaEditor._compile/_invalidateCompiled 输出框（右栏共用）', () => {
    function makeOutInst() {
        const inst = Object.create(MangaEditor.prototype);
        inst.draft = {
            width: 1024, height: 1024,
            bbox_coord_space: 'abs', bbox_format: 'xyxy',
            summary: { caption: 'A poster.', canvas: 'single' },
            items: [{ label: 'object', caption: 'A cup.', bbox: [64, 64, 512, 512] }]
        };
        inst.compiled = null;
        inst.copyBtn = { disabled: false };
        inst.aiOutTa = { value: '' };
        inst.jsonNote = { textContent: '' };
        inst._outMode = '';
        inst.statusCalls = [];
        inst._status = (text, isError) => inst.statusCalls.push({ text, isError });
        inst._saveTimer = null;
        inst._saveDirty = false;
        inst._draftTouched = true;   // 编译不改草稿，不触发保存断言
        inst._scheduleSave = () => {};
        return inst;
    }

    test('编译成功：产物写入右栏输出框 + 尺寸提醒', () => {
        const inst = makeOutInst();
        inst._compile();
        expect(inst.compiled.ok).toBe(true);
        expect(inst.aiOutTa.value).toContain('"summary"');
        expect(inst.aiOutTa.value).toContain('abs_centralized');
        expect(inst.jsonNote.textContent).toContain('1024×1024');
        expect(inst._outMode).toBe('compile');
        expect(inst.copyBtn.disabled).toBe(false);
    });

    test('编译失败：右栏旧编译产物清空、按钮禁用、状态报错', () => {
        const inst = makeOutInst();
        inst.aiOutTa.value = '旧产物';
        inst._outMode = 'compile';
        inst.draft.items = [];   // 空 items 编译必失败
        inst._compile();
        expect(inst.compiled.ok).toBe(false);
        expect(inst.aiOutTa.value).toBe('');
        expect(inst.jsonNote.textContent).toBe('');
        expect(inst.copyBtn.disabled).toBe(true);
        expect(inst.statusCalls.at(-1).text).toContain('编译失败');
    });

    test('草稿变更：正在显示的编译产物清空；AI 文案留档不误清', () => {
        const inst = makeOutInst();
        inst._compile();
        expect(inst.aiOutTa.value).not.toBe('');
        inst._invalidateCompiled();
        expect(inst.aiOutTa.value).toBe('');          // 编译产物过期即清
        expect(inst.jsonNote.textContent).toBe('');
        // AI 留档场景：编辑草稿不清 AI 输出
        inst.aiOutTa.value = 'SUMMARY: AI 输出留档';
        inst._outMode = 'ai';
        inst._invalidateCompiled();
        expect(inst.aiOutTa.value).toBe('SUMMARY: AI 输出留档');
    });

    test('右栏为 AI 输出态时按右栏编译（文案取 AI、几何取草稿、不回写左侧）', () => {
        const inst = makeOutInst();
        inst.aiOutTa.value = 'SUMMARY: AI 整体描述。\nITEM 1: AI 元素文案。';
        inst._outMode = 'ai';
        inst._compile();
        expect(inst.compiled.ok).toBe(true);
        expect(inst.aiOutTa.value).toContain('AI 整体描述');
        expect(inst.aiOutTa.value).toContain('AI 元素文案');
        // 左侧草稿未被回写
        expect(inst.draft.summary.caption).toBe('A poster.');
        expect(inst.draft.items[0].caption).toBe('A cup.');
        expect(inst._outMode).toBe('compile');
    });

    test('手动编辑草稿消费 AI 输出标记：之后编译按草稿（右栏内容保留供参考）', () => {
        const inst = makeOutInst();
        inst.aiOutTa.value = 'SUMMARY: AI 整体描述。\nITEM 1: AI 元素文案。';
        inst._outMode = 'ai';
        inst._invalidateCompiled();
        expect(inst._outMode).toBe('');                       // 标记被消费
        expect(inst.aiOutTa.value).toContain('AI 整体描述');  // 内容不清，仅供参考
        inst._compile();
        expect(inst.compiled.ok).toBe(true);
        expect(inst.aiOutTa.value).toContain('A cup.');       // 按草稿编译
        expect(inst.aiOutTa.value).not.toContain('AI 元素文案');
    });
});

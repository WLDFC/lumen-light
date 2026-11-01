/**
 * ==========================================================================
 * CoordinateLayout 单元测试
 * 覆盖 MOSS-Image Layout 草稿的校验与编译（compile_prompt.py 的 JS 移植）：
 *   - 坐标换算断言对齐上游 test_compile_prompt.py（横/竖构图、分数坐标
 *     包络、round9 塌缩拒绝）
 *   - 编译产物形态：单行 JSON、中心原点 yxyx、无宽高字段、键序与内容
 *     原样保留、中文/emoji 不转义、草稿对象不被修改
 *   - 非法输入拒绝：几何越界/反转/零尺寸/布尔/NaN/Infinity/字符串、
 *     尺寸非 16 倍数、坐标约定错、未知字段、text 元素缺文案、
 *     空 caption/空 items、canvas 模式枚举
 *   - 编辑器辅助：clampDim 钳制、normalizeBox 归一、snapValue 磁吸
 *   - 加载容错归一（normalizeDraft，ADR 018）：合法草稿往返恒等（shot
 *     保留）、缺字段补默认、坏条目剔除不拖垮、非对象返回 null、
 *     坐标约定强制 abs/xyxy、越界框钳回画幅
 * 被测文件是浏览器端经典脚本（依赖全局 window），用 vm 模块在
 * 同一上下文中执行（与 nodeTypes.test.js 同一套做法）。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: {} };
vm.createContext(context);

const source = fs.readFileSync(
    path.join(__dirname, '../../js/utils/CoordinateLayout.js'), 'utf-8');
vm.runInContext(source, context, { filename: 'CoordinateLayout.js' });

const CL = context.window.CoordinateLayout;

// 上游 test_compile_prompt.py setUp 的同款草稿（1536×1024 + 中文文案）
function makeDraft() {
    return {
        width: 1536,
        height: 1024,
        bbox_coord_space: 'abs',
        bbox_format: 'xyxy',
        summary: { meta: ['poster'], canvas: 'single', caption: 'A ceramic campaign.' },
        items: [{
            label: 'text',
            caption: 'Dark-green lettering.',
            text: '把日常，过成诗。\n"MOSS" 🪴',
            bbox: [928, 272, 1408, 448]
        }]
    };
}

describe('CoordinateLayout 坐标换算（对齐上游 centered_box）', () => {
    test('横构图换算：xyxy 左上原点 → yxyx 中心原点', () => {
        expect(CL.centeredBox([176, 224, 800, 864], 1536, 1024, 'box'))
            .toEqual([-288, -592, 352, 32]);   // layout.md 文档给定的换算示例
    });

    test('上游断言：横构图中文标题框', () => {
        expect(CL.centeredBox([928, 272, 1408, 448], 1536, 1024, 'box'))
            .toEqual([-240, 160, -64, 640]);
    });

    test('竖构图全幅框', () => {
        expect(CL.centeredBox([0, 0, 768, 1344], 768, 1344, 'box'))
            .toEqual([-672, -384, 672, 384]);
    });

    test('分数坐标包络：floor 左上 / ceil 右下', () => {
        expect(CL.centeredBox([10.9, 20.1, 100.01, 200.99], 768, 1344, 'box'))
            .toEqual([-652, -374, -471, -283]);
    });

    test('round9 消浮点噪声后按整数值换算', () => {
        expect(CL.centeredBox([1.00000000001, 2, 100, 200], 768, 1344, 'box'))
            .toEqual([-670, -383, -472, -284]);
    });

    test('非法几何一律拒绝（越界/反转/零尺寸/长度错/布尔/NaN/Infinity/字符串）', () => {
        const cases = [
            [-1, 0, 100, 100], [0, 0, 1537, 100], [0, 0, 100, 1025],
            [100, 0, 50, 100], [0, 0, 0, 100], [0, 0, 100],
            [true, 0, 100, 100], [0, 0, NaN, 100],
            [0, 0, Infinity, 100], [0, 0, '100', 100],
            [0, 0, 0.00000000001, 100]     // round9 塌缩成零宽 → 导出精度下过小
        ];
        for (const box of cases) {
            expect(() => CL.centeredBox(box, 1536, 1024, 'box')).toThrow();
        }
    });
});

describe('CoordinateLayout 编译产物形态', () => {
    test('编译成功且不修改草稿对象', () => {
        const draft = makeDraft();
        const before = JSON.parse(JSON.stringify(draft));
        const r = CL.compileDraft(draft);
        expect(r.ok).toBe(true);
        expect(draft).toEqual(before);
    });

    test('产物为单行 JSON：中心原点 yxyx、无宽高字段、内容原样', () => {
        const draft = makeDraft();
        const r = CL.compileDraft(draft);
        expect(r.ok).toBe(true);
        expect(r.prompt).not.toContain('\n');
        const parsed = JSON.parse(r.prompt);
        expect(parsed.items[0].bbox).toEqual([-240, 160, -64, 640]);
        expect(parsed.items[0].text).toBe(draft.items[0].text);
        expect(parsed.summary).toEqual(draft.summary);
        expect(parsed.bbox_coord_space).toBe('abs_centralized');
        expect(parsed.bbox_format).toBe('yxyx');
        expect(parsed.width).toBeUndefined();
        expect(parsed.height).toBeUndefined();
    });

    test('键序与紧凑分隔：summary 在前，无空格分隔（与 Python dumps 对齐）', () => {
        const draft = makeDraft();
        const r = CL.compileDraft(draft);
        expect(r.prompt.startsWith('{"summary":')).toBe(true);
        expect(r.prompt).toContain('"items":[{"label":"text"');
        expect(r.prompt).not.toContain('": ');
    });

    test('中文与 emoji 不转义（ensure_ascii=False 语义）', () => {
        const draft = makeDraft();
        const r = CL.compileDraft(draft);
        expect(r.prompt).toContain('把日常，过成诗。');
        expect(r.prompt).toContain('🪴');
        // 字符串内换行转义为 \n 字面量，产物无物理换行
        expect(r.prompt).toContain('\\n');
    });

    test('caption 草稿返回纯文本并保留逐字文案', () => {
        const caption = 'An ivory cup marked "茶".\nPreserve this second line.';
        const r = CL.compileDraft({ caption });
        expect(r).toEqual({ ok: true, prompt: caption });
    });
});

describe('CoordinateLayout 草稿校验拒绝', () => {
    test('尺寸非法：非 16 倍数 / 0 / 布尔', () => {
        for (const [field, value] of [['width', 1023], ['height', 0], ['width', true]]) {
            const draft = makeDraft();
            draft[field] = value;
            const r = CL.compileDraft(draft);
            expect(r.ok).toBe(false);
            expect(typeof r.error).toBe('string');
        }
    });

    test('坐标约定错：abs_centralized / normalized_1000 / yxyx 输入均拒绝', () => {
        for (const [field, value] of [
            ['bbox_coord_space', 'abs_centralized'],
            ['bbox_coord_space', 'normalized_1000'],
            ['bbox_format', 'yxyx']
        ]) {
            const draft = makeDraft();
            draft[field] = value;
            expect(CL.compileDraft(draft).ok).toBe(false);
        }
    });

    test('未知字段拒绝（children/font_size/parent），不静默丢弃', () => {
        for (const [field, value] of [
            ['children', [{ bbox: [0, 0, 20, 20] }]],
            ['font_size', 32],
            ['parent', 'cup']
        ]) {
            const draft = makeDraft();
            draft.items[0][field] = value;
            expect(CL.compileDraft(draft).ok).toBe(false);
        }
    });

    test('text 元素缺 text 字段拒绝（报错含「文字内容」）', () => {
        const draft = makeDraft();
        delete draft.items[0].text;
        const r = CL.compileDraft(draft);
        expect(r.ok).toBe(false);
        expect(r.error).toContain('文字内容');
    });

    test('空 caption / 空 items / caption 草稿带多余字段 均拒绝', () => {
        const d1 = makeDraft(); d1.summary.caption = '';
        expect(CL.compileDraft(d1).ok).toBe(false);
        const d2 = makeDraft(); d2.items = [];
        expect(CL.compileDraft(d2).ok).toBe(false);
        expect(CL.compileDraft({ caption: 'x', items: [] }).ok).toBe(false);
        expect(CL.compileDraft({ caption: '' }).ok).toBe(false);
    });

    test('canvas 模式枚举：三模式通过，其余拒绝', () => {
        for (const mode of CL.CANVAS_MODES) {
            const draft = makeDraft();
            draft.summary.canvas = mode;
            expect(CL.compileDraft(draft).ok).toBe(true);
        }
        const draft = makeDraft();
        draft.summary.canvas = 'diptych';
        expect(CL.compileDraft(draft).ok).toBe(false);
    });

    test('label 枚举：object/character/text 通过，其余拒绝', () => {
        for (const label of CL.ITEM_LABELS) {
            const draft = makeDraft();
            draft.items[0].label = label;
            if (label !== 'text') delete draft.items[0].text;
            expect(CL.compileDraft(draft).ok).toBe(true);
        }
        const draft = makeDraft();
        draft.items[0].label = 'panel';
        expect(CL.compileDraft(draft).ok).toBe(false);
    });

    test('validateDraft 返回错误文案或 null', () => {
        expect(CL.validateDraft(makeDraft())).toBeNull();
        const bad = makeDraft();
        bad.width = 1000;
        expect(typeof CL.validateDraft(bad)).toBe('string');
    });
});

describe('CoordinateLayout 编辑器辅助', () => {
    test('createDraft 默认 1024×1024 single 模式可编译（补齐 caption 后）', () => {
        const draft = CL.createDraft();
        expect(draft).toMatchObject({
            width: 1024, height: 1024,
            bbox_coord_space: 'abs', bbox_format: 'xyxy',
            summary: { caption: '', canvas: 'single' },
            items: []
        });
        draft.summary.caption = 'A poster.';
        draft.items.push({ label: 'object', caption: 'A cup.', bbox: [0, 0, 512, 512] });
        expect(CL.compileDraft(draft).ok).toBe(true);
    });

    test('clampDim：就近取 16 倍数并钳制范围', () => {
        expect(CL.clampDim(1000)).toBe(1008);
        expect(CL.clampDim(832.4)).toBe(832);
        expect(CL.clampDim(32)).toBe(CL.MIN_DIM);
        expect(CL.clampDim(99999)).toBe(CL.MAX_DIM);
        expect(CL.clampDim('x')).toBe(1024);
    });

    test('normalizeBox：取整、反转排序、钳回画幅、最小 2px', () => {
        expect(CL.normalizeBox([600, 400, 200, 100], 1024, 1024))
            .toEqual([200, 100, 600, 400]);
        expect(CL.normalizeBox([-50, -50, 2000, 2000], 1024, 1024))
            .toEqual([0, 0, 1024, 1024]);
        expect(CL.normalizeBox([10, 10, 11, 11], 1024, 1024))
            .toEqual([10, 10, 12, 12]);
    });

    test('snapValue：阈值内吸附最近目标，阈值外原值', () => {
        expect(CL.snapValue(103, [100], 8)).toEqual({ value: 100, snapped: true });
        expect(CL.snapValue(110, [100], 8)).toEqual({ value: 110, snapped: false });
        // 两个目标同距取先到者（画幅中心优先于后加入的参考线）
        expect(CL.snapValue(50, [0, 100], 50)).toEqual({ value: 0, snapped: true });
    });

    test('axisTargets：画幅 0/中心/边缘 + 参考线', () => {
        expect(CL.axisTargets(1024, [128, 256])).toEqual([0, 512, 1024, 128, 256]);
    });

    test('PRESET_SIZES 全部为 16 的倍数且在合法范围', () => {
        for (const p of CL.PRESET_SIZES) {
            expect(p.width % 16).toBe(0);
            expect(p.height % 16).toBe(0);
            expect(p.width).toBeGreaterThanOrEqual(CL.MIN_DIM);
            expect(p.height).toBeLessThanOrEqual(CL.MAX_DIM);
        }
    });
});

describe('CoordinateLayout 加载容错归一（normalizeDraft，ADR 018）', () => {
    // 编辑器真实草稿形态：含 item.shot 景别元数据与 text 元素
    function editorDraft() {
        return {
            width: 832,
            height: 1216,
            bbox_coord_space: 'abs',
            bbox_format: 'xyxy',
            summary: { caption: '竖版海报', canvas: 'multi_panel' },
            items: [
                { label: 'character', caption: '前景女孩', bbox: [64, 64, 400, 640], shot: '前景' },
                { label: 'text', caption: '主标题', text: '流光', bbox: [400, 900, 768, 1000] }
            ]
        };
    }

    test('合法编辑器草稿往返恒等（shot/text 原样保留）', () => {
        expect(CL.normalizeDraft(editorDraft())).toEqual(editorDraft());
    });

    test('item.title 框标题透传（编辑器侧元数据，编译前剥离）', () => {
        const draft = editorDraft();
        draft.items[0].title = '亚丝娜';
        expect(CL.normalizeDraft(draft).items[0].title).toBe('亚丝娜');
        // 空白标题不落字段（与「未设标题」同态）
        draft.items[0].title = '   ';
        expect(CL.normalizeDraft(draft).items[0].title).toBeUndefined();
        // 编译侧：title 不在白名单，必须由编辑器剥离后才过校验
        draft.items[0].title = '亚丝娜';
        expect(CL.compileDraft(draft).ok).toBe(false);
    });

    test('合法上游草稿（meta/palette/tags 白名单字段）往返保留', () => {
        const draft = makeDraft();   // summary.meta + item.text 的上游形态
        const out = CL.normalizeDraft(draft);
        expect(out).toEqual(draft);
        const withTags = {
            ...draft,
            items: [{ ...draft.items[0], tags: ['solo'], palette: ['#fff'] }]
        };
        expect(CL.normalizeDraft(withTags).items[0].tags).toEqual(['solo']);
        expect(CL.normalizeDraft(withTags).items[0].palette).toEqual(['#fff']);
    });

    test('非对象输入返回 null', () => {
        for (const bad of [null, undefined, 42, 'draft', [], [editorDraft()]]) {
            expect(CL.normalizeDraft(bad)).toBeNull();
        }
    });

    test('缺字段/坏类型补默认：画幅钳 16 倍数、summary 兜底、坐标约定强制', () => {
        const out = CL.normalizeDraft({
            width: 1000.4,            // 就近 16 倍数 → 1008
            height: 'x',              // 非数字 → 默认 1024
            bbox_coord_space: 'abs_centralized',   // 强制回 abs
            bbox_format: 'yxyx',      // 强制回 xyxy
            summary: { canvas: '未知模式' },        // canvas 非法 → single
            items: [],
            unknownRoot: true         // 未知根字段丢弃
        });
        expect(out).toEqual({
            width: 1008,
            height: 1024,
            bbox_coord_space: 'abs',
            bbox_format: 'xyxy',
            summary: { caption: '', canvas: 'single' },
            items: []
        });
        expect('unknownRoot' in out).toBe(false);
    });

    test('summary 缺失整体兜底为空 caption + single', () => {
        const out = CL.normalizeDraft({ width: 1024, height: 1024, items: [] });
        expect(out.summary).toEqual({ caption: '', canvas: 'single' });
    });

    test('坏条目剔除、好条目保留（顺序不变）', () => {
        const out = CL.normalizeDraft({
            width: 1024, height: 1024,
            items: [
                null,                                    // 非对象
                { caption: '缺 label' },                 // label 非法
                { label: 'object', caption: 42, bbox: [0, 0, 10, 10] },        // caption 非字符串
                { label: 'object', caption: '缺 bbox' },                          // bbox 缺失
                { label: 'character', caption: '好条目', bbox: [1, 2, 3, 4], shot: '' }  // shot 空串剥掉
            ]
        });
        expect(out.items).toEqual([
            { label: 'character', caption: '好条目', bbox: [1, 2, 3, 4] }
        ]);
    });

    test('空 caption 条目保留（新建卡片的合法中间态）', () => {
        const out = CL.normalizeDraft({
            width: 1024, height: 1024,
            items: [{ label: 'object', caption: '', bbox: [10, 10, 100, 100] }]
        });
        expect(out.items).toHaveLength(1);
        expect(out.items[0].caption).toBe('');
    });

    test('越界/反转/非有限 bbox 钳回画幅', () => {
        const out = CL.normalizeDraft({
            width: 1024, height: 1024,
            items: [
                { label: 'object', caption: '越界', bbox: [-50, -50, 2000, 2000] },
                { label: 'object', caption: '反转', bbox: [600, 400, 200, 100] },
                { label: 'object', caption: 'NaN', bbox: [NaN, NaN, NaN, NaN] }
            ]
        });
        expect(out.items[0].bbox).toEqual([0, 0, 1024, 1024]);
        expect(out.items[1].bbox).toEqual([200, 100, 600, 400]);
        expect(out.items[2].bbox).toEqual([0, 0, 2, 2]);
    });

    test('text/tags/palette 非法形态剥离（text 非字符串丢、数组混非字符串丢）', () => {
        const out = CL.normalizeDraft({
            width: 1024, height: 1024,
            items: [{
                label: 'text',
                caption: '标题',
                text: 42,
                bbox: [0, 0, 100, 100],
                tags: ['ok', 3],
                palette: 'not-array'
            }]
        });
        const item = out.items[0];
        expect('text' in item).toBe(false);
        expect('tags' in item).toBe(false);
        expect('palette' in item).toBe(false);
    });

    test('background 背景引用：/api/assets/ 引用保留，其余形态丢弃', () => {
        const ok = CL.normalizeDraft({
            width: 1024, height: 1024, items: [],
            background: '/api/assets/file/ab12.png'
        });
        expect(ok.background).toBe('/api/assets/file/ab12.png');
        // base64 / 临时地址 / 非字符串一律丢弃——只存稳定引用的契约
        for (const bad of ['data:image/png;base64,AAAA', '/api/comfy/view?filename=x', '', 42, null]) {
            const out = CL.normalizeDraft({
                width: 1024, height: 1024, items: [], background: bad
            });
            expect('background' in out).toBe(false);
        }
    });

    test('归一结果可直接喂编译（剥离 shot 后）——恢复链路闭环', () => {
        const draft = CL.normalizeDraft(editorDraft());
        const forCompile = {
            ...draft,
            items: draft.items.map(({ shot, ...rest }) => rest)   // _draftForCompile 同款剥离
        };
        const r = CL.compileDraft(forCompile);
        expect(r.ok).toBe(true);
    });
});

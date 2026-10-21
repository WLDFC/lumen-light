/**
 * ==========================================================================
 * LoraSendPopup 投递名称归一单元测试（ADR 028）
 * 覆盖 resolveForTarget 的分流：精确命中原样发、目录基准不同按文件名
 * 唯一匹配换名（忽略大小写）、重名歧义不猜并回报候选、清单里没有如实
 * 失败、清单不可用（未连接/未加载）与空路径兜底。
 * 被测文件是浏览器端经典脚本（依赖全局 window），用 vm 模块加载；
 * 类只在方法体内引用 NodeTypes/LumenLight 等全局，顶层加载无需桩。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { window: {} };
vm.createContext(context);
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/components/lora-manager/LoraSendPopup.js'), 'utf-8'),
    context, { filename: 'LoraSendPopup.js' });
const LoraSendPopup = context.window.LoraSendPopup;

describe('LoraSendPopup.resolveForTarget 投递名称归一（ADR 028）', () => {
    // ComfyUI object_info 形态的清单（注册根与 LumenLight 扫描根不同）
    const COMFY_FILES = [
        'Moss/2f2qx-moss-image-epoch-10.safetensors',
        '角色/bubu2kufo_style_moss_uma_v1.safetensors',
        'hair_light.safetensors'
    ];

    test('精确命中：原样返回不换名', () => {
        const r = LoraSendPopup.resolveForTarget(COMFY_FILES, 'Moss/2f2qx-moss-image-epoch-10.safetensors');
        expect(r).toEqual({ path: 'Moss/2f2qx-moss-image-epoch-10.safetensors', resolved: true });
    });

    test('目录基准不同：按文件名唯一匹配换名（ resolved + renamed）', () => {
        // 管理器扫描根不同 → 相对路径带别的目录前缀，文件名一致
        const r = LoraSendPopup.resolveForTarget(COMFY_FILES, '外部收藏/Moss/2f2qx-moss-image-epoch-10.safetensors');
        expect(r).toEqual({
            path: 'Moss/2f2qx-moss-image-epoch-10.safetensors',
            resolved: true,
            renamed: true
        });
    });

    test('文件名匹配忽略大小写', () => {
        const r = LoraSendPopup.resolveForTarget(COMFY_FILES, 'x/HAIR_LIGHT.SAFETENSORS');
        expect(r.resolved).toBe(true);
        expect(r.renamed).toBe(true);
        expect(r.path).toBe('hair_light.safetensors');
    });

    test('重名歧义（同名多份）不猜：保留原值并带候选清单', () => {
        const files = ['a/dup_lora.safetensors', 'b/dup_lora.safetensors', 'other.safetensors'];
        const r = LoraSendPopup.resolveForTarget(files, 'c/dup_lora.safetensors');
        expect(r.resolved).toBe(false);
        expect(r.path).toBe('c/dup_lora.safetensors');
        expect(r.reason).toContain('多个同名文件');
        expect(r.candidates).toEqual(['a/dup_lora.safetensors', 'b/dup_lora.safetensors']);
    });

    test('清单里没有该文件：如实失败保留原值', () => {
        const r = LoraSendPopup.resolveForTarget(COMFY_FILES, 'x/not_exist_lora.safetensors');
        expect(r.resolved).toBe(false);
        expect(r.path).toBe('x/not_exist_lora.safetensors');
        expect(r.reason).toContain('未找到');
        expect(r.candidates).toBeUndefined();
    });

    test('清单不可用（空/非数组）：保留原值并说明原因', () => {
        for (const files of [[], undefined, null]) {
            const r = LoraSendPopup.resolveForTarget(files, 'a/b.safetensors');
            expect(r.resolved).toBe(false);
            expect(r.path).toBe('a/b.safetensors');
            expect(r.reason).toContain('清单不可用');
        }
    });

    test('空路径兜底', () => {
        const r = LoraSendPopup.resolveForTarget(COMFY_FILES, '');
        expect(r.resolved).toBe(false);
        expect(r.reason).toContain('空路径');
    });

    test('反斜杠清单（部分 Windows 版 ComfyUI 实测形态）：跨分隔符匹配并换发原生形态', () => {
        const winFiles = [
            'anima\\(美学品质修改器V5)anima-preview-3-masterpieces-v5.safetensors',
            '萝莉画风\\alice_(nikke)-000006.safetensors',
            'root_only.safetensors'
        ];
        // 管理器正斜杠路径 → 换成 ComfyUI 的反斜杠原生形态（提交校验按它走）
        const r1 = LoraSendPopup.resolveForTarget(winFiles, 'anima/(美学品质修改器V5)anima-preview-3-masterpieces-v5.safetensors');
        expect(r1.resolved).toBe(true);
        expect(r1.renamed).toBe(true);
        expect(r1.path).toBe('anima\\(美学品质修改器V5)anima-preview-3-masterpieces-v5.safetensors');
        const r2 = LoraSendPopup.resolveForTarget(winFiles, '外部/alice_(nikke)-000006.safetensors');
        expect(r2.path).toBe('萝莉画风\\alice_(nikke)-000006.safetensors');
        // 根目录文件两边形态本来就一致：精确命中
        expect(LoraSendPopup.resolveForTarget(winFiles, 'root_only.safetensors').resolved).toBe(true);
    });

    test('反斜杠清单下的重名歧义与未找到照常如实上报', () => {
        const winFiles = ['a\\dup.safetensors', 'b\\dup.safetensors'];
        const r = LoraSendPopup.resolveForTarget(winFiles, 'c/dup.safetensors');
        expect(r.resolved).toBe(false);
        expect(r.candidates).toEqual(['a\\dup.safetensors', 'b\\dup.safetensors']);
        const miss = LoraSendPopup.resolveForTarget(['a\\x.safetensors'], 'b/y.safetensors');
        expect(miss.reason).toContain('未找到');
    });
});

describe('LoraSendPopup.healEntries 历史条目自动补归一（ADR 028 决策四）', () => {
    const COMFY_FILES = [
        'Moss/alice_(nikke)-000006.safetensors',
        'hair_light.safetensors'
    ];

    test('清单就绪后：离线投递的原路径条目按唯一文件名匹配就地更正', () => {
        const entries = [
            { file: '外部收藏/alice_(nikke)-000006.safetensors' },   // 基准不同 → 换名
            { file: 'Moss/alice_(nikke)-000006.safetensors' },       // 已精确命中 → 不动
            { file: 'x/不存在的lora.safetensors' },                   // 真不在清单 → 不动
            { file: '' }                                             // 空值 → 不动
        ];
        const healed = LoraSendPopup.healEntries(entries, COMFY_FILES);
        expect(healed).toBe(1);
        expect(entries[0].file).toBe('Moss/alice_(nikke)-000006.safetensors');
        expect(entries[1].file).toBe('Moss/alice_(nikke)-000006.safetensors');
        expect(entries[2].file).toBe('x/不存在的lora.safetensors');
        expect(entries[3].file).toBe('');
    });

    test('重名歧义不猜：保持原值不更正', () => {
        const files = ['a/dup.safetensors', 'b/dup.safetensors'];
        const entries = [{ file: 'c/dup.safetensors' }];
        expect(LoraSendPopup.healEntries(entries, files)).toBe(0);
        expect(entries[0].file).toBe('c/dup.safetensors');
    });

    test('守卫：条目/清单为空或非数组返回 0 不抛错', () => {
        expect(LoraSendPopup.healEntries([], COMFY_FILES)).toBe(0);
        expect(LoraSendPopup.healEntries([{ file: 'x.safetensors' }], [])).toBe(0);
        expect(LoraSendPopup.healEntries(null, COMFY_FILES)).toBe(0);
        expect(LoraSendPopup.healEntries([{ file: 'x.safetensors' }], undefined)).toBe(0);
    });
});

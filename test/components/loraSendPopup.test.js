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

// ==================== 布局模式直投共享口（2026-11-08） ====================

describe('LoraSendPopup.deliverToPanel 一键投面板（弹窗面板钮/布局直投共用）', () => {
    afterEach(() => {
        context.window.promptPanel = undefined;
        context.LumenLight = undefined;
        context.localStorage = undefined;
    });

    /** 现成面板桩（每次深拷贝，防用例间串状态） */
    const makePanel = (overrides = {}) => ({
        comfyParams: {
            modelLists: { loras: ['Moss/2f2qx.safetensors'] },
            loras: [],
            loraStackCollapsed: true,
            render() { this.rendered = (this.rendered || 0) + 1; },
            ...overrides
        }
    });

    test('面板未初始化：ok=false（调用方回落投递弹窗），不做任何事', async () => {
        const r = await LoraSendPopup.deliverToPanel([{ path: 'a/x.safetensors', name: 'x' }]);
        expect(r).toEqual({ ok: false });
        expect(context.window.promptPanel).toBeUndefined();
    });

    test('成功：换名归一入栈、自动展开叠加区、render 收尾', async () => {
        context.window.promptPanel = makePanel();
        context.LumenLight = { generateId: () => 'id-1' };
        const store = {};
        context.localStorage = {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); }
        };
        const r = await LoraSendPopup.deliverToPanel(
            [{ path: '外部收藏/Moss/2f2qx.safetensors', name: 'x' }]);
        expect(r.ok).toBe(true);
        expect(r.results[0].renamed).toBe(true);   // 目录基准不同 → 按文件名换名
        const cp = context.window.promptPanel.comfyParams;
        expect(cp.loras).toEqual([
            { id: 'id-1', file: 'Moss/2f2qx.safetensors', strengthModel: 1, strengthClip: 1 }
        ]);
        expect(cp.loraStackCollapsed).toBe(false);          // 折叠态自动展开
        expect(store.comfyLoraStackCollapsed).toBe('false'); // 展开记忆同步
        expect(cp.rendered).toBe(1);
    });

    test('清单为空且有 loadModelLists：先补拉再投（时机差自愈）', async () => {
        let pulled = 0;
        context.window.promptPanel = makePanel({
            modelLists: { loras: [] },
            loraStackCollapsed: false,
            async loadModelLists() {
                pulled++;
                this.modelLists.loras = ['a/b.safetensors'];
            }
        });
        context.LumenLight = { generateId: () => 'id-2' };
        context.localStorage = { getItem: () => null, setItem: () => {} };
        const r = await LoraSendPopup.deliverToPanel([{ path: 'a/b.safetensors', name: 'b' }]);
        expect(pulled).toBe(1);
        expect(r.ok).toBe(true);
        expect(r.results[0].resolved).toBe(true);
    });
});

describe('LoraManager 布局模式（预制件开合与直投拦截）', () => {
    // 留白计算在 SidePanelLayout 共享层、开关在 LumenLayoutPanel 预制件
    // ——均先于 LoraManager 载入
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, '../../js/utils/SidePanelLayout.js'), 'utf-8'),
        context, { filename: 'SidePanelLayout.js' });
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, '../../js/components/LumenLayoutPanel.js'), 'utf-8'),
        context, { filename: 'LumenLayoutPanel.js' });
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, '../../js/components/LoraManager.js'), 'utf-8'),
        context, { filename: 'LoraManager.js' });
    const LoraManager = context.window.LoraManager;

    /** 可测实例：真实预制件 + 闭包桩按钮/窗口根（vm 跨界不依赖方法内 this） */
    function makeLayoutInst() {
        const mkClassList = () => {
            const set = new Set();
            return {
                set,
                toggle(c, on) { if (on) set.add(c); else set.delete(c); },
                has: (c) => set.has(c)
            };
        };
        const inst = Object.create(LoraManager.prototype);
        const button = {
            classList: mkClassList(), disabled: false, title: '', handlers: {},
            addEventListener(t, fn) { this.handlers[t] = fn; }
        };
        const dialog = { classList: mkClassList(), style: { setProperty() {}, removeProperty() {} } };
        const store = {};
        inst._layout = new context.window.LumenLayoutPanel({
            button,
            dialog: () => dialog,
            storageKey: 'lumen.loraLayout'
        });
        context.localStorage = {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); }
        };
        return { inst, button, dialog, store };
    }

    test('_openSendPopup：普通模式走弹窗不拦截', () => {
        const { inst } = makeLayoutInst();
        const opens = [];
        inst.sendPopupCtl = { open: (...a) => opens.push(a) };
        inst._openSendPopup({ path: 'a' }, 'anchor');
        expect(opens).toHaveLength(1);
    });

    test('_openSendPopup：布局模式直投；面板未初始化回落弹窗', async () => {
        const { inst } = makeLayoutInst();
        inst._layout.set(true);   // 预制件真身：类名/高亮/记忆一并到位
        const opens = [];
        inst.sendPopupCtl = { open: (...a) => opens.push(a) };
        context.window.promptPanel = undefined;   // deliverToPanel → ok:false
        await inst._openSendPopup({ path: 'a' }, 'anchor');
        await new Promise((r) => setImmediate(r));   // async 链路放行
        expect(opens).toHaveLength(1);            // 回落到弹窗
        expect(opens[0][1]).toBe('anchor');       // anchor 原样透传
    });
});

// 布局开关/留白实测的断言随实现收敛分别迁往：
//   test/components/lumenLayoutPanel.test.js（预制件开合/记忆/置灰/留白）
//   test/utils/sidePanelLayout.test.js（面板实测对齐口径）

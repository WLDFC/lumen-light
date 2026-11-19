/**
 * ==========================================================================
 * LoraTriggerManager「专用框」（target=3）单元测试
 * 覆盖 2026-11-14 新增的无实体写入目标：
 *   - setTarget(3)：旧实体框按书签摘除托管块，状态落 localStorage
 *   - target=3 时 _syncNow 不写任何实体框，lastBlock 照常记账
 *   - getVirtualBlock()：target=3 返回现算托管块（固定面板叠加区口径，
 *     不随弹窗遗留的画布模式漂移）；其余目标返回空串
 *   - PromptInputManager.getPrompts()：专用框块注入框 1 与框 2 之间
 *     （PromptMerge.join 空一行 + 补逗号）
 * 被测文件是浏览器端经典脚本（依赖全局 window/document/localStorage），
 * 用 vm 模块在同一上下文中执行（与 loraTriggerText.test.js 同一套做法）。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');

function load(file) {
    vm.runInContext(fs.readFileSync(require('path').join(ROOT, file), 'utf8'), context);
}

const store = {};
// 自引用 sandbox：window === 顶层全局，浏览器裸全局（LoraTriggerText /
// LoraFileSelect / PromptMerge 等）在 vm 内与 window 属性同源可查
const context = {
    console,
    document: {
        addEventListener: () => {},
        removeEventListener: () => {},
        getElementById: () => null
    },
    localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; }
    }
};
context.window = context;
vm.createContext(context);

load('js/utils/PromptMerge.js');
load('js/utils/LoraTriggerText.js');
load('js/components/LoraTriggerManager.js');
load('js/components/PromptInputManager.js');

/** 元数据就绪闸（loadMeta 链是微任务，等若干拍落地） */
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

/** 造一个触发词管理器：叠加区一只带触发词的 LoRA，两个可写的面板框 */
function makeManager() {
    context.window.LoraFileSelect = {
        _meta: { triggers: { 'a.safetensors': 'word1, word2' } },
        loadMeta: () => Promise.resolve()
    };
    const boxes = { posPrompt: { value: '' }, posPrompt2: { value: '' } };
    const mgr = new context.window.LoraTriggerManager({
        getStackLoras: () => [{ file: 'a.safetensors' }],
        promptInputManager: {
            get posPrompt() { return boxes.posPrompt; },
            get posPrompt2() { return boxes.posPrompt2; }
        }
    });
    return { mgr, boxes };
}

describe('LoraTriggerManager 专用框（target=3）', () => {
    beforeEach(async () => {
        for (const k of Object.keys(store)) delete store[k];
        context.window.promptPanel = undefined;
        await flush();
    });

    test('默认目标仍是正向框 1', () => {
        const { mgr } = makeManager();
        expect(mgr.state.target).toBe(1);
    });

    test('target=3：旧框按书签摘除托管块，虚拟框承接内容', async () => {
        const { mgr, boxes } = makeManager();
        await flush();
        // 先落在正向框 1（空框首写不带前导空行）
        expect(boxes.posPrompt.value).toBe('word1, word2');

        mgr.setTarget(3);
        await flush();
        // 框 1 恢复无托管块；虚拟框记账
        expect(boxes.posPrompt.value).toBe('');
        expect(boxes.posPrompt2.value).toBe('');
        expect(mgr.state.target).toBe(3);
        expect(mgr.state.lastBlock).toBe('word1, word2');
        expect(mgr.getVirtualBlock()).toBe('word1, word2');
    });

    test('target=3 时叠加区变更不落任何实体框，lastBlock 照常记账', async () => {
        const { mgr, boxes } = makeManager();
        await flush();
        mgr.setTarget(3);
        await flush();

        // 叠加区再加一只 LoRA（有触发词）
        context.window.LoraFileSelect._meta.triggers['b.safetensors'] = 'bword';
        mgr.getStackLoras = () => [{ file: 'a.safetensors' }, { file: 'b.safetensors' }];
        mgr.syncFromStack();
        await flush();

        expect(boxes.posPrompt.value).toBe('');
        expect(boxes.posPrompt2.value).toBe('');
        expect(mgr.state.lastBlock).toBe('word1, word2\nbword');
        expect(mgr.getVirtualBlock()).toBe('word1, word2\nbword');
    });

    test('切回正向框 1 时块重新写回框 1 末尾', async () => {
        const { mgr, boxes } = makeManager();
        await flush();
        mgr.setTarget(3);
        await flush();
        mgr.setTarget(1);
        await flush();
        expect(boxes.posPrompt.value).toBe('word1, word2');
        expect(mgr.getVirtualBlock()).toBe('');
    });

    test('getVirtualBlock 固定面板叠加区口径，不随弹窗遗留的 node 模式漂移', async () => {
        const { mgr } = makeManager();
        await flush();
        mgr.setTarget(3);
        await flush();
        // 模拟开过画布节点弹窗后关闭：_mode/_node 残留
        mgr._mode = 'node';
        mgr._node = null;
        expect(mgr.getVirtualBlock()).toBe('word1, word2');
    });

    test('target=3 持久化往返（localStorage）', async () => {
        const { mgr } = makeManager();
        await flush();
        mgr.setTarget(3);
        await flush();

        const mgr2 = new context.window.LoraTriggerManager({
            getStackLoras: () => [{ file: 'a.safetensors' }]
        });
        expect(mgr2.state.target).toBe(3);
    });

    test('target=2 持久化不受 3 引入影响', () => {
        store['lumen.loraTriggers.v1'] = JSON.stringify({ target: 2 });
        const mgr = new context.window.LoraTriggerManager({});
        expect(mgr.state.target).toBe(2);
    });
});

describe('PromptInputManager.getPrompts 专用框注入', () => {
    beforeEach(async () => {
        for (const k of Object.keys(store)) delete store[k];
        context.promptPanel = undefined;
        await flush();
    });

    test('专用框块插在框 1 与框 2 之间（空一行 + 补逗号）', async () => {
        const { mgr } = makeManager();
        await flush();
        mgr.setTarget(3);
        await flush();
        context.window.promptPanel = { triggerManager: mgr };

        const pim = Object.create(context.window.PromptInputManager.prototype);
        pim.posPrompt = { value: 'masterpiece' };
        pim.posPrompt2 = { value: 'a girl' };
        pim.negPrompt = { value: 'bad' };

        const res = pim.getPrompts();
        expect(res.positive).toBe('masterpiece,\n\nword1, word2,\n\na girl');
        expect(res.negative).toBe('bad');
    });

    test('非专用框目标不注入（块已在实体框里，不重复）', async () => {
        const { mgr } = makeManager();
        await flush();
        context.window.promptPanel = { triggerManager: mgr };

        const pim = Object.create(context.window.PromptInputManager.prototype);
        pim.posPrompt = { value: 'masterpiece\n\nword1, word2' };
        pim.posPrompt2 = { value: '' };
        pim.negPrompt = { value: '' };

        expect(pim.getPrompts().positive).toBe('masterpiece\n\nword1, word2');
    });

    test('无 triggerManager 实例时行为与旧版一致', () => {
        context.window.promptPanel = undefined;
        const pim = Object.create(context.window.PromptInputManager.prototype);
        pim.posPrompt = { value: 'a' };
        pim.posPrompt2 = { value: 'b' };
        pim.negPrompt = { value: '' };
        expect(pim.getPrompts().positive).toBe('a,\n\nb');
    });
});

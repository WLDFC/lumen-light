/**
 * ==========================================================================
 * LoraTriggerText 单元测试
 * 覆盖触发词托管块纯函数层：
 *   - normalizeRel：反斜杠归一、首尾分隔符剔除（ADR 028 同源问题）
 *   - parseWords：中英文逗号拆分、trim、去空、去重
 *   - weightWord：权重 1 原文、≠1 (词:权重)、小数格式化
 *   - composeBlock：默认全开权重 1、逐词开关、LoRA 级开关、栈序多行
 *   - applyBlock：书签原位替换 / 整串去重跳过 / 书签丢失末尾重写 /
 *     空块移除（连带空行分隔符）/ 空框首写不留前导空行
 * 被测文件是浏览器端经典脚本（依赖全局 window），用 vm 模块在
 * 同一上下文中执行（与 promptMerge.test.js 同一套做法）。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: {} };
vm.createContext(context);

const source = fs.readFileSync(
    path.join(__dirname, '../../js/utils/LoraTriggerText.js'), 'utf-8');
vm.runInContext(source, context, { filename: 'LoraTriggerText.js' });

const LT = context.window.LoraTriggerText;

describe('normalizeRel 路径归一', () => {
    test('反斜杠换正斜杠（ComfyUI object_info 原生形态）', () => {
        expect(LT.normalizeRel('sub\\dir\\model.safetensors'))
            .toBe('sub/dir/model.safetensors');
    });
    test('正斜杠原样保留', () => {
        expect(LT.normalizeRel('sub/dir/model.safetensors'))
            .toBe('sub/dir/model.safetensors');
    });
    test('剔除首尾分隔符与空值', () => {
        expect(LT.normalizeRel('/a/b/')).toBe('a/b');
        expect(LT.normalizeRel('')).toBe('');
        expect(LT.normalizeRel(null)).toBe('');
    });
});

describe('parseWords 触发词解析', () => {
    test('逗号拆分 + trim + 去空（Civitai join(", ") 形态）', () => {
        expect(LT.parseWords('word one, word two ,  word three'))
            .toEqual(['word one', 'word two', 'word three']);
    });
    test('全角逗号同样拆分', () => {
        expect(LT.parseWords('蓝发，红色衣服')).toEqual(['蓝发', '红色衣服']);
    });
    test('去重保序与空串', () => {
        expect(LT.parseWords('a, b, a, , c, b')).toEqual(['a', 'b', 'c']);
        expect(LT.parseWords('')).toEqual([]);
        expect(LT.parseWords(null)).toEqual([]);
    });
});

describe('weightWord 权重语法', () => {
    test('权重 1 原文写入', () => {
        expect(LT.weightWord('smile', 1)).toBe('smile');
        expect(LT.weightWord('smile')).toBe('smile');
    });
    test('权重 ≠1 写 (词:权重)', () => {
        expect(LT.weightWord('smile', 1.2)).toBe('(smile:1.2)');
        expect(LT.weightWord('smile', 0.8)).toBe('(smile:0.8)');
    });
    test('小数格式化去尾零，最多两位', () => {
        expect(LT.weightWord('smile', 1.2)).toBe('(smile:1.2)');
        expect(LT.weightWord('smile', 1.5)).toBe('(smile:1.5)');
        expect(LT.weightWord('smile', 1.05)).toBe('(smile:1.05)');
        expect(LT.weightWord('smile', 1.234)).toBe('(smile:1.23)');
    });
    test('非法权重按原文处理', () => {
        expect(LT.weightWord('smile', NaN)).toBe('smile');
        expect(LT.weightWord('smile', Infinity)).toBe('smile');
    });
});

describe('composeBlock 托管块拼装', () => {
    const entries = [
        { rel: 'a.safetensors', words: ['aword1', 'aword2'] },
        { rel: 'b.safetensors', words: ['bword'] }
    ];

    test('默认全开权重 1：每 LoRA 一行、词逗号连接', () => {
        expect(LT.composeBlock(entries, {})).toBe('aword1, aword2\nbword');
        expect(LT.composeBlock(entries, null)).toBe('aword1, aword2\nbword');
    });

    test('逐词开关：关闭的词剔除，全关的 LoRA 整行不出现', () => {
        const cfg = {
            'a.safetensors': { words: { aword1: { on: false }, aword2: { on: true } } },
            'b.safetensors': { words: { bword: { on: false } } }
        };
        expect(LT.composeBlock(entries, cfg)).toBe('aword2');
    });

    test('LoRA 级开关关闭整只跳过', () => {
        const cfg = { 'a.safetensors': { enabled: false } };
        expect(LT.composeBlock(entries, cfg)).toBe('bword');
    });

    test('未记录的新词默认开启（Civitai 后补词自动进块）', () => {
        const cfg = { 'a.safetensors': { words: { aword1: { on: true, weight: 1.3 } } } };
        expect(LT.composeBlock(entries, cfg)).toBe('(aword1:1.3), aword2\nbword');
    });

    test('全部无生效词 → 空串', () => {
        expect(LT.composeBlock([], {})).toBe('');
        expect(LT.composeBlock(entries, {
            'a.safetensors': { enabled: false },
            'b.safetensors': { enabled: false }
        })).toBe('');
    });
});

describe('applyBlock 书签写入策略', () => {
    test('空框首写：不留前导空行', () => {
        expect(LT.applyBlock('', 't1', '')).toEqual({ value: 't1', changed: true });
    });

    test('非空框追加：与原提示词空一行分隔', () => {
        expect(LT.applyBlock('masterpiece', 't1', ''))
            .toEqual({ value: 'masterpiece\n\nt1', changed: true });
    });

    test('书签原位替换（权重改动）', () => {
        expect(LT.applyBlock('base\n\nold', 'new', 'old'))
            .toEqual({ value: 'base\n\nnew', changed: true });
    });

    test('整串去重：块已在框内（书签相同）→ 不动', () => {
        expect(LT.applyBlock('base\n\nt1', 't1', 't1'))
            .toEqual({ value: 'base\n\nt1', changed: false });
    });

    test('整串去重：用户手写过相同内容 → 跳过', () => {
        expect(LT.applyBlock('t1\n\nbase', 't1', ''))
            .toEqual({ value: 't1\n\nbase', changed: false });
    });

    test('书签丢失（手删块）→ 末尾重写', () => {
        expect(LT.applyBlock('base', 't1', 'old'))
            .toEqual({ value: 'base\n\nt1', changed: true });
    });

    test('空块 + 书签在框 → 整体移除且不留连续空行', () => {
        expect(LT.applyBlock('base\n\nt1', '', 't1'))
            .toEqual({ value: 'base', changed: true });
        // 块在中间（用户挪动过）也收敛
        expect(LT.applyBlock('a\n\nt1\n\nb', '', 't1'))
            .toEqual({ value: 'a\n\nb', changed: true });
    });

    test('空块 + 书签不在框 → 不动', () => {
        expect(LT.applyBlock('base', '', 't1'))
            .toEqual({ value: 'base', changed: false });
        expect(LT.applyBlock('base', '', ''))
            .toEqual({ value: 'base', changed: false });
    });

    test('书签相同内容不同位置：替换跟随书签所在处', () => {
        expect(LT.applyBlock('t1\n\nbase', 't2', 't1'))
            .toEqual({ value: 't2\n\nbase', changed: true });
    });

    test('null 框内容按空串处理', () => {
        expect(LT.applyBlock(null, 't1', '')).toEqual({ value: 't1', changed: true });
    });
});

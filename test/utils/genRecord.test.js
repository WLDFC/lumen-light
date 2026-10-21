/**
 * ==========================================================================
 * GenRecord 单元测试（生成参数记录——图片溯源/生成同款数据层）
 * 覆盖：
 *   - forComfy/forApi/forRh 三链路构建器的字段归一（空值兜底、loras 过滤）
 *   - modeLabel 徽章文案与未知模式回显
 *   - describeRows 展示装配：comfy 参数摘要（null 不占行）、api 复合键
 *     拆分展示、rh 参数清单透传
 *   - loraText 强度标注（≠1 括号、=1 原文）
 *   - formatTime 时间格式化
 * 被测文件是浏览器端经典脚本（依赖全局 window），用 vm 模块在
 * 同一上下文中执行（与 loraTriggerText.test.js 同一套做法）。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: {} };
vm.createContext(context);

const source = fs.readFileSync(
    path.join(__dirname, '../../js/utils/GenRecord.js'), 'utf-8');
vm.runInContext(source, context, { filename: 'GenRecord.js' });

const GR = context.window.GenRecord;

describe('三链路构建器字段归一', () => {
    test('forComfy：params 空值兜底为 null，loras 过滤无 file 条目', () => {
        const info = GR.forComfy({
            positive: ' a girl ',
            workflowId: 'wf-1',
            workflowName: '测试工作流',
            params: { steps: 28, cfg: null },
            loras: [
                { file: 'a.safetensors', strengthModel: 0.8, strengthClip: 1 },
                null,
                { strengthModel: 0.5 }
            ],
            node: null
        });
        expect(info.mode).toBe('comfy');
        expect(info.positive).toBe(' a girl ');
        expect(info.negative).toBe('');
        expect(info.params).toEqual({
            steps: 28, cfg: null, sampler: null,
            sizeW: null, sizeH: null, denoise: null
        });
        expect(info.loras).toEqual([{ file: 'a.safetensors', strengthModel: 0.8, strengthClip: 1 }]);
        expect(info.sourceNodeId).toBeNull();
        expect(info.sourceNodeTitle).toBe('提示词面板');
        expect(typeof info.time).toBe('number');
    });

    test('forComfy：来源节点取 getTitle()（含 #NNN 编号）', () => {
        const info = GR.forComfy({
            node: { id: 'n1', getTitle: () => 'Generate #012' }
        });
        expect(info.sourceNodeId).toBe('n1');
        expect(info.sourceNodeTitle).toBe('Generate #012');
    });

    test('forApi：model/size 等缺省兜底', () => {
        const info = GR.forApi({ positive: 'cat', model: 'openai||gpt-image-1' });
        expect(info.mode).toBe('api');
        expect(info.provider).toBe('');
        expect(info.size).toBeNull();
        expect(info.quality).toBe('');
        expect(info.refCount).toBe(0);
    });

    test('forApi：sourceTitle 覆盖来源名（聊天窗口来源，无节点）', () => {
        const info = GR.forApi({
            positive: 'cat',
            model: 'openai||gpt-image-1',
            sourceTitle: '聊天窗口',
            node: null
        });
        expect(info.sourceNodeId).toBeNull();
        expect(info.sourceNodeTitle).toBe('聊天窗口');
        // 不传 sourceTitle 时维持原兜底：无节点 = 提示词面板
        expect(GR.forApi({ node: null }).sourceNodeTitle).toBe('提示词面板');
    });

    test('forRh：paramList 过滤无 label 条目并字符串化', () => {
        const info = GR.forRh({
            resourceKind: 'app',
            resourceId: 'rh-9',
            resourceName: '云端应用',
            instanceType: 'pro',
            paramList: [
                { label: '步数', value: 24 },
                { label: '' },
                { label: '种子', value: null }
            ]
        });
        expect(info.paramList).toEqual([
            { label: '步数', value: '24' },
            { label: '种子', value: '' }
        ]);
    });
});

describe('describeRows 展示装配', () => {
    test('comfy：null 参数不占行，工作流名优先于 id', () => {
        const rows = GR.describeRows(GR.forComfy({
            workflowId: 'wf-1',
            workflowName: 'anima画布工作流',
            model: 'anima_v2.safetensors',
            params: { steps: 28, cfg: 4.5, sampler: 'euler', sizeW: null, sizeH: null, denoise: null }
        }));
        const labels = rows.map((r) => r.label);
        expect(labels).toEqual(['工作流', '主模型', '步数', 'CFG', '采样器']);
        expect(rows[0].value).toBe('anima画布工作流');
    });

    test('api：复合键取模型 ID 段，尺寸/参考图条件成行，厂商不单列', () => {
        const rows = GR.describeRows(GR.forApi({
            model: 'openai||gpt-image-1',
            provider: 'openai',
            size: '1024x1024',
            refCount: 2
        }));
        const map = Object.fromEntries(rows.map((r) => [r.label, r.value]));
        expect(map['模型']).toBe('gpt-image-1');
        expect(map['厂商']).toBeUndefined();
        expect(map['尺寸']).toBe('1024x1024');
        expect(map['参考图']).toBe('2 张');
        expect(map['比例']).toBeUndefined();
        expect(map['质量']).toBeUndefined();
    });

    test('rh：类型/资源/档位 + paramList 透传', () => {
        const rows = GR.describeRows(GR.forRh({
            resourceKind: 'app',
            resourceId: 'rh-9',
            resourceName: '',
            instanceType: 'pro',
            paramList: [{ label: '提示词', value: 'hello' }]
        }));
        const map = Object.fromEntries(rows.map((r) => [r.label, r.value]));
        expect(map['类型']).toBe('应用');
        expect(map['资源']).toBe('rh-9');
        expect(map['档位']).toBe('pro');
        expect(map['提示词']).toBe('hello');
    });

    test('空记录返回空数组', () => {
        expect(GR.describeRows(null)).toEqual([]);
    });
});

describe('loraText / modeLabel / formatTime', () => {
    test('loraText：强度≠1 括号标注，=1 原文', () => {
        expect(GR.loraText({ file: 'a.safetensors', strengthModel: 0.8 })).toBe('a.safetensors (0.8)');
        expect(GR.loraText({ file: 'a.safetensors', strengthModel: 1 })).toBe('a.safetensors');
        expect(GR.loraText({ file: 'b.safetensors' })).toBe('b.safetensors');
        expect(GR.loraText(null)).toBe('');
    });

    test('modeLabel：三模式文案与未知回显', () => {
        expect(GR.modeLabel('comfy')).toBe('ComfyUI');
        expect(GR.modeLabel('api')).toBe('API 生图');
        expect(GR.modeLabel('rh')).toBe('RunningHub');
        expect(GR.modeLabel('x')).toBe('x');
        expect(GR.modeLabel(undefined)).toBe('');
    });

    test('formatTime：YYYY-MM-DD HH:mm 定长格式', () => {
        expect(GR.formatTime(new Date(2026, 9, 30, 8, 5).getTime())).toBe('2026-10-30 08:05');
        expect(GR.formatTime(0)).toBe('');
    });
});

/**
 * ==========================================================================
 * ImagePipeline 忽略节点（bypass）过滤测试（2026-11-09）
 * 语义：遍历照穿、贡献剔除——被忽略的节点连线不动、BFS 继续穿过，
 * 但其文本 / LoRA 堆栈 / 图片 / 视频贡献在各收集点被剔除。
 * vm 加载经典脚本，NodeTypes / PromptMerge 经 context 注入。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { window: {}, document: {} };
vm.createContext(context);
for (const f of ['NodeTypes.js', 'PromptMerge.js', 'ImagePipeline.js']) {
    vm.runInContext(
        fs.readFileSync(path.join(__dirname, '../../js/utils', f), 'utf-8'),
        context, { filename: f });
}
// ImagePipeline 无 window 导出（浏览器靠顶层 class 声明进全局），
// vm 里顶层 class 在脚本间共享词法作用域，这里显式挂到 window 供 Node 侧取用；
// PromptMerge 只挂了 window，裸标识符在 vm 里解析不到，补一份到 context 全局
vm.runInContext('window.ImagePipeline = ImagePipeline; PromptMerge = window.PromptMerge;', context);
const ImagePipeline = context.window.ImagePipeline;
const NodeTypes = context.window.NodeTypes;

// 测试画布对象工厂：id + source 最小可用（ImagePipeline 是纯数据层）
function promptNode(id, text, bypassed) {
    return { id, source: NodeTypes.SOURCE.PROMPT_NODE, text, bypassed };
}
function loraNode(id, entries, bypassed) {
    return { id, source: NodeTypes.SOURCE.LORA_NODE, entries, bypassed, getEnabledLoras() { return this.entries; } };
}
function canvasImage(id, bypassed) {
    return { id, source: 'save', img: { src: 'data:image/png;base64,x' }, bypassed };
}
function video(id, bypassed) {
    return { id, source: NodeTypes.SOURCE.VIDEO, img: { src: 'data:image/png;base64,x' }, videoUrl: '/data/videos/' + id + '.mp4', bypassed };
}

describe('collectPrompt 忽略节点贡献剔除', () => {
    test('被忽略的提示词节点文本不进合并，链照穿', () => {
        // gen ← p2(忽略) ← p1
        const objs = [
            { id: 'gen', source: NodeTypes.SOURCE.IMAGE_GEN_NODE },
            promptNode('p1', 'one'),
            promptNode('p2', 'two', true)
        ];
        const conns = [
            { fromId: 'p2', toId: 'gen' },
            { fromId: 'p1', toId: 'p2' }
        ];
        const pipe = new ImagePipeline(conns, objs);
        expect(pipe.collectPrompt('gen')).toBe('one');
        expect(pipe.collectUpstreamPromptNodes('gen').length).toBe(2);  // 遍历照穿
    });

    test('被忽略的 LoRA 节点不挡链上文本透传', () => {
        // gen ← lora(忽略) ← p1
        const objs = [
            { id: 'gen', source: NodeTypes.SOURCE.IMAGE_GEN_NODE },
            promptNode('p1', 'keep'),
            loraNode('l1', [])
        ];
        objs[2].bypassed = true;
        const conns = [
            { fromId: 'l1', toId: 'gen' },
            { fromId: 'p1', toId: 'l1' }
        ];
        const pipe = new ImagePipeline(conns, objs);
        expect(pipe.collectPrompt('gen')).toBe('keep');
    });
});

describe('collectLoras 忽略节点堆栈剔除', () => {
    test('被忽略的 LoRA 节点堆栈不收，未忽略的正常收', () => {
        const objs = [
            { id: 'gen', source: NodeTypes.SOURCE.IMAGE_GEN_NODE },
            promptNode('p1', 'p'),
            loraNode('l1', [{ file: 'a.safetensors', strengthModel: 1, strengthClip: 1 }]),
            loraNode('l2', [{ file: 'b.safetensors', strengthModel: 0.8, strengthClip: 0.8 }], true)
        ];
        const conns = [
            { fromId: 'l1', toId: 'gen' },
            { fromId: 'l2', toId: 'l1' },
            { fromId: 'p1', toId: 'l2' }
        ];
        const pipe = new ImagePipeline(conns, objs);
        expect(pipe.collectLoras('gen')).toEqual([
            { file: 'a.safetensors', strengthModel: 1, strengthClip: 1 }
        ]);
    });
});

describe('collectImageEntries 忽略图片本体剔除、串联链照穿', () => {
    beforeEach(() => {
        // slotPayload 依赖 document/canvas（异步编码），测试桩化为恒等透传
        ImagePipeline.slotPayload = (obj) => Promise.resolve({ image: obj.id, mask: null });
    });

    test('被忽略的图片不进参考图，其上游图片仍收入', () => {
        // gen ← img2(忽略) ← img1
        const objs = [
            { id: 'gen', source: NodeTypes.SOURCE.IMAGE_GEN_NODE },
            canvasImage('img1'),
            canvasImage('img2', true)
        ];
        const conns = [
            { fromId: 'img2', toId: 'gen' },
            { fromId: 'img1', toId: 'img2' }
        ];
        const pipe = new ImagePipeline(conns, objs);
        return pipe.collectImageEntries('gen').then((entries) => {
            expect(entries).toEqual([{ image: 'img1', mask: null }]);
        });
    });

    test('未忽略图片正常收入', () => {
        const objs = [
            { id: 'gen', source: NodeTypes.SOURCE.IMAGE_GEN_NODE },
            canvasImage('img1')
        ];
        const conns = [{ fromId: 'img1', toId: 'gen' }];
        const pipe = new ImagePipeline(conns, objs);
        return pipe.collectImageEntries('gen').then((entries) => {
            expect(entries).toEqual([{ image: 'img1', mask: null }]);
        });
    });
});

describe('collectVideos 忽略视频剔除', () => {
    test('被忽略的视频不收，未忽略的正常收', () => {
        const objs = [
            { id: 'gen', source: NodeTypes.SOURCE.IMAGE_GEN_NODE },
            promptNode('p1', 'p'),
            video('v1'),
            video('v2', true)
        ];
        const conns = [
            { fromId: 'v1', toId: 'gen' },
            { fromId: 'v2', toId: 'p1' },
            { fromId: 'p1', toId: 'gen' }
        ];
        const pipe = new ImagePipeline(conns, objs);
        expect(pipe.collectVideos('gen')).toEqual(['/data/videos/v1.mp4']);
    });
});

/**
 * ==========================================================================
 * CanvasDelivery 单元测试
 * 覆盖交付出口纯决策：下载计划（视频下视频文件本身/图片下合成图）、
 * 资产入库计划（视频封面强制 .png 名）、URL 归一化与扩展名替换。
 * 被测文件是浏览器端经典脚本，用 vm 上下文按浏览器加载顺序执行
 * （同 CanvasHitTester 测试模式）。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: {} };
vm.createContext(context);

[
    '../../js/utils/NodeTypes.js',
    '../../js/utils/CanvasDelivery.js'
].forEach((file) => {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf-8');
    vm.runInContext(source, context, { filename: file });
});

const CanvasDelivery = context.window.CanvasDelivery;
const NodeTypes = context.window.NodeTypes;

describe('CanvasDelivery.normalizeVideoUrl', () => {
    test('无前导斜杠的本地路径补斜杠', () => {
        expect(CanvasDelivery.normalizeVideoUrl('data/videos/a.mp4')).toBe('/data/videos/a.mp4');
    });

    test('已有前导斜杠保持不变', () => {
        expect(CanvasDelivery.normalizeVideoUrl('/data/videos/a.mp4')).toBe('/data/videos/a.mp4');
    });

    test('空值返回空字符串', () => {
        expect(CanvasDelivery.normalizeVideoUrl('')).toBe('');
        expect(CanvasDelivery.normalizeVideoUrl(null)).toBe('');
        expect(CanvasDelivery.normalizeVideoUrl(undefined)).toBe('');
    });
});

describe('CanvasDelivery.withExtension', () => {
    test('替换已有扩展名', () => {
        expect(CanvasDelivery.withExtension('video_1.mp4', 'png')).toBe('video_1.png');
    });

    test('无扩展名时追加', () => {
        expect(CanvasDelivery.withExtension('video_1', 'png')).toBe('video_1.png');
    });

    test('只认最后一个点（含多点文件名）', () => {
        expect(CanvasDelivery.withExtension('my.video.mp4', 'png')).toBe('my.video.png');
    });

    test('空文件名走兜底基名', () => {
        expect(CanvasDelivery.withExtension('', 'png')).toBe('file.png');
    });
});

describe('CanvasDelivery.getDownloadPlan', () => {
    const videoObj = {
        id: 'abcdef1234567890',
        source: NodeTypes.SOURCE.VIDEO,
        img: { src: 'data:image/png;base64,COVER' },
        videoUrl: 'data/videos/video_1.mp4',
        name: '我的视频.mp4'
    };

    test('视频对象：下视频文件本身，URL 归一化，不用封面', () => {
        const plan = CanvasDelivery.getDownloadPlan(videoObj, null);
        expect(plan).toEqual({
            kind: 'video',
            url: '/data/videos/video_1.mp4',
            filename: '我的视频.mp4'
        });
        expect(plan.src).toBeUndefined();
    });

    test('视频对象无 name 时补默认 mp4 文件名（id 前 6 位）', () => {
        const plan = CanvasDelivery.getDownloadPlan({ ...videoObj, name: undefined }, null);
        expect(plan.filename.startsWith('lumen-video-abcdef-')).toBe(true);
        expect(plan.filename.endsWith('.mp4')).toBe(true);
    });

    test('图片对象：用调用方传入的合成图源', () => {
        const obj = { id: 'aaa111', source: 'unknown', img: { src: 'data:image/png;base64,RAW' }, name: '图.png' };
        const plan = CanvasDelivery.getDownloadPlan(obj, 'data:image/png;base64,COMPOSITE');
        expect(plan).toEqual({
            kind: 'image',
            src: 'data:image/png;base64,COMPOSITE',
            filename: '图.png'
        });
    });

    test('图片对象合成源缺失时回退原图 src', () => {
        const obj = { id: 'aaa111', source: 'unknown', img: { src: 'data:image/png;base64,RAW' } };
        const plan = CanvasDelivery.getDownloadPlan(obj, null);
        expect(plan.src).toBe('data:image/png;base64,RAW');
        expect(plan.filename.startsWith('lumen-image-aaa111-')).toBe(true);
    });

    test('完全无源的占位对象也不抛错（src 空字符串，由调用方报错）', () => {
        const plan = CanvasDelivery.getDownloadPlan({ id: 'x1', source: 'generation-placeholder' }, null);
        expect(plan.kind).toBe('image');
        expect(plan.src).toBe('');
    });
});

describe('CanvasDelivery.getAssetPlan', () => {
    test('视频对象：交付封面，文件名强制 .png（防封面挂 .mp4 名入库）', () => {
        const obj = {
            id: 'vid123',
            source: NodeTypes.SOURCE.VIDEO,
            img: { src: 'data:image/png;base64,COVER' },
            videoUrl: '/data/videos/video_1.mp4',
            name: 'video_1.mp4'
        };
        const plan = CanvasDelivery.getAssetPlan(obj, null);
        expect(plan.src).toBe('data:image/png;base64,COVER');
        expect(plan.filename).toBe('video_1.png');
    });

    test('视频对象无 name 时默认封面名也是 .png', () => {
        const obj = { id: 'vid123', source: NodeTypes.SOURCE.VIDEO, img: { src: 'data:image/png;base64,C' } };
        const plan = CanvasDelivery.getAssetPlan(obj, null);
        expect(plan.filename.startsWith('lumen-cover-vid123-')).toBe(true);
        expect(plan.filename.endsWith('.png')).toBe(true);
    });

    test('图片对象：文件名与源原样保留', () => {
        const obj = { id: 'img222', source: 'unknown', img: { src: 'data:image/png;base64,R' }, name: '画.png' };
        const plan = CanvasDelivery.getAssetPlan(obj, 'data:image/png;base64,COMPOSITE');
        expect(plan).toEqual({
            src: 'data:image/png;base64,COMPOSITE',
            filename: '画.png'
        });
    });
});

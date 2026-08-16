/**
 * ==========================================================================
 * ImageProxyCache 单元测试
 * 覆盖显示代理的绘制源决策（原生/代理切换、档位上限、滞回区间）。
 * 被测文件是浏览器端经典脚本（顶层 const/class 依赖全局词法作用域，
 * require() 会把它们变成模块私有），这里用 vm 模块在同一个上下文中
 * 执行源码，模拟 script 标签的加载行为。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: {} };
vm.createContext(context);

['../../js/canvas/ImageProxyCache.js'].forEach((file) => {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf-8');
    vm.runInContext(source, context, { filename: file });
});

const ImageProxyCache = context.window.ImageProxyCache;

/** 便捷构造决策参数（原生 2048 长边为生成图典型尺寸） */
function decide({ native = 2048, display, proxyMax, usingProxy }) {
    return ImageProxyCache.selectQuality({
        nativeLongEdge: native,
        displayLongEdgePx: display,
        proxyMaxLongEdge: proxyMax,
        usingProxy
    });
}

describe('ImageProxyCache.selectQuality 绘制源决策', () => {
    test('native 档（proxyMaxLongEdge 为 null）永远返回原生绘制', () => {
        expect(decide({ display: 100, proxyMax: null, usingProxy: false })).toBe('native');
        expect(decide({ display: 999999, proxyMax: null, usingProxy: false })).toBe('native');
    });

    test('原图不大于代理上限时返回原生绘制（代理无收益）', () => {
        expect(decide({ native: 1024, display: 500, proxyMax: 1024, usingProxy: false })).toBe('native');
        expect(decide({ native: 512, display: 100, proxyMax: 1024, usingProxy: false })).toBe('native');
    });

    test('显示长边小于代理上限时使用代理（缩小/常规视角）', () => {
        expect(decide({ display: 800, proxyMax: 1024, usingProxy: false })).toBe('proxy');
        expect(decide({ display: 511, proxyMax: 512, usingProxy: false })).toBe('proxy');
    });

    test('显示长边达到代理上限且未用代理时返回原生（放大查看细节）', () => {
        expect(decide({ display: 1024, proxyMax: 1024, usingProxy: false })).toBe('native');
        expect(decide({ display: 2048, proxyMax: 512, usingProxy: false })).toBe('native');
    });

    test('滞回：已用代理时，超出上限 15% 以内仍保持代理，避免临界闪烁', () => {
        // 1024 × 1.15 = 1177.6：1176 以内保持代理
        expect(decide({ display: 1100, proxyMax: 1024, usingProxy: true })).toBe('proxy');
        expect(decide({ display: 1170, proxyMax: 1024, usingProxy: true })).toBe('proxy');
        // 超过滞回边界才退回原生
        expect(decide({ display: 1180, proxyMax: 1024, usingProxy: true })).toBe('native');
        // 对比：同样的显示尺寸，未用代理时直接判原生
        expect(decide({ display: 1100, proxyMax: 1024, usingProxy: false })).toBe('native');
    });

    test('原生尺寸缺失（0/undefined）时保守返回原生绘制', () => {
        const raw = (nativeLongEdge) => ImageProxyCache.selectQuality({
            nativeLongEdge,
            displayLongEdgePx: 100,
            proxyMaxLongEdge: 1024,
            usingProxy: false
        });
        expect(raw(0)).toBe('native');
        expect(raw(undefined)).toBe('native');
        expect(raw(null)).toBe('native');
    });
});

describe('ImageProxyCache.getProxyMaxLongEdge 档位映射', () => {
    test('balanced → 1024，performance → 512', () => {
        expect(ImageProxyCache.getProxyMaxLongEdge('balanced')).toBe(1024);
        expect(ImageProxyCache.getProxyMaxLongEdge('performance')).toBe(512);
    });

    test('native 与未知档位返回 null（禁用代理）', () => {
        expect(ImageProxyCache.getProxyMaxLongEdge('native')).toBeNull();
        expect(ImageProxyCache.getProxyMaxLongEdge('unknown')).toBeNull();
        expect(ImageProxyCache.getProxyMaxLongEdge(undefined)).toBeNull();
    });
});

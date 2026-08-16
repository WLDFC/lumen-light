/**
 * ==========================================================================
 * llmResolution.js 单元测试
 * 覆盖模型分辨率约束（上限降级 / 下限升档）与最小总像素判定。
 * llmResolution.js 是浏览器端脚本（通过 window 暴露），
 * Node 环境下先注入 window 全局再加载。
 * ==========================================================================
 */

global.window = global;
require('../../js/utils/llmResolution.js');

const LlmResolution = window.LlmResolution;

describe('applyModelResolutionConstraints - Seedream 4.5 最小总像素', () => {
    const model = 'doubao-seedream-4-5-251128';

    test('1K 档 1:1 等比放大到 1920x1920（总像素 3686400）', () => {
        const res = LlmResolution.getResolutionForModel(model, '1:1', '1K');
        expect(res).toEqual({ width: 1920, height: 1920, upgraded: true });
    });

    test('1K 档 16:9 等比放大到 2560x1440', () => {
        const res = LlmResolution.getResolutionForModel(model, '16:9', '1K');
        expect(res).toEqual({ width: 2560, height: 1440, upgraded: true });
    });

    test('1K 档 9:16 等比放大到 1440x2560', () => {
        const res = LlmResolution.getResolutionForModel(model, '9:16', '1K');
        expect(res).toEqual({ width: 1440, height: 2560, upgraded: true });
    });

    test('2K 档 16:9 恰好压线（2560x1440），不标记升档', () => {
        const res = LlmResolution.getResolutionForModel(model, '16:9', '2K');
        expect(res).toEqual({ width: 2560, height: 1440 });
    });

    test('2K 档 1:1（2560x2560）与 4K 档不受影响', () => {
        expect(LlmResolution.getResolutionForModel(model, '1:1', '2K')).toEqual({ width: 2560, height: 2560 });
        expect(LlmResolution.getResolutionForModel(model, '1:1', '4K')).toEqual({ width: 3840, height: 3840 });
    });
});

describe('applyModelResolutionConstraints - 其他模型不受下限升档影响', () => {
    test('通用模型 1K 档保持 1024x1024', () => {
        const res = LlmResolution.getResolutionForModel('some-unknown-model', '1:1', '1K');
        expect(res).toEqual({ width: 1024, height: 1024 });
    });

    test('Seedream 5.0 pro 走原有 2K 上限降级', () => {
        const res = LlmResolution.getResolutionForModel('doubao-seedream-5-0-pro', '1:1', '4K');
        expect(res).toEqual({ width: 2560, height: 2560 });
    });

    test('gpt-image-2 仍按目标像素面积分档', () => {
        const res = LlmResolution.getResolutionForModel('gpt-image-2', '1:1', '2K');
        expect(res).toEqual({ width: 1920, height: 1920 });
    });

    test('gpt-image-1 仍吸附固定三档', () => {
        const res = LlmResolution.getResolutionForModel('gpt-image-1', '16:9', '2K');
        expect(res).toEqual({ width: 1536, height: 1024 });
    });
});

describe('getMinTotalPixels', () => {
    test('Seedream 4.5 返回 3686400', () => {
        expect(LlmResolution.getMinTotalPixels('doubao-seedream-4-5-251128')).toBe(3686400);
    });

    test('其他模型返回 0（无特殊下限）', () => {
        expect(LlmResolution.getMinTotalPixels('gpt-image-2')).toBe(0);
        expect(LlmResolution.getMinTotalPixels('doubao-seedream-4-0-250828')).toBe(0);
        expect(LlmResolution.getMinTotalPixels('')).toBe(0);
        expect(LlmResolution.getMinTotalPixels(null)).toBe(0);
    });
});

describe('clampArea', () => {
    test('面积达标时原样返回', () => {
        expect(LlmResolution.clampArea(2560, 1440, 3686400)).toEqual({ width: 2560, height: 1440 });
    });

    test('面积不足时等比放大到最小面积', () => {
        expect(LlmResolution.clampArea(1024, 1024, 3686400)).toEqual({ width: 1920, height: 1920 });
        expect(LlmResolution.clampArea(1024, 576, 3686400)).toEqual({ width: 2560, height: 1440 });
    });
});

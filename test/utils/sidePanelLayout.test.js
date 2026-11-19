/**
 * ==========================================================================
 * SidePanelLayout 并排窗口留白共享纯函数层测试（2026-11-08）
 * 消费方：LoRA 管理器 / 提示词管理器「布局」模式。vm 加载经典脚本，
 * document/window 经 context 注入。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { window: {} };
vm.createContext(context);
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/utils/SidePanelLayout.js'), 'utf-8'),
    context, { filename: 'SidePanelLayout.js' });
const SidePanelLayout = context.window.SidePanelLayout;

describe('SidePanelLayout.clampGap 留白钳制', () => {
    test('默认档 552（非法值回落）、下限 360、上限保弹窗 minWidth', () => {
        expect(SidePanelLayout.clampGap(undefined, 2000, 760)).toBe(552);
        expect(SidePanelLayout.clampGap(NaN, 2000, 760)).toBe(552);
        expect(SidePanelLayout.clampGap(100, 2000, 760)).toBe(360);
        expect(SidePanelLayout.clampGap(5000, 2000, 760)).toBe(1240);   // 2000-760
        expect(SidePanelLayout.clampGap(5000, 2000, 900)).toBe(1100);   // minWidth 可调
    });

    test('低于下限钳到 360；结果取整', () => {
        expect(SidePanelLayout.clampGap(123.6, 2000, 760)).toBe(360);
        expect(SidePanelLayout.clampGap(600.4, 2000, 760)).toBe(600);
    });
});

describe('SidePanelLayout.defaultGap 面板实测对齐', () => {
    afterEach(() => {
        delete context.document;
        delete context.window.innerWidth;
    });

    test('面板可见：按实测左缘对齐 +7 呼吸', () => {
        context.document = {
            getElementById: (id) => (id === 'promptPanel' ? {
                getBoundingClientRect: () => ({ width: 540, left: 1420 })
            } : null)
        };
        context.window.innerWidth = 2000;
        expect(SidePanelLayout.defaultGap(2000, 760)).toBe(587);   // 2000-1420+7
    });

    test('面板关闭/不可测：回落 552 默认档', () => {
        context.document = { getElementById: () => null };
        context.window.innerWidth = 2000;
        expect(SidePanelLayout.defaultGap(2000, 760)).toBe(552);
    });

    test('面板左缘异常（width 0 / 越界）走回落档', () => {
        context.window.innerWidth = 2000;
        context.document = {
            getElementById: () => ({ getBoundingClientRect: () => ({ width: 0, left: 100 }) })
        };
        expect(SidePanelLayout.defaultGap(2000, 760)).toBe(552);
        context.document = {
            getElementById: () => ({ getBoundingClientRect: () => ({ width: 540, left: 2500 }) })
        };
        expect(SidePanelLayout.defaultGap(2000, 760)).toBe(552);
    });
});

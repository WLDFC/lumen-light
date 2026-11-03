/**
 * LumenColorPicker 共享预制件测试（ADR 068）：色板取色器自灯箱
 * StudioColorPicker 升格（灯箱/漫画双消费方）。被测文件是浏览器端
 * 经典脚本（挂 window），用 vm 在同一上下文执行；本文件只测纯函数层
 * 与静态数据（DOM 交互两宿主各自冒烟）。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: {} };
vm.createContext(context);
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/components/LumenColorPicker.js'), 'utf-8'),
    context, { filename: 'LumenColorPicker.js' });
const LumenColorPicker = context.window.LumenColorPicker;

describe('LumenColorPicker 颜色纯函数', () => {
    test('hexToRgb：六位 hex（带/不带 #）解析，非法输入 null', () => {
        expect(LumenColorPicker.hexToRgb('#ff0000')).toEqual({ r: 255, g: 0, b: 0 });
        expect(LumenColorPicker.hexToRgb('1A2b3C')).toEqual({ r: 0x1a, g: 0x2b, b: 0x3c });
        expect(LumenColorPicker.hexToRgb('#fff')).toBe(null);       // 三位缩写不支持
        expect(LumenColorPicker.hexToRgb('#12345')).toBe(null);
        expect(LumenColorPicker.hexToRgb('zzzzzz')).toBe(null);
        // 数字串经 String 强转后恰为合法六位 hex——组件口径宽松放行
        expect(LumenColorPicker.hexToRgb(123456)).toEqual({ r: 0x12, g: 0x34, b: 0x56 });
        expect(LumenColorPicker.hexToRgb('')).toBe(null);
    });

    test('rgbToHex：钳位 0-255 + 两位补零', () => {
        expect(LumenColorPicker.rgbToHex(255, 0, 0)).toBe('#ff0000');
        expect(LumenColorPicker.rgbToHex(300, -5, 128)).toBe('#ff0080');   // 越界钳回
        expect(LumenColorPicker.rgbToHex(16, 32, 64)).toBe('#102040');     // padStart
    });

    test('rgbToHsv 基准点：红满饱和、白零饱和、黑零明度', () => {
        expect(LumenColorPicker.rgbToHsv(255, 0, 0)).toEqual({ h: 0, s: 1, v: 1 });
        const white = LumenColorPicker.rgbToHsv(255, 255, 255);
        expect(white.s).toBe(0);
        expect(white.v).toBe(1);
        const black = LumenColorPicker.rgbToHsv(0, 0, 0);
        expect(black.s).toBe(0);
        expect(black.v).toBe(0);
    });

    test('hsvToRgb→rgbToHsv 采样往返（色相环 60° 步进）', () => {
        for (let h = 0; h < 360; h += 60) {
            const rgb = LumenColorPicker.hsvToRgb(h, 1, 1);
            const back = LumenColorPicker.rgbToHsv(rgb.r, rgb.g, rgb.b);
            expect(back.h).toBeCloseTo(h, 6);
            expect(back.s).toBeCloseTo(1, 6);
            expect(back.v).toBeCloseTo(1, 6);
        }
    });

    test('hsvToRgb 数值域：输出总在 0-255', () => {
        for (const h of [0, 37, 90, 180, 251, 359]) {
            for (const s of [0, 0.37, 1]) {
                for (const v of [0, 0.42, 1]) {
                    const { r, g, b } = LumenColorPicker.hsvToRgb(h, s, v);
                    for (const n of [r, g, b]) {
                        expect(n).toBeGreaterThanOrEqual(0);
                        expect(n).toBeLessThanOrEqual(255);
                    }
                }
            }
        }
    });
});

describe('LumenColorPicker 静态数据（双宿主共享）', () => {
    test('PRESETS 预设 8 色（灯箱同款）+ RECENT_MAX=4', () => {
        expect(LumenColorPicker.PRESETS).toHaveLength(8);
        expect(LumenColorPicker.PRESETS[0]).toEqual({ name: '红', value: '#ef4444' });
        for (const c of LumenColorPicker.PRESETS) {
            expect(LumenColorPicker.hexToRgb(c.value)).not.toBe(null);   // 全部合法 hex
            expect(typeof c.name).toBe('string');
        }
        expect(LumenColorPicker.RECENT_MAX).toBe(4);
    });
});

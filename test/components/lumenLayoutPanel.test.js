/**
 * ==========================================================================
 * LumenLayoutPanel 并排布局开关预制件测试（2026-11-08 收敛）
 * 三消费方：LoRA 管理器 / 提示词管理器 / 漫画编辑器。vm 加载经典脚本
 * （SidePanelLayout 须先载——缺省留白走它实测），按钮/窗口根用桩。
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
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/components/LumenLayoutPanel.js'), 'utf-8'),
    context, { filename: 'LumenLayoutPanel.js' });
const LumenLayoutPanel = context.window.LumenLayoutPanel;

/** 闭包持集合的 classList 桩（vm realm 跨界调用下不依赖方法内 this） */
function mkClassList() {
    const set = new Set();
    return {
        toggle(c, on) { if (on) set.add(c); else set.delete(c); },
        has: (c) => set.has(c)
    };
}

/** 桩按钮：记录事件与态 */
function mkButton() {
    return {
        classList: mkClassList(),
        disabled: false,
        title: '',
        handlers: {},
        addEventListener(t, fn) { this.handlers[t] = fn; },
        click() { this.handlers.click && this.handlers.click(); }
    };
}

/** 桩窗口根：记录类名与样式变量（styleVars 与 style 方法共享同一对象） */
function mkDialog() {
    const vars = {};
    return {
        classList: mkClassList(),
        styleVars: vars,
        style: {
            setProperty(k, v) { vars[k] = v; },
            removeProperty(k) { delete vars[k]; }
        }
    };
}

/** 现成预制件（默认口径，localStorage 走传入 store） */
function mkPanel(store, overrides = {}) {
    const button = mkButton();
    const dialog = mkDialog();
    const panel = new LumenLayoutPanel({
        button,
        dialog: () => dialog,
        storageKey: 'lumen.testLayout',
        ...overrides
    });
    context.localStorage = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); }
    };
    return { panel, button, dialog };
}

describe('LumenLayoutPanel 开合与记忆', () => {
    let store;
    beforeEach(() => { store = {}; });
    afterEach(() => { delete context.localStorage; });

    test('set(true)：css 类+变量+高亮+记忆四同步；set(false) 全回落', () => {
        const { panel, button, dialog } = mkPanel(store);
        panel.set(true);
        expect(panel.active).toBe(true);
        expect(dialog.classList.has('lora-layout')).toBe(true);
        expect(button.classList.has('is-active')).toBe(true);
        expect(store['lumen.testLayout']).toBe('on');
        expect(dialog.styleVars['--side-layout-gap']).toMatch(/px$/);   // 缺省走 SidePanelLayout 实测
        panel.set(false);
        expect(panel.active).toBe(false);
        expect(dialog.classList.has('lora-layout')).toBe(false);
        expect(dialog.styleVars['--side-layout-gap']).toBeUndefined();  // null offGap = 移除变量
        expect(store['lumen.testLayout']).toBe('off');
    });

    test('按钮点击开合（预制件自绑监听）', () => {
        const { panel, button } = mkPanel(store);
        button.click();
        expect(panel.active).toBe(true);
        button.click();
        expect(panel.active).toBe(false);
    });

    test('自定义 getGap 钩子生效（漫画恢复拖拽值口径）', () => {
        const { panel, dialog } = mkPanel(store, { getGap: () => 432 });
        panel.set(true);
        expect(dialog.styleVars['--side-layout-gap']).toBe('432px');
    });

    test('cssClass=null 只动变量不挂类（漫画壳口径）+ offGap 关-态写值', () => {
        const { panel, dialog } = mkPanel(store, {
            cssClass: null, gapVar: '--manga-gap', offGap: '0px'
        });
        panel.set(true);
        expect(dialog.styleVars['--manga-gap']).toMatch(/px$/);
        panel.set(false);
        expect(dialog.styleVars['--manga-gap']).toBe('0px');   // 全屏，壳无条件吃变量
    });

    test('persist=false 只动界面不落盘（视口不足强制回落的口径）', () => {
        const { panel } = mkPanel(store);
        panel.set(true);
        panel.set(false, false);
        expect(store['lumen.testLayout']).toBe('on');   // 记忆保留
        expect(panel.active).toBe(false);
    });
});

describe('LumenLayoutPanel.applyStored 开窗应用', () => {
    let store;
    beforeEach(() => { store = {}; });
    afterEach(() => { delete context.localStorage; });

    test('视口足够：恢复记忆态+实测留白，按钮可用', () => {
        context.window.innerWidth = 2000;
        store['lumen.testLayout'] = 'on';
        const { panel, button, dialog } = mkPanel(store);
        expect(panel.applyStored()).toBe(true);
        expect(panel.active).toBe(true);
        expect(button.disabled).toBe(false);
        expect(dialog.styleVars['--side-layout-gap']).toMatch(/px$/);
        delete context.window.innerWidth;
    });

    test('视口不足：按钮置灰+强制回落，记忆保留不抹（拉宽重开即恢复）', () => {
        context.window.innerWidth = 1200;
        store['lumen.testLayout'] = 'on';
        const { panel, button, dialog } = mkPanel(store);
        expect(panel.applyStored()).toBe(false);
        expect(panel.active).toBe(false);
        expect(button.disabled).toBe(true);
        expect(button.title).toContain('1500');
        expect(store['lumen.testLayout']).toBe('on');   // 不抹记忆
        delete context.window.innerWidth;
    });
});

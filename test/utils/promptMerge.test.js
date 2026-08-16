/**
 * ==========================================================================
 * PromptMerge 单元测试
 * 覆盖共享提示词段合并工具：
 *   - 空行分隔、空段剔除、trim
 *   - 拼接处自动补逗号且区分中英文（半角 , / 全角 ，）
 *   - 多段链式拼接时逐 junction 判定
 * 被测文件是浏览器端经典脚本（依赖全局 window），用 vm 模块在
 * 同一上下文中执行（与 nodeTypes.test.js 同一套做法）。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: {} };
vm.createContext(context);

const source = fs.readFileSync(
    path.join(__dirname, '../../js/utils/PromptMerge.js'), 'utf-8');
vm.runInContext(source, context, { filename: 'PromptMerge.js' });

const PM = context.window.PromptMerge;

describe('PromptMerge 基础合并', () => {
    test('两段之间用空行分隔，前段英文结尾补半角逗号', () => {
        expect(PM.join(['masterpiece, best quality', '1girl, sitting']))
            .toBe('masterpiece, best quality,\n\n1girl, sitting');
    });

    test('前段以中文结尾补全角逗号', () => {
        expect(PM.join(['一个女孩在咖啡店', '1girl, sitting']))
            .toBe('一个女孩在咖啡店，\n\n1girl, sitting');
    });

    test('前段已以逗号结尾（半角/全角）不重复补', () => {
        expect(PM.join(['a,', 'b'])).toBe('a,\n\nb');
        expect(PM.join(['a，', 'b'])).toBe('a，\n\nb');
    });

    test('多段链式：每个 junction 以前一段合并后的结尾判定', () => {
        expect(PM.join(['a', 'b', '女孩'])).toBe('a,\n\nb,\n\n女孩');
    });

    test('单段与空输入', () => {
        expect(PM.join(['  solo  '])).toBe('solo');
        expect(PM.join([])).toBe('');
        expect(PM.join(null)).toBe('');
    });

    test('空段与纯空格段被剔除，不产生多余空行', () => {
        expect(PM.join(['a', '   ', '', 'b'])).toBe('a,\n\nb');
    });
});

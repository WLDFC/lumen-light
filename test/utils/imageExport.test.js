/**
 * ==========================================================================
 * ImageExport 单元测试（js/utils/ImageExport.js 图片源导出工具）
 * Node 环境可测的纯逻辑部分：
 *   - sniffImageMime：PNG/JPEG/GIF/WEBP/BMP 魔数识别 + 未知/过短拒绝
 *   - rewriteMime：data URL 的 mime 声明段重写（主体 base64 不变）
 * toDataUrl / blobToDataUrl / canvasToBlob 依赖 fetch / FileReader /
 * canvas，浏览器端能力，不在 Node 测试范围。
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
    path.join(__dirname, '../../js/utils/ImageExport.js'), 'utf-8');
vm.runInContext(source, context, { filename: 'ImageExport.js' });

const IE = context.window.ImageExport;

describe('ImageExport.sniffImageMime 魔数嗅探', () => {
    const bytes = (...arr) => new Uint8Array(arr).buffer;

    test('识别 PNG / JPEG / GIF / WEBP / BMP', () => {
        expect(IE.sniffImageMime(bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)))
            .toBe('image/png');
        expect(IE.sniffImageMime(bytes(0xFF, 0xD8, 0xFF, 0xE0)))
            .toBe('image/jpeg');
        expect(IE.sniffImageMime(bytes(0x47, 0x49, 0x46, 0x38)))  // "GIF8"
            .toBe('image/gif');
        expect(IE.sniffImageMime(bytes(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
            0x57, 0x45, 0x42, 0x50)))                             // "RIFF"...."WEBP"
            .toBe('image/webp');
        expect(IE.sniffImageMime(bytes(0x42, 0x4D, 0x00, 0x00)))  // "BM"
            .toBe('image/bmp');
    });

    test('RIFF 但非 WEBP 返回 null（伪装扩展名兜底场景）', () => {
        expect(IE.sniffImageMime(bytes(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
            0x57, 0x41, 0x56, 0x45)))                             // "RIFF"...."WAVE"
            .toBe(null);
    });

    test('未知格式 / 过短缓冲 / 空缓冲返回 null', () => {
        expect(IE.sniffImageMime(bytes(0x00, 0x01, 0x02, 0x03))).toBe(null);
        expect(IE.sniffImageMime(bytes(0x89))).toBe(null);
        expect(IE.sniffImageMime(new ArrayBuffer(0))).toBe(null);
    });
});

describe('ImageExport.rewriteMime data URL 类型重写', () => {
    test('替换 mime 声明段，主体 base64 不变', () => {
        expect(IE.rewriteMime('data:application/octet-stream;base64,QUJD', 'image/png'))
            .toBe('data:image/png;base64,QUJD');
    });

    test('相同 mime 重写为幂等', () => {
        const url = 'data:image/jpeg;base64,/9j/4AAQ';
        expect(IE.rewriteMime(url, 'image/jpeg')).toBe(url);
    });
});

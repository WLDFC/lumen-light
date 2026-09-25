/**
 * ==========================================================================
 * fileTextExtractor.js 单元测试
 * 覆盖：纯文本/JSON/CSV 解码、扩展名判定、大小与长度上限、
 *       Excel 往返解析（用 xlsx 现场生成缓冲再读回）。
 * PDF/Word 依赖真实二进制样本，此处不做解析断言（仅验证不支持格式的拒绝逻辑）。
 * ==========================================================================
 */

const {
    extractText,
    isSupported,
    getExt,
    MAX_FILE_BYTES,
    MAX_TEXT_CHARS
} = require('../../utils/fileTextExtractor');

describe('getExt / isSupported - 扩展名与格式判定', () => {
    test('取小写扩展名', () => {
        expect(getExt('报告.PDF')).toBe('.pdf');
        expect(getExt('data.JSON')).toBe('.json');
        expect(getExt('noext')).toBe('');
    });

    test('受支持的格式返回 true', () => {
        ['a.txt', 'a.md', 'a.csv', 'a.log', 'a.json', 'a.xml', 'a.yaml', 'a.yml',
            'a.pdf', 'a.docx', 'a.xls', 'a.xlsx'].forEach((f) => {
            expect(isSupported(f)).toBe(true);
        });
    });

    test('不支持的格式返回 false（pptx / doc / 图片 / 无扩展名）', () => {
        ['a.pptx', 'a.ppt', 'a.doc', 'a.png', 'noext'].forEach((f) => {
            expect(isSupported(f)).toBe(false);
        });
    });
});

describe('extractText - 纯文本类', () => {
    test('txt 原样解码并去首尾空白', async () => {
        const res = await extractText({ buffer: Buffer.from('  你好，世界\n第二行  ', 'utf8'), filename: 'note.txt' });
        expect(res.text).toBe('你好，世界\n第二行');
        expect(res.truncated).toBe(false);
        expect(res.empty).toBe(false);
    });

    test('CRLF 归一化为 LF', async () => {
        const res = await extractText({ buffer: Buffer.from('a\r\nb\r\n', 'utf8'), filename: 'x.md' });
        expect(res.text).toBe('a\nb');
    });

    test('json 保留原始文本（不重排结构）', async () => {
        const raw = '{"k": 1}';
        const res = await extractText({ buffer: Buffer.from(raw, 'utf8'), filename: 'c.json' });
        expect(res.text).toBe(raw);
    });

    test('空内容标记 empty=true', async () => {
        const res = await extractText({ buffer: Buffer.from('   \n  ', 'utf8'), filename: 'empty.txt' });
        expect(res.empty).toBe(true);
        expect(res.text).toBe('');
    });
});

describe('extractText - 上限与错误', () => {
    test('超过 MAX_TEXT_CHARS 触发截断，charCount 记录原始长度', async () => {
        const big = 'x'.repeat(MAX_TEXT_CHARS + 5000);
        const res = await extractText({ buffer: Buffer.from(big, 'utf8'), filename: 'big.txt' });
        expect(res.truncated).toBe(true);
        expect(res.text.length).toBe(MAX_TEXT_CHARS);
        expect(res.charCount).toBe(MAX_TEXT_CHARS + 5000);
    });

    test('非 Buffer 抛错', async () => {
        await expect(extractText({ buffer: 'not a buffer', filename: 'a.txt' }))
            .rejects.toThrow(/Buffer/);
    });

    test('超过大小上限抛错', async () => {
        const oversize = Buffer.alloc(MAX_FILE_BYTES + 1, 0x61);
        await expect(extractText({ buffer: oversize, filename: 'a.txt' }))
            .rejects.toThrow(/MB 上限/);
    });

    test('不支持的扩展名抛错', async () => {
        await expect(extractText({ buffer: Buffer.from('x'), filename: 'slide.pptx' }))
            .rejects.toThrow(/暂不支持解析该格式/);
    });
});

describe('extractText - Excel 往返', () => {
    test('xlsx 缓冲读回，包含表名标注与单元格内容', async () => {
        const XLSX = require('xlsx');
        const wb = XLSX.utils.book_new();
        const sheet = XLSX.utils.aoa_to_sheet([['姓名', '年龄'], ['张三', 30]]);
        XLSX.utils.book_append_sheet(wb, sheet, 'Sheet1');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

        const res = await extractText({ buffer: buf, filename: 'people.xlsx' });
        expect(res.ext).toBe('.xlsx');
        expect(res.text).toContain('【工作表 Sheet1】');
        expect(res.text).toContain('姓名,年龄');
        expect(res.text).toContain('张三,30');
    });
});

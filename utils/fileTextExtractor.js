/**
 * ==========================================================================
 * 文档文本提取器
 * 作用：把用户上传的文档（纯文本 / PDF / Word / Excel）解析成纯文本，
 *       供 LLM 聊天时拼进用户消息（大多数 OpenAI 兼容接口不收原文件，
 *       只收文本，因此统一在后端提取文本再提交）。
 *       重型解析库（pdf-parse / mammoth / xlsx）按需惰性 require，
 *       仅解析纯文本时不会加载它们，保证模块加载与单测轻量。
 *
 * 支持格式：
 *   - 纯文本：txt/md/markdown/csv/tsv/log/json/xml/yaml/yml/ini/conf/srt/vtt
 *   - PDF：pdf（pdf-parse v2）
 *   - Word：docx（mammoth，仅 .docx，不含老式二进制 .doc）
 *   - Excel：xls/xlsx/xlsm（xlsx）
 * 不支持：ppt/pptx（需额外 zip 解析库）、doc（老式二进制 Word）
 * ==========================================================================
 */

'use strict';

const path = require('path');

// ==================== 可调上限（一处修改全局生效） ====================
// 单文件字节上限：超过直接拒绝，避免超大文件撑爆请求体与内存
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB
// 单文件提取文本的字符上限：超过则截断（约 1.2 万 token），防止塞爆模型上下文
const MAX_TEXT_CHARS = 50000;

// 各格式对应的扩展名集合
const PLAIN_TEXT_EXT = new Set([
    '.txt', '.md', '.markdown', '.csv', '.tsv', '.log',
    '.json', '.xml', '.yaml', '.yml', '.ini', '.conf', '.srt', '.vtt'
]);
const PDF_EXT = new Set(['.pdf']);
const WORD_EXT = new Set(['.docx']);
const EXCEL_EXT = new Set(['.xls', '.xlsx', '.xlsm']);

/**
 * 取文件扩展名（小写，含点）
 * @param {string} filename - 文件名
 * @returns {string} 如 '.pdf'；无扩展名返回 ''
 */
function getExt(filename) {
    return path.extname(String(filename || '')).toLowerCase();
}

/**
 * 判断某文件是否为受支持的文档格式
 * @param {string} filename - 文件名
 * @returns {boolean}
 */
function isSupported(filename) {
    const ext = getExt(filename);
    return PLAIN_TEXT_EXT.has(ext) || PDF_EXT.has(ext) || WORD_EXT.has(ext) || EXCEL_EXT.has(ext);
}

/**
 * 解析 PDF（pdf-parse v2 API：new PDFParse({data}).getText()）
 * @param {Buffer} buffer - PDF 文件缓冲
 * @returns {Promise<string>} 提取的文本
 */
async function parsePdf(buffer) {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
        const result = await parser.getText();
        return (result && result.text) || '';
    } finally {
        // 释放底层 worker/资源，失败忽略
        try { await parser.destroy(); } catch (_) { /* 忽略销毁异常 */ }
    }
}

/**
 * 解析 Word .docx（mammoth 提取纯文本，丢弃排版）
 * @param {Buffer} buffer - docx 文件缓冲
 * @returns {Promise<string>} 提取的文本
 */
async function parseDocx(buffer) {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return (result && result.value) || '';
}

/**
 * 解析 Excel（每个工作表转 CSV，并标注表名）
 * @param {Buffer} buffer - xls/xlsx 文件缓冲
 * @returns {string} 提取的文本
 */
function parseExcel(buffer) {
    const XLSX = require('xlsx');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    return workbook.SheetNames
        .map((name) => {
            const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
            return `【工作表 ${name}】\n${csv}`;
        })
        .join('\n\n');
}

/**
 * 按上限截断文本
 * @param {string} text - 原始文本
 * @returns {{text: string, truncated: boolean, charCount: number}}
 *          charCount 为截断前的原始字符数
 */
function truncate(text) {
    if (text.length <= MAX_TEXT_CHARS) {
        return { text, truncated: false, charCount: text.length };
    }
    return { text: text.slice(0, MAX_TEXT_CHARS), truncated: true, charCount: text.length };
}

/**
 * 从文件缓冲提取纯文本（对外主入口）
 * @param {Object} params
 * @param {Buffer} params.buffer - 文件内容缓冲
 * @param {string} params.filename - 文件名（用于按扩展名选择解析器）
 * @returns {Promise<{text: string, truncated: boolean, charCount: number, ext: string, empty: boolean}>}
 * @throws {Error} 非 Buffer、超过大小上限、格式不支持或解析失败时抛出
 */
async function extractText({ buffer, filename }) {
    if (!Buffer.isBuffer(buffer)) {
        throw new Error('提取文本需要 Buffer 类型的文件内容');
    }
    if (buffer.length > MAX_FILE_BYTES) {
        throw new Error(`文件超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB 上限，无法解析`);
    }

    const ext = getExt(filename);
    let raw;
    if (PLAIN_TEXT_EXT.has(ext)) {
        raw = buffer.toString('utf8');
    } else if (PDF_EXT.has(ext)) {
        raw = await parsePdf(buffer);
    } else if (WORD_EXT.has(ext)) {
        raw = await parseDocx(buffer);
    } else if (EXCEL_EXT.has(ext)) {
        raw = parseExcel(buffer);
    } else {
        throw new Error(`暂不支持解析该格式（${ext || '未知扩展名'}）：支持 txt/md/csv/json/pdf/docx/xls/xlsx 等`);
    }

    // 归一化换行并去首尾空白
    const normalized = String(raw || '').replace(/\r\n/g, '\n').trim();
    if (!normalized) {
        return { text: '', truncated: false, charCount: 0, ext, empty: true };
    }

    const result = truncate(normalized);
    return { ...result, ext, empty: false };
}

module.exports = {
    extractText,
    isSupported,
    getExt,
    MAX_FILE_BYTES,
    MAX_TEXT_CHARS
};

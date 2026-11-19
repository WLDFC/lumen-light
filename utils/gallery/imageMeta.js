/**
 * ==========================================================================
 * 图片内嵌生成元数据提取（在线画廊详情面板的元数据来源之一，ADR 090）
 * ==========================================================================
 * 背景：Civitai 公开 API 已全站剥除生成元数据（/images、/posts、版本
 * 社区图三处实测），但**图片文件本体的 PNG 文本块剥不掉**——A1111 系
 * 写 `parameters`（tEXt），ComfyUI 系写 `prompt`（节点图 JSON）+`workflow`。
 * 实测最新流 12 条里 3 条 PNG 全部命中（其余 9 条 JPG 本来就不带）。
 *
 * 本模块只做纯解析：Buffer 进 → 归一化元数据出，零网络零文件。
 * 消费方：routes/gallery.js 的 GET /meta 端点。
 *
 * 支持形态：
 *   - A1111 `parameters` 文本（prompt + Negative prompt 行 + 尾部 settings）
 *   - ComfyUI `prompt` 节点图 JSON（KSampler 系节点的 positive/negative
 *     输入回链取文本；找不到采样节点则收集全部 CLIPTextEncode 文本兜底）
 * JPEG 不处理（EXIF 里极少有生成参数，实测 Civitai 原图 JPG 均无）。
 * ==========================================================================
 */

const zlib = require('zlib');

/** PNG 签名判定 */
function isPng(buf) {
    return !!(buf && buf.length >= 8 && buf.toString('latin1', 1, 8) === 'PNG\r\n\u001a\n');
}

/** JPEG 签名判定 */
function isJpeg(buf) {
    return !!(buf && buf.length >= 4 && buf[0] === 0xFF && buf[1] === 0xD8);
}

/**
 * 解析 PNG 全部文本块（tEXt / zTXt / iTXt，含压缩解码）。
 * @returns {Object|null} { 块名: 文本 }；非 PNG 返回 null
 */
function pngTextChunks(buf) {
    if (!isPng(buf)) return null;
    const texts = {};
    let off = 8;
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        if (type === 'IEND') break;
        if (len < 0 || off + 12 + len > buf.length) break;   // 结构损坏防御
        const data = buf.slice(off + 8, off + 8 + len);
        try {
            if (type === 'tEXt') {
                const nul = data.indexOf(0);
                if (nul !== -1) {
                    texts[data.slice(0, nul).toString('latin1')] = data.slice(nul + 1).toString('latin1');
                }
            } else if (type === 'zTXt') {
                const nul = data.indexOf(0);
                if (nul !== -1) {
                    texts[data.slice(0, nul).toString('latin1')] =
                        zlib.inflateSync(data.slice(nul + 2)).toString('latin1');
                }
            } else if (type === 'iTXt') {
                const nul1 = data.indexOf(0);
                const key = data.slice(0, nul1).toString('latin1');
                const rest = data.slice(nul1 + 1);
                const nul2 = rest.indexOf(0);
                const compressionFlag = rest[nul2 + 1];      // 0=未压缩 1=zlib
                const rest2 = rest.slice(nul2 + 2);
                const nul3 = rest2.indexOf(0);
                let payload = rest2.slice(nul3 + 1);
                if (compressionFlag === 1) payload = zlib.inflateSync(payload);
                texts[key] = payload.toString('utf8');
            }
        } catch { /* 单块损坏跳过 */ }
        off += 12 + len;
    }
    return texts;
}

/**
 * 解析 A1111 `parameters` 文本：prompt（可多行）→ Negative prompt 行 →
 * 尾部 settings 行（Key: value 逗号分隔）。
 * @returns {{ prompt, negativePrompt, sampler, steps, cfgScale, seed,
 *            size, model }|null}
 */
function parseA1111Parameters(text) {
    const s = String(text || '').replace(/\0/g, '').trim();   // 个别文件块内有残留 NUL
    if (!s) return null;
    const lines = s.split('\n');
    const negIdx = lines.findIndex((l) => l.startsWith('Negative prompt:'));
    let promptLines;
    let negativePrompt = '';
    let settingsLine = '';
    if (negIdx !== -1) {
        negativePrompt = lines[negIdx].slice('Negative prompt:'.length).trim();
        promptLines = lines.slice(0, negIdx);
        const rest = lines.slice(negIdx + 1);
        const last = rest.length ? rest[rest.length - 1] : '';
        settingsLine = last.includes(':') ? last : '';
        if (!settingsLine) promptLines = promptLines.concat(rest);   // 没有 settings，负面后全是正文
    } else {
        const last = lines[lines.length - 1] || '';
        if (last.includes(': ') && lines.length > 1) {
            settingsLine = last;
            promptLines = lines.slice(0, -1);
        } else {
            promptLines = lines;
        }
    }
    const prompt = promptLines.join('\n').trim();
    if (!prompt) return null;
    const settings = {};
    settingsLine.split(',').forEach((kv) => {
        const i = kv.indexOf(':');
        if (i !== -1) settings[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    });
    return {
        prompt,
        negativePrompt,
        model: settings.Model || settings.model || '',
        sampler: settings.Sampler || settings.sampler || '',
        steps: settings.Steps || settings.steps || '',
        cfgScale: settings['CFG scale'] || settings.CFG || settings.cfg || '',
        seed: settings.Seed || settings.seed || '',
        size: settings.Size || settings.size || ''
    };
}

/**
 * 解析 ComfyUI `prompt` 节点图 JSON：优先走 KSampler 系节点的
 * positive/negative 输入回链取编码文本；找不到采样节点则收集全部
 * CLIPTextEncode 文本兜底（第一个当正面、第二个当负面）。
 * @returns {同 parseA1111Parameters|null}
 */
function parseComfyPrompt(text) {
    let g;
    try { g = JSON.parse(text); } catch { return null; }
    if (!g || typeof g !== 'object') return null;

    // 回链取文本：inputs.text 可能是字符串，也可能是 [上游节点id, 槽位] 引用
    const textOf = (id, seen = new Set()) => {
        const n = g[id];
        if (!n || seen.has(id)) return '';
        seen.add(id);
        const t = n.inputs && n.inputs.text;
        if (typeof t === 'string') return t;
        if (Array.isArray(t)) return textOf(String(t[0]), seen);
        return '';
    };

    let prompt = '';
    let negativePrompt = '';
    let sampler = '';
    let steps = '';
    let cfgScale = '';
    let seed = '';

    const entry = Object.entries(g).find(([, n]) => /sampler/i.test(String(n.class_type || '')));
    if (entry) {
        const inputs = entry[1].inputs || {};
        const pos = Array.isArray(inputs.positive) ? String(inputs.positive[0]) : '';
        const neg = Array.isArray(inputs.negative) ? String(inputs.negative[0]) : '';
        prompt = textOf(pos);
        negativePrompt = textOf(neg);
        sampler = String(inputs.sampler_name || inputs.sampler || '');
        steps = String(inputs.steps ?? '');
        cfgScale = String(inputs.cfg ?? '');
        seed = String(inputs.seed ?? inputs.noise_seed ?? '');
    }
    if (!prompt) {
        // 兜底：全部 CLIPTextEncode 文本收集
        const texts = Object.values(g)
            .filter((n) => /TextEncode/i.test(String(n.class_type || '')))
            .map((n) => (n.inputs && typeof n.inputs.text === 'string') ? n.inputs.text : '')
            .filter(Boolean);
        prompt = texts[0] || '';
        negativePrompt = texts[1] || '';
    }
    if (!prompt) return null;
    return {
        prompt: prompt.trim(),
        negativePrompt: negativePrompt.trim(),
        model: '',
        sampler,
        steps,
        cfgScale,
        seed,
        size: ''
    };
}

/**
 * 总入口：图片字节 → 内嵌生成元数据（非 PNG 返回 null；PNG 无
 * parameters/prompt 块也返回 null）。
 * @param {Buffer} buf
 * @returns {{ source: 'a1111'|'comfy', prompt, negativePrompt, model,
 *            sampler, steps, cfgScale, seed, size }|null}
 */
// ==================== JPEG：EXIF UserComment（站内在线生成器口径） ====================

/**
 * 解码 EXIF UserComment 原始值（去掉 8 字节编码前缀）。站方怪癖：标着
 * `UNICODE` 前缀的实际编码有三种（UTF-8 / UTF-16LE / UTF-16BE——后者是
 * EXIF 标准口径），按前 64 字节的 NUL 分布判定奇偶位选 BE/LE。
 */
function decodeExifUserComment(raw) {
    if (!raw || raw.length <= 8) return '';
    const prefix = raw.toString('latin1', 0, 8);
    const body = raw.slice(8);
    const strip = (s) => s.replace(/\0+$/g, '').replace(/^\uFEFF/, '').trim();
    if (!/^UNICODE/.test(prefix)) return strip(body.toString('utf8'));
    // NUL 分布探测：ASCII 文本在 UTF-16LE 下 NUL 落奇数位、BE 落偶数位；
    // 无 NUL 则是站方「标 UNICODE 实为 UTF-8」的变体
    let zerosEven = 0;
    let zerosOdd = 0;
    for (let i = 0; i < Math.min(body.length, 64); i++) {
        if (body[i] === 0) (i % 2 === 0) ? zerosEven++ : zerosOdd++;
    }
    if (!zerosEven && !zerosOdd) return strip(body.toString('utf8'));
    if (zerosEven > zerosOdd) {
        // UTF-16BE（EXIF 标准）：Node 无原生解码，字节两两换序后按 LE 解
        const swapped = Buffer.from(body);
        swapped.swap16();
        return strip(swapped.toString('utf16le'));
    }
    return strip(body.toString('utf16le'));
}

/**
 * 从 JPEG 字节提取 EXIF UserComment 文本（走段扫描定位 APP1 Exif →
 * TIFF IFD 解析 tag 0x9286，ExifIFD 子链一并搜）。
 * @returns {string|null} 无 EXIF/无该标签返回 null
 */
function jpegExifUserComment(buf) {
    if (!isJpeg(buf)) return null;
    let off = 2;
    let exifStart = -1;
    while (off + 4 <= buf.length) {
        if (buf[off] !== 0xFF) break;
        const marker = buf[off + 1];
        if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { off += 2; continue; }
        if (marker === 0xDA) break;   // SOS：图像数据开始
        const len = buf.readUInt16BE(off + 2);
        if (marker === 0xE1 && buf.toString('latin1', off + 4, off + 10) === 'Exif\0\0') {
            exifStart = off + 10;     // 指向 TIFF 头（'II*'/'MM*'）
            break;
        }
        off += 2 + len;
    }
    if (exifStart < 0) return null;

    const le = buf.toString('latin1', exifStart, exifStart + 2) === 'II';
    const rd16 = (o) => le ? buf.readUInt16LE(o) : buf.readUInt16BE(o);
    const rd32 = (o) => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
    const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    let found = null;
    const walk = (ifdOff) => {
        if (found !== null || !ifdOff || ifdOff + 2 > buf.length) return;
        const n = rd16(ifdOff);
        if (n <= 0 || n > 256) return;   // 结构损坏防御
        for (let i = 0; i < n && found === null; i++) {
            const e = ifdOff + 2 + i * 12;
            const tag = rd16(e);
            const type = rd16(e + 2);
            const cnt = rd32(e + 4);
            if (tag === 0x8769) { walk(exifStart + rd32(e + 8)); continue; }
            if (tag === 0x9286) {   // UserComment
                const size = (sizes[type] || 1) * cnt;
                let voff = e + 8;
                if (size > 4) voff = exifStart + rd32(e + 8);
                if (voff > 0 && voff + size <= buf.length) {
                    found = decodeExifUserComment(buf.slice(voff, voff + size));
                }
            }
        }
        if (found === null) {
            const next = rd32(ifdOff + 2 + n * 12);
            if (next) walk(exifStart + next);
        }
    };
    walk(exifStart + rd32(exifStart + 4));
    return found;
}

/** EXIF UserComment 载荷分流：A1111 格式文本 → 结构化；JSON（站内
 *  生成器 resource-stack）→ 递归找 prompt 字段；其余整段当 prompt */
function parseUserCommentPayload(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    if (s.startsWith('{')) {
        const found = { prompt: '', negativePrompt: '' };
        try {
            const obj = JSON.parse(s.replace(/\0+$/g, ''));
            (function find(o, depth) {
                if (depth > 6 || !o || typeof o !== 'object') return;
                for (const [k, v] of Object.entries(o)) {
                    if (typeof v === 'string') {
                        if (/prompt/i.test(k) && v.length > found.prompt.length) found.prompt = v;
                        else if (/negative/i.test(k) && !found.negativePrompt) found.negativePrompt = v;
                    } else if (v && typeof v === 'object') find(v, depth + 1);
                }
            })(obj, 0);
            if (found.prompt) {
                return { prompt: found.prompt, negativePrompt: found.negativePrompt, model: '', sampler: '', steps: '', cfgScale: '', seed: '', size: '' };
            }
        } catch { /* JSON 坏/字段缺失：落到整段 prompt */ }
    }
    if (s.includes('Negative prompt:') || /\bSteps:\s/.test(s)) {
        const m = parseA1111Parameters(s);
        if (m) return m;
    }
    return { prompt: s, negativePrompt: '', model: '', sampler: '', steps: '', cfgScale: '', seed: '', size: '' };
}

/**
 * 总入口：图片字节 → 内嵌生成元数据。PNG 走文本块（A1111/ComfyUI），
 * JPEG 走 EXIF UserComment（站内生成器，Prompt 文本/JSON 两种载荷）。
 * @param {Buffer} buf
 * @returns {{ source: 'a1111'|'comfy'|'jpeg-exif', prompt, negativePrompt,
 *            model, sampler, steps, cfgScale, seed, size }|null}
 */
function extractGenerationMeta(buf) {
    if (isPng(buf)) {
        const texts = pngTextChunks(buf);
        if (!texts) return null;
        if (texts['parameters']) {
            const m = parseA1111Parameters(texts['parameters']);
            if (m) return Object.assign({ source: 'a1111' }, m);
        }
        if (texts['prompt']) {
            const m = parseComfyPrompt(texts['prompt']);
            if (m) return Object.assign({ source: 'comfy' }, m);
        }
        return null;
    }
    if (isJpeg(buf)) {
        const comment = jpegExifUserComment(buf);
        if (!comment) return null;
        const m = parseUserCommentPayload(comment);
        if (m) return Object.assign({ source: 'jpeg-exif' }, m);
        return null;
    }
    return null;
}

module.exports = { isPng, isJpeg, pngTextChunks, parseA1111Parameters, parseComfyPrompt, jpegExifUserComment, decodeExifUserComment, parseUserCommentPayload, extractGenerationMeta };

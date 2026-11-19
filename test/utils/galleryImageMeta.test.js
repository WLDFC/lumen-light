/**
 * ==========================================================================
 * utils/gallery/imageMeta.js 单元测试：PNG 文本块解析 + A1111/ComfyUI
 * 生成元数据归一（手工构造 PNG 字节，零网络零文件）
 * ==========================================================================
 */

const zlib = require('zlib');
const { isPng, pngTextChunks, parseA1111Parameters, parseComfyPrompt, extractGenerationMeta } = require('../../utils/gallery/imageMeta');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 构造一个 PNG chunk（CRC 置零——解析器不校验 CRC） */
function chunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    return out;
}

/** 构造带 EXIF UserComment 的最小 JPEG（little-endian TIFF，ExifIFD 子链）。
 *  布局：TIFF 头(8B) → IFD0(18B: 1 条 ExifIFD 指针) → ExifIFD(18B: 1 条
 *  UserComment) → UserComment 原始值（含 8 字节编码前缀） */
function buildJpeg(userCommentRaw) {
    const exifIfdOff = 26;              // 8 + 18
    const ucDataOff = 44;               // 26 + 18
    const ifd0 = Buffer.alloc(18);
    ifd0.writeUInt16LE(1, 0);           // 条目数
    ifd0.writeUInt16LE(0x8769, 2);      // ExifIFD 指针 tag
    ifd0.writeUInt16LE(4, 4);           // type LONG
    ifd0.writeUInt32LE(1, 6);           // count
    ifd0.writeUInt32LE(exifIfdOff, 10); // value = ExifIFD 偏移
    ifd0.writeUInt32LE(0, 14);          // 无下一 IFD
    const exifIfd = Buffer.alloc(18);
    exifIfd.writeUInt16LE(1, 0);
    exifIfd.writeUInt16LE(0x9286, 2);   // UserComment tag
    exifIfd.writeUInt16LE(7, 4);        // type UNDEFINED
    exifIfd.writeUInt32LE(userCommentRaw.length, 6);
    exifIfd.writeUInt32LE(ucDataOff, 10);
    exifIfd.writeUInt32LE(0, 14);
    const tiff = Buffer.concat([
        Buffer.from('II*\0', 'latin1'),
        (() => { const o = Buffer.alloc(4); o.writeUInt32LE(8, 0); return o; })(),
        ifd0,
        exifIfd,
        userCommentRaw
    ]);
    const app1Body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const app1 = Buffer.alloc(4 + app1Body.length);
    app1[0] = 0xFF; app1[1] = 0xE1;                       // 段标记在前
    app1.writeUInt16BE(app1Body.length + 2, 2);           // 长度含自身 2B
    app1Body.copy(app1, 4);
    return Buffer.concat([
        Buffer.from([0xFF, 0xD8]),
        app1,
        Buffer.from([0xFF, 0xD9])
    ]);
}

/** 编码前缀 + 内容（与 EXIF UserComment 原始值形态一致） */
function ucRaw(prefix, contentBytes) {
    return Buffer.concat([Buffer.alloc(8, 0).fill(prefix.slice(0, 8), 'latin1'), contentBytes]);
}

/** ASCII 串 → UTF-16BE 字节（EXIF 标准口径） */
function utf16be(s) {
    const b = Buffer.alloc(s.length * 2);
    for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), i * 2);
    return b;
}

function buildPng(textChunks) {
    const parts = [PNG_SIG];
    parts.push(chunk('IHDR', Buffer.alloc(13)));
    for (const [key, text, compress] of textChunks) {
        if (compress) {
            const body = Buffer.concat([
                Buffer.from(key + '\0'),
                Buffer.from([0]),
                zlib.deflateSync(Buffer.from(text, 'utf8'))
            ]);
            parts.push(chunk('zTXt', body));
        } else {
            parts.push(chunk('tEXt', Buffer.concat([Buffer.from(key + '\0'), Buffer.from(text, 'utf8')])));
        }
    }
    parts.push(chunk('IEND', Buffer.alloc(0)));
    return Buffer.concat(parts);
}

const A1111_TEXT = [
    'masterpiece, 1girl, long_hair',
    'looking at viewer',
    'Negative prompt: lowres, bad_anatomy',
    'Steps: 28, Sampler: Euler a, CFG scale: 7, Seed: 3436117041, Size: 832x1216, Model: animaV5'
].join('\n');

const COMFY_JSON = JSON.stringify({
    '3': {
        class_type: 'KSampler',
        inputs: { seed: 111, steps: 25, cfg: 4.5, sampler_name: 'euler', positive: ['6', 0], negative: ['7', 0] }
    },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '1girl, masterpiece\nbest quality', clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'worst quality', clip: ['4', 1] } }
});

describe('utils/gallery/imageMeta PNG 文本块解析', () => {
    test('tEXt/zTXt/iTXt 三种块全部解出', () => {
        const buf = buildPng([
            ['parameters', A1111_TEXT, false],
            ['zipped', 'hello-zip', true]
        ]);
        expect(isPng(buf)).toBe(true);
        const texts = pngTextChunks(buf);
        expect(texts['parameters']).toBe(A1111_TEXT);
        expect(texts['zipped']).toBe('hello-zip');
    });

    test('非 PNG / 损坏数据返回 null 不抛错', () => {
        expect(isPng(Buffer.from('not a png at all........'))).toBe(false);
        expect(pngTextChunks(Buffer.from('JPEGDATA'))).toBe(null);
    });
});

describe('utils/gallery/imageMeta A1111 parameters 解析', () => {
    test('prompt 多行 + 负面 + settings 键名宽容取值', () => {
        const m = parseA1111Parameters(A1111_TEXT);
        expect(m.prompt).toBe('masterpiece, 1girl, long_hair\nlooking at viewer');
        expect(m.negativePrompt).toBe('lowres, bad_anatomy');
        expect(m.sampler).toBe('Euler a');
        expect(m.steps).toBe('28');
        expect(m.cfgScale).toBe('7');
        expect(m.seed).toBe('3436117041');
        expect(m.size).toBe('832x1216');
        expect(m.model).toBe('animaV5');
    });

    test('无负面无 settings 的裸 prompt', () => {
        const m = parseA1111Parameters('just a prompt');
        expect(m.prompt).toBe('just a prompt');
        expect(m.negativePrompt).toBe('');
        expect(m.sampler).toBe('');
    });

    test('空串返回 null', () => {
        expect(parseA1111Parameters('')).toBe(null);
        expect(parseA1111Parameters('   ')).toBe(null);
    });
});

describe('utils/gallery/imageMeta ComfyUI prompt 解析', () => {
    test('KSampler 回链取正/负文本与采样参数', () => {
        const m = parseComfyPrompt(COMFY_JSON);
        expect(m.prompt).toBe('1girl, masterpiece\nbest quality');
        expect(m.negativePrompt).toBe('worst quality');
        expect(m.sampler).toBe('euler');
        expect(m.steps).toBe('25');
        expect(m.cfgScale).toBe('4.5');
        expect(m.seed).toBe('111');
    });

    test('无采样节点：CLIPTextEncode 兜底收集', () => {
        const g = JSON.stringify({
            '10': { class_type: 'CLIPTextEncode', inputs: { text: 'pos text' } },
            '11': { class_type: 'CLIPTextEncode', inputs: { text: 'neg text' } }
        });
        const m = parseComfyPrompt(g);
        expect(m.prompt).toBe('pos text');
        expect(m.negativePrompt).toBe('neg text');
    });

    test('坏 JSON / 无文本返回 null', () => {
        expect(parseComfyPrompt('not json')).toBe(null);
        expect(parseComfyPrompt('{"1":{"class_type":"KSampler","inputs":{}}}')).toBe(null);
    });
});

describe('utils/gallery/imageMeta 总入口', () => {
    test('A1111 PNG → source=a1111 全字段', () => {
        const meta = extractGenerationMeta(buildPng([['parameters', A1111_TEXT, false]]));
        expect(meta.source).toBe('a1111');
        expect(meta.prompt).toContain('masterpiece');
        expect(meta.seed).toBe('3436117041');
    });

    test('ComfyUI PNG → source=comfy', () => {
        const meta = extractGenerationMeta(buildPng([['prompt', COMFY_JSON, true]]));
        expect(meta.source).toBe('comfy');
        expect(meta.prompt).toContain('1girl');
    });

    test('无文本块的 PNG / 非 PNG → null', () => {
        expect(extractGenerationMeta(buildPng([]))).toBe(null);
        expect(extractGenerationMeta(Buffer.from('JPGDATA'))).toBe(null);
        expect(extractGenerationMeta(null)).toBe(null);
    });
});

describe('utils/gallery/imageMeta JPEG EXIF UserComment 提取', () => {
    test('UTF-16BE 编码（EXIF 标准口径）：A1111 格式文本', () => {
        const text = '1girl, masterpiece\nNegative prompt: lowres\nSteps: 28, Sampler: Euler a, Seed: 42';
        const jpeg = buildJpeg(ucRaw('UNICODE\0', utf16be(text)));
        const meta = extractGenerationMeta(jpeg);
        expect(meta.source).toBe('jpeg-exif');
        expect(meta.prompt).toBe('1girl, masterpiece');
        expect(meta.negativePrompt).toBe('lowres');
        expect(meta.sampler).toBe('Euler a');
        expect(meta.seed).toBe('42');
    });

    test('UTF-8 装在 UNICODE 前缀里（站方怪癖）：裸 prompt 整段呈现', () => {
        const jpeg = buildJpeg(ucRaw('UNICODE\0', Buffer.from('sensitive,@ newest,@ best quality', 'utf8')));
        const meta = extractGenerationMeta(jpeg);
        expect(meta.source).toBe('jpeg-exif');
        expect(meta.prompt).toBe('sensitive,@ newest,@ best quality');
        expect(meta.negativePrompt).toBe('');
    });

    test('JSON 载荷（站内生成器 resource-stack）：递归找 prompt 字段', () => {
        const payload = JSON.stringify({
            'resource-stack': {
                'class_type': 'CheckpointLoaderSimple',
                'positive-prompt': '1girl, best quality',
                'negative-prompt': 'bad hands'
            }
        });
        const jpeg = buildJpeg(ucRaw('UNICODE\0', Buffer.from(payload, 'utf16le')));
        const meta = extractGenerationMeta(jpeg);
        expect(meta.source).toBe('jpeg-exif');
        expect(meta.prompt).toBe('1girl, best quality');
        expect(meta.negativePrompt).toBe('bad hands');
    });

    test('无 EXIF 的 JPEG → null', () => {
        const plain = Buffer.concat([Buffer.from([0xFF, 0xD8]), Buffer.from([0xFF, 0xD9])]);
        expect(extractGenerationMeta(plain)).toBe(null);
    });
});

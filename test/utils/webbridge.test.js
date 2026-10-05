/**
 * 网页桥接纯逻辑单元测试：适配器注册表、豆包原图候选剥离、
 * 文件输入 accept 放行判定、内容签名去重、附件暂存。
 * 这些是 2026-09-30 真机联调中反复出 bug 的纯逻辑部分，
 * 页面操作（选择器/求值）依赖真实 DOM，不在单测范围。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const { listSites, getAdapter } = require('../../utils/webbridge/adapters');
const base = require('../../utils/webbridge/adapters/base');
const assets = require('../../utils/webbridge/assets');

describe('网页桥接适配器注册表', () => {
    test('listSites 返回豆包且标记可用', () => {
        const sites = listSites();
        const doubao = sites.find((s) => s.id === 'doubao');
        expect(doubao).toBeDefined();
        expect(doubao.name).toBe('豆包');
        expect(doubao.ready).toBe(true);
        expect(doubao.homeUrl).toContain('doubao.com');
    });

    test('getAdapter 返回完整契约实现，未登记 id 返回 null', () => {
        const a = getAdapter('doubao');
        ['findInput', 'sendMessage', 'isGenerating', 'extractReply', 'detectTask', 'imageVariants', 'revealVideos', 'stopGeneration']
            .forEach((k) => expect(typeof a[k]).toBe('function'));
        expect(getAdapter('not-a-site')).toBeNull();
    });

    test('listSites 返回 ChatGPT 且标记可用', () => {
        const sites = listSites();
        const chatgpt = sites.find((s) => s.id === 'chatgpt');
        expect(chatgpt).toBeDefined();
        expect(chatgpt.name).toBe('ChatGPT');
        expect(chatgpt.ready).toBe(true);
        expect(chatgpt.homeUrl).toContain('chatgpt.com');
    });

    test('getAdapter("chatgpt") 返回契约实现（无 imageVariants，走原 URL 单候选）', () => {
        const a = getAdapter('chatgpt');
        ['findInput', 'sendMessage', 'isGenerating', 'extractReply', 'detectTask', 'revealVideos', 'revealImages', 'stopGeneration']
            .forEach((k) => expect(typeof a[k]).toBe('function'));
        expect(a.imageVariants).toBeUndefined();
        expect(a.urlPattern.test('https://chatgpt.com/')).toBe(true);
        expect(a.urlPattern.test('https://www.doubao.com/chat/')).toBe(false);
    });

    test('listSites 返回 Gemini 且标记可用，imageVariants 剥 googleusercontent 尺寸段', () => {
        const sites = listSites();
        const gemini = sites.find((s) => s.id === 'gemini');
        expect(gemini).toBeDefined();
        expect(gemini.name).toBe('Gemini');
        expect(gemini.ready).toBe(true);
        expect(gemini.homeUrl).toContain('gemini.google.com');
        const a = getAdapter('gemini');
        ['findInput', 'sendMessage', 'isGenerating', 'extractReply', 'detectTask', 'imageVariants', 'revealVideos', 'revealImages', 'stopGeneration']
            .forEach((k) => expect(typeof a[k]).toBe('function'));
        // googleusercontent 尺寸指令段：剥掉 + 补 =s0 原图候选 + 原 URL 兜底
        const u = 'https://lh3.googleusercontent.com/gg/abc123=w400-h300-p-k-no-nu';
        expect(a.imageVariants(u)).toEqual([
            'https://lh3.googleusercontent.com/gg/abc123',
            'https://lh3.googleusercontent.com/gg/abc123=s0',
            u
        ]);
        // 不带尺寸段的 URL 只返回原 URL 单候选
        const plain = 'https://lh3.googleusercontent.com/gg/xyz';
        expect(a.imageVariants(plain)).toEqual([plain]);
        expect(a.urlPattern.test('https://gemini.google.com/app')).toBe(true);
        expect(a.urlPattern.test('https://chatgpt.com/')).toBe(false);
    });
});

describe('豆包原图候选剥离（imageVariants）', () => {
    const doubao = getAdapter('doubao');

    test('带 tplv 模板段的 URL 剥出原图候选（保留模板 id 的剥法最优先）', () => {
        const url = 'https://sf-tos-cdn.doubao.com/obj/lumen/foo~tplv-a3vwejppg7-obj:resize:384:384.image?stal=1';
        const variants = doubao.imageVariants(url);
        expect(variants).toHaveLength(4);
        // 候选 1：只剥操作参数、保留模板 id（最不易失效）
        expect(variants[0]).toBe('https://sf-tos-cdn.doubao.com/obj/lumen/foo~tplv-a3vwejppg7-obj.image?stal=1');
        // 候选 2：剥到伪扩展名前
        expect(variants[1]).toBe('https://sf-tos-cdn.doubao.com/obj/lumen/foo.image?stal=1');
        // 候选 3：整段剥掉；原 URL 兜底在最后
        expect(variants[2]).toBe('https://sf-tos-cdn.doubao.com/obj/lumen/foo?stal=1');
        expect(variants[3]).toBe(url);
    });

    test('不带模板段的 URL 只返回原 URL 单候选', () => {
        const url = 'https://cdn.example.com/pic.png';
        expect(doubao.imageVariants(url)).toEqual([url]);
    });
});

describe('文件输入 accept 放行判定（acceptAllowsImages）', () => {
    test.each([
        ['', true],                                  // 未声明：放行
        ['image/*', true],
        ['image/png,image/jpeg', true],
        ['.pdf,.txt,.csv,.docx,.png,.jpeg,.jpg,.webp', true],   // 豆包实测的扩展名清单
        ['.pdf,.docx,.xlsx', false],                 // 明确只收文档
        ['video/*', false],
        ['.mp4,.webm', false]
    ])('accept=%j → %j', (accept, expected) => {
        expect(base.acceptAllowsImages(accept)).toBe(expected);
    });
});

describe('内容签名去重（imageSignature / sigMeanDiff）', () => {
    test('同图不同尺寸签名差 < 3，不同图 > 3', async () => {
        const sharp = require('sharp');
        const base1 = await sharp({ create: { width: 300, height: 400, channels: 3, background: { r: 200, g: 120, b: 130 } } }).png().toBuffer();
        const big = await sharp(base1).resize(600, 800).png().toBuffer();
        const other = await sharp({ create: { width: 300, height: 400, channels: 3, background: { r: 30, g: 200, b: 40 } } }).png().toBuffer();
        const toDataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

        const s1 = await assets.imageSignature(toDataUrl(base1));
        const s2 = await assets.imageSignature(toDataUrl(big));
        const s3 = await assets.imageSignature(toDataUrl(other));
        expect(assets.sigMeanDiff(s1, s2)).toBeLessThan(3);   // 同图放大 2 倍 → 判重
        expect(assets.sigMeanDiff(s1, s3)).toBeGreaterThanOrEqual(3);   // 不同图 → 保留
    });

    test('非法数据签名返回 null，差值兜底为 255（不参与判重）', async () => {
        const sig = await assets.imageSignature('data:image/png;base64,!!notanimage!!');
        expect(sig).toBeNull();
        expect(assets.sigMeanDiff(sig, sig)).toBe(255);
    });
});

describe('图片路径基键（imageBaseKey）', () => {
    test('缩略与原图请求共享同一基键（剥 ~tplv 参数段与查询串）', () => {
        const preview = 'https://p26-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/abc.jpeg~tplv-a9rns2rl98-rc_genimage:resize:288:384?lk3s=sign1';
        const original = 'https://p26-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/abc.jpeg?lk3s=sign2';
        expect(assets.imageBaseKey(preview)).toBe(assets.imageBaseKey(original));
        expect(assets.imageBaseKey(preview)).toBe('/tos-cn-i-a9rns2rl98/rc_gen_image/abc.jpeg');
    });

    test('UI 资源（气泡图标等）路径不同，基键必然对不上', () => {
        const bubble = 'https://www.doubao.com/obj/chat-bubble/loading.png';
        const genImage = 'https://p26-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/abc.jpeg';
        expect(assets.imageBaseKey(bubble)).not.toBe(assets.imageBaseKey(genImage));
    });
});

describe('附件暂存（stageImageFiles / cleanupStagedFiles）', () => {
    test('data URL 落盘为临时文件并可清理', async () => {
        // 1x1 红色 PNG
        const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-wb-test-'));
        const paths = await assets.stageImageFiles({ dataDir, dataUrls: [png, 'not-a-data-url'] });
        expect(paths).toHaveLength(1);   // 非法项跳过
        expect(paths[0]).toContain(path.join('webbridge', 'tmp'));
        expect(fs.existsSync(paths[0])).toBe(true);

        assets.cleanupStagedFiles(paths);
        // unlink 是异步尽力而为：轮询等待删除完成
        await new Promise((r) => setTimeout(r, 200));
        expect(fs.existsSync(paths[0])).toBe(false);
        fs.rmSync(dataDir, { recursive: true, force: true });
    });
});

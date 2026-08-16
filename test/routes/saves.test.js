/**
 * ==========================================================================
 * routes/saves.js 集成测试
 * 覆盖三段式保存协议（init 建会话 → 批次上传图片 → finalize 提交）：
 *   - 空存档（无图片，仅节点/连线/提示词元数据）
 *   - 多批图片上传与 ID→文件名映射
 *   - 覆盖/非覆盖重名处理、非法 token 拦截、默认存档名生成
 *   - 读取接口的 src 相对路径转换
 * 通过 supertest 直连 Express 应用，使用临时目录避免污染 save/。
 * ==========================================================================
 */

const express = require('express');
const request = require('supertest');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const createSavesRouter = require('../../routes/saves');

// 1×1 红色像素 PNG 的 data URL（测试图片用，体积小且无需真实解码）
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeApp(savesDir) {
    const app = express();
    app.use(express.json({ limit: '100mb' }));
    app.use('/api/saves', createSavesRouter({ savesDir }));
    return app;
}

/** 走完一次完整保存流程，返回各阶段响应 */
async function saveFlow(app, initPayload, batches = []) {
    const initRes = await request(app).post('/api/saves').send(initPayload);
    if (initRes.body.status !== 'ok') return { initRes };

    const token = initRes.body.token;
    const batchRes = [];
    for (const images of batches) {
        batchRes.push(await request(app).post('/api/saves').send({ token, images }));
    }
    const finalRes = await request(app).post('/api/saves').send({ token, finalize: true });
    return { initRes, batchRes, finalRes };
}

describe('routes/saves 三段式保存协议', () => {
    let tmpDir;
    let savesDir;
    let app;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-saves-test-'));
        savesDir = path.join(tmpDir, 'save');
        app = makeApp(savesDir);
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    const NODES_ONLY_META = {
        prompt: 'masterpiece, best quality',
        prompt2: 'second positive box',
        negativePrompt: 'lowres, bad anatomy',
        viewport: { scale: 0.8, offsetX: 120, offsetY: -40 },
        connections: [{ fromId: 'n1', toId: 'n2', order: 0 }],
        nodes: [
            { id: 'n1', type: 'prompt-node', x: 100, y: 100, width: 2048, height: 2048, text: 'a cat' },
            { id: 'n2', type: 'comfy-gen-node', x: 300, y: 100, width: 2048, height: 2600, workflowId: 'wf1', count: 1 }
        ]
    };

    describe('init 阶段', () => {
        test('init 只建会话返回 token，不产生存档目录内容变化', async () => {
            const res = await request(app).post('/api/saves')
                .send({ name: '会话测试', overwrite: false, ...NODES_ONLY_META });

            expect(res.status).toBe(200);
            expect(res.body.status).toBe('ok');
            expect(typeof res.body.token).toBe('string');
            expect(res.body.token.length).toBeGreaterThan(0);
            expect(res.body.name).toBe('会话测试');
            // 未 finalize：project.json 尚不存在
            await expect(
                fs.access(path.join(savesDir, '会话测试', 'project.json'))
            ).rejects.toThrow();
        });

        test('非覆盖模式下重名存档被拒绝', async () => {
            await saveFlow(app, { name: '重名', overwrite: false, ...NODES_ONLY_META });
            const res = await request(app).post('/api/saves')
                .send({ name: '重名', overwrite: false, ...NODES_ONLY_META });

            expect(res.status).toBe(400);
            expect(res.body.status).toBe('error');
            expect(res.body.message).toContain('已存在');
        });

        test('未提供名称时生成默认存档名 存档-YYYYMMDD-序号', async () => {
            const res = await request(app).post('/api/saves')
                .send({ overwrite: false, ...NODES_ONLY_META });

            expect(res.status).toBe(200);
            expect(res.body.name).toMatch(/^存档-\d{8}-\d{3}$/);
        });

        test('非法字符被安全化', async () => {
            const res = await request(app).post('/api/saves')
                .send({ name: 'a<b>:c', overwrite: false, ...NODES_ONLY_META });

            expect(res.status).toBe(200);
            expect(res.body.name).toBe('a_b__c');
        });
    });

    describe('空存档与纯节点存档（回归：图片为空也能正常保存）', () => {
        test('空画布：init → 0 批次 → finalize 正常写入 project.json', async () => {
            const { initRes, finalRes } = await saveFlow(app, {
                name: '空白存档', overwrite: false, ...NODES_ONLY_META, nodes: [], connections: []
            });

            expect(initRes.status).toBe(200);
            expect(finalRes.status).toBe(200);
            expect(finalRes.body.status).toBe('ok');
            expect(finalRes.body.imageCount).toBe(0);
            expect(finalRes.body.images).toEqual([]);

            const proj = JSON.parse(await fs.readFile(
                path.join(savesDir, '空白存档', 'project.json'), 'utf-8'));
            expect(proj.images).toEqual([]);
            expect(proj.nodes).toEqual([]);
        });

        test('纯节点存档：节点/连线/双向提示词完整落盘（含 prompt2）', async () => {
            const { finalRes } = await saveFlow(app, { name: '纯节点', overwrite: false, ...NODES_ONLY_META });

            expect(finalRes.status).toBe(200);
            const proj = JSON.parse(await fs.readFile(
                path.join(savesDir, '纯节点', 'project.json'), 'utf-8'));
            expect(proj.images).toEqual([]);
            expect(proj.nodes).toHaveLength(2);
            expect(proj.connections).toEqual([{ fromId: 'n1', toId: 'n2', order: 0 }]);
            expect(proj.prompt).toBe('masterpiece, best quality');
            expect(proj.prompt2).toBe('second positive box');
            expect(proj.negativePrompt).toBe('lowres, bad anatomy');
            expect(proj.viewport).toEqual({ scale: 0.8, offsetX: 120, offsetY: -40 });
        });
    });

    describe('批次上传与 finalize', () => {
        test('多批图片上传，finalize 返回 ID→文件名映射并写入文件', async () => {
            const images = [
                { id: 'img1', src: TINY_PNG, filename: 'one.png', x: 0, y: 0, width: 1, height: 1 },
                { id: 'img2', src: TINY_PNG, filename: 'two.png', x: 10, y: 0, width: 1, height: 1 }
            ];
            const { initRes, batchRes, finalRes } = await saveFlow(app,
                { name: '多批', overwrite: false, ...NODES_ONLY_META },
                [[images[0]], [images[1]]]);

            expect(initRes.status).toBe(200);
            expect(batchRes).toHaveLength(2);
            for (const r of batchRes) {
                expect(r.status).toBe(200);
                expect(r.body.status).toBe('ok');
                expect(r.body.token).toBeTruthy();
            }
            expect(finalRes.status).toBe(200);
            expect(finalRes.body.imageCount).toBe(2);
            expect(finalRes.body.images.map(i => i.id)).toEqual(['img1', 'img2']);

            const proj = JSON.parse(await fs.readFile(
                path.join(savesDir, '多批', 'project.json'), 'utf-8'));
            expect(proj.images).toHaveLength(2);
            expect(proj.nodes).toHaveLength(2); // 元数据与图片解耦：批次之外仍有节点
            const onePath = path.join(savesDir, '多批', 'images', finalRes.body.images[0].filename);
            const buf = await fs.readFile(onePath);
            expect(buf.length).toBeGreaterThan(0);
        });

        test('data URL 图片名重复时自动追加序号', async () => {
            const img = { id: 'img1', src: TINY_PNG, filename: 'dup.png', x: 0, y: 0, width: 1, height: 1 };
            const { finalRes } = await saveFlow(app,
                { name: '去重', overwrite: false }, [[img, { ...img, id: 'img2' }]]);

            const filenames = finalRes.body.images.map(i => i.filename).sort();
            expect(filenames).toEqual(['dup.png', 'dup_1.png']);
        });

        test('finalize 覆盖模式替换 images 目录，旧图片被清理', async () => {
            const oldImg = { id: 'old1', src: TINY_PNG, filename: 'old.png', x: 0, y: 0, width: 1, height: 1 };
            await saveFlow(app, { name: '覆盖', overwrite: false }, [[oldImg]]);

            const newImg = { id: 'new1', src: TINY_PNG, filename: 'new.png', x: 5, y: 5, width: 1, height: 1 };
            const { finalRes } = await saveFlow(app, { name: '覆盖', overwrite: true }, [[newImg]]);

            expect(finalRes.status).toBe(200);
            expect(finalRes.body.overwrite).toBe(true);
            const imagesDir = path.join(savesDir, '覆盖', 'images');
            const files = await fs.readdir(imagesDir);
            expect(files).toEqual(['new.png']);
            // 覆盖完成后临时目录不残留
            await expect(fs.access(path.join(savesDir, '覆盖', 'images_tmp'))).rejects.toThrow();
        });

        test('无效 token 被拒绝', async () => {
            const res = await request(app).post('/api/saves')
                .send({ token: 'no_such_token', images: [] });
            expect(res.status).toBe(400);
            expect(res.body.message).toContain('不存在');
        });
    });

    describe('视频对象存档（回归：视频实体归档与 videoUrl 持久化）', () => {
        let videoSrcPath;
        let videoBytes;

        beforeEach(async () => {
            // 造一个"视频"源文件（内容不重要，字节一致即可）
            videoBytes = Buffer.from('fake mp4 payload for archive test');
            videoSrcPath = path.join(tmpDir, 'source-video.mp4');
            await fs.writeFile(videoSrcPath, videoBytes);
        });

        test('videoUrl 写入元数据，视频实体归档到 videos/ 子目录', async () => {
            const videoEntry = {
                id: 'v1', src: TINY_PNG, filename: 'video_a.png',
                name: 'video_a.mp4', source: 'video',
                videoUrl: videoSrcPath,       // 绝对路径（saveVideoFile 支持）
                x: 0, y: 0, width: 100, height: 200
            };
            const { finalRes } = await saveFlow(app, { name: '视频存档', overwrite: false }, [[videoEntry]]);

            expect(finalRes.status).toBe(200);
            const meta = finalRes.body.images[0];
            expect(meta.videoUrl).toBe(videoSrcPath);          // videoUrl 不再被丢弃
            expect(meta.videoFile).toBe('source-video.mp4');   // 归档副本文件名

            const archived = await fs.readFile(path.join(savesDir, '视频存档', 'videos', 'source-video.mp4'));
            expect(archived.equals(videoBytes)).toBe(true);

            const proj = JSON.parse(await fs.readFile(
                path.join(savesDir, '视频存档', 'project.json'), 'utf-8'));
            expect(proj.images[0].videoUrl).toBe(videoSrcPath);
            expect(proj.images[0].videoFile).toBe('source-video.mp4');
        });

        test('读取接口把 videoUrl 重写为存档内副本路径', async () => {
            const videoEntry = {
                id: 'v1', src: TINY_PNG, filename: 'video_a.png',
                name: 'video_a.mp4', source: 'video',
                videoUrl: videoSrcPath, x: 0, y: 0, width: 100, height: 200
            };
            await saveFlow(app, { name: '视频读取', overwrite: false }, [[videoEntry]]);

            const res = await request(app).get('/api/saves/' + encodeURIComponent('视频读取'));
            const img = res.body.data.images[0];
            expect(img.videoUrl).toBe('save/%E8%A7%86%E9%A2%91%E8%AF%BB%E5%8F%96/videos/source-video.mp4');
            expect(img.videoFile).toBe('source-video.mp4');
        });

        test('无视频对象的存档不创建 videos 目录', async () => {
            await saveFlow(app, { name: '无视频', overwrite: false });
            const entries = await fs.readdir(path.join(savesDir, '无视频'));
            expect(entries).toEqual(['images', 'project.json']);
        });

        test('覆盖保存替换 videos 目录：旧视频清理、新视频落位', async () => {
            const v1 = { id: 'v1', src: TINY_PNG, filename: 'a.png', name: 'a.mp4', source: 'video', videoUrl: videoSrcPath, x: 0, y: 0, width: 1, height: 1 };
            await saveFlow(app, { name: '覆盖视频', overwrite: false }, [[v1]]);

            const v2 = { id: 'v2', src: TINY_PNG, filename: 'b.png', name: 'b.mp4', source: 'video', videoUrl: videoSrcPath, x: 0, y: 0, width: 1, height: 1 };
            await saveFlow(app, { name: '覆盖视频', overwrite: true }, [[v2]]);

            const videos = await fs.readdir(path.join(savesDir, '覆盖视频', 'videos'));
            expect(videos).toEqual(['source-video.mp4']);
            // 临时目录不残留
            const rootEntries = await fs.readdir(path.join(savesDir, '覆盖视频'));
            expect(rootEntries).toEqual(['images', 'project.json', 'videos']);
        });

        test('源视频文件不存在时保留 videoUrl 但不归档', async () => {
            const v = { id: 'v1', src: TINY_PNG, filename: 'a.png', name: 'gone.mp4', source: 'video', videoUrl: '/data/videos/missing.mp4', x: 0, y: 0, width: 1, height: 1 };
            const { finalRes } = await saveFlow(app, { name: '丢失视频', overwrite: false }, [[v]]);

            expect(finalRes.body.images[0].videoUrl).toBe('/data/videos/missing.mp4');
            expect(finalRes.body.images[0].videoFile).toBeUndefined();
            await expect(fs.access(path.join(savesDir, '丢失视频', 'videos'))).rejects.toThrow();
        });
    });

    describe('读取接口', () => {
        test('GET /api/saves/:name 返回存档并将图片 src 转为相对 URL', async () => {
            const img = { id: 'img1', src: TINY_PNG, filename: 'pic.png', x: 0, y: 0, width: 1, height: 1 };
            await saveFlow(app, { name: '读取', overwrite: false, ...NODES_ONLY_META }, [[img]]);

            const res = await request(app).get('/api/saves/' + encodeURIComponent('读取'));
            expect(res.status).toBe(200);
            expect(res.body.status).toBe('ok');
            expect(res.body.data.prompt2).toBe('second positive box');
            expect(res.body.data.nodes).toHaveLength(2);
            expect(res.body.data.images[0].src).toBe('save/%E8%AF%BB%E5%8F%96/images/pic.png');
        });

        test('GET /api/saves 列出全部存档', async () => {
            await saveFlow(app, { name: '列表A', overwrite: false });
            await saveFlow(app, { name: '列表B', overwrite: false });

            const res = await request(app).get('/api/saves');
            expect(res.status).toBe(200);
            const names = res.body.saves.map(s => s.name);
            expect(names).toContain('列表A');
            expect(names).toContain('列表B');
        });

        test('读取不存在的存档返回 404', async () => {
            const res = await request(app).get('/api/saves/' + encodeURIComponent('不存在'));
            expect(res.status).toBe(404);
        });
    });
});

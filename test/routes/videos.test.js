/**
 * ==========================================================================
 * routes/videos.js + saves 视频工作区 GC 集成测试
 * 覆盖 data/videos 工作区的两条清理路径：
 *   - DELETE /api/videos/:filename（画布删除视频时的立即删除，防路径穿越）
 *   - 保存提交后的引用 GC（commitSave 清理未引用文件）
 * videosDir 指向临时目录，不触碰真实 data/videos。
 * ==========================================================================
 */

const express = require('express');
const request = require('supertest');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const createVideosRouter = require('../../routes/videos');
const createSavesRouter = require('../../routes/saves');

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('视频工作区清理', () => {
    let tmpDir;
    let videosDir;
    let app;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-videos-test-'));
        videosDir = path.join(tmpDir, 'data', 'videos');
        await fs.mkdir(videosDir, { recursive: true });
        app = express();
        app.use(express.json({ limit: '100mb' }));
        app.use('/api/videos', createVideosRouter({ videosDir }));
        app.use('/api/saves', createSavesRouter({ savesDir: path.join(tmpDir, 'save'), videosDir }));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    describe('DELETE /api/videos/:filename', () => {
        test('删除存在的文件', async () => {
            await fs.writeFile(path.join(videosDir, 'a.mp4'), 'data');

            const res = await request(app).delete('/api/videos/a.mp4');
            expect(res.status).toBe(200);
            await expect(fs.access(path.join(videosDir, 'a.mp4'))).rejects.toThrow();
        });

        test('文件不存在时幂等成功', async () => {
            const res = await request(app).delete('/api/videos/missing.mp4');
            expect(res.status).toBe(200);
        });

        test('路径穿越被拦截（../ 与绝对路径均无法逃出 videos 目录）', async () => {
            const secret = path.join(tmpDir, 'secret.txt');
            await fs.writeFile(secret, 'secret');

            await request(app).delete('/api/videos/..%2Fsecret.txt');
            await request(app).delete('/api/videos/' + encodeURIComponent('../secret.txt'));
            // 文件必须还在
            await expect(fs.access(secret)).resolves.toBeUndefined();
        });
    });

    describe('保存后的引用 GC（commitSave）', () => {
        async function saveWithVideos(videos) {
            // 先按前端会引用的工作区文件名创建视频实体
            for (const v of videos) {
                await fs.writeFile(path.join(videosDir, path.basename(v.videoUrl)), 'video-bytes-' + v.id);
            }
            const entries = videos.map((v) => ({
                id: v.id, src: TINY_PNG, filename: v.id + '.png',
                name: v.id + '.mp4', source: 'video', videoUrl: v.videoUrl,
                x: 0, y: 0, width: 1, height: 1
            }));
            const init = await request(app).post('/api/saves')
                .send({ name: 'GC存档', overwrite: false, nodes: [] });
            expect(init.status).toBe(200);
            const batch = await request(app).post('/api/saves')
                .send({ token: init.body.token, images: entries });
            expect(batch.status).toBe(200);
            return request(app).post('/api/saves').send({ token: init.body.token, finalize: true });
        }

        test('保存后：被引用的保留、未引用的被清理', async () => {
            // 预置一个无关文件（前次会话遗留）——应当被清理
            await fs.writeFile(path.join(videosDir, 'orphan.mp4'), 'orphan');

            const res = await saveWithVideos([
                { id: 'v1', videoUrl: '/data/videos/keep.mp4' }
            ]);
            expect(res.status).toBe(200);

            const remaining = await fs.readdir(videosDir);
            expect(remaining).toContain('keep.mp4');      // 被画布引用 → 保留
            expect(remaining).not.toContain('orphan.mp4'); // 无引用 → 清理
        });

        test('videoUrl 指向存档副本（save/...）不占工作区引用', async () => {
            await fs.writeFile(path.join(videosDir, 'workspace.mp4'), 'data');
            const res = await saveWithVideos([
                { id: 'v1', videoUrl: 'save/其他存档/videos/archived.mp4' }
            ]);
            expect(res.status).toBe(200);
            // 指向存档的引用不影响工作区判定：workspace.mp4 未被引用 → 清理
            const remaining = await fs.readdir(videosDir);
            expect(remaining).not.toContain('workspace.mp4');
        });

        test('未传 videosDir 时 GC 跳过（向后兼容）', async () => {
            const bareApp = express();
            bareApp.use(express.json({ limit: '100mb' }));
            bareApp.use('/api/saves', createSavesRouter({ savesDir: path.join(tmpDir, 'save2') }));

            await fs.writeFile(path.join(videosDir, 'untouched.mp4'), 'data');
            const init = await request(bareApp).post('/api/saves')
                .send({ name: '无GC', overwrite: false, nodes: [] });
            await request(bareApp).post('/api/saves')
                .send({ token: init.body.token, images: [] });
            await request(bareApp).post('/api/saves').send({ token: init.body.token, finalize: true });

            const remaining = await fs.readdir(videosDir);
            expect(remaining).toContain('untouched.mp4');
        });
    });
});

/**
 * ==========================================================================
 * routes/tags.js 提示词 sidecar（tag/images/<图片名>.txt）测试：
 *   - POST 保存后生成同名 .txt（标题/模型/时间头 + 正面 + 负面段；
 *     负面为空时整段省略）
 *   - PUT 编辑后 sidecar 内容同步重写
 *   - DELETE 连带删除 sidecar
 *   - 同图重复保存（去重分支）改名后 sidecar 跟着重写
 *   - 旧数据迁移：首次 GET / 为缺 sidecar 的条目幂等补齐（已有的不动）；
 *     imageHash 缺失的旧条目从 imageUrl 兜底推导文件名
 *   - 生成参数节（genInfo，溯源/生成同款）：POST 带记录 → 存进 tags.json
 *     （真相源）且 sidecar 追加「生成参数」节（comfy/api 口径、空值不占行）；
 *     PUT 编辑重写不丢参数节；坏载荷（非对象/缺 mode）拒收不写字段；
 *     同图重复保存随带新记录时更新
 * 临时目录隔离 tag/，内存 express 应用 + supertest 直打路由。
 * ==========================================================================
 */

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');

const createTagsRouter = require('../../routes/tags');

// 1×1 PNG（Data URL 直传，sharp 可解码转 WebP）
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function makeApp(tagsDir) {
    const app = express();
    app.use(express.json());
    app.use('/api/tags', createTagsRouter({ tagsDir }));
    return app;
}

/** 按收藏条目推 sidecar 路径（images/<去扩展名图片名>.txt） */
const sidecarPath = (tagsDir, tag) =>
    path.join(tagsDir, 'images', `${path.basename(tag.imageUrl).replace(/\.webp$/, '')}.txt`);

describe('routes/tags 提示词 sidecar', () => {
    let tagsDir;
    beforeEach(() => {
        tagsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tags-sidecar-test-'));
    });
    afterEach(() => {
        fs.rmSync(tagsDir, { recursive: true, force: true });
    });

    test('POST 保存后生成同名 .txt：头部三行 + 正/负面段', async () => {
        const app = makeApp(tagsDir);
        const res = await request(app).post('/api/tags').send({
            prompt: 'masterpiece, 1girl',
            negativePrompt: 'lowres, bad hands',
            imageUrl: TINY_PNG,
            name: '蓝天海岸',
            model: 'anima',
            source: 'comfy'
        });
        expect(res.status).toBe(200);

        const txt = fs.readFileSync(sidecarPath(tagsDir, res.body.tag), 'utf8');
        expect(txt).toContain('标题: 蓝天海岸');
        expect(txt).toContain('模型: anima');
        expect(txt).toMatch(/^时间: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/m);
        expect(txt).toContain('── 正面提示词 ──\nmasterpiece, 1girl');
        expect(txt).toContain('── 负面提示词 ──\nlowres, bad hands');
    });

    test('负面提示词为空时省略负面段', async () => {
        const app = makeApp(tagsDir);
        const res = await request(app).post('/api/tags').send({
            prompt: 'masterpiece, 1girl',
            imageUrl: TINY_PNG,
            name: '无题'
        });
        const txt = fs.readFileSync(sidecarPath(tagsDir, res.body.tag), 'utf8');
        expect(txt).toContain('── 正面提示词 ──');
        expect(txt).not.toContain('── 负面提示词 ──');
    });

    test('PUT 编辑后 sidecar 同步重写', async () => {
        const app = makeApp(tagsDir);
        const tag = (await request(app).post('/api/tags').send({
            prompt: 'old prompt', imageUrl: TINY_PNG, name: '旧名', model: 'anima'
        })).body.tag;

        await request(app).put(`/api/tags/${tag.id}`).send({ name: '新名', prompt: 'new prompt' });
        const txt = fs.readFileSync(sidecarPath(tagsDir, tag), 'utf8');
        expect(txt).toContain('标题: 新名');
        expect(txt).toContain('new prompt');
        expect(txt).not.toContain('old prompt');
    });

    test('DELETE 连带删除 sidecar', async () => {
        const app = makeApp(tagsDir);
        const tag = (await request(app).post('/api/tags').send({
            prompt: 'p', imageUrl: TINY_PNG, name: 'x'
        })).body.tag;
        const file = sidecarPath(tagsDir, tag);
        expect(fs.existsSync(file)).toBe(true);

        await request(app).delete(`/api/tags/${tag.id}`);
        expect(fs.existsSync(file)).toBe(false);
    });

    test('同图重复保存（去重分支）改名后 sidecar 跟着重写', async () => {
        const app = makeApp(tagsDir);
        const body = { prompt: 'p', imageUrl: TINY_PNG, name: '第一版', model: 'anima' };
        await request(app).post('/api/tags').send(body);

        const second = await request(app).post('/api/tags').send({ ...body, name: '第二版' });
        expect(second.body.duplicated).toBe(true);

        const txt = fs.readFileSync(sidecarPath(tagsDir, second.body.tag), 'utf8');
        expect(txt).toContain('标题: 第二版');
        expect(txt).not.toContain('第一版');
    });

    test('旧数据迁移：首次 GET / 为缺 sidecar 的条目补齐，已有的不覆盖（幂等）', async () => {
        const imagesDir = path.join(tagsDir, 'images');
        fs.mkdirSync(imagesDir, { recursive: true });

        // 条目 A：预置 sidecar（模拟用户手工放过的标记），GET 不应覆盖
        fs.writeFileSync(path.join(imagesDir, 'aaa.txt'), '手工标记', 'utf8');
        // 条目 B：无 sidecar，GET 应补齐
        const seed = [
            { id: 'a', imageHash: 'aaa', name: '已有', model: 'anima', prompt: 'pa',
              imageUrl: '/tag/images/aaa.webp', thumbnailUrl: '/tag/thumbnails/aaa.webp', createdAt: 1700000000000 },
            { id: 'b', imageHash: 'bbb', name: '待补', model: '', prompt: 'pb',
              negativePrompt: 'nb', imageUrl: '/tag/images/bbb.webp', thumbnailUrl: '/tag/thumbnails/bbb.webp', createdAt: 1700000000001 }
        ];
        fs.writeFileSync(path.join(tagsDir, 'tags.json'), JSON.stringify(seed), 'utf8');

        await request(makeApp(tagsDir)).get('/api/tags');

        expect(fs.readFileSync(path.join(imagesDir, 'aaa.txt'), 'utf8')).toBe('手工标记');
        const b = fs.readFileSync(path.join(imagesDir, 'bbb.txt'), 'utf8');
        expect(b).toContain('标题: 待补');
        expect(b).toContain('── 正面提示词 ──\npb');
        expect(b).toContain('── 负面提示词 ──\nnb');

        // 再 GET 一次不炸不重写（幂等由存在性检查保证）
        await request(makeApp(tagsDir)).get('/api/tags');
        expect(fs.readFileSync(path.join(imagesDir, 'aaa.txt'), 'utf8')).toBe('手工标记');
    });

    test('imageHash 缺失的旧条目从 imageUrl 兜底推导 sidecar 名', async () => {
        const imagesDir = path.join(tagsDir, 'images');
        fs.mkdirSync(imagesDir, { recursive: true });
        const seed = [{
            id: 'legacy', name: '旧条目', model: 'flux2 klein', prompt: 'legacy prompt',
            imageUrl: '/tag/images/legacy123.webp', thumbnailUrl: '/tag/thumbnails/legacy123.webp',
            createdAt: 1700000000000
        }];
        fs.writeFileSync(path.join(tagsDir, 'tags.json'), JSON.stringify(seed), 'utf8');

        await request(makeApp(tagsDir)).get('/api/tags');
        const txt = fs.readFileSync(path.join(imagesDir, 'legacy123.txt'), 'utf8');
        expect(txt).toContain('标题: 旧条目');
        expect(txt).toContain('模型: flux2 klein');
        expect(txt).toContain('legacy prompt');
    });

    // ==================== 生成参数节（genInfo，溯源/生成同款） ====================

    const COMFY_GEN_INFO = {
        mode: 'comfy',
        time: new Date(2026, 9, 30, 8, 5, 0).getTime(),
        sourceNodeId: 'n1',
        sourceNodeTitle: 'Generate #001',
        workflowId: 'wf-1',
        workflowName: 'anima画布工作流',
        positive: 'p',
        negative: '',
        params: { steps: 28, cfg: 4.5, sampler: 'euler', sizeW: 832, sizeH: 1216, denoise: null },
        model: 'anima_v2.safetensors',
        loras: [{ file: 'add_detail.safetensors', strengthModel: 0.8, strengthClip: 1 }]
    };

    test('POST 带 genInfo：tags.json 存真相源且 sidecar 追加生成参数节', async () => {
        const app = makeApp(tagsDir);
        const res = await request(app).post('/api/tags').send({
            prompt: 'p', imageUrl: TINY_PNG, name: '带记录', model: 'anima',
            genInfo: COMFY_GEN_INFO
        });
        expect(res.status).toBe(200);

        const txt = fs.readFileSync(sidecarPath(tagsDir, res.body.tag), 'utf8');
        expect(txt).toContain('── 生成参数 ──');
        expect(txt).toContain('模式: ComfyUI');
        expect(txt).toMatch(/^生成时间: 2026-10-30 08:05:00$/m);
        expect(txt).toContain('工作流: anima画布工作流');
        expect(txt).toContain('主模型: anima_v2.safetensors');
        expect(txt).toContain('步数: 28');
        expect(txt).toContain('尺寸: 832 × 1216');
        expect(txt).toContain('LoRA: add_detail.safetensors (0.8)');
        // 空值不占行：denoise 为 null、负面段为空
        expect(txt).not.toContain('去噪');

        // 真相源（tags.json）也存了记录——编辑重写 sidecar 不丢参数节的保障
        const tags = JSON.parse(fs.readFileSync(path.join(tagsDir, 'tags.json'), 'utf8'));
        expect(tags[0].genInfo.mode).toBe('comfy');
        expect(tags[0].genInfo.params.steps).toBe(28);
    });

    test('api 模式参数节：复合键拆模型 ID，厂商不单列', async () => {
        const app = makeApp(tagsDir);
        const res = await request(app).post('/api/tags').send({
            prompt: 'p', imageUrl: TINY_PNG, name: 'api 图',
            genInfo: {
                mode: 'api',
                model: 'openai||gpt-image-1',
                provider: 'openai',
                size: '1024x1024',
                refCount: 2
            }
        });
        const txt = fs.readFileSync(sidecarPath(tagsDir, res.body.tag), 'utf8');
        expect(txt).toContain('模式: API 生图');
        expect(txt).toContain('模型: gpt-image-1');
        expect(txt).not.toContain('厂商');
        expect(txt).toContain('参考图: 2 张');
    });

    test('PUT 编辑后 sidecar 重写仍保留生成参数节', async () => {
        const app = makeApp(tagsDir);
        const tag = (await request(app).post('/api/tags').send({
            prompt: 'p', imageUrl: TINY_PNG, name: '旧名', genInfo: COMFY_GEN_INFO
        })).body.tag;

        await request(app).put(`/api/tags/${tag.id}`).send({ name: '新名', prompt: 'new' });
        const txt = fs.readFileSync(sidecarPath(tagsDir, tag), 'utf8');
        expect(txt).toContain('标题: 新名');
        expect(txt).toContain('── 生成参数 ──');
        expect(txt).toContain('工作流: anima画布工作流');
    });

    test('坏载荷拒收：非对象/缺 mode 不写字段，sidecar 无参数节', async () => {
        const app = makeApp(tagsDir);
        const res = await request(app).post('/api/tags').send({
            prompt: 'p', imageUrl: TINY_PNG, name: '坏记录',
            genInfo: 'junk-string'
        });
        expect(res.status).toBe(200);

        const tags = JSON.parse(fs.readFileSync(path.join(tagsDir, 'tags.json'), 'utf8'));
        expect(tags[0].genInfo).toBeUndefined();
        const txt = fs.readFileSync(sidecarPath(tagsDir, res.body.tag), 'utf8');
        expect(txt).not.toContain('── 生成参数 ──');

        // 缺 mode 的对象同样拒收
        const res2 = await request(app).post('/api/tags').send({
            prompt: 'p2', imageUrl: TINY_PNG, name: '缺mode', genInfo: { foo: 1 }
        });
        const tags2 = JSON.parse(fs.readFileSync(path.join(tagsDir, 'tags.json'), 'utf8'));
        expect(res2.status).toBe(200);
        expect(tags2.find(t => t.name === '缺mode').genInfo).toBeUndefined();
    });

    test('同图重复保存随带新 genInfo 时更新记录并重写参数节', async () => {
        const app = makeApp(tagsDir);
        const body = { prompt: 'p', imageUrl: TINY_PNG, name: '第一版' };
        await request(app).post('/api/tags').send(body);

        const second = await request(app).post('/api/tags').send({
            ...body, name: '第二版', genInfo: COMFY_GEN_INFO
        });
        expect(second.body.duplicated).toBe(true);

        const tags = JSON.parse(fs.readFileSync(path.join(tagsDir, 'tags.json'), 'utf8'));
        expect(tags[0].genInfo.mode).toBe('comfy');
        const txt = fs.readFileSync(sidecarPath(tagsDir, second.body.tag), 'utf8');
        expect(txt).toContain('标题: 第二版');
        expect(txt).toContain('── 生成参数 ──');
    });
});

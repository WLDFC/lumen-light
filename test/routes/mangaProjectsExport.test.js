/**
 * 漫画项目路由导出端点测试（routes/mangaProjects.js POST /export-zip，
 * ADR 079「导出本项目到本地」）。前端逐页渲染 PNG 后 base64 上传，后端
 * 流式打包 zip 下载——本测试用 1x1 PNG 夹具走真打包，yauzl 解包校验
 * 条目名与字节数；载荷校验（坏 dataUrl/空 files/超名）与文件名净化另测。
 */

const request = require('supertest');
const express = require('express');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const yauzl = require('yauzl');
const createMangaProjectsRouter = require('../../routes/mangaProjects');

/** 1x1 透明 PNG 的 data URL 夹具 */
const TINY_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** supertest 响应体（ArrayBuffer/Blob/Buffer）→ Buffer */
async function bodyToBuffer(body) {
    if (Buffer.isBuffer(body)) return body;
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
        return Buffer.from(new Uint8Array(await body.arrayBuffer()));
    }
    if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
    return Buffer.from(body);
}

/** yauzl 读 zip 条目名清单（Promise 包装） */
async function listZipEntries(body) {
    const buf = await bodyToBuffer(body);
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(buf, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
            if (err) return reject(err);
            const names = [];
            zipfile.on('entry', (entry) => {
                names.push(entry.fileName);
                zipfile.readEntry();
            });
            zipfile.on('end', () => resolve(names));
            zipfile.on('error', reject);
            zipfile.readEntry();
        });
    });
}

function makeApp() {
    const app = express();
    app.use(express.json({ limit: '100mb' }));
    app.use('/api/manga-projects', createMangaProjectsRouter({ dataDir: os.tmpdir() }));
    return app;
}

describe('漫画页面合成图打包（POST /api/manga-projects/export-zip）', () => {
    test('两张 PNG 打包成 zip：条目名原样、字节可解包', async () => {
        const r = await request(makeApp()).post('/api/manga-projects/export-zip')
            .send({
                name: '我的漫画',
                files: [
                    { name: '第01页.png', dataUrl: TINY_PNG },
                    { name: '第02页.png', dataUrl: TINY_PNG }
                ]
            })
            .responseType('arraybuffer');
        expect(r.status).toBe(200);
        expect(r.headers['content-type']).toBe('application/zip');
        expect(Buffer.isBuffer(r.body)).toBe(true);
        const names = await listZipEntries(r.body);
        expect(names).toEqual(['第01页.png', '第02页.png']);
    });

    test('zip 文件名中文走 RFC 5987 filename* 头', async () => {
        const r = await request(makeApp()).post('/api/manga-projects/export-zip')
            .send({ name: '默认漫画', files: [{ name: 'p.png', dataUrl: TINY_PNG }] });
        expect(r.headers['content-disposition']).toContain('filename*=UTF-8\'\'');
        expect(r.headers['content-disposition']).toContain(encodeURIComponent('默认漫画'));
    });

    test('同名条目自动加 (2) 后缀不互相覆盖', async () => {
        const r = await request(makeApp()).post('/api/manga-projects/export-zip')
            .send({
                name: 'x',
                files: [
                    { name: 'p.png', dataUrl: TINY_PNG },
                    { name: 'p.png', dataUrl: TINY_PNG }
                ]
            })
            .responseType('arraybuffer');
        expect(r.status).toBe(200);
        expect(await listZipEntries(r.body)).toEqual(['p.png', 'p(2).png']);
    });

    test('载荷校验：坏 dataUrl / 空 files / 空名 400', async () => {
        const app = makeApp();
        expect((await request(app).post('/api/manga-projects/export-zip')
            .send({ name: 'x', files: [{ name: 'p.png', dataUrl: 'not-a-dataurl' }] })).status).toBe(400);
        expect((await request(app).post('/api/manga-projects/export-zip')
            .send({ name: 'x', files: [] })).status).toBe(400);
        expect((await request(app).post('/api/manga-projects/export-zip')
            .send({ name: '', files: [{ name: 'p.png', dataUrl: TINY_PNG }] })).status).toBe(400);
    });

    test('条目名路径分隔符被净化（防 zip-slip）', async () => {
        const r = await request(makeApp()).post('/api/manga-projects/export-zip')
            .send({
                name: 'x',
                files: [{ name: '..\\evil\\page.png', dataUrl: TINY_PNG }]
            })
            .responseType('arraybuffer');
        expect(r.status).toBe(200);
        const names = await listZipEntries(r.body);
        expect(names[0]).not.toContain('\\');
        expect(names[0]).not.toContain('..');
    });
});

/**
 * ==========================================================================
 * utils/piExtensionSync.js 单元测试：pi 扩展差量同步
 * 安装/覆盖/跳过三分统计、非 .ts 忽略、源目录缺失容错、
 * 目标目录里的无关文件不受影响（用户自装扩展不动）。
 * 临时目录隔离真实 ~/.pi/agent/extensions/。
 * ==========================================================================
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { syncPiExtensions } = require('../../utils/piExtensionSync');

function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file, content) {
    fs.writeFileSync(file, content);
    return file;
}

describe('utils/piExtensionSync 扩展差量同步', () => {
    let srcDir;
    let targetDir;

    beforeEach(() => {
        srcDir = path.join(makeTempDir('pi-sync-proj-'), 'pi-extensions');
        fs.mkdirSync(srcDir, { recursive: true });
        targetDir = makeTempDir('pi-sync-target-');
    });

    afterEach(() => {
        fs.rmSync(path.dirname(srcDir), { recursive: true, force: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
    });

    test('首次同步：全部 installed，文件落盘', () => {
        write(path.join(srcDir, 'a.ts'), 'export const a = 1;');
        write(path.join(srcDir, 'b.ts'), 'export const b = 2;');
        const r = syncPiExtensions({ projectRoot: path.dirname(srcDir), targetDir });
        expect(r).toMatchObject({ installed: 2, updated: 0, skipped: 0, synced: 2, errors: [] });
        expect(fs.readFileSync(path.join(targetDir, 'a.ts'), 'utf8')).toBe('export const a = 1;');
    });

    test('重复同步：内容一致全部 skipped，不重复写盘', () => {
        write(path.join(srcDir, 'a.ts'), 'const a = 1;');
        const target = path.join(targetDir, 'a.ts');
        syncPiExtensions({ projectRoot: path.dirname(srcDir), targetDir });
        const before = fs.statSync(target).mtimeMs;
        const r = syncPiExtensions({ projectRoot: path.dirname(srcDir), targetDir });
        expect(r).toMatchObject({ installed: 0, updated: 0, skipped: 1, synced: 0 });
        expect(fs.statSync(target).mtimeMs).toBe(before);
    });

    test('源码变更：覆盖更新（updated）并写入新内容', () => {
        const src = write(path.join(srcDir, 'a.ts'), 'v1');
        syncPiExtensions({ projectRoot: path.dirname(srcDir), targetDir });
        write(src, 'v2');
        const r = syncPiExtensions({ projectRoot: path.dirname(srcDir), targetDir });
        expect(r).toMatchObject({ installed: 0, updated: 1, synced: 1 });
        expect(fs.readFileSync(path.join(targetDir, 'a.ts'), 'utf8')).toBe('v2');
    });

    test('非 .ts 文件与子目录忽略', () => {
        write(path.join(srcDir, 'README.md'), 'readme');
        write(path.join(srcDir, 'a.ts'), 'const a = 1;');
        fs.mkdirSync(path.join(srcDir, 'sub'));
        const r = syncPiExtensions({ projectRoot: path.dirname(srcDir), targetDir });
        expect(r).toMatchObject({ installed: 1, synced: 1 });
        expect(fs.existsSync(path.join(targetDir, 'README.md'))).toBe(false);
    });

    test('目标目录里的用户自有文件不受影响', () => {
        const userExt = write(path.join(targetDir, 'my-own-ext.ts'), 'user content');
        write(path.join(srcDir, 'a.ts'), 'const a = 1;');
        syncPiExtensions({ projectRoot: path.dirname(srcDir), targetDir });
        expect(fs.readFileSync(userExt, 'utf8')).toBe('user content');
    });

    test('目标目录不存在时自动创建', () => {
        const nested = path.join(targetDir, 'deep', 'extensions');
        write(path.join(srcDir, 'a.ts'), 'const a = 1;');
        const r = syncPiExtensions({ projectRoot: path.dirname(srcDir), targetDir: nested });
        expect(r).toMatchObject({ installed: 1, errors: [] });
        expect(fs.existsSync(path.join(nested, 'a.ts'))).toBe(true);
    });

    test('源目录缺失：errors 记录、零写入、不抛异常', () => {
        const r = syncPiExtensions({
            projectRoot: path.join(makeTempDir('pi-sync-empty-')),
            targetDir
        });
        expect(r.synced).toBe(0);
        expect(r.errors[0]).toContain('源目录不存在');
    });

    test('真实项目源码可同步（sanity）：pi-extensions 下 5 个扩展全部就位', () => {
        // 不落真实 C 盘：targetDir 指向临时目录，projectRoot 用真实项目根
        const r = syncPiExtensions({ targetDir });
        expect(r.errors).toEqual([]);
        expect(r.synced).toBeGreaterThanOrEqual(5);
        for (const name of ['lumen-canvas.ts', 'lumen-guard.ts', 'lumen-mcp.ts',
            'lumen-skills.ts', 'lumen-web.ts']) {
            expect(fs.existsSync(path.join(targetDir, name))).toBe(true);
        }
    });
});

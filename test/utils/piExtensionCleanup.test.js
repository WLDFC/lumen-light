/**
 * ==========================================================================
 * utils/piExtensionCleanup.js 单元测试：pi 遗留全局扩展清理
 * 同名删除、非同名不动（用户自装扩展）、子目录跳过、
 * 源/目标目录缺失容错、PI_CODING_AGENT_DIR 解析、
 * 真实项目源码清单 sanity。
 * 临时目录隔离真实 ~/.pi/agent/extensions/。
 * ==========================================================================
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { cleanupLegacyGlobalExtensions } = require('../../utils/piExtensionCleanup');

function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file, content) {
    fs.writeFileSync(file, content);
    return file;
}

describe('utils/piExtensionCleanup 遗留全局扩展清理', () => {
    let srcDir;
    let targetDir;

    beforeEach(() => {
        srcDir = path.join(makeTempDir('pi-clean-proj-'), 'pi-extensions');
        fs.mkdirSync(srcDir, { recursive: true });
        targetDir = makeTempDir('pi-clean-target-');
    });

    afterEach(() => {
        fs.rmSync(path.dirname(srcDir), { recursive: true, force: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
        delete process.env.PI_CODING_AGENT_DIR;
    });

    test('同名遗留文件删除，返回 removed 清单', () => {
        write(path.join(srcDir, 'a.ts'), 'export const a = 1;');
        write(path.join(srcDir, 'b.ts'), 'export const b = 2;');
        const fa = write(path.join(targetDir, 'a.ts'), 'stale copy');
        const fb = write(path.join(targetDir, 'b.ts'), 'stale copy');
        const r = cleanupLegacyGlobalExtensions({
            projectRoot: path.dirname(srcDir), targetDir
        });
        expect(r.removed.sort()).toEqual(['a.ts', 'b.ts']);
        expect(r.errors).toEqual([]);
        expect(fs.existsSync(fa)).toBe(false);
        expect(fs.existsSync(fb)).toBe(false);
    });

    test('名字不在 pi-extensions/ 清单内的文件一律不动（用户自装扩展）', () => {
        write(path.join(srcDir, 'lumen-canvas.ts'), 'const a = 1;');
        const userExt = write(path.join(targetDir, 'my-own-ext.ts'), 'user content');
        const userOther = write(path.join(targetDir, 'lumen-canvas.js'), 'not ts');
        cleanupLegacyGlobalExtensions({
            projectRoot: path.dirname(srcDir), targetDir
        });
        expect(fs.readFileSync(userExt, 'utf8')).toBe('user content');
        expect(fs.existsSync(userOther)).toBe(true);
    });

    test('同名子目录跳过，只删普通文件', () => {
        write(path.join(srcDir, 'a.ts'), 'const a = 1;');
        const dirLike = path.join(targetDir, 'a.ts');
        fs.mkdirSync(dirLike);
        fs.writeFileSync(path.join(dirLike, 'inner.txt'), 'x');
        const r = cleanupLegacyGlobalExtensions({
            projectRoot: path.dirname(srcDir), targetDir
        });
        expect(r.removed).toEqual([]);
        expect(fs.existsSync(dirLike)).toBe(true);
    });

    test('目标目录不存在：静默零删除、不抛异常', () => {
        write(path.join(srcDir, 'a.ts'), 'const a = 1;');
        const r = cleanupLegacyGlobalExtensions({
            projectRoot: path.dirname(srcDir),
            targetDir: path.join(targetDir, 'not-exist')
        });
        expect(r).toEqual({ removed: [], errors: [] });
    });

    test('源目录缺失：无从匹配清单，静默零删除', () => {
        write(path.join(targetDir, 'a.ts'), 'stale');
        const r = cleanupLegacyGlobalExtensions({
            projectRoot: path.join(makeTempDir('pi-clean-empty-')), targetDir
        });
        expect(r.removed).toEqual([]);
        expect(fs.existsSync(path.join(targetDir, 'a.ts'))).toBe(true);
    });

    test('PI_CODING_AGENT_DIR：指向 agent 目录，清理其 extensions/ 子目录', () => {
        write(path.join(srcDir, 'a.ts'), 'const a = 1;');
        const agentDir = makeTempDir('pi-clean-agent-');
        const extDir = path.join(agentDir, 'extensions');
        fs.mkdirSync(extDir, { recursive: true });
        const stale = write(path.join(extDir, 'a.ts'), 'stale');
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const r = cleanupLegacyGlobalExtensions({ projectRoot: path.dirname(srcDir) });
        expect(r.removed).toEqual(['a.ts']);
        expect(fs.existsSync(stale)).toBe(false);
        fs.rmSync(agentDir, { recursive: true, force: true });
    });

    test('真实项目源码清单 sanity：pi-extensions 下全部 .ts 可被清除', () => {
        // 不碰真实全局目录：targetDir 指向临时目录并预置全套同名遗留
        const realNames = fs.readdirSync(path.resolve(__dirname, '../../pi-extensions'))
            .filter(n => n.endsWith('.ts'));
        expect(realNames.length).toBeGreaterThanOrEqual(5);
        for (const name of realNames) {
            write(path.join(targetDir, name), 'stale copy');
        }
        const r = cleanupLegacyGlobalExtensions({ targetDir });
        expect(r.errors).toEqual([]);
        expect(r.removed.sort()).toEqual(realNames.sort());
        for (const name of realNames) {
            expect(fs.existsSync(path.join(targetDir, name))).toBe(false);
        }
    });
});

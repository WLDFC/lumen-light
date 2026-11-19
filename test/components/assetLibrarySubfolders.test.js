/**
 * ==========================================================================
 * AssetLibrary 子文件夹递归扫描测试（2026-11-09）
 * 覆盖：_scanDir 递归收集与 _assetDir 标记、MAX_DIR_DEPTH 层级上限、
 * 非媒体文件过滤、assetKey 分组键。vm 加载经典脚本，
 * CanvasVideoManager 桩化，实例用 Object.create(prototype) 绕开
 * 需要完整 DOM 的构造链。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { window: {} };
vm.createContext(context);
vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/components/AssetLibrary.js'), 'utf-8'),
    context, { filename: 'AssetLibrary.js' });
const AssetLibrary = context.window.AssetLibrary;

// CanvasVideoManager 视频判断桩（扩展名兜底路径）；
// AssetLibrary 里是裸标识符引用，须挂 context 全局（vm 里 window.X 不参与裸解析）
context.window.CanvasVideoManager = {
    isVideoFile: (f) => /\.(mp4|webm)$/i.test(f.name || '')
};
vm.runInContext('CanvasVideoManager = window.CanvasVideoManager;', context);

// 目录/文件句柄桩：entries() 异步生成器，形如 FileSystemDirectoryHandle
function dirHandle(entries) {
    return {
        kind: 'directory',
        entries: async function* () {
            for (const [name, entry] of Object.entries(entries)) yield [name, entry];
        }
    };
}
function fileHandle(name, mime) {
    return {
        kind: 'file',
        getFile: async () => ({ name, type: mime || 'image/png' })
    };
}

function makeLib() {
    return Object.create(AssetLibrary.prototype);
}

describe('_scanDir 递归扫描子文件夹', () => {
    test('根/一级/二级子文件夹内的媒体文件全部收集并带 _assetDir 标记', async () => {
        const root = dirHandle({
            'root.png': fileHandle('root.png'),
            'note.txt': fileHandle('note.txt', 'text/plain'),
            'sub': dirHandle({
                'a.png': fileHandle('a.png'),
                'deep': dirHandle({
                    'b.jpg': fileHandle('b.jpg', 'image/jpeg')
                })
            })
        });
        const out = [];
        await makeLib()._scanDir(root, 1, '', out);
        const keys = out.map(AssetLibrary.assetKey).sort();
        expect(keys).toEqual(['root.png', 'sub/a.png', 'sub/deep/b.jpg']);
        expect(out.find((f) => f.name === 'b.jpg')._assetDir).toBe('sub/deep');
        expect(out.find((f) => f.name === 'root.png')._assetDir).toBe('');
    });

    test('超出层级上限的目录不深入（根+两层=3 级）', async () => {
        const root = dirHandle({
            'l1': dirHandle({
                'l2': dirHandle({
                    'ok.png': fileHandle('ok.png'),
                    'l3': dirHandle({
                        'too-deep.png': fileHandle('too-deep.png')
                    })
                })
            })
        });
        const out = [];
        await makeLib()._scanDir(root, 1, '', out);
        expect(out.map((f) => f.name)).toEqual(['ok.png']);
    });

    test('非图片/视频文件不收，视频按扩展名兜底收取', async () => {
        const root = dirHandle({
            'clip.webm': fileHandle('clip.webm', ''),
            'doc.pdf': fileHandle('doc.pdf', 'application/pdf'),
            'pic.gif': fileHandle('pic.gif', '')
        });
        const out = [];
        await makeLib()._scanDir(root, 1, '', out);
        expect(out.map((f) => f.name).sort()).toEqual(['clip.webm', 'pic.gif']);
    });
});

describe('AssetLibrary.assetKey 分组键', () => {
    test('子文件夹文件带路径前缀，根文件就是文件名', () => {
        expect(AssetLibrary.assetKey({ name: 'x.png', _assetDir: 'a/b' })).toBe('a/b/x.png');
        expect(AssetLibrary.assetKey({ name: 'x.png', _assetDir: '' })).toBe('x.png');
        expect(AssetLibrary.assetKey({ name: 'x.png' })).toBe('x.png');
    });
});

describe('层级常量', () => {
    test('MAX_DIR_DEPTH = 3（根=第 1 层）', () => {
        expect(AssetLibrary.MAX_DIR_DEPTH).toBe(3);
    });
});

describe('折叠状态记忆', () => {
    // localStorage 极简桩（ _is/_setGroupFolded 只用 getItem/setItem）；
    // 挂 window 后再桥接到 context 全局（AssetLibrary 内是裸标识符引用）
    const storage = new Map();
    context.window.localStorage = {
        getItem: (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => storage.set(k, String(v))
    };
    vm.runInContext('localStorage = window.localStorage;', context);

    test('默认不折叠；写入后读取一致；取消折叠删除记忆', () => {
        const lib = makeLib();
        expect(lib._isGroupFolded('tagA', 'sub')).toBe(false);
        lib._setGroupFolded('tagA', 'sub', true);
        expect(lib._isGroupFolded('tagA', 'sub')).toBe(true);
        lib._setGroupFolded('tagA', 'sub', false);
        expect(lib._isGroupFolded('tagA', 'sub')).toBe(false);
    });

    test('同子路径不同标签互不影响；损坏存储表按全不折叠处理', () => {
        const lib = makeLib();
        lib._setGroupFolded('tagA', 'sub', true);
        expect(lib._isGroupFolded('tagB', 'sub')).toBe(false);
        expect(lib._isGroupFolded('tagA', 'sub/deep')).toBe(false);
        storage.set(AssetLibrary.FOLDED_STORAGE_KEY, '{broken');
        expect(lib._isGroupFolded('tagA', 'sub')).toBe(false);
        storage.delete(AssetLibrary.FOLDED_STORAGE_KEY);
    });
});

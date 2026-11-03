/**
 * 系统字体枚举路由测试（routes/systemFonts.js，ADR 067）。
 * parseFontNames 纯函数用真实注册表值名形态做夹具（2026-11-06 本机采样：
 * 251 条全英文名、& 复合名、样式词直拼族名、(TrueType) 绝对多数、另有
 * (120)/(All res) 非标准后缀）；路由侧注入 stub listFonts 测缓存与错误
 * 透传，不真 spawn PowerShell。
 */

const request = require('supertest');
const express = require('express');
const createSystemFontsRouter = require('../../routes/systemFonts');
const { parseFontNames } = require('../../routes/systemFonts');

describe('parseFontNames：注册表值名 → 字族清单', () => {
    test('& 复合名拆段 + 样式词剥离 + 去重（雅黑三值 → 一条中文别名）', () => {
        const out = parseFontNames([
            'Microsoft YaHei & Microsoft YaHei UI (TrueType)',
            'Microsoft YaHei Bold & Microsoft YaHei UI Bold (TrueType)',
            'Microsoft YaHei Light & Microsoft YaHei UI Light (TrueType)'
        ]);
        expect(out).toEqual([{ label: '微软雅黑', family: 'Microsoft YaHei' }]);
    });

    test('样式词逐词回退（Bold Italic/Semibold Italic），Display/Math 不误伤', () => {
        const out = parseFontNames([
            'Segoe UI Semibold Italic (TrueType)',
            'Segoe UI (TrueType)',
            'Segoe UI Variable (TrueType)',
            'Cambria & Cambria Math (TrueType)',
            'Cambria Bold Italic (TrueType)'
        ]);
        const fams = out.map((f) => f.family);
        expect(fams).toContain('Segoe UI');
        expect(fams).toContain('Segoe UI Variable');
        expect(fams).toContain('Cambria');
        expect(fams).toContain('Cambria Math');
        expect(fams.filter((f) => f === 'Segoe UI')).toHaveLength(1);
        expect(fams.filter((f) => f === 'Cambria')).toHaveLength(1);
        expect(fams).not.toContain('Segoe UI Semibold');
    });

    test('Calibri Light 剥 Light；SimSun-ExtB 连名不误伤；内置中文字体出中文 label', () => {
        const out = parseFontNames([
            'Calibri Light (TrueType)',
            'SimSun-ExtB (TrueType)',
            'SimSun & NSimSun (TrueType)',
            'SimHei (TrueType)',
            'KaiTi (TrueType)',
            'DengXian Bold (TrueType)'
        ]);
        const byFamily = Object.fromEntries(out.map((f) => [f.family, f.label]));
        expect(byFamily['Calibri']).toBe('Calibri');          // Light 已剥
        expect(byFamily['SimSun']).toBe('宋体');               // 别名片
        expect(byFamily['NSimSun']).toBe('新宋体');
        expect(byFamily['SimHei']).toBe('黑体');
        expect(byFamily['KaiTi']).toBe('楷体');
        expect(byFamily['DengXian']).toBe('等线');
        expect(byFamily['SimSun-ExtB']).toBe('SimSun-ExtB');  // 连字符族名原样
        expect(out.map((f) => f.family)).not.toContain('Calibri Light');
    });

    test('「X UI」伴生族丢弃、无同基名真族保留（Leelawadee UI）', () => {
        const out = parseFontNames([
            'Microsoft JhengHei & Microsoft JhengHei UI (TrueType)',
            'Leelawadee UI (TrueType)',
            'Segoe UI (TrueType)'
        ]);
        const fams = out.map((f) => f.family);
        expect(fams).toContain('Leelawadee UI');   // 无 Leelawadee 基名 → 保留
        expect(fams).not.toContain('Microsoft JhengHei UI');
        expect(fams).toContain('Microsoft JhengHei');
    });

    test('非标准后缀 (120)/(All res) 剥离；未知无后缀名原样保留', () => {
        const out = parseFontNames([
            'Marlett (All res)',
            'Some Font (120)',
            'Mystery Font'
        ]);
        const fams = out.map((f) => f.family);
        expect(fams).toEqual(expect.arrayContaining(['Marlett', 'Some Font', 'Mystery Font']));
    });

    test('去重大小写不敏感、zh collation 排序、空/脏输入安全', () => {
        const out = parseFontNames(['arial (TrueType)', 'Arial Bold (TrueType)', 'Zilla Slab (TrueType)']);
        expect(out.map((f) => f.family)).toEqual(['Arial', 'Zilla Slab']);
        expect(parseFontNames([])).toEqual([]);
        expect(parseFontNames(null)).toEqual([]);
        expect(parseFontNames(['', '  ', '(TrueType)'])).toEqual([]);
    });
});

describe('GET /api/system-fonts：进程缓存与错误透传（stub listFonts）', () => {
    function makeApp(listFonts) {
        const app = express();
        app.use('/api/system-fonts', createSystemFontsRouter({ listFonts }));
        return app;
    }

    test('返回 ok+fonts；缓存生效（二次请求不重调 listFonts）', async () => {
        let calls = 0;
        const app = makeApp(async () => {
            calls++;
            return [{ label: 'Arial', family: 'Arial' }];
        });
        const r1 = await request(app).get('/api/system-fonts');
        expect(r1.status).toBe(200);
        expect(r1.body).toEqual({ status: 'ok', fonts: [{ label: 'Arial', family: 'Arial' }] });
        await request(app).get('/api/system-fonts');
        expect(calls).toBe(1);   // 第二次命中进程缓存
    });

    test('listFonts 抛错 → 500 + status error（前端回落精选清单）', async () => {
        const app = makeApp(async () => { throw new Error('PowerShell 不可用'); });
        const r = await request(app).get('/api/system-fonts');
        expect(r.status).toBe(500);
        expect(r.body.status).toBe('error');
        expect(r.body.message).toContain('PowerShell');
    });
});

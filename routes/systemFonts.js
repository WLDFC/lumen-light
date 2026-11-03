/**
 * ==========================================================================
 * 系统字体枚举 API（/api/system-fonts）
 * ==========================================================================
 * 作用：后端读 Windows 字体注册表（HKLM + HKCU\...\CurrentVersion\Fonts，
 *       GDI 注册的字体清单——与 Photoshop 等桌面软件同一数据源），清理成
 *       字族清单供两编辑器（ImageStudio/漫画）字体菜单「加载系统全部字
 *       体」消费。取代浏览器 queryLocalFonts 路线（需授权/仅 Chromium/
 *       非安全上下文不可用——本机两编辑器实测双双失败，ADR 067）。
 * 数据口径：注册表值名 = `<字体全名> (<技术后缀>)`（本机实测：251 条、
 *       全英文名、(TrueType) 占绝大多数、& 复合名 15 条、样式词直接拼族
 *       名后、另有 (120)/(All res) 类非标准后缀）→ parseFontNames 纯函数
 *       清理：去技术后缀 → & 拆段 → 去尾部样式词 → 丢「X UI」伴生族 →
 *       去重排序；系统内置中文字体经别名片映射成中文显示名（注册表值名
 *       全英文，DirectWrite 的本地化名拿不到——label 中文/family 保持
 *       CSS 可用的英文名，ADR 067）。
 * 缓存：进程级一份（字体装/卸极少发生，重启后端刷新）。
 * 挂载：server.js `app.use('/api/system-fonts', createSystemFontsRouter())`。
 * ==========================================================================
 */

const express = require('express');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileP = promisify(execFile);

/** PowerShell 枚举脚本：UTF-8 控制台输出（reg.exe 走 GBK 会乱码，PS 显式
 *  设 UTF8 绕开）；读 HKLM+HKCU 两键值名（滤 PS* 元属性；键不存在/空键
 *  静默跳过），哈希表包装 ConvertTo-Json 防单元素被解包成裸字符串 */
const PS_SCRIPT = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;"
    + "$out=@();"
    + "'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',"
    + "'HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'"
    + "|ForEach-Object{$k=Get-ItemProperty $_ -ErrorAction SilentlyContinue;"
    + "if($k){$k.PSObject.Properties|Where-Object{$_.Name -notlike 'PS*'}|ForEach-Object{$out+=$_.Name}}};"
    + "ConvertTo-Json -Compress @{fonts=@($out)}";

/** 值名尾部技术后缀白名单（外加纯数字段与 (All res)——本机实测存在的
 *  非标准条目；只剥一处、剥完为空则整条丢弃） */
const TYPE_SUFFIX_RE = /\s*\((?:TrueType|OpenType|TrueTypeOutline|Raster Font|Vector Font|All res|\d+)\)\s*$/i;

/** 尾部样式词白名单（小写比对）——注册表把字重/斜体直接拼在族名后
 *  （SimSun-ExtB 的连字符段、Segoe UI Variable 的 Display、Cambria Math
 *  的 Math 都不在表内不误伤）。不剥 Regular——Windows 基本不注册该词，
 *  剥了反而伤「XX Regular」类真名 */
const STYLE_WORDS = new Set([
    'bold', 'italic', 'oblique', 'light', 'medium', 'black', 'thin', 'heavy',
    'semibold', 'semilight', 'extrabold', 'extralight', 'demibold', 'bolditalic'
]);

/** 系统内置中文字体显示名别名（键 = family 小写）。注册表值名全英文
 *  （本机实测无 CJK 值名），DirectWrite 的本地化名后端拿不到——菜单
 *  label 用中文与精选清单观感一致，family 保持 CSS 字体串原样 */
const ZH_ALIAS = {
    'simsun': '宋体',
    'nsimsun': '新宋体',
    'microsoft yahei': '微软雅黑',
    'simhei': '黑体',
    'kaiti': '楷体',
    'fangsong': '仿宋',
    'dengxian': '等线',
    'microsoft jhenghei': '微軟正黑體',
    'microsoft yahei ui': '微软雅黑 UI'
};

/** 剥尾部样式词（逐词回退，'Cambria Bold Italic' → 'Cambria'） */
function stripStyleWords(seg) {
    const words = seg.split(/\s+/);
    while (words.length > 1 && STYLE_WORDS.has(words[words.length - 1].toLowerCase())) {
        words.pop();
    }
    return words.join(' ').trim();
}

/**
 * 注册表值名清单 → 字族清单（纯函数，Jest 可单测）：
 * 去技术后缀 → & 拆段（.ttc 多家族）→ 去尾部样式词 → 小写去重 →
 * 「X UI」伴生族当存在同基名 X 时丢弃（Leelawadee UI 这类无同基名的
 * 真族保留）→ zh collation 排序。返回 [{label, family}]
 */
function parseFontNames(names) {
    const seen = new Map();   // family 小写 → {label, family}（大小写不敏感去重）
    for (const raw of names || []) {
        const name = String(raw || '').trim();
        if (!name) continue;
        const base = name.replace(TYPE_SUFFIX_RE, '').trim();
        if (!base) continue;
        for (let seg of base.split(' & ')) {
            seg = stripStyleWords(seg.replace(/\s+/g, ' ').trim());
            if (!seg) continue;
            const key = seg.toLowerCase();
            const prev = seen.get(key);
            if (prev) {
                // 大小写变体取规范形态（全小写疑为脏数据，混写大小写优先）
                if (prev.family === key && seg !== key) {
                    seen.set(key, { label: ZH_ALIAS[key] || seg, family: seg });
                }
                continue;
            }
            seen.set(key, { label: ZH_ALIAS[key] || seg, family: seg });
        }
    }
    const out = [...seen.values()];
    // 「X UI」伴生族丢弃：基名（去掉 UI 尾缀）在「非 UI 结尾」的族里真实
    // 存在才算伴生——Segoe UI 自身不带非 UI 的 Segoe 基名，不能自己吞自己
    const bases = new Set(out.filter((f) => !/\s+UI$/i.test(f.family))
        .map((f) => f.family.toLowerCase()));
    const filtered = out.filter((f) => {
        if (!/\s+UI$/i.test(f.family)) return true;
        return !bases.has(f.family.replace(/\s+UI$/i, '').trim().toLowerCase());
    });
    filtered.sort((a, b) => a.family.localeCompare(b.family, 'zh-Hans-CN'));
    return filtered;
}

/** 默认枚举：spawn PowerShell 读注册表 → parseFontNames 清理 */
async function defaultListFonts() {
    const { stdout } = await execFileP('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
        { timeout: 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        throw new Error('字体枚举输出解析失败（PowerShell 返回非 JSON）');
    }
    return parseFontNames(Array.isArray(parsed.fonts) ? parsed.fonts : []);
}

/**
 * 路由工厂（仿 coordinateDraft.js）：GET / 返回 { status:'ok', fonts }。
 * listFonts 可注入（测试桩）。进程级缓存——首次成功后不再重枚举，
 * 装/卸字体重启后端刷新
 */
function createSystemFontsRouter({ listFonts = defaultListFonts } = {}) {
    const router = express.Router();
    let cache = null;
    router.get('/', async (req, res) => {
        try {
            if (!cache) cache = await listFonts();
            res.json({ status: 'ok', fonts: cache });
        } catch (error) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    });
    return router;
}

module.exports = createSystemFontsRouter;
module.exports.parseFontNames = parseFontNames;

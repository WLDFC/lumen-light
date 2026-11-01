/**
 * ==========================================================================
 * PiAgentBlocks 单元测试
 * 覆盖 pi 回复块纯函数层：流式光标清理、时长人话化、参数内联、工具输出
 * 摘要（base64 折叠/截断）、工具名映射（四工具族专名 + mcp__ 全名保留）、
 * Markdown 转义与行内渲染（代码段保护）、流式复读去重纯决策。
 * 被测文件是浏览器端经典脚本，用 vm 上下文执行（同 CanvasDelivery 模式）。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: {} };
vm.createContext(context);

vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../../js/utils/PiAgentBlocks.js'), 'utf-8'),
    context, { filename: 'PiAgentBlocks.js' }
);

const B = context.window.PiAgentBlocks;

describe('PiAgentBlocks.stripCursor', () => {
    test('去掉尾部光标占位（含前置空白）', () => {
        expect(B.stripCursor('回答内容 ▍')).toBe('回答内容');
        expect(B.stripCursor('回答内容▍')).toBe('回答内容');
    });

    test('无光标文本原样返回；空值返回空串', () => {
        expect(B.stripCursor('普通文本')).toBe('普通文本');
        expect(B.stripCursor('')).toBe('');
        expect(B.stripCursor(null)).toBe('');
    });
});

describe('PiAgentBlocks.fmtDuration', () => {
    test('60 秒内显示秒', () => {
        expect(B.fmtDuration(500)).toBe('1 秒'); // 四舍五入
        expect(B.fmtDuration(59000)).toBe('59 秒');
    });

    test('超过 60 秒显示分秒', () => {
        expect(B.fmtDuration(61000)).toBe('1 分 1 秒');
        expect(B.fmtDuration(125000)).toBe('2 分 5 秒');
    });
});

describe('PiAgentBlocks.argsInline', () => {
    test('空参数返回空串不显示', () => {
        expect(B.argsInline(undefined)).toBe('');
        expect(B.argsInline(null)).toBe('');
        expect(B.argsInline('')).toBe('');
        expect(B.argsInline({})).toBe('');
    });

    test('字符串原样、对象紧凑 JSON', () => {
        expect(B.argsInline('ls -la')).toBe('ls -la');
        expect(B.argsInline({ file: 'a.js' })).toBe('{"file":"a.js"}');
    });
});

describe('PiAgentBlocks.summarizeToolOutput', () => {
    test('空输出给占位提示', () => {
        expect(B.summarizeToolOutput('')).toBe('（无输出）');
        expect(B.summarizeToolOutput('   ')).toBe('（无输出）');
        expect(B.summarizeToolOutput(null)).toBe('（无输出）');
    });

    test('对象序列化为 JSON 而非 [object Object]', () => {
        const out = B.summarizeToolOutput({ ok: true });
        expect(out).toContain('"ok": true');
        expect(out).not.toContain('[object Object]');
    });

    test('含长 base64 串时整体折叠', () => {
        const b64 = 'A'.repeat(B.BASE64_RUN);
        const out = B.summarizeToolOutput(`前缀信息 ${b64} 后缀`);
        expect(out).toContain('已折叠不展示');
        expect(out).not.toContain('前缀信息');
    });

    test('超长输出截断并注明总长', () => {
        // 用非 base64 字符（中文）避免提前命中 base64 折叠分支
        const out = B.summarizeToolOutput('中'.repeat(B.TOOL_OUTPUT_LIMIT + 100));
        expect(out.startsWith('中'.repeat(B.TOOL_OUTPUT_LIMIT))).toBe(true);
        expect(out).toContain(`共 ${B.TOOL_OUTPUT_LIMIT + 100} 字符`);
    });

    test('普通输出原样', () => {
        expect(B.summarizeToolOutput('正常输出')).toBe('正常输出');
    });
});

describe('PiAgentBlocks.toolMeta', () => {
    test('画布工具族给专名', () => {
        expect(B.toolMeta('canvas_drop_image').title).toBe('落图到画布');
        expect(B.toolMeta('canvas_run_comfy_x').title).toBe('执行 Comfy 工作流');
        expect(B.toolMeta('canvas_unknown_new').title).toBe('画布工具');
    });

    test('Comfy 工具族：收录的给中文、未收录的保后缀区分度', () => {
        expect(B.toolMeta('comfy_mcp_system_stats').title).toBe('Comfy 状态');
        expect(B.toolMeta('comfy_mcp_new_thing').title).toBe('Comfy · new_thing');
    });

    test('联网与技能工具族', () => {
        expect(B.toolMeta('web_search').title).toBe('联网搜索');
        expect(B.toolMeta('web_fetch').title).toBe('读取网页');
        expect(B.toolMeta('skill_load').title).toBe('加载技能');
    });

    test('pi 内置工具与大小写不敏感', () => {
        expect(B.toolMeta('bash').title).toBe('终端');
        expect(B.toolMeta('Bash').title).toBe('终端');
        expect(B.toolMeta('read').title).toBe('查阅');
        expect(B.toolMeta('edit').title).toBe('写入');
        expect(B.toolMeta('grep_search').title).toBe('搜索');
    });

    test('用户自挂 MCP 工具保留全名不翻译', () => {
        expect(B.toolMeta('mcp__myserver__do_thing').title).toBe('mcp__myserver__do_thing');
    });

    test('未知工具兜底原名，返回值带 svg 图标', () => {
        const m = B.toolMeta('mystery_tool');
        expect(m.title).toBe('mystery_tool');
        expect(m.icon).toContain('<svg');
    });
});

describe('PiAgentBlocks.mdEscape / mdInline', () => {
    test('转义覆盖五个 HTML 特殊字符（注入闸）', () => {
        expect(B.mdEscape('<img src=x onerror=alert(1)>'))
            .toBe('&lt;img src=x onerror=alert(1)&gt;');
        expect(B.mdEscape('a&b"c\'d')).toBe('a&amp;b&quot;c&#39;d');
    });

    test('行内粗体与行内代码', () => {
        expect(B.mdInline('**粗体** 文本')).toBe('<strong>粗体</strong> 文本');
        expect(B.mdInline('`code()` 尾部')).toBe('<code class="pi-md-code">code()</code> 尾部');
    });

    test('代码段内的星号不参与粗体解析', () => {
        expect(B.mdInline('`**不粗**`')).toBe('<code class="pi-md-code">**不粗**</code>');
    });
});

describe('PiAgentBlocks.dedupeBlocks（流式复读去重纯决策）', () => {
    const mk = (type, key) => ({ type, key });

    test('同类型同内容：保留首个、其后重复剔除', () => {
        const blocks = [mk('text', 'A'), mk('thinking', 'T'), mk('text', 'A')];
        const { kept, removed } = B.dedupeBlocks(blocks, 'text', (b) => b.key);
        expect(kept).toEqual([blocks[0], blocks[1]]);
        expect(removed).toEqual([blocks[2]]);
    });

    test('不同内容与不同类型不受影响', () => {
        const blocks = [mk('text', 'A'), mk('text', 'B'), mk('thinking', 'A')];
        const { kept, removed } = B.dedupeBlocks(blocks, 'text', (b) => b.key);
        expect(removed).toEqual([]);
        expect(kept).toHaveLength(3);
    });

    test('key 为空串的块不参与去重（空占位不误删）', () => {
        const blocks = [mk('text', ''), mk('text', '')];
        const { kept, removed } = B.dedupeBlocks(blocks, 'text', (b) => b.key);
        expect(removed).toEqual([]);
        expect(kept).toHaveLength(2);
    });

    test('重复多段全部剔除、只留首个（N 段相同总结场景）', () => {
        const blocks = [mk('text', 'S'), mk('text', 'S'), mk('text', 'S')];
        const { kept, removed } = B.dedupeBlocks(blocks, 'text', (b) => b.key);
        expect(kept).toEqual([blocks[0]]);
        expect(removed).toEqual([blocks[1], blocks[2]]);
    });
});

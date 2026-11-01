/**
 * ==========================================================================
 * PiAgentBlocks — pi 回复块的纯函数层（自 LlmPiAgent.js 拆出）
 * ==========================================================================
 * 作用：pi 回复块渲染中所有不碰 DOM 的决策逻辑收口于此：
 *   - 工具输出摘要（base64/二进制折叠、超长截断）；
 *   - 工具名 → 中文标题/图标映射（对齐 zcode 块观感，覆盖画布/联网/Comfy/
 *     技能/pi 内置四个工具族与 mcp__ 全名保留规则）；
 *   - 流式光标清理、时长人话化、参数内联展示；
 *   - 迷你 Markdown 的 HTML 转义与行内渲染（粗体/行内代码，代码段保护）；
 *   - 流式复读去重的纯决策（按类型+内容 key 保留首个、其后重复剔除）——
 *     pi 个别场景会把同一段思考/文本流式输出两次（ADR 016），DOM 移除
 *     由调用方（LlmPiAgent）执行，这里只算哪些块该留。
 * 纯函数零 DOM 依赖，Jest 经 vm 上下文单测（test/utils/piAgentBlocks.test.js）。
 * ==========================================================================
 */

/** 工具结果展示上限（字符）：超出截断，避免超长输出撑爆气泡 */
const PI_TOOL_OUTPUT_LIMIT = 2000;
/** 判定"base64/二进制"输出的连续 base64 字符阈值 */
const PI_BASE64_RUN = 300;

/** 思考块图标（cpu 线稿，与工具图标同风格） */
const PI_THINK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>';

const PiAgentBlocks = {

    /** 工具结果展示上限（字符） */
    TOOL_OUTPUT_LIMIT: PI_TOOL_OUTPUT_LIMIT,
    /** base64 连续字符阈值 */
    BASE64_RUN: PI_BASE64_RUN,
    /** 思考块图标 svg */
    THINK_ICON: PI_THINK_ICON,

    /** 去掉文本尾部的流式光标占位符 */
    stripCursor(s) {
        return String(s || '').replace(/\s*▍$/, '');
    },

    /** 毫秒 → 人话时长（60 秒内 "N 秒"，以上 "M 分 S 秒"） */
    fmtDuration(ms) {
        const s = Math.max(0, Math.round(ms / 1000));
        if (s < 60) return s + ' 秒';
        return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
    },

    /** 工具参数的头部单行内联展示（紧凑 JSON；空参数返回空串不显示） */
    argsInline(args) {
        if (args === undefined || args === null || args === '') return '';
        if (typeof args === 'object' && Object.keys(args).length === 0) return '';
        return typeof args === 'string' ? args : JSON.stringify(args);
    },

    /**
     * 工具结果摘要化：base64/二进制折叠、超长截断，避免大段乱码进界面
     * @param {*} text - 工具原始输出（字符串或对象，对象序列化为 JSON）
     * @returns {string} 适合折叠展示的摘要
     */
    summarizeToolOutput(text) {
        let s;
        if (typeof text === 'string') s = text;
        else if (text == null) s = '';
        else {
            // 工具返回对象时直接 String() 会得到 "[object Object]"，必须序列化
            try { s = JSON.stringify(text, null, 2); } catch { s = String(text); }
        }
        if (!s.trim()) return '（无输出）';
        if (new RegExp(`[A-Za-z0-9+/]{${PI_BASE64_RUN},}`).test(s)) {
            return `（含 base64/二进制输出，共 ${s.length} 字符，已折叠不展示）`;
        }
        if (s.length > PI_TOOL_OUTPUT_LIMIT) {
            return s.slice(0, PI_TOOL_OUTPUT_LIMIT) + `\n…（已截断，共 ${s.length} 字符）`;
        }
        return s;
    },

    /**
     * 按工具名给出展示元数据（中文标题 + 图标），对齐 zcode 的块观感：
     * 常见内置工具与扩展工具族显示中文标题，未知工具与用户自挂
     * MCP 工具（mcp__ 前缀）保留原名，避免看不出是哪个服务器
     * @param {string} name - 工具名
     * @returns {{title: string, icon: string}} 头部标题与 svg 标记
     */
    toolMeta(name) {
        const svg = (paths) => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
        const ICON = {
            terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
            read: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
            canvas: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
            search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
            edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
            star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
            globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
            film: '<rect x="2" y="2" width="20" height="20" rx="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/>',
            gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
            save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
            check: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
            wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'
        };
        const pick = (title, key) => ({ title, icon: svg(ICON[key]) });
        const n = String(name || '').toLowerCase();
        // ---- 画布工具族（lumen-canvas 扩展，按实际名单给专名）----
        if (/^canvas_get_state$/.test(n)) return pick('获取画布状态', 'canvas');
        if (/^canvas_get_image/.test(n)) return pick('取画布图片', 'canvas');
        if (/^canvas_get_prompts/.test(n)) return pick('获取提示词链', 'canvas');
        if (/^canvas_drop_image$/.test(n)) return pick('落图到画布', 'canvas');
        if (/^canvas_drop_video$/.test(n)) return pick('落视频到画布', 'film');
        if (/^canvas_run_comfy/.test(n)) return pick('执行 Comfy 工作流', 'gear');
        if (/^canvas_run_llm_image/.test(n)) return pick('AI 生图', 'star');
        if (/^canvas_run_video/.test(n)) return pick('AI 生视频', 'film');
        if (/^canvas_poll_task/.test(n)) return pick('查询生成任务', 'check');
        if (/^canvas_build/.test(n)) return pick('搭建节点工作流', 'gear');
        if (/^canvas_list_workflows/.test(n)) return pick('列出工作流', 'gear');
        if (/^canvas_search_assets/.test(n)) return pick('检索资产', 'search');
        if (/^canvas_clear_media/.test(n)) return pick('清空画布', 'canvas');
        if (/^canvas_delete_media/.test(n)) return pick('删除画布媒体', 'canvas');
        if (/^canvas_/.test(n)) return pick('画布工具', 'canvas');
        // ---- 联网工具族（lumen-web 扩展）----
        if (/^web_search/.test(n)) return pick('联网搜索', 'globe');
        if (/^web_image_search/.test(n)) return pick('网络搜图', 'globe');
        if (/^web_fetch/.test(n)) return pick('读取网页', 'globe');
        if (/^web_/.test(n)) return pick('联网工具', 'globe');
        // ---- Comfy 原生工具族（lumen-comfy 扩展 comfy_mcp_*，
        //      按实际名单给中文，未收录的显示 "Comfy · 后缀" 保住区分度）----
        if (/^comfy_mcp_/.test(n)) {
            const t = {
                comfy_mcp_system_stats: 'Comfy 状态',
                comfy_mcp_job: '查询 Comfy 任务',
                comfy_mcp_fetch_outputs: '取 Comfy 输出',
                comfy_mcp_run_workflow: '执行 Comfy 工作流',
                comfy_mcp_run_template: '运行 Comfy 模板',
                comfy_mcp_list_workflow_slots: '查看工作流槽位',
                comfy_mcp_set_workflow_slot: '写入工作流槽位',
                comfy_mcp_search_models: '检索模型',
                comfy_mcp_search_templates: '检索模板',
                comfy_mcp_fetch_template: '拉取模板',
                comfy_mcp_download_model: '下载模型',
                comfy_mcp_install_node: '安装节点',
                comfy_mcp_nodes: '查看节点清单',
                comfy_mcp_workflow_deps: '依赖分析',
                comfy_mcp_get_logs: 'Comfy 日志',
                comfy_mcp_free_memory: '释放显存',
                comfy_mcp_upload_file: '上传文件',
                comfy_mcp_download: '下载'
            }[n];
            return t ? pick(t, 'gear') : pick('Comfy · ' + n.replace(/^comfy_mcp_/, ''), 'gear');
        }
        // ---- 技能库（lumen-skills 扩展）----
        if (/^skill_list/.test(n)) return pick('查看技能列表', 'read');
        if (/^skill_load/.test(n)) return pick('加载技能', 'read');
        // ---- pi 内置工具 ----
        if (/^bash$|shell|terminal/.test(n)) return pick('终端', 'terminal');
        if (/^read$|^open/.test(n)) return pick('查阅', 'read');
        if (/^edit$|^write$|^apply_patch|^create/.test(n)) return pick('写入', 'edit');
        if (/grep|glob|find|search|query|list|^ls$/.test(n)) return pick('搜索', 'search');
        // ---- 用户自挂 MCP 工具：保留全名（含服务器名）不翻译 ----
        if (/^mcp__/.test(n)) return { title: name || 'MCP 工具', icon: svg(ICON.wrench) };
        return { title: name || '工具', icon: svg(ICON.wrench) };
    },

    /** HTML 转义（Markdown 渲染的第一道闸：所有原文先过这里） */
    mdEscape(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    /** 行内渲染：粗体 / 行内代码（先保护代码段再处理粗体，代码内的
     *  星号不参与粗体解析——`**这样**` 应显示为字面量） */
    mdInline(s) {
        const codes = [];
        // 行内代码先摘出来（内容原样保留，不再吃粗体解析）
        let out = s.replace(/`([^`]+)`/g, (_, code) => {
            codes.push(`<code class="pi-md-code">${code}</code>`);
            return `\u0000${codes.length - 1}\u0000`;
        });
        out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        // 占位符还原（顺序倒放不需要——占位符本身不含 ** ）
        return out.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
    },

    /**
     * 流式复读去重的纯决策：同类型块按 keyOf 归一化比较，保留首个、
     * 其后内容完全相同的重复剔除（以先出现的为准）。DOM 移除由调用方
     * 对 removed 执行（本函数不碰 DOM）。
     * @param {Array<Object>} blocks - 块列表
     * @param {'thinking'|'text'} type - 参与去重的块类型
     * @param {(b: Object) => string} keyOf - 取块的内容 key（空串不参与）
     * @returns {{kept: Array<Object>, removed: Array<Object>}}
     */
    dedupeBlocks(blocks, type, keyOf) {
        const seen = new Set();
        const kept = [];
        const removed = [];
        for (const b of blocks) {
            if (b.type === type) {
                const key = keyOf(b);
                if (key && seen.has(key)) { removed.push(b); continue; }
                if (key) seen.add(key);
            }
            kept.push(b);
        }
        return { kept, removed };
    }
};

// 暴露到全局作用域
window.PiAgentBlocks = PiAgentBlocks;

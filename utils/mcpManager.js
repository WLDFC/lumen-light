/**
 * ==========================================================================
 * LumenLight MCP 客户端管理器（MCPManager）
 * ==========================================================================
 * 作用：让画布成为 MCP 宿主——管理用户在 设置 → MCP 里登记的 MCP 服务器
 *       （一期仅 stdio 传输：spawn 本地命令），提供连接生命周期、工具发现
 *       与调用代理：
 *         - saveServers(servers)：写入 settings.json 的 mcp.servers 并差量
 *           应用（新增/启用的连接，移除/停用的断开）；
 *         - getAllTools()：全部已连接服务器的工具扁平清单（pi 桥接扩展
 *           lumen-mcp 注册结构化工具的数据源）；
 *         - callTool(serverId, tool, args)：工具调用代理（pi 桥接的
 *           execute 落点），返回 MCP content 数组。
 *       协议层使用官方 @modelcontextprotocol/sdk（Client + StdioClientTransport）。
 *
 * 说明：
 *   - 配置存于 settings.json 的 mcp.servers 区块，本类负责读写该区块
 *     （读改写整个文件，保留 api/runninghub 等其他设置）；
 *   - 单个服务器连接失败不阻塞其他服务器：错误记在该服务器状态上，
 *     设置界面可见、可手动重连；
 *   - 子进程随 client.close() 终止；后端退出时由 server.js 的 exit 钩子
 *     调 closeAll() 尽力清理，防孤儿进程。
 * ==========================================================================
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const cp = require('child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

/** 单次工具调用超时（毫秒）：云端/重工具调用可能较慢，放宽到 10 分钟 */
const CALL_TIMEOUT_MS = 10 * 60 * 1000;

/** 权限分级 → 数值（越高权力越大），用于服务器最低权限门禁 */
const LEVEL_RANK = { readonly: 0, standard: 1, full: 2 };

class MCPManager {
    /**
     * @param {Object} options
     * @param {string} options.dataDir - 数据目录（settings.json 所在）
     */
    constructor({ dataDir }) {
        this.dataDir = dataDir;
        this.settingsPath = path.join(dataDir, 'settings.json');
        /** id → { cfg, client, transport, tools, status, error } */
        this.servers = new Map();
        /** id → 连接 Promise（防并发重复连接） */
        this._starting = new Map();
    }

    // ==================== 配置读写 ====================

    /** 读 settings.json（文件不存在/损坏按空对象处理） */
    async _readSettings() {
        try {
            return JSON.parse(await fs.readFile(this.settingsPath, 'utf-8')) || {};
        } catch {
            return {};
        }
    }

    /** 读登记的服务器列表（settings.json 缺 mcp 区块时返回 []） */
    async readServers() {
        const settings = await this._readSettings();
        return Array.isArray(settings.mcp && settings.mcp.servers)
            ? settings.mcp.servers : [];
    }

    /**
     * 当前全局权限分级（读 data/pi/settings.json，由 PiAgentManager 维护，
     * 设置 → 通用 → 权限分级 写入）。文件缺失/非法时按 standard
     */
    _permissionLevel() {
        try {
            const raw = fsSync.readFileSync(path.join(this.dataDir, 'pi', 'settings.json'), 'utf-8');
            const level = JSON.parse(raw).permissionLevel;
            return LEVEL_RANK[level] !== undefined ? level : 'standard';
        } catch {
            return 'standard';
        }
    }

    /** 服务器标注的最低权限（一期旧配置缺省视为 standard） */
    static _minLevelOf(cfg) {
        return LEVEL_RANK[cfg.minLevel] !== undefined ? cfg.minLevel : 'standard';
    }

    /**
     * 保存服务器列表（写 settings.json 的 mcp.servers，保留其他设置）
     * 并差量应用到连接状态。支持两种传输：
     *   - stdio：本地命令（command/args/env）
     *   - http ：远程 Streamable HTTP（url/headers）
     * @param {Array<Object>} servers
     * @returns {Promise<Array>} 清洗归一后的列表
     */
    async saveServers(servers) {
        const clean = (Array.isArray(servers) ? servers : [])
            .map((s, i) => {
                const id = String(s.id || `mcp_${Date.now()}_${i}`);
                const name = String(s.name || '').trim();
                const enabled = s.enabled !== false;
                const minLevel = ['readonly', 'standard', 'full'].includes(s.minLevel) ? s.minLevel : 'standard';
                const disabledTools = Array.isArray(s.disabledTools) ? s.disabledTools.map(String) : [];
                if (s.transport === 'http') {
                    return {
                        id, name, transport: 'http',
                        url: String(s.url || '').trim(),
                        headers: s.headers && typeof s.headers === 'object'
                            ? Object.fromEntries(Object.entries(s.headers)
                                .filter(([k, v]) => typeof k === 'string' && typeof v === 'string'))
                            : {},
                        enabled, minLevel, disabledTools,
                        comfyRoot: String(s.comfyRoot || '').trim()
                    };
                }
                return {
                    id, name, transport: 'stdio',
                    command: String(s.command || '').trim(),
                    args: Array.isArray(s.args) ? s.args.map(String) : [],
                    env: s.env && typeof s.env === 'object'
                        ? Object.fromEntries(Object.entries(s.env)
                            .filter(([k, v]) => typeof k === 'string' && typeof v === 'string'))
                        : {},
                    enabled, minLevel, disabledTools,
                    comfyRoot: String(s.comfyRoot || '').trim()
                };
            });
            // 不再丢弃未填完的服务器（草稿）：原样持久化、连接阶段跳过。
            // 之前在这里过滤会导致"新建未填完的卡片"在任意一次保存后被静默清掉，
            // 界面与存档不一致（删除某张卡会触发全量保存，其余草稿跟着消失）
        // 旧配置快照（写盘前取）：用于判定哪些服务器的 comfyRoot 发生了变化
        const previous = new Map((await this.readServers()).map((s) => [s.id, s]));

        const settings = await this._readSettings();
        settings.mcp = { ...(settings.mcp || {}), servers: clean };
        await fs.writeFile(this.settingsPath, JSON.stringify(settings, null, 4), 'utf-8');
        await this.applyConfig(clean);

        // ComfyUI 根目录有变动的 stdio 服务器：自动重新认领（等价 comfy
        // set-default，外部命令），结果逐台返回给调用方展示
        const claims = [];
        for (const cfg of clean) {
            if (cfg.transport !== 'stdio' || !cfg.comfyRoot) continue;
            const before = previous.get(cfg.id);
            if (before && before.comfyRoot === cfg.comfyRoot) continue;   // 未变化
            const claimed = await this.comfySetDefault(cfg.id, cfg.comfyRoot);
            claims.push({ id: cfg.id, name: cfg.name, ok: claimed.ok, output: claimed.output });
        }
        return { servers: clean, claims };
    }

    // ==================== 连接生命周期 ====================

    /**
     * 差量应用配置：enabled 服务器保持连接（配置变化则重连），
     * 移除/停用的断开。幂等，可反复调用
     * @param {Array<Object>} [desiredList] - 目标配置（缺省从 settings.json 读）
     */
    async applyConfig(desiredList) {
        const desired = desiredList || await this.readServers();
        const desiredIds = new Set();
        const starts = [];

        for (const cfg of desired) {
            if (!cfg.enabled) continue;
            // 未填完的草稿（无名称或无启动配置）：只持久化不连接，
            // 避免对空命令 spawn 产生无意义的失败状态
            if (!cfg.name || !(cfg.transport === 'http' ? cfg.url : cfg.command)) continue;
            desiredIds.add(cfg.id);
            const running = this.servers.get(cfg.id);
            if (running && running.status === 'running' &&
                JSON.stringify(running.cfg) === JSON.stringify(cfg)) {
                continue;   // 已连接且配置未变
            }
            if (running) await this.disconnect(cfg.id);   // 配置变化：重连
            starts.push(this.connect(cfg).catch(() => false));
        }
        for (const id of [...this.servers.keys()]) {
            if (!desiredIds.has(id)) await this.disconnect(id);
        }
        await Promise.allSettled(starts);   // 等连接落定，调用方拿到确定性状态
    }

    /**
     * 连接单个服务器（幂等）：spawn 子进程 + initialize 握手 + 工具清单缓存。
     * 失败不抛出：错误记在该服务器状态上，返回 false
     * @param {Object} cfg - { id, name, command, args, env, enabled }
     * @returns {Promise<boolean>} 是否进入 running
     */
    async connect(cfg) {
        const id = cfg.id;
        const existing = this.servers.get(id);
        if (existing && existing.status === 'running') return true;
        const pending = this._starting.get(id);
        if (pending) return pending;

        const attempt = (async () => {
            const entry = { cfg, client: null, transport: null, tools: [], resources: [], prompts: [], status: 'starting', error: '' };
            this.servers.set(id, entry);
            try {
                const connectWith = async (transport) => {
                    const client = new Client({ name: 'LumenLight', version: '1.0.0' });
                    entry.client = client;
                    entry.transport = transport;
                    await client.connect(transport);
                    return client;
                };

                let client;
                if (cfg.transport === 'http') {
                    // 远程 Streamable HTTP；老服务器不支持时回退旧版 SSE 传输
                    const url = new URL(cfg.url);
                    const headers = cfg.headers && Object.keys(cfg.headers).length
                        ? { requestInit: { headers: cfg.headers } } : undefined;
                    try {
                        client = await connectWith(new StreamableHTTPClientTransport(url, headers));
                    } catch (httpErr) {
                        try { if (entry.transport) await entry.transport.close(); } catch { /* 尽力 */ }
                        entry.client = null; entry.transport = null;
                        console.warn(`[MCP] ${cfg.name} Streamable HTTP 连接失败，回退 SSE:`, httpErr && httpErr.message);
                        client = await connectWith(new SSEClientTransport(url, headers));
                    }
                } else {
                    client = await connectWith(new StdioClientTransport({
                        command: cfg.command,
                        args: cfg.args || [],
                        env: this._childEnv(cfg.env || {}, cfg.command)
                    }));
                }

                // 三类清单：工具必有；资源/提示词按服务器能力，不支持则安全降级为空
                entry.tools = (await client.listTools()).tools || [];
                entry.resources = ((await client.listResources().catch(() => ({ resources: [] }))).resources) || [];
                entry.prompts = ((await client.listPrompts().catch(() => ({ prompts: [] }))).prompts) || [];

                // stdio + comfy.exe 在场：读取 comfy-cli 当前认领的 workspace。
                //   - 配置里未登记（旧版本认领过）→ 自动补登；
                //   - comfy-cli 丢了认领（重装/升级）而配置里有 → 自动恢复
                if (cfg.transport !== 'http' && cfg.command) {
                    const comfyBin = path.join(path.dirname(cfg.command), 'comfy.exe');
                    if (fsSync.existsSync(comfyBin)) {
                        entry.claimedWorkspace = await this._queryClaimedWorkspace(comfyBin) || '';
                        if (!cfg.comfyRoot && entry.claimedWorkspace) {
                            await this._persistComfyRoot(cfg.id, entry.claimedWorkspace);
                            cfg.comfyRoot = entry.claimedWorkspace;
                        } else if (cfg.comfyRoot && !entry.claimedWorkspace) {
                            await this.comfySetDefault(cfg.id, cfg.comfyRoot);
                        }
                    }
                }

                entry.status = 'running';
                entry.error = '';
                return true;
            } catch (err) {
                entry.status = 'error';
                entry.error = err && err.message ? err.message : String(err);
                try { entry.transport ? entry.transport.close() : null; } catch { /* 尽力清理 */ }
                entry.client = null;
                entry.transport = null;
                return false;
            } finally {
                this._starting.delete(id);
            }
        })();
        this._starting.set(id, attempt);
        return attempt;
    }

    /**
     * 按配置 id 连接（设置界面手动重连用）
     * @param {string} id - 服务器 id
     * @returns {Promise<boolean>}
     */
    async connectById(id) {
        const cfg = (await this.readServers()).find((s) => s.id === id);
        if (!cfg) return false;
        return this.connect(cfg);
    }

    /** 断开并移除一个服务器连接 */
    async disconnect(id) {
        const entry = this.servers.get(id);
        if (!entry) return;
        this.servers.delete(id);
        try { if (entry.client) await entry.client.close(); } catch { /* 尽力 */ }
        try { if (entry.transport) entry.transport.close(); } catch { /* 尽力 */ }
    }

    /** 断开全部（后端退出时由 exit 钩子调用，防孤儿子进程） */
    closeAll() {
        for (const entry of this.servers.values()) {
            try { if (entry.client) entry.client.close(); } catch { /* 尽力 */ }
        }
        this.servers.clear();
    }

    /**
     * 子进程环境：继承后端进程环境（PATH/HOME 等，保证 npx/python 等命令
     * 可被找到），再叠加服务器专属 env（可覆盖同名变量）。
     * 特殊语法：值以 "+" 开头 = 前置追加到继承值之后（分隔符按 PATH 惯例
     * Windows 用 ";"、其他平台用 ":"）——典型场景：PATH=+venv\Scripts，
     * 让 MCP 服务器内部能 shell 到其虚拟环境里的命令
     */
    _childEnv(custom, command) {
        const base = {};
        for (const [k, v] of Object.entries(process.env)) {
            if (typeof v === 'string') base[k] = v;
        }
        const merged = { ...base };
        const sep = process.platform === 'win32' ? ';' : ':';
        // 启动命令所在目录自动前置到 PATH：MCP 服务器常需 shell 同目录的
        // 兄弟命令（如 comfy-mcp 调同 venv 的 comfy），用户免配环境变量
        if (command) {
            const cmdDir = path.dirname(command);
            merged.PATH = merged.PATH ? cmdDir + sep + merged.PATH : cmdDir;
        }
        for (const [k, v] of Object.entries(custom)) {
            if (typeof v !== 'string') continue;
            merged[k] = v.startsWith('+') && base[k]
                ? v.slice(1) + sep + base[k]
                : v;
        }
        return merged;
    }

    // ==================== 查询与调用 ====================

    /**
     * 总览：配置 + 连接状态 + 工具清单（设置界面数据源）
     * @returns {Promise<Array<{...cfg, status, error, tools}>>}
     */
    async getOverview() {
        const cfgs = await this.readServers();
        return cfgs.map((cfg) => {
            const entry = this.servers.get(cfg.id);
            const running = entry && entry.status === 'running';
            return {
                ...cfg,
                status: entry ? entry.status : (cfg.enabled ? 'stopped' : 'disabled'),
                error: entry ? entry.error : '',
                tools: running ? entry.tools : [],
                resources: running ? (entry.resources || []) : [],
                prompts: running ? (entry.prompts || []) : [],
                claimedWorkspace: entry ? (entry.claimedWorkspace || '') : '',
                // 同目录存在 comfy.exe → 视为 comfy-mcp 类服务器（仅 stdio 有意义），
                // 面板显示 "ComfyUI 根目录认领" 行
                hasComfyCli: cfg.transport !== 'http' && cfg.command &&
                    fsSync.existsSync(path.join(path.dirname(cfg.command), 'comfy.exe'))
            };
        });
    }

    /**
     * 全部已连接服务器的工具扁平清单（pi 桥接扩展注册用）。
     * 双重过滤：① 服务器标注的最低权限高于当前全局分级 → 整台服务器
     * 不暴露；② 服务器内被用户停用的工具（disabledTools）不暴露
     * @returns {Promise<Array<{serverId, serverName, name, description, inputSchema}>>}
     */
    async getAllTools() {
        const current = this._permissionLevel();
        const out = [];
        for (const [id, entry] of this.servers) {
            if (entry.status !== 'running') continue;
            const minLevel = MCPManager._minLevelOf(entry.cfg);
            if (LEVEL_RANK[minLevel] > LEVEL_RANK[current]) continue;
            for (const tool of entry.tools) {
                if ((entry.cfg.disabledTools || []).includes(tool.name)) continue;
                out.push({
                    serverId: id,
                    serverName: entry.cfg.name,
                    name: tool.name,
                    description: tool.description || '',
                    inputSchema: tool.inputSchema || { type: 'object', properties: {} }
                });
            }
        }
        return out;
    }

    /**
     * 工具调用代理（pi 桥接扩展的 execute 落点）
     * @param {string} serverId - 服务器 id
     * @param {string} tool - 工具名
     * @param {Object} args - 工具参数（MCP inputSchema 约定）
     * @returns {Promise<{ok, text, content, isError}>} text 为 content 中
     *   全部文本段拼接（LLM 友好），content 保留原始 MCP 内容数组
     */
    async callTool(serverId, tool, args) {
        const entry = this.servers.get(serverId);
        if (!entry || entry.status !== 'running') {
            return { ok: false, text: `MCP 服务器未连接：${serverId}`, content: [], isError: true };
        }
        // 权限门禁兜底：即使工具已暴露给 agent（清单拉取时权限更高），
        // 调用瞬间权限被调低也会被拦下
        const minLevel = MCPManager._minLevelOf(entry.cfg);
        const current = this._permissionLevel();
        if (LEVEL_RANK[minLevel] > LEVEL_RANK[current]) {
            return {
                ok: false,
                text: `权限不足：该 MCP 服务器的工具需要「${minLevel}」级权限（当前「${current}」），可在 设置 → 通用 → 权限分级 调整`,
                content: [],
                isError: true
            };
        }
        if ((entry.cfg.disabledTools || []).includes(tool)) {
            return { ok: false, text: `工具已被停用：${tool}（可在 设置 → MCP 中重新启用）`, content: [], isError: true };
        }
        try {
            const result = await entry.client.callTool(
                { name: tool, arguments: args || {} },
                undefined,
                { timeout: CALL_TIMEOUT_MS }
            );
            const content = Array.isArray(result.content) ? result.content : [];
            const text = content
                .filter((c) => c && c.type === 'text')
                .map((c) => c.text)
                .join('\n');
            return { ok: !result.isError, text, content, isError: !!result.isError };
        } catch (err) {
            // 连接失效（子进程崩溃等）：标记状态，设置界面可见并可重连
            entry.status = 'error';
            entry.error = err && err.message ? err.message : String(err);
            return { ok: false, text: `MCP 调用失败：${entry.error}`, content: [], isError: true };
        }
    }

    /** 确保配置中的 enabled 服务器均已连接（后端启动时调用，幂等） */
    async ensureStarted() {
        await this.applyConfig();
    }

    // ==================== comfy-mcp 专用 ====================

    /**
     * 认领 ComfyUI 根目录（等价于 comfy set-default <path>）：用该服务器
     * 同 venv 的 comfy.exe 执行，成功后 comfy-cli 记忆默认 workspace，
     * 本地类工具（server_info/validate/templates/run...）即指向该安装。
     * 附带校验：目录须存在且像 ComfyUI 根目录（main.py + 版本文件）；
     * 便携版外层目录（含 ComfyUI 子目录）自动下钻
     * @param {string} serverId - 服务器 id
     * @param {string} rootPath - 用户填写的 ComfyUI 根目录
     * @returns {Promise<{ok: boolean, output: string}>}
     */
    async comfySetDefault(serverId, rootPath) {
        const cfg = (await this.readServers()).find((s) => s.id === serverId);
        if (!cfg) return { ok: false, output: '未找到该服务器，请先保存设置' };
        if (cfg.transport === 'http' || !cfg.command) {
            return { ok: false, output: '该服务器不是本地命令型（stdio），无 comfy.exe 可用' };
        }
        const comfyBin = path.join(path.dirname(cfg.command), 'comfy.exe');
        if (!fsSync.existsSync(comfyBin)) {
            return { ok: false, output: '未在该服务器命令的同目录找到 comfy.exe（仅支持 comfy-mcp 类服务器）' };
        }

        let p = String(rootPath || '').trim().replace(/^"+|"+$/g, '');
        if (!p || !fsSync.existsSync(p)) {
            return { ok: false, output: `目录不存在：${p || '（空）'}` };
        }
        const has = (f) => fsSync.existsSync(path.join(p, f));
        if (!has('main.py') && fsSync.existsSync(path.join(p, 'ComfyUI', 'main.py'))) {
            p = path.join(p, 'ComfyUI');   // 便携版外层目录：自动下钻一层
        }
        if (!has('main.py') || !(has('comfyui_version.py') || has('folder_paths.py'))) {
            return { ok: false, output: '该目录不像 ComfyUI 根目录（未找到 main.py / comfyui_version.py）' };
        }

        const { err, stdout, stderr } = await new Promise((resolve) => {
            cp.execFile(comfyBin, ['set-default', p], { timeout: 60000, windowsHide: true },
                (e, so, se) => resolve({ err: e, stdout: String(so || ''), stderr: String(se || '') }));
        });
        const output = (stdout + '\n' + stderr).trim();
        if (err) return { ok: false, output: output || err.message };
        await this._persistComfyRoot(serverId, p);
        return { ok: true, output: output || `已认领：${p}` };
    }

    /**
     * 运行 venv 里的 comfy.exe 子命令，解析 envelope/1 输出。
     * 失败（进程错误/非 JSON/ok=false）返回 null，调用方自行降级
     */
    async _runComfyEnvelope(comfyBin, args) {
        try {
            const { err, stdout } = await new Promise((resolve) => {
                cp.execFile(comfyBin, args, { timeout: 60000, windowsHide: true },
                    (e, so, se) => resolve({ err: e, stdout: String(so || ''), stderr: String(se || '') }));
            });
            if (err) return null;
            const parsed = JSON.parse(stdout);
            return parsed && parsed.ok ? parsed : null;
        } catch {
            return null;
        }
    }

    /** 解析 comfy which 的 envelope 输出 → workspace_path（无则 null） */
    static _parseWhichWorkspace(envelope) {
        return (envelope && envelope.data && envelope.data.workspace_path) || null;
    }

    /** 查询 comfy-cli 当前认领的 workspace 路径（查询失败返回 ''） */
    async _queryClaimedWorkspace(comfyBin) {
        const envelope = await this._runComfyEnvelope(comfyBin, ['which']);
        return MCPManager._parseWhichWorkspace(envelope) || '';
    }

    /** 把认领路径持久化到服务器配置（认领动作与自动补登共用） */
    async _persistComfyRoot(serverId, rootPath) {
        const servers = await this.readServers();
        const cfgSaved = servers.find((s) => s.id === serverId);
        if (!cfgSaved) return;
        cfgSaved.comfyRoot = rootPath;
        const settings = await this._readSettings();
        settings.mcp = { ...(settings.mcp || {}), servers };
        await fs.writeFile(this.settingsPath, JSON.stringify(settings, null, 4), 'utf-8');
        const entry = this.servers.get(serverId);
        if (entry) entry.cfg = { ...entry.cfg, comfyRoot: rootPath };
    }

    /**
     * 弹出系统原生文件夹选择窗口（仅 Windows，资源管理器同款现代对话框）：
     * PowerShell 内联 C#（Add-Type 编译，冷编译数百毫秒）COM interop 调
     * IFileOpenDialog + FOS_PICKFOLDERS，带地址栏/最近位置/新建文件夹，
     * 观感远好于老式 FolderBrowserDialog 树形窗口。返回用户选择的绝对路径
     * （浏览器文件夹选择 API 出于安全不返回绝对路径，故由后端代为弹窗）。
     * 脚本引号/中文密集，走 -EncodedCommand（UTF-16LE Base64）免转义。
     * 用户取消时返回 { canceled: true }
     * @returns {Promise<{path?: string, canceled?: boolean}>}
     */
    pickFolder() {
        const csharp = `using System;
using System.Runtime.InteropServices;

public class ModernFolderPicker
{
    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialogRCW {}

    [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr hwndOwner);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
        void GetResults(out IntPtr ppenum);
        void GetSelectedItems(out IntPtr ppsai);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    public static string Pick(string title)
    {
        IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialogRCW();
        uint fos;
        dialog.GetOptions(out fos);
        dialog.SetOptions(fos | 0x20u | 0x40u);       // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
        if (!string.IsNullOrEmpty(title)) dialog.SetTitle(title);
        if (dialog.Show(IntPtr.Zero) != 0) return null;   // 非 S_OK = 用户取消
        IShellItem item;
        dialog.GetResult(out item);
        string path;
        item.GetDisplayName(0x80058000u, out path);       // SIGDN_FILESYSPATH
        return path;
    }
}`;
        const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$cs = @'
${csharp}
'@
Add-Type -TypeDefinition $cs
$p = [ModernFolderPicker]::Pick('选择 ComfyUI 根目录')
if ($p) { Write-Output $p }`;
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        return new Promise((resolve) => {
            cp.execFile('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded],
                { timeout: 600000, windowsHide: true },
                (err, stdout) => {
                    const p = String(stdout || '').trim();
                    if (err && !p) {
                        // 脚本异常（如 Add-Type 编译失败）与用户取消都无输出——按取消处理
                        return resolve({ canceled: true });
                    }
                    resolve(p ? { path: p } : { canceled: true });
                });
        });
    }

    // ==================== 资源与提示词（MCP resources/prompts） ====================

    /** 服务器级权限门禁（资源/提示词与工具同规则） */
    _serverAllowed(cfg) {
        return LEVEL_RANK[MCPManager._minLevelOf(cfg)] <= LEVEL_RANK[this._permissionLevel()];
    }

    /**
     * 聚合全部可用资源清单（按服务器分组；过权限门禁）
     * @returns {Promise<Array<{serverId, serverName, resources}>>}
     */
    async listAllResources() {
        const out = [];
        for (const [id, entry] of this.servers) {
            if (entry.status !== 'running' || !this._serverAllowed(entry.cfg)) continue;
            if ((entry.resources || []).length === 0) continue;
            out.push({ serverId: id, serverName: entry.cfg.name, resources: entry.resources });
        }
        return out;
    }

    /** 实时列出某服务器的资源清单（并刷新缓存） */
    async listServerResources(serverId) {
        const entry = this.servers.get(serverId);
        if (!entry || entry.status !== 'running') return { ok: false, output: '服务器未连接' };
        if (!this._serverAllowed(entry.cfg)) return { ok: false, output: '权限不足' };
        try {
            entry.resources = ((await entry.client.listResources().catch(() => ({ resources: [] }))).resources) || [];
            return { ok: true, resources: entry.resources };
        } catch (err) {
            return { ok: false, output: err.message };
        }
    }

    /**
     * 读取资源内容：text 段拼接为 text，原始 contents 一并返回
     * @param {string} serverId
     * @param {string} uri - MCP 资源 URI
     */
    async readResource(serverId, uri) {
        const entry = this.servers.get(serverId);
        if (!entry || entry.status !== 'running') {
            return { ok: false, text: 'MCP 服务器未连接', contents: [] };
        }
        if (!this._serverAllowed(entry.cfg)) {
            return { ok: false, text: '权限不足', contents: [] };
        }
        try {
            const result = await entry.client.readResource({ uri });
            const contents = Array.isArray(result.contents) ? result.contents : [];
            const text = contents
                .map((c) => typeof c.text === 'string'
                    ? c.text
                    : (c.blob ? `（二进制内容，mimeType=${c.mimeType || '未知'}，${c.blob.length} base64 字符）` : ''))
                .filter(Boolean).join('\n');
            return { ok: true, text, contents };
        } catch (err) {
            return { ok: false, text: `读取失败：${err && err.message}`, contents: [] };
        }
    }

    /**
     * 聚合全部提示词模板清单（按服务器分组；过权限门禁）
     * @returns {Promise<Array<{serverId, serverName, prompts}>>}
     */
    async listAllPrompts() {
        const out = [];
        for (const [id, entry] of this.servers) {
            if (entry.status !== 'running' || !this._serverAllowed(entry.cfg)) continue;
            if ((entry.prompts || []).length === 0) continue;
            out.push({ serverId: id, serverName: entry.cfg.name, prompts: entry.prompts });
        }
        return out;
    }

    /**
     * 获取（渲染）提示词模板：messages 拼为 "role: text" 文本，原始消息一并返回
     * @param {string} serverId
     * @param {string} name - 模板名
     * @param {Object} args - 模板参数
     */
    async getPrompt(serverId, name, args) {
        const entry = this.servers.get(serverId);
        if (!entry || entry.status !== 'running') {
            return { ok: false, text: 'MCP 服务器未连接', messages: [] };
        }
        if (!this._serverAllowed(entry.cfg)) {
            return { ok: false, text: '权限不足', messages: [] };
        }
        try {
            const result = await entry.client.getPrompt({ name, arguments: args || {} });
            const messages = (result.messages || []).map((m) => {
                const c = m.content || {};
                return `${m.role}: ${c.type === 'text' ? c.text : `（${c.type} 内容）`}`;
            });
            return { ok: true, text: messages.join('\n\n'), messages: result.messages || [] };
        } catch (err) {
            return { ok: false, text: `获取提示词失败：${err && err.message}`, messages: [] };
        }
    }

    /**
     * pi 桥接扩展用：具备资源/提示词能力的服务器清单（过权限门禁），
     * 扩展据此注册 list_resources / read_resource / get_prompt 元工具
     */
    async getCapabilityServers() {
        const current = this._permissionLevel();
        const resourceServers = [];
        const promptServers = [];
        for (const [id, entry] of this.servers) {
            if (entry.status !== 'running') continue;
            const minLevel = MCPManager._minLevelOf(entry.cfg);
            if (LEVEL_RANK[minLevel] > LEVEL_RANK[current]) continue;
            if ((entry.resources || []).length > 0) {
                resourceServers.push({ serverId: id, serverName: entry.cfg.name });
            }
            if ((entry.prompts || []).length > 0) {
                promptServers.push({
                    serverId: id,
                    serverName: entry.cfg.name,
                    prompts: entry.prompts.map((p) => ({ name: p.name, description: p.description || '' }))
                });
            }
        }
        return { resourceServers, promptServers };
    }

    /**
     * 重列某个运行中服务器的三类清单（工具/资源/提示词，缓存刷新）
     * @param {string} serverId
     * @returns {Promise<{ok, output}>}
     */
    async refresh(serverId) {
        const entry = this.servers.get(serverId);
        if (!entry || entry.status !== 'running') return { ok: false, output: '服务器未连接' };
        try {
            entry.tools = (await entry.client.listTools()).tools || [];
            entry.resources = ((await entry.client.listResources().catch(() => ({ resources: [] }))).resources) || [];
            entry.prompts = ((await entry.client.listPrompts().catch(() => ({ prompts: [] }))).prompts) || [];
            return {
                ok: true,
                output: `工具 ${entry.tools.length} · 资源 ${entry.resources.length} · 提示词 ${entry.prompts.length}`
            };
        } catch (err) {
            return { ok: false, output: err.message };
        }
    }
}

module.exports = MCPManager;

/**
 * ==========================================================================
 * pi 编码智能体 RPC 进程管理器（PiAgentManager）
 * ==========================================================================
 * 作用：以子进程方式运行 pi --mode rpc（JSONL over stdio），为 LumenLight
 *       提供 agent 能力：
 *   - prompt(message, images, archive, model) ：发消息（自动切模型/会话）
 *   - 事件流经回调转发（路由层广播到浏览器 WebSocket）
 *   - 每个画布存档绑定一个 pi 会话（session-map.json 持久化映射）
 *   - 模型走 LLM 面板：从 data/settings.json 生成 provider 注册配置，
 *     apiKey 经环境变量（LUMEN_KEY_*）注入，扩展内用 $LUMEN_KEY_* 引用
 *
 * 协议要点（docs/rpc.md）：
 *   - stdout 严格 JSONL，按 \n 切分（不能用 readline，会误切 U+2028/9）
 *   - 命令带 id，应答 {type:'response', id, success, data}
 *   - 其余行为事件（message_update/tool_execution_* 等）直接广播
 * ==========================================================================
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { syncPiExtensions } = require('./piExtensionSync');

/** spawn 后等待扩展加载/注册 provider 的时间（ms） */
const MODEL_SETTLE_MS = 2500;
/** 单条 pi 命令的超时（prompt 的应答是"接受"语义，正常很快）。
 *  不能太长：pi 假死期间每个挂起的 RPC 都会占住一条浏览器同源连接
 *  （浏览器同域仅 6 连接），超时过长会拖成整页请求互锁 */
const CMD_TIMEOUT_MS = 20 * 1000;
/** prompt 前探测 isStreaming 的超时（排队判定是尽力而为，超时保守按流式排队） */
const PROBE_TIMEOUT_MS = 5 * 1000;
/** 连续真实 RPC 超时达到此次数判定 pi 疑似卡死，广播 pi_unresponsive
 *  交前端人工决策（程序不再自动杀进程）；期间任何 stdout 活动清零计数 */
const RPC_FAIL_NOTIFY = 3;
/** 附图登记表的存档数上限（LRU 语义）：附图以 base64 常驻内存，
 *  多存档长会话下封顶防膨胀，最久未用的存档条目先淘汰 */
const ATT_ARCHIVE_MAX = 12;
/** 同上但针对探测（get_state 健康查询）：探测超时在 pi 忙时较常见，
 *  阈值必须高于真实命令；历史上探测与真实命令共用计数，忙轮中可能误判 */
const PROBE_FAIL_NOTIFY = 6;

/** 追加到 pi 系统提示词的语言指令。pi 内置系统提示词是英文（编码智能体
 *  定位），模型思考语言会跟随系统提示词，导致中文用户看到英文思考块。
 *  用 pi 官方 CLI 参数 --append-system-prompt 在 spawn 时注入，不覆盖
 *  内置工具指引；对 thinking 的约束力因模型而异，但这是最正规的注入点。
 *  注意：改此常量不会触发 pi 自动重启（指纹只含 provider 配置），
 *  需手动重启 pi（状态灯点击或重启后端）才生效 */
const PI_LANG_APPEND =
    '语言要求：无论用户消息使用何种语言、也无论会话历史中的思考块是什么语言，' +
    '你新产生的思考（thinking）与最终回复（最终面向用户的文本）一律使用简体中文；' +
    '代码、命令、文件名、工具参数除外。';

class PiAgentManager {
    constructor({ projectRoot, dataDir, clients }) {
        this.projectRoot = projectRoot;
        this.dataDir = dataDir;
        this.clients = clients;   // WebSocket 客户端映射（广播事件用）

        this.bundlePath = path.join(projectRoot, 'pi', 'node_modules',
            '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
        this.sessionsDir = path.join(dataDir, 'pi', 'sessions');
        this.mapFile = path.join(dataDir, 'pi', 'session-map.json');
        this.settingsFile = path.join(dataDir, 'pi', 'settings.json');

        this.proc = null;
        this.stdoutBuf = '';
        this.pending = new Map();   // id -> {resolve, reject, timer}
        this.seq = 0;
        this.currentModel = null;   // {provider, modelId}
        this.currentArchiveKey = null;
        this.sessionMap = this._readJson(this.mapFile, {});
        this.permissionLevel = this._readJson(this.settingsFile, {}).permissionLevel || 'standard';
        this.starting = null;
        this.rpcFailStreak = 0;   // 连续 RPC 超时计数（疑似卡死上报判定用）
        this.probeFailStreak = 0;  // 连续探测超时计数（阈值更高，与真实命令分开）
        this.lastEventAt = 0;      // 最近一次 pi 生命迹象时间（stdout 活动/spawn，状态灯 tooltip 用）
        this.lastAbortAt = 0;      // 最近一次用户点停止的时间（停止信号：扩展后台任务据此自我取消）
        this._unresponsiveNotified = false;  // 已广播疑似卡死，恢复时据此广播 pi_responsive 回绿
        this.logFile = path.join(dataDir, 'pi', 'agent.log');
        this._fp = null;          // spawn 时的 API 设置指纹（变化则重启）
        // 会话级附图登记：archiveKey -> 最近一条含附图消息的附图列表
        // （扩展工具按 attachment:N 引用，解析见 getAttachments）。
        // 附图引用不再"只活一条消息"：用户发图后追问参数（如"放大 2x"）
        // 是多轮常态，下一条消息不带图时引用必须仍然命中
        this.attachmentsByArchive = new Map();
    }

    // ==================== 配置读写 ====================

    _readJson(file, fallback) {
        try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
    }

    _writeJson(file, data) {
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, JSON.stringify(data, null, 2));
        } catch (err) {
            console.error('写入 pi 配置失败:', err);
        }
    }

    /** pi 生命周期日志（spawn/stderr/exit/kill）：追加到 data/pi/agent.log。
     *  pi 内部崩溃往往只留下一行退出码和 stderr 堆栈，原先只打在后端
     *  控制台、随终端关闭丢失，事后无法定罪（首传图轮腰斩即因此无证可查） */
    _logLine(msg) {
        try {
            if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > 1024 * 1024) {
                fs.writeFileSync(this.logFile, '');   // 简单封顶：超 1MB 清空重写
            }
            fs.appendFileSync(this.logFile, `${new Date().toLocaleString()} ${msg}\n`);
        } catch { /* 日志写失败不影响主流程 */ }
    }

    /** 权限分级：readonly（只读）/ standard（标准）/ full（完整） */
    getPermissionLevel() { return this.permissionLevel; }

    setPermissionLevel(level) {
        if (!['readonly', 'standard', 'full'].includes(level)) return;
        this.permissionLevel = level;
        // 读改写保留其他区块（面板技能库启停状态 disabledSkills 与本字段
        // 共存于此文件；旧版整体覆盖会把并存字段抹掉）
        const cur = this._readJson(this.settingsFile, {});
        this._writeJson(this.settingsFile, { ...cur, permissionLevel: level });
    }

    /**
     * 禁用工具清单（面板「工具与技能」勾选维护）：扩展在 pi 启动与每回合
     * 开始读取，经 setActiveTools 把禁用工具从模型可见工具集移除
     */
    getDisabledTools() {
        const list = this._readJson(this.settingsFile, {}).disabledTools;
        return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
    }

    setDisabledTools(list) {
        const cur = this._readJson(this.settingsFile, {});
        this._writeJson(this.settingsFile, {
            ...cur,
            disabledTools: (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string')
        });
        return this.getDisabledTools();
    }

    /**
     * 从 LumenLight 设置（data/settings.json 的 api.providers）生成
     * pi 扩展需要的 provider 注册配置。apiKey 不直接下发，
     * 而是以环境变量名（LUMEN_KEY_*）引用——spawn 时注入真实值
     */
    getProviderConfig() {
        const settings = this._readJson(path.join(this.dataDir, 'settings.json'), {});
        const api = settings.api || {};
        const providers = [];
        const envKeys = {};
        let i = 0;
        for (const [name, cfg] of Object.entries(api.providers || {})) {
            if (!cfg.endpoint || !cfg.apiKey) continue;
            const envKey = `LUMEN_KEY_${i}`;
            envKeys[envKey] = cfg.apiKey;
            providers.push({
                id: 'lumen-' + name,
                name: 'Lumen · ' + name,
                baseUrl: cfg.endpoint,
                apiKeyEnv: envKey,
                models: (cfg.models || [])
                    .filter((m) => {
                        // 空行 null 占位守卫：设置面板模型收集与行严格对位，
                        // 空行存 null（前端过滤容忍 null，此处必须同口径——
                        // 否则一个空行就让 provider 注册整体失败、pi 全哑）
                        if (!m) return false;
                        // 面板模型行开关关闭（enabled === false）的全局隐藏：
                        // 同样不注册给 pi（与前端下拉过滤口径一致）
                        if (m.enabled === false) return false;
                        const t = m.type || 'auto';
                        if (t === 'image' || t === 'video') return false;  // 图像/视频模型不进 pi
                        if (t === 'chat') return true;
                        // auto/未标记：按名称关键词识别（口径与前端
                        // LumenLight.looksLikeImageModel 一致），防止 gpt-image-* 等
                        // 生图模型因 type 标记缺失被误注册进 pi——注册后一旦被
                        // pi 下拉选中就是一次模型调用报错
                        return !/seedream|dall-e|dalle|midjourney|sdxl|flux|image/i.test(m.id);
                    })
                    // pi 的 registerProvider 要求模型带全 schema（input/cost/
                    // contextWindow/maxTokens 必填）：缺 input 数组时 pi 内部
                    // 调 model.input.includes(...) 直接崩（undefined.includes）。
                    // 设置里若自带这些字段则透传覆盖默认值。
                    // contextWindow 默认 307200（300K）：2026-10-28 由 128K 上调
                    // （用户拍板，主力模型均为大窗口）；对实际窗口更小的模型
                    // 代价是自动压缩不触发、靠 API 溢出兜底——已知窗口的模型
                    // 应在设置→API「编辑」弹窗里设准
                    .map((m) => ({
                        id: m.id,
                        name: m.displayName || m.id,
                        reasoning: m.reasoning === true,
                        api: 'openai-completions',
                        input: ['text', 'image'],
                        cost: m.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: m.contextWindow || 307200,
                        maxTokens: m.maxTokens || 8192
                    }))
            });
            i++;
        }
        return { providers, envKeys };
    }

    /** spawn 环境：在当前环境上叠加各 provider 的 key（LUMEN_KEY_*）。
     *  直接复用 getProviderConfig().envKeys，保证与下发给扩展的 apiKeyEnv
     *  索引完全一致（历史上两处各自计数、规则不同曾导致密钥错位鉴权失败） */
    _buildEnv() {
        const env = { ...process.env };
        try {
            Object.assign(env, this.getProviderConfig().envKeys);
        } catch { /* 设置读取失败时用当前环境 */ }
        return env;
    }

    /** API 设置指纹：provider 注册配置序列化。
     *  设置页改模型/密钥/端点后指纹变化 → pi 进程需重启重新注册 */
    _fingerprint() {
        try { return JSON.stringify(this.getProviderConfig()); } catch { return ''; }
    }

    // ==================== 进程生命周期 ====================

    /** 确保 pi RPC 进程已启动（幂等；崩溃后下次调用自动重启）。
     *  另：API 设置（模型/密钥/端点）变化时自动重启——provider 注册表与
     *  密钥环境变量只在 spawn 时生成，不重启则 set_model 切到"注册表里不存在"
     *  的模型会让 pi 内部报错（undefined.includes），之后所有 prompt 空回复 */
    ensureStarted() {
        if (this.proc && this.proc.exitCode === null) {
            if (this._fp === this._fingerprint()) return Promise.resolve();
            console.log('[pi] 检测到 API 设置变化，重启 pi 进程以重新注册 provider');
            this.stop();
            this.proc = null;
            this.currentModel = null;
            this.currentArchiveKey = null;
        }
        if (this.starting) return this.starting;

        this.starting = new Promise((resolve, reject) => {
            if (!fs.existsSync(this.bundlePath)) {
                this.starting = null;
                return reject(new Error('未找到 pi 程序包：' + this.bundlePath));
            }
            // mkdir/spawn 的同步异常必须接管：否则 starting 永远挂着已 reject
            // 的 promise，之后所有 ensureStarted() 直接拿到旧失败——pi 再也
            // 起不来，只能重启后端（"崩溃后必须重启后端"的根因之一）
            try {
                fs.mkdirSync(this.sessionsDir, { recursive: true });
                // 白名单工作区：pi 写临时脚本/产物的项目内出口之一
                // （另一处为 data/skills/，均可经 data/pi/guard.json 调整），
                // lumen-guard 扩展按权限分级放行白名单、拦截项目内其余写入
                fs.mkdirSync(path.join(this.projectRoot, 'data', 'pi', 'workspace'), { recursive: true });
                // 用当前 node 直接运行 pi 的 CLI bundle（免 cmd shell 转义问题）。
                // --append-system-prompt：追加中文语言指令（见 PI_LANG_APPEND），
                // 数组式传参自动处理空格，无 shell 转义问题。
                // -e lumen-guard.ts：加载写保护扩展，按权限分级（settings.json，
                // 与 MCP 工具门禁同源）硬拦截 pi 对项目代码的 edit/write/bash
                // 写入，拦截记录追加到 agent.log（详见 pi-extensions/lumen-guard.ts）。
                // 用 -e 显式加载而非 .pi/extensions/ 自动发现：CLI 扩展不依赖
                // 项目信任状态，RPC 模式下不会静默失效。
                const guardExt = path.join(this.projectRoot, 'pi-extensions', 'lumen-guard.ts');
                // 其余扩展（canvas/skills/mcp/web）走全局扩展目录自动发现：
                // 拉起前差量同步 pi-extensions/*.ts → ~/.pi/agent/extensions/
                // （内容一致跳过，毫秒级）。发行包用户首次开 agent 模式即自动
                // 安装扩展、更新包后重启后端自动升级，全程无手动步骤；
                // 同步失败只记日志不阻塞 spawn（pi 仍可启动，只是扩展缺失）
                try {
                    const sync = syncPiExtensions({ projectRoot: this.projectRoot });
                    if (sync.synced > 0 || sync.errors.length > 0) {
                        this._logLine('[extensions] 同步：安装 ' + sync.installed +
                            ' / 覆盖 ' + sync.updated + ' / 跳过 ' + sync.skipped +
                            (sync.errors.length ? '，失败：' + sync.errors.join('；') : ''));
                    }
                } catch (syncErr) {
                    this._logLine('[extensions] 同步异常: ' + syncErr.message);
                }
                const spawnArgs = [this.bundlePath, '--mode', 'rpc', '--session-dir', this.sessionsDir,
                     '--append-system-prompt', PI_LANG_APPEND];
                if (fs.existsSync(guardExt)) spawnArgs.push('-e', guardExt);
                const child = spawn(process.execPath, spawnArgs,
                    { cwd: this.projectRoot, env: this._buildEnv(), windowsHide: true });
                this.proc = child;
            } catch (err) {
                this.starting = null;
                this._logLine('[spawn] 启动失败: ' + err.message);
                return reject(err);
            }

            // 绑定基准 = 刚 spawn 的子进程（spawn 到此无 await 间隙，
            // this.proc 即它）。不用 try 块里的局部 child：其作用域到
            // catch 为止，块外引用是运行时 ReferenceError（node --check
            // 查不出未声明引用，曾致 pi 完全不可用）
            const proc = this.proc;
            proc.stdout.on('data', (chunk) => this._onStdout(chunk));
            this._logLine('[spawn] pi RPC 进程启动');
            proc.stderr.on('data', (chunk) => {
                const text = chunk.toString().trim();
                if (text) {
                    console.warn('[pi stderr]', text.slice(0, 300));
                    this._logLine('[stderr] ' + text.slice(0, 300));
                }
            });
            // stdin/进程错误必须显式接管：pi 退出瞬间的写入会触发 EPIPE，
            // 流 'error' 事件无监听者时会抛未捕获异常直接带走整个后端
            proc.stdin.on('error', (err) => {
                console.warn('[pi] stdin 错误（进程可能已退出）:', err.message);
                this._noteRpcFail();
            });
            proc.on('error', (err) => {
                console.error('[pi] 进程错误:', err.message);
            });
            proc.on('exit', (code, signal) => {
                // 历史教训：旧进程的 exit 事件可能在新进程 spawn 之后才被处理，
                // 若不核对身份，迟到退出会把刚拉起的新进程引用抹成 null——
                // 新 pi 被孤儿化持有会话文件，前端还收到假的"进程退出"广播
                const isCurrent = this.proc === proc;
                this._logLine(`[exit] 进程退出 code=${code} signal=${signal}` +
                    (isCurrent ? '' : '（旧进程迟到退出，忽略——当前进程不受影响）'));
                if (!isCurrent) return;
                console.log(`[pi] 进程退出（code=${code} signal=${signal}）`);
                this.proc = null;
                this.currentModel = null;
                this.currentArchiveKey = null;
                for (const [, p] of this.pending) {
                    clearTimeout(p.timer);
                    p.reject(new Error('pi 进程已退出'));
                }
                this.pending.clear();
                // 通知前端：pi 进程退出（流式中的气泡需要明示原因，
                // 否则表现为无声卡死）
                this._broadcast({
                    type: 'pi-event',
                    event: { type: 'pi_process_exit', code, signal }
                });
            });

            // 留出扩展加载与 provider 注册的时间
            this._fp = this._fingerprint();   // 记录本次 spawn 用的设置指纹
            // 进程拉起即广播并刷新生命迹象时间：前端状态灯（多标签页）同步亮绿
            this.lastEventAt = Date.now();
            this._broadcast({ type: 'pi-event', event: { type: 'pi_started' } });
            setTimeout(() => { this.starting = null; resolve(); }, MODEL_SETTLE_MS);
        });
        return this.starting;
    }

    /** stdout JSONL 解析（严格按 \n 切分） */
    _onStdout(chunk) {
        this.stdoutBuf += chunk.toString('utf-8');
        let idx;
        while ((idx = this.stdoutBuf.indexOf('\n')) !== -1) {
            const line = this.stdoutBuf.slice(0, idx).replace(/\r$/, '');
            this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
            if (!line.trim()) continue;
            let obj;
            try { obj = JSON.parse(line); } catch { continue; }
            this._dispatch(obj);
        }
    }

    _dispatch(obj) {
        // 任何 stdout 输出（事件或应答）都证明 pi 活着：卡死计数清零
        this.rpcFailStreak = 0;
        this.probeFailStreak = 0;
        this.lastEventAt = Date.now();
        // 此前已广播疑似卡死的，第一次恢复活动时广播回绿（状态灯黄→绿）
        if (this._unresponsiveNotified) {
            this._unresponsiveNotified = false;
            this._broadcast({ type: 'pi-event', event: { type: 'pi_responsive' } });
        }
        // 带 id 的应答 → 关联到挂起的调用
        if (obj.type === 'response' && obj.id && this.pending.has(obj.id)) {
            const p = this.pending.get(obj.id);
            clearTimeout(p.timer);
            this.pending.delete(obj.id);
            if (obj.success) p.resolve(obj.data !== undefined ? obj.data : obj);
            else p.reject(new Error(obj.error?.message || 'pi 命令执行失败'));
            return;
        }
        // 其余为事件流：广播给画布客户端（前端渲染流式气泡）
        this._broadcast({ type: 'pi-event', event: obj });
    }

    _broadcast(payload) {
        for (const client of this.clients.values()) {
            if (client.role === 'canvas' && client.ws.readyState === 1) {
                try { client.ws.send(JSON.stringify(payload)); } catch { /* 忽略单个失败 */ }
            }
        }
    }

    /** 发送一条 RPC 命令并等待同名 id 的应答。
     *  opts.probe=true 表示健康探测类命令：其超时只计探测计数，
     *  不参与真实命令的卡死上报计数（忙轮中超时不等于卡死） */
    send(cmd, timeoutMs = CMD_TIMEOUT_MS, opts = {}) {
        if (!this.proc || this.proc.exitCode !== null) {
            return Promise.reject(new Error('pi 进程未运行'));
        }
        const id = `r${++this.seq}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                if (opts.probe) this._noteProbeFail();
                else this._noteRpcFail();
                reject(new Error('pi 命令超时'));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.proc.stdin.write(JSON.stringify({ id, ...cmd }) + '\n');
            } catch (err) {
                // 写入失败（管道已断）：立即失败，不等超时
                clearTimeout(timer);
                this.pending.delete(id);
                this._noteRpcFail();
                reject(new Error('pi 命令写入失败: ' + err.message));
            }
        });
    }

    /**
     * RPC 失败计数：连续超时/写失败达到阈值时判定 pi 疑似卡死（事件循环被堵，
     * 不再处理 stdin 命令）。方案 A：程序不自动杀进程，只广播 pi_unresponsive
     * 由前端弹人工按钮（[重启 pi 进程]/[继续等待]）决策；
     * 期间任何 stdout 活动会在 _dispatch 里清零计数，仍挂死则再凑满阈值再上报
     */
    _noteRpcFail() {
        this.rpcFailStreak++;
        if (this.rpcFailStreak < RPC_FAIL_NOTIFY) return;
        this.rpcFailStreak = 0;
        this._notifyUnresponsive('rpc', RPC_FAIL_NOTIFY);
    }

    /** 探测（get_state 健康查询）失败计数：只在连续多次无应答且期间
     *  无任何 stdout 活动时才判定疑似卡死（有活动会在 _dispatch 里清零） */
    _noteProbeFail() {
        this.probeFailStreak++;
        if (this.probeFailStreak < PROBE_FAIL_NOTIFY) return;
        this.probeFailStreak = 0;
        this._notifyUnresponsive('probe', PROBE_FAIL_NOTIFY);
    }

    /** 疑似卡死上报：只检测不动手，重启与否由前端人工按钮决定 */
    _notifyUnresponsive(source, threshold) {
        const label = source === 'probe' ? '探测' : 'RPC';
        console.warn(`[pi] 连续 ${threshold} 次${label}无应答，疑似卡死（不自动重启，等待前端人工处理）`);
        this._logLine(`[unresponsive] 连续 ${threshold} 次 ${source} 无应答，疑似卡死，已上报前端`);
        this._unresponsiveNotified = true;   // 恢复活动时 _dispatch 会广播 pi_responsive
        this._broadcast({
            type: 'pi-event',
            event: { type: 'pi_unresponsive', source, count: threshold }
        });
    }

    /** 重启 pi 进程（前端状态灯黄/红点击、疑似卡死按钮共用）：
     *  kill 旧进程 → 等其退出（上限 3s，避免新旧 pi 同时持有会话文件）
     *  → 立即拉起新进程接续会话。exit 广播照常发出让前端收尾流式气泡 */
    async restart() {
        const wasAlive = this.proc && this.proc.exitCode === null;
        if (wasAlive) {
            console.warn('[pi] 重启请求：kill 当前进程');
            this._logLine('[kill] 重启请求（前端状态灯/卡死按钮）');
            try { this.proc.kill(); } catch { /* 已退出则忽略 */ }
        }
        this.rpcFailStreak = 0;
        this.probeFailStreak = 0;
        if (wasAlive) {
            const t0 = Date.now();
            while (this.proc && this.proc.exitCode === null && Date.now() - t0 < 3000) {
                await new Promise((r) => setTimeout(r, 100));
            }
        }
        await this.ensureStarted();
    }

    // ==================== 业务操作 ====================

    /** 确保模型为 LLM 面板选中的那个（provider 名映射为 lumen-<厂商>）。
     *  pi 启动后扩展注册 provider 存在延迟，set_model 失败时重试几次 */
    async ensureModel(providerName, modelId) {
        if (!providerName || !modelId) return;
        const piProvider = 'lumen-' + providerName;
        if (this.currentModel &&
            this.currentModel.provider === piProvider &&
            this.currentModel.modelId === modelId) return;
        await this.ensureStarted();

        let lastErr = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                await this.send({ type: 'set_model', provider: piProvider, modelId });
                this.currentModel = { provider: piProvider, modelId };
                console.log(`[pi] 模型切换: ${piProvider} / ${modelId}`);
                return;
            } catch (err) {
                lastErr = err;
                console.warn(`[pi] set_model 第 ${attempt} 次失败: ${err.message}`);
                await new Promise((r) => setTimeout(r, 1000));
            }
        }
        throw lastErr;
    }

    /**
     * 每个存档绑定一个会话：存档变化时切换或新建会话。
     * 映射持久化在 data/pi/session-map.json
     */
    async switchToArchive(archiveName) {
        await this.ensureStarted();
        const key = archiveName || '__unsaved__';
        if (this.currentArchiveKey === key) return;

        const mapped = this.sessionMap[key];
        if (mapped && fs.existsSync(mapped)) {
            await this.send({ type: 'switch_session', sessionPath: mapped });
            console.log(`[pi] 已切换到存档「${key}」的既有会话`);
        } else {
            await this.send({ type: 'new_session' });
            const st = await this.send({ type: 'get_state' });
            if (st && st.sessionFile) {
                this.sessionMap[key] = st.sessionFile;
                this._writeJson(this.mapFile, this.sessionMap);
            }
            console.log(`[pi] 已为存档「${key}」新建会话`);
        }
        this.currentArchiveKey = key;
        // 会话恢复可能改变 pi 当前模型：作废缓存，强制下次 ensureModel 重新 set_model
        this.currentModel = null;
    }

    /**
     * 重置存档绑定的 pi 会话（从头开新对话）。
     * 面板「清空对话」时调用：pi 的对话按存档持久化在会话文件里，
     * 只清界面会让旧上下文在下一句原样背进去（上下文持续膨胀，
     * 历史里的过期信息甚至会误导模型自我认知）。
     * 会话文件（即上下文本体）随清屏**全部**从磁盘删除：清屏语义为
     * "推倒重来"，sessions/ 不留任何旧记录（所有存档的 agent 上下文
     * 一并清除，各存档下次对话自动新建会话）。
     */
    async resetSession(archiveName) {
        const key = archiveName || '__unsaved__';
        if (!this.proc || this.proc.exitCode !== null) {
            // pi 未运行：清空映射与全部会话文件，下次 prompt 自动新建会话
            this.sessionMap = {};
            this._writeJson(this.mapFile, this.sessionMap);
            this.currentArchiveKey = null;
            this._wipeSessionsDir(null);
            this._clearAttachments();
            return;
        }
        await this.send({ type: 'new_session' });
        const st = await this.send({ type: 'get_state' });
        // 映射整体重建：其他存档的旧会话文件即将删除，保留条目只会变成
        // 悬空引用（switchToArchive 对不存在的文件本就会新建会话兜底）
        this.sessionMap = (st && st.sessionFile) ? { [key]: st.sessionFile } : {};
        this._writeJson(this.mapFile, this.sessionMap);
        this.currentArchiveKey = key;
        // 新会话可能重置 pi 当前模型：作废缓存，强制下次 ensureModel 重新 set_model
        this.currentModel = null;
        // 删除旧会话文件（保留刚建的新会话——pi 可能尚未落盘，按路径保留）
        this._wipeSessionsDir(st && st.sessionFile ? st.sessionFile : null);
        // 会话推倒重来，附图引用一并作废（旧会话上下文已删，引用旧图
        // 只会让模型编辑一张它"不记得"的图）
        this._clearAttachments();
    }

    /** 清空全部附图登记（清屏/重置会话用：清屏语义为推倒重来，所有存档） */
    _clearAttachments() {
        this.attachmentsByArchive.clear();
    }

    /**
     * 清空 sessions/ 目录下的全部会话文件（keepPath 除外）。
     * 只删文件不碰目录（fail-safe：会话目录里预期只有 JSONL 文件）；
     * 单个文件删除失败只记日志，不阻塞其余清理。
     */
    _wipeSessionsDir(keepPath) {
        try {
            const keep = keepPath ? path.resolve(keepPath).toLowerCase() : null;
            let removed = 0;
            for (const name of fs.readdirSync(this.sessionsDir)) {
                const full = path.join(this.sessionsDir, name);
                try {
                    if (keep && path.resolve(full).toLowerCase() === keep) continue;
                    if (!fs.statSync(full).isFile()) continue;
                    fs.unlinkSync(full);
                    removed++;
                } catch { /* 单个文件失败不阻塞其余清理 */ }
            }
            if (removed > 0) this._logLine(`[session] 清屏：已删除 ${removed} 个会话文件`);
        } catch (err) {
            this._logLine('[session] 清理会话目录失败: ' + err.message);
        }
    }

    /**
     * 发送用户消息（自动完成：进程启动 → 模型切换 → 会话切换 → prompt）。
     * prompt 的应答只是"已接受"，后续流式内容经事件广播
     * @param {Object} opts
     * @param {string} [opts.systemPrompt] - chat 场景系统提示词：pi RPC 的 prompt
     *        命令无 system 参数，在会话首条消息（messageCount 为 0）时拼入消息
     *        头部；后续消息不重复注入，避免长会话上下文膨胀。
     *        「清空对话」重置会话后首条会重新注入
     */
    async prompt({ message, images, archive, provider, modelId, systemPrompt }) {
        await this.ensureStarted();
        // 先切会话再设模型：switch_session 会让 pi 从会话文件恢复
        // "上次用的模型"（可能已从设置删除），若先设模型会被顶掉，
        // 导致 pi 拿着注册表里不存在的模型调用而内部报错
        await this.switchToArchive(archive);
        await this.ensureModel(provider, modelId);

        // pi 仍在执行上一任务时自动排队（followUp），不再让第二条消息报错。
        // 排队的消息会在上一轮 agent_end 后自动送达。
        // 探测用短超时：排队判定是优化而非正确性依赖，pi 忙时探测本身
        // 也可能排队，不能让它拖住本次请求
        let queued = false;
        try {
            const st = await this.send({ type: 'get_state' }, PROBE_TIMEOUT_MS, { probe: true });
            queued = st?.isStreaming === true;
            // 会话首条消息（messageCount 为 0）注入指令块：
            // 1. 语言要求放最前（消息位置的指令对思考语言影响最强；
            //    DeepSeek 系模型对 system prompt 末尾的语言指令不敏感）
            // 2. 用户 chat 系统提示词跟在语言要求之后
            // 利用排队探测顺带拿到的 messageCount，零额外 RPC；探测失败（st 为空）
            // 时保守不注入，宁可丢提示词也不给忙会话再插一条
            if (!queued && st && (st.messageCount || 0) === 0) {
                const langLine = PI_LANG_APPEND;
                const userSys = systemPrompt && systemPrompt.trim() ? `\n\n${systemPrompt.trim()}` : '';
                const sep = message ? '\n\n---\n\n' : '';
                message = `[系统指令（对本会话全程有效）]\n${langLine}${userSys}${sep}${message}`;
            }
        } catch (err) {
            // 探测超时 = pi 忙到连健康查询都无暇应答：保守按流式处理走
            // followUp 排队，避免裸 prompt 被 pi 拒成回合报错；
            // 其余错误（进程未运行等）仍按非流式
            queued = err.message === 'pi 命令超时';
        }

        // 附图登记（扩展工具按 attachment:N 引用）：附图只存在于消息级
        // 上下文、不在画布上，没有引用时模型只能靠猜"画布上哪张是附图"
        // （实测猜错过、编辑了无关的图）。
        // 登记粒度是"最近一条含附图的消息"且按存档隔离：本条不带图时
        // 不覆盖旧值——发图→追问参数的下一轮，attachment:N 仍解析到
        // 上次的图（回退语义见 getAttachments）
        const { archiveKey, hasNewImages } = this._registerPromptAttachments(archive, images);
        const lastAtts = this.attachmentsByArchive.get(archiveKey) || [];

        // 消息尾部显式声明附图引用，杜绝模型自行猜测映射
        let finalMessage = message;
        if (hasNewImages) {
            const n = images.length;
            finalMessage += `\n\n[系统注记：本消息含 ${n} 张附图，按顺序在工具 refImages 中引用为 attachment:1…attachment:${n}；基于附图的编辑必须使用这些引用，不要按画布图片名猜测]`;
        } else if (lastAtts.length) {
            const n = lastAtts.length;
            finalMessage += `\n\n[系统注记：本消息无新附图；此前随消息发送的附图仍然有效，可继续用 attachment:1…attachment:${n} 引用最近一次发送的附图]`;
        }

        const cmd = {
            type: 'prompt',
            message: finalMessage,
            images: images && images.length ? images : undefined
        };
        if (queued) cmd.streamingBehavior = 'followUp';
        await this.send(cmd);
        return { accepted: true, queued };
    }

    /** 附图引用列表（扩展按 attachment:N 取图）：返回当前存档最近一条
     *  含附图消息的附图——本条消息带图时即本条的（prompt 已覆盖登记），
     *  不带图时回退到上一次的，"发图→追问参数"的第二轮引用不再落空。
     *  按 currentArchiveKey 隔离，不跨存档串图 */
    getAttachments() {
        const key = this.currentArchiveKey || '__unsaved__';
        const list = this.attachmentsByArchive.get(key) || [];
        return list.map((item, i) => {
            // 前端发来的是 pi 图片对象 { type:'image', data, mimeType }（见 LlmPiAgent.js），
            // 旧实现当字符串处理会把对象原样透传，扩展再传给 /api/llm/generate-image
            // 时报“参考图格式错误（仅支持 base64 data URL）”。这里统一归一成 data URL。
            let dataUrl = item;
            if (item && typeof item === 'object' && typeof item.data === 'string') {
                dataUrl = `data:${item.mimeType || 'image/png'};base64,${item.data}`;
            }
            const m = /^data:([^;,]+)[;,]/.exec(typeof dataUrl === 'string' ? dataUrl : '');
            return { ref: `attachment:${i + 1}`, mediaType: m ? m[1] : 'image/png', dataUrl };
        });
    }

    /** prompt 附图登记：本条带图 → 覆盖该存档登记（重插 Map 尾部 = 最近
     *  使用，总量按 ATT_ARCHIVE_MAX 封顶、最久未用的存档先淘汰）；
     *  不带图 → 保留旧值供 getAttachments 回退。返回注记构造所需信息 */
    _registerPromptAttachments(archive, images) {
        const archiveKey = archive || '__unsaved__';
        const hasNewImages = Array.isArray(images) && images.length > 0;
        if (hasNewImages) {
            this.attachmentsByArchive.delete(archiveKey);
            this.attachmentsByArchive.set(archiveKey, images.slice());
            while (this.attachmentsByArchive.size > ATT_ARCHIVE_MAX) {
                const oldest = this.attachmentsByArchive.keys().next().value;
                this.attachmentsByArchive.delete(oldest);
            }
        }
        return { archiveKey, hasNewImages };
    }

    /** 中止当前推理（用户点停止按钮）：完整语义为「清队列 + 掐 bash + 中止」。
     *  官方文档明确 abort **不会**清排队消息、且残留队列会在中止后继续投递
     *  （"abort continues queued messages when they remain in the session"，
     *  推荐的 Esc 实现是先 clear_queue 再 abort）——不清队列就是此前
     *  "点了停止循环却复活"的主因。返回各步执行结果供前端提示 */
    async abort() {
        const out = { clearQueue: false, abortBash: false, abortSent: false };
        if (!this.proc || this.proc.exitCode !== null) return out;
        // 停止信号时间戳：后台生图/视频任务的取消检查器轮询 /api/pi/stop-signal，
        // 发现信号晚于自己提交时间即中止（点一次停止，排队消息与后台任务全清）
        this.lastAbortAt = Date.now();
        // 清队列与掐 bash 并行等（各 5s 上限）：pi 忙时也应答很快，僵死时
        // 两个超时并行最多拖 5s；失败不阻塞 abort 写入
        await Promise.allSettled([
            this.send({ type: 'clear_queue' }, 5000).then(() => { out.clearQueue = true; }),
            this.send({ type: 'abort_bash' }, 5000).then(() => { out.abortBash = true; })
        ]).catch(() => { });
        // abort 的应答要等会话空闲才回来（rpc.md："wait for the session to
        // become idle before responding"）——工具挂住时可能永不回来。
        // 这里只写入不等应答：停止的完成信号由事件流 agent_end 承担，
        // HTTP 立即返回保证按钮即时反馈；真僵死由 pi_unresponsive 上报兜底
        try {
            const id = `r${++this.seq}`;
            this.proc.stdin.write(JSON.stringify({ id, type: 'abort' }) + '\n');
            out.abortSent = true;
        } catch { /* 管道已断，进程退出事件会跟进 */ }
        return out;
    }

    /** 当前 pi 状态（未运行时返回 running:false）。
     *  alive/pid/lastEventAt/failStreak 供前端状态灯初始化与 tooltip：
     *  WebSocket 广播只覆盖在线期间的事件，F5 后灯的初始态靠这里补 */
    async getState() {
        const alive = !!(this.proc && this.proc.exitCode === null);
        if (!alive) {
            return {
                running: false,
                alive: false,
                pid: null,
                lastEventAt: this.lastEventAt,
                failStreak: Math.max(this.rpcFailStreak, this.probeFailStreak),
                archive: this.currentArchiveKey
            };
        }
        const st = await this.send({ type: 'get_state' }, CMD_TIMEOUT_MS, { probe: true });
        return {
            running: true,
            alive: true,
            pid: this.proc.pid,
            lastEventAt: this.lastEventAt,
            failStreak: Math.max(this.rpcFailStreak, this.probeFailStreak),
            archive: this.currentArchiveKey,
            model: st?.model || null,
            isStreaming: !!st?.isStreaming,
            sessionFile: st?.sessionFile || null,
            messageCount: st?.messageCount || 0
        };
    }

    stop() {
        if (this.proc && this.proc.exitCode === null) this.proc.kill();
    }
}

module.exports = PiAgentManager;

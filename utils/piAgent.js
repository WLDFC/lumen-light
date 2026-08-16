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

/** spawn 后等待扩展加载/注册 provider 的时间（ms） */
const MODEL_SETTLE_MS = 2500;
/** 单条 pi 命令的超时（prompt 的应答是"接受"语义，正常很快） */
const CMD_TIMEOUT_MS = 120 * 1000;

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

    /** 权限分级：readonly（只读）/ standard（标准）/ full（完整） */
    getPermissionLevel() { return this.permissionLevel; }

    setPermissionLevel(level) {
        if (!['readonly', 'standard', 'full'].includes(level)) return;
        this.permissionLevel = level;
        this._writeJson(this.settingsFile, { permissionLevel: level });
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
                    .filter((m) => (m.type || 'auto') !== 'image')  // 图像模型不进 pi
                    .map((m) => ({ id: m.id, name: m.displayName || m.id, reasoning: false }))
            });
            i++;
        }
        return { providers, envKeys };
    }

    /** spawn 环境：在当前环境上叠加各 provider 的 key（LUMEN_KEY_*） */
    _buildEnv() {
        const env = { ...process.env };
        try {
            const settings = this._readJson(path.join(this.dataDir, 'settings.json'), {});
            const api = settings.api || {};
            let i = 0;
            for (const [, cfg] of Object.entries(api.providers || {})) {
                if (cfg.endpoint && cfg.apiKey) env[`LUMEN_KEY_${i}`] = cfg.apiKey;
                i++;
            }
        } catch { /* 设置读取失败时用当前环境 */ }
        return env;
    }

    // ==================== 进程生命周期 ====================

    /** 确保 pi RPC 进程已启动（幂等；崩溃后下次调用自动重启） */
    ensureStarted() {
        if (this.proc && this.proc.exitCode === null) return Promise.resolve();
        if (this.starting) return this.starting;

        this.starting = new Promise((resolve, reject) => {
            if (!fs.existsSync(this.bundlePath)) {
                this.starting = null;
                return reject(new Error('未找到 pi 程序包：' + this.bundlePath));
            }
            fs.mkdirSync(this.sessionsDir, { recursive: true });

            // 用当前 node 直接运行 pi 的 CLI bundle（免 cmd shell 转义问题）
            this.proc = spawn(process.execPath,
                [this.bundlePath, '--mode', 'rpc', '--session-dir', this.sessionsDir],
                { cwd: this.projectRoot, env: this._buildEnv(), windowsHide: true });

            this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
            this.proc.stderr.on('data', (chunk) => {
                const text = chunk.toString().trim();
                if (text) console.warn('[pi stderr]', text.slice(0, 300));
            });
            this.proc.on('exit', (code) => {
                console.log(`[pi] 进程退出（code=${code}）`);
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
                    event: { type: 'pi_process_exit', code }
                });
            });

            // 留出扩展加载与 provider 注册的时间
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

    /** 发送一条 RPC 命令并等待同名 id 的应答 */
    send(cmd, timeoutMs = CMD_TIMEOUT_MS) {
        if (!this.proc || this.proc.exitCode !== null) {
            return Promise.reject(new Error('pi 进程未运行'));
        }
        const id = `r${++this.seq}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('pi 命令超时'));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.proc.stdin.write(JSON.stringify({ id, ...cmd }) + '\n');
        });
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
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await this.send({ type: 'set_model', provider: piProvider, modelId });
                this.currentModel = { provider: piProvider, modelId };
                console.log(`[pi] 模型切换: ${piProvider} / ${modelId}`);
                return;
            } catch (err) {
                lastErr = err;
                console.warn(`[pi] set_model 第 ${attempt} 次失败: ${err.message}`);
                await new Promise((r) => setTimeout(r, 1500));
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
    }

    /**
     * 发送用户消息（自动完成：进程启动 → 模型切换 → 会话切换 → prompt）。
     * prompt 的应答只是"已接受"，后续流式内容经事件广播
     */
    async prompt({ message, images, archive, provider, modelId }) {
        await this.ensureStarted();
        await this.ensureModel(provider, modelId);
        await this.switchToArchive(archive);

        // pi 仍在执行上一任务时自动排队（followUp），不再让第二条消息报错。
        // 排队的消息会在上一轮 agent_end 后自动送达
        let queued = false;
        try {
            const st = await this.send({ type: 'get_state' });
            queued = st?.isStreaming === true;
        } catch { /* 查询失败按非流式处理 */ }

        const cmd = {
            type: 'prompt',
            message,
            images: images && images.length ? images : undefined
        };
        if (queued) cmd.streamingBehavior = 'followUp';
        await this.send(cmd);
        return { accepted: true, queued };
    }

    /** 中止当前流式推理 */
    async abort() {
        if (!this.proc || this.proc.exitCode !== null) return;
        await this.send({ type: 'abort' });
    }

    /** 当前 pi 状态（未运行时返回 running:false） */
    async getState() {
        if (!this.proc || this.proc.exitCode !== null) {
            return { running: false, archive: this.currentArchiveKey };
        }
        const st = await this.send({ type: 'get_state' });
        return {
            running: true,
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

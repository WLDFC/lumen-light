/**
 * ==========================================================================
 * LumenLight 网页桥接管理器（WebBridgeManager）
 * ==========================================================================
 * 作用：网页桥接模式的后端核心——管理一个由后端拉起的专用浏览器实例
 *       （puppeteer-core + 独立 user-data-dir，配置持久化在
 *       data/webbridge/profile/，登录一次长期有效），编排"发送消息 →
 *       轮询捕获 → 资产交付 → 回流画布"的完整回合。
 *
 * 职责边界（重构后）：
 *   - 本类只做编排：浏览器生命周期、配置持久化、回合调度（主回合 +
 *     页面同步巡逻）、事件出口；
 *   - 轮询与稳定判定在 utils/webbridge/turnWatcher.js（两套场景共用
 *     同一状态机）；
 *   - 资源下载/原图择优/签名去重/附件暂存在 utils/webbridge/assets.js
 *     （纯函数化，显式传依赖）；
 *   - 站点差异全部封装在适配器（utils/webbridge/adapters/），本类只调
 *     base.js 契约接口，不感知具体站点（新增站点不改这里）。
 *
 * 与既有 API 生图链路（/api/llm、modelAdapters、videoProviders）完全
 * 隔离；与现有结构的唯一交汇是 WS 回流消息格式（new-image / new-video，
 * 与 Comfy/RunningHub 同构，前端落图零改动，由路由层映射）。
 *
 * 设计要点：
 *   - HTTP 一律快速应答：生成过程不占请求（浏览器同源 6 连接的历史
 *     教训），流式与产物全部走事件；
 *   - 事件命名用领域语义（asset_image / asset_video），WS 消息映射由
 *     路由层负责；
 *   - 浏览器被用户手动关闭（disconnected 事件）→ 状态复位并广播，
 *     下次发送自动重新拉起。
 * ==========================================================================
 */

const fsp = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer-core');
const { getAdapter, listSites } = require('./webbridge/adapters');
const assets = require('./webbridge/assets');
const { runTurnLoop, contentKeyOf } = require('./webbridge/turnWatcher');

/**
 * 桥接浏览器专用调试端口（固定值）：浏览器以独立进程存活（不随后端
 * 退出/重启而关闭），后端重启后凭此端口重连原实例——登录态与已打开的
 * 对话页原样保留。选 9224 避开常用开发端口（9222/9223）
 */
const BRIDGE_DEBUG_PORT = 9224;

/** 主回合轮询间隔：回复文本快照频率 */
const POLL_INTERVAL_MS = 700;
/** 文本稳定窗口：最近一次文本变化超过此时长且不在生成中 = 回合完成 */
const STABLE_MS = 2500;
/** 主回合总超时（云端生视频可能很慢，放宽到 15 分钟） */
const TURN_TIMEOUT_MS = 15 * 60 * 1000;
/** 主回合发送后等待首个回复块出现的宽限期（模型排队/站点加载） */
const FIRST_REPLY_GRACE_MS = 60 * 1000;
/** 页面同步巡逻轮询间隔（低频常驻，避免持续占 CDP） */
const POST_TURN_POLL_MS = 3000;
/** 网络层媒体捕获缓存上限（FIFO；交付不来也不能无限涨） */
const MEDIA_CAPTURE_MAX = 20;
/** 大图捕获的响应体积下限（字节）：区分生成图与头像/图标类小图 */
const LARGE_IMAGE_MIN_BYTES = 50 * 1024;

/** 视频 URL 的去重键：路径主体（? 前部分）。CDN 签名 URL 每次请求
 *  query 都不同，全等比对挡不住"同一视频、多份签名" */
function videoKeyOf(u) {
    return String(u).split('?')[0];
}

/** 视频到达签名：最新回复块的视频卡数 + 可提取的视频直链（路径主体）。
 *  豆包视频常在文本定稿后"无文本变化"地渲染进已交付的回复块（播放器
 *  控件词还会被噪声行过滤），文本基线感知不到——看护以本签名感知
 *  视频到达并触发补交付。URL 只取路径主体：播放器重新签名 src（query
 *  变化）不代表新视频，算进签名会让巡逻误触发重复交付（真机踩坑） */
function videoSigOf(reply) {
    if (!reply) return '';
    const urls = Array.isArray(reply.videoUrls) ? reply.videoUrls : [];
    const cards = typeof reply.videoCardCount === 'number' ? reply.videoCardCount : 0;
    return `${cards}|${urls.map((u) => videoKeyOf(u).slice(0, 100)).join('|')}`;
}

/** 视频直链去重：同路径主体只留一份（多清晰度 source、重复捕获等） */
function dedupeVideoUrls(urls) {
    const seen = new Set();
    return (urls || []).filter((u) => {
        const k = videoKeyOf(u);
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

/** 常见 Chromium 系浏览器可执行文件候选（browserPath 未配置时自动探测） */
function browserCandidates() {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const lad = process.env['LocalAppData'] || '';
    return [
        path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ].filter(Boolean);
}

class WebBridgeManager {
    /**
     * @param {Object} options
     * @param {string} options.dataDir - 数据目录（settings.json 所在）
     * @param {Function} options.emit - 事件出口（路由层包装成 WS 广播）；
     *        领域事件：status / stream_text / task_progress / message_end /
     *        error / asset_image {dataUrl,prompt} / asset_video {videoPath,prompt}
     */
    constructor({ dataDir, emit }) {
        this.dataDir = dataDir;
        this.settingsPath = path.join(dataDir, 'settings.json');
        this.emit = emit || (() => {});

        /** 浏览器实例与当前站点状态（null = 未启动） */
        this.browser = null;
        /** 当前站点适配器 id（settings.json webbridge.activeSite）。
         *  构造器默认 doubao 只是兜底：启动即异步从配置恢复上次保存的
         *  站点（getConfig 内对齐内存），否则重启后面板显示与消息发送
         *  都会退回豆包——已保存却"不生效"的真机踩坑 */
        this.activeSite = 'doubao';
        this._initialSiteLoaded = this.getConfig().catch(() => {});
        /** 当前站点页面（undefined = 未打开） */
        this.page = undefined;
        /** 是否有回合在进行（同站点同时刻至多一回合） */
        this._busy = false;
        /** 本轮中止标记（abort 接口置位，轮询循环检查） */
        this._abortFlag = false;
        /** 启动中标记（防并发拉起） */
        this._starting = null;
        /** 页面同步巡逻代次（新巡逻/页面更换使旧巡逻退出） */
        this._syncWatchToken = 0;
        /** 网络层捕获的媒体响应 URL（视频兜底：播放器形态千变万化，但
         *  视频文件必经网络；交付后清空） */
        this._mediaCapture = [];
        /** 已交付视频的路径主体键（跨交付去重硬防线）：播放器重签名/
         *  卡数抖动会让巡逻再次触发交付，没有这道防线同一视频会被
         *  重复推送上画布（真机踩坑：一个视频落两份）。Set 按插入序
         *  淘汰最旧的，上限只防极端长会话 */
        this._deliveredVideoKeys = new Set();
        /** 网络层捕获的大图响应 URL（图片原图兜底：页面点开大图/高清
         *  预览时请求的原始尺寸 URL 带有效签名，比剥离猜测可靠） */
        this._imageCapture = [];
        /** 已挂媒体捕获钩子的页面（WeakSet：页面销毁自动除名） */
        this._hookedPages = new WeakSet();
        /** 原尺寸下载落盘目录：适配器点击站点"下载原尺寸"按钮后，Chrome
         *  经 CDP setDownloadBehavior 把原档直写此目录（读盘直取字节，
         *  绕开 CORS 与一次性签名——真机踩坑：页内渲染档 394KB vs 原档
         *  753KB，fetch 两条路都被堵死时这是唯一的高质量字节源） */
        this._downloadDir = path.join(this.dataDir, 'webbridge', 'downloads');
        /** 本轮附件暂存文件（回合收尾清理） */
        this._stagedFiles = null;
        /** 最近一次成功交付的回复文本（同步巡逻的比对基线）。
         *  基线用"已交付"而非"回合文本"：看护被新回合顶掉时，未交付的
         *  内容（如视频投递）与基线的差异仍在，下一任看护能补交付，
         *  不再静默丢失（2026-09-30 真机踩坑） */
        this._lastDeliveredText = '';
        /** 最近一次交付的内容键（contentKeyOf：文本+图片/视频 URL 基键）：
         *  巡逻判新与回合基线对齐的基准，纯图回复没有文本，必须用内容键 */
        this._lastDeliveredContentKey = '';
        /** 已交付图片的路径基键集合（assets.imageBaseKey）：假信号预检
         *  用——纯图回复没有正文，连续两条生图回复的 text 都是空串，
         *  只比对文本会把第二条当重复跳过（2026-10-03 真机踩坑） */
        this._deliveredImageBaseKeys = new Set();
        /** 最近一次交付完成时刻（ms）：媒体捕获资格的时间基准——只有
         *  此后新产生的捕获才归属下一次交付。替代旧的"交付开始时快照
         *  基线"：后者会把看护空闲期间到达的视频捕获当陈旧数据淘汰，
         *  晚到的视频永远交付不出去（2026-09-30 真机踩坑） */
        this._lastDeliverAt = 0;
        /** 最近一次交付的视频签名（videoSigOf）：看护据此感知"文本没变
         *  但视频卡到了"的场景并触发补交付 */
        this._lastDeliveredVSig = '';
    }

    // ==================== 配置（settings.json 的 webbridge 区块） ====================

    async _readSettings() {
        try {
            return JSON.parse(await fsp.readFile(this.settingsPath, 'utf8'));
        } catch {
            return {};
        }
    }

    async _writeSettings(settings) {
        await fsp.mkdir(path.dirname(this.settingsPath), { recursive: true });
        await fsp.writeFile(this.settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    }

    /** 读配置（缺省自动补默认值，不动 settings.json 其他区块）。
     *  顺带把持久化的站点对齐进内存：本方法是各路径（状态查询/拉起
     *  浏览器/保存）读配置的必经点，在这里对齐可保证重启后任何入口
     *  拿到的都是上次保存的站点；文件里的站点未登记时保持现状 */
    async getConfig() {
        const settings = await this._readSettings();
        const cfg = settings.webbridge || {};
        const site = cfg.activeSite || 'doubao';
        if (site !== this.activeSite && getAdapter(site)) {
            this.activeSite = site;
            this.page = undefined;   // 站点变了，已跟踪的标签页不再适用
        }
        return {
            browserPath: cfg.browserPath || '',
            activeSite: site,
            headless: !!cfg.headless
        };
    }

    /** 保存配置（读改写整个文件，保留 api/runninghub/mcp 等其他区块） */
    async saveConfig(patch) {
        const settings = await this._readSettings();
        const cur = settings.webbridge || {};
        settings.webbridge = { ...cur };
        if (typeof patch.browserPath === 'string') settings.webbridge.browserPath = patch.browserPath.trim();
        if (typeof patch.activeSite === 'string' && getAdapter(patch.activeSite)) {
            settings.webbridge.activeSite = patch.activeSite;
        }
        if (typeof patch.headless === 'boolean') settings.webbridge.headless = patch.headless;
        if (typeof patch.lastPageUrl === 'string') {
            settings.webbridge.lastPageUrls = settings.webbridge.lastPageUrls || {};
            settings.webbridge.lastPageUrls[this.activeSite] = patch.lastPageUrl;
        }
        await this._writeSettings(settings);
        // 站点切换即时生效：只更新指针，已开的标签页留给下次 ensurePage 复用判定
        if (settings.webbridge.activeSite !== this.activeSite) {
            this.activeSite = settings.webbridge.activeSite;
            this.page = undefined;
        }
        return this.getConfig();
    }

    /** 当前站点适配器（base.js 契约对象；未登记返回 null） */
    getAdapter() {
        return getAdapter(this.activeSite);
    }

    // ==================== 浏览器生命周期 ====================

    /**
     * 探测浏览器可执行文件：配置路径优先，其次常见安装位置
     * @returns {Promise<string>} 可执行文件绝对路径
     */
    async _resolveBrowserPath() {
        const cfg = await this.getConfig();
        if (cfg.browserPath && require('fs').existsSync(cfg.browserPath)) return cfg.browserPath;
        for (const cand of browserCandidates()) {
            if (require('fs').existsSync(cand)) return cand;
        }
        throw new Error('未找到 Chrome/Edge 浏览器，请在 设置 → 网页桥接 中手动指定浏览器路径');
    }

    /**
     * 拉起/接入专用浏览器（幂等）：独立 user-data-dir 会话持久化。
     * 浏览器是**独立进程**（调试端口 + 脱离后端进程树），后端重启不关它：
     *   1) 先试重连调试端口上的存活实例（上次后端退出只 disconnect）；
     *   2) 没有存活实例才拉起：detached spawn + 网络调试端口——puppeteer
     *      默认的 pipe 连接会随父进程死亡而断、Chrome 随之自杀（历史教训：
     *      后端一重启浏览器就陪葬，登录页状态全丢），网络端口无此绑定；
     *   3) 后端退出钩子（closeAll）只 disconnect 不 close。
     * 只有设置界面"关闭浏览器"（stop）才真正结束浏览器进程。
     * 启动失败不缓存半成品状态
     */
    async ensureStarted() {
        if (this.browser && this.browser.connected) return this.browser;
        if (this._starting) return this._starting;

        this._starting = (async () => {
            const cfg = await this.getConfig();
            const debugUrl = `http://127.0.0.1:${BRIDGE_DEBUG_PORT}`;

            // 1) 重连存活实例
            const existing = await puppeteer.connect({
                browserURL: debugUrl,
                defaultViewport: null            // 跟随窗口大小，网页按真实尺寸渲染
            }).catch(() => null);
            if (existing) {
                console.log(`[WebBridge] 重连存活桥接浏览器（调试端口 ${BRIDGE_DEBUG_PORT}），登录态与标签页原样保留`);
                this._adoptBrowser(existing);
                return existing;
            }

            // 2) 拉起独立进程（同款反自动化参数 + 固定调试端口）
            const executablePath = await this._resolveBrowserPath();
            const profileDir = path.join(this.dataDir, 'webbridge', 'profile');
            await fsp.mkdir(profileDir, { recursive: true });
            const chromeArgs = [
                `--remote-debugging-port=${BRIDGE_DEBUG_PORT}`,
                `--user-data-dir=${profileDir}`,
                ...(cfg.headless ? ['--headless=new'] : []),
                '--start-maximized', '--lang=zh-CN', '--no-first-run',
                // 反自动化指纹：--enable-automation 会让 navigator.webdriver
                // 置真，Google 登录页（ChatGPT 走 Google OAuth）即以"此浏览器
                // 或应用可能不安全"拒绝登录；blink 特性排除是双保险
                '--disable-blink-features=AutomationControlled',
                // 后台保活（后台自动发送的关键）：窗口被其他窗口遮挡/失焦时，
                // Windows 端 Chrome 的原生遮挡检测会把页面标记为 hidden——
                // 页面 rAF 冻结、输入管线挂起、CDP 注入的鼠标/键盘事件被静默
                // 吞掉，发送动作一直冻结到用户手动切回窗口（真机踩坑：
                // 文字停在输入框，切回窗口才发出）。禁用遮挡计算与后台节流
                // 后，桥接窗口在后台也保持可见态，程序化发送即时生效
                '--disable-features=CalculateNativeWinOcclusion',
                '--disable-backgrounding-occluded-windows',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                // 磁盘缓存上限 128MB：豆包这类重前端站点会把 Chrome 配置目录
                // 撑到几百 MB，到顶自动滚动覆盖（登录态文件不受影响）
                '--disk-cache-size=134217728'
            ];
            console.log(`[WebBridge] 拉起桥接浏览器（独立进程，调试端口 ${BRIDGE_DEBUG_PORT}）: ${executablePath}`);
            spawn(executablePath, chromeArgs, { detached: true, stdio: 'ignore' }).unref();

            // 3) 轮询等待调试端口就绪后连接（≤20s）
            let browser = null;
            for (let i = 0; i < 40 && !browser; i++) {
                await new Promise((r) => setTimeout(r, 500));
                browser = await puppeteer.connect({
                    browserURL: debugUrl,
                    defaultViewport: null
                }).catch(() => null);
            }
            if (!browser) throw new Error('桥接浏览器调试端口未就绪（20s 超时），请检查浏览器路径配置');
            this._adoptBrowser(browser);
            return browser;
        })();

        try {
            return await this._starting;
        } finally {
            this._starting = null;
        }
    }

    /**
     * 接管浏览器连接：挂断线复位与新标签页媒体捕获监听，并给重连时的
     * 存量标签页补挂捕获（targetcreated 只对新开标签页触发）
     */
    _adoptBrowser(browser) {
        // 浏览器级下载重定向：把 Chrome 的下载行为引到 downloads/ 目录。
        // 必须发在浏览器级 CDP 会话上（页面级会话在新 Chrome 上不可靠），
        // 适配器声明 downloadsOriginals 并点击站点下载按钮后，原档直写
        // 此目录供交付读盘直取（绕开 CORS 与一次性签名）
        (async () => {
            try {
                await fsp.mkdir(this._downloadDir, { recursive: true });
                const client = await browser.target().createCDPSession();
                await client.send('Browser.setDownloadBehavior', {
                    behavior: 'allow',
                    downloadPath: this._downloadDir
                });
            } catch { /* 尽力而为：下载兜底不可用时走捕获配对 */ }
        })();
        // 用户手动关闭浏览器窗口：复位状态并广播，下次发送自动重连/重拉
        browser.on('disconnected', () => {
            console.log('[WebBridge] 桥接浏览器已断开（手动关闭或崩溃）');
            this.browser = null;
            this.page = undefined;
            this._busy = false;
            this.emit({ type: 'status', state: 'closed', site: this.activeSite });
        });

        // 新开标签页（含播放卡点击弹出的播放器页）自动挂媒体捕获
        browser.on('targetcreated', async (target) => {
            try {
                if (target.type() === 'page') {
                    const p = await target.page();
                    if (p) this._attachMediaCapture(p);
                }
            } catch { /* 尽力而为 */ }
        });

        // 重连接管：存量标签页补挂媒体捕获
        (async () => {
            const pages = await browser.pages().catch(() => []);
            pages.forEach((p) => this._attachMediaCapture(p));
        })();

        this.browser = browser;
        this.emit({ type: 'status', state: 'running', site: this.activeSite });
    }

    /**
     * 找到目标站点的标签页，找不到就新开并导航到对话入口。
     * 同站点可能有多个标签页（入口页 + 对话页 + 播放器弹层）：
     * 优先选 URL 路径最长的（对话页 URL 比入口页长——跨站点通用的
     * 启发式；曾因命中空白入口页导致整轮捕获不到内容）。
     * 页面加载/跳转异常会向上抛，由调用方转成错误事件
     */
    async ensurePage(adapter) {
        if (this.page && !this.page.isClosed()) {
            // 已有本站标签页：确认还在目标站点 URL 上（用户可能手动导航走了）
            const url = this.page.url();
            if (adapter.urlPattern.test(url)) return this.page;
        }
        // 在全部标签页里挑本站页面：按 URL 路径长度降序（对话页优先）
        const pages = await this.browser.pages();
        const candidates = pages.filter((p) => adapter.urlPattern.test(p.url()));
        if (candidates.length) {
            candidates.sort((a, b) => b.url().split('?')[0].length - a.url().split('?')[0].length);
            const existing = candidates[0];
            console.log(`[WebBridge] 复用本站标签页（${candidates.length} 个候选）: ${existing.url().slice(0, 100)}`);
            this._attachMediaCapture(existing);
            this.page = existing;
            this._startSyncWatcher(existing, adapter);
            return existing;
        }
        const page = await this.browser.newPage();
        // 浏览器重启后本地标签页不保留（Chrome 强杀不恢复），但对话内容在
        // 站点服务端——回到该站点最近一次对话页（按站点记忆），而非空白
        // 入口页，保证看护/交付能在原对话上下文里继续工作
        const settings = await this._readSettings();
        const lastUrl = (settings.webbridge?.lastPageUrls || {})[adapter.id];
        const targetUrl = lastUrl && adapter.urlPattern.test(lastUrl) ? lastUrl : adapter.homeUrl;
        try {
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60 * 1000 });
            if (targetUrl !== adapter.homeUrl) {
                console.log(`[WebBridge] 已回到最近对话页: ${targetUrl.slice(0, 100)}`);
            }
        } catch (err) {
            console.warn('[WebBridge] 打开对话页失败，回退入口页:', err.message);
            await page.goto(adapter.homeUrl, { waitUntil: 'domcontentloaded', timeout: 60 * 1000 }).catch(() => {});
        }
        this.page = page;
        this._attachMediaCapture(page);
        this._startSyncWatcher(page, adapter);
        this.emit({ type: 'status', state: 'page-open', site: adapter.id });
        return page;
    }

    /**
     * 页面同步巡逻（常驻）：桥接标签页活着就持续轮询，页面上出现任何
     * 新内容（面板发的、用户手动在页面上操作的、豆包视频结果）都在
     * 稳定后自动交付回流。取代旧的"回合后 15 分钟看护"——后者依赖
     * 面板交互续命，用户直接在页面上操作时经常不在值勤（真机踩坑）。
     *
     * 协调规则：
     *   - 面板回合进行中（_busy）巡逻让位，回合的交付更新基线
     *     （_lastDeliveredText）后巡逻自然跳过已交付内容；
     *   - 基线为空（后端重启）时先对齐页面现状，不倾倒历史内容；
     *   - 捕获隔离沿用交付基线快照（见 _deliver）。
     */
    _startSyncWatcher(page, adapter) {
        this._syncWatchToken += 1;
        const token = this._syncWatchToken;
        this._runSyncWatcher(page, adapter, token).catch((err) =>
            console.warn('[WebBridge] 页面同步巡逻异常:', err.message));
    }

    async _runSyncWatcher(page, adapter, token) {
        console.log('[WebBridge] 页面同步巡逻启动（桥接页面存活期间持续回流新内容）');
        // 基线初始化：后端重启等场景基线为空时对齐页面现状，避免把
        // 巡逻启动前就存在的历史消息倾倒进面板——基线用内容键（文本+
        // 图片/视频 URL），纯图历史回复也能正确对齐（旧版只对齐文本，
        // 重启后会把页面上的纯图回复当新内容重新交付）
        if (!this._lastDeliveredContentKey) {
            const existing = await adapter.extractReply(page).catch(() => null);
            const key = contentKeyOf(existing);
            if (key) {
                this._lastDeliveredContentKey = key;
                this._lastDeliveredText = (existing && existing.text) || '';
                this._lastDeliveredVSig = videoSigOf(existing);
            }
        }
        while (token === this._syncWatchToken) {
            await new Promise((r) => setTimeout(r, POST_TURN_POLL_MS));
            if (token !== this._syncWatchToken) return;
            if (!this.browser || !this.browser.connected || page.isClosed()) return;
            if (this._busy) continue;   // 面板回合进行中：回合负责捕获与交付
            let reply = null;
            try { reply = await adapter.extractReply(page); } catch { continue; }
            const replyKey = contentKeyOf(reply);
            // 新内容 = 内容键与最近交付基线不同（文本变化、新图、新视频
            // 任一即可；纯图回复没有正文，旧版只看文本会永远漏掉）
            if (!replyKey || replyKey === this._lastDeliveredContentKey) continue;
            // 新内容：稳定判定（含任务检测/生成中检查/流式上报）后交付
            try {
                const result = await runTurnLoop({
                    page,
                    adapter,
                    emit: this.emit,
                    knownText: this._lastDeliveredText,
                    baselineKey: this._lastDeliveredContentKey,
                    timeoutMs: TURN_TIMEOUT_MS,
                    pollMs: POST_TURN_POLL_MS,
                    stableMs: STABLE_MS,
                    firstReplyGraceMs: 0,
                    superseded: () => token !== this._syncWatchToken || this._busy
                });
                if (result.superseded) continue;
                await this._rememberPageUrl(adapter, page.url()).catch(() => {});
                // sinceTs 取最近交付时刻：只消费上次交付之后到达的捕获
                await this._deliver(page, adapter, result.text, result.reply, result.suggestions, this._lastDeliverAt);
            } catch (err) {
                console.warn('[WebBridge] 同步巡逻交付异常:', err.message);
            }
        }
    }

    /**
     * 手动导航当前站点标签页到指定 URL（并记忆为最近对话页）。
     * 供"重启后恢复对话"等场景；URL 必须匹配站点域名
     */
    async openUrl(url) {
        const adapter = this.getAdapter();
        if (!adapter) throw new Error(`站点 ${this.activeSite} 未登记`);
        if (!adapter.urlPattern.test(String(url || ''))) {
            throw new Error('URL 与当前桥接站点不匹配');
        }
        await this.ensureStarted();
        const page = await this.ensurePage(adapter);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60 * 1000 });
        await this.saveConfig({ lastPageUrl: page.url() });
        return { url: page.url() };
    }

    /** 页面导航/会话变化时记忆最近对话页（内部调用） */
    async _rememberPageUrl(adapter, url) {
        if (!url || !adapter.urlPattern.test(url)) return;
        if (url === adapter.homeUrl) return;   // 入口页不记
        try {
            await this.saveConfig({ lastPageUrl: url });
        } catch { /* 尽力而为 */ }
    }

    /**
     * 挂网络层媒体捕获（每页一次）：监听 video/* 与直链视频后缀的响应，
     * 记录 CDN 地址——播放器可能用 MSE blob（节点无法直接 fetch blob），
     * 但媒体分片必经网络，捕获到的 URL 由交付环节兜底下载。
     * 已有本页钩子时跳过（targetcreated 与 ensurePage 会重复调用）
     */
    _attachMediaCapture(page) {
        if (!page || this._hookedPages.has(page)) return;
        this._hookedPages.add(page);
        page.on('response', (resp) => {
            try {
                const url = resp.url();
                if (!/^https?:/i.test(url)) return;   // blob:/data: 交给页面侧
                const ct = (resp.headers()['content-type'] || '').toLowerCase();
                const pathPart = url.split('?')[0].toLowerCase();
                if (ct.startsWith('video/') || /\.(mp4|webm|mov)(\?|$)/.test(pathPart)) {
                    // 按路径主体（? 前）去重：CDN 签名 URL 每次请求 query
                    // 都不同，全等比对挡不住同一视频重复入队（两侧都取
                    // 小写，与 pathPart 口径一致）
                    if (this._mediaCapture.some((m) => m.url.split('?')[0].toLowerCase() === pathPart)) return;
                    this._mediaCapture.push({ url, at: Date.now() });
                    // FIFO 上限：交付不来也不能无限涨
                    if (this._mediaCapture.length > MEDIA_CAPTURE_MAX) this._mediaCapture.shift();
                    console.log(`[WebBridge] 捕获媒体响应: ${url.slice(0, 140)}`);
                    return;
                }
                // 大图捕获：页面自己请求的大尺寸图片（点开大图/高清预览），
                // URL 带有效签名——比剥模板的猜测候选可靠（剥过的签名会 403）。
                // 以响应体积区分内容图与头像/图标（小图无补交付价值）
                if (ct.startsWith('image/')) {
                    const size = parseInt(resp.headers()['content-length'] || '0', 10);
                    if (size > LARGE_IMAGE_MIN_BYTES) {
                        if (!this._imageCapture.some((m) => m.url === url)) {
                            this._imageCapture.push({ url, at: Date.now(), size });
                            if (this._imageCapture.length > MEDIA_CAPTURE_MAX) this._imageCapture.shift();
                            console.log(`[WebBridge] 捕获大图响应: ${url.slice(0, 140)} (${size} 字节)`);
                        }
                    }
                }
            } catch { /* 尽力而为 */ }
        });
    }

    /** 扫描原尺寸下载目录：返回 sinceTs 之后落盘的文件（按时间升序），
     *  顺带清理 2 小时前的陈旧档（读后即删之外的第二道卫生防线） */
    _scanOriginalDownloadFiles(sinceTs) {
        try {
            const out = [];
            const now = Date.now();
            for (const name of fsSync.readdirSync(this._downloadDir)) {
                const filePath = path.join(this._downloadDir, name);
                try {
                const st = fsSync.statSync(filePath);
                if (!st.isFile()) continue;
                if (/\.crdownload$/i.test(name)) continue;   // 下载未完成
                if (st.mtimeMs >= sinceTs) out.push({ filePath, mtimeMs: st.mtimeMs });
                else if (now - st.mtimeMs > 2 * 60 * 60 * 1000) fsSync.unlinkSync(filePath);
                } catch { /* 单个文件失败跳过 */ }
            }
            return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
        } catch {
            return [];
        }
    }

    /** 读取并删除原尺寸下载文件（读后即删防重复交付）→ dataUrl 清单。
     *  maxCount 限制单次取用数：多图回合里 blob 组按序各领一个 */
    _consumeOriginalDataUrls(sinceTs, maxCount = Infinity) {
        const out = [];
        for (const f of this._scanOriginalDownloadFiles(sinceTs)) {
            if (out.length >= maxCount) break;
            try {
                const ext = path.extname(f.filePath).toLowerCase();
                const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
                out.push(`data:${mime};base64,${fsSync.readFileSync(f.filePath).toString('base64')}`);
                fsSync.unlinkSync(f.filePath);
            } catch { /* 读失败即删，防死循环堆积 */ try { fsSync.unlinkSync(f.filePath); } catch { /* 尽力而为 */ } }
        }
        return out;
    }

    /** 关闭浏览器（设置界面/后端退出钩子调用） */
    async stop() {        if (!this.browser) return;
        const b = this.browser;
        this.browser = null;
        this.page = undefined;
        this._busy = false;
        try { await b.close(); } catch { /* 尽力而为 */ }
        this.emit({ type: 'status', state: 'closed', site: this.activeSite });
    }

    /** 后端退出钩子：只断开连接、保留浏览器进程（独立进程设计，重启后凭
     *  调试端口重连，登录态与打开的对话页原样保留；浏览器由设置界面
     *  "关闭浏览器"按钮或用户手动关闭来终止） */
    closeAll() {
        if (!this.browser) return;
        try { this.browser.disconnect(); } catch { /* 尽力而为 */ }
        this.browser = null;
        this.page = undefined;
    }

    /** 汇总状态（设置界面与面板状态行共用） */
    async getStatus() {
        const cfg = await this.getConfig();
        const adapter = this.getAdapter();
        return {
            running: !!(this.browser && this.browser.connected),
            busy: this._busy,
            activeSite: this.activeSite,
            siteName: adapter ? adapter.name : this.activeSite,
            pageUrl: this.page && !this.page.isClosed() ? this.page.url() : '',
            sites: listSites(),
            browserPath: cfg.browserPath
        };
    }

    // ==================== 消息回合（发送 → 轮询 → 交付） ====================

    /**
     * 发送一条消息并启动回复捕获（异步执行，立即返回）。
     * 失败同步抛出（HTTP 层转错误应答）；过程事件经 emit 推送
     * @param {{text: string, images: string[]}} msg
     * @returns {Promise<{accepted: boolean}>}
     */
    async send(msg) {
        if (this._busy) {
            const err = new Error('上一条消息的回复尚未捕获完成，请稍候');
            err.status = 409;
            throw err;
        }
        const adapter = this.getAdapter();
        if (!adapter) throw new Error(`站点 ${this.activeSite} 未登记`);
        if (adapter.ready === false) throw new Error(`${adapter.name} 适配器尚未校准，暂不可用`);
        if (!msg || (!String(msg.text || '').trim() && !(msg.images || []).length)) {
            throw new Error('消息内容为空');
        }

        await this.ensureStarted();
        const page = await this.ensurePage(adapter);

        // 附件图片暂存为临时文件：隐藏 <input type=file> 的原生注入
        // （uploadFile 只认磁盘路径），回合收尾时清理
        let imagePaths = [];
        if (Array.isArray(msg.images) && msg.images.length) {
            try {
                imagePaths = await assets.stageImageFiles({ dataDir: this.dataDir, dataUrls: msg.images });
                this._stagedFiles = imagePaths;
            } catch (err) {
                console.warn('[WebBridge] 附件暂存失败，降级为 data URL 注入:', err.message);
            }
        }

        // 回合内容基线：发送前对"当前最新回复"快照一次。新回复未渲染时
        // 页面上的最新助手块仍是上一轮内容，轮询若不做基线比对会把旧图
        // 当本轮新内容提前交付（真机踩坑：图生图回合回的是上一轮的图）。
        // 只认与基线键不同的内容 = 必须等到最新一轮的新回复
        const baseline = await adapter.extractReply(page).catch(() => null);
        const baselineKey = contentKeyOf(baseline);

        await adapter.sendMessage(page, {
            text: String(msg.text || ''),
            images: msg.images || [],
            imagePaths
        });

        this._busy = true;
        this._abortFlag = false;
        // 轮询在后台跑：HTTP 已应答，过程全走事件
        this._runActiveTurn(page, adapter, baselineKey).catch(() => { /* 错误已在内部 emit */ });
        return { accepted: true };
    }

    /**
     * 主回合：轮询捕获（turnWatcher 状态机）→ 交付 → 晚到产物交页面
     * 同步巡逻接管。错误经 emit 推送（HTTP 已应答，不再向上抛）
     */
    async _runActiveTurn(page, adapter, baselineKey = '') {
        const sinceTs = Date.now();   // 回合起点：此后产生的捕获才归属本轮
        try {
            const result = await runTurnLoop({
                page,
                adapter,
                emit: this.emit,
                baselineKey,
                timeoutMs: TURN_TIMEOUT_MS,
                pollMs: POLL_INTERVAL_MS,
                stableMs: STABLE_MS,
                firstReplyGraceMs: FIRST_REPLY_GRACE_MS,
                superseded: () => this._abortFlag
            });
            if (result.superseded) {
                this.emit({ type: 'message_end', site: adapter.id, aborted: true, text: result.text, suggestions: [], images: [], videos: [] });
                return;
            }
            // 记忆对话页 URL（新会话在入口页发起时，豆包会跳转到 /chat/<id>，
            // 此时 URL 才定型）：浏览器重启后能回到原对话
            await this._rememberPageUrl(adapter, page.url()).catch(() => {});
            await this._deliver(page, adapter, result.text, result.reply, result.suggestions, sinceTs);
            // 晚到的图片/视频（豆包视频常"稍后另发一条"投递）由页面同步
            // 巡逻接管：它常驻轮询文本与视频签名，回合结束后自动补交付。
            // 旧的"回合后异步看护"与本巡逻并发会对同一内容重复交付，已删
        } catch (err) {
            console.error('[WebBridge] 回合异常:', err.message);
            this.emit({ type: 'error', site: adapter.id, message: err.message });
        } finally {
            this._busy = false;
            assets.cleanupStagedFiles(this._stagedFiles);
            this._stagedFiles = null;
        }
    }

    /** 中止当前回合的捕获（尽力点击站点停止按钮） */
    async abort() {
        if (!this._busy) return;
        this._abortFlag = true;
        const adapter = this.getAdapter();
        if (adapter && typeof adapter.stopGeneration === 'function' &&
            this.page && !this.page.isClosed()) {
            await adapter.stopGeneration(this.page).catch(() => {});
        }
    }

    /**
     * 重发当前页面最新内容（诊断/手动补救用）：看护被顶掉、交付异常等
     * 场景下，页面里已生成但未回流的内容由此补交付——走与正常交付
     * 完全相同的链路（触发视频加载 → 提取 → 资产转存 → 回流）。
     * 最新回复与交付基线相同（已交付过）时明确报错，防止重复投递
     */
    async redeliverCurrent() {
        const adapter = this.getAdapter();
        if (!adapter) throw new Error(`站点 ${this.activeSite} 未登记`);
        await this.ensureStarted();
        const page = await this.ensurePage(adapter);
        // 有内容 = 文本或图片/视频 URL 任一非空（纯图回复没有正文——
        // 旧版只认文本，ChatGPT 生图回复永远补不了交付）
        const hasContent = (r) => !!(r && ((r.text || '').trim() ||
            (Array.isArray(r.imageUrls) && r.imageUrls.length) ||
            (Array.isArray(r.videoUrls) && r.videoUrls.length)));
        // SPA 渲染等待：刚导航到对话页时消息列表可能尚未渲染，轮询至多 12s
        let reply = null;
        for (let i = 0; i < 12 && !hasContent(reply); i++) {
            reply = await adapter.extractReply(page);
            if (!hasContent(reply)) await new Promise((r) => setTimeout(r, 1000));
        }
        if (!hasContent(reply)) throw new Error('当前页面没有可补交付的回复内容（12s 内未渲染出消息）');
        const replyText = reply.text || '';
        // "已交付过"= 文本与视频签名都没变、没有未登记的图片基键、且没有
        // 待交付的视频捕获。只比对文本会挡掉"视频卡/图片晚到"的补交付
        // （文本早已交付过或根本没有文本）；捕获侧同样排除已交付键
        const pendingVideoCaptures = this._mediaCapture.some((m) =>
            m.at >= this._lastDeliverAt && !this._deliveredVideoKeys.has(videoKeyOf(m.url)));
        const newImageKeys = (reply.imageUrls || [])
            .map((u) => assets.imageBaseKey(u))
            .filter((k) => !this._deliveredImageBaseKeys.has(k));
        if (replyText === this._lastDeliveredText &&
            videoSigOf(reply) === this._lastDeliveredVSig &&
            !newImageKeys.length && !pendingVideoCaptures) {
            throw new Error('当前页面最新回复已交付过，没有待补发的内容');
        }
        // sinceTs 取最近交付时刻：补交付消费上次交付之后到达的捕获
        //（晚到的视频），历史回合的陈旧捕获仍被时间门槛挡住
        await this._deliver(page, adapter, replyText, reply, reply.suggestions || [], this._lastDeliverAt);
        return { delivered: true, text: replyText };
    }

    /**
     * 资产交付（回合收尾与同步巡逻共用）：触发视频加载 → 最新快照 →
     * 图片去重下载、视频转存 → 逐个推送落画布（asset_image / asset_video），
     * 最后发 message_end 给面板（含推荐追问与转存失败说明）
     */
    async _deliver(page, adapter, text, reply, suggestions = [], sinceTs = 0) {
        // 捕获资格按"不早于 sinceTs"（回合/看护起点或最近交付时刻）判定：
        // 晚到的视频捕获大多发生在交付空闲期，旧版"交付开始时快照基线"
        // 会把它们当陈旧数据淘汰——视频永远交付不出去（真机踩坑）。
        // 历史回合的陈旧捕获由 sinceTs 时间门槛挡住
        try { await adapter.revealVideos?.(page); } catch { /* 失败不阻塞 */ }
        // 原尺寸下载：适配器声明 downloadsOriginals 且 revealImages 确实
        // 点到了站点的"下载原尺寸"按钮（Chrome 落盘 downloads/）时，
        // 图片段才会等原档落盘——否则纯图交付不陪绑等待
        let originalsExpected = false;
        try {
            originalsExpected = adapter.downloadsOriginals === true &&
                (await adapter.revealImages?.(page)) === true;
        } catch { /* 失败不阻塞 */ }

        // 重新提取一次最新快照：图片/视频 URL 可能在最后一次文本变化之后
        // 才渲染进 DOM（reply 是文本变化时的旧快照，直接用会漏图；
        // reply 可为 null——视频签名触发时文本未变，稳定循环不记快照）
        let assetReply = reply || { imageUrls: [], videoUrls: [], videoCardCount: 0 };
        try {
            const fresh = await adapter.extractReply(page);
            if (fresh) {
                assetReply = {
                    imageUrls: (fresh.imageUrls && fresh.imageUrls.length)
                        ? fresh.imageUrls : ((reply && reply.imageUrls) || []),
                    videoUrls: (fresh.videoUrls && fresh.videoUrls.length)
                        ? fresh.videoUrls : ((reply && reply.videoUrls) || []),
                    videoCardCount: typeof fresh.videoCardCount === 'number'
                        ? fresh.videoCardCount : 0
                };
            }
        } catch { /* 重新提取失败：沿用最后一次文本变化时的快照 */ }

        // 假信号预检：文本没变且没有"从未交付过"的新视频候选（DOM 直链
        // 和捕获都算）时，本次触发是播放器重签名/卡数抖动等假信号——
        // 放行会把同一视频再下载推送一遍（真机踩坑：一个视频落两份），
        // 也可能把已交付消息里的图片重复上画布。放在图片段落之前整次
        // 跳过，图片管线本身不动
        {
            const preDom = dedupeVideoUrls(assetReply.videoUrls)
                .filter((u) => !this._deliveredVideoKeys.has(videoKeyOf(u)));
            const preCap = this._mediaCapture.filter((m) =>
                m.at >= sinceTs && !this._deliveredVideoKeys.has(videoKeyOf(m.url)));
            const preNewImages = (Array.isArray(assetReply.imageUrls) ? assetReply.imageUrls : [])
                .map((u) => assets.imageBaseKey(u))
                .filter((k) => !this._deliveredImageBaseKeys.has(k));
            if (text === this._lastDeliveredText && !preDom.length && !preCap.length && !preNewImages.length) {
                this._lastDeliveredVSig = videoSigOf(assetReply);   // 对齐签名基线，止住巡逻反复触发
                this._lastDeliveredContentKey = contentKeyOf({ text, ...assetReply });   // 对齐内容键基线
                this._lastDeliverAt = Date.now();
                console.log('[WebBridge] 文本无变化且无新视频/新图片，跳过重复交付');
                return { text, images: [], videos: [], suggestions };
            }
        }

        const cookieHeader = await this._cookieHeader();
        const referer = adapter.homeUrl;

        // ---- 图片：按"路径基键"归属捕获响应 + 每张回复图独立择优 ----
        // 本轮可消费的捕获 = 回合/看护起点之后到达（时间门槛；已被此前
        // 交付消费掉的捕获在消费时即从 _imageCapture 移除，这里天然只剩
        // 未消费的）。历史教训：旧版用"交付开始时 _imageCapture 的 URL
        // 快照"再做排除——快照与过滤的是同一个数组，排除条件恒真，
        // eligible 永远为空；豆包时代 DOM 图是可直接下载的 https 直链
        // 才没暴露，Gemini 的 DOM 图是加载后即回收的 blob:（唯一数据源
        // 就是捕获），一上来就"全部原图候选下载失败"
        const domImageUrls = Array.isArray(assetReply.imageUrls) ? assetReply.imageUrls : [];
        // 内容捕获消费器：取走当前"时间合格（不早于回合/看护起点）+ 适配器
        // 认可的内容图"的捕获，并从队列移除（防重复消费）。适配器可用
        // isContentImageUrl 把 UI 资源挡在门外——gstatic 雪碧图等与内容图
        // 体积同量级，按尺寸阈值区分不了
        const consumeContentCaptures = () => {
            const got = this._imageCapture.filter((m) => m.at >= sinceTs &&
                (!adapter.isContentImageUrl || adapter.isContentImageUrl(m.url)));
            if (got.length) this._imageCapture = this._imageCapture.filter((m) => !got.includes(m));
            return got;
        };
        const eligibleImageCaptures = consumeContentCaptures();
        const eligibleImageSet = new Set(eligibleImageCaptures);
        this._imageCapture = this._imageCapture.filter((m) => !eligibleImageSet.has(m));
        const capturedByBase = new Map();
        for (const m of eligibleImageCaptures) {
            const key = assets.imageBaseKey(m.url);
            if (!capturedByBase.has(key)) capturedByBase.set(key, []);
            capturedByBase.get(key).push(m.url);
        }
        // 同一张图的多个来源按基键分组：豆包的回复图常同时存在多个 CDN
        // 主机/模板的节点（实测 p26 主机只给 288x384 缩略、p3 主机给
        // 1728x2304 原图）——组内合并全部候选做像素择优，选出该图的最优
        // 版本；跨组的签名去重在择优之后做（否则先交付的小图会把后到的
        // 高清版本当重复图杀掉——真机踩坑）
        const baseGroups = new Map();   // baseKey → { urls:Set, captures:[] }
        for (const domUrl of domImageUrls) {
            const key = assets.imageBaseKey(domUrl);
            if (!baseGroups.has(key)) baseGroups.set(key, { urls: new Set(), captures: capturedByBase.get(key) || [] });
            baseGroups.get(key).urls.add(domUrl);
        }
        // 原档落盘等待：reveal 点击后 Chrome 下载原档（走 VPN 时可能
        // 20s+，真机踩坑：12s 上限等不到 → 孤儿 + 交付 199KB 压缩档），
        // 最多等 30s；文件一落盘（且无 .crdownload 未完成下载）立即继续，
        // 不会傻等满上限。全局只等一次（多图逐组消费，不等第二轮）
        if (originalsExpected) {
            for (let i = 0; i < 30; i++) {
                const files = this._scanOriginalDownloadFiles(sinceTs);
                const crd = fsSync.existsSync(this._downloadDir)
                    ? fsSync.readdirSync(this._downloadDir).filter((n) => /\.crdownload$/i.test(n))
                    : [];
                if (files.length && !crd.length) break;
                await new Promise((r) => setTimeout(r, 1000));
            }
        }
        const images = [];
        const imageSigs = [];          // 已收图的 16x16 灰度签名（近似重复过滤）
        const seenDataUrls = new Set();
        const videos = [];
        const assetErrors = [];
        // 交付开始批次里未被基键配对认领的捕获：blob 组（DOM 是回收后的
        // blob，基键与捕获对不上）是它们唯一的去处——上一版漏了这条归还
        // 通路，开始批次捕获被消费器取走后成了孤儿，下载时队列已空
        //（真机踩坑：回合期间落网的 5 条捕获全部无人认领）。
        // 认领判据 = 捕获基键命中某个 DOM 组的基键；不能用"捕获自身
        // URL 集合"做排除——那是同数组自滤，无人认领集合恒空。
        // 按响应体积降序：最大的最可能是最终全尺寸图，配合 goodEnoughPixels
        // 提前收工，把串行候选下载从十几个压到两三个
        const domGroupKeys = new Set(baseGroups.keys());
        const unclaimedCaptures = eligibleImageCaptures
            .filter((m) => !domGroupKeys.has(assets.imageBaseKey(m.url)))
            .sort((a, b) => (b.size || 0) - (a.size || 0));
        for (const [baseKey, group] of baseGroups) {
            let candidates = [...new Set([...group.captures, ...group.urls])];
            // 原尺寸下载候选（最高优先）：Chrome 落盘的原档字节直取——
            // 753KB 原档 vs 394KB 渲染档（真机对比），且天然通过
            // minImageBytes 字节筛选；每组建最多领 1 个（多图按点击序
            // 对应组序），读后即删
            if (originalsExpected) {
                const originals = this._consumeOriginalDataUrls(sinceTs, 1);
                if (originals.length) candidates.unshift(...originals);
            }
            // blob 组（站点用 blob: 渲染生成图且加载后回收，如 Gemini）：
            //   a. 先认领开始批次里无人认领的捕获（就是本回合的生成图字节）；
            //   b. 再短等（≤8s）reveal 触发、尚未落网的新捕获——原图响应
            //      有网络延迟，固定时刻快照永远赶不上（真机踩坑×3）
            if (candidates.every((u) => u.startsWith('blob:')) &&
                typeof adapter.isContentImageUrl === 'function') {
                if (unclaimedCaptures.length) {
                    // 最多认领 4 条（体积降序在前）：内容签名去重已兜住同图
                    // 重复，4 个候选足够像素择优；全量认领会串行下载十几个
                    // 同图副本，交付动辄多等几十秒（真机优化）
                    candidates.push(...unclaimedCaptures.splice(0, 4).map((m) => m.url));
                }
                for (let i = 0; i < 16 && !candidates.some((u) => !u.startsWith('blob:')); i++) {
                    const fresh = consumeContentCaptures();
                    if (fresh.length) {
                        candidates.push(...fresh.map((m) => m.url));
                        break;
                    }
                    await new Promise((r) => setTimeout(r, 500));
                }
                candidates = [...new Set(candidates)];
            }
            try {
                let dataUrl;
                try {
                    dataUrl = await assets.downloadBestImage({ page, urls: candidates, adapter, cookieHeader, referer });
                } catch (firstErr) {
                    // 整组下载失败：现场捞一次内容捕获 + 全部原档重试（原档
                    // 不限时间——之前回合因时序竞态落下的孤儿也一并归还）。
                    // 兜底不能挂在"全部候选是 blob"的偶然条件上——同一站点
                    // 有时提取到回收的 blob、有时只有下载按钮直链（一次性
                    // 签名 + CORS，页面内/后端直连都会失败），而捕获与原档
                    // 是稳定字节源（真机踩坑：候选形态漂移导致兜底失守）
                    const retryUrls = [
                        ...this._consumeOriginalDataUrls(0),
                        ...unclaimedCaptures.splice(0, 4).map((m) => m.url),
                        ...consumeContentCaptures().map((m) => m.url)
                    ];
                    if (!retryUrls.length) throw firstErr;
                    console.log(`[WebBridge] 候选全失败，现场捞 ${retryUrls.length} 条内容捕获重试`);
                    dataUrl = await assets.downloadBestImage({ page, urls: [...new Set(retryUrls)], adapter, cookieHeader, referer });
                }
                // 去重：精确内容重复 + 近似重复（同图多尺寸 CDN 变体的
                // URL 不同但像素同源，适配器 URL 去重兜不住的在这里收尾）
                if (seenDataUrls.has(dataUrl)) continue;
                const sig = await assets.imageSignature(dataUrl);
                if (sig && imageSigs.some((s) => assets.sigMeanDiff(sig, s) < 3)) continue;
                seenDataUrls.add(dataUrl);
                if (sig) imageSigs.push(sig);
                images.push(dataUrl);
                this._deliveredImageBaseKeys.add(baseKey);   // 登记已交付，假信号预检据此识别新图
                // 落画布（与 /api/receive-image 的 image 字段同格式的裸 base64
                // 由路由层从 dataUrl 剥前缀）
                this.emit({ type: 'asset_image', dataUrl, prompt: { positive: text } });
            } catch (err) {
                console.warn('[WebBridge] 图片转存失败:', err.message);
                assetErrors.push(`图片下载失败（${baseKey.slice(0, 80)}）：${err.message}`);
            }
        }

        // ---- 视频：DOM 直链优先，网络捕获兜底 ----
        // 本轮可消费的捕获 = 不早于 sinceTs（回合/看护起点或最近交付时刻）
        // 且从未交付过；捕获可能比交付慢半拍（播放器加载视频有延迟）：
        // 最多等 8s 再定论。所有来源统一按路径主体去重 + 已交付键过滤
        //（跨交付硬防线，见 _deliveredVideoKeys）
        let videoUrls = dedupeVideoUrls(assetReply.videoUrls)
            .filter((u) => !this._deliveredVideoKeys.has(videoKeyOf(u)));
        const eligibleVideoCaptures = () => this._mediaCapture.filter((m) =>
            m.at >= sinceTs && !this._deliveredVideoKeys.has(videoKeyOf(m.url)));
        // 只在回复块里真的有视频卡时才等捕获落网（豆包：视频卡在 DOM、
        // 播放器加载慢，捕获晚半拍）。无条件等会让纯图交付凭空多 8s——
        // asset_image 已落画布、message_end 还没发，面板转圈不同步
        //（真机踩坑）。没有视频卡的站点晚到视频由页面巡逻兜底补交付
        if (!videoUrls.length && (assetReply.videoCardCount || 0) > 0) {
            for (let i = 0; i < 8 && !eligibleVideoCaptures().length; i++) {
                await new Promise((r) => setTimeout(r, 1000));
            }
        }
        const freshVideoCaptures = eligibleVideoCaptures();
        if (!videoUrls.length && freshVideoCaptures.length) {
            videoUrls = dedupeVideoUrls(freshVideoCaptures.map((m) => m.url));
            console.log(`[WebBridge] DOM 无视频地址，使用网络捕获兜底（${videoUrls.length} 个）`);
        }
        const okVideoKeys = new Set();
        for (const url of videoUrls) {
            try {
                const { fileBase } = await assets.downloadVideoToFile({
                    url, cookieHeader, referer,
                    dir: path.join(this.dataDir, 'videos')
                });
                const videoPath = `data/videos/${fileBase}`;
                videos.push(videoPath);
                const key = videoKeyOf(url);
                okVideoKeys.add(key);
                // 登记已交付（跨交付去重）：后续重签名触发的重复交付
                // 会被预检和过滤直接挡掉
                this._deliveredVideoKeys.add(key);
                if (this._deliveredVideoKeys.size > 100) {
                    this._deliveredVideoKeys.delete(this._deliveredVideoKeys.keys().next().value);
                }
                this.emit({ type: 'asset_video', videoPath, prompt: { positive: text } });
            } catch (err) {
                console.warn('[WebBridge] 视频转存失败:', err.message);
                assetErrors.push(`视频下载失败：${err.message}`);
            }
        }
        // 已消费的捕获在成功交付后才淘汰（下载失败的保留在缓冲里，
        // 补交付可重试——CDN 签名 URL 有时效，宜尽快重试）。按路径主体
        // 比对淘汰：同视频的其他签名变体一并清掉，避免下次补交付
        // 把同一视频再交付一遍
        const consumedVideoKeys = new Set([
            ...okVideoKeys,
            ...(videos.length ? freshVideoCaptures.map((m) => videoKeyOf(m.url)) : [])
        ]);
        this._mediaCapture = this._mediaCapture.filter((m) => !consumedVideoKeys.has(videoKeyOf(m.url)));

        console.log(`[WebBridge] 交付: 文本${text.length}字 图片${images.length} 视频${videos.length}${assetErrors.length ? ' 异常' + assetErrors.length : ''}`);
        this._lastDeliveredText = text;   // 更新交付基线（看护补交付的比对基准）
        this._lastDeliveredVSig = videoSigOf(assetReply);   // 视频签名基线：已交付的视频不再触发补交付
        this._lastDeliveredContentKey = contentKeyOf({ text, ...assetReply });   // 内容键基线（含已交付的图片/视频）
        this._lastDeliverAt = Date.now();   // 捕获资格基准推进：下次交付只消费此后新捕获
        this.emit({
            type: 'message_end',
            site: adapter.id,
            text,
            suggestions,
            images,       // data URL（面板气泡展示用）
            videos,       // data/videos/ 相对路径
            assetErrors   // 转存失败说明（面板明示，不再静默丢图）
        });
    }

    /** 当前页面的 Cookie 请求头值（页面未就绪时返回空串） */
    async _cookieHeader() {
        try {
            const cookies = this.page && !this.page.isClosed() ? await this.page.cookies() : [];
            return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        } catch {
            return '';
        }
    }
}

module.exports = WebBridgeManager;

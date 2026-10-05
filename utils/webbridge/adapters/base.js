/**
 * ==========================================================================
 * LumenLight 网页桥接：站点适配器契约与共享页内工具（base）
 * ==========================================================================
 * 定义"网页桥接模式"对目标网站的适配契约。每个站点一个适配器文件
 * （如 doubao.js），只做该站点的页面操作与内容提取，不含任何
 * 连接管理/消息路由逻辑——那些都在 WebBridgeManager 里。
 * 新增站点 = 新建一个适配器文件并在 index.js 登记一行。
 *
 * 管理器对适配器的调用时序（一轮对话）：
 *   1. ensurePage：按 urlPattern 找已有标签页，找不到就 newPage + goto homeUrl
 *   2. sendMessage(page, { text, images, imagePaths })：注入文本（尽力附带
 *      图片）并触发发送
 *   3. 轮询 isGenerating / detectTask / extractReply（turnWatcher 状态机）
 *   4. 回合收尾：revealVideos（可选，触发视频加载）→ extractReply 最新快照
 *      → 资源经 assets.js 下载转存 → 事件回流
 *
 * 设计要点：
 *   - 内容捕获以 DOM 提取为主（stable-polling），网络层拦截（captureRules，
 *     预留）作为适配器可选增强，二者并存；
 *   - 所有选择器都写成"候选数组"（按序试第一个命中的），站点改版时
 *     修适配器文件里的候选清单即可，不动框架；
 *   - 页内求值代码需要跨方法共享的部分（如"找最新回复块"）以函数源码
 *     字符串形式由本模块提供（puppeteer evaluate 不能带闭包，只能嵌源码）；
 *   - 适配器方法一律以 page（puppeteer Page）为第一参数，自身无状态，
 *     并发与生命周期由管理器独占管理（一个站点同一时刻至多一个回合）。
 * ==========================================================================
 */

/**
 * 适配器契约（JSDoc 结构说明，运行时由各适配器文件直接导出对象）：
 *
 * @typedef {Object} WebBridgeAdapter
 * @property {string} id            站点唯一标识（存 settings.json webbridge.activeSite）
 * @property {string} name          站点显示名（面板/设置界面用）
 * @property {string} homeUrl       首次打开的页面地址（对话入口）
 * @property {RegExp|string} urlPattern  判定某标签页属于本站点的 URL 匹配
 * @property {boolean} [ready]      false = 框架就绪但适配器尚未校准（设置界面置灰提示）
 *
 * @property {(page: Object) => Promise<Object|null>} findInput
 *      定位输入框元素句柄；找不到返回 null（管理器报"输入框未找到"）
 * @property {(page: Object, msg: {text: string, images: string[], imagePaths?: string[]}) => Promise<void>} sendMessage
 *      注入消息并触发发送。imagePaths 为附件图片的磁盘路径（管理器从
 *      data URL 暂存，供 uploadFile 原生注入——站点上传管线最认的方式）；
 *      images 为 data URL，仅在无可用文件输入时作合成 paste 兜底。
 *      附件注入失败可降级为纯文本（不得抛错中断文本发送）
 * @property {(page: Object) => Promise<boolean>} isGenerating
 *      站点是否仍在生成（如"停止生成"按钮存在）。无法判定时返回 false，
 *      由 turnWatcher 的"文本稳定"判定兜底
 * @property {(page: Object) => Promise<{text: string, suggestions: string[], imageUrls: string[], videoUrls: string[]}|null>} extractReply
 *      提取最新一条回复：纯文本 + 推荐追问（站点给出的可续问选项，
 *      面板渲染为可点击胶囊，不混入正文）+ 资源 URL 清单。
 *      还没有回复块时返回 null；文本始终返回"最新完整文本"
 *      （turnWatcher 做稳定判定与去重，不做增量拼接）。
 *      注意：videoUrls 只收 http(s) 直链——MSE 播放器的 blob: 地址
 *      节点无法 fetch，且会阻塞管理器的网络捕获兜底
 * @property {Array} [captureRules] 预留：网络层捕获规则（暂无站点使用）
 * @property {(page: Object) => Promise<{active: boolean, text: string}>} [detectTask]
 *      可选：站点是否在进行生图/生视频等长任务（骨架屏/进度条检测）。
 *      turnWatcher 在有任务期间不进入"文本稳定完成"判定，并把 text 经
 *      task_progress 事件推给面板渲染进度行。未实现时按无任务处理
 * @property {(url: string) => string[]} [imageVariants]
 *      可选：图片原图候选清单（回复块 <img> 常是缩略变体，CDN 模板段
 *      剥掉即原图地址）。管理器逐候选下载并按实际像素取最大者，
 *      失败候选自动跳过。未实现时按原 URL 单候选处理
 * @property {(page: Object) => Promise<boolean>} [revealVideos]
 *      可选：触发视频加载。聊天里的视频常是自定义播放卡（点击前无
 *      <video> 元素），此方法模拟点击并在拿到视频地址后静音暂停。
 *      管理器在交付环节调用，失败不阻塞
 * @property {(page: Object) => Promise<boolean>} [revealImages]
 *      可选：触发大图加载。回复块里的 <img> 常是缩略变体且 CDN 签名
 *      使剥离模板的猜测失效，此方法模拟点击图片打开大图预览（页面
 *      请求的原始尺寸 URL 由管理器的网络捕获钩子记下）。交付环节调用
 * @property {(page: Object) => Promise<void>} [stopGeneration]
 *      可选：尽力点击站点的"停止生成"按钮（与发送按钮同位互换的场景
 *      把发送候选一并试掉）。管理器 abort 接口调用
 */

/**
 * 页内共享：定位"最新一条回复块"。
 * 先按回复块候选取最后一个匹配块；全部落空时退化为启发式——
 * 取消息列表最后一个非用户消息的子块。
 * puppeteer 的 evaluate 无法携带闭包，跨方法共享的页内逻辑以函数源码
 * 字符串提供，适配器在构造 evaluate 求值体时嵌入（见 doubao.js）
 * @returns {string} 可嵌入 evaluate 源码的函数字面量
 */
function findReplyBlockSource() {
    return `(function findReplyBlock(replySels, listSels, userSels) {
        let block = null;
        for (const sel of replySels) {
            try {
                const nodes = document.querySelectorAll(sel);
                if (nodes.length) { block = nodes[nodes.length - 1]; break; }
            } catch (e) { /* 非法选择器跳过 */ }
        }
        if (!block) {
            for (const sel of listSels) {
                try {
                    const list = document.querySelector(sel);
                    if (!list) continue;
                    const kids = Array.from(list.children).filter((k) => (k.innerText || '').trim());
                    for (let i = kids.length - 1; i >= 0; i--) {
                        const isUser = userSels.some((us) => {
                            try { return !!kids[i].querySelector(us); } catch (e2) { return false; }
                        });
                        if (!isUser) { block = kids[i]; break; }
                    }
                    if (block) break;
                } catch (e3) { /* 跳过 */ }
            }
        }
        return block;
    })`;
}

/**
 * 文件输入 accept 清单是否放行图片附件（跨站点通用的纯函数）。
 * accept 形态不一：MIME（image/*）、扩展名清单（.png,.jpg）、混合——
 * 只有"明确列出且不含任何图片类型"才拒绝，空值放行
 * @param {string} accept - input 元素的 accept 属性（小写）
 * @returns {boolean}
 */
function acceptAllowsImages(accept) {
    const a = String(accept || '').toLowerCase();
    if (!a) return true;                            // 未声明：放行
    if (a.includes('image')) return true;
    if (a === '*' || a.includes('*/*')) return true;   // 接受一切（video/* 不是！）
    if (/\.(png|jpe?g|webp|gif|bmp|avif)/.test(a)) return true;   // 扩展名清单含图片
    return false;                                   // 明确只收其他类型（pdf/doc 等）
}

module.exports = { findReplyBlockSource, acceptAllowsImages };

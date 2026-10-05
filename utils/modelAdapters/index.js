/**
 * ==========================================================================
 * 模型协议适配器注册表（modelAdapters）
 * ==========================================================================
 * 作用：把"某个模型家族走什么协议、参数怎么映射、结果怎么提取"收敛成
 *       一个个独立适配器，路由层（routes/llm.js）退化为薄调度器。
 *       接入新的模型家族（未来的视频模型等）= 新增一个适配器文件并
 *       注册到下方的 adapters 数组，路由层零改动。
 *
 * 适配器接口约定：
 *   id    - 适配器标识（日志与调试用）
 *   mode  - 执行模式：'sync'（一次请求等结果）
 *           预留 'task'（异步任务：提交拿 taskId → 轮询取结果，视频模型用）
 *   match(context) → boolean
 *           是否命中本适配器；context: { model, imageList }
 *   run(request) → Promise<{ imageSrc: string, reply?: string }>
 *           执行生成并提取结果；request: { model, prompt, size, quality,
 *           images, provider: { name, config }, signal }
 *           signal 为可选 AbortSignal（客户端取消生图时中止上游请求），
 *           适配器必须透传给底层请求函数。
 *           失败时抛出带可读 message 的 Error（路由层原样回传前端）。
 *
 * 注册顺序即匹配优先级，兜底适配器（generations-image）必须放最后。
 * 模型家族识别与参数映射的纯函数仍集中在 utils/llmModelRules.js，
 * 适配器只负责编排，不重复实现识别逻辑。
 * ==========================================================================
 */

const editsImageAdapter = require('./editsImageAdapter');
const chatImageAdapter = require('./chatImageAdapter');
const generationsImageAdapter = require('./generationsImageAdapter');

// 顺序即优先级：edits / chat 是按模型家族精确匹配的，
// generations 是永远命中的兜底，必须保持在末位
const adapters = [
    editsImageAdapter,
    chatImageAdapter,
    generationsImageAdapter
];

/**
 * 按模型与请求形态挑选适配器
 * @param {Object} context - { model, imageList }
 * @returns {Object} 命中的适配器（保证总有返回）
 */
function pickImageAdapter(context) {
    for (const adapter of adapters) {
        if (adapter.match(context)) return adapter;
    }
    return generationsImageAdapter;
}

module.exports = { pickImageAdapter, adapters };

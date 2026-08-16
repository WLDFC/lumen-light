/**
 * ==========================================================================
 * LumenLight 生图节点管线（ImagePipeline）
 * ==========================================================================
 * 作用：从 ImageGenNode 拆出的图生图数据收集模块，职责单一——
 *       沿画布连线向上游遍历，收集提示词文本与参考图并转换为 API 所需格式。
 *       纯数据层：不碰 DOM、不依赖节点实例，只依赖传入的连线数组与
 *       画布对象数组（images.images），可独立测试与复用。
 *
 * 收集规则（连线链路）：
 *   画布图片(可多级串联) → 提示词节点(可多级串联) → [LoRA 节点(文本透传，
 *   收集其堆栈)] → 生图节点
 *   - 提示词：整条链上所有提示词节点的文本合并，节点之间空一行、拼接处
 *     自动补逗号（规则见 PromptMerge，区分中英文），按"离生图节点由远到近"
 *     排序（数据流方向：源头在前）
 *   - 参考图：连入生图节点或链上任意提示词节点的画布图片，
 *     命中后继续沿图片串联链向上游遍历，链上图片一并收入
 * ==========================================================================
 */
class ImagePipeline {
    /**
     * @param {Object[]} connections - 画布连线数组 [{ fromId, toId, ... }]
     * @param {Object[]} images - 画布对象数组（含图片、提示词节点、生图节点）
     */
    constructor(connections, images) {
        this.connections = connections;
        this.images = images;
    }

    /**
     * 按 id 查找画布对象
     * @param {string} id - 对象 id
     * @returns {Object|undefined}
     */
    findById(id) {
        return this.images.find(img => img.id === id);
    }

    /**
     * 判断对象是否为可作为参考图的真实画布图片。
     * 判定规则已上收到全局 NodeTypes.isRealCanvasImage（与提示词节点
     * 参考图缩略图共用同一份），此处仅保留原静态方法签名作兼容入口
     * @param {Object} obj - 画布对象
     * @returns {boolean}
     */
    static isCanvasImage(obj) {
        return NodeTypes.isRealCanvasImage(obj);
    }

    /**
     * 沿连线向上游遍历整条提示词链（含直接连入生图节点的提示词节点）。
     * LoRA 节点是文本透传节点：既参与遍历（其上游的提示词继续收集），
     * 也作为堆栈载体被 collectLoras 收集。
     *
     * 遍历策略：从生图节点出发逐层向上（BFS），第 0 层为直接连入的
     * 提示词节点，第 1 层为连入第 0 层的提示词节点，以此类推。
     * 输出按"离生图节点由远到近"排序（数据流方向：源头在前，末端在后），
     * 同层按连线创建顺序排列；visited 集合去重并防止环状连线死循环。
     *
     * @param {string} nodeId - 生图节点 id
     * @returns {Object[]} 提示词节点数组（无上游提示词时为空数组）
     */
    collectUpstreamPromptNodes(nodeId) {
        const levels = [];              // levels[i] = 第 i 层的提示词节点数组
        const visited = new Set([nodeId]);
        let frontier = [nodeId];        // 当前层的"接收方"节点 id
        while (frontier.length) {
            const next = [];
            for (const toId of frontier) {
                for (const c of this.connections) {
                    if (c.toId !== toId || visited.has(c.fromId)) continue;
                    const from = this.findById(c.fromId);
                    // 提示词节点与 LoRA 节点都是可穿过的链上节点
                    if (!from || !(NodeTypes.isPromptNode(from.source) ||
                                   NodeTypes.isLoraNode(from.source))) continue;
                    visited.add(c.fromId);
                    next.push(from);
                }
            }
            if (next.length) levels.push(next);
            frontier = next.map(n => n.id);
        }
        // 层级反转：最上游（离生图节点最远）的提示词排在最前
        return levels.reverse().flat();
    }

    /**
     * 收集整条提示词链的文本并合并
     * 节点文本交给 PromptMerge.join 统一处理：段间空行 + 拼接处自动补
     * 逗号（区分中英文），按"离生图节点由远到近"排序。
     * @param {string} nodeId - 生图节点 id
     * @returns {string} 拼接后的提示词（无可用提示词时为空串）
     */
    collectPrompt(nodeId) {
        return PromptMerge.join(
            this.collectUpstreamPromptNodes(nodeId).map(n => (n.text || ''))
        );
    }

    /**
     * 收集链路上全部 LoRA 节点的堆栈（按"离生图节点由远到近"排序 = 应用顺序，
     * 后应用的叠加在前应用的上面）。只收启用且有文件的条目。
     * @param {string} nodeId - 生图节点 id
     * @returns {Array<{file: string, strengthModel: number, strengthClip: number}>}
     */
    collectLoras(nodeId) {
        const loras = [];
        for (const node of this.collectUpstreamPromptNodes(nodeId)) {
            if (!NodeTypes.isLoraNode(node.source)) continue;
            if (typeof node.getEnabledLoras !== 'function') continue;
            loras.push(...node.getEnabledLoras());
        }
        return loras;
    }

    /**
     * 收集参考图（图生图 I2I）：连入整条提示词链上任意节点（含生图节点）的画布图片。
     * 命中后继续沿图片串联链（图片1 → 图片2）向上游遍历，链上图片一并收入。
     * @param {string} nodeId - 生图节点 id
     * @returns {Promise<string[]>} base64 data URL 数组（转换失败的图片跳过并打印日志）
     */
    async collectImages(nodeId) {
        // 待收集的接收方节点集合：生图节点 + 整条上游提示词链
        const upstreamIds = new Set(
            [nodeId, ...this.collectUpstreamPromptNodes(nodeId).map(n => n.id)]
        );

        // 从上述节点的连入连线中收集画布图片；命中后继续沿图片串联链
        // 向上游遍历，把链上所有图片一并收入
        const srcList = [];
        const seen = new Set();
        const queue = [];               // 待向上游遍历的图片对象
        for (const c of this.connections) {
            if (!upstreamIds.has(c.toId)) continue;
            const from = this.findById(c.fromId);
            if (!ImagePipeline.isCanvasImage(from) || seen.has(from.id)) continue;
            seen.add(from.id);
            queue.push(from);
        }
        while (queue.length) {
            const img = queue.shift();
            srcList.push(img.img.src);
            // 图片串联：连入当前图片的上游图片同样作为参考图
            for (const c of this.connections) {
                if (c.toId !== img.id || seen.has(c.fromId)) continue;
                const from = this.findById(c.fromId);
                if (!ImagePipeline.isCanvasImage(from)) continue;
                seen.add(from.id);
                queue.push(from);
            }
        }
        if (srcList.length === 0) return [];

        // 并发转换为 base64 data URL
        const results = await Promise.all(srcList.map((src) => ImagePipeline.imageToDataUrl(src)));
        return results.filter(Boolean);
    }

    /**
     * 将图片地址转为 base64 data URL（策略与 LlmAttachments.addImageUrl 一致）：
     *   - data URL：直接使用
     *   - 本站地址（画布本地图片）：直接 fetch 转 base64
     *   - 第三方远程地址（如 API 返回的 CDN 图）：走后端代理 /api/llm/download-image 避免 CORS
     * @param {string} src - 图片地址
     * @returns {Promise<string|null>} data URL，失败时返回 null
     */
    static async imageToDataUrl(src) {
        if (!src) return null;
        if (src.startsWith('data:')) return src;
        try {
            let fetchUrl = src;
            if (/^https?:\/\//i.test(src) && !src.startsWith(location.origin)) {
                fetchUrl = `/api/llm/download-image?url=${encodeURIComponent(src)}`;
            }
            const res = await fetch(fetchUrl);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const blob = await res.blob();
            return await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => resolve(e.target.result);
                reader.onerror = () => reject(new Error('FileReader 读取失败'));
                reader.readAsDataURL(blob);
            });
        } catch (err) {
            console.error('生图节点参考图转 base64 失败，已跳过该图:', err);
            return null;
        }
    }
}

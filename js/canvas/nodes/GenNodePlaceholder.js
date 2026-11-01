/**
 * ==========================================================================
 * GenNodePlaceholder — 出图节点占位图生命周期混入（ADR 053）
 * ==========================================================================
 * 作用：API 生图 / Comfy 生图 / RunningHub 三类节点的占位图生命周期
 *       （创建→替换→兜底落图）原先是三份逐行近似的拷贝（仅 source 标记、
 *       附件命名前缀、输入格式三处不同），契约修复要修三遍。收敛到这里
 *       后，节点差异全部变成类上的静态配置：
 *         PLACEHOLDER_SOURCE      占位图回图的 source 标记（如 'comfy'）
 *         PLACEHOLDER_NAME_PREFIX 回图文件名前缀（如 'comfy_gen'）
 *         PLACEHOLDER_INPUT       'base64'（Comfy/RunningHub 传 PNG 裸
 *                                 base64，内部拼 data URL）| 'url'（API
 *                                 生图传现成地址）
 *         PLACEHOLDER_GAP / PLACEHOLDER_CASCADE  几何常量（已有，沿用）
 *
 * 契约：原型混入（partial-class，ADR 026 同款）——各节点文件在类定义后
 *       Object.assign(<NodeClass>.prototype, GenNodePlaceholder)，this 即
 *       节点实例；须先于节点文件加载。VideoGenNode 不混入：其占位框按
 *       宽高比计算、无级联、回流走视频链路（ADR 044），与出图节点是真实
 *       差异。占位图本体管理在 PlaceholderManager（window.placeholder-
 *       Manager），本混入只做节点侧编排。
 * 错误策略：replacePlaceholder 不吞错误——await 的调用方（API 生图）靠它
 *       把落图失败计入结果统计；不 await 的调用方（Comfy/RunningHub）
 *       在各自调用点 .catch 防未处理 rejection。
 * ==========================================================================
 */

const GenNodePlaceholder = {

    /**
     * 在节点右侧创建生成占位图（创建/动画统一交给全局占位图管理器）
     * @param {{width: number, height: number}|null} res - 生成尺寸（auto 时为 null）
     * @param {number} [index] - 多张生成时的序号（沿对角线级联偏移，避免相互遮挡）
     * @returns {Object} 占位图句柄
     */
    createPlaceholder(res, index = 0) {
        const width = res ? res.width : 1024;
        const height = res ? res.height : 1024;

        // 位置：节点右侧留出间距，垂直居中；多张生成时沿对角线级联
        const cascade = index * this.constructor.PLACEHOLDER_CASCADE;
        const x = this.x + this.width + this.constructor.PLACEHOLDER_GAP + cascade;
        const y = this.y + this.height / 2 - height / 2 + cascade;

        return window.placeholderManager.create(this, { x, y, width, height });
    },

    /**
     * 移除占位图（生成失败 / 节点销毁时调用），委托全局占位图管理器
     * @param {Object} [target] - 要移除的占位图句柄；缺省时移除本节点全部占位图
     */
    removePlaceholder(target) {
        if (target) {
            window.placeholderManager.remove(target);
        } else {
            window.placeholderManager.removeAll(this);
        }
    },

    /**
     * 用真实生成图片替换占位图：委托全局管理器按占位图中心、原始尺寸落图
     * @param {Object} placeholder - 占位图句柄
     * @param {string} raw - 生成图片地址（PLACEHOLDER_INPUT='url'）或
     *                       PNG 裸 base64（'base64'，内部拼 data URL 前缀）
     * @param {string} prompt - 生成时使用的提示词
     * @param {string} [negativePrompt] - 生成时使用的负面提示词（无则空串）
     * @returns {Promise<Object>} 落图后的真实图片对象
     */
    replacePlaceholder(placeholder, raw, prompt, negativePrompt) {
        const C = this.constructor;
        const imageUrl = C.PLACEHOLDER_INPUT === 'base64'
            ? 'data:image/png;base64,' + raw
            : raw;
        return window.placeholderManager.replace(placeholder, imageUrl, {
            name: `${C.PLACEHOLDER_NAME_PREFIX}_${Date.now()}.png`,
            source: C.PLACEHOLDER_SOURCE,
            prompt: prompt || '',
            negativePrompt: negativePrompt || '',
            genInfo: this._activeGenInfo || null
        });
    },

    /**
     * 无占位图可替换时的兜底落图：放在节点右侧空白处（垂直居中）
     * @param {string} raw - 生成图片（base64 输入拼 data URL，url 输入原样）
     * @param {string} prompt - 生成时使用的提示词
     * @param {string} [negativePrompt] - 生成时使用的负面提示词
     */
    _appendImageRightOfNode(raw, prompt, negativePrompt) {
        const C = this.constructor;
        const img = new Image();
        img.onload = () => {
            img.onload = null;
            this.canvas.images.images.push({
                id: LumenLight.generateId(),
                name: `${C.PLACEHOLDER_NAME_PREFIX}_${Date.now()}.png`,
                img: img,
                x: this.x + this.width + C.PLACEHOLDER_GAP,
                y: this.y + this.height / 2 - img.height / 2,
                width: img.width,
                height: img.height,
                selected: false,
                source: C.PLACEHOLDER_SOURCE,
                prompt: prompt || '',
                negativePrompt: negativePrompt || '',
                ...(this._activeGenInfo ? { genInfo: this._activeGenInfo } : {}),
                created: Date.now()
            });
            this.canvas.draw();
        };
        img.src = C.PLACEHOLDER_INPUT === 'base64'
            ? 'data:image/png;base64,' + raw
            : raw;
    }
};

// 暴露到全局作用域（与 NodeTypes 同一约定；节点文件 Object.assign 到各自原型）
window.GenNodePlaceholder = GenNodePlaceholder;

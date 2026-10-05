/**
 * ==========================================================================
 * LumenLight 节点类型注册表（NodeTypes）
 * ==========================================================================
 * 作用：画布对象类型（source 字符串）的唯一定义处。提供类型常量与语义
 *       谓词，画布各层（渲染/命中/连线/交互/剪贴板/存档）一律通过本模块
 *       判断节点类型，禁止再散落 source 字符串比较。
 *
 * 为什么需要：source 判断曾散落在 10 个文件 20+ 处，每新增一种节点类型
 * 都要全项目找一遍补齐（容易漏）。收敛到这里之后，新增节点类型 = 本文件
 * 加一个常量 + 把它归入对应的谓词集合。
 *
 * 类型语义速查：
 *   - 面板节点 isPanelNode：提示词/文本/LoRA/三类生图节点。DOM 元素浮在画布上，
 *     统一走 updateTransform + setSelected 同步、contains 命中、toJSON 存档、
 *     自由宽高缩放；canvas 层跳过绘制
 *   - 端口节点 hasDomPorts：提示词/LoRA/三类生图节点。状态栏有 DOM 端口圆点，
 *     连线锚点与端口坐标取自节点的 getPortPoint()（文本节点无端口）
 *   - LoRA 节点 isLoraNode：可堆叠的 LoRA 组合，左右双端口（文本透传），
 *     右端口只能连向 LoRA/生图节点（作用范围传递）
 *   - 生图节点 isGenNode：三类生图节点。无输出端口、左端口只收提示词、
 *     单入替换规则
 *   - 真实画布图片 isRealCanvasImage：有图像数据的非节点、非占位图对象，
 *     可作为内容/参考图参与连线、显示缩放控制点、入存档
 * ==========================================================================
 */

const NodeTypes = {
    /** 画布对象 source 类型常量（唯一出处，禁止在别处写字面量） */
    SOURCE: {
        PROMPT_NODE: 'prompt-node',
        TEXT_NODE: 'text-node',
        LORA_NODE: 'lora-node',
        IMAGE_GEN_NODE: 'image-gen-node',
        COMFY_GEN_NODE: 'comfy-gen-node',
        RUNHUB_GEN_NODE: 'runhub-gen-node',
        GENERATION_PLACEHOLDER: 'generation-placeholder',
        VIDEO: 'video'
    },

    /** 提示词节点（可串链的合并器） */
    isPromptNode(source) {
        return source === NodeTypes.SOURCE.PROMPT_NODE;
    },

    /** LoRA 节点（可堆叠的 LoRA 组合，文本透传，作用于下游 Comfy 生图） */
    isLoraNode(source) {
        return source === NodeTypes.SOURCE.LORA_NODE;
    },

    /** 文本节点（画布备注，无端口不参与连线） */
    isTextNode(source) {
        return source === NodeTypes.SOURCE.TEXT_NODE;
    },

    /** LLM API 生图节点 */
    isImageGenNode(source) {
        return source === NodeTypes.SOURCE.IMAGE_GEN_NODE;
    },

    /** ComfyUI 工作流生图节点 */
    isComfyGenNode(source) {
        return source === NodeTypes.SOURCE.COMFY_GEN_NODE;
    },

    /** RunningHub 云端工作流生成节点（工作流本体在平台云端） */
    isRunHubGenNode(source) {
        return source === NodeTypes.SOURCE.RUNHUB_GEN_NODE;
    },

    /** 生图节点集合（三类）：无输出端口，左端口单入替换 */
    isGenNode(source) {
        return NodeTypes.isImageGenNode(source) ||
               NodeTypes.isComfyGenNode(source) ||
               NodeTypes.isRunHubGenNode(source);
    },

    /** 面板节点集合：DOM 元素，跳过 canvas 绘制，走节点专属交互/存档链路 */
    isPanelNode(source) {
        return NodeTypes.isPromptNode(source) ||
               NodeTypes.isTextNode(source) ||
               NodeTypes.isLoraNode(source) ||
               NodeTypes.isGenNode(source);
    },

    /** 端口节点集合：状态栏带 DOM 端口圆点，连线锚点取自节点几何 */
    hasDomPorts(source) {
        return NodeTypes.isPromptNode(source) ||
               NodeTypes.isLoraNode(source) ||
               NodeTypes.isGenNode(source);
    },

    /** 生成占位图（生成中的临时动画框，不可选中/连线/入存档） */
    isPlaceholder(source) {
        return source === NodeTypes.SOURCE.GENERATION_PLACEHOLDER;
    },

    /** 视频对象（画布上显示首帧封面，双击播放/暂停） */
    isVideo(source) {
        return source === NodeTypes.SOURCE.VIDEO;
    },

    /**
     * 是否为可作为内容/参考图的真实画布图片：
     * 有图像数据，且不是占位图、不是面板节点
     * （文本/生图节点 img 为 null，天然被排除）
     * @param {Object} obj - 画布对象（图片、节点或占位图）
     * @returns {boolean}
     */
    isRealCanvasImage(obj) {
        return !!obj && !!obj.img && !!obj.img.src &&
            !NodeTypes.isPlaceholder(obj.source) &&
            !NodeTypes.isPanelNode(obj.source);
    }
};

// 将 NodeTypes 暴露到全局作用域
window.NodeTypes = NodeTypes;

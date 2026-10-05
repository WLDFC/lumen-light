/**
 * ==========================================================================
 * LumenLight RunningHub 工作流 JSON 导入解析器（RhWorkflowImporter）
 * ==========================================================================
 * 作用：把 ComfyUI API 格式的工作流 JSON 解析成登记卡的参数映射
 *       （params），替代手工抄写 nodeId/fieldName。两个入口，均调用
 *       RhWorkflowImporter.import(json)：
 *         1. 登记卡「从平台拉取」（首选）：后端代理平台 getJsonApiFormat
 *            拉取云端正在运行的工作流 JSON，天然不存在版本漂移；
 *         2. 「导入本地 JSON」（备用）：选择本地导出的 API 格式文件。
 *
 * 解析规则（与 ComfyParamScanner 同一判定哲学）：
 *   API 格式里连线输入是 [节点id, 槽位] 数组，typeof 检查天然把连线排除，
 *   只有字面值（字符串/数字）才可能被平台 nodeInfoList 覆盖。
 *
 *   1. 图片槽位：LoadImage 系节点的 image 输入 → type:'image'
 *      （提交时后端把连线图片上传平台换 fileName 回填）
 *   2. 提示词：CLIPTextEncode 的 text 输入 → type:'string'；role 由采样器
 *      节点的 positive/negative 连线经 Conditioning 链 BFS 反查确定
 *   3. 通用文本字段：任意节点上的 text/prompt/caption 等文本形态字面
 *      输入 → type:'string'（官方文档确认 nodeInfoList 可覆盖工作流
 *      JSON 中任意字面字段，自定义节点的提示词由此覆盖）
 *   4. 常规标量参数（步数/CFG/采样器/种子/尺寸/模型文件等白名单字段）：
 *      任何节点上的字面值 → type:'string'（平台 fieldValue 统一为字符串）
 *   5. Primitive 系暴露节点（PrimitiveString/PrimitiveInt 等）→ type:'string'
 *
 * 纯函数、不碰 DOM，可独立测试。
 * ==========================================================================
 */

class RhWorkflowImporter {
    /**
     * 常规标量字段白名单 → 中文标签
     * （任何节点上出现这些字面值输入都会成为可调参数行）
     */
    static SCALAR_FIELDS = {
        steps: '步数',
        cfg: 'CFG',
        denoise: '降噪',
        sampler_name: '采样器',
        scheduler: '调度器',
        seed: '种子',
        noise_seed: '种子',
        batch_size: '数量',
        width: '宽度',
        height: '高度',
        length: '视频长度（秒）',
        num_frames: '帧数',
        fps: '帧率',
        ckpt_name: '主模型',
        unet_name: '主模型',
        lora_name: 'LoRA 模型',
        vae_name: 'VAE 模型',
        upscale_model: '放大模型',
        model_name: '模型文件'
    };

    /**
     * 通用文本字段名匹配：任意节点上这些名字的字面字符串输入都视为
     * 可覆盖的文本参数（官方文档确认 nodeInfoList 可覆盖工作流 JSON 中
     * 任意字面字段，自定义节点的提示词输入不属于 CLIPTextEncode /
     * Primitive 时也在此暴露；文件名形态的值仍排除）
     */
    static TEXT_FIELD_RE = /^(text|prompt|positive|negative|positive_prompt|negative_prompt|caption|description|query|instruction|input_text)$/i;

    /** 模型/媒体文件扩展名：命中视为文件选择而非文本，不暴露 */
    static FILE_VALUE_RE = /\.(safetensors|ckpt|pt|pth|bin|gguf|sft|onnx|engine|mp4|mp3|wav|png|jpe?g|webp|gif|zip)$/i;

    /**
     * 解析工作流 JSON → 登记卡 params
     * @param {Object} workflow - ComfyUI API 格式工作流对象
     * @returns {Object} { params: [...] } 成功，或 { error: '原因' } 失败
     */
    static import(workflow) {
        if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
            return { error: '不是 ComfyUI API 格式的工作流 JSON（应为对象，键为节点 id）' };
        }

        // 收集有效节点（键为节点 id，值含 class_type/type）
        const nodeIds = Object.keys(workflow).filter((k) => {
            const n = workflow[k];
            return n && typeof n === 'object' && !Array.isArray(n) &&
                   (n.class_type || n.type);
        });
        if (nodeIds.length === 0) {
            return { error: '未找到任何工作流节点（请确认导出的是 API 格式而非普通格式）' };
        }

        // 反查提示词角色（采样器 positive/negative 连线 → CLIPTextEncode）
        const textRole = RhWorkflowImporter._resolveTextRoles(workflow, nodeIds);

        // 按优先级分桶：图片槽位 > 提示词 > 常规参数
        const imageParams = [];
        const promptParams = [];
        const scalarParams = [];
        const seen = new Set();

        const push = (bucket, nodeId, fieldName, label, type, extra) => {
            const key = `${nodeId}:${fieldName}`;
            if (seen.has(key)) return;
            seen.add(key);
            bucket.push({ nodeId: String(nodeId), fieldName, label, type, ...extra });
        };

        for (const nodeId of nodeIds) {
            const node = workflow[nodeId];
            const classType = String(node.class_type || node.type || '');
            const inputs = node.inputs || {};
            // 输出/保存类节点不暴露参数
            if (/Save|Preview|SendVideo|SendImage|ShowAnything|DisplayAny/i.test(classType)) continue;

            // 1. 图片槽位：LoadImage 系（LoadImage / LoadImageOutput 等）
            if (/LoadImage/i.test(classType) && typeof inputs.image === 'string') {
                push(imageParams, nodeId, 'image', '输入图片', 'image');
                continue;
            }

            // 2. 提示词：CLIPTextEncode 的字面 text
            if (/CLIPTextEncode/i.test(classType) && typeof inputs.text === 'string') {
                const role = textRole.get(String(nodeId));
                if (role === 'prompt') {
                    push(promptParams, nodeId, 'text', '正向提示词', 'string', { role: 'prompt' });
                } else if (role === 'negative') {
                    push(promptParams, nodeId, 'text', '负面提示词', 'string', { role: 'negative' });
                } else {
                    // 不在采样器链上的文本编码（如风格化提示）按普通文本暴露
                    push(promptParams, nodeId, 'text', '文本', 'string');
                }
                continue;
            }

            // 3. Primitive 系暴露节点（工作流作者主动开放的参数）
            if (/^PrimitiveString/i.test(classType) && typeof inputs.text === 'string') {
                push(scalarParams, nodeId, 'text', '文本', 'string');
                continue;
            }
            if (/^Primitive(Int|Float|Boolean)$/.test(classType) && inputs.value !== undefined) {
                push(scalarParams, nodeId, 'value', classType.includes('Int') ? '整数' :
                    classType.includes('Float') ? '小数' : '开关', 'string');
                continue;
            }

            // 4. 通用文本字段：任意节点上的提示词形态字面字符串
            for (const [field, value] of Object.entries(inputs)) {
                if (typeof value !== 'string' || !value.trim()) continue;
                if (!RhWorkflowImporter.TEXT_FIELD_RE.test(field)) continue;
                if (RhWorkflowImporter.FILE_VALUE_RE.test(value)) continue;
                const role = /^negative/i.test(field) ? 'negative'
                    : /^(positive|prompt)$/i.test(field) ? 'prompt' : undefined;
                push(scalarParams, nodeId, field,
                    role === 'negative' ? '负面提示词' :
                    role === 'prompt' ? '提示词' : `文本（${field}）`,
                    'string', role ? { role } : undefined);
            }

            // 5. 常规标量白名单字段（采样器/加载器/尺寸等任意节点上的字面值）。
            //    白名单不含 text/prompt 等文本字段（那些由规则 4 的通用文本
            //    字段处理并自动带 role），此处无需再判角色
            for (const field of Object.keys(RhWorkflowImporter.SCALAR_FIELDS)) {
                const v = inputs[field];
                if (typeof v !== 'string' && typeof v !== 'number') continue;
                push(scalarParams, nodeId, field, RhWorkflowImporter.SCALAR_FIELDS[field], 'string');
            }
        }

        const params = [...imageParams, ...promptParams, ...scalarParams];
        if (params.length === 0) {
            return { error: '未从工作流中解析出可调参数（没有字面值的图片输入/文本/白名单字段）' };
        }
        return { params };
    }

    /**
     * 反查 CLIPTextEncode 的提示词角色：从每个采样器类节点的 positive /
     * negative 连线输入出发，沿 Conditioning 系节点 BFS 向上游遍历，
     * 命中的第一个 CLIPTextEncode 标记为对应角色
     * @param {Object} workflow - 工作流对象
     * @param {string[]} nodeIds - 有效节点 id 列表
     * @returns {Map<string, 'prompt'|'negative'>} 节点id → 角色
     */
    static _resolveTextRoles(workflow, nodeIds) {
        const roleByNode = new Map();
        const idSet = new Set(nodeIds);

        for (const id of nodeIds) {
            const inputs = workflow[id].inputs || {};
            for (const [field, role] of [['positive', 'prompt'], ['negative', 'negative']]) {
                const link = inputs[field];
                if (!Array.isArray(link) || !link.length) continue;
                const start = String(link[0]);
                if (!idSet.has(start)) continue;

                // BFS：只穿过 Conditioning 系中间节点（ZeroOut/Combine 等）
                const queue = [start];
                const visited = new Set();
                while (queue.length) {
                    const nid = queue.shift();
                    if (visited.has(nid)) continue;
                    visited.add(nid);
                    const n = workflow[nid];
                    if (!n) continue;
                    const ct = String(n.class_type || n.type || '');
                    if (/CLIPTextEncode/i.test(ct)) {
                        // 先到先得：两个采样器共用同一编码时不重复登记
                        if (!roleByNode.has(nid)) roleByNode.set(nid, role);
                        continue;
                    }
                    if (/Conditioning/i.test(ct)) {
                        for (const v of Object.values(n.inputs || {})) {
                            if (Array.isArray(v) && v.length && idSet.has(String(v[0]))) {
                                queue.push(String(v[0]));
                            }
                        }
                    }
                }
            }
        }
        return roleByNode;
    }
}

// 暴露到全局作用域（浏览器端经典脚本，设置面板调用）
window.RhWorkflowImporter = RhWorkflowImporter;

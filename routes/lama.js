/**
 * ==========================================================================
 * LumenLight 本地物体移除路由模块（LaMa inpainting）
 * 作用：提供 /api/lama/remove 接口，使用 onnxruntime-node 在本地运行
 *       LaMa（big-lama 的 ONNX 导出版）模型，接收原图 + 遮罩，
 *       将遮罩标记的区域抹除并用周边内容智能填充，返回处理后的 PNG。
 *
 * 模型：Carve/LaMa-ONNX 的 lama_fp32.onnx（官方推荐导出版，opset 17）
 *       存放目录 models/lama/，固定输入 512x512。
 *       规格参考 Carve 官方 demo 与 gemini-dewatermark 的实现：
 *         - 输入 image [1,3,512,512] float32，像素归一化到 [0,1]
 *         - 输入 mask  [1,1,512,512] float32，二值 {0,1}，1 = 待填补区域
 *         - 输出 [1,3,512,512]，量程实测 [0,255]（非 [0,1]，勿乘 255）
 *
 * 处理流程（v4，bbox 裁剪 + 等比 pad + refiner 二次细化）：
 *   1. 遮罩取 alpha 二值化，算包围盒并外扩 25% 上下文边距（IOPaint
 *      同款策略）——模型只看"物体周边"这一小块，有效分辨率从
 *      "整图÷512" 提升到 "遮罩区÷512"，消除全图压缩的模糊感；
 *   2. bbox 裁剪区【等比缩放】到 512 内再镜像 pad 补齐（v4 改进：
 *      旧版 fit:fill 硬拉伸会让非正方形 bbox 内容变形，填充纹理
 *      方向错乱）→ 推理 → 裁掉 pad 区拉回原生尺寸；
 *   3. refiner 二次细化（LaMa 官方推理策略）：从第一遍填充结果里
 *      再裁一个紧贴遮罩（10% 边距）的小区域做第二遍推理——洞在
 *      512 输入里占比更大，纹理重建更细；只取洞内羽化结果。
 *      bbox 已经很小时（细化收益 <1.25 倍）自动跳过，省一半耗时；
 *   4. 以羽化遮罩为 alpha 把 bbox 内填充结果贴回原图（软边过渡）。
 *   （v2 曾试过噪点匹配注入，实测让填充区更糙已移除）
 * ==========================================================================
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

// onnxruntime-node 体积较大，懒加载：首次调用推理接口时才 require
let ort = null;

/** 模型文件路径 */
const MODEL_PATH = path.join(__dirname, '..', 'models', 'lama', 'lama_fp32.onnx');

/** 模型固定输入尺寸 */
const INPUT_SIZE = 512;

/** bbox 外扩边距比例（相对 bbox 尺寸），给模型留周边上下文 */
const CONTEXT_MARGIN = 0.25;

/** refiner 紧凑裁剪边距比例（相对遮罩 bbox 尺寸） */
const REFINE_MARGIN = 0.10;

/**
 * 已加载的推理会话缓存（Promise，防止并发首次请求重复加载模型）
 */
let sessionPromise = null;

/**
 * 推理串行队列：session.run 不保证并发安全（DML 后端尤甚），
 * 用 Promise 链把请求排队执行
 */
let inferenceQueue = Promise.resolve();

/**
 * 获取推理会话（首次加载约 2~7 秒，之后常驻复用）
 */
function getSession() {
    if (sessionPromise) return sessionPromise;

    sessionPromise = (async () => {
        if (!fs.existsSync(MODEL_PATH)) {
            throw new Error('LaMa 模型未下载：缺少 models/lama/lama_fp32.onnx');
        }
        if (!ort) {
            ort = require('onnxruntime-node');
        }
        // 固定 CPU 后端：LaMa 的 FFT（rfft/irfft）算子与 Windows DML 执行
        // 提供者不兼容——session 创建能成功，但 run 时在 FFC 模块的
        // MatMul 节点上崩溃（E_INVALIDARG），因此不能像 rembg 那样
        // dml 优先。CPU 上 512x512 单次推理约 2.4~3 秒，首次加载约 13 秒
        // （懒加载：首次调用接口时才触发，之后 session 常驻复用）
        const session = await ort.InferenceSession.create(MODEL_PATH, {
            executionProviders: ['cpu'],
            graphOptimizationLevel: 'all',
            logSeverityLevel: 3,
            severityLevel: 3
        });
        console.log('[lama] 模型已加载，后端: cpu');
        return { session, provider: 'cpu' };
    })();

    // 加载失败时清除缓存，否则一次失败让接口永久不可用
    sessionPromise.catch(() => { sessionPromise = null; });
    return sessionPromise;
}

/** 从 data URL / 纯 base64 中剥离前缀 */
function stripDataUrl(s) {
    return String(s).replace(/^data:image\/\w+;base64,/, '');
}

/**
 * 计算二值遮罩的包围盒，外扩边距后钳制到图像范围。
 * @param {Float32Array} maskBin - 二值遮罩（0/1）
 * @param {number} w - 图像宽
 * @param {number} h - 图像高
 * @param {number} marginRatio - 外扩边距比例
 * @param {number} minMargin - 最小外扩像素
 * @returns {{x0:number,y0:number,x1:number,y1:number}} 钳制后的裁剪范围（含端点）
 */
function computeBBox(maskBin, w, h, marginRatio, minMargin) {
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            if (maskBin[row + x]) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    // 空遮罩防御：调用前已校验有遮罩，理论不会走到
    if (maxX < 0) return { x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
    const mx = Math.max(Math.round((maxX - minX) * marginRatio), minMargin);
    const my = Math.max(Math.round((maxY - minY) * marginRatio), minMargin);
    return {
        x0: Math.max(0, minX - mx),
        y0: Math.max(0, minY - my),
        x1: Math.min(w - 1, maxX + mx),
        y1: Math.min(h - 1, maxY + my)
    };
}

/**
 * 单次 LaMa 推理封装（含等比 pad 几何处理）。
 * 流程：等比缩放到 512 内 → 镜像 pad 补齐（图像）/0 pad（遮罩）→
 * 推理 → 裁掉 pad 区 → 拉回原生 w×h。
 * @param {Object} session - onnxruntime InferenceSession
 * @param {Buffer} rgb - 原生分辨率 RGB 像素，w×h×3
 * @param {Float32Array} maskBin - 二值遮罩（0/1），w×h
 * @param {number} w - 原生宽
 * @param {number} h - 原生高
 * @returns {Promise<Buffer>} 填充后的 RGB 像素，w×h×3
 */
async function runInpaint(session, rgb, maskBin, w, h) {
    // ---- 等比缩放：最长边到 512，短边按比例（内容不变形） ----
    const { data: scaledRgb, info: scaledInfo } = await sharp(rgb, {
        raw: { width: w, height: h, channels: 3 }
    })
        .resize(INPUT_SIZE, INPUT_SIZE, { fit: 'inside' })
        .raw()
        .toBuffer({ resolveWithObject: true });
    const sw = scaledInfo.width;
    const sh = scaledInfo.height;
    // 居中 pad 偏移
    const padX = (INPUT_SIZE - sw) >> 1;
    const padY = (INPUT_SIZE - sh) >> 1;

    // 图像 pad 用镜像（extendWith: 'mirror'）：镜像内容延续边缘纹理，
    // 比灰边/复制边对模型更友好（pad 区大概率整块被模型当上下文）
    const { data: paddedRgb } = await sharp(scaledRgb, {
        raw: { width: sw, height: sh, channels: 3 }
    })
        .extend({
            top: padY, bottom: INPUT_SIZE - sh - padY,
            left: padX, right: INPUT_SIZE - sw - padX,
            background: { r: 0, g: 0, b: 0 },
            extendWith: 'mirror'
        })
        .raw()
        .toBuffer({ resolveWithObject: true });

    // 遮罩 pad 用 0（背景）：pad 区不是待填补区
    const maskU8 = Buffer.alloc(INPUT_SIZE * INPUT_SIZE);   // 默认全 0
    // 遮罩先等比缩放（与图像同几何），再嵌入 512 画布
    const { data: scaledMask } = await sharp(Buffer.from(maskBin.map(v => v * 255)), {
        raw: { width: w, height: h, channels: 1 }
    })
        .resize(sw, sh)                     // 等比（与图像缩放同参数）
        .toColourspace('b-w')               // 必须强制单通道：sharp 默认输出 sRGB
        .raw()                              // 3 通道，缺了会把交错 RGB 当单通道读
        .toBuffer({ resolveWithObject: true });
    for (let y = 0; y < sh; y++) {
        const dstRow = (padY + y) * INPUT_SIZE + padX;
        const srcRow = y * sw;
        for (let x = 0; x < sw; x++) {
            maskU8[dstRow + x] = scaledMask[srcRow + x];
        }
    }

    // ---- 张量化 ----
    const pixelCount = INPUT_SIZE * INPUT_SIZE;
    const imageTensor = new Float32Array(3 * pixelCount);
    for (let i = 0; i < pixelCount; i++) {
        imageTensor[i] = paddedRgb[i * 3] / 255;                          // R
        imageTensor[pixelCount + i] = paddedRgb[i * 3 + 1] / 255;         // G
        imageTensor[pixelCount * 2 + i] = paddedRgb[i * 3 + 2] / 255;     // B
    }
    const maskTensor = new Float32Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
        maskTensor[i] = maskU8[i] > 127 ? 1 : 0;
    }

    // ---- 推理（串行队列） ----
    const result = await new Promise((resolve, reject) => {
        const task = () => session.run({
            image: new ort.Tensor('float32', imageTensor, [1, 3, INPUT_SIZE, INPUT_SIZE]),
            mask: new ort.Tensor('float32', maskTensor, [1, 1, INPUT_SIZE, INPUT_SIZE])
        });
        const chained = inferenceQueue.then(task, task);
        inferenceQueue = chained.catch(() => {});
        chained.then(resolve, reject);
    });
    const output = result[session.outputNames[0]];   // [1,3,512,512]

    // ---- 输出解码：量程实测 [0,255]，直接 clamp（勿乘 255，否则全白） ----
    const od = output.data;
    const outRgb = Buffer.allocUnsafe(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        outRgb[i * 3] = Math.max(0, Math.min(255, Math.round(od[i])));
        outRgb[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(od[pixelCount + i])));
        outRgb[i * 3 + 2] = Math.max(0, Math.min(255, Math.round(od[pixelCount * 2 + i])));
    }

    // ---- 裁掉 pad 区，拉回原生尺寸（等比，无变形） ----
    const filled = await sharp(outRgb, {
        raw: { width: INPUT_SIZE, height: INPUT_SIZE, channels: 3 }
    })
        .extract({ left: padX, top: padY, width: sw, height: sh })
        .resize(w, h, { fit: 'fill' })   // sw:sh = w:h 等比，fill 即精确还原
        .raw()
        .toBuffer();
    return filled;
}

/**
 * POST /api/lama/remove
 * 移除遮罩区域内的物体：接收原图 + 遮罩（均 base64），返回补全后的 PNG
 *
 * 请求参数：
 *   - imageData {string} 原图 base64（data URL 前缀可选）
 *   - maskData  {string} 遮罩 base64（透明 PNG，红色不透明区域 = 待移除区）
 */
router.post('/remove', async (req, res) => {
    const t0 = Date.now();
    try {
        const { imageData, maskData } = req.body;
        if (!imageData || !maskData) {
            return res.status(400).json({
                status: 'error',
                message: '缺少必要参数: imageData / maskData'
            });
        }

        const { session, provider } = await getSession();

        // ==================== 原图解码 ====================
        // 解码出原图 raw 像素（拿真实尺寸 + 全流程复用，避免二次
        // decode 时 EXIF rotate 语义混乱）。
        // 统一转 sRGB RGB（灰度/CMYK/带 alpha 图直接按 3 通道索引会错位）
        const imgBuffer = Buffer.from(stripDataUrl(imageData), 'base64');
        const { data: origRgb, info: origInfo } = await sharp(imgBuffer)
            .rotate()                    // 按 EXIF 自动摆正方向
            .toColourspace('srgb')
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        const origWidth = origInfo.width;
        const origHeight = origInfo.height;

        // ==================== 遮罩二值化（原生分辨率） ====================
        // 遮罩是透明底 + 红色涂画区，取 alpha 通道二值化（>127 = 移除区）。
        // 在原图分辨率上处理（不做全图缩放），保证 bbox 精度
        const maskBuffer = Buffer.from(stripDataUrl(maskData), 'base64');
        const maskOrig = await sharp(maskBuffer)
            .resize(origWidth, origHeight, { fit: 'fill' })
            .extractChannel('alpha')
            .toColourspace('b-w')
            .raw()
            .toBuffer();
        const maskBinOrig = new Float32Array(origWidth * origHeight);
        let maskAny = false;
        for (let i = 0; i < maskBinOrig.length; i++) {
            if (maskOrig[i] > 127) { maskBinOrig[i] = 1; maskAny = true; }
        }
        if (!maskAny) {
            return res.status(400).json({ status: 'error', message: '遮罩为空：请先涂出要移除的区域' });
        }

        // ==================== bbox 裁剪 ====================
        // 只把"物体+周边上下文"送进模型，而不是整图——有效分辨率由
        // 遮罩区大小决定，消除全图 512 压缩的模糊感
        const bbox = computeBBox(maskBinOrig, origWidth, origHeight, CONTEXT_MARGIN, 16);
        const cropW = bbox.x1 - bbox.x0 + 1;
        const cropH = bbox.y1 - bbox.y0 + 1;
        console.log(`[lama] bbox: (${bbox.x0},${bbox.y0})-(${bbox.x1},${bbox.y1}) ${cropW}x${cropH}, 原图 ${origWidth}x${origHeight}`);

        // 原生分辨率裁剪 RGB + 遮罩（extract 直接用 raw 输入，坐标精确）
        const { data: cropRgb } = await sharp(origRgb, {
            raw: { width: origWidth, height: origHeight, channels: 3 }
        })
            .extract({ left: bbox.x0, top: bbox.y0, width: cropW, height: cropH })
            .raw()
            .toBuffer({ resolveWithObject: true });
        const maskBinCrop = new Float32Array(cropW * cropH);
        for (let y = 0; y < cropH; y++) {
            for (let x = 0; x < cropW; x++) {
                maskBinCrop[y * cropW + x] = maskBinOrig[(bbox.y0 + y) * origWidth + (bbox.x0 + x)];
            }
        }

        // ==================== 第一遍推理（bbox 级） ====================
        let cropInpainted = await runInpaint(session, cropRgb, maskBinCrop, cropW, cropH);

        // ==================== refiner 第二遍（紧凑裁剪，细节细化） ====================
        // 紧贴遮罩再裁一个小区域：洞在 512 输入里占比更大，纹理重建更细。
        // 门控看绝对缩放：仅当 bbox 大于模型输入（第一遍内容被降采样、
        // 洞在模型眼里变小）时细化才有意义；bbox ≤512 时第一遍已放大
        // 内容，第二遍是亚像素级放大，无真实细节增益还多花一次推理
        const tight = computeBBox(maskBinCrop, cropW, cropH, REFINE_MARGIN, 8);
        const tightW = tight.x1 - tight.x0 + 1;
        const tightH = tight.y1 - tight.y0 + 1;
        const gain = Math.max(cropW / tightW, cropH / tightH);
        if (Math.max(cropW, cropH) > INPUT_SIZE) {
            const { data: tightRgb } = await sharp(cropInpainted, {
                raw: { width: cropW, height: cropH, channels: 3 }
            })
                .extract({ left: tight.x0, top: tight.y0, width: tightW, height: tightH })
                .raw()
                .toBuffer({ resolveWithObject: true });
            const maskBinTight = new Float32Array(tightW * tightH);
            for (let y = 0; y < tightH; y++) {
                for (let x = 0; x < tightW; x++) {
                    maskBinTight[y * tightW + x] = maskBinCrop[(tight.y0 + y) * cropW + (tight.x0 + x)];
                }
            }
            const refined = await runInpaint(session, tightRgb, maskBinTight, tightW, tightH);

            // 只取洞内（羽化）结果贴回第一遍填充图：第二遍上下文变少，
            // 洞外区域不如第一遍可靠，丢弃；羽化 2px 防接缝。
            // 手动 alpha 混合而非 sharp composite：composite 作用在 raw
            // 像素输入上会把输出提升为 4 通道，按 3 通道读回会整块错位
            const alphaTight = await sharp(Buffer.from(maskBinTight.map(v => v * 255)), {
                raw: { width: tightW, height: tightH, channels: 1 }
            })
                .blur(2)
                .toColourspace('b-w')   // 强制单通道（sharp 默认输出 3 通道）
                .raw()
                .toBuffer();
            const blended = Buffer.from(cropInpainted);   // 拷贝后原地混合
            for (let y = 0; y < tightH; y++) {
                for (let x = 0; x < tightW; x++) {
                    const a = alphaTight[y * tightW + x] / 255;
                    if (a <= 0) continue;
                    const srcI = (y * tightW + x) * 3;
                    const dstI = ((tight.y0 + y) * cropW + (tight.x0 + x)) * 3;
                    for (let c = 0; c < 3; c++) {
                        blended[dstI + c] = Math.round(refined[srcI + c] * a + blended[dstI + c] * (1 - a));
                    }
                }
            }
            cropInpainted = blended;
            console.log(`[lama] refiner: 紧凑区 ${tightW}x${tightH}, 细化增益 ${gain.toFixed(2)}x`);
        } else {
            console.log(`[lama] refiner 跳过: bbox ${cropW}x${cropH} ≤ 512，第一遍已放大内容`);
        }

        // ==================== 合成回原图 ====================
        // 手动 alpha 混合（勿用 sharp composite）：实测 composite 在 raw
        // 像素基底上合成大尺寸覆盖层（>~600px）会输出乱值/通道错位，
        // 小覆盖层正常——行为不稳定，改用确定性手动混合
        const maskSoftU8 = Buffer.from(maskBinCrop.map(v => v * 255));
        const alphaCrop = await sharp(maskSoftU8, {
            raw: { width: cropW, height: cropH, channels: 1 }
        })
            .blur(2)
            .toColourspace('b-w')   // 强制单通道，避免 3 通道交错
            .raw()
            .toBuffer();

        const composed = Buffer.from(origRgb);   // 拷贝后原地混合
        for (let y = 0; y < cropH; y++) {
            for (let x = 0; x < cropW; x++) {
                const a = alphaCrop[y * cropW + x] / 255;
                if (a <= 0) continue;
                const srcI = (y * cropW + x) * 3;
                const dstI = ((bbox.y0 + y) * origWidth + (bbox.x0 + x)) * 3;
                for (let c = 0; c < 3; c++) {
                    composed[dstI + c] = Math.round(cropInpainted[srcI + c] * a + composed[dstI + c] * (1 - a));
                }
            }
        }

        const composedPng = await sharp(composed, {
            raw: { width: origWidth, height: origHeight, channels: 3 }
        })
            .png()
            .toBuffer();

        const cost = Date.now() - t0;
        console.log(`✅ [lama] 物体移除完成: bbox ${cropW}x${cropH} @ ${origWidth}x${origHeight}, ${provider}, ${cost}ms`);

        res.json({
            status: 'ok',
            image: `data:image/png;base64,${composedPng.toString('base64')}`,
            provider,
            cost
        });
    } catch (error) {
        console.error('[lama] 物体移除失败:', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

module.exports = router;

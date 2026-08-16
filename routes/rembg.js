/**
 * ==========================================================================
 * LumenLight 抠图去背景路由模块
 * 作用：提供 /api/rembg 系列接口，使用 onnxruntime-node 在本地运行
 *       BEN2 等抠图模型，将图片主体分离出来并输出透明背景 PNG。
 *
 * 技术选型说明：
 *   采用 onnxruntime-node（Node 原生绑定）而非 Python + rembg，好处是
 *   无需安装 Python 环境与虚拟环境，依赖仅 2 个 npm 包，且 Windows 下
 *   可通过 DirectML 直接调用 GPU 加速（无需安装 CUDA）。
 *
 * 模型存放目录：models/rembg/
 *   模型由用户在设置界面按需下载，不随项目预置（单个模型约 200MB+）。
 *
 * 预处理/后处理流程（各模型的具体参数见 MODEL_REGISTRY）：
 *   - 预处理：resize 到 1024x1024，像素归一化到 [0,1] 后按模型自身 mean/std 标准化
 *   - 后处理：模型输出已是 [0,1] 的前景概率，clamp 后缩放回原尺寸作为 alpha
 * ==========================================================================
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { download } = require('../tools/download-model');

// onnxruntime-node 体积较大（含各平台原生二进制），采用懒加载：
// 只有真正调用抠图接口时才 require，避免影响服务启动速度
let ort = null;

/** 模型文件存放目录 */
const MODEL_DIR = path.join(__dirname, '..', 'models', 'rembg');

/** 模型推理分辨率（BEN2 官方训练分辨率，不可随意更改） */
const INPUT_SIZE = 1024;

/**
 * 可选模型清单
 * 供设置界面展示下载选项，也用于校验前端传来的模型 ID
 *
 * 各模型的预处理/后处理参数差异说明：
 *   - mean / std：像素先除 255 归一化到 [0,1]，再按 (x - mean) / std 标准化。
 *     BEN2 官方仅做 ToTensor()，故 mean 全 0、std 全 1（等价于不做标准化）；
 *     RMBG-2.0 采用标准 ImageNet 均值方差。
 *
 * 注：当前两个模型输出末端均自带 Sigmoid，已是 [0,1] 前景概率，
 *     后处理统一 clamp 即可，无需 min-max 拉伸。
 */
const MODEL_REGISTRY = {
    ben2: {
        name: 'BEN2 Base',
        file: 'BEN2_Base.onnx',
        // 使用 hf-mirror 镜像，避免国内网络无法访问 HuggingFace
        url: 'https://hf-mirror.com/PramaLLC/BEN2/resolve/main/BEN2_Base.onnx',
        sizeMB: 213,
        desc: '发丝级精度，适合人物、动物、毛发类主体',
        mean: [0, 0, 0],
        std: [1, 1, 1]
    },
    'rmbg2-fp16': {
        name: 'RMBG-2.0 (FP16)',
        file: 'RMBG-2.0-fp16.onnx',
        // 使用 ModelScope 镜像：国内直连速度快、免登录，且支持 Range 断点续传。
        // 官方 HuggingFace 仓库 briaai/RMBG-2.0 为 gated 下载，需登录授权，故不采用。
        url: 'https://www.modelscope.cn/models/AI-ModelScope/RMBG-2.0/resolve/master/onnx/model_fp16.onnx',
        sizeMB: 490,
        desc: '综合精度最高，通用场景首选（仅限非商用）',
        // 官方 preprocessor_config.json 采用标准 ImageNet 标准化参数
        mean: [0.485, 0.456, 0.406],
        std: [0.229, 0.224, 0.225]
    }
};

/** 抠图默认使用的模型 ID */
const DEFAULT_MODEL = 'ben2';

/**
 * 已加载的推理会话缓存
 * 键为模型 ID，值为 Promise<{session, provider}>。
 *
 * 这里缓存 Promise 而非 session 实例，是为了让并发的首次请求共享同一次加载：
 * 若缓存实例，两个请求同时进来时都会看到"未缓存"从而各自加载一份 213MB 模型，
 * 造成内存/显存翻倍甚至 OOM。
 */
const sessionCache = new Map();

/**
 * 推理串行队列
 * ONNX Runtime 的 session.run 并不保证并发安全（DirectML 后端尤其如此），
 * 且单张推理已占满 GPU，并发不会提速。因此用一条 Promise 链把请求排队执行。
 */
let inferenceQueue = Promise.resolve();

/**
 * 将任务追加到推理队列尾部，保证同一时刻只有一个推理在跑
 * @param {Function} task 返回 Promise 的异步任务
 * @returns {Promise<*>} 任务的执行结果
 */
function enqueueInference(task) {
    // 用 catch 兜住前一个任务的异常，避免一次失败导致整条队列作废
    const result = inferenceQueue.then(task, task);
    inferenceQueue = result.catch(() => {});
    return result;
}

/**
 * 正在进行/已结束的模型下载任务
 * 键为模型 ID，值为 { state, downloaded, total, speed, message, cancelled }
 * state 取值：downloading | done | cancelled | error
 */
const downloadTasks = new Map();

/**
 * 将下载任务内部状态整理成前端友好的进度对象
 * @param {Object} task 下载任务
 */
function buildProgress(task) {
    return {
        state: task.state,
        percent: task.total ? +((task.downloaded / task.total) * 100).toFixed(1) : 0,
        downloadedMB: +(task.downloaded / 1024 / 1024).toFixed(1),
        totalMB: +(task.total / 1024 / 1024).toFixed(1),
        speedMB: +task.speed.toFixed(2),
        message: task.message
    };
}

/**
 * 获取（或首次创建）指定模型的推理会话
 * 首次加载耗时约 7 秒，加载后常驻内存复用
 * @param {string} modelId 模型 ID，需存在于 MODEL_REGISTRY
 * @returns {Promise<{session: Object, provider: string}>}
 */
function getSession(modelId) {
    // 命中缓存直接返回（含正在加载中的 Promise），这是性能关键
    if (sessionCache.has(modelId)) {
        return sessionCache.get(modelId);
    }

    const loading = createSession(modelId);
    // 先存入缓存再等待，使并发请求能共享这一次加载
    sessionCache.set(modelId, loading);

    // 加载失败时清除缓存，否则一次失败会让该模型永久不可用
    loading.catch(() => sessionCache.delete(modelId));

    return loading;
}

/**
 * 实际创建推理会话（仅由 getSession 调用）
 * @param {string} modelId 模型 ID
 * @returns {Promise<{session: Object, provider: string}>}
 */
async function createSession(modelId) {
    const meta = MODEL_REGISTRY[modelId];
    if (!meta) {
        throw new Error(`未知模型: ${modelId}`);
    }

    const modelPath = path.join(MODEL_DIR, meta.file);
    if (!fs.existsSync(modelPath)) {
        throw new Error(`模型未下载: ${meta.name}，请先在设置中下载该模型`);
    }

    // 懒加载 onnxruntime
    if (!ort) {
        ort = require('onnxruntime-node');
    }

    // 依次尝试执行后端：dml 为 Windows GPU 加速（无需 CUDA），cpu 为兜底
    const providers = process.platform === 'win32' ? ['dml', 'cpu'] : ['cpu'];
    let session = null;
    let used = null;

    for (const ep of providers) {
        try {
            session = await ort.InferenceSession.create(modelPath, {
                executionProviders: [ep],
                // 日志级别 3=Error：屏蔽 ONNX Runtime 的 Warning 输出。
                // RMBG-2.0 内部含动态 reshape，推理时会反复打印
                // "Shape mismatch attempting to re-use buffer" 警告。
                // 该警告仅表示运行时放弃复用内存缓冲、改为重新分配，
                // 不影响推理结果，故直接屏蔽以保持控制台整洁。
                logSeverityLevel: 3,
                severityLevel: 3
            });
            used = ep;
            break;
        } catch (err) {
            // 当前后端不可用，记录后尝试下一个
            console.warn(`[rembg] 后端 ${ep} 不可用: ${err.message.split('\n')[0]}`);
        }
    }

    if (!session) {
        throw new Error('ONNX Runtime 所有执行后端均不可用');
    }

    console.log(`[rembg] 模型 ${meta.name} 已加载，后端: ${used}`);
    return { session, provider: used };
}

/**
 * POST /api/rembg
 * 抠图去背景：接收 base64 图片，返回透明背景的 PNG（base64）
 *
 * 请求参数：
 *   - imageData {string} 图片 base64（支持 data URL 前缀）
 *   - model {string} 可选，模型 ID；未传则使用默认模型
 */
router.post('/', async (req, res) => {
    try {
        const { imageData, model = DEFAULT_MODEL } = req.body;

        if (!imageData) {
            return res.status(400).json({
                status: 'error',
                message: '缺少必要参数: imageData'
            });
        }

        // 预处理/后处理参数随模型而异，先取出并校验
        const meta = MODEL_REGISTRY[model];
        if (!meta) {
            return res.status(400).json({
                status: 'error',
                message: `未知模型: ${model}`
            });
        }

        const t0 = Date.now();

        // ==================== 解码输入图片 ====================
        const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
        const inputBuffer = Buffer.from(base64Data, 'base64');

        // ==================== 加载模型 ====================
        const { session, provider } = await getSession(model);

        // ==================== 取出原图像素 ====================
        // rotate() 无参数表示按 EXIF orientation 自动旋转。手机竖拍的照片实际
        // 像素是横向的、靠 EXIF 标记方向，不处理会导致抠图结果方向错乱。
        //
        // 尺寸必须从这里的 info 取，不能用 metadata()：
        // metadata() 读的是文件头，即使链式调用了 rotate() 仍返回旋转前的宽高，
        // 用错尺寸会让 mask 与原图错位。
        //
        // toColourspace('srgb') 也是必须的：灰度图 / CMYK 图 removeAlpha 后
        // 通道数并非 3，直接按 i*3 索引会读越界得到黑图。
        const { data: rgb3, info } = await sharp(inputBuffer)
            .rotate()
            .toColourspace('srgb')
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        const origWidth = info.width;
        const origHeight = info.height;

        // ==================== 预处理 ====================
        // 缩放到模型输入尺寸（复用上面已旋转好的像素，避免二次解码）
        const { data: rgb } = await sharp(rgb3, {
            raw: { width: origWidth, height: origHeight, channels: 3 }
        })
            .resize(INPUT_SIZE, INPUT_SIZE, { fit: 'fill' })
            .raw()
            .toBuffer({ resolveWithObject: true });

        // HWC(uint8) 转 NCHW(float32)
        // 先归一化到 [0,1]，再按模型自身的 mean/std 做标准化
        const pixelCount = INPUT_SIZE * INPUT_SIZE;
        const nchw = new Float32Array(3 * pixelCount);
        const [mr, mg, mb] = meta.mean;
        const [sr, sg, sb] = meta.std;
        for (let i = 0; i < pixelCount; i++) {
            nchw[i] = (rgb[i * 3] / 255 - mr) / sr;                        // R 通道
            nchw[pixelCount + i] = (rgb[i * 3 + 1] / 255 - mg) / sg;       // G 通道
            nchw[pixelCount * 2 + i] = (rgb[i * 3 + 2] / 255 - mb) / sb;   // B 通道
        }

        // ==================== 推理 ====================
        const inputName = session.inputNames[0];
        const outputName = session.outputNames[0];
        const tensor = new ort.Tensor('float32', nchw, [1, 3, INPUT_SIZE, INPUT_SIZE]);

        // 入队串行执行，避免多请求同时占用 GPU
        const result = await enqueueInference(() => session.run({ [inputName]: tensor }));
        const maskData = result[outputName].data; // 形状 [1,1,1024,1024]，Float16Array

        // ==================== 后处理 ====================
        const maskGray = Buffer.allocUnsafe(pixelCount);

        // 模型输出末端自带 Sigmoid，已是 [0,1] 区间的前景概率，直接 clamp 转 0-255。
        // 此处刻意不做 min-max 归一化，以保留"无主体则全透明"的正确行为。
        for (let i = 0; i < pixelCount; i++) {
            const v = maskData[i];
            maskGray[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
        }

        // 将 mask 从 1024x1024 缩放回原图尺寸
        // 两个必须项：
        //   .raw() —— 否则 toBuffer 返回编码后的图像字节流而非像素数据
        //   .toColourspace('b-w') —— sharp 对单通道 raw 输入 resize 后会自动转成
        //     sRGB 三通道，若不强制回单通道，按像素索引读取会错位成斜向条纹
        const alphaBuffer = await sharp(maskGray, {
            raw: { width: INPUT_SIZE, height: INPUT_SIZE, channels: 1 }
        })
            .resize(origWidth, origHeight, { fit: 'fill' })
            .toColourspace('b-w')
            .raw()
            .toBuffer();

        // 将原图 RGB 与 mask 手动组装成 RGBA
        // 不使用 sharp 的 joinChannel：其与 removeAlpha 在内部 pipeline 中的
        // 执行顺序并非调用顺序，会导致刚拼上的 alpha 通道被移除

        const origPixels = origWidth * origHeight;
        const rgba = Buffer.allocUnsafe(origPixels * 4);
        for (let i = 0; i < origPixels; i++) {
            rgba[i * 4] = rgb3[i * 3];
            rgba[i * 4 + 1] = rgb3[i * 3 + 1];
            rgba[i * 4 + 2] = rgb3[i * 3 + 2];
            rgba[i * 4 + 3] = alphaBuffer[i];
        }

        // 输出透明背景 PNG
        const outputBuffer = await sharp(rgba, {
            raw: { width: origWidth, height: origHeight, channels: 4 }
        })
            .png()
            .toBuffer();

        const cost = Date.now() - t0;
        console.log(`✅ [rembg] 抠图完成: ${origWidth}x${origHeight}, ${provider}, ${cost}ms`);

        res.json({
            status: 'ok',
            image: `data:image/png;base64,${outputBuffer.toString('base64')}`,
            model,
            provider,
            cost
        });

    } catch (error) {
        console.error('[rembg] 抠图失败:', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

/**
 * GET /api/rembg/models
 * 返回模型清单及本地下载状态，供设置界面渲染
 */
router.get('/models', (req, res) => {
    const models = Object.entries(MODEL_REGISTRY).map(([id, meta]) => {
        const filePath = path.join(MODEL_DIR, meta.file);
        const exists = fs.existsSync(filePath);
        const task = downloadTasks.get(id);
        return {
            id,
            name: meta.name,
            desc: meta.desc,
            sizeMB: meta.sizeMB,
            downloaded: exists,
            // 已下载则返回实际体积，便于前端识别不完整的文件
            actualMB: exists
                ? +(fs.statSync(filePath).size / 1024 / 1024).toFixed(1)
                : 0,
            loaded: sessionCache.has(id),
            // 下载中的进度信息（无任务时为 null）
            progress: task ? buildProgress(task) : null
        };
    });
    res.json({ status: 'ok', models });
});

/**
 * POST /api/rembg/download
 * 开始下载模型（立即返回，前端轮询 /download/status 获取进度）
 * 下载先写入 .part 临时文件，完成后才改名为正式文件，
 * 避免中断产生的残缺文件被推理接口当成可用模型加载
 *
 * 请求参数：model {string} 模型 ID
 */
router.post('/download', (req, res) => {
    const { model } = req.body;
    const meta = MODEL_REGISTRY[model];

    if (!meta) {
        return res.status(400).json({ status: 'error', message: `未知模型: ${model}` });
    }

    const filePath = path.join(MODEL_DIR, meta.file);
    if (fs.existsSync(filePath)) {
        return res.json({ status: 'ok', message: '模型已下载', downloaded: true });
    }

    const existing = downloadTasks.get(model);
    if (existing && existing.state === 'downloading') {
        return res.json({ status: 'ok', message: '下载已在进行中' });
    }

    // 断点续传的临时文件：download() 内部会读取其体积并发送 Range 请求
    const partPath = filePath + '.part';
    const task = {
        state: 'downloading',
        downloaded: 0,
        total: meta.sizeMB * 1024 * 1024, // 拿到响应头前先用清单值估算
        speed: 0,
        message: '',
        cancelled: false
    };
    downloadTasks.set(model, task);

    download(meta.url, partPath, {
        onProgress: ({ downloaded, total, speed }) => {
            task.downloaded = downloaded;
            if (total) task.total = total;
            task.speed = speed;
        },
        shouldAbort: () => task.cancelled
    })
        .then(() => {
            fs.renameSync(partPath, filePath);
            task.state = 'done';
            console.log(`[rembg] 模型下载完成: ${meta.name}`);
        })
        .catch((err) => {
            task.state = task.cancelled ? 'cancelled' : 'error';
            task.message = err.message;
            console.error(`[rembg] 模型下载失败 ${meta.name}: ${err.message}`);
        });

    res.json({ status: 'ok', message: '已开始下载' });
});

/**
 * GET /api/rembg/download/status?model=xxx
 * 查询下载进度，供前端轮询
 */
router.get('/download/status', (req, res) => {
    const task = downloadTasks.get(req.query.model);
    if (!task) {
        return res.json({ status: 'ok', progress: null });
    }
    res.json({ status: 'ok', progress: buildProgress(task) });
});

/**
 * POST /api/rembg/download/cancel
 * 取消下载，已下载的部分保留在 .part 文件中，下次下载自动续传
 */
router.post('/download/cancel', (req, res) => {
    const task = downloadTasks.get(req.body.model);
    if (!task || task.state !== 'downloading') {
        return res.json({ status: 'ok', message: '没有正在进行的下载' });
    }
    task.cancelled = true;
    res.json({ status: 'ok', message: '已请求取消' });
});

/**
 * DELETE /api/rembg/models/:id
 * 删除已下载的模型文件（含未完成的 .part），并释放常驻的推理会话
 */
router.delete('/models/:id', async (req, res) => {
    const { id } = req.params;
    const meta = MODEL_REGISTRY[id];

    if (!meta) {
        return res.status(400).json({ status: 'error', message: `未知模型: ${id}` });
    }

    const task = downloadTasks.get(id);
    if (task && task.state === 'downloading') {
        return res.status(409).json({ status: 'error', message: '模型正在下载中，请先取消下载' });
    }

    try {
        // 先释放推理会话，否则模型文件被进程占用无法删除
        const loading = sessionCache.get(id);
        if (loading) {
            sessionCache.delete(id);
            // 缓存的是 Promise，需等加载完成才能拿到 session 来释放
            const { session } = await loading;
            if (typeof session.release === 'function') await session.release();
        }

        const filePath = path.join(MODEL_DIR, meta.file);
        for (const p of [filePath, filePath + '.part']) {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        downloadTasks.delete(id);

        console.log(`[rembg] 已删除模型: ${meta.name}`);
        res.json({ status: 'ok', message: '模型已删除' });
    } catch (error) {
        console.error('[rembg] 删除模型失败:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

module.exports = router;

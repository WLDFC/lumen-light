/**
 * ==========================================================================
 * LumenLight 高清放大路由模块
 * 作用：提供 /api/upscale POST 接口，接收前端传来的 base64 图片数据，
 *       调用本地 Real-ESRGAN 可执行文件进行图片放大处理，然后将放大后的
 *       图片以 base64 格式返回给前端。
 * 
 * 支持的放大类型：
 *   - anime（动漫/二次元）：使用 realesr-animevideov3 模型，支持 2x/4x
 *   - real（真实/照片）：使用 realesrgan-x4plus 模型，仅支持 4x
 * 
 * 可执行文件路径：Real-ESRGAN/realesrgan-ncnn-vulkan-v0.2.0/realesrgan-ncnn-vulkan.exe
 * ==========================================================================
 */

const express = require('express');     // Express 框架
const router = express.Router();        // 创建路由实例
const path = require('path');           // 路径处理模块
const fs = require('fs');               // 文件系统模块
const { exec } = require('child_process'); // 子进程执行模块，用于调用 Real-ESRGAN

/**
 * POST /api/upscale
 * 高清放大 API：接收 base64 图片，调用 Real-ESRGAN 执行放大，返回 base64 结果
 * 
 * 请求参数：
 *   - imageData {string} 图片的 base64 数据（支持 data:image/xxx;base64, 前缀）
 *   - type {string} 放大类型，'anime' 或 'real'
 *   - scale {number} 放大倍数，anime 支持 2/4，real 支持 4
 */
router.post('/', async (req, res) => {
    try {
        // 从请求体中解析参数
        const { imageData, type, scale } = req.body;
        
        // 校验必要参数
        if (!imageData || !type || !scale) {
            return res.status(400).json({ 
                status: 'error', 
                message: '缺少必要参数: imageData, type, scale' 
            });
        }

        console.log(`🔍 开始高清放大: ${type} ${scale}x`);

        // ==================== 创建临时目录 ====================
        const tempDir = path.join(__dirname, '..', 'temp_upscale');
        if (!fs.existsSync(tempDir)) {
            // 递归创建临时目录
            fs.mkdirSync(tempDir, { recursive: true });
        }

        // ==================== 生成临时文件路径 ====================
        const timestamp = Date.now();
        const inputFilename = `input_${timestamp}.png`;   // 输入临时文件名
        const outputFilename = `output_${timestamp}.png`; // 输出临时文件名
        const inputPath = path.join(tempDir, inputFilename);
        const outputPath = path.join(tempDir, outputFilename);

        // ==================== 保存 base64 图片到临时文件 ====================
        // 移除 base64 字符串中的 data URL 前缀，只保留纯 base64 数据
        const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(inputPath, Buffer.from(base64Data, 'base64'));

        // ==================== 确定 Real-ESRGAN 模型参数 ====================
        // 根据类型和倍数选择模型：
        //   - anime 2x: realesr-animevideov3
        //   - anime 4x: realesrgan-x4plus-anime
        //   - real 4x:  realesrgan-x4plus
        let modelName;
        if (type === 'anime') {
            if (parseInt(scale) === 2) {
                modelName = 'realesr-animevideov3';
            } else {
                modelName = 'realesrgan-x4plus-anime';
            }
        } else {
            // 真实照片模型
            modelName = 'realesrgan-x4plus';
        }

        // ==================== 检查 Real-ESRGAN 可执行文件 ====================
        // 可执行文件位于 Real-ESRGAN 子文件夹中
        const realesrganPath = path.join(__dirname, '..', 'Real-ESRGAN', 'realesrgan-ncnn-vulkan-v0.2.0', 'realesrgan-ncnn-vulkan.exe');
        
        // 检查可执行文件是否存在
        if (!fs.existsSync(realesrganPath)) {
            // 清理已保存的输入临时文件
            fs.unlinkSync(inputPath);
            return res.status(500).json({
                status: 'error',
                message: 'Real-ESRGAN 未找到，请确保 Real-ESRGAN/realesrgan-ncnn-vulkan-v0.2.0 文件夹包含 realesrgan-ncnn-vulkan.exe'
            });
        }

        // ==================== 构建 Real-ESRGAN 命令 ====================
        // -i 输入文件，-o 输出文件，-n 模型名称，-s 放大倍数
        const command = `"${realesrganPath}" -i "${inputPath}" -o "${outputPath}" -n ${modelName} -s ${scale}`;
        
        console.log(`执行命令: ${command}`);

        // ==================== 执行 Real-ESRGAN 放大处理 ====================
        // 设置超时时间为 5 分钟（300000 毫秒）
        exec(command, { timeout: 300000 }, (error, stdout, stderr) => {
            // 清理输入临时文件（无论成功与否都清理）
            try {
                fs.unlinkSync(inputPath);
            } catch (e) {
                console.warn('清理输入文件失败:', e.message);
            }

            console.log('Real-ESRGAN stdout:', stdout);
            console.log('Real-ESRGAN stderr:', stderr);

            // 如果命令执行出错，返回错误信息
            if (error) {
                console.error('Real-ESRGAN 执行失败:', error);
                return res.status(500).json({
                    status: 'error',
                    message: '放大处理失败: ' + error.message
                });
            }

            // 检查输出文件是否生成
            if (!fs.existsSync(outputPath)) {
                console.error(`输出文件不存在: ${outputPath}`);
                return res.status(500).json({
                    status: 'error',
                    message: '输出文件未生成'
                });
            }

            // ==================== 读取输出文件并转换为 base64 ====================
            const outputBuffer = fs.readFileSync(outputPath);
            const outputBase64 = `data:image/png;base64,${outputBuffer.toString('base64')}`;

            // 清理输出临时文件
            try {
                fs.unlinkSync(outputPath);
            } catch (e) {
                console.warn('清理输出文件失败:', e.message);
            }

            console.log(`✅ 高清放大完成: ${type} ${scale}x`);

            // 返回放大后的图片和参数信息
            res.json({
                status: 'ok',
                upscaledImage: outputBase64,
                type: type,
                scale: scale
            });
        });

    } catch (error) {
        // 捕获并返回服务器内部错误
        console.error('高清放大 API 错误:', error);
        res.status(500).json({
            status: 'error',
            message: '服务器错误: ' + error.message
        });
    }
});

// 导出路由实例，供 server.js 使用
module.exports = router;

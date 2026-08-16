/**
 * 模型下载器 —— 支持 HuggingFace 镜像、断点续传、进度回调
 *
 * 用法：
 *   node tools/download-model.js <url> <输出路径>
 *
 * 设计要点：
 *   1. 显式 agent 绕过环境变量代理，避免 ICUBE_PROXY_HOST 之类的干扰
 *   2. 手动处理 302 重定向（HF 的 resolve 端点会跳转到 CDN）
 *   3. 支持 Range 断点续传，大模型断网后可继续
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

/** 单次请求的最大重定向次数，防止循环跳转 */
const MAX_REDIRECTS = 10;

/**
 * 发起请求并自动跟随重定向
 * @param {string} url 目标地址
 * @param {Object} headers 附加请求头
 * @param {number} depth 当前重定向深度
 * @returns {Promise<http.IncomingMessage>}
 */
function request(url, headers = {}, depth = 0) {
    return new Promise((resolve, reject) => {
        if (depth > MAX_REDIRECTS) {
            return reject(new Error('重定向次数过多'));
        }

        const parsed = new URL(url);
        const client = parsed.protocol === 'https:' ? https : http;

        const req = client.request(
            {
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: 'GET',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                    ...headers
                },
                // 关键：不使用全局 agent，避免继承环境代理设置
                agent: false,
                timeout: 60000
            },
            (res) => {
                // 跟随重定向
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume(); // 丢弃响应体，释放连接
                    const next = new URL(res.headers.location, url).toString();
                    return resolve(request(next, headers, depth + 1));
                }
                resolve(res);
            }
        );

        req.on('timeout', () => req.destroy(new Error('请求超时')));
        req.on('error', reject);
        req.end();
    });
}

/**
 * 下载文件到本地，带进度输出与断点续传
 * @param {string} url 下载地址
 * @param {string} destPath 保存路径
 * @param {Object} [options] 可选项
 * @param {Function} [options.onProgress] 进度回调 ({downloaded, total, speed})，
 *        由服务端路由传入以便推送给前端；不传则仅打印到控制台
 * @param {Function} [options.shouldAbort] 返回 true 时中止下载（用于用户取消）
 */
async function download(url, destPath, options = {}) {
    const { onProgress, shouldAbort } = options;
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    // 断点续传：若已有部分文件，从断点继续
    let downloaded = 0;
    const headers = {};
    if (fs.existsSync(destPath)) {
        downloaded = fs.statSync(destPath).size;
        if (downloaded > 0) {
            headers.Range = `bytes=${downloaded}-`;
            console.log(`发现已下载 ${(downloaded / 1024 / 1024).toFixed(1)} MB，尝试续传`);
        }
    }

    const res = await request(url, headers);

    if (res.statusCode === 416) {
        console.log('文件已完整下载');
        return destPath;
    }
    if (res.statusCode !== 200 && res.statusCode !== 206) {
        throw new Error(`HTTP ${res.statusCode}`);
    }

    // 206 表示续传成功，200 表示服务端不支持续传、从头开始
    const isResume = res.statusCode === 206;
    if (!isResume) downloaded = 0;

    const remaining = parseInt(res.headers['content-length'] || '0', 10);
    const total = downloaded + remaining;
    console.log(`总大小: ${(total / 1024 / 1024).toFixed(1)} MB`);

    const file = fs.createWriteStream(destPath, { flags: isResume ? 'a' : 'w' });

    let lastPrint = Date.now();
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
        res.on('data', (chunk) => {
            downloaded += chunk.length;

            // 用户取消：销毁连接，已下载部分保留以便后续续传
            if (shouldAbort && shouldAbort()) {
                res.destroy();
                file.close();
                return reject(new Error('下载已取消'));
            }

            // 每 500ms 上报一次进度，避免刷屏与高频 IO
            if (Date.now() - lastPrint > 500) {
                const speed = downloaded / 1024 / 1024 / ((Date.now() - startTime) / 1000);
                if (onProgress) {
                    onProgress({ downloaded, total, speed });
                } else {
                    const pct = total ? ((downloaded / total) * 100).toFixed(1) : '?';
                    process.stdout.write(
                        `\r进度: ${pct}%  ${(downloaded / 1024 / 1024).toFixed(1)} MB  ${speed.toFixed(2)} MB/s   `
                    );
                }
                lastPrint = Date.now();
            }
        });

        res.pipe(file);

        file.on('finish', () => {
            file.close();
            const mb = (downloaded / 1024 / 1024).toFixed(1);
            const sec = ((Date.now() - startTime) / 1000).toFixed(1);
            if (onProgress) {
                onProgress({ downloaded, total: total || downloaded, speed: 0 });
            } else {
                process.stdout.write(`\r下载完成: ${mb} MB，耗时 ${sec}s\n`);
            }
            resolve(destPath);
        });

        file.on('error', reject);
        res.on('error', reject);
    });
}

// CLI 入口
if (require.main === module) {
    const [url, dest] = process.argv.slice(2);
    if (!url || !dest) {
        console.error('用法: node tools/download-model.js <url> <输出路径>');
        process.exit(1);
    }
    download(url, dest).catch((err) => {
        console.error(`\n下载失败: ${err.message}`);
        process.exit(1);
    });
}

module.exports = { download, request };

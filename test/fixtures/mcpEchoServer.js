/**
 * 测试夹具：最小 stdio MCP 服务器（原生 JSON-RPC 2.0，不依赖 SDK）
 * 仅实现测试所需的方法：initialize / notifications/initialized /
 * tools/list（一个 echo 工具）/ tools/call（回显 text 参数）。
 * 协议形态：stdin/stdout 上按行分隔的 JSON-RPC 2.0 消息。
 */
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || msg.jsonrpc !== '2.0') return;

    switch (msg.method) {
        case 'initialize':
            send(msg.id, {
                protocolVersion: msg.params && msg.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: 'echo-test', version: '1.0.0' }
            });
            break;
        case 'notifications/initialized':
            break;   // 通知无需应答
        case 'tools/list':
            send(msg.id, {
                tools: [{
                    name: 'echo',
                    description: '回显文本（测试夹具）',
                    inputSchema: {
                        type: 'object',
                        properties: { text: { type: 'string', description: '要回显的文本' } },
                        required: ['text']
                    }
                }]
            });
            break;
        case 'tools/call':
            send(msg.id, {
                content: [{ type: 'text', text: `echo:${(msg.params.arguments || {}).text ?? ''}` }],
                isError: false
            });
            break;
        default:
            if (msg.id !== undefined) send(msg.id, {});
    }
});

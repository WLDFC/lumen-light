// 临时诊断脚本：解析 pi 会话 JSONL，按时间顺序打印用户消息/工具调用/工具结果/错误
const fs = require('fs');
const file = process.argv[2];
const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim());
for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const m = o.message || {};
    const ts = (o.timestamp || '').slice(11, 19);
    if (m.role === 'user') {
        const text = (m.content || []).filter(c => c.type === 'text').map(c => c.text).join(' ');
        console.log(`${ts}  USER   ${text.slice(0, 60)}`);
    } else if (m.role === 'assistant') {
        for (const c of (m.content || [])) {
            if (c.type === 'toolCall') {
                console.log(`${ts}  CALL   ${c.name} ${JSON.stringify(c.arguments || {}).slice(0, 80)}`);
            } else if (c.type === 'text' && c.text) {
                console.log(`${ts}  TEXT   ${c.text.replace(/\n/g, ' ').slice(0, 60)}`);
            }
        }
        if (m.stopReason === 'error') console.log(`${ts}  !!STOP-ERROR  ${m.errorMessage || ''}`);
    } else if (m.role === 'toolResult') {
        const text = (m.content || []).filter(c => c.type === 'text').map(c => c.text).join(' ');
        const imgs = (m.content || []).filter(c => c.type === 'image').length;
        console.log(`${ts}  RESULT ${m.isError ? 'ERR ' : 'ok  '} ${m.toolName} ${text.replace(/\n/g, ' ').slice(0, 60)}${imgs ? ` [+${imgs} img]` : ''}`);
    }
}

/**
 * MCPManager 与 /api/mcp 路由测试
 * 用手写的最小 stdio MCP 服务器夹具（test/fixtures/mcpEchoServer.js）
 * 驱动完整链路：spawn → initialize 握手 → tools/list → tools/call → 断开。
 * 每个用例独立临时 dataDir，settings.json 由夹具写入。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const request = require('supertest');

const MCPManager = require('../../utils/mcpManager');
const createMcpRouter = require('../../routes/mcp');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'mcpEchoServer.js');

/** HTTP 传输夹具：手写 MCP JSON-RPC over HTTP（无状态，单 JSON 响应） */
async function startHttpMcpServer() {
    const app = express();
    app.use(express.json());
    app.post('/mcp', (req, res) => {
        const msg = req.body;
        if (!msg || msg.jsonrpc !== '2.0') return res.status(400).end();
        if (msg.id === undefined) return res.status(202).end();   // 通知无需应答
        const reply = (result) => res.json({ jsonrpc: '2.0', id: msg.id, result });
        switch (msg.method) {
            case 'initialize':
                reply({
                    protocolVersion: msg.params.protocolVersion,
                    capabilities: { tools: {}, resources: {}, prompts: {} },
                    serverInfo: { name: 'http-test', version: '1.0.0' }
                });
                break;
            case 'tools/list':
                reply({ tools: [{ name: 'ping', description: 'ping 工具', inputSchema: { type: 'object', properties: {} } }] });
                break;
            case 'tools/call':
                reply({ content: [{ type: 'text', text: 'pong' }], isError: false });
                break;
            case 'resources/list':
                reply({ resources: [{ uri: 'test://info', name: 'info', mimeType: 'text/plain' }] });
                break;
            case 'resources/read':
                reply({ contents: [{ uri: 'test://info', mimeType: 'text/plain', text: 'hello-resource' }] });
                break;
            case 'prompts/list':
                reply({ prompts: [{ name: 'greet', description: '打招呼模板', arguments: [] }] });
                break;
            case 'prompts/get':
                reply({ messages: [{ role: 'user', content: { type: 'text', text: '你好呀' } }] });
                break;
            default:
                reply({});
        }
    });
    app.delete('/mcp', (req, res) => res.status(200).end());
    return new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
    });
}

// 模块级清理：任一 describe 里的 manager 都在用例结束后断开全部连接
// （MCP 子进程的 stdio 管道句柄不释放，jest 会挂在退出阶段）
let manager;
afterEach(async () => {
    if (manager) {
        manager.closeAll();
        manager = null;
    }
});

/** 建临时 dataDir 并写入 settings.json（可附带 pi 权限分级文件） */
async function makeDataDir(servers, permissionLevel) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-mcp-'));
    fs.writeFileSync(
        path.join(dir, 'settings.json'),
        JSON.stringify({ mcp: { servers } }, null, 2)
    );
    if (permissionLevel) {
        fs.mkdirSync(path.join(dir, 'pi'), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'pi', 'settings.json'),
            JSON.stringify({ permissionLevel }, null, 2)
        );
    }
    return dir;
}

const ECHO_SERVER = {
    id: 't1',
    name: 'echo',
    command: process.execPath,
    args: [FIXTURE],
    enabled: true
};

describe('MCPManager（stdio MCP 宿主）', () => {
    test('applyConfig 连接 fixture → 工具清单 → 调用回显 → 断开', async () => {
        const dataDir = await makeDataDir([ECHO_SERVER]);
        manager = new MCPManager({ dataDir });

        await manager.applyConfig();
        expect(manager.servers.get('t1').status).toBe('running');

        const tools = await manager.getAllTools();
        const echo = tools.find((t) => t.serverId === 't1' && t.name === 'echo');
        expect(echo).toBeTruthy();
        expect(echo.description).toContain('回显');

        const r = await manager.callTool('t1', 'echo', { text: '你好' });
        expect(r.ok).toBe(true);
        expect(r.isError).toBe(false);
        expect(r.text).toBe('echo:你好');

        await manager.disconnect('t1');
        expect(manager.servers.size).toBe(0);
        const after = await manager.callTool('t1', 'echo', { text: 'x' });
        expect(after.ok).toBe(false);
    }, 30000);

    test('saveServers 持久化 settings.json 并差量应用（停用即断开）', async () => {
        const dataDir = await makeDataDir([]);
        manager = new MCPManager({ dataDir });

        const saved = await manager.saveServers([{
            name: 'echo',
            command: process.execPath,
            args: [FIXTURE],
            enabled: true
        }]);
        expect(manager.servers.size).toBe(1);
        expect(saved.servers[0].id).toBeTruthy();

        const file = JSON.parse(
            fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf-8')
        );
        expect(file.mcp.servers).toHaveLength(1);
        expect(file.mcp.servers[0].command).toBe(process.execPath);

        // 停用 → 自动断开
        await manager.saveServers([{ ...file.mcp.servers[0], enabled: false }]);
        expect(manager.servers.size).toBe(0);
    }, 30000);

    test('配置变化触发重连（命令变化 → 旧连接被替换）', async () => {
        const dataDir = await makeDataDir([ECHO_SERVER]);
        manager = new MCPManager({ dataDir });
        await manager.applyConfig();

        await manager.saveServers([{ ...ECHO_SERVER, name: 'echo2' }]);
        const entry = manager.servers.get('t1');
        expect(entry.status).toBe('running');
        expect(entry.cfg.name).toBe('echo2');
    }, 30000);

    test('_childEnv：+ 前缀把值前置追加到继承环境（PATH 场景）', () => {
        manager = new MCPManager({ dataDir: os.tmpdir() });
        const env = manager._childEnv({ PATH: '+E:\\venv\\Scripts', NEW_VAR: 'v' });
        expect(env.PATH.startsWith('E:\\venv\\Scripts;')).toBe(true);
        expect(env.NEW_VAR).toBe('v');
    });

    test('_childEnv：启动命令所在目录自动前置到 PATH（免手配环境变量）', () => {
        manager = new MCPManager({ dataDir: os.tmpdir() });
        const env = manager._childEnv({}, 'H:\\proj\\mcp\\.venv\\Scripts\\comfy-mcp.exe');
        expect(env.PATH.startsWith('H:\\proj\\mcp\\.venv\\Scripts;')).toBe(true);
    });

    test('_parseWhichWorkspace：解析 comfy which 的 envelope 输出', () => {
        const ws = MCPManager._parseWhichWorkspace({
            schema: 'envelope/1', ok: true, command: 'which',
            data: { workspace_path: 'I:\\ComfyUI', workspace_type: 'default' }
        });
        expect(ws).toBe('I:\\ComfyUI');
        expect(MCPManager._parseWhichWorkspace(null)).toBe(null);
        expect(MCPManager._parseWhichWorkspace({ ok: true, data: {} })).toBe(null);
        expect(MCPManager._parseWhichWorkspace({ ok: false, data: { workspace_path: 'X' } })).toBe('X');
    });

    test('HTTP 传输：远程服务器连接/工具/调用/资源/提示词/刷新', async () => {
        const { server, port } = await startHttpMcpServer();
        try {
            const dataDir = await makeDataDir([{
                id: 'r1', name: 'remote', transport: 'http',
                url: `http://127.0.0.1:${port}/mcp`, enabled: true
            }], 'full');
            manager = new MCPManager({ dataDir });
            await manager.applyConfig();
            expect(manager.servers.get('r1').status).toBe('running');

            expect((await manager.getAllTools()).some((t) => t.name === 'ping')).toBe(true);
            expect((await manager.callTool('r1', 'ping', {})).text).toBe('pong');
            expect((await manager.readResource('r1', 'test://info')).text).toBe('hello-resource');
            expect((await manager.getPrompt('r1', 'greet', {})).text).toBe('user: 你好呀');
            const refresh = await manager.refresh('r1');
            expect(refresh.ok).toBe(true);
        } finally {
            await new Promise((r) => server.close(r));
        }
    }, 30000);

    test('权限分级门禁：readonly 下标准级服务器不可见，升权后恢复', async () => {
        const dataDir = await makeDataDir([{ ...ECHO_SERVER, minLevel: 'standard' }], 'readonly');
        manager = new MCPManager({ dataDir });
        await manager.applyConfig();

        // 全局 readonly < 服务器 standard：工具不暴露、调用被拦
        expect((await manager.getAllTools())).toHaveLength(0);
        const blocked = await manager.callTool('t1', 'echo', { text: 'x' });
        expect(blocked.ok).toBe(false);
        expect(blocked.text).toContain('权限不足');

        // 全局升到 standard：恢复可见可用（免重启，文件即真源）
        fs.mkdirSync(path.join(dataDir, 'pi'), { recursive: true });
        fs.writeFileSync(
            path.join(dataDir, 'pi', 'settings.json'),
            JSON.stringify({ permissionLevel: 'standard' }, null, 2)
        );
        expect((await manager.getAllTools())).toHaveLength(1);
        expect((await manager.callTool('t1', 'echo', { text: 'x' })).ok).toBe(true);
    }, 30000);

    test('disabledTools：停用的工具不暴露且调用被拦', async () => {
        const dataDir = await makeDataDir([{ ...ECHO_SERVER, disabledTools: ['echo'] }], 'full');
        manager = new MCPManager({ dataDir });
        await manager.applyConfig();

        expect((await manager.getAllTools())).toHaveLength(0);
        const r = await manager.callTool('t1', 'echo', { text: 'x' });
        expect(r.ok).toBe(false);
        expect(r.text).toContain('工具已被停用');
    }, 30000);

    test('saveServers 保留 minLevel/disabledTools/comfyRoot，路径变动自动认领', async () => {
        const dataDir = await makeDataDir([]);
        manager = new MCPManager({ dataDir });
        const result = await manager.saveServers([{
            name: 'echo', command: process.execPath, args: [FIXTURE],
            enabled: true, minLevel: 'full', disabledTools: ['echo'],
            comfyRoot: 'D:\\ComfyUI'
        }]);
        const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf-8'));
        expect(file.mcp.servers[0].minLevel).toBe('full');
        expect(file.mcp.servers[0].disabledTools).toEqual(['echo']);
        // 认领的 ComfyUI 根目录随配置持久化（F5 后回显）
        expect(file.mcp.servers[0].comfyRoot).toBe('D:\\ComfyUI');
        // minLevel=full 在全局 standard（未写 pi 权限文件）下不可见
        expect((await manager.getAllTools())).toHaveLength(0);

        // 路径有变动 → 自动认领（夹具目录无 comfy.exe，认领结果如实报错）
        expect(result.claims).toHaveLength(1);
        expect(result.claims[0].ok).toBe(false);
        expect(result.claims[0].output).toContain('comfy.exe');
        // 路径未变化 → 不重复认领
        const again = await manager.saveServers([{ ...file.mcp.servers[0] }]);
        expect(again.claims).toHaveLength(0);
    }, 30000);
});

describe('/api/mcp 路由', () => {
    test('overview 返回连接状态，call 代理工具调用', async () => {
        const dataDir = await makeDataDir([ECHO_SERVER]);
        manager = new MCPManager({ dataDir });
        await manager.applyConfig();

        const app = express();
        app.use(express.json());
        app.use('/api/mcp', createMcpRouter({ mcpManager: manager }));

        const overview = await request(app).get('/api/mcp/overview');
        expect(overview.status).toBe(200);
        expect(overview.body.status).toBe('ok');
        expect(overview.body.servers[0].status).toBe('running');
        expect(overview.body.servers[0].tools.some((t) => t.name === 'echo')).toBe(true);

        const call = await request(app)
            .post('/api/mcp/call')
            .send({ serverId: 't1', tool: 'echo', args: { text: 'x' } });
        expect(call.status).toBe(200);
        expect(call.body.status).toBe('ok');
        expect(call.body.text).toBe('echo:x');

        const tools = await request(app).get('/api/mcp/tools');
        expect(tools.body.tools[0].serverName).toBe('echo');
    }, 30000);
});

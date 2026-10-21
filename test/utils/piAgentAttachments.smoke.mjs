/**
 * piAgentManager 附图会话级登记的冒烟测试（node 直跑不入 jest，与
 * lumenWeb.smoke.mjs 同机制——直接 node test/utils/piAgentAttachments.smoke.mjs）。
 *
 * 覆盖"附图引用不再只活一条消息"的登记语义：发图→追问参数（不带图）
 * 的下一轮 attachment:N 仍命中；存档间不串图；LRU 封顶；清屏作废。
 * prompt() 本体会 spawn pi 进程，不可直测——这里直测它调用的登记/
 * 解析/清理三个方法（行为契约与 prompt 内注记分支共用同一份数据）。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const PiAgentManager = require(join(process.cwd(), 'utils', 'piAgentManager.js'));

const IMG = (tag) => ({ type: 'image', data: Buffer.from(tag).toString('base64'), mimeType: 'image/png' });

function makeManager() {
    const dataDir = mkdtempSync(join(tmpdir(), 'lumen-pi-att-'));
    return new PiAgentManager({ projectRoot: process.cwd(), dataDir, clients: new Map() });
}

// 1. 空登记：无附图时返回空列表
{
    const m = makeManager();
    assert.deepEqual(m.getAttachments(), [], '空登记应返回空列表');
}

// 2. 带图登记 → attachment:1 命中，对象形态归一成 data URL
//    （真实流程 switchToArchive 先设 currentArchiveKey，这里同步镜像）
{
    const m = makeManager();
    m.currentArchiveKey = 'anima-2';
    m._registerPromptAttachments('anima-2', [IMG('red-dress')]);
    const atts = m.getAttachments();
    assert.equal(atts.length, 1);
    assert.equal(atts[0].ref, 'attachment:1');
    assert.ok(atts[0].dataUrl.startsWith('data:image/png;base64,'), '对象形态应归一为 data URL');
    assert.equal(atts[0].mediaType, 'image/png');
}

// 3. 核心回归（截图场景）：发图后不带图追问，引用仍命中（回退不覆盖）
{
    const m = makeManager();
    m._registerPromptAttachments('anima-2', [IMG('red-dress')]);
    m._registerPromptAttachments('anima-2', []);   // 用户回 "2X"，无附图
    m.currentArchiveKey = 'anima-2';               // switchToArchive 已在同存档
    const atts = m.getAttachments();
    assert.equal(atts.length, 1, '不带图的后续消息应回退到上一次登记');
    assert.equal(atts[0].ref, 'attachment:1');
}

// 4. 新图覆盖旧登记：最近一条含附图消息胜出
{
    const m = makeManager();
    m._registerPromptAttachments('anima-2', [IMG('old')]);
    m._registerPromptAttachments('anima-2', [IMG('new1'), IMG('new2')]);
    m.currentArchiveKey = 'anima-2';
    const atts = m.getAttachments();
    assert.equal(atts.length, 2);
    assert.ok(atts[0].dataUrl.includes(Buffer.from('new1').toString('base64')), '应是最新一条的图');
}

// 5. 存档隔离：不跨存档串图
{
    const m = makeManager();
    m._registerPromptAttachments('A', [IMG('only-a')]);
    m.currentArchiveKey = 'B';
    assert.deepEqual(m.getAttachments(), [], '存档 B 不应看到存档 A 的附图');
    m.currentArchiveKey = 'A';
    assert.equal(m.getAttachments().length, 1, '切回存档 A 应仍命中');
}

// 6. LRU 封顶：超出 ATT_ARCHIVE_MAX 淘汰最久未用存档
{
    const m = makeManager();
    const cap = 12;   // 与 ATT_ARCHIVE_MAX 一致
    for (let i = 0; i < cap + 1; i++) m._registerPromptAttachments(`arch-${i}`, [IMG(`i${i}`)]);
    m.currentArchiveKey = 'arch-0';
    assert.deepEqual(m.getAttachments(), [], '最久未用的 arch-0 应被淘汰');
    m.currentArchiveKey = `arch-${cap}`;
    assert.equal(m.getAttachments().length, 1, '最新存档应保留');
    // 重新使用中间存档后，它应排到尾部不被下次淘汰
    m.currentArchiveKey = 'arch-5';
    m._registerPromptAttachments('arch-5', [IMG('refreshed')]);
    m._registerPromptAttachments('arch-new', [IMG('x')]);
    m.currentArchiveKey = 'arch-5';
    assert.equal(m.getAttachments().length, 1, '刚刷新过的存档不应被淘汰');
}

// 7. 清屏作废：_clearAttachments 清空全部存档登记
{
    const m = makeManager();
    m._registerPromptAttachments('A', [IMG('a')]);
    m._registerPromptAttachments('B', [IMG('b')]);
    m._clearAttachments();
    m.currentArchiveKey = 'A';
    assert.deepEqual(m.getAttachments(), [], '清屏后登记应全空');
}

// 8. 字符串形态兼容：旧协议直接发 data URL 字符串也能归一
{
    const m = makeManager();
    m._registerPromptAttachments('A', ['data:image/jpeg;base64,QUJD']);
    m.currentArchiveKey = 'A';
    const atts = m.getAttachments();
    assert.equal(atts[0].mediaType, 'image/jpeg');
    assert.ok(atts[0].dataUrl.startsWith('data:image/jpeg;base64,'));
}

console.log('piAgentAttachments.smoke: 8 组断言全部通过');

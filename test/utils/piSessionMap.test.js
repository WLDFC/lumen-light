/**
 * piAgentManager 会话映射测试（2026-11-20 多会话）
 * 覆盖：session-map.json v1→v2 迁移（存量单存档映射归到 ::legacy，与前端
 * 首个会话固定 id 对位）、v2 结构识别、<存档>::<会话id> 配对键规则。
 * 用 Object.create 挂原型做轻量实例（不走构造器的 fs 依赖）。
 */

const PiAgentManager = require('../../utils/piAgentManager');

/** 最小桩实例：只挂映射读写用到的字段与方法依赖 */
const makeStub = (rawMap) => {
    const stub = Object.create(PiAgentManager.prototype);
    stub._readJson = () => rawMap;
    return stub;
};

describe('piAgentManager._loadSessionMap v1→v2 迁移', () => {
    test('v1 单存档映射（存档键 → 会话文件）整体归到 ::legacy', () => {
        const stub = makeStub({
            '__unsaved__': 'sessions/abc.jsonl',
            '存档一': 'sessions/def.jsonl'
        });
        const map = stub._loadSessionMap();
        expect(map.version).toBe(2);
        expect(map.pairs).toEqual({
            '__unsaved__::legacy': 'sessions/abc.jsonl',
            '存档一::legacy': 'sessions/def.jsonl'
        });
    });

    test('v2 结构原样收下（version 2 + pairs）', () => {
        const v2 = { version: 2, pairs: { '__unsaved__::sabc': 'sessions/x.jsonl' } };
        const stub = makeStub(v2);
        expect(stub._loadSessionMap()).toBe(v2);
    });

    test('空文件/损坏 JSON → 空 v2 映射', () => {
        const stub = makeStub(null);
        const map = stub._loadSessionMap();
        expect(map.version).toBe(2);
        expect(map.pairs).toEqual({});
    });

    test('v1 里的非字符串值（脏数据）不进 pairs', () => {
        const stub = makeStub({ '__unsaved__': 'ok.jsonl', '脏档': 42, '脏档2': null });
        const map = stub._loadSessionMap();
        expect(map.pairs).toEqual({ '__unsaved__::legacy': 'ok.jsonl' });
    });
});

describe('piAgentManager._pairKey 绑定键规则', () => {
    test('<存档>::<会话id>；空存档归 __unsaved__，空会话归 legacy', () => {
        const stub = Object.create(PiAgentManager.prototype);
        expect(stub._pairKey('存档一', 'sabc')).toBe('存档一::sabc');
        expect(stub._pairKey(null, null)).toBe('__unsaved__::legacy');
        expect(stub._pairKey('', 'sabc')).toBe('__unsaved__::sabc');
        expect(stub._pairKey('存档一', null)).toBe('存档一::legacy');
    });
});

/**
 * detect 测试（2026-11-09 新增：从图片识别分镜模板）
 * 覆盖：_parseDetectReply 鲁棒解析（panels 对象/裸数组/代码围栏/前后说明
 * 文字/x y w h 变形兼容/尾逗号修复/非 JSON 报错带回复开头）与
 * _normalizeDetectCells 归一化（千分比→0~1、倒序对换、越界钳制、
 * 小格噪声剔除、数量上限截断）
 */

const { makeInstance } = require('./helpers');

describe('_parseDetectReply 识别回复解析', () => {
    const inst = makeInstance([]);

    test('标准 panels 对象', () => {
        const cells = inst._parseDetectReply(
            '{"panels":[{"x1":10,"y1":20,"x2":500,"y2":600},{"x1":520,"y1":20,"x2":990,"y2":400}]}');
        expect(cells).toHaveLength(2);
        expect(cells[0]).toEqual({ x1: 10, y1: 20, x2: 500, y2: 600 });
    });

    test('代码围栏 + 前后说明文字 + 裸数组', () => {
        const reply = '好的，识别结果如下：\n```json\n[{"x1":0,"y1":0,"x2":1000,"y2":500}]\n```\n以上。';
        expect(inst._parseDetectReply(reply)).toEqual([
            { x1: 0, y1: 0, x2: 1000, y2: 500 }
        ]);
    });

    test('x/y/w/h 变形兼容', () => {
        const cells = inst._parseDetectReply('{"panels":[{"x":100,"y":200,"w":300,"h":400}]}');
        expect(cells).toEqual([{ x1: 100, y1: 200, x2: 400, y2: 600 }]);
    });

    test('尾逗号修复', () => {
        const cells = inst._parseDetectReply(
            '{"panels":[{"x1":1,"y1":2,"x2":3,"y2":4},]}');
        expect(cells).toHaveLength(1);
    });

    test('非 object 条目与坐标缺失条目跳过', () => {
        const cells = inst._parseDetectReply(
            '{"panels":[null,"x",{"x1":"a","y1":1,"x2":2,"y2":3},{"x1":1,"y1":2,"x2":3,"y2":4}]}');
        expect(cells).toEqual([{ x1: 1, y1: 2, x2: 3, y2: 4 }]);
    });

    test('非 JSON 回复抛错并带回复开头', () => {
        expect(() => inst._parseDetectReply('我觉得这张图有三个格子'))
            .toThrow(/我觉得这张图有三个格子/);
    });
});

describe('_normalizeDetectCells 坐标归一化', () => {
    const inst = makeInstance([]);

    test('千分比 → 0~1 归一化', () => {
        expect(inst._normalizeDetectCells([{ x1: 100, y1: 200, x2: 600, y2: 800 }]))
            .toEqual([{ x: 0.1, y: 0.2, w: 0.5, h: 0.6 }]);
    });

    test('倒序对换（x1>x2 / y1>y2）', () => {
        expect(inst._normalizeDetectCells([{ x1: 600, y1: 800, x2: 100, y2: 200 }]))
            .toEqual([{ x: 0.1, y: 0.2, w: 0.5, h: 0.6 }]);
    });

    test('越界钳制到 0~1000', () => {
        expect(inst._normalizeDetectCells([{ x1: -50, y1: -50, x2: 1200, y2: 1200 }]))
            .toEqual([{ x: 0, y: 0, w: 1, h: 1 }]);
    });

    test('单轴小于 2% 的噪声格剔除', () => {
        const cells = inst._normalizeDetectCells([
            { x1: 0, y1: 0, x2: 10, y2: 500 },      // w=1% 剔
            { x1: 0, y1: 0, x2: 500, y2: 15 },      // h=1.5% 剔
            { x1: 0, y1: 0, x2: 500, y2: 500 }      // 保留
        ]);
        expect(cells).toEqual([{ x: 0, y: 0, w: 0.5, h: 0.5 }]);
    });

    test('数量上限截断（40 格）', () => {
        // 每格高 25‰（>2% 噪声线），50 格里第 41 格起 y 已越界钳到满幅被剔——
        // 恰好验证「上限截断」与「钳制剔除」的复合行为
        const many = Array.from({ length: 50 }, (_, i) => (
            { x1: 0, y1: i * 25, x2: 1000, y2: i * 25 + 25 }));
        expect(inst._normalizeDetectCells(many)).toHaveLength(40);
    });
});

/**
 * ==========================================================================
 * RhAppImporter 单元测试
 * 覆盖应用参数模板解析：IMAGE 槽位（fieldType 与文件名兜底）/ LIST 选项
 * 解出 / STRING 提示词角色 / INT-FLOAT 文本行 / BOOLEAN 开关 / 未知类型
 * 跳过 / fieldData 双形态（JSON 字符串与已解数组）/ 空模板报错。
 * 被测文件是浏览器端经典脚本（依赖全局 window），用 vm 模块在
 * 同一上下文中执行（与 ComfyParamScanner.test.js 同一套做法）。
 * ==========================================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = { console, window: {} };
vm.createContext(context);

const source = fs.readFileSync(
    path.join(__dirname, '../../js/utils/RhAppImporter.js'), 'utf-8');
vm.runInContext(source, context, { filename: 'RhAppImporter.js' });

const Importer = context.window.RhAppImporter;

/** 实测 apiCallDemo 返回形态的换装应用模板（Qwen Image 2.1） */
function sampleTemplate() {
    return {
        webappName: 'Qwen Image 2.1 图片换装',
        nodeInfoList: [
            {
                nodeId: '470', nodeName: 'LoadImage', fieldName: 'image',
                fieldType: 'IMAGE',
                fieldValue: 'd458a4eb...05e.png',
                fieldData: '[["example.png", "None"], {"image_upload": true}]',
                description: '图1：人物'
            },
            {
                nodeId: '510', nodeName: 'LoadImage', fieldName: 'image',
                fieldType: 'IMAGE',
                fieldValue: '2e541fa0...8a8.jpg',
                description: '图2：服装'
            },
            {
                nodeId: '13', nodeName: 'ResolutionSelector', fieldName: 'aspect_ratio',
                fieldType: 'LIST',
                fieldValue: '9:16 (Portrait Widescreen)',
                fieldData: JSON.stringify(['COMBO', {
                    default: '1:1 (Square)',
                    options: ['1:1 (Square)', '9:16 (Portrait Widescreen)', '16:9 (Widescreen)']
                }]),
                description: '画面比例'
            },
            {
                nodeId: '13', nodeName: 'ResolutionSelector', fieldName: 'megapixels',
                fieldType: 'FLOAT',
                fieldValue: '2',
                fieldData: JSON.stringify(['FLOAT', { max: 16, min: 0.1, step: 0.1 }]),
                description: '分辨率大小'
            },
            {
                nodeId: '516', nodeName: 'JjkText', fieldName: 'text',
                fieldType: 'STRING',
                fieldValue: '图1女人穿上图2的服装',
                fieldData: '["STRING", {"multiline": true}]',
                description: '提示词'
            }
        ]
    };
}

describe('RhAppImporter', () => {
    test('完整模板：图片槽位/下拉/数值/提示词各归其位，label 取 description', () => {
        const { params, error } = Importer.import(sampleTemplate());
        expect(error).toBeUndefined();
        expect(params).toHaveLength(5);

        // 图片槽位（两张，key 同为 image 但 nodeId 不同不去重）
        expect(params[0]).toMatchObject({
            nodeId: '470', fieldName: 'image', label: '图1：人物', type: 'image'
        });
        expect(params[1]).toMatchObject({ nodeId: '510', type: 'image' });

        // 下拉：选项从 fieldData JSON 解出，def 取模板 fieldValue
        expect(params[2]).toMatchObject({
            nodeId: '13', fieldName: 'aspect_ratio', label: '画面比例', type: 'list'
        });
        expect(params[2].options).toEqual([
            '1:1 (Square)', '9:16 (Portrait Widescreen)', '16:9 (Widescreen)'
        ]);
        expect(params[2].def).toBe('9:16 (Portrait Widescreen)');

        // 数值：文本行，def 预填（空串提交给 FLOAT 字段平台会转换失败）
        expect(params[3]).toMatchObject({
            fieldName: 'megapixels', label: '分辨率大小', type: 'string', def: '2'
        });

        // 提示词：带 role=prompt（连线提示词自动兜底）
        expect(params[4]).toMatchObject({
            fieldName: 'text', label: '提示词', type: 'string', role: 'prompt'
        });
        expect(params[4].def).toBe('图1女人穿上图2的服装');
    });

    test('无 description 时 label 回退字段名；图片槽位序号递增', () => {
        const { params } = Importer.import({
            nodeInfoList: [
                { nodeId: '1', fieldName: 'image', fieldType: 'IMAGE', fieldValue: 'a.png' },
                { nodeId: '2', fieldName: 'mask', fieldType: 'IMAGE', fieldValue: 'b.png' }
            ]
        });
        expect(params[0].label).toBe('输入图片1');
        expect(params[1].label).toBe('输入图片2');
    });

    test('fieldName=image 但 fieldValue 不是文件名：不识别为图片槽位', () => {
        const { params } = Importer.import({
            nodeInfoList: [
                { nodeId: '1', fieldName: 'image', fieldType: 'STRING', fieldValue: 'hello' }
            ]
        });
        expect(params[0].type).toBe('string');
    });

    test('负面提示词 role 识别（description 与 fieldName 两条路径）', () => {
        const { params } = Importer.import({
            nodeInfoList: [
                { nodeId: '1', fieldName: 'text', fieldType: 'STRING', description: '负面提示词' },
                { nodeId: '2', fieldName: 'negative_prompt', fieldType: 'STRING' }
            ]
        });
        expect(params[0].role).toBe('negative');
        expect(params[1].role).toBe('negative');
    });

    test('BOOLEAN 渲染为 true/false 下拉，def 归一小写', () => {
        const { params } = Importer.import({
            nodeInfoList: [
                { nodeId: '1', fieldName: 'enable', fieldType: 'BOOLEAN', fieldValue: 'True' }
            ]
        });
        expect(params[0].type).toBe('list');
        expect(params[0].options).toEqual(['true', 'false']);
        expect(params[0].def).toBe('true');
    });

    test('fieldData 已是数组形态（非 JSON 字符串）也能解出选项', () => {
        const { params } = Importer.import({
            nodeInfoList: [
                {
                    nodeId: '1', fieldName: 'style', fieldType: 'LIST', fieldValue: 'anime',
                    fieldData: ['COMBO', { options: ['anime', 'realistic'] }]
                }
            ]
        });
        expect(params[0].options).toEqual(['anime', 'realistic']);
    });

    test('fieldData 损坏/无选项的 LIST 回退文本行', () => {
        const { params } = Importer.import({
            nodeInfoList: [
                { nodeId: '1', fieldName: 'style', fieldType: 'LIST', fieldValue: 'x', fieldData: 'not-json' }
            ]
        });
        expect(params[0].type).toBe('string');
    });

    test('未知类型且无标量值：跳过；全部不可调时报错', () => {
        const empty = Importer.import({
            nodeInfoList: [{ nodeId: '1', fieldName: 'mystery', fieldType: 'WIDGET' }]
        });
        expect(empty.error).toBeTruthy();

        const mixed = Importer.import({
            nodeInfoList: [
                { nodeId: '1', fieldName: 'mystery', fieldType: 'WIDGET' },
                { nodeId: '2', fieldName: 'seed', fieldType: 'INT', fieldValue: '0' }
            ]
        });
        expect(mixed.params).toHaveLength(1);
        expect(mixed.params[0].fieldName).toBe('seed');
    });

    test('空模板/缺 nodeInfoList 报错；同 nodeId:fieldName 去重', () => {
        expect(Importer.import(null).error).toBeTruthy();
        expect(Importer.import({ nodeInfoList: [] }).error).toBeTruthy();
        const dup = Importer.import({
            nodeInfoList: [
                { nodeId: '1', fieldName: 'text', fieldType: 'STRING', fieldValue: 'a' },
                { nodeId: '1', fieldName: 'text', fieldType: 'STRING', fieldValue: 'b' }
            ]
        });
        expect(dup.params).toHaveLength(1);
    });
});

/**
 * shape 测试（2026-11-09 自 mangaEditor.test.js 按模块拆分）
 * 覆盖：MangaEditor 形状工具与形状图层（MangaShape，自灯箱迁移 ADR 069）
 */

const { context, MangaEditor, CoordinateLayout, makeInstance } = require('./helpers');

describe('MangaEditor 形状工具与形状图层（MangaShape，自灯箱迁移 ADR 069）', () => {
    /** 形状工具用例实例：形状状态字段 + 舞台/持久化/历史桩（手势测试
     *  经 _localPoint/_toDraft 桩喂坐标——draft 坐标即屏幕坐标） */
    function makeShapeInst() {
        const inst = makeInstance([]);
        inst.activeTool = 'shape';
        inst._shapeOpts = {
            type: 'rect', fill: '#ffffff', strokeColor: '#000000',
            strokeWidth: 6, radius: 24, tail: 'lb'
        };
        inst._fillColor = '#ffffff';
        inst._strokeColor = '#000000';
        inst._lastShapeFill = null;
        inst._lastShapeStrokeWidth = null;
        inst._view = { scale: 1, ox: 0, oy: 0 };
        inst._activeLayerId = null;
        inst._selLayerId = null;
        inst._layerImgCache = new Map();
        inst._nextLayerId = 1;
        inst._guides = [];
        inst._stroke = null;
        inst._drag = null;
        inst.stageCv = {
            style: {},
            setPointerCapture() {},
            getBoundingClientRect: () => ({ left: 0, top: 0 })
        };
        inst._scheduleSave = () => {};
        inst._scheduleThumbRefresh = () => {};
        inst._renderLayerPanel = () => {};
        inst._redrawCursorRing = () => {};
        inst._histCalls = [];
        inst._histSnapshot = () => ({ mark: inst._histCalls.length });
        inst._commitHistory = (snap, label) => inst._histCalls.push(label);
        inst._localPoint = () => ({ px: 0, py: 0 });
        inst._toDraft = (px, py) => ({ x: px, y: py });
        return inst;
    }

    test('addShapeLayer：第四形态 schema/命名/插层栈顶', () => {
        const inst = makeShapeInst();
        const layer = inst.addShapeLayer(12, 34);
        expect(inst.draft.drawLayers).toHaveLength(1);
        expect(inst.draft.drawLayers[0]).toBe(layer);
        expect(layer.id).toBe(1);
        expect(layer.name).toBe('形状 1');
        expect(layer.visible).toBe(true);
        expect(layer.x).toBe(12);
        expect(layer.y).toBe(34);
        expect(layer.shape).toEqual({
            type: 'rect', w: 2, h: 2, fill: '#ffffff', strokeColor: '#000000',
            strokeWidth: 6, radius: 24, tail: 'lb'
        });
    });

    test('_shapeLayerBounds 含渲染外伸；_layerBounds 泛化出口认识形状层', () => {
        const inst = makeShapeInst();
        const layer = inst.addShapeLayer(10, 10);
        layer.shape.w = 50;
        layer.shape.h = 40;
        // sw=6 矩形外伸 = ceil(6/2)+1 = 4
        expect(inst._shapeLayerBounds(layer)).toEqual([6, 6, 64, 54]);
        expect(inst._layerBounds(layer)).toEqual([6, 6, 64, 54]);
    });

    test('_shapeStart：空白建临时层进 shape-create；命中选中并反向同步选项', () => {
        const inst = makeShapeInst();
        inst._shapeStart(5, 5);
        expect(inst._drag.mode).toBe('shape-create');
        expect(inst._selLayerId).toBe(inst.draft.drawLayers[0].id);
        expect(inst.draft.drawLayers).toHaveLength(1);
        // 命中已有层：不进拖拽，_shapeOpts 被图层属性反向同步（防选项条
        // 默认值覆盖选中层既有属性，灯箱同款）
        const layer = inst.draft.drawLayers[0];
        inst._drag = null;
        layer.shape.w = 80;
        layer.shape.h = 60;
        layer.shape.fill = '#abcdef';
        layer.shape.strokeWidth = 9;
        inst._shapeStart(20, 20);
        expect(inst._drag).toBeNull();
        expect(inst._selLayerId).toBe(layer.id);
        expect(inst._shapeOpts.fill).toBe('#abcdef');
        expect(inst._shapeOpts.strokeWidth).toBe(9);
        expect(inst._lastShapeFill).toBe('#abcdef');
    });

    test('_shapeCreateMove：宽高/左上角实时更新，Shift 约束正方，反向拖换向', () => {
        const inst = makeShapeInst();
        inst._shapeStart(10, 10);
        inst._shapeCreateMove({ x: 50, y: 40 }, {});
        expect(inst._drag.layer.shape.w).toBe(40);
        expect(inst._drag.layer.shape.h).toBe(30);
        expect(inst._drag.layer.x).toBe(10);
        expect(inst._drag.layer.y).toBe(10);
        inst._shapeCreateMove({ x: 50, y: 40 }, { shiftKey: true });
        expect(inst._drag.layer.shape.w).toBe(40);
        expect(inst._drag.layer.shape.h).toBe(40);
        inst._shapeCreateMove({ x: 2, y: 4 }, {});   // 向左上拖过起点
        expect(inst._drag.layer.x).toBe(2);
        expect(inst._drag.layer.y).toBe(4);
        expect(inst._drag.layer.shape.w).toBe(8);
        expect(inst._drag.layer.shape.h).toBe(6);
    });

    test('_shapeStart 画幅外不新建（舞台黑边区按下直接忽略，ADR 069 真机修复二）', () => {
        const inst = makeShapeInst();
        inst._shapeStart(-50, 100);   // 左侧黑边
        inst._shapeStart(100, 1100);  // 底部黑边
        inst._shapeStart(1100, 1100); // 右下角外
        expect(inst.draft.drawLayers || []).toHaveLength(0);
        expect(inst._drag).toBeNull();
        inst._shapeStart(100, 100);   // 画幅内正常建
        expect(inst._drag && inst._drag.mode).toBe('shape-create');
    });

    test('_shapeCreateMove 全程钳画幅内：拖出黑边贴边停住', () => {
        const inst = makeShapeInst();
        inst._shapeStart(900, 900);
        inst._shapeCreateMove({ x: 1500, y: 1200 }, {});   // 拖进右侧/底部黑边
        expect(inst._drag.layer.x).toBe(900);
        expect(inst._drag.layer.y).toBe(900);
        expect(inst._drag.layer.shape.w).toBe(124);   // 1024-900：贴边不越界
        expect(inst._drag.layer.shape.h).toBe(124);
    });

    test('_shapeCreateMove Shift 大轴越界再钳：正方不越过底/右边', () => {
        const inst = makeShapeInst();
        inst._shapeStart(900, 950);
        inst._shapeCreateMove({ x: 1000, y: 960 }, { shiftKey: true });   // x 跨 100
        expect(inst._drag.layer.shape.w).toBe(100);   // Shift 取大轴
        expect(inst._drag.layer.shape.h).toBe(74);    // 底边越界再钳（1024-950）
        expect(inst._drag.layer.y + inst._drag.layer.shape.h).toBeLessThanOrEqual(1024);
    });

    test('_shapeCreateUp：按类型命名+「绘制形状」入账；干点静默摘除零历史', () => {
        const inst = makeShapeInst();
        inst._shapeOpts.type = 'bubble';
        inst._shapeStart(10, 10);
        inst._shapeCreateMove({ x: 110, y: 80 }, {});
        const layer = inst._drag.layer;
        inst._shapeCreateUp(inst._drag);
        expect(layer.name).toBe('气泡框');
        expect(inst._histCalls).toEqual(['绘制形状']);
        expect(inst.draft.drawLayers).toHaveLength(1);
        expect(inst._drag).toBeNull();
        // 干点（<6px）：临时层摘除、无新历史
        inst._shapeStart(10, 10);
        inst._shapeCreateMove({ x: 12, y: 12 }, {});
        inst._shapeCreateUp(inst._drag);
        expect(inst.draft.drawLayers).toHaveLength(1);
        expect(inst._histCalls).toEqual(['绘制形状']);
        expect(inst._drag).toBeNull();
    });

    test('select 手势 layer-move：平移写 x/y（包围盒钳制，外伸基准不漂移）', () => {
        const inst = makeShapeInst();
        const layer = inst.addShapeLayer(10, 10);
        layer.shape.w = 50;
        layer.shape.h = 40;
        inst._selLayerId = layer.id;
        inst.activeTool = 'select';
        inst._drag = {
            mode: 'layer-move', layerId: layer.id, moved: true,
            orig: inst._layerBounds(layer).slice(),
            origGeom: { x: 10, y: 10, w: 50, h: 40 },
            start: { x: 0, y: 0 }, histSnap: inst._histSnapshot()
        };
        inst._localPoint = () => ({ px: 30, py: 20 });
        inst._onPointerMove({ clientX: 0, clientY: 0 });
        expect(layer.x).toBe(40);
        expect(layer.y).toBe(30);
        expect(layer.shape.w).toBe(50);   // 拖动不改尺寸
    });

    test('select 已选层优先于元素分支：全画幅元素 bbox 不再吃掉层拖动（ADR 069 真机修复）', () => {
        const inst = makeShapeInst();
        inst.draft.items.push({ cid: 0, label: 'character', caption: '', bbox: [0, 0, 1024, 1024] });
        inst.selected = -1;
        inst._hiddenCids = new Set();
        const layer = inst.addShapeLayer(100, 100);
        layer.shape.w = 200;
        layer.shape.h = 100;
        inst._selectImageLayer(layer.id);
        inst.activeTool = 'select';
        inst._localPoint = () => ({ px: 150, py: 130 });   // 形状内部
        context.document = { activeElement: null };   // 焦点交还路径读 activeElement
        try {
            inst._onPointerDown({ pointerId: 1, button: 0, preventDefault() {} });
        } finally {
            delete context.document;   // 同橡皮测试：局部桩用完即撤
        }
        expect(inst._drag && inst._drag.mode).toBe('layer-move');
        expect(inst._drag.layerId).toBe(layer.id);
    });

    test('select 手势 layer-resize：八向非等比直改 x/y/w/h，边宽不随缩放', () => {
        const inst = makeShapeInst();
        const layer = inst.addShapeLayer(10, 10);
        layer.shape.w = 50;
        layer.shape.h = 40;
        inst._selLayerId = layer.id;
        inst.activeTool = 'select';
        inst._drag = {
            mode: 'layer-resize', layerId: layer.id, anchor: 'se', moved: true,
            orig: inst._layerBounds(layer).slice(),
            origGeom: { x: 10, y: 10, w: 50, h: 40 },
            histSnap: inst._histSnapshot()
        };
        inst._localPoint = () => ({ px: 90, py: 80 });
        inst._onPointerMove({ clientX: 0, clientY: 0 });
        expect(layer.x).toBe(10);   // 拖 se：左上角锚定
        expect(layer.y).toBe(10);
        expect(layer.shape.w).toBe(80);
        expect(layer.shape.h).toBe(70);
        expect(layer.shape.strokeWidth).toBe(6);   // 边宽保持设定值（用户拍板）
        // 拖 nw：右下角锚定，x/y 跟随
        inst._drag.origGeom = { x: layer.x, y: layer.y, w: layer.shape.w, h: layer.shape.h };
        inst._drag.anchor = 'nw';
        inst._localPoint = () => ({ px: 0, py: 0 });
        inst._onPointerMove({ clientX: 0, clientY: 0 });
        expect(layer.x).toBe(0);
        expect(layer.y).toBe(0);
        expect(layer.shape.w).toBe(90);
        expect(layer.shape.h).toBe(80);
    });

    test('_cancelDrag：shape-create 摘临时层；resize 回滚 x/y/w/h 四件套', () => {
        const inst = makeShapeInst();
        inst._shapeStart(10, 10);
        inst._shapeCreateMove({ x: 60, y: 50 }, {});
        inst._cancelDrag();
        expect(inst.draft.drawLayers).toHaveLength(0);
        expect(inst._drag).toBeNull();
        // resize 中断：几何回到拖拽前
        const layer = inst.addShapeLayer(10, 10);
        layer.shape.w = 50;
        layer.shape.h = 40;
        inst._selLayerId = layer.id;
        inst._drag = {
            mode: 'layer-resize', layerId: layer.id, anchor: 'se',
            orig: inst._layerBounds(layer).slice(),
            origGeom: { x: 10, y: 10, w: 50, h: 40 },
            histSnap: inst._histSnapshot()
        };
        inst._localPoint = () => ({ px: 90, py: 80 });
        inst._onPointerMove({ clientX: 0, clientY: 0 });
        expect(layer.shape.w).toBe(80);
        inst._cancelDrag();
        expect(layer.x).toBe(10);
        expect(layer.y).toBe(10);
        expect(layer.shape.w).toBe(50);
        expect(layer.shape.h).toBe(40);
    });

    test('_applyShapeOpts：未选中只落默认；选中实时生效', () => {
        const inst = makeShapeInst();
        inst._shapeOpts.type = 'ellipse';
        inst._applyShapeOpts();
        expect(inst.draft.drawLayers || []).toHaveLength(0);   // 无选中层不碰层栈
        const layer = inst.addShapeLayer(0, 0);
        inst._selLayerId = layer.id;
        inst._applyShapeOpts();
        expect(layer.shape.type).toBe('ellipse');
    });

    test('setColor 按工具分发到形状填充色（色板契约扩一档，ADR 068/069）', () => {
        const inst = makeShapeInst();
        inst.setColor('#112233');
        expect(inst._fillColor).toBe('#112233');
        expect(inst._shapeOpts.fill).toBe('#112233');
        // 选中层实时生效
        const layer = inst.addShapeLayer(0, 0);
        inst._selLayerId = layer.id;
        inst.setColor('#445566');
        expect(layer.shape.fill).toBe('#445566');
    });

    test('红斜杠开关：去填充↔恢复上次值；去边框↔恢复上次边宽', () => {
        const inst = makeShapeInst();
        const layer = inst.addShapeLayer(0, 0);
        inst._selLayerId = layer.id;
        layer.shape.fill = '#abcdef';
        layer.shape.strokeWidth = 3;
        inst._syncShapeOptsFromLayer(layer);   // 真实选择流程：选项条反向同步
        inst._toggleShapeFillNone();
        expect(layer.shape.fill).toBe('none');
        expect(inst._lastShapeFill).toBe('#abcdef');
        inst._toggleShapeFillNone();
        expect(layer.shape.fill).toBe('#abcdef');
        inst._toggleShapeStrokeNone();
        expect(layer.shape.strokeWidth).toBe(0);
        inst._toggleShapeStrokeNone();
        expect(layer.shape.strokeWidth).toBe(3);
    });

    // ==================== 钢笔工具（2026-11-11） ====================

    test('ShapeLayout.polyNormalize：绝对点集→局部点集+包围盒+原点；<3 点 null', () => {
        const S = context.window.ShapeLayout;   // vm 沙箱内取（直 require 会踩 window 赋值行）
        const n = S.polyNormalize([[10, 20], [50, 20], [30, 60]]);
        expect(n).toEqual({ x: 10, y: 20, points: [[0, 0], [40, 0], [20, 40]], w: 40, h: 40 });
        expect(S.polyNormalize([[0, 0], [10, 10]])).toBeNull();
    });

    test('ShapeLayout.polyScalePoints：点集随包围盒等比缩放', () => {
        const S = context.window.ShapeLayout;
        expect(S.polyScalePoints([[0, 0], [10, 0], [10, 10]], 10, 10, 30, 20))
            .toEqual([[0, 0], [30, 0], [30, 20]]);
    });

    test('_penStart：首点建会话且须画幅内；追加点钳进画幅', () => {
        const inst = makeShapeInst();
        inst._penStart(-5, -5);   // 首点画幅外被忽略（不建会话）
        expect(inst._pen).toBeUndefined();
        inst._penStart(10, 10);
        expect(inst._pen.pts).toEqual([[10, 10]]);
        inst._penStart(2000, 50);   // 超出画幅钳到右缘
        expect(inst._pen.pts[1]).toEqual([1024, 50]);
    });

    test('_penClose：≥3 点归一化建层入账并选中；<3 点静默取消零历史', () => {
        const inst = makeShapeInst();
        inst._penStart(10, 20);
        inst._penStart(50, 20);
        inst._penStart(30, 60);
        inst._penClose();
        expect(inst._pen).toBeNull();
        expect(inst.draft.drawLayers).toHaveLength(1);
        const layer = inst.draft.drawLayers[0];
        expect(layer.shape.type).toBe('poly');
        expect(layer.x).toBe(10);
        expect(layer.y).toBe(20);
        expect(layer.shape.points).toEqual([[0, 0], [40, 0], [20, 40]]);
        expect(layer.shape.w).toBe(40);
        expect(layer.shape.h).toBe(40);
        expect(layer.name).toBe('多边形');
        expect(layer.shape.fill).toBe('#ffffff');   // 属性取选项条默认值
        expect(inst._selLayerId).toBe(layer.id);
        expect(inst._histCalls).toContain('绘制多边形');
        // <3 点：静默取消（状态提示）零历史零建层
        inst._penStart(0, 0);
        inst._penStart(30, 30);
        inst._penClose();
        expect(inst._pen).toBeNull();
        expect(inst.draft.drawLayers).toHaveLength(1);
        expect(inst.statusCalls.at(-1).text).toContain('至少需要 3 个顶点');
    });

    test('近起点闭合：屏幕 8px 内点回起点即提交（≥3 点）', () => {
        const inst = makeShapeInst();
        inst._penStart(10, 10);
        inst._penStart(60, 10);
        inst._penStart(60, 60);
        inst._penStart(12, 12);   // 距起点 draft 距离 √8≈2.83 × scale 1 ≤ 8 → 闭合
        expect(inst._pen).toBeNull();
        expect(inst.draft.drawLayers).toHaveLength(1);
    });

    test('_setTool：pen 在白名单；切走工具会话静默丢弃', () => {
        const inst = makeShapeInst();
        inst._setTool('pen');
        expect(inst.activeTool).toBe('pen');
        inst._penStart(5, 5);
        expect(inst._pen).toBeDefined();
        inst._setTool('brush');
        expect(inst._pen).toBeNull();   // 切走丢弃零痕迹
    });

    test('钢笔建层继承圆角滑杆：radius 取 _shapeOpts（polyPath 顶点圆角）', () => {
        const inst = makeShapeInst();
        inst._shapeOpts.radius = 12;
        inst._penStart(10, 10);
        inst._penStart(60, 10);
        inst._penStart(60, 60);
        inst._penClose();
        expect(inst.draft.drawLayers[0].shape.radius).toBe(12);
    });
});

// ==========================================================================
// 形状条边宽/圆角数值框（2026-11-11）：滑杆旁可编辑数字，双向同步钳范围
// ==========================================================================

describe('MangaEditor 形状条数值框（边宽/圆角量化）', () => {
    /** _buildShapeBar 的最小 document 桩：元素 mock 记监听器与追加序；
     *  用完即删（remove.test.js withRemoveDoc 同款惯例） */
    function withBarDoc(fn) {
        const made = [];
        const mkEl = (tag) => {
            const el = {
                tag, style: {}, children: [], hidden: false,
                classList: { toggle() {}, add() {}, remove() {} },
                _listeners: {},
                addEventListener(t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); },
                fire(t) { (this._listeners[t] || []).forEach((f) => f()); },
                append(...kids) { this.children.push(...kids); },
                appendChild(k) { this.children.push(k); return k; },
                insertBefore(b) { this.children.push(b); }
            };
            made.push(el);
            return el;
        };
        context.document = { createElement: mkEl };
        try {
            return fn(made);
        } finally {
            delete context.document;
        }
    }

    function makeBarInst() {
        const inst = Object.create(MangaEditor.prototype);
        inst._shapeOpts = {
            type: 'rect', fill: '#ffffff', strokeColor: '#000000',
            strokeWidth: 6, radius: 24, tail: 'lb'
        };
        inst._lastShapeFill = null;
        inst._selLayerId = null;
        inst._renderStage = () => {};
        inst._renderLayerPanel = () => {};
        const header = {
            children: [],
            querySelector: () => null,      // 无 .manga-header-right → appendChild 分支
            appendChild(k) { this.children.push(k); }
        };
        inst.dialog = {
            querySelector: (sel) => sel === '.recipe-dialog-header' ? header : null
        };
        return inst;
    }

    const findNum = (made, key) => made.find((e) => e.className === 'manga-shape-num' && e.title.includes(key));

    test('数值框构建与初始值：紧跟滑杆之后，初值取 _shapeOpts', () => {
        const made = withBarDoc((made) => {
            const inst = makeBarInst();
            inst._buildShapeBar();
            return made;
        });
        const bar = made.find((e) => e.className === 'manga-shape-tools');
        const wNum = findNum(made, '边框宽度');
        const rNum = findNum(made, '圆角');
        expect(wNum.type).toBe('number');
        expect(wNum.value).toBe('6');           // makeShapeInst 默认 strokeWidth 6
        expect(rNum.value).toBe('24');          // radius 24
        // 追加序：… 边宽 label、滑杆、数值框、圆角 label、滑杆、数值框
        const names = bar.children.map((c) => c.className + '|' + (c.textContent || ''));
        expect(names).toContain('manga-brush-width-label|边宽');
        expect(names.indexOf('manga-brush-width-label|边宽') + 1).toBe(names.indexOf('manga-shape-range|'));
        expect(names.indexOf('manga-shape-range|') + 1).toBe(names.indexOf('manga-shape-num|'));
    });

    test('键入即生效：数字框 input → _shapeOpts/滑杆/应用同步；空输入不动', () => {
        withBarDoc(() => {
            const inst = makeBarInst();
            inst._buildShapeBar();
            const wNum = inst._shapeWidthNumEl;
            wNum.value = '14';
            wNum.fire('input');
            expect(inst._shapeOpts.strokeWidth).toBe(14);
            expect(inst._shapeWidthEl.value).toBe('14');   // 滑杆随动
            wNum.value = '';                               // 清空（打字中间态）
            wNum.fire('input');
            expect(inst._shapeOpts.strokeWidth).toBe(14);  // 不动
        });
    });

    test('越界钳制：change 时钳回滑杆范围并规范化回写', () => {
        withBarDoc(() => {
            const inst = makeBarInst();
            inst._buildShapeBar();
            const rNum = inst._shapeRadiusNumEl;
            rNum.value = '999';
            rNum.fire('change');
            expect(inst._shapeOpts.radius).toBe(120);
            expect(rNum.value).toBe('120');
            rNum.value = 'abc';
            rNum.fire('change');
            expect(rNum.value).toBe('120');   // 非法回写当前值
        });
    });

    test('滑杆拖动数值框随动；_syncShapeBarDom 对表数值框', () => {
        withBarDoc(() => {
            const inst = makeBarInst();
            inst._buildShapeBar();
            const width = inst._shapeWidthEl;
            width.value = '12';
            width.fire('input');
            expect(inst._shapeOpts.strokeWidth).toBe(12);
            expect(inst._shapeWidthNumEl.value).toBe('12');
            inst._shapeOpts.strokeWidth = 8;
            inst._syncShapeBarDom();
            expect(inst._shapeWidthNumEl.value).toBe('8');
            expect(inst._shapeRadiusNumEl.value).toBe(String(inst._shapeOpts.radius));
        });
    });
});

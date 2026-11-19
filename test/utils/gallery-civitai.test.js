/**
 * ==========================================================================
 * utils/gallery/civitai.js 单元测试：查询构造 + 缩略图重写 + 响应归一化
 * （纯函数层，网络在 routes/gallery.js）
 * ==========================================================================
 */

const { NSFW_MAP, SORT_MAP, buildPath, buildModelsSearchPath, rewriteThumbUrl, normalizeMeta, normalizeItems, normalizeModelSearch, MODELS_SEARCH_PAGE, MODEL_IMAGE_CAP } = require('../../utils/gallery/civitai');

/** 把适配器产出的路径回解析成参数对象（URLSearchParams 空格编成 +，直接匹配易错） */
function parseParams(path) {
    return new URLSearchParams(path.slice(path.indexOf('?') + 1));
}

describe('utils/gallery/civitai 查询构造', () => {
    test('SFW 三档映射：None / Soft / X（单值上限语义，逗号列表被 API 拒收）', () => {
        expect(buildPath({ nsfw: 'sfw' })).toContain('nsfw=None');
        expect(buildPath({ nsfw: 'soft' })).toContain('nsfw=Soft');
        expect(buildPath({ nsfw: 'r18' })).toContain('nsfw=X');
        // 未知档回退 SFW
        expect(buildPath({ nsfw: 'bogus' })).toContain('nsfw=None');
    });

    test('排序：缺省 hot（站内 Images 板块口径，作者多样性实测最好）；period 恒定下发缺省 Month', () => {
        const hot = parseParams(buildPath({}));
        expect(hot.get('sort')).toBe(SORT_MAP.hot);
        expect(hot.get('period')).toBe('Month');
        const fresh = parseParams(buildPath({ sort: 'new' }));
        expect(fresh.get('sort')).toBe(SORT_MAP.new);
        expect(fresh.get('period')).toBe('Month');
    });

    test('时间范围五档映射：Day/Week/Month/Year/AllTime', () => {
        expect(parseParams(buildPath({ period: 'day' })).get('period')).toBe('Day');
        expect(parseParams(buildPath({ period: 'week' })).get('period')).toBe('Week');
        expect(parseParams(buildPath({ period: 'year' })).get('period')).toBe('Year');
        expect(parseParams(buildPath({ period: 'all' })).get('period')).toBe('AllTime');
        expect(parseParams(buildPath({ period: 'bogus' })).get('period')).toBe('Month');   // 非法回落
    });

    test('基模筛选：baseModels 参数生效、空值不进查询串', () => {
        expect(parseParams(buildPath({ basemodels: 'Pony' })).get('baseModels')).toBe('Pony');
        expect(buildPath({}).includes('baseModels')).toBe(false);   // 全部基模=不传
    });

    test('cursor 与 username 进查询串；limit 钳制 1-200', () => {
        const p = parseParams(buildPath({ cursor: 'abc123', username: 'WLDFC', limit: 999 }));
        expect(p.get('cursor')).toBe('abc123');
        expect(p.get('username')).toBe('WLDFC');
        expect(p.get('limit')).toBe('200');
        expect(parseParams(buildPath({ limit: 0 })).get('limit')).toBe('48');   // 非法值回缺省
        expect(parseParams(buildPath({})).get('limit')).toBe('48');             // 缺省 48
    });
});

describe('utils/gallery/civitai 缩略图重写', () => {
    test('original=true → width=450,optimized=true（与封面重写同口径）', () => {
        expect(rewriteThumbUrl('https://image.civitai.com/h/1/original=true/f.jpeg'))
            .toBe('https://image.civitai.com/h/1/width=450,optimized=true/f.jpeg');
    });
    test('已有 width=N 段替换数值', () => {
        expect(rewriteThumbUrl('https://image.civitai.com/h/1/width=1152/f.jpeg'))
            .toBe('https://image.civitai.com/h/1/width=450/f.jpeg');
    });
    test('识别不了或空值原样返回', () => {
        expect(rewriteThumbUrl('https://example.com/a.jpeg')).toBe('https://example.com/a.jpeg');
        expect(rewriteThumbUrl('')).toBe('');
        expect(rewriteThumbUrl(null)).toBe(null);
    });
});

describe('utils/gallery/civitai 响应归一化', () => {
    test('完整字段抽取：meta 各键名变体、LoRA 资源过滤、原站链接', () => {
        const payload = {
            items: [{
                id: 42,
                url: 'https://image.civitai.com/h/42/original=true/f.jpeg',
                width: 1024,
                height: 1536,
                username: 'artist1',
                baseModel: 'Pony',
                thumbnail: null,
                stats: { likeCount: 1234 },
                modelVersionIds: [8899, 1234],
                meta: {
                    prompt: '1girl, masterpiece',
                    'Negative prompt': 'lowres',
                    Model: 'someModel v2',
                    baseModel: 'SDXL 1.0',
                    sampler: 'DPM++ 2M',
                    steps: 28,
                    'CFG scale': 7,
                    Seed: 123,
                    Size: '1024x1536',
                    resources: [
                        { type: 'lora', name: 'loraA' },
                        { type: 'lora', modelName: 'loraB' },
                        { type: 'checkpoint', name: 'notALora' }
                    ]
                }
            }],
            metadata: { nextCursor: 'cur-9' }
        };
        const { items, nextToken } = normalizeItems(payload);
        expect(items).toHaveLength(1);
        const it = items[0];
        expect(it.id).toBe('42');
        expect(it.source).toBe('civitai');
        expect(it.thumb).toContain('width=450,optimized=true');
        expect(it.full).toContain('original=true');
        expect(it.prompt).toBe('1girl, masterpiece');
        expect(it.negativePrompt).toBe('lowres');
        expect(it.model).toBe('someModel v2');
        expect(it.baseModel).toBe('Pony');              // 镜像顶层形态优先
        expect(it.loras).toEqual(['loraA', 'loraB']);   // 非 lora 资源剔除
        expect(it.sampler).toBe('DPM++ 2M');
        expect(it.steps).toBe('28');
        expect(it.cfgScale).toBe('7');
        expect(it.seed).toBe('123');
        expect(it.size).toBe('1024x1536');
        expect(it.score).toBe(1234);                    // stats.likeCount → 热度
        expect(it.modelVersionId).toBe('8899');         // 首个版本 id 透出
        expect(it.username).toBe('artist1');
        expect(it.link).toBe('https://civitai.com/images/42');
        expect(nextToken).toBe('cur-9');
    });

    test('镜像形态：meta=null 时字段空串、thumbnail=null 回退原图重写、meta.baseModel 兜底', () => {
        const payload = {
            items: [{
                id: 7,
                url: 'https://image.civitai.com/h/7/width=1152/f.jpeg',
                thumbnail: null,
                baseModel: 'SDXL 1.0',
                meta: null
            }]
        };
        const { items } = normalizeItems(payload);
        const it = items[0];
        expect(it.prompt).toBe('');
        expect(it.baseModel).toBe('SDXL 1.0');
        expect(it.thumb).toBe('https://image.civitai.com/h/7/width=450/f.jpeg');   // 重写缩宽
        expect(it.modelVersionId).toBe('');
        expect(it.score).toBe(0);
    });

    test('thumbnail 有值直用（不重写）', () => {
        const { items } = normalizeItems({
            items: [{ id: 1, url: 'https://a/original=true/x.jpeg', thumbnail: 'https://cdn/thumb.webp' }]
        });
        expect(items[0].thumb).toBe('https://cdn/thumb.webp');
    });

    test('无 metadata / 坏条目：nextToken=null、缺 id 或 url 的条目剔除', () => {
        const { items, nextToken } = normalizeItems({
            items: [{ id: 1, url: 'https://a/b' }, { url: 'no-id' }, { id: 2 }]
        });
        expect(items).toHaveLength(1);
        expect(nextToken).toBe(null);
    });

    test('payload 形态异常不抛错', () => {
        expect(normalizeItems(null)).toEqual({ items: [], nextToken: null });
        expect(normalizeItems({})).toEqual({ items: [], nextToken: null });
    });

    test('normalizeMeta：版本示例图元数据归一（/model-versions images[].meta 共用）', () => {
        const m = normalizeMeta({
            prompt: '1girl, masterpiece',
            'Negative prompt': 'lowres',
            Model: 'someModel',
            sampler: 'Euler a',
            steps: 28,
            'CFG scale': 7,
            Seed: 99,
            Size: '832x1216',
            resources: [{ type: 'lora', name: 'loraX' }]
        });
        expect(m.prompt).toBe('1girl, masterpiece');
        expect(m.negativePrompt).toBe('lowres');
        expect(m.model).toBe('someModel');
        expect(m.sampler).toBe('Euler a');
        expect(m.seed).toBe('99');
        expect(m.loras).toEqual(['loraX']);
        expect(normalizeMeta(null).prompt).toBe('');   // null meta 不抛错
    });
});

describe('utils/gallery/civitai Images 搜索（模型匹配聚合，2026-11-19）', () => {
    /** 造一个 /models 命中条目：单模型多版本展示图 */
    function model(name, versions, creator) {
        return {
            name,
            creator: { username: creator || 'maker1' },
            modelVersions: versions.map((v) => ({
                id: v.id,
                baseModel: v.base || 'SDXL 1.0',
                images: (v.images || []).map((im) => ({ type: 'image', nsfw: 'None', ...im }))
            }))
        };
    }

    test('buildModelsSearchPath：query/游标进查询串，limit=每页模型数', () => {
        const p = parseParams(buildModelsSearchPath({ query: '亚丝娜', cursor: 'c2' }));
        expect(p.get('query')).toBe('亚丝娜');
        expect(p.get('cursor')).toBe('c2');
        expect(p.get('limit')).toBe(String(MODELS_SEARCH_PAGE));
        expect(buildModelsSearchPath({}).includes('cursor')).toBe(false);
    });

    test('展示图扁平化：跨模型跨版本铺开，字段映射（底模/版本id/作者回退 creator）', () => {
        const payload = {
            items: [
                model('Asuna-SAO', [
                    { id: 11, base: 'Pony', images: [{ id: 100, url: 'https://image.civitai.com/h/100/original=true/a.jpeg', width: 832, height: 1216, username: 'imgAuthor' }] },
                    { id: 12, base: 'SD 1.5', images: [{ id: 101, url: 'https://image.civitai.com/h/101/width=1152/b.jpeg' }] }
                ]),
                model('Asuna-BA', [{ id: 13, images: [{ id: 100, url: 'https://image.civitai.com/h/100/original=true/a.jpeg' }] }])   // 跨模型重复图
            ],
            metadata: { nextCursor: 'mc-3' }
        };
        const { items, nextToken } = normalizeModelSearch(payload, { nsfw: 'sfw' });
        expect(items).toHaveLength(2);                     // 跨模型重复 id 去重
        expect(items[0].id).toBe('100');
        expect(items[0].baseModel).toBe('Pony');           // 取图片所属版本
        expect(items[0].modelVersionId).toBe('11');        // 详情富化钥匙=版本 id
        expect(items[0].username).toBe('imgAuthor');       // 图片级作者优先
        expect(items[0].model).toBe('Asuna-SAO');          // 模型名兜底 info 行
        expect(items[0].thumb).toContain('width=450,optimized=true');
        expect(items[0].link).toBe('https://civitai.com/images/100');
        expect(items[1].username).toBe('maker1');          // 图片无作者回退 creator
        expect(nextToken).toBe('mc-3');
    });

    test(`单模型封顶 ${MODEL_IMAGE_CAP} 张防霸屏；跨版本取最新在前`, () => {
        const images = [];
        for (let i = 1; i <= MODEL_IMAGE_CAP + 5; i++) {
            images.push({ id: i, url: `https://image.civitai.com/h/${i}/original=true/x.jpeg` });
        }
        const { items } = normalizeModelSearch({
            items: [model('M', [{ id: 1, images }])],
            metadata: {}
        });
        expect(items).toHaveLength(MODEL_IMAGE_CAP);
        expect(items.map((it) => Number(it.id))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    test('nsfw 防御性过滤：档位超上限剔除、字段缺失不拦、视频条目剔除', () => {
        const payload = {
            items: [model('M', [{
                id: 1,
                images: [
                    { id: 1, url: 'https://a/1', nsfw: 'X' },
                    { id: 2, url: 'https://a/2', nsfw: 'Soft' },
                    { id: 3, url: 'https://a/3' },                          // 无 nsfw 字段
                    { id: 4, url: 'https://a/4', type: 'video', nsfw: 'None' }
                ]
            }])]
        };
        const sfw = normalizeModelSearch(payload, { nsfw: 'sfw' });
        expect(sfw.items.map((it) => it.id)).toEqual(['3']);        // X/Soft 拦（sfw=仅安全）、缺字段留、视频剔除
        const r18 = normalizeModelSearch(payload, { nsfw: 'r18' });
        expect(r18.items.map((it) => it.id)).toEqual(['1', '2', '3']);   // X 全量放行
    });

    test('payload 形态异常不抛错、坏条目剔除', () => {
        expect(normalizeModelSearch(null)).toEqual({ items: [], nextToken: null });
        const { items, nextToken } = normalizeModelSearch({ items: [{ name: 'M', modelVersions: [{ id: 1, images: [{ url: 'no-id' }, { id: 9, url: 'https://a/9' }] }] }] });
        expect(items).toHaveLength(1);
        expect(items[0].id).toBe('9');
        expect(nextToken).toBe(null);
    });
});

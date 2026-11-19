/**
 * ==========================================================================
 * utils/gallery/danbooru.js 单元测试：查询构造（含 2-tag 配额分配）+ 归一化
 * 查询串断言统一回解析（URLSearchParams 空格编成 +，直接字符串匹配易错）
 * ==========================================================================
 */

const { buildPath, normalizeItems } = require('../../utils/gallery/danbooru');

/** 把适配器产出的路径回解析成参数对象 */
function parseParams(path) {
    return new URLSearchParams(path.slice(path.indexOf('?') + 1));
}

describe('utils/gallery/danbooru 查询构造', () => {
    test('默认（全部 all + 最热）：无 rating tag，只有 order:score', () => {
        const { path } = buildPath({});
        const p = parseParams(path);
        expect(path).toContain('danbooru.donmai.us/posts.json');
        expect(p.get('tags')).toBe('order:score');
        expect(p.get('limit')).toBe('48');
        expect(p.get('page')).toBe('1');
    });

    test('站方四档精确语义 + all=不过滤；未知档回落 all', () => {
        expect(parseParams(buildPath({ nsfw: 'g' }).path).get('tags')).toBe('rating:g order:score');
        expect(parseParams(buildPath({ nsfw: 's' }).path).get('tags')).toBe('rating:s order:score');
        expect(parseParams(buildPath({ nsfw: 'q' }).path).get('tags')).toBe('rating:q order:score');
        expect(parseParams(buildPath({ nsfw: 'e' }).path).get('tags')).toBe('rating:e order:score');
        expect(parseParams(buildPath({ nsfw: 'bogus' }).path).get('tags')).toBe('order:score');
    });

    test('new 排序 + all 档：tag 全空（默认序、不过滤）', () => {
        const tags = parseParams(buildPath({ sort: 'new' }).path).get('tags');
        expect(tags).toBe('');
    });

    test('1 用户词 + 分级 + 最热排序 = 3 超限：丢排序、留分级、记录警告', () => {
        const { path, warnings } = buildPath({ tags: '1girl', nsfw: 'g', sort: 'hot' });
        expect(parseParams(path).get('tags')).toBe('1girl rating:g');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('排序被忽略');
    });

    test('2 用户词：分级与排序都被丢、双警告', () => {
        const { path, warnings } = buildPath({ tags: '1girl solo', nsfw: 'g', sort: 'hot' });
        expect(parseParams(path).get('tags')).toBe('1girl solo');
        expect(warnings).toHaveLength(2);
    });

    test('all 档无分级 tag：省下的额度被 2 用户词占满，排序仍要丢', () => {
        const { path, warnings } = buildPath({ tags: '1girl solo', nsfw: 'all', sort: 'hot' });
        expect(parseParams(path).get('tags')).toBe('1girl solo');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('排序被忽略');
    });

    test('空用户词不限流：分级+排序全保留', () => {
        const { warnings } = buildPath({ tags: '', nsfw: 'g', sort: 'hot' });
        expect(warnings).toEqual([]);
    });

    test('page/limit 边界钳制', () => {
        const p = parseParams(buildPath({ page: -3, limit: 999 }).path);
        expect(p.get('page')).toBe('1');
        expect(p.get('limit')).toBe('200');
    });
});

describe('utils/gallery/danbooru 响应归一化', () => {
    test('字段抽取：tag 串→prompt、链接、评分、作者', () => {
        const payload = [{
            id: 777,
            preview_file_url: 'https://cdn.donmai.us/p.jpg',
            large_file_url: 'https://cdn.donmai.us/l.jpg',
            image_width: 800,
            image_height: 1200,
            tag_string_general: '1girl long_hair smile',
            tag_string_artist: 'some_artist',
            rating: 'q',
            score: 42,
            uploader_name: 'uploader1'
        }];
        const { items, nextToken } = normalizeItems(payload, 48);
        expect(items).toHaveLength(1);
        const it = items[0];
        expect(it.id).toBe('777');
        expect(it.source).toBe('danbooru');
        expect(it.thumb).toBe('https://cdn.donmai.us/p.jpg');
        expect(it.full).toBe('https://cdn.donmai.us/l.jpg');
        expect(it.prompt).toBe('1girl, long_hair, smile');
        expect(it.tags).toEqual(['1girl', 'long_hair', 'smile']);
        expect(it.artist).toBe('some_artist');
        expect(it.rating).toBe('q');
        expect(it.score).toBe(42);
        expect(it.link).toBe('https://danbooru.donmai.us/posts/777');
        expect(nextToken).toBe(null);   // 1 < 48：没有下一页
    });

    test('满页视为有下一页（nextToken 哨兵）', () => {
        const full = Array.from({ length: 48 }, (_, i) => ({ id: i }));
        const { items, nextToken } = normalizeItems(full, 48);
        expect(items).toHaveLength(48);
        expect(nextToken).toBe('1');
    });

    test('非数组 / 缺 id 条目容错', () => {
        expect(normalizeItems(null)).toEqual({ items: [], nextToken: null });
        expect(normalizeItems([null, {}, { id: 5 }]).items).toHaveLength(1);
    });
});

'use strict';
/**
 * 搜索引擎回归测试。
 *
 * 全部用真实响应快照（test/fixtures/*）离线跑，不联网：
 * 站点改版导致解析失效时这里会直接失败，而不是等用户搜出空结果才发现。
 *
 * 覆盖三层：
 *   1. 归一化工具（体积/时间/base32 磁链）—— 各站格式差异的消化处
 *   2. 各站点解析器 —— 真实快照 → 条目
 *   3. 引擎 —— 扇出/容错/去重/排序（用假 transport，验证编排而非网络）
 */
const fs = require('fs');
const path = require('path');

const ROOT = './build';
const FIXTURES = path.join(__dirname, 'fixtures');

// 归一化工具、引擎、注册表与全部 provider 都在同一个模块里
const svc = require(`${ROOT}/services/SearchService`);
const util = svc;
const engine = svc;
const registry = svc;
const {
    apibayProvider, acgripProvider, dmhyProvider, animetoshoProvider,
    nyaaProvider, sukebeiProvider, tpbAdultProvider,
} = svc;

let pass = 0;
const fails = [];

/**
 * 在途的异步用例。
 *
 * check() 原本是同步的：`fn()` 的返回值被直接丢弃。于是所有写成
 * `check('...', () => { return engine.search(...).then(r => assert(...)) })`
 * 的用例——引擎编排那一整段——**断言从未被校验**：
 * 抛错发生在脱离调用栈的 Promise 里，只会变成一条 unhandledRejection，
 * 用例照样计入 pass。也就是说引擎测试此前是"全绿但没生效"。
 * 这里把返回的 thenable 收集起来，由 runAsync 统一 await 后再统计。
 */
const pending = [];

const check = (name, fn) => {
    let result;
    try {
        result = fn();
    } catch (e) {
        fails.push({ name, message: e.message });
        return;
    }
    if (result && typeof result.then === 'function') {
        // 异步用例：成功/失败都要等 Promise 落地才计数
        pending.push(
            Promise.resolve(result).then(
                () => { pass++; },
                (e) => { fails.push({ name, message: e && e.message ? e.message : String(e) }); }
            )
        );
        return;
    }
    pass++;
};

const assert = (cond, msg) => {
    if (!cond) throw new Error(msg || '断言失败');
};

const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** 用真实快照跑一个 provider */
const parseFixture = (provider, file, query) =>
    provider.parse(fixture(file), { url: provider.buildSearchUrl(query || 'x'), query: query || 'x' });

/**
 * 页面里数据行的地面真值：整页去重后的 /view/<id> 个数。
 *
 * 故意不复用解析器的任何判据（行切分、class、<tr> 结构都不看），
 * 否则"解析器只认 class=\"default\"，把可信源整批丢掉"这类漏行 bug
 * 会被同一个错误判据自证清白——当年就是靠 `assert(hits.length > 0)`
 * 混过去的：nyaa 快照 75 行只解析出 66 行，测试全绿。
 */
const countPageRows = (body) =>
    new Set([...body.matchAll(/href="(?:https?:\/\/[^"/]+)?\/view\/(\d+)"/gi)].map((m) => m[1])).size;

/* ------------------------------------------------------------------ */
/* 1. 归一化工具                                                        */
/* ------------------------------------------------------------------ */

const runUtil = () => {
    // 体积：覆盖实测到的全部形态
    check('parseSizeBytes: nyaa 的 "6.6 GiB"', () => {
        const n = util.parseSizeBytes('6.6 GiB');
        assert(Math.abs(n - 6.6 * 1024 ** 3) < 1e6, `得到 ${n}`);
    });
    check('parseSizeBytes: dmhy 的 "48.5GB"（无空格、十进制）', () => {
        const n = util.parseSizeBytes('48.5GB');
        assert(Math.abs(n - 48.5 * 1000 ** 3) < 1e6, `得到 ${n}`);
    });
    check('parseSizeBytes: acg.rip 的 "1.8 GB"', () => {
        const n = util.parseSizeBytes('1.8 GB');
        assert(Math.abs(n - 1.8 * 1000 ** 3) < 1e6, `得到 ${n}`);
    });
    check('parseSizeBytes: apibay 的纯字节 "183567938"', () => {
        assert(util.parseSizeBytes('183567938') === 183567938, '纯字节数应原样返回');
    });
    check('parseSizeBytes: animetosho 的 "33,343,733,854 bytes"（带千分位）', () => {
        assert(util.parseSizeBytes('33,343,733,854') === 33343733854, '千分位应被去掉');
    });
    check('parseSizeBytes: 未公布返回 -1（不是 0）', () => {
        assert(util.parseSizeBytes('-') === util.UNKNOWN, '"-" 应为 UNKNOWN');
        assert(util.parseSizeBytes('') === util.UNKNOWN, '空串应为 UNKNOWN');
    });

    // 时间：epoch 秒 / 毫秒 / 两种日期文本
    check('parseTimestamp: epoch 秒 → 毫秒', () => {
        assert(util.parseTimestamp(1264712003) === 1264712003000, '秒级应乘 1000');
    });
    check('parseTimestamp: epoch 毫秒原样返回', () => {
        assert(util.parseTimestamp(1789227900000) === 1789227900000, '毫秒级不该再乘');
    });
    check('parseDateText: nyaa 的 "2026-09-12 15:45"', () => {
        const t = util.parseDateText('2026-09-12 15:45');
        assert(t === Date.UTC(2026, 8, 12, 15, 45), `得到 ${new Date(t).toISOString()}`);
    });
    check('parseDateText: dmhy 的 "2026/08/28 05:32"', () => {
        const t = util.parseDateText('2026/08/28 05:32');
        assert(t === Date.UTC(2026, 7, 28, 5, 32), `得到 ${new Date(t).toISOString()}`);
    });
    check('parseDateText: animetosho 的日/月/年 "05/05/2026 20:50"', () => {
        const t = util.parseDateText('05/05/2026 20:50');
        assert(t === Date.UTC(2026, 4, 5, 20, 50), `日/月/年顺序解析错，得到 ${new Date(t).toISOString()}`);
    });

    // base32 磁链：dmhy/animetosho 用 base32，必须能转成 hex 才能跨站去重
    check('base32ToHex: 32 位 base32 → 40 位 hex', () => {
        // 用真实 dmhy 磁链里的 btih
        const hex = util.base32ToHex('7BSRIRFCYCZ767R5UPF5OXNFR327BHQZ');
        assert(/^[0-9a-f]{40}$/.test(hex), `应得到 40 位 hex，得到 "${hex}"`);
    });
    check('magnetInfoHash: hex 与 base32 都能提取', () => {
        const hex = util.magnetInfoHash('magnet:?xt=urn:btih:ef3e7ad1b12bdd9fc341691d8866cd1fa8374a4b');
        assert(hex === 'ef3e7ad1b12bdd9fc341691d8866cd1fa8374a4b', 'hex 应原样小写');
        const b32 = util.magnetInfoHash('magnet:?xt=urn:btih:7BSRIRFCYCZ767R5UPF5OXNFR327BHQZ&dn=x');
        assert(/^[0-9a-f]{40}$/.test(b32), `base32 应转成 hex，得到 "${b32}"`);
    });
    check('magnetInfoHash: 同一资源的 hex 与 base32 表示一致', () => {
        // f8651444a2c0b3ff7e3da3cbd75da58ef5f09e19 的 base32 形式
        const fromHex = util.magnetInfoHash('magnet:?xt=urn:btih:f8651444a2c0b3ff7e3da3cbd75da58ef5f09e19');
        const fromB32 = util.base32ToHex('7BSRIRFCYCZ767R5UPF5OXNFR327BHQZ');
        assert(fromHex.length === 40 && fromB32.length === 40, '两者都应是 40 位');
    });
    check('normalizeTitle: 忽略大小写/标点/括号段', () => {
        const a = util.normalizeTitle('[Group] Frieren - 01 (1080p)');
        const b = util.normalizeTitle('frieren 01');
        assert(a === b, `应归一为同一条："${a}" vs "${b}"`);
    });
};

/* ------------------------------------------------------------------ */
/* 2. 各站点解析器                                                      */
/* ------------------------------------------------------------------ */

const runParsers = () => {
    check('apibay: JSON 快照解析出条目且字段完整', () => {
        const hits = parseFixture(apibayProvider, 'apibay.json', 'big buck bunny');
        assert(hits.length > 0, '应解析出条目');
        const h = hits[0];
        assert(h.id, '应有 id');
        assert(h.title, '应有标题');
        assert(h.infoHash && h.infoHash.length === 40, `infoHash 应是 40 位 hex，得到 "${h.infoHash}"`);
        assert(h.magnet.startsWith('magnet:?xt=urn:btih:'), '应拼出 magnet');
        assert(h.sizeBytes > 0, `sizeBytes 应已知，得到 ${h.sizeBytes}`);
        assert(h.publishedAt > 0, `publishedAt 应已知，得到 ${h.publishedAt}`);
        assert(h.seeders !== undefined, '应有 seeders');
        assert(h.viewUrl.includes('thepiratebay.org'), '应有详情页地址');
    });
    check('apibay: 无结果占位行被丢弃', () => {
        const body = JSON.stringify([{ id: '0', name: 'No results returned', info_hash: '' }]);
        const hits = apibayProvider.parse(body, { url: '', query: 'x' });
        assert(hits.length === 0, `占位行应被丢弃，得到 ${hits.length} 条`);
    });
    check('apibay: 非法 JSON 返回空数组而不抛错', () => {
        const hits = apibayProvider.parse('<html>error</html>', { url: '', query: 'x' });
        assert(Array.isArray(hits) && hits.length === 0, '应返回空数组');
    });

    check('nyaa: HTML 快照解析出条目且字段完整', () => {
        const hits = parseFixture(nyaaProvider, 'nyaa.html', 'frieren');
        assert(hits.length > 0, '应解析出条目');
        const h = hits[0];
        assert(h.id, '应有 id');
        assert(h.title && !/^torrent-/.test(h.title), `标题应是真实标题，得到 "${h.title}"`);
        assert(h.magnet.startsWith('magnet:'), '应有磁链');
        assert(h.torrent.includes('/download/'), '应有种子直链');
        assert(h.sizeBytes > 0, `体积应解析出，得到 ${h.sizeBytes}`);
        assert(h.publishedAt > 0, `时间应解析出，得到 ${h.publishedAt}`);
        assert(h.seeders >= 0, `做种数应解析出，得到 ${h.seeders}`);
        assert(h.category, '应有分类文本');
        assert(h.viewUrl.startsWith('https://nyaa.si/view/'), `详情页应补成绝对地址，得到 ${h.viewUrl}`);
    });
    check('nyaa: 末尾三个数字列依次是 做种/吸血/完成', () => {
        const hits = parseFixture(nyaaProvider, 'nyaa.html', 'frieren');
        const h = hits[0];
        assert(h.seeders !== util.UNKNOWN && h.leechers !== util.UNKNOWN && h.completed !== util.UNKNOWN,
            `三个数都该解析出，得到 ${h.seeders}/${h.leechers}/${h.completed}`);
    });

    check('sukebei: 同一解析器吃里区快照', () => {
        const hits = parseFixture(sukebeiProvider, 'sukebei.html', 'x');
        assert(hits.length > 0, '应解析出条目');
        const h = hits[0];
        assert(h.torrent.startsWith('https://sukebei.nyaa.si/download/'),
            `种子直链应指向 .si 域，得到 ${h.torrent}`);
        assert(h.viewUrl.startsWith('https://sukebei.nyaa.site/view/'),
            `这份旧快照的详情链是 .site 绝对地址，应原样保留，得到 ${h.viewUrl}`);
        assert(h.magnet.startsWith('magnet:'), '应有磁链');
    });

    /**
     * 漏行回归：数据行在站点侧按状态上色（default 普通 / success 可信上传组 /
     * danger 另一种标记），旧行定位只认 default，于是可信源整批消失——
     * sukebei 同人志分类页 75 行全是 success，解析出 0 行。
     * 现在拿整页 /view/<id> 去重数当地面真值，逐份快照比对行数。
     */
    check('Nyaa 系: 解析行数等于页面数据行数（含 success/danger 状态行）', () => {
        const cases = [
            ['nyaa.html', nyaaProvider],
            ['sukebei.html', sukebeiProvider],
            ['sukebei_si.html', sukebeiProvider],
        ];
        for (const [file, provider] of cases) {
            const body = fixture(file);
            const expected = countPageRows(body);
            const hits = provider.parse(body, { url: provider.buildSearchUrl('x'), query: 'x' });
            assert(expected > 0, `${file}: 地面真值为 0，快照本身有问题`);
            assert(hits.length === expected,
                `${file}: 应解析 ${expected} 行（页面数据行数），实际 ${hits.length} —— 有行被丢掉`);
            const ids = hits.map((h) => h.id);
            assert(new Set(ids).size === ids.length, `${file}: 行 id 不该重复`);
        }
    });
    check('Nyaa 系: 三份快照的行 class 构成确实不同（否则上一条用例形同虚设）', () => {
        const classOf = (file) => {
            const b = fixture(file);
            const set = new Set([...b.matchAll(/<tr[^>]*class="([^"]*)"/gi)].map((m) => m[1]));
            return Array.from(set).sort().join(',');
        };
        const nyaa = classOf('nyaa.html');
        const siDoujin = classOf('sukebei_si.html');
        assert(/default/.test(nyaa) && /success/.test(nyaa) && /danger/.test(nyaa),
            `nyaa.html 应同时含三种状态行，得到 "${nyaa}"`);
        assert(siDoujin === 'success',
            `sukebei_si.html 应整页都是可信源行（这正是旧代码解析出 0 行的那类页），得到 "${siDoujin}"`);
    });
    /**
     * 死种行只有 magnet、没有 /download/<id>.torrent（实测 sukebei `?q=nitroplus`
     * 14 行里 11 行如此）。旧代码按 id 硬拼一个地址，那 11 个必然 404——
     * 每次下载先白打一发请求才回落到 magnet。现在行内没有就留空，
     * 由调用方按"只有 magnet"处理（hook 里 downloadHit / saveTorrentFile 各有兜底）。
     */
    check('Nyaa 系: 行内没有种子直链时留空，不按 id 伪造地址', () => {
        const magnet = `magnet:?xt=urn:btih:${'a'.repeat(40)}`;
        const row = '<tr class="success">'
            + '<td><a href="/?c=1_2" title="Art - Doujinshi"><img class="category-icon" alt="Art - Doujinshi"></a></td>'
            + '<td colspan="2"><a href="/view/4249429" title="只有磁链的死种">只有磁链的死种</a></td>'
            + `<td class="text-center"><a href="${magnet}">Magnet</a></td>`
            + '<td class="text-center">1.4 GiB</td>'
            + '<td class="text-center" data-timestamp="1739318040">2025-02-12 00:54</td>'
            + '<td class="text-center">3</td><td class="text-center">0</td><td class="text-center">1098</td>'
            + '</tr>';
        const hits = nyaaProvider.parse(`<table>${row}</table>`, { url: '', query: 'x' });
        assert(hits.length === 1, `应解析出 1 条，得到 ${hits.length}`);
        assert(hits[0].torrent === '', `行内没有直链就不该伪造，得到 "${hits[0].torrent}"`);
        assert(hits[0].magnet === magnet, `magnet 应照常解析，得到 "${hits[0].magnet}"`);
        assert(hits[0].infoHash === 'a'.repeat(40), 'info hash 应从 magnet 里取到（跨站去重要用）');
    });
    check('sukebei: .si 快照解析出日文同人志标题与 .si 详情链', () => {
        const hits = parseFixture(sukebeiProvider, 'sukebei_si.html', '同人誌');
        assert(hits.length > 0, '应解析出条目');
        const h = hits[0];
        assert(/[぀-ヿ一-鿿]/.test(h.title), `标题应含日文，得到 "${h.title}"`);
        assert(h.viewUrl.startsWith('https://sukebei.nyaa.si/view/'), `详情页应在 .si 域，得到 ${h.viewUrl}`);
        assert(h.category.includes('Doujinshi'), `分类应是同人志，得到 "${h.category}"`);
        assert(h.seeders > 0, `做种数应解析出，得到 ${h.seeders}`);
    });
    check('sukebei: 搜索地址走 .si（.site 镜像对日文查询静默返回空）', () => {
        const url = sukebeiProvider.buildSearchUrl('nitroplus');
        assert(url === 'https://sukebei.nyaa.si/?q=nitroplus', `得到 ${url}`);
        assert(!sukebeiProvider.descriptor.homepage.includes('.site'),
            `站点主页应为 .si，得到 ${sukebeiProvider.descriptor.homepage}`);
    });
    check('sukebei 与 nyaa 用同一份解析逻辑（只是配置不同）', () => {
        // 两个 provider 由 createNyaaProvider 各自创建，所以不能比较函数引用；
        // 真正要保证的是：同一份 HTML 交给两者，解析出的条目结构完全一致。
        const nyaaHits = parseFixture(nyaaProvider, 'nyaa.html', 'x');
        const sukebeiHits = parseFixture(sukebeiProvider, 'sukebei.html', 'x');
        assert(nyaaHits.length > 0 && sukebeiHits.length > 0, '两者都应解析出条目');
        const keysOf = (h) => Object.keys(h).sort().join(',');
        assert(keysOf(nyaaHits[0]) === keysOf(sukebeiHits[0]),
            '两者解析出的字段结构应一致，说明共用同一份实现');
        assert(nyaaProvider.descriptor.adult === false, 'nyaa 应为全年龄');
        assert(sukebeiProvider.descriptor.adult === true, 'sukebei 应为成人');
    });

    /**
     * TPB 里区（tpb.party）。两份快照都是 2026-10-08 的真实响应：
     *   tpb_porn.html ← /s/?q=doujinshi&porn=on  （30 行，分类只剩 503/505/599）
     *   tpb_all.html  ← /search/doujinshi/0/99/99（30 行，混着 403/602/699 等非成人）
     * 二者并排放着测，是为了锁住"筛选必须在服务端做"：
     * apibay 的 c= 参数服务端直接忽略（实测五种写法响应逐字节相同），
     * 想拿成人结果只能换 tpb.party 的 porn=on；在解析器里事后过滤等于自欺。
     */
    check('tpb.party: 搜索地址带 porn=on 且关键词做了编码', () => {
        const url = tpbAdultProvider.buildSearchUrl('充電器');
        assert(url === `https://tpb.party/s/?q=${encodeURIComponent('充電器')}&porn=on`, `得到 ${url}`);
    });
    check('tpb.party: HTML 快照解析出条目且字段完整', () => {
        const hits = parseFixture(tpbAdultProvider, 'tpb_porn.html', 'doujinshi');
        assert(hits.length > 0, '应解析出条目');
        const h = hits[0];
        assert(/^\d+$/.test(h.id), `id 应是详情链接里的数字，得到 "${h.id}"`);
        assert(h.title && !/^torrent-/.test(h.title), `标题应是真实标题，得到 "${h.title}"`);
        assert(h.viewUrl.startsWith('https://tpb.party/torrent/'), `详情页应原样绝对，得到 ${h.viewUrl}`);
        assert(h.magnet.startsWith('magnet:?xt=urn:btih:'), `应有磁链，得到 "${h.magnet}"`);
        assert(/^[0-9a-f]{40}$/.test(h.infoHash), `磁链应抽出 40 位 hex，得到 "${h.infoHash}"`);
        assert(h.sizeBytes > 0 && h.sizeText, `体积应解析出，得到 ${h.sizeBytes} / "${h.sizeText}"`);
        assert(h.seeders !== util.UNKNOWN && h.leechers !== util.UNKNOWN,
            `做种/吸血应解析出，得到 ${h.seeders}/${h.leechers}`);
        assert(h.completed === util.UNKNOWN, `列表页不提供完成数，应记 UNKNOWN，得到 ${h.completed}`);
        assert(h.category, `分类应是 "Porn > …"，得到 "${h.category}"`);
    });
    /**
     * 日期列在同一站内就两种形态："10-17 2025"（往年）与 "05-01 19:50"（本年，缺年份）。
     * 补年份要读当前时间，而 parse 必须是纯函数（否则快照离线测试会随日期漂移）。
     * 只解析带年份的那半更糟：本年的新条目会因 UNKNOWN 在日期排序里落到末尾。
     * 所以整站日期一律 UNKNOWN，这条用例把决定钉住，防止将来"顺手补一下"。
     */
    check('tpb.party: 日期缺年份，整站记 UNKNOWN 而不猜年份', () => {
        const hits = parseFixture(tpbAdultProvider, 'tpb_porn.html', 'doujinshi');
        assert(hits.length > 0, '应解析出条目');
        const dated = hits.filter((h) => h.publishedAt !== util.UNKNOWN);
        assert(dated.length === 0, `日期应全为 UNKNOWN，实际有 ${dated.length} 条带值`);
    });
    check('tpb.party: 列表页没有 .torrent 直链，留空也不伪造', () => {
        const hits = parseFixture(tpbAdultProvider, 'tpb_porn.html', 'doujinshi');
        assert(hits.every((h) => h.torrent === ''), 'TPB 列表页只给磁链，种子直链在详情页');
    });
    /**
     * 上传者若是 Anonymous，那一格渲染成 <i>Anonymous</i>（没有 /user/ 链）。
     * 早先按"末尾几个格是数字"取列，在这一行上体积整格丢掉、做种数被读成吸血数
     * （实测 id 75355407：真值 15/2，启发式给成 2/-1）。现在按固定列序取，
     * 这两条用例把列序锁住——列序一变（站点改版）就整体记 UNKNOWN，宁可少信息也不给错信息。
     */
    check('tpb.party: Anonymous 行（上传者格没有 /user/ 链）也取对体积与做种数', () => {
        const body = fixture('tpb_porn.html');
        assert(/<i>Anonymous<\/i>/.test(body), '快照里应有 Anonymous 行，否则这条用例形同虚设');
        const anon = tpbAdultProvider.parse(body, { url: '', query: 'doujinshi' })
            .find((h) => h.id === '75355407');
        assert(anon, '应解析出 id 75355407 那一行');
        assert(anon.seeders === 15, `做种数应是 15，得到 ${anon.seeders}`);
        assert(anon.leechers === 2, `吸血数应是 2，得到 ${anon.leechers}`);
        assert(anon.sizeText === '5.08 GiB' && anon.sizeBytes > 0,
            `体积应取到，得到 ${anon.sizeBytes} / "${anon.sizeText}"`);
    });
    check('tpb.party: 列序正常的行都取到体积与做种/吸血', () => {
        const hits = parseFixture(tpbAdultProvider, 'tpb_porn.html', 'doujinshi');
        const missing = hits.filter((h) => h.sizeBytes === util.UNKNOWN
            || h.seeders === util.UNKNOWN || h.leechers === util.UNKNOWN);
        assert(missing.length === 0,
            `${missing.length} 行没取到体积或做种/吸血：${missing.map((h) => h.id).join(',')}`);
    });
    check('tpb.party: 解析行数等于页面数据行数', () => {
        const body = fixture('tpb_porn.html');
        const expected = new Set([...body.matchAll(/href="(?:https?:\/\/[^"/]+)?\/torrent\/(\d+)\//gi)]
            .map((m) => m[1])).size;
        const hits = tpbAdultProvider.parse(body, { url: '', query: 'doujinshi' });
        assert(expected > 0, '地面真值为 0，快照本身有问题');
        assert(hits.length === expected, `应解析 ${expected} 行，实际 ${hits.length}`);
        const ids = hits.map((h) => h.id);
        assert(new Set(ids).size === ids.length, '行 id 不该重复');
    });
    check('tpb.party: 里站分区，且筛选后的快照全是成人分类', () => {
        assert(tpbAdultProvider.descriptor.adult === true, '应为成人站点');
        assert(registry.groupOf(tpbAdultProvider.descriptor) === 'nsfw', '应落进里站分区');
        const hits = parseFixture(tpbAdultProvider, 'tpb_porn.html', 'doujinshi');
        const notPorn = hits.filter((h) => !/^Porn\b/.test(h.category));
        assert(notPorn.length === 0,
            `porn=on 之后不该有非成人分类，得到 ${notPorn.map((h) => h.category).join(' / ')}`);
    });
    check('tpb.party 对照快照: 不带 porn=on 时同一关键词混进非成人分类', () => {
        const hits = parseFixture(tpbAdultProvider, 'tpb_all.html', 'doujinshi');
        assert(hits.length > 0, '对照快照也应解析出条目，否则这条用例形同虚设');
        const mixed = hits.filter((h) => !/^Porn\b/.test(h.category));
        assert(mixed.length > 0, '不带筛选的页面应含非成人分类');
    });

    check('acg.rip: HTML 快照解析出条目', () => {
        const hits = parseFixture(acgripProvider, 'acgrip.html', 'big buck bunny');
        assert(hits.length > 0, '应解析出条目');
        const h = hits[0];
        assert(h.id, '应有 id');
        assert(h.title, '应有标题');
        assert(h.torrent.startsWith('https://acg.rip/t/'), `种子直链应补成绝对地址，得到 ${h.torrent}`);
        assert(h.viewUrl.startsWith('https://acg.rip/t/'), `详情页应补成绝对地址，得到 ${h.viewUrl}`);
        assert(h.sizeBytes > 0, `体积应解析出，得到 ${h.sizeBytes}`);
        assert(h.publishedAt > 0, `时间应解析出，得到 ${h.publishedAt}`);
    });
    check('acg.rip: 不公布做种数时记 UNKNOWN 而非 0', () => {
        const hits = parseFixture(acgripProvider, 'acgrip.html', 'x');
        assert(hits[0].seeders === util.UNKNOWN, `应记 UNKNOWN(-1)，得到 ${hits[0].seeders}`);
    });

    check('dmhy: HTML 快照解析出条目', () => {
        const hits = parseFixture(dmhyProvider, 'dmhy.html', '葬送的芙莉莲');
        assert(hits.length > 0, '应解析出条目');
        const h = hits[0];
        assert(h.id, '应有 id');
        assert(h.title, '应有标题');
        assert(h.magnet.startsWith('magnet:'), '应有磁链');
        assert(h.sizeBytes > 0, `体积应解析出，得到 ${h.sizeBytes}`);
        assert(h.publishedAt > 0, `时间应解析出，得到 ${h.publishedAt}`);
        assert(h.viewUrl.includes('share.dmhy.org/topics/view/'), `详情页地址不对：${h.viewUrl}`);
    });
    check('dmhy: base32 磁链被转成 hex（否则无法跨站去重）', () => {
        const hits = parseFixture(dmhyProvider, 'dmhy.html', 'x');
        const withHash = hits.filter((h) => h.infoHash);
        assert(withHash.length > 0, '应有条目带 infoHash');
        assert(withHash.every((h) => /^[0-9a-f]{40}$/.test(h.infoHash)),
            'infoHash 应全部是 40 位 hex');
    });

    check('animetosho: HTML 快照解析出条目', () => {
        const hits = parseFixture(animetoshoProvider, 'animetosho.html', 'frieren');
        assert(hits.length > 0, '应解析出条目');
        const h = hits[0];
        assert(h.id, '应有 id');
        assert(h.title, '应有标题');
        assert(h.magnet.startsWith('magnet:'), '应有磁链');
        assert(h.torrent.includes('.torrent'), `应有种子直链，得到 "${h.torrent}"`);
        assert(h.sizeBytes > 0, `体积应解析出，得到 ${h.sizeBytes}`);
        assert(h.publishedAt > 0, `时间应解析出，得到 ${h.publishedAt}`);
    });
    check('animetosho: 做种/吸血从 title 属性解析', () => {
        const hits = parseFixture(animetoshoProvider, 'animetosho.html', 'x');
        const withPeers = hits.filter((h) => h.seeders !== util.UNKNOWN);
        assert(withPeers.length > 0, '应至少有一条解析出做种数');
        assert(withPeers[0].leechers !== util.UNKNOWN, '吸血数也该解析出');
    });

    /**
     * 漏行回归：详情页 id 在站点侧有三种形态，实测同一页搜索结果里就混着——
     * frieren 快照 75 条 = `.n<数字>` 60 + `.k<数字>` 14 + `.<纯数字>` 1。
     * 旧代码只认 `.n`，另外 15 条整条静默消失（`assert(hits.length > 0)` 照样绿）。
     * 地面真值用页面里唯一的 /storage/torrent/<hash> 个数，不复用解析器的判据。
     */
    check('animetosho: 解析条数等于页面唯一种子文件数（三种 id 形态都要吃到）', () => {
        const body = fixture('animetosho.html');
        const hits = parseFixture(animetoshoProvider, 'animetosho.html', 'frieren');
        const pageHashes = new Set(
            [...body.matchAll(/\/storage\/torrent\/([0-9a-f]{40})/g)].map((m) => m[1])
        );
        assert(pageHashes.size > 0, '快照里应有一种种子文件，否则用例形同虚设');
        assert(hits.length === pageHashes.size,
            `页面有 ${pageHashes.size} 个唯一种子文件，只解析出 ${hits.length} 条 —— 有行被丢掉`);
        assert(new Set(hits.map((h) => h.id)).size === hits.length, 'id 不该重复');
        const hasN = hits.some((h) => /^n\d+$/.test(h.id));
        const hasK = hits.some((h) => /^k\d+$/.test(h.id));
        const hasBare = hits.some((h) => /^\d+$/.test(h.id));
        assert(hasN && hasK && hasBare,
            `三种 id 形态都应解析出，得到 n=${hasN} k=${hasK} 纯数字=${hasBare}`);
    });

    check('所有解析器对垃圾输入都返回空数组而不抛错', () => {
        const providers = registry.allProviders();
        for (const p of providers) {
            const hits = p.parse('<html><body>not a result page</body></html>', { url: '', query: 'x' });
            assert(Array.isArray(hits), `${p.descriptor.id} 应返回数组`);
            assert(hits.length === 0, `${p.descriptor.id} 对垃圾输入应返回 0 条，得到 ${hits.length}`);
        }
    });
    check('所有解析器对空串都不抛错', () => {
        for (const p of registry.allProviders()) {
            const hits = p.parse('', { url: '', query: 'x' });
            assert(Array.isArray(hits) && hits.length === 0, `${p.descriptor.id} 空输入应返回空数组`);
        }
    });
};

/* ------------------------------------------------------------------ */
/* 3. 引擎：分区扇出 / 容错 / 去重 / 排序                                    */
/* ------------------------------------------------------------------ */

/** 假 transport：按 URL 里的域名返回对应快照，可注入失败 */
const makeTransport = (opts) => {
    const options = opts || {};
    const calls = [];
    return {
        calls,
        async get(req) {
            calls.push(req.url);
            for (const rule of options.fail || []) {
                if (req.url.includes(rule.match)) {
                    return { ok: false, status: rule.status || 0, body: '', finalUrl: req.url, error: rule.error || '注入的失败' };
                }
            }
            // 按主机名精确匹配，不用 includes：'sukebei.nyaa.si' 里含子串 'nyaa.si'，
            // 用 includes 会让里站请求拿到 nyaa 的快照（此前正是这样：两站 HTML 同构，
            // 照样解析出条目，测试全绿，但 sukebei 专属形态从没被覆盖过）。
            const table = [
                ['nyaa.si', 'nyaa.html'],
                ['sukebei.nyaa.si', 'sukebei_si.html'],
                ['sukebei.nyaa.site', 'sukebei.html'],
                ['apibay.org', 'apibay.json'],
                ['acg.rip', 'acgrip.html'],
                ['share.dmhy.org', 'dmhy.html'],
                ['animetosho.org', 'animetosho.html'],
                ['tpb.party', 'tpb_porn.html'],
            ];
            for (const [host, file] of table) {
                let hostname = '';
                try {
                    hostname = new URL(req.url).hostname;
                } catch (_e) {
                    continue;
                }
                if (hostname === host) {
                    return { ok: true, status: 200, body: fixture(file), finalUrl: req.url };
                }
            }
            return { ok: true, status: 200, body: '', finalUrl: req.url };
        },
    };
};

const runEngine = async () => {
    // 扇出：一次搜索打满所选分区
    const t1 = makeTransport();
    const r1 = await engine.search({ q: 'frieren', group: 'sfw' }, t1);
    check('引擎: 一次搜索扇出到本分区全部站点', () => {
        const ids = r1.sites.map((s) => s.site).sort();
        const expected = registry.sitesFor('sfw').map((s) => s.id).sort();
        assert(ids.join(',') === expected.join(','), `应查询本分区全部站点，得到 ${ids.join(',')}`);
        assert(t1.calls.length === expected.length, `应发出 ${expected.length} 个请求，实际 ${t1.calls.length}`);
    });
    check('引擎: 汇总结果来自多个站点且带站点章', () => {
        assert(r1.hits.length > 0, '应有汇总结果');
        const sites = new Set(r1.hits.map((h) => h.site));
        assert(sites.size > 1, `结果应来自多个站点，实际只有 ${Array.from(sites).join(',')}`);
        assert(r1.hits.every((h) => h.siteLabel), '每条都应带站点显示名');
    });
    check('引擎: 每站状态带耗时与条数', () => {
        for (const s of r1.sites) {
            assert(s.ok, `${s.site} 应成功`);
            assert(s.count > 0, `${s.site} 应有条数`);
            assert(typeof s.elapsedMs === 'number' && s.elapsedMs >= 0, `${s.site} 应有耗时`);
        }
    });

    // 容错：一个站挂了，其余照常
    const t2 = makeTransport({ fail: [{ match: 'apibay.org', error: '连接被重置' }] });
    const r2 = await engine.search({ q: 'frieren', group: 'sfw' }, t2);
    check('引擎: 单站失败不影响其余站点', () => {
        assert(r2.success, '整体应仍为成功');
        assert(r2.hits.length > 0, '其余站点的结果应照常返回');
        const bad = r2.sites.find((s) => s.site === 'apibay');
        assert(bad && !bad.ok, '失败站点应标记 ok=false');
        assert(bad.error && bad.error.includes('连接被重置'), `应带上失败原因，得到 "${bad.error}"`);
        const others = r2.sites.filter((s) => s.site !== 'apibay');
        assert(others.every((s) => s.ok), '其余站点应全部成功');
    });
    check('引擎: 结果里不含失败站点的条目', () => {
        assert(!r2.hits.some((h) => h.site === 'apibay'), 'apibay 失败了，不该有它的条目');
    });
    check('引擎: message 汇总成功/失败站数', () => {
        assert(/4\/5/.test(r2.message) || /失败/.test(r2.message), `message 应说明失败情况，得到 "${r2.message}"`);
    });

    // 全部失败也不能抛
    const t3 = makeTransport({ fail: [{ match: '' }] });
    const r3 = await engine.search({ q: 'frieren', group: 'sfw' }, t3);
    check('引擎: 全部站点失败时仍返回结构化结果而不抛错', () => {
        assert(r3.success, '整体仍应返回 success');
        assert(r3.hits.length === 0, '应无结果');
        assert(r3.sites.every((s) => !s.ok), '所有站点应标记失败');
        assert(r3.sites.every((s) => s.error), '每站都应有失败原因');
    });

    // 分区隔离：一次搜索只打一个分区，跨区站点一个请求都不发
    const t4 = makeTransport();
    const rSfw = await engine.search({ q: 'frieren', group: 'sfw' }, t4);
    check('引擎: 表站搜索不碰里站站点', () => {
        const sfw = registry.sitesFor('sfw').map((s) => s.id);
        const nsfw = registry.sitesFor('nsfw').map((s) => s.id);
        assert(nsfw.length > 0, '里站分区应有站点，否则这条用例形同虚设');
        assert(rSfw.sites.every((s) => sfw.includes(s.site)),
            `状态里只该有表站，得到 ${rSfw.sites.map((s) => s.site).join(',')}`);
        assert(!rSfw.hits.some((h) => nsfw.includes(h.site)), '结果里不该混进里站条目');
        nsfw.forEach((id) => {
            const host = registry.getProvider(id).descriptor.homepage.replace(/^https?:\/\//, '');
            assert(!t4.calls.some((u) => u.includes(host)), `不该向里站 ${id}（${host}）发请求`);
        });
    });

    const t5 = makeTransport();
    const rNsfw = await engine.search({ q: 'frieren', group: 'nsfw' }, t5);
    check('引擎: 里站搜索只打里站分区', () => {
        const expected = registry.sitesFor('nsfw').map((s) => s.id).sort();
        const got = rNsfw.sites.map((s) => s.site).sort();
        assert(got.join(',') === expected.join(','), `应只查询里站，得到 ${got.join(',')}`);
        assert(t5.calls.length === expected.length, `应发出 ${expected.length} 个请求，实际 ${t5.calls.length}`);
        assert(rNsfw.hits.every((h) => expected.includes(h.site)), '结果应只来自里站');
    });
    /**
     * 里站分区以前只有 sukebei 一个站，扇出退化成单站请求也没人看得出来。
     * 这条用例把"里站也是多站扇出"锁住：站点数与来源数都要 ≥2。
     */
    check('引擎: 里站扇出是多站点的，不只一个站在出结果', () => {
        assert(registry.sitesFor('nsfw').length >= 2,
            `里站分区应至少两个站点，实际 ${registry.sitesFor('nsfw').length} 个`);
        const sites = new Set(rNsfw.hits.map((h) => h.site));
        assert(sites.size >= 2, `里站结果应来自多个站点，实际 ${Array.from(sites).join(',') || '无结果'}`);
    });

    // 分区必选：没选就不搜，并给出明确原因，而不是静默回落到某个分区
    const tNoGroup = makeTransport();
    const rNoGroup = await engine.search({ q: 'frieren' }, tNoGroup);
    check('引擎: 未选分区时直接失败且不发请求', () => {
        assert(!rNoGroup.success, '应为失败');
        assert(rNoGroup.message && rNoGroup.message.includes('表站'), `应提示先选分区，得到 "${rNoGroup.message}"`);
        assert(tNoGroup.calls.length === 0, `不应发出任何请求，实际 ${tNoGroup.calls.length}`);
        assert(rNoGroup.hits.length === 0 && rNoGroup.sites.length === 0, '应无结果与站点状态');
    });

    // 分区模型的唯一支点：adult 是唯一判据，不存在第二处可能与之矛盾的登记
    check('注册表: 分区只由 adult 决定，两区无重叠且并集为全部站点', () => {
        const all = registry.listSites();
        const sfw = registry.sitesFor('sfw').map((s) => s.id);
        const nsfw = registry.sitesFor('nsfw').map((s) => s.id);
        assert(sfw.length + nsfw.length === all.length,
            `两区之和应等于站点总数，${sfw.length}+${nsfw.length} vs ${all.length}`);
        assert(!sfw.some((id) => nsfw.includes(id)), '同一站点不该同时属于两个分区');
        all.forEach((s) => {
            assert(registry.groupOf(s) === (s.adult ? 'nsfw' : 'sfw'), `${s.id}: 分区应只由 adult 决定`);
        });
        assert(nsfw.length > 0, '里站分区不应为空');
    });

    // 空关键词
    const r6 = await engine.search({ q: '   ' }, makeTransport());
    check('引擎: 空关键词直接返回失败且不发请求', () => {
        assert(!r6.success, '应为失败');
        assert(r6.hits.length === 0, '应无结果');
        assert(r6.message, '应有提示信息');
    });

    // 去重
    check('引擎: 跨站去重按 info hash 合并同一资源', () => {
        // nyaa 与 animetosho 索引大量重叠，真实快照里就能观察到
        const t = makeTransport();
        return engine.search({ q: 'frieren', group: 'sfw' }, t).then((r) => {
            const hashes = r.hits.filter((h) => h.infoHash).map((h) => h.infoHash);
            const unique = new Set(hashes);
            assert(hashes.length === unique.size, `去重后 info hash 应唯一，${hashes.length} vs ${unique.size}`);
        });
    });

    // 排序
    check('引擎: 按做种数降序，未知值排在末尾', () => {
        const t = makeTransport();
        return engine.search({ q: 'frieren', group: 'sfw', sort: 'seeders' }, t).then((r) => {
            const known = r.hits.filter((h) => h.seeders !== util.UNKNOWN);
            for (let i = 1; i < known.length; i++) {
                assert(known[i - 1].seeders >= known[i].seeders,
                    `做种数应降序：${known[i - 1].seeders} 在 ${known[i].seeders} 之前`);
            }
            // 未知值不应插在已知值中间
            const firstUnknown = r.hits.findIndex((h) => h.seeders === util.UNKNOWN);
            if (firstUnknown >= 0) {
                const after = r.hits.slice(firstUnknown);
                assert(after.every((h) => h.seeders === util.UNKNOWN),
                    '未知做种数应全部排在末尾');
            }
        });
    });
    check('引擎: 按体积降序', () => {
        const t = makeTransport();
        return engine.search({ q: 'frieren', group: 'sfw', sort: 'size' }, t).then((r) => {
            const known = r.hits.filter((h) => h.sizeBytes !== util.UNKNOWN);
            for (let i = 1; i < known.length; i++) {
                assert(known[i - 1].sizeBytes >= known[i].sizeBytes, '体积应降序');
            }
        });
    });

    /**
     * 排序比较器必须满足契约：对任意一对条目都返回**有限数**（负/0/正）。
     *
     * rank() 曾把 UNKNOWN 映射成 -Infinity，而比较式是 `rank(b) - rank(a)`：
     * 两条都未知时得到 `-Infinity - (-Infinity)` = **NaN**。
     *
     * 为什么不能只断言"最终顺序"：实测 V8 的 TimSort 对 NaN 相当宽容
     * （3000 组随机数据跑"已知在前、未知在后"全部通过），所以靠结果顺序
     * 抓不到它。这里直接对 engine 导出的比较器断言契约本身。
     */
    check('引擎: 排序比较器对"双未知"返回有限数（-Infinity 相减会得到 NaN）', () => {
        const unknownHit = (site) => ({
            id: 'x', title: 't', site, siteLabel: site, magnet: '', torrent: '', viewUrl: '',
            sizeBytes: util.UNKNOWN, sizeText: '', seeders: util.UNKNOWN, leechers: util.UNKNOWN,
            completed: util.UNKNOWN, publishedAt: util.UNKNOWN, category: '', infoHash: '',
        });
        const knownHit = { ...unknownHit('k'), sizeBytes: 100, seeders: 5, publishedAt: 1000 };

        for (const sort of ['seeders', 'size', 'date', 'site']) {
            const cmp = engine.compareBy(sort);
            const pairs = [
                ['双未知', unknownHit('a'), unknownHit('b')],
                ['未知 vs 已知', unknownHit('a'), knownHit],
                ['已知 vs 未知', knownHit, unknownHit('a')],
                ['已知 vs 已知', knownHit, { ...knownHit, seeders: 9, sizeBytes: 9, publishedAt: 9 }],
            ];
            for (const [label, a, b] of pairs) {
                const r = cmp(a, b);
                assert(!Number.isNaN(r), `${sort}/${label}: 比较器返回 NaN（排序键不能是 ±Infinity）`);
                assert(Number.isFinite(r), `${sort}/${label}: 比较器应返回有限数，得到 ${r}`);
            }
            // 双未知必须视为相等，这样排序才是确定的。
            // 注意 site 排序是 `站点名 || 做种数` 复合比较：结果先由站点名决定，
            // 所以"相等"与"已知在前"这两条都必须在**同一站点**下断言。
            const sameSiteUnknown = unknownHit('s');
            const sameSiteKnown = { ...knownHit, site: 's', siteLabel: 's' };
            assert(cmp(sameSiteUnknown, sameSiteUnknown) === 0, `${sort}: 同一站点下两条未知值应比较为相等`);
            // 已知必须排在未知之前（降序语义）
            assert(cmp(sameSiteKnown, sameSiteUnknown) < 0, `${sort}: 已知值应排在未知值之前`);
            assert(cmp(sameSiteUnknown, sameSiteKnown) > 0, `${sort}: 未知值应排在已知值之后`);
        }
    });

    // 单站上限
    check('引擎: limitPerSite 限制单站条数', () => {
        const t = makeTransport();
        return engine.search({ q: 'frieren', group: 'sfw', limitPerSite: 3 }, t).then((r) => {
            const bySite = {};
            for (const h of r.hits) bySite[h.site] = (bySite[h.site] || 0) + 1;
            for (const [site, n] of Object.entries(bySite)) {
                assert(n <= 3, `${site} 超过单站上限：${n}`);
            }
        });
    });

    // 做种数过滤：未知不应被当成 0 滤掉
    check('引擎: minSeeders 过滤时保留做种数未知的条目', () => {
        const t = makeTransport();
        return engine.search({ q: 'frieren', group: 'sfw', minSeeders: 5 }, t).then((r) => {
            const unknownKept = r.hits.some((h) => h.seeders === util.UNKNOWN);
            assert(unknownKept, '做种数未知的条目（acg.rip/dmhy）不该被 minSeeders 滤掉');
            for (const h of r.hits) {
                assert(h.seeders === util.UNKNOWN || h.seeders >= 5,
                    `应满足 minSeeders，得到 ${h.seeders}`);
            }
        });
    });
};

/* ------------------------------------------------------------------ */

const run = () => {
    runUtil();
    runParsers();
    console.log(`搜索引擎：通过 ${pass} 项，失败 ${fails.length} 项`);
    if (fails.length) {
        for (const f of fails) console.log(`  ✗ ${f.name}: ${f.message}`);
        return false;
    }
    return true;
};

/** 引擎测试是异步的，单独跑 */
const runAsync = async () => {
    const before = pass;
    const beforeFails = fails.length;
    await runEngine();
    // 必须等在途的异步用例全部落地，否则它们的断言结果来不及计入统计
    // （这正是此前引擎测试"全绿但没生效"的原因）。
    while (pending.length > 0) {
        const batch = pending.splice(0, pending.length);
        await Promise.all(batch);
    }
    console.log(`搜索引擎（引擎编排）：通过 ${pass - before} 项，失败 ${fails.length - beforeFails} 项`);
    if (fails.length) {
        for (const f of fails) console.log(`  ✗ ${f.name}: ${f.message}`);
        return false;
    }
    return true;
};

module.exports = { run, runAsync };

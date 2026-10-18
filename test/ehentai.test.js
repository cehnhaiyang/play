'use strict';
/**
 * E-Hentai 站点适配的离线快照测试。
 *
 * 为什么必须用真实快照：解析器最容易错的地方恰恰是手写假 HTML 不会踩的
 * ——属性顺序、懒加载占位、翻页游标的有无、缩略图批次的页码映射。
 * test/fixtures/eh_*.html 是 2026-10 经本机代理抓下来的真页面，改解析器时
 * 这些断言会立刻告诉你是"站点改版"还是"你改错了"。
 *
 * 只测纯函数（parseList / nextCursor / readMetaTable / parseImagePage 等），
 * 不发任何网络请求。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');

let pass = 0;
const fails = [];
const check = (name, fn) => {
    try { fn(); pass++; }
    catch (e) { fails.push({ name, message: e.message }); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };
const eq = (a, b, msg) => {
    if (a !== b) throw new Error(`${msg || '不相等'}：实际 ${JSON.stringify(a)}，预期 ${JSON.stringify(b)}`);
};

const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const run = () => {
    pass = 0;
    fails.length = 0;

    const svc = require(path.join(ROOT, 'app', 'main', 'ehentaiService.js'));
    const registry = require(path.join(ROOT, 'app', 'main', 'galleryRegistry.js'));

    /* ====================================================================== */
    /* 1. 列表解析                                                             */
    /* ====================================================================== */

    check('前端页解析出 25 本，字段齐全', () => {
        const items = svc.parseList(fixture('eh_front.html'), 'latest');
        eq(items.length, 25, '前端页条目数');
        const first = items[0];
        assert(/^\d+$/.test(first.gid), `gid 应为纯数字，得到 ${first.gid}`);
        assert(/^[0-9a-f]{10}$/.test(first.token), `token 应为 10 位十六进制，得到 ${first.token}`);
        eq(first.url, `https://e-hentai.org/g/${first.gid}/${first.token}/`, '详情地址');
        assert(first.title && first.title.length > 1, '标题不能为空');
        assert(/^\d{4}-\d{2}-\d{2}/.test(first.date), `日期应形如 2026-10-17，得到 ${first.date}`);
        assert(/^\d+$/.test(first.pages), `页数应为数字，得到 ${first.pages}`);
        eq(first.kind, 'image', '本站点只有图片');
        eq(first.channel, 'latest', '频道标记');
    });

    check('懒加载封面取 data-src，不取 data: 占位', () => {
        // 前端页里确实混着 data: 占位 + data-src 真链的条目（实测），
        // 只读 src 会把它们画成空白卡。
        const html = fixture('eh_front.html');
        assert(html.includes('src="data:image/gif;base64'), '快照里应含 data: 占位封面（否则这条用例失去意义）');
        const items = svc.parseList(html, 'latest');
        const withCover = items.filter((i) => i.cover);
        assert(withCover.length > 0, '至少要有封面');
        const bad = items.filter((i) => i.cover && i.cover.startsWith('data:'));
        eq(bad.length, 0, `不该把 data: 占位当封面：${bad.map((i) => i.gid).join(',')}`);
        const nonHttp = items.filter((i) => i.cover && !/^https?:\/\//.test(i.cover));
        eq(nonHttp.length, 0, `封面必须是绝对地址：${nonHttp.map((i) => i.cover).join(',')}`);
    });

    check('语言与标签从命名空间标签里取，不显示 language:/other:', () => {
        const items = svc.parseList(fixture('eh_front.html'), 'latest');
        // 前端页第一本实测带 artist:nunnu / parody / character 三个标签
        const first = items[0];
        assert(!/^language:/i.test(first.tag), `tag 不该以 language: 开头：${first.tag}`);
        assert(!first.tag.includes('language:'), `tag 里不该出现 language: 命名空间：${first.tag}`);
        // lang 只取语言标签的值，没语言标签时为空串（不是 'language:'）
        assert(first.lang === '' || !first.lang.includes(':'), `lang 应是纯值，得到 ${first.lang}`);
    });

    check('频道页解析（doujinshi）与前端页同构', () => {
        const items = svc.parseList(fixture('eh_doujinshi.html'), 'doujinshi');
        eq(items.length, 25, '同人志页条目数');
        eq(items[0].channel, 'doujinshi', '频道标记');
        assert(items.every((i) => i.gid && i.token), '每本都要有 gid 与 token');
    });

    check('popular 页多段表合并后按 gid+token 去重', () => {
        const items = svc.parseList(fixture('eh_popular.html'), 'popular');
        assert(items.length > 25, `popular 是多段合并，应多于 25 条，得到 ${items.length}`);
        const keys = items.map((i) => `${i.gid}:${i.token}`);
        eq(new Set(keys).size, keys.length, '不该有重复条目');
    });

    check('搜索结果页解析（f_search）', () => {
        const items = svc.parseList(fixture('eh_search.html'), 'search');
        eq(items.length, 25, '搜索结果条目数');
    });

    check('认不出画廊锚的行不产生条目（表头/广告行）', () => {
        const items = svc.parseList('<table class="itg"><tr><th></th><th>Published</th></tr><tr><td>广告</td></tr></table>', 'latest');
        eq(items.length, 0, '表头不该产生条目');
    });

    /* ====================================================================== */
    /* 2. 翻页游标                                                             */
    /* ====================================================================== */

    check('翻页靠 ?next= 游标：前端页给出下一页地址', () => {
        // 实测关键事实：?page=N 三页返回同一批（首个 gid 完全相同），
        // 只有 ?next=<本页最后一个 gid> 才翻得动。用页码翻页会永远停在第 1 页。
        const cursor = svc.nextCursor(fixture('eh_front.html'));
        assert(/\?next=\d+/.test(cursor), `前端页应有 ?next= 游标，得到 ${JSON.stringify(cursor)}`);
        assert(cursor.startsWith('https://e-hentai.org/'), `游标应是绝对地址，得到 ${cursor}`);
    });

    check('搜索页游标保留关键词', () => {
        const cursor = svc.nextCursor(fixture('eh_search.html'));
        assert(cursor.includes('f_search=frieren'), `搜索游标必须带关键词，否则翻页会变成全站列表：${cursor}`);
        assert(/\bnext=\d+/.test(cursor), `搜索游标要有 next：${cursor}`);
    });

    check('末页没有游标（#unext 是 span 而不是 a）', () => {
        // popular 页的 #unext 实测是 <span>：没有下一页。
        // 若把 span 当游标，UI 会一直"加载更多"打同一页。
        eq(svc.nextCursor(fixture('eh_popular.html')), '', 'popular 页不该给出游标');
    });

    check('列表结果：有游标才算还有更多', () => {
        const withCursor = svc.buildChannelListResult({
            channelId: 'latest', page: 1, query: '', html: fixture('eh_front.html'), finalUrl: 'https://e-hentai.org/',
        });
        eq(withCursor.hasMore, true, '前端页还有更多');
        eq(withCursor.baseUrl, svc.nextCursor(fixture('eh_front.html')), 'baseUrl 必须是游标（下一页要原样用它）');

        const noCursor = svc.buildChannelListResult({
            channelId: 'popular', page: 1, query: '', html: fixture('eh_popular.html'), finalUrl: 'https://e-hentai.org/popular',
        });
        eq(noCursor.hasMore, false, 'popular 没有游标，不该还有更多');
    });

    check('挑战页不是结果页：明确报错而不是"没搜到"', () => {
        const challenge = '<html><head><title>Just a moment...</title></head><body>'
            + '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script>'
            + '<div>Checking your browser before accessing</div></body></html>';
        let message = '';
        try {
            svc.buildChannelListResult({ channelId: 'search', page: 1, query: 'x', html: challenge, finalUrl: '' });
        } catch (e) {
            message = e.message;
        }
        assert(/人机验证/.test(message), `应报人机验证，实际：${JSON.stringify(message)}`);
        assert(!/未找到/.test(message), '不能把验证拦截伪装成"未找到"');
    });

    check('搜索无结果与解析失败必须分开报', () => {
        let notFound = '';
        try {
            svc.buildChannelListResult({
                channelId: 'search', page: 1, query: 'zzzz',
                html: '<html><body>No hits found</body></html>', finalUrl: '',
            });
        } catch (e) { notFound = e.message; }
        assert(/未找到/.test(notFound), `真无结果应报未找到，实际：${notFound}`);

        let broken = '';
        try {
            svc.buildChannelListResult({
                channelId: 'search', page: 1, query: 'zzzz',
                html: '<html><body><div>完全认不出的新模板</div></body></html>', finalUrl: '',
            });
        } catch (e) { broken = e.message; }
        assert(/解析失败/.test(broken), `模板变更应报解析失败，实际：${broken}`);
        assert(!/未找到/.test(broken), '解析失败不能伪装成"没搜到"（用户换词也没用）');
    });

    check('频道页没有列表主表时也报解析失败，不静默给空列表', () => {
        // 判据必须是页面内容，而不是"这次请求算不算搜索"：只对搜索报错时，频道页遇到
        // 改版或被换成别的页会静默变成空列表、"加载更多"一起消失，谁也看不出异常。
        let message = '';
        try {
            svc.buildChannelListResult({
                channelId: 'doujinshi', page: 1, query: '',
                html: '<html><body><div>站点维护中</div></body></html>', finalUrl: '',
            });
        } catch (e) { message = e.message; }
        assert(/解析失败/.test(message), `无主表的频道页应报解析失败，实际：${JSON.stringify(message)}`);

        // 有主表但没有条目（末页/空频道）：照旧返回空列表，不许误报成解析失败
        const empty = svc.buildChannelListResult({
            channelId: 'doujinshi', page: 1, query: '',
            html: '<html><body><table class="itg gltc"><tr><th>Title</th></tr></table></body></html>',
            finalUrl: 'https://e-hentai.org/doujinshi',
        });
        eq(empty.items.length, 0, '有主表但零条：返回空列表');
        eq(empty.hasMore, false, '没有游标就没有更多');
    });

    /* ====================================================================== */
    /* 3. 详情页                                                               */
    /* ====================================================================== */

    check('详情页元信息表：Length 给总页数', () => {
        const meta = svc._internals.readMetaTable(fixture('eh_gallery.html'));
        eq(meta.Length, '685 pages', 'Length 行');
        eq(meta.Language, 'Japanese', 'Language 行');
        assert(/MiB|KiB|GiB/.test(meta['File Size'] || ''), `File Size 应带单位，得到 ${meta['File Size']}`);
        eq(svc._internals.totalPagesOf(meta), 685, '总页数');
    });

    check('详情页标题取 #gn（不是堆关键词的 <title>）', () => {
        const html = fixture('eh_gallery.html');
        const gn = html.match(/<h1[^>]*id=["']gn["'][^>]*>([\s\S]*?)<\/h1>/i);
        assert(gn && gn[1].trim().length > 0, '#gn 应有标题');
        // <title> 是 "<标题> - E-Hentai Galleries" 这种 SEO 串，直接当作品名会污染列表
        assert(html.includes('- E-Hentai Galleries'), '快照的 <title> 确实是 SEO 串（否则这条用例失去意义）');
    });

    check('缩略锚解析出页码映射（每批 20 页）', () => {
        const thumbs = svc._internals.readThumbs(fixture('eh_gallery.html'));
        eq(thumbs.size, 20, '首批缩略图应有 20 页');
        const first = thumbs.get(1);
        assert(first && /\/s\/[0-9a-f]+\/4262064-1$/.test(first.url), `第 1 页地址形状不对：${first && first.url}`);
        assert(thumbs.get(20), '第 20 页应在首批里');
        eq(thumbs.get(21), undefined, '第 21 页不属于首批（?p=1 才有）');
    });

    check('第二批缩略图从第 21 页开始', () => {
        const thumbs = svc._internals.readThumbs(fixture('eh_gallery_p2.html'));
        assert(thumbs.get(21), '第二批应含第 21 页');
        eq(thumbs.get(20), undefined, '第二批不含第 20 页');
        const first = thumbs.get(21);
        assert(/4262064-21$/.test(first.url), `第 21 页地址形状不对：${first.url}`);
    });

    check('作品地址解析：必须是 /g/<gid>/<token>/', () => {
        const ok = svc.parseGalleryUrl('https://e-hentai.org/g/4262064/ecdb568beb/');
        eq(ok.gid, '4262064', 'gid');
        eq(ok.token, 'ecdb568beb', 'token');
        eq(ok.url, 'https://e-hentai.org/g/4262064/ecdb568beb/', '规范地址');
        // 省略域名也能认（用户常直接贴路径）
        eq(svc.parseGalleryUrl('/g/4262064/ecdb568beb/').gid, '4262064', '相对路径');
        // 纯数字缺 token：本站点定位不到，必须返回 null 让上层报清楚
        eq(svc.parseGalleryUrl('4262064'), null, '纯数字不该被接受');
        eq(svc.parseGalleryUrl('https://e-hentai.org/g/4262064/'), null, '缺 token 不该被接受');
    });

    check('作品地址尾巴带 query/hash 也要认（浏览器复制出来的地址常带）', () => {
        // 旧写法要求地址以 "/" 收尾，于是 `?nw=session`、`#comments` 这类
        // **完全有效**的作品地址被判成"请填写作品页地址"，用户只能自己去删尾巴。
        eq(svc.parseGalleryUrl('https://e-hentai.org/g/4262064/ecdb568beb/?nw=session').gid, '4262064', '?nw=session');
        eq(svc.parseGalleryUrl('https://e-hentai.org/g/4262064/ecdb568beb/#comments').gid, '4262064', '#comments');
    });

    check('gid 归一：纯数字 / 作品页 / 图片页都要能抽出纯数字', () => {
        // registry.gidOf 全靠它：拿不到纯数字时，落盘目录会被拼成
        // `g-ehentai4262064`（任务键当 gid），取消判定也永远为假。
        eq(svc.normalizeGid('4262064').gid, '4262064', '纯数字');
        eq(svc.normalizeGid('ehentai:4262064').gid, '', '任务键不是 gid（不该被当成数字抽出）');
        eq(svc.normalizeGid('https://e-hentai.org/g/4262064/ecdb568beb/').gid, '4262064', '作品页');
        // 渲染层会把 probe.firstPageUrl（可能是图片页）当 gidOrUrl 回传
        eq(svc.normalizeGid('https://e-hentai.org/s/6f97f6ac71/4262064-1').gid, '4262064', '图片页');
    });

    check('任务键与取消判定对纯数字、图片页、作品页三种输入都成立', () => {
        // 渲染层往下传的是 probe.firstPageUrl；主进程取消时拿到的可能是纯数字。
        // 三者的站点内键必须一致，否则"进度回写找不到任务""取消不掉"。
        const byId = svc.taskKeyOf('4262064');
        const byPage = svc.taskKeyOf('https://e-hentai.org/g/4262064/ecdb568beb/');
        const byImage = svc.taskKeyOf('https://e-hentai.org/s/6f97f6ac71/4262064-1');
        eq(byId, '4262064', '纯数字');
        eq(byPage, '4262064', '作品页');
        eq(byImage, '4262064', '图片页');
        assert(svc.keyMatches(byPage, '4262064'), '作品页键应被纯数字取消命中');
        assert(svc.keyMatches(`${byPage}#run-1`, '4262064'), '带 runToken 的键也要命中');
        eq(svc.keyMatches('9999999', '4262064'), false, '不同 gid 不该命中');
    });

    check('站点描述自洽：id/label/rootName/kinds 都在 provider 里', () => {
        // 这四个字段是 galleryRegistry 组装站点表、决定落盘目录的依据。
        // 缺一个就会在运行时才炸（注册表启动即抛），所以在这里先咬住。
        eq(svc.id, 'ehentai', 'id');
        eq(svc.label, 'E-Hentai', 'label');
        eq(svc.rootName, 'ehentai', '落盘根目录名（Downloads/<rootName>/…）');
        eq(svc.adult, true, '成人站点标记（UI 据此显示 18+）');
        // 探测结果的 site 必须由 provider 自己盖：后续抓页/落盘/取消都拿它回指站点，
        // 漏掉就只剩 gid 可猜，而两个站点的 gid 空间互不相干。
        const probeSrc = fs.readFileSync(path.join(ROOT, 'app', 'main', 'ehentaiService.js'), 'utf8');
        const block = probeSrc.slice(probeSrc.indexOf('async function probeGallery'));
        const body = block.slice(0, block.indexOf('\n}'));
        assert(/site:\s*'ehentai'/.test(body),
            'probeGallery 的返回值里必须带 site: \'ehentai\'（否则详情页的保存会落到默认站点去）');
    });

    check('探测结果的 firstPageUrl 必须是作品页，不能是图片页', () => {
        // 这是整条链路的接缝：渲染层把 firstPageUrl 当 gidOrUrl 回传给抓页/取消，
        // 而本站点的 firstPageUrl 曾经是缩略锚（/s/<imgkey>/<gid>-1 图片页）。
        // 于是每次"边下边播"都报"请填写作品页地址"，整条路走不通。
        const probeSrc = fs.readFileSync(path.join(ROOT, 'app', 'main', 'ehentaiService.js'), 'utf8');
        const block = probeSrc.slice(probeSrc.indexOf('async function probeGallery'));
        const body = block.slice(0, block.indexOf('\n}'));
        assert(/firstPageUrl:\s*galleryUrl/.test(body),
            'probeGallery 必须把 firstPageUrl 设成 galleryUrl（作品页）；'
            + '设成缩略锚会让后续抓页/取消拿到图片页地址而整条链路失败');
        assert(!/firstPageUrl:\s*first\b/.test(body),
            'firstPageUrl 不能取缩略图锚（那是 /s/ 图片页，不是作品页）');
        // 同一份契约里 firstImgUrl 才是直链：两者不能是同一个值
        assert(/firstImgUrl:/.test(body), 'firstImgUrl 必须单独给（大图直链或封面）');
    });

    /* ====================================================================== */
    /* 4. 图片页                                                               */
    /* ====================================================================== */

    check('图片页解析出大图直链与尺寸信息', () => {
        const parsed = svc.parseImagePage(fixture('eh_page.html'));
        assert(parsed, '应解析出大图');
        assert(/^https?:\/\//.test(parsed.url), `直链必须是绝对地址：${parsed.url}`);
        assert(parsed.url.includes('keystamp='), '直链应带 keystamp（有时效，不能缓存复用）');
        eq(parsed.width, 1280, '宽度');
        eq(parsed.height, 1645, '高度');
        assert(/KiB|MiB/.test(parsed.sizeText), `体积文案：${parsed.sizeText}`);
    });

    check('没有大图的页面返回 null（配额超限时就是这种页）', () => {
        eq(svc.parseImagePage('<html><body>You are opening pages too fast</body></html>'), null);
    });

    check('图片页的限流/风控错误走站点文案，不是裸 HTTP 状态码', () => {
        // 这条只能静态核对：resolveImageUrl 走网络，离线测不了。图片页与列表页一样
        // 会被限流，裸报 HTTP 429/403 会让用户在失败页列表里看到一串状态码。
        const src = fs.readFileSync(path.join(ROOT, 'app', 'main', 'ehentaiService.js'), 'utf8');
        const block = src.slice(src.indexOf('async function resolveImageUrl'));
        const body = block.slice(0, block.indexOf('\n}'));
        assert(/mapHttpError\(error\)/.test(body), 'resolveImageUrl 的 httpGet 失败要过 mapHttpError');
        assert(/isCloudflareErrorPage/.test(body), 'Cloudflare 错误页不能报成"未在该页找到大图"');
    });

    /* ====================================================================== */
    /* 5. 频道表与注册表                                                       */
    /* ====================================================================== */

    check('频道表每个 base 都能拼出真实地址', () => {
        for (const ch of svc.CHANNELS) {
            const url = svc.channelListUrl(ch.id, 1);
            assert(url.startsWith('https://e-hentai.org/'), `${ch.id} 地址不对：${url}`);
        }
        // 搜索必须带关键词，否则拼出来的是全站列表
        let threw = false;
        try { svc.channelListUrl('search', 1, ''); } catch { threw = true; }
        assert(threw, '空关键词搜索应报错，而不是退回全站列表');
    });

    check('频道页没有游标时页码不改变地址（翻页只能靠游标）', () => {
        // 页码在本地只是计数器：站点用 ?next=<gid> 翻页，?page=N 实测返回同一批。
        // 所以渲染层必须把上一页回带的 baseUrl 连同缓存一起保留并回传 —— 丢了游标
        // 就只能把第 1 页重抓一遍，"加载更多"点了没反应（这条断言就是那个前提）。
        eq(svc.channelListUrl('latest', 1, ''), 'https://e-hentai.org/', '首页');
        eq(svc.channelListUrl('latest', 2, ''), 'https://e-hentai.org/', '第 2 页仍落到首页');
        eq(svc.channelListUrl('doujinshi', 3, ''), 'https://e-hentai.org/doujinshi', '频道页同理');
        assert(/f_search=/.test(svc.channelListUrl('search', 1, 'a b')), '搜索页要带关键词');
    });

    check('列表缓存必须跨重启保留翻页游标', () => {
        // 静态核对：这两个函数是渲染层 hook + localStorage，离线没有入口，行为测不了。
        // 但这条不变式很脆 —— 游标一旦不落盘，e-hentai 的"加载更多"在重启后只能把
        // 第 1 页再抓一遍，零增长随即把 hasMore 收敛成 false，按钮消失且毫无报错。
        const src = fs.readFileSync(path.join(ROOT, 'app', 'hooks', 'useAcgmho.ts'), 'utf8');
        const store = src.slice(src.indexOf('function storeCache('));
        assert(/baseUrl:\s*entry\.baseUrl/.test(store.slice(0, store.indexOf('\n}'))),
            'storeCache 要把 baseUrl 一起写入 localStorage');
        const load = src.slice(src.indexOf('function loadStoredCache('));
        assert(/baseUrl:\s*entry\.baseUrl/.test(load.slice(0, load.indexOf('\n}'))),
            'loadStoredCache 要把 baseUrl 读回来');
    });

    check('未知频道明确报错', () => {
        let message = '';
        try { svc.channelListUrl('nope', 1); } catch (e) { message = e.message; }
        assert(/未知频道/.test(message), `应报未知频道，实际：${message}`);
    });

    check('本站点只声明图片类型', () => {
        eq(JSON.stringify(svc.kinds), JSON.stringify(['image']), 'kinds');
        assert(svc.CHANNELS.every((c) => c.kind === 'image'), '所有频道都是图片');
    });

    check('下载是逐页「现取直链 → 立刻下载」，不许先批量抓完再下', () => {
        // 直链的 keystamp 最多 10 分钟失效（实测到期落在整 10 分钟边界）。
        // 旧实现先把全本直链解析完再统一下载：685 页的书在 1s 间隔下光解析就要
        // 11 分钟，尾部页全部 403，用户看到"下载完成 600/685"却不知道剩下的是坏的。
        const src = fs.readFileSync(path.join(ROOT, 'app', 'main', 'ehentaiService.js'), 'utf8');
        const block = src.slice(src.indexOf('async function downloadGallery'));
        const body = block.slice(0, block.indexOf('\n}\n'));
        assert(!/fetchGalleryPages\s*\(/.test(body),
            'downloadGallery 不能先调 fetchGalleryPages 批量取直链（签名会在下载前就过期）');
        assert(/resolveImageUrl\s*\(/.test(body),
            'downloadGallery 必须逐页 resolveImageUrl 现取直链');
        assert(/downloadImageWithResume\s*\(/.test(body),
            'downloadGallery 必须逐页下载');
    });

    check('落盘目录与徽标用的是纯数字 gid（不是任务键）', () => {
        // handleSaveImages 曾经把 site.gidOf() 的空串回落成任务键，
        // 于是目录被拼成 `g-ehentai4262064`，徽标里的 gid 也是脏的。
        const core = require(path.join(ROOT, 'app', 'main', 'galleryCore.js'));
        const eh = registry.getSite('ehentai');
        const gid = eh.gidOf('4262064');
        eq(gid, '4262064', 'gidOf 必须给出纯数字');
        const dir = core.defaultGalleryRoot('ehentai', gid, 'g');
        assert(!/ehentai4262064/.test(dir), `目录名不该带任务键：${dir}`);
        assert(/[\\/]ehentai[\\/]g-4262064$/.test(dir), `目录应是 Downloads/ehentai/g-4262064，得到 ${dir}`);
    });

    /* ====================================================================== */
    /* 6. 注册表                                                               */
    /* ====================================================================== */

    check('注册表列出两个站点，且各自频道不串', () => {
        const sites = registry.listSites().map((s) => s.id);
        assert(sites.includes('acgmho') && sites.includes('ehentai'), `站点表：${sites.join(',')}`);
        const all = registry.listChannels();
        const eh = all.find((s) => s.site === 'ehentai');
        const acg = all.find((s) => s.site === 'acgmho');
        eq(eh.channels.length, svc.CHANNELS.length, 'ehentai 频道数');
        assert(acg.channels.length > 0, 'acgmho 频道数');
        assert(eh.channels !== acg.channels, '两个站点的频道表不能是同一个数组');
    });

    check('任务键带站点前缀，两站点同号互不相干', () => {
        const acg = registry.getSite('acgmho');
        const eh = registry.getSite('ehentai');
        const acgKey = acg.taskKeyOf('https://www.acgmho.com/h/4262064.html');
        const ehKey = eh.taskKeyOf('https://e-hentai.org/g/4262064/ecdb568beb/');
        assert(acgKey.startsWith('acgmho:'), `acgmho 键：${acgKey}`);
        assert(ehKey.startsWith('ehentai:'), `ehentai 键：${ehKey}`);
        assert(acgKey !== ehKey, '同号作品在两站必须是不同的键');
        // 归属判定不能跨站
        eq(eh.keyMatches(acgKey, '4262064'), false, 'ehentai 不该认领 acgmho 的键');
        eq(acg.keyMatches(ehKey, '4262064'), false, 'acgmho 不该认领 ehentai 的键');
    });

    check('未知站点明确报错（不静默回落成默认站点）', () => {
        let message = '';
        try { registry.getSite('nope'); } catch (e) { message = e.message; }
        assert(/未知站点/.test(message), `应报未知站点，实际：${message}`);
    });

    check('旧的无前缀任务键仍归默认站点', () => {
        // 历史任务键（h:123 / 123）没有站点前缀：那时只有 acgmho 一个站点，
        // 归给它是唯一能同时保证"旧任务能取消"和"不误杀新站点"的判法。
        eq(registry.siteOfTaskKey('h:123').id, 'acgmho', 'h:123');
        eq(registry.siteOfTaskKey('123').id, 'acgmho', '123');
        eq(registry.siteOfTaskKey('ehentai:4262064').id, 'ehentai', 'ehentai:4262064');
    });

    check('每个站点都声明自己的搜索 cookie 域（不共用一份）', () => {
        // 主进程按它从 Electron 会话捞 cf_clearance。曾经写死 acgmho 的两个域，
        // 接 e-hentai 之后就把 acgmho 的 cookie 发去了 e-hentai.org ——
        // 既是凭证跨站泄漏，也必然无效（cookie 按域签发）。
        const acg = registry.getSite('acgmho');
        const eh = registry.getSite('ehentai');
        assert(Array.isArray(acg.searchCookieOrigins) && acg.searchCookieOrigins.length > 0,
            'acgmho 必须声明 searchCookieOrigins');
        assert(Array.isArray(eh.searchCookieOrigins) && eh.searchCookieOrigins.length > 0,
            'ehentai 必须声明 searchCookieOrigins');
        const overlap = acg.searchCookieOrigins.filter((u) => eh.searchCookieOrigins.includes(u));
        eq(overlap.length, 0, `两个站点不该共用 cookie 域：${overlap.join(',')}`);
        assert(eh.searchCookieOrigins.every((u) => /e-hentai\.org/.test(u)),
            `ehentai 的 cookie 域必须是自己的域，得到 ${eh.searchCookieOrigins.join(',')}`);
    });

    /* ====================================================================== */

    if (fails.length > 0) {
        for (const f of fails) console.log(`  FAIL  ${f.name}\n        ${f.message}`);
    }
    console.log(`  E-Hentai 适配 ${pass} pass / ${fails.length} fail`);
    return fails.length === 0;
};

module.exports = { run };

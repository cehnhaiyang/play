'use strict';
/**
 * 插件嗅探分类的回归测试。
 *
 * 被测的是 `extension/src/shared/classify.ts` 的**真实实现**（编译产物），
 * 不是副本 —— 分类逻辑如果只能靠"打开浏览器点一下"验证，`.ts` 分片、
 * query 藏后缀、content-type 与后缀互相矛盾这几类错就会长期潜伏。
 *
 * 另有三组**跨端同源**断言：
 *   · 后缀表派生自 const.ts（不是手抄），比对它与应用侧 main.js 副本；
 *   · MIME→后缀表与 main.js 的第二份副本逐条比对；
 *   · 分片正则与 const.ts 的源码字符串一致。
 *
 * 迁移期这三条都必须绿。等自建浏览器外壳删掉、main.js 那份副本消失后，
 * 前两组断言会失去比对对象，届时连同本文件一起简化（不是删掉分类测试）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

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

const run = () => {
    // 每次调用都重置：run() 会被同进程调用多次（变异检查就是），
    // 计数留在模块级会把上一次的结果累计进来。
    pass = 0;
    fails.length = 0;

    const C = require('./build/extension/src/shared/classify.js');
    const CONST = require('./build/shared/core/index.js');
    const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'app', 'main', 'main.js'), 'utf8');

    const classify = (url, contentType, documentUrl) =>
        C.classifyResponse({ url, contentType: contentType || '', documentUrl });

    /* ====================================================================== */
    /* 1. content-type 判据                                                     */
    /* ====================================================================== */

    check('m3u8 / mpd 判成 stream，后缀取真实类型', () => {
        eq(classify('https://a.com/x', 'application/vnd.apple.mpegurl')?.type, 'stream');
        eq(classify('https://a.com/x', 'application/vnd.apple.mpegurl')?.ext, 'm3u8');
        eq(classify('https://a.com/x', 'application/dash+xml')?.ext, 'mpd', 'dash 的后缀是 mpd 不是 m3u8');
    });

    check('video/mp2t 归一成 ts + stream（不能照搬子类型 mp2t）', () => {
        // 照搬 content-type 字面量会得到 ext='mp2t'，而 const.ts 表里只有 'ts'，
        // 于是同一个地址两条路径两个结论：筛选栏归错类、ffmpeg 判定落空。
        const r = classify('https://a.com/v', 'video/mp2t');
        eq(r?.type, 'stream', 'MPEG-TS 属 stream');
        eq(r?.ext, 'ts', "后缀必须归一为 'ts'");
    });

    check('video/x-flv 判成 stream', () => {
        eq(classify('https://a.com/v', 'video/x-flv')?.type, 'stream');
        eq(classify('https://a.com/v', 'video/x-flv')?.ext, 'flv');
    });

    check('MIME 子类型不是后缀时映射到规范后缀', () => {
        // 照搬子类型会让文件名变成「片子.matroska」，而应用按 MEDIA_EXTENSIONS
        // 查表全部落空。
        eq(classify('https://a.com/v', 'video/x-matroska')?.ext, 'mkv');
        eq(classify('https://a.com/v', 'audio/x-mpeg')?.ext, 'mp3');
        eq(classify('https://a.com/v', 'audio/mp4')?.ext, 'm4a', 'audio/mp4 的真实后缀是 m4a');
        eq(classify('https://a.com/v', 'video/mpeg')?.ext, 'mpg');
    });

    check('ogg 按主类型分岔（video/ogg 与 audio/ogg 不同）', () => {
        // 合成一张表必然把其中一个映射错，所以是两张表。
        eq(classify('https://a.com/v', 'video/ogg')?.ext, 'ogv');
        eq(classify('https://a.com/v', 'audio/ogg')?.ext, 'ogg');
    });

    check('image/svg+xml 归一成 svg', () => {
        eq(classify('https://a.com/i', 'image/svg+xml')?.ext, 'svg');
    });

    check('网页自身资源被丢弃（html/css/js/json）', () => {
        for (const ct of ['text/html; charset=utf-8', 'text/css', 'application/javascript', 'application/json']) {
            eq(classify('https://a.com/page', ct), null, `${ct} 不该进嗅探列表`);
        }
    });

    /* ====================================================================== */
    /* 2. 后缀与 query 判据                                                     */
    /* ====================================================================== */

    check('无 content-type 时按路径后缀判定', () => {
        eq(classify('https://a.com/movie.mp4', '')?.type, 'video');
        eq(classify('https://a.com/song.flac', '')?.type, 'audio');
        eq(classify('https://a.com/pic.avif', '')?.type, 'image');
        eq(classify('https://a.com/list.m3u8', '')?.type, 'stream');
    });

    check('query 里藏的后缀能认出来，且返回真实后缀', () => {
        // 裸 includes 会把 component.tsx 里的 .ts、backup.mpd2 里的 .mpd 也认进来，
        // 于是界面打上「ffmpeg 下载」徽章，用户点了才发现下回来一个文本文件。
        eq(classify('https://a.com/get?file=movie.mp4', '')?.ext, 'mp4');
        eq(classify('https://a.com/get?file=movie.mpd', '')?.ext, 'mpd', '要返回真实后缀不是写死 m3u8');
        eq(classify('https://a.com/get?url=a%2Fb.m3u8', '')?.ext, 'm3u8');
    });

    check('query 后缀必须成词：component.tsx / backup.mpd2 不算', () => {
        eq(classify('https://a.com/get?f=component.tsx', ''), null, '.tsx 不是 .ts');
        eq(classify('https://a.com/get?f=backup.mpd2', ''), null, '.mpd2 不是 .mpd');
    });

    check('不可嗅探的协议被丢弃', () => {
        for (const u of [
            'blob:https://a.com/abc',
            'data:video/mp4;base64,AAAA',
            'file:///D:/local.mp4',
            'chrome-extension://abc/x.mp4',
            'devtools://devtools/x',
        ]) {
            eq(classify(u, 'video/mp4'), null, `${u} 不该进嗅探列表`);
        }
    });

    check('file: 必须排除（ACG 落盘页轮播会刷屏）', () => {
        // 落盘页正是 file://，hostname 为空走不进域名排除，img 又是 no-referrer。
        eq(classify('file:///D:/saved/001.jpg', 'image/jpeg'), null);
    });

    /* ====================================================================== */
    /* 3. HLS 分片过滤                                                          */
    /* ====================================================================== */

    check('HLS 分片被丢弃（不刷屏）', () => {
        for (const u of [
            'https://a.com/seg/000.ts',
            'https://a.com/ts/1.ts',
            'https://a.com/chunk_00001.ts',
            'https://a.com/0.ts',
            'https://a.com/video-1.ts',
        ]) {
            eq(classify(u, 'video/mp2t'), null, `${u} 是分片，不该推送`);
        }
    });

    check('整段 .ts 视频被保留（分片判据不能过宽）', () => {
        // 年份目录里的整段 .ts 同样可下载，正是这份判据要保护的东西。
        const r = classify('https://a.com/video/2024/lecture.ts', 'video/mp2t');
        assert(r !== null, '整段 .ts 不该被当成分片丢掉');
        eq(r.type, 'stream');
        eq(r.ext, 'ts');
    });

    check('播放列表本身保留（它是可下载的流入口）', () => {
        // 名字里带 playlist 的分片路径要留下
        const r = classify('https://a.com/playlist/seg1.ts', 'video/mp2t');
        assert(r !== null, '带 playlist 的地址要保留');
    });

    check('CDN 标成 octet-stream 的分片仍被丢弃（第三条门）', () => {
        // 部分 CDN 把分片标成 application/octet-stream：既不进 mpegurl 分支
        // 也不进 video/ 分支，只靠 content-type 两条门会让整页 segNNN.ts 全推上来。
        eq(classify('https://a.com/seg/0001.ts', 'application/octet-stream'), null);
    });

    /* ====================================================================== */
    /* 4. ACG 排除                                                              */
    /* ====================================================================== */

    check('ACG 域名与其子域被排除', () => {
        for (const host of ['acgmho.com', 'www.acgmho.com', 'cdn.acgnngca.com', 'acg-hentai.com']) {
            eq(classify(`https://${host}/x.jpg`, 'image/jpeg'), null, `${host} 属 ACG，走画廊流程`);
        }
    });

    check('ACG 页面下挂的第三方资源也被排除（documentUrl 命中）', () => {
        eq(classify('https://cdn.other.com/x.jpg', 'image/jpeg', 'https://acgmho.com/g/123'), null);
    });

    check('非 ACG 域名不受影响（后缀匹配不能过宽）', () => {
        // notacgmho.com 不该被当成 acgmho.com 的子域
        assert(classify('https://notacgmho.com/x.jpg', 'image/jpeg') !== null, 'notacgmho.com 不是 ACG 域');
    });

    /* ====================================================================== */
    /* 5. 标题推导                                                              */
    /* ====================================================================== */

    check('标题优先取 content-disposition 的文件名', () => {
        eq(C.deriveTitle('https://a.com/x', 'attachment; filename="影片.mp4"', 'mp4'), '影片.mp4');
        eq(C.deriveTitle('https://a.com/x', "attachment; filename*=UTF-8''%E7%89%87.mp4", 'mp4'), '片.mp4');
    });

    check('没有 disposition 时取 URL 末段并解码', () => {
        eq(C.deriveTitle('https://a.com/dir/%E7%89%87.mp4', '', 'mp4'), '片.mp4');
    });

    check('超长或缺失的文件名回落成 Media_<ext>', () => {
        const long = 'a'.repeat(90) + '.mp4';
        eq(C.deriveTitle(`https://a.com/${long}`, '', 'mp4'), 'Media_mp4');
        eq(C.deriveTitle('https://a.com/', '', 'mp4'), 'Media_mp4');
    });

    /* ====================================================================== */
    /* 6. 跨端同源：后缀表派生自 const.ts                                        */
    /* ====================================================================== */

    check('后缀表派生自 const.ts，与表内容一致', () => {
        // 期望值要按**后缀名**排除 aibook —— 它在表里的类型是 image，
        // 按类型过滤（type === 'aibook'）永远匹配不上。
        const expected = { stream: [], video: [], audio: [], image: [] };
        for (const [ext, type] of Object.entries(CONST.MEDIA_EXTENSIONS)) {
            if (ext === 'aibook') continue;
            if (expected[type]) expected[type].push(ext);
        }
        const sortJoin = (a) => [...a].sort().join(',');
        eq(sortJoin(C.STREAM_EXTS), sortJoin(expected.stream), 'stream 后缀表');
        eq(sortJoin(C.VIDEO_EXTS), sortJoin(expected.video), 'video 后缀表');
        eq(sortJoin(C.AUDIO_EXTS), sortJoin(expected.audio), 'audio 后缀表');
        eq(sortJoin(C.IMAGE_EXTS), sortJoin(expected.image), 'image 后缀表');
    });

    check('.aibook 不进嗅探表（它是应用归档不是网页资源）', () => {
        assert(!C.IMAGE_EXTS.includes('aibook'), 'aibook 应被 SNIFF_EXCLUDED_EXTS 排除');
    });

    /* ====================================================================== */
    /* 7. 跨端同源：与 main.js 的手抄副本比对                                    */
    /* ====================================================================== */

    check('插件后缀表与 main.js 副本逐条一致（迁移期）', () => {
        const block = (name) => {
            const start = MAIN_SRC.indexOf(`const ${name} = [`);
            assert(start > 0, `main.js 里找不到 ${name}`);
            const end = MAIN_SRC.indexOf('];', start);
            return MAIN_SRC.slice(start, end);
        };
        const pairs = [
            ['streamExts', C.STREAM_EXTS],
            ['videoExts', C.VIDEO_EXTS],
            ['audioExts', C.AUDIO_EXTS],
            ['imageExts', C.IMAGE_EXTS],
        ];
        for (const [name, ours] of pairs) {
            const src = block(name);
            for (const ext of ours) {
                assert(new RegExp(`'${ext}'`).test(src), `${name} 缺 '${ext}'：插件有而 main.js 没有`);
            }
        }
    });

    check('MIME→后缀两张表与 main.js 逐条一致（迁移期）', () => {
        const grab = (name) => {
            const start = MAIN_SRC.indexOf(`const ${name} = {`);
            assert(start > 0, `main.js 里找不到 ${name}`);
            const end = MAIN_SRC.indexOf('};', start);
            const body = MAIN_SRC.slice(start, end);
            const out = {};
            for (const m of body.matchAll(/'([^']+)':\s*'([^']+)'/g)) out[m[1]] = m[2];
            return out;
        };
        const video = grab('VIDEO_MIME_EXTS');
        const audio = grab('AUDIO_MIME_EXTS');
        for (const [k, v] of Object.entries(C.VIDEO_MIME_EXTS)) {
            eq(video[k], v, `VIDEO_MIME_EXTS['${k}']`);
        }
        for (const [k, v] of Object.entries(C.AUDIO_MIME_EXTS)) {
            eq(audio[k], v, `AUDIO_MIME_EXTS['${k}']`);
        }
    });

    check('分片正则与 shared/core 的源码字符串一致', () => {
        // 插件用 shared/core/media.ts 的源码字符串构造正则，main.js 是逐字复制的一份。
        // 这里确认插件侧真的用了共享源码（不是自己又写了一遍）。
        const src = fs.readFileSync(
            path.join(ROOT, 'extension', 'src', 'shared', 'classify.ts'), 'utf8');
        assert(src.includes('HLS_SEGMENT_RE_SOURCE'), 'classify.ts 必须 import 共享的分片正则源码');
        assert(!/\(\?:\^\|\/\)\(?:segment\|seg\|chunk/.test(src),
            'classify.ts 自己抄了一份分片正则 —— 应该 import shared/core 的那份');
        assert(typeof CONST.HLS_SEGMENT_RE_SOURCE === 'string', 'shared/core 应导出正则源码字符串');
    });

    /* ====================================================================== */
    /* 8. 与 shared/core 的判据同口径                                          */
    /* ====================================================================== */

    check('分类结果与 getMediaType 对同一地址结论一致', () => {
        // 两条路径（网络层嗅探 / 页内扫描）对同一个地址必须同结论，
        // 否则筛选栏归类与实际下载方式会对不上。
        const cases = [
            ['https://a.com/movie.mp4', 'video'],
            ['https://a.com/song.mp3', 'audio'],
            ['https://a.com/list.m3u8', 'stream'],
            ['https://a.com/pic.png', 'image'],
        ];
        for (const [url, expected] of cases) {
            eq(classify(url, '')?.type, expected, `${url} 的嗅探分类`);
            eq(CONST.getMediaType(url, undefined, url), expected, `${url} 的 getMediaType 分类`);
        }
    });

    /* ====================================================================== */
    /* 8.1 页内扫描的后缀判据（classifyByExt）                                   */
    /* ====================================================================== */

    /**
     * 页内扫描的候选**没有响应头** —— 那些地址很多根本没被请求过，正是这一层
     * 要捞的东西。所以它只能走后缀判据，而这条路径必须与网络层同结论：
     * 同一个地址走两条路得出两个类型，筛选栏与实际下载方式就会对不上。
     */
    check('classifyByExt 与 classifyResponse 对同一地址同结论', () => {
        const cases = [
            ['https://a.com/movie.mp4', 'mp4', 'video'],
            ['https://a.com/song.flac', 'flac', 'audio'],
            ['https://a.com/list.m3u8', 'm3u8', 'stream'],
            ['https://a.com/pic.avif', 'avif', 'image'],
        ];
        for (const [url, ext, expected] of cases) {
            eq(C.classifyByExt(url, ext)?.type, expected, `${url} 的页内分类`);
            eq(classify(url, '')?.type, expected, `${url} 的网络层分类`);
        }
    });

    check('classifyByExt 认不出时返回 null（不硬套一个类型）', () => {
        // 页内扫描的候选里混着 JS、CSS、字体。认不出就丢，硬套类型会往列表里灌噪声。
        eq(C.classifyByExt('https://a.com/app.js', 'js'), null);
        eq(C.classifyByExt('https://a.com/style.css', 'css'), null);
        eq(C.classifyByExt('https://a.com/font.woff2', 'woff2'), null);
        eq(C.classifyByExt('https://a.com/x', ''), null);
    });

    check('classifyByExt 也丢 HLS 分片（否则一次扫描灌进几百条）', () => {
        // 网络层那条路已经拦了；页内扫描（Performance / 源码正则）会捞到整页
        // segNNN.ts，少了这道闸一次扫描就能把列表刷满。
        eq(C.classifyByExt('https://a.com/seg/000.ts', 'ts'), null);
        eq(C.classifyByExt('https://a.com/ts/1.ts', 'ts'), null);
        // 整段 .ts 仍要保留（分片判据不能过宽）
        assert(C.classifyByExt('https://a.com/video/2024/lecture.ts', 'ts') !== null,
            '整段 .ts 不该被页内扫描丢掉');
    });

    check('classifyByExt 看 query 里藏的后缀', () => {
        // 页内扫描捞到的地址常常没有路径后缀（`/api/play?file=movie.mp4`）
        eq(C.classifyByExt('https://a.com/get?file=movie.mp4', '')?.type, 'video');
        eq(C.classifyByExt('https://a.com/get?url=a%2Fb.m3u8', '')?.type, 'stream');
    });

    /* ====================================================================== */
    /* 8.2 页内扫描脚本的注入契约                                               */
    /* ====================================================================== */

    /**
     * `IN_PAGE_SCAN` 会被 `toString()` 之后在目标页面里**重新求值**。
     *
     * 所以它不能引用任何外层作用域的东西 —— 包括 import 进来的常量。哪怕
     * TypeScript 编译通过，运行时那个标识符在页面里根本不存在，表现为
     * "扫描静默返回空"：不报错、不抛异常，列表就是空的。
     *
     * 这条断言必须存在，因为上面那个失败模式没有任何其它检查能挡住它。
     */
    check('IN_PAGE_SCAN 不引用外层作用域（注入后仍能求值）', () => {
        const src = fs.readFileSync(
            path.join(ROOT, 'extension', 'src', 'shared', 'inpage.ts'), 'utf8');
        const start = src.indexOf('export const IN_PAGE_SCAN');
        assert(start > 0, 'inpage.ts 里找不到 IN_PAGE_SCAN');
        // 取到函数体结束：下一个顶层 `};` 收尾
        const body = src.slice(start, src.indexOf('\n};', start));

        /*
         * 判据一：函数体里出现的标识符，只能是参数、局部声明、或宿主全局。
         * 这里用**编译产物**跑真值而不是读源码：源码里的类型标注会被擦除，
         * 拿源码判会误报。
         */
        const built = require('./build/extension/src/shared/inpage.js');
        assert(typeof built.IN_PAGE_SCAN === 'function', '编译产物里没有 IN_PAGE_SCAN');

        const text = built.IN_PAGE_SCAN.toString();
        assert(text.includes('location.href'), 'IN_PAGE_SCAN 里应读取页面自身地址');
        // 自由变量：源码里不得出现 `config.` 之外的模块级标识符引用。
        // 保守判据 —— 只钉住最容易犯的那一类：直接引用 import 进来的常量名。
        for (const name of ['STREAM_EXTS', 'VIDEO_EXTS', 'AUDIO_EXTS', 'IMAGE_EXTS', 'MEDIA_EXTENSIONS']) {
            assert(!new RegExp(`\\b${name}\\b`).test(body),
                `IN_PAGE_SCAN 引用了外层常量 ${name} —— 注入到页面后它是 undefined，扫描会静默返回空。`
                + '需要的表要经 args 传进来。');
        }
    });

    check('IN_PAGE_SCAN 在无 DOM 的沙箱里可求值，且候选来源齐全', () => {
        /*
         * 真跑一遍：造一个最小的 DOM 桩，确认五条采集路径都被走到。
         *
         * 这是**契约断言**不是实现断言 —— 旧实现（useBrowse 的
         * IN_PAGE_INSPECTOR_SCRIPT）有四条路，一条少了就是能力缺失，
         * 而"少了一条"在真浏览器里只表现为"某些站点嗅不到"。
         */
        const built = require('./build/extension/src/shared/inpage.js');
        const created = [];

        const makeElement = (tag, attrs = {}) => ({
            tagName: tag.toUpperCase(),
            getAttribute: (k) => (k in attrs ? attrs[k] : null),
            querySelectorAll: () => [],
            currentSrc: attrs.currentSrc || '',
            src: attrs.src || '',
        });

        const media = makeElement('video', { src: '/movie.mp4' });
        media.currentSrc = '/movie.mp4';
        const audio = makeElement('audio', { src: '/song.mp3' });
        const frame = makeElement('iframe', { src: 'https://other.com/embed' });

        const documentStub = {
            title: '测试页面',
            querySelectorAll: (selector) => {
                if (selector === 'video, audio') return [media, audio];
                if (selector === 'iframe') return [frame];
                return [];
            },
            documentElement: {
                outerHTML: '<html><script>var x = "https://cdn.com/a.m3u8";</script></html>',
            },
        };

        const locationStub = { href: 'https://page.com/watch' };
        const windowStub = {
            __playinfo__: {
                data: {
                    dash: {
                        video: [{ baseUrl: 'https://cdn.com/v.m4s' }],
                        audio: [{ baseUrl: 'https://cdn.com/a.m4s' }],
                    },
                },
            },
        };
        const performanceStub = {
            getEntriesByType: () => [
                { name: 'https://cdn.com/perf.mp4', initiatorType: 'video' },
                { name: 'https://cdn.com/app.js', initiatorType: 'script' },
            ],
        };

        const vm = require('vm');
        const sandbox = { document: documentStub, location: locationStub, window: windowStub, performance: performanceStub, URL, Set, Array, JSON, RegExp, String };
        vm.createContext(sandbox);
        const result = vm.runInContext(
            `(${built.IN_PAGE_SCAN.toString()})(${JSON.stringify({
                allExts: ['m3u8', 'mp4', 'mp3', 'm4s'],
                limit: 100,
                htmlLimit: 100000,
                matchLimit: 100,
            })})`,
            sandbox,
        );

        const urls = result.items.map((i) => i.url);
        const hints = new Set(result.items.map((i) => i.hint));
        eq(result.pageUrl, 'https://page.com/watch', '页面地址应由页面自己报');
        eq(result.pageTitle, '测试页面');

        assert(urls.includes('https://page.com/movie.mp4'), 'DOM 里的 <video src> 应被收到');
        assert(urls.includes('https://page.com/song.mp3'), 'DOM 里的 <audio src> 应被收到');
        assert(urls.includes('https://cdn.com/perf.mp4'), 'Performance 里的资源应被收到');
        assert(urls.includes('https://cdn.com/v.m4s'), '__playinfo__ 的 dash 视频轨应被收到');
        assert(urls.includes('https://cdn.com/a.m4s'), '__playinfo__ 的 dash 音频轨应被收到');
        assert(urls.includes('https://other.com/embed'), 'iframe src 应被收到');
        assert(urls.includes('https://cdn.com/a.m3u8'), '页面源码里的直链应被正则捞到');

        for (const hint of ['video', 'audio', 'perf', 'playinfo-video', 'playinfo-audio', 'frame', 'source']) {
            assert(hints.has(hint), `候选来源 ${hint} 没有产出任何条目 —— 一条采集路径漏了`);
        }
        void created;
    });

    check('IN_PAGE_SCAN 丢掉 blob: 与相对地址归一', () => {
        // blob: 是页面自己那块内存的句柄，点下载必然失败；
        // 相对地址不归一的话送回 SW 之后已经不知道它是相对谁的了。
        const built = require('./build/extension/src/shared/inpage.js');
        const vm = require('vm');
        const media = {
            tagName: 'VIDEO',
            getAttribute: () => 'blob:https://page.com/abc',
            querySelectorAll: () => [],
            currentSrc: 'blob:https://page.com/abc',
            src: '',
        };
        const sandbox = {
            document: {
                title: '',
                querySelectorAll: (s) => (s === 'video, audio' ? [media] : []),
                documentElement: { outerHTML: '' },
            },
            location: { href: 'https://page.com/x' },
            window: {},
            performance: { getEntriesByType: () => [] },
            URL, Set, Array, JSON, RegExp, String,
        };
        vm.createContext(sandbox);
        const result = vm.runInContext(
            `(${built.IN_PAGE_SCAN.toString()})(${JSON.stringify({ allExts: ['mp4'], limit: 10, htmlLimit: 10, matchLimit: 10 })})`,
            sandbox,
        );
        eq(result.items.length, 0, 'blob: 不该进候选');
    });

    /* ====================================================================== */
    /* 8.3 两条采集路径不得各写一份实现                                          */
    /* ====================================================================== */

    /**
     * `dispatchBridge`（应用/球经 native messaging）与 `dispatchBall`
     * （页面里的球走 `chrome.runtime`）做的是同一批事，只是入口不同。
     *
     * **重叠的部分只能有一份实现。** 两份实现必然漂移，而漂移的表现是
     * "某一端点了没反应"—— 实测过一次：给 `sniffer-set-enabled` 加了
     * "打开开关时自动扫一次当前页"，只加在 `dispatchBridge` 那一份上。
     * 球走的是 `dispatchBall`，于是用户点开开关看到的仍是空列表，
     * 而插件自检（走桥）全绿。
     *
     * 判据：`dispatchBall` 里凡是与桥重叠的 kind，都必须**转发**而不是
     * 重新实现。转发写起来就是一个 `dispatchBridge('...')` 调用，
     * 重新实现则是去碰 `clearItems` / `scanTab` / `getItems` 这些内部函数。
     */
    check('dispatchBall 与 dispatchBridge 重叠的部分只有一份实现', () => {
        const src = fs.readFileSync(
            path.join(ROOT, 'extension', 'src', 'background', 'service-worker.ts'), 'utf8');
        const start = src.indexOf('const dispatchBall');
        assert(start > 0, '找不到 dispatchBall');
        // 取到函数结束：下一个顶层 `};` 收尾
        const body = src.slice(start, src.indexOf('\n};', start));

        /*
         * 与桥重叠的 kind —— 它们必须转发。
         * 不在这张表里的（cookies-*、host-ensure、page-eval、page-navigate）
         * 是球独有、面板没有上下文的，允许直接实现。
         */
        const mustForward = [
            'sniffer-set-enabled', 'sniffer-get-state', 'sniffer-clear',
            'sniffer-clear-tab', 'sniffer-tabs', 'sniffer-close-tab',
            'sniffer-scan', 'sniffer-active-page',
            'sniffer-ai-scan', 'downloads-start', 'agent-snapshot', 'agent-action',
            // 面板的「规则 / 请求头 / 存储 / JWT」四个页签走的就是这几条
            'tamper-get', 'tamper-set', 'tamper-inject',
            'page-storage-read', 'page-storage-write',
        ];
        for (const kind of mustForward) {
            assert(body.includes(`'${kind}'`), `dispatchBall 少了 ${kind} 这条分支`);
            // 该分支里必须出现一次转发调用
            const at = body.indexOf(`case '${kind}'`);
            const next = body.indexOf('case ', at + 6);
            const branch = body.slice(at, next < 0 ? body.length : next);
            assert(/dispatchBridge\(/.test(branch),
                `dispatchBall 的 ${kind} 没有转发给 dispatchBridge，而是自己实现了一份 ——`
                + '两份实现必然漂移，表现是"某一端点了没反应"。');
        }

        // 反向：转发之后不该再碰那些内部函数（碰了说明只转了一半）
        for (const fn of ['clearItems(', 'scanTab(', 'aiSniffTab(', 'clearTab(', 'getItems(']) {
            assert(!body.includes(fn),
                `dispatchBall 里直接调了 ${fn} —— 与桥重叠的操作必须整条转发，`
                + '只转一半等于又造了一份实现。');
        }
    });

    /* ====================================================================== */
    /* 8.4 端点表 / 协议 / 桥分发三处必须对得上                                    */
    /* ====================================================================== */

    /**
     * 新增一个桥端点要同时改三个地方：`service-worker.ts` 的 `dispatchBridge`
     * 分支、`shared/protocol.ts` 的 `BallRequest`、以及 `dispatchBall` 的转发。
     *
     * 漏掉任何一处的表现都是**运行时才暴露**，而且都是"点了没反应"：
     *  · 漏了 `dispatchBridge` 分支 —— 插件回"不认识的桥端点"；
     *  · 漏了 `dispatchBall` 转发 —— 球发出去的消息落到穷尽检查，抛"未知消息"。
     *
     * 实测过一次：`tamper-set` 加进了归属表与 `dispatchBridge`，却忘了
     * `BallRequest` 与转发。球上的规则页点"保存"直接报"未知消息"，
     * 而插件侧的单测全绿 —— 因为那些测的是 `dispatchBridge`，球根本不走它。
     *
     * ## 为什么判据取自**球的调用点**而不是归属表
     *
     * `BRIDGE_ENDPOINTS` 里 `route: 'extension'` 的条目并非都由插件的
     * `dispatchBridge` 实现 —— 迁移期还有一批（get-cookies、acgmho-* 等）
     * 仍由应用侧的 handler 直接服务，那条名单在 `bridge.test.js` 里。
     * 拿归属表当判据会把那批全部误报。
     *
     * 真正要守的是"球调的每一个端点，插件都认识"。所以这里扫的是
     * `app/renderer/orb/` 下的**实际调用字面量**——那是唯一权威。
     */
    check('悬浮球调的每个桥端点都有 dispatchBridge 分支', () => {
        const orbDir = path.join(ROOT, 'app', 'renderer', 'orb');
        const swSrc = fs.readFileSync(
            path.join(ROOT, 'extension', 'src', 'background', 'service-worker.ts'), 'utf8');
        const start = swSrc.indexOf('const dispatchBridge');
        assert(start > 0, '找不到 dispatchBridge');
        const body = swSrc.slice(start, swSrc.indexOf('\n};', start));

        /*
         * **必须先剥掉注释再匹配。**
         *
         * 变异测试实测过：把 `case 'tamper-set'` 整段用块注释注掉之后，
         * 断言**照样绿** —— 因为那个字面量还在注释里。判据是"有没有这条分支"，
         * 而注释掉的分支不是分支。这是源码文本断言最容易骗过自己的地方。
         */
        const code = body
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');

        const called = new Set();
        for (const file of fs.readdirSync(orbDir)) {
            if (!/\.tsx?$/.test(file)) continue;
            const src = fs.readFileSync(path.join(orbDir, file), 'utf8');
            // bridge('endpoint') / bridge<T>('endpoint') / agentAction 走的是 agent-action
            for (const m of src.matchAll(/\bbridge(?:<[^>]*>)?\(\s*'([\w-]+)'/g)) called.add(m[1]);
        }
        assert(called.size >= 8, `球的桥调用太少（${called.size}），正则可能失配了`);

        const missing = [...called].filter((name) => !code.includes(`case '${name}'`));
        eq(missing.length, 0,
            `球调了这些端点，但 dispatchBridge 没有分支：${missing.join('、')}。`
            + '表现是插件回"不认识的桥端点"，而界面上只是"点了没反应"。');
    });

    check('BallRequest 的每个 kind 都在 dispatchBall 里有分支', () => {
        const protocolSrc = fs.readFileSync(
            path.join(ROOT, 'extension', 'src', 'shared', 'protocol.ts'), 'utf8');
        const start = protocolSrc.indexOf('export type BallRequest');
        assert(start > 0, '找不到 BallRequest');
        const block = protocolSrc.slice(start, protocolSrc.indexOf('export type BallEvent', start));

        // kind 都是字符串字面量，抓 `kind: '...'`
        const kinds = [...block.matchAll(/kind: '([\w-]+)'/g)].map((m) => m[1]);
        assert(kinds.length > 10, `BallRequest 的 kind 太少（${kinds.length}），正则可能失配了`);

        const swSrc = fs.readFileSync(
            path.join(ROOT, 'extension', 'src', 'background', 'service-worker.ts'), 'utf8');
        const dStart = swSrc.indexOf('const dispatchBall');
        assert(dStart > 0, '找不到 dispatchBall');
        const body = swSrc.slice(dStart, swSrc.indexOf('\n};', dStart));

        const missing = kinds.filter((kind) => !body.includes(`case '${kind}'`));
        eq(missing.length, 0,
            `这些 kind 在 BallRequest 里声明了，但 dispatchBall 没有分支：${missing.join('、')}。`
            + '球发出去会落到穷尽检查，抛"未知消息"—— 表现是界面点了没反应。');
    });

    /* ====================================================================== */
    /* 8.5 标签页归属：两端共用的唯一判据                                        */
    /* ====================================================================== */

    /**
     * 嗅探的作用域是"浏览器里打开的全部标签页"，所以归属判据是标签页 id。
     *
     * **必须直接调用判据，不能只 grep 源码。** 变异测试实测过：把一个判据
     * 换成 `() => false`，全部用例照样绿 —— 因为没有任何一条断言调用过它，
     * 那些"断言"只是在源码里找那个名字。
     *
     * 覆盖三种状态：拥有、不拥有、摘掉之后剩下的。
     */
    check('isFromTab：拥有 / 不拥有 / 没有归属三种状态', () => {
        const { isFromTab, withoutTab } = CONST;

        // 一条被两个标签页请求过的资源：两个标签页下都必须看得见。
        // 只记第一个会让"切到另一个标签页就看不到它"，而那个标签页确实请求过它
        const shared = { url: 'u', tabIds: [3, 7] };
        eq(isFromTab(shared, 3), true, '被 3 号请求过');
        eq(isFromTab(shared, 7), true, '也被 7 号请求过 —— 单 id 存不下这个事实');
        eq(isFromTab(shared, 9), false, '没被 9 号请求过');

        // 没有归属的条目（SW 发起的请求、旧版本落盘的记录）：哪个标签页都不算它
        eq(isFromTab({ url: 'u' }, 3), false, '没有 tabIds 时不属于任何标签页');
        eq(isFromTab({ url: 'u', tabIds: [] }, 3), false, '空数组同理');
        eq(isFromTab(null, 3), false, 'null 不该抛');
    });

    check('withoutTab：别的标签页也有它时只摘归属，不整条删', () => {
        const { withoutTab } = CONST;

        // 两个标签页共有 → 摘掉一个之后条目还在，且不再属于被摘的那个
        const shared = { url: 'u', tabIds: [3, 7] };
        const after = withoutTab(shared, 3);
        // 比 JSON 而不是 eq()：eq 用 `!==` 比，两个不同的数组永远不等 ——
        // 那样写出来的断言会无条件报红，而不是在判据坏掉时报红
        eq(JSON.stringify(after?.tabIds), JSON.stringify([7]), '3 号被摘掉，7 号还在');
        eq(after.url, 'u', '条目本身留着');
        assert(shared.tabIds.length === 2, '不能就地改原对象');

        // 只有它一个 → 整条丢掉。返回 null 是"删掉"的唯一信号
        eq(withoutTab({ url: 'u', tabIds: [3] }, 3), null, '没有别的标签页拥有它就该整条丢');

        // 本来就不拥有 → 原样返回**同一个引用**，调用方据此跳过写盘
        const other = { url: 'u', tabIds: [7] };
        assert(withoutTab(other, 3) === other,
            '不拥有时返回同一个引用 —— 调用方靠这个判据决定要不要写盘，'
            + '每次返回新对象会让列表每轮都被判成"变了"');

        // 没有归属的条目：摘不掉，也不该被摘
        const orphan = { url: 'u' };
        assert(withoutTab(orphan, 3) === orphan, '没有归属的条目不属于任何标签页');
    });

    /* ====================================================================== */
    /* 9. shared/core 的宿主无关性（service worker 能安全 import）              */
    /* ====================================================================== */
    check('shared/core 索引里没有碰宿主全局的模块', () => {
        /*
         * 这是整个 shared/ 分层存在的理由，必须被钉住。
         *
         * 插件 service worker **没有 DOM**：`document` / `window` / `localStorage`
         * 全都不存在。而 shared/core 会被 service worker import ——
         * 一旦某个模块在**求值期**（模块顶层，而非函数体内）碰这些全局，
         * service worker 装上就崩，且崩在模块顶层、没有任何指向性错误信息，
         * 表现为"插件整个没反应"。TypeScript 拦不住这种错（它只看类型）。
         *
         * 判据分两层：
         *  1. 索引文件本身不得导出已知需要 DOM 的模块（gallery 拖着 JSZip）；
         *  2. 被导出的每个模块，其**模块顶层**不得出现宿主全局。
         */
        const indexPath = path.join(ROOT, 'shared', 'core', 'index.ts');
        const indexSrc = fs.readFileSync(indexPath, 'utf8');
        assert(!/from '\.\/gallery'/.test(indexSrc),
            'shared/core/index.ts 导出了 gallery —— 它拖着 JSZip，会进 service worker bundle');

        // 取出索引导出的模块名，逐个检查它们的模块顶层
        const exported = [...indexSrc.matchAll(/^export \* from '\.\/([\w-]+)';/gm)].map((m) => m[1]);
        assert(exported.length >= 10, `索引导出的模块太少（${exported.length}），正则可能失配了`);

        const HOST_GLOBALS = /\b(localStorage|sessionStorage|document|window|navigator|FileReader|AudioContext)\b/;
        const offenders = [];
        for (const name of exported) {
            const file = path.join(ROOT, 'shared', 'core', `${name}.ts`);
            if (!fs.existsSync(file)) continue;
            const src = fs.readFileSync(file, 'utf8');
            /*
             * 只看**模块顶层**：从文件头到第一个函数/箭头函数体之前。
             * 简化判据：把「顶层语句」近似成"不缩进的行"（模块顶层的 import、
             * const 声明、export 都从第 0 列开始，而函数体内部一律有缩进）。
             * 这个近似对本仓库的排版成立，且失败方向是"报多了"而非"漏报"。
             */
            const topLevel = src.split('\n').filter((line) => /^[^\s]/.test(line)).join('\n');
            // import 行本身不算（类型导入会被擦除，值导入由打包器处理）
            const withoutImports = topLevel.split('\n')
                .filter((line) => !/^import\b/.test(line)).join('\n');
            const hit = withoutImports.match(HOST_GLOBALS);
            if (hit) offenders.push(`${name}.ts 的模块顶层出现 ${hit[1]}`);
        }
        eq(offenders.length, 0, offenders.join('；'));
    });

    check('shared/core 能在无 DOM 的沙箱里被完整求值', () => {
        /*
         * 上一条是文本判据（近似），这一条是**真跑**：
         * 把编译产物在一个屏蔽了 DOM 全局的沙箱里 require 一遍。
         * 文本判据可能因为排版变化误报，这一条不会 —— 它测的就是
         * "service worker 里 import 会不会当场炸"。
         *
         * 用 node:vm 造一个干净上下文：只给 CommonJS 需要的最小宿主
         * （module/exports/require），**不给** document/window/localStorage。
         * 任何模块顶层的宿主访问都会在这里抛 ReferenceError。
         */
        const vm = require('vm');
        const built = path.join(__dirname, 'build', 'shared', 'core', 'index.js');
        assert(fs.existsSync(built), '找不到 shared/core 的编译产物');

        const sandbox = { module: { exports: {} }, exports: {}, console, TextEncoder, TextDecoder, URL, atob, btoa };
        sandbox.exports = sandbox.module.exports;
        sandbox.require = (id) => {
            // 编译产物内部互相 require 时，继续在同一个沙箱里求值
            const resolved = require.resolve(id, { paths: [path.dirname(built)] });
            const code = fs.readFileSync(resolved, 'utf8');
            const sub = { module: { exports: {} }, exports: {}, console, TextEncoder, TextDecoder, URL, atob, btoa };
            sub.exports = sub.module.exports;
            sub.require = sandbox.require;
            vm.createContext(sub);
            vm.runInContext(code, sub, { filename: resolved });
            return sub.module.exports;
        };

        vm.createContext(sandbox);
        const code = fs.readFileSync(built, 'utf8');
        vm.runInContext(code, sandbox, { filename: built });

        const core = sandbox.module.exports;
        // 求值成功还不够：核心导出必须真的可用，否则"没崩"可能只是空模块
        assert(typeof core.getMediaType === 'function', '沙箱里拿不到 getMediaType');
        assert(typeof core.MEDIA_EXTENSIONS === 'object', '沙箱里拿不到 MEDIA_EXTENSIONS');
        assert(typeof core.buildCookieKeys === 'function', '沙箱里拿不到 buildCookieKeys');
        eq(core.getMediaType('https://a.com/x.m3u8', undefined, 'https://a.com/x.m3u8'), 'stream',
            '无 DOM 沙箱里 getMediaType 结论不对');
    });

    if (fails.length > 0) {
        console.log(`插件嗅探分类：通过 ${pass} 项，失败 ${fails.length} 项`);
        for (const f of fails) console.log(`  FAIL  ${f.name}\n        ${f.message}`);
        return false;
    }
    console.log(`插件嗅探分类：通过 ${pass} 项，失败 0 项`);
    return true;
};

module.exports = { run };

'use strict';
/**
 * 嗅探引擎回归。
 *
 * 被测的是**真实实现**，不是副本：
 *   1. 页内嗅探脚本（hooks/useBrowse.ts 的 IN_PAGE_INSPECTOR_SCRIPT）
 *      —— 把它求值出来，用假 DOM 跑一遍，断言分类与过滤结果；
 *   2. 文本兜底提取（extractLinksLocally）与共享判据（HLS_SEGMENT_RE_SOURCE /
 *      isHlsSegmentPath）—— 直接调编译产物；
 *   3. 主进程后缀表与分片判据 —— 读 electron/main.js 原文做一致性比对。
 *
 * 为什么页内脚本要真跑：它整体是一个模板字符串，插值（后缀表、分片正则源码）
 * 出错时**源码看起来完全正常** —— 只有求值才能发现"插值没替换"或
 * "反斜杠被模板吃掉"。实测过：源码写 `\d`、运行时变成裸 `d`，正则静默失效。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * 被测源码路径。
 *
 * 可用 BROWSE_SRC 覆盖 —— 变异测试靠它指向一份**改坏的副本**，
 * 从而在不碰产品文件的前提下验证断言真的能失败（与 agenttools 的 AGENT_SRC 同款）。
 */
const BROWSE_SRC = fs.readFileSync(
    process.env.BROWSE_SRC || path.join(ROOT, 'hooks', 'useBrowse.ts'), 'utf8');
const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
const AI_SRC = fs.readFileSync(path.join(ROOT, 'services', 'AiService.ts'), 'utf8');
const CONST = require('./build/const.js');

let pass = 0;
const fails = [];
const check = (name, fn) => {
    try { fn(); pass++; }
    catch (e) { fails.push({ name, message: e.message }); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };

/**
 * 把页内脚本求值成可调用的函数。
 *
 * **必须让模板字符串自己去求值**，不能拿源码文本手工 replace 插值 ——
 * 模板会吃掉一层反斜杠：源码里写 `\\.`，运行时才是 `\.`（正则里的字面点）。
 * 手工 replace 得到的是未转义的原文，求值后正则变成"反斜杠 + 任意字符"，
 * 于是所有后缀都匹配不上、全部落到 defaultType —— 看起来像产品坏了，
 * 实际是测试绕过了模板处理这一层。实测踩过这个坑。
 *
 * 做法：把模板原文塞进一个模板字面量里求值，插值的三个符号由参数提供。
 * 这样产品里的 `${JSON.stringify(...)}` 由引擎自己算，测试不复制这份逻辑。
 */
const loadInspector = () => {
    const start = BROWSE_SRC.indexOf('const IN_PAGE_INSPECTOR_SCRIPT = `');
    assert(start > 0, '找不到 IN_PAGE_INSPECTOR_SCRIPT');
    const bodyStart = start + 'const IN_PAGE_INSPECTOR_SCRIPT = `'.length;
    const bodyEnd = BROWSE_SRC.indexOf('\n`;', bodyStart);
    assert(bodyEnd > bodyStart, '找不到页内脚本的结尾反引号');
    const template = BROWSE_SRC.slice(bodyStart, bodyEnd);

    // 模板里若出现反引号或 `\${`，把它原样塞进模板字面量就会语法错乱。
    // 目前没有，将来加了必须显式失败，而不是抛一个看不懂的 SyntaxError。
    assert(!template.includes('`'), '页内脚本里出现了反引号，本测试的求值前提已不成立');
    assert(!template.includes('\\${'), '页内脚本里出现了转义的 ${，本测试的求值前提已不成立');

    // 后缀表：与产品同源（const.ts 的 MEDIA_EXTENSIONS 去掉 SNIFF_EXCLUDED_EXTS）
    const excluded = new Set(['aibook']);
    const CATEGORIES = { stream: [], video: [], audio: [], image: [], document: [], gallery: [], other: [] };
    for (const [ext, type] of Object.entries(CONST.MEDIA_EXTENSIONS)) {
        if (!excluded.has(ext)) CATEGORIES[type].push(ext);
    }

    const script = new Function(
        'CATEGORIES', 'HLS_SEGMENT_RE_SOURCE',
        `return \`${template}\`;`,
    )(CATEGORIES, CONST.HLS_SEGMENT_RE_SOURCE);

    assert(typeof script === 'string' && script.includes('getMediaInfo'),
        '页内脚本求值结果不像一段脚本');

    // 脚本整体是一个 IIFE 表达式。
    // **必须 trim**：模板串以换行开头，`return \n (() => {...})()` 会触发 ASI，
    // return 后面直接补分号、整个函数返回 undefined。
    const fn = new Function('document', 'window', 'URL', 'Set', 'RegExp', 'console', `return ${script.trim()};`);
    return (elements, href = 'https://s.test/page', iframes = []) => fn(
        {
            title: 'T',
            querySelectorAll: (sel) => {
                if (sel === 'video, audio') return elements;
                if (sel === 'iframe') return iframes;
                return [];
            },
        },
        { location: { href }, performance: { getEntriesByType: () => [] }, __playinfo__: null },
        URL, Set, RegExp, console,
    );
};

const inspect = loadInspector();

/** 造一个 <video>/<audio> 元素；tag 用**小写**，脚本里是 tagName.toLowerCase() */
const el = (src, tag = 'video', currentSrc = '') => ({
    tagName: tag, src, currentSrc, querySelectorAll: () => [],
});

/** 跑一次并返回 url -> { type, ext } 的映射 */
const classify = (elements, iframes = []) => {
    const out = new Map();
    for (const link of inspect(elements, 'https://s.test/page', iframes).links) {
        out.set(link.url, { type: link.type, ext: link.ext });
    }
    return out;
};

const run = () => {
    /* ====================================================================== */
    /* 1. 页内脚本：HLS 分片必须被丢掉                                        */
    /* ====================================================================== */

    check('页内脚本丢掉 HLS 分片（各种命名）', () => {
        const segments = [
            'https://s.test/a/seg1.ts',
            'https://s.test/a/seg00001.ts',
            'https://s.test/a/segment2.ts',
            'https://s.test/a/chunk_00001.ts',
            'https://s.test/a/000.ts',
            'https://s.test/a/1.ts',
            'https://s.test/a/x-1.ts',
            'https://s.test/ts/9.ts',
        ];
        const got = classify(segments.map((u) => el(u)));
        for (const u of segments) {
            assert(!got.has(u), `分片不该进列表：${u}`);
        }
    });

    /**
     * 整段的 .ts 视频**必须留下**。
     *
     * 这是分片判据最容易误伤的一类：判据一旦放宽成"任何 .ts 都算分片"，
     * 用户就再也嗅探不到整段 TS 视频了 —— 而它同样可下载。
     */
    check('页内脚本保留整段的 .ts 视频', () => {
        const full = [
            'https://s.test/video/2024/lecture.ts',   // 年份目录含两位以上数字
            'https://s.test/movie.ts',
            'https://s.test/download/show.ts',
        ];
        const got = classify(full.map((u) => el(u)));
        for (const u of full) {
            assert(got.has(u), `整段 .ts 不该被当成丢弃：${u}`);
            assert(got.get(u).type === 'stream', `${u} 应归 stream，实际 ${got.get(u).type}`);
            assert(got.get(u).ext === 'ts', `${u} 的后缀应为 ts，实际 ${got.get(u).ext}`);
        }
    });

    check('页内脚本认出普通媒体与流媒体', () => {
        const got = classify([
            el('https://s.test/index.m3u8'),
            el('https://s.test/movie.mp4'),
            el('https://s.test/song.mp3', 'audio'),
            el('https://s.test/pic.avif'),
        ]);
        assert(got.get('https://s.test/index.m3u8').type === 'stream', 'm3u8 应归 stream');
        assert(got.get('https://s.test/movie.mp4').type === 'video', 'mp4 应归 video');
        assert(got.get('https://s.test/song.mp3').type === 'audio', 'mp3 应归 audio');
        assert(got.get('https://s.test/pic.avif').type === 'image', 'avif 应归 image');
    });

    /**
     * 后缀必须**成词**匹配。
     *
     * 早先在整条 URL 上用裸 includes('.ts') / ('.mpd')：`component.tsx` 含 `.ts`、
     * `backup.mpd2` 含 `.mpd`，源码与备份文件全被当成流媒体收进列表。
     *
     * 用 iframe 造样本而不是 <video>：`<video src>` 的标签兜底会把任何地址
     * 都归成 video，从而掩盖"后缀认错"这个问题 —— 要测的正是"认不出后缀时
     * 该不该收"，所以走**没有标签兜底**的那条路径。
     */
    check('页内脚本不把 component.tsx / backup.mpd2 当成媒体', () => {
        const got = classify([], [
            { src: 'https://s.test/app.js?component.tsx' },
            { src: 'https://s.test/x?backup.mpd2' },
            { src: 'https://s.test/y?notes.txt' },
        ]);
        assert(!got.has('https://s.test/app.js?component.tsx'), 'component.tsx 不该被当成 .ts');
        assert(!got.has('https://s.test/x?backup.mpd2'), 'backup.mpd2 不该被当成 .mpd');
        assert(!got.has('https://s.test/y?notes.txt'), 'notes.txt 不是媒体');
    });

    check('页内脚本从 query 参数里认出媒体（后缀与类型同步）', () => {
        const got = classify([
            el('https://s.test/play?file=movie.mpd'),
            el('https://s.test/play?file=movie.mp4'),
            el('https://s.test/play?url=a%2Fb.m3u8&t=1'),
        ]);
        const mpd = got.get('https://s.test/play?file=movie.mpd');
        assert(mpd && mpd.type === 'stream', '?file=movie.mpd 应归 stream');
        // 后缀必须是**真实的那个**：写死 m3u8 会让下载命名与 ffmpeg 判定都用错
        assert(mpd.ext === 'mpd', `?file=movie.mpd 的后缀应为 mpd，实际 ${mpd.ext}`);

        const mp4 = got.get('https://s.test/play?file=movie.mp4');
        assert(mp4 && mp4.type === 'video' && mp4.ext === 'mp4', '?file=movie.mp4 应归 video/mp4');

        const m3u8 = got.get('https://s.test/play?url=a%2Fb.m3u8&t=1');
        assert(m3u8 && m3u8.type === 'stream' && m3u8.ext === 'm3u8', '编码过的 .m3u8 应归 stream/m3u8');
    });

    /* ====================================================================== */
    /* 2. 共享判据                                                            */
    /* ====================================================================== */

    check('isHlsSegmentPath 与页内脚本同判据', () => {
        for (const p of ['/a/seg1.ts', '/a/000.ts', '/ts/9.ts', '/a/x-1.ts', '/a/chunk_2.ts']) {
            assert(CONST.isHlsSegmentPath(p), `${p} 应判为分片`);
        }
        for (const p of ['/video/2024/lecture.ts', '/movie.ts', '/a/b.m3u8', '/a/seg.mp4']) {
            assert(!CONST.isHlsSegmentPath(p), `${p} 不该判为分片`);
        }
        assert(!CONST.isHlsSegmentPath(''), '空路径不该判为分片');
    });

    check('HLS_SEGMENT_RE_SOURCE 不含会破坏模板插值的字符', () => {
        // 源码要经 JSON.stringify 插进模板字符串，反斜杠会被模板吃一层；
        // 真正的保障是它**只含双反斜杠转义**（JSON.stringify 出来仍是合法正则源码）。
        const re = new RegExp(CONST.HLS_SEGMENT_RE_SOURCE, 'i');
        assert(re.test('/a/seg1.ts'), '插值后的正则源码应当可用');
        assert(CONST.HLS_SEGMENT_RE_SOURCE.includes('\\d'), '源码里应保留 \\d 转义');
    });

    /* ====================================================================== */
    /* 3. 主进程侧一致性                                                       */
    /* ====================================================================== */

    /**
     * 主进程的后缀分类必须与 const.ts 一致。
     *
     * 主进程不能 import const.ts（TS），后缀表是派生副本；副本漂移的后果是
     * 同一个地址两条路径两个结论。这里比对**两边都有**的后缀。
     */
    check('主进程后缀分类与 const.ts 同源', () => {
        const grabList = (name) => {
            const i = MAIN_SRC.indexOf(`const ${name} = [`);
            assert(i > 0, `main.js 里找不到 ${name}`);
            const j = MAIN_SRC.indexOf('];', i);
            return (MAIN_SRC.slice(i, j).match(/'([a-z0-9]+)'/g) || []).map((s) => s.slice(1, -1));
        };

        const pairs = [['streamExts', 'stream'], ['videoExts', 'video'],
            ['audioExts', 'audio'], ['imageExts', 'image']];
        for (const [name, type] of pairs) {
            for (const ext of grabList(name)) {
                const expected = CONST.MEDIA_EXTENSIONS[ext];
                if (!expected) continue;   // 主进程刻意只列媒体后缀，缺项不算漂移
                assert(expected === type,
                    `${ext} 分类漂移：const.ts=${expected} main.js=${type}`);
            }
        }
    });

    /**
     * 主进程的分片正则必须与 const.ts 的 HLS_SEGMENT_RE_SOURCE **逐字同源**。
     *
     * 两边各写一份的话，页内丢分片、网络层不丢（或反之）——
     * 表现为"列表里还是刷满了 segNNN.ts"。
     */
    check('主进程分片正则与 const.ts 同源', () => {
        const start = MAIN_SRC.indexOf('const hlsSegmentRe = new RegExp(');
        assert(start > 0, 'main.js 里找不到 hlsSegmentRe');
        const end = MAIN_SRC.indexOf("'i'", start);
        assert(end > start, '找不到 hlsSegmentRe 的结尾');
        const literal = MAIN_SRC.slice(start, end);

        // 逐条比对四个分支的源码文本（去掉引号与拼接符后比对片段）
        const parts = CONST.HLS_SEGMENT_RE_SOURCE.split('|');
        for (const part of parts) {
            // 主进程源码里是 JS 字符串字面量，反斜杠写成 \\
            const asLiteral = part.replace(/\\/g, '\\\\');
            assert(literal.includes(asLiteral),
                `主进程分片正则缺少分支：${part}\n（const.ts 改了源码而 main.js 没跟上）`);
        }
    });

    /**
     * 下载判定：渲染层标为 stream 的资源，主进程必须走 ffmpeg。
     *
     * 只看后缀会漏 —— AI 提取出的地址常常没有可辨识后缀（/api/play?format=hls），
     * ext 回落成 mp4，但渲染层已按 type='stream' 打了 ffmpeg 徽章。
     * 两边不一致时落盘的 .mp4 里装的是 m3u8 文本，播放器打开是黑的。
     */
    check('下载走 ffmpeg 的判定同时看后缀与 type', () => {
        const start = MAIN_SRC.indexOf('const isStream = STREAM_EXTENSIONS.has(ext)');
        assert(start > 0, '找不到 isStream 的判定');
        const line = MAIN_SRC.slice(start, MAIN_SRC.indexOf('\n', start));
        assert(/payload\?\.type === 'stream'/.test(line),
            'isStream 没看渲染层给的 type —— 无后缀的 HLS 会被裸 HTTP 直存');
    });

    check('流媒体下载一律落成 .mp4', () => {
        const start = MAIN_SRC.indexOf('const targetPath = resolveDownloadTarget(title, isStream');
        assert(start > 0, '找不到 targetPath 的构造');
        const line = MAIN_SRC.slice(start, MAIN_SRC.indexOf('\n', start));
        assert(/isStream \? 'mp4' : ext/.test(line),
            '流媒体没有按 mp4 落盘 —— 按源后缀命名（.ts/.m3u8）系统认不出类型');
    });

    /**
     * 'unknown' 是占位符不是后缀。
     *
     * 嗅探的页内脚本与 AI 提取在认不出后缀时都会显式写 'unknown'；
     * inferExtension 照单全收会落出 `标题.unknown`。
     */
    check('inferExtension 不把 unknown 当后缀', () => {
        const start = MAIN_SRC.indexOf('function inferExtension(url, ext)');
        assert(start > 0, '找不到 inferExtension');
        const body = MAIN_SRC.slice(start, MAIN_SRC.indexOf('\n}', start));
        assert(/hinted !== 'unknown'/.test(body),
            "inferExtension 没有排除 'unknown' —— 会落出 标题.unknown");
    });

    /**
     * MIME 子类型不能直接当后缀。
     *
     * video/x-matroska 的子类型是 `x-matroska`、audio/x-mpeg 是 `x-mpeg`，
     * 照搬会产出系统认不出的后缀（真实后缀分别是 mkv / mp3）。
     */
    check('MIME 子类型映射到规范后缀', () => {
        // 两张表声明在函数**之前**，只切函数体会漏掉它们 —— 从表声明处开始切
        const start = MAIN_SRC.indexOf('const VIDEO_MIME_EXTS = {');
        assert(start > 0, '找不到 VIDEO_MIME_EXTS');
        const end = MAIN_SRC.indexOf('function canonicalExtFromMime', start);
        assert(end > start, '找不到 canonicalExtFromMime');
        const body = MAIN_SRC.slice(start, MAIN_SRC.indexOf('\n}', end));

        assert(/'x-matroska': 'mkv'/.test(body), 'x-matroska 应映射到 mkv');
        assert(/'x-mpeg': 'mp3'/.test(body), 'x-mpeg 应映射到 mp3');
        assert(/'quicktime': 'mov'/.test(body), 'quicktime 应映射到 mov');
        assert(/'x-msvideo': 'avi'/.test(body), 'x-msvideo 应映射到 avi');
        // 两张表：ogg 在 video 下是 ogv、audio 下是 ogg，合成一张必错一个
        assert(/'ogg': 'ogv'/.test(body), 'video/ogg 应映射到 ogv');
        assert(/'ogg': 'ogg'/.test(body), 'audio/ogg 应映射到 ogg');
        assert(/AUDIO_MIME_EXTS/.test(MAIN_SRC), '缺少 AUDIO_MIME_EXTS');
        // 取表要按主类型分流，不能写死一张
        assert(/startsWith\('audio\/'\) \? AUDIO_MIME_EXTS : VIDEO_MIME_EXTS/.test(body),
            'canonicalExtFromMime 没有按 audio/video 分流取表');
    });

    /**
     * mp2t 必须归一成 stream/'ts'。
     *
     * 早先照搬 content-type 的字面量得到 ext='mp2t'，而 const.ts 表里只有 'ts' ——
     * 同一个地址网络层判 video、页内判 stream，筛选栏与 ffmpeg 判定全跟着错。
     */
    check('主进程把 video/mp2t 归一成 stream/ts', () => {
        const start = MAIN_SRC.indexOf("contentType.includes('mp2t')");
        assert(start > 0, '找不到 mp2t 分支');
        const body = MAIN_SRC.slice(start, start + 600);
        assert(/detectedType = 'stream'/.test(body), 'mp2t 应判成 stream');
        assert(/ext = 'ts'/.test(body), "mp2t 的后缀应归一为 'ts'（const.ts 表里只有 ts）");
    });

    /**
     * 分片过滤的门必须覆盖"CDN 把分片标成 application/octet-stream"。
     *
     * 只开 ext/contentType 两道门时，那种响应既不是 video/mp2t 也进不了
     * streamExts 分支，整页 segNNN.ts 会被全量推给渲染层。
     */
    check('主进程分片过滤认路径后缀（不依赖响应头）', () => {
        const start = MAIN_SRC.indexOf('// 过滤 TS 切片分段');
        assert(start > 0, '找不到分片过滤段');
        const body = MAIN_SRC.slice(start, MAIN_SRC.indexOf('\n        }', start));
        assert(/pathExt === 'ts'/.test(body),
            "分片过滤没有看 pathExt —— octet-stream 的 HLS 分片会漏进来刷满列表");
        assert(/hlsSegmentRe\.test\(pathname\)/.test(body), '分片过滤没有用路径正则');
    });

    /* ====================================================================== */
    /* 4. AI 提取与筛选栏                                                     */
    /* ====================================================================== */

    /**
     * AI 提取只收 http(s)。
     *
     * blob: 是页面自己内存的句柄，跨不过进程边界 —— 主进程下载器按它请求只会失败，
     * 播放器也不在页面那个源上。页内脚本与网络层都各自拦了它，唯独这条路径放行过。
     */
    check('AI 提取不接受 blob: 地址', () => {
        const start = AI_SRC.indexOf('export const extractMediaLinks');
        assert(start > 0, '找不到 extractMediaLinks');
        const body = AI_SRC.slice(start, AI_SRC.indexOf('\n};', start));
        assert(!/\|\s*blob:/.test(body),
            'extractMediaLinks 仍接受 blob: —— 收进来的条目两个按钮都点不动');
        assert(/\^https\?:\\\/\\\/\$?/i.test(body) || /https\?:\\\/\\\//.test(body),
            'extractMediaLinks 没有限制为 http(s)');
    });

    /**
     * AI 提取的后缀只能从**最后一个路径段**里取。
     *
     * `pathPart.split('.').pop()` 在路径无点时返回整个末段，
     * `/stream/abc123` 会得到 ext='abc123' —— 落盘文件叫 `标题.abc123`。
     */
    check('AI 提取的后缀不会把路径末段当扩展名', () => {
        const start = AI_SRC.indexOf('export const extractMediaLinks');
        const body = AI_SRC.slice(start, AI_SRC.indexOf('\n};', start));

        // 断言前先剥掉注释行：说明"早先用过 split('.').pop()"的注释本身含那个串，
        // 不剥就会把注释当成代码 —— 一条永远失败、且失败原因看不懂的断言。
        const code = body.split('\n')
            .filter((line) => {
                const t = line.trim();
                return !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('//');
            })
            .join('\n');

        assert(!code.includes("pathPart.split('.').pop()"),
            "extractMediaLinks 仍用 split('.').pop() 取后缀（无点路径会整段当后缀）");
        assert(code.includes("lastIndexOf('.')"), '后缀应从最后一个路径段的点号处切');
        assert(/dot > 0/.test(code), '点号在首位（.hidden）不该算后缀');
    });

    /**
     * 筛选栏与落盘校验必须读**同一份**清单。
     *
     * 两份必然漂移：落盘校验放行 CATEGORIES 的全部键（含 gallery/other），
     * 而界面只有固定的几项 —— 手改成 'gallery' 能通过校验，
     * 界面上却没有那个按钮，表现为"列表空了却看不出为什么"。
     *
     * **不断言清单里有哪些类型**：document 要不要进筛选栏是待定的产品决定，
     * 测试不该把一个未定的产品选择固化成断言。这里只锁"同源"这一件事。
     */
    check('筛选栏与落盘校验同源', () => {
        assert(/export const SNIFF_FILTER_OPTIONS/.test(BROWSE_SRC),
            'useBrowse 没有导出 SNIFF_FILTER_OPTIONS（唯一真值）');
        assert(/SNIFF_FILTER_OPTIONS\.map\(\(option\) => option\.value\)/.test(BROWSE_SRC),
            'filterType 的落盘校验没有走筛选栏那份清单');

        // 界面那份必须来自 hook，不能再写一份字面量
        const floatingSrc = fs.readFileSync(path.join(ROOT, 'components', 'Floating.tsx'), 'utf8');
        assert(/const SNIFF_FILTERS = SNIFF_FILTER_OPTIONS;/.test(floatingSrc),
            'Floating 又自己写了一份筛选清单（两份必然漂移）');

        // 校验不能退回"放行 CATEGORIES 全部键"：那会允许界面上没有的筛选态
        assert(!/\['all', \.\.\.Object\.keys\(CATEGORIES\)\]/.test(BROWSE_SRC),
            '落盘校验退回用 CATEGORIES 全部键 —— 会放行界面上没有的筛选态');
    });

    /* ====================================================================== */
    /* 5. 下载判据三方同源                                                     */
    /* ====================================================================== */

    /**
     * requiresFfmpeg 必须取或：type 与 ext 各自补对方的漏。
     *
     * 只看 type 会漏 `{"url":"...x.flv","type":"video"}`（模型给的类型与后缀不自洽）；
     * 只看 ext 会漏 `/api/play?format=hls`（没有可辨识后缀，ext 回落 mp4）。
     */
    check('requiresFfmpeg 同时看 type 与后缀', () => {
        const f = CONST.requiresFfmpeg;
        assert(typeof f === 'function', 'const.ts 没有导出 requiresFfmpeg');

        assert(f('stream', 'mp4'), 'type=stream 就该走 ffmpeg（哪怕后缀像普通视频）');
        assert(f('video', 'flv'), 'ext=flv 就该走 ffmpeg（哪怕模型说它是 video）');
        assert(f('video', 'm3u8'), 'ext=m3u8 就该走 ffmpeg');
        assert(f('stream', 'unknown'), 'type=stream 且后缀未知，仍要走 ffmpeg');

        assert(!f('video', 'mp4'), '普通 mp4 不该走 ffmpeg');
        assert(!f('audio', 'mp3'), '普通 mp3 不该走 ffmpeg');
        assert(!f('image', 'png'), '图片不该走 ffmpeg');
        assert(!f(undefined, undefined), '两样都没有时不该走 ffmpeg');
    });

    check('requiresFfmpeg 的后缀表就是 const.ts 的 stream 类', () => {
        for (const [ext, type] of Object.entries(CONST.MEDIA_EXTENSIONS)) {
            const expected = type === 'stream';
            assert(CONST.requiresFfmpeg('video', ext) === expected,
                `${ext} 的 ffmpeg 判定与 MEDIA_EXTENSIONS 不一致（表里是 ${type}）`);
        }
    });

    /**
     * 三方同源：主进程 / 下载逻辑 / 面板按钮必须用同一个判据。
     *
     * 实测事故：面板按 `link.type === 'stream'` 判、主进程按后缀判 ——
     * 一个 .flv 条目（type=video）在 ffmpeg 缺失时按钮照常可点，
     * 点下去才报"未找到 ffmpeg"。
     */
    check('下载判据三方同源（主进程 / useBrowse / 面板）', () => {
        const floatingSrc = fs.readFileSync(path.join(ROOT, 'components', 'Floating.tsx'), 'utf8');

        // 面板：按钮禁用与徽章都走 requiresFfmpeg，不能再写 type === 'stream'
        assert(/const needsFfmpeg = requiresFfmpeg\(link\.type, link\.ext\)/.test(floatingSrc),
            '面板的下载可用性没有走 requiresFfmpeg');
        assert(!/const canDownload = link\.type !== 'stream'/.test(floatingSrc),
            "面板仍按 link.type !== 'stream' 判 —— ext=flv/type=video 会漏");
        assert(!/\{link\.type === 'stream' && \(/.test(floatingSrc),
            '面板的 ffmpeg 徽章仍按 type 判 —— 与按钮、与主进程不一致');

        // useBrowse：拦截与文案同样走 requiresFfmpeg
        assert(/requiresFfmpeg\(link\.type, link\.ext\) && !downloadCapabilities\.ffmpegAvailable/.test(BROWSE_SRC),
            'useBrowse 的 download 没有用 requiresFfmpeg 拦截');
        assert(/requiresFfmpeg\(link\.type, link\.ext\) \? '正在使用 ffmpeg/.test(BROWSE_SRC),
            'useBrowse 的下载文案没有用 requiresFfmpeg');

        // 主进程：两半都要在（与 const.ts 同判据的派生副本）
        const start = MAIN_SRC.indexOf('const isStream = STREAM_EXTENSIONS.has(ext)');
        assert(start > 0, '找不到主进程的 isStream');
        const line = MAIN_SRC.slice(start, MAIN_SRC.indexOf('\n', start));
        assert(/STREAM_EXTENSIONS\.has\(ext\)/.test(line), '主进程 isStream 少了后缀那一半');
        assert(/payload\?\.type === 'stream'/.test(line), '主进程 isStream 少了 type 那一半');
    });

    /**
     * isGenericTitle：新增与更新两条路径共用的标题判据。
     *
     * 这个函数的意义全在"两条路径共用"上 —— 各写一份时，
     * 标题为文件名的条目永远升不了级（更新那份只看 Media_ 前缀）。
     */
    check('isGenericTitle 认出没信息量的标题', () => {
        const g = CONST.isGenericTitle;
        assert(typeof g === 'function', 'const.ts 没有导出 isGenericTitle');

        for (const t of ['Media_stream', 'media_123', 'index.m3u8', 'playlist.m3u8',
            'stream.mp4', 'chunk_1.ts', 'hls_720', 'detected', '', undefined, null]) {
            assert(g(t), `${JSON.stringify(t)} 应判为通用标题`);
        }
        // 纯哈希 / 纯数字文件名（剥掉扩展名后再判）
        assert(g('a1b2c3d4e5f60718293a4b5c6d7e8f90'), '32 位哈希应判为通用');
        assert(g('a1b2c3d4e5f60718.mp4'), '哈希+扩展名应判为通用');
        assert(g('20240115.mp4'), '纯数字文件名应判为通用');

        for (const t of ['【合集】某部电影 1080p', 'My Holiday Video.mp4', '第 3 集']) {
            assert(!g(t), `${JSON.stringify(t)} 不该判为通用（有信息量）`);
        }
        // 边界：短哈希不算（16 位以下可能是真标题），数字不足 8 位同理
        assert(!g('abc123.mp4'), '短文件名不该判为通用');
        assert(!g('2024.mp4'), '4 位数字不该判为通用');
    });

    /**
     * 标题升级：只在"旧的没信息量、新的有"时替换。
     *
     * 这条锁的是 addLinks 里的**更新分支**——变异校验发现它原先没有覆盖。
     */
    check('标题升级判据要求新标题有信息量', () => {
        const start = BROWSE_SRC.indexOf('const addLinks = useCallback');
        assert(start > 0, '找不到 addLinks');
        const body = BROWSE_SRC.slice(start, BROWSE_SRC.indexOf('}, []);', start));

        assert(/isGenericTitle\(existing\.title\)/.test(body),
            '更新分支没有用 isGenericTitle 判旧标题（只看 Media_ 前缀会让 index.m3u8 永远升不了级）');
        assert(/!isGenericTitle\(item\.title\)/.test(body),
            '更新分支没有要求新标题有信息量 —— 两个都通用时会来回替换');
        assert(!/existing\.title\.startsWith\('Media_'\)/.test(body),
            '更新分支退回只看 Media_ 前缀');
        // 新增分支也要用同一个判据，否则两条路径又各判一份
        assert(/if \(isGenericTitle\(enhancedTitle\)/.test(body),
            '新增分支没有用 isGenericTitle');
    });

    return fails.length === 0;
};

module.exports = {
    run: async () => {
        const ok = run();
        console.log(`嗅探引擎：通过 ${pass} 项，失败 ${fails.length} 项`);
        for (const f of fails) console.log(`  ✗ ${f.name}: ${f.message}`);
        return ok;
    },
};

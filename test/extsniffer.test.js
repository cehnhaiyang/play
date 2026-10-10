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
    const CONST = require('./build/const.js');
    const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');

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

    check('分片正则与 const.ts 的源码字符串一致', () => {
        // 插件用 const.ts 的源码字符串构造正则，main.js 是逐字复制的一份。
        // 这里确认插件侧真的用了共享源码（不是自己又写了一遍）。
        const src = fs.readFileSync(
            path.join(ROOT, 'extension', 'src', 'shared', 'classify.ts'), 'utf8');
        assert(src.includes('HLS_SEGMENT_RE_SOURCE'), 'classify.ts 必须 import 共享的分片正则源码');
        assert(!/\(\?:\^\|\/\)\(?:segment\|seg\|chunk/.test(src),
            'classify.ts 自己抄了一份分片正则 —— 应该 import const.ts 的那份');
        assert(typeof CONST.HLS_SEGMENT_RE_SOURCE === 'string', 'const.ts 应导出正则源码字符串');
    });

    /* ====================================================================== */
    /* 8. 与 const.ts 的判据同口径                                              */
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

    if (fails.length > 0) {
        console.log(`插件嗅探分类：通过 ${pass} 项，失败 ${fails.length} 项`);
        for (const f of fails) console.log(`  FAIL  ${f.name}\n        ${f.message}`);
        return false;
    }
    console.log(`插件嗅探分类：通过 ${pass} 项，失败 0 项`);
    return true;
};

module.exports = { run };

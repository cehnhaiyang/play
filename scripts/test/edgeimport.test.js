'use strict';
/**
 * Edge 导入与书签树的回归测试。
 *
 * 覆盖五块，每一块对应一类**不会报错、只会静默出错**的失败：
 *
 *   1. **书签树纯操作**（services/BookmarkService）—— 拖拽把文件夹移进自己的
 *      子树，会让整棵子树从书签里消失且不可撤销。这是本套件里最要紧的一条。
 *
 *   2. **Edge 数据解析**（electron/edgeImportService 的纯函数）—— WebKit 时间戳
 *      是 1601 年起的**微秒**且超过 2^53；算错的表现是"历史里的时间全是 1601 年"，
 *      不报错、不崩溃。
 *
 *   3. **扁平 → 树的迁移** —— 老用户升级后书签还在不在。迁移写错的表现是
 *      "升级完书签没了"，而单元测试之外几乎发现不了。
 *
 *   4. **导入合并去重** —— 重复导入两次应该幂等。写错的表现是书签翻倍。
 *
 *   5. **Cookie 离线解密**（electron/abeCrypto.js + edgeImportService 的
 *      readCookiesOffline/unwrapMasterKey）—— 密钥拿错、AAD 弄错、前缀切错，
 *      表现都是"导入成功但登录态不对"，GCM 认证是唯一的硬判据。
 *
 * 两边都用**产品代码本身**：判据在 services/BookmarkService（TS，编译产物），
 * 解析、解密与接线在 electron/edgeImportService.js 与 electron/abeCrypto.js
 *（JS，直接 require）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

let pass = 0;
const fails = [];
// 在途的异步断言：与 search.test.js 同一模式 —— check 只管注册，
// runAsync 统一 await 后再统计，否则异步断言抛错只会变成
// unhandledRejection，用例照样计入 pass（曾经的 search.test 教训）。
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
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };
const eq = (a, b, msg) => {
    if (a !== b) throw new Error(`${msg || '不相等'}：实际 ${JSON.stringify(a)}，预期 ${JSON.stringify(b)}`);
};

/** 稳定的 id 生成器，让断言可复现 */
const idGen = () => {
    let n = 0;
    return () => `id-${++n}`;
};

const run = () => {
    const edge = require(path.join(ROOT, 'electron', 'edgeImportService.js'));
    const bm = require('./build/services/BookmarkService');

    /* ====================================================================== */
    /* 1. 书签树纯操作                                                         */
    /* ====================================================================== */

    check('moveNode：把文件夹移进自己的子树必须被拒绝', () => {
        // 这是本套件最重要的一条：朴素的"先摘下来再插进去"会把 parent
        // 连同它自己的子树一起挂到自己下面，结果是整块从书签里消失。
        //
        // 断言方式说明：变异测试里把 isDescendant 这道闸拿掉（M1）时，
        // 测试**仍然全绿** —— 因为 moveNode 里还有第二道闸：detach 之后
        // insertNode 找不到 target（target 是 located.node 的子孙，而 located.node
        // 已经被摘出树了），于是原样返回。两道闸互为冗余，去掉任一道行为都不变。
        //
        // 所以这里不去假装"杀掉"那个变异体，而是**把冗余本身断言下来**：
        // 结构必须完全没动。这样万一将来两道闸被同时改坏，这条会红。
        const tree = {
            bar: bm.makeFolder('bar', '收藏夹栏'),
            other: bm.makeFolder('other', '其他收藏夹'),
        };
        const parent = bm.makeFolder('P', '父文件夹');
        const child = bm.makeFolder('C', '子文件夹');
        const leaf = bm.makeUrlNode('L', 'https://a.com', 'A');
        child.children = [leaf];
        parent.children = [child];
        tree.bar.children = [parent];

        const moved = bm.moveNode(tree, 'P', 'C');
        assert(moved === tree, '移动到自己的子孙下必须原样返回（引用相等），实际产生了新树');

        // 结构必须逐层不动：这是"两道闸都失效"时才会红的那条
        assert(!bm.findNode(child, 'P'), 'child 里不该出现 parent（那是环）');
        eq(bm.nodeDepth(moved.bar, 'P'), 1, 'parent 应仍在第 1 层');
        eq(bm.nodeDepth(moved.bar, 'C'), 2, 'child 应仍在第 2 层');
        eq(bm.nodeDepth(moved.bar, 'L'), 3, 'leaf 应仍在第 3 层');
        eq(bm.countNodes(moved.bar), 3, '节点总数必须是 3（多一个就是环）');
    });

    check('moveNode：移到自己下面也要被拒绝', () => {
        const tree = { bar: bm.makeFolder('bar', '栏'), other: bm.makeFolder('other', '其他') };
        const f = bm.makeFolder('F', 'F');
        tree.bar.children = [f];
        assert(bm.moveNode(tree, 'F', 'F') === tree, '移动到自身必须被拒绝');
    });

    check('moveNode：正常移动确实改变了结构', () => {
        const tree = { bar: bm.makeFolder('bar', '栏'), other: bm.makeFolder('other', '其他') };
        const src = bm.makeFolder('S', '源');
        const dst = bm.makeFolder('D', '目标');
        const leaf = bm.makeUrlNode('L', 'https://a.com', 'A');
        src.children = [leaf];
        tree.bar.children = [src, dst];

        const moved = bm.moveNode(tree, 'L', 'D');
        assert(moved !== tree, '正常移动必须产生新树');
        assert(!bm.findNode(moved.bar, 'S').children.length, '源文件夹里应该已经没有了');
        assert(bm.findNode(moved.bar, 'D').children.length === 1, '目标文件夹里应该有 1 项');
        assert(bm.findNode(moved.bar, 'L'), '叶子节点必须还在');
    });

    check('moveNode：目标不是文件夹时拒绝', () => {
        const tree = { bar: bm.makeFolder('bar', '栏'), other: bm.makeFolder('other', '其他') };
        const leaf = bm.makeUrlNode('L', 'https://a.com', 'A');
        const other = bm.makeUrlNode('M', 'https://b.com', 'B');
        tree.bar.children = [leaf, other];
        assert(bm.moveNode(tree, 'L', 'M') === tree, '往 url 节点里塞东西必须被拒绝');
    });

    check('moveNode：不存在的 id 不改变树', () => {
        const tree = { bar: bm.makeFolder('bar', '栏'), other: bm.makeFolder('other', '其他') };
        assert(bm.moveNode(tree, 'nope', 'bar') === tree, '源不存在必须原样返回');
        assert(bm.moveNode(tree, 'bar', 'nope') === tree, '目标不存在必须原样返回');
    });

    check('replaceNode：只重建路径上的节点（未走到的分支保持引用）', () => {
        const tree = { bar: bm.makeFolder('bar', '栏'), other: bm.makeFolder('other', '其他') };
        const a = bm.makeFolder('A', 'A');
        const b = bm.makeFolder('B', 'B');
        a.children = [bm.makeUrlNode('L', 'https://a.com', 'A')];
        b.children = [bm.makeUrlNode('M', 'https://b.com', 'B')];
        tree.bar.children = [a, b];

        const next = bm.replaceNode(tree.bar, 'L', (node) => ({ ...node, title: '改了' }));
        assert(next !== tree.bar, '根应该被重建');
        assert(next.children[1] === b, '没走到的分支必须保持同一引用（否则 memo 白做）');
        assert(next.children[0] !== a, '走到的分支应该被重建');
    });

    check('removeNode：删掉不存在的 id 返回原树', () => {
        const tree = { bar: bm.makeFolder('bar', '栏'), other: bm.makeFolder('other', '其他') };
        tree.bar.children = [bm.makeUrlNode('L', 'https://a.com', 'A')];
        assert(bm.removeNode(tree.bar, 'nope') === tree.bar, '删不存在的节点不该产生新引用');
    });

    check('removeNode：删除文件夹连带整棵子树', () => {
        // 管理器里"删除此文件夹"走的就是这条：文件夹本身必须能删掉，不能只删里面的条目
        const tree = { bar: bm.makeFolder('bar', '栏'), other: bm.makeFolder('other', '其他') };
        const sub = bm.makeFolder('F', '工具');
        sub.children = [bm.makeUrlNode('L', 'https://a.com', 'A')];
        tree.bar.children = [sub, bm.makeUrlNode('M', 'https://b.com', 'B')];
        const next = bm.removeNode(tree.bar, 'F');
        eq(next.children.length, 1, '文件夹整块消失');
        eq(next.children[0].id, 'M', '旁边的书签不受影响');
        assert(bm.findNode(next, 'L') === null, '子树里的叶子也一起走');
    });

    check('isDescendant：含自身', () => {
        const tree = { bar: bm.makeFolder('bar', '栏'), other: bm.makeFolder('other', '其他') };
        const p = bm.makeFolder('P', 'P');
        const c = bm.makeFolder('C', 'C');
        p.children = [c];
        tree.bar.children = [p];
        assert(bm.isDescendant(p, 'P'), '自身算自己的后代（这是"不能拖进自己"的判据）');
        assert(bm.isDescendant(p, 'C'), '子节点算后代');
        assert(!bm.isDescendant(c, 'P'), '父节点不是子节点的后代');
    });

    check('insertNode：越界下标被夹到合法区间', () => {
        // **必须用多元素数组**：单元素时 splice(-1) 与 splice(0) 结果相同，
        // 断言不出"负下标有没有被夹到 0"。变异测试里这条正是因此漏网的（M8）。
        const root = bm.makeFolder('bar', '栏');
        root.children = [
            bm.makeUrlNode('A', 'https://a.com', 'A'),
            bm.makeUrlNode('B', 'https://b.com', 'B'),
            bm.makeUrlNode('C', 'https://c.com', 'C'),
        ];

        const withBig = bm.insertNode(root, 'bar', bm.makeUrlNode('X', 'https://x.com', 'X'), 999);
        eq(withBig.children.map((c) => c.id).join(','), 'A,B,C,X', '越界下标应追加到末尾');

        // 负下标夹到 0（插到最前）。不夹的话原生 splice 会从**末尾倒数** ——
        // 一个"看起来差不多"的错位，正是最难发现的那种。
        //
        // 这里必须用 -1 而不是 -5：在 3 元素数组上 splice(-5) 与 splice(0)
        // 结果相同（都夹到 0），用它根本区分不出有没有夹取。
        const withNeg = bm.insertNode(root, 'bar', bm.makeUrlNode('X', 'https://x.com', 'X'), -1);
        eq(withNeg.children.map((c) => c.id).join(','), 'X,A,B,C', '负下标应插到最前，而不是倒数第二');

        // 省略 index 才是追加
        const withNone = bm.insertNode(root, 'bar', bm.makeUrlNode('X', 'https://x.com', 'X'));
        eq(withNone.children.map((c) => c.id).join(','), 'A,B,C,X', '省略 index 时追加到末尾');

        // 正常下标按语义插入
        const withMid = bm.insertNode(root, 'bar', bm.makeUrlNode('X', 'https://x.com', 'X'), 1);
        eq(withMid.children.map((c) => c.id).join(','), 'A,X,B,C', '下标 1 应插到第 2 位');

        // 原树不能被改动（不可变语义）
        eq(root.children.length, 3, '原树必须保持不变');
    });

    /* ====================================================================== */
    /* 2. Edge 解析纯函数                                                      */
    /* ====================================================================== */

    check('webkitMicrosToMs：1601 年起的微秒 → Unix 毫秒', () => {
        // 实测值：Edge 里 "2026-06-23" 的 date_added
        const ms = edge.webkitMicrosToMs('13426657176474389');
        const year = new Date(ms).getUTCFullYear();
        assert(year >= 2025 && year <= 2027, `年份应该在 2025-2027，实际 ${year}`);
    });

    check('webkitMicrosToMs：非法输入返回 0 而不是 NaN', () => {
        // NaN 会一路传到界面变成 "Invalid Date"
        for (const bad of [null, undefined, '', 'abc', 0, -1, {}, 'NaN']) {
            const out = edge.webkitMicrosToMs(bad);
            eq(out, 0, `输入 ${JSON.stringify(bad)} 应返回 0`);
            assert(Number.isFinite(out), '必须是有限数');
        }
    });

    check('webkitMicrosToMs：超过 2^53 的值不丢精度（按字符串处理）', () => {
        const big = '13426657176474389';
        assert(Number(big) > Number.MAX_SAFE_INTEGER, '这个值本来就该超过 2^53，否则这条断言没意义');
        const ms = edge.webkitMicrosToMs(big);
        assert(ms > 0 && Number.isFinite(ms), '必须算得出有限的正数');
    });

    check('parseEdgeBookmarks：树结构、文件夹层级与 extras', () => {
        const raw = {
            roots: {
                bookmark_bar: {
                    type: 'folder', name: '收藏夹栏', guid: 'BAR', date_added: '13426657176474389',
                    children: [
                        { type: 'url', name: 'A', url: 'https://a.com', guid: 'A1', date_added: '13426657176474389' },
                        {
                            type: 'folder', name: '工具', guid: 'F1', date_added: '13426657176474389',
                            children: [{ type: 'url', name: 'B', url: 'https://b.com', guid: 'B1', date_added: '0' }],
                        },
                    ],
                },
                other: { type: 'folder', name: '其他收藏夹', guid: 'OTHER', children: [] },
                synced: { type: 'folder', name: '移动收藏夹', guid: 'SYNC', children: [
                    { type: 'url', name: 'C', url: 'https://c.com', guid: 'C1' },
                ] },
                workspaces_v2: { type: 'folder', name: '工作区', guid: 'WS', children: [] },
            },
        };

        const tree = edge.parseEdgeBookmarks(raw);
        eq(tree.bar.title, '收藏夹栏', '栏标题');
        eq(tree.bar.children.length, 2, '栏下 2 项');
        eq(tree.bar.children[1].type, 'folder', '第二项是文件夹');
        eq(tree.bar.children[1].title, '工具', '文件夹名');
        eq(tree.bar.children[1].children.length, 1, '文件夹里有 1 项');
        eq(tree.bar.children[1].children[0].url, 'https://b.com', '文件夹里的 url');

        // extras：非空的其它根必须带回来，空的（工作区）不要
        eq(tree.extras.length, 1, 'extras 只收非空的根');
        eq(tree.extras[0].title, '移动收藏夹', 'extras 的名字');
    });

    check('parseEdgeBookmarks：坏节点被丢弃但不影响其它节点', () => {
        const tree = edge.parseEdgeBookmarks({
            roots: {
                bookmark_bar: {
                    type: 'folder', name: '栏', guid: 'BAR',
                    children: [
                        { type: 'url', name: '好的', url: 'https://ok.com', guid: 'OK' },
                        { type: 'url', name: '没有 url', guid: 'X1' },          // 丢
                        null,                                                    // 丢
                        { type: 'unknown', name: '未知类型', guid: 'X2' },       // 丢
                        { type: 'url', url: 'https://noname.com', guid: 'X3' },  // 保（title 用 url 兜底）
                    ],
                },
            },
        });
        eq(tree.bar.children.length, 2, '只应保留 2 条有效节点');
        eq(tree.bar.children[1].title, 'https://noname.com', '缺 title 时用 url 兜底');
    });

    check('parseEdgeBookmarks：完全空的输入也能给出两个根', () => {
        const tree = edge.parseEdgeBookmarks(null);
        eq(tree.bar.type, 'folder', 'bar 必须是文件夹');
        eq(tree.other.type, 'folder', 'other 必须是文件夹');
        assert(Array.isArray(tree.bar.children), 'children 必须是数组');
        eq(tree.extras.length, 0, '没有 extras');
    });

    check('parseEdgeBookmarks：空文件夹被保住（不被当成空而丢弃）', () => {
        const tree = edge.parseEdgeBookmarks({
            roots: { bookmark_bar: { type: 'folder', name: '栏', guid: 'BAR', children: [
                { type: 'folder', name: '空文件夹', guid: 'E1', children: [] },
            ] } },
        });
        eq(tree.bar.children.length, 1, '空文件夹必须保留');
        eq(tree.bar.children[0].children.length, 0, '里面确实是空的');
    });

    check('flattenBookmarkNodes：带上文件夹路径', () => {
        const node = {
            id: 'R', type: 'folder', title: '根', children: [
                { id: 'A', type: 'url', title: 'A', url: 'https://a.com' },
                { id: 'F', type: 'folder', title: '工具', children: [
                    { id: 'B', type: 'url', title: 'B', url: 'https://b.com' },
                ] },
            ],
        };
        const flat = edge.flattenBookmarkNodes(node);
        eq(flat.length, 2, '两个 url');
        eq(flat[0].folderPath.length, 0, '第一层没有路径');
        eq(flat[1].folderPath.length, 1, '第二层有 1 级路径');
        eq(flat[1].folderPath[0], '工具', '路径内容是文件夹名');
    });

    check('countBookmarkNodes：文件夹与网址都算', () => {
        const node = { id: 'R', type: 'folder', title: '根', children: [
            { id: 'A', type: 'url', url: 'https://a.com' },
            { id: 'F', type: 'folder', title: 'F', children: [
                { id: 'B', type: 'url', url: 'https://b.com' },
            ] },
        ] };
        eq(edge.countBookmarkNodes(node), 3, '1 url + 1 folder + 1 url = 3');
        eq(edge.countBookmarkNodes(null), 0, 'null 是 0');
    });

    /* ====================================================================== */
    /* 3. Favicon                                                             */
    /* ====================================================================== */

    check('faviconScore：偏好 32×32', () => {
        assert(edge.faviconScore({ width: 32 }) > edge.faviconScore({ width: 16 }), '32 优于 16');
        assert(edge.faviconScore({ width: 32 }) > edge.faviconScore({ width: 128 }), '32 优于 128');
        assert(edge.faviconScore({ width: 16 }) > edge.faviconScore({ width: 128 }), '16 优于 128');
    });

    check('detectImageMime：认出 PNG / ICO / JPEG', () => {
        eq(edge.detectImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'image/png', 'PNG');
        eq(edge.detectImageMime(Buffer.from([0x00, 0x00, 0x01, 0x00])), 'image/x-icon', 'ICO');
        eq(edge.detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg', 'JPEG');
        eq(edge.detectImageMime(Buffer.from([0x00, 0x01, 0x02, 0x03])), '', '认不出的返回空串');
        eq(edge.detectImageMime(Buffer.alloc(0)), '', '空 buffer 返回空串');
    });

    check('selectFavicons：同一页面挑最高分的图', () => {
        // 两张图的**格式不同**，这样才分得清选中的是哪一张。
        // 只用"都是 PNG dataURL"来断言的话，"取第一张"和"取最高分"都能过 ——
        // 变异测试里这条正是漏网的（M29）。
        const big128 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);          // JPEG，128px
        const small32 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);          // PNG，32px
        const rows = [
            { page_url: 'https://a.com', image_data: big128, width: 128 },   // 先出现，但分低
            { page_url: 'https://a.com', image_data: small32, width: 32 },
        ];
        const out = edge.selectFavicons(rows);
        eq(out.size, 1, '同一页面只留一张');
        assert(out.get('https://a.com').startsWith('data:image/png;base64,'),
            '必须选 32×32 那张（PNG），而不是先出现的 128×128（JPEG）');
    });

    check('selectFavicons：与顺序无关（32 在前也在后都选 32）', () => {
        const big128 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]);
        const small32 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]);
        const reversed = edge.selectFavicons([
            { page_url: 'https://b.com', image_data: small32, width: 32 },
            { page_url: 'https://b.com', image_data: big128, width: 128 },
        ]);
        assert(reversed.get('https://b.com').startsWith('data:image/png;base64,'), '顺序换了结果不变');
    });

    check('selectFavicons：超过单图上限的被丢弃', () => {
        const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(edge.FAVICON_MAX_BYTES + 10)]);
        const out = edge.selectFavicons([{ page_url: 'https://big.com', image_data: big, width: 32 }]);
        eq(out.size, 0, '超大图必须被丢弃（否则撑爆 localStorage 配额）');
    });

    check('selectFavicons：总量超预算后不再收，但不影响已收的', () => {
        // 每张约 5.5KB 的 dataURL，预算 320KB → 大约 58 张
        const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(4000, 7)]);
        const rows = [];
        for (let i = 0; i < 200; i += 1) {
            rows.push({ page_url: `https://s${i}.com`, image_data: png, width: 32 });
        }
        const out = edge.selectFavicons(rows);
        assert(out.size > 0, '至少要收下一些');
        assert(out.size < 200, '预算必须真的起作用（不能全收）');
    });

    check('selectFavicons：认不出格式的图被跳过', () => {
        const junk = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
        const out = edge.selectFavicons([{ page_url: 'https://x.com', image_data: junk, width: 32 }]);
        eq(out.size, 0, '认不出 MIME 就不收');
    });

    check('attachFavicons：先精确匹配，再退到 origin', () => {
        const tree = { id: 'R', type: 'folder', title: 'R', children: [
            { id: 'A', type: 'url', title: 'A', url: 'https://a.com/page?x=1' },
            { id: 'B', type: 'url', title: 'B', url: 'https://b.com/deep/path' },
            { id: 'C', type: 'url', title: 'C', url: 'not a url' },
        ] };
        const icons = new Map([
            ['https://a.com/page?x=1', 'data:image/png;base64,AAA'],
            ['https://b.com', 'data:image/png;base64,BBB'],
        ]);
        edge.attachFavicons(tree, icons);
        eq(tree.children[0].icon, 'data:image/png;base64,AAA', '精确匹配');
        eq(tree.children[1].icon, 'data:image/png;base64,BBB', 'origin 回退');
        eq(tree.children[2].icon, undefined, '非法 URL 不该崩，也不该配图标');
    });

    /* ====================================================================== */
    /* 4. Cookie 归一化                                                        */
    /* ====================================================================== */

    check('normalizeSqliteCookie：会话 cookie 不写 expirationDate', () => {
        // has_expires 为假表示会话 cookie —— 即使 expires_utc 里残留着一个
        // 很大的旧时间戳（Chromium 真会这样存），也不能写 expirationDate。
        // 若原样传给 Electron，会被当成过期，cookie 直接消失 —— 沿用旧
        // normalizeCdpCookie 时踩过的同一个坑（expires: -1 那条）。
        const out = edge.normalizeSqliteCookie(
            { host_key: '.a.com', name: 'a', path: '/', has_expires: 0, expires_utc: '13300000000000000' }, '1');
        eq(out.expirationDate, undefined, '会话 cookie 不能带过期时间');
        eq(out.url, 'http://a.com/', 'url 照拼');
    });

    check('normalizeSqliteCookie：持久 cookie 的 WebKit 微秒正确换算成秒', () => {
        // 13300000000000000 微秒 → 13300000000000 毫秒 → 减 11644473600000 →
        // 1655526400000 毫秒 → 1655526400 秒。列是 CAST 过的 TEXT，直接 Number。
        const out = edge.normalizeSqliteCookie(
            { host_key: 'a.com', name: 'a', path: '/x', has_expires: 1, expires_utc: '13300000000000000', is_secure: 1 }, 'v');
        eq(out.expirationDate, 1655526400, '微秒→毫秒→秒，向下取整');
        eq(out.url, 'https://a.com/x', 'secure 走 https');
    });

    check('normalizeSqliteCookie：sameSite 数字映射到 Electron 的取值', () => {
        // Chromium 存的是数字枚举：2=Strict，1=Lax，0=None，-1=未指定。
        const map = (s) => edge.normalizeSqliteCookie({ host_key: 'a.com', name: 'a', samesite: s }, 'v').sameSite;
        eq(map(2), 'strict', '2=Strict');
        eq(map(1), 'lax', '1=Lax');
        eq(map(0), 'no_restriction', '0=None');
        eq(map(-1), 'unspecified', '-1=未指定');
        eq(map(99), 'unspecified', '未知值回落');
        eq(map(undefined), 'unspecified', '缺列回落');
    });

    check('normalizeSqliteCookie：缺 host_key/name 的行被丢弃', () => {
        eq(edge.normalizeSqliteCookie({ name: 'a' }, 'v'), null, '缺 host_key');
        eq(edge.normalizeSqliteCookie({ host_key: 'a.com' }, 'v'), null, '缺 name');
        eq(edge.normalizeSqliteCookie(null, 'v'), null, 'null');
    });

    check('buildCookieUrl：去掉域名前导点，否则不是合法 URL', () => {
        // https://.example.com 不是合法 URL，Electron 会拒绝这条 cookie
        eq(edge.buildCookieUrl({ domain: '.example.com', path: '/', secure: true }), 'https://example.com/', '前导点必须去掉');
        eq(edge.buildCookieUrl({ domain: 'a.com', path: '/x', secure: false }), 'http://a.com/x', '非 secure 用 http');
        eq(edge.buildCookieUrl({ domain: 'a.com', secure: true }), 'https://a.com/', '缺 path 用 /');
    });

    check('离线解密不动 msedge.exe：CDP 调用必须彻底删除', () => {
        /**
         * 回归测试。用户要求不启动 Edge。旧的 readCookiesViaCdp 会
         * spawn msedge.exe（--headless=new + 调试端口）—— 必须彻底删除，
         * 不只是"不再调用"：留着就是下一次误用的入口。
         */
        const src = fs.readFileSync(path.join(ROOT, 'electron', 'edgeImportService.js'), 'utf8');

        for (const banned of ['readCookiesViaCdp', 'remote-debugging-port',
            'Storage.getCookies', 'DevToolsActivePort', 'webSocketDebuggerUrl',
            'cdp-profile', '--restore-last-session']) {
            assert(!src.includes(banned), `源码里不应再出现 ${banned}`);
        }

        assert(/async function readCookiesOffline/.test(src), '必须有 readCookiesOffline');
        assert(/async function unwrapMasterKey/.test(src), '必须有 unwrapMasterKey');
        // Cookies 表走 openSqliteCopy（复制到临时目录再只读打开），与历史/账号同模式
        const start = src.indexOf('async function readCookiesOffline');
        const body = src.slice(start, start + 6000);
        assert(body.includes("'Network', 'Cookies'") || body.includes('"Network", "Cookies"'),
            'readCookiesOffline 必须读 profile 下的 Network/Cookies');
    });

    check('unwrapMasterKey：必须先验提权，未提权不得启动解密助手', () => {
        // SYSTEM 令牌要 SeDebugPrivilege，非管理员跑解密助手只会得到一堆
        // ACCESS_DENIED，还弹一次 powershell 黑框 —— 必须在进程内先拦。
        const src = fs.readFileSync(path.join(ROOT, 'electron', 'edgeImportService.js'), 'utf8');
        const start = src.indexOf('async function unwrapMasterKey');
        assert(start > 0, '找不到 unwrapMasterKey');
        const body = src.slice(start, start + 4000);
        const checkAt = body.indexOf('isProcessElevated');
        const spawnAt = body.indexOf("spawnSync('powershell.exe'");
        assert(checkAt > 0, 'unwrapMasterKey 必须验提权');
        assert(spawnAt > 0, '找不到 powershell 启动点');
        assert(checkAt < spawnAt, '验提权必须在启动 powershell 之前');
    });

    check('解密助手：必须先做本机 DPAPI 自举，再碰模拟令牌', () => {
        // 实测教训：进程内第一次 DPAPI 调用若发生在模拟令牌下，
        // 之后所有模拟态调用都报 gle=127 且状态不可恢复（Stage 0 测出）。
        // 先以自己身份跑一遍 roundtrip 做自举，后面的模拟调用才正常。
        // 这条盯的是"自举被当成多余代码删掉/挪到枚举后面"的改法。
        const src = fs.readFileSync(path.join(ROOT, 'electron', 'edgeImportService.js'), 'utf8');
        const runAt = src.indexOf('public static string Run(');
        assert(runAt > 0, '找不到 C# 的 Run');
        const body = src.slice(runAt, runAt + 12000);
        const primeAt = body.indexOf('SELF-PRIME');
        const enumAt = body.indexOf('CreateToolhelp32Snapshot');
        assert(primeAt > 0, 'Run 里必须有 SELF-PRIME 自举');
        assert(enumAt > 0, '找不到令牌枚举');
        assert(primeAt < enumAt, '自举必须在令牌枚举之前');
        assert(/if\s*\(!Roundtrip\(\)\)\s*\{\s*log\.AppendLine\("ERR=PRIME_FAIL"\)/.test(body),
            '自举失败必须报 ERR=PRIME_FAIL，而不是带着坏状态往下走');
        // 上面两条只盯注释不够：变异测试证实过，把 `if (!Roundtrip())` 整行
        // 挪到枚举后面、注释留在原地，注释检查照样通过。所以这里按**代码行**
        // 本身定位 —— 自举代码必须在枚举之前。
        const primeCodeAt = body.indexOf('if (!Roundtrip())');
        assert(primeCodeAt > 0, '找不到自举代码行');
        assert(primeCodeAt < enumAt, '自举代码行必须在令牌枚举之前（注释不算数）');
    });

    check('导入前必须先杀掉 Edge 后台进程，且在所有读取之前', () => {
        /**
         * 回归测试。Edge 关掉窗口后仍有一批后台进程常驻（主进程带
         * `--no-startup-window`，实测 9 个），持有整份 profile 里多个 SQLite 的锁
         * —— Cookies、History、Web Data、Login Data 都受影响。
         *
         * 所以 killEdgeProcesses 必须在**任何**读取之前调用，而不是只挡在
         * Cookie 那一段前面：只挡 Cookie 的话，历史/自动填充/账号仍会在被锁的
         * 库上读，表现是"有的项导进来了、有的莫名其妙是空的"。
         */
        const src = fs.readFileSync(path.join(ROOT, 'electron', 'edgeImportService.js'), 'utf8');

        assert(/async function killEdgeProcesses/.test(src), '必须有 killEdgeProcesses');
        assert(/'\/IM',\s*'msedge\.exe',\s*'\/T',\s*'\/F'/.test(src),
            "必须用 taskkill /IM msedge.exe /T /F —— /T 连子进程一起杀，漏了渲染进程锁还在");

        const fnStart = src.indexOf('async function importEdgeData');
        assert(fnStart > 0, '找不到 importEdgeData');
        const body = src.slice(fnStart);

        const killAt = body.indexOf('await killEdgeProcesses');
        assert(killAt > 0, 'importEdgeData 里必须调用 killEdgeProcesses');

        // 必须早于每一个读取动作
        for (const reader of ['readBookmarksFromProfile(', 'readFaviconsFromProfile(',
            'readHistoryFromProfile(', 'readAutofillFromProfile(',
            'readAccountsFromProfile(', 'readCookiesOffline(']) {
            const at = body.indexOf(reader);
            assert(at > 0, `importEdgeData 里应该调用 ${reader}`);
            assert(killAt < at, `${reader} 之前必须先杀 Edge —— 否则它读的是被锁的库`);
        }

        // 杀掉之后要等锁真正释放，不能立刻往下走
        assert(/EDGE_KILL_TIMEOUT_MS/.test(src), '必须有等待锁释放的超时上限');
        assert(/isCookiesLocked\(userDataDir, profileId\)/.test(src),
            '等锁释放要用 isCookiesLocked 轮询，而不是固定 sleep');
    });

    /* ====================================================================== */
    /* 5. ABE 离线解密（electron/abeCrypto.js，直接 require）                  */
    /* ====================================================================== */

    // 固定夹具（一次生成、硬编码，测试必须确定性 —— 禁止在用例里随机）：
    // BLOB3/CNG/MASTER 自洽（xor(CNG, mask)==MASTER，内层明文即 MASTER）；
    // BLOB1 是 flag 1 形状；BLOB0 是 Edge 154 实测的 flag 0（32 字节即密钥）；
    // COOKIE/COOKIE_EMPTY 用 MASTER 加密（前缀 + 值 / 纯前缀）。
    const abe = require(path.join(ROOT, 'electron', 'abeCrypto.js'));
    const U = (hex) => new Uint8Array(Buffer.from(hex, 'hex'));
    const FIX = {
        BLOB3: '22000000303220433a5c50726f6772616d2046696c65735c4d6963726f736f66745c456467655d00000003aabbccddeeff00112233445566778899aabbccddeeff001122334455667788990102030405060708090a0b0c7a632793ac42c3366261117aa032f1ed738f81c473a48034a40b5e1480eacbb7539467e58b1923ac32f79164e116c17e',
        CNG: 'cce983fd813363cfd9ecf801d6f0e8e303b3bca3631ad48b7d020e0c90e4cd6f',
        MASTER: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
        BLOB1: '04000000303220583d000000010c0b0a0908070605040302012983bcbd7ec887a3017fde4d1f9883ee567c94e29cc5a15d8a21589259f262505e0617728efcebd2315b39804bbcb642',
        PT1: 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100',
        BLOB0: '0400000030322059200000001234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        RAWKEY: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        COOKIE: '763230a0a1a2a3a4a5a6a7a8a9aaab0099cac39ee18313519187a6b1443f151e6b43583267edf05b4b396169ad5024c51b3c45787e5f3b8acff0059d10ef54ed8a42fbe39adb61e40c84349266b0615f81a004',
        VALUE: 'session-token-abc123',
        COOKIE_EMPTY: '763230b0b1b2b3b4b5b6b7b8b9babb90deedef596c6396ce99ab6acfd40ad0a6588177deb2d52f77fc44ee89304519911b4ebdcfce27914f0b1939758c834d',
    };

    check('abe：flag 0（Edge 154 实测形状）直接给出 32 字节主密钥', async () => {
        // 本机实测：key blob 的 content 就是密钥本身，没有内层加密。
        // 若将来有人把这里改成"一律走 flag 3"，这条会红 —— 那正是要拦的。
        const parsed = abe.parseKeyBlob(U(FIX.BLOB0));
        eq(parsed.flag, 0, 'flag');
        const key = await abe.deriveMasterKey(parsed, null);
        eq(Buffer.from(key).toString('hex'), FIX.RAWKEY, '主密钥');
    });

    check('abe：flag 3（XOR + AES-GCM）派生主密钥', async () => {
        const parsed = abe.parseKeyBlob(U(FIX.BLOB3));
        eq(parsed.flag, 3, 'flag');
        eq(parsed.encryptedAesKey.length, 32, 'encAesKey 长度');
        const key = await abe.deriveMasterKey(parsed, U(FIX.CNG));
        eq(Buffer.from(key).toString('hex'), FIX.MASTER, '主密钥');
    });

    check('abe：flag 1（内置 AES 密钥）派生主密钥', async () => {
        const parsed = abe.parseKeyBlob(U(FIX.BLOB1));
        eq(parsed.flag, 1, 'flag');
        const key = await abe.deriveMasterKey(parsed, null);
        eq(Buffer.from(key).toString('hex'), FIX.PT1, '主密钥');
    });

    check('abe：v20 cookie 解密 + 32 字节前缀切分', async () => {
        const pt = await abe.decryptV20Cookie(U(FIX.MASTER), U(FIX.COOKIE));
        const parts = abe.splitCookiePlaintext(pt);
        eq(abe.decodeCookieValue(parts.valueBytes), FIX.VALUE, '真值');
        assert(abe.looksLikeRandomPrefix(parts.prefix), '前缀应该是随机量');
    });

    check('abe：空值 cookie（明文恰好 32 字节）导成空串，不丢弃', async () => {
        // 真实库里有 11 条这种（GCM 照样认证通过）。空值是合法值，
        // 丢弃等于静默丢数据 —— 必须导成空串。
        const pt = await abe.decryptV20Cookie(U(FIX.MASTER), U(FIX.COOKIE_EMPTY));
        const parts = abe.splitCookiePlaintext(pt);
        eq(abe.decodeCookieValue(parts.valueBytes), '', '空值');
    });

    check('abe：错密钥必须 GCM 认证失败，而不是解出乱码', async () => {
        // GCM 的 tag 是 128 位：密钥错了"恰好解出合法 UTF-8"的概率可忽略。
        // 这条盯的是"有人把 tag 校验关了/改成 try-catch 吞掉"的改法。
        const wrong = Buffer.from(FIX.MASTER, 'hex');
        wrong[0] ^= 1;
        let rejected = false;
        try {
            await abe.decryptV20Cookie(U(wrong.toString('hex')), U(FIX.COOKIE));
        } catch (_e) {
            rejected = true;
        }
        assert(rejected, '错密钥必须抛错');
    });

    check('abe：坏输入必须抛错（flag/长度/前缀/base64）', () => {
        // key blob 长度字段对不上
        let badFlag = false;
        try {
            abe.parseKeyBlob(U('01000000780d000000020909'));
        } catch (_e) {
            badFlag = true;
        }
        assert(badFlag, '非法 flag 必须抛错');
        // v20 前缀不对
        let badPrefix = false;
        try {
            abe.stripAppbPrefix(Buffer.from('DPAPIq3k=').toString('base64'));
        } catch (_e) {
            badPrefix = true;
        }
        assert(badPrefix, '缺 APPB 前缀必须抛错');
        // 不是 base64
        let badB64 = false;
        try {
            abe.stripAppbPrefix('@@@not-base64@@@');
        } catch (_e) {
            badB64 = true;
        }
        assert(badB64, '非法 base64 必须抛错');
    });

    check('readCookiesOffline：Local State 缺 APPB 时明说，不抛错', async () => {
        // elevation 无关：Local State 读不到在 unwrap 之前就返回了。
        // 这条保证"Edge 装了但 Local State 损坏/缺失"时用户看到的是人话，
        // 而不是一条 powershell 报错。
        const r = await edge.readCookiesOffline({
            userDataDir: path.join(ROOT, 'scripts', 'test', 'no-such-dir'),
            profileDir: path.join(ROOT, 'scripts', 'test', 'no-such-dir'),
            tempDb: path.join(ROOT, 'scripts', 'test'),
            tempRoot: path.join(ROOT, 'scripts', 'test'),
            warnings: [],
            report: null,
        });
        assert(Array.isArray(r.cookies) && r.cookies.length === 0, 'cookies 应为空数组');
        assert(typeof r.error === 'string' && r.error.includes('APPB'), `错误必须提到 APPB，实际：${r.error}`);
    });

    check('unwrapMasterKey：解不出密钥时必须抛错，不返回空密钥', async () => {
        // 非管理员：必须在进程内直接拦下，连 powershell 都不起 ——
        // 若提权检查被删/短路（变异 M5），这里会变成助手跑完后的
        // UNWRAP_FAIL 文案，照样抛错但信息不对，必须能区分。
        // 空密钥流进 GCM 等于全库"认证失败"，绝不能发生。
        let msg = '';
        try {
            await edge.unwrapMasterKey({ primaryB64: '', fallbackB64: '', workDir: __dirname, report: null });
        } catch (e) {
            msg = e.message;
        }
        if (!edge.isProcessElevated()) {
            assert(/管理员权限/.test(msg), `非管理员必须报权限问题，实际：${msg}`);
        } else {
            assert(/管理员权限|APPB|解密/.test(msg), `错误信息必须可操作，实际：${msg}`);
        }
    });

    check('账号读取：用户名是明文，必须能导；密码不碰', () => {
        const src = fs.readFileSync(path.join(ROOT, 'electron', 'edgeImportService.js'), 'utf8');
        assert(/function readAccountsFromProfile/.test(src), '必须有 readAccountsFromProfile');

        const start = src.indexOf('function readAccountsFromProfile');
        const end = src.indexOf('/** 读默认搜索引擎', start);
        const body = src.slice(start, end > 0 ? end : start + 2500);

        assert(body.includes('username_value'), '要从 logins.username_value 取用户名');
        assert(!/password_value/.test(body), '绝不能读 password_value —— v20 解不开，读了也是密文');
        assert(body.includes('blacklisted_by_user = 0'),
            '用户在 Edge 里选了「从不保存」的行不能导进来，那是明确的选择');
    });

    /* ====================================================================== */
    /* 5. profile 解析                                                         */
    /* ====================================================================== */

    check('profilesFromLocalState：Default 排最前，其余按数字序', () => {
        const list = edge.profilesFromLocalState({
            profile: { info_cache: {
                'Profile 10': { name: '十' },
                'Default': { name: '您的 Chrome' },
                'Profile 2': { name: '二' },
                'Guest Profile': { name: '访客' },       // 必须排除
                'System Profile': { name: '系统' },      // 必须排除
            } },
        }, 'C:\\UD');

        const ids = list.map((p) => p.id);
        eq(ids[0], 'Default', 'Default 必须排最前');
        assert(!ids.includes('Guest Profile'), '访客配置不是用户配置');
        assert(!ids.includes('System Profile'), '系统配置不是用户配置');
        // Profile 2 必须排在 Profile 10 前面（数字序，不是字典序）
        assert(ids.indexOf('Profile 2') < ids.indexOf('Profile 10'), 'Profile 2 应排在 Profile 10 前');
    });

    check('profilesFromLocalState：Local State 坏了也要给出 Default', () => {
        const list = edge.profilesFromLocalState(null, 'C:\\UD');
        eq(list.length, 1, '至少一个 profile');
        eq(list[0].id, 'Default', '回落 Default');
        eq(list[0].name, 'Default', '没有名字时用 id 当名字');
    });

    check('profilesFromLocalState：名字缺失时回落目录名', () => {
        const list = edge.profilesFromLocalState({ profile: { info_cache: { Default: {} } } }, 'C:\\UD');
        eq(list[0].name, 'Default', '缺 name 用 id');
        assert(list[0].dir.endsWith('Default'), 'dir 应以 profile id 结尾');
    });

    /* ====================================================================== */
    /* 6. 选项归一化与错误翻译                                                  */
    /* ====================================================================== */

    check('normalizeImportOptions：默认全开、上限有值', () => {
        const opts = edge.normalizeImportOptions(undefined);
        eq(opts.profileId, 'Default', '默认 profile');
        eq(opts.include.bookmarks, true, '默认导入书签');
        eq(opts.include.cookies, true, '默认导入 cookie');
        eq(opts.historyLimit, edge.HISTORY_LIMIT, '默认历史上限');
    });

    check('normalizeImportOptions：显式 false 能关掉单项', () => {
        const opts = edge.normalizeImportOptions({ include: { cookies: false, history: false } });
        eq(opts.include.cookies, false, 'cookie 应被关掉');
        eq(opts.include.history, false, '历史应被关掉');
        eq(opts.include.bookmarks, true, '未提到的项保持默认开');
    });

    check('normalizeImportOptions：负数上限被夹到 0', () => {
        eq(edge.normalizeImportOptions({ historyLimit: -5 }).historyLimit, 0, '负数夹到 0');
        eq(edge.normalizeImportOptions({ historyLimit: 12.7 }).historyLimit, 12, '小数向下取整');
    });

    check('describeSqliteError：锁定给出可操作提示', () => {
        const msg = edge.describeSqliteError('LOCKED');
        assert(msg.includes('退出'), `锁定提示必须告诉用户怎么办，实际：${msg}`);
    });

    check('edgeExecutableCandidates：覆盖 x86 与 x64 两个 Program Files', () => {
        const list = edge.edgeExecutableCandidates({ app: ['Microsoft', 'Edge', 'Application'] });
        assert(list.length >= 2, '至少两个候选路径');
        assert(list.every((p) => p.endsWith('msedge.exe')), '都应以 msedge.exe 结尾');
    });

    /* ====================================================================== */
    /* 7. 扁平 → 树迁移                                                        */
    /* ====================================================================== */

    check('migrateFlatBookmarks：老数据全部平铺进收藏夹栏，顺序不变', () => {
        const flat = [
            { id: '1', title: 'Google', url: 'https://www.google.com', createdAt: 100 },
            { id: '2', title: 'Bing', url: 'https://www.bing.com', createdAt: 200 },
        ];
        const tree = bm.migrateFlatBookmarks(flat, idGen());
        eq(tree.bar.children.length, 2, '两条都迁移过来');
        eq(tree.bar.children[0].title, 'Google', '顺序必须保持');
        eq(tree.bar.children[0].type, 'url', '迁移后是 url 节点');
        eq(tree.other.children.length, 0, '其他收藏夹是空的');
    });

    check('migrateFlatBookmarks：坏条目丢弃但不影响好的', () => {
        const flat = [
            { id: '1', title: '好', url: 'https://ok.com' },
            null,
            { id: '2', title: '没 url' },
            { id: '3', title: '也好', url: 'https://ok2.com' },
        ];
        const tree = bm.migrateFlatBookmarks(flat, idGen());
        eq(tree.bar.children.length, 2, '只保留两条有效');
    });

    check('migrateFlatBookmarks：非数组输入给出空树而不是崩', () => {
        for (const bad of [null, undefined, 'x', 42, {}]) {
            const tree = bm.migrateFlatBookmarks(bad, idGen());
            eq(tree.bar.children.length, 0, `输入 ${JSON.stringify(bad)} 应给出空树`);
            eq(tree.bar.type, 'folder', '根必须是文件夹');
        }
    });

    check('normalizeTree：两个根都不是 folder 时补空文件夹', () => {
        const tree = bm.normalizeTree({ bar: { type: 'url', url: 'https://x.com' }, other: null }, idGen());
        eq(tree.bar.type, 'folder', 'bar 被修正为文件夹');
        eq(tree.other.type, 'folder', 'other 被补成文件夹');
    });

    check('normalizeNode：title 缺失时用 url 兜底（界面取首字当图标）', () => {
        const node = bm.normalizeNode({ type: 'url', url: 'https://a.com' }, idGen());
        eq(node.title, 'https://a.com', '缺 title 必须补上，否则书签栏会留下一条没有文字的条目');
    });

    check('normalizeNode：非法 createdAt 归零而不是 NaN', () => {
        const node = bm.normalizeNode({ type: 'url', url: 'https://a.com', createdAt: 'abc' }, idGen());
        eq(node.createdAt, 0, 'NaN 会一路传到界面变成 Invalid Date');
    });

    /* ====================================================================== */
    /* 8. 导入合并与去重                                                       */
    /* ====================================================================== */

    check('mergeIntoFolder：按 URL 去重', () => {
        const folder = bm.makeFolder('bar', '栏');
        folder.children = [bm.makeUrlNode('existing', 'https://dup.com', '已有')];
        const seen = new Set(['https://dup.com']);

        const incoming = [
            bm.makeUrlNode('n1', 'https://dup.com', '重复'),
            bm.makeUrlNode('n2', 'https://new.com', '新的'),
        ];
        const { folder: merged, stats } = bm.mergeIntoFolder(folder, incoming, seen, idGen());
        eq(stats.added, 1, '只加 1 条');
        eq(stats.skipped, 1, '跳过 1 条');
        eq(merged.children.length, 2, '总数为 2');
    });

    check('mergeIntoFolder：导入的节点换上新 id（不与本地 id 空间冲突）', () => {
        const folder = bm.makeFolder('bar', '栏');
        const incoming = [bm.makeUrlNode('edge-guid-xxx', 'https://a.com', 'A')];
        const { folder: merged } = bm.mergeIntoFolder(folder, incoming, new Set(), idGen());
        assert(merged.children[0].id !== 'edge-guid-xxx', '必须换 id，否则与本地 id 撞车');
        assert(merged.children[0].id.startsWith('id-'), '用的是注入的 id 生成器');
    });

    check('mergeIntoFolder：文件夹整块进来，内部 id 也被重写', () => {
        const folder = bm.makeFolder('bar', '栏');
        const sub = bm.makeFolder('edge-folder', '工具');
        sub.children = [bm.makeUrlNode('edge-leaf', 'https://a.com', 'A')];

        const { folder: merged, stats } = bm.mergeIntoFolder(folder, [sub], new Set(), idGen());
        // added 的口径是**网址条数**（文件夹不是书签）。把文件夹也算进去，
        // "导入了 N 条"就与界面上的书签数对不上。
        eq(stats.added, 1, '只数网址，不数文件夹');
        eq(merged.children.length, 1, '顶层只加了一个文件夹');
        eq(merged.children[0].type, 'folder', '它是文件夹');
        assert(merged.children[0].id !== 'edge-folder', '文件夹 id 也要重写');
        assert(merged.children[0].children[0].id !== 'edge-leaf', '内部叶子 id 也要重写');
        eq(merged.children[0].children[0].url, 'https://a.com', '内容没变');
    });

    check('mergeIntoFolder：文件夹内部的重复 url 也要被剔除', () => {
        // 只在顶层判重的症状是"重复导入后栏上没多，点进文件夹发现翻倍了"
        const folder = bm.makeFolder('bar', '栏');
        folder.children = [bm.makeUrlNode('x', 'https://dup.com', '已有')];
        const seen = bm.collectUrls({ bar: folder, other: bm.makeFolder('other', '其他') });

        const sub = bm.makeFolder('e', '工具');
        sub.children = [
            bm.makeUrlNode('l1', 'https://dup.com', '重复'),
            bm.makeUrlNode('l2', 'https://new.com', '新的'),
        ];
        const { folder: merged, stats } = bm.mergeIntoFolder(folder, [sub], seen, idGen());
        eq(stats.added, 1, '只有 1 条是新的');
        eq(stats.skipped, 1, '重复的那条被剔除');
        eq(merged.children.length, 2, '原有 1 条 + 导入的 1 个文件夹');
        // 按标题找文件夹，不按下标 —— 下标会随"原有书签在前"而变化
        const imported = merged.children.find((c) => c.type === 'folder');
        assert(imported, '导入的文件夹应该在');
        eq(imported.children.length, 1, '文件夹里应该只剩 1 条');
        eq(imported.children[0].url, 'https://new.com', '留下的应该是新的那条');
    });

    check('mergeIntoFolder：二次导入同一批数据是幂等的', () => {
        // 这是"重复点导入按钮"的场景。写错的表现是书签翻倍。
        const incoming = [
            bm.makeUrlNode('e1', 'https://a.com', 'A'),
            bm.makeUrlNode('e2', 'https://b.com', 'B'),
        ];
        const first = bm.mergeIntoFolder(bm.makeFolder('bar', '栏'), incoming, new Set(), idGen());
        const second = bm.mergeIntoFolder(first.folder, incoming, bm.collectUrls({
            bar: first.folder, other: bm.makeFolder('other', '其他'),
        }), idGen());
        eq(second.stats.added, 0, '第二次不应该再加任何东西');
        eq(second.stats.skipped, 2, '两条都被跳过');
        eq(second.folder.children.length, 2, '总数仍然是 2');
    });

    check('mergeIntoFolder：空文件夹被保留', () => {
        const { folder: merged, stats } = bm.mergeIntoFolder(
            bm.makeFolder('bar', '栏'), [bm.makeFolder('e', '空文件夹')], new Set(), idGen()
        );
        eq(merged.children.length, 1, '空文件夹也要进来');
        eq(stats.added, 0, '里面没有 url，所以新增数是 0');
        eq(stats.skipped, 0, '文件夹不算被跳过');
    });

    check('mergeIntoFolder：二次导入含文件夹的数据不产生空拷贝', () => {
        // 回归：之前文件夹从不去重，网址全被判重跳过后，每导一次多一批空文件夹
        const incoming = () => {
            const sub = bm.makeFolder('e1', '工具');
            sub.children = [
                bm.makeUrlNode('l1', 'https://a.com', 'A'),
                bm.makeUrlNode('l2', 'https://b.com', 'B'),
            ];
            return [sub];
        };
        let folder = bm.makeFolder('bar', '栏');
        for (let i = 0; i < 3; i++) {
            const seen = bm.collectUrls({ bar: folder, other: bm.makeFolder('other', '其他') });
            const r = bm.mergeIntoFolder(folder, incoming(), seen, idGen());
            folder = r.folder;
            if (i === 0) {
                eq(r.stats.added, 2, '首次新增 2 条');
            } else {
                eq(r.stats.added, 0, `第 ${i + 1} 次不该新增`);
                eq(r.stats.skipped, 2, `第 ${i + 1} 次两条都跳过`);
            }
        }
        eq(folder.children.length, 1, '导 3 次顶层还是只有 1 个文件夹');
        eq(bm.flattenUrls(folder).length, 2, '网址还是 2 条');
    });

    check('mergeIntoFolder：同名文件夹复用，已有保留、新增并入', () => {
        const folder = bm.makeFolder('bar', '栏');
        const old = bm.makeFolder('old', '工具');
        old.children = [bm.makeUrlNode('x', 'https://a.com', 'A')];
        folder.children = [old];
        const seen = bm.collectUrls({ bar: folder, other: bm.makeFolder('other', '其他') });

        const incoming = bm.makeFolder('e', '工具');
        incoming.children = [
            bm.makeUrlNode('l1', 'https://a.com', '重复'),
            bm.makeUrlNode('l2', 'https://b.com', '新的'),
        ];
        const { folder: merged, stats } = bm.mergeIntoFolder(folder, [incoming], seen, idGen());
        eq(merged.children.length, 1, '还是 1 个文件夹，不另起拷贝');
        eq(merged.children[0].id, 'old', '复用的是已有的那个');
        eq(merged.children[0].children.length, 2, '旧的 A 留下，新的 B 并入');
        eq(stats.added, 1, '新增 1 条');
        eq(stats.skipped, 1, '跳过 1 条');
    });

    check('mergeIntoFolder：不同名文件夹各自保留', () => {
        const folder = bm.makeFolder('bar', '栏');
        folder.children = [bm.makeFolder('old', '工具')];
        const incoming = bm.makeFolder('e', '资源');
        incoming.children = [bm.makeUrlNode('l', 'https://x.com', 'X')];
        const { folder: merged } = bm.mergeIntoFolder(folder, [incoming], new Set(), idGen());
        eq(merged.children.length, 2, '名字不同就是两个文件夹');
    });

    check('mergeIntoFolder：嵌套同名逐层复用', () => {
        const inner = bm.makeFolder('inner-old', '子');
        inner.children = [bm.makeUrlNode('x', 'https://a.com', 'A')];
        const outer = bm.makeFolder('outer-old', '工具');
        outer.children = [inner];
        const folder = bm.makeFolder('bar', '栏');
        folder.children = [outer];
        const seen = bm.collectUrls({ bar: folder, other: bm.makeFolder('other', '其他') });

        const inInner = bm.makeFolder('ie', '子');
        inInner.children = [bm.makeUrlNode('l', 'https://b.com', 'B')];
        const inOuter = bm.makeFolder('oe', '工具');
        inOuter.children = [inInner];
        const { folder: merged, stats } = bm.mergeIntoFolder(folder, [inOuter], seen, idGen());
        eq(merged.children.length, 1, '外层不复制');
        eq(merged.children[0].children.length, 1, '内层不复制');
        eq(merged.children[0].children[0].children.length, 2, 'A 留下，B 并入内层');
        eq(stats.added, 1, '新增 1 条');
        eq(stats.skipped, 0, '没有重复可跳');
    });

    check('mergeIntoFolder：空文件夹二次导入不再复制', () => {
        const first = bm.mergeIntoFolder(
            bm.makeFolder('bar', '栏'), [bm.makeFolder('e', '空文件夹')], new Set(), idGen()
        );
        eq(first.folder.children.length, 1, '首次进来（Edge 原样要保住）');
        const seen = bm.collectUrls({ bar: first.folder, other: bm.makeFolder('other', '其他') });
        const second = bm.mergeIntoFolder(
            first.folder, [bm.makeFolder('e2', '空文件夹')], seen, idGen()
        );
        eq(second.folder.children.length, 1, '第二次不再复制');
        eq(second.stats.added, 0, '新增 0');
        eq(second.stats.skipped, 0, '文件夹不算跳过');
    });

    check('collectUrls：两个根都收', () => {
        const tree = {
            bar: { id: 'bar', type: 'folder', title: '栏', children: [
                { id: 'a', type: 'url', title: 'A', url: 'https://a.com' },
            ] },
            other: { id: 'other', type: 'folder', title: '其他', children: [
                { id: 'b', type: 'url', title: 'B', url: 'https://b.com' },
            ] },
        };
        const set = bm.collectUrls(tree);
        eq(set.size, 2, '两个根都要收（漏掉一个的症状是"收藏了但星标不亮"）');
        assert(set.has('https://a.com') && set.has('https://b.com'), '两条都在');
    });

    /* ====================================================================== */
    /* 9. 跨进程契约                                                           */
    /* ====================================================================== */

    check('preload 暴露的 edge API 与 meta 声明一致', () => {
        const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
        const iface = fs.readFileSync(path.join(ROOT, 'meta', 'interface.ts'), 'utf8');

        assert(/edge:\s*\{/.test(preload), 'preload 必须有 edge 命名空间');
        for (const method of ['detect', 'run', 'onProgress']) {
            assert(new RegExp(`${method}:`).test(preload), `preload 缺 ${method}`);
        }
        assert(/edge\?:\s*ElectronEdgeAPI/.test(iface), 'ElectronAPI 上必须声明 edge');
    });

    check('主进程 IPC 通道名与 preload 逐字一致', () => {
        const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
        const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');

        for (const channel of ['edge-detect', 'edge-import']) {
            assert(main.includes(`ipcMain.handle('${channel}'`), `main.js 缺 handler：${channel}`);
            assert(preload.includes(`'${channel}'`), `preload 缺通道：${channel}`);
        }
        // 进度通道走 send/on 一对，不是 invoke
        assert(main.includes("send('edge-import-progress'"), 'main.js 必须发进度事件');
        assert(preload.includes("subscribe('edge-import-progress'"), 'preload 必须订阅进度事件');
    });

    check('edgeImportService 不 require electron（否则无法被测试直接 require）', () => {
        const src = fs.readFileSync(path.join(ROOT, 'electron', 'edgeImportService.js'), 'utf8');
        assert(!/require\(['"]electron['"]\)/.test(src), '不能 require electron —— 那会让本模块无法单测');
    });

    check('edgeImportService 的 cookies 写回在主进程而不是服务里', () => {
        const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
        assert(/session\.defaultSession/.test(main), 'cookies.set 必须写在 main.js（服务不碰 electron）');
        assert(/cookies\.set\(/.test(main), '必须有 cookies.set 调用');
    });

    check('书签栏显示策略的三个取值在类型与界面里一致', () => {
        const iface = fs.readFileSync(path.join(ROOT, 'meta', 'interface.ts'), 'utf8');
        const panel = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');

        const decl = iface.match(/BookmarkBarVisibility\s*=\s*([^;]+);/);
        assert(decl, '找不到 BookmarkBarVisibility 声明');
        for (const value of ['always', 'newTab', 'never']) {
            assert(decl[1].includes(`'${value}'`), `类型里缺 ${value}`);
            assert(panel.includes(`['${value}'`), `界面里缺 ${value} 这个选项`);
        }
    });

    check('书签栏是 webview 容器的兄弟节点，不是祖先', () => {
        // webview 的父链一动就重载页面。这条断言盯的是"书签栏被写进
        // BrowserView 内部"这种改法 —— 那会让每次切换显示策略都重载网页。
        const panel = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');
        const barIndex = panel.indexOf('<BookmarkBar');
        const viewIndex = panel.indexOf('<BrowserView');
        assert(barIndex > 0 && viewIndex > 0, '两个组件都要在');
        assert(barIndex < viewIndex, '书签栏必须出现在 BrowserView 之前（同一 flex 列的兄弟）');
    });

    check('BookmarkBar 组件不接受 webview 作为子节点', () => {
        const panel = fs.readFileSync(path.join(ROOT, 'components', 'BrowsePanel.tsx'), 'utf8');
        const start = panel.indexOf('const BookmarkBar: React.FC<{');
        assert(start > 0, '找不到 BookmarkBar');
        const end = panel.indexOf('const BookmarkBarItem', start);
        const body = panel.slice(start, end);
        assert(!body.includes('<webview'), '书签栏里不能出现 webview');
        assert(!body.includes('{children}'), '书签栏不能透传 children（会诱导别人把 webview 塞进来）');
    });

    console.log(`Edge 导入与书签树：通过 ${pass} 项，失败 ${fails.length} 项`);
    if (fails.length) {
        for (const f of fails) console.log(`  ✗ ${f.name}: ${f.message}`);
        return false;
    }
    return true;
};

/** 离线解密用例是异步的（AES-GCM 走 subtle），单独跑 */
const runAsync = async () => {
    const before = pass;
    const beforeFails = fails.length;
    // 必须等在途的异步用例全部落地，否则它们的断言结果来不及计入统计
    //（search.test 里修过的同一类问题：全绿但没生效）。
    while (pending.length > 0) {
        const batch = pending.splice(0, pending.length);
        await Promise.all(batch);
    }
    console.log(`Edge 导入（离线解密）：通过 ${pass - before} 项，失败 ${fails.length - beforeFails} 项`);
    if (fails.length) {
        for (const f of fails) console.log(`  ✗ ${f.name}: ${f.message}`);
        return false;
    }
    return true;
};

module.exports = { run, runAsync };

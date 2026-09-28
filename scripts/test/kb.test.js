'use strict';
/**
 * 知识库（open-reverselab 接入）回归。
 *
 * 打在三处最容易悄悄坏掉的地方：
 *   1. 分词与阈值 —— 原先的子串匹配下 `'a'` 命中 100 条、一个空格 96 条，
 *      查询越短噪音越大，方向正好反了。这里把"短查询必须 0 命中"钉死。
 *   2. 双信号源 —— kb-index.json 的 signals 是路由关键词，front-matter 的
 *      signals 多为检测指纹，语义不同。只用后者时"付费墙"命中 0 条。
 *   3. 以磁盘为准 —— 仓库自带索引有实测缺口（文章不在任何索引里、
 *      `../..` 跨板块路径、整个分类在生成物里缺失），索引必须从磁盘重建。
 *
 * 还有一条不是"防回归"而是"防退化"：超长文章必须回大纲而不是截断。
 * 库里有 13 篇超过 32KB，最大 104KB —— 截断等于把 104KB 砍成前 15%，
 * 而模型还以为自己看到了全文。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const KB = require('./build/services/KbService/index.js');

/**
 * 真实 KB 目录。
 *
 * 测试**默认不依赖**它 —— CI 与 fresh clone 下没有 open-reverselab，
 * 那时只跑合成样本的用例。目录存在时额外跑一组"真库体检"，
 * 把实测出来的那些数字（190 篇、13 篇超限、6 条越界路径）钉住。
 */
const KB_ROOT = (() => {
    const base = ROOT;
    let names = [];
    try {
        names = fs.readdirSync(base).filter((n) => n.startsWith('open-reverselab')).sort().reverse();
    } catch (_e) {
        return '';
    }
    for (const name of names) {
        const candidate = path.join(base, name, 'kb');
        if (fs.existsSync(path.join(candidate, 'ctf-website', 'techniques'))) return candidate;
    }
    return '';
})();

/** 把真库读成 KbSourceFile[]，与主进程 loadKbSource 同样的口径 */
const readRealKb = () => {
    const files = [];
    const boardIndexes = {};
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.toLowerCase().endsWith('.md')) continue;
            const rel = path.relative(KB_ROOT, full).split(path.sep).join('/');
            if (!/^([^/]+)\/techniques\/(.+\.md)$/.test(rel)) continue;
            files.push({ path: rel, content: fs.readFileSync(full, 'utf8') });
        }
    };
    walk(KB_ROOT);
    for (const board of fs.readdirSync(KB_ROOT, { withFileTypes: true })) {
        if (!board.isDirectory()) continue;
        const indexFile = path.join(KB_ROOT, board.name, 'techniques', 'kb-index.json');
        if (!fs.existsSync(indexFile)) continue;
        try {
            boardIndexes[board.name] = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
        } catch (_e) { /* 单个板块索引坏掉不影响其余 */ }
    }
    return { files, boardIndexes };
};

/* -------------------------------------------------------------------------- */

let pass = 0;
const fails = [];
const check = (name, fn) => {
    try { fn(); pass++; }
    catch (e) { fails.push({ name, message: e && e.message ? e.message : String(e) }); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };

const run = () => {
    /* ------------------------------ front-matter ------------------------------ */

    check('解析内联 JSON 数组（这批文章的真实写法）', () => {
        const { data } = KB.parseFrontMatter(
            '---\nid: "a/b"\nsignals: ["x", "y z"]\nkeywords: ["k"]\n---\n# 标题\n正文\n');
        assert(Array.isArray(data.signals) && data.signals.length === 2, 'signals 应是 2 项数组');
        assert(data.signals[1] === 'y z', `带空格的项应完整保留，实际 ${JSON.stringify(data.signals)}`);
        assert(data.id === 'a/b', '引号应被剥掉');
    });

    check('解析 > 折叠块（summary 用它，且必须合成一行）', () => {
        const { data } = KB.parseFrontMatter(
            '---\nsummary: >\n  第一行\n  第二行\nboard: "x"\n---\n# T\n');
        assert(data.summary === '第一行 第二行', `折叠块应合成为一行，实际 ${JSON.stringify(data.summary)}`);
        assert(data.board === 'x', '折叠块之后的字段仍要解析到');
    });

    check('正文切得干净：front-matter 不进 body', () => {
        const { body } = KB.parseFrontMatter('---\nid: "a"\n---\n# 标题\n\n正文段落\n');
        assert(!body.includes('id:'), '正文不得含 front-matter');
        assert(body.startsWith('# 标题'), `正文应从 H1 起，实际 ${JSON.stringify(body.slice(0, 20))}`);
    });

    check('没有 front-matter 时原样返回（4 个 attack-network.md 是这种）', () => {
        const text = '# 攻击网\n\n内容\n';
        const { data, body } = KB.parseFrontMatter(text);
        assert(Object.keys(data).length === 0, '不应凭空造出字段');
        assert(body === text, '正文应原样');
    });

    check('front-matter 未闭合时不吞掉正文', () => {
        const text = '---\nid: "a"\n# 标题\n正文\n';
        const { body } = KB.parseFrontMatter(text);
        assert(body === text, '未闭合应当整篇当正文，而不是把正文也吃掉');
    });

    /* --------------------------------- 路径 --------------------------------- */

    check('归一化解析 . 与 ..（跨板块路径必须能过）', () => {
        assert(KB.normalizeRel('a/b/../c.md') === 'a/c.md', '.. 应回退一级');
        assert(KB.normalizeRel('./a//b.md') === 'a/b.md', '. 与重复分隔符应被清掉');
        assert(KB.normalizeRel('a\\b.md') === 'a/b.md', '反斜杠应统一成 /');
    });

    check('归一化挡住越出根目录（../../../etc/passwd）', () => {
        assert(KB.normalizeRel('../../../etc/passwd') === null, '越出根必须返回 null');
        assert(KB.normalizeRel('a/../../x.md') === null, '中途越出也要挡住');
    });

    check('索引里的 ../.. 跨板块路径能解析到真实文件', () => {
        // ctf-website 的 kb-index.json 里有 6 条这种路径（指向 windows / general）。
        // 直接当字面量查表会全部落空 —— 这正是它必须走 normalizeRel 的原因。
        const files = [
            { path: 'ctf-website/techniques/01-recon/x.md', content: '---\nid: "a"\n---\n# A\n' },
            { path: 'general/techniques/01-kernel/y.md', content: '---\nid: "b"\n---\n# B\n' },
        ];
        const boardIndexes = {
            'ctf-website': {
                entries: [{ id: 'kernel', signals: ['page cache'], files: ['../../general/techniques/01-kernel/y.md'] }],
            },
        };
        const entries = KB.buildKbIndex(files, boardIndexes);
        const target = entries.find((e) => e.path === 'general/techniques/01-kernel/y.md');
        assert(target, '应能建出 general 那篇的索引项');
        assert(target.indexSignals.includes('page cache'),
            `跨板块信号应挂上，实际 ${JSON.stringify(target.indexSignals)}`);
    });

    check('索引指向不存在的文件时静默跳过，不抛', () => {
        const files = [{ path: 'ctf-website/techniques/a.md', content: '---\nid: "a"\n---\n# A\n' }];
        const boardIndexes = { 'ctf-website': { entries: [{ id: 'ghost', signals: ['x'], files: ['nope.md'] }] } };
        const entries = KB.buildKbIndex(files, boardIndexes);
        assert(entries.length === 1, '幽灵条目不该凭空造出文章');
        assert(entries[0].indexSignals.length === 0, '幽灵条目的信号不该挂到别人身上');
    });

    /* -------------------------------- 建索引 -------------------------------- */

    check('只收 <board>/techniques/**.md，README 不算文章', () => {
        const files = [
            { path: 'ctf-website/techniques/01-recon/x.md', content: '# X\n' },
            { path: 'ctf-website/techniques/README.md', content: '# 说明\n' },
            { path: 'ctf-website/README.md', content: '# 板块\n' },
            { path: 'kb/README.md', content: '# 库\n' },
            { path: 'ctf-website/checklists/attack-matrix.md', content: '# 矩阵\n' },
        ];
        const entries = KB.buildKbIndex(files);
        assert(entries.length === 1, `只应建出 1 篇，实际 ${entries.length}：${entries.map((e) => e.path).join(', ')}`);
    });

    check('无 front-matter 时标题回落到 H1', () => {
        const entries = KB.buildKbIndex([
            { path: 'ctf-website/techniques/attack-network.md', content: '# 攻击网总览\n\n正文\n' },
        ]);
        assert(entries[0].title === '攻击网总览', `应从 H1 取标题，实际 ${entries[0].title}`);
    });

    /* ------------------------------ 分词与阈值 ------------------------------ */

    check('单字符 ASCII 词被丢弃（这是旧实现的噪音源）', () => {
        assert(KB.tokenizeQuery('a').length === 0, "'a' 不应产出任何 token");
        assert(KB.tokenizeQuery('e').length === 0, "'e' 不应产出任何 token");
        assert(KB.tokenizeQuery('-').length === 0, "'-' 不应产出任何 token");
        assert(KB.tokenizeQuery(' ').length === 0, '空格不应产出任何 token');
    });

    check('中文切出二元组 + 完整串', () => {
        const tokens = KB.tokenizeQuery('付费墙');
        assert(tokens.includes('付费墙'), '完整串应在（三字词靠它拿到精确命中）');
        assert(tokens.includes('付费') && tokens.includes('费墙'), `二元组应在，实际 ${JSON.stringify(tokens)}`);
    });

    check('中英混排各取各的', () => {
        const tokens = KB.tokenizeQuery('接口 401 unauthorized');
        assert(tokens.includes('401'), '数字词应在');
        assert(tokens.includes('unauthorized'), '英文词应在');
        assert(tokens.includes('接口'), '中文词应在');
    });

    /* -------------------------------- 检索 --------------------------------- */

    /** 造一条文章，signals 分别放两路 */
    const mk = (over) => ({
        board: 'ctf-website', path: 'ctf-website/techniques/x.md', id: 'x',
        title: '', summary: '', category: '', signals: [], keywords: [], tags: [], indexSignals: [],
        ...over,
    });

    check('短查询不再爆炸：a / e / - / 空格 全部 0 命中', () => {
        const entries = [mk({ title: 'paywall bypass', signals: ['a'], keywords: ['e'], indexSignals: ['-'] })];
        for (const q of ['a', 'e', '-', ' ', '']) {
            const hits = KB.searchKb(entries, q);
            assert(hits.length === 0, `查询 ${JSON.stringify(q)} 应 0 命中，实际 ${hits.length}`);
        }
    });

    check('两路信号都参与评分（缺一路就漏）', () => {
        // 只用 front-matter signals 时"付费墙"命中 0 条 —— 它的 signals 是检测指纹
        const onlyFront = mk({ signals: ['Piano Tinypass script[src*="tinypass.com"]'] });
        const onlyIndex = mk({ indexSignals: ['付费墙'] });
        const both = mk({ signals: ['Piano Tinypass'], indexSignals: ['付费墙'] });

        assert(KB.searchKb([onlyIndex], '付费墙').length === 1, 'kb-index 那一路应能命中');
        assert(KB.searchKb([onlyFront], '付费墙').length === 0, '只有指纹时"付费墙"本就该 0 命中');

        // 两路各命中**不同**的词时，分数必须叠加。
        // 注意不能拿同一个词测：同一 token 是取跨源最大值，两路命中同一个词不叠加
        // （这是刻意的 —— 一个词命中两次不代表这条更相关）。
        const query = '付费墙 tinypass';
        const frontOnly = mk({ signals: ['Piano Tinypass'] });
        const indexOnly = mk({ indexSignals: ['付费墙'] });
        const scoreBoth = KB.scoreEntry(both, KB.tokenizeQuery(query)).score;
        assert(scoreBoth > KB.scoreEntry(indexOnly, KB.tokenizeQuery(query)).score,
            '两路合起来应高于只有 kb-index 一路');
        assert(scoreBoth > KB.scoreEntry(frontOnly, KB.tokenizeQuery(query)).score,
            '两路合起来应高于只有 front-matter 一路');
    });

    check('低于阈值的弱匹配被挡掉', () => {
        // 只有一个 tag 子串命中 = 4 分，低于 10 分阈值
        const weak = mk({ tags: ['something'] });
        assert(KB.searchKb([weak], 'some').length === 0, '弱匹配不该进结果');
    });

    check('结果按分数降序，同分按路径稳定排序', () => {
        const a = mk({ path: 'ctf-website/techniques/a.md', indexSignals: ['jwt'] });
        const b = mk({ path: 'ctf-website/techniques/b.md', indexSignals: ['jwt'] });
        const strong = mk({ path: 'ctf-website/techniques/c.md', indexSignals: ['jwt', 'token'] });
        const hits = KB.searchKb([b, a, strong], 'jwt token');
        assert(hits[0].path.endsWith('c.md'), '高分应排第一');
        assert(hits[1].path.endsWith('a.md') && hits[2].path.endsWith('b.md'), '同分应按路径升序，保证两次调用顺序一致');
    });

    check('命中词回传，供模型判断为什么是这条', () => {
        const hits = KB.searchKb([mk({ indexSignals: ['paywall'] })], 'paywall');
        assert(hits[0].matched.includes('paywall'), `matched 应含命中词，实际 ${JSON.stringify(hits[0].matched)}`);
    });

    check('limit 生效', () => {
        const many = Array.from({ length: 20 }, (_, i) =>
            mk({ path: `ctf-website/techniques/${i}.md`, indexSignals: ['jwt'] }));
        assert(KB.searchKb(many, 'jwt').length === KB.KB_SEARCH_LIMIT, `默认应回 ${KB.KB_SEARCH_LIMIT} 条`);
        assert(KB.searchKb(many, 'jwt', 3).length === 3, 'limit 参数应生效');
    });

    /* ------------------------------- 章节切片 ------------------------------- */

    const ARTICLE = [
        '---', 'id: "x"', 'title: "测试"', '---',
        '# 标题', '', '开头段落', '',
        '## 方法 1', '', '方法一的正文', '',
        '### 方法 1 细节', '', '细节正文', '',
        '## 方法 2', '', '方法二的正文', '',
        '## 攻击链', '', '链正文', '',
    ].join('\n');

    check('收集标题并算出各自区间', () => {
        const { body } = KB.parseFrontMatter(ARTICLE);
        const heads = KB.collectHeadings(body);
        // H1「标题」+ 方法 1 / 方法 1 细节 / 方法 2 / 攻击链 = 5
        assert(heads.length === 5, `应收到 5 个标题，实际 ${heads.length}`);
        const m1 = heads.find((h) => h.title === '方法 1');
        const m2 = heads.find((h) => h.title === '方法 2');
        // 方法 1 的区间必须止于方法 2 —— 否则读"方法 1"会把后面全带上
        assert(m1.end === m2.start, '同级标题应切断上一个的区间');
        assert(body.slice(m1.start, m1.end).includes('方法一的正文'), '区间内容应正确');
        assert(!body.slice(m1.start, m1.end).includes('方法二的正文'), '不得越界到下一节');
    });

    check('嵌套标题算进父节（### 属于 ##）', () => {
        const { body } = KB.parseFrontMatter(ARTICLE);
        const heads = KB.collectHeadings(body);
        const m1 = heads.find((h) => h.title === '方法 1');
        assert(body.slice(m1.start, m1.end).includes('细节正文'),
            '### 是 ## 的子节，读父节应把它带上');
    });

    check('代码块里的 # 注释不算标题（真库踩过：124 个"标题"里 81 个是注释）', () => {
        // Python / bash / yaml 的注释就是 # 开头，而这批文章代码占大头
        // （全库 4280 个代码块）。不跳围栏的后果有两层：大纲全是噪音，
        // 且读某一节时下一个"标题"其实是行代码注释，那一节在注释处被切断。
        const text = [
            '# 真标题', '',
            '## 第一节', '',
            '```python',
            '# 这不是标题',
            '## 这也不是',
            'x = 1',
            '```', '',
            '## 第二节', '',
            '正文',
        ].join('\n');
        const heads = KB.collectHeadings(text);
        const titles = heads.map((h) => h.title);
        assert(titles.length === 3, `应只认出 3 个真标题，实际 ${titles.length}：${titles.join(' | ')}`);
        assert(titles.includes('第一节') && titles.includes('第二节'), '真标题都应在');
        assert(!titles.includes('这不是标题') && !titles.includes('这也不是'), '围栏内的 # 行不得当标题');

        // 更要紧的一层：第一节的区间必须跨过代码块，而不是被注释截断
        const first = heads.find((h) => h.title === '第一节');
        const second = heads.find((h) => h.title === '第二节');
        assert(first.end === second.start, '第一节应一直延伸到第二节，不被代码注释切断');
        assert(text.slice(first.start, first.end).includes('x = 1'), '第一节区间应含代码块内容');
    });

    check('~~~ 围栏同样跳过', () => {
        const text = ['# T', '', '~~~', '# 注释', '~~~', '', '## 真节', '正文'].join('\n');
        const titles = KB.collectHeadings(text).map((h) => h.title);
        assert(!titles.includes('注释'), '~~~ 围栏内也不得当标题');
        assert(titles.includes('真节'), '围栏外的标题仍要认出');
    });

    check('未闭合的围栏按 CommonMark 吞到文末（规范行为，不是 bug）', () => {
        // 规范：未闭合的围栏延伸到文档结尾。真库实测 0 个文件是这种，
        // 所以这里钉的是"别自作聪明去恢复"—— 一个作者本意是代码的段落，
        // 被我们猜成标题，只会让大纲里多出假条目。
        const text = ['# T', '', '```', 'code', '## 在围栏里', '正文'].join('\n');
        const titles = KB.collectHeadings(text).map((h) => h.title);
        assert(titles.length === 1 && titles[0] === 'T',
            `未闭合围栏之后应全算代码，只留围栏前的标题，实际 ${JSON.stringify(titles)}`);
    });

    check('短文直接回全文，不给大纲', () => {
        const entry = { path: 'a.md', title: '测试' };
        const result = KB.readKbArticle(entry, ARTICLE);
        assert(result.content.includes('方法二的正文'), '短文应回全文');
        assert(result.truncated === false, '不应标成截断');
    });

    check('超长文不回正文，改回大纲（硬需求，非优化）', () => {
        const entry = { path: 'a.md', title: '测试' };
        const result = KB.readKbArticle(entry, ARTICLE, { limitBytes: 80 });
        assert(result.truncated === true, '应标记超限');
        assert(result.content === '', '超限时不得回半截正文 —— 那会让模型以为看到了全文');
        assert(result.outline.length === 5, '应回完整大纲');
        assert(result.notice && result.notice.includes('outline'),
            `提示应指向 outline 用法，实际 ${JSON.stringify(result.notice)}`);
    });

    check('按 section 取章节（子串匹配，给几个字就够）', () => {
        const entry = { path: 'a.md', title: '测试' };
        const result = KB.readKbArticle(entry, ARTICLE, { section: '方法 2' });
        assert(result.content.includes('方法二的正文'), '应取到目标章节');
        assert(!result.content.includes('方法一的正文'), '不应带上别的章节');
        assert(result.section === '方法 2', '应回传命中的标题');
    });

    check('section 命中不到时给可操作的提示，而不是空正文', () => {
        const entry = { path: 'a.md', title: '测试' };
        const result = KB.readKbArticle(entry, ARTICLE, { section: '不存在的章节' });
        assert(result.content === '', '不该回正文');
        assert(result.notice && result.notice.includes('outline'), '应让模型去看大纲');
        assert(result.outline.length === 5, '大纲仍要给出，否则模型无从下手');
    });

    check('超限文章按 section 仍能读到内容', () => {
        const entry = { path: 'a.md', title: '测试' };
        const result = KB.readKbArticle(entry, ARTICLE, { section: '攻击链', limitBytes: 80 });
        assert(result.content.includes('链正文'), '章节本身没超限就该正常返回');
    });

    /* ---------------------------- 真实 KB 体检 ---------------------------- */

    if (!KB_ROOT) {
        console.log('  （未找到 open-reverselab 目录，跳过真实知识库体检）');
    } else {
        const { files, boardIndexes } = readRealKb();
        const entries = KB.buildKbIndex(files, boardIndexes);

        check('真库：索引出全部文章且都是 4 个板块之一', () => {
            assert(entries.length >= 150, `篇数异常：${entries.length}`);
            const boards = new Set(entries.map((e) => e.board));
            for (const b of boards) {
                assert(['ctf-website', 'apk-reverse', 'pe-reverse', 'general', 'windows'].includes(b),
                    `出现未知板块 ${b}`);
            }
        });

        check('真库：每篇都有标题（无 front-matter 的靠 H1 兜底）', () => {
            const empty = entries.filter((e) => !e.title);
            assert(empty.length === 0, `有 ${empty.length} 篇没标题：${empty.slice(0, 3).map((e) => e.path).join(', ')}`);
        });

        check('真库：不在任何 kb-index.json 里的文章仍可被检索（以磁盘为准）', () => {
            // 实测有 5 篇是这种情况（2 篇 apk-reverse + 3 篇 pe-reverse）。
            // 若改成"以 kb-index.json 为准"，它们会永远搜不到。
            const noIndex = entries.filter((e) => e.indexSignals.length === 0);
            assert(noIndex.length > 0, '应当存在没被 kb-index 覆盖的文章（找不到说明索引方式变了）');
            const target = noIndex.find((e) => e.title);
            const hits = KB.searchKb(entries, target.title);
            assert(hits.length > 0, `「${target.title}」应能靠 front-matter 被搜到`);
        });

        check('真库：越界路径没有把索引键弄脏', () => {
            const bad = entries.filter((e) => e.path.includes('..') || e.path.includes('\\'));
            assert(bad.length === 0, `索引键不该含 .. 或反斜杠：${bad.slice(0, 3).map((e) => e.path).join(', ')}`);
        });

        check('真库：短查询 0 命中（旧实现下 a=100 / e=102 / 空格=96）', () => {
            for (const q of ['a', 'e', '-', ' ']) {
                const hits = KB.searchKb(entries, q, 50);
                assert(hits.length === 0, `查询 ${JSON.stringify(q)} 应 0 命中，实际 ${hits.length}`);
            }
        });

        check('真库：付费墙能命中 23-paywall-bypass', () => {
            const hits = KB.searchKb(entries, '付费墙');
            assert(hits.length > 0, '「付费墙」应命中 —— 这条只有两路信号合并才成立');
            assert(hits.some((h) => h.path.includes('23-paywall-bypass')),
                `应命中 paywall 板块，实际 ${hits.map((h) => h.path).join(', ')}`);
        });

        check('真库：jwt 命中 02-auth/jwt', () => {
            const hits = KB.searchKb(entries, 'jwt');
            assert(hits.some((h) => h.path.includes('02-auth/jwt')), 'jwt 应命中 jwt 目录');
        });

        check('真库：超长文章确实存在，且 read 会给大纲而不是截断', () => {
            const oversize = entries.filter((e) => {
                const src = files.find((f) => f.path === e.path);
                return src && KB.byteLength(src.content) > KB.KB_READ_LIMIT_BYTES;
            });
            assert(oversize.length > 0, '库里有超限文章，这条断言的前提不该消失');

            const sample = oversize[0];
            const src = files.find((f) => f.path === sample.path);
            const result = KB.readKbArticle(sample, src.content);
            assert(result.truncated === true, `${sample.path} 应标记超限`);
            assert(result.content === '', '超限时不得回半截正文');
            assert(result.outline.length > 0, '必须给大纲，否则模型无从下手');
        });

        check('真库：按大纲里的标题能真正读到内容', () => {
            const sample = entries.find((e) => e.path.includes('13-signature'));
            const src = files.find((f) => f.path === sample.path);
            const outline = KB.readKbArticle(sample, src.content).outline;
            const target = outline.find((h) => h.level === 2) || outline[0];
            const result = KB.readKbArticle(sample, src.content, { section: target.title });
            assert(result.content.length > 0,
                `按大纲标题「${target.title}」应读到内容，实际为空（notice: ${result.notice}）`);
        });

        check('真库：大纲里没有代码注释冒充标题', () => {
            // 全库代码块占大头，Python/bash 注释就是 # 开头。不跳围栏时
            // 13-signature/03-key-attacks.md 会切出 124 个"标题"、其中 81 个是注释。
            //
            // 这里钉**具体那几个已知的假标题**，不用「像代码就报错」那类启发式 ——
            // 实测那种启发式会误伤真标题：`### 6.1 \`key_extractor.py\` — 全自动密钥提取器`
            // 是真的 markdown 标题（在讲一个脚本），却被 `/\.py\b/` 判成代码。
            const FAKE = [
                'weak_keys_dict.py — 弱密钥字典 + 自动测试',
                '=== Top 100 HMAC 弱密钥 (精选) ===',
                'framework_default_keys.py — 框架默认密钥生成器与测试器',
                '所有语言都可能出错的值',
                '关键判断:',
            ];
            for (const rel of ['13-signature/03-key-attacks.md', '12-payment/payment-bypass.md']) {
                const entry = entries.find((e) => e.path.endsWith(rel));
                assert(entry, `真库里应能找到 ${rel}`);
                const src = files.find((f) => f.path === entry.path);
                const outline = KB.readKbArticle(entry, src.content).outline;

                // 不跳围栏时这个文件是 124，跳了是 43。80 是两者之间的安全线。
                assert(outline.length < 80,
                    `${rel} 切出 ${outline.length} 个标题，多半又把代码注释算进去了`);

                const leaked = outline.filter((h) => FAKE.includes(h.title));
                assert(leaked.length === 0,
                    `${rel} 的大纲里混进了代码行：${leaked.map((h) => h.title).join(' | ')}`);
            }
        });

        check('真库：界面报的篇数与 Agent 能搜到的篇数一致', () => {
            // 这条防的是"显示的和实际发生的不一致"：kbStatus 曾经数"techniques 下
            // 所有 .md"（含 11 个 README），而建索引时另排一遍 README，两边差 11 ——
            // 面板显示 205 篇，模型实际只能搜到 194 篇。
            const status = require(path.join(ROOT, 'electron', 'kbService.js')).kbStatus('');
            assert(status.ready, '真库应处于就绪状态');
            assert(status.articles === entries.length,
                `面板报 ${status.articles} 篇，索引只有 ${entries.length} 篇 —— 判据又分家了`);
        });

        check('真库：对媒体嗅探类查询不假装有答案', () => {
            // 这个库不覆盖 m3u8 / HLS / 防盗链。返回空是**正确**行为 ——
            // 提示词里也明说了这类问题别在这儿找。这条断言防的是"为了好看
            // 而把弱匹配也塞进结果"。
            for (const q of ['m3u8', '防盗链']) {
                const hits = KB.searchKb(entries, q);
                assert(hits.length === 0, `「${q}」本库不覆盖，不该有命中，实际 ${hits.length}`);
            }
        });
    }

    console.log(`知识库：通过 ${pass} 项，失败 ${fails.length} 项`);
    if (fails.length) {
        for (const f of fails) console.log(`  ✗ ${f.name}: ${f.message}`);
        return false;
    }
    return true;
};

module.exports = { run };

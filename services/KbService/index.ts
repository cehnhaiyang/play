/**
 * 知识库服务：把 open-reverselab 的 Markdown 文章索引化并提供检索。
 *
 * 这个模块是**纯函数**：不碰文件系统、不碰网络、不碰 Electron。
 * 文件读取由主进程做（见 electron/kbService.js），这里只接收
 * `{ path, content }[]` 并产出索引与检索结果。
 *
 * 为什么检索放在渲染层而不是主进程：
 * 主进程目录只能写 .js（见 electron-main-constraints），纯逻辑放那儿就失去了
 * 单测能力 —— scripts/test/tsconfig.json 不 include electron/。放这里则被测试
 * 套件直接编译，与 services/SearchService 同一套路。
 *
 * 为什么从磁盘全量重建索引、而不是直接读仓库自带的 kb-index.json：
 * 那份索引有三个实测缺口 —— 有文章不在任何索引里、有条目用 `../..` 越界到别的
 * 板块、有整个分类在 docs 的生成物里缺失。以磁盘为准、把 kb-index.json 只当作
 * **一路加权信号**，这三个缺陷就在我们这侧被消掉了，不需要改动外部仓库。
 */

/* -------------------------------------------------------------------------- */
/*                                   类型                                      */
/* -------------------------------------------------------------------------- */

/** 主进程读回来的一份原始文件。path 是 kb 根目录下的相对路径，统一 '/' 分隔 */
export interface KbSourceFile {
    path: string;
    content: string;
}

/** 仓库自带 kb-index.json 的形状（只取我们用得到的字段） */
export interface KbBoardIndex {
    entries?: { id?: string; signals?: string[]; files?: string[] }[];
}

/** 索引里的一条文章 */
export interface KbEntry {
    board: string;
    path: string;
    id: string;
    title: string;
    summary: string;
    category: string;
    /** front-matter 的 signals —— 多为**检测指纹**（如 `script[src*="tinypass.com"]`） */
    signals: string[];
    keywords: string[];
    tags: string[];
    /** kb-index.json 的 signals —— 多为**路由关键词**，与上面那组语义不同，两组都要 */
    indexSignals: string[];
}

export interface KbSearchHit {
    path: string;
    board: string;
    title: string;
    summary: string;
    score: number;
    /** 命中的词，供模型判断"为什么这条被选出来" */
    matched: string[];
}

export interface KbHeading {
    level: number;
    title: string;
    /** 在正文里的字符偏移 */
    start: number;
    end: number;
}

export interface KbReadResult {
    path: string;
    title: string;
    section?: string;
    outline: { level: number; title: string }[];
    content: string;
    bytes: number;
    truncated: boolean;
    notice?: string;
}

/** 主进程 load() 的返回 */
export interface KbLoadPayload {
    root: string;
    files: KbSourceFile[];
    boardIndexes: Record<string, KbBoardIndex>;
    error?: string;
}

/** 主进程 status() 的返回 */
export interface KbStatusPayload {
    ready: boolean;
    root: string;
    articles: number;
    bytes: number;
    error?: string;
}

/* -------------------------------------------------------------------------- */
/*                                 常量与工具                                   */
/* -------------------------------------------------------------------------- */

/**
 * 命中阈值。
 *
 * 取 10 是实测出来的：低于它时"参数""数据""验证"这类通用词会把无关文章
 * 一起拖进结果；高于它则真实查询开始漏。评分权重见 scoreEntry。
 */
export const KB_SEARCH_MIN_SCORE = 10;

/** 一次检索回给模型几条。5 条 ≈ 900 字节，比回整个索引便宜得多 */
export const KB_SEARCH_LIMIT = 5;

/**
 * 单次 read 回传正文的字节上限。
 *
 * 比 Agent 的 RESULT_LIMIT_BYTES（32768）低一截：那条上限管的是页面脚本的返回值，
 * 这条管的是知识库正文，留出 JSON 外壳与大纲的余量。
 */
export const KB_READ_LIMIT_BYTES = 24576;

/** 检索结果里摘要的截断长度（字符，不是字节） */
const SUMMARY_CHARS = 160;

export const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** 按**字节**截断且不切坏多字节字符，与 useAgent 的同名函数同一套二分 */
export const truncateBytes = (text: string, limit: number): string => {
    if (byteLength(text) <= limit) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (byteLength(text.slice(0, mid)) <= limit) lo = mid;
        else hi = mid - 1;
    }
    return text.slice(0, lo);
};

/**
 * 归一化 kb 根目录下的相对路径，解析 `.` 与 `..`。
 *
 * 越出 kb 根一律返回 null —— 仓库自带的 ctf-website 索引里有 6 条
 * `../../windows/techniques/...` 与 `../../general/techniques/...`，
 * 它们是**合法且必要**的跨板块引用，必须解析成功；
 * 但 `../../../etc/passwd` 这种要挡住。
 */
export const normalizeRel = (raw: string): string | null => {
    const parts: string[] = [];
    for (const seg of String(raw).split(/[\\/]+/)) {
        if (!seg || seg === '.') continue;
        if (seg === '..') {
            if (parts.length === 0) return null;
            parts.pop();
            continue;
        }
        parts.push(seg);
    }
    return parts.length ? parts.join('/') : null;
};

/** 文章路径：`<board>/techniques/**.md`，README 不算文章 */
export const ARTICLE_PATH_RE = /^([^/]+)\/techniques\/(.+\.md)$/;

const firstHeading = (body: string): string => {
    const m = /^#\s+(.+?)\s*$/m.exec(body);
    return m ? m[1] : '';
};

const basename = (path: string): string => path.split('/').pop() || path;

/* -------------------------------------------------------------------------- */
/*                              front-matter 解析                              */
/* -------------------------------------------------------------------------- */

export type KbFrontMatter = Record<string, string | string[]>;

const unquote = (raw: string): string => {
    const t = raw.trim();
    if (t.length >= 2
        && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
        return t.slice(1, -1);
    }
    return t;
};

/**
 * 标量或内联数组。
 *
 * 这批文章的列表字段**全部**写成内联 JSON 数组（`signals: ["a", "b"]`），
 * 不是 YAML 的块序列 —— 所以先按 JSON 解析，失败了再退回按逗号裸切。
 */
const parseScalar = (raw: string): string | string[] => {
    const t = raw.trim();
    if (t.startsWith('[')) {
        try {
            const parsed = JSON.parse(t);
            if (Array.isArray(parsed)) return parsed.map((v) => String(v));
        } catch {
            // 不是合法 JSON（YAML 里裸词不引号时会这样）：按逗号切
        }
        return t.replace(/^\[|\]$/g, '')
            .split(',')
            .map((v) => unquote(v))
            .filter(Boolean);
    }
    return unquote(t);
};

const FM_DELIM = /^---\s*$/;

/**
 * 切出 YAML front-matter 与正文。
 *
 * 只支持这批文件真实用到的四种取值形态：引号标量、内联数组、
 * `>` 折叠块（summary / summary_en 用它）、`|` 字面块。
 * 不引 YAML 库：为一个只读 front-matter 的场景拉一个解析器不划算，
 * 而且失败时我们只需要降级成"没有 front-matter"，不需要抛错。
 */
export const parseFrontMatter = (text: string): { data: KbFrontMatter; body: string } => {
    const src = text.replace(/^\uFEFF/, '');
    if (!src.startsWith('---')) return { data: {}, body: src };

    const lines = src.split('\n');
    if (!FM_DELIM.test(lines[0])) return { data: {}, body: src };

    let end = -1;
    for (let i = 1; i < lines.length; i += 1) {
        if (FM_DELIM.test(lines[i])) { end = i; break; }
    }
    if (end < 0) return { data: {}, body: src };

    const data: KbFrontMatter = {};
    let i = 1;
    while (i < end) {
        const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
        if (!m) { i += 1; continue; }

        const key = m[1];
        const rest = m[2].trim();

        if (rest === '>' || rest === '|') {
            const block: string[] = [];
            i += 1;
            while (i < end && (lines[i].trim() === '' || /^\s/.test(lines[i]))) {
                block.push(lines[i].replace(/^\s+/, ''));
                i += 1;
            }
            while (block.length && block[block.length - 1] === '') block.pop();
            data[key] = rest === '>' ? block.join(' ').trim() : block.join('\n').trim();
            continue;
        }

        data[key] = parseScalar(rest);
        i += 1;
    }

    return { data, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') };
};

/* -------------------------------------------------------------------------- */
/*                                  建索引                                     */
/* -------------------------------------------------------------------------- */

const asList = (v: string | string[] | undefined): string[] => {
    if (Array.isArray(v)) return v;
    return v ? [v] : [];
};

/**
 * 把各板块 kb-index.json 的 signals 挂到对应文件上。
 *
 * 必须走 normalizeRel 解析 `..`：ctf-website 的索引里有 6 条指向
 * windows / general 的跨板块路径，直接当字面量查表会全部落空。
 */
export const resolveBoardIndexSignals = (
    files: KbSourceFile[],
    boardIndexes: Record<string, KbBoardIndex>,
): Map<string, string[]> => {
    const known = new Set(files.map((f) => f.path));
    const out = new Map<string, string[]>();

    for (const [board, index] of Object.entries(boardIndexes || {})) {
        const base = `${board}/techniques`;
        for (const entry of index?.entries || []) {
            for (const rel of entry?.files || []) {
                const resolved = normalizeRel(`${base}/${rel}`);
                // 索引指向磁盘上不存在的文件时静默跳过：以磁盘为准
                if (!resolved || !known.has(resolved)) continue;
                out.set(resolved, (out.get(resolved) || []).concat(entry?.signals || []));
            }
        }
    }
    return out;
};

/** 从原始文件列表建出文章索引。非文章路径（README、板块说明等）自然被过滤掉 */
export const buildKbIndex = (
    files: KbSourceFile[],
    boardIndexes: Record<string, KbBoardIndex> = {},
): KbEntry[] => {
    const signalsByPath = resolveBoardIndexSignals(files, boardIndexes);
    const entries: KbEntry[] = [];

    for (const file of files) {
        const m = ARTICLE_PATH_RE.exec(file.path);
        if (!m) continue;
        if (/(^|\/)readme\.md$/i.test(file.path)) continue;

        const { data, body } = parseFrontMatter(file.content);
        entries.push({
            board: m[1],
            path: file.path,
            id: asList(data.id)[0] || file.path.replace(/\.md$/, ''),
            // 无 front-matter 的文章（4 个 attack-network.md）回落到 H1
            title: asList(data.title)[0] || firstHeading(body) || basename(file.path),
            summary: asList(data.summary)[0] || '',
            category: asList(data.category)[0] || '',
            signals: asList(data.signals),
            keywords: asList(data.keywords),
            tags: asList(data.tags),
            indexSignals: signalsByPath.get(file.path) || [],
        });
    }

    return entries;
};

/* -------------------------------------------------------------------------- */
/*                                   检索                                      */
/* -------------------------------------------------------------------------- */

/**
 * 分词：ASCII 词 + 中文二元组 + 完整中文串。
 *
 * 三条实测约束决定了这个写法：
 *  - 单字符 ASCII 词必须丢掉。原先的子串匹配下 `'a'` 命中 100 条、`'e'` 102 条、
 *    `'-'` 101 条、一个空格 96 条 —— 查询越短噪音越大，方向正好反了。
 *  - 中文没有词边界，只能靠二元组；同时保留完整串，让"付费墙"这种
 *    三字词能拿到一次精确命中。
 *  - 权重一律 1：实测调过加权，对结果排序没有可见改善，不如保持可解释。
 */
export const tokenizeQuery = (query: string): string[] => {
    const lower = String(query || '').toLowerCase();
    const out = new Set<string>();

    for (const m of lower.matchAll(/[a-z0-9][a-z0-9_+:.\-]*/g)) {
        if (m[0].length >= 2) out.add(m[0]);
    }
    for (const m of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
        const run = m[0];
        out.add(run);
        for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2));
    }

    return [...out];
};

/**
 * 单条文章的得分。
 *
 * 两组 signals 都要用，且**权重不同** —— 它们的语义不一样：
 * kb-index.json 的 signals 是路由关键词（"paywall"、"付费墙"），
 * front-matter 的 signals 多为检测指纹（`Piano Tinypass script[src*=...]`）。
 * 只用 front-matter 时"付费墙"命中 0 条，合起来才命中 5 篇。
 */
export const scoreEntry = (entry: KbEntry, tokens: string[]): { score: number; matched: string[] } => {
    let score = 0;
    const matched: string[] = [];

    for (const token of tokens) {
        let best = 0;

        for (const v of entry.indexSignals) {
            const s = v.toLowerCase();
            if (s === token) { best = Math.max(best, 16); break; }
            if (s.includes(token)) best = Math.max(best, 12);
        }
        for (const v of entry.signals) {
            const s = v.toLowerCase();
            if (s === token) { best = Math.max(best, 14); break; }
            if (s.includes(token)) best = Math.max(best, 10);
        }
        for (const v of entry.keywords) {
            const s = v.toLowerCase();
            if (s === token) { best = Math.max(best, 8); break; }
            if (s.includes(token)) best = Math.max(best, 7);
        }
        for (const v of entry.tags) {
            const s = v.toLowerCase();
            if (s === token) { best = Math.max(best, 5); break; }
            if (s.includes(token)) best = Math.max(best, 4);
        }

        if (entry.title.toLowerCase().includes(token)) best = Math.max(best, 6);
        if (entry.id.toLowerCase().includes(token)) best = Math.max(best, 5);
        if (entry.path.toLowerCase().includes(token)) best = Math.max(best, 4);

        if (best > 0) {
            score += best;
            matched.push(token);
        }
    }

    return { score, matched };
};

export const searchKb = (
    entries: KbEntry[],
    query: string,
    limit = KB_SEARCH_LIMIT,
): KbSearchHit[] => {
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0) return [];

    const hits: KbSearchHit[] = [];
    for (const entry of entries) {
        const { score, matched } = scoreEntry(entry, tokens);
        if (score < KB_SEARCH_MIN_SCORE) continue;
        hits.push({
            path: entry.path,
            board: entry.board,
            title: entry.title,
            summary: entry.summary.slice(0, SUMMARY_CHARS),
            score,
            matched,
        });
    }

    // 同分时按路径排，让结果稳定 —— 否则同一查询两次调用可能给出不同顺序
    hits.sort((a, b) => (b.score - a.score) || a.path.localeCompare(b.path));
    return hits.slice(0, limit);
};

/* -------------------------------------------------------------------------- */
/*                                 章节切片                                    */
/* -------------------------------------------------------------------------- */

/** 围栏代码块的开闭标记（``` 或 ~~~，允许缩进） */
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/**
 * 收集 1-4 级标题，并把每个标题的 end 收到下一个同级或更高级标题之前。
 *
 * **必须跳过围栏代码块内的行。** 这批文章里代码占了大头（全库 4280 个代码块），
 * 而 Python / bash / yaml 的注释就是 `#` 开头 —— 实测 13-signature/03-key-attacks.md
 * 会被切出 124 个"标题"，其中 81 个是 `# === Top 100 HMAC 弱密钥 ===` 这类注释。
 * 后果有两层：大纲全是噪音；更糟的是读某一节时，下一个"标题"其实是一行代码注释，
 * 于是那一节在注释处被切断 —— 实测「0. 密钥攻击全景」只剩 433 字节。
 */
export const collectHeadings = (body: string): KbHeading[] => {
    const lines = body.split('\n');
    const offsets: number[] = [];
    let offset = 0;
    for (const line of lines) {
        offsets.push(offset);
        offset += line.length + 1;
    }

    const heads: KbHeading[] = [];
    let fence: string | null = null;

    lines.forEach((line, idx) => {
        const fenceMatch = FENCE_RE.exec(line);
        if (fenceMatch) {
            const marker = fenceMatch[1];
            if (fence === null) fence = marker;
            // 闭合围栏必须与开栏同类且不短于它；更短的（如 ``` 撞上 ````）不算闭合
            else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
            return;
        }
        if (fence !== null) return;

        const m = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
        if (!m) return;
        heads.push({ level: m[1].length, title: m[2], start: offsets[idx], end: body.length });
    });

    for (let i = 0; i < heads.length; i += 1) {
        for (let j = i + 1; j < heads.length; j += 1) {
            if (heads[j].level <= heads[i].level) { heads[i].end = heads[j].start; break; }
        }
    }

    return heads;
};

export const buildOutline = (headings: KbHeading[]): { level: number; title: string }[] =>
    headings.map((h) => ({ level: h.level, title: h.title }));

/**
 * 读一篇文章。
 *
 * 超长文章**不截断**而是回大纲 —— 这条是硬需求不是优化：
 * 库里有 13 篇超过 32 KB，最大的一篇 104 KB（3.2 倍上限）。
 * 直接截断等于把 104 KB 砍成前 15%，模型还以为自己看到了全文；
 * 回大纲则让它先看清结构，再按标题取真正需要的那一段。
 */
export const readKbArticle = (
    entry: KbEntry,
    rawContent: string,
    options: { section?: string; limitBytes?: number } = {},
): KbReadResult => {
    const limit = options.limitBytes || KB_READ_LIMIT_BYTES;
    const { body } = parseFrontMatter(rawContent);
    const headings = collectHeadings(body);
    const outline = buildOutline(headings);
    const total = byteLength(body);

    const base: KbReadResult = {
        path: entry.path,
        title: entry.title,
        outline,
        content: '',
        bytes: total,
        truncated: false,
    };

    const section = (options.section || '').trim();
    if (section) {
        const needle = section.toLowerCase();
        const hit = headings.find((h) => h.title.toLowerCase().includes(needle));
        if (!hit) {
            return {
                ...base,
                notice: `没有找到标题含「${section}」的章节。请从 outline 里挑一个标题再读。`,
            };
        }
        const text = body.slice(hit.start, hit.end).trim();
        const clipped = truncateBytes(text, limit);
        return {
            ...base,
            section: hit.title,
            content: clipped,
            truncated: byteLength(text) > limit,
            notice: byteLength(text) > limit ? '该章节仍超出单次上限，已截断。' : undefined,
        };
    }

    if (total <= limit) {
        return { ...base, content: body.trim() };
    }

    return {
        ...base,
        truncated: true,
        notice: `正文 ${total} 字节，超过单次上限 ${limit} 字节，未回传正文。`
            + '请从 outline 里挑一个章节，用 section 参数读它。',
    };
};

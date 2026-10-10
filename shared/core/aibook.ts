/**
 * .aibook —— AI 绘本单文件格式。
 *
 * ## 为什么是 JSON 而不是 ZIP
 *
 * 与 .gallery 的取舍不同：绘本正文是文字、图片数量少（通常 3～20 页）且需要
 * 连文案、语音一起整体分享，所以用 JSON 单文件而非 ZIP —— 自描述、可读、可手改，
 * 也省掉解压依赖。代价是图片以 data URL 内联，体积比 ZIP 大约 33%。
 *
 * 磁盘形态：
 *     { "version": "1.0", "title": "小狐狸的月亮",
 *       "pages": [ { "image": "data:image/png;base64,...", "text": "…",
 *                    "audio": "…" }, … ] }
 *
 * 解析与组装本身与 DOM 无关；只有 `readAiBookFile` 要 `File`。
 */
import type { AiBookFile, AiBookPage, ParsedAiBook } from '../meta';

/** 当前写出的格式版本 */
export const AIBOOK_VERSION = '1.0';

/** 单本绘本的页数上限（与画廊包同量级，防呆而非业务限制） */
export const AIBOOK_MAX_PAGES = 2000;

/** 是否为 .aibook 文件（按后缀判定，导入入口用） */
export const isAiBookFileName = (fileName: string): boolean =>
    /\.aibook$/i.test((fileName || '').trim());

/** 组装一本 .aibook 的 JSON 文本 */
export const buildAiBookJson = (title: string, pages: AiBookPage[]): string => {
    const payload: AiBookFile = {
        version: AIBOOK_VERSION,
        title: (title || '').trim() || '未命名故事',
        pages,
    };
    return JSON.stringify(payload, null, 2);
};

/** 组装一本 .aibook 的 Blob（供下载 / Electron 另存为） */
export const buildAiBookBlob = (title: string, pages: AiBookPage[]): Blob =>
    new Blob([buildAiBookJson(title, pages)], { type: 'application/json' });

/**
 * 解析 .aibook 文本。
 *
 * 容错策略：字段缺失/类型不对的页直接跳过；一页不剩才抛错。
 * 这样用户手改坏一页仍能打开整本书。
 */
export const parseAiBookText = (text: string, fallbackTitle = '未命名故事'): ParsedAiBook => {
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch (error) {
        throw new Error(`不是合法的 .aibook 文件（JSON 解析失败）：${error instanceof Error ? error.message : '未知错误'}`);
    }

    const file = data as Partial<AiBookFile>;
    if (!file || typeof file !== 'object') throw new Error('不是合法的 .aibook 文件（内容为空）');
    if (!Array.isArray(file.pages)) throw new Error('不是合法的 .aibook 文件（缺少 pages 数组）');

    const pages: AiBookPage[] = [];
    for (const raw of file.pages.slice(0, AIBOOK_MAX_PAGES)) {
        const page = raw as Partial<AiBookPage>;
        if (!page || typeof page !== 'object') continue;
        const image = typeof page.image === 'string' ? page.image.trim() : '';
        if (!image) continue;
        pages.push({
            image,
            text: typeof page.text === 'string' ? page.text : '',
            audio: typeof page.audio === 'string' && page.audio ? page.audio : undefined,
        });
    }

    if (pages.length === 0) throw new Error('这本 .aibook 里没有任何有效页面');

    const title = typeof file.title === 'string' && file.title.trim() ? file.title.trim() : fallbackTitle;
    return { title, pages };
};

/** 读取并解析 .aibook 文件（书名缺省取文件名） */
export const readAiBookFile = async (file: File): Promise<ParsedAiBook> => {
    const text = await file.text();
    const fallback = file.name.replace(/\.aibook$/i, '').trim() || '未命名故事';
    return parseAiBookText(text, fallback);
};

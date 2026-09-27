/**
 * galleryPack — 单文件 .gallery（ZIP 改后缀）的打包 / 解包规则。
 *
 * 输入目录约定（选择文件夹后）：
 *   <root>/.name   ← 画廊名文件：文件名即 `.name`，内容有且仅有一行字符串 = 画廊名
 *   <root>/1.png   ← 数字命名 + 图片后缀即可（不一定是 png）
 *   <root>/2.jpg   ← 同上，页码 = 数字部分
 * 其它一切文件（子目录、非数字命名、非图片后缀、坏掉的 .name）直接无视。
 *
 * 输出单文件：
 *   <画廊名>.gallery ← ZIP（STORE 不重压图片），包内：`.name` + 原名图片
 * 导入时按魔数 `PK` 识别单文件包；旧式 JSON 徽标（`{"format":...}`）走原逻辑。
 */
import JSZip from 'jszip';
import { galleryPageNumber } from './utils';

export const GALLERY_PACK_NAME_FILE = '.name';
export const GALLERY_PACK_MAX_PAGES = 2000;

export interface PackImage {
    file: File;
    page: number;
}

export interface CollectedPack {
    /** 所选根目录名（webkitdirectory 第一级；单文件/扁平选择为空） */
    root: string;
    /** 画廊名（.name 内容） */
    name: string;
    /** 按（页码，文件名）排好的图片 */
    images: PackImage[];
    /** 被无视的文件数（统计用，不报错） */
    ignoredFiles: number;
}

/** 文件名做 .gallery 输出名：去非法字符、压空白、限长 */
export const sanitizePackName = (name: string): string => {
    const clean = String(name || '')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
    return clean || '未命名画廊';
};

/**
 * .name 内容校验：有且仅有一行非空字符串。
 * 首尾空白/末尾换行容忍（trim 后内部不许再含换行），否则返回 null。
 */
export const parseNameFileContent = (text: string): string | null => {
    const line = String(text ?? '').trim();
    if (!line || /[\r\n]/.test(line)) return null;
    return line;
};

const relOf = (file: File): string =>
    (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;

const baseOf = (rel: string): string => rel.split('/').pop() || '';

/**
 * 从一批文件（通常是 webkitdirectory 整目录）中按规则收集打包源。
 * 多根目录时优先取“含合法 .name 的根”，否则取第一个含图片的根。
 * 无合法 .name / 无合法图片则抛错（调用方转成用户提示）。
 */
export async function collectPackSources(files: File[]): Promise<CollectedPack> {
    const list = Array.from(files || []).filter((f) => f && typeof f.name === 'string');
    if (list.length === 0) throw new Error('所选目录为空');

    // 根目录分组：只有“根下直接子文件”（depth<=1）参与规则判定
    const byRoot = new Map<string, { rel: string; file: File }[]>();
    for (const file of list) {
        const rel = relOf(file);
        const segs = rel.split('/');
        const depth = segs.length - 1;
        if (depth > 1) continue;
        const root = depth === 1 ? segs[0] : '';
        if (!byRoot.has(root)) byRoot.set(root, []);
        byRoot.get(root)!.push({ rel, file });
    }

    const roots = [...byRoot.keys()].sort((a, b) => a.localeCompare(b, 'zh'));
    // 被无视的文件 = 总入选 - 根下直接子文件（子目录深层文件按规则直接无视）
    const inScope = roots.reduce((n, r) => n + (byRoot.get(r)?.length || 0), 0);
    const ignoredFiles = list.length - inScope;

    // 逐根尝试：先找合法 .name，再找图片
    const attempts: string[] = [];
    for (const root of roots) {
        const group = byRoot.get(root)!;
        const nameCandidates = group
            .filter((g) => baseOf(g.rel) === GALLERY_PACK_NAME_FILE)
            .sort((a, b) => a.rel.localeCompare(b.rel, 'zh'));
        const images: PackImage[] = [];
        for (const g of group) {
            const page = galleryPageNumber(baseOf(g.rel));
            if (page == null) continue;
            images.push({ file: g.file, page });
        }
        images.sort((a, b) => a.page - b.page || a.file.name.localeCompare(b.file.name, 'zh'));
        if (nameCandidates.length === 0) {
            attempts.push(`「${root || '所选文件'}」：缺少 ${GALLERY_PACK_NAME_FILE} 文件`);
            continue;
        }
        let name: string | null = null;
        for (const c of nameCandidates) {
            try {
                name = parseNameFileContent(await c.file.text());
            } catch {
                name = null;
            }
            if (name) break;
        }
        if (!name) {
            attempts.push(`「${root || '所选文件'}」：${GALLERY_PACK_NAME_FILE} 内容不合要求（必须有且仅有一行画廊名）`);
            continue;
        }
        if (images.length === 0) {
            attempts.push(`「${root || '所选文件'}」：没有数字命名的图片（如 1.png、2.jpg）`);
            continue;
        }
        return { root, name, images, ignoredFiles };
    }
    throw new Error(
        attempts.length > 0
            ? `没有符合规则的画廊：${attempts.slice(0, 3).join('；')}`
            : '没有符合规则的文件（需要 .name + 数字命名图片）'
    );
}

/** 打包为单文件 .gallery（ZIP Blob，后缀由调用方定为 .gallery） */
export async function packToGalleryBlob(name: string, images: PackImage[]): Promise<Blob> {
    const zip = new JSZip();
    zip.file(GALLERY_PACK_NAME_FILE, name);
    for (const img of images) {
        zip.file(img.file.name, img.file);
    }
    // 图片本身已压缩，STORE 只组包不重压，又快又不掉画质
    return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

export interface UnpackedGallery {
    name: string;
    pages: PackImage[];
}

/** 前 2 字节是否为 ZIP 魔数 `PK`（含空包/分卷头都放行，后续由 JSZip 校验） */
export async function isGalleryPackFile(file: File): Promise<boolean> {
    try {
        const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
        return head.length === 2 && head[0] === 0x50 && head[1] === 0x4b;
    } catch {
        return false;
    }
}

/**
 * 解包单文件 .gallery：包内找 `.name`（画廊名）+ 数字命名图片。
 * 结构不符（旧 JSON 徽标 / 损坏）返回 null，调用方回落原逻辑。
 */
export async function unpackGalleryPack(file: File): Promise<UnpackedGallery | null> {
    try {
        if (!(await isGalleryPackFile(file))) return null;
        const zip = await JSZip.loadAsync(file);
        const entries = Object.values(zip.files).filter((e) => !e.dir);
        if (entries.length === 0 || entries.length > GALLERY_PACK_MAX_PAGES + 8) return null;

        let name: string | null = null;
        for (const e of entries) {
            const base = e.name.split('/').pop() || '';
            if (base !== GALLERY_PACK_NAME_FILE) continue;
            try {
                const text = await e.async('text');
                const parsed = parseNameFileContent(text);
                if (parsed) {
                    name = parsed;
                    break;
                }
            } catch {
                // 读坏一个 .name 换下一个
            }
        }
        if (!name) return null;

        const pages: PackImage[] = [];
        for (const e of entries) {
            const base = e.name.split('/').pop() || '';
            const page = galleryPageNumber(base);
            if (page == null) continue;
            if (pages.length >= GALLERY_PACK_MAX_PAGES) break;
            try {
                const blob = await e.async('blob');
                pages.push({
                    page,
                    file: new File([blob], base, { type: blob.type || 'application/octet-stream' }),
                });
            } catch {
                // 单页读坏跳过该页
            }
        }
        if (pages.length === 0) return null;
        pages.sort((a, b) => a.page - b.page || a.file.name.localeCompare(b.file.name, 'zh'));
        return { name, pages };
    } catch {
        return null;
    }
}

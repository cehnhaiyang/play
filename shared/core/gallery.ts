/**
 * 画廊：文件夹形态与单文件 .gallery（ZIP 改后缀）。
 *
 * ## 两种形态的取舍
 *
 * **文件夹形态**（用户直接选目录导入）：
 *     我的画廊/
 *         我的画廊.gallery   ← 徽标/清单文件（JSON，可含标题/作者/来源）
 *         1.png
 *         2.jpg
 * 规则：只有「徽标存在 + 至少一张数字命名图片」才认作画廊；
 * 非数字文件名、非图片后缀一律忽略。
 *
 * **单文件 .gallery**（ZIP 改后缀，便于分享）：
 * 输入目录约定：`<root>/.name`（画廊名）+ `<root>/1.png` 数字命名图片。
 * 输出包内：`.name` + 原名图片，STORE 不重压。
 * 导入时按魔数 `PK` 识别单文件包；旧式 JSON 徽标走原逻辑。
 *
 * 需要 DOM（`File` / `Blob` / JSZip 的 Blob 路径）。
 */
import JSZip from 'jszip';
import type {
    CollectedPack,
    DetectedGallery,
    PackImage,
    SplitImportFiles,
    UnpackedGallery,
} from '../meta';
import { IMAGE_EXTENSIONS } from './images';

/** 取路径最后一段（webkitRelativePath 或裸文件名都适用） */
const baseNameOf = (path: string): string => (path || '').split('/').pop() || '';

/** 文件在所选目录里的相对路径（普通选择退化成文件名） */
const relPathOf = (file: File): string =>
    (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;

/** 文件夹相对目录（webkitRelativePath 的目录部分；无则返回 ''） */
export const dirOfFile = (file: File): string => {
    const rel = relPathOf(file);
    const idx = rel.lastIndexOf('/');
    return idx > 0 ? rel.slice(0, idx) : '';
};

/** 是否为画廊徽标文件（*.gallery） */
export const isGalleryMarker = (fileName: string): boolean =>
    /\.gallery$/i.test((fileName || '').trim());

/** 画廊徽标文件名取画廊名（去掉 .gallery 后缀） */
export const galleryNameFromMarker = (fileName: string): string =>
    baseNameOf(fileName).replace(/\.gallery$/i, '').trim() || '未命名画廊';

/**
 * 若是“数字命名 + 图片后缀”返回页码（1-based 整数），否则返回 null。
 * 前导零、空格都接受（"001.png"→1）；小数/负数/非数字一律忽略。
 */
export const galleryPageNumber = (fileName: string): number | null => {
    const base = baseNameOf(fileName);
    const dot = base.lastIndexOf('.');
    if (dot <= 0) return null;
    const stem = base.slice(0, dot).trim();
    if (!IMAGE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase())) return null;
    if (!/^\d+$/.test(stem)) return null;
    const n = parseInt(stem, 10);
    return Number.isSafeInteger(n) && n >= 1 ? n : null;
};

/**
 * 从一批文件（文件/文件夹混合选择）中识别画廊文件夹。
 * 同目录下：徽标存在 + ≥1 张有效图片 ⇒ 成组；其余文件原样归入 loose。
 */
export const detectGalleryFolders = (files: File[]): SplitImportFiles => {
    const galleries: DetectedGallery[] = [];
    const loose: File[] = [];
    const orphanMarkers: File[] = [];

    const byDir = new Map<string, File[]>();
    for (const file of files) {
        const dir = dirOfFile(file);
        const group = byDir.get(dir);
        if (group) group.push(file);
        else byDir.set(dir, [file]);
    }

    for (const [dir, group] of byDir) {
        const markers = group
            .filter((f) => isGalleryMarker(f.name))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        if (markers.length === 0) {
            loose.push(...group);
            continue;
        }
        const pages = group
            .map((f) => ({ file: f, page: galleryPageNumber(f.name) }))
            .filter((p): p is { file: File; page: number } => p.page != null)
            .sort((a, b) => a.page - b.page);
        if (pages.length === 0) {
            // 有徽标无有效图片：整组不认，徽标记为孤立（提示用），其余进 loose
            orphanMarkers.push(...markers);
            loose.push(...group.filter((f) => !isGalleryMarker(f.name)));
            continue;
        }
        const name = galleryNameFromMarker(markers[0].name);
        galleries.push({ groupId: `gallery:${dir}/${name}`, name, dir, pages, marker: markers[0] });
        // 已认定的画廊目录：徽标本身不进播放列表，其余不合规文件（非数字命名/非图片）
        // 按格式约定直接忽略，不散装进 loose
    }

    return { galleries, loose, orphanMarkers };
};

/* ========================================================================== */
/* 单文件 .gallery（ZIP 改后缀）                                              */
/* ========================================================================== */

export const GALLERY_PACK_NAME_FILE = '.name';
export const GALLERY_PACK_MAX_PAGES = 2000;

/**
 * .name 内容校验：有且仅有一行非空字符串。
 * 首尾空白/末尾换行容忍（trim 后内部不许再含换行），否则返回 null。
 */
export const parseNameFileContent = (text: string): string | null => {
    const line = String(text ?? '').trim();
    if (!line || /[\r\n]/.test(line)) return null;
    return line;
};

/** 按页码升序、同页按文件名排（中文序，与资源管理器所见一致） */
const byPageThenName = (a: PackImage, b: PackImage): number =>
    a.page - b.page || a.file.name.localeCompare(b.file.name, 'zh');

/**
 * 从一批文件（通常是 webkitdirectory 整目录）中按规则收集打包源。
 * 多根目录时取**第一个「.name 合法 + 有数字命名图片」的根**（按根名中文序），
 * 全都不合格则抛错，错误里带上前三个根各自缺什么（调用方转成用户提示）。
 */
export const collectPackSources = async (files: File[]): Promise<CollectedPack> => {
    const list = Array.from(files || []).filter((f) => f && typeof f.name === 'string');
    if (list.length === 0) throw new Error('所选目录为空');

    // 根目录分组：只有“根下直接子文件”（depth<=1）参与规则判定
    const byRoot = new Map<string, { rel: string; file: File }[]>();
    for (const file of list) {
        const rel = relPathOf(file);
        const segs = rel.split('/');
        const depth = segs.length - 1;
        if (depth > 1) continue;
        const root = depth === 1 ? segs[0] : '';
        const group = byRoot.get(root);
        if (group) group.push({ rel, file });
        else byRoot.set(root, [{ rel, file }]);
    }

    const roots = [...byRoot.keys()].sort((a, b) => a.localeCompare(b, 'zh'));
    // 被无视的文件 = 总入选 - 根下直接子文件（子目录深层文件按规则直接无视）
    const inScope = roots.reduce((n, r) => n + (byRoot.get(r)?.length || 0), 0);
    const ignoredFiles = list.length - inScope;

    // 逐根尝试：先找合法 .name，再找图片。
    // 每个根只报**第一条**不满足的规则，顺序即用户看到的提示优先级，不能调换。
    const attempts: string[] = [];
    for (const root of roots) {
        const group = byRoot.get(root)!;
        const label = `「${root || '所选文件'}」`;
        const nameCandidates = group
            .filter((g) => baseNameOf(g.rel) === GALLERY_PACK_NAME_FILE)
            .sort((a, b) => a.rel.localeCompare(b.rel, 'zh'));
        if (nameCandidates.length === 0) {
            attempts.push(`${label}：缺少 ${GALLERY_PACK_NAME_FILE} 文件`);
            continue;
        }

        // 同一根下可能有多个 .name（历史残留），取第一个内容合法的
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
            attempts.push(`${label}：${GALLERY_PACK_NAME_FILE} 内容不合要求（必须有且仅有一行画廊名）`);
            continue;
        }

        const images: PackImage[] = [];
        for (const g of group) {
            const page = galleryPageNumber(baseNameOf(g.rel));
            if (page != null) images.push({ file: g.file, page });
        }
        images.sort(byPageThenName);
        if (images.length === 0) {
            attempts.push(`${label}：没有数字命名的图片（如 1.png、2.jpg）`);
            continue;
        }

        return { root, name, images, ignoredFiles };
    }

    throw new Error(
        attempts.length > 0
            ? `没有符合规则的画廊：${attempts.slice(0, 3).join('；')}`
            : '没有符合规则的文件（需要 .name + 数字命名图片）',
    );
};

/** 打包为单文件 .gallery（ZIP Blob，后缀由调用方定为 .gallery） */
export const packToGalleryBlob = async (name: string, images: PackImage[]): Promise<Blob> => {
    const zip = new JSZip();
    zip.file(GALLERY_PACK_NAME_FILE, name);
    for (const img of images) zip.file(img.file.name, img.file);
    // 图片本身已压缩，STORE 只组包不重压，又快又不掉画质
    return zip.generateAsync({ type: 'blob', compression: 'STORE' });
};

/** 前 2 字节是否为 ZIP 魔数 `PK`（含空包/分卷头都放行，后续由 JSZip 校验） */
export const isGalleryPackFile = async (file: File): Promise<boolean> => {
    try {
        const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
        return head.length === 2 && head[0] === 0x50 && head[1] === 0x4b;
    } catch {
        return false;
    }
};

/**
 * 解包单文件 .gallery：包内找 `.name`（画廊名）+ 数字命名图片。
 * 结构不符（旧 JSON 徽标 / 损坏）返回 null，调用方回落原逻辑。
 */
export const unpackGalleryPack = async (file: File): Promise<UnpackedGallery | null> => {
    try {
        if (!(await isGalleryPackFile(file))) return null;
        const zip = await JSZip.loadAsync(file);
        const entries = Object.values(zip.files).filter((e) => !e.dir);
        if (entries.length === 0 || entries.length > GALLERY_PACK_MAX_PAGES + 8) return null;

        let name: string | null = null;
        for (const e of entries) {
            if (baseNameOf(e.name) !== GALLERY_PACK_NAME_FILE) continue;
            try {
                name = parseNameFileContent(await e.async('text'));
            } catch {
                name = null;
            }
            if (name) break;
        }
        if (!name) return null;

        const pages: PackImage[] = [];
        for (const e of entries) {
            if (pages.length >= GALLERY_PACK_MAX_PAGES) break;
            const base = baseNameOf(e.name);
            const page = galleryPageNumber(base);
            if (page == null) continue;
            try {
                const blob = await e.async('blob');
                pages.push({ page, file: new File([blob], base, { type: blob.type || 'application/octet-stream' }) });
            } catch {
                // 单页读坏跳过该页
            }
        }
        if (pages.length === 0) return null;
        pages.sort(byPageThenName);
        return { name, pages };
    } catch {
        return null;
    }
};

/**
 * 播放条目的构造与资源释放。
 *
 * 需要 DOM：`File` / `Blob` / `URL.createObjectURL` / `document`。
 * 只在 Electron 渲染层用 —— 插件侧不持有本地文件，也不管播放。
 */
import type { MediaType, VideoFile } from '../meta';
import { generateId } from './ids';
import { getMediaType } from './media';

/** 封装本地文件对象为播放器可用的数据结构 */
export const createVideoFile = (file: File, folder?: string): VideoFile => {
    const item: VideoFile = {
        id: generateId(),
        file,
        url: URL.createObjectURL(file),
        name: file.name,
        type: 'file',
        mediaType: getMediaType(file.name, file.type),
    };
    if (folder) item.folder = folder;
    return item;
};

/** 封装网络流媒体链接（extra 用于透出封面、艺术家等附加字段） */
export const createStreamFile = (
    url: string,
    name?: string,
    mediaType?: MediaType,
    extra?: Partial<VideoFile>,
): VideoFile => {
    const fileName = name || `Resource ${generateId()}`;
    return {
        id: generateId(),
        url,
        name: fileName,
        type: 'stream',
        mediaType: mediaType || getMediaType(fileName, undefined, url),
        ...extra,
    };
};

/**
 * 清理资源，防止内存泄漏：释放 `URL.createObjectURL` 创建的 Blob URL。
 *
 * 判据是「URL 是不是 blob:」而不是「条目 type 是不是 file」：
 * .aibook 绘本页由 data URL 转成 blob: 后以 stream 条目入列（没有本地 File），
 * 旧判据会把这些 Blob 全部漏掉，反复导入导出绘本会持续吃内存。
 */
export const revokeVideoFile = (videoFile: VideoFile): void => {
    if (videoFile.url && videoFile.url.startsWith('blob:')) {
        URL.revokeObjectURL(videoFile.url);
    }
};

/**
 * 触发一次"下载文件"（音频工程包导出 / 画廊与绘本另存回退 / Agent 会话导出共用）。
 *
 * 原先三处各写一份，差异只在 revoke 时机与是否入文档 —— 而这两点写错都不报错：
 * 前者表现为"下载到一半失败"，后者表现为"点了没反应"。统一成一份之后，
 * 只剩这一个地方需要被盯住。两个细节都是有意的：
 *
 * - **入文档再点**：游离节点在部分内核上不触发下载；
 * - **延迟 revoke**：`click()` 只是发起导航，Chromium 是异步读 Blob 的，
 *   紧接着 revoke 有概率拿到已回收的 URL。留一拍再释放更稳，
 *   5 秒对用户无感（文件此时早已落盘）。
 *
 * Electron 下这次下载走渲染层自己的 blob URL，不经过主进程的下载拦截
 * （浏览器外壳拆除后，应用里已经没有 will-download 接管了）。
 */
export const downloadBlob = (blob: Blob, fileName: string): void => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
};

/**
 * 图片编解码：data URL ⇄ File / Blob URL。
 *
 * ## 需要 DOM
 *
 * `FileReader` / `File` / `Blob` / `URL.createObjectURL` 在插件 service worker 里
 * 都不存在。这一层只在**有 DOM 的宿主**里用，目前只有 Electron 渲染层。
 * service worker 侧要处理图片时走 `fetch` + `arrayBuffer`，不要 import 这里。
 */
import { MEDIA_EXTENSIONS } from './media';

/**
 * data URL 拆成 `{ mimeType, base64 }`。
 * 非 data URL（http/blob）返回 null —— 调用方需自行先取回字节。
 */
export const splitDataUrl = (dataUrl: string): { mimeType: string; base64: string } | null => {
    const match = String(dataUrl || '').match(/^data:([^;,]*);base64,(.*)$/s);
    if (!match) return null;
    return { mimeType: match[1] || 'image/png', base64: match[2] || '' };
};

/** File → data URL */
export const fileToDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(`图片读取失败：${file.name}`));
    reader.readAsDataURL(file);
});

/**
 * 任意图片来源 → data URL。
 * 已经是 data URL 的原样返回；blob/http 取回字节再编码。
 */
export const toDataUrl = async (source: File | string): Promise<string> => {
    if (typeof source !== 'string') return fileToDataUrl(source);
    const text = source.trim();
    if (!text) throw new Error('图片地址为空');
    if (text.startsWith('data:')) return text;
    const response = await fetch(text);
    if (!response.ok) throw new Error(`图片获取失败（HTTP ${response.status}）`);
    const blob = await response.blob();
    return fileToDataUrl(new File([blob], 'page.png', { type: blob.type || 'image/png' }));
};

/**
 * data URL → Blob URL。
 *
 * 播放列表里的条目一律用 Blob URL（CSP 与 `<img>` 都友好，且能被
 * `revokeVideoFile` 统一回收）；data URL 直接塞进 `<img>` 在长图下会撑爆内存。
 * 内容不是合法 data URL 时返回空串，调用方按"没有图"处理。
 */
export const dataUrlToBlobUrl = (dataUrl: string): string => {
    const split = splitDataUrl(dataUrl);
    if (!split) return '';
    try {
        const binary = atob(split.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return URL.createObjectURL(new Blob([bytes], { type: split.mimeType }));
    } catch {
        return '';
    }
};

/** 图片后缀集合（由 MEDIA_EXTENSIONS 反查，保证与播放器判断一致） */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(
    Object.entries(MEDIA_EXTENSIONS).filter(([, v]) => v === 'image').map(([k]) => k),
);

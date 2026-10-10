/**
 * 插件内部的消息协议（侧边栏 ↔ service worker）。
 *
 * 与 `meta/bridge.ts` 的 `BridgeRequest` **不是一回事**，刻意分开：
 *
 *   · 这里走 `chrome.runtime.sendMessage`，同进程内，消息不会被序列化截断，
 *     也没有 native messaging 的 1MB 上限；
 *   · `BridgeRequest` 走 native messaging 到本机应用，是跨进程的，
 *     要分片、要版本握手。
 *
 * 混用一套类型会让"这个字段能不能放"变成看运气 —— 在插件内部随手塞一张
 * base64 图片没问题，同样的代码走桥就会静默失败。
 */
import type { MediaType } from '../../../meta';

/**
 * 一条嗅探结果。
 *
 * 形状与 `meta/interface.ts` 的 `FoundLink` 对齐（`source` 固定 'network'），
 * 这样将来交给播放器时不需要再转一次。
 */
export interface SniffedMedia {
    url: string;
    title: string;
    type: MediaType;
    ext: string;
    source: 'network';
    /** 防盗链 Referer。Chrome 的 webRequest **不提供** referrer，靠请求头捕获 */
    referer?: string;
    /** 发起该请求的页面地址 */
    pageUrl?: string;
    /** 发现时间（毫秒时间戳），列表按它倒序 */
    foundAt: number;
}

/** 侧边栏 → service worker */
export type PanelRequest =
    | { kind: 'sniffer-set-enabled'; enabled: boolean }
    | { kind: 'sniffer-get-state' }
    | { kind: 'sniffer-clear' }
    | { kind: 'cookies-get'; url: string }
    | { kind: 'cookies-remove'; url: string; name: string }
    | { kind: 'downloads-list' }
    | { kind: 'downloads-action'; id: number; action: 'pause' | 'resume' | 'cancel' | 'erase' | 'show' }
    | { kind: 'downloads-start'; url: string; filename?: string };

/** service worker → 侧边栏 */
export type PanelEvent =
    | { kind: 'sniffed-media'; item: SniffedMedia }
    | { kind: 'sniffer-state'; enabled: boolean; items: SniffedMedia[] };

/** 统一回包。失败也要有回包 —— 否则面板会一直转圈 */
export interface PanelResponse<T = unknown> {
    ok: boolean;
    result?: T;
    error?: string;
}

/** 嗅探列表上限。超过后丢最旧的：这是工作列表不是归档 */
export const MAX_SNIFFED_ITEMS = 500;

/** 同一 URL 在这个窗口内不重复推送（毫秒） */
export const SNIFF_DEDUP_MS = 5000;

/** chrome.storage 键名 */
export const STORAGE_KEYS = {
    /** 嗅探总开关。放 local：用户希望它跨浏览器重启保持 */
    SNIFFER_ENABLED: 'snifferEnabled',
    /** 嗅探结果。放 session：SW 会被回收，但结果不该活过浏览器重启 */
    SNIFFED_ITEMS: 'sniffedItems',
} as const;

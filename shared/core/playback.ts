/**
 * 播放态判定：当前这个条目"能不能播、能不能翻页"。
 *
 * ## 为什么这些判据必须集中在一处
 *
 * 每一条都同时被**逻辑层**与**UI 层**读，两边各写一份必然漂移，而漂移的表现
 * 都是"界面显示的状态与实际行为对不上"：
 *
 *  - `isSlideshowMedia`：播放器的轮播 effect（什么时候该自动翻页）读它；
 *  - `isPlayableMedia`：入列过滤读它 —— 主窗口收推送时筛一道、嗅探球推之前筛一道；
 *  - `canPlayback`：播放键可用性 + `togglePlay()` 返回值 + 轮播末项守卫，**三处**读它。
 *
 * 与 DOM 无关：插件侧也要判（画廊/文档在插件里同样存在）。
 */
import type { MediaType } from '../meta';

/**
 * 是否为「幻灯片」型媒体：没有 video 元素，播放态即自动轮播开关。
 *
 * 只有图集算：轮播只为图集实现，把文档算进来会让它一打开就进播放态却永不翻页，
 * 而控制条因「正在播放」自动隐藏 —— 用户面对静止的文档找不到控制条。文档是
 * 逐行读的，自动翻页本来也会打断阅读。画廊占位/other 是纯静态页，同理不算。
 */
export const isSlideshowMedia = (mediaType: MediaType | undefined): boolean => mediaType === 'image';

/**
 * 是否有「播放态」：音视频/流，以及幻灯片轮播的图集。
 *
 * 文档、画廊占位、other 都没有播放态 —— 底栏的播放键对它们点了没反应。
 * 与 {@link isPagedMedia} 的差别正好落在文档上：文档能翻页，但不能播放。
 */
export const isPlayableMedia = (mediaType: MediaType | undefined): boolean =>
    mediaType === 'video' || mediaType === 'stream' || mediaType === 'audio' || isSlideshowMedia(mediaType);

/** 是否为分页媒体（翻页而非快进）：图集与文档 */
export const isPagedMedia = (mediaType: MediaType | undefined): boolean =>
    mediaType === 'image' || mediaType === 'document';

/**
 * 当前条目的播放态是否真的能生效。
 *
 * 比 {@link isPlayableMedia} 多问一句「有没有推进的可能」：幻灯片靠翻到下一页
 * 前进，已经在末项时播放态无从生效 —— 轮播 effect 会在同一帧把它按回暂停，
 * 于是播放键亮着却按不出结果，提示还会先报一句「播放中」再原地变回暂停。
 */
export const canPlayback = (
    mediaType: MediaType | undefined,
    currentIndex: number,
    fileCount: number,
): boolean => {
    if (!isPlayableMedia(mediaType)) return false;
    if (isSlideshowMedia(mediaType)) return currentIndex < fileCount - 1;
    return true;
};

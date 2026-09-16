import type {
    MediaType,
    VideoSourceType,
    PlaybackMode,
    ObjectFitMode,
    ExpandedOscillatorType,
    AcgCategory,
    MediaSourceChannel,
    MediaGroupType,
    LFOTarget,
    ArpPattern,
    MessageRole,
    StorageType,
    GalleryDownloadStatus,
    GalleryFetchStatus,
} from './type';

/**
 * ============================================================================
 * 1. 核心媒体与资源接口
 * ============================================================================
 */

/**
 * 播放器核心视频/媒体文件数据结构
 */
export interface VideoFile {
    /** 唯一标识符 (UUID 或时间戳 hash) */
    id: string;
    /** 本地文件 File 句柄 (可选，由本地上传或拖拽注入) */
    file?: File;
    /** 媒体访问 URL (Blob URL、本地虚拟协议路径或远程 HTTP/HLS 地址) */
    url: string;
    /** 媒体名称/标题展示 */
    name: string;
    /** 资源载体类型 ('file' 本地文件或 'stream' 在线流) */
    type: VideoSourceType;
    /** 媒体分类 ('video' | 'audio' | 'image' | 'stream' | 'document' | 'other') */
    mediaType: MediaType;
    /** 描述信息/附加说明 */
    description?: string;
    /** 内嵌或缓存的 Base64 音频/数据 */
    audioData?: string;
    /** 所属分组 ID */
    groupId?: string;
    /** 所属分组显示名称 */
    groupName?: string;
    /** 分组类型 ('ai-book' | 'folder' | 'gallery') */
    groupType?: MediaGroupType;
    /** 相对文件夹路径（文件夹导入时携带，如 a/b，用于侧边栏文件夹树） */
    folder?: string;

    // 丰富 ACG 多媒体元数据
    /** 是否为动图画册 (如含有 WebP 动图/GIF/APNG) */
    isAnimated?: boolean;
    /** 图集页码（ACG 画廊推送时携带，用于有序合并与断点续抓） */
    page?: number;
    /** 视频封面/海报图 URL */
    poster?: string;
    /** 作者/创作者/画师名称 */
    artist?: string;
    /** ACG 细分大类 ('manga' | 'animated_gallery' | 'animation' | 'asmr') */
    acgCategory?: AcgCategory;
}

/**
 * 网络嗅探器截获的媒体资源信息
 */
export interface FoundLink {
    /** 嗅探到的媒体直链 URL */
    url: string;
    /** 资源标题或从页面提取的名称 */
    title: string;
    /** 媒体类别 */
    type: MediaType;
    /** 文件扩展名 (如 mp4, m3u8, png) */
    ext: string;
    /** 嗅探来源渠道 ('local' | 'ai' | 'network') */
    source: MediaSourceChannel;
    /** 触发嗅探的宿主页面 URL */
    pageUrl?: string;
    /** 请求该资源所需的 Referer 头，用于防盗链处理 */
    referer?: string;
}

/**
 * 调用 Electron 媒体下载服务入参
 */
export interface DownloadMediaParams {
    /** 目标下载地址 */
    url: string;
    /** 保存的文件名或显示标题 */
    title: string;
    /** 媒体资源类型 */
    type: MediaType;
    /** 文件扩展名 */
    ext: string;
    /** 防盗链 HTTP Referer */
    referer?: string;
}

/**
 * 媒体下载任务返回结果
 */
export interface DownloadMediaResult {
    /** 是否启动/下载成功 */
    success: boolean;
    /** 提示或状态消息 */
    message: string;
    /** 下载成功后的本地保存绝对路径 */
    filePath?: string;
}

/**
 * 宿主环境下载与转码能力
 */
export interface DownloadCapabilities {
    /** FFmpeg 是否在本地系统中可用 */
    ffmpegAvailable: boolean;
    /** FFmpeg 状态或版本说明信息 */
    ffmpegMessage: string;
}

/**
 * 内置浏览器书签数据项
 */
export interface Bookmark {
    /** 书签唯一 ID */
    id: string;
    /** 网页地址 */
    url: string;
    /** 网页标题 */
    title: string;
    /** 网站 Favicon 图标地址或 Base64 */
    icon?: string;
    /** 创建时间戳 (毫秒) */
    createdAt: number;
}

/**
 * ============================================================================
 * 2. 播放器状态与配置接口
 * ============================================================================
 */

/**
 * 播放器全局运行状态
 */
export interface PlayerState {
    /** 是否正在播放 */
    isPlaying: boolean;
    /** 是否处于缓冲等待状态 */
    isBuffering: boolean;
    /** 当前音量大小 (0 ~ 1) */
    volume: number;
    /** 当前播放进度时刻 (单位: 秒) */
    currentTime: number;
    /** 媒体总时长 (单位: 秒) */
    duration: number;
    /** 是否静音 */
    isMuted: boolean;
    /** 循环/轮播模式 (ListLoop, SingleLoop, Random, StopAfter) */
    playbackMode: PlaybackMode;
    /** 播放速率倍速 (如 0.5, 1.0, 1.25, 1.5, 2.0) */
    playbackRate: number;
    /** 渲染缩放模式 ('contain' | 'cover' | 'fill') */
    objectFit: ObjectFitMode;
    /** 是否处于全屏模式 */
    isFullscreen: boolean;
    /** 是否处于画中画 (PiP) 模式 */
    isPip: boolean;
}

/**
 * 播放器播放列表状态
 */
export interface PlaylistState {
    /** 当前列表中的媒体项数组 */
    files: VideoFile[];
    /** 当前选中的媒体索引位置 (-1 为未选中) */
    currentIndex: number;
}

/**
 * ============================================================================
 * 3. 音频引擎接口与音效/音序联合类型
 * ============================================================================
 */

/**
 * 已生成/合成音频的统计分析指标
 */
export interface AudioStats {
    /** 音频总时长 (秒) */
    duration: number;
    /** 采样率 (Hz，如 44100, 48000) */
    sampleRate: number;
    /** 声道数 (1 单声道, 2 立体声) */
    channels: number;
    /** 均方根电平能量 (RMS) */
    rms: number;
    /** 峰值电平 (Peak Amplitude, 0 ~ 1) */
    peak: number;
}

/**
 * 音频语法解析错误信息
 */
export interface ParserError {
    /** 详细错误描述 */
    message: string;
    /** 发生错误的乐谱脚本行号 */
    line: number;
}

/**
 * ADSR 振幅/滤波包络定义 (单位均为秒，Sustain 为电平比例)
 */
export interface Envelope {
    /** 起音时间 (Attack time, 秒) */
    attack: number;
    /** 衰减时间 (Decay time, 秒) */
    decay: number;
    /** 维持电平比例 (Sustain level, 0 ~ 1) */
    sustain: number;
    /** 释音时间 (Release time, 秒) */
    release: number;
}

/**
 * 双二阶双极点滤波器配置
 */
export interface FilterDef {
    /** 滤波器类型 (lowpass, highpass, bandpass 等) */
    type: BiquadFilterType;
    /** 截止频率或中心频率 (Hz) */
    frequency: number;
    /** 品质因数 Q 值 (共振峰尖锐度) */
    Q: number;
}

/**
 * 低频振荡器 (LFO) 调制配置
 */
export interface LFODef {
    /** LFO 波形 (sine, square, sawtooth, triangle) */
    type: OscillatorType;
    /** LFO 振荡调制速率 (Hz) */
    frequency: number;
    /** 调制深度与强度 */
    amount: number;
    /** 调制受控参数 ('frequency' | 'filter' | 'gain' | 'pan') */
    target: LFOTarget;
}

/**
 * 延迟回声效果器配置
 */
export interface DelayEffectDef {
    type: 'delay';
    /** 延迟时间 (秒) */
    time: number;
    /** 反馈系数 (0 ~ 1) */
    feedback: number;
    /** 干湿比 (0 ~ 1) */
    mix: number;
}

/**
 * 混响空间效果器配置
 */
export interface ReverbEffectDef {
    type: 'reverb';
    /** 混响尾音衰减时间 (秒) */
    decay: number;
    /** 干湿比 (0 ~ 1) */
    mix: number;
}

/**
 * 破音/失真效果器配置
 */
export interface DistortionEffectDef {
    type: 'distortion';
    /** 过载与失真程度数值 */
    amount: number;
}

/**
 * 音频效果器联合类型 (包含 Delay, Reverb, Distortion)
 */
export type EffectDef = DelayEffectDef | ReverbEffectDef | DistortionEffectDef;

/**
 * 乐器音色定义契约
 */
export interface InstrumentDef {
    /** 乐器唯一名称标识 */
    name: string;
    /** 主振荡器波形类型 */
    wave: ExpandedOscillatorType;
    /** 振幅 ADSR 包络 */
    envelope: Envelope;
    /** 滤波器配置 (可选) */
    filter?: FilterDef;
    /** 滤波器专用 ADSR 包络 (可选) */
    filterEnvelope?: Envelope;
    /** 滤波包络调制深度 (可选) */
    filterEnvAmount?: number;
    /** LFO 调制配置 (可选) */
    lfo?: LFODef;
    /** 声像位置 (-1 左声道 ~ 1 右声道，可选) */
    pan?: number;
    /** 基础增益音量 (0 ~ 1) */
    gain: number;
    /** 调频合成 (FM) 调制波形 (可选) */
    fm_wave?: ExpandedOscillatorType;
    /** 调频调制深度指数 (可选) */
    fm_index?: number;
    /** 调频频率比率 (可选) */
    fm_ratio?: number;
    /** 音调微调音分 (Detune, 单位: cents，可选) */
    detune?: number;
}

/**
 * 单音音符指令
 */
export interface NoteCommand {
    type: 'note';
    /** 音高记号 (如 'C4', 'F#5', 'Bb3') */
    pitch: string;
    /** 时值记号 (如 '4n', '8n', '16n', '1m') */
    duration: string;
}

/**
 * 和弦指令 (多音齐鸣)
 */
export interface ChordCommand {
    type: 'chord';
    /** 构成和弦的音高数组 (如 ['C4', 'E4', 'G4']) */
    pitches: string[];
    /** 和弦发声时值 */
    duration: string;
}

/**
 * 琶音指令
 */
export interface ArpCommand {
    type: 'arp';
    /** 琶音基础音阶或和弦音高数组 */
    pitches: string[];
    /** 扫描形态 ('up' | 'down' | 'upDown' | 'random') */
    pattern: ArpPattern;
    /** 琶音每个单音触发速率 (如 '16n') */
    rate: string;
    /** 琶音总持续时长 */
    duration: string;
}

/**
 * 休止符指令
 */
export interface RestCommand {
    type: 'rest';
    /** 休止时长 */
    duration: string;
}

/**
 * 音序事件指令联合类型
 */
export type SequenceCommand = NoteCommand | RestCommand | ChordCommand | ArpCommand;

/**
 * 音序轨道定义
 */
export interface SequenceDef {
    /** 轨道名称 */
    name: string;
    /** 指定演奏该轨道的乐器名称 */
    instrumentName: string;
    /** 轨道包含的音符与控制指令列表 */
    commands: SequenceCommand[];
}

/**
 * 经调度器计算生成的精准时钟发声事件
 */
export interface ScheduledEvent {
    /** 触发时间刻 (秒) */
    time: number;
    /** 音频频率 (Hz) */
    freq: number;
    /** 发声持续时间 (秒) */
    duration: number;
    /** 振荡器波形 */
    wave: ExpandedOscillatorType;
    /** 振幅 ADSR 包络 */
    envelope: Envelope;
    /** 滤波器设置 (可选) */
    filter?: FilterDef;
    /** 滤波 ADSR 包络 (可选) */
    filterEnvelope?: Envelope;
    /** 滤波调制量 (可选) */
    filterEnvAmount?: number;
    /** LFO 调制 (可选) */
    lfo?: LFODef;
    /** 声像位置 (可选) */
    pan?: number;
    /** 音量增益 (0 ~ 1) */
    gain: number;
    /** FM 调制波形 (可选) */
    fm_wave?: ExpandedOscillatorType;
    /** FM 调制深度 (可选) */
    fm_index?: number;
    /** FM 调频比率 (可选) */
    fm_ratio?: number;
    /** 音调微调 (可选) */
    detune?: number;
}

/**
 * ============================================================================
 * 4. 项目与持久化接口
 * ============================================================================
 */

/**
 * AI 助手对话消息
 */
export interface Message {
    /** 消息发送方角色 ('user' | 'model' | 'system') */
    role: MessageRole;
    /** 消息正文文本 */
    content: string;
    /** 发送时间戳 (毫秒) */
    timestamp: number;
}

/**
 * 音频工作台工程项目
 */
export interface Project {
    /** 项目唯一 ID */
    id: string;
    /** 项目名称 */
    name: string;
    /** 乐谱及合成 DSL 脚本代码 */
    code: string;
    /** 项目关联的 AI 聊天会话历史 */
    messages: Message[];
    /** 创建时间戳 */
    createdAt: number;
    /** 最近修改时间戳 */
    lastModified: number;
}

/**
 * ============================================================================
 * 5. 网络篡改与存储工具接口
 * ============================================================================
 */

/**
 * 响应数据拦截与篡改规则
 */
export interface TamperRule {
    /** 规则唯一 ID */
    id?: string;
    /** 规则是否启用生效 */
    enabled: boolean;
    /** 匹配的网络 URL 正则或 Glob 通配模式 */
    urlPattern: string;
    /** 需要修改的 JSONPath 路径表达式 */
    jsonPath: string;
    /** 篡改后的替换目标新值 (JSON 字符串或纯文本) */
    newValue: string;
}

/**
 * HTTP 请求头篡改/注入规则
 */
export interface HeaderRule {
    /** 规则唯一 ID */
    id?: string;
    /** 是否启用 */
    enabled: boolean;
    /** 匹配的目标 URL 规则 */
    urlPattern: string;
    /** 目标 Header 键名 (如 Referer, User-Agent, Authorization) */
    headerName: string;
    /** 注入或覆盖的 Header 值 */
    headerValue: string;
}

/**
 * 浏览器存储条目项
 */
export interface StorageItem {
    /** 存储键名 */
    key: string;
    /** 存储内容值 */
    value: string;
    /** 存储载体类型 ('cookie' | 'local' | 'session') */
    type: StorageType;
}

/**
 * ============================================================================
 * 6. Webview 与 Electron 桌面环境接口 (不使用 declare global，显式强类型契约)
 * ============================================================================
 */

/**
 * Electron `<webview>` 原生宿主标签契约接口
 */
export interface WebviewElement extends HTMLElement {
    /** 当前浏览地址 */
    src: string;
    /** 注册事件监听 */
    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
    /** 注销事件监听 */
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
    /** 重新加载当前页面 */
    reload(): void;
    /** 获取当前 Webview URL */
    getURL(): string;
    /** 导航加载指定 URL */
    loadURL(url: string): Promise<void>;
    /** 页面后退 */
    goBack(): void;
    /** 页面前进 */
    goForward(): void;
    /** 是否允许后退 */
    canGoBack(): boolean;
    /** 是否允许前进 */
    canGoForward(): boolean;
    /** 在 Webview 宿主上下文中执行 JavaScript 脚本 */
    executeJavaScript(code: string): Promise<any>;
    /** 是否允许弹窗属性 */
    allowpopups?: string;
    /** webpreferences 配置字符串 */
    webpreferences?: string;
}

/**
 * 内置浏览画廊：频道定义（与主进程 acgmhoService.GALLERY_CHANNELS 对齐）
 */
export type AcgmhoChannelKind = 'image' | 'video' | 'audio' | 'mixed';

export interface AcgmhoChannelDef {
  /** 频道 id：latest | hot | manga | album | animation | hanime | asmr | cosplay | webtoon | western */
  id: string;
  /** 中文展示名 */
  label: string;
  /** 站点路径前缀 */
  base: string;
  /** 内容主类型（cosplay 为图文视频混排） */
  kind: AcgmhoChannelKind;
}

/**
 * 画廊列表条目（封面流）
 */
export interface AcgmhoGalleryItem {
  /** 作品数字 ID */
  gid: string;
  /** 详情页完整地址 */
  url: string;
  /** 标题 */
  title: string;
  /** 封面直链（可能为空） */
  cover: string;
  /** 上架日期文本 */
  date?: string;
  /** 语言 */
  lang?: string;
  /** 标签/分类 */
  tag?: string;
  /** 页数文本（漫画系） */
  pages?: string;
  /** 观看数（视频系） */
  views?: string;
  /** 时长（视频/音频） */
  duration?: string;
  /** 作者/社团（有声） */
  artist?: string;
  /** 站点前缀 h | hentai | gif | hanime | asmr | cos | webtoon | western */
  prefix: string;
  /** 条目媒体类型 */
  kind: 'image' | 'video' | 'audio';
  /** 所属频道 id */
  channel: string;
}

export interface AcgmhoChannelListResult {
  channelId: string;
  page: number;
  hasMore: boolean;
  items: AcgmhoGalleryItem[];
}

/**
 * Electron 注入到渲染层的 ACGMHO 专属画册下载与爬虫 API
 */
export interface ElectronAcgmhoAPI {
    /** 探测画册基础信息及元数据 */
    probe: (gidOrUrl: string) => Promise<GalleryProbeResult>;
    /** 频道表（内置浏览画廊左侧分类） */
    channels: () => Promise<AcgmhoChannelDef[]>;
    /** 频道列表（分页）：{ channelId, page } */
    channelList: (options: { channelId: string; page?: number }) => Promise<{ success: boolean; message?: string } & AcgmhoChannelListResult>;
    /** 开启画册批量下载任务 */
    startDownload: (options: GalleryDownloadOptions) => Promise<{
        success: boolean;
        message: string;
        outDir?: string;
        manifestPath?: string;
    }>;
    /** 取消指定 gid 的下载任务 */
    cancelDownload: (gid: string) => Promise<void>;
    /** 调用系统管理器打开下载目录 */
    openFolder: (folderPath: string) => Promise<void>;
    /** 监听下载进度更新事件，返回取消订阅函数 */
    onProgress: (callback: (progress: GalleryDownloadProgress) => void) => () => void;
    /** 分页抓取画册图片页面元数据列表（单飞：同 gid 新 run 会取消旧 run，调用方用 runId 辨别过期回包） */
    fetchPages: (options: { gidOrUrl: string; pages?: string; delayMs?: number; runId?: string; skipPages?: number[]; probe?: GalleryProbeResult }) => Promise<{
        gid: string;
        title: string;
        totalPages: number;
        pages: GalleryPageItem[];
        /** 本轮最终失败的页（已重试过），可凭此重试失败页 */
        errors?: { page: number; error: string }[];
        runId?: string;
    }>;
    /** 取消分页抓取任务（传 runId 则只取消匹配的 run，防误杀新任务） */
    cancelFetchPages: (gid: string, runId?: string) => Promise<void>;
    /** 监听抓取进度事件，返回取消订阅函数 */
    onFetchProgress: (callback: (progress: GalleryFetchProgress) => void) => () => void;
}

/**
 * Sukebei / Nyaa 搜索结果条目（与主进程 sukebeiService 对齐）
 */
export interface SukebeiItem {
    /** 详情页数字 ID */
    id: string;
    /** 资源标题 */
    title: string;
    /** 详情页相对路径，如 /view/4712759 */
    view: string;
    /** 详情页完整地址 */
    viewUrl: string;
    /** .torrent 直链 */
    torrent: string;
    /** magnet 链接（可能为空） */
    magnet: string;
    /** 体积文本，如 709.4 MiB */
    size: string;
    /** 发布日期 */
    date: string;
    /** 做种数（未知为 -1） */
    seeders: number;
    /** 吸血数（未知为 -1） */
    leechers: number;
    /** 完成数（未知为 -1） */
    completed: number;
    /** 分类文本 */
    category: string;
    /** 来源站点 sukebei | nyaa */
    site: string;
}

export interface SukebeiSearchOptions {
    site?: string;
    q: string;
    category?: string;
    filter?: string;
    sort?: string;
    pages?: number;
    minSeeders?: number;
}

/**
 * 内置 BT 任务快照（与主进程 torrentService 对齐）
 */
export type TorrentTaskStatus = 'metadata' | 'downloading' | 'seeding' | 'paused' | 'error';

export interface TorrentFileInfo {
    index: number;
    name: string;
    path: string;
    length: number;
}

export interface TorrentTaskSnapshot {
    id: string;
    name: string;
    status: TorrentTaskStatus;
    /** 0~1 */
    progress: number;
    downloaded: number;
    total: number;
    downloadSpeed: number;
    uploadSpeed: number;
    numPeers: number;
    etaMs: number;
    files: TorrentFileInfo[];
    outDir: string;
    error: string;
}

export interface TorrentStartOptions {
    magnet?: string;
    torrentPath?: string;
    torrentUrl?: string;
    site?: string;
    name?: string;
    outDir?: string;
    /** 只下载指定文件索引，为空 = 全下 */
    fileIndexes?: number[];
    /** 手动指定 peer（如 ['127.0.0.1:6881']），本机联调或 tracker 全挂时兜底 */
    addPeers?: string[];
}

/**
 * Electron 注入到渲染层的 Sukebei 搜索与种子 API
 */
export interface ElectronSukebeiAPI {
    /** 关键词搜索，返回条目列表 */
    search: (options: SukebeiSearchOptions) => Promise<{ success: boolean; message?: string; items: SukebeiItem[] }>;
    /** 只下载 .torrent 种子文件（不下正片） */
    getTorrent: (options: { site?: string; id?: string; torrentUrl?: string; title?: string; outDir?: string }) => Promise<{ success: boolean; message?: string; path?: string; bytes?: number }>;
}

/**
 * Electron 注入到渲染层的内置 BT 下载引擎 API
 */
export interface ElectronTorrentAPI {
    /** 启动下载任务（magnet / torrentPath / torrentUrl 至少其一）；重复添加返回既有任务并置 duplicate */
    start: (options: TorrentStartOptions) => Promise<{ success: boolean; message?: string; taskId?: string; outDir?: string; duplicate?: boolean }>;
    /** 取消任务（默认同时删除未完成文件） */
    cancel: (taskId: string, deleteFiles?: boolean) => Promise<{ success: boolean; message?: string }>;
    /** 暂停任务 */
    pause: (taskId: string) => Promise<{ success: boolean; message?: string }>;
    /** 恢复任务 */
    resume: (taskId: string) => Promise<{ success: boolean; message?: string }>;
    /** 当前全部任务快照 */
    tasks: () => Promise<TorrentTaskSnapshot[]>;
    /** 打开任务目录（传 taskId 或目录路径） */
    openFolder: (target: string) => Promise<{ success: boolean; message?: string }>;
    /** 监听任务进度，返回取消订阅函数 */
    onProgress: (callback: (progress: TorrentTaskSnapshot) => void) => () => void;
}

/**
 * Electron 主进程与渲染进程桥接暴露的统一 API (preload 注入)
 */
export interface ElectronAPI {
    /** 监听全局导航事件跳转 */
    onNavigateToUrl: (callback: (url: string) => void) => () => void;
    /** 注销导航事件监听器 */
    removeNavigateListener: () => void;
    /** 监听网络层嗅探到的媒体流或文件 */
    onSniffedMedia: (callback: (media: FoundLink) => void) => () => void;
    /** 获取当前宿主转码与下载能力 (如 FFmpeg) */
    getDownloadCapabilities: () => Promise<DownloadCapabilities>;
    /** 调用原生下载引擎保存媒体文件 */
    downloadMedia: (payload: DownloadMediaParams) => Promise<DownloadMediaResult>;
    /** 读取指定域名的 Cookie */
    getCookies: (url: string) => Promise<any[]>;
    /** 设置 Cookie 项 */
    setCookie: (details: any) => Promise<void>;
    /** 移除指定名称的 Cookie */
    removeCookie: (url: string, name: string) => Promise<void>;
    /** ACGMHO 画册下载服务 API (可选模块) */
    acgmho?: ElectronAcgmhoAPI;
    /** Sukebei / Nyaa 资源搜索与种子 API (可选模块) */
    sukebei?: ElectronSukebeiAPI;
    /** 内置 BT 下载引擎 API (可选模块) */
    torrent?: ElectronTorrentAPI;
}

/**
 * Electron 渲染进程环境信息
 */
export interface ElectronProcessEnv {
    /** 是否处于 Electron 桌面运行容器中 */
    isElectron?: boolean;
    /** 注入的环境变量配置 */
    env: {
        API_KEY: string;
    };
}

/**
 * 扩展后的全局 Window 接口声明，统一挂载强类型属性
 */
export interface AppWindow extends Window {
    /** Electron 桥接 API 实例 */
    electronAPI?: ElectronAPI;
    /** 进程环境信息 */
    process?: ElectronProcessEnv;
}

/**
 * 集中获取强类型的应用窗口对象，杜绝 global 污染
 * @returns 包含 Electron 扩展的全局窗口对象
 */
export const getAppWindow = (): AppWindow => {
    return typeof window !== 'undefined' ? (window as unknown as AppWindow) : ({} as AppWindow);
};

/**
 * 安全获取注入的 ElectronAPI 实例
 * @returns ElectronAPI 对象，若处于纯 Web 浏览器环境则返回 undefined
 */
export const getElectronAPI = (): ElectronAPI | undefined => {
    return getAppWindow().electronAPI;
};

/**
 * ============================================================================
 * 7. ACGMHO 图集下载相关接口
 * ============================================================================
 */

/**
 * 画册探测返回元数据结构
 */
export interface GalleryProbeResult {
    /** 画册 ID (GID) */
    gid: string;
    /** 画册标题名称 */
    title: string;
    /** 总页数 */
    totalPages: number;
    /** 第一页图片缩略图或直链 */
    firstImgUrl: string;
    /** 资源路径前缀 */
    prefix: string;
    /** 第一页页面地址 */
    firstPageUrl: string;

    // 多媒体扩展字段
    /** 媒体类型 */
    mediaType?: 'video' | 'audio' | 'image';
    /** ACG 内容分类 */
    category?: AcgCategory;
    /** 是否含有动态图片 */
    isAnimated?: boolean;
    /** 关联视频流地址 (若有) */
    videoUrl?: string;
    /** 封面海报地址 */
    poster?: string;
    /** 音轨列表 (若有) */
    audioList?: Array<{ name: string; url: string; artist?: string; cover?: string; type?: string }>;
    /** 媒体时长格式化文本 */
    duration?: string;
}

/**
 * 启动画册下载任务的配置参数
 */
export interface GalleryDownloadOptions {
    /** 画册 ID (gid) 或画册网页 URL */
    gidOrUrl: string;
    /** 指定下载的页码范围 (如 "1-10,15", 可选，默认全本) */
    pages?: string;
    /** 自定义保存目标本地文件夹路径 */
    outDir?: string;
    /** 抓取请求间隔延迟 (毫秒，防风控防封禁) */
    delayMs?: number;
}

/**
 * 画册下载进度通知数据结构
 */
export interface GalleryDownloadProgress {
    /** 画册 ID (gid) */
    gid: string;
    /** 当前已处理的页码 */
    currentPage: number;
    /** 目标总页数 */
    totalPages: number;
    /** 当前已下载数据量 (字节数) */
    currentBytes: number;
    /** 估计总字节数 */
    totalBytes: number;
    /** 下载完成百分比 (0 ~ 100) */
    percent: number;
    /** 当前正在下载的图片直链地址 */
    currentUrl: string;
    /** 下载任务生命周期状态 */
    status: GalleryDownloadStatus;
    /** 状态文字说明或错误原因 */
    message?: string;
    /** 已保存到本地的完整文件路径列表 */
    savedFiles: string[];
}

/**
 * 画册单页下载元数据记录 (用于生成 manifest 清单)
 */
export interface GalleryRecord {
    /** 页码序号 (从 1 开始) */
    page: number;
    /** 页面网页 URL */
    page_url: string;
    /** 页面标题 */
    title?: string | null;
    /** 提取的原始图片直链 URL */
    img_url?: string | null;
    /** 图片 alt 属性或提示文字 */
    img_alt?: string | null;
    /** 本地保存相对文件名 */
    saved_as?: string;
    /** 文件大小 (字节) */
    bytes?: number;
    /** 下载失败时的错误描述 */
    error?: string;
}

/**
 * 画册下载归档 Manifest 清单文件结构
 */
export interface GalleryManifest {
    /** 画册 ID (gid) */
    gid: string;
    /** 画册标题 */
    title: string;
    /** 图片保存的基础相对路径目录 */
    base: string;
    /** 下载归档完成时间 (ISO 格式时间字符串) */
    downloadedAt: string;
    /** 包含的所有单页元数据记录 */
    records: GalleryRecord[];
}

/**
 * 画册页面基础项数据
 */
export interface GalleryPageItem {
    /** 页码编号 */
    page: number;
    /** 页面网页地址 */
    url: string;
    /** 页面标题 */
    title: string;
    /** 图片 alt 描述 */
    alt?: string | null;
}

/**
 * 画册分页提取进度通知
 */
export interface GalleryFetchProgress {
    /** 画册 ID (gid) */
    gid: string;
    /** 本轮 run 标识（渲染层凭此丢弃过期 run 的进度） */
    runId?: string;
    /** 当前已抓取的页数 */
    current: number;
    /** 预计总页数 */
    total: number;
    /** 当前刚抓取到的单页信息 */
    item: GalleryPageItem;
    /** 累计已获取的所有页面列表 */
    records: GalleryPageItem[];
    /** 抓取阶段状态 */
    status: GalleryFetchStatus;
}

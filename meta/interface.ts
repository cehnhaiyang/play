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
    GalleryDownloadStatus,
    GalleryFetchStatus,
    AiConfig,
    AiTestResult,
    EnvelopeCurve,
    FilterKind,
    DrumName,
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
 * 媒体下载实时进度（主进程 → 渲染层推送）。
 *
 * 两种下载方式共用这一个形状：流媒体走 ffmpeg（用 Duration + out_time_ms 算
 * 真实百分比），直链文件走 HTTP（用 Content-Length + 已收字节）。
 * 拿不到总长时 percent 为 null —— 界面据此显示不定进度条，
 * 而不是拿一个假百分比骗人。
 */
export interface MediaDownloadProgress {
    /** 同一 URL 的下载标识，渲染层用来确认这条进度属于当前那次下载 */
    url: string;
    /** 0~100；无法确定总长时为 null */
    percent: number | null;
    /** 已处理字节（ffmpeg 的 total_size 或 HTTP 已收字节） */
    receivedBytes: number;
    /** 总字节；未知为 0 */
    totalBytes: number;
    /** 已处理时长（秒）；直链文件无此概念时为 0 */
    processedSeconds: number;
    /** 总时长（秒）；未知为 0 */
    totalSeconds: number;
    /** 处理速度倍率（ffmpeg 的 speed=2.1x → 2.1）；未知为 0 */
    speed: number;
    /** 被跳过的 HLS 分片数（源站缺失，ffmpeg 自报） */
    skippedSegments: number;
    status: 'starting' | 'downloading' | 'completed' | 'error' | 'cancelled';
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
    /** 是否被用户取消（取消不算失败，半成品文件已删除） */
    cancelled?: boolean;
    /**
     * 非致命警告：下载成功但内容有缺失（如 HLS 源站丢了分片，ffmpeg 跳过继续）。
     * 与 success 并存——文件确实下下来了，只是不完整，不该当成失败。
     */
    warning?: string;
    /** 被跳过的 HLS 分片数（ffmpeg 自报，仅流媒体下载有意义） */
    skippedSegments?: number;
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
 * 书签节点：**树**结构，与 Edge / Chrome 的收藏夹同构。
 *
 * 为什么从扁平数组改成树：扁平列表能存「收藏了什么」，但存不了「收藏在哪个
 * 文件夹里」。而收藏夹栏的核心用途恰恰是**按文件夹分层** —— 工具、资源、AI
 * 各一个文件夹，是用户自己建立的信息架构。压平等于把它丢掉。
 *
 * url 节点与 folder 节点共用一个类型（而不是拆成两个接口）：渲染层的拖拽、
 * 遍历、查找都希望「孩子」是同一种东西；拆开后每个递归函数都要先判类型再
 * 分派，而判类型这件事 `node.type` 已经做了。
 */
export interface BookmarkNode {
    /** 节点唯一 ID */
    id: string;
    /** 节点类型：网址或文件夹 */
    type: 'url' | 'folder';
    /** 显示标题 */
    title: string;
    /** 网址（仅 type === 'url'） */
    url?: string;
    /** 子节点（仅 type === 'folder'；允许空数组，空文件夹要保住） */
    children?: BookmarkNode[];
    /** 网站 Favicon（dataURL 或 http 地址，仅 type === 'url'） */
    icon?: string;
    /** 创建时间戳 (毫秒) */
    createdAt: number;
}

/**
 * 书签树的两个根。
 *
 * 与 Edge 一致：`bar` 是收藏夹栏（横栏展示），`other` 是其他收藏夹
 * （只在管理器里出现，不占横栏）。两个根都必须是 folder。
 */
export interface BookmarkTree {
    /** 收藏夹栏 */
    bar: BookmarkNode;
    /** 其他收藏夹 */
    other: BookmarkNode;
}

/**
 * 书签栏显示策略。
 *
 * 与 Edge / Chrome 出厂默认一致：只在没有打开网页时显示。
 * 'always' 会压缩网页可视区，'never' 则让入口难以发现 —— 所以默认是 'newTab'。
 */
export type BookmarkBarVisibility = 'always' | 'newTab' | 'never';

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
    /**
     * 分段过渡曲线。
     * 缺省为 `exp`（指数，最接近真实乐器的自然衰减）。
     * 旧版本只支持指数，故保持向后兼容。
     */
    curve?: EnvelopeCurve;
    /**
     * 起音前的保持延迟 (秒)。用于模拟"吹奏起音前的气息准备"、
     * 或让和弦各声部错开进入。缺省 0。
     */
    delay?: number;
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
    /**
     * 搁架/峰值滤波器的增益量 (dB)，仅 lowshelf/highshelf/peaking 有意义。
     */
    gain?: number;
    /**
     * 自动扫频目标频率 (Hz)。
     * 若设置，滤波器会在音符时值内从 `frequency` 平滑扫到该值，
     * 无需 `filter_envelope` 即可实现 riser / 扫频效果。
     */
    sweepTo?: number;
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
    /** 调制受控参数 ('frequency' | 'filter' | 'gain' | 'pan' | 'detune') */
    target: LFOTarget;
    /**
     * 起振淡入时间 (秒)。避免 LFO 在音符起始瞬间突变造成"咔哒"声。
     */
    ramp?: number;
    /**
     * 调制深度是否随时间线性增长（用于 riser 式渐进颤音）。
     */
    swell?: boolean;
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
    /** 反馈回路低通截止 (Hz)，越低回声越暗、越像磁带延迟 */
    damping?: number;
    /** 是否启用乒乓（左右交替）延迟 */
    pingPong?: boolean;
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
    /** 预延迟 (秒)，拉开干声与混响的距离以增强空间纵深感 */
    preDelay?: number;
    /** 高频阻尼 (Hz)，越低尾音越温暖 */
    damping?: number;
}

/**
 * 破音/失真效果器配置
 */
export interface DistortionEffectDef {
    type: 'distortion';
    /** 过载与失真程度数值 */
    amount: number;
    /** 干湿比 (0 ~ 1)，缺省 1（全湿） */
    mix?: number;
}

/**
 * 位深压缩效果器配置 (Bitcrusher)
 */
export interface BitcrushEffectDef {
    type: 'bitcrush';
    /** 量化位数，越低越脏 (1 ~ 16) */
    bits: number;
    /** 干湿比 (0 ~ 1) */
    mix: number;
}

/**
 * 合唱效果器配置
 */
export interface ChorusEffectDef {
    type: 'chorus';
    /** 调制速率 (Hz) */
    rate: number;
    /** 调制深度 (毫秒) */
    depth: number;
    /** 干湿比 (0 ~ 1) */
    mix: number;
}

/**
 * 镶边效果器配置
 */
export interface FlangerEffectDef {
    type: 'flanger';
    /** 调制速率 (Hz) */
    rate: number;
    /** 反馈系数 (0 ~ 1)，越高金属感越强 */
    feedback: number;
    /** 干湿比 (0 ~ 1) */
    mix: number;
}

/**
 * 移相效果器配置
 */
export interface PhaserEffectDef {
    type: 'phaser';
    /** 调制速率 (Hz) */
    rate: number;
    /** 扫频下限 (Hz) */
    min: number;
    /** 扫频上限 (Hz) */
    max: number;
    /** 干湿比 (0 ~ 1) */
    mix: number;
}

/**
 * 颤音（音量调制）效果器配置
 */
export interface TremoloEffectDef {
    type: 'tremolo';
    /** 调制速率 (Hz) */
    rate: number;
    /** 调制深度 (0 ~ 1) */
    depth: number;
}

/**
 * 动态压缩效果器配置
 */
export interface CompressorEffectDef {
    type: 'compressor';
    /** 阈值 (dB) */
    threshold: number;
    /** 压缩比 */
    ratio: number;
    /** 启动时间 (秒) */
    attack: number;
    /** 释放时间 (秒) */
    release: number;
}

/**
 * 滤波扫频效果器配置（作为效果链一环的整体扫频）
 */
export interface FilterEffectDef {
    type: 'filter';
    /** 滤波器类型 */
    kind: FilterKind;
    /** 起始频率 (Hz) */
    from: number;
    /** 结束频率 (Hz) */
    to: number;
    /** 品质因数 */
    Q: number;
    /** 扫频持续时长 (秒) */
    duration: number;
    /** 扫频起始时刻 (秒) */
    start: number;
}

/**
 * 三段式均衡效果器配置
 */
export interface EqEffectDef {
    type: 'eq';
    /** 低频增益 (dB)，作用在 lowShelf */
    low: number;
    /** 中频增益 (dB)，作用在 peaking */
    mid: number;
    /** 高频增益 (dB)，作用在 highShelf */
    high: number;
}

/**
 * 音频效果器联合类型
 */
export type EffectDef =
    | DelayEffectDef
    | ReverbEffectDef
    | DistortionEffectDef
    | BitcrushEffectDef
    | ChorusEffectDef
    | FlangerEffectDef
    | PhaserEffectDef
    | TremoloEffectDef
    | CompressorEffectDef
    | FilterEffectDef
    | EqEffectDef;

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

    /* --- 表现力扩展 --- */

    /**
     * 起音滑音时长 (秒)。音高从 `portamentoFrom` 半音比滑向目标音，
     * 模拟弦乐换把、人声滑音、808 滑音贝斯。
     */
    glide?: number;
    /** 滑音起始偏移（半音数，缺省 -12 即低八度滑入） */
    glideFrom?: number;
    /**
     * 音高包络深度（半音数）。正值=起音偏高再落下（打击乐/鼓皮张力），
     * 负值=起音偏低再扬起。与 `pitchDecay` 配合使用。
     */
    pitchEnvAmount?: number;
    /** 音高包络衰减时长 (秒) */
    pitchDecay?: number;
    /**
     * 立体声展开度 (0 ~ 1)。多个发声体按此值向左右散开，
     * 是让弦乐群/合唱"变宽"的主要手段。
     */
    spread?: number;
    /** 力度灵敏度 (0 ~ 1)。1 = 力度完全影响音量，0 = 力度不影响音量 */
    velocitySensitivity?: number;
    /**
     * 力度对滤波器截止的影响量 (Hz)。
     * 让强奏时音色更亮，是管弦乐"强弱=音色变化"的关键。
     */
    velocityToFilter?: number;
    /**
     * 每音符复音数 (1 ~ 7)。大于 1 时按 `detune` 叠加多个失谐振荡器，
     * 形成 SuperSaw 式的厚实音墙。
     */
    voices?: number;
    /**
     * 声部内失谐扩散量 (cents)。第 i 个声部偏移量按此值均分，
     * 与 `voices` 配合决定"厚"的程度。
     */
    unisonSpread?: number;
    /**
     * 生成自定义 PeriodicWave 的谐波振幅数组。
     * 设置后 `wave` 会被忽略，用真实谐波叠加代替内置波形，
     * 是逼近真实乐器频谱的最强手段。
     */
    harmonics?: number[];
    /**
     * 起音噪声量 (0 ~ 1)。在音符起始处混入极短噪声爆发，
     * 用于模拟弓弦摩擦、气息、拨片触弦等"起音质感"。
     */
    attackNoise?: number;
    /**
     * 乐器级效果链。仅作用于该乐器，与全局 `effect_chain` 串联。
     * 这是让"主音吉他带失真、弦乐带混响"同时成立的关键。
     */
    effects?: EffectDef[];
    /**
     * 循环起音点 (秒)。弦乐/管乐的持续音可在此时间点后重新触发，
     * 用较少的音符时长模拟长音呼吸。
     */
    loopPoint?: number;
}

/**
 * 单个发声事件的逐音符表现力参数
 * 让同一乐器可以演奏出强弱、连断、滑音等变化，而不是机械重复同一音色。
 */
export interface NoteExpression {
    /** 力度 (0 ~ 1，缺省 0.8)。同时影响音量与音色亮度 */
    velocity?: number;
    /** 声像覆盖 (-1 ~ 1)，覆盖乐器默认声像 */
    pan?: number;
    /** 增益覆盖 (0 ~ 1)，覆盖乐器默认增益 */
    gain?: number;
    /** 时值缩放 (0 ~ 4，缺省 1)。0.5 = 断奏，1.5 = 连奏 */
    gate?: number;
    /** 音高偏移（半音），用于临时离调或装饰音 */
    transpose?: number;
    /** 滑音时长 (秒)，覆盖乐器 glide */
    glide?: number;
    /** 声部内失谐覆盖 (cents) */
    detune?: number;
    /**
     * 人性化抖动强度 (0 ~ 1)。
     * 按此强度对音高、力度、时值施加随机微扰，
     * 消除机械感 —— 这是让程序化作曲"像人演奏"的核心手段。
     */
    humanize?: number;
}

/**
 * 单音音符指令
 */
export interface NoteCommand extends NoteExpression {
    type: 'note';
    /** 音高记号 (如 'C4', 'F#5', 'Bb3') */
    pitch: string;
    /** 时值记号 (如 '4n', '8n', '16n', '1m') */
    duration: string;
}

/**
 * 和弦指令 (多音齐鸣)
 */
export interface ChordCommand extends NoteExpression {
    type: 'chord';
    /** 构成和弦的音高数组 (如 ['C4', 'E4', 'G4']) */
    pitches: string[];
    /** 和弦发声时值 */
    duration: string;
    /**
     * 琶音化程度 (0 ~ 1)。
     * 0 = 完全齐奏；大于 0 时各声部依次错开进入，模拟竖琴/吉他的滚奏。
     */
    strum?: number;
}

/**
 * 琶音指令
 */
export interface ArpCommand extends NoteExpression {
    type: 'arp';
    /** 琶音基础音阶或和弦音高数组 */
    pitches: string[];
    /** 扫描形态 */
    pattern: ArpPattern;
    /** 琶音每个单音触发速率 (如 '16n') */
    rate: string;
    /** 琶音总持续时长 */
    duration: string;
    /** 每个音的占空比 (0 ~ 1，缺省 0.9)。越小越断奏 */
    gate?: number;
    /** 跨八度数量 (1 ~ 4，缺省 1)。把和弦音向上复制若干八度扩展音域 */
    octaves?: number;
}

/**
 * 鼓组打击指令
 * 直接引用内置鼓组音色，无需定义乐器即可编写节奏声部。
 */
export interface HitCommand extends NoteExpression {
    type: 'hit';
    /** 鼓组音色名 */
    drum: DrumName;
    /** 时值 */
    duration: string;
    /**
     * 鼓组音高微调（半音）。正值更紧更高，负值更沉更低。
     * 用于把同一个 kick 音色调成不同调性的底鼓。
     */
    drumTune?: number;
    /** 衰减时长缩放倍数（1 = 音色原值）。大于 1 更长，小于 1 更短促 */
    drumDecay?: number;
    /**
     * 音色明暗偏移（Hz）。作用于鼓组的高通/噪声层，
     * 正值更亮更"脆"，负值更暗更"闷"。
     */
    drumTone?: number;
    /** 起音冲击感 (0 ~ 1)。越大瞬态越硬，适合军鼓/拍手 */
    drumSnap?: number;
}

/**
 * 和弦进行指令
 *
 * 一次写完一整段和声进行，每个和弦按时值依次发声。
 * 这是让 LLM 用"和声思维"而不是"逐音符思维"作曲的关键指令：
 * 模型只需给出和弦符号序列，具体声位由引擎按规则展开。
 */
export interface ProgressionCommand extends NoteExpression {
    type: 'progression';
    /** 每个和弦的音高数组（已由和弦符号展开） */
    chords: string[][];
    /** 每个和弦的时值记号，长度与 chords 一致 */
    beats: string[];
    /** 跨八度数量 (1 ~ 4)，把和弦向上复制若干八度铺开 */
    octaves?: number;
    /** 和弦内音的演奏方式：up/down 等做琶音化，asPlayed 齐奏 */
    pattern: ArpPattern;
    /** 每个音的占空比 (0 ~ 1，缺省 1) */
    gate?: number;
    /** 和弦内各音错开进入的程度 (0 ~ 1)，做竖琴式滚奏 */
    strum?: number;
}

/**
 * 快速音阶/音型跑动指令
 *
 * 用固定速率把一串音高依次奏出，是填充乐句空隙、制造推进感最省笔墨的写法。
 */
export interface RunCommand extends NoteExpression {
    type: 'run';
    /** 依次奏出的音高序列 */
    pitches: string[];
    /** 每个音的速率（如 '16n'） */
    rate: string;
    /** 整条音型重复次数（缺省 1） */
    repeat?: number;
    /** 方向：up 原序 / down 逆序 / updown 往返 */
    direction: 'up' | 'down' | 'updown';
    /** 每个音的占空比 (0 ~ 1，缺省 1) */
    gate?: number;
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
export type SequenceCommand =
    | NoteCommand
    | RestCommand
    | ChordCommand
    | ArpCommand
    | HitCommand
    | ProgressionCommand
    | RunCommand;

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
    /** 整轨力度缩放 (0 ~ 2，缺省 1)，用于快速平衡声部 */
    gain?: number;
    /** 整轨移调（半音，缺省 0） */
    transpose?: number;
    /** 整轨人性化强度 (0 ~ 1) */
    humanize?: number;
}

/**
 * 混音轨道排布指令
 */
export interface MixTrack {
    /** 引用的音序名 */
    source: string;
    /** 起始时刻 (秒) */
    time: number;
    /** 重复次数 */
    loop: number;
    /** 轨道音量缩放 (缺省 1) */
    gain?: number;
    /** 轨道声像 (-1 ~ 1) */
    pan?: number;
    /** 每次循环的起始时刻递增（秒），用于做卡农式错位叠加 */
    stagger?: number;
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

    /* --- 表现力扩展（由调度器从乐器定义 + 逐音符表达合并而来） --- */

    /** 起音滑音时长 (秒) */
    glide?: number;
    /** 滑音起始半音偏移 */
    glideFrom?: number;
    /** 音高包络深度（半音） */
    pitchEnvAmount?: number;
    /** 音高包络衰减时长 (秒) */
    pitchDecay?: number;
    /** 立体声展开度 (0 ~ 1) */
    spread?: number;
    /** 力度 (0 ~ 1) */
    velocity?: number;
    /** 力度对滤波器截止的影响量 (Hz) */
    velocityToFilter?: number;
    /** 每音符复音数 */
    voices?: number;
    /** 声部内失谐扩散 (cents) */
    unisonSpread?: number;
    /** 自定义谐波振幅数组 */
    harmonics?: number[];
    /** 起音噪声量 (0 ~ 1) */
    attackNoise?: number;
    /** 乐器级效果链 */
    effects?: EffectDef[];
    /** 打击乐音色（设置时走鼓组合成路径，忽略 wave/fm） */
    drum?: DrumName;
    /** 鼓组音高微调（半音） */
    drumTune?: number;
    /** 鼓组衰减缩放倍数 */
    drumDecay?: number;
    /** 鼓组音色明暗偏移 (Hz) */
    drumTone?: number;
    /** 鼓组起音冲击感 (0 ~ 1) */
    drumSnap?: number;
    /** 循环起音点 (秒) */
    loopPoint?: number;
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
 *
 * 生效范围限于**当前页面主世界**的 JS。以下路径的解析发生在别处，规则不生效：
 * Web Worker / SharedWorker / Service Worker 内的解析、跨域 iframe 内的请求、
 * 页面在引擎装钩前就存下的 JSON.parse 引用、WASM 或原生层解析的 JSON。
 * （Service Worker 本身不构成绕过：它只拦截网络，响应仍由页面主世界解析。）
 */
export interface TamperRule {
    /** 规则唯一 ID */
    id?: string;
    /** 规则是否启用生效 */
    enabled: boolean;
    /**
     * URL 匹配模式。留空、`*`、`.*` 都表示匹配全部。
     *
     * 含 `*`（任意串）或 `?`（任意单字符）时按 glob 匹配，
     * 否则按子串包含匹配。**不是正则**。
     *
     * 匹配对象是「页面地址」与「接口地址」两者取或 —— 针对具体接口写的
     * 规则（如 `*api.example.com*`）不需要页面地址本身也含该串。
     */
    urlPattern: string;
    /**
     * 要替换的目标键名。取最后一段：`data.user.id` 与 `id` 等价，都匹配任意
     * 层级上名为 `id` 的字段。**不是 JSONPath**，不支持下标、通配与过滤。
     *
     * 响应/请求路径下按字段名匹配；存储路径下按完整的存储键匹配
     * （整条写法或它的末段都可以）。
     */
    jsonPath: string;
    /**
     * 替换目标新值。
     *
     * 类型按写法推断，判据是**严格 JSON 数字字面量**：
     * - `true` / `false` / `null` → 对应类型
     * - `42` / `3.14` / `-5` / `1e3` → number
     * - 其余一律按字符串（`007`、`0x10`、`Infinity`、`1.`、`.5`、`+1`、带空格的数字都是字符串）
     *
     * 两个特殊写法：
     * - `=` 前缀强制当字符串：`=007` 得到字符串 `"007"`（而不是数字 7）。
     *   想写一个**本身以 `=` 开头**的字符串就双写：`==1+1` 得到 `"=1+1"`。
     * - `undefined` 会让该字段从响应里消失（`JSON.stringify` 会丢掉值为 undefined 的键），
     *   效果等于删除字段。想写字符串 `"undefined"` 请用 `=undefined`。
     *
     * 注意：JSON 响应路径会还原成上述类型，但 **localStorage / sessionStorage 路径
     * 始终返回字符串** —— Storage 规范规定 `getItem` 只能返回字符串或 null。
     */
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
    /** URL 匹配模式，语义同 {@link TamperRule.urlPattern} */
    urlPattern: string;
    /** 目标 Header 键名 (如 Referer, User-Agent, Authorization)，大小写不敏感 */
    headerName: string;
    /** 注入或覆盖的 Header 值；留空表示**删除**该请求头 */
    headerValue: string;
}

/**
 * 一条 Cookie。
 *
 * 字段与 Electron `cookies.get()` 的返回对齐。除 name/value 外全部可选 ——
 * 面板与 Agent 工具都要把它们**原样回填**给 `cookies.set`：
 * 那是整条覆盖语义，漏掉 httpOnly 会把 HttpOnly 会话 cookie 降级成 JS 可读，
 * 漏掉 expirationDate 会把持久 cookie 变成会话 cookie（关窗就掉登录态）。
 */
export interface CookieItem {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    /** 是否为会话 cookie（无过期时间） */
    session?: boolean;
    /** Unix 秒级过期时间 */
    expirationDate?: number;
    sameSite?: string;
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
    /** 重新加载并**忽略缓存**（Ctrl+Shift+R）。普通 reload 会复用缓存，改不掉的旧资源要靠它 */
    reloadIgnoringCache(): void;
    /** 中止当前导航。加载卡住时唯一的出路 —— 不调它只能等超时 */
    stop(): void;
    /** 获取当前 Webview URL */
    getURL(): string;
    /** 当前页面标题 */
    getTitle(): string;
    /** 是否仍在加载资源 */
    isLoading(): boolean;
    /** 导航加载指定 URL */
    loadURL(url: string): Promise<void>;
    /** 触发一次下载（不导航）。右键菜单的「链接/图片另存为」用它 */
    downloadURL(url: string): void;
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
    /**
     * 该 webview 对应 webContents 的数字 id。
     *
     * 主进程推来的浏览器命令带的是 webContents id（它只知道 webContents，
     * 不知道标签页 id），靠这个方法把两者对上 —— 发声状态、右键菜单的
     * "分析这个元素"都依赖这个映射。
     */
    getWebContentsId(): number;
    /**
     * 页面内查找。返回本次请求的 id，结果通过 `found-in-page` 事件回传
     * （webview 元素上**没有**同步返回值可用，必须等事件）。
     */
    findInPage(text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): number;
    /** 结束查找。'clearSelection' 清掉高亮，'keepSelection' 把高亮转成普通选中 */
    stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void;
    /** 缩放级别。与 setZoomFactor 的区别是它按 level 步进（每级 1.2 倍），Chrome 的 Ctrl+± 用的就是它 */
    setZoomLevel(level: number): void;
    getZoomLevel(): number;
    setZoomFactor(factor: number): void;
    getZoomFactor(): number;
    /** 静音该页面 */
    setAudioMuted(muted: boolean): void;
    isAudioMuted(): boolean;
    /** 此刻是否正在出声。标签页上的小喇叭图标靠它 —— 静音的视频不算 */
    isCurrentlyAudible(): boolean;
    /** 打开该页面的开发者工具 */
    openDevTools(): void;
    closeDevTools(): void;
    isDevToolsOpened(): boolean;
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
    /** 搜索关键词（搜索流） */
    query?: string;
    /** 列表页 302 后的规范地址：搜索翻页必须基于它（/q/ 翻页服务端永远回第 1 页） */
    baseUrl?: string;
}

/**
 * Electron 注入到渲染层的 ACGMHO 专属画册下载与爬虫 API
 */
export interface ElectronAcgmhoAPI {
    /** 探测画册基础信息及元数据 */
    probe: (gidOrUrl: string) => Promise<GalleryProbeResult>;
    /** 频道表（内置浏览画廊左侧分类） */
    channels: () => Promise<AcgmhoChannelDef[]>;
    /** 频道列表（分页）：{ channelId, page, query, baseUrl }，baseUrl 为上一页规范地址（搜索翻页用） */
    channelList: (options: { channelId: string; page?: number; query?: string; baseUrl?: string }) => Promise<{ success: boolean; message?: string } & AcgmhoChannelListResult>;
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
    /** 边下边播落盘：按直链保存图片并写 manifest/.gallery 徽标（同 gid 新任务顶掉旧任务） */
    saveImages: (options: GallerySaveOptions) => Promise<{
        success: boolean;
        outDir?: string;
        manifestPath?: string;
        galleryMarkerPath?: string;
        savedFiles?: string[];
    }>;
    /** 取消指定 gid 的落盘任务 */
    cancelSaveImages: (gid: string) => Promise<void>;
    /** 监听落盘进度事件（含 file-done 单页完成），返回取消订阅函数 */
    onSaveProgress: (callback: (progress: GallerySaveProgress) => void) => () => void;
}

/**
 * 通用搜索结果条目。
 *
 * 各站点字段名、单位、日期格式互不相同（"709.4 MiB" / 字节数 / 秒级时间戳 /
 * "2024-01-02 03:04"），引擎在 provider 里就地归一化，UI 只认这一种结构。
 * 这样"加一个站点"不需要动结果列表一行代码。
 */
export interface SearchHit {
    /** 站点内唯一 ID（provider 自定，只需在本站内唯一） */
    id: string;
    /** 来源 provider id，如 'apibay' */
    site: string;
    /** 来源站点显示名 */
    siteLabel: string;
    /** 资源标题 */
    title: string;
    /** magnet 链接（可能为空） */
    magnet: string;
    /** .torrent 直链（可能为空） */
    torrent: string;
    /** 详情页地址（可能为空） */
    viewUrl: string;
    /**
     * 归一化后的字节数，-1 表示站点未提供。
     * 跨站排序/筛选只能用这个——各站原始文本单位不统一，按字符串排毫无意义。
     */
    sizeBytes: number;
    /** 原始体积文本，保留站点原样用于展示 */
    sizeText: string;
    /** 做种数（站点未公布为 -1） */
    seeders: number;
    /** 吸血数（站点未公布为 -1） */
    leechers: number;
    /** 完成数（站点未公布为 -1） */
    completed: number;
    /** 发布时间（epoch 毫秒，未知为 -1） */
    publishedAt: number;
    /** 分类文本 */
    category: string;
    /** info hash（小写 hex，未知为空串）——跨站去重键 */
    infoHash: string;
}

/**
 * 站点插口描述。引擎与 UI 都只通过它认识站点，不感知任何站点细节。
 */
export interface SiteDescriptor {
    /** provider 唯一 id */
    id: string;
    /** 显示名 */
    label: string;
    /** 站点主页（作 referer 与「详情」兜底） */
    homepage: string;
    /** 是否成人内容：UI 可据此默认收起，避免默认把里区结果混进表区 */
    adult: boolean;
    /** 站点擅长的内容类型，仅用于 UI 提示 */
    kinds: string[];
}

/** 单站搜索状态：扇出后哪几站成功、哪几站失败及原因 */
export interface SearchSiteStatus {
    site: string;
    label: string;
    ok: boolean;
    /** 该站返回条目数 */
    count: number;
    elapsedMs: number;
    /** 失败原因（ok 为 false 时有值） */
    error?: string;
}

/** 搜索请求 */
export interface SearchQuery {
    /** 关键词 */
    q: string;
    /** 限定站点 id 列表；留空/不传 = 搜索全部已注册站点 */
    sites?: string[];
    /** 单站结果上限 */
    limitPerSite?: number;
    /** 汇总排序方式 */
    sort?: SearchSort;
    /** 过滤掉做种数低于该值的条目（0 = 不过滤） */
    minSeeders?: number;
    /** 是否包含成人站点结果 */
    includeAdult?: boolean;
}

export type SearchSort = 'seeders' | 'size' | 'date' | 'site';

/** 搜索汇总结果 */
export interface SearchResult {
    success: boolean;
    message?: string;
    /** 归一化并去重后的汇总条目 */
    hits: SearchHit[];
    /** 每站明细（含失败原因） */
    sites: SearchSiteStatus[];
    /** 总耗时 */
    elapsedMs: number;
}

/** 主进程出网层代取文本的返回 */
export interface NetFetchTextResult {
    ok: boolean;
    status: number;
    body: string;
    /** 最终地址（跟随重定向后） */
    finalUrl?: string;
    error?: string;
}

/**
 * 内置 BT 任务快照（与主进程 electron/main.js 里的 btSnapshot 对齐）
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
 * Electron 注入到渲染层的种子文件获取 API。
 *
 * 搜索本身不再需要 IPC —— 搜索引擎完整地待在 services/SearchService，
 * 用渲染层 fetch 直接请求各站点（代理配在 Chromium 会话上，自动生效）。
 * 只有"把 .torrent 落到磁盘"必须由主进程做（需要文件系统权限）。
 */
export interface ElectronTorrentFileAPI {
    /**
     * 下载 .torrent 种子文件并存盘。
     * 主进程持有站点白名单，渲染层传来的任意地址不会被无条件抓取（防 SSRF）。
     */
    fetchFile: (options: {
        url: string;
        title?: string;
        outDir?: string;
    }) => Promise<{ success: boolean; message?: string; path?: string; bytes?: number }>;
}

/**
 * 应用设置读取结果
 */
export interface AppSettingsSnapshot {
    success: boolean;
    /** 用户配置的代理端口（'' 表示留空 = 一律直连） */
    proxyPort: string;
    /** 当前实际生效的代理端点（'' 表示直连）；配了端口但连不上时这里为空 */
    applied: string;
    /**
     * 实际生效的隧道协议：'http' | 'socks5' | ''（直连时为空）。
     * 用户只填裸端口时由主进程探测得出，界面据此显示「经 …:10808（SOCKS5）」，
     * 让"填了 SOCKS 端口还是连不上"这类问题一眼可辨。
     */
    proxyProtocol?: string;
    /** AI 服务配置（OpenAI 兼容协议） */
    ai: AiConfig;
    /** 知识库根目录（'' 表示按默认位置查找） */
    kbRoot: string;
    /** 知识库当前可用状态，随设置一起回传，省掉界面一次额外往返 */
    kb: KbStatus;
    message?: string;
}

/**
 * 保存代理端口的返回：normalized 是归一化后的值（如填 "10810" 得到 "127.0.0.1:10810"）
 */
export interface SaveProxyPortResult extends AppSettingsSnapshot {
    normalized: string;
}

/**
 * 保存 AI 配置的返回
 */
export interface SaveAiConfigResult {
    success: boolean;
    /** 归一化后真正落盘的配置；校验失败时回传当前生效的旧配置 */
    ai: AiConfig;
    message?: string;
}

/**
 * 知识库当前状态。
 *
 * `ready` 为 false 时其余字段无意义 —— 界面据此显示"未接入"而不是"0 篇"，
 * 后者会被读成"库是空的"，而实际是路径没找到。
 */
export interface KbStatus {
    ready: boolean;
    /** 实际生效的知识库根目录（绝对路径）；未就绪时为空串 */
    root: string;
    /** 文章篇数（只数 `<board>/techniques/**.md`，README 不算） */
    articles: number;
    /** 全部文章正文合计字节 */
    bytes: number;
    /** 未就绪时的原因，直接可展示给用户 */
    error?: string;
}

/** 保存知识库路径的返回：status 是保存后的现查结果 */
export interface SaveKbRootResult {
    success: boolean;
    kbRoot: string;
    status: KbStatus;
    message?: string;
}

/**
 * 一份待索引的原始文件。主进程原样搬字节，解析在渲染层做。
 */
export interface KbSourceFile {
    /** kb 根目录下的相对路径，'/' 分隔 */
    path: string;
    content: string;
}

/**
 * 仓库自带 kb-index.json 的形状。只取我们用得到的两个字段：
 * 这份索引不作为唯一真相（它有实测缺口），只当作**一路加权信号**。
 */
export interface KbBoardIndex {
    entries?: { id?: string; signals?: string[]; files?: string[] }[];
}

/** 主进程 kb.load() 的返回 */
export interface KbLoadPayload {
    root: string;
    files: KbSourceFile[];
    boardIndexes: Record<string, KbBoardIndex>;
    /** 因超限或读失败被跳过的文件数 */
    skipped?: number;
    error?: string;
}

/** 主进程 kb.read() 的返回 */
export interface KbReadPayload {
    path?: string;
    content?: string;
    error?: string;
}

/**
 * Electron 注入到渲染层的知识库 API。
 *
 * 主进程只搬字节，解析 / 检索 / 切片全在 services/KbService（纯 TS，可单测）。
 */
export interface ElectronKbAPI {
    /** 整库一次读完（约 3MB）。渲染层长期驻留，之后检索不再往返 IPC */
    load: () => Promise<KbLoadPayload>;
    /** 读单篇正文 */
    read: (path: string) => Promise<KbReadPayload>;
    /** 轻量状态：根目录 / 篇数 / 是否就绪 */
    status: () => Promise<KbStatus>;
    /** 保存 kb 根目录，返回里带新的 status */
    setRoot: (value: string) => Promise<SaveKbRootResult>;
}

/**
 * 主进程能下发的浏览器动作。
 *
 * **这张清单与 electron/browserService.js 的 BROWSER_ACTIONS 逐字对应**，
 * 两边漂移的症状是"按了没反应"——渲染层收到一个自己不认识的动作名，
 * switch 落到 default 就静默忽略了。所以有一处静态断言逐字比对两份清单
 * （test/browser.test.js）。
 *
 * 分三段，与主进程那边的 BROWSER_KEY_ACTIONS / BROWSER_MENU_ACTIONS /
 * BROWSER_PUSH_ACTIONS 一一对应。分类是有意义的：只有第一段会经过
 * `before-input-event` 的 preventDefault 路径。
 */
export type BrowserAction =
    /* 由键盘触发（唯一需要 preventDefault 的一批） */
    // 标签页
    | 'newTab' | 'closeTab' | 'reopenTab' | 'nextTab' | 'prevTab' | 'selectTabIndex' | 'lastTab'
    // 地址与导航
    | 'focusAddressBar' | 'reload' | 'hardReload' | 'stop' | 'back' | 'forward' | 'home'
    // 页面能力
    | 'find' | 'findNext' | 'findPrev' | 'escape'
    | 'zoomIn' | 'zoomOut' | 'zoomReset'
    // 其它
    | 'toggleBookmark' | 'toggleDevTools'
    // Agent 工作区：聚焦输入框（界面层动作，主进程只管按键、渲染层转发给面板）
    | 'focusAgentInput'
    /* 由右键菜单触发（不是按键，不经过 preventDefault） */
    | 'analyzeElement' | 'openInBackgroundTab' | 'searchSelection'
    /* 主进程推送的状态变更（不是用户操作，是 webContents 事件） */
    | 'audibleChanged';

/** 主进程下发的浏览器命令 */
export interface BrowserCommand {
    action: BrowserAction;
    /** 动作参数：selectTabIndex 是下标，analyzeElement 是 {x,y}，其余多为空 */
    arg?: any;
    /**
     * 命令来源的 webContents id（0 表示无来源）。
     *
     * 用来把命令路由到**发出它的那个标签页**，而不是一律当成当前标签页。
     * 发声状态尤其需要它：后台标签页开始放音频时，当前标签页根本没变。
     */
    webContentsId?: number;
}

/**
 * 网页自身触发的下载（区别于嗅探下载 / 画廊下载 / BT）。
 *
 * 这些字段全部由主进程**当场取值**组成快照 —— DownloadItem 是 Electron
 * 对象，塞进 IPC 会直接抛 "An object could not be cloned"。
 */
export interface BrowserDownload {
    id: string;
    filename: string;
    /** 落盘绝对路径。设不上保存路径时为空串（退回系统保存对话框） */
    savePath: string;
    url: string;
    mimeType: string;
    totalBytes: number;
    receivedBytes: number;
    /** 0–100；总长未知时为 -1，界面据此画不定进度条 */
    percent: number;
    state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
    paused: boolean;
    canResume: boolean;
    /** 平均速度（字节/秒）。非进行中为 0 */
    speed: number;
    startedAt: number;
    endedAt: number;
}

/** 下载操作：暂停 / 继续 / 取消 / 定位 / 打开 / 从列表移除 */
export type BrowserDownloadAction = 'pause' | 'resume' | 'cancel' | 'reveal' | 'open' | 'remove';

/** Edge 里一个 profile 的数据概览（探测阶段返回，不打开任何数据库） */
export interface EdgeProfileSummary {
    /** 目录名：Default / Profile 1 … */
    id: string;
    /** Local State 里记录的可读名字，例如「您的 Chrome」 */
    name: string;
    /** profile 绝对路径 */
    dir: string;
    /** 目录是否真的存在 */
    exists: boolean;
    /** 收藏夹里的网址条数 */
    bookmarkCount: number;
    /** 收藏夹里的文件夹个数 */
    folderCount: number;
    /** 是否有 Cookies 库 */
    hasCookies: boolean;
    /** 是否有 History 库 */
    hasHistory: boolean;
}

/** Edge 探测结果 */
export interface EdgeDetectResult {
    /** 本机是否装了 Edge 并找到 User Data */
    available: boolean;
    /** 找不到时的原因（直接展示给用户） */
    reason?: string;
    /** 发行版 id：stable / beta / dev / canary */
    channel?: string;
    /** 发行版显示名 */
    label?: string;
    /** Edge 版本号 */
    version?: string;
    /** User Data 根目录 */
    userDataDir?: string;
    /** msedge.exe 路径 */
    executable?: string;
    /** 各 profile */
    profiles: EdgeProfileSummary[];
}

/**
 * 导入项开关。
 *
 * 没有「密码」这一项 —— 不是漏了，是 Edge 的密码库（v20 / App-Bound）
 * 在第三方进程里解不开，而 CDP 也没有暴露密码的接口。界面里写明原因，
 * 而不是给一个点了没反应的开关。
 */
export interface EdgeImportInclude {
    bookmarks?: boolean;
    favicons?: boolean;
    history?: boolean;
    autofill?: boolean;
    /** 账号（用户名）。**能导** —— 用户名在 Edge 里是明文，加密的只有密码 */
    accounts?: boolean;
    cookies?: boolean;
    searchEngine?: boolean;
}

/** 导入请求参数 */
export interface EdgeImportOptions {
    /** 要导入的 profile 目录名，默认 Default */
    profileId?: string;
    /** 覆盖 User Data 根目录（一般不用传，探测结果里已经带了） */
    userDataDir?: string;
    /** 逐项开关，缺省视为全开 */
    include?: EdgeImportInclude;
    /** 历史条数上限 */
    historyLimit?: number;
    /** 自动填充条数上限 */
    autofillLimit?: number;
    /** 账号条数上限 */
    accountLimit?: number;
}

/** 导入过程中某一项失败/降级的原因。**绝不静默跳过**，每一条都要能展示 */
export interface EdgeImportWarning {
    /** 出问题的类别：bookmarks / favicons / history / autofill / cookies / searchEngine */
    category: string;
    /** 人话说明 */
    message: string;
}

/** 一条浏览器历史 */
export interface EdgeHistoryEntry {
    url: string;
    title: string;
    visitCount: number;
    /** 最后访问时间（毫秒时间戳，0 表示未知） */
    lastVisit: number;
}

/** 一条自动填充记录 */
export interface EdgeAutofillEntry {
    name: string;
    value: string;
    /** Edge 记录的累计使用次数 */
    count: number;
}

/**
 * 一条账号记录。
 *
 * 只有用户名，**没有密码** —— 密码是 v20 App-Bound Encryption，密钥锁在
 * SYSTEM DPAPI 里，只有 Edge 进程本身能解，CDP 也不提供密码接口。
 * 用户名则是明文存储，所以这一项能导。
 */
export interface EdgeAccountEntry {
    /** 这条登录记录属于哪个站点 */
    origin: string;
    /** 用户名（明文） */
    username: string;
    /** Edge 记录的累计使用次数 */
    timesUsed: number;
    /** 最后使用时间（毫秒时间戳，0 表示未知） */
    lastUsed: number;
}

/** 一条待写入会话的 Cookie（值已是明文） */
export interface EdgeCookieEntry {
    url: string;
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    sameSite: string;
    expirationDate?: number;
}

/** 导入结果统计 */
export interface EdgeImportStats {
    bookmarks: number;
    folders: number;
    favicons: number;
    history: number;
    autofill: number;
    accounts: number;
    cookies: number;
    /** 实际写入会话的 Cookie 条数（主进程填） */
    cookiesApplied?: number;
}

/** 导入结果 */
export interface EdgeImportResult {
    ok: boolean;
    /** ok 为 false 时的原因 */
    error?: string;
    /** 数据来源信息 */
    edge?: { label: string; version: string; profileId: string; userDataDir: string };
    /** 收藏夹树（含 extras：Edge 里非空的其它根，如「移动收藏夹」） */
    bookmarks?: { bar: BookmarkNode; other: BookmarkNode; extras: BookmarkNode[] } | null;
    history: EdgeHistoryEntry[];
    autofill: EdgeAutofillEntry[];
    accounts: EdgeAccountEntry[];
    cookies: EdgeCookieEntry[];
    searchEngine: { keyword: string; shortName: string; url: string } | null;
    warnings: EdgeImportWarning[];
    stats: EdgeImportStats;
}

/** Electron 注入到渲染层的 Edge 导入 API */
export interface ElectronEdgeAPI {
    /** 探测本机 Edge 与各 profile（只读文件，不打开数据库） */
    detect: () => Promise<EdgeDetectResult>;
    /** 执行导入。返回逐项结果与 warnings */
    run: (options?: EdgeImportOptions) => Promise<EdgeImportResult>;
    /** 导入过程中的阶段提示，返回取消订阅函数 */
    onProgress: (callback: (message: string) => void) => () => void;
}

/** Electron 注入到渲染层的浏览器外壳 API */
export interface ElectronBrowserAPI {
    /** 浏览器动作命令（新建标签、查找、缩放…）。返回取消订阅函数 */
    onCommand: (callback: (command: BrowserCommand) => void) => () => void;
    /** 下载进度 / 完成 / 中断。返回取消订阅函数 */
    onDownload: (callback: (download: BrowserDownload) => void) => () => void;
    /** 取当前全部下载记录（面板首次打开时补齐历史） */
    downloads: () => Promise<BrowserDownload[]>;
    /** 对某条下载执行操作 */
    downloadAction: (id: string, action: BrowserDownloadAction) => Promise<{ success: boolean; message?: string }>;
}

/**
 * Electron 注入到渲染层的应用设置 API（主进程持久化，改完立即生效）
 */
export interface ElectronSettingsAPI {
    /** 读取当前设置与生效状态 */
    get: () => Promise<AppSettingsSnapshot>;
    /** 保存代理端口；留空表示直连，非法值会被拒绝并回传 message */
    setProxyPort: (value: string) => Promise<SaveProxyPortResult>;
    /** 保存 AI 配置；字段非法会被拒绝并回传 message */
    setAiConfig: (value: AiConfig) => Promise<SaveAiConfigResult>;
    /**
     * 用给定配置发一次真实请求探活（不落盘），验证地址/密钥/模型是否可用。
     *
     * `reasoningEffort` 是映射后的下发取值：映射表在 AiService，
     * 主进程没有也不做映射，由渲染层算好传进来。
     * 传 `null` 表示明确不下发该参数（服务商不需要思考，或用户选了「不思考」）；
     * 缺省时才回落到配置里的档位。
     */
    testAiConfig: (value: AiConfig, reasoningEffort?: string | null) => Promise<AiTestResult>;
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
    /** 监听全局导航事件跳转，返回取消订阅函数 */
    onNavigateToUrl: (callback: (url: string) => void) => () => void;
    /** 监听网络层嗅探到的媒体流或文件 */
    onSniffedMedia: (callback: (media: FoundLink) => void) => () => void;
    /** 打开/关闭主进程网络层嗅探推送（默认关闭，由"持续嗅探"开关控制） */
    setSnifferEnabled: (enabled: boolean) => Promise<{ success: boolean; armed: boolean }>;
    /** 获取当前宿主转码与下载能力 (如 FFmpeg) */
    getDownloadCapabilities: () => Promise<DownloadCapabilities>;
    /** 调用原生下载引擎保存媒体文件 */
    downloadMedia: (payload: DownloadMediaParams) => Promise<DownloadMediaResult>;
    /** 取消正在进行的媒体下载（kill 子进程/请求，并删掉半成品文件） */
    cancelMediaDownload: (url: string) => Promise<{ success: boolean; message?: string }>;
    /** 媒体下载实时进度，返回取消订阅函数 */
    onMediaDownloadProgress: (callback: (progress: MediaDownloadProgress) => void) => () => void;
    /** 读取指定域名的 Cookie */
    getCookies: (url: string) => Promise<any[]>;
    /** 设置 Cookie 项 */
    setCookie: (details: any) => Promise<void>;
    /** 移除指定名称的 Cookie */
    removeCookie: (url: string, name: string) => Promise<void>;
    /** ACGMHO 画册下载服务 API (可选模块) */
    acgmho?: ElectronAcgmhoAPI;
    /** 应用设置 API (可选模块) */
    settings?: ElectronSettingsAPI;
    /** 知识库 API (可选模块) */
    kb?: ElectronKbAPI;
    /** 浏览器外壳 API (可选模块) */
    browser?: ElectronBrowserAPI;
    /** Edge 数据导入 API (可选模块) */
    edge?: ElectronEdgeAPI;
    /** Sukebei / Nyaa 资源搜索与种子 API (可选模块) */
    torrentFile?: ElectronTorrentFileAPI;
    /** 内置 BT 下载引擎 API (可选模块) */
    torrent?: ElectronTorrentAPI;
    /** 单文件 .gallery 打包保存 API (可选模块) */
    galleryPack?: ElectronGalleryPackAPI;
}

/**
 * 扩展后的全局 Window 接口声明，统一挂载强类型属性
 */
export interface AppWindow extends Window {
    /** Electron 桥接 API 实例 */
    electronAPI?: ElectronAPI;
}

/**
 * 集中获取强类型的应用窗口对象，杜绝 global 污染
 * @returns 包含 Electron 扩展的全局窗口对象
 */
export const getAppWindow = (): AppWindow => {
    return typeof window !== 'undefined' ? (window as unknown as AppWindow) : ({} as AppWindow);
};

/**
 * 安全获取注入的 ElectronAPI 实例。
 *
 * 返回 undefined 只意味着一件事：**preload 桥没加载**（加载故障）。
 * 它不是"另一种合法的运行环境"—— 本应用是桌面应用，永远在 Electron 里跑。
 * 所以调用点必须把 undefined 当故障报出来（提示重启），而不是静默降级。
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
    /**
     * 第一页 HTML 原文（仅内存传递：下载/抓取复用它免去重下一遍第 1 页）。
     * 体积大，禁止进 localStorage（落盘前必须剔除，见 useAcgmho.StoredProbe）。
     */
    firstHtml?: string;

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
    /** 配套探测结果（gid+前缀双匹配时复用，防同名异站帖子串台） */
    probe?: GalleryProbeResult;
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
 * 边下边播落盘：单页保存完成记录（主进程 file-done 事件携带）
 */
export interface GallerySavedFile {
    /** 页码（从 1 开始） */
    page: number;
    /** 原始远程直链 */
    url: string;
    /** 页标题 */
    title?: string;
    /** 本地 file:// URL（可直接塞进播放列表） */
    localUrl: string;
    /** 本地绝对路径 */
    savedPath: string;
    /** 文件大小（字节） */
    bytes: number;
}

/**
 * 边下边播落盘任务配置
 */
export interface GallerySaveOptions {
    /** 作品数字 ID */
    gid: string;
    /** 任务键（prefix:gid，缺省由渲染层按 prefix 推导，主进程回传进度时原样带回） */
    taskKey?: string;
    /** 作品标题（用于目录徽标/manifest） */
    title?: string;
    /** 站点前缀（用于重建 Referer 防盗链） */
    prefix?: string;
    /** 详情页地址（写入徽标来源） */
    sourceUrl?: string;
    /** 总页数提示（写入徽标） */
    totalPages?: number;
    /** 待保存的图片直链（页码升序为佳） */
    items: { page: number; url: string; title?: string }[];
    /** 自定义保存目录（默认 Downloads/acgmho/\<prefix\>-\<gid\>） */
    outDir?: string;
}

/**
 * 边下边播落盘进度通知
 */
export interface GallerySaveProgress {
    /** 作品数字 ID */
    gid: string;
    /** 任务键（prefix:gid）：同数字 gid 不同前缀的两本作品凭此区分进度 */
    taskKey?: string;
    /** 作品标题 */
    title?: string;
    /** 已落盘文件数 */
    doneFiles: number;
    /** 待保存文件总数 */
    totalFiles: number;
    /** 完成百分比（按文件数，0 ~ 100） */
    percent: number;
    /** 任务状态（复用下载状态机，另加 file-done 单页完成事件） */
    status: GalleryDownloadStatus | 'file-done';
    /** 状态文字说明 */
    message?: string;
    /** 落盘目录 */
    outDir?: string;
    /** 单页落盘完成时携带（status === 'file-done'） */
    file?: GallerySavedFile;
}

/**
 * 单文件包（.gallery 画廊 ZIP / .aibook 绘本 JSON）保存请求
 */
export interface GalleryPackSaveOptions {
    /** 建议文件名（不带路径，如 `我的画廊.gallery`）。后缀决定落盘类型与对话框过滤器 */
    fileName: string;
    /** 包字节 */
    data: ArrayBuffer;
}

/**
 * 单文件包保存结果
 */
export interface GalleryPackSaveResult {
    success: boolean;
    /** 用户取消了保存对话框 */
    cancelled?: boolean;
    /** 实际写入的绝对路径 */
    filePath?: string;
    /** 给用户的说明文字 */
    message?: string;
}

/**
 * Electron 注入的单文件包保存 API
 * （画廊 .gallery 与 AI 绘本 .aibook 共用，按 fileName 后缀区分类型）
 */
export interface ElectronGalleryPackAPI {
    /** 弹另存为对话框（默认下载目录 + 建议文件名），用户确认后写入 */
    savePack: (options: GalleryPackSaveOptions) => Promise<GalleryPackSaveResult>;
}

/**
 * 画册页面基础项数据
 */
export interface GalleryPageItem {
    /** 页码编号 */
    page: number;
    /** 本页图片直链（非详情页地址，可直接进播放列表/下载） */
    url: string;
    /** 页标题（如"标题 - P01/20"） */
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
    /** 本次事件新增的单页（失败页为 null，渲染层凭它流式进播放列表） */
    item?: GalleryPageItem | null;
    /** 抓取阶段状态 */
    status: GalleryFetchStatus;
}

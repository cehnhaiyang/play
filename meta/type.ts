/**
 * ============================================================================
 * 1. 媒体与资源基础类型
 * ============================================================================
 */

/**
 * 支持的媒体内容大类
 * - `video`: 视频文件或流媒体 (MP4, WebM, M3U8 等)
 * - `audio`: 音频文件 (MP3, FLAC, WAV 等)
 * - `image`: 静态或动态图像资源 (JPG, PNG, GIF, WebP 等)
 * - `stream`: 在线直播流或切片流协议
 * - `document`: 文档类资源 (PDF, TXT, EPUB 等)
 * - `gallery`: 画廊 (.gallery 徽标文件，代表一本多页图集)
 * - `other`: 其它未分类的多媒体/二进制资源
 */
export type MediaType = 'video' | 'audio' | 'image' | 'stream' | 'document' | 'gallery' | 'other';

/**
 * 视频资源输入源类型
 * - `file`: 本地物理文件或 Blob/File 对象
 * - `stream`: 网络在线流地址 (如 HLS / HTTP 流)
 */
export type VideoSourceType = 'file' | 'stream';

/**
 * ACG (动画/漫画/游戏/音频) 多媒体内容细分分类
 * - `manga`: 漫画 / 图集画册
 * - `animated_gallery`: 动图集 (包含动图的画册)
 * - `animation`: 动画短片 / 视频作品
 * - `asmr`: ASMR 音频 / 同人声音作品
 */
export type AcgCategory = 'manga' | 'animated_gallery' | 'animation' | 'asmr';

/**
 * 抓取或嗅探资源的数据源渠道
 * - `local`: 本地探测或已存在缓存
 * - `ai`: AI 分析或模型识别解析
 * - `network`: 网络嗅探器或 HTTP 抓取截获
 */
export type MediaSourceChannel = 'local' | 'ai' | 'network';

/**
 * 媒体文件所属的分组分类
 * - `ai-book`: AI 生成或解析的画集/电子书
 * - `folder`: 普通文件夹分组
 * - `gallery`: 画廊分组（一本多页图集，来自 .gallery 文件夹或 ACG 推送）
 */
export type MediaGroupType = 'ai-book' | 'folder' | 'gallery';

/**
 * ============================================================================
 * 2. 播放器渲染与控制类型
 * ============================================================================
 */

/**
 * 播放器画面内容适应容器模式 (等同于 CSS `object-fit`)
 * - `contain`: 保持原有比例缩放，完整展示在画面内（可能产生黑边）
 * - `cover`: 保持原有比例缩放并裁剪，填满整个播放容器
 * - `fill`: 不保持比例，拉伸画面以铺满整个容器
 */
export type ObjectFitMode = 'contain' | 'cover' | 'fill';

/**
 * 播放器循环与轮播模式枚举
 * 字符串枚举，在运行时保留具体字符串值，方便直接存储到 LocalStorage
 */
export enum PlaybackMode {
    /** 列表循环播放 */
    ListLoop = 'List Loop',
    /** 单曲/单个视频循环 */
    SingleLoop = 'Single Loop',
    /** 随机播放列表中的媒体 */
    Random = 'Random',
    /** 当前媒体播放完毕后停止 */
    StopAfter = 'Stop After',
}

/**
 * ============================================================================
 * 3. 音频引擎与音序合成类型
 * ============================================================================
 */

/**
 * 音频工作流引擎的运行生命周期状态
 */
export enum AppState {
    /** 空闲就绪状态 */
    IDLE = 'idle',
    /** 正在通过 AI/规则生成音频语法脚本 */
    GENERATING_SYNTAX = 'generating_syntax',
    /** 正在根据音轨配置与事件合成音频数据 */
    SYNTHESIZING_AUDIO = 'synthesizing_audio',
    /** 正在将合成结果导出为音频文件 (WAV/MP3) */
    EXPORTING_AUDIO = 'exporting_audio',
    /** 音频合成完成，缓冲就绪，等待播放 */
    READY = 'ready',
    /** 音频正在播放中 */
    PLAYING = 'playing',
    /** 音频引擎发生解析或渲染异常 */
    ERROR = 'error',
}

/**
 * 扩展音频振荡器波形类型
 * 在 Web Audio API 原生波形基础上扩充了白噪声、粉红噪声与自定义曲线
 */
export type ExpandedOscillatorType =
    | 'sine'         // 正弦波 (纯音)
    | 'square'       // 方波 (适合明亮、8-bit 风格音色)
    | 'sawtooth'     // 锯齿波 (富含泛音，适合弦乐与合成 Lead)
    | 'triangle'     // 三角波 (泛音较弱，适合柔和笛音与低音)
    | 'white_noise'  // 白噪声 (全频段均匀能量，适合打击乐/雨声)
    | 'pink_noise'   // 粉红噪声 (按倍频程衰减，适合海浪/环境音/风声)
    | 'brown_noise'  // 布朗噪声 (低频随机游走，适合雷鸣/低频轰鸣)
    | 'custom';      // 自定义 PeriodicWave 振荡周期

/**
 * 低频振荡器 (LFO) 调制的受控目标参数
 * - `frequency`: 调制音高/振荡频率 (颤音 Vibrato)
 * - `filter`: 调制滤波器截止频率 (自动哇音 Auto-Wah)
 * - `gain`: 调制增益/音量 (震音 Tremolo)
 * - `pan`: 调制立体声声像 (自动摇摆 Auto-Pan)
 * - `detune`: 调制失谐量，制造更宽的合唱/超级锯琴听感
 */
export type LFOTarget = 'frequency' | 'filter' | 'gain' | 'pan' | 'detune';

/**
 * 滤波器响应类型
 * 覆盖 Web Audio BiquadFilterNode 的全部可用类型，
 * 解析层据此白名单校验，避免把非法字符串塞进节点 type 触发运行时异常。
 */
export type FilterKind =
    | 'lowpass'
    | 'highpass'
    | 'bandpass'
    | 'notch'
    | 'lowshelf'
    | 'highshelf'
    | 'peaking'
    | 'allpass';

/**
 * 噪声色彩
 * - `white`: 全频段等能量，适合镲片、军鼓、雨声
 * - `pink`: 按倍频程衰减，适合海浪、风声、氛围铺底
 * - `brown`: 更低频的随机游走，适合雷鸣、低沉轰鸣
 */
export type NoiseColor = 'white' | 'pink' | 'brown';

/**
 * 包络分段曲线形态
 * - `linear`: 线性过渡，听感机械、可预测
 * - `exp`: 指数过渡，接近自然衰减（打击乐、拨弦的默认形态）
 * - `hold`: 阶梯保持，用于 S 段之前制造延迟感
 */
export type EnvelopeCurve = 'linear' | 'exp' | 'hold';

/**
 * 琶音音符扫描模式
 * - `up`: 从低音扫描到高音
 * - `down`: 从高音扫描到低音
 * - `upDown`: 往返扫描且首尾音不重复 (低 -> 高 -> 低)
 * - `downUp`: 反向往返扫描
 * - `asPlayed`: 严格按书写顺序循环
 * - `random`: 在和弦音中随机选取
 */
export type ArpPattern = 'up' | 'down' | 'upDown' | 'downUp' | 'asPlayed' | 'random';

/**
 * 鼓组音色合成模型
 * - `membrane`: 带音高包络的正弦膜振动（底鼓、通鼓、808 低音）
 * - `noise`: 噪声为主叠加带通塑形（军鼓、拍手、沙锤）
 * - `metallic`: 多个非谐分音叠加（镲片、踩镲、牛铃）
 */
export type DrumVoiceType = 'membrane' | 'noise' | 'metallic';

/**
 * 内置鼓组音色名
 * 通过 `hit("kick", "4n")` 之类的指令引用，无需自建乐器即可获得节奏声部。
 */
export type DrumName =
    | 'kick' | 'sub_kick' | 'snare' | 'rim' | 'clap'
    | 'hat' | 'open_hat' | 'pedal_hat'
    | 'tom_low' | 'tom_mid' | 'tom_high'
    | 'crash' | 'ride' | 'cowbell' | 'shaker' | 'tambourine';

/**
 * 效果器种类
 * - 时间类：`delay` `reverb`
 * - 失真类：`distortion` `bitcrush` `overdrive`
 * - 滤波类：`filter` (可做自动扫频) `eq`
 * - 动态类：`chorus` `flanger` `phaser` `tremolo` `compressor` `pingpong`
 */
export type EffectType =
    | 'delay' | 'pingpong' | 'reverb'
    | 'distortion' | 'bitcrush' | 'overdrive'
    | 'filter' | 'eq'
    | 'chorus' | 'flanger' | 'phaser' | 'tremolo'
    | 'compressor';

/**
 * 聊天交互消息角色
 * - `user`: 用户输入的指令或提示词
 * - `model`: AI 大模型返回的回复或乐谱代码
 * - `system`: 系统的预置提示词或上下文配置
 */
export type MessageRole = 'user' | 'model' | 'system';

/**
 * ============================================================================
 * 3.5 AI 服务类型
 * ============================================================================
 */

/**
 * AI 思考（推理）强度档位
 * 直接对应 OpenAI 兼容接口的 `reasoning_effort` 字段。
 * 注意：服务端对该字段做白名单校验，传入其它值会直接返回 503，
 * 因此这里是闭合联合而非 string。
 * - `low`: 最快、最省 token，适合格式转换类任务
 * - `high`: 平衡档，适合常规生成
 * - `max`: 最强推理，适合复杂修复与长链推理
 */
export type ReasoningEffort = 'low' | 'high' | 'max';

/**
 * AI 服务连接配置（OpenAI 兼容协议）
 * 由主进程 settings.json 持有，渲染层只通过 IPC 读写，密钥不落到渲染进程。
 */
export interface AiConfig {
    /** 接口基址，需带版本段，如 http://127.0.0.1:7863/v1（末尾斜杠会被归一化去掉） */
    baseUrl: string;
    /** 调用密钥；本地服务可为空串 */
    apiKey: string;
    /** 模型标识，如 global:deepseek-v4.1-flash */
    model: string;
    /** 思考强度档位 */
    reasoningEffort: ReasoningEffort;
}

/**
 * 单轮对话消息
 */
export interface AiChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

/**
 * 一次补全请求的可选参数
 */
export interface AiChatOptions {
    /** 系统提示词，会作为首条 system 消息插入 */
    system?: string;
    /** 对话消息列表 */
    messages: AiChatMessage[];
    /** 采样温度 */
    temperature?: number;
    /** 回复长度上限 */
    maxTokens?: number;
    /** 要求模型返回严格 JSON 对象 */
    jsonMode?: boolean;
    /** 覆盖默认思考强度（不传则用配置里的档位） */
    reasoningEffort?: ReasoningEffort;
}

/**
 * AI 连接测试结果
 */
export interface AiTestResult {
    success: boolean;
    message: string;
    /** 往返耗时（毫秒） */
    latency?: number;
    /** 服务端回显的实际模型名 */
    model?: string;
    /** 服务端返回内容的截断预览 */
    reply?: string;
}

/**
 * ============================================================================
 * 4. 网络劫持与存储类型
 * ============================================================================
 */

/**
 * 浏览器存储类型标识
 * - `cookie`: HTTP Cookie
 * - `local`: localStorage 本地持久化存储
 * - `session`: sessionStorage 会话级存储
 */
export type StorageType = 'cookie' | 'local' | 'session';

/**
 * ============================================================================
 * 5. 图集下载生命周期状态
 * ============================================================================
 */

/**
 * 画册全量下载过程中的任务进度状态
 * - `probing`: 探测解析画册元数据中
 * - `downloading`: 正在批量下载图片资源
 * - `completed`: 画册全部内容下载并写入完成
 * - `cancelled`: 下载任务已被取消
 * - `error`: 下载过程中遇到错误
 */
export type GalleryDownloadStatus = 'probing' | 'downloading' | 'completed' | 'cancelled' | 'error';

/**
 * 画册页面拉取阶段的状态
 * - `fetching`: 正在分页拉取页面信息
 * - `completed`: 页面信息拉取完毕
 * - `cancelled`: 已取消拉取
 * - `error`: 拉取失败
 */
export type GalleryFetchStatus = 'fetching' | 'completed' | 'cancelled' | 'error';

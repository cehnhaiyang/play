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
 * AI 思考（推理）强度档位：界面与配置里只有这三档
 *
 * 各服务商的 reasoning_effort 取值不同（OFM 用 light / balanced / deep），
 * 下发前由 AiService.resolveReasoningEffort 按服务商、模型映射。
 *
 * - `low`: 最快、最省 token
 * - `high`: 平衡档，适合常规生成
 * - `max`: 最强推理，最慢
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
 * 多模态消息内容块（OpenAI /chat/completions 的 content 数组形态）
 *
 * 纯文本消息仍可直接用字符串，只有需要带图（AI 绘本读图、OCR）时才用数组。
 */
export type AiContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } };

/**
 * 单轮对话消息
 */
export interface AiChatMessage {
    role: 'system' | 'user' | 'assistant';
    /** 纯文本用 string；带图消息用 AiContentPart[] */
    content: string | AiContentPart[];
}

/**
 * 流式增量。
 *
 * content 与 reasoning 分开：推理模型的思考过程与最终答复是两条独立的流，
 * 混在一起会让"已经想完了吗"完全看不出来。
 */
export interface AiStreamDelta {
    /** 正文增量 */
    content?: string;
    /** 推理过程增量（推理模型才有，字段名各家不一，服务层已归一化） */
    reasoning?: string;
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
    /**
     * 流式回调。传入即请求 stream:true，并在每个增量到达时调用；
     * **返回值仍是完整文本**，调用方无需自己拼接。
     *
     * 服务端不认 stream 时会自动回落成一次性请求（见 AiService.chat）。
     */
    onDelta?: (delta: AiStreamDelta) => void;
    /** 中断信号。中止后 fetch 抛 AbortError，调用方据此区分"用户停止"与"真失败" */
    signal?: AbortSignal;
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
 * 3.5 AI 绘本（读图成书）
 * ============================================================================
 */

/**
 * 送入模型的一张图片。
 * base64 不含 `data:...;base64,` 前缀，由调用方拆好。
 */
export interface AiImageInput {
    /** Base64 编码的图片数据（不含 data URL 前缀） */
    base64: string;
    /** MIME 类型，如 image/png；缺失时按 image/png 处理 */
    mimeType?: string;
}

/**
 * AI 根据一组图片创作出的故事
 */
export interface AiStory {
    /** 故事标题 */
    title: string;
    /** 与输入图片一一对应的分页文案 */
    pages: string[];
}

/**
 * .aibook 单文件（JSON）结构
 *
 * 与播放列表的 VideoFile 是两套东西：VideoFile 是运行时条目，
 * .aibook 是可落盘/可分享的归档格式，图片内联为 data URL。
 */
export interface AiBookPage {
    /** 图片的 data URL（或远程 URL） */
    image: string;
    /** 该页文案 */
    text: string;
    /** 该页语音（Base64 PCM，可选，朗读后缓存） */
    audio?: string;
}

export interface AiBookFile {
    /** 格式版本，便于以后演进 */
    version: string;
    /** 书名 */
    title: string;
    pages: AiBookPage[];
}

/**
 * ============================================================================
 * 3.7 Agent 工作空间（在已登录页面里执行脚本）
 * ============================================================================
 *
 * 形状是「代码执行器」而不是「点击驱动器」：
 * 工具只有"在页面主世界跑一段脚本"和"导航"，点击/输入/取数全部塌缩成脚本里的一行。
 * 原因是上下文经济学 —— 每次观察都要序列化进模型上下文，
 * 而 DOM 快照动辄数万 token；脚本的返回值可以截断，代码本身高度可压缩。
 */

/**
 * Agent 可调用的工具名。
 *
 * `S` 是脚本工具，用 args.action 选四件事：R 运行 / L 列出 / S 保存 / D 删除。
 * 四者合并成一个工具是**上下文成本**的取舍：工具说明每步随请求重发一次，
 * 拆成四个条目要多花约 400 字节 × 步数，而它们本就共享同一份状态（脚本清单）。
 *
 * 后三个是把**用户手动面板里的能力**开放给模型：拦截规则、存储、令牌。
 * 它们不是 `S` 的替代 —— 规则类能力必须在引擎层生效（钩子装在页面主世界，
 * 脚本只能影响自己那一次调用），存储类能力必须走原生 API
 * （Cookie 在渲染进程里读不到 HttpOnly）。
 *
 * `kb` 是知识库检索，与上面五个都不同：它**不碰页面**，只读本地文章。
 * 放在这里是因为它的消费者就是 Agent —— 模型在动手前先查库，
 * 比从零推理页面结构划算得多。
 */
export type AgentToolName =
    | 'S'
    | 'navigate'
    | 'tamper_rules'
    | 'storage'
    | 'tokens'
    | 'kb';

/**
 * 对话流里的一条消息。
 *
 * 这里不复用 AiChatMessage：那条是发给模型的协议消息，
 * 这条是界面上的记录，多了脚本源码、成功标记、时间戳等仅供展示的字段。
 */
export interface AgentMessage {
    id: string;
    role: 'user' | 'assistant' | 'tool';
    /** 助手轮次的说明文字；工具消息为结果摘要 */
    content: string;
    /**
     * 界面自己生成的提示，**不是模型说的话**。
     *
     * 中断、空回复、步数耗尽这三种结束方式都要给用户一个交代，于是这里补一条
     * assistant 消息。但它进不了模型上下文：重建历史时若原样当作模型的输出回放，
     * 模型会读到一句自己从未写过的"（模型本轮没有返回内容…）"，
     * 进而把界面文案当成自己的承诺。重建时按环境提示写回（见 buildTranscript）。
     */
    notice?: boolean;
    /**
     * 这一轮的推理过程（推理模型才有，可空）。
     *
     * 必须落进消息本身：它原先只活在流式气泡上，而气泡在每步结束时就被
     * `setStreaming(null)` 收掉了 —— 于是这轮交互一结束，用户再也找不到
     * 模型当时的判断依据。事后想复盘"它为什么改了这个字段"时，
     * 唯一能回答的就是这段文字，所以它得跟消息一起进列表、一起落盘。
     */
    reasoning?: string;
    /** 工具消息：调用的工具名 */
    tool?: AgentToolName;
    /**
     * 工具消息：工具名 + 动作（如 S·R）。
     *
     * 重建模型上下文时要用它：只写 "S" 的话，「跑脚本 / 列清单 / 存脚本 / 删脚本」
     * 在历史里长得一模一样，模型看不出自己上一轮到底做过哪一件。
     */
    label?: string;
    /**
     * 工具消息：由 urlPattern 自动触发，不属于任何一次模型调用。
     *
     * 必须与模型自己发起的调用区分开 —— 重建上下文时若把自动执行的结果写成
     * 「工具 X 的执行结果」，等于凭空捏造一次模型从未发出的调用。
     */
    auto?: boolean;
    /** 工具消息：执行的脚本源码（供界面展开查看） */
    script?: string;
    /** 工具消息：是否执行成功 */
    ok?: boolean;
    /** 工具消息：回传给模型的完整观察结果（已截断） */
    result?: string;
    at: number;
}

/**
 * 保存下来的脚本。
 *
 * `urlPattern` 非空时，页面 dom-ready 且 URL 命中即自动执行 ——
 * 这一步复用 useBrowse 的 onPageReady 广播，不需要另挂监听。
 */
export interface AgentScript {
    id: string;
    name: string;
    /** 用途说明，会进系统提示词帮模型挑选 */
    description: string;
    code: string;
    /** URL 子串匹配；空串表示只在对话中被显式调用 */
    urlPattern: string;
    enabled: boolean;
    /** 最近一次执行时间（含自动执行） */
    lastRunAt?: number;
    /** 最近一次执行结果（已截断，供界面显示） */
    lastResult?: string;
}

/** Agent 循环的运行状态 */
export type AgentRunStatus = 'idle' | 'thinking' | 'acting';

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

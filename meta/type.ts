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
 * 各模型认的 reasoning_effort 取值可能不同，下发前由
 * AiService.resolveReasoningEffort 按**模型**映射；映射结果为空即不下发该参数。
 *
 * - `low`: 最快、最省 token
 * - `high`: 平衡档，适合常规生成
 * - `max`: 最强推理，最慢
 */
export type ReasoningEffort = 'low' | 'high' | 'max';

/** 界面上的一个档位：value 是配置里的档位（缺省即「不思考」），label 是按钮文字 */
export interface AiEffortOption {
    /** 缺省表示不下发思考参数 */
    value?: ReasoningEffort;
    label: string;
    hint: string;
}

/** 服务商认的取值：low / high / max 换成它认的写法；未列出的档位原样下发 */
export type AiEffortMap = Partial<Record<ReasoningEffort, string>>;

/**
 * 模型预设：思考配置挂在这里，不挂服务商。
 *
 * 同一个服务商下不同模型对 reasoning_effort 的态度可以完全相反 —— 实测
 * agent2api 的 GET /v1/models 逐个模型给出 supports_reasoning 字段，
 * LongCat-2.0 是 false，glm-5.3 / deepseek-v4 / kimi-k3 是 true。
 * 挂在服务商上就表达不了这种差异：选一次服务商，只能对所有模型统一下发或统一不发。
 */
export interface AiModelPreset {
    /** 下发给服务商的模型标识，界面也用它显示 */
    id: string;
    /**
     * 该模型是否需要思考档位。
     * `false` = 不需要：整条链路都不带 reasoning_effort（档位可能已写进模型名）。
     * 缺省视为需要。
     */
    reasoning?: boolean;
    /** 该模型的档位映射 */
    efforts?: AiEffortMap;
}

/** 服务商预设：地址、密钥与模型候选；思考配置属于模型，服务商不持有 */
export interface AiProviderPreset {
    id: string;
    /** 按钮文字 */
    label: string;
    /** 按钮悬浮提示 */
    note: string;
    baseUrl: string;
    apiKey: string;
    /** 该服务商的模型候选；第一个是套用预设时的默认值 */
    models: AiModelPreset[];
}

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
    /**
     * 思考强度档位。
     *
     * 可选：缺省即「不思考」，请求不下发 reasoning_effort，交给服务商默认行为。
     * 当前模型预设声明不需要思考（AiService.AI_PROVIDERS 里模型的 reasoning 为 false）
     * 时同样不下发，档位是否真的下发要看 AiService.resolveReasoningEffort。
     */
    reasoningEffort?: ReasoningEffort;
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
 * 一次补全请求的 token 用量。
 *
 * `estimated` 是这份数据最要紧的字段：服务端不回 usage 时由本地按字符类别估算
 * （见 AiService.estimateTokens），误差约 ±20%。界面必须把两者分开显示 ——
 * 把估算值当账单展示，用户会照着它去核对计费。
 */
export interface AiUsage {
    /** 输入 token（系统提示词 + 全部历史） */
    promptTokens: number;
    /** 输出 token */
    completionTokens: number;
    /** 合计 */
    totalTokens: number;
    /** true = 本地估算；false = 服务端实测 */
    estimated: boolean;
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
    /**
     * 本次请求的 token 用量回调，**成功收到回复后**调用一次（失败不调用）。
     *
     * 服务端回了 usage 就是实测值；没回（流式默认不带、部分本地代理不带）则由
     * AiService 按完整入参估算 —— 估算只能在这一层做：系统提示词是在 chat 内部
     * 拼进 messages 的，调用方手上那份不含它，自己估算会系统性少算一大截。
     */
    onUsage?: (usage: AiUsage) => void;
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

/** .aibook 文本解析结果（书名缺省时已回落到调用方给的 fallback） */
export interface ParsedAiBook {
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
 * Agent 可调用的工具名（全小写，严格匹配）。
 *
 * `js` 是执行器（在页面主世界跑一段脚本），`script_store` 管脚本的持久化
 * （列出 / 保存 / 更新 / 删除）；两者分开是因为“跑一次”与“存下来复用”是
 * 两件不同的事， prompt 里各占一条，模型不会把它们搞混。
 *
 * 后五个是把**用户手动面板里的能力**开放给模型：导航、拦截规则、存储、令牌、
 * 知识库。规则类能力必须在引擎层生效（钩子装在页面主世界，脚本只能影响自己
 * 那一次调用），存储类能力必须走原生 API（Cookie 在渲染进程里读不到 HttpOnly）。
 *
 * `kb` 只读本地文章，不碰页面。
 */
export type AgentToolName =
    | 'js'
    | 'script_store'
    | 'navigate'
    | 'tamper'
    | 'storage'
    | 'tokens'
    | 'kb';

/**
 * 一条工具消息的来源：谁让它跑的。
 *
 * 两个值对模型有实质区别，不是同义标签：
 * - `auto`：urlPattern 命中，页面就绪时自动跑的（副作用，该当背景）
 * - `manual`：用户在脚本页亲手点的「运行」（刚验证过这段脚本，是有效信号）
 */
export type AgentMessageOrigin = 'auto' | 'manual';

/**
 * 对话流里的一条消息。
 *
 * 这里不复用 AiChatMessage：那条是发给模型的协议消息，
 * 这条是界面上的记录，多了脚本源码、成功标记、时间戳等仅供展示的字段。
 */
export interface AgentMessage {
    id: string;
    role: 'user' | 'assistant' | 'tool';
    /**
     * 正文。
     *
     * 助手轮次是它说的话（或界面补的提示，见 notice）；工具消息是这一步做了什么
     * —— 模型发起的调用写 thought，环境事件（见 origin）写脚本名。
     */
    content: string;
    /**
     * 界面自己生成的提示，**不是模型说的话**。
     *
     * 四种结束方式都要给用户一个交代，于是这里补一条 assistant 消息：中断、
     * 空回复、连续协议错误放弃、轮内上下文超限。但它进不了模型上下文：重建历史时
     * 若原样当作模型的输出回放，模型会读到一句自己从未写过的"（模型本轮没有
     * 返回内容…）"，进而把界面文案当成自己的承诺。重建时按系统提示写回
     * （见 buildTranscript）。
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
     * 工具消息：工具名 + 动作（如 script_store·save）。
     *
     * 重建模型上下文时要用它：只写 "script_store" 的话，「列清单 / 存脚本 /
     * 改脚本 / 删脚本」在历史里长得一模一样，模型看不出自己上一轮到底做过哪一件。
     */
    label?: string;
    /**
     * 工具消息：这条**不是模型发出的调用**，而是脚本被跑了一次；值即来源
     * （见 {@link AgentMessageOrigin}）。缺省即模型自己发起的调用。
     *
     * 两个消费者都只读这一个字段，不从 label 或正文里各猜一次：
     *  - 重建上下文（buildTranscript）—— 写成「工具 X 的执行结果」等于凭空捏造
     *    一次模型从未发出的调用，它会以为自己已经跑过那段脚本；
     *  - 界面角标 —— 从别处猜的话，「谁按的」与「哪来的」会各说一套。
     */
    origin?: AgentMessageOrigin;
    /** 工具消息：执行的脚本源码（供界面展开查看） */
    script?: string;
    /** 工具消息：是否执行成功 */
    ok?: boolean;
    /** 工具消息：回传给模型的完整观察结果（已截断） */
    result?: string;
    /**
     * 这条消息对应的那次模型调用的 token 用量。
     *
     * 落在消息上而不是只维护一个累计值：删除一条或回退一轮之后，累计值必须能
     * 重算（见 AgentUsage）。界面自己补的提示（notice）没有用量 —— 它不是
     * 模型说的话，也就没有对应的调用。
     */
    usage?: AiUsage;
    /**
     * 上下文压缩记录。带这个字段的消息是压缩的**分界线**，
     * 不是模型的发言也不是用户的提问 —— 界面据此画一条明显的分隔条。
     */
    compaction?: AgentCompaction;
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
 * 一次上下文压缩的结果：旧消息交给模型压成结构化摘要，保留最近若干条原文。
 *
 * 摘要必须**落进对话流**而不是只留一份文本：压缩是不可逆的 —— 被压掉的原文
 * 在界面上仍然逐条可见，用户需要一条明确的分界线知道"这之前的已经不在
 * 上下文里了"，否则他会以为模型还记得上面那些内容。
 */
export interface AgentCompaction {
    /** 摘要正文（结构化 Markdown），作为一条 user 消息置于上下文最前 */
    summary: string;
    /**
     * 摘要覆盖到哪一条消息为止（含该条）—— 分界线**插入时的锚点**。
     *
     * 用**消息 id** 而不是轮次下标：用户删掉中间一条、或回退到某轮之后，
     * 下标就全错位了。
     *
     * 注意它只是锚点，不是"这条压缩还算不算数"的判据：插完之后边界由承载
     * 摘要的那条消息在流里的**位置**回答（见 buildTranscript）。按 upTo 反查
     * 的话，用户单条删掉这个锚点就会让一份本来有效的摘要被误判成失效。
     */
    upTo: string;
    /** 压缩完成时刻 */
    at: number;
    /** 被压掉（不再逐条回放）的消息条数 */
    coveredMessages: number;
    /**
     * 其中**真正送进摘要器**的消息条数。
     *
     * 小于 coveredMessages 时差额是被直接丢弃的：摘要器的输入有上限，
     * 超出部分连摘要都没有。界面必须如实说出这个差额 ——
     * 否则用户以为"压过的都还记得"，而实际上有几条是彻底没了。
     */
    summarizedMessages: number;
    /** 压缩前上下文的估算 token 数 */
    beforeTokens: number;
    /** 压缩后上下文的估算 token 数 */
    afterTokens: number;
    /**
     * 压缩后是否**仍未**回到硬门槛以内。
     *
     * 为 true 时界面必须继续警示并保持输入框禁用：压缩没解决问题，
     * 而"压缩完成"的绿色提示会把用户引向错误的安心。
     */
    overBudget: boolean;
}

/**
 * 会话导出的选项。
 *
 * 定义在 meta 而不是 const.ts：导出的两个 builder 与导出动作分处两处，
 * 对缺省的理解必须一致（见 resolveExportOptions）。
 */
export interface AgentExportOptions {
    /**
     * 是否写入推理过程，默认 true。
     *
     * 关掉后文件里连 `<details>` 都不出现，但**文件头会注明"不含推理"** ——
     * 否则读到一份没有推理的记录，人只会以为模型当时没思考。
     */
    includeReasoning?: boolean;
    /**
     * 文件名与文件头共用的时间戳，默认取当前时刻。
     *
     * 必须是同一个时刻：分两次取的话，文件名的时间与文件头写的对不上，
     * 导两份还会出现同名覆盖。
     */
    at?: number;
}

/** 会话累计 token 统计（按现存消息重算，删除 / 回退后自动收敛） */
export interface AgentUsage {
    /** 累计输入 token（每次模型调用的 prompt 都计入，不做任何去重） */
    promptTokens: number;
    /** 累计输出 token */
    completionTokens: number;
    /** 合计 */
    totalTokens: number;
    /** 模型调用次数 */
    calls: number;
    /** 其中有多少次是本地估算（服务端未回 usage） */
    estimatedCalls: number;
    /**
     * 当前上下文占用：**按现存消息重建后**的输入 token 估算。
     *
     * 与累计值是两个问题：累计值回答"这个会话花了多少"，这个回答"下一次请求
     * 要发多少" —— 后者才是决定何时该压缩的那个数。
     *
     * 刻意不用"最近一次调用的实测 promptTokens"：实测值只在发过请求之后才有，
     * 而用户刚删掉几轮、或刚压缩完时正需要看到当前占用 —— 那时一个陈旧的
     * 实测值比估算更误导。所以这个数**永远是估算**，界面统一带 ~ 标注。
     */
    contextTokens: number;
}

/**
 * JWT 解码结果。两段都保持 unknown：payload 的形状由签发方决定，
 * 这里只负责拆段与解码，不替调用方猜字段。
 */
export interface DecodedJwt {
    header: unknown;
    payload: unknown;
}

/**
 * 被篡改引擎跳过的规则，附带它在原数组里的下标与原因。
 *
 * 下标是给模型/用户**定位**用的：只说"有 2 条被跳过"没用，
 * 得说清是第几条、缺哪个字段，才能一步改对。
 */
export interface DroppedRule {
    /** 在哪一类规则里：intercept / request / headers */
    group: 'intercept' | 'request' | 'headers';
    /** 在该数组里的下标（0 起） */
    index: number;
    /** 缺什么 */
    reason: string;
}

/**
 * ============================================================================
 * 6. 运行日志
 * ============================================================================
 */

export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

/** 一条运行日志。主进程日志将来合并进来时直接填 source，面板不用改 */
export interface LogEntry {
    seq: number;
    /** Date.now() */
    ts: number;
    level: LogLevel;
    /** 格式化后的纯文本，不存原始对象（省内存、落盘小、无循环引用） */
    message: string;
    /** 日志来源：现在只有渲染层，主进程合并进来时填 'main' */
    source: 'renderer';
}

/**
 * ============================================================================
 * 8. 图集下载生命周期状态
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

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
    | 'custom';      // 自定义 PeriodicWave 振荡周期

/**
 * 低频振荡器 (LFO) 调制的受控目标参数
 * - `frequency`: 调制音高/振荡频率 (颤音 Vibrato)
 * - `filter`: 调制滤波器截止频率 (自动哇音 Auto-Wah)
 * - `gain`: 调制增益/音量 (震音 Tremolo)
 * - `pan`: 调制立体声声像 (自动摇摆 Auto-Pan)
 */
export type LFOTarget = 'frequency' | 'filter' | 'gain' | 'pan';

/**
 * 琶音音符扫描模式
 * - `up`: 从低音扫描到高音
 * - `down`: 从高音扫描到低音
 * - `upDown`: 往返扫描 (低 -> 高 -> 低)
 * - `random`: 在和弦音中随机选取
 */
export type ArpPattern = 'up' | 'down' | 'upDown' | 'random';

/**
 * 聊天交互消息角色
 * - `user`: 用户输入的指令或提示词
 * - `model`: AI 大模型返回的回复或乐谱代码
 * - `system`: 系统的预置提示词或上下文配置
 */
export type MessageRole = 'user' | 'model' | 'system';

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

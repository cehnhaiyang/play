import type {
    AiChatMessage,
    AiChatOptions,
    AiConfig,
    AiTestResult,
    FoundLink,
    MediaType,
    ReasoningEffort,
} from '../meta';
import { getElectronAPI } from '../meta';
import { loadStr, saveStr } from '../utils/persist';
import { PRESET_NAMES } from './AudioService/audioEngine/presets';
import { DRUM_NAMES } from './AudioService/audioEngine/drums';

/**
 * ============================================================================
 * AI 服务（OpenAI 兼容协议）
 * ============================================================================
 *
 * 设计要点：
 *
 * 1. **协议而非厂商**。只依赖 /chat/completions 这一套事实标准，不再绑定任何
 *    单一厂商 SDK。换服务商只改设置里的地址与模型名，不动代码。
 *
 * 2. **配置真值在主进程**。密钥等敏感配置由主进程 settings.json 持有，渲染层
 *    通过 IPC 读写。这样设置面板只有一个数据源，也避免密钥散进 localStorage。
 *
 * 3. **浏览器环境可降级**。纯 Web 调试（无 Electron）时没有主进程，此时回落到
 *    localStorage，让 npm run dev 下 AI 功能仍可联调。
 *
 * 4. **不缓存客户端实例**。配置可能随时被设置面板改掉，缓存会拿到过期配置；
 *    每轮对话现读配置的开销远小于一次网络请求本身。
 */

/* -------------------------------------------------------------------------- */
/*                                配置读写                                     */
/* -------------------------------------------------------------------------- */

/** 浏览器降级模式下的存储键 */
const AI_CONFIG_STORAGE_KEY = 'play_ai_config';

/** 与服务端白名单一致；非法值服务端直接 503，所以本地先挡一道 */
const REASONING_EFFORTS: ReasoningEffort[] = ['low', 'high', 'max'];

/** 默认配置：本地 tc2api，开箱即用 */
export const DEFAULT_AI_CONFIG: AiConfig = {
    baseUrl: 'http://127.0.0.1:7863/v1',
    apiKey: '1',
    model: 'global:deepseek-v4.1-flash',
    reasoningEffort: 'low',
};

/** 把任意输入收敛成一份字段齐全且合法的配置 */
const normalizeConfig = (input: Partial<AiConfig> | null | undefined): AiConfig => {
    const raw = input && typeof input === 'object' ? input : {};
    const effort = raw.reasoningEffort as ReasoningEffort | undefined;
    return {
        baseUrl: (raw.baseUrl || '').trim().replace(/\/+$/, '') || DEFAULT_AI_CONFIG.baseUrl,
        apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : DEFAULT_AI_CONFIG.apiKey,
        model: (raw.model || '').trim() || DEFAULT_AI_CONFIG.model,
        reasoningEffort: effort && REASONING_EFFORTS.includes(effort) ? effort : DEFAULT_AI_CONFIG.reasoningEffort,
    };
};

/**
 * 读取当前 AI 配置。
 * 优先问主进程；浏览器环境或 IPC 失败时回落到 localStorage。
 */
export const getAiConfig = async (): Promise<AiConfig> => {
    const settingsApi = getElectronAPI()?.settings;
    if (settingsApi) {
        try {
            const snapshot = await settingsApi.get();
            if (snapshot?.ai) return normalizeConfig(snapshot.ai);
        } catch (_error) {
            // 主进程暂时不可用：继续往下走浏览器回落，不直接抛错
        }
    }

    try {
        const cached = loadStr(AI_CONFIG_STORAGE_KEY, '', '');
        if (cached) return normalizeConfig(JSON.parse(cached) as Partial<AiConfig>);
    } catch (_error) {
        // 存量配置损坏：按默认值起步
    }

    return { ...DEFAULT_AI_CONFIG };
};

/**
 * 保存 AI 配置。返回主进程（或回落存储）给出的结果。
 * 主进程会做字段校验，非法值不会落盘。
 */
export const saveAiConfig = async (config: AiConfig): Promise<{ success: boolean; message?: string; ai?: AiConfig }> => {
    const settingsApi = getElectronAPI()?.settings;
    if (settingsApi) {
        try {
            const res = await settingsApi.setAiConfig(config);
            if (res?.success && res.ai) return { success: true, message: res.message, ai: res.ai };
            if (res && !res.success) return { success: false, message: res.message };
        } catch (error) {
            return { success: false, message: error instanceof Error ? error.message : '保存失败' };
        }
    }

    // 浏览器回落：本地没有主进程那套校验，这里自己挡一次非法档位
    const normalized = normalizeConfig(config);
    const ok = saveStr(AI_CONFIG_STORAGE_KEY, JSON.stringify(normalized), '');
    return ok
        ? { success: true, message: '已保存到浏览器本地存储', ai: normalized }
        : { success: false, message: '浏览器存储写入失败（可能配额已满）' };
};

/**
 * 测试当前配置能否真正调通。
 * 主进程侧发请求；浏览器回落时用 fetch 自行探测。
 */
export const testAiConnection = async (config: AiConfig): Promise<AiTestResult> => {
    const settingsApi = getElectronAPI()?.settings;
    if (settingsApi) {
        try {
            return await settingsApi.testAiConfig(config);
        } catch (error) {
            return { success: false, message: error instanceof Error ? error.message : '测试失败' };
        }
    }

    const normalized = normalizeConfig(config);
    const startedAt = Date.now();
    try {
        const response = await fetch(`${normalized.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(normalized.apiKey ? { Authorization: `Bearer ${normalized.apiKey}` } : {}),
            },
            body: JSON.stringify({
                model: normalized.model,
                messages: [{ role: 'user', content: 'ping' }],
                // 128 而非 8：推理模型的思考过程也占 completion 预算，
                // 给太小会导致 content 为空，探活看起来"通了但没回话"
                max_tokens: 128,
                reasoning_effort: normalized.reasoningEffort,
            }),
        });
        const latency = Date.now() - startedAt;
        const text = await response.text();
        if (!response.ok) return { success: false, message: `HTTP ${response.status}：${text.slice(0, 300)}` };

        let reply = '';
        let model = normalized.model;
        try {
            const data = JSON.parse(text);
            reply = data?.choices?.[0]?.message?.content || '';
            model = data?.model || model;
        } catch (_error) {
            // 200 但非 JSON：仍算连通
        }
        return { success: true, message: `连接正常（${latency}ms）`, latency, model, reply: String(reply).slice(0, 120) };
    } catch (error) {
        const reason = error instanceof Error ? error.message : '未知错误';
        return { success: false, message: `连接失败：${reason}` };
    }
};

/* -------------------------------------------------------------------------- */
/*                                底层调用                                     */
/* -------------------------------------------------------------------------- */

/** 服务端错误正文里的 message 字段，比裸状态码有用得多 */
const extractErrorMessage = (status: number, body: string): string => {
    try {
        const parsed = JSON.parse(body);
        const detail = parsed?.error?.message || parsed?.message;
        if (typeof detail === 'string' && detail.trim()) return detail.trim();
    } catch (_error) {
        // 非 JSON 错误正文：直接截断原文
    }
    return body.trim().slice(0, 300) || `HTTP ${status}`;
};

/**
 * 发起一次对话补全，返回助手回复文本。
 *
 * 失败一律抛 Error（带服务端原文），由调用方决定如何提示用户——
 * 这里不吞异常，否则界面会把"密钥错了"显示成"未找到资源"。
 */
export const chat = async (options: AiChatOptions): Promise<string> => {
    const config = await getAiConfig();
    const messages: AiChatMessage[] = options.system
        ? [{ role: 'system', content: options.system }, ...options.messages]
        : options.messages;

    const payload: Record<string, unknown> = {
        model: config.model,
        messages,
        // 思考强度是服务端白名单字段，始终显式下发，避免依赖服务端默认值
        reasoning_effort: options.reasoningEffort || config.reasoningEffort,
    };
    if (typeof options.temperature === 'number') payload.temperature = options.temperature;
    if (typeof options.maxTokens === 'number') payload.max_tokens = options.maxTokens;
    if (options.jsonMode) payload.response_format = { type: 'json_object' };

    let response: Response;
    try {
        response = await fetch(`${config.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
            },
            body: JSON.stringify(payload),
        });
    } catch (error) {
        // 网络层失败（服务没起、端口不通、被 CSP 拦）走这里
        const reason = error instanceof Error ? error.message : '未知网络错误';
        throw new Error(`无法连接 AI 服务（${config.baseUrl}）：${reason}`);
    }

    const text = await response.text();
    if (!response.ok) {
        throw new Error(`AI 服务返回错误：${extractErrorMessage(response.status, text)}`);
    }

    let data: { choices?: { message?: { content?: string } }[] };
    try {
        data = JSON.parse(text);
    } catch (_error) {
        throw new Error('AI 服务返回了无法解析的内容，请确认接口地址指向 OpenAI 兼容服务。');
    }

    return data?.choices?.[0]?.message?.content || '';
};

/* -------------------------------------------------------------------------- */
/*                                文本清洗                                     */
/* -------------------------------------------------------------------------- */

/** 去除 Markdown 代码块围栏与首尾空白 */
export const cleanCodeBlock = (text: string): string => {
    if (!text) return '';
    const codeBlockRegex = /```(?:spg|[\w]*)?\n([\s\S]*?)```/;
    const match = text.match(codeBlockRegex);
    if (match && match[1]) return match[1].trim();
    return text.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
};

/** 从可能带围栏/前后缀的回复里抠出 JSON 数组 */
const extractJsonArray = (text: string): unknown[] | null => {
    if (!text) return null;
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return null;
    try {
        const parsed = JSON.parse(match[0]);
        return Array.isArray(parsed) ? parsed : null;
    } catch (_error) {
        return null;
    }
};

/* -------------------------------------------------------------------------- */
/*                                SPG 音频生成                                 */
/* -------------------------------------------------------------------------- */

/**
 * 预设名与鼓组名从引擎实现处导入，而不是在提示词里手抄一份。
 * 手抄的清单会随代码演进而失配（此前提示词教了乐器级 effect_chain，
 * 而解析器并不支持，模型据此生成的代码必然编译失败）。
 */
const presetList = (): string => PRESET_NAMES.join(', ');
const drumList = (): string => DRUM_NAMES.join(', ');

/** 系统提示词：告诉 AI 如何生成 .spg 语法 */
const SPG_SYSTEM_PROMPT = `
你是一位世界级的作曲家和音频工程师，精通 "Sound Particle Generator" (SPG) 语言。
你的任务是把自然语言描述转写成**可编译、且音乐性优秀**的 SPG 代码。

==================== 输出纪律（最重要） ====================
1. 只输出 SPG 代码本身，不要 Markdown 围栏、不要解释、不要寒暄。
2. 只能使用下面文档里出现过的语法。**不要发明语法**：解析器对未知指令、未知参数会直接报错。
3. 缩进用 2 空格。可写 \`#\` 或 \`//\` 注释。
4. 写完在心里过一遍：括号配对、引号配对、每个 sequence 都被 mix 引用、每个音名都是合法音名。

==================== 文件结构 ====================
SPG 由五部分组成，顺序任意，但通常写成：config → define_instrument → sequence → effect_chain → mix。

#### 1. config（全局配置，最多一个）
\`\`\`
config {
  tempo: 120          # BPM，必须 > 0
  master_gain: 0.6    # 总音量，0~2
}
\`\`\`

#### 2. define_instrument（乐器定义）
\`\`\`
define_instrument(name="lead") {
  preset: "supersaw"       # 可选，从下面的预设表里选，作为参数基线
  wave: "sawtooth"         # 覆盖预设
  gain: 0.6
  pan: -0.2
}
\`\`\`

**可用预设**：${presetList()}

**波形 wave**：sine | square | sawtooth | triangle | white_noise | pink_noise | brown_noise

**全部乐器参数**（都可选，未写的用预设值或默认值）：
- \`wave\` 主波形
- \`envelope\` 振幅包络，见下方"包络"一节
- \`filter\` 滤波器，见下方"滤波器"一节
- \`filter_envelope\` + \`filter_env_amount\` 滤波包络与其调制深度(Hz)
- \`lfo\` 低频调制，见下方"LFO"一节
- \`gain\` 0~1　\`pan\` -1~1（-1 全左，1 全右）
- \`fm_wave\` / \`fm_ratio\` / \`fm_index\`　FM 合成。fm_wave 只能是 sine/square/sawtooth/triangle；
  fm_ratio 是倍频比（0.5 得低八度调制、3.5 得金属钟声）；fm_index 是调制深度(Hz)，越大越亮越噪
- \`detune\` 失谐(音分)。**单个乐器内的整体失谐**
- \`voices\` 1~7　每音符叠加几个失谐振荡器（SuperSaw 音墙）；\`unison_spread\` 声部间失谐音分
- \`spread\` 0~1　声部的立体声展开宽度，弦乐群/合唱靠它变宽
- \`glide\` 起音滑音时长(秒) + \`glide_from\` 起始偏移(半音，默认 -12)
  　→ 弦乐换把、808 滑音贝斯、人声滑音
- \`pitch_env_amount\` 音高包络深度(半音) + \`pitch_decay\` 衰减时长(秒)
  　→ 底鼓/定音鼓的"鼓皮张力下坠"，正值先高后低
- \`attack_noise\` 0~1　起音处的极短噪声爆发 → 弓弦摩擦、气息、拨片触弦
- \`harmonics\` 谐波振幅数组，如 \`harmonics: [1, 0.5, 0.33, 0.25]\`
  　→ 用真实谐波叠加自定义音色（管风琴音栓、玻璃、人声共振峰），设置后 wave 被忽略
- \`velocity_sensitivity\` 0~1　力度对音量的影响程度
- \`velocity_to_filter\` 力度对滤波截止的影响(Hz) → **强奏更亮**，管弦乐的关键
- \`effect_chain\` **乐器级效果链**，只作用于该乐器（写法同全局 effect_chain）
- \`loop_point\` 循环起音点(秒)

#### 3. sequence（音序 / 声部）
\`\`\`
sequence(name="melody", instrument="lead", gain=1.0, transpose=0, humanize=0) {
  note("C5", "4n")
  chord(["C4","E4","G4"], "2n")
  arp(chord=["C4","E4","G4"], pattern="up", rate="16n", duration="1n")
  hit("kick", "4n")
  rest("8n")
}
\`\`\`
sequence 级参数：\`gain\` 整轨音量、\`transpose\` 整轨移调(半音)、\`humanize\` 整轨人性化 0~1。

**五条指令**：
1. \`note(音名, 时值)\` —— 单音。例：\`note("A4", "8n")\`
2. \`chord([音名...], 时值, strum=0)\` —— 和弦。\`strum\` 0~1 让各声部依次进入（竖琴/吉他滚奏）
3. \`arp(chord=[...], pattern=..., rate=..., duration=..., octaves=1, gate=0.9)\` —— 琶音
   - pattern: \`up\` | \`down\` | \`upDown\` | \`downUp\` | \`asPlayed\` | \`random\`
   - rate 是每个音的间隔，duration 是琶音总时长，octaves 1~4 跨八度扩展
4. \`hit(鼓组名, 时值)\` —— 打击乐，**不需要定义乐器**。可用：${drumList()}
5. \`rest(时值)\` —— 休止

**逐音符表现力**（note/chord/arp/hit 都支持，作为命名参数写在括号里）：
- \`velocity=0.9\` 力度 0~1，同时影响音量与亮度
- \`pan=-0.4\` 覆盖乐器声像　\`gain=0.5\` 覆盖乐器音量
- \`gate=0.5\` 时值缩放，0.5 断奏、1.5 连奏
- \`transpose=12\` 临时移调(半音)
- \`glide=0.1\` 该音符的滑音时长(秒)
- \`detune=8\` 覆盖失谐
- \`humanize=0.4\` 0~1 人性化抖动（音高/力度/时值微扰），**消除机械感的关键**

例：\`note("C5", "8n", velocity=1.0, humanize=0.3)\`

#### 4. effect_chain（效果链）
可放在顶层（作用于全部声音），也可放进 define_instrument 里（只作用于该乐器）。
\`\`\`
effect_chain {
  eq(low=2, mid=-1, high=3)
  chorus(rate=1.2, depth=4, mix=0.4)
  delay(time=0.375, feedback=0.35, mix=0.25, damping=2000)
  reverb(decay=2.8, mix=0.35, pre_delay=0.02, damping=5000)
}
\`\`\`
可用效果器：
- \`delay(time, feedback, mix, damping, pingpong)\`　延迟；pingpong=true 得左右弹跳
- \`pingpong(...)\`　同 delay 的乒乓写法
- \`reverb(decay, mix, pre_delay, damping)\`　混响；decay 是尾音长度(秒)
- \`distortion(amount, mix)\`　失真　\`overdrive(amount, mix)\`　轻度过载
- \`bitcrush(bits, mix)\`　位深压缩，bits 1~16，越低越脏
- \`chorus(rate, depth, mix)\`　合唱　\`flanger(rate, feedback, mix)\`　镶边
- \`phaser(rate, min, max, mix)\`　移相　\`tremolo(rate, depth)\`　颤音
- \`compressor(threshold, ratio, attack, release)\`　压缩
- \`filter(kind, from, to, Q, duration, at)\`　整体扫频，kind 见滤波器一节
- \`eq(low, mid, high)\`　三段均衡，单位 dB

**顺序很重要**：失真应放在延迟/混响之前，否则会把尾音一起弄脏。

#### 5. mix（混音编排，决定各声部何时进入）
\`\`\`
mix {
  track(source="drums",  time=0, loop=4)
  track(source="bass",   time=0, loop=4)
  track(source="melody", time=2, loop=1, gain=0.9, pan=0.2)
}
\`\`\`
- \`source\` 引用的音序名（必须存在）
- \`time\` 起始时刻，可用秒或音乐时值：\`time=0\`、\`time="2n"\`
- \`loop\` 重复次数　\`gain\` 轨道音量　\`pan\` 轨道声像
- \`stagger\` 每次循环的错位增量(秒)，可做卡农式叠加
**不写 mix 时，所有音序会按定义顺序首尾相接播放。**

==================== 包络 ====================
- \`adsr(a, d, s, r)\` —— s 是电平比例 0~1，其余是秒
- \`ad(a, d)\` 打击乐式　\`ar(a, r)\` 持续音式　\`perc(a, d, r)\` 短促打击
- 附加命名参数：\`curve=exp|linear|hold\`（默认 exp，最自然）、\`delay=秒\`
例：\`envelope: "adsr(0.01, 0.3, 0.5, 0.4)"\`、\`envelope: "perc(0.001, 0.25, 0.1)"\`

**用包络塑造演奏法**：
- 断奏 staccato → \`perc(0.001, 0.15, 0.08)\`
- 连奏 legato → \`adsr(0.25, 0.3, 0.9, 0.5)\`
- 拨弦 pluck → \`adsr(0.004, 1.2, 0.0, 0.3)\`
- 持续 pad → \`adsr(1.5, 1.0, 0.8, 2.5, curve=linear)\`

==================== 滤波器 ====================
\`lowpass(freq, Q)\`、\`highpass(freq, Q)\`、\`bandpass(freq, Q)\`、\`notch\`、\`lowshelf\`、\`highshelf\`、\`peaking\`、\`allpass\`
- 附加参数：\`sweep_to=目标频率\` 在音符时值内自动扫频（riser 效果）
- Q 越大共振峰越尖锐（acid 贝斯用 Q=8~12）
例：\`filter: "lowpass(800, 2)"\`、\`filter: "bandpass(1200, 1.5, sweep_to=6000)"\`

==================== LFO ====================
\`波形(freq=速率Hz, amount=深度, target=目标, ramp=淡入秒, swell=true)\`
- 波形：sine | square | sawtooth | triangle
- target 及其量纲：
  - \`frequency\` 颤音，amount 单位是**音分**（5~15 是自然颤音，50+ 是夸张效果）
  - \`filter\` 自动哇音，amount 单位是 **Hz**（200~2000）
  - \`gain\` 震音，amount 是 **0~1 的深度比例**（0.2~0.5）
  - \`pan\` 自动摇摆，amount 是 0~1
- \`ramp\` 让调制慢慢进入（弦乐/长笛必用，否则起音会抖）
- \`swell=true\` 让调制随时间增强（riser）
例：\`lfo: "sine(freq=5.5, amount=10, target=frequency, ramp=0.6)"\`

==================== 时值写法 ====================
\`1n\` 全音符　\`2n\` 二分　\`4n\` 四分　\`8n\` 八分　\`16n\` 十六分　\`32n\`　\`64n\`
- 附点加 \`.\`：\`4n.\` = 1.5 倍
- 三连音加 \`t\`：\`4nt\` = 2/3
- 小节：\`1m\`（4/4 拍的 4 拍）
- 绝对时间：\`250ms\`、\`1.5s\`；纯数字按秒算

==================== 音名写法 ====================
\`C4\` \`F#5\` \`Bb3\` \`Eb2\`（**必须带八度数字，且必须加引号**）。
中央 C 是 \`C4\`，A4 = 440Hz。也可直接写频率：\`"440hz"\`。
音名写错（如 \`H9\`、漏掉八度）会导致编译失败。

==================== 作曲质量准则 ====================
**编曲分层**：一个完整的作品应包含多个声部同时进行：
旋律 + 和声/铺底 + 低音 + 节奏。不要只写一条旋律线。

**声像布局**（模仿真实乐队/管弦乐座位，让混音有宽度）：
低音与底鼓 pan=0；弦乐群 pan=-0.5~-0.3；铜管 pan=0.2；键盘/吉他 pan=±0.3；
打击乐点缀 pan=±0.4。避免所有声部都堆在中间。

**动态与层次**：主旋律 gain 0.6~0.8，伴奏 0.35~0.5，低音 0.6~0.75。
用 velocity 做出强弱起伏，而不是让每个音都一样响。

**消除机械感**（程序化作曲最容易失败的地方）：
- 给旋律和伴奏加 \`humanize=0.15~0.35\`
- 用 \`velocity\` 让乐句有起伏，长音渐强、句尾渐弱
- 同一声部不要连续几十个完全相同的音；用 rest、gate、transpose 制造变化
- 用 \`arp\` 或 \`gate=0.5\` 增加节奏的呼吸

**风格配方**：
- **史诗管弦乐**：strings_section 铺底 + brass_ensemble 主题 + timpani/低音鼓重拍 + harp 点缀。
  弦乐用长 attack 的 pad 包络，铜管用 filter_envelope 做 swell，务必加 reverb(decay=4, mix=0.5)。
- **电子舞曲**：hit("kick") 四拍落地 + hit("hat") 八分/十六分 + sub_bass 根音 + supersaw 和弦。
  tempo 124~128，用 sidechain 感（贝斯避开底鼓落点）。
- **Lo-fi / Chill**：electric_piano 或 nylon_guitar + warm_pad + 轻鼓。
  tempo 70~85，humanize 0.3，加 chorus 与 bitcrush(bits=10, mix=0.3)，swing 感靠附点时值。
- **氛围 / 环境**：warm_pad 长音 + wind/rain 噪声层 + bell 点缀，大量 reverb，tempo 60~75。
- **Chiptune**：chiptune 预设 + square 琶音 + 快速 16n 音型，tempo 140~160。
- **爵士**：electric_piano + 走 walking bass（4n 级进）+ ride 镲，和弦用七和弦九和弦。

**结构建议**：用 mix 的 time/loop 让音乐有段落感 ——
例如鼓与贝斯 loop=4 打底，旋律在第 2 拍进入，副歌段落用 transpose 升调或加新声部。

==================== 完整示例（可直接作为质量基准） ====================
config {
  tempo: 96
  master_gain: 0.7
}

define_instrument(name="pad") {
  preset: "strings_section"
  gain: 0.42
  pan: -0.35
  effect_chain { reverb(decay=3.5, mix=0.45, damping=4200) }
}

define_instrument(name="lead") {
  preset: "flute"
  gain: 0.62
  pan: 0.2
  effect_chain {
    delay(time="8n.", feedback=0.3, mix=0.22, damping=2400)
    reverb(decay=2.4, mix=0.3)
  }
}

define_instrument(name="low") {
  preset: "cello"
  gain: 0.68
  pan: 0.1
}

sequence(name="harmony", instrument="pad") {
  chord(["A3","C4","E4"], "1n")
  chord(["F3","A3","C4"], "1n")
  chord(["C4","E4","G4"], "1n")
  chord(["G3","B3","D4"], "1n")
}

sequence(name="melody", instrument="lead", humanize=0.25) {
  note("E5", "4n", velocity=0.85)
  note("A5", "8n.", velocity=1.0)
  note("G5", "8n", velocity=0.7)
  rest("8n")
  note("E5", "2n", velocity=0.9, gate=1.2)
}

sequence(name="bass", instrument="low") {
  note("A2", "2n")
  note("F2", "2n")
  note("C3", "2n")
  note("G2", "2n")
}

sequence(name="drums") {
  hit("kick", "2n")
  hit("hat", "4n", velocity=0.5)
  hit("snare", "2n", velocity=0.7)
  hit("hat", "4n", velocity=0.4)
}

effect_chain {
  eq(low=1.5, mid=0, high=1)
  compressor(threshold=-16, ratio=3, attack=0.02, release=0.3)
}

mix {
  track(source="drums",   time=0, loop=2)
  track(source="bass",    time=0, loop=2)
  track(source="harmony", time=0, loop=2)
  track(source="melody",  time=2, loop=1)
}

==================== 输出约束 ====================
1. **只输出代码**，无 Markdown 围栏、无解释文字。
2. 用户要求"交响乐/史诗"时，**必须**有 3 个以上不同乐器同时进行，并包含打击乐与低音声部。
3. 用户要求"电子舞曲/EDM"时，**必须**有底鼓节奏声部与低音声部。
4. 每条旋律都要有力度与人性化处理，不要输出每个音都一模一样的机械音序。
`;

const SPG_FIX_PROMPT = `
你是一个 SPG 代码修复专家。下面的代码在编译时失败了，请修复它。

修复原则：
1. **只改语法，不改音乐创意**。保持原有的音符、乐器、结构不变，除非它们本身就是错误来源。
2. 优先检查这些高频错误：
   - 音名不合法：必须是"字母A-G + 可选#/b + 八度数字"，且**必须加引号**（\`note("C4","4n")\` 而不是 \`note(C4,"4n")\`）
   - 时值不合法：只能用 4n / 8n. / 16nt / 1m / 250ms / 1.5s 这类写法
   - 引用了未定义的乐器或音序名（拼写不一致）
   - 括号或引号没有配对
   - 使用了不存在的参数名或指令名（只能用小写文档里的那些）
   - 未知预设名或未知鼓组名
3. 若报错指向"未定义的乐器"，要么把乐器补上，要么把 sequence 的 instrument 改成已存在的名字。
4. 若某个音序没有被 mix 引用，它不会发声 —— 需要补上 track。

必须输出**修复后的完整代码**，不要输出 diff、不要解释、不要 Markdown 围栏。

以下是 SPG 语言的完整语法参考，修复时必须严格遵循：
`;

/**
 * 修复提示词 = 修复指令 + 完整语法文档。
 * 只给"修复指令"而不给语法，模型只能凭印象猜合法写法，
 * 这正是此前自动修复反复失败的原因。
 */
const buildFixPrompt = (): string => `${SPG_FIX_PROMPT}${SPG_SYSTEM_PROMPT}`;

/**
 * 根据自然语言描述生成 SPG 音频合成代码。
 * 编曲类任务吃推理，这里用 high 档换质量。
 */
export const generateSyntax = async (userDescription: string): Promise<string> => {
    const text = await chat({
        system: SPG_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userDescription }],
        temperature: 0.7,
        reasoningEffort: 'high',
    });
    return cleanCodeBlock(text);
};

/**
 * 修复编译失败的 SPG 代码。
 * 输入是确定性的报错信息，低温度 + max 档更容易一次改对。
 */
export const fixSyntax = async (brokenCode: string, errorMessage: string): Promise<string> => {
    const text = await chat({
        system: buildFixPrompt(),
        messages: [{ role: 'user', content: `Code:\n${brokenCode}\n\nError:\n${errorMessage}` }],
        temperature: 0.2,
        reasoningEffort: 'max',
    });
    return cleanCodeBlock(text);
};

/* -------------------------------------------------------------------------- */
/*                              页面资源提取                                   */
/* -------------------------------------------------------------------------- */

const EXTRACT_PROMPT = `Extract direct media URLs from the text below.
Target: Stream (m3u8, mpd), Video (mp4, mkv, etc), Audio (mp3, etc), Images (high res).
Return strictly JSON array: [{"url": "...", "title": "...", "type": "video"}]
Do not wrap in markdown code blocks. Just the raw JSON.
Text: `;

/** 嗅探结果里认可的媒体类型；其余（含 other）一律丢弃 */
const KNOWN_TYPES: MediaType[] = ['stream', 'video', 'audio', 'image', 'document'];

/**
 * 用 AI 从页面源码里提取直链资源。
 *
 * 输出不可信：只收录 http(s) 直链、已知媒体类型，ext 去掉 query/hash，上限 50 条。
 * 返回的字段与 FoundLink 对齐，由调用方补齐 pageUrl/referer 等上下文。
 */
export const extractMediaLinks = async (
    pageContent: string,
    fallbackTitle: string
): Promise<Array<Pick<FoundLink, 'url' | 'title' | 'type' | 'ext'>>> => {
    const preview = pageContent.length > 80000 ? pageContent.slice(0, 80000) : pageContent;

    const text = await chat({
        messages: [{ role: 'user', content: `${EXTRACT_PROMPT}${preview}` }],
        reasoningEffort: 'low',
    });

    const parsed = extractJsonArray(text);
    if (!parsed) return [];

    return parsed
        .filter((item): item is { url: string; title?: string; type?: string } => {
            const url = (item as { url?: unknown })?.url;
            return typeof url === 'string' && /^(https?:\/\/|blob:)/i.test(url.trim());
        })
        .slice(0, 50)
        .map((item) => {
            const cleanUrl = item.url.trim();
            const pathPart = cleanUrl.split('?')[0].split('#')[0];
            const extGuess = pathPart.split('.').pop()?.toLowerCase();
            const ext = extGuess && /^[a-z0-9]{2,5}$/.test(extGuess) ? extGuess : 'unknown';
            const type: MediaType = KNOWN_TYPES.includes(item.type as MediaType)
                ? (item.type as MediaType)
                : 'other';
            return { url: cleanUrl, title: item.title || fallbackTitle || 'AI 识别资源', type, ext };
        })
        // 'other' 非媒体候选项直接丢弃，避免污染嗅探列表
        .filter((item) => item.type !== 'other');
};

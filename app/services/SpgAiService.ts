/**
 * SPG 音频生成的 AI 部分：语法文档提示词、生成、修复。
 *
 * ## 为什么从 AiService 里切出来
 *
 * 这段代码需要三个名字表（`PRESET_NAMES` / `DRUM_NAMES` / `CHORD_QUALITY_NAMES`），
 * 而它们**派生自 AudioService 的实现数据**（`PRESETS` / `DRUM_SPECS` / `CHORD_INTERVALS`），
 * 不是可以另抄一份的常量 —— 抄一份就会漂移，漂移的后果是提示词教了引擎不认的写法、
 * 模型据此生成的代码必然编译失败（此前真实发生过，见 engine.test.js 的同源断言）。
 *
 * 于是形成依赖链：SPG 生成 → AudioService（5383 行 Web Audio 引擎）。
 *
 * 而 `AiService` 本身要被插件侧的 Agent 使用（它只要 `chat()`）。
 * 两者放在一个文件里，插件 bundle 就会把整个音频引擎拖进去 ——
 * 更关键的是 `SPG_SYSTEM_PROMPT` 是**模块级模板字符串**，它在 import 时
 * 就求值 `presetList()` / `drumList()` / `chordList()`，
 * 所以连 tree-shaking 都救不了：只要 import 了 AiService，AudioService 必然被求值。
 *
 * 所以按**功能归属**切，而不是按"看起来像 AI 就都放 AiService"切：
 * SPG 是音频功能的一部分，它属于应用侧；AiService 只留通用的补全与解析。
 *
 * ## 搬运说明
 *
 * 本文件内容**逐字来自** `shared/ai/AiService.ts`：
 *   · `cleanCodeBlock`（原 L707-714）—— 只被本文件的 generate/fix 使用，一并带走
 *   · SPG 段（原 L769-1101）
 * 逻辑一行未动，只补了 import。
 */
import { PRESET_NAMES, DRUM_NAMES, CHORD_QUALITY_NAMES } from './AudioService';
import { chat } from '../../shared/ai/AiService';
/** 去除 Markdown 代码块围栏与首尾空白 */
export const cleanCodeBlock = (text: string): string => {
    if (!text) return '';
    const codeBlockRegex = /```(?:spg|[\w]*)?\n([\s\S]*?)```/;
    const match = text.match(codeBlockRegex);
    if (match && match[1]) return match[1].trim();
    return text.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
};

/**
 * 作品名注释：生成提示词要求写在第 1 行的那一行。
 *
 * 标记词只有这一个来源 —— 提示词里给模型看的示例行与下面的解析正则都由它拼出。
 * 两处各写一份字面量的话，改了提示词而没改正则（或反过来）不会报错：
 * 模型照新格式写，解析器认不出来，作品名通道就此静默失效。
 *
 * 注释符认 `#` 与 `//` 两种 —— 提示词只教 `#`，但注释符是模型的自由，
 * 认两种能让"作品名没被认出来"少一半机会。`作品名` 之后必须是冒号，
 * 所以 `# 作品名字：…` 这类写法不会被误认。
 */
const TITLE_MARKER = '作品名';
const TITLE_LINE = new RegExp(
    `^[ \\t]*(?:#|//)[ \\t]*${TITLE_MARKER}[ \\t]*[:：][ \\t]*([^\\r\\n]+)$`,
    'm'
);
/** 提示词里给模型的规范示例行。由 `TITLE_MARKER` 拼出，与 `TITLE_LINE` 同源。 */
export const TITLE_LINE_EXAMPLE = `# ${TITLE_MARKER}：三圈半`;

/**
 * 把作品名注释从代码里摘出来。
 *
 * **摘掉，而不是留在代码里**：工程标题的唯一权威是 `Project.name`。
 * 注释留在代码里就是同一件事的第二个副本 —— 用户在标题栏改个名字，
 * 两者立刻不一致，而没有任何东西会去读那行注释。作品名走的是传输通道，
 * 不是存储位置。
 *
 * 认不出作品名时返回 `title: null` 且代码原样返回：那一行是注释，
 * 摘不掉也不影响 SPG 编译，所以作品名通道永远不能反过来弄坏代码通道。
 */
export const splitTitle = (text: string): { code: string; title: string | null } => {
    const matched = text.match(TITLE_LINE);
    if (!matched) return { code: text, title: null };
    return { code: text.replace(TITLE_LINE, '').trim(), title: matched[1].trim() };
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
/** 和弦性质清单同样从实现处取，避免提示词教了引擎不认的写法 */
const chordList = (): string => CHORD_QUALITY_NAMES.filter((q) => q.length > 0).join(' ');

/** 系统提示词：告诉 AI 如何生成 .spg 语法 */
const SPG_SYSTEM_PROMPT = `
你是一位世界级的作曲家和音频工程师，精通 "Sound Particle Generator" (SPG) 语言。
你的任务是把自然语言描述转写成**可编译、且音乐性优秀**的 SPG 代码。

==================== 输出纪律（最重要） ====================
1. 第 1 行**必须**是作品名注释，格式固定：\`${TITLE_LINE_EXAMPLE}\`
   - 这一行会被程序摘走，**直接替换掉工程的标题**，所以它只能出现在第 1 行、只能出现一次。
   - 命名规则：2~8 个字；从**这首曲子的结构里**找一个具体事实来命名
     （某个声部始终不动、某次终止没有解决、某个数字反复出现）。
   - **禁止情绪标签**（"忧伤""恐怖""激烈""史诗"）—— 那等于替听众下结论，任何同类作品都能套用。
   - 不要用"未命名""音乐""作品"这类占位词，不要加书名号或引号，不要写副标题。
2. 第 2 行起是 SPG 代码，不要 Markdown 围栏、不要解释、不要寒暄。
3. 只能使用下面文档里出现过的语法。**不要发明语法**：解析器对未知指令、未知参数会直接报错。
4. 缩进用 2 空格。可写 \`#\` 或 \`//\` 注释。
5. 写完在心里过一遍：括号配对、引号配对、每个 sequence 都被 mix 引用、每个音名都是合法音名。

==================== 文件结构 ====================
SPG 由五部分组成，顺序任意，但通常写成：config → define_instrument → sequence → effect_chain → mix。

#### 1. config（全局配置，最多一个）
\`\`\`
config {
  tempo: 120          # BPM，必须 > 0（写 bpm: 也可以）
  master_gain: 0.7    # 总音量，0~2
  key: "Am"           # 可选，调性；写出来能提醒你自己保持调内
  scale: "minor"      # 可选：major minor dorian lydian mixolydian ...
  swing: 0            # 可选，0~1 摇摆量；爵士/Lo-fi 用 0.3~0.6
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
（另有 \`custom\`：必须同时给 \`harmonics\`，否则编译失败）

**全部乐器参数**（都可选，未写的用预设值或默认值）：
- \`wave\` 主波形
- \`envelope\`（别名 \`env\`）振幅包络，见下方"包络"一节
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
  　→ 用真实谐波叠加自定义音色（管风琴音栓、玻璃、人声共振峰），设置后 wave 被忽略。
  　**不能与噪声波形（white_noise 等）同用** —— 噪声没有振荡器可挂谐波，会编译失败
- \`velocity_sensitivity\` 0~1　力度对音量的影响程度
- \`velocity_to_filter\` 力度对滤波截止的影响(Hz) → **强奏更亮**，管弦乐的关键
- \`effect_chain\` **乐器级效果链**，只作用于该乐器（写法同全局 effect_chain）
- \`loop_point\` 循环起音点(秒)

#### 3. sequence（音序 / 声部）
\`\`\`
sequence(name="melody", instrument="lead", gain=1.0, transpose=0, humanize=0) {
  note("C5", "4n")
  chord("Am7", "2n")                                    # 和弦符号直接写
  chord(["C4","E4","G4"], "2n", voicing="drop2")        # 或音高数组 + 声位
  progression(["Am7","Dm7","G7","Cmaj7"], "1n")         # 一整段和声进行
  arp("Am7", pattern="up", rate="16n", duration="1n")   # 琶音
  run(["C4","D4","E4","G4"], "16n")                     # 音型跑动
  hit("kick", "4n")
  rest("8n")
}
\`\`\`
sequence 级参数：\`gain\` 整轨音量、\`transpose\` 整轨移调(半音)、\`humanize\` 整轨人性化 0~1。

**七条指令**：
1. \`note(音名, 时值)\` —— 单音。例：\`note("A4", "8n")\`
2. \`chord(和弦, 时值, strum=0, voicing="close", octave=4)\` —— 和弦
   - **第一个参数可以是和弦符号**（推荐）或音高数组
   - \`voicing\` 声位：\`close\` 密集（默认）| \`open\` 开放 | \`drop2\` 爵士左手 | \`spread\` 宽铺底
   - \`octave\` 和弦发在第几八度（默认 4，中央 C 所在八度）
   - \`strum\` 0~1 让各声部依次进入（竖琴/吉他滚奏）
3. \`progression(和弦数组, 时值, voicing=..., pattern="asPlayed")\` —— **和弦进行，一次写完整段和声**
   - 时值可以是单个记号（每个和弦等长），也可以是与和弦数等长的数组
   - \`pattern\` 默认 \`asPlayed\` 齐奏；改成 \`up\`/\`down\` 就得到分解和弦伴奏
   - 例：\`progression(["Am7","Dm7","G7","Cmaj7"], ["1n","1n","1n","2n"], voicing="drop2")\`
4. \`arp(和弦, pattern=..., rate=..., duration=..., octaves=1, gate=0.9)\` —— 琶音
   - 第一个参数同样可以是和弦符号
   - pattern: \`up\` | \`down\` | \`upDown\` | \`downUp\` | \`asPlayed\` | \`random\`
   - rate 是每个音的间隔，duration 是琶音总时长，octaves 1~4 跨八度扩展
5. \`run(音高数组, 速率, direction="up", repeat=1, gate=1)\` —— 快速音型跑动
   - direction: \`up\` 原序 | \`down\` 逆序 | \`updown\` 往返
   - 用来填满乐句空隙、制造推进感，比手写一长串 note 省得多
6. \`hit(鼓组名, 时值, tune=0, decay=1, tone=0, snap=0)\` —— 打击乐，**不需要定义乐器**
   - 可用：${drumList()}
   - \`tune\` 半音微调（-12 低八度）　\`decay\` 衰减倍数（0.5 更短促）　
     \`tone\` 明暗偏移(Hz)　\`snap\` 0~1 起音冲击感
   - 用这些参数把同一套鼓拆成"主歌的闷底鼓 / 副歌的亮底鼓"，避免全曲一模一样
7. \`rest(时值)\` —— 休止

**逐音符表现力**（所有指令都支持，作为命名参数写在括号里）：
- \`velocity=0.9\` 力度 0~1，同时影响音量与亮度　\`accent=true\` 顶到最强力度
- \`pan=-0.4\` 覆盖乐器声像　\`gain=0.5\` 覆盖乐器音量
- \`gate=0.5\` 时值缩放，0.5 断奏、1.5 连奏
- \`transpose=12\` 临时移调(半音)　\`octave=1\` 临时移调(八度)
- \`glide=0.1\` 该音符的滑音时长(秒)
- \`detune=8\` 覆盖失谐
- \`humanize=0.4\` 0~1 人性化抖动（音高/力度/时值微扰），**消除机械感的关键**

例：\`note("C5", "8n", velocity=1.0, humanize=0.3)\`

#### 和弦符号（强烈建议使用）
写法：\`根音 + 性质 [+ /低音]\`，例如 \`C\` \`Am\` \`Fmaj7\` \`G7\` \`Dm7b5\` \`Bbmaj9\` \`C/E\` \`Am7/G\`。
支持的性质：${chordList()}
- 用和弦符号而不是自己展开音高数组：引擎的声位规则比你手算更可靠，
  而且 \`voicing\` 能自动做出转位/开放排列，音乐性明显更好。
- 低音斜杠写法 \`C/E\` 会自动把 E 放到最低声部，**不要**再手写一个低八度的 E。

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
- \`filter(kind, from, to, Q, duration, start)\`　整体扫频，kind 见滤波器一节
- \`eq(low, mid, high)\`　三段均衡，单位 dB
参数名必须用上面列出的那些规范名；写错参数名会直接编译失败。
以下同义写法也能编译，但会给出"已按某某处理"的提示，正式写法请直接用规范名：
delay→time、fb→feedback、size→decay、drive→amount（失真里）、depth→bits（位深里）、
speed→rate、tone→damping、bass→low、treble→high、ping_pong→pingpong、
end→to（扫频里）、from→min、to→max（移相里）、dur→duration、at→start。
注意 \`filter\` 里 \`start\` 是**扫频起始时刻(秒)**，起始频率请写 \`from\`。

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
**写了 mix 就必须把每个想发声的 sequence 都列进去**，漏掉的音序不会发声。

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
  - \`detune\` 与 frequency 同量纲（音分），直接调制失谐
  - \`filter\` 自动哇音，amount 单位是 **Hz**（200~2000）
  - \`gain\` 震音，amount 是 **0~1 的深度比例**（0.2~0.5）
  - \`pan\` 自动摇摆，amount 是 0~1
- \`ramp\` 让调制慢慢进入（弦乐/长笛必用，否则起音会抖）
- \`swell=true\` 让调制随时间增强（riser）
例：\`lfo: "sine(freq=5.5, amount=10, target=frequency, ramp=0.6)"\`

==================== 时值写法 ====================
\`1n\` 全音符　\`2n\` 二分　\`4n\` 四分　\`8n\` 八分　\`16n\` 十六分　\`32n\`　\`64n\`　\`128n\`
- 附点加 \`.\`：\`4n.\` = 1.5 倍，\`4n..\` = 1.75 倍
- 三连音加 \`t\`：\`4nt\` = 2/3
- 小节：\`1m\`（4/4 拍的 4 拍）
- 绝对时间：\`250ms\`、\`1.5s\`；纯数字按秒算

==================== 音名写法 ====================
\`C4\` \`F#5\` \`Bb3\` \`Eb2\`（**必须带八度数字，且必须加引号**）。
中央 C 是 \`C4\`，A4 = 440Hz。也可直接写频率：\`"440hz"\`。
音名写错（如 \`H9\`、漏掉八度）会导致编译失败。
**单音只能用 note()，不能把和弦符号写进 note()** —— 和弦请用 chord()/progression()/arp()。

==================== 作曲质量准则 ====================
**编曲分层**：一个完整的作品应包含多个声部同时进行：
旋律 + 和声/铺底 + 低音 + 节奏。不要只写一条旋律线。

**用和弦思维而不是逐音思维**：
优先用 \`progression\` 铺和声、\`chord\` 写和弦、\`arp\` 写分解和弦，
只在写旋律线时才逐个 \`note\`。这样和声不会跑调，声位也更专业。

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
- 鼓组用 \`tune\`/\`decay\`/\`snap\` 让重复的鼓点有变化，不要全曲同一个音色

**风格配方**：
- **史诗管弦乐**：strings_section 铺底 + brass_ensemble 主题 + timpani/低音鼓重拍 + harp 点缀。
  弦乐用长 attack 的 pad 包络，铜管用 filter_envelope 做 swell，务必加 reverb(decay=4, mix=0.5)。
- **电子舞曲**：hit("kick") 四拍落地 + hit("hat") 八分/十六分 + sub_bass 根音 + supersaw 和弦。
  tempo 124~128，用 sidechain 感（贝斯避开底鼓落点）。
- **Lo-fi / Chill**：electric_piano 或 nylon_guitar + warm_pad + 轻鼓。
  tempo 70~85，humanize 0.3，config 里写 swing: 0.4，
  和弦用 \`progression([...], voicing="drop2")\`，加 chorus 与 bitcrush(bits=10, mix=0.3)。
- **爵士**：electric_piano + 走 walking bass（4n 级进）+ ride 镲，
  和声用 \`progression(["Dm7","G7","Cmaj7"], "1n", voicing="drop2")\`，swing 0.5~0.7。
- **氛围 / 环境**：warm_pad 长音 + wind/rain 噪声层 + bell 点缀，大量 reverb，tempo 60~75。
- **Chiptune**：chiptune 预设 + square 琶音 + \`run([...], "16n")\` 快速音型，tempo 140~160。

**结构建议**：用 mix 的 time/loop 让音乐有段落感 ——
例如鼓与贝斯 loop=4 打底，旋律在第 2 拍进入，副歌段落用 transpose 升调或加新声部。

==================== 输出约束 ====================
1. **只输出那一行作品名注释 + 代码本身**，无 Markdown 围栏、无解释文字。
2. 用户要求"交响乐/史诗"时，**必须**有 3 个以上不同乐器同时进行，并包含打击乐与低音声部。
3. 用户要求"电子舞曲/EDM"时，**必须**有底鼓节奏声部与低音声部。
4. 每条旋律都要有力度与人性化处理，不要输出每个音都一模一样的机械音序。
5. 和声部分优先用 progression/chord/arp 的和弦符号写法，不要逐个音手写和弦。
`;

const SPG_FIX_PROMPT = `
你是一个 SPG 代码修复专家。下面的代码在编译时失败了，请修复它。

修复原则：
1. **只改语法，不改音乐创意**。保持原有的音符、乐器、结构不变，除非它们本身就是错误来源。
2. 优先检查这些高频错误：
   - 音名不合法：必须是"字母A-G + 可选#/b + 八度数字"，且**必须加引号**（\`note("C4","4n")\` 而不是 \`note(C4,"4n")\`）
   - 时值不合法：只能用 4n / 8n. / 16nt / 1m / 250ms / 1.5s 这类写法
    - **未知参数名**：报错信息里会列出该指令可用的参数，照着改。常见混淆是
      \`delay(delay=...)\` 应为 \`delay(time=...)\`、\`reverb(size=...)\` 应为 \`reverb(decay=...)\`
      （这两个同义写法其实能编译，但会告警，修复时顺手改成规范名）、
      \`velocity\` 拼成 \`velo\`/\`velosity\`
   - 引用了未定义的乐器或音序名（拼写不一致）——报错信息里会列出已定义的名字
   - 括号或引号没有配对
   - 使用了不存在的参数名或指令名（只能用文档里列出的那些）
   - 未知预设名或未知鼓组名——报错信息里会列出全部可用取值
   - 把和弦符号写进了 \`note()\`：\`note("Am7","2n")\` 必须改成 \`chord("Am7","2n")\`
   - \`progression\` 的时值数组长度必须与和弦数组长度一致
3. 若报错指向"未定义的乐器"，要么把乐器补上，要么把 sequence 的 instrument 改成已存在的名字。
4. 若某个音序没有被 mix 引用，它不会发声 —— 需要补上 track。
5. 若报错是"未知的和弦符号"，改用文档里列出的和弦性质，或直接写音高数组。
6. 下面语法文档里"输出纪律"的第 1 条（作品名注释）**对修复不适用**：
   待修代码里没有这一行，也不要添上。标题由用户自己管，修复不碰它。

必须输出**修复后的完整代码**，不要输出 diff、不要解释、不要 Markdown 围栏。

以下是 SPG 语言的完整语法参考，修复时必须严格遵循：
`;

/**
 * 迭代优化提示词：输入是一份**已经成型的作品**，而不是一句描述。
 *
 * 与 `SPG_FIX_PROMPT` 的根本区别在于目标：修复是"让它能跑"，
 * 迭代是"让它更好听，但还得是同一首曲子"。所以这份提示词的大半篇幅
 * 用在**划出不可动的边界**上 —— 模型对"优化"的默认理解是重写，
 * 而重写会连调性、曲式、旋律一起换掉，用户拿回的是一首陌生的曲子。
 */
const SPG_REFINE_PROMPT = `
你是一位世界级的作曲家和音频工程师，精通 "Sound Particle Generator" (SPG) 语言。
用户会给你一份**已经能编译、已经成型的 SPG 作品**。请把它优化一遍。

==================== 最高优先级：不许动的部分 ====================
"优化"不是"重写"。下面这些构成这首曲子的**身份**，一个都不许动：

1. \`tempo\`、\`key\`、\`scale\` —— 速度与调性是听感的第一身份。
2. **和声骨架** —— 哪个小节是什么和弦、和弦怎么走，保持原样。
3. **曲式与时间轴** —— 段落数量、每段长度、声部进出的时刻（\`mix\` 的 time/loop）不变。
4. **主旋律的音高与节奏** —— 不要"改进"旋律本身，那是作曲不是优化。
5. **乐器的音色身份** —— preset / wave / harmonics / 包络的基本形状保留。
   可以把参数往同一方向微调（混响更深、attack 稍长），
   但**不要换乐器**（钢琴换电钢、弦乐群换 pad 都属于换乐器）。
6. **作品名** —— 迭代不重命名工程，也不要往代码里加作品名注释。

自检标准：把优化前后的两份代码给同一个人听，他应当认出这是同一首曲子。

==================== 优化什么 ====================
在守住上面那些身份的前提下，从这些**混音与演奏层面**的维度去改：

1. **声部平衡** —— 主旋律 gain 0.6~0.8、伴奏 0.35~0.5、低音 0.6~0.75。
   原稿最常见的毛病是所有声部一样响：把层次拉开，让该突出的突出。
2. **频段冲突** —— 同频段只留一个声部。低音与底鼓挤在一起就错开八度或削减一方；
   两个声部音高只差几个半音又同时响，只会互相掩盖。
3. **力度起伏** —— 逐音符的 velocity 要有句子感：长音渐强、句尾渐弱，
   而不是每个音都同样响。原稿若通篇没有 velocity，这是收益最大的一处改动。
4. **人性化** —— 给旋律与伴奏加 \`humanize=0.15~0.35\`。
   机械感是程序化作曲最典型的失败。
5. **声像布局** —— 低音与底鼓 pan=0；弦乐群 -0.5~-0.3；键盘/吉他 ±0.3；
   打击乐点缀 ±0.4。避免所有声部堆在中间。
6. **空间与效果** —— 混响/延迟的用量与预延迟；失真必须排在延迟/混响**之前**，
   否则会把尾音一起弄脏。
7. **演奏法** —— 用包络与 gate 让同一段素材有断奏/连奏的区分；
   鼓组用 tune/decay/snap 让重复的鼓点有变化，而不是全曲同一个音色。
8. **结构收束** —— 末段是不是只是"又一次循环"？末段的处理（留白、只留一个声部、
   不解决、延长尾音）决定作品停在什么位置。必要时为末段单独写一份素材。
9. **修正真正的错误** —— 能编译但语义写错的构造（见下方陷阱）、
   每段时值求和不等于整小节的算术错误、写了 mix 却没被任何 track 引用的音序。

**克制**：不要为了显得改过而到处加东西。改动集中在最值得改的那几处，
每一处都要能说出理由。加一个声部或一层效果之前，先确认它没有把已有的东西盖住。

==================== 陷阱：这些地方最容易"改着改着改了音乐" ====================
1. 效果器 \`filter\` 的 \`start\` 是**扫频起始时刻(秒)**，起始频率写 \`from\`。
2. \`run\` 的 \`direction="down"\` 会**反转数组**，要让音高下行，数组必须按上行写。
3. \`arp\` 的 \`up\`/\`down\` 按**音高排序**，只有 \`asPlayed\` 保留书写顺序。
4. \`progression\` 没有 \`duration\`，时值参数叫 \`beats\`。
5. 包络的 A+D 超过音符时值会被**按比例压缩**：写 \`adsr(3.5, 2.0, …)\` 配 1 小节的音符，
   实际起音只有约 3.0 秒。
6. \`config\` 的 \`key\`/\`scale\` **不参与发声**，不会自动转调，也不会滤掉音阶外的音。
7. 一条音序里的指令**严格串行**，不存在同时发声；跨音序的同时发声靠 \`mix\` 的 time 对齐。
8. \`loop=N\` 是"从上一遍终点接续再演一遍"，不是每遍都从 time 重来。
9. 同一乐器、同时刻、同音高只是把振幅叠上去，听不出"更厚"；要加厚就换音高或音色。
10. 每段音序的时长应当是**整小节数**，否则 \`mix\` 的 time 会逐遍累积偏移。

==================== 注释纪律 ====================
原稿的注释是作品说明的一部分，要保留；但你改过参数之后，
**所有含具体数字、方向词、比较词的注释都必须重新核对** ——
写下的值不等于听到的值（见上面第 5 条），注释声称的行为必须与改动后的代码一致。
对不上的就改注释，不要留着。不要写"原稿这里是什么"这类话，只写当前实现的技术理由。

==================== 输出纪律 ====================
1. 只输出**完整的优化后代码**，不要 diff、不要解释、不要寒暄、不要 Markdown 围栏。
2. **不要**写作品名注释 —— 迭代不改工程名。
3. 保持原稿的块顺序、缩进风格与注释语言（中文注释就继续用中文）。
4. 只能使用下面文档里出现过的语法。**不要发明语法**：解析器对未知指令、未知参数直接报错。
5. 写完在心里过一遍：括号配对、引号配对、每个 sequence 都被 mix 引用、每个音名都合法。

以下是 SPG 语言的完整语法参考，优化时必须严格遵循：
`;

/**
 * 修复与迭代共用同一份语法文档。
 *
 * 只给指令而不给语法，模型只能凭印象猜合法写法 ——
 * 这正是此前自动修复反复失败的原因。凡是"让模型改一份 SPG 代码"的通道
 * 都必须经过这里，否则它会退化成一次凭记忆的重写。
 */
const withSyntaxDoc = (instructions: string): string => `${instructions}${SPG_SYSTEM_PROMPT}`;

/**
 * 生成结果：代码与作品名是两个独立的出参。
 *
 * 不把作品名塞进代码里（哪怕以注释形式）是因为工程标题的唯一权威是
 * `Project.name` —— 见 `splitTitle` 的说明。
 */
export interface GeneratedSpg {
    /** 已摘掉作品名注释的 SPG 源码，可直接进编辑器 */
    code: string;
    /** 模型给出的作品名；没写这一行时为 null（调用方应保持原标题不变） */
    title: string | null;
}

/**
 * 把一次模型回复拆成「作品名 + 干净代码」。
 *
 * 顺序是**先摘作品名、再清围栏**，不能反过来：模型有时把作品名写在代码围栏
 * 外面，而 `cleanCodeBlock` 只返回围栏**内部**的内容，先清围栏那一行就没了。
 * 这个顺序错了不会报错，只会表现为"AI 不给工程命名了"，所以导出它给测试直接调用。
 */
export const parseReply = (text: string): GeneratedSpg => {
    const { code, title } = splitTitle(text || '');
    return { code: cleanCodeBlock(code), title };
};

/**
 * 根据自然语言描述生成 SPG 音频合成代码。
 * 编曲类任务吃推理，这里用 high 档换质量。
 */
export const generateSyntax = async (userDescription: string): Promise<GeneratedSpg> => {
    const text = (await chat({
        system: SPG_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userDescription }],
        temperature: 0.7,
        reasoningEffort: 'high',
    })).content;
    return parseReply(text);
};

/**
 * 把一份已有的 SPG 作品交给模型迭代优化，返回优化后的完整代码。
 *
 * **不是"重新生成"**：用户给的是已成型的曲子，要的是同一首曲子在混音、
 * 演奏法与结构收束上更好，而不是另一首。所以这条通道与 `generateSyntax`
 * 分开 —— 两者虽然都返回一份可编译代码，但目标相反：一个从零创造，
 * 一个必须保住原曲的身份。合成一个函数就得在内部再按方向分一次叉。
 *
 * 作品名与 `fixSyntax` 同样**只摘不取**：迭代不改工程名，工程沿用原文件名。
 */
export const refineSyntax = async (code: string): Promise<string> => {
    const text = (await chat({
        system: withSyntaxDoc(SPG_REFINE_PROMPT),
        messages: [{ role: 'user', content: `待优化的作品：\n${code}` }],
        // 温度比生成低：这里要的是"同一个人的同一首曲子"，不是新灵感。
        // 生成用 0.7 是为了多样性，迭代用 0.7 只会让模型忍不住重写。
        temperature: 0.3,
        reasoningEffort: 'max',
    })).content;
    return parseReply(text).code;
};

/**
 * 修复编译失败的 SPG 代码。
 * 输入是确定性的报错信息，低温度 + max 档更容易一次改对。
 *
 * 作品名**只摘不取**：修复提示词与生成提示词共用同一份语法文档，
 * 模型会照规矩补一行作品名，但那行必须丢掉 —— 修复只改语法，
 * 重命名不属于它，何况用户很可能已经自己改过标题了。
 */
export const fixSyntax = async (brokenCode: string, errorMessage: string): Promise<string> => {
    const text = (await chat({
        system: withSyntaxDoc(SPG_FIX_PROMPT),
        messages: [{ role: 'user', content: `Code:\n${brokenCode}\n\nError:\n${errorMessage}` }],
        temperature: 0.2,
        reasoningEffort: 'max',
    })).content;
    return parseReply(text).code;
};

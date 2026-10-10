---
name: spg-coding
description: 仅适用于本项目（the-play）。写、改、审 `.spg/*.txt` 的 SPG 音频脚本时读：以 services/AudioService.ts 为唯一权威的核对方法、五种块与全部参数白名单、时值与音量算式、一组「写了不报错但结果不是你以为的」陷阱、时间艺术作品的结构纪律、注释纪律与命名法。
whenToUse: 生成、修改、审查 the-play 的 SPG 脚本（`.spg/` 下的 `.txt`）；判断某个 SPG 构造实际会发出什么声音；或为这类作品命名。
---

# SPG 编码

> **权威只有一份：`services/AudioService.ts`。**
> 解析器 `SPGParser`、调度器 `EventScheduler`、合成器 `AudioSynthesizer` 都在其中（约 5400 行）。
> `services/AiService.ts` 的系统提示词是同一套语言的说明文档，但**可能落后于实现** —— 冲突时以实现为准。
>
> 解析器的贯穿原则是「**宁可报错，不要静默忽略**」：未知参数、非法时值、非法枚举一律抛 `SPGError` 并带行号。
> 于是拼错参数名会立刻报错，而**语义写错不会** —— 第三节那张清单专治后者。

---

## 一、核对方法：怎么把实现当权威用

### 1.1 来源优先级

| 优先级 | 来源 | 用途 |
|---|---|---|
| 1 | `services/AudioService.ts` 的实现代码 | 参数白名单、取值范围、默认值、分支条件 |
| 2 | `services/AiService.ts` 的提示词 | 意图与推荐用法 |
| 3 | 你对通用 DSL / 合成器 / 音频格式的经验 | **只用来生成搜索关键词**，不能作为写下去的依据 |

第 3 项最危险：SPG 长得像通用格式，经验会给出一个「看起来对」的写法。
典型：效果器 `filter` 的 `start` 是「第几秒开始扫频」，起始频率叫 `from`。
凭直觉写 `start=<频率>` 不报错，只是数值被当成时间 —— 语义完全变了。

**规则：每一个写进文件的构造，都要在实现里找到消费它的那一行。** 找不到消费点，
就说明它是「解析了但没人读」的字段；要么不用，要么在注释里写明「只做格式校验，不参与发声」。

### 1.2 找白名单，不要从示例里归纳

实现里有若干张参数白名单表和 `rejectUnknownParams` 式的校验函数。
**读白名单表本身**比从示例归纳快且准 —— 示例可能用了别名，也可能本身就过时。

```
grep -n "PARAMS\s*[:=]|_NAMES\s*[:=]|rejectUnknownParams" services/AudioService.ts
```

### 1.3 别名表是坑的清单

实现里的 `*_ALIASES` 表记录的正是「最常写错、于是被容忍」的写法。读它一遍就知道哪些名字有歧义。
反过来：**别名存在不等于推荐使用** —— 写正式名，别名只当兼容。

---

## 二、语言参考

### 2.1 五种块

| 块 | 数量限制 | 说明 |
|---|---|---|
| `config { }` | 最多 1 个 | tempo / master_gain / key / scale / swing |
| `define_instrument(name="…") { }` | 可多个 | 音色定义 |
| `sequence(name="…", instrument="…") { }` | 可多个 | 音符序列 |
| `effect_chain { }` | 顶层可重复，乐器级最多 1 个 | 效果链，顺序 = 信号流经顺序 |
| `mix { track(...) }` | 最多 1 个 | 编排；写了之后未被引用的音序不发声 |

块的出现顺序任意。注释用 `#` 或 `//`，按行剥离（尊重引号）。

### 2.2 config

| 参数 | 约束 |
|---|---|
| `tempo` / `bpm` | > 0，≤ 1000 |
| `master_gain` / `gain` | ≥ 0，≤ 2 |
| `key` | 正则 `/^[A-Ga-g][#b♯♭]?m?$/`，如 `"Cm"`、`"F#"` |
| `scale` | 枚举：major / minor / harmonic_minor / melodic_minor / dorian / phrygian / lydian / mixolydian / locrian / major_pentatonic / minor_pentatonic / blues / chromatic / whole_tone |
| `swing` | 0~1 |

**`key` 与 `scale` 只做格式校验，调度与合成都不读取它们。** 写 `key: "Cm"` 不会自动转调，
也不会把音阶外的音滤掉。想让脚本听起来是某个调，必须自己写对音高。

`swing` 把落在十六分网格第 2 个的音推到 1/3 拍、第 4 个（即后半拍八分）推到 2/3 拍。
`8n` 写法落在偶数步上，所以**四分与八分音符的旋律基本不受影响**，主要作用于十六分与八分交替的琶音。

### 2.3 时值记号（`parseDuration`）

| 写法 | 含义 |
|---|---|
| `4n` / `8n` / `16n` / `32n` | 1/N 全音符；全音符 = 4 拍 |
| `4n.` | 附点，×1.5 |
| `4n..` | 双附点，×1.75（不是 1.5×1.5） |
| `4nt` | 三连音，×2/3 |
| `1m` | 1 小节 = 4 拍 |
| `250ms` / `1.5s` | 绝对时间 |
| `250`（裸数字） | **按秒**，不是按拍 |
| `4x` | **报错**。裸数字必须整串是数字 |

`1m` 恒等于 4 拍（按 4/4 记），与 tempo 无关。

### 2.4 音高与和弦

- 音名必须带八度：`"C4"`、`"F#5"`、`"Bb3"`；也接受频率写法 `"440hz"`。
- C4 = MIDI 60，A4 = 440Hz。
- `chord()` / `arp()` / `progression()` 的第一个位置参数既可以给音高数组，
  也可以给**和弦符号字符串**（`"Am7"`、`"Cmaj9"`、`"G7/B"`）。
- `note("Am7", "2n")` 会报错并提示改用 `chord()` —— 这是刻意的可操作报错。
- `chord` 的 `octave`（默认 4）是**声位寄存器**，与 `note` 的 `octave`
  （升高 N 个八度）语义不同；实现里把它标为 reserved，不会重复叠加。

### 2.5 乐器参数白名单

```
preset, wave, envelope, env, amp_envelope, filter, filter_envelope, filter_env_amount,
lfo, pan, gain, fm_wave, fm_index, fm_ratio, detune, glide, glide_from,
pitch_env_amount, pitch_decay, spread, velocity_sensitivity, velocity_to_filter,
voices, unison_spread, harmonics, attack_noise, loop_point, effect_chain
```

- `preset` 作为基线，其余字段逐项覆盖它。可用预设含 `piano`、`electric_piano`、
  `bell`、`marimba`、`music_box`、`glass`、`strings_section`、`cello`、`flute`、
  `supersaw`、`synth_pad`、`warm_pad`、`timpani` 等 55 个。
- `wave`：`sine | square | sawtooth | triangle | white_noise | pink_noise | brown_noise | custom`。
  `custom` **必须**配 `harmonics`；噪声波形**不能**配 `harmonics`（两者都报错）。
- `voices` 被钳制到 1~7；`attack_noise` 钳制到 0~1；`gain` 默认 0.8。
- `velocity_sensitivity` 默认 0.7；`velocity_to_filter` 默认 0。
- `fm_wave` 只能是 `sine | square | sawtooth | triangle`（噪声名会报错）。
- `fm_ratio` **必须 > 0**；`fm_index` 为 0 或缺失时 FM 静默关闭。
- `glide` / `pitch_decay` / `loop_point` 不接受负数。

### 2.6 包络

`adsr(a, d, s, r)` / `ad(a, d)` / `ar(a, r)` / `perc(a, d, r)`，
可加 `curve=linear|exp|hold`（默认 `exp`）与 `delay=秒`。
`adsr` 的 `s` 是 0~1 的**电平比例**，不是秒。参数可写引号也可裸写。
负数报错；`sustain > 1` 被钳制为 1。

**`applyAdsr` 会在 `a + d > 音符时值` 时把两者按 `noteDur / (a + d)` 等比压缩** ——
写下的秒数不等于听到的秒数，见 6.2。

### 2.7 滤波器

`lowpass | highpass | bandpass | notch | lowshelf | highshelf | peaking | allpass`，
位置参数 `(freq, Q)`，额外可写 `gain`（搁架/峰值用）、`sweep` / `sweep_to`。
`freq > 0`，`Q ≥ 0`（实现里再钳到 0~30）。

### 2.8 LFO

`波形(freq=, amount=, target=, ramp=, swell=true)`，波形取四种振荡器波形。
`target`：`frequency | filter | gain | pan | detune`。`freq > 0`。

**`amount` 的单位随 target 变**：

| target | 单位 | 钳制 |
|---|---|---|
| `frequency` / `detune` | **音分**（实际接在 detune 上，各音高听感一致） | ±1200 |
| `filter` | Hz | 0~12000 |
| `gain` | 0~1 的深度比 | 0~1 |
| `pan` | -1~1 | 0~1 |

`swell=true` 会把深度再线性升到 `peakAmount * 2.2`，终点取
`t + max(0.05, 音符时值, ramp)`（保证自动化时间单调）。

### 2.9 效果器（13 种）

```
delay, pingpong, reverb, distortion, bitcrush, overdrive, filter, eq, chorus,
flanger, phaser, tremolo, compressor
```

| 效果 | 参数 |
|---|---|
| `delay` / `pingpong` | time, feedback, mix, damping, pingpong |
| `reverb` | decay, mix, predelay, pre_delay, damping |
| `distortion` / `overdrive` | amount, mix |
| `bitcrush` | bits（1~16）, mix |
| `chorus` | rate, depth, mix |
| `flanger` | rate, feedback, mix |
| `phaser` | rate, min, max, mix |
| `tremolo` | rate, depth |
| `filter` | kind, from, to, q, duration, **start** |
| `eq` | low, mid, high |
| `compressor` | threshold, ratio, attack, release |

- `eq` 实现为 lowshelf 250Hz / peaking 1200Hz Q0.9 / highshelf 4000Hz，各钳 ±24dB。
- **效果器 `filter` 的 `start` 是「第几秒开始扫频」，起始频率必须写 `from`。**
  这是最容易写错的一处：直觉会把 `start` 当起始频率，写了不报错但语义完全不同。
- 同义参数别名（会编译但发警告）：`delay→time`、`fb→feedback`、`tone→damping`、
  `size→decay`、`drive`/`gain→amount`、`depth→bits`、`speed→rate`、
  `ping_pong→pingpong`、`end→to`、`dur→duration`、`at→start`、`bass→low`、`treble→high`。
  写正式名，别名只当兼容。

### 2.10 音序指令

块头参数：`name | seq | id`、`instrument | inst`、`gain`、`transpose`、`humanize`。

逐音符可用参数（`NOTE_EXPR_PARAMS`）：
`velocity, vel, pan, gain, gate, transpose, glide, detune, humanize, human, octave, accent`

- `accent=true` 就是 `velocity=1` 的简写，`hit()` 也认。
- `gate` 是时值倍率：`gate=1.06` 让音稍微拖过下一条指令的起点，用来暗示踏板交叠。
- **指令严格串行**：每条把时间轴往后推自己的时值。**不存在「同时发两个音」** ——
  要同时发声只能用 `chord()`。这一条决定了「钟声与刮擦」是先后而不是叠加。

| 指令 | 参数 |
|---|---|
| `note(音高, 时值)` | — |
| `chord(数组或符号, 时值, strum=, voicing=, octave=, duration=)` | `strum` 0~1，每个声部错开 `strum * 0.055` 秒；`voicing`: close/open/drop2/spread |
| `arp(数组或符号, pattern=, rate=, duration=, octaves=, gate=)` | `pattern`: up/down/upDown/downUp/asPlayed/random；`rate` 默认 `16n`；`octaves` 1~4；`gate` 默认 0.9 |
| `progression(chords=, beats=, …)` | `beats` 是时值参数。**没有 `duration`** —— 写了报错 |
| `run(数组, 速率, direction=, repeat=, gate=)` | `direction`: up/down/updown |
| `hit(鼓名, 时值, tune=, decay=, tone=, snap=, duration=)` | `decay` 必须 > 0；`snap` 0~1 |
| `rest(时值)` | 也接受 `dur` / `len` |

### 2.11 `arp` 与 `run` 的顺序陷阱

- `arp` 的 `up` / `down` 是**按音高排序**，不是书写顺序；只有 `asPlayed` 与 `random`
  保留书写顺序。直接按下标升序会让 `["C3","G3","Eb3"]` 的 up 出来不是上行琶音。
- `arp` 的步数 = `floor(duration / rate)`，索引对 `order.length` **取模回绕**。
  4 音池的 `upDown` 是 6 步（0-1-2-3-2-1），配 8 个八分音符会回绕到池首两个音。
- **`run` 的 `direction="down"` 会把数组反转。** 要让音高下行，数组必须按**上行**写。
  写下行数组再配 `down` 得到的是上行线 —— 与意图恰好相反，且不报错。
- `run` 的 `updown` 对长度 > 2 的数组是 `concat(slice(1,-1).reverse())`。

**这类「按语义重排输入」的参数一律读那几行代码，不要猜。** 注释在这里极易写反。

### 2.12 鼓组

可用名（`DRUM_NAMES`，从 `DRUM_SPECS` 派生）：
`kick, sub_kick, snare, rim, clap, hat, open_hat, pedal_hat, tom_low, tom_mid,
tom_high, crash, ride, cowbell, shaker, tambourine`

- `hit()` **不需要乐器**。块里只有 `hit` 时解析器不会要求乐器存在。
- 鼓组事件**不走乐器的滤波 / LFO / 增益 / 声像链路**，自带 `DRUM_SPECS` 标定
  （kick 增益 1.0、hat 0.45、shaker 0.4…），只认逐音符的 `velocity` / `pan`
  以及 mix 轨道的 `pan`。给纯鼓音序写 `instrument` 不会改变音色。
- 微调参数单位：`tune` 半音、`decay` 倍率（下限 0.05）、`tone` 噪声中心频率的 Hz 偏移、
  `snap` 0~1 瞬态。时值短于音色自然衰减时按门限截断（可用来掐断开镲）。
- 振幅算式：`clamp(spec.gain * (0.45 + velocity * 0.7), 0, 2, 0.8)`。

### 2.13 音量与力度：三级相乘

```
gain = clamp(baseGain * velScale * seqGain * trackGain * jitterGain, 0, 2, 0.8)
```

- `baseGain` = 逐音符 `gain`，否则乐器 `gain`（默认 0.8）。
- `velScale = clamp((1 - sens) + sens * (velocity / 0.8), 0, 1.6, 1)`，
  `sens` 是 `velocity_sensitivity`（默认 0.7）。
  **`velocity = 0.8` 恰好是 1.0 倍**；`sens=0.85` 时 `velocity=0.4` 只有 0.58 倍。
- 所以 `velocity` 写满 1.0 会顶到钳制上限，**留余量**（0.3~0.9 之间）比写满好。
- 三层增益（乐器 × 音序 × 轨道）相乘后再乘 `config.master_gain`。
- `humanize` 产生 ±12 音分、±12% 力度、±2% 时值的可复现抖动（种子含音序名、
  起始时刻与 loop 下标）。
- `velocity_to_filter` 让强奏更亮：`filter.frequency + (velocity - 0.8) * vtF`。

### 2.14 `mix` 与 loop 的真实语义

`track(source=, time=, loop=, gain=, pan=, stagger=)`，别名 `seq`/`track`、`at`、`repeat`/`times`。

**`loop` 是「再演一遍」：第 n 遍从上一遍的**终点**接续，不是每遍都从 `time` 重来。**

```
currentStart = time
for i in 0..loop-1:  duration = 播放(source, currentStart);  currentStart += duration + stagger
```

推论：

- 一条 4 小节的音序 `loop=3` 正好铺 12 小节，不会重叠也不会留缝。
- 想让某声部「每隔 8 小节回来一次」，**不能**靠 `loop`，要用多条 `track` 分别给 `time`。
- `stagger` 让每次循环错位叠加（可做卡农），但也会让该声部比别的声部长出 `stagger`。
- **写了 `mix` 之后，没被任何 `track` 引用的音序一律不发声**，解析器只给一句警告。
  改脚本时两侧要同步。
- **不写 `mix` 时，所有音序按定义顺序首尾相接**（游标累加），不是全部从 0 叠加。
  这常被误以为是「同时播放」。

### 2.15 导出长度

```
totalDuration + tailRoom
tailRoom = effects.length > 0 ? min(max(3.0, 最长混响 decay), 12) : 0.5
```

混响 `decay` 被钳到 0.05~12 秒。离线渲染总时长上限 900 秒。

---

## 三、「写了不报错但结果不符」清单

解析器只拦语法，不拦语义。写脚本前逐条确认：

1. **`fm_index` 不是教科书里的调制指数** —— 它是直接加到载波频率上的 Hz 频偏量
   （`fmGain.gain = fm_index`），且随时间衰减到 8%。预设 `bell` 用 420、`piano` 用 180。
2. **效果器 `filter` 的 `start` 是扫频起始时刻**，起始频率写 `from`。
3. **`progression` 没有 `duration`**，时值参数叫 `beats`。
4. **`run` 的 `direction="down"` 反转数组**，要下行就得按上行写。
5. **`arp` 的 up/down 按音高排序**，`asPlayed` 才保留书写顺序。
6. **`wave` 是噪声时不能配 `harmonics`**；`wave:"custom"` 必须配 `harmonics`。
7. **`fm_ratio` 必须为正**；为 0 或负数报错（不需要 FM 就删掉三个 fm 字段）。
8. **`config` 的 `key` / `scale` 不参与发声**，不会自动转调。
9. **包络的 A+D 超过音符时值会被按比例压缩**（`applyAdsr` 与滤波包络都如此）：
   写 `adsr(3.5, 2.0, …)` 配 1 小节的音符，实际起音只有约 3.0 秒。
   滤波包络同理：峰值是 `baseFreq + amount`，持续电平是 `baseFreq + amount * sustain`。
10. **同乐器、同时刻、同音高**只是把振幅叠上去（两个振荡器同相，多约 6dB），
    听不出「更厚」。要加厚就换音高或换音色。
11. **一条音序里的指令严格串行**，不存在同时发声；跨音序的同时发声由 `mix` 的 `time` 对齐。
12. **每段音序的时长应当是整小节数**，否则 `mix` 的 `time` 会逐遍累积偏移。
    改完记得把每段的时值求和验算一遍（见 4.3）。

---

## 四、结构纪律

> **同一个素材循环两遍，是「重复」；换一个素材，才是「发展」。**
> 参数化把「复制粘贴」变得极其便宜，于是它成了最容易被滥用的手段。

### 4.1 `loop=N` 不是发展

把一段 4 小节的素材 `loop=2` 铺满 8 小节，音高、时值、走向**完全相同**。
即使抖动种子含循环下标（每次的微随机不同），听感上仍然是「同一句话说了两遍」。

**要制造发展，就写第二份素材。** 复述与发展的区别是结构性的，
不能靠参数微调（力度、声像、滤波）弥补 —— 那些只改变「听起来一样的东西有多响」。

判断当前是不是在偷懒：**问「第二遍里有没有一个新音是新的」。** 没有，就是复述。

### 4.2 替换，不是叠加

表达「状态升级」时，新素材应当**接替**旧素材，而不是与它同时响。

反例：心跳慢的素材 `loop` 铺满全曲，同时在某个时间点叠加一份心跳快的素材。
结果不是「心率变快」，而是两套心跳同时响 —— 低频搅成一片，
而且「变快」这个意思被自己的慢速版本抵消了。

**规则：表示状态变化的两个素材，时间区间不重叠。** 交接点落在结构边界上。

同理，声部之间如果音高只差几个半音、又占同一频段，同时响只会互相掩盖。
**同频段只留一个声部**，要加厚就在它的音高上做文章，不是再加一个。

### 4.3 结构要能在时间轴上算术验算

每一段的时长必须是**基本单位的整数倍**（小节、秒、帧）。
否则循环接续时会逐遍累积偏移，几遍之后彻底错开 —— 而且不报错。

验算方法：把每段的时值列出来求和，确认等于预期的整段长度。

```
1n + 8n + 2n. + 4n = 4 + 0.5 + 3 + 1 = 8.5 拍   ← 不是整小节
```

这类错误在原稿里非常常见（写的时候按感觉凑，没求和）。
**改写时逐段求和一遍，是成本最低、收益最高的一步检查。**

### 4.4 终点要有设计，不要让它自然结束

素材铺满时长之后，「最后一段」往往只是「又一次循环」。
把它单独写出来 —— 末段的处理方式（留白、只留一个声部、不解决、延长尾音）
决定了整部作品停在什么位置上。

**具体做法**：末段单独写一份素材，而不是让前一段 `loop` 到底。
代价是几行重复，收益是作品有一个真正的结尾。

---

## 五、改写流程

### 5.1 先提取意图，再动语法

旧稿往往语法过时但意图可读。改写分两步，不要合并：

1. **提取意图**：这段想表达什么？（渐强、留白、对位、收束……）
2. **用 SPG 重新实现**：意图不变，实现重写。

跳过第 1 步会退化成「把旧写法逐句翻译成新写法」—— 旧稿里被语法限制逼出来的
绕路（复制粘贴的段落、靠时间偏移硬凑的层次）会被原样继承。

**判断哪些是「语法限制的产物」**：同一段内容被复制多份、只改一两个参数，
通常说明旧语法缺少「循环/变体」机制。这类重复正是改写要消掉的主要目标 ——
但消掉之后要按 4.1 检查：是真的用 `loop` 复述了两遍，还是写了两份素材。

### 5.2 逐项核对清单

写完后，对文件里**每一个**构造过一遍：

- [ ] 参数名在白名单里（拼写、单复数、下划线）
- [ ] 数值在实现允许的区间内（尤其：> 0、0~1、枚举值）
- [ ] 该字段真的有消费点，而不是「解析了但没人读」
- [ ] 时值/长度单位与 `parseDuration` 的规则一致（拍、秒、毫秒、小节）
- [ ] 引号、分隔符、注释符与实现的分词方式一致
- [ ] 顺序类参数（`direction`、`pattern`、`up`/`down`）已回到那几行代码确认过方向
- [ ] 若实现里对某些组合会抛错（如「A 必须配 B」），确认没有踩到
- [ ] 每段音序的时值求和等于整小节数（4.3）
- [ ] 所有 `sequence` 都被某条 `track` 引用，或确认不写 `mix`

---

## 六、注释纪律

> **注释不是证据。你上一轮写下的注释更不是。**
> 一份脚本里最危险的不是语法错误（会报错），而是**注释声称的行为与引擎实际行为不符** ——
> 它不报错、不告警，只是让下一个读的人（包括你自己）基于错的前提做决定。

### 6.1 两类缺陷，要分开验

| 类型 | 表现 | 怎么发现 |
|---|---|---|
| **数值型** | 注释里的秒数/频率/比例与实际不符 | 对着实现算一遍，把算式写进注释 |
| **方向型** | 注释说「上行/变亮/减少」，实际相反 | 读实现的分支，确认哪条路径生效 |

方向型最集中的地方是顺序类参数（2.11）与被压缩的参数（6.2）。

**规则：凡是注释里出现具体数字或方向词，就要能在实现里指出对应的那一行。**
指不出来，就删掉那个数字，改成定性描述。

### 6.2 参数写下的值 ≠ 听到的值

实现里常有「按比例压缩」「截断到上限」「钳制到区间」的逻辑，它们会让写下的数字与实际发声不符。

数值型最隐蔽的例子：包络的 A+D 若超过音符时值，实现会**按比例压缩**它们。
于是注释里写的「3.5 秒起音」实际是 3.0 秒。**要么把数值调到不被压缩，
要么在注释里说明会被压缩** —— 两者都行，装作没发生不行。

### 6.3 把自己上一轮写的注释也当作待审对象

迭代同一个文件时，最容易留下的错误是**上一轮自己写的注释**。
它们看起来「已经是审过的」，于是被跳过。

实操：每轮开始前，先把文件里所有含**具体数字、方向词、比较词**（「比…高」「低于」「唯一」）
的注释行 grep 出来，逐条对着当前实现重验。改动过参数之后，
这些注释几乎必然有一条已经过期。

**改动一处，搜一遍全局**：某声部的音区变了，所有说「高一个八度」「最低音是 X」的
注释都要重算。这类注释散落在文件各处，不会因为改了一行而自动出现。

### 6.4 不要用「原稿」当参照系

改写后的文件里出现「原稿这里写的是…」「比原来的 C3 高一个八度」这类句子，
对读者没有价值 —— 原稿可能已被删除、改名或不在手边。
**只写当前实现的技术理由**（「C3 会与长音撞同一音高，所以用 C4」），
不要写「改自哪里」。

---

## 七、命名：从结构里长出来

给作品取名时，**不要用情绪标签**（「忧伤」「恐怖」「激烈」）——
那等于替受众下了结论，而且任何同类作品都能套用。

**从结构里找一个具体的、可验证的事实当名字**：某个声部始终不动、
某次终止没有解决、某个数字反复出现。这样的名字：

- 不需要受众预先知道这是什么情绪；
- 名字自己说明了作品里发生了什么；
- 无法被套用到别的作品上。

命名与文件名是两回事：改名时同步更新文件内的标题与说明注释，**不要因为改名就动内容**。

---

## 八、验证边界

`npm run test:spg`（= `node test/index.js`）只编译 `services/AudioService.ts` 与 `meta`
到 `test/build/`，然后跑引擎与兼容性用例。**它不读取 `.spg/` 下的任何脚本文件。**

所以：**手写的 SPG 脚本永远处于「未执行验证」状态**，除非有人在 GUI 里粘贴编译。
交付时的正确说法是「已按实现逐条核对，未执行」，不是「已验证」（见 `verification-discipline`）。

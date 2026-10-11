# SPG 语法全文

> **权威来源**：`app/renderer/services/AudioService.ts`（解析器 `SPGParser`、调度器 `EventScheduler`、
> 合成器 `AudioSynthesizer` 都在这个文件里）。本文逐条对照该实现写成。
> `app/renderer/services/SpgAiService.ts` 里的 `SPG_SYSTEM_PROMPT` 是给模型看的同语言文档，
> **可能滞后于实现**；两者冲突时以实现为准。
>
> 解析器的原则是「**宁可报错，不要静默忽略**」：未知参数、非法时值、非法枚举都会抛出带行号的
> `SPGError`。所以拼错的参数名会立刻失败，而**语义写错的构造不会** —— 见第 13 节。

---

## 1. 文件结构

SPG 由五类块组成，顺序任意：

| 块 | 数量限制 | 作用 |
|---|---|---|
| `config { }` | 最多 1 个 | 速度 / 总音量 / 调性 / 音阶 / 摇摆 |
| `define_instrument(name="…") { }` | 任意多个 | 乐器定义 |
| `sequence(name="…", instrument="…") { }` | 任意多个 | 音符序列 |
| `effect_chain { }` | 顶层可写多个（顺序拼接成一条链）；每个乐器内最多 1 个 | 效果链，书写顺序 = 信号流顺序 |
| `mix { track(...) }` | 最多 1 个 | 编排；**一旦写了 mix，没有被 track 引用的 sequence 不会发声** |

注释用 `#` 或 `//`，按行剥离（识别引号内部，不会误剥字符串里的 `#`）。
块体可以同行连写：`hit("kick","4n") hit("hat","4n")` 会被正确切成两条语句。
语句末尾的分号可选。

**缩进用 2 空格**（不是语法要求，是约定）。

---

## 2. config

```spg
config {
  tempo: 120          # 或写 bpm:
  master_gain: 0.7    # 或写 gain:
  key: "Am"
  scale: "minor"
  swing: 0
}
```

| 参数 | 约束 | 默认 |
|---|---|---|
| `tempo` / `bpm` | > 0 且 ≤ 1000 | 120 |
| `master_gain` / `gain` | ≥ 0，上限截断到 2 | 0.6 |
| `key` | 正则 `^[A-Ga-g][#b♯♭]?m?$`，如 `"C"` `"Am"` `"F#"` `"Bbm"` | `"C"` |
| `scale` | 枚举，见下 | `"major"` |
| `swing` | 0~1 | 0 |

**scale 取值（14 个）**：
`major` `minor` `harmonic_minor` `melodic_minor` `dorian` `phrygian` `lydian`
`mixolydian` `locrian` `major_pentatonic` `minor_pentatonic` `blues` `chromatic` `whole_tone`

> **`key` 与 `scale` 只做格式校验，调度与合成都不读它们。** 写 `key: "Cm"` 不会转调，
> 也不会滤掉音阶外的音。要让曲子听起来在某个调上，音高必须自己写对。

**swing 的实际行为**：把落在十六分网格奇数步的音往后推 1/3 个十六分，把 `step % 4 === 2`
（后半拍八分）往后推 2/3 个十六分，位移量再乘以 `swing`。
`8n` 写法落在偶数步上，**只处理奇数步的话 `8n` 完全不受影响**，所以两层都做了 —— 但
四分与八分音符为主的旋律听感变化仍然有限，它主要作用在十六分与八分交替的琶音上。

---

## 3. define_instrument

```spg
define_instrument(name="lead") {
  preset: "supersaw"
  wave: "sawtooth"
  gain: 0.6
  pan: -0.2
  effect_chain {
    chorus(rate=1.2, depth=4, mix=0.4)
  }
}
```

头部参数：`name` / `instrument` / `id`（`name` 必填，缺失报错；同名乐器重复定义报错）。

### 3.1 全部乐器参数（白名单）

```
preset  wave  envelope  env  amp_envelope  filter  filter_envelope  filter_env_amount
lfo  pan  gain  fm_wave  fm_index  fm_ratio  detune  glide  glide_from
pitch_env_amount  pitch_decay  spread  velocity_sensitivity  velocity_to_filter
voices  unison_spread  harmonics  attack_noise  loop_point  effect_chain
```

| 参数 | 含义与取值 | 默认 |
|---|---|---|
| `preset` | 参数基线，其余字段逐项覆盖它 | 无 |
| `wave` | `sine` `square` `sawtooth` `triangle` `white_noise` `pink_noise` `brown_noise` `custom` | `sine` |
| `envelope` / `env` / `amp_envelope` | 振幅包络字符串，见第 6 节 | `adsr(0.01, 0.1, 0.7, 0.2)` |
| `filter` | 滤波器字符串，见第 7 节 | 无 |
| `filter_envelope` | 滤波包络（同包络写法） | 无 |
| `filter_env_amount` | 滤波包络调制深度（Hz） | 0 |
| `lfo` | 低频调制字符串，见第 8 节 | 无 |
| `gain` | 乐器基线音量 | 0.8 |
| `pan` | -1 全左 ~ 1 全右 | 0 |
| `fm_wave` | 只能是 `sine` `square` `sawtooth` `triangle`（写噪声名报错） | 无 |
| `fm_index` | 调制深度（Hz）。**不是教科书的调制指数** | 无（0 或缺省 = FM 关闭） |
| `fm_ratio` | 倍频比，**必须 > 0**（≤0 报错） | 无 |
| `detune` | 音分 | 0 |
| `glide` | 起音滑音时长（秒），不能为负 | 0 |
| `glide_from` | 滑音起始偏移（半音） | -12 |
| `pitch_env_amount` | 音高包络深度（半音），**正值是先高后低** | 0 |
| `pitch_decay` | 音高包络衰减时长（秒），不能为负 | 0.05 |
| `spread` | 立体声展开宽度 0~1 | 0 |
| `velocity_sensitivity` | 力度对音量的影响程度 | 0.7 |
| `velocity_to_filter` | 力度对滤波截止的影响（Hz），强奏更亮 | 0 |
| `voices` | 每音符叠加几个失谐振荡器，截断到 1~7 | 1 |
| `unison_spread` | 声部间失谐（音分） | 12 |
| `harmonics` | 谐波振幅数组，如 `[1, 0.5, 0.33, 0.25]`，不能为空 | 无 |
| `attack_noise` | 起音噪声爆发量，截断到 0~1 | 0 |
| `loop_point` | 循环起音点（秒），不能为负 | 0 |
| `effect_chain` | 乐器级效果链（写成 `effect_chain { … }` 嵌套块） | 无 |

**互斥与必填约束（违反即报错）**：

- `wave: "custom"` **必须**同时有 `harmonics`（可以来自 preset 基线），否则报错。
- 噪声波形（`white_noise` / `pink_noise` / `brown_noise`）**不能**与 `harmonics` 同用 ——
  噪声走 BufferSource，根本没有振荡器可挂谐波，不拦的话会安静地按纯噪声发声。
- `fm_ratio` ≤ 0 报错；不需要 FM 就把 `fm_wave` / `fm_ratio` / `fm_index` 三个一起删掉。

### 3.2 预设（`Object.keys(PRESETS)`，51 个）

```
piano  electric_piano  organ  harpsichord  clavinet
synth_pad  warm_pad  supersaw  lead_square  chiptune
bass  sub_bass  reese_bass  acid  plucked_synth
bell  marimba  music_box  glass
guitar  nylon_guitar  electric_guitar  harp  pizzicato
violin  viola  cello  contrabass  strings_section  solo_strings
brass_ensemble  trumpet  french_horn  trombone  tuba
flute  piccolo  clarinet  oboe  bassoon  choir  timpani
kick  snare  tom  hihat  crash  noise_sweep  wind  rain  thunder
```

预设名大小写不敏感（`getPreset` 会 `toLowerCase()`）。未知预设名报错并列出全部可用值。

几个预设的关键数值，写注释时可以引用：

| 预设 | 要点 |
|---|---|
| `piano` | `wave: sine`，`fm_wave: triangle`，`fm_ratio: 3.0`，`fm_index: 180`，`gain: 0.75`，`voices: 2`，`unison_spread: 3`，低通 6000Hz Q0.4，`velocity_sensitivity: 0.85`，`velocity_to_filter: 3000` |
| `bell` | `fm_index: 420`（金属钟声靠高 fm_index） |
| `timpani` | `pitchEnvAmount: 5`（鼓皮张力下坠） |

### 3.3 两个方向容易写反的参数（已在实现中核对）

**`pitch_env_amount` 是向下掉音高。** 振荡器从 `freq * 2^(amount / 12)` 起振 —— 即**高于**写的音高 ——
在 `max(0.005, pitch_decay)` 秒内指数回落到 `freq`。正值 = 先高后低，这就是底鼓/定音鼓
「鼓皮张力下坠」的来源。注释写「音高下落」是对的，写「音高上扬」是方向性错误。

**`loop_point` 的重起音段长不等于 `loop_point`。** 当 `loopPoint > 0 && noteDur > loopPoint * 1.5` 时，
音符被切成 `segments = floor(noteDur / loopPoint)` 段等长片段，每段长 `segDur = noteDur / segments`，
每段重新起音。例：64 BPM 下 `1n` = 3.75s，`loop_point: 1.8` 得 `segments = floor(3.75 / 1.8) = 2`，
每段 1.875s —— 注释写「每 1.8s 重起音」偏差约 4%。
另外这个模式只在 `sustain < 1` 时听得出来：`sustain = 1.0` 时「衰减到 sustain」等于原地不动。

---

## 4. sequence

```spg
sequence(name="melody", instrument="lead", gain=1.0, transpose=0, humanize=0) {
  note("C5", "4n")
  chord("Am7", "2n")
  chord(["C4","E4","G4"], "2n", voicing="drop2")
  progression(["Am7","Dm7","G7","Cmaj7"], "1n")
  arp("Am7", pattern="up", rate="16n", duration="1n")
  run(["C4","D4","E4","G4"], "16n")
  hit("kick", "4n")
  rest("8n")
}
```

头部参数：`name` / `seq` / `id`（必填，重复报错）、`instrument` / `inst`（默认 `"default"`）、
`gain`（默认 1）、`transpose`（半音，默认 0）、`humanize`（0~1，默认 0）。

- 只有含音高类指令（`note` / `chord` / `arp` / `progression` / `run`）的音序才需要乐器；
  **纯 `hit` 的鼓组音序不需要任何乐器定义**。
- 一个音序里一条指令都没有 → 报错。
- 全部音序都没定义乐器时，引擎会补一个 `default`（正弦，gain 0.5）。

### 4.1 七条指令

| 指令 | 参数 | 说明 |
|---|---|---|
| `note(音名, 时值)` | 具名写法 `pitch` / `note` / `n`，`duration` / `dur` / `len` / `d` | 单音。写和弦符号会报错并提示改用 `chord()` |
| `chord(和弦, 时值, …)` | `strum` `voicing` `octave` `pitches`/`chord`/`notes` `duration`/`dur` | 第一个参数可以是和弦符号或音高数组 |
| `arp(和弦, …)` | `pattern` `rate` `duration` `octaves` `gate` `voicing` `octave` `chord`/`notes`/`pitches` | 琶音 |
| `progression(和弦数组, 时值, …)` | `chords`/`chord` `beats`/`beat` `voicing` `octave` `octaves` `pattern` `strum` `gate` | 和声进行 |
| `run(音高数组, 速率, …)` | `notes`/`pitches` `rate`/`step` `direction`/`pattern` `repeat`/`times` `gate` | 音型跑动 |
| `hit(鼓组名, 时值, …)` | `drum`/`name` `duration`/`dur`/`len` `tune` `decay` `tone` `snap` | 打击乐，不需要乐器 |
| `rest(时值)` | `duration`/`dur`/`len` | 休止。**不接受逐音符表现力参数** |

未知指令报错并列出可用清单。所有指令名大小写不敏感。

### 4.2 逐音符表现力参数（`NOTE_EXPR_PARAMS`）

```
velocity  vel  pan  gain  gate  transpose  glide  detune  humanize  human  octave  accent
```

| 参数 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `velocity` / `vel` | 截断到 0~1 | 0.8 | 同时影响音量与亮度 |
| `pan` | 截断到 -1~1 | 乐器 pan | 覆盖乐器声像 |
| `gain` | ≥ 0 | 乐器 gain | 覆盖乐器音量 |
| `gate` | ≥ 0（调度时再截断到 0~4） | 1 | 时值缩放：0.5 断奏、1.5 连奏 |
| `transpose` | 半音 | 0 | 临时移调 |
| `octave` | 八度数 | 0 | 等价于 `transpose = octave * 12`，与 `transpose` 相加 |
| `glide` | ≥ 0 | 乐器 glide | 该音符的滑音时长（秒） |
| `detune` | 音分 | 乐器 detune | 覆盖失谐 |
| `humanize` / `human` | 0~1 | 音序 humanize | 人性化抖动 |
| `accent` | 布尔 | false | `accent=true` 等价于 `velocity=1` |

布尔值的合法写法：真 = `true` / `1` / `yes` / `on`，假 = `false` / `0` / `no` / `off`（大小写不敏感）。
**写别的词（如 `accent=maybe`）会报错**，不会静默当 false —— 安静地演奏成普通力度是最难排查的一类问题。

枚举取值一律大小写不敏感：指令名、滤波器类型、`voicing`、`pattern`、`scale`、`target` 等，
比对时都做 `toLowerCase()`。

**`octave` 在 `chord` 里是另一回事**：`chord("Am7","1n", octave=3)` 的 `octave` 是
「和弦发在第几八度」（声位寄存器），实现里被标为 reserved，不会再当成移调参数解释。
若两边都解释，`octave=3` 会同时把整组音再升高 36 个半音。

### 4.3 chord

```
chord(和弦或音高数组, 时值, strum=0, voicing="close", octave=4)
```

- `voicing`：`close` 密集（默认）| `open` 开放（第二音升八度）| `drop2` 爵士左手（倒数第二音降八度）| `spread` 宽铺底（相邻音交替升八度）
- `octave`：默认 4（中央 C 所在八度）
- `strum`：0~1，各声部依次进入，每个声部偏移 `strum * 0.055` 秒
- **`chord` 接受 `gate`**（逐音符表现力参数统一合并），且**时间轴只按 `duration` 前进** ——
  `strum` 的错位不会推移后续指令。所以收尾长和弦可以写
  `chord([...], "1n", strum=0.3, gate=1.5)`，它会响到 1.5 倍时值并溢进混响尾巴。

### 4.4 arp

```
arp(和弦或音高数组, pattern="up", rate="16n", duration="1n", octaves=1, gate=0.9)
```

- `pattern`：`up` | `down` | `upDown` | `downUp` | `asPlayed` | `random`
- `rate` 默认 `16n`；`duration` 是琶音**总时长**，必填
- `octaves` 截断到 1~4；`gate` 默认 0.9
- **`up` / `down` 按音高排序，不是书写顺序**；只有 `asPlayed` 与 `random` 保留书写顺序。
  按下标排序会让 `["C3","G3","Eb3"]` 出来的根本不是上行琶音。
- 步数 = `floor(duration / rate)`，下标**对 `order.length` 取模回绕**。
  四音池的 `upDown` 是 6 步（0-1-2-3-2-1），配 8 个八分音符会绕回池子的前两个音 ——
  是波浪形轮廓，不是干净的重复。
- `upDown` / `downUp` 在 `len <= 2` 时退化为单程，避免两音和弦变成同音重复。
- **`arp` 接受具名音高来源**：`arp(chord=[...])`，也可写 `notes=` / `pitches=`。
  具名来源优先于位置参数，且一旦给出，位置参数就整体让位给 `pattern` / `rate` / `duration`
  （从下标 0 开始读）。这样 `arp(chord=["C4"], "up", "16n", "1n")` 不会把 `"up"` 当成和弦符号。

### 4.5 progression

```
progression(["Am7","Dm7","G7","Cmaj7"], "1n", voicing="drop2", pattern="asPlayed")
progression(["Am7","Dm7","G7","Cmaj7"], ["1n","1n","1n","2n"])
```

- 时值参数叫 **`beats`**（别名 `beat`）。**没有 `duration`** —— 写了直接报错。
- 时值可以是单个记号（每个和弦等长），也可以是与和弦数等长的数组；
  数组长度与和弦数不一致会报错。
- `pattern` 默认 `asPlayed`（齐奏）；改成 `up` / `down` 等就按琶音方式把和弦音依次奏出，
  直接得到分解和弦伴奏。`octaves` 1~4 跨八度扩展。
  注意 **`progression` 的步长与 `arp` 不同**：`arp` 的步长是 `rate`、步数是 `floor(duration / rate)`；
  `progression` 则把**每个和弦自己的时值**平分成 `order.length` 步（`stepDur = dur / order.length`），
  所以这里没有 `rate` 参数。
- 和弦数组里可以混写具体音高数组。

### 4.6 run

```
run(["C4","D4","E4","G4"], "16n", direction="up", repeat=1, gate=1)
```

- `direction`：`up` 原序 | `down` **反转数组** | `updown` 往返。也接受 `pattern` 这个名字。
- `direction="down"` 是**反转数组**，所以要让音高下行，**数组必须按上行写**。
  写成下行数组再传 `down`，得到的是上行线条 —— 与意图完全相反，且不报错。
- `updown` 在长度 > 2 时是 `原序 + 中间段反转`（首尾不重复）。
- `repeat` ≥ 1；`gate` 默认 1。

### 4.7 hit

```
hit("kick", "4n", tune=0, decay=1, tone=0, snap=0)
```

- 鼓组名可位置传，也可用 `drum=` / `name=`。**刻意不收 `kit=`**：`kit` 指整套鼓，而这里要的是单件。
- 时值默认 `8n`。
- `tune` 半音微调 | `decay` 衰减倍数（**必须 > 0**，下限 0.05）| `tone` 噪声中心频率偏移（Hz）| `snap` 0~1 起音冲击（越界报错）。
- 音符时值短于音色自然衰减时会被 gate 截断（可用来掐掉开镲）。

### 4.8 鼓组（`DRUM_NAMES`，16 个）

```
kick  sub_kick  snare  rim  clap  hat  open_hat  pedal_hat
tom_low  tom_mid  tom_high  crash  ride  cowbell  shaker  tambourine
```

三种合成模型：`membrane`（带音高包络的正弦膜振动）、`noise`（噪声为主、带通塑形）、
`metallic`（多个非谐方波分音叠加）。

**鼓组事件不经过乐器的滤波 / LFO / gain / pan 链路**，它们只认逐音符的 `velocity` / `pan`
与 mix 轨道的 `pan`，音色由 `DRUM_SPECS` 自带标定：

| 鼓 | 模型 | 频率 | 衰减 | gain | 高通 |
|---|---|---|---|---|---|
| `kick` | membrane | 52 | 0.34 | 1.0 | 28 |
| `sub_kick` | membrane | 38 | 0.62 | 1.0 | 24 |
| `snare` | noise | 190 | 0.19 | 0.8 | 160 |
| `rim` | noise | 420 | 0.05 | 0.6 | 500 |
| `clap` | noise | 300 | 0.28 | 0.7 | 400 |
| `hat` | metallic | 320 | 0.055 | 0.45 | 6000 |
| `open_hat` | metallic | 320 | 0.42 | 0.42 | 5500 |
| `pedal_hat` | metallic | 300 | 0.09 | 0.38 | 4000 |
| `tom_low` | membrane | 92 | 0.5 | 0.8 | 50 |
| `tom_mid` | membrane | 132 | 0.42 | 0.8 | 60 |
| `tom_high` | membrane | 186 | 0.36 | 0.78 | 80 |
| `crash` | metallic | 280 | 1.9 | 0.4 | 2500 |
| `ride` | metallic | 420 | 1.3 | 0.38 | 3000 |
| `cowbell` | metallic | 540 | 0.32 | 0.45 | 400 |
| `shaker` | noise | 200 | 0.11 | 0.4 | 2200 |
| `tambourine` | noise | 260 | 0.3 | 0.42 | 3000 |

鼓组振幅公式：`clamp(spec.gain * (0.45 + velocity * 0.7), 0, 2, 0.8)`。

---

## 5. 时值写法（`parseDuration`）

| 写法 | 含义 |
|---|---|
| `1n` `2n` `4n` `8n` `16n` `32n` `64n` `128n` | 1/N 全音符，**全音符 = 4 拍** |
| `4n.` | 附点，×1.5 |
| `4n..` | 双附点，×1.75（**不是** 1.5×1.5 = 2.25） |
| `4nt` | 三连音，×2/3 |
| `1m` | 1 小节 = 4 拍（按 4/4 计），正则 `^([\d.]+)m$`，所以 `2m` = 8 拍、`3m` = 12 拍 |
| `250ms` | 毫秒 |
| `1.5s` | 秒 |
| `250` | 纯数字**按秒**算，不是拍 |
| `4x` | **报错**。纯数字必须整串都是数字 |

附点与三连音可以叠加，倍率 = `(2 - 2^-dots) * (2/3)^triplets`，最多循环 8 次。
`1m` 恒为 4 拍，与 tempo 无关。

一拍秒数 = `60 / tempo`。例：64 BPM → 1 拍 0.9375s，1 小节 3.75s，16 小节 60s。

---

## 6. 包络

```
adsr(a, d, s, r)      ad(a, d)      ar(a, r)      perc(a, d, r)
```

- 参数可位置传，也可用具名：`a`/`attack`、`d`/`decay`、`s`/`sustain`、`r`/`release`。
- 附加具名参数：`curve=linear|exp|hold`（默认 `exp`）、`delay=秒`（默认 0）。
- **`adsr` 的 `s` 是 0~1 的电平比例，不是秒**；> 1 截断到 1。
- 负值一律报错（负时间会让自动化时间点倒流）。
- `ad` 的 release 自动取 decay 的一半；`ar` 的 sustain 固定为 1；`perc` 的 sustain 固定为 0。

各形态的默认值：

| 形态 | 默认 |
|---|---|
| `adsr` | a=0.01, d=0.1, s=0.7, r=0.2 |
| `ad` | a=0.01, d=0.3, r=0.15（= d/2） |
| `ar` | a=0.05, r=0.4, d=0.01, s=1 |
| `perc` | a=0.001, d=0.3, r=0.15 |

写法示例（值加引号或裸写都认；块内字段是带括号深度的线性扫描，所以跨行数组也能解析）：

```
envelope: "adsr(0.01, 0.3, 0.5, 0.4)"
envelope: "perc(0.001, 0.25, 0.1)"
envelope: "adsr(1.5, 1.0, 0.8, 2.5, curve=linear)"
```

演奏法配方：

| 演奏法 | 包络 |
|---|---|
| 断奏 staccato | `perc(0.001, 0.15, 0.08)` |
| 连奏 legato | `adsr(0.25, 0.3, 0.9, 0.5)` |
| 拨弦 pluck | `adsr(0.004, 1.2, 0.0, 0.3)` |
| 持续 pad | `adsr(1.5, 1.0, 0.8, 2.5, curve=linear)` |

> **A + D 超过音符时值会被按比例压缩。** 见第 13 节第 9 条。

---

## 7. 滤波器

```
lowpass(freq, Q)   highpass(freq, Q)   bandpass(freq, Q)   notch
lowshelf   highshelf   peaking   allpass
```

- 类型枚举：`lowpass` `highpass` `bandpass` `notch` `lowshelf` `highshelf` `peaking` `allpass`
- 位置参数 `(freq, Q)`，也可具名 `freq`/`frequency`、`q`、`gain`
- 附加参数：`sweep` / `sweep_to=目标频率`（在音符时值内自动扫频，riser 效果）
- `freq` 必须 > 0（默认 1000）；`Q` 不能为负（默认 1，实现里截断到 0~30）
- `gain` 用于 shelf / peaking

```
filter: "lowpass(800, 2)"
filter: "bandpass(1200, 1.5, sweep_to=6000)"
```

---

## 8. LFO

```
波形(freq=速率Hz, amount=深度, target=目标, ramp=淡入秒, swell=true)
```

波形只能是 `sine` | `square` | `sawtooth` | `triangle`。
`target`：`frequency` | `filter` | `gain` | `pan` | `detune`（默认 `frequency`）。

**`amount` 的量纲随 `target` 变化**：

| target | 单位 | 截断范围 | 常用值 |
|---|---|---|---|
| `frequency` / `detune` | **音分** | ±1200 | 5~15 自然颤音，50+ 夸张 |
| `filter` | Hz | 0~12000 | 200~2000 自动哇音 |
| `gain` | 深度比例 0~1 | 0~1 | 0.2~0.5 震音 |
| `pan` | -1~1 | 0~1 | 自动摇摆 |

`ramp` 让调制慢慢进入（弦乐/长笛必用，否则起音会抖）。
`swell=true` 让调制深度线性升到 `peakAmount * 2.2`，终点在
`t + max(0.05, 音符时值, ramp)`。

```
lfo: "sine(freq=5.5, amount=10, target=frequency, ramp=0.6)"
```

---

## 9. 效果链与效果器

`effect_chain` 可放顶层（作用于全部声音），也可放进 `define_instrument` 里（只作用于该乐器）。
顶层写多个 `effect_chain` 块会按书写顺序拼成一条链。
**顺序很重要**：失真应排在延迟/混响之前，否则会把尾音一起弄脏。

### 9.1 十三个效果器

| 效果器 | 参数（含默认值） |
|---|---|
| `delay` / `pingpong` | `time`=0.3（**时值参数**，可写 `"8n."`）`feedback`=0.3 `mix`=0.4 `damping`=2000 `pingpong`=false |
| `reverb` | `decay`=2.0 `mix`=0.3 `predelay`/`pre_delay`=0.01 `damping`=5000 |
| `distortion` | `amount`=0.5 `mix`=1 |
| `overdrive` | `amount`=0.15 `mix`=1 |
| `bitcrush` | `bits`=8（截断到 1~16）`mix`=1 |
| `chorus` | `rate`=1.5 `depth`=3.5 `mix`=0.5 |
| `flanger` | `rate`=0.3 `feedback`=0.6 `mix`=0.5 |
| `phaser` | `rate`=0.5 `min`=300 `max`=2000 `mix`=0.6 |
| `tremolo` | `rate`=5 `depth`=0.6 |
| `compressor` | `threshold`=-20 `ratio`=4 `attack`=0.01 `release`=0.25 |
| `filter` | `kind`=`lowpass` `from`=200 `to`=4000 `q`=1 `duration`=2（**时值参数**）`start`=0 |
| `eq` | `low`=0 `mid`=0 `high`=0（单位 dB） |

**`filter` 效果器最容易写错**：`start` 是**扫频起始时刻（秒）**，起始频率要写 `from`。
凭直觉写 `start=200` 不会报错，那个数字会被当成时间读，含义完全变了。

**`delay` / `pingpong` 的 `time` 是时值参数**（`durArg(['time'], 0, '0.3')`），
所以 `time="8n."` 合法且随 tempo 变化；64 BPM 下 `8n.` = 0.703s。
`pingpong` 的右声道延迟是 `time * 1.5`。

**`eq` 的实现**：低架 250Hz / 峰值 1200Hz Q0.9 / 高架 4000Hz，每段截断到 ±24dB。
注释里描述低频段请写 **250Hz**，不是 200Hz。

### 9.2 同义参数名（能编译，但会给出「已按某某处理」的提示）

```
delay→time      fb→feedback     tone→damping    ping_pong→pingpong
size→decay      drive→amount    gain→amount     depth→bits
speed→rate      bass→low        treble→high     end→to
dur→duration    at→start        from→min        to→max
```

正式写法请直接用规范名。**`filter` 里没有 `start: 'from'` 这条别名，是刻意的**：
`start` 已经是「扫频起始时刻」，再当「起始频率」的别名，同一个名字就背上两种量纲。

---

## 10. mix（编排）

```spg
mix {
  track(source="drums",  time=0, loop=4)
  track(source="bass",   time=0, loop=4)
  track(source="melody", time="2n", loop=1, gain=0.9, pan=0.2)
}
```

| 参数 | 说明 | 默认 |
|---|---|---|
| `source` / `seq` / `track` | 引用的音序名，必须存在 | 必填 |
| `time` / `at` | 起始时刻，秒或时值记号 | 0 |
| `loop` / `repeat` / `times` | 重复次数，≥ 0 取整 | 1 |
| `gain` | 轨道音量 | 1 |
| `pan` | 轨道声像，截断到 ±1 | 0 |
| `stagger` | 每次循环的错位增量（秒），可做卡农 | 0 |

### 10.1 loop 的真实语义

**`loop` 是「从上一遍的终点接着再演一遍」，不是每遍都从 `time` 重来。**

```
currentStart = time
for i in 0..loop-1:
    duration = play(source, currentStart)
    currentStart += duration + stagger
```

推论：

- 4 小节的音序 `loop=3` 正好覆盖 12 小节，既不重叠也不留缝。
- 要让某个声部「每 8 小节回来一次」，**`loop` 做不到**；用多条 `track` 各写自己的 `time`。
- `stagger` 让每次重复错位叠加（卡农），但也让这个声部比别的声部长出 `stagger`。
- **多条 track 可以引用同一个 `source`** —— `mix` 就是一张列表，每条独立调度。
  这是「把同一份素材在时间轴后段重述一次」的正确写法。
- **不写 mix 时，所有音序按定义顺序首尾相接**（一个游标），不是全部从 0 叠加。
  这一点常被误认为「同时播放」。

### 10.2 写了 mix 之后的静默失效

写了 `mix` 之后，**没有被任何 track 引用的音序不会发声**，解析器只给一条警告：
`以下音序没有被 mix 引用，不会发声：…`。编译通过、界面显示 READY，但那一轨听不见 ——
改动两侧（加/删 sequence 与改 mix）必须同步。

---

## 11. 音量、力度与人性化

### 11.1 三级增益相乘

```
gain = clamp(baseGain * velScale * seqGain * trackGain * jitterGain, 0, 2, 0.8)
```

- `baseGain`：逐音符 `gain`，否则乐器 `gain`（默认 0.8）。
  **鼓组例外**：`baseGain = expr.gain ?? 1`，绝不沿用当前乐器的 gain
  （否则加一个 `gain: 0.2` 的铺底音色会让底鼓一起变轻）。声像同理。
- `velScale = clamp((1 - sens) + sens * (velocity / 0.8), 0, 1.6, 1)`，
  `sens` = `velocity_sensitivity`（默认 0.7）。
  **`velocity = 0.8` 正好是 1.0 倍**；`sens = 0.85` 时 `velocity = 0.4` 只有 0.58 倍。
- 最后整体再乘 `config.master_gain`。

> 写 `velocity = 1.0` 会顶到截断上限。**留出余量（0.3~0.9）更好。**

### 11.2 人性化抖动

`humanize` 产生**可复现**的随机抖动：音高 ±12 音分、力度 ±12%、时间 ±0.012s，
全部按 `humanize` 值缩放。种子 = `hash(音序名 : 起始时刻 : 轨道下标/循环下标)`，
所以同一份代码每次渲染出的音频一致。

### 11.3 力度影响音色

`velocity_to_filter` 让强奏更亮：`滤波截止 + (velocity - 0.8) * velocity_to_filter`，
结果截断到 20~20000Hz。这是管弦乐「强弱 = 音色」的关键。

---

## 12. 导出长度

```
总时长 = 所有事件的结束时刻
tailRoom = 效果链非空 ? min(max(3.0, 最长混响 decay), 12) : 0.5
导出长度 = 总时长 + tailRoom
```

- 混响 `decay` 在合成时被截断到 0.05~12 秒（`MAX_REVERB_DECAY = 12`，与脉冲生成共用）。
- 离线渲染总长上限 900 秒（`MAX_RENDER_SECONDS`）。
- `EFFECT_TAIL = 3.0` 是效果链存在时的最小留尾。

**算例**：64 BPM、16 小节 = 60s，全局链里有 `reverb(decay=6.5)` →
`tailRoom = min(max(3, 6.5), 12) = 6.5`，导出约 66.5s。

---

## 13. 「能编译但和你想的不一样」清单

解析器只拦语法，不拦语义。写之前逐条确认：

1. **`fm_index` 不是教科书的调制指数** —— 它是直接加到载波频率上的 Hz 频偏，随时间衰减到 8%。
   `bell` 用 420，`piano` 用 180。
2. **`filter` 效果器的 `start` 是扫频起始时刻**，起始频率写 `from`。
3. **`progression` 没有 `duration`**，时值参数叫 `beats`。
4. **`run` 的 `direction="down"` 反转数组**，要下行输出就得写上行数组。
5. **`arp` 的 `up` / `down` 按音高排序**，只有 `asPlayed` 保留书写顺序。
6. **噪声 `wave` 不能配 `harmonics`**；`wave:"custom"` 必须配 `harmonics`。
7. **`fm_ratio` 必须为正**；不需要 FM 就把三个 fm 字段一起删掉。
8. **`config` 的 `key` / `scale` 不参与发声**，不转调也不滤音。
9. **包络 A+D 超过音符时值会被按比例压缩**（振幅包络与滤波包络都是）：
   1 小节的音符配 `adsr(3.5, 2.0, …)`，实际起音约 3.0 秒。
   滤波包络同理，峰值是 `基础频率 + amount`，持续电平是 `基础频率 + amount * sustain`。
10. **同乐器、同时刻、同音高只是叠加振幅**（两个同相振荡器约 +6dB），听不出「更厚」。
    要加厚就换音高或换音色。
11. **一条音序内的指令严格串行**，不存在同时发声；跨音序的同时发声靠 `mix` 的 `time` 对齐。
12. **每段音序的时值应当是整小节数**，否则 `mix` 的 `time` 会逐遍累积偏移。
13. **`pitch_env_amount` 是向下掉音高**，从 `freq * 2^(amount/12)` 落到 `freq`。
14. **`loop_point` 的重起音段长是 `noteDur / floor(noteDur / loopPoint)`**，不是 `loopPoint` 本身。

---

## 14. 完整示例

```spg
# 五种块齐全的最小完整作品：16 小节，96 BPM

config {
  tempo: 96
  master_gain: 0.7
  key: "Cm"
  scale: "minor"
  swing: 0
}

define_instrument(name="keys") {
  preset: "electric_piano"
  gain: 0.7
  pan: -0.2
  envelope: "adsr(0.005, 1.2, 0.2, 0.5)"
  lfo: "sine(freq=5.2, amount=8, target=frequency, ramp=0.6)"
  velocity_to_filter: 2000
}

define_instrument(name="pad") {
  preset: "warm_pad"
  gain: 0.45
  spread: 0.6
  attack_noise: 0.1
  effect_chain {
    chorus(rate=0.8, depth=4, mix=0.4)
  }
}

# 1 小节：8 个八分 = 4 拍
sequence(name="drums") {
  hit("kick", "8n", velocity=0.95)
  hit("hat", "8n", decay=0.6)
  hit("snare", "8n", velocity=0.7)
  hit("hat", "8n", tune=2)
  hit("kick", "8n", velocity=0.85)
  hit("hat", "8n", decay=0.6)
  hit("snare", "8n", velocity=0.75)
  hit("open_hat", "8n", velocity=0.5)
}

# 2 小节 = 8 拍
sequence(name="bass", instrument="keys", transpose=-12, humanize=0.1) {
  note("C2", "2n", velocity=0.8, gate=0.9)
  note("G2", "2n", velocity=0.7)
  note("Ab2", "2n", velocity=0.75)
  note("G2", "2n", velocity=0.6)
}

# 4 小节 = 16 拍
sequence(name="chords", instrument="pad") {
  progression(["Cm7", "Abmaj7", "Fm7", "G7"], "1m", voicing="drop2")
}

# 2 小节 = 8 拍：1 + 1.5 + 4 + 0.5 + 1
sequence(name="melody", instrument="keys", humanize=0.25) {
  note("Eb4", "4n", velocity=0.6)
  note("G4", "4n.", velocity=0.78)
  arp("Cm7", pattern="upDown", rate="16n", duration="1n", octaves=2, gate=0.85)
  rest("8n")
  chord("Cm7", "4n", strum=0.3, gate=1.2, velocity=0.55)
}

effect_chain {
  eq(low=1.5, mid=-1, high=2)
  delay(time="8n.", feedback=0.3, mix=0.2, damping=2500)
  reverb(decay=3.5, mix=0.3, pre_delay=0.02, damping=5000)
}

mix {
  track(source="drums",  time=0,    loop=16)          # 1 小节 × 16 = 16 小节
  track(source="bass",   time=0,    loop=8)           # 2 小节 × 8  = 16 小节
  track(source="chords", time=0,    loop=4, gain=0.9) # 4 小节 × 4  = 16 小节
  track(source="melody", time="4m", loop=6, pan=0.15) # 从第 4 小节起，2 × 6 = 12 小节
}
```

时值核对：96 BPM → 1 拍 0.625s，1 小节 2.5s，16 小节 **40s**；
混响 decay 3.5 → `tailRoom = 3.5`，导出约 **43.5s**。

---

## 15. 结构纪律（写曲子时用）

- **`loop=N` 是重述，不是发展。** 同一段素材 `loop=2` 得到的是完全相同的音高、时值与走向，
  听到的是「同一句话说两遍」。要发展就**另写一份素材**，参数微调补偿不了结构上的重复。
  自检：第二遍里有哪怕一个新音吗？
- **替换，不要堆叠。** 表达「状态升级」的新素材应当**接管**旧素材，而不是与它同时响。
  两个只差几个半音、又占同一频段的声部同时响，只会互相掩盖。**一个频段留一个声部。**
- **结构要能在时间轴上做算术核对。** 每段时值必须是基本单位（小节）的整数倍，
  否则 `loop` 续接会逐遍累积偏移，几遍之后整体错位且不报错。
  改写时把每段时值加起来核一遍，是成本最低、收益最高的一次检查。
- **结尾要设计，不能让它自然耗尽。** 素材铺满时长后，「最后一段」通常只是「又一次循环」。
  末段的处理（留白、只留一个声部、不解决、延长尾音）决定作品停在什么位置。

---

## 附：AI 通道约定（不是引擎语法）

以下只对 `app/renderer/services/SpgAiService.ts` 的生成通道有效，**引擎不认**：

- 生成时**第 1 行**必须是作品名注释：`# 作品名：三圈半`。
  正则 `^[ \t]*(?:#|//)[ \t]*作品名[ \t]*[:：][ \t]*([^\r\n]+)$`（多行模式）。
  这一行会被 `splitTitle` 摘走并替换工程标题 —— 工程名的唯一权威是 `Project.name`，
  注释留在代码里就是同一件事的第二个副本。摘不掉也不影响编译，作品名通道永远不会反过来弄坏代码通道。
- 命名规则：2~8 个字，从**这首曲子的结构里**取一个具体事实（某个声部始终不动、
  某次终止没有解决、某个数字反复出现）。**禁止情绪标签**（「忧伤」「恐怖」「史诗」）——
  那等于替听众下结论，任何同类作品都能套用。
- 迭代优化（`refineSyntax`）与修复（`fixSyntax`）**不写也不改**这一行。

# SPG 语法

> 未知参数、非法时值、非法枚举都会报出带行号的编译错误；拼错的参数名会立刻失败。

---

## 1. 文件结构

SPG 由五类块组成，顺序任意：

| 块 | 数量限制 | 作用 |
|---|---|---|
| `config { }` | 最多 1 个 | 速度 / 总音量 / 调性 / 音阶 / 摇摆 |
| `define_instrument(name="…") { }` | 任意多个 | 乐器定义 |
| `sequence(name="…", instrument="…") { }` | 任意多个 | 音符序列 |
| `effect_chain { }` | 顶层可写多个（按书写顺序拼成一条链）；每个乐器内最多 1 个 | 效果链 |
| `mix { track(...) }` | 最多 1 个 | 编排；写了 mix 后，没被 track 引用的 sequence 不发声（见第 11.2 节） |

注释用 `#` 或 `//`，按行剥离（识别引号内部，不会误剥字符串里的 `#`）。
块体可以同行连写：`hit("kick","4n") hit("hat","4n")` 会被正确切成两条语句。
语句末尾的分号可选。

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
| `scale` | 枚举，取值见下 | `"major"` |
| `swing` | 0~1 | 0 |

**scale 取值（14 个）**：
`major` `minor` `harmonic_minor` `melodic_minor` `dorian` `phrygian` `lydian`
`mixolydian` `locrian` `major_pentatonic` `minor_pentatonic` `blues` `chromatic` `whole_tone`

> **`key` 与 `scale` 只做格式校验，调度与合成都不读它们。** 写 `key: "Cm"` 不会转调，
> 也不会滤掉音阶外的音。

**swing 的位移**：落在十六分网格奇数步的音往后推 1/3 个十六分，`step % 4 === 2`
（后半拍八分）往后推 2/3 个十六分，位移量再乘以 `swing`。

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
| `envelope` / `env` / `amp_envelope` | 振幅包络字符串，写法见第 7 节 | `adsr(0.01, 0.1, 0.7, 0.2)` |
| `filter` | 滤波器字符串，写法见第 8 节 | 无 |
| `filter_envelope` | 滤波包络（同包络写法） | 无 |
| `filter_env_amount` | 滤波包络调制深度（Hz） | 0 |
| `lfo` | 低频调制字符串，写法见第 9 节 | 无 |
| `gain` | 乐器基线音量 | 0.8 |
| `pan` | -1 全左 ~ 1 全右 | 0 |
| `fm_wave` | 只能是 `sine` `square` `sawtooth` `triangle`（写噪声名报错） | 无 |
| `fm_index` | 调制深度（Hz），不是调制指数 | 无（缺省或 0 = FM 关闭） |
| `fm_ratio` | 倍频比，**必须 > 0**（≤0 报错） | 无 |
| `detune` | 音分 | 0 |
| `glide` | 起音滑音时长（秒），不能为负 | 0 |
| `glide_from` | 滑音起始偏移（半音） | -12 |
| `pitch_env_amount` | 音高包络深度（半音），**正值是先高后低** | 0 |
| `pitch_decay` | 音高包络衰减时长（秒），不能为负 | 0.05 |
| `spread` | 立体声展开宽度 0~1 | 0 |
| `velocity_sensitivity` | 力度对音量的影响程度 | 0.7 |
| `velocity_to_filter` | 力度对滤波截止的影响（Hz） | 0 |
| `voices` | 每音符叠加几个失谐振荡器，截断到 1~7 | 1 |
| `unison_spread` | 声部间失谐（音分） | 12 |
| `harmonics` | 谐波振幅数组，如 `[1, 0.5, 0.33, 0.25]`，不能为空 | 无 |
| `attack_noise` | 起音噪声爆发量，截断到 0~1 | 0 |
| `loop_point` | 重起音点（秒），不能为负 | 0 |
| `effect_chain` | 乐器级效果链（写成 `effect_chain { … }` 嵌套块） | 无 |

**互斥与必填约束（违反即报错）**：

- `wave: "custom"` **必须**同时有 `harmonics`（可以来自 preset 基线）。
- 噪声波形（`white_noise` / `pink_noise` / `brown_noise`）**不能**与 `harmonics` 同用。
- `fm_ratio` 必须 > 0。

**`pitch_env_amount` 的方向**：振荡器从 `freq * 2^(amount / 12)` 起振（即**高于**写的音高），
在 `max(0.005, pitch_decay)` 秒内指数回落到 `freq`。正值 = 先高后低。

**`loop_point` 的重起音段长**：当 `loop_point > 0` 且 `noteDur > loop_point * 1.5` 时，音符被切成
`floor(noteDur / loop_point)` 段等长片段，每段重新起音，段长为 `noteDur / segments`
（不等于 `loop_point`）。该模式只在 `sustain < 1` 时起作用。

### 3.2 预设（51 个）

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

预设名大小写不敏感。未知预设名报错并列出全部可用值。

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
- 一个音序内的指令**严格串行**：每条从上一条的结束时刻接着排，不存在同时发声；
  跨音序的对齐靠 `mix` 的 `time`。
- 全部音序都没定义乐器时，引擎会补一个 `default`（正弦，gain 0.5）。

### 4.1 七条指令

| 指令 | 参数 | 说明 |
|---|---|---|
| `note(音名, 时值)` | 具名写法 `pitch` / `note` / `n`，`duration` / `dur` / `len` / `d` | 单音。和弦符号要改用 `chord()` |
| `chord(和弦, 时值, …)` | `strum` `voicing` `octave` `pitches`/`chord`/`notes` `duration`/`dur` | 第一个参数可以是和弦符号或音高数组 |
| `arp(和弦, …)` | `pattern` `rate` `duration` `octaves` `gate` `voicing` `octave` `chord`/`notes`/`pitches` | 琶音 |
| `progression(和弦数组, 时值, …)` | `chords`/`chord` `beats`/`beat` `voicing` `octave` `octaves` `pattern` `strum` `gate` | 和声进行 |
| `run(音高数组, 速率, …)` | `notes`/`pitches` `rate`/`step` `direction`/`pattern` `repeat`/`times` `gate` | 音型跑动 |
| `hit(鼓组名, 时值, …)` | `drum`/`name` `duration`/`dur`/`len` `tune` `decay` `tone` `snap` | 打击乐，不需要乐器 |
| `rest(时值)` | `duration`/`dur`/`len` | 休止。**不接受逐音符表现力参数** |

未知指令报错并列出可用清单。指令名大小写不敏感。

### 4.2 逐音符表现力参数

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
**写别的词（如 `accent=maybe`）会报错**，不会静默当 false。

枚举取值一律大小写不敏感：指令名、滤波器类型、`voicing`、`pattern`、`scale`、`target` 等，
比对时都做 `toLowerCase()`。

**`octave` 在 `chord` 里是声位寄存器**：`chord("Am7","1n", octave=3)` 的 `octave` 是
「和弦发在第几八度」，不再当成移调参数解释。

### 4.3 chord

```
chord(和弦或音高数组, 时值, strum=0, voicing="close", octave=4)
```

- `voicing`：`close` 密集（默认）| `open` 第二音升八度 | `drop2` 倒数第二音降八度 | `spread` 相邻音交替升八度
- `octave`：默认 4
- `strum`：0~1，各声部依次进入，每个声部偏移 `strum * 0.055` 秒
- **`chord` 接受 `gate`**，且**时间轴只按 `duration` 前进**，`strum` 的错位不推移后续指令。

#### 4.3.1 和弦符号

`chord` / `arp` / `progression` 的第一个参数（或数组元素）可以是和弦符号：
`根音 + 性质 + 可选斜杠低音`，如 `C` `Am7` `Fmaj9` `G7/B` `C#m7b5`。

根音是 `A`~`G` 加任意个变音记号（`#` `♯` `b` `♭`），如 `Bb` `F#` `Ebb`。

性质白名单（单字母 `m`/`M` 区分小七与大七）：

```
（空） maj M major m min minor - dim o aug + 5
sus sus4 sus2 7sus4 7sus2 9sus4 maj7sus4 m7sus4 13sus4
6 m6 min6
7 dom7 maj7 M7 Δ7 m7 min7 -7 m7b5 min7b5 ø ø7 dim7 o7 mM7 mMaj7 minMaj7 mM9 aug7 +7 augM7
add9 add2 madd9 add11 add4 add6 madd6
9 dom9 maj9 M9 m9 min9 6/9 69 m6/9
11 maj11 m11 13 maj13 m13
```

`maj` / `min` / `dim` / `aug` / `sus` / `add` 这几个前缀大小写不敏感（`MAJ7` = `maj7`）。
白名单外的组合按 `基础三和弦 + 扩展音 + 变化音` 依次解析：
扩展音 `2` `6` `7` `9` `11` `13`（`11` 与 `13` 隐含 `9`，`9`/`11`/`13` 隐含七度），
变化音 `b5` `#5` `b9` `#9` `#11` `b11` `b13`，省略音 `no3`/`omit3`、`no5`/`omit5`。
两者都识别不了就报错，不会静默给一个错的和声。

斜杠低音在根音下方一个八度内补一个低音声部（`C/E` 仍是完整 C 和弦的转位，不是替换）。
展开后 `drop2` / `spread` 可能产生同音，重音会被去掉。

### 4.4 arp

```
arp(和弦或音高数组, pattern="up", rate="16n", duration="1n", octaves=1, gate=0.9)
```

- `pattern`：`up` | `down` | `upDown` | `downUp` | `asPlayed` | `random`
- `rate` 默认 `16n`；`duration` 是琶音**总时长**，必填
- `octaves` 截断到 1~4；`gate` 默认 0.9
- **`up` / `down` 按音高排序，不是书写顺序**；只有 `asPlayed` 与 `random` 保留书写顺序。
- 步数 = `floor(duration / rate)`，下标**对 `order.length` 取模回绕**。
  四音池的 `upDown` 是 6 步（0-1-2-3-2-1）。
- `upDown` / `downUp` 在 `len <= 2` 时退化为单程。
- **`arp` 接受具名音高来源**：`arp(chord=[...])`，也可写 `notes=` / `pitches=`。
  具名来源优先于位置参数，且一旦给出，位置参数就整体让位给 `pattern` / `rate` / `duration`
  （从下标 0 开始读）。所以 `arp(chord=["C4"], "up", "16n", "1n")` 不会把 `"up"` 当成和弦符号。

### 4.5 progression

```
progression(["Am7","Dm7","G7","Cmaj7"], "1n", voicing="drop2", pattern="asPlayed")
progression(["Am7","Dm7","G7","Cmaj7"], ["1n","1n","1n","2n"])
```

- 时值参数叫 **`beats`**（别名 `beat`），没有 `duration`。
- 时值可以是单个记号（每个和弦等长），也可以是与和弦数等长的数组；
  数组长度与和弦数不一致会报错。
- `pattern` 默认 `asPlayed`（齐奏）；改成 `up` / `down` 等就按琶音方式把和弦音依次奏出。
  `octaves` 1~4 跨八度扩展。**`progression` 的步长与 `arp` 不同**：`arp` 的步长是 `rate`、
  步数是 `floor(duration / rate)`；`progression` 则把**每个和弦自己的时值**平分成
  `order.length` 步（`stepDur = dur / order.length`），所以这里没有 `rate` 参数。
- 和弦数组里可以混写具体音高数组。

### 4.6 run

```
run(["C4","D4","E4","G4"], "16n", direction="up", repeat=1, gate=1)
```

- `direction`：`up` 原序 | `down` 反转数组 | `updown` 往返。也接受 `pattern` 这个名字。
- `down` 反转数组，所以要输出下行线条，数组要按上行写。
- `updown` 在长度 > 2 时是 `原序 + 中间段反转`（首尾不重复）。
- `repeat` ≥ 1；`gate` 默认 1。

### 4.7 hit

```
hit("kick", "4n", tune=0, decay=1, tone=0, snap=0)
```

- 鼓组名可位置传，也可用 `drum=` / `name=`。不提供 `kit=`（那指整套鼓，这里要的是单件）。
- 时值默认 `8n`。
- `tune` 半音微调 | `decay` 衰减倍数（必须 > 0，下限 0.05）| `tone` 噪声中心频率偏移（Hz）| `snap` 0~1 起音冲击
- 音符时值短于音色自然衰减时会被 gate 截断。

### 4.8 鼓组（16 个）

```
kick  sub_kick  snare  rim  clap  hat  open_hat  pedal_hat
tom_low  tom_mid  tom_high  crash  ride  cowbell  shaker  tambourine
```

**鼓组事件不经过乐器的滤波 / LFO / gain / pan 链路**，只认逐音符的 `velocity` / `pan`
与 mix 轨道的 `pan`。

---

## 5. 音名与频率

音高可以写成音名，也可以直接写频率：

| 写法 | 含义 |
|---|---|
| `C4` `F#5` `Bb3` `C#4` | 字母 `A`~`G`（大小写均可）+ 最多 3 个变音记号 + 八度数字，八度可为负（`C-1`） |
| `440hz` | 频率（Hz，`hz` 大小写不敏感），内部换算成音高号 |

变音记号：`#` 与 `♯` 升半音，`b` 与 `♭` 降半音。`C4` 是中央 C。
无法识别的音名报错，不会静默当成 0。

---

## 6. 时值写法

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
`1m` 恒为 4 拍，与 tempo 无关。一拍秒数 = `60 / tempo`。

---

## 7. 包络

```
adsr(a, d, s, r)      ad(a, d)      ar(a, r)      perc(a, d, r)
```

- 参数可位置传，也可用具名：`a`/`attack`、`d`/`decay`、`s`/`sustain`、`r`/`release`。
- 附加具名参数：`curve=linear|exp|hold`（默认 `exp`）、`delay=秒`（默认 0）。
- `adsr` 的 `s` 是 0~1 的电平比例，不是秒。
- 负值报错。
- `ad` 的 release 取 decay 的一半；`ar` 的 sustain 固定为 1；`perc` 的 sustain 固定为 0。

各形态的默认值：

| 形态 | 默认 |
|---|---|
| `adsr` | a=0.01, d=0.1, s=0.7, r=0.2 |
| `ad` | a=0.01, d=0.3, s=0, r=0.15（= d/2） |
| `ar` | a=0.05, d=0.01, s=1, r=0.4 |
| `perc` | a=0.001, d=0.3, s=0, r=0.15 |

值加引号或裸写都认：

```
envelope: "adsr(0.01, 0.3, 0.5, 0.4)"
envelope: "perc(0.001, 0.25, 0.1)"
envelope: "adsr(1.5, 1.0, 0.8, 2.5, curve=linear)"
```

> **A + D 超过音符时值会被按比例压缩**（振幅包络与滤波包络都是）。滤波包络的峰值是
> `基础频率 + amount`，持续电平是 `基础频率 + amount * sustain`。

---

## 8. 滤波器

```
lowpass(freq, Q)   highpass(freq, Q)   bandpass(freq, Q)   notch
lowshelf   highshelf   peaking   allpass
```

- 类型枚举：`lowpass` `highpass` `bandpass` `notch` `lowshelf` `highshelf` `peaking` `allpass`
- 位置参数依次是 `(freq, Q, gain, sweep_to)`，也可以用具名 `freq`/`frequency`、`q`、`gain`、`sweep`/`sweep_to`
- `sweep` / `sweep_to=目标频率`：在音符时值内自动扫频
- `freq` 必须 > 0（默认 1000）；`Q` 不能为负（默认 1，合成时截断到 0~30）
- `gain` 用于 shelf / peaking

```
filter: "lowpass(800, 2)"
filter: "bandpass(1200, 1.5, sweep_to=6000)"
```

---

## 9. LFO

```
波形(freq=速率Hz, amount=深度, target=目标, ramp=淡入秒, swell=true)
```

- `freq` 默认 5，必须 > 0
- `amount` 默认 10，量纲随 `target` 变化
- `target` 默认 `frequency`
- `ramp` 默认 0（秒）
- `swell` 默认 false（布尔值写法同第 4.2 节）

波形只能是 `sine` | `square` | `sawtooth` | `triangle`。
`target`：`frequency` | `filter` | `gain` | `pan` | `detune`。

| target | `amount` 单位 | 截断范围 |
|---|---|---|
| `frequency` / `detune` | **音分**（挂到振荡器的 detune） | ±1200 |
| `filter` | Hz | 0~12000 |
| `gain` | 深度比例，再乘声部增益 | 0~1 |
| `pan` | 声像 | 0~1 |

`ramp` 让调制逐渐进入：起点是 0，在 `ramp` 秒内线性升到完整深度。
`swell=true` 让调制深度线性升到 `peakAmount * 2.2`，终点在
`t + max(0.05, 音符时值, ramp)`。

```
lfo: "sine(freq=5.5, amount=10, target=frequency, ramp=0.6)"
```

---

## 10. 效果链与效果器

`effect_chain` 可放顶层（作用于全部声音），也可放进 `define_instrument` 里（只作用于该乐器）。
顶层写多个 `effect_chain` 块会按书写顺序拼成一条链，**书写顺序即信号流顺序**。

### 10.1 十三个效果器

| 效果器 | 参数（含默认值） |
|---|---|
| `delay` / `pingpong` | `time`=0.3（**时值参数**，可写 `"8n."`）`feedback`=0.3 `mix`=0.4 `damping`=2000 `pingpong`=false |
| `reverb` | `decay`=2.0（截断到 0.05~12）`mix`=0.3 `predelay`/`pre_delay`=0.01 `damping`=5000 |
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

**`filter` 效果器的 `start` 是扫频起始时刻（秒）**，起始频率写 `from`。
写 `start=200` 不报错，但那个数字被当成时间读。

**`delay` / `pingpong` 的 `time` 是时值参数**，所以 `time="8n."` 合法且随 tempo 变化；
64 BPM 下 `8n.` = 0.703s。`pingpong` 的右声道延迟是 `time * 1.5`。

**`eq` 的三段固定**：低架 250Hz / 峰值 1200Hz Q0.9 / 高架 4000Hz，每段截断到 ±24dB。

### 10.2 同义参数名

```
delay→time      fb→feedback     tone→damping    ping_pong→pingpong
size→decay      drive→amount    gain→amount     depth→bits
speed→rate      bass→low        treble→high     end→to
dur→duration    at→start        from→min        to→max
```

别名与规范名等价。`filter` 没有 `start: 'from'` 这条别名（`start` 是扫频起始时刻）。

---

## 11. mix（编排）

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
| `stagger` | 每次循环的错位增量（秒） | 0 |

### 11.1 loop 的语义

`loop` 从上一遍的**终点**接着再演一遍，不是每遍都从 `time` 重来；`stagger` 在这个终点上
再加一个错位增量。`loop` 只有连续续接这一种行为，间隔重复要用多条 `track` 各写自己的 `time`。

多条 track 可以引用同一个 `source`。不写 `mix` 时，所有音序按定义顺序**首尾相接**（一个游标），
不是全部从 0 叠加。

### 11.2 写了 mix 之后的静默失效

写了 `mix` 之后，没有被任何 track 引用的音序不会发声，只给一条警告
`以下音序没有被 mix 引用，不会发声：…`，编译仍然通过。

---

## 12. 音量、力度与人性化

### 12.1 增益相乘

```
gain = clamp(baseGain * velScale * seqGain * trackGain * jitterGain, 0, 2, 0.8)
输出 = gain * config.master_gain
velScale = clamp((1 - sens) + sens * (velocity / 0.8), 0, 1.6, 1)
```

- `baseGain`：逐音符 `gain`，否则乐器 `gain`（默认 0.8）。
  **鼓组例外**：`baseGain = expr.gain ?? 1`，不沿用当前乐器的 gain（声像同理）。
- `sens` = `velocity_sensitivity`（默认 0.7）。**`velocity = 0.8` 正好是 1.0 倍**。
- `velocity` 超过 1.0 会被截断。

### 12.2 人性化抖动

`humanize` 产生可复现的随机抖动：音高 ±12 音分、力度 ±12%、时间 ±0.012s，
全部按 `humanize` 值缩放。种子 = `hash(音序名 : 起始时刻 : 轨道下标/循环下标)`，
同一份代码每次渲染结果一致。

### 12.3 力度对滤波

`velocity_to_filter` 让滤波截止随力度变化：`滤波截止 + (velocity - 0.8) * velocity_to_filter`，
结果截断到 20~20000Hz。


---
name: spg-coding
description: Applies to this project only (the-play). Read when writing, editing or reviewing SPG audio scripts under `.spg/`: how to check constructs against the sole authority `app/renderer/services/AudioService.ts`, the five block types and all parameter whitelists, the duration and gain formulas, a list of "it parses but does not sound like you think" traps, structural discipline for time-based artwork, comment discipline, and naming.
whenToUse: When generating, modifying or reviewing a the-play SPG script (`.txt` / `.spg` under `.spg/`); when determining what a given SPG construct actually sounds like; or when naming such a work.
---

# SPG coding

> **There is exactly one authority: `app/renderer/services/AudioService.ts`.**
> The parser `SPGParser`, the scheduler `EventScheduler` and the synthesizer `AudioSynthesizer` all live
> inside it (~5400 lines; the exact count drifts because the file is edited concurrently outside the
> session). Note the path: it is **not** `services/AudioService.ts` — that path does not exist, and
> grepping it fails with `os error 3`. When in doubt, `glob "**/AudioService.ts"` first.
>
> The SPG system prompt lives in `app/renderer/services/SpgAiService.ts` (`SPG_SYSTEM_PROMPT`, around
> line 92). It is documentation for the same language but **may lag the implementation** — on conflict,
> the implementation wins.
>
> The parser's guiding principle is "**rather raise an error than silently ignore**": unknown parameters,
> illegal durations and illegal enums all throw `SPGError` with a line number.
> So a misspelled parameter name fails immediately, while a **semantically wrong construct does not** —
> the list in section 3 exists specifically for the latter.

---

## 1. How to use the implementation as the authority

### 1.1 Source priority

| Priority | Source | Use it for |
|---|---|---|
| 1 | The implementation code in `app/renderer/services/AudioService.ts` | Parameter whitelists, value ranges, defaults, branch conditions |
| 2 | The prompt in `app/renderer/services/SpgAiService.ts` | Intent and recommended usage |
| 3 | Your experience with generic DSLs / synthesizers / audio formats | **Only to generate search keywords** — never as grounds for writing something |

Priority 3 is the most dangerous: SPG looks like a generic format, so experience produces a
"looks right" spelling. Classic case: the `filter` effect's `start` means "at which second the sweep
begins"; the starting frequency is called `from`. Writing `start=<frequency>` on intuition raises no
error — the number is simply read as a time, and the meaning changes completely.

**Rule: every construct you put into the file must have the exact line that consumes it located in the
implementation.** If you cannot find a consumer, the field is "parsed but never read"; either do not use
it, or state in a comment that it is format-checked only and does not affect the sound.

### 1.2 Read the whitelist, do not induce it from examples

The implementation contains several parameter whitelist tables and `rejectUnknownParams`-style
validation functions. **Reading the whitelist table itself** is faster and more accurate than inducing
rules from examples — examples may use aliases, or may themselves be out of date.

```
grep -n "PARAMS\s*[:=]|_NAMES\s*[:=]|rejectUnknownParams" app/renderer/services/AudioService.ts
```

### 1.3 The alias tables are the list of traps

The `*_ALIASES` tables in the implementation record exactly the spellings that are written wrongly most
often and therefore tolerated. Reading them once tells you which names are ambiguous.
Conversely: **the existence of an alias does not make it recommended** — write the canonical name and
treat aliases as compatibility only.

---

## 2. Language reference

### 2.1 The five block types

| Block | Count limit | Purpose |
|---|---|---|
| `config { }` | at most 1 | tempo / master_gain / key / scale / swing |
| `define_instrument(name="…") { }` | many | instrument definition |
| `sequence(name="…", instrument="…") { }` | many | note sequence |
| `effect_chain { }` | repeatable at top level, at most 1 per instrument | effect chain; order = signal flow order |
| `mix { track(...) }` | at most 1 | arrangement; once written, unreferenced sequences produce no sound |

Blocks may appear in any order. Comments use `#` or `//` and are stripped per line (quote-aware).

### 2.2 config

| Parameter | Constraint |
|---|---|
| `tempo` / `bpm` | > 0, ≤ 1000 |
| `master_gain` / `gain` | ≥ 0, ≤ 2 |
| `key` | regex `/^[A-Ga-g][#b♯♭]?m?$/`, e.g. `"Cm"`, `"F#"` |
| `scale` | enum: major / minor / harmonic_minor / melodic_minor / dorian / phrygian / lydian / mixolydian / locrian / major_pentatonic / minor_pentatonic / blues / chromatic / whole_tone |
| `swing` | 0~1 |

**`key` and `scale` are format-checked only; neither scheduling nor synthesis reads them.** Writing
`key: "Cm"` does not transpose anything and does not filter out notes outside the scale. To make a script
sound like a given key you must write the pitches correctly yourself.

`swing` pushes notes landing on the 2nd sixteenth-grid slot to 1/3 of a beat, and the 4th (i.e. the
off-beat eighth) to 2/3 of a beat. `8n` notation lands on even steps, so **quarter- and eighth-note
melodies are essentially unaffected**; it mainly acts on arpeggios alternating sixteenths and eighths.

### 2.3 Duration notation (`parseDuration`)

| Spelling | Meaning |
|---|---|
| `4n` / `8n` / `16n` / `32n` | 1/N of a whole note; whole note = 4 beats |
| `4n.` | dotted, ×1.5 |
| `4n..` | double-dotted, ×1.75 (not 1.5×1.5) |
| `4nt` | triplet, ×2/3 |
| `1m` | 1 measure = 4 beats |
| `250ms` / `1.5s` | absolute time |
| `250` (bare number) | **interpreted as seconds**, not beats |
| `4x` | **error**. A bare number must be numeric in full |

`1m` is always 4 beats (assumed 4/4), independent of tempo. The measure regex is `^([\d.]+)m$`, so any
number of measures works: `2m` = 8 beats, `3m` = 12 beats (verified). Dots and triplets are counted by a
loop, so `2n.` = 3 beats, `8n.` = 0.75 beat.

### 2.4 Pitches and chords

- A pitch name must carry an octave: `"C4"`, `"F#5"`, `"Bb3"`; frequency notation `"440hz"` is also accepted.
- C4 = MIDI 60, A4 = 440Hz.
- The first positional argument of `chord()` / `arp()` / `progression()` may be either an array of pitches
  or a **chord symbol string** (`"Am7"`, `"Cmaj9"`, `"G7/B"`).
- `note("Am7", "2n")` raises an error telling you to use `chord()` instead — a deliberate, actionable error.
- `chord`'s `octave` (default 4) is a **voicing register**, unlike `note`'s `octave`
  (raise by N octaves). The implementation marks it reserved so it is not applied twice.

### 2.5 Instrument parameter whitelist

```
preset, wave, envelope, env, amp_envelope, filter, filter_envelope, filter_env_amount,
lfo, pan, gain, fm_wave, fm_index, fm_ratio, detune, glide, glide_from,
pitch_env_amount, pitch_decay, spread, velocity_sensitivity, velocity_to_filter,
voices, unison_spread, harmonics, attack_noise, loop_point, effect_chain
```

- `preset` is the baseline; every other field overrides it item by item. Available presets include
  `piano`, `electric_piano`, `bell`, `marimba`, `music_box`, `glass`, `strings_section`, `cello`,
  `flute`, `supersaw`, `synth_pad`, `warm_pad`, `timpani` and 55 in total.
- `wave`: `sine | square | sawtooth | triangle | white_noise | pink_noise | brown_noise | custom`.
  `custom` **requires** `harmonics`; noise waveforms **must not** have `harmonics` (both raise errors).
- `voices` is clamped to 1~7; `attack_noise` clamped to 0~1; `gain` defaults to 0.8.
- `velocity_sensitivity` defaults to 0.7; `velocity_to_filter` defaults to 0.
- `fm_wave` may only be `sine | square | sawtooth | triangle` (noise names raise an error).
- `fm_ratio` **must be > 0**; when `fm_index` is 0 or missing, FM is silently off.
- `glide` / `pitch_decay` / `loop_point` do not accept negative values.

**`pitch_env_amount` direction (verified in the implementation):** the oscillator starts at
`freq * 2^(amount / 12)` — that is, *above* the written pitch — and exponentially ramps **down** to
`freq` over `pitch_decay` seconds (`Math.max(0.005, pitchDecay)`). So a positive amount is a downward
pitch drop, which is what makes a timpani or kick sound like a struck drum head losing tension. A comment
claiming "the pitch falls" is correct; a comment claiming it rises is a direction-type defect.

**`loop_point` re-attack (verified):** with `loopPoint > 0 && noteDur > loopPoint * 1.5` the note is cut
into `segments = floor(noteDur / loopPoint)` equal pieces of `segDur = noteDur / segments`, each
re-attacking. **The segment length is `segDur`, not `loopPoint`.** Worked example: a `1n` note at 64 BPM
is 3.75s, `loop_point: 1.8` gives `segments = floor(3.75 / 1.8) = 2`, so each segment is 1.875s — a
comment saying "re-attacks every 1.8s" is off by ~4%. This mode is only audible when `sustain < 1`:
at `sustain = 1.0` "decay to sustain" means staying put, so re-attacking changes nothing.

### 2.6 Envelopes

`adsr(a, d, s, r)` / `ad(a, d)` / `ar(a, r)` / `perc(a, d, r)`, optionally with
`curve=linear|exp|hold` (default `exp`) and `delay=seconds`.
`adsr`'s `s` is a 0~1 **level ratio**, not seconds. Arguments may be quoted or bare.
Negative values raise an error; `sustain > 1` is clamped to 1.

**`applyAdsr` compresses both `a` and `d` by `noteDur / (a + d)` when `a + d > note duration`** —
the seconds you write are not the seconds you hear; see 6.2.

### 2.7 Filters

`lowpass | highpass | bandpass | notch | lowshelf | highshelf | peaking | allpass`,
positional arguments `(freq, Q)`, plus optional `gain` (for shelves/peaking) and `sweep` / `sweep_to`.
`freq > 0`, `Q ≥ 0` (the implementation clamps to 0~30).

### 2.8 LFO

`waveform(freq=, amount=, target=, ramp=, swell=true)`, where the waveform is one of the four oscillator
shapes. `target`: `frequency | filter | gain | pan | detune`. `freq > 0`.

**The unit of `amount` depends on `target`:**

| target | Unit | Clamp |
|---|---|---|
| `frequency` / `detune` | **cents** (actually wired to detune, so the effect is consistent across pitches) | ±1200 |
| `filter` | Hz | 0~12000 |
| `gain` | depth ratio 0~1 | 0~1 |
| `pan` | -1~1 | 0~1 |

`swell=true` ramps the depth linearly up to `peakAmount * 2.2`, with the endpoint at
`t + max(0.05, note duration, ramp)` (keeping automation times monotonic).

### 2.9 Effects (13 kinds)

```
delay, pingpong, reverb, distortion, bitcrush, overdrive, filter, eq, chorus,
flanger, phaser, tremolo, compressor
```

| Effect | Parameters |
|---|---|
| `delay` / `pingpong` | time, feedback, mix, damping, pingpong |
| `reverb` | decay, mix, predelay, pre_delay, damping |
| `distortion` / `overdrive` | amount, mix |
| `bitcrush` | bits (1~16), mix |
| `chorus` | rate, depth, mix |
| `flanger` | rate, feedback, mix |
| `phaser` | rate, min, max, mix |
| `tremolo` | rate, depth |
| `filter` | kind, from, to, q, duration, **start** |
| `eq` | low, mid, high |
| `compressor` | threshold, ratio, attack, release |

- `eq` is implemented as lowshelf at 250Hz / peaking at 1200Hz Q0.9 / highshelf at 4000Hz, each clamped
  to ±24dB. **Quote 250Hz, not 200Hz**, when describing the low band in a comment.
- **The `filter` effect's `start` is "at which second the sweep begins"; the starting frequency must be
  written as `from`.** This is the single easiest thing to get wrong: intuition reads `start` as the
  starting frequency, no error is raised, and the meaning is entirely different.
- `delay` / `pingpong` `time` is parsed as a **duration argument with tempo** (`durArg(['time'], 0, '0.3')`),
  so `time="8n."` is legal and tempo-relative. At 64 BPM, `8n.` = 0.75 beat × 0.9375s = 0.703s.
  For `pingpong` the right channel delay is `time * 1.5`.
- Synonym aliases (they compile but emit a warning): `delay→time`, `fb→feedback`, `tone→damping`,
  `size→decay`, `drive`/`gain→amount`, `depth→bits`, `speed→rate`,
  `ping_pong→pingpong`, `end→to`, `dur→duration`, `at→start`, `bass→low`, `treble→high`.
  Write the canonical name; treat aliases as compatibility only.

### 2.10 Sequence commands

Block-header parameters: `name | seq | id`, `instrument | inst`, `gain`, `transpose`, `humanize`.

Per-note parameters (`NOTE_EXPR_PARAMS`):
`velocity, vel, pan, gain, gate, transpose, glide, detune, humanize, human, octave, accent`

- `accent=true` is shorthand for `velocity=1`; `hit()` honours it too.
- `gate` is a duration multiplier: `gate=1.06` lets a note run slightly past the next command's start,
  useful for implying pedal overlap.
- **Commands are strictly serial**: each one pushes the timeline forward by its own duration.
  **There is no way to sound two notes simultaneously** — for that you must use `chord()`.
  This is what makes "the bell and the scrape" sequential rather than layered.

| Command | Parameters |
|---|---|
| `note(pitch, duration)` | — |
| `chord(array or symbol, duration, strum=, voicing=, octave=, duration=)` | `strum` 0~1, each voice offset by `strum * 0.055` seconds; `voicing`: close/open/drop2/spread |
| `arp(array or symbol, pattern=, rate=, duration=, octaves=, gate=)` | `pattern`: up/down/upDown/downUp/asPlayed/random; `rate` defaults to `16n`; `octaves` 1~4; `gate` defaults to 0.9 |
| `progression(chords=, beats=, …)` | `beats` is a duration parameter. **There is no `duration`** — writing it raises an error |
| `run(array, rate, direction=, repeat=, gate=)` | `direction`: up/down/updown |
| `hit(drum name, duration, tune=, decay=, tone=, snap=, duration=)` | `decay` must be > 0; `snap` 0~1 |
| `rest(duration)` | also accepts `dur` / `len` |

Two parsing facts verified in the implementation:

- **`chord` accepts `gate`** like any other note expression (it is merged in via `NOTE_EXPR_PARAMS`), and
  `chord` advances the timeline by `duration` only — the `strum` offsets do not shift subsequent commands.
  So a sustained final chord can be written `chord([...], "1n", strum=0.3, gate=1.5)` and it will ring
  1.5× its written length into the reverb tail.
- **`arp` accepts a named pitch source**: `arp(chord=[...])`, also `notes=` / `pitches=`. A named source
  takes priority over the positional argument, and when it is present the positional arguments are
  re-read as `pattern` / `rate` / `duration` starting from index 0. This exists so that
  `arp(chord=["C4"], "up", "16n", "1n")` does not try to parse `"up"` as a chord symbol.

### 2.11 The ordering traps in `arp` and `run`

- `arp`'s `up` / `down` order by **pitch**, not by written order; only `asPlayed` and `random` preserve
  written order. Sorting by index directly would make `["C3","G3","Eb3"]` come out as something that is
  not an ascending arpeggio at all.
- `arp`'s step count is `floor(duration / rate)`, and the index **wraps modulo `order.length`**.
  A 4-note pool's `upDown` is 6 steps (0-1-2-3-2-1), so pairing it with 8 eighth notes wraps back to the
  first two notes of the pool — a wave-shaped contour, not a clean repeat.
- **`run`'s `direction="down"` reverses the array.** To make the pitches descend, the array must be
  written **ascending**. Writing a descending array and passing `down` yields an ascending line — the
  exact opposite of the intent, with no error.
- `run`'s `updown` for arrays longer than 2 is `concat(slice(1,-1).reverse())`.

**Any parameter that "reorders the input by semantics" must be read in those exact lines; never guess.**
Comments are extremely easy to get backwards here.

### 2.12 Drum kit

Available names (`DRUM_NAMES`, derived from `DRUM_SPECS`):
`kick, sub_kick, snare, rim, clap, hat, open_hat, pedal_hat, tom_low, tom_mid,
tom_high, crash, ride, cowbell, shaker, tambourine`

- `hit()` **needs no instrument**. When a block contains only `hit`, the parser does not require an
  instrument to exist.
- Drum events **do not pass through the instrument's filter / LFO / gain / pan chain**; they carry their
  own `DRUM_SPECS` calibration (kick gain 1.0, hat 0.45, shaker 0.4…). They honour only per-note
  `velocity` / `pan` and the mix track's `pan`. Writing `instrument` on a pure drum sequence does not
  change the timbre.
- Tuning parameters and units: `tune` in semitones, `decay` a multiplier (floor 0.05), `tone` a Hz offset
  of the noise centre frequency, `snap` 0~1 transient. When the note duration is shorter than the
  timbre's natural decay it is truncated by the gate (useful to choke an open hat).
- Amplitude formula: `clamp(spec.gain * (0.45 + velocity * 0.7), 0, 2, 0.8)`.

### 2.13 Volume and velocity: three levels multiplied

```
gain = clamp(baseGain * velScale * seqGain * trackGain * jitterGain, 0, 2, 0.8)
```

- `baseGain` = the per-note `gain`, otherwise the instrument `gain` (default 0.8).
- `velScale = clamp((1 - sens) + sens * (velocity / 0.8), 0, 1.6, 1)`, where `sens` is
  `velocity_sensitivity` (default 0.7).
  **`velocity = 0.8` is exactly a 1.0 multiplier**; with `sens=0.85`, `velocity=0.4` yields only 0.58×.
- So writing `velocity` at the full 1.0 hits the clamp ceiling; **leaving headroom** (0.3~0.9) is better.
- The three gain levels (instrument × sequence × track) are multiplied, then multiplied by
  `config.master_gain`.
- `humanize` produces ±12 cents, ±12% velocity and ±2% duration of reproducible jitter (the seed includes
  the sequence name, the start time and the loop index).
- `velocity_to_filter` makes hard playing brighter: `filter.frequency + (velocity - 0.8) * vtF`.

### 2.14 The real semantics of `mix` and loop

`track(source=, time=, loop=, gain=, pan=, stagger=)`, aliases `seq`/`track`, `at`, `repeat`/`times`.

**`loop` means "play it again": pass n continues from the previous pass's END, not from `time` again.**

```
currentStart = time
for i in 0..loop-1:  duration = play(source, currentStart);  currentStart += duration + stagger
```

Consequences:

- A 4-measure sequence with `loop=3` covers exactly 12 measures, with neither overlap nor gap.
- To make a part "come back every 8 measures", **`loop` cannot do it**; use several `track` entries with
  their own `time` instead.
- `stagger` offsets each repetition so they overlap (usable for a canon), but it also makes that part
  longer than the others by `stagger`.
- **Once `mix` is written, any sequence not referenced by a `track` produces no sound**; the parser only
  emits a warning. Both sides must be kept in sync when editing.
- **Without `mix`, all sequences are concatenated head to tail** in definition order (a running cursor),
  not layered from 0. This is commonly mistaken for "playing simultaneously".
- `loop` **defaults to 1** when omitted, so a single `track` needs no `loop` at all.
- Several tracks may reference the same `source` — `mix` is a plain list, and each entry is scheduled
  independently. That is the correct way to restate the same material at a later point in the timeline.

### 2.15 Export length

```
totalDuration + tailRoom
tailRoom = effects.length > 0 ? min(max(3.0, longest reverb decay), 12) : 0.5
```

Reverb `decay` is clamped to 0.05~12 seconds. The offline render total is capped at 900 seconds.

Worked example: 16 measures at 64 BPM = 60s, with a global chain present and `decay=6.5` gives
`tailRoom = min(max(3, 6.5), 12) = 6.5`, so the rendered length is about 66.5s. A header comment claiming
"4 rounds ≈ 64s" for 16 measures at 64 BPM is a numeric defect — the correct figure is 60s.

---

## 3. The "parses fine but does not do what you think" list

The parser only stops syntax, not semantics. Confirm each item before writing a script:

1. **`fm_index` is not the textbook modulation index** — it is a Hz frequency deviation added directly to
   the carrier frequency (`fmGain.gain = fm_index`), decaying to 8% over time. The `bell` preset uses
   420, `piano` uses 180.
2. **The `filter` effect's `start` is the sweep start time**; the starting frequency goes in `from`.
3. **`progression` has no `duration`**; the duration parameter is called `beats`.
4. **`run`'s `direction="down"` reverses the array**, so descending output requires ascending input.
5. **`arp`'s up/down order by pitch**; only `asPlayed` preserves written order.
6. **A noise `wave` must not have `harmonics`**; `wave:"custom"` must have `harmonics`.
7. **`fm_ratio` must be positive**; 0 or negative raises an error (delete all three fm fields if you do
   not want FM).
8. **`config`'s `key` / `scale` do not affect the sound** and do not transpose.
9. **An envelope whose A+D exceeds the note duration is compressed proportionally** (both `applyAdsr` and
   the filter envelope): `adsr(3.5, 2.0, …)` on a one-measure note gives an actual attack of about 3.0s.
   The filter envelope behaves the same way: the peak is `baseFreq + amount` and the sustain level is
   `baseFreq + amount * sustain`.
10. **Same instrument, same instant, same pitch** merely adds amplitude (two in-phase oscillators, about
    +6dB); it does not sound "thicker". To thicken, change the pitch or the timbre.
11. **Commands inside one sequence are strictly serial**; there is no simultaneous sounding. Simultaneity
    across sequences is arranged by `mix`'s `time`.
12. **Each sequence's duration should be a whole number of measures**, otherwise `mix`'s `time` drifts
    cumulatively with each pass. After editing, re-sum each section's durations (see 4.3).
13. **`pitch_env_amount` drops the pitch downward** from `freq * 2^(amount/12)` to `freq` over
    `pitch_decay`; it never rises.
14. **`loop_point` re-attacks on a segment length of `noteDur / floor(noteDur / loopPoint)`, not on
    `loopPoint` itself**, and only when `noteDur > loopPoint * 1.5`.

---

## 4. Structural discipline

> **Looping the same material twice is "repetition"; changing the material is "development".**
> Parameterisation makes copy-paste extremely cheap, which is exactly why it is the most abused tool.

### 4.1 `loop=N` is not development

Spreading a 4-measure passage over 8 measures with `loop=2` gives **identical** pitches, durations and
direction. Even though the jitter seed includes the loop index (so each pass differs microscopically),
what you hear is still "the same sentence said twice".

**To create development, write a second piece of material.** The difference between restatement and
development is structural and cannot be compensated by parameter tweaks (velocity, pan, filtering) —
those only change "how loud the identical thing is".

To check whether you are being lazy, ask: **"is there a single new note in the second pass?"**
If not, it is restatement.

### 4.2 Replace, do not stack

When expressing an "escalation of state", the new material should **take over from** the old one, not
sound at the same time as it.

Counter-example: a slow heartbeat looped across the whole piece, with a fast heartbeat added on top at
some point. The result is not "the heart rate increased" but two heartbeats sounding at once — the low end
turns to mud, and the meaning "faster" is cancelled out by its own slow version.

**Rule: two materials that express a change of state must not overlap in time.** The hand-over point sits
on a structural boundary.

Likewise, if two parts differ by only a few semitones and occupy the same frequency band, sounding them
together only masks both. **Keep one part per frequency band**; to thicken, work on that part's pitches
rather than adding another one.

### 4.3 The structure must be arithmetically checkable on the timeline

Every section's duration must be an **integer multiple of the base unit** (measure, second, frame).
Otherwise the loop continuation accumulates drift pass after pass, and after a few passes everything is
misaligned — with no error raised.

How to check: list each section's durations, sum them, and confirm the total equals the expected section
length.

```
1n + 8n + 2n. + 4n = 4 + 0.5 + 3 + 1 = 8.5 beats   ← not a whole measure
```

This class of error is very common in drafts (written by feel, never summed).
**Summing each section once while rewriting is the cheapest, highest-yield check available.**

### 4.4 The ending must be designed, not left to run out

Once the material fills the duration, the "last section" is usually just "another loop".
Write it separately — how the final section is handled (silence, a single remaining part, no resolution,
an extended tail) determines where the whole piece comes to rest.

**Concretely**: write a separate piece of material for the final section instead of letting the previous
one `loop` to the end. The cost is a few repeated lines; the reward is that the work has a real ending.

### 4.5 A round-based plan that works for iteration

When iterating a piece that is a sequence of equal-length rounds, restructure it as follows. This
procedure was used to repair a piece whose four rounds were byte-identical accompaniment:

1. **Split the timeline into rounds** and give each round a name (`Ⅰ statement → Ⅱ entry → Ⅲ high point
   → Ⅳ close`). Write that map into the header comment so the structure is readable without playing it.
2. **Name the material by round**: `*_a` for the opening material, `*_b` for the developed material,
   `*_end` for the closing material. Renaming the old material to `*_a` is part of the fix, not cosmetic:
   it makes the mix block read as a section map.
3. **Keep exactly one invariant layer** — typically the bass pedal, which carries the harmonic skeleton —
   and let it run across the earlier rounds (`loop=3`). State in a comment that this layer is deliberately
   static and serves as the reference ground for the development above it. Everything else changes per round.
4. **Change a different parameter per round** so the development is audible, not merely present on paper:
   register (raise the whole bed a third), contour (`up` → `upDown`), rhythm (single strokes → double
   strokes), density (arpeggios drop out in the final round).
5. **Give the final round a cadence and a tail**: end on the tonic, drop the busiest part, and let the last
   note cross the barline with `gate=1.4`–`1.5` so it bleeds into the reverb tail instead of stopping dead.
6. **Verify each sequence's duration sums to the same whole number of measures**, then verify the mix
   timeline: with `loop` semantics as in 2.14, check that consecutive tracks for the same part start
   exactly where the previous one ends and that no part is left uncovered.

---

## 5. Rewriting procedure

### 5.1 Extract the intent first, then touch the syntax

An old draft often has dated syntax but readable intent. Split the rewrite into two steps; do not merge them:

1. **Extract the intent**: what is this passage trying to express? (crescendo, silence, counterpoint,
   close…)
2. **Re-implement in SPG**: same intent, new implementation.

Skipping step 1 degenerates into "translating the old spelling sentence by sentence into the new spelling" —
the detours the old syntax forced (copy-pasted passages, layers faked with time offsets) get inherited
unchanged.

**How to tell which parts are "artefacts of the old syntax"**: the same content copied several times with
only one or two parameters changed usually means the old syntax lacked a loop/variation mechanism. That
repetition is exactly what the rewrite should remove — but after removing it, check against 4.1: did you
really restate with `loop`, or did you write two pieces of material?

### 5.2 Item-by-item checklist

After writing, walk through **every** construct in the file:

- [ ] The parameter name is in the whitelist (spelling, singular/plural, underscores)
- [ ] The value is within the range the implementation allows (especially: > 0, 0~1, enum values)
- [ ] The field actually has a consumer, rather than being "parsed but never read"
- [ ] Duration/length units match `parseDuration`'s rules (beats, seconds, milliseconds, measures)
- [ ] Quotes, separators and comment markers match the implementation's tokenisation
- [ ] Ordering parameters (`direction`, `pattern`, `up`/`down`) were confirmed against those exact lines
- [ ] Combinations the implementation rejects (e.g. "A requires B") are not present
- [ ] Every sequence's durations sum to a whole number of measures (4.3)
- [ ] Every `sequence` is referenced by some `track`, or `mix` is deliberately omitted

---

## 6. Comment discipline

> **A comment is not evidence. A comment you wrote in a previous round even less so.**
> The most dangerous thing in a script is not a syntax error (that raises an error) but **a comment whose
> claimed behaviour contradicts what the engine actually does** — it raises nothing, warns nothing, and
> simply makes the next reader (including yourself) decide on a false premise.

### 6.1 Two defect classes, verified separately

| Class | Symptom | How to find it |
|---|---|---|
| **Numeric** | Seconds/frequencies/ratios in the comment do not match reality | Recompute against the implementation and put the formula in the comment |
| **Directional** | The comment says "ascending / brighter / decreasing" but the opposite happens | Read the implementation's branches and confirm which path actually runs |

Directional defects cluster around ordering parameters (2.11) and compressed parameters (6.2).

**Rule: whenever a comment contains a concrete number or a direction word, you must be able to point at
the line in the implementation that corresponds to it.** If you cannot, delete the number and replace it
with a qualitative statement.

### 6.2 The value you write ≠ the value you hear

Implementations routinely contain "compress proportionally", "truncate at the ceiling" and "clamp to
range" logic, which makes the written number differ from what sounds.

The most insidious numeric example: if an envelope's A+D exceeds the note duration, the implementation
**compresses them proportionally**. So a comment claiming a "3.5 second attack" is really 3.0 seconds.
**Either adjust the value so it is not compressed, or say in the comment that it will be** — both are
acceptable; pretending it does not happen is not.

### 6.3 Treat your own previous comments as objects under review

When iterating the same file, the errors most likely to survive are **the comments you wrote in the
previous round**. They look "already reviewed" and therefore get skipped.

Practical method: before each round, grep out every comment line containing a **concrete number, a
direction word, or a comparison word** ("higher than", "lower than", "only") and re-verify each one
against the current implementation. After you change a parameter, one of them has almost certainly gone stale.

**Change one thing, search globally**: if a part's register moved, every comment saying "an octave higher"
or "the lowest note is X" must be recomputed. Such comments are scattered all over the file and will not
announce themselves because you edited one line.

### 6.4 Do not use "the original draft" as a frame of reference

Sentences like "the original wrote this as…" or "an octave above the old C3" have no value for a reader —
the original may have been deleted, renamed, or simply not be at hand.
**Write only the technical reason for the current implementation** ("C3 would collide with the sustained
note on the same pitch, so C4"), never "changed from where".

---

## 7. Naming: grow the name out of the structure

When naming a work, **do not use an emotion label** ("sorrowful", "horrific", "furious") — that draws the
conclusion on the audience's behalf, and it fits any work of the same kind.

**Take a concrete, verifiable fact from the structure as the name**: a part that never moves, a cadence
that never resolves, a number that keeps recurring. Such a name:

- does not require the audience to know in advance what emotion is intended;
- explains what happens in the work by itself;
- cannot be applied to a different work.

Naming and the file name are two separate things: when renaming, update the title and explanatory
comments inside the file, **but do not change the content just because of a rename**.

---

## 8. Verification boundary

`npm run test:spg` (= `node test/index.js`) compiles the modules listed in `test/tsconfig.json` —
`app/renderer/services/AudioService.ts`, `SpgAiService.ts`, `LogService.ts`, `SearchService.ts`,
`shared/ai/AiService.ts`, `shared/core/**`, `shared/meta/**` and some `extension/src/**` files — into
`test/build/`, then runs the engine and compatibility cases. **It does not read any script under `.spg/`**
(verified: no `.spg` reference in `test/index.js`).

Therefore: **a hand-written SPG script is permanently in the "not executed" state** unless someone pastes
it into the GUI to compile it. The correct wording on delivery is "checked item by item against the
implementation, not executed", never "verified" (see `verification-discipline`).

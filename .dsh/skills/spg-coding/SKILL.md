---
name: spg-coding
description: Applies to this project only (the-play). Use whenever writing, editing, rewriting, porting or reviewing an SPG audio script (`.txt` / `.spg` under `.spg/`), or when asked what an SPG construct does or sounds like. Contains the full SPG language reference (config / define_instrument / sequence / effect_chain / mix blocks, durations, pitches and chord symbols, envelopes, filters, LFOs, effects, drums, loudness, loop semantics, export length), the list of constructs that parse but do not sound the way they read, how to check a construct against the sole authority `app/renderer/services/AudioService.ts`, structural discipline for time-based pieces, comment discipline and naming. Use it even for small SPG edits: a misspelled parameter fails loudly, but a construct with the wrong meaning does not.
---

# SPG coding

> **There is exactly one authority: `app/renderer/services/AudioService.ts`.**
> The parser `SPGParser`, the scheduler `EventScheduler` and the synthesizer `AudioSynthesizer` all live
> inside it (~5400 lines; the count drifts because the file is edited concurrently outside the session).
> Note the path: it is **not** `services/AudioService.ts` — that path does not exist, and grepping it
> fails with `os error 3`. When in doubt, `glob "**/AudioService.ts"` first.
>
> The SPG system prompt (`SPG_SYSTEM_PROMPT`, around line 92 of `app/renderer/services/SpgAiService.ts`)
> documents the same language but **may lag the implementation**. So may §2 of this file, which is a
> transcription. On conflict, the implementation wins.
>
> The parser's principle is "**rather raise an error than silently ignore**": unknown parameters, illegal
> durations and illegal enums throw `SPGError` with a line number. A misspelled name therefore fails at
> once; a **semantically wrong construct does not** — §3 exists for those.

---

## 1. Working method

### 1.1 Workflow at a glance

1. **Intent first.** Decide what each section must express before choosing syntax (§5.1).
2. **Write from the reference** (§2) and take structure rules from §4.
3. **Pre-flight** against the silent-failure list (§3) and **sum every sequence's duration** (§4.3).
4. **Audit every comment** that carries a number or a direction word (§6).
5. **Walk the checklist** (§5.2), then deliver as "checked item by item against the implementation,
   not executed" (§8).

### 1.2 Source priority

| Priority | Source | Use it for |
|---|---|---|
| 1 | The implementation, `app/renderer/services/AudioService.ts` | Parameter whitelists, value ranges, defaults, branch conditions |
| 2 | §2 of this file; the prompt in `SpgAiService.ts` | Intent, recommended usage, a fast first answer |
| 3 | Your experience with generic DSLs / synthesizers / audio formats | **Search keywords only** — never grounds for writing something |

Priority 3 is the most dangerous: SPG looks like a generic format, so experience supplies a spelling that
"looks right". Classic case: the `filter` effect's `start` is the second at which the sweep begins; the
starting frequency is `from`. Writing `start=<frequency>` raises no error — the number is simply read as
a time, and the meaning changes completely.

### 1.3 When §2 is enough and when to read the code

§2 saves you from re-deriving the language, but it is a transcription and can lag. So:

- A construct listed in §2 and used as written needs no lookup.
- **Find the consuming line in the implementation** when the construct is not in §2; when a comment will
  assert a number, unit, ordering or direction about it (§6.1); when §2, the SPG prompt, an example or the
  parser's own error disagree; or when you suspect §2 is out of date.
- If you cannot find a consumer, the field is "parsed but never read". Do not use it, or state in a
  comment that it is format-checked only and does not affect the sound.

### 1.4 Read the whitelist, do not induce it from examples

The implementation holds several parameter whitelist tables and `rejectUnknownParams`-style validators.
Reading the table itself is faster and more accurate than inferring rules from examples, which may use
aliases or be out of date.

```
grep -n "PARAMS\s*[:=]|_NAMES\s*[:=]|rejectUnknownParams" app/renderer/services/AudioService.ts
```

### 1.5 Alias tables mark the commonly misspelled names

The `*_ALIASES` tables record spellings that are written wrongly often enough to be tolerated; reading
them once shows which names are ambiguous. **An alias existing does not make it recommended** — write the
canonical name and treat aliases as compatibility only (§2.11).

---

## 2. Language reference

### 2.1 File structure

SPG is made of five block types, in any order:

| Block | Count limit | Purpose |
|---|---|---|
| `config { }` | at most 1 | tempo / master gain / key / scale / swing |
| `define_instrument(name="…") { }` | many | instrument definition |
| `sequence(name="…", instrument="…") { }` | many | note sequence |
| `effect_chain { }` | top level: many, concatenated in written order into one chain; inside an instrument: at most 1 | effect chain; **written order = signal-flow order** |
| `mix { track(...) }` | at most 1 | arrangement; once written, unreferenced sequences produce no sound (§2.12) |

Lexical rules:

- Comments use `#` or `//`, stripped per line and quote-aware (a `#` inside a string survives).
- Several statements may share a line: `hit("kick","4n") hit("hat","4n")` is cut into two. A trailing
  `;` is optional.
- Enumerations are case-insensitive: command names, filter kinds, `voicing`, `pattern`, `scale`,
  `target`, preset names.
- Booleans: true = `true` / `1` / `yes` / `on`, false = `false` / `0` / `no` / `off`. Any other word
  (`accent=maybe`) **throws**; it is never silently read as false.
- An unknown command throws and lists the valid ones; an unknown preset throws and lists all valid names.

A minimal skeleton (unexecuted template; every comment is arithmetic you can re-check):

```spg
# 4 measures at 96 BPM: the pad is the invariant ground, the melody changes at measure 3.
config {
  tempo: 96
  master_gain: 0.7
}

define_instrument(name="pad") {
  preset: "warm_pad"
  envelope: "adsr(1.2, 0.8, 0.8, 2.0)"   # A + D = 2.0 s < one 1m chord (2.5 s at 96 BPM): not compressed
  effect_chain {
    reverb(decay=4, mix=0.35)
  }
}

define_instrument(name="bell") {
  preset: "music_box"
}

sequence(name="pad_a", instrument="pad") {          # 2 × 1m = 2 measures
  progression(["Am7","Fmaj7"], "1m")
}

sequence(name="melody_a", instrument="bell") {      # 2 + 1 + 1 + 4 = 8 beats = 2 measures
  note("A4", "2n")
  note("C5", "4n")
  note("B4", "4n")
  note("A4", "1n")
}

sequence(name="melody_b", instrument="bell") {      # 4 × 1 + 3 + 1 = 8 beats = 2 measures; new notes, not a repeat
  note("E5", "4n")
  note("D5", "4n")
  note("C5", "4n")
  note("D5", "4n")
  note("E5", "2n.")
  rest("4n")
}

mix {
  track(source="pad_a",    time=0, loop=2)    # pass 2 starts where pass 1 ends: measures 1–4
  track(source="melody_a", time=0)
  track(source="melody_b", time="2m")         # "2m" = 2 measures; a bare 8 would mean 8 seconds
}
```

### 2.2 config

```spg
config {
  tempo: 120          # or bpm:
  master_gain: 0.7    # or gain:
  key: "Am"
  scale: "minor"
  swing: 0
}
```

| Parameter | Constraint | Default |
|---|---|---|
| `tempo` / `bpm` | > 0 and ≤ 1000 | 120 |
| `master_gain` / `gain` | ≥ 0; clamped to 2 | 0.6 |
| `key` | regex `^[A-Ga-g][#b♯♭]?m?$`, e.g. `"C"`, `"Am"`, `"F#"`, `"Bbm"` | `"C"` |
| `scale` | enum of 14, below | `"major"` |
| `swing` | 0~1 | 0 |

`scale` values: `major` `minor` `harmonic_minor` `melodic_minor` `dorian` `phrygian` `lydian`
`mixolydian` `locrian` `major_pentatonic` `minor_pentatonic` `blues` `chromatic` `whole_tone`.

> ⚠ **`key` and `scale` are format-checked only; neither scheduling nor synthesis reads them.** Writing
> `key: "Cm"` does not transpose anything and does not filter out notes outside the scale. To make a
> script sound like a key, write the pitches correctly yourself.

**`swing`** shifts notes later, scaled by its value. On the sixteenth-note grid, odd steps move 1/3 of a
sixteenth later; steps with `step % 4 === 2` (the off-beat eighth) move 2/3 of a sixteenth later; steps
divisible by 4 stay put. At `swing=1` the 2nd sixteenth therefore lands at 1/3 beat, the off-beat eighth
at 2/3 beat (a triplet feel) and the 4th sixteenth at 5/6 beat. Off-beat eighths are affected too, not
only sixteenth arpeggios. This is the documented rule; confirm the grid snapping in `EventScheduler` if
swing is central to a piece.

### 2.3 Durations (`parseDuration`)

| Spelling | Meaning |
|---|---|
| `1n` `2n` `4n` `8n` `16n` `32n` `64n` `128n` | 1/N of a whole note; **whole note = 4 beats** |
| `4n.` | dotted, ×1.5 |
| `4n..` | double-dotted, ×1.75 (**not** 1.5 × 1.5) |
| `4nt` | triplet, ×2/3 |
| `1m` | one measure = 4 beats (4/4 assumed); regex `^([\d.]+)m$`, so `2m` = 8 beats, `3m` = 12 beats |
| `250ms` / `1.5s` | absolute milliseconds / seconds |
| `250` | a bare number is **seconds**, not beats |
| `4x` | **error**: a bare number must be numeric in full |

- Dots and triplets combine: multiplier `(2 − 2^−dots) × (2/3)^triplets`, looped at most 8 times.
  `2n.` = 3 beats, `8n.` = 0.75 beat.
- One beat = `60 / tempo` seconds. `1m` is always 4 beats, independent of tempo. At 64 BPM a `1n` is 3.75 s.
- The bare-number rule applies wherever a duration is parsed, including `mix` `time`: write
  `time="4m"`, not `time=16`.

### 2.4 Pitches and chord symbols

| Spelling | Meaning |
|---|---|
| `C4` `F#5` `Bb3` | letter `A`–`G` (either case) + up to 3 accidentals + octave number; the octave may be negative (`C-1`). **A pitch name must carry an octave.** |
| `440hz` | frequency in Hz (`hz` case-insensitive), converted to a pitch number |

Accidentals: `#` and `♯` raise a semitone, `b` and `♭` lower one. C4 = middle C = MIDI 60; A4 = 440 Hz.
An unrecognisable name throws; it is never silently read as 0.

**Chord symbols.** The first positional argument of `chord()` / `arp()` / `progression()` (or an element
of the progression array) may be a pitch array **or** a chord symbol: root + quality + optional slash
bass, e.g. `C` `Am7` `Fmaj9` `G7/B` `C#m7b5`. The root is `A`–`G` plus any number of accidentals
(`Bb`, `F#`, `Ebb`). `note("Am7", "2n")` throws and tells you to use `chord()` — a deliberate, actionable
error.

Quality whitelist (single-letter `m` / `M` distinguishes minor-seventh from major-seventh):

```
(empty) maj M major m min minor - dim o aug + 5
sus sus4 sus2 7sus4 7sus2 9sus4 maj7sus4 m7sus4 13sus4
6 m6 min6
7 dom7 maj7 M7 Δ7 m7 min7 -7 m7b5 min7b5 ø ø7 dim7 o7 mM7 mMaj7 minMaj7 mM9 aug7 +7 augM7
add9 add2 madd9 add11 add4 add6 madd6
9 dom9 maj9 M9 m9 min9 6/9 69 m6/9
11 maj11 m11 13 maj13 m13
```

- The prefixes `maj` / `min` / `dim` / `aug` / `sus` / `add` are case-insensitive (`MAJ7` = `maj7`).
- Outside the whitelist the parser reads `base triad + extension + alteration` in turn. Extensions:
  `2` `6` `7` `9` `11` `13` (`11` and `13` imply the 9; `9` / `11` / `13` imply the seventh).
  Alterations: `b5` `#5` `b9` `#9` `#11` `b11` `b13`. Omissions: `no3` / `omit3`, `no5` / `omit5`.
  If neither route recognises the symbol it throws; it never silently yields a wrong harmony.
- A slash bass adds a bass voice within one octave below the root. `C/E` is still the complete C chord
  with a bass added, not a replacement. After expansion `drop2` / `spread` may produce duplicate pitches;
  duplicates are removed.

### 2.5 define_instrument

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

Header: `name` / `instrument` / `id`. `name` is required, and a duplicate name throws. The table below **is**
the whitelist; any other key throws.

| Parameter | Meaning and values | Default |
|---|---|---|
| `preset` | Baseline; every other field overrides it item by item (names below) | none |
| `wave` | `sine`, `square`, `sawtooth`, `triangle`, `white_noise`, `pink_noise`, `brown_noise`, `custom` | `sine` |
| `envelope` (`env`, `amp_envelope`) | Amplitude envelope string (§2.6) | `adsr(0.01, 0.1, 0.7, 0.2)` |
| `filter` | Filter string (§2.7) | none |
| `filter_envelope` | Filter envelope, same grammar as `envelope` | none |
| `filter_env_amount` | Filter-envelope depth, Hz | 0 |
| `lfo` | LFO string (§2.8) | none |
| `gain` | Instrument base volume | 0.8 |
| `pan` | −1 hard left … 1 hard right | 0 |
| `fm_wave` | `sine`, `square`, `sawtooth`, `triangle` only (noise names throw) | none |
| `fm_index` | FM depth in **Hz**, not a modulation index; 0 or absent = FM off | none |
| `fm_ratio` | Frequency ratio, **must be > 0** | none |
| `detune` | Cents | 0 |
| `glide` | Attack glide time, seconds, ≥ 0 | 0 |
| `glide_from` | Glide start offset, semitones | −12 |
| `pitch_env_amount` | Pitch-envelope depth, semitones; **positive = starts high, then falls** | 0 |
| `pitch_decay` | Pitch-envelope decay, seconds, ≥ 0 | 0.05 |
| `spread` | Stereo spread, 0~1 | 0 |
| `velocity_sensitivity` | How strongly velocity scales volume | 0.7 |
| `velocity_to_filter` | Velocity → filter cutoff, Hz | 0 |
| `voices` | Detuned oscillators per note, clamped to 1~7 | 1 |
| `unison_spread` | Detune between voices, cents | 12 |
| `harmonics` | Harmonic amplitude array, e.g. `[1, 0.5, 0.33, 0.25]`; must not be empty | none |
| `attack_noise` | Attack noise burst, clamped to 0~1 | 0 |
| `loop_point` | Re-attack point, seconds, ≥ 0 | 0 |
| `effect_chain` | Instrument-level chain, a nested `effect_chain { … }` block | none |

**Constraints (a violation throws):**

- `wave: "custom"` **requires** `harmonics` (it may come from the preset baseline).
- A noise wave (`white_noise` / `pink_noise` / `brown_noise`) **must not** have `harmonics`.
- `fm_ratio` must be > 0. FM is silently off when `fm_index` is 0 or missing, but a leftover
  `fm_ratio: 0` still throws — delete all three fm fields rather than zeroing them.

> ⚠ **`fm_index` is not the textbook modulation index.** It is a Hz frequency deviation added directly
> to the carrier frequency (`fmGain.gain = fm_index`), decaying to 8% over time. The `bell` preset uses
> 420, `piano` uses 180.

> ⚠ **`pitch_env_amount` direction.** The oscillator starts at `freq * 2^(amount / 12)` — *above* the
> written pitch — and ramps exponentially **down** to `freq` over `max(0.005, pitch_decay)` seconds. A
> positive amount is a downward drop, which is what makes a timpani or kick sound like a struck head
> losing tension. A comment saying the pitch falls is correct; one saying it rises is a direction defect.

> ⚠ **`loop_point` re-attack.** Only when `loop_point > 0` and `noteDur > loop_point * 1.5` is the note
> cut into `segments = floor(noteDur / loop_point)` equal pieces of `segDur = noteDur / segments`, each
> re-attacking. **The segment length is `segDur`, not `loop_point`.** Example: a `1n` at 64 BPM is 3.75 s;
> `loop_point: 1.8` gives `floor(3.75 / 1.8) = 2` segments of 1.875 s, so "re-attacks every 1.8 s" is
> about 4% off. Audible only when `sustain < 1`: at `sustain = 1.0` "decay to sustain" means staying put,
> so re-attacking changes nothing.

**Presets** (names are case-insensitive; the 51 below are the documented ones — an unknown name throws
and prints the authoritative full list, so trust that error over this list):

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

### 2.6 Envelopes

```
adsr(a, d, s, r)      ad(a, d)      ar(a, r)      perc(a, d, r)
```

- Arguments may be positional or named: `a`/`attack`, `d`/`decay`, `s`/`sustain`, `r`/`release`.
  Extra named arguments: `curve=linear|exp|hold` (default `exp`) and `delay=<seconds>` (default 0).
  Values may be quoted or bare. Negative values throw.
- `adsr`'s `s` is a 0~1 **level ratio**, not seconds; `sustain > 1` is clamped to 1.
- `ad`: release is half the decay. `ar`: sustain fixed at 1. `perc`: sustain fixed at 0.

| Form | Defaults |
|---|---|
| `adsr` | a=0.01, d=0.1, s=0.7, r=0.2 |
| `ad` | a=0.01, d=0.3, s=0, r=0.15 (= d/2) |
| `ar` | a=0.05, d=0.01, s=1, r=0.4 |
| `perc` | a=0.001, d=0.3, s=0, r=0.15 |

```
envelope: "adsr(0.01, 0.3, 0.5, 0.4)"
envelope: "perc(0.001, 0.25, 0.1)"
envelope: "adsr(1.5, 1.0, 0.8, 2.5, curve=linear)"
```

> ⚠ **When `a + d` exceeds the note duration, `applyAdsr` compresses both `a` and `d` by
> `noteDur / (a + d)`** — the seconds you write are not the seconds you hear. Example: at 64 BPM a `1m`
> note is 3.75 s; `adsr(3.5, 2.0, …)` has `a + d = 5.5`, factor `3.75 / 5.5 ≈ 0.68`, so the real attack is
> about 2.4 s and the decay about 1.4 s. Either shorten the values so nothing is compressed, or say in the
> comment that it will be (§6.2).

`filter_envelope` uses the same grammar and the same compression. Its peak is `baseFreq + amount` and its
sustain level is `baseFreq + amount * sustain`, where `amount` is `filter_env_amount`.

### 2.7 Filters

```
filter: "lowpass(800, 2)"
filter: "bandpass(1200, 1.5, sweep_to=6000)"
```

- Kinds: `lowpass`, `highpass`, `bandpass`, `notch`, `lowshelf`, `highshelf`, `peaking`, `allpass`.
- Positional order `(freq, Q, gain, sweep_to)`; named `freq`/`frequency`, `q`, `gain`, `sweep`/`sweep_to`.
- `freq` must be > 0 (default 1000). `Q` must be ≥ 0 (default 1; clamped to 0~30 at synthesis).
  `gain` is for shelves and peaking. `sweep_to=<Hz>` sweeps toward that frequency across the note.

### 2.8 LFO

```
lfo: "sine(freq=5.5, amount=10, target=frequency, ramp=0.6)"
```

Form: `waveform(freq=, amount=, target=, ramp=, swell=)`. Waveform is one of `sine`, `square`, `sawtooth`,
`triangle`. Defaults: `freq` 5 (must be > 0), `amount` 10, `target` `frequency`, `ramp` 0 s, `swell` false.
`target` is one of `frequency`, `filter`, `gain`, `pan`, `detune`.

**The unit of `amount` depends on `target`:**

| target | `amount` unit | Clamp |
|---|---|---|
| `frequency` / `detune` | **cents** (wired to the oscillator's detune, so the effect is consistent across pitches) | ±1200 |
| `filter` | Hz | 0~12000 |
| `gain` | depth ratio, then multiplied by voice gain | 0~1 |
| `pan` | pan swing (position range −1~1) | 0~1 |

> ⚠ The default `amount=10` is the same whatever the target. For `gain` and `pan`, where the clamp is
> 0~1, an omitted `amount` therefore means full depth (derived from the default and the clamp). Always
> write `amount` explicitly.

`ramp` fades the modulation in: it starts at 0 and rises linearly to full depth over `ramp` seconds.
`swell=true` ramps the depth linearly up to `peakAmount * 2.2`, with the endpoint at
`t + max(0.05, note duration, ramp)` (keeping automation times monotonic).

### 2.9 sequence

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

Header: `name` / `seq` / `id` (required; a duplicate throws), `instrument` / `inst` (default `"default"`),
`gain` (default 1), `transpose` (semitones, default 0), `humanize` (0~1, default 0).

- Only a sequence containing pitched commands (`note` / `chord` / `arp` / `progression` / `run`) needs an
  instrument. **A pure-`hit` drum sequence needs no instrument definition.**
- A sequence with no commands throws. If no instrument is defined anywhere, the engine adds a `default`
  (sine, gain 0.5).
- **Commands are strictly serial**: each starts where the previous one ended. **There is no way to sound
  two notes at once** inside a sequence — use `chord()` for simultaneity, and `mix` `time` to align
  separate sequences. This is why "the bell and the scrape" come out sequential, not layered.

#### Commands

| Command | Named parameters | Notes |
|---|---|---|
| `note(pitch, duration)` | `pitch`/`note`/`n`, `duration`/`dur`/`len`/`d` | Single note. A chord symbol throws; use `chord()` |
| `chord(chord, duration, …)` | `strum`, `voicing`, `octave`, `pitches`/`chord`/`notes`, `duration`/`dur` | First argument: chord symbol or pitch array |
| `arp(chord, …)` | `pattern`, `rate`, `duration`, `octaves`, `gate`, `voicing`, `octave`, `chord`/`notes`/`pitches` | Arpeggio |
| `progression(chords, beats, …)` | `chords`/`chord`, `beats`/`beat`, `voicing`, `octave`, `octaves`, `pattern`, `strum`, `gate` | Chord progression; **no `duration`, no `rate`** |
| `run(pitches, rate, …)` | `notes`/`pitches`, `rate`/`step`, `direction`/`pattern`, `repeat`/`times`, `gate` | Running figure |
| `hit(drum, duration, …)` | `drum`/`name`, `duration`/`dur`/`len`, `tune`, `decay`, `tone`, `snap` | Percussion; needs no instrument; no `kit=` (that would mean a whole kit) |
| `rest(duration)` | `duration`/`dur`/`len` | Silence. **Takes no per-note expression parameters** |

Every command except `rest` also accepts the per-note expression parameters below. Command names are
case-insensitive.

#### Per-note expression parameters

`velocity vel pan gain gate transpose glide detune humanize human octave accent`

| Parameter | Values | Default | Notes |
|---|---|---|---|
| `velocity` / `vel` | clamped to 0~1 | 0.8 | Affects both volume and brightness |
| `pan` | clamped to −1~1 | instrument pan | Overrides the instrument pan |
| `gain` | ≥ 0 | instrument gain | Overrides the instrument volume |
| `gate` | ≥ 0 (clamped to 0~4 when scheduled) | 1 | Duration multiplier: 0.5 staccato, 1.5 legato; `1.06` runs just past the next command, implying pedal overlap |
| `transpose` | semitones | 0 | Temporary transposition |
| `octave` | octaves | 0 | Equals `transpose = octave * 12`, added to `transpose` (**in `chord` it means something else**, below) |
| `glide` | ≥ 0 | instrument glide | Glide time for this note, seconds |
| `detune` | cents | instrument detune | Overrides detune |
| `humanize` / `human` | 0~1 | sequence humanize | Jitter amount (§2.13) |
| `accent` | boolean | false | `accent=true` is shorthand for `velocity=1`; `hit()` honours it too |

#### chord

```
chord(chord_or_pitches, duration, strum=0, voicing="close", octave=4)
```

- `voicing`: `close` (default) dense; `open` lifts the 2nd note an octave; `drop2` drops the
  second-from-top note an octave; `spread` lifts adjacent notes alternately.
- `strum` 0~1: voices enter one after another, each offset by `strum * 0.055` s.
- **`octave` is the voicing register** (default 4): `chord("Am7", "1n", octave=3)` plays the chord in the
  3rd octave. It is not applied a second time as a transposition. (`arp` and `progression` also list
  `octave`; confirm in the parser if the register matters.)
- **`chord` accepts `gate`**, and the timeline advances by `duration` only — `strum` offsets do not push
  later commands. A sustained final chord can be `chord([...], "1n", strum=0.3, gate=1.5)`: it rings 1.5×
  its written length into the reverb tail.

#### arp

```
arp(chord_or_pitches, pattern="up", rate="16n", duration="1n", octaves=1, gate=0.9)
```

- `pattern`: `up`, `down`, `upDown`, `downUp`, `asPlayed`, `random`. `rate` defaults to `16n`.
  `duration` is the arpeggio's **total length**; always write it. `octaves` is clamped to 1~4;
  `gate` defaults to 0.9.
- **`up` / `down` order by pitch, not by written order**; only `asPlayed` and `random` keep written
  order. (Sorting by index would turn `["C3","G3","Eb3"]` into something that is not an ascending
  arpeggio at all.)
- Step count is `floor(duration / rate)`, and the index **wraps modulo `order.length`**. A 4-note pool's
  `upDown` is 6 steps (0-1-2-3-2-1); pairing it with 8 eighth notes wraps back to the pool's first two
  notes — a wave-shaped contour, not a clean repeat. With `len <= 2`, `upDown` / `downUp` degrade to
  a single pass.
- **A named pitch source is accepted**: `arp(chord=[...])`, also `notes=` / `pitches=`. It takes priority
  over the positional argument, and once present the positional arguments are re-read from index 0 as
  `pattern` / `rate` / `duration`. This exists so `arp(chord=["C4"], "up", "16n", "1n")` does not try to
  parse `"up"` as a chord symbol.

#### progression

```
progression(["Am7","Dm7","G7","Cmaj7"], "1n", voicing="drop2", pattern="asPlayed")
progression(["Am7","Dm7","G7","Cmaj7"], ["1n","1n","1n","2n"])
```

- The duration parameter is **`beats`** (alias `beat`); **`duration` does not exist and throws.**
- `beats` is one token (every chord equally long) or an array as long as the chord list; a length
  mismatch throws.
- `pattern` defaults to `asPlayed` (block chords); `up` / `down` etc. play the chord tones in turn.
  `octaves` 1~4 extends across octaves. **The step length differs from `arp`**: `arp` steps by `rate`;
  `progression` splits **each chord's own duration** into `order.length` equal steps
  (`stepDur = dur / order.length`) — hence no `rate` parameter.
- The chord list may mix in explicit pitch arrays.

#### run

```
run(["C4","D4","E4","G4"], "16n", direction="up", repeat=1, gate=1)
```

- `direction` (also accepted as `pattern`): `up` as written; `down` **reverses the array**; `updown`
  goes there and back.
- **`down` reverses the array, so a descending line needs an array written ascending.** Writing a
  descending array and passing `down` yields an ascending line — the opposite of the intent, no error.
- For arrays longer than 2, `updown` is `concat(slice(1, -1).reverse())`: the ends are not repeated.
- `repeat` ≥ 1; `gate` defaults to 1.

> **Any parameter that "reorders the input by semantics" must be read in its exact lines, never
> guessed.** Comments are extremely easy to get backwards here.

#### hit

```
hit("kick", "4n", tune=0, decay=1, tone=0, snap=0)
```

The drum name may be positional or `drum=` / `name=`; duration defaults to `8n`. `tune` semitones;
`decay` a multiplier (must be > 0, floor 0.05); `tone` a Hz offset of the noise centre frequency;
`snap` 0~1 transient. When the written duration is shorter than the timbre's natural decay, the gate
truncates it — useful to choke an open hat.

### 2.10 Drums

Names (`DRUM_NAMES`, derived from `DRUM_SPECS`):

```
kick  sub_kick  snare  rim  clap  hat  open_hat  pedal_hat
tom_low  tom_mid  tom_high  crash  ride  cowbell  shaker  tambourine
```

- **Drum events bypass the instrument's filter / LFO / gain / pan chain.** They carry their own
  `DRUM_SPECS` calibration (kick gain 1.0, hat 0.45, shaker 0.4 …) and honour only per-note `velocity` /
  `pan` and the mix track's `pan`. Writing `instrument` on a pure drum sequence changes nothing.
- Drum base gain is `expr.gain ?? 1`: it does **not** inherit the current instrument's `gain` (pan
  likewise).
- Drum amplitude formula: `clamp(spec.gain * (0.45 + velocity * 0.7), 0, 2, 0.8)`. How this combines
  with the scheduler's general gain formula (§2.13) — for instance whether velocity is applied twice — is
  not documented; read the code before relying on exact drum loudness.

### 2.11 Effect chains and effects

`effect_chain` may sit at top level (acts on all sound) or inside `define_instrument` (that instrument
only). Several top-level blocks are concatenated in written order into one chain; **written order is
signal-flow order**.

The 13 effects and their parameters with defaults:

| Effect | Parameters |
|---|---|
| `delay` / `pingpong` | `time`=0.3 (**a duration**, `"8n."` is legal), `feedback`=0.3, `mix`=0.4, `damping`=2000, `pingpong`=false |
| `reverb` | `decay`=2.0 (clamped 0.05~12), `mix`=0.3, `predelay` / `pre_delay`=0.01, `damping`=5000 |
| `distortion` | `amount`=0.5, `mix`=1 |
| `overdrive` | `amount`=0.15, `mix`=1 |
| `bitcrush` | `bits`=8 (clamped 1~16), `mix`=1 |
| `chorus` | `rate`=1.5, `depth`=3.5, `mix`=0.5 |
| `flanger` | `rate`=0.3, `feedback`=0.6, `mix`=0.5 |
| `phaser` | `rate`=0.5, `min`=300, `max`=2000, `mix`=0.6 |
| `tremolo` | `rate`=5, `depth`=0.6 |
| `compressor` | `threshold`=-20, `ratio`=4, `attack`=0.01, `release`=0.25 |
| `filter` | `kind`=`lowpass`, `from`=200, `to`=4000, `q`=1, `duration`=2 (**a duration**), `start`=0 |
| `eq` | `low`=0, `mid`=0, `high`=0 (dB) |

- ⚠ **The `filter` effect's `start` is "at which second the sweep begins"; the starting frequency must be
  written `from`.** Intuition reads `start` as a frequency; no error is raised and the meaning is
  entirely different.
- `delay` / `pingpong` `time` is parsed as a **duration with tempo** (`durArg(['time'], 0, '0.3')`), so
  `time="8n."` is legal and tempo-relative: at 64 BPM, `8n.` = 0.75 beat × 0.9375 s = 0.703 s. A bare
  `0.3` is seconds. For `pingpong` the right-channel delay is `time * 1.5`.
- `eq` is fixed to lowshelf at 250 Hz / peaking at 1200 Hz with Q 0.9 / highshelf at 4000 Hz, each
  clamped to ±24 dB. **Quote 250 Hz, not 200 Hz,** for the low band in a comment.

**Aliases.** They compile (with a warning) and are equivalent to the canonical name. Always write the
canonical name:

```
delay→time      fb→feedback     tone→damping    ping_pong→pingpong
size→decay      drive→amount    gain→amount     depth→bits
speed→rate      bass→low        treble→high     end→to
dur→duration    at→start        from→min        to→max
```

Aliases apply per effect: `depth` is canonical on chorus / tremolo but an alias of `bits` on bitcrush;
`from` / `to` are canonical on the `filter` effect but aliases of `min` / `max` on phaser. No alias maps
`start` to `from`.

### 2.12 mix and loop

```spg
mix {
  track(source="drums",  time=0, loop=4)
  track(source="bass",   time=0, loop=4)
  track(source="melody", time="2n", loop=1, gain=0.9, pan=0.2)
}
```

| Parameter | Meaning | Default |
|---|---|---|
| `source` / `seq` / `track` | Referenced sequence name; must exist | required |
| `time` / `at` | Start, seconds or a duration token | 0 |
| `loop` / `repeat` / `times` | Repetitions, ≥ 0, truncated to an integer | 1 |
| `gain` | Track volume | 1 |
| `pan` | Track pan, clamped to ±1 | 0 |
| `stagger` | Per-pass offset increment, seconds | 0 |

**`loop` means "play it again": pass n continues from the previous pass's END, not from `time` again.**

```
currentStart = time
for i in 0..loop-1:  duration = play(source, currentStart);  currentStart += duration + stagger
```

Consequences:

- A 4-measure sequence with `loop=3` covers exactly 12 measures, with neither overlap nor gap.
- To make a part "come back every 8 measures", **`loop` cannot do it**; use several `track` entries, each
  with its own `time`. `loop` has exactly one behaviour: continuous continuation.
- `stagger` is added after every pass. A positive value inserts a gap and makes the part longer than the
  others by about `stagger` per pass; overlapping passes (a canon) would need a negative value, and the
  docs do not say whether the parser accepts one — check before relying on it.
- Several tracks may reference the same `source`: `mix` is a plain list and each entry is scheduled
  independently. That is the correct way to restate material later on the timeline.
- ⚠ **Once `mix` is written, any sequence not referenced by a `track` produces no sound.** The parser
  only warns (`以下音序没有被 mix 引用，不会发声：…`) and compilation still passes. Keep both sides in
  sync when editing.
- ⚠ **Without `mix`, all sequences are concatenated head to tail** in definition order (one running
  cursor), not layered from 0. This is commonly mistaken for "playing simultaneously".

### 2.13 Loudness, velocity and humanize

```
gain   = clamp(baseGain * velScale * seqGain * trackGain * jitterGain, 0, 2, 0.8)
output = gain * config.master_gain
velScale = clamp((1 - sens) + sens * (velocity / 0.8), 0, 1.6, 1)
```

- `baseGain` is the per-note `gain`, otherwise the instrument `gain` (default 0.8). Drums are the
  exception (§2.10).
- `sens` is `velocity_sensitivity` (default 0.7). **`velocity = 0.8` is exactly a 1.0 multiplier**; with
  `sens = 0.85`, `velocity = 0.4` gives only 0.58×.
- Velocity is clamped at 1.0. Writing everything at 1.0 leaves no room to accent; **leave headroom**
  (0.3~0.9).
- Instrument × sequence × track gains are multiplied, then multiplied by `master_gain`.
- `velocity_to_filter` makes hard playing brighter: cutoff + `(velocity - 0.8) * velocity_to_filter`,
  clamped to 20~20000 Hz.
- **`humanize`** gives reproducible jitter: pitch ±12 cents, velocity ±12%, onset ±0.012 s, all scaled
  by the humanize value (one earlier source also listed ±2% duration; confirm in the code if duration
  jitter matters). Seed = `hash(sequence name : start time : track/loop index)`, so identical code
  renders identically, while each loop pass differs microscopically.

### 2.14 Export length

```
totalDuration + tailRoom
tailRoom = effects.length > 0 ? min(max(3.0, longest reverb decay), 12) : 0.5
```

Reverb `decay` is clamped to 0.05~12 s. The offline render is capped at 900 s.

Worked example: 16 measures at 64 BPM = 64 beats × 0.9375 s = 60 s. With a global chain and `decay=6.5`,
`tailRoom = min(max(3, 6.5), 12) = 6.5`, so the render is about 66.5 s. A header comment saying
"4 rounds ≈ 64 s" for that piece is a numeric defect (64 is the beat count); the figure is 60 s.

---

## 3. "Parses fine but does not do what you think"

The parser stops syntax errors only, not semantic ones. Confirm each item before writing a script;
details live in the section cited.

1. **`filter` effect**: `start` is the sweep's start *time*; the start frequency is `from` (§2.11).
2. **`fm_index`** is a Hz deviation, not a modulation index; FM is off when it is 0 or missing; `fm_ratio`
   must be > 0 (§2.5).
3. **`progression`** takes `beats`, never `duration` or `rate` (§2.9).
4. **`run(direction="down")` reverses the array**: write it ascending to get a descent (§2.9).
5. **`arp` `up` / `down` sort by pitch**; only `asPlayed` / `random` keep written order; the index wraps
   modulo the pool size (§2.9).
6. **Noise `wave` + `harmonics`** throws; **`wave: "custom"` without `harmonics`** throws (§2.5).
7. **`key` / `scale` do nothing audible**, and **`swing` also moves off-beat eighths** (§2.2).
8. **An envelope with `a + d` longer than the note is compressed proportionally** (amplitude and filter
   envelopes alike): written seconds ≠ heard seconds (§2.6).
9. **`pitch_env_amount` > 0 drops the pitch** from above; it never rises (§2.5).
10. **`loop_point` re-attacks every `noteDur / floor(noteDur / loop_point)`**, not every `loop_point`, and
    only when `noteDur > loop_point * 1.5` and `sustain < 1` (§2.5).
11. **A bare number is seconds**, in durations and in `mix` `time` (§2.3).
12. **`octave`** shifts by N octaves in `note` but is the voicing register (default 4) in `chord` (§2.9).
13. **Commands in a sequence are strictly serial**; simultaneity needs `chord()` or separate tracks (§2.9).
14. **Drums bypass the instrument's filter / LFO / gain / pan**, and their base gain does not inherit the
    instrument's (§2.10).
15. **LFO `amount`'s unit follows `target`**, and the default 10 is not target-aware (§2.8).
16. **After `mix` is written, unreferenced sequences are silent**; without `mix`, sequences run head to
    tail (§2.12).
17. **`loop` continues from the previous pass's end**; it cannot "return every N measures" (§2.12).
18. **A sequence that is not a whole number of measures drifts** a little more on every pass (§4.3).
19. **Same instrument + same instant + same pitch** only adds amplitude (two in-phase oscillators,
    about +6 dB); it does not sound thicker. Change the pitch or the timbre to thicken (§4.2).
20. **Aliases compile with a warning**; write canonical names, and remember `depth` / `from` / `to` mean
    different things in different effects (§2.11).

---

## 4. Structural discipline

> **Looping the same material twice is "repetition"; changing the material is "development".**
> Parameterisation makes copy-paste extremely cheap, which is exactly why it is the most abused tool.

### 4.1 `loop=N` is not development

Spreading a 4-measure passage over 8 measures with `loop=2` gives **identical** pitches, durations and
direction. The jitter seed includes the loop index, so each pass differs microscopically, but what you
hear is still "the same sentence said twice".

**To create development, write a second piece of material.** The difference between restatement and
development is structural and cannot be made up with parameter tweaks (velocity, pan, filtering): those
only change how loud the identical thing is. To check whether you are being lazy, ask **"is there a single
new note in the second pass?"** If not, it is restatement.

### 4.2 Replace, do not stack

When expressing an "escalation of state", the new material should **take over from** the old, not sound
at the same time as it.

Counter-example: a slow heartbeat looped across the whole piece with a fast heartbeat added on top at
some point. The result is not "the heart rate rose" but two heartbeats at once — the low end turns to mud
and "faster" is cancelled by its own slow version.

**Rule: two materials that express a change of state must not overlap in time.** Put the hand-over on a
structural boundary.

Likewise, if two parts differ by only a few semitones and occupy the same frequency band, sounding them
together only masks both, and identical pitch on the same instrument merely adds amplitude (§3, item 19).
**Keep one part per frequency band**; to thicken, work on that part's pitches instead of adding another.

### 4.3 The structure must be arithmetically checkable

Every section's duration must be an **integer multiple of the base unit** (measure, second, frame).
Otherwise loop continuation accumulates drift pass after pass, and after a few passes everything is
misaligned — with no error raised.

How to check: list each sequence's durations, sum them, and confirm the total equals the intended length.

```
1n + 8n + 2n. + 4n = 4 + 0.5 + 3 + 1 = 8.5 beats   ← not a whole measure
```

Then check the `mix` timeline. A sequence of M measures with `loop=k` occupies M×k measures, so the next
track for that part starts at `time="(M*k)m"` counted from the first track's `time`. In the §2.1 skeleton,
`pad_a` is 2 measures × `loop=2` = 4 measures, and `melody_b` starts at `"2m"` because `melody_a` is 2
measures long.

This class of error is very common in drafts written by feel and never summed. **Summing each section once
while rewriting is the cheapest, highest-yield check available.**

### 4.4 The ending must be designed, not left to run out

Once the material fills the duration, the last section is usually just "another loop". Write it
separately: how the final section is handled (silence, a single remaining part, no resolution, an extended
tail) decides where the whole piece comes to rest.

Concretely, write a separate piece of material for the final section instead of letting the previous one
`loop` to the end. The cost is a few repeated lines; the reward is a real ending.

### 4.5 A round-based plan for iteration

When iterating a piece made of equal-length rounds, restructure it as follows. This procedure repaired a
piece whose four rounds were byte-identical accompaniment:

1. **Split the timeline into rounds** and name each (`Ⅰ statement → Ⅱ entry → Ⅲ high point → Ⅳ close`).
   Write that map into the header comment so the structure is readable without playing it.
2. **Name the material by round**: `*_a` for opening material, `*_b` for developed material, `*_end` for
   closing material. Renaming the old material to `*_a` is part of the fix, not cosmetic: it makes the
   `mix` block read as a section map.
3. **Keep exactly one invariant layer** — typically the bass pedal, which carries the harmonic skeleton —
   and let it run across the earlier rounds (`loop=3`). State in a comment that this layer is deliberately
   static, the reference ground for the development above it. Everything else changes per round.
4. **Change a different parameter per round** so the development is audible, not merely present on paper:
   register (raise the whole bed a third), contour (`up` → `upDown`), rhythm (single → double strokes),
   density (arpeggios drop out in the final round).
5. **Give the final round a cadence and a tail**: end on the tonic, drop the busiest part, and let the
   last note cross the barline with `gate=1.4`–`1.5` so it bleeds into the reverb tail instead of
   stopping dead.
6. **Verify each sequence sums to the same whole number of measures**, then verify the `mix` timeline with
   the `loop` semantics of §2.12: consecutive tracks for the same part start exactly where the previous
   one ends, and no part is left uncovered.

---

## 5. Rewriting procedure

### 5.1 Extract the intent first, then touch the syntax

An old draft often has dated syntax but readable intent. Do the rewrite in two separate steps:

1. **Extract the intent**: what is this passage trying to express? (crescendo, silence, counterpoint,
   close …)
2. **Re-implement in SPG**: same intent, new implementation.

Skipping step 1 degenerates into translating the old spelling sentence by sentence into the new one, and
the detours the old syntax forced (copy-pasted passages, layers faked with time offsets) are inherited
unchanged.

**How to spot an artefact of the old syntax**: the same content copied several times with one or two
parameters changed usually means the old syntax lacked a loop or variation mechanism. That repetition is
what the rewrite should remove — but afterwards check against §4.1: did you really restate with `loop`,
or did you write two pieces of material?

### 5.2 Item-by-item checklist

After writing, walk **every** construct in the file:

- [ ] The parameter name is in the whitelist (spelling, singular/plural, underscores)
- [ ] The value is within the range the implementation allows (especially > 0, 0~1, enum values)
- [ ] The field has a consumer, rather than being "parsed but never read"
- [ ] Duration and length units match `parseDuration` (beats, seconds, milliseconds, measures); `mix`
      `time` values are in the unit you intended
- [ ] Quotes, separators and comment markers match the implementation's tokenisation
- [ ] Ordering parameters (`direction`, `pattern`, `up` / `down`) were confirmed against those exact lines
- [ ] No combination the implementation rejects ("A requires B", noise + `harmonics`, `fm_ratio` ≤ 0)
- [ ] Every sequence's durations sum to a whole number of measures (§4.3)
- [ ] Every `sequence` is referenced by some `track`, or `mix` is deliberately omitted
- [ ] Every comment containing a number or direction word was re-verified (§6)

---

## 6. Comment discipline

> **A comment is not evidence. A comment you wrote in a previous round even less so.**
> The most dangerous thing in a script is not a syntax error (that raises an error) but **a comment whose
> claimed behaviour contradicts what the engine does**: it raises nothing, warns nothing, and makes the
> next reader (including you) decide on a false premise.

### 6.1 Two defect classes, verified separately

| Class | Symptom | How to find it |
|---|---|---|
| **Numeric** | Seconds / frequencies / ratios in the comment do not match reality | Recompute against the implementation and put the formula in the comment |
| **Directional** | The comment says "ascending / brighter / decreasing" but the opposite happens | Read the implementation's branches and confirm which path runs |

Directional defects cluster around ordering parameters (§2.9) and compressed parameters (§6.2).

**Rule: whenever a comment contains a concrete number or a direction word, you must be able to point at
the line in the implementation that corresponds to it.** If you cannot, delete the number and replace it
with a qualitative statement.

### 6.2 The value you write ≠ the value you hear

Implementations routinely contain "compress proportionally", "truncate at the ceiling" and "clamp to
range" logic, so the written number differs from what sounds.

The most insidious numeric case: when an envelope's `a + d` exceeds the note duration, both are
**compressed proportionally**, so a comment claiming a "3.5 second attack" may really describe 2.4
seconds (worked through in §2.6). **Either adjust the value so it is not compressed, or say in the comment
that it will be** — both are acceptable; pretending it does not happen is not.

### 6.3 Treat your own previous comments as objects under review

When iterating the same file, the errors most likely to survive are **the comments you wrote last
round**. They look "already reviewed" and get skipped.

Practical method: before each round, grep out every comment line containing a **concrete number, a
direction word or a comparison word** ("higher than", "lower than", "only") and re-verify each against the
current implementation. After you change a parameter, one of them has almost certainly gone stale.

**Change one thing, search globally**: if a part's register moved, every comment saying "an octave higher"
or "the lowest note is X" must be recomputed. Such comments are scattered across the file and will not
announce themselves because you edited one line.

### 6.4 Do not use "the original draft" as a frame of reference

Sentences like "the original wrote this as …" or "an octave above the old C3" have no value for a reader:
the original may have been deleted, renamed, or simply not be at hand. **Write only the technical reason
for the current implementation** ("C3 would collide with the sustained note on the same pitch, so C4"),
never "changed from where".

---

## 7. Naming: grow the name out of the structure

When naming a work, **do not use an emotion label** ("sorrowful", "horrific", "furious"): it draws the
conclusion on the audience's behalf and fits any work of the same kind.

**Take a concrete, verifiable fact from the structure as the name** — a part that never moves, a cadence
that never resolves, a number that keeps recurring. (For instance, a piece whose bass never leaves one
pitch across four rounds could be called "Four Rounds, One Bass Note".) Such a name:

- does not require the audience to know in advance what emotion is intended;
- explains by itself what happens in the work;
- cannot be applied to a different work.

Naming and the file name are two separate things: when renaming, update the title and the explanatory
comments inside the file, **but do not change the content just because of a rename**.

---

## 8. Verification boundary

`npm run test:spg` (= `node test/index.js`) compiles the modules listed in `test/tsconfig.json` —
`app/renderer/services/AudioService.ts`, `SpgAiService.ts`, `LogService.ts`, `SearchService.ts`,
`shared/ai/AiService.ts`, `shared/core/**`, `shared/meta/**` and some `extension/src/**` files — into
`test/build/`, then runs the engine and compatibility cases. **It does not read any script under
`.spg/`** (verified: no `.spg` reference in `test/index.js`).

Therefore **a hand-written SPG script is permanently in the "not executed" state** unless someone pastes
it into the GUI to compile it. The correct wording on delivery is "checked item by item against the
implementation, not executed", never "verified" (see `verification-discipline`).
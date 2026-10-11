---
name: project-workspace-and-commit
description: Applies to this project only (the-play, D:\the-play). Covers the real directory layout and the exact paths of the SPG engine, the SPG system prompt and the Electron main process; the fact that `git_commit` runs `git add -A` and therefore sweeps in unrelated changes that must be reported every time; and the applicability boundary of the `test` and `typecheck` tools.
whenToUse: When creating or modifying any file in the-play, when calling `git_commit`, when locating the SPG engine or the SPG system prompt, or when deciding whether a given verification path is even possible.
---

# Workspace and commit discipline for this project

## 1. Directory responsibilities — use these exact paths

**The paths below are the real ones. `services/AudioService.ts` does not exist.** Getting this
wrong is not a cosmetic problem: `grep` on a non-existent path aborts with

```
rg: D:\the-play\services\AudioService.ts: IO error for operation on
D:\the-play\services\AudioService.ts: 系统找不到指定的路径。 (os error 3)
```

and the call is wasted. When unsure, run `glob "**/AudioService.ts"` first — it resolves in one call.

| Path | Responsibility |
|---|---|
| `app/renderer/services/AudioService.ts` | **Sole authority for the SPG language** (~5383 lines): `SPGParser`, `EventScheduler`, `AudioSynthesizer`, `BrowserAudioEngine`, `DRUM_SPECS`, `PRESETS` |
| `app/renderer/services/SpgAiService.ts` | Holds the SPG system prompt: `SPG_SYSTEM_PROMPT` (line 92), applied via `withSyntaxDoc` (line 471) and `system: SPG_SYSTEM_PROMPT` (line 504). It is documentation and **may lag the implementation** |
| `shared/ai/AiService.ts` | A separate AI service — **not** the SPG prompt. Do not confuse it with `SpgAiService.ts` |
| `app/renderer/services/LogService.ts`, `SearchService.ts` | Other renderer services |
| `app/main/main.js` | Electron main process (~3483 lines). Contains `handleSpgSave` (line 1988), registered as `ipcMain.handle('spg-save', handleSpgSave)` (line 2015) |
| `app/renderer/` | Renderer: `App.tsx`, `index.tsx`, `components/` (`AudioPanel.tsx`, `GalleryPanel.tsx`, `PlayPanel.tsx`, `TorrentPanel.tsx`, `Floating.tsx`), `orb/` |
| `shared/core/`, `shared/meta/`, `shared/ai/` | Shared modules consumed by both renderer and tests |
| `extension/` | Browser extension (`extension/src/agent/**`, `extension/src/shared/**`) |
| `.spg/` | SPG script drop directory |
| `test/` | `test/index.js` is the entry point; each `*.test.js` is a regression suite; `test/build/` is compiled output |

`package.json` facts worth knowing: `"main": "app/main/main.js"`, `"test:spg": "node test/index.js"`,
`"typecheck": "tsc --noEmit && tsc --noEmit -p extension/tsconfig.json"`.

`.spg/` file names carry a timestamp (`${projectName}_${ISOtimestamp}.spg`), so regenerating the same
project never overwrites itself. But **the user has hand-curated these files** (renamed, de-duplicated,
copies moved away) — current contents are mixed `.txt` and `.spg`, e.g. `忧伤_钢琴.txt`, `压抑恐怖.txt`,
`未落.txt`, `原地.txt`, `三圈半.txt`, `美好世界.spg`, `微光.txt`. Do not assume a naming rule — use
`glob` to see what is actually there.

### Why the drop file is written by the main process

The renderer has no filesystem permission, so `handleSpgSave` writes it. The target uses
`app.getAppPath()` rather than `__dirname`, because after packaging `__dirname` is inside the read-only
`app.asar` archive. In development `getAppPath()` is the project root, i.e. `D:\the-play\.spg`.
A failed write **does not affect the generated result** (it is already in the editor); it only means no
archive copy was kept.

---

## 2. `git_commit` sweeps in unrelated changes

The `git_commit` tool is equivalent to `git add -A && git commit -m 更新`. It **takes no arguments and
cannot commit a selected file**.

Consequence: any pre-existing uncommitted change in the workspace (someone else's refactor, another
session's edits) is committed along with yours, under the fixed message `更新`.

**After every call, compare the `N files changed` in the output against the number of files you
actually touched.** If they differ, state in the report that "the commit swept in changes that were not
part of this task" and name the files. Do not assume those changes are yours, and do not explain them
just because they ended up inside your commit.

The line-ending warning (`LF will be replaced by CRLF`) is only a notice and does not mean the content
changed.

The tree can change **during** a session, not just between sessions. Observed in one session: the first
call returned `nothing to commit, working tree clean` (exit code 1), and after the edits the next call
reported `2 files changed` where only one file was mine — the extra one,
`app/renderer/services/SpgAiService.ts`, had been modified concurrently by something outside the session.

`git_commit` has a second use: **creating a recovery point for new or untracked files.** Call it once
before a batch of edits, so a bad edit can be reverted. When the tree is clean it returns
`nothing to commit` (exit code 1) — that is itself a useful signal: there are no unsaved changes.

---

## 3. Applicability boundary of `test` and `typecheck`

**The `test` tool does not read scripts under `.spg/`** (see `spg-coding` section 8). It runs the whole
suite in `test/`, entry point `test/index.js`. So when delivering an SPG script the correct wording is
"checked item by item against `app/renderer/services/AudioService.ts`, not executed", never "verified".

`typecheck` runs `tsc --noEmit` (plus the extension project) and is only meaningful for this project's
TypeScript. Editing `.txt` / `.spg` scripts cannot change its result, so there is no reason to call it then.

---

## 4. Do not assume the workspace is as you left it

This project's workspace **is modified concurrently outside the session**. Already observed:

- a delivered `.txt` file moved (project root → `.spg/`) or renamed;
- the user renaming files to the work's title (`忧伤_钢琴_优化版.txt` → `未落.txt`,
  `压抑恐怖 (2).txt` → `原地.txt`);
- `components/AudioPanel/` being collapsed into a single `app/renderer/components/AudioPanel.tsx`.

**Run `glob` before acting to confirm the file's current location and name.** On an instruction like
"iterate X", do not read from the path you remember — look it up first. A file not being where you expect
is normal, not an anomaly.

When the user explicitly says "it has been renamed to X", go straight to the new name; only fall back to
`glob` listing the directory if that fails. Do not assume the rename failed and do not rename it back.

---
name: project-workspace-and-commit
description: 仅适用于本项目（the-play，D:\the-play）。讲清目录职责、SPG 脚本的落盘位置、`git_commit` 工具会 `git add -A` 从而捎带无关改动这一必须每次上报的行为，以及 `test` 与 `typecheck` 两个工具在本项目的适用边界。
whenToUse: 在 the-play 里新建或修改任何文件、调用 `git_commit`、或需要判断某条验证路径是否可行时。
---

# 本项目的工作区与提交纪律

## 一、目录职责

| 路径 | 职责 |
|---|---|
| `services/AudioService.ts` | **SPG 语言的唯一权威**（约 5400 行）：`SPGParser`、`EventScheduler`、`AudioSynthesizer`、`BrowserAudioEngine`、`DRUM_SPECS`、`PRESETS` |
| `services/AiService.ts` | 生成 SPG 的系统提示词（`SPG_SYSTEM_PROMPT` 附近）。是文档，**可能落后于实现** |
| `.spg/` | SPG 脚本的落盘目录。`electron/main.js` 的 `handleSpgSave` 用 `app.getAppPath()/.spg`，开发时即 `D:\the-play\.spg` |
| `test/` | `test/index.js` 是入口；各 `*.test.js` 是回归套件 |
| `components/` `hooks/` `electron/` | UI、渲染层 hook、主进程 |

`.spg/` 下的文件名带时间戳（`${工程名}_${ISO时间戳}.spg`），同一工程反复生成不会互相覆盖。
但**用户手工整理过这些文件**（改名、去重、移走副本），所以不要假设命名规律 ——
用 `glob` 看当前实际内容。

### 生成物落盘为什么在主进程

渲染层没有文件系统权限，所以由 `handleSpgSave` 落盘；落点用 `app.getAppPath()`
而不是 `__dirname`，因为打包后 `__dirname` 在只读的 `app.asar` 内。
写盘失败**不影响生成结果**（生成物已在编辑器里），只是没留档。

---

## 二、`git_commit` 会捎带无关改动

`git_commit` 工具等价于 `git add -A && git commit -m 更新`。它**没有参数、无法只提交指定文件**。

后果：工作区里任何既有的未提交改动（其他人在做的重构、别的会话留下的修改）
都会被一起提交，且提交信息固定为「更新」。

**每次调用后都要看输出里的 `N files changed`，与本次实际改动的文件数对照。**
不一致就在报告里说明「提交捎带了非本次任务的改动」，并点名文件。
不要默认这些改动是自己做的，也不要因为它们出现在自己的提交里就去解释它们。

行尾警告（`LF will be replaced by CRLF`）只是提示，不代表内容变化。

`git_commit` 的另一个用途：**给新文件或未跟踪文件做恢复点**。
在批量编辑之前调用一次，之后编辑出错就能一行回退。
工作区干净时它会返回 `nothing to commit`（exit code 1）—— 这本身也是有用的信号：
说明当前没有未保存的改动。

---

## 三、`test` 与 `typecheck` 的适用边界

**`test` 工具不读 `.spg/` 下的脚本**（见 `spg-coding` 第八节）。它跑的是 `test/` 目录下的
整套用例（入口 `test/index.js`）。所以交付 SPG 脚本时，正确说法是「逐条对着
`services/AudioService.ts` 核对过，未执行验证」，不是「已验证」。

`typecheck` 跑的是 `tsc --noEmit`，只对本项目的 TypeScript 有效；改 `.txt` / `.spg` 脚本
不会影响它的结果，此时不必调用。

---

## 四、不要假设工作区是你上次离开时的样子

本项目的工作区**在本会话之外被并发修改**。已经观察到：

- 交付过的 `.txt` 文件被移动（根目录 → `.spg/`）或被改名；
- 用户手工改名成作品名（`忧伤_钢琴_优化版.txt` → `未落.txt`，`压抑恐怖 (2).txt` → `原地.txt`）；
- `components/AudioPanel/` 目录被合并成单个 `components/AudioPanel.tsx`。

**动手前先 `glob` 确认文件当前位置与名字。** 收到「迭代 X」这类指令时，
不要按记忆里的路径直接读 —— 先查。文件不在预期位置是常态，不是异常。

用户明确说「已更名为 X」时，直接按新名字找；找不到再用 `glob` 列目录，
不要假设改名失败或去改回旧名。

import type { AgentCompaction, AgentMessage, AiUsage } from '../meta';
import { downloadBlob } from './utils';

/**
 * ============================================================================
 * Agent 会话导出（Markdown 单文件）
 * ============================================================================
 *
 * 导出的是**完整会话**：助手的推理、工具调用的脚本与返回值都在；
 * 推理可以按需去掉（见 AgentExportOptions.includeReasoning）。
 *
 * 段落顺序刻意与界面逐条对齐（助手气泡是「推理 → 正文」，工具卡片是
 * 「摘要 → 推理 → 脚本 → 返回值」）：两边各写一套顺序时，用户复盘
 * 「它当时为什么这么改」会看到两份不一样的记录，而无从判断该信哪个。
 */

/* -------------------------------------------------------------------------- */
/*                                格式化原语                                   */
/* -------------------------------------------------------------------------- */

/** 补零到两位 */
const pad = (value: number): string => String(value).padStart(2, '0');

/** 本地时区时间戳：yyyy-MM-dd HH:mm:ss */
const formatDateTime = (at: number): string => {
    const d = new Date(at);
    const date = [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())].join('-');
    const time = [pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join(':');
    return `${date} ${time}`;
};

/** 只有时刻。段落标题用 —— 日期在文件头已经写过一遍了 */
const formatClock = (at: number): string => formatDateTime(at).slice('yyyy-MM-dd '.length);

/** 文件名里不能出现的字符（Windows 最严格，一次列全）；控制字符一并换掉 */
const UNSAFE_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * 代码围栏：比正文里最长的一串反引号更长。
 *
 * 固定写 ``` 会在两种情况下把导出件写坏 —— Agent 常写生成 Markdown 的脚本，
 * 脚本本身就含 ```；返回值里带代码片段同理。围栏被提前闭合后，
 * 后面的内容会被整段当成代码或正文错位，而导出件看起来"没报错"。
 */
const fenceFor = (text: string): string => {
    const runs: string[] = text.match(/`+/g) || [];
    const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
    return '`'.repeat(Math.max(3, longest + 1));
};

/** 代码块；lang 传空串即不带语法标记 */
const codeBlock = (text: string, lang: string): string => {
    const fence = fenceFor(text);
    return `${fence}${lang}\n${text.replace(/\s+$/, '')}\n${fence}`;
};

/** 引用块：逐行加 ">"，空行写成 ">"，否则引用会在空行处断成两段 */
const blockquote = (text: string): string =>
    text.replace(/\s+$/, '').split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');

/** 推理：折叠起来。一段推理动辄上万字，平铺会把正文彻底淹没 */
const reasoningBlock = (reasoning: string): string =>
    `<details>\n<summary>推理过程</summary>\n\n${blockquote(reasoning)}\n\n</details>`;

/* -------------------------------------------------------------------------- */
/*                                 段落组装                                    */
/* -------------------------------------------------------------------------- */

/** 段落标题：角色 + 关键标记 + 时刻 */
const sectionHeading = (message: AgentMessage, index: number): string => {
    const clock = formatClock(message.at);
    if (message.role === 'user') return `${index}. 用户 · ${clock}`;
    // 压缩分界线既不是模型的发言也不是用户的提问。写成「助手」会让读到这份
    // 导出件的人（以及把它喂给别的模型的用户）以为那是模型说过的话
    if (message.compaction) return `${index}. 上下文压缩 · ${clock}`;
    // 界面自己补的提示不是模型说的话，标题里就得区分开
    if (message.role === 'assistant') return `${index}. 助手${message.notice ? '（界面提示）' : ''} · ${clock}`;
    const label = message.label || message.tool || '未知工具';
    return `${index}. 工具 ${label}${message.ok === false ? '（失败）' : ''} · ${clock}`;
};

/** token 数：只在有实测或估算值时写出来，没有就不占位置 */
const usageLine = (usage: AiUsage | undefined): string | null => {
    if (!usage) return null;
    const approx = usage.estimated ? '~' : '';
    return `token：${approx}${usage.promptTokens} 输入 + ${approx}${usage.completionTokens} 输出 = ${approx}${usage.totalTokens}`
        + `${usage.estimated ? '（本地估算）' : '（服务端实测）'}`;
};

/** 压缩记录的一行摘要说明 */
const compactionLine = (compaction: AgentCompaction): string => {
    const dropped = compaction.coveredMessages - compaction.summarizedMessages;
    return `已压缩 ${compaction.coveredMessages} 条（${compaction.beforeTokens} → ${compaction.afterTokens} token）`
        + `${dropped > 0 ? `，其中 ${dropped} 条超出摘要输入上限被直接丢弃` : ''}`
        + `${compaction.overBudget ? '，**压缩后仍超预算**' : ''}`;
};

/** 一条消息的正文块，顺序与界面一致 */
const sectionBody = (message: AgentMessage, includeReasoning: boolean): string[] => {
    const text = message.content.trim();

    // 压缩消息：正文就是摘要本身，另加一行说明它覆盖了什么
    if (message.compaction) {
        return [`> ${compactionLine(message.compaction)}`, text];
    }

    // 不带思考的导出只掐推理这一块：脚本与返回值是「发生了什么」，
    // 推理是「它当时怎么想的」，后者才是分享时要去掉的那部分
    const reasoning = includeReasoning && message.reasoning ? [reasoningBlock(message.reasoning)] : [];

    if (message.role === 'tool') {
        const body: string[] = [];
        if (text) body.push(text);
        body.push(...reasoning);
        if (message.script) body.push(`**脚本**\n\n${codeBlock(message.script, 'js')}`);
        // 返回值即使为空也写出来：界面上这张卡片永远有这一栏，
        // 省略会让「没有返回」和「没有这一步」在导出件里长得一样
        body.push(`**返回值**\n\n${codeBlock(message.result || '(空)', 'text')}`);
        const cost = usageLine(message.usage);
        if (cost) body.push(`> ${cost}`);
        return body;
    }

    const body: string[] = [...reasoning];
    if (text) body.push(message.notice ? blockquote(text) : text);
    const cost = usageLine(message.usage);
    if (cost) body.push(`> ${cost}`);
    return body;
};

/** 一条消息 → 一个 Markdown 段落；块之间留空行 */
const messageSection = (message: AgentMessage, index: number, includeReasoning: boolean): string =>
    [`## ${sectionHeading(message, index)}`, ...sectionBody(message, includeReasoning)].join('\n\n');

/* -------------------------------------------------------------------------- */
/*                                 对外接口                                    */
/* -------------------------------------------------------------------------- */

/** 会话标题：第一条用户提问压成一行，用作文件名（标题里换行会让文件名带上控制字符） */
const sessionTitle = (messages: AgentMessage[]): string => {
    const first = messages.find((message) => message.role === 'user' && message.content.trim());
    return first ? first.content.replace(/\s+/g, ' ').trim().slice(0, 24) : '未命名会话';
};

/** 导出选项。默认导出完整会话（含推理），关掉推理是为了直接分享 */
export interface AgentExportOptions {
    /**
     * 是否写入推理过程，默认 true。
     *
     * 关掉后文件里连 `<details>` 都不出现，但**文件头会注明"不含推理"** ——
     * 否则读到一份没有推理的记录，人只会以为模型当时没思考。
     */
    includeReasoning?: boolean;
    /**
     * 文件名与文件头共用的时间戳，默认取当前时刻。
     *
     * 必须是同一个时刻：分两次取的话，文件名的时间与文件头写的对不上，
     * 导两份还会出现同名覆盖。
     */
    at?: number;
}

/** 取一次选项，把缺省值补齐（两个 builder 与导出动作对缺省的理解必须一致） */
const resolveOptions = (options: AgentExportOptions): Required<AgentExportOptions> => ({
    includeReasoning: options.includeReasoning !== false,
    at: options.at ?? Date.now(),
});

/**
 * 导出文件名：Agent对话_<标题>_<带思考|不带思考>_<yyyyMMddHHmmss>.md
 *
 * 标记带不带思考是刻意的：两种导出常会被连着一起来一遍，
 * 只靠文件名分不出哪份含推理，事后只能逐个打开翻。
 *
 * 带时间戳同理：落盘路径由下载目录决定、同名自动编号，
 * 不留时间的话一串「Agent对话_xxx (1).md」谁也认不出哪份是新的。
 */
export const buildAgentSessionFileName = (messages: AgentMessage[], options: AgentExportOptions = {}): string => {
    const { includeReasoning, at } = resolveOptions(options);
    const stamp = formatDateTime(at).replace(/[-: ]/g, '');
    const title = sessionTitle(messages).replace(UNSAFE_FILENAME_CHARS, '_');
    return `Agent对话_${title}_${includeReasoning ? '带思考' : '不带思考'}_${stamp}.md`;
};

/** 会话 → Markdown 单文件（推理、脚本、返回值按选项收录） */
export const buildAgentSessionMarkdown = (messages: AgentMessage[], options: AgentExportOptions = {}): string => {
    const { includeReasoning, at } = resolveOptions(options);
    const header = [
        `导出时间：${formatDateTime(at)}`,
        `共 ${messages.length} 条记录`,
        includeReasoning ? '含推理过程' : '不含推理过程',
    ].join(' · ');
    const sections = messages.map((message, index) => messageSection(message, index + 1, includeReasoning));
    return `${['# Agent 会话导出', `> ${header}`, ...sections].join('\n\n')}\n`;
};

/**
 * 导出会话：组内容 + 触发下载（下载动作复用 utils 里的 downloadBlob）。
 *
 * Blob 的 type 带上 charset：Electron 落盘后系统据此选默认打开方式与编码。
 */
export const exportAgentSession = (messages: AgentMessage[], options: AgentExportOptions = {}): void => {
    // 时间戳只在这里取一次：文件名与文件头必须是同一个时刻
    const resolved = resolveOptions(options);
    const blob = new Blob([buildAgentSessionMarkdown(messages, resolved)], {
        type: 'text/markdown;charset=utf-8',
    });
    downloadBlob(blob, buildAgentSessionFileName(messages, resolved));
};

import type { AiToolSpec } from '../../../shared/meta';
import { SANDBOX_ACTIONS, SANDBOX_NODE_TIMEOUT_DEFAULT_MS, SANDBOX_NODE_TIMEOUT_MAX_MS } from '../../../shared/meta';

/**
 * Description conventions used by every tool below:
 *   1. First sentence: what the tool does, in one line.
 *   2. "Use for / Not for": routing between tools, so the model picks the right one.
 *   3. Pitfalls: the mistakes that actually cost a step (irreversible writes, ambiguous keys, ...).
 *   4. Return value: what comes back and what it costs the context.
 * Conditional requirements ("required for X action") live in the parameter descriptions,
 * because the flat schema cannot express them.
 */
const d = (...lines: string[]): string => lines.join('\n');

const JS: AiToolSpec = {
    name: 'js',
    description: d(
        "Run JavaScript in the focused page's main world. It shares memory, globals, cookies and the logged-in session with the page, so the page's own functions and credentialed fetch() work directly.",
        '',
        "Use for: reading page state, calling the page's functions or APIs, inspecting the DOM, quick experiments.",
        'Not for: changing which page you work on (use focus), changes the page must keep receiving (use tamper; an edit made here affects only that one call), raw storage or cookies (use storage), files (use sandbox).',
        '',
        'Fails when nothing is focused yet: call focus first.',
        '',
        'Return value: whatever you return enters the context and is re-sent with every later step. Return only the fields you need, as plain JSON-serializable data (no DOM nodes, functions or circular references). Filter, slice or summarize inside the code instead of returning large objects.',
    ),
    parameters: {
        type: 'object',
        properties: {
            code: {
                type: 'string',
                description:
                    'JavaScript source. Top-level return and await are allowed; main-world globals and credentialed fetch all work. '
                    + 'Use return to hand a value back.',
            },
        },
        required: ['code'],
        additionalProperties: false,
    },
};

const FOCUS: AiToolSpec = {
    name: 'focus',
    description: d(
        'Choose the page you work on. Every tool that touches a page (js, storage, tokens, tamper) acts on the focused page, so call this before them and again whenever you need a different page.',
        '',
        'If a tab with exactly this URL is already open it is reloaded (a clean main world); otherwise a new background tab is opened. Neither steals focus from the user, so they can keep working elsewhere.',
        '',
        'Accepts an absolute URL, a relative path starting with / (resolved against the focused page), or a bare domain (https:// is added). Returns the final URL, which can differ from the requested one (redirects).',
        '',
        'Call it on its own. The page changes underneath any call that reads it in the same batch, so issue js / storage calls in the next step, after focus has returned.',
    ),
    parameters: {
        type: 'object',
        properties: {
            url: { type: 'string', description: 'Absolute URL, a path starting with /, or a bare domain.' },
        },
        required: ['url'],
        additionalProperties: false,
    },
};

const TAMPER: AiToolSpec = {
    name: 'tamper',
    description: d(
        'Engine-level request/response tampering: the only way to change what the page itself receives or sends. Use it whenever the page must keep seeing the modified value. An edit made from js affects that one call only.',
        '',
        'Three rule lists:',
        '- intercept: fields in JSON responses the page receives.',
        '- request: fields in JSON request bodies the page sends.',
        '- headers: request headers.',
        'Pass only the lists you want to change; omitted lists are left untouched.',
        '',
        'Actions: get returns the current rules (call it before set, so you merge instead of duplicating); set merges the rules you pass.',
        '',
        'Rules take effect immediately for matching traffic, but are persisted only when the user clicks "apply" in the panel. If the change has to survive, tell the user to click it.',
    ),
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['get', 'set'],
                description: 'get reads the current rules; set merges the rules you pass.',
            },
            intercept: {
                type: 'array',
                description: 'Response field rules. Omit to leave the existing ones untouched.',
                items: {
                    type: 'object',
                    properties: {
                        enabled: { type: 'boolean', description: 'Whether the rule is active.' },
                        url_pattern: { type: 'string', description: '* for every URL, or a substring of the URL.' },
                        key: {
                            type: 'string',
                            description: "The field's own name, i.e. the last key of its JSON path (isVip, not data.user.isVip).",
                        },
                        value: { description: 'Any JSON value. Used when op is set.' },
                        op: { type: 'string', enum: ['set', 'delete'], description: 'set writes value into the field; delete removes the field.' },
                    },
                    required: ['url_pattern', 'key'],
                },
            },
            request: {
                type: 'array',
                description: 'Request body field rules. Omit to leave the existing ones untouched.',
                items: {
                    type: 'object',
                    properties: {
                        enabled: { type: 'boolean', description: 'Whether the rule is active.' },
                        url_pattern: { type: 'string', description: '* for every URL, or a substring of the URL.' },
                        key: {
                            type: 'string',
                            description: "The field's own name, i.e. the last key of its JSON path.",
                        },
                        value: { description: 'Any JSON value. Used when op is set.' },
                        op: { type: 'string', enum: ['set', 'delete'], description: 'set writes value into the field; delete removes the field.' },
                    },
                    required: ['url_pattern', 'key'],
                },
            },
            headers: {
                type: 'array',
                description: 'Request header rules. Omit to leave the existing ones untouched.',
                items: {
                    type: 'object',
                    properties: {
                        enabled: { type: 'boolean', description: 'Whether the rule is active.' },
                        url_pattern: { type: 'string', description: '* for every URL, or a substring of the URL.' },
                        name: { type: 'string', description: 'Header name.' },
                        value: { type: 'string', description: 'Header value. An empty string deletes the header.' },
                    },
                    required: ['url_pattern', 'name', 'value'],
                },
            },
        },
        required: ['action'],
        additionalProperties: false,
    },
};

const STORAGE: AiToolSpec = {
    name: 'storage',
    description: d(
        'Read and write localStorage, sessionStorage and cookies directly. It bypasses the tamper engine, so you always see the real stored values.',
        '',
        'Use for: inspecting or editing stored state (login flags, cached settings, cookies). To change what the page receives from the network, use tamper instead.',
        '',
        'Start with get to list what exists and to learn the exact key identifiers. A cookie key carries its domain and path: pass back exactly what get returned. A bare cookie name is ambiguous and may hit the wrong cookie.',
    ),
    parameters: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['get', 'set', 'delete'] },
            area: { type: 'string', enum: ['local', 'session', 'cookie'], description: 'Which store to act on.' },
            key: {
                type: 'string',
                description: 'Required for set and delete. For a cookie, the exact key that get returned.',
            },
            value: {
                type: 'string',
                description: 'Required for set; always a string (stringify JSON first). To store an empty string, pass "" explicitly.',
            },
        },
        required: ['action', 'area'],
        additionalProperties: false,
    },
};

const TOKENS: AiToolSpec = {
    name: 'tokens',
    description: d(
        'Inspect and rewrite JWTs.',
        '',
        '- find: scan localStorage, sessionStorage and cookies for JWTs. Reports where each one lives; reuse those area / key values to write back.',
        '- decode: parse a token into header and payload. Needs token.',
        '- rewrite: merge changes into the payload. Needs token and changes. To write the result back, also pass area and key.',
        '',
        'A rewritten token has an invalid signature. That is inherent to this kind of debugging: it is useful for testing client-side behaviour driven by claims (role, plan, exp, ...), not for getting a server to accept the token.',
    ),
    parameters: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['find', 'decode', 'rewrite'] },
            token: { type: 'string', description: 'The JWT. Required for decode and rewrite.' },
            changes: {
                type: 'object',
                description: 'rewrite: fields to merge into the JWT payload.',
                additionalProperties: true,
            },
            area: { type: 'string', enum: ['local', 'session', 'cookie'], description: 'rewrite: where to write the new token back.' },
            key: { type: 'string', description: 'rewrite: the storage key or cookie key that find returned.' },
        },
        required: ['action'],
        additionalProperties: false,
    },
};

const SANDBOX: AiToolSpec = {
    name: 'sandbox',
    description: d(
        'Local sandbox: files plus script execution. It is your only disk access; everything outside the sandbox root is invisible and unwritable.',
        '',
        'Main actions (the action enum is the full list):',
        '- read: return the whole file. Never truncated.',
        '- write: create a file, or replace one completely, with content.',
        '- edit: replace one snippet (old -> new) in an existing file.',
        '- lines: replace a line range (start..end) with content.',
        '- checkjs: syntax-check the JS source in content. Takes no path.',
        '- node: run the file at path.',
        '',
        'Rules:',
        '- To change an existing file, use edit (or lines). Do not read it and write it back in full: a full rewrite silently drops whatever you did not carry over. Use write only for new files or a deliberate full replacement.',
        '- Always pass content to write. An omitted content empties the file.',
        '- edit: old must match verbatim (indentation included) and occur exactly once. If it is not unique, extend it with a neighbouring line.',
        '- node: timeout only sets how long to wait. Which file runs is decided by path alone.',
    ),
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: [...SANDBOX_ACTIONS],
                description: 'Which file operation to perform.',
            },
            path: {
                type: 'string',
                description: 'POSIX-style path relative to the sandbox root, e.g. out/notes.md. Required for every action except checkjs.',
            },
            content: {
                type: 'string',
                description:
                    'write: the full text to write. lines: the replacement text for the range. '
                    + 'checkjs: the JS source to check. Never omit it for these actions.',
            },
            old: {
                type: 'string',
                description: 'edit: the text to replace. Must match verbatim (indentation included) and be unique in the file; extend it with a neighbouring line when it is not.',
            },
            new: { type: 'string', description: 'edit: the replacement text. An empty string deletes the matched segment.' },
            start: { type: 'number', description: 'lines: 1-based first line of the range.' },
            end: { type: 'number', description: 'lines: 1-based last line of the range (inclusive). Omit to replace only start.' },
            timeout: {
                type: 'number',
                description: `node: how long to wait, in ms. Default ${SANDBOX_NODE_TIMEOUT_DEFAULT_MS}, capped at ${SANDBOX_NODE_TIMEOUT_MAX_MS}. It never changes which file runs.`,
            },
        },
        required: ['action'],
        additionalProperties: false,
    },
};

export const AGENT_TOOLS: AiToolSpec[] = [JS, FOCUS, TAMPER, STORAGE, TOKENS, SANDBOX];
import type { AiToolSpec } from '../../../shared/meta';
import { SANDBOX_ACTIONS, SANDBOX_NODE_TIMEOUT_DEFAULT_MS, SANDBOX_NODE_TIMEOUT_MAX_MS } from '../../../shared/meta';

const JS: AiToolSpec = {
    name: 'js',
    description:
        'Run JavaScript in the current page\'s main world. Shares memory, cookies, globals and the '
        + 'logged-in session with the page, so the page\'s own functions are callable directly. '
        + 'Return an explicitly serializable value; whatever you return enters the context and is '
        + 're-sent with every later step, so return only the fields you need. '
        + 'Never change location.href here — use navigate.',
    parameters: {
        type: 'object',
        properties: {
            code: {
                type: 'string',
                description:
                    'JavaScript source. `return` is allowed at top level; await, main-world globals and '
                    + 'credentialed fetch all work.',
            },
        },
        required: ['code'],
        additionalProperties: false,
    },
};

const NAVIGATE: AiToolSpec = {
    name: 'navigate',
    description:
        'Go to a URL. A relative path resolves against the current page; a bare domain gets https://. '
        + 'Returns the final normalized URL after load. Never mix it into the same batch as calls that '
        + 'read the page — the page changes underneath them.',
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
    description:
        'Engine-level request/response tampering — the only way to change what the page itself receives. '
        + 'Editing a value from js affects that one call only; anything the page must keep receiving goes '
        + 'through this tool. Changes take effect immediately but are only persisted when the user clicks '
        + '"apply" in the panel.',
    parameters: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['get', 'set'], description: 'get reads current rules; set merges the ones you pass.' },
            intercept: {
                type: 'array',
                description: 'Response field rules. Omit to leave the existing ones untouched.',
                items: {
                    type: 'object',
                    properties: {
                        enabled: { type: 'boolean' },
                        url_pattern: { type: 'string', description: '* or a substring of the URL' },
                        key: { type: 'string', description: 'field name; the last key of the JSON path' },
                        value: { description: 'any JSON value' },
                        op: { type: 'string', enum: ['set', 'delete'] },
                    },
                    required: ['url_pattern', 'key'],
                },
            },
            request: {
                type: 'array',
                description: 'Request field rules. Omit to leave the existing ones untouched.',
                items: {
                    type: 'object',
                    properties: {
                        enabled: { type: 'boolean' },
                        url_pattern: { type: 'string' },
                        key: { type: 'string' },
                        value: { description: 'any JSON value' },
                        op: { type: 'string', enum: ['set', 'delete'] },
                    },
                    required: ['url_pattern', 'key'],
                },
            },
            headers: {
                type: 'array',
                description: 'Request header rules. An empty value deletes the header.',
                items: {
                    type: 'object',
                    properties: {
                        enabled: { type: 'boolean' },
                        url_pattern: { type: 'string' },
                        name: { type: 'string', description: 'header name' },
                        value: { type: 'string', description: 'empty string deletes the header' },
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
    description:
        'Raw storage and cookie access, bypassing the tamper engine — you read the real values. '
        + 'A cookie key must be the exact identifier get returned (it carries domain/path); a bare name '
        + 'is ambiguous.',
    parameters: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['get', 'set', 'delete'] },
            area: { type: 'string', enum: ['local', 'session', 'cookie'] },
            key: { type: 'string', description: 'required for set / delete; for a cookie it is the key get returned' },
            value: { type: 'string', description: 'required for set. To write an empty string pass "" explicitly.' },
        },
        required: ['action', 'area'],
        additionalProperties: false,
    },
};

const TOKENS: AiToolSpec = {
    name: 'tokens',
    description:
        'JWT inspection and rewriting. find scans local/session storage and cookies; rewrite merges fields '
        + 'into the payload — that invalidates the server signature, which is the inherent premise of this '
        + 'kind of debugging.',
    parameters: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['find', 'decode', 'rewrite'] },
            token: { type: 'string', description: 'required for decode / rewrite' },
            changes: {
                type: 'object',
                description: 'fields to merge into the JWT payload',
                additionalProperties: true,
            },
            area: { type: 'string', enum: ['local', 'session', 'cookie'], description: 'where to write back' },
            key: { type: 'string', description: 'the storage key / cookie key find returned' },
        },
        required: ['action'],
        additionalProperties: false,
    },
};

const SANDBOX: AiToolSpec = {
    name: 'sandbox',
    description:
        'Local sandbox: files and script execution. It is the only disk access you have; the rest of the '
        + 'filesystem is invisible and unwritable. Change an existing file with edit, never read + full '
        + 'write — a full rewrite silently drops what you did not read. read and write never truncate, so '
        + 'any file comes back whole and can be edited whole.',
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
                    'write: the text to write. lines: the replacement text for that line range. '
                    + 'checkjs: the JS source to check. Never omit it — an omitted content on write would empty the file.',
            },
            old: {
                type: 'string',
                description: 'edit: text to replace, must match verbatim (indentation included) and be unique. Extend it with a neighbouring line when it is not.',
            },
            new: { type: 'string', description: 'edit: replacement text. An empty string deletes that segment.' },
            start: { type: 'number', description: 'lines: 1-based first line of the range' },
            end: { type: 'number', description: 'lines: 1-based last line of the range. Omit to replace only start.' },
            timeout: {
                type: 'number',
                description: `node: wait in ms, default ${SANDBOX_NODE_TIMEOUT_DEFAULT_MS}, capped at ${SANDBOX_NODE_TIMEOUT_MAX_MS}. It only changes how long to wait, never which file runs.`,
            },
        },
        required: ['action'],
        additionalProperties: false,
    },
};

export const AGENT_TOOLS: AiToolSpec[] = [JS, NAVIGATE, TAMPER, STORAGE, TOKENS, SANDBOX];

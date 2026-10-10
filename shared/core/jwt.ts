/**
 * JWT 工具：识别、解码、改写 payload。
 *
 * ## 为什么放在 shared 而不是某个组件里
 *
 * 面板（篡改工具的 tokens 视图）与 Agent 的 `tokens` 工具都要用，
 * 两边各写一份必然漂移 —— 表现为"面板里看到的 payload 和模型看到的不一样"。
 * 它是纯函数，能在 Node 回归测试里直接断言，不必起浏览器。
 *
 * ## 改完签名必然失效
 *
 * `rewriteJwtPayload` 只替换 payload 段，header 与签名段逐字符原样搬运。
 * 签名覆盖的正是 payload，所以改完服务端若验签就会拒绝。
 * **这不是缺陷，是这类调试的固有前提** —— 调用方必须把这句话一并交代给用户。
 */
import type { DecodedJwt } from '../meta';

/**
 * 候选 token 的形状：两段或三段 base64url。
 *
 * 两段也接受：未签名的调试 token 只有 `header.payload`，要求三段会把它们全漏掉。
 * 签名段可以为空串（`a.b.` 合法），所以第三段用 `*` 而不是 `+`。
 */
const JWT_SHAPE = /^[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}(\.[A-Za-z0-9_-]*)?$/;

/** 这个值是否长得像 JWT */
export const looksLikeJwt = (value: string): boolean => JWT_SHAPE.test(value);

/**
 * 从一堆字符串里挑出所有像 JWT 的值，去重且保持出现顺序。
 *
 * Cookie 值常见 `Bearer xxx` 前缀，所以取最后一段再判；非字符串一律跳过。
 */
export const pickJwtCandidates = (values: unknown[]): string[] => {
    const out: string[] = [];
    for (const raw of values) {
        if (typeof raw !== 'string') continue;
        const token = raw.trim().split(/\s+/).pop() || '';
        if (looksLikeJwt(token) && !out.includes(token)) out.push(token);
    }
    return out;
};

/**
 * base64url 段 → 字节。
 *
 * 必须补回 `=` 填充：atob 对长度不是 4 的倍数的输入直接抛
 * InvalidCharacterError，而 JWT 规范要求**去掉**填充 ——
 * 不补的话绝大多数真实 token 都解不开。
 */
const base64UrlToBytes = (segment: string): Uint8Array => {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
};

/** 字节 → base64url（无填充），逐字节拼接而非展开成参数，避免长 payload 爆栈 */
const bytesToBase64Url = (bytes: Uint8Array): string => {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** 拆出 JWT 的三段（签名段可能不存在，返回空串） */
const splitJwt = (token: string): string[] => {
    const parts = String(token || '').trim().split('.');
    if (parts.length < 2 || !parts[0] || !parts[1]) {
        throw new Error('不是有效的 JWT：至少要有 header.payload 两段');
    }
    return parts;
};

/**
 * 解 JWT 的 header / payload。
 *
 * base64url 不能直接 atob 后 JSON.parse：atob 返回的是 Latin-1 字节串，
 * payload 里只要有中文/日文就会变成乱码（实测 `{"name":"张三"}` 解成
 * `{"name":"å¼ ä¸"}`）。必须先还原成 UTF-8 字节再用 TextDecoder 解。
 * 带 emoji 的 payload 在部分实现下还会直接抛 InvalidCharacterError。
 */
export const decodeJwt = (token: string): DecodedJwt => {
    const parts = splitJwt(token);
    const read = (segment: string): unknown =>
        JSON.parse(new TextDecoder('utf-8').decode(base64UrlToBytes(segment)));
    return { header: read(parts[0]), payload: read(parts[1]) };
};

/**
 * 改写 payload 字段并重组 token。
 *
 * **只替换 payload 段**，header 与签名段逐字符原样搬运 —— 重新编码 header
 * 可能改变它的字节形态（键序、空白），而签名是对 `header.payload` 的原始
 * 字节串算的，动 header 会让本来能用的 token 变成另一种坏法。
 */
export const rewriteJwtPayload = (token: string, changes: Record<string, unknown>): string => {
    const parts = splitJwt(token);
    const { payload } = decodeJwt(token);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('payload 不是 JSON 对象，无法按字段改写');
    }

    const merged = { ...(payload as Record<string, unknown>), ...changes };
    const segment = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(merged)));
    return [parts[0], segment, ...parts.slice(2)].join('.');
};

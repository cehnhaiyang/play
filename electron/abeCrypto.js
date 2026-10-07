'use strict';

/**
 * Edge App-Bound Encryption（v20）的**纯解密判据**（主进程侧）。
 *
 * ============================================================================
 * 为什么这一层在主进程目录、而不是 services/
 * ============================================================================
 *
 * 解 cookie 只发生在主进程（渲染层拿不到密钥，也没有 DPAPI/NCrypt）。
 * 本模块**不 require electron** —— 后者让它可以被 test/ 直接
 * require 求值（与 edgeImportService/kbService 同一条边界）。
 *
 * 完整解密链：
 *
 *   Local State 的 `app_bound_encrypted_key`（APPB 前缀）
 *     → SYSTEM 身份 CryptUnprotectData（第一层 DPAPI，见 unwrapAppBoundKey）
 *     → 用户身份 CryptUnprotectData（第二层 DPAPI）
 *     → key blob（`u32 headerLen + header + u32 contentLen + content`）
 *     → 32 字节主密钥
 *     → 解每条 cookie 的 `encrypted_value`（`v20 + 12B iv + ct + 16B tag`）
 *
 * 本机 Edge 154.0.4258.37 的实测形状（Stage 0/1 已验证）：
 *   - key blob 的 content 就是 **32 字节主密钥本身**（`flag 0`，无内层加密）；
 *   - flag 1/2/3 的分支是 Chromium 旧形状（Chrome 133~136 时代），保留做
 *     兼容 —— `aster_app_bound_encrypted_key` 若解出那种形状也能走；
 *   - cookie 明文 = `32 字节随机前缀 + UTF-8 真值`，空值 cookie 的明文
 *     恰好 32 字节（GCM 照样认证通过，真值为空串）。
 *
 * 常量来源：flag1 AES / flag3 XOR 在本机 elevation_service.exe 里原样存在
 * （偏移 3568920 / 3568984，与 Chrome 公开值一致）；cookie 结构见
 * runassu/chrome_v20_decryption。加密原语只用 `globalThis.crypto.subtle`
 *（AES-GCM），零第三方依赖。
 */

/** Local State 里 APPB 字段的 4 字节前缀 */
const APPB_PREFIX = 'APPB';

/** "DPAPI" 前缀是 5 字节 —— v10 的 encrypted_key 剥壳时别数错 */
const DPAPI_PREFIX_LEN = 5;

/** Cookies 表 encrypted_value 的 3 字节前缀 */
const V20_PREFIX = 'v20';

/** AES-256 主密钥长度 */
const AES_KEY_BYTES = 32;

/** GCM nonce 长度 */
const GCM_NONCE_BYTES = 12;

/** GCM tag 长度 */
const GCM_TAG_BYTES = 16;

/** cookie 明文里真值之前的固定前缀长度 */
const COOKIE_VALUE_PREFIX_BYTES = 32;

/**
 * key blob 的 flag 0：content 就是 32 字节主密钥（Edge 154 实测形状）。
 * 不是 Chromium 文档里的值 —— 这是本机实测确认的新形状，见文件头注释。
 */
const KEY_BLOB_FLAG_RAW = 0;

/** key blob 的 flag 1：AES-256-GCM，密钥写死在 elevation_service.exe 里 */
const KEY_BLOB_FLAG_AES = 1;

/** key blob 的 flag 2：ChaCha20-Poly1305（本机 Edge 不出现，见 deriveMasterKey） */
const KEY_BLOB_FLAG_CHACHA = 2;

/** key blob 的 flag 3：AES-256-GCM，密钥经 CNG（"Microsoft Edgekey1"）再 XOR */
const KEY_BLOB_FLAG_CNG = 3;

/**
 * flag 1 的 AES 密钥（elevation_service.exe 内置，Chrome/Edge 同值）。
 * 写死而不是"从二进制里抠"，因为读 Program Files 是部署相关动作，
 * 不该进纯判据层。
 */
const FLAG1_AES_KEY_HEX =
    'B31C6E241AC846728DA9C1FAC4936651CFFB944D143AB816276BCC6DA0284787';

/** flag 3 的 XOR 掩码（elevation_service.exe 内置，Chrome/Edge 同值） */
const FLAG3_XOR_MASK_HEX =
    'CCF8A1CEC56605B8517552BA1A2D061C03A29E90274FB2FCF59BA4B75C392390';

/** hex → 字节；非法输入抛错（调用方按"解不开"处理，不在这里吞） */
function hexToBytes(hex) {
    if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0) {
        throw new Error('hex 长度非法');
    }
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        const byte = parseInt(hex.substr(i * 2, 2), 16);
        if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
            throw new Error(`hex 第 ${i} 字节非法`);
        }
        out[i] = byte;
    }
    return out;
}

/** 字节 → 小写 hex */
function bytesToHex(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
}

/**
 * Local State 的 base64 字段 → 去掉 APPB 前缀的 DPAPI blob。
 * 第一层（SYSTEM DPAPI）必须由主进程解，这里只做剥壳。
 */
function stripAppbPrefix(fieldBase64) {
    if (typeof fieldBase64 !== 'string' || fieldBase64.length === 0) {
        throw new Error('APPB 字段为空');
    }
    // 不用 atob：主进程侧有 Buffer（且 mainstatic 的全局白名单里本来就有它），
    // 这里顺手把 base64 的形状先卡死 —— Buffer.from 遇到非法字符是静默跳过，
    // 不预检的话坏输入会变成"长度对不上的 blob"，报错信息完全走偏。
    if (fieldBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(fieldBase64)) {
        throw new Error('APPB 字段不是合法 base64');
    }
    const raw = Uint8Array.from(Buffer.from(fieldBase64, 'base64'));
    if (raw.length <= APPB_PREFIX.length) {
        throw new Error('APPB 字段过短');
    }
    for (let i = 0; i < APPB_PREFIX.length; i++) {
        if (raw[i] !== APPB_PREFIX.charCodeAt(i)) {
            throw new Error('缺少 APPB 前缀');
        }
    }
    return raw.slice(APPB_PREFIX.length);
}

function readU32LE(buf, offset) {
    return (
        buf[offset] |
        (buf[offset + 1] << 8) |
        (buf[offset + 2] << 16) |
        (buf[offset + 3] << 24)
    ) >>> 0;
}

/**
 * 解析双层 DPAPI 之后的 key blob。
 *
 * 布局：`u32 headerLen + header + u32 contentLen + content`，且
 * `headerLen + contentLen + 8 === 总长`。content 有两种形状：
 *   - 32 字节 → flag 0，主密钥本身（Edge 154 实测）；
 *   - 首字节是 flag 1/2/3 → 旧形状（flag 1/2 载荷 61 字节，
 *     flag 3 载荷 93 字节，见 Chromium elevator.cc）。
 */
function parseKeyBlob(blob) {
    if (!(blob instanceof Uint8Array) || blob.length < 8) {
        throw new Error('key blob 过短');
    }
    const headerLen = readU32LE(blob, 0);
    if (4 + headerLen + 4 > blob.length) {
        throw new Error('key blob header 长度越界');
    }
    const contentLen = readU32LE(blob, 4 + headerLen);
    if (headerLen + contentLen + 8 !== blob.length) {
        throw new Error('key blob 长度字段对不上');
    }
    const content = blob.slice(4 + headerLen + 4);
    if (content.length !== contentLen) {
        throw new Error('key blob 内容长度非法');
    }
    const header = blob.slice(4, 4 + headerLen);

    if (contentLen === AES_KEY_BYTES) {
        return { header, flag: KEY_BLOB_FLAG_RAW, rawKey: content.slice() };
    }

    if (contentLen < 1) {
        throw new Error('key blob 内容为空');
    }
    const flag = content[0];
    const rest = content.slice(1);

    if (flag === KEY_BLOB_FLAG_AES || flag === KEY_BLOB_FLAG_CHACHA) {
        if (rest.length !== GCM_NONCE_BYTES + AES_KEY_BYTES + GCM_TAG_BYTES) {
            throw new Error(`flag ${flag} 载荷长度非法`);
        }
        return {
            header, flag,
            iv: rest.slice(0, 12),
            ciphertext: rest.slice(12, 44),
            tag: rest.slice(44, 60),
            encryptedAesKey: null,
            rawKey: null,
        };
    }

    if (flag === KEY_BLOB_FLAG_CNG) {
        if (rest.length !== AES_KEY_BYTES + GCM_NONCE_BYTES + AES_KEY_BYTES + GCM_TAG_BYTES) {
            throw new Error('flag 3 载荷长度非法');
        }
        return {
            header, flag,
            encryptedAesKey: rest.slice(0, 32),
            iv: rest.slice(32, 44),
            ciphertext: rest.slice(44, 76),
            tag: rest.slice(76, 92),
            rawKey: null,
        };
    }

    throw new Error(`不支持的 key blob flag：${flag}`);
}

/** AES-256-GCM 解密（AAD 为空 —— 这是 Chromium 对这两处载荷的用法） */
async function aesGcmDecrypt(key, iv, ciphertext, tag) {
    if (!(key instanceof Uint8Array) || key.length !== AES_KEY_BYTES) {
        throw new Error('AES 密钥不是 32 字节');
    }
    if (!(iv instanceof Uint8Array) || iv.length !== GCM_NONCE_BYTES) {
        throw new Error('GCM iv 不是 12 字节');
    }
    if (!(tag instanceof Uint8Array) || tag.length !== GCM_TAG_BYTES) {
        throw new Error('GCM tag 不是 16 字节');
    }
    const cryptoKey = await globalThis.crypto.subtle.importKey(
        'raw', key, { name: 'AES-GCM' }, false, ['decrypt'],
    );
    const combined = new Uint8Array(ciphertext.length + tag.length);
    combined.set(ciphertext, 0);
    combined.set(tag, ciphertext.length);
    const plain = await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv }, cryptoKey, combined,
    );
    return new Uint8Array(plain);
}

function xorBytes(a, b) {
    if (a.length !== b.length) {
        throw new Error('XOR 两边长度不一致');
    }
    const out = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) {
        out[i] = a[i] ^ b[i];
    }
    return out;
}

/**
 * 从 key blob 派生 32 字节 v20 主密钥。
 *
 * @param parsed `parseKeyBlob` 的结果
 * @param cngDecrypted 仅 flag 3 需要：主进程用 CNG（"Microsoft Edgekey1"）
 *   解出的 32 字节；flag 0/1 不需要传。
 */
async function deriveMasterKey(parsed, cngDecrypted) {
    if (!parsed || typeof parsed.flag !== 'number') {
        throw new Error('key blob 解析结果非法');
    }
    if (parsed.flag === KEY_BLOB_FLAG_RAW) {
        if (!(parsed.rawKey instanceof Uint8Array) || parsed.rawKey.length !== AES_KEY_BYTES) {
            throw new Error('flag 0 缺少 32 字节主密钥');
        }
        return parsed.rawKey.slice();
    }
    if (parsed.flag === KEY_BLOB_FLAG_AES) {
        const key = hexToBytes(FLAG1_AES_KEY_HEX);
        return aesGcmDecrypt(key, parsed.iv, parsed.ciphertext, parsed.tag);
    }
    if (parsed.flag === KEY_BLOB_FLAG_CNG) {
        if (!(cngDecrypted instanceof Uint8Array) || cngDecrypted.length !== AES_KEY_BYTES) {
            throw new Error('flag 3 需要主进程先做 CNG 解密（32 字节）');
        }
        const mask = hexToBytes(FLAG3_XOR_MASK_HEX);
        const key = xorBytes(cngDecrypted, mask);
        return aesGcmDecrypt(key, parsed.iv, parsed.ciphertext, parsed.tag);
    }
    if (parsed.flag === KEY_BLOB_FLAG_CHACHA) {
        // Edge 154 实测与文档（Chrome 137+ 回到 AES-GCM）都不走这个分支。
        // ChaCha20-Poly1305 在 Node 的 crypto 里是 16 字节 IV 变体，
        // 与这里的 12 字节 nonce 对不上，硬凑等于埋雷 —— 明确报错而不是猜。
        throw new Error('flag 2（ChaCha20）未实现：本机 Edge 不应出现此分支');
    }
    throw new Error(`不支持的 key blob flag：${parsed.flag}`);
}

/**
 * 解一条 cookie 的 encrypted_value。
 *
 * 布局：`v20(3) + iv(12) + ct(变长) + tag(16)`，AAD 为空。
 * 返回的是**带 32 字节前缀的明文**（见文件头注释），真值用
 * `splitCookiePlaintext` + `decodeCookieValue` 取。
 */
async function decryptV20Cookie(masterKey, encryptedValue) {
    if (!(encryptedValue instanceof Uint8Array)) {
        throw new Error('encrypted_value 不是字节串');
    }
    if (
        encryptedValue.length < V20_PREFIX.length + GCM_NONCE_BYTES + GCM_TAG_BYTES ||
        encryptedValue[0] !== V20_PREFIX.charCodeAt(0) ||
        encryptedValue[1] !== V20_PREFIX.charCodeAt(1) ||
        encryptedValue[2] !== V20_PREFIX.charCodeAt(2)
    ) {
        throw new Error('不是 v20 加密的 cookie');
    }
    const iv = encryptedValue.slice(3, 15);
    const ciphertext = encryptedValue.slice(15, encryptedValue.length - GCM_TAG_BYTES);
    const tag = encryptedValue.slice(encryptedValue.length - GCM_TAG_BYTES);
    return aesGcmDecrypt(masterKey, iv, ciphertext, tag);
}

/**
 * 把 `decryptV20Cookie` 的明文切成前缀与真值。
 *
 * 前缀是 32 字节随机量（不是值的一部分）：Stage 1 用真实库验证过，
 * 全部 1326 条里没有任何一条的完整明文是合法 UTF-8，而去掉前缀后
 * 1315 条是完整合法的 cookie 值；剩下 11 条明文恰好 32 字节，
 * 即空值 cookie（GCM 照样认证通过）。
 */
function splitCookiePlaintext(plaintext) {
    if (!(plaintext instanceof Uint8Array) || plaintext.length < COOKIE_VALUE_PREFIX_BYTES) {
        throw new Error('cookie 明文过短');
    }
    return {
        prefix: plaintext.slice(0, COOKIE_VALUE_PREFIX_BYTES),
        valueBytes: plaintext.slice(COOKIE_VALUE_PREFIX_BYTES),
    };
}

/**
 * cookie 值字节 → 字符串。
 *
 * 空值合法（空值 cookie 照样导入，不静默丢弃）。严格 UTF-8 解码，
 * 含 NUL 直接拒绝 —— cookie 值里不该有它，出现说明前缀切分或密钥
 * 错了，宁可报错也不写一条坏 cookie 进会话。
 */
function decodeCookieValue(valueBytes) {
    if (!(valueBytes instanceof Uint8Array)) {
        throw new Error('cookie 值不是字节串');
    }
    if (valueBytes.length === 0) {
        return '';
    }
    let value;
    try {
        value = new TextDecoder('utf-8', { fatal: true }).decode(valueBytes);
    } catch (_e) {
        throw new Error('cookie 值不是合法 UTF-8');
    }
    if (value.indexOf('\u0000') !== -1) {
        throw new Error('cookie 值含 NUL 字符');
    }
    return value;
}

/** 前缀是否"像随机量"（Stage 1 交叉验证用的判据：真值段可解、前缀段不可读） */
function looksLikeRandomPrefix(prefix) {
    if (!(prefix instanceof Uint8Array) || prefix.length !== COOKIE_VALUE_PREFIX_BYTES) {
        return false;
    }
    let nonAscii = 0;
    for (let i = 0; i < prefix.length; i++) {
        if (prefix[i] < 0x20 || prefix[i] > 0x7e) {
            nonAscii++;
        }
    }
    // 32 字节随机量里可打印 ASCII 占一半以上几乎不可能（p < 2^-16 量级）
    return nonAscii >= COOKIE_VALUE_PREFIX_BYTES / 2;
}

module.exports = {
    APPB_PREFIX,
    DPAPI_PREFIX_LEN,
    V20_PREFIX,
    AES_KEY_BYTES,
    GCM_NONCE_BYTES,
    GCM_TAG_BYTES,
    COOKIE_VALUE_PREFIX_BYTES,
    KEY_BLOB_FLAG_RAW,
    KEY_BLOB_FLAG_AES,
    KEY_BLOB_FLAG_CHACHA,
    KEY_BLOB_FLAG_CNG,
    FLAG1_AES_KEY_HEX,
    FLAG3_XOR_MASK_HEX,
    hexToBytes,
    bytesToHex,
    stripAppbPrefix,
    parseKeyBlob,
    aesGcmDecrypt,
    deriveMasterKey,
    decryptV20Cookie,
    splitCookiePlaintext,
    decodeCookieValue,
    looksLikeRandomPrefix,
};

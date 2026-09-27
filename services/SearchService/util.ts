/**
 * ============================================================================
 * 归一化工具
 * ============================================================================
 *
 * 各站点的字段格式互不相同，引擎与 UI 只认归一化后的数字：
 *
 *   体积   "6.6 GiB" / "48.5GB" / "183567938" / "33,343,733,854 bytes"
 *   时间   epoch 秒 / epoch 毫秒 / "2026-09-12 15:45" / "2026/08/28 05:32"
 *   磁链   btih 可能是 40 位 hex，也可能是 32 位 base32（dmhy / animetosho）
 *
 * 这些差异全部在本文件消化。跨站排序只能用数字——按 "1.8 GB" 与 "709.4 MiB"
 * 这类字符串排序毫无意义（字典序里 "1.8 GB" > "709.4 MiB"，而实际相反）。
 */

/** 未知值统一用 -1，与 0 区分开：0 是"确实是零"，-1 是"站点没公布" */
export const UNKNOWN = -1;

/* ------------------------------- HTML 文本 ------------------------------- */

const NAMED_ENTITIES: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    '#39': "'", '#x27': "'", '#x2F': '/', hellip: '…', mdash: '—', ndash: '–',
};

/** 解码 HTML 实体（含数字实体）。解析标题时必须先做，否则标题里会留着 &#39; 这类噪音 */
export function decodeEntities(input: string): string {
    return String(input || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
        if (body.charAt(0) === '#') {
            const isHex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
            const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
            if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
            try {
                return String.fromCodePoint(code);
            } catch (_e) {
                return whole;
            }
        }
        const named = NAMED_ENTITIES[body];
        return named === undefined ? whole : named;
    });
}

/** 去标签 + 解码实体 + 压空白 */
export function stripTags(input: string): string {
    return decodeEntities(String(input || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/* --------------------------------- 体积 --------------------------------- */

const SIZE_UNITS: Record<string, number> = {
    B: 1,
    // 带 i 的是二进制单位（1024），不带的按十进制（1000）。
    // 两者差约 7%，对"按体积排序"没有实质影响，但按字面正确解析更不容易出错。
    KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4, PIB: 1024 ** 5,
    KB: 1000, MB: 1000 ** 2, GB: 1000 ** 3, TB: 1000 ** 4, PB: 1000 ** 5,
};

/**
 * 体积文本 → 字节数。无法解析返回 UNKNOWN。
 * 覆盖实测到的全部形态：
 *   "6.6 GiB"（nyaa） / "48.5GB"（dmhy） / "1.8 GB"（acg.rip）
 *   "183567938"（apibay，纯字节） / "33,343,733,854 bytes"（animetosho 的 title）
 *   "-" / "" / "N/A"（站点未公布）
 */
export function parseSizeBytes(input: string): number {
    const raw = String(input == null ? '' : input).trim();
    if (!raw || raw === '-' || /^(n\/?a|unknown|未知)$/i.test(raw)) return UNKNOWN;

    // 纯数字（可带千分位）：站点直接给了字节数
    const plain = raw.replace(/,/g, '');
    if (/^\d+$/.test(plain)) {
        const n = Number(plain);
        return Number.isFinite(n) && n >= 0 ? n : UNKNOWN;
    }

    // "33,343,733,854 bytes"
    const bytesOnly = raw.match(/^([\d.,]+)\s*bytes?$/i);
    if (bytesOnly) {
        const n = Number(bytesOnly[1].replace(/,/g, ''));
        return Number.isFinite(n) && n >= 0 ? n : UNKNOWN;
    }

    // "6.6 GiB" / "48.5GB" / "1.8 GB"
    const m = raw.match(/([\d.,]+)\s*([KMGTPE]?i?B)\b/i);
    if (!m) return UNKNOWN;
    const value = Number(m[1].replace(/,/g, ''));
    const unit = SIZE_UNITS[m[2].toUpperCase()];
    if (!Number.isFinite(value) || unit === undefined) return UNKNOWN;
    return Math.round(value * unit);
}

/** 字节数 → 人类可读（结果列表用；站点原始文本仍保留在 sizeText 里） */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let v = bytes;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) {
        v /= 1024;
        u += 1;
    }
    return `${v.toFixed(u === 0 ? 0 : v >= 100 ? 0 : 1)} ${units[u]}`;
}

/* --------------------------------- 时间 --------------------------------- */

/**
 * 时间 → epoch 毫秒。无法解析返回 UNKNOWN。
 *
 * epoch 秒与毫秒靠量级区分：秒级现在约 1.7e9，毫秒级约 1.7e12，
 * 阈值取 1e11 可稳定分开两者（1e11 秒是公元 5138 年，1e11 毫秒是 1973 年）。
 */
export function parseTimestamp(input: string | number): number {
    if (input == null || input === '') return UNKNOWN;
    const n = typeof input === 'number' ? input : Number(String(input).trim());
    if (!Number.isFinite(n) || n <= 0) return UNKNOWN;
    return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

/**
 * 日期文本 → epoch 毫秒。无法解析返回 UNKNOWN。
 * 覆盖实测形态：
 *   "2026-09-12 15:45"（nyaa） / "2026/08/28 05:32"（dmhy）
 *   "05/05/2026 20:50"（animetosho，日/月/年）
 */
export function parseDateText(input: string): number {
    const raw = String(input || '').trim();
    if (!raw) return UNKNOWN;

    // 年在前：YYYY-MM-DD / YYYY/MM/DD [HH:mm[:ss]]
    const ymd = raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (ymd) {
        const t = Date.UTC(
            Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]),
            Number(ymd[4] || 0), Number(ymd[5] || 0), Number(ymd[6] || 0)
        );
        return Number.isFinite(t) ? t : UNKNOWN;
    }

    // 日在先：DD/MM/YYYY [HH:mm]（animetosho）
    const dmy = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
    if (dmy) {
        const t = Date.UTC(
            Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]),
            Number(dmy[4] || 0), Number(dmy[5] || 0)
        );
        return Number.isFinite(t) ? t : UNKNOWN;
    }

    const fallback = Date.parse(raw);
    return Number.isFinite(fallback) ? fallback : UNKNOWN;
}

/* -------------------------------- info hash ------------------------------- */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * base32 → 小写 hex。
 *
 * 必需，不是锦上添花：dmhy 与 animetosho 的磁链用的是 32 位 base32 btih
 * （如 7BSRIRFCYCZ767R5UPF5OXNFR327BHQZ），nyaa 与 apibay 用 40 位 hex。
 * 不统一的话，同一资源在两站之间无法识别为同一条，跨站去重直接失效。
 */
export function base32ToHex(input: string): string {
    const s = String(input || '').toUpperCase().replace(/=+$/, '');
    if (!s) return '';
    let bits = 0;
    let value = 0;
    let out = '';
    for (let i = 0; i < s.length; i += 1) {
        const idx = BASE32_ALPHABET.indexOf(s.charAt(i));
        if (idx < 0) return ''; // 非 base32 字符：整体判为无效，不返回半截结果
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bits -= 8;
            out += ((value >>> bits) & 0xff).toString(16).padStart(2, '0');
        }
    }
    return out;
}

/**
 * 从 magnet 链接提取 info hash（小写 hex）。提取不到返回空串。
 * 两种编码都要认，见 base32ToHex 的说明。
 */
export function magnetInfoHash(magnet: string): string {
    const m = String(magnet || '').match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
    if (!m) return '';
    const btih = m[1];
    if (/^[0-9a-fA-F]{40}$/.test(btih)) return btih.toLowerCase();
    if (/^[a-zA-Z2-7]{32}$/.test(btih)) return base32ToHex(btih);
    return '';
}

/** 已知 info hash 时补一条 magnet（apibay 只给 hash，不给磁链） */
export function buildMagnet(infoHash: string, name: string): string {
    if (!infoHash) return '';
    const dn = name ? `&dn=${encodeURIComponent(name)}` : '';
    return `magnet:?xt=urn:btih:${infoHash}${dn}`;
}

/* -------------------------------- 标题归一 -------------------------------- */

/**
 * 标题归一化，仅用于跨站去重的兜底比较（info hash 缺失时）。
 * 去掉大小写、标点、空白差异——同一条资源在不同站的标题常有细微排版差别。
 */
export function normalizeTitle(input: string): string {
    return String(input || '')
        .toLowerCase()
        .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ') // 去掉 [字幕组] (年份) 这类括号段
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

/* --------------------------------- URL --------------------------------- */

/** 把站点给的相对地址补成绝对地址（nyaa 用相对、sukebei 用绝对，两者都要能处理） */
export function absolutize(href: string, base: string): string {
    const s = String(href || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith('//')) return `https:${s}`;
    const origin = String(base || '').replace(/\/+$/, '');
    if (s.startsWith('/')) return `${origin}${s}`;
    return `${origin}/${s}`;
}

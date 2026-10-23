'use strict';
// Hardened drop-in replacement for arena/ws.js.
// Changes vs. the shipped file:
//   * opcode 0 (continuation) is preserved instead of being coerced to 1;
//   * frameMasked() supports the 64-bit length form instead of throwing >65535;
//   * unfragmented messages are no longer re-copied;
//   * frames are appended to a list and joined once per parsed message
//     (no O(n^2) Buffer.concat of the whole receive buffer);
//   * RFC6455 protocol errors are detected: unmasked client frames, stray
//     continuations, data frames interleaved into a fragmented message,
//     fragmented control frames, control payloads >125 bytes, non-minimal
//     length encoding, unexpected RSV bits;
//   * a declared payload length above MAX_MESSAGE is refused with 1009 before
//     the payload is buffered, so a bogus 1 TiB header cannot OOM the process;
//   * UTF-8 validity of text frames is verified (1007) instead of lossy decode.
const crypto = require('crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const NO_STATUS = Buffer.alloc(0);
const MAX_MESSAGE = Number(process.env.WS_MAX_MESSAGE || 32 * 1024 * 1024);

let _fatalUtf8 = null;
function fatalUtf8() {
  if (!_fatalUtf8) _fatalUtf8 = new TextDecoder('utf-8', { fatal: true });
  return _fatalUtf8;
}

function acceptKey(key) {
  return crypto.createHash('sha1').update(String(key) + GUID).digest('base64');
}

function header(op, fin, len, masked) {
  const b0 = (fin ? 0x80 : 0) | op;
  const m = masked ? 0x80 : 0;
  if (len < 126) return Buffer.from([b0, m | len]);
  if (len < 65536) {
    const h = Buffer.alloc(4);
    h[0] = b0; h[1] = m | 126; h.writeUInt16BE(len, 2);
    return h;
  }
  const h = Buffer.alloc(10);
  h[0] = b0; h[1] = m | 127; h.writeBigUInt64BE(BigInt(len), 2);
  return h;
}

function frame(payload, opcode) {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const op = opcode === undefined ? 1 : opcode;
  return Buffer.concat([header(op, true, b.length, false), b]);
}

function frameMasked(payload, opcode) {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const op = opcode === undefined ? 1 : opcode;
  const mask = crypto.randomBytes(4);
  const out = Buffer.from(b);
  for (let i = 0; i < out.length; i++) out[i] ^= mask[i & 3];
  return Buffer.concat([header(op, true, b.length, true), mask, out]);
}

function createParser(onMessage, onClose, opts) {
  // Server role by default: RFC6455 requires every client frame to be masked.
  // Pass { requireMasked: false } when parsing the server side of the socket.
  const requireMasked = !opts || opts.requireMasked !== false;
  const st = {
    chunks: [],       // unconsumed receive chunks
    len: 0,           // total bytes across st.chunks
    frag: null,       // accumulated fragments of the current message
    fragOp: 0,
    fragLen: 0,
    closed: false
  };

  function fail(respond, code, reason) {
    if (st.closed) return;
    st.closed = true;
    try {
      if (respond) {
        let payload = NO_STATUS;
        if (code) {
          payload = Buffer.alloc(2 + Buffer.byteLength(reason || ''));
          payload.writeUInt16BE(code, 0);
          payload.write(reason || '', 2);
        }
        respond(frame(payload, 8));
      }
    } catch (e) {}
    try { onClose(); } catch (e) {}
  }

  st.push = function (chunk, respond) {
    if (st.closed) return;
    if (chunk && chunk.length) { st.chunks.push(chunk); st.len += chunk.length; }
    for (;;) {
      // ---- need at least the 2-byte header ----
      if (st.len < 2) return;
      if (st.chunks[0].length < 2) {
        st.chunks = [Buffer.concat(st.chunks)];
      }
      let head = st.chunks[0];
      const b0 = head[0], b1 = head[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      if (rsv !== 0) return fail(respond, 1002, 'RSV bits set');
      if (requireMasked && !masked) return fail(respond, 1002, 'client frame not masked');

      let len = b1 & 0x7f;
      let off = 2;
      let minimal = true;
      if (len === 126) {
        if (st.len < 4) return;
        if (st.chunks[0].length < 4) st.chunks = [Buffer.concat(st.chunks)];
        len = st.chunks[0].readUInt16BE(2);
        off = 4;
        minimal = len >= 126;
      } else if (len === 127) {
        if (st.len < 10) return;
        if (st.chunks[0].length < 10) st.chunks = [Buffer.concat(st.chunks)];
        const big = st.chunks[0].readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return fail(respond, 1009, 'message too big');
        len = Number(big);
        off = 10;
        minimal = len >= 65536;
      }
      const control = op >= 8;
      if (control && (!fin || len > 125)) return fail(respond, 1002, 'invalid control frame');
      if (!minimal) return fail(respond, 1002, 'non-minimal length encoding');
      if (len > MAX_MESSAGE || (st.fragLen + len) > MAX_MESSAGE) return fail(respond, 1009, 'message too big');

      // ---- need the whole frame ----
      const ml = masked ? 4 : 0;
      if (st.len < off + ml + len) return;
      st.chunks = [Buffer.concat(st.chunks)];
      const b = st.chunks[0];
      const pl = Buffer.from(b.slice(off + ml, off + ml + len));
      if (masked) {
        const mask = b.slice(off, off + 4);
        for (let i = 0; i < pl.length; i++) pl[i] ^= mask[i & 3];
      }
      st.chunks = b.length > off + ml + len ? [b.slice(off + ml + len)] : [];
      st.len = st.chunks.length ? st.chunks[0].length : 0;

      // ---- opcode handling ----
      if (op === 8) {
        try { if (respond) respond(frame(NO_STATUS, 8)); } catch (e) {}
        if (!st.closed) { st.closed = true; try { onClose(); } catch (e) {} }
        return;
      }
      if (op === 9) {
        try { if (respond) respond(frame(pl, 10)); } catch (e) {}
        continue;
      }
      if (op === 10) continue;                       // pong

      if (op === 1 || op === 2) {
        if (st.frag) return fail(respond, 1002, 'data frame during fragmented message');
        if (fin) {
          deliver(op, pl);
        } else {
          st.frag = pl; st.fragOp = op; st.fragLen = pl.length;
        }
        continue;
      }
      if (op === 0) {
        if (!st.frag) return fail(respond, 1002, 'continuation without a start frame');
        st.fragLen += pl.length;
        st.frag = st.frag.length ? Buffer.concat([st.frag, pl]) : pl;
        if (fin) { const op0 = st.fragOp; const full = st.frag; st.frag = null; st.fragLen = 0; deliver(op0, full); }
        continue;
      }
      return fail(respond, 1002, 'reserved opcode ' + op);
    }
  };

  function deliver(op, payload) {
    if (op === 2) return void onMessage(payload);
    let text;
    try { text = fatalUtf8().decode(payload); }
    catch (e) { return fail(null, 1007, 'invalid utf-8'); }
    onMessage(text);
  }

  return st;
}

module.exports = { acceptKey, frame, frameMasked, createParser, MAX_MESSAGE };

'use strict';
const crypto = require('crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
  return crypto.createHash('sha1').update(String(key) + GUID).digest('base64');
}

function frame(payload, opcode) {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const op = opcode || 1;
  let head;
  if (b.length < 126) {
    head = Buffer.from([0x80 | op, b.length]);
  } else if (b.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | op;
    head[1] = 126;
    head.writeUInt16BE(b.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | op;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(b.length), 2);
  }
  return Buffer.concat([head, b]);
}

function frameMasked(payload, opcode) {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const op = opcode || 1;
  const mask = crypto.randomBytes(4);
  let head;
  if (b.length < 126) {
    head = Buffer.from([0x80 | op, 0x80 | b.length]);
  } else {
    head = Buffer.alloc(4);
    head[0] = 0x80 | op;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(b.length, 2);
  }
  const out = Buffer.from(b);
  for (let i = 0; i < out.length; i++) out[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, out]);
}

function createParser(onMessage, onClose) {
  const st = { buf: Buffer.alloc(0), frag: null };
  st.push = function (chunk, respond) {
    st.buf = Buffer.concat([st.buf, chunk]);
    for (;;) {
      const b = st.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        off = 10;
      }
      const ml = masked ? 4 : 0;
      if (b.length < off + ml + len) return;
      const mask = masked ? b.slice(off, off + 4) : null;
      const pl = Buffer.from(b.slice(off + ml, off + ml + len));
      if (mask) for (let i = 0; i < pl.length; i++) pl[i] ^= mask[i & 3];
      st.buf = b.slice(off + ml + len);
      if (op === 8) {
        try { if (respond) respond(frame(Buffer.alloc(0), 8)); } catch (e) {}
        onClose();
        return;
      }
      if (op === 9) {
        try { if (respond) respond(frame(pl, 10)); } catch (e) {}
        continue;
      }
      if (op === 1 || op === 2) {
        if (!fin) { st.frag = st.frag ? Buffer.concat([st.frag, pl]) : pl; continue; }
        const full = st.frag ? Buffer.concat([st.frag, pl]) : pl;
        st.frag = null;
        onMessage(full.toString('utf8'));
      }
    }
  };
  return st;
}

module.exports = { acceptKey, frame, frameMasked, createParser };

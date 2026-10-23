'use strict';
// Shared RFC6455 conformance cases, parameterised by the ws module under test.
// Cases that describe correct behaviour are asserted; cases named BUG* assert the
// CURRENT buggy behaviour, so a fixed module makes them fail (that is the signal).
module.exports = function run(ws) {
  const assert = require('assert');
  const { acceptKey, frame, frameMasked, createParser } = ws;
  const results = [];
  const t = (name, fn) => {
    try { fn(); results.push(['PASS', name]); }
    catch (e) { results.push(['FAIL', name, e.message]); }
  };

  t('acceptKey matches RFC6455 example vector', () => {
    assert.strictEqual(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  t('frame(): small payload = 1-byte length', () => {
    const f = frame('hi');
    assert.deepStrictEqual([...f.slice(0, 2)], [0x81, 2]);
    assert.strictEqual(f.slice(2).toString(), 'hi');
  });
  t('frame(): 200 bytes uses 126 + uint16', () => {
    const f = frame(Buffer.alloc(200, 0x61));
    assert.strictEqual(f[1], 126);
    assert.strictEqual(f.readUInt16BE(2), 200);
    assert.strictEqual(f.length, 4 + 200);
  });
  t('frame(): 70000 bytes uses 127 + uint64', () => {
    const f = frame(Buffer.alloc(70000, 0x61));
    assert.strictEqual(f[1], 127);
    assert.strictEqual(Number(f.readBigUInt64BE(2)), 70000);
    assert.strictEqual(f.length, 10 + 70000);
  });
  t('frame(): server frames must NOT be masked (mask bit clear)', () => {
    assert.strictEqual(frame('x')[1] & 0x80, 0);
  });

  t('frameMasked(): 100 bytes -> 1-byte header carries 0x80|len', () => {
    const f = frameMasked('a'.repeat(100));
    assert.strictEqual(f[1], 0x80 | 100);
    assert.strictEqual(f.length, 2 + 4 + 100);
  });
  t('client frames are always masked', () => {
    assert.strictEqual(frameMasked('x')[1] & 0x80, 0x80);
    assert.strictEqual(frameMasked('x'.repeat(300))[1] & 0x80, 0x80);
  });
  t('frameMasked(): 70000 bytes must use the 64-bit length form', () => {
    const f = frameMasked(Buffer.alloc(70000, 0x61));
    assert.strictEqual(f[1] & 0x7f, 127);
    assert.strictEqual(Number(f.readBigUInt64BE(2)), 70000);
    assert.strictEqual(f.length, 10 + 4 + 70000);
  });
  t('opcode 0 (continuation) is preserved, not coerced to 1', () => {
    assert.strictEqual(frameMasked('x', 0)[0] & 0x0f, 0);
    assert.strictEqual(frame(Buffer.alloc(0), 0)[0] & 0x0f, 0);
  });

  t('parser: one unfragmented masked text frame', () => {
    const got = [];
    const p = createParser((s) => got.push(s), () => {});
    p.push(frameMasked(JSON.stringify({ type: 'hello' })));
    assert.deepStrictEqual(got, ['{"type":"hello"}']);
  });
  t('parser: frame split across TCP chunks (byte-by-byte)', () => {
    const got = [];
    const p = createParser((s) => got.push(s), () => {});
    for (const b of frameMasked('partial-delivery')) p.push(Buffer.from([b]));
    assert.deepStrictEqual(got, ['partial-delivery']);
  });
  t('parser: fragmented message (op1 fin0 + op0 fin1) is delivered', () => {
    const got = [];
    const p = createParser((s) => got.push(s), () => {});
    const first = frameMasked('AAAA', 1);
    first[0] &= 0x7f;                     // FIN=0, opcode=1
    p.push(first);
    p.push(frameMasked('BBBB', 0));       // FIN=1, opcode=0
    assert.deepStrictEqual(got, ['AAAABBBB'], 'got=' + JSON.stringify(got));
  });
  t('parser: ping(9) -> pong(10) with the same payload', () => {
    const sent = [];
    const p = createParser(() => {}, () => {});
    p.push(frameMasked('hb', 9), (f) => sent.push(f));
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0][0] & 0x0f, 10);
    assert.strictEqual(sent[0][0] & 0x80, 0x80, 'pong must have FIN set');
    assert.strictEqual(sent[0].slice(2).toString(), 'hb');
  });
  t('parser: close(8) -> close reply + onClose fired', () => {
    const sent = []; let closed = 0;
    const p = createParser(() => {}, () => { closed++; });
    p.push(frameMasked('', 8), (f) => sent.push(f));
    assert.strictEqual(sent[0][0] & 0x0f, 8);
    assert.strictEqual(closed, 1);
  });
  t('parser: unmasked client frame is a protocol error', () => {
    const sent = []; let closed = 0;
    const p = createParser(() => {}, () => { closed++; });
    p.push(frame('hello'), (f) => sent.push(f));   // unmasked = illegal from a client
    assert.strictEqual(closed, 1, 'must close the connection');
    assert.strictEqual(sent[0] ? sent[0][0] & 0x0f : -1, 8, 'must reply with a close frame');
  });
  t('parser: stray continuation frame is a protocol error', () => {
    let closed = 0;
    const p = createParser(() => {}, () => { closed++; });
    p.push(frameMasked('orphan', 0), () => {});
    assert.strictEqual(closed, 1);
  });
  t('parser: data frame interleaved into a fragmented message is an error', () => {
    let closed = 0; let delivered = 0;
    const p = createParser(() => { delivered++; }, () => { closed++; });
    const first = frameMasked('AAAA', 1); first[0] &= 0x7f;
    p.push(first, () => {});
    p.push(frameMasked('BBBB', 1), () => {});      // new data frame mid-message
    assert.strictEqual(closed, 1);
    assert.strictEqual(delivered, 0);
  });
  t('parser: oversized declared length is refused before buffering it', () => {
    let closed = 0;
    const p = createParser(() => {}, () => { closed++; });
    const head = Buffer.alloc(14);
    head[0] = 0x81; head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(2 ** 40), 2);     // 1 TiB declared, 4 mask bytes follow
    p.push(head, () => {});
    assert.strictEqual(closed, 1);
  });
  t('parser: fragmented control frame is an error', () => {
    let closed = 0;
    const p = createParser(() => {}, () => { closed++; });
    const f = frameMasked('ping', 9); f[0] &= 0x7f;  // FIN cleared on a control frame
    p.push(f, () => {});
    assert.strictEqual(closed, 1);
  });

  return results;
};

const { publicKeyFromKmsDer, signatureFromKmsDer } = require('../src/derUtils');
const { buildDerSpki, buildDerSignature } = require('./derFixtures');

describe('publicKeyFromKmsDer', () => {
  it('extracts exactly the 64-byte point, skipping the algorithm identifier and BIT STRING framing', () => {
    const point = Buffer.alloc(64);
    for (let i = 0; i < 64; i++) point[i] = i; // distinctive, order-sensitive filler — 0,1,2,...63

    const der = buildDerSpki(point);
    const extracted = publicKeyFromKmsDer(der);

    expect(extracted).toEqual(point);
  });

  it('throws if the outer structure is not a SEQUENCE', () => {
    const notASequence = Buffer.from([0x02, 0x01, 0x00]); // an INTEGER, not a SEQUENCE
    expect(() => publicKeyFromKmsDer(notASequence)).toThrow(/Expected outer SEQUENCE/);
  });
});

describe('signatureFromKmsDer', () => {
  it('round-trips r and s values that need no padding (already 32 bytes, high bit clear)', () => {
    const r = Buffer.alloc(32, 0x11);
    r[0] = 0x01; // clear the high bit so no DER sign-byte is added
    const s = Buffer.alloc(32, 0x22);
    s[0] = 0x01;

    const der = buildDerSignature(r, s);
    const { r: rOut, s: sOut } = signatureFromKmsDer(der);

    expect(rOut).toEqual(r);
    expect(sOut).toEqual(s);
  });

  it('strips the DER sign-padding byte when the high bit was set', () => {
    const r = Buffer.alloc(32, 0xff); // high bit set — DER will prepend 0x00
    const s = Buffer.alloc(32, 0x02);
    s[0] = 0x01;

    const der = buildDerSignature(r, s);
    const { r: rOut } = signatureFromKmsDer(der);

    // Even though the DER encoding is 33 bytes for r (0x00 + 32 real
    // bytes), the parsed output must be exactly 32 bytes, matching r —
    // proving the sign byte was stripped, not left in and corrupting
    // the value's length.
    expect(rOut).toEqual(r);
    expect(rOut.length).toBe(32);
  });

  it('left-pads a shorter-than-32-byte integer back to 32 bytes', () => {
    // A small s value — DER's minimal-length rule means leading zero
    // bytes are dropped entirely, so KMS could legitimately return an
    // s encoded in far fewer than 32 bytes for a small-enough value.
    const smallS = Buffer.from([0x01, 0x23]); // 2 raw bytes
    const r = Buffer.alloc(32, 0x05);
    r[0] = 0x01;

    const der = buildDerSignature(r, smallS);
    const { s: sOut } = signatureFromKmsDer(der);

    expect(sOut.length).toBe(32);
    // The real value should be right-aligned — the last 2 bytes are
    // the original value, everything before is zero-padding.
    expect(sOut.subarray(30)).toEqual(smallS);
    expect(sOut.subarray(0, 30)).toEqual(Buffer.alloc(30));
  });
});

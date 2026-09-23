/**
 * Shared DER-construction helpers used by both derUtils.test.js (which
 * needs synthetic, structurally-valid-but-arbitrary fixtures) and
 * kmsSigner.test.js (which wraps REAL cryptographic values — a real
 * generated public key point, a real ECDSA signature — in this same
 * DER framing, to test the signer against genuinely valid crypto rather
 * than arbitrary bytes). Factored out once specifically so both test
 * files exercise identical DER-building logic and can't silently drift
 * into testing against two subtly different fixture shapes.
 */

function derLength(len) {
  if (len >= 0x80) throw new Error('test helper only supports short-form DER lengths');
  return Buffer.from([len]);
}

function buildDerSpki(rawPoint64) {
  const algIdFiller = Buffer.from([0x06, 0x01, 0xaa, 0x06, 0x01, 0xbb]);
  const algIdSeq = Buffer.concat([Buffer.from([0x30]), derLength(algIdFiller.length), algIdFiller]);

  const bitStringValue = Buffer.concat([Buffer.from([0x00, 0x04]), rawPoint64]);
  const bitString = Buffer.concat([Buffer.from([0x03]), derLength(bitStringValue.length), bitStringValue]);

  const outerValue = Buffer.concat([algIdSeq, bitString]);
  return Buffer.concat([Buffer.from([0x30]), derLength(outerValue.length), outerValue]);
}

function buildDerSignature(rBuf, sBuf) {
  const encodeInteger = (buf) => {
    const needsPad = buf[0] & 0x80;
    const value = needsPad ? Buffer.concat([Buffer.from([0x00]), buf]) : buf;
    return Buffer.concat([Buffer.from([0x02]), derLength(value.length), value]);
  };
  const rEnc = encodeInteger(rBuf);
  const sEnc = encodeInteger(sBuf);
  const body = Buffer.concat([rEnc, sEnc]);
  return Buffer.concat([Buffer.from([0x30]), derLength(body.length), body]);
}

module.exports = { buildDerSpki, buildDerSignature };

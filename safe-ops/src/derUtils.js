/**
 * Minimal, hand-written DER (ASN.1) parsing — just enough to read the two
 * specific structures AWS KMS returns for an ECC_SECG_P256K1 key, nothing
 * more general. Same "small, purpose-built, not a general library" choice
 * made for every hand-maintained ABI fragment elsewhere in this project
 * (oracle-service's chainClient.js, the indexer's rpcClient.js, the
 * backend's web3_client.py) — a full ASN.1 parser is a much bigger
 * dependency than two small, well-understood structures actually need.
 *
 * Why this file exists at all: KMS speaks DER because that's the
 * standard encoding for X.509/ECDSA structures across essentially the
 * entire non-blockchain cryptography world. Ethereum speaks raw,
 * fixed-width byte values (a 64-byte public key, a 32-byte r, a 32-byte
 * s). Something has to translate between the two — this is that
 * translation layer, kept deliberately separate from kmsSigner.js so it
 * can be unit-tested with plain byte arrays and no AWS SDK or mocking
 * at all (see test/derUtils.test.js).
 */

/**
 * Reads one DER TLV (Type-Length-Value) header starting at `offset` and
 * returns where the VALUE bytes start and how long they are. DER length
 * encoding has two forms this needs to handle: "short form" (the length
 * fits in one byte, top bit 0) and "long form" (the top bit is 1, and
 * the REST of that byte says how many following bytes encode the actual
 * length) — KMS's responses are small enough to only ever hit the
 * short-form and one-byte-long-form cases in practice, but both are
 * handled correctly here rather than assuming only the common case.
 */
function readTlvHeader(buf, offset) {
  const tag = buf[offset];
  let lengthByte = buf[offset + 1];
  let length;
  let valueOffset;

  if ((lengthByte & 0x80) === 0) {
    // Short form: this byte IS the length.
    length = lengthByte;
    valueOffset = offset + 2;
  } else {
    // Long form: the low 7 bits say how many following bytes make up
    // the real length, big-endian.
    const numLengthBytes = lengthByte & 0x7f;
    length = 0;
    for (let i = 0; i < numLengthBytes; i++) {
      length = (length << 8) | buf[offset + 2 + i];
    }
    valueOffset = offset + 2 + numLengthBytes;
  }

  return { tag, length, valueOffset };
}

/**
 * Extracts the raw 64-byte uncompressed public key point (X || Y, no
 * 0x04 prefix) from KMS's GetPublicKey DER response.
 *
 * Structure (SubjectPublicKeyInfo):
 *   SEQUENCE {
 *     SEQUENCE { OID algorithm, OID curve }   <- skipped entirely, not parsed
 *     BIT STRING { 0x00 padding-bits-count, 0x04 uncompressed-marker, X (32 bytes), Y (32 bytes) }
 *   }
 * This function does NOT verify the algorithm/curve OIDs match
 * ECC_SECG_P256K1 — it assumes the KMS key was created with the right
 * KeySpec (see 01-deploy-safe-infrastructure.js's own key-creation step)
 * and just extracts the point. A production hardening pass might want
 * to verify the OID bytes explicitly rather than trust the caller
 * configured the right key spec.
 */
function publicKeyFromKmsDer(derBuffer) {
  const outer = readTlvHeader(derBuffer, 0);
  if (outer.tag !== 0x30) {
    throw new Error('Expected outer SEQUENCE (0x30) in KMS public key DER');
  }

  // Skip the inner algorithm-identifier SEQUENCE entirely — we don't
  // need to parse it, only skip past it to reach the BIT STRING.
  const algIdHeader = readTlvHeader(derBuffer, outer.valueOffset);
  const bitStringOffset = algIdHeader.valueOffset + algIdHeader.length;

  const bitString = readTlvHeader(derBuffer, bitStringOffset);
  if (bitString.tag !== 0x03) {
    throw new Error('Expected BIT STRING (0x03) for the public key point');
  }

  // First byte of a BIT STRING's value is the count of UNUSED bits in
  // the final byte — always 0x00 for a byte-aligned EC point, and safe
  // to skip. The next byte (0x04) marks "uncompressed point" — also
  // skipped, since the raw X/Y bytes are all Ethereum's address
  // derivation actually needs.
  const pointStart = bitString.valueOffset + 2;
  const rawPoint = derBuffer.subarray(pointStart, pointStart + 64);

  if (rawPoint.length !== 64) {
    throw new Error(`Expected a 64-byte uncompressed EC point, got ${rawPoint.length} bytes`);
  }
  return rawPoint;
}

/**
 * Extracts (r, s) as 32-byte-padded Buffers from KMS's Sign DER response.
 *
 * Structure (ECDSA-Sig-Value):
 *   SEQUENCE { INTEGER r, INTEGER s }
 * DER INTEGERs are signed, minimal-length encodings — a value whose
 * high bit would otherwise be set gets a leading 0x00 byte prepended
 * so it's unambiguously read as positive. That leading byte has to be
 * stripped (not just left in place) before treating the remaining
 * bytes as the raw 32-byte value Ethereum expects, and a value shorter
 * than 32 bytes (leading zero bytes trimmed by DER's "minimal length"
 * rule) has to be LEFT-padded back to 32 bytes — both handled here.
 */
function signatureFromKmsDer(derBuffer) {
  const outer = readTlvHeader(derBuffer, 0);
  if (outer.tag !== 0x30) {
    throw new Error('Expected outer SEQUENCE (0x30) in KMS signature DER');
  }

  const rHeader = readTlvHeader(derBuffer, outer.valueOffset);
  const rRaw = derBuffer.subarray(rHeader.valueOffset, rHeader.valueOffset + rHeader.length);

  const sOffset = rHeader.valueOffset + rHeader.length;
  const sHeader = readTlvHeader(derBuffer, sOffset);
  const sRaw = derBuffer.subarray(sHeader.valueOffset, sHeader.valueOffset + sHeader.length);

  return { r: toPadded32(rRaw), s: toPadded32(sRaw) };
}

function toPadded32(rawBytes) {
  // Strip a single DER-mandated leading 0x00 sign byte, if present,
  // THEN left-pad to exactly 32 bytes — order matters: padding first
  // would leave the sign byte in the middle of the value.
  let bytes = rawBytes;
  if (bytes.length === 33 && bytes[0] === 0x00) {
    bytes = bytes.subarray(1);
  }
  if (bytes.length > 32) {
    throw new Error(`Integer value too long after stripping sign byte: ${bytes.length} bytes`);
  }
  const padded = Buffer.alloc(32);
  bytes.copy(padded, 32 - bytes.length);
  return padded;
}

module.exports = { publicKeyFromKmsDer, signatureFromKmsDer, readTlvHeader };

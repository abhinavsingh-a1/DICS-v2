const { AbstractSigner, computeAddress, hashMessage, keccak256, Signature, Transaction, TypedDataEncoder, recoverAddress, resolveProperties, copyRequest } = require('ethers');
const { GetPublicKeyCommand, SignCommand } = require('@aws-sdk/client-kms');
const { publicKeyFromKmsDer, signatureFromKmsDer } = require('./derUtils');

// The secp256k1 curve order — needed to enforce Ethereum's "low-s"
// signature rule (EIP-2). KMS has no idea this rule exists; it happily
// returns mathematically valid signatures with a "high" s value, which
// Ethereum clients reject as non-canonical (originally a defense
// against transaction-malleability attacks). This constant, and the
// normalization logic below that uses it, is what makes a KMS signature
// actually acceptable to a real Ethereum node.
const SECP256K1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
const SECP256K1_HALF_N = SECP256K1_N / 2n;

/**
 * An ethers v6 Signer whose private key never exists outside AWS KMS —
 * every signing operation (a plain message, a transaction, EIP-712
 * typed data) reduces to "compute the right 32-byte digest, ask KMS to
 * sign THAT specific digest, translate KMS's answer into the (r, s, v)
 * shape Ethereum expects." That reduction is exactly what
 * `_signDigest` below does once; every public method is a thin wrapper
 * around it, matching the pattern used throughout this project of
 * factoring the one piece that actually matters into one place rather
 * than repeating it per call site (see, e.g., notification-service's
 * shared `call` helper in chain/client.go).
 *
 * The KMS key backing this signer MUST have been created with
 * `KeySpec: 'ECC_SECG_P256K1'` — the one asymmetric key spec AWS KMS
 * offers that uses the exact same curve as Ethereum. Any other key spec
 * will produce a public key / signatures this class cannot correctly
 * turn into an Ethereum address or a valid Ethereum signature.
 */
class KmsSigner extends AbstractSigner {
  constructor(kmsClient, keyId, provider) {
    super(provider);
    this.kmsClient = kmsClient;
    this.keyId = keyId;
    this._cachedAddress = null;
  }

  connect(provider) {
    return new KmsSigner(this.kmsClient, this.keyId, provider);
  }

  async getAddress() {
    if (this._cachedAddress) {
      return this._cachedAddress; // KMS charges per API call and the key never changes — caching is free correctness, not just an optimization
    }

    const response = await this.kmsClient.send(new GetPublicKeyCommand({ KeyId: this.keyId }));
    const rawPoint = publicKeyFromKmsDer(Buffer.from(response.PublicKey));

    // Ethereum's address derivation: keccak256 of the raw 64-byte
    // (X || Y) public key point, uncompressed-marker byte excluded —
    // then take the last 20 bytes. `computeAddress` here is ethers'
    // own implementation of exactly this rule; reused rather than
    // hand-rolled a second time, since ethers already gets this right
    // and re-implementing it would just be a second place this logic
    // could silently drift from correct.
    this._cachedAddress = computeAddress('0x04' + rawPoint.toString('hex'));
    return this._cachedAddress;
  }

  /**
   * The one real signing primitive. Every public sign* method below
   * ends up here with a specific 32-byte digest.
   *
   * @param {string} digestHex 0x-prefixed 32-byte hash to sign
   * @returns {Promise<import('ethers').Signature>}
   */
  async _signDigest(digestHex) {
    const digestBytes = Buffer.from(digestHex.slice(2), 'hex');
    if (digestBytes.length !== 32) {
      throw new Error(`_signDigest expects a 32-byte digest, got ${digestBytes.length} bytes`);
    }

    const response = await this.kmsClient.send(
      new SignCommand({
        KeyId: this.keyId,
        Message: digestBytes,
        // Critical: without this, KMS treats `Message` as the UNHASHED
        // input and runs its own SHA-256 over it before signing —
        // producing a signature over SHA256(keccak256(originalData))
        // instead of a signature over keccak256(originalData), which
        // Ethereum would simply reject (wrong digest entirely, not just
        // wrong format). MessageType: 'DIGEST' tells KMS "this 32-byte
        // value IS ALREADY the digest — sign it directly, don't hash it
        // again."
        MessageType: 'DIGEST',
        SigningAlgorithm: 'ECDSA_SHA_256',
      })
    );

    const { r, s: sRaw } = signatureFromKmsDer(Buffer.from(response.Signature));

    // Low-s normalization (EIP-2): if KMS's s exceeds half the curve
    // order, the mathematically equivalent low-s signature is (N - s),
    // and the recovery id's parity bit flips as a result. Normalizing
    // BEFORE brute-forcing the recovery id below (rather than after)
    // means the brute-force only ever has to consider the two
    // candidates consistent with the value actually being submitted.
    let s = BigInt('0x' + sRaw.toString('hex'));
    if (s > SECP256K1_HALF_N) {
      s = SECP256K1_N - s;
    }
    const sHex = '0x' + s.toString(16).padStart(64, '0');
    const rHex = '0x' + r.toString('hex');

    const address = await this.getAddress();
    const recoveryId = this._findRecoveryId(digestHex, rHex, sHex, address);

    return Signature.from({ r: rHex, s: sHex, v: 27 + recoveryId });
  }

  /**
   * KMS's Sign API returns only (r, s) — never which of the two
   * possible public keys the signature recovers to (Ethereum's "v" /
   * recovery id). Since THIS signer already knows its own address
   * (from getAddress(), a separate KMS call made once and cached), the
   * correct recovery id can be determined by brute force: try both
   * possibilities (0 and 1) and see which one recovers back to the
   * address this signer actually is. Exactly two candidates, so this
   * is O(1) in practice, not a real search.
   */
  _findRecoveryId(digestHex, rHex, sHex, expectedAddress) {
    for (const recoveryId of [0, 1]) {
      const candidateSignature = Signature.from({ r: rHex, s: sHex, v: 27 + recoveryId });
      const recovered = recoverAddress(digestHex, candidateSignature);
      if (recovered.toLowerCase() === expectedAddress.toLowerCase()) {
        return recoveryId;
      }
    }
    // Should be unreachable if KMS actually signed with the key this
    // signer's address was derived from — surfaced as a loud error
    // rather than silently returning a guess, since a caller receiving
    // a signature that recovers to the WRONG address is a much worse
    // failure mode than a thrown exception here.
    throw new Error('Could not determine a valid recovery id — signature does not match this signer\'s address');
  }

  async signMessage(message) {
    // hashMessage applies the EIP-191 "\x19Ethereum Signed Message:\n"
    // prefix (see docs/dataflow/Step-1-Wallet-Auth.md for the full
    // explanation of this exact prefix and why it exists) before
    // hashing — the same scheme a browser wallet uses for a plain
    // signature, just produced here via KMS instead of a private key
    // in memory.
    const digest = hashMessage(message);
    const signature = await this._signDigest(digest);
    return signature.serialized;
  }

  async signTypedData(domain, types, value) {
    // EIP-712 (see docs/dataflow/Step-4-Oracle-Verification.md) — the
    // same structured-signing scheme oracle-service uses for its
    // OracleResponse payloads, here available to anything using this
    // signer for a Safe transaction's typed-data hash.
    const digest = TypedDataEncoder.hash(domain, types, value);
    const signature = await this._signDigest(digest);
    return signature.serialized;
  }

  async signTransaction(tx) {
    const resolvedTx = await resolveProperties(copyRequest(tx));
    if (resolvedTx.from != null) {
      delete resolvedTx.from; // Transaction.from() below derives `from` from the signature itself, not this field
    }
    const unsignedTx = Transaction.from(resolvedTx);
    const digest = keccak256(unsignedTx.unsignedSerialized);
    const signature = await this._signDigest(digest);
    unsignedTx.signature = signature;
    return unsignedTx.serialized;
  }
}

module.exports = { KmsSigner, SECP256K1_N };

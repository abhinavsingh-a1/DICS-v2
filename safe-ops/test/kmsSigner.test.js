const { SigningKey, keccak256, hashMessage, recoverAddress, computeAddress } = require('ethers');
const { GetPublicKeyCommand, SignCommand } = require('@aws-sdk/client-kms');
const { KmsSigner, SECP256K1_N } = require('../src/kmsSigner');
const { buildDerSpki, buildDerSignature } = require('./derFixtures');

/**
 * Rather than mock the CRYPTOGRAPHY (which would only prove this class
 * calls some functions in some order, not that the result is actually
 * a valid Ethereum signature), this test generates a REAL secp256k1
 * keypair via ethers' own SigningKey, signs a REAL digest with it, and
 * feeds that genuine cryptographic material into a MOCKED KMS client —
 * the network call is faked, the math is not. This is what makes it
 * possible to assert things like "the recovered address actually
 * matches" without needing a real AWS connection or a real running
 * KMS key. Compare this design choice to derUtils.test.js, which tests
 * pure DER-parsing structure with arbitrary bytes — this file layers
 * real crypto ON TOP of that same DER framing, one level up.
 */
function buildMockKmsClient(signingKey) {
  // signingKey.publicKey is "0x04" + 64 hex bytes (X || Y) — strip the
  // "0x04" marker before wrapping in DER, since publicKeyFromKmsDer
  // expects the raw 64-byte point without it (see that function's own
  // comment on the marker byte it skips).
  const rawPoint = Buffer.from(signingKey.publicKey.slice(4), 'hex');
  const publicKeyDer = buildDerSpki(rawPoint);

  return {
    send: jest.fn(async (command) => {
      if (command instanceof GetPublicKeyCommand) {
        return { PublicKey: publicKeyDer };
      }
      if (command instanceof SignCommand) {
        const digestHex = '0x' + Buffer.from(command.input.Message).toString('hex');
        // signingKey.sign() is ethers' own, already-correct secp256k1
        // signing — used here purely as "ground truth" to generate a
        // real (r, s) pair for this real digest, standing in for what
        // a real KMS key would return.
        const realSignature = signingKey.sign(digestHex);
        const r = Buffer.from(realSignature.r.slice(2), 'hex');
        const s = Buffer.from(realSignature.s.slice(2), 'hex');
        return { Signature: buildDerSignature(r, s) };
      }
      throw new Error(`Mock KMS client received an unexpected command: ${command.constructor.name}`);
    }),
  };
}

describe('KmsSigner', () => {
  const signingKey = new SigningKey('0x' + '11'.repeat(32)); // fixed, non-secret test-only key — never used for anything real
  const expectedAddress = computeAddress(signingKey.publicKey);

  it('getAddress() derives the correct Ethereum address from the KMS public key, and caches it', async () => {
    const mockClient = buildMockKmsClient(signingKey);
    const signer = new KmsSigner(mockClient, 'test-key-id', null);

    const address1 = await signer.getAddress();
    const address2 = await signer.getAddress();

    expect(address1).toBe(expectedAddress);
    expect(address2).toBe(expectedAddress);
    // Only ONE GetPublicKeyCommand should have been sent — the second
    // getAddress() call must have used the cached value, not made a
    // second real KMS call. This is the actual proof caching works,
    // not just that the right address came back.
    const getPublicKeyCalls = mockClient.send.mock.calls.filter(([cmd]) => cmd instanceof GetPublicKeyCommand);
    expect(getPublicKeyCalls).toHaveLength(1);
  });

  it('_signDigest produces a signature that recovers to this signer\'s own address', async () => {
    const mockClient = buildMockKmsClient(signingKey);
    const signer = new KmsSigner(mockClient, 'test-key-id', null);

    const digest = keccak256('0xdeadbeef');
    const signature = await signer._signDigest(digest);

    const recovered = recoverAddress(digest, signature);
    expect(recovered.toLowerCase()).toBe(expectedAddress.toLowerCase());
  });

  it('normalizes a high-s signature to the equivalent low-s form before returning it', async () => {
    // Build a mock KMS client that deliberately returns the
    // mathematically-equivalent HIGH-s form of a real signature — proving
    // the normalization logic actually runs, not just that ethers
    // already handed back a low-s value that happened to need no fixing.
    const digest = keccak256('0xcafebabe');
    const realSignature = signingKey.sign(digest);
    const realS = BigInt(realSignature.s);
    const highS = SECP256K1_N - realS; // the other mathematically valid s for this same (digest, key)
    expect(highS).toBeGreaterThan(SECP256K1_N / 2n); // sanity-check the test fixture itself is actually "high"

    const highSHex = Buffer.from(highS.toString(16).padStart(64, '0'), 'hex');
    const rHex = Buffer.from(realSignature.r.slice(2), 'hex');

    const mockClient = {
      send: jest.fn(async (command) => {
        if (command instanceof GetPublicKeyCommand) {
          const rawPoint = Buffer.from(signingKey.publicKey.slice(4), 'hex');
          return { PublicKey: buildDerSpki(rawPoint) };
        }
        return { Signature: buildDerSignature(rHex, highSHex) };
      }),
    };

    const signer = new KmsSigner(mockClient, 'test-key-id', null);
    const signature = await signer._signDigest(digest);

    // The returned s must be the LOW form, not the high one the mock
    // "KMS" actually returned — this is the real assertion; everything
    // above it is just constructing a legitimately high-s input to
    // normalize away.
    expect(BigInt(signature.s)).toBeLessThanOrEqual(SECP256K1_N / 2n);
    expect(BigInt(signature.s)).toBe(realS);

    // And despite the input being deliberately "wrong-form," the final
    // signature must still recover to the correct address — proving
    // the recovery-id brute force correctly accounted for the parity
    // flip that normalizing s from high to low causes.
    const recovered = recoverAddress(digest, signature);
    expect(recovered.toLowerCase()).toBe(expectedAddress.toLowerCase());
  });

  it('signMessage applies the EIP-191 prefix before signing, matching a normal wallet signature', async () => {
    const mockClient = buildMockKmsClient(signingKey);
    const signer = new KmsSigner(mockClient, 'test-key-id', null);

    const message = 'Aurelia Labs login nonce: test123';
    const serializedSignature = await signer.signMessage(message);

    // The whole point of EIP-191 (see docs/dataflow/Step-1-Wallet-Auth.md)
    // is that recovering against the PREFIXED hash succeeds, while
    // recovering against the raw, unprefixed message would recover to
    // some other (wrong) address entirely. This test checks the first
    // half directly.
    const recovered = recoverAddress(hashMessage(message), serializedSignature);
    expect(recovered.toLowerCase()).toBe(expectedAddress.toLowerCase());
  });
});

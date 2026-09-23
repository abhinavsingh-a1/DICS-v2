# 18 — `safe-ops`: Testing Cryptography Without Real AWS Infrastructure

## The core testing problem this project faced

`KmsSigner` exists specifically so a private key never has to sit in
memory or on disk — which means there's no key this test suite could
ever "just use directly" to check the signing math is correct, the way
`Governance.t.sol` can just instantiate a real `DICSGovernanceToken`
with a plain test private key. The honest options were: mock the
cryptography itself (proves the code *calls things*, not that the
*output is valid*), or stand up a real AWS account with a real KMS key
for CI (real cost, real infrastructure, not appropriate for a fast unit
test suite). Neither is right. The approach actually used:

## Mock the network call, not the math

```js
const signingKey = new SigningKey('0x' + '11'.repeat(32));
// ... later, inside the mocked KMS client's send():
const realSignature = signingKey.sign(digestHex);
```

`ethers.SigningKey` is a real, correct secp256k1 implementation —
generating a real keypair and producing a real, valid signature for a
real digest. The mock KMS client (`buildMockKmsClient` in
`kmsSigner.test.js`) intercepts only the *network call* (`.send(...)`)
and returns THIS real signature, DER-wrapped, exactly as a real KMS API
response would arrive. `KmsSigner` itself has no idea it's talking to a
fake — every line of its own logic (DER parsing, low-s normalization,
recovery-id brute force) runs unmodified against genuinely valid
cryptographic material. This is what makes an assertion like "the
recovered address matches" actually mean something, rather than just
confirming a mock returned what it was told to return.

## Proving the low-s normalization actually does something

The trickiest test in this file (`normalizes a high-s signature...`)
deliberately does NOT use the signature ethers produces natively —
ethers' own `SigningKey.sign()` already returns low-s signatures, so
using it directly would never exercise the normalization code at all
(a bug in that logic could exist and this test suite would never
notice). Instead:

```js
const highS = SECP256K1_N - realS; // the other mathematically valid s for the same signature
```

ECDSA's own math guarantees `(r, s)` and `(r, N - s)` are *both* valid
signatures for the same message and key — this is precisely EIP-2's
motivation for requiring the low form as canonical in the first place.
The test constructs this deliberately-high-s variant, feeds it through
the mock as if it were what KMS actually returned, and then asserts
`KmsSigner` handed back the *low* form — and that it still recovers to
the correct address despite the recovery-id parity flip normalizing s
causes. This is the difference between "wrote a normalization function"
and "proved the normalization function is necessary and correct" — the
test is deliberately adversarial against its own code, not just a
happy-path check.

## Why `derUtils.test.js` needs no cryptography at all

DER parsing is pure structural byte-manipulation — nothing about
extracting "the 64 bytes after this header" needs a valid EC point,
only bytes of the right length in the right place. `derUtils.test.js`
uses arbitrary filler bytes (`0, 1, 2, ...63` for the public-key test)
specifically to prove the *parsing logic* is correct independent of
whether the underlying values happen to be real cryptography — a
different, narrower kind of correctness than `kmsSigner.test.js` checks,
and appropriately tested with a simpler kind of fixture as a result.

## Running these tests

```bash
cd safe-ops
npm install
npm test
```

No AWS account, no real KMS key, no running blockchain. Every test
completes in milliseconds. As with every other piece of `safe-ops/`,
this has not actually been executed in the environment this project
was built in — see that project's own README for the honest status of
what's verified (the DER/signing math, tested against real generated
cryptography) versus what isn't (whether `@safe-global/protocol-kit`'s
real API matches what the scripts assume).

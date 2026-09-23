# 10 — Safe Multisig + AWS KMS: Design, Threat Model, and Operational Checklists

## What changed, in one sentence

`ClaimRegistry.UNDERWRITER_ROLE` now belongs to a Safe multisig whose
owners are individual employees, each signing with a key that lives
inside AWS KMS and never exists as a plaintext private key anywhere —
replacing the single `UNDERWRITER_PRIVATE_KEY` EOA that
`underwriter-service`'s own code comments flagged as a known
simplification since the moment it was built.

## Why this over a custom smart-contract account

A real option considered and set aside: a purpose-built smart-contract
account with a rule like "the company can change the owner." This is a
real, valid pattern (many teams build exactly this), but it means
designing, writing, and auditing new Solidity from scratch — new attack
surface, new edge cases, nothing reused from work the wider ecosystem
has already hardened. **Safe is the same underlying idea — a
smart-contract account with configurable ownership and threshold
rules — already built, already extensively audited, already the
de facto standard multisig across Ethereum.** Given this project
already has a real `ClaimGasPaymaster.sol` (EIP-4337) and a documented
smart-account-adjacent design space, "reuse Safe" is the lower-risk,
lower-effort choice for exactly the guarantee needed here (N-of-M
employee sign-off, add/remove owners over time) — genuinely simpler,
not just nominally so.

## Why Safe contracts had to be deployed onto Besu at all

On mainnet and most public testnets, Safe's core contracts already
exist at well-known addresses — deployed once, long ago, via a
deterministic factory, so every chain that has them has them at the
*same* address. A private Besu network has no such history; nobody has
ever deployed anything here before. `safe-ops/scripts/01-deploy-safe-infrastructure.js`
is that one-time bootstrap, using `@safe-global/safe-deployments`'s
canonical artifacts (the same bytecode/ABI Safe itself publishes) so
this project isn't hand-maintaining Safe's own contract bytecode.

## Why AWS KMS, and what it actually buys

A raw private key in an environment variable (the *original*
`UNDERWRITER_PRIVATE_KEY` model, and still exactly what `oracle-service`'s
signer key is today — see that service's own README for the same
flagged simplification) has one fundamental property: **whoever can
read that file can sign anything, forever, with no record of who
actually did it.** An AWS KMS asymmetric key (`ECC_SECG_P256K1` — the
one KMS key spec that uses Ethereum's exact curve) never exposes its
private material to anything, including this codebase — every signature
is produced by calling KMS's `Sign` API, and AWS IAM controls *precisely
who* is allowed to invoke that specific key, with every invocation
logged in CloudTrail. Concretely, this changes what "revoke someone's
signing ability" means: instead of "hope everyone who might have a copy
of the `.env` file deletes it," it becomes "remove one IAM permission,"
an action with its own audit trail, reversible, and impossible for the
revoked person to work around by having kept a copy of anything (they
never had the key material to copy in the first place).

## Why the signing math had to be built by hand (`kmsSigner.js`, `derUtils.js`)

KMS speaks the general-purpose cryptography world's language (DER
encoding, SHA-256-oriented signing flows); Ethereum speaks its own
narrower dialect (raw 32-byte digests, low-s-normalized signatures,
recovery IDs). Three specific translation problems, each real and each
handled explicitly rather than glossed over:

1. **KMS wants to hash the message itself by default.** Passing
   `MessageType: 'DIGEST'` is what tells KMS "this 32-byte value IS
   ALREADY the hash — sign it directly." Without this, KMS would sign
   `SHA256(keccak256(data))` instead of `keccak256(data)` — not a
   format problem, a completely different, useless digest.
2. **KMS returns DER-encoded (r, s); Ethereum wants raw, fixed-width
   bytes, low-s-normalized.** `derUtils.js` handles the DER parsing;
   `kmsSigner.js`'s `_signDigest` handles the low-s normalization
   (EIP-2) KMS has no awareness of at all.
3. **KMS never tells you the recovery ID.** Ethereum signatures encode
   a `v` value specifically so a verifier can recover the *unique*
   correct public key from `(r, s)` alone, without needing the message
   sender to separately supply their address — but KMS's `Sign` API
   only returns `(r, s)`, leaving `v` for the caller to work out. Since
   this signer already knows its own address (from a separate,
   one-time `GetPublicKey` call), it determines the correct `v` by
   trying both possibilities and checking which one recovers back to
   that known address — exactly two candidates, so this is a fixed,
   cheap check, not an open-ended search.

## Why signatures are collected within one script run, not via Safe's Transaction Service

Safe's real-world multi-person flow normally goes through a hosted (or
self-hosted) **Transaction Service** — one person proposes, the
Transaction Service holds the pending proposal, other owners review and
sign independently at their own time via the Safe web app, and once
threshold is met, anyone can execute. That's real infrastructure this
project doesn't stand up for a private Besu network. Given
`safe-ops/`'s scripts already have configured access to every owner's
KMS key ID (necessarily — someone has to operate this tooling), the
scripts instead sign with enough owners' keys **within one script
execution**, back to back.

**This is a real, named trade-off, not a hidden shortcut**: it means
whoever runs `04-propose-and-execute-transaction.js` has, in that one
process, the ability to invoke every configured owner's KMS key in
sequence — appropriate for a small number of trusted internal signers
who've agreed out-of-band (a Slack thread, a meeting) that a given
claim should be approved, and want one script to execute that agreement;
**not** appropriate if the actual design goal were "no single operator
should ever be able to trigger multiple owners' signatures in one
action." If that stronger guarantee is ever needed, the real next step
is standing up Safe's Transaction Service (self-hosted is an option;
Safe also publishes it as open source) and having each owner sign via
the Safe web app or CLI independently — a materially larger
infrastructure lift than anything built here, which is exactly why the
simpler approach was chosen first, per the original request's own
"simplest" framing.

## Onboarding checklist (new employee)

1. Provision a new KMS key: `aws kms create-key --key-spec ECC_SECG_P256K1 --key-usage SIGN_VERIFY --description "DICS underwriter: <name>"`.
2. Grant that specific person's IAM principal `kms:Sign` and
   `kms:GetPublicKey` on that key ID only — not a shared/broad KMS
   policy covering every underwriter key.
3. Run `node scripts/05-add-owner.js <new-key-id> [newThreshold]` —
   requires the *existing* threshold's worth of current owners to sign
   this addition; the new person cannot add themselves.
4. Add the new key ID to `OWNER_KMS_KEY_IDS` in every deployment's
   `.env` that references this Safe.

## Offboarding checklist (departing employee)

1. Run `node scripts/06-remove-owner.js <their-safe-address> [newThreshold]`
   — signed by the *remaining* owners meeting the *current* threshold;
   the departing person's signature is never needed or used.
2. Revoke their IAM access to their own KMS key directly in AWS —
   independent of step 1 (see `06-remove-owner.js`'s own header on why
   both matter: step 1 alone leaves their key still cryptographically
   *able* to sign, just ignored by the Safe contract; step 2 alone
   leaves a stale owner entry that could still count toward quorum
   through some other compromise path).
3. Remove their key ID from `OWNER_KMS_KEY_IDS` in every deployment's
   `.env`.
4. If their departure changes the intended threshold (not just the
   owner count), confirm the `newThreshold` argument passed in step 1
   actually reflects the intended new policy — the script enforces only
   that the number is *mathematically valid* (not exceeding the
   remaining owner count), not that it matches whatever your actual
   internal policy should be.

## What this does NOT change

- `oracle-service`'s signer key is untouched — still a single EOA, same
  flagged simplification as always. Nothing about this change extends
  to the oracle-signing role; that remains a separate, real gap.
- `ClaimRegistry`'s `ADMIN_ROLE`/`DEFAULT_ADMIN_ROLE` (held by the
  claims Timelock) is untouched — this change is scoped specifically to
  `UNDERWRITER_ROLE`.
- `underwriter-service` (the Java REST API from earlier in this
  project) still exists and its `GET /claims/pending` endpoint is still
  accurate — only its *write* path (`ClaimRegistryClient.java`'s direct
  `setClaimStatus`/`payoutClaim` calls, signed by a single configured
  EOA) is now stale against a real deployment, since `msg.sender` for
  those calls would need to *be* the Safe, not an EOA. See that
  service's own updated README for how this is reflected there.

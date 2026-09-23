# safe-ops

Replaces `underwriter-service`'s single `UNDERWRITER_PRIVATE_KEY` EOA
with a real Safe multisig, owned by individual employees, each signing
with their own AWS KMS key — never a raw private key on disk or in an
environment variable.

**Full design rationale, threat model, and onboarding/offboarding
checklists:** `docs/services/10-Safe-Multisig-And-KMS.md`. This README
is the "how do I actually run these scripts" reference; that document
is the "why is it built this way" one.

## One-time setup (in order)

```bash
npm install
cp .env.example .env
# fill in RPC_URL, CHAIN_ID, CLAIM_REGISTRY_ADDRESS, DEPLOYER_PRIVATE_KEY,
# AWS_REGION

npm run deploy-safe-infra
# -> copy the three printed addresses into .env

# Provision one AWS KMS key per employee-owner BEFORE this next step:
#   aws kms create-key --key-spec ECC_SECG_P256K1 --key-usage SIGN_VERIFY
# then set OWNER_KMS_KEY_IDS (comma-separated) and SAFE_THRESHOLD in .env

npm run create-safe
# -> copy UNDERWRITER_SAFE_ADDRESS into .env

npm run grant-role
# grants ClaimRegistry.UNDERWRITER_ROLE to the Safe — see that script's
# own header on why this step may need to go through Timelock
# governance instead of running directly, on anything beyond a local
# test deployment
```

## Day-to-day: approving, rejecting, paying out a claim

```bash
node scripts/04-propose-and-execute-transaction.js 1 approve
node scripts/04-propose-and-execute-transaction.js 1 reject
node scripts/04-propose-and-execute-transaction.js 1 payout
```

## Onboarding / offboarding

```bash
# New employee (their KMS key must already exist — see setup above)
node scripts/05-add-owner.js <their-kms-key-id> [newThreshold]

# Departing employee
node scripts/06-remove-owner.js <their-safe-owner-address> [newThreshold]
```

Removing an owner is itself a Safe transaction — it needs signatures
from the REMAINING owners meeting the current threshold, run by them,
not by the person leaving. See `06-remove-owner.js`'s own header for
the second, equally necessary step this script does NOT do (revoking
the departing person's IAM access to their own KMS key).

## Run the tests

```bash
npm test
```

No AWS account, KMS key, or running chain needed — `derUtils.test.js`
tests the DER-parsing logic with hand-built byte fixtures, and
`kmsSigner.test.js` generates a real secp256k1 keypair via ethers
itself and feeds it through a mocked KMS client, so the tests prove the
signing math is actually correct (address derivation, digest signing,
low-s normalization, recovery-id determination) without ever touching
real AWS infrastructure. See `docs/tests-explained/18` for the full
walkthrough.

## Honest status of the Safe SDK integration specifically

Every script here was written against my best understanding of
`@safe-global/protocol-kit` v4.x's API shape, without the ability to
`npm install` and check against the real package's TypeScript
definitions in the environment this was built in. `src/eip1193FromKmsSigner.js`'s
own header explains exactly what to do if `Safe.init()` or any
protocol-kit call rejects this project's assumptions: treat it as
expected verification work, the same way every other "not independently
compiled" piece of this project has needed at least one real correction
round once actually run. The DER parsing and KMS signing math
(`derUtils.js`, `kmsSigner.js`) carry higher confidence than the
protocol-kit wiring specifically, since the former is tested against
real cryptographic values and the latter cannot be, in this
environment.

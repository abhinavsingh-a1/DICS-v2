# 08 — `contracts/mocks/MockClaimRegistrySink.sol` Explained

**Read `00-Introduction.md` first** if you haven't — this document
assumes you already know what a mock is and why this project has them.

## The full file (26 lines)

```solidity
contract MockClaimRegistrySink is IClaimRegistryOracleSink {
    uint256 public lastClaimId;
    bytes32 public lastRequestId;
    bool public lastApproved;
    uint256 public callCount;

    function recordOracleVerification(uint256 claimId, bytes32 requestId, bool approved) external override {
        lastClaimId = claimId;
        lastRequestId = requestId;
        lastApproved = approved;
        callCount++;
    }
}
```

## Purpose of this file

`OracleAdapter`'s entire job, once a signature checks out, is to call
`recordOracleVerification(...)` on whatever contract implements
`IClaimRegistryOracleSink` — in the real system, that's `ClaimRegistry`.
This file exists so `OracleAdapter.t.sol` can test `OracleAdapter`
**on its own**, without needing a fully working `ClaimRegistry`
standing behind it. It answers exactly one question for the test: *did
`OracleAdapter` call the right function, with the right arguments,
after (and only after) a valid signature was verified?*

## Why this contract exists at all — what would be left out without it

Without this mock, every single `OracleAdapter.t.sol` test would need
to deploy a real `ClaimRegistry` too — which itself needs a real
`InsurancePolicy`, roles granted on both, and at least one policy
registered, none of which has anything to do with what
`OracleAdapter.t.sol` is actually trying to prove (signature
verification, replay protection, expiry checks). Worse, if a real
`ClaimRegistry` were used, a failing `OracleAdapter` test could
actually be caused by a bug in `ClaimRegistry` instead — the test
would no longer tell you *which* contract broke. This mock keeps the
two contracts' tests cleanly separated: `OracleAdapter.t.sol` proves
`OracleAdapter`'s logic; `ClaimRegistryUpgrade.t.sol` (using its own,
different mock) proves `ClaimRegistry`'s logic.

## Why each variable exists — what would be left out without it

- **`lastClaimId`, `lastRequestId`, `lastApproved`** — without these,
  a test could confirm the mock was called, but not confirm it was
  called with the *correct* data. `test_ValidSignature_ForwardsToClaimRegistry`
  specifically checks `sink.lastClaimId() == 42` — proving `OracleAdapter`
  didn't just call the sink, but forwarded the exact claim ID from the
  signed response, unmodified.
- **`callCount`** — without this, a test couldn't distinguish "called
  once" from "called three times." This matters because
  `test_ValidSignature_ForwardsToClaimRegistry` also implicitly proves
  the function is called *exactly once* per valid submission — if
  `OracleAdapter` had a bug that called it twice, `callCount` would
  catch that even though the individual field values would still look
  correct.

## Why this specific line is kept: `external override`

`override` isn't optional stylistic flair — Solidity **requires** it
whenever a function implements a function declared in an interface the
contract inherits from (here, `IClaimRegistryOracleSink`). Without
`override`, this wouldn't compile at all — Solidity would see a
contract that inherits an interface but doesn't actually provide the
promised function, and correctly refuse to build it. The word
`override` is Solidity's way of making sure that connection is
deliberate, not accidental.

## Data flow inside `recordOracleVerification`

1. **Input:** `claimId` (e.g. `42`), `requestId` (a 32-byte hash),
   `approved` (`true`/`false`) — whatever `OracleAdapter` decided to
   forward after verifying a signature.
2. Each of the three values is written directly into this contract's
   own storage (`lastClaimId = claimId`, etc.) — overwriting whatever
   was there from any previous call.
3. `callCount` is incremented by exactly `1`.
4. **Output:** nothing is returned (the function has no return value) —
   the entire point of calling it is the *storage change*, which the
   test then reads afterward via `sink.lastClaimId()`,
   `sink.callCount()`, and so on (these getters exist automatically in
   Solidity for any `public` state variable — that's why `lastClaimId`
   is declared `public` here, specifically so the test file can read it
   from outside the contract).

## Where else this file is used

Its header comment notes it's also reused by
`script/DeployIntegrationFixture.s.sol`, for the *same* reason:
`oracle-service`'s own JavaScript integration test needs a real,
deployed `OracleAdapter` to submit signatures against, but doesn't need
a real `ClaimRegistry` either — the same isolation this mock provides
for Foundry tests applies just as well to that separate test suite.

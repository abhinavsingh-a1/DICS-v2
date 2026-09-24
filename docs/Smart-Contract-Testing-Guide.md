# DICS v2 Smart Contracts — Testing Guide

Covers all **59 test functions** across **8 Foundry test files**, pulled
directly from the actual source (not recalled from memory) so this list
matches exactly what's in the repository.

---

## 1. Prerequisites

```bash
cd smart-contracts

# Foundry itself, if not already installed
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Dependencies — pinned to the versions this project actually compiles against
forge install OpenZeppelin/openzeppelin-contracts-upgradeable@v5.7.0
forge install OpenZeppelin/openzeppelin-contracts@v5.7.0
forge install eth-infinitism/account-abstraction   # only needed for ClaimGasPaymaster.sol

# After installing, record the exact commit hash actually pulled down —
# see besu-network/README.md's note on why "@v5.7.0" alone isn't a
# strong enough pin (this project hit real, evidence-backed override
# differences between two installs of the "same" tag during development).
git -C lib/openzeppelin-contracts rev-parse HEAD
git -C lib/openzeppelin-contracts-upgradeable rev-parse HEAD
```

Confirm `foundry.toml` has the remappings documented in
`besu-network/README.md` before running anything below.

---

## 2. Running tests — the general commands

```bash
forge build                          # compile only — do this first, always
forge test                           # run every test, every file
forge test -vv                       # + show console.log output
forge test -vvv                      # + show revert reasons and call traces on failure
forge test -vvvv                     # + show full call traces even on success
forge test --match-contract Vault    # only test files whose contract name contains "Vault"
forge test --match-test test_Revert  # only test functions whose name contains this string
forge test --match-path test/Vault.t.sol   # only this specific file
forge coverage                       # line/branch/function coverage report
forge coverage --report lcov         # machine-readable coverage, for CI
forge snapshot                       # gas usage snapshot, for spotting regressions
```

**Recommended order when running this for the first time:** run each file
individually (Section 4 gives the exact command for each), in the order
listed in Section 3 — that order follows each contract's actual
dependency chain, so a failure early on tells you where to look before
spending time on files that depend on the broken piece.

---

## 3. Test files, in dependency order

| # | File | Tests | What it covers |
|---|---|---|---|
| 1 | `InsurancePolicy.t.sol` | 11 | Policy registration, active/inactive windows, eligibility checks — no dependency on any other contract's test setup |
| 2 | `OracleAdapter.t.sol` | 7 | EIP-712 signature verification, replay/expiry protection — depends only on a mock sink, not the real `ClaimRegistry` |
| 3 | `ClaimRegistryUpgrade.t.sol` | 13 | Claim lifecycle, upgrade safety, rate limiting, policy-wiring — uses a mock policy registry to isolate `ClaimRegistry`'s own logic |
| 4 | `Premium.t.sol` | 8 | The real `InsurancePolicy` + real `ClaimRegistry` together — premium payment blocking claims end-to-end |
| 5 | `PolicyCatalog.t.sol` | 7 | Self-service `subscribeToPolicy` — atomic issue-and-pay |
| 6 | `Vault.t.sol` | 8 | The CDP module — deposit, mint, liquidation |
| 7 | `Governance.t.sol` | 3 | The full propose → vote → queue → execute cycle against a real `Vault` |
| 8 | `ClaimGasPaymaster.t.sol` | 2 | EIP-4337 gas sponsorship — a real `EntryPoint` + `SimpleAccount` + signed `UserOperation`, this contract's first real exercise in this project |

---

## 4. Every test case, file by file

### `InsurancePolicy.t.sol`

```bash
forge test --match-path test/InsurancePolicy.t.sol -vvv
```

| Test | What it verifies |
|---|---|
| `test_RegisterPolicy_StoresCorrectData` | A registered policy's fields are stored exactly as submitted |
| `test_RevertWhen_DuplicatePolicyId` | Registering the same policy ID twice reverts |
| `test_RevertWhen_NonManagerRegisters` | Only `POLICY_MANAGER_ROLE` can register a policy |
| `test_IsPolicyActive_TrueWithinWindow` | A policy is active inside its `[validFrom, validUntil]` window |
| `test_IsPolicyActive_FalseBeforeStart` | Inactive before `validFrom` |
| `test_IsPolicyActive_FalseAfterExpiry` | Inactive after `validUntil` |
| `test_IsPolicyActive_FalseWhenRevoked` | A revoked policy is inactive regardless of dates |
| `test_IsClaimEligible_TrueForValidClaim` | The combined eligibility check passes for a legitimate claim |
| `test_IsClaimEligible_FalseForWrongClaimant` | Eligibility fails if the caller isn't the actual holder |
| `test_IsClaimEligible_FalseWhenExceedsCoverage` | Eligibility fails if the amount exceeds coverage |
| `test_RevertWhen_PausedRegistration` | `pause()` blocks new registrations |

### `OracleAdapter.t.sol`

```bash
forge test --match-path test/OracleAdapter.t.sol -vvv
```

| Test | What it verifies |
|---|---|
| `test_ValidSignature_ForwardsToClaimRegistry` | A correctly signed, authorized response is verified and forwarded |
| `test_RevertWhen_SignerNotAuthorized` | A valid signature from a key without `ORACLE_SIGNER_ROLE` is rejected |
| `test_RevertWhen_RequestIdReplayed` | The exact same `requestId` cannot be submitted twice |
| `test_RevertWhen_ResponseExpired` | A response older than the validity window is rejected |
| `test_RevertWhen_TimestampFromFuture` | A response claiming a future timestamp is rejected |
| `test_RevertWhen_Paused` | `pause()` blocks verification submission |
| `test_RevertWhen_RevokedSignerReusesKey` | Revoking a signer's role immediately invalidates their (unused) signatures |

### `ClaimRegistryUpgrade.t.sol`

```bash
forge test --match-path test/ClaimRegistryUpgrade.t.sol -vvv
```

| Test | What it verifies |
|---|---|
| `test_StateSurvivesUpgrade` | Proxy storage is intact after swapping the implementation contract |
| `test_RevertWhen_NonUpgraderCallsUpgrade` | Only `UPGRADER_ROLE` can authorize an upgrade |
| `test_RevertWhen_PausedRejectsSubmitClaim` | `pause()` blocks claim submission |
| `test_RevertWhen_ClaimExceedsRateLimitWindow` | The rolling payout-volume cap is enforced exactly at its boundary |
| `test_RescueForeignToken_RevertsOnPayoutToken` | The foreign-token rescue function cannot touch the actual payout token |
| `test_RevertWhen_ClaimantIsNotPolicyHolder` | Only the real policyholder can submit a claim on their policy |
| `test_RevertWhen_PolicyRevoked` | A revoked policy blocks claim submission |
| `test_RevertWhen_PolicyNotYetValid` | A not-yet-active policy blocks claim submission |
| `test_RevertWhen_ClaimExceedsPolicyCoverage` | A single claim over the coverage cap is rejected |
| `test_RevertWhen_CumulativeNonRejectedClaimsExceedCoverage` | Coverage is a shared budget across multiple pending claims, not a per-claim allowance |
| `test_RejectedClaimFreesUpCoverageForNewSubmission` | A `Rejected` claim no longer counts against coverage |
| `test_RevertWhen_PolicyPremiumLapsed` | A lapsed premium blocks claim submission |
| `test_RevertWhen_PolicyRegistryNotSet` | Claim submission fails cleanly if `InsurancePolicy`'s address was never configured |

### `Premium.t.sol`

```bash
forge test --match-path test/Premium.t.sol -vvv
```

| Test | What it verifies |
|---|---|
| `test_PayPremium_ExtendsFromNowWhenNoPriorPayment` | First payment extends coverage from the current time |
| `test_PayPremium_StacksOnRemainingPeriodRatherThanWastingIt` | An early renewal extends from the prior expiry, not from "now" |
| `test_IsPremiumCurrent_TrueWithinGracePeriodAfterLapse` | The exact grace-period boundary is enforced correctly |
| `test_UnconfiguredPremiumTermsAreExempt` | A policy with no billing configured is treated as exempt, not blocked |
| `test_RevertWhen_NonHolderPaysPremium` | Only the actual policyholder can pay their premium |
| `test_ClaimSubmission_SucceedsWhenPremiumCurrent` | End-to-end: a paid-up policy can be claimed against |
| `test_RevertWhen_ClaimSubmittedAfterPremiumLapsed` | End-to-end: a lapsed policy blocks the claim, using the real `InsurancePolicy` + real `ClaimRegistry` together |
| `test_ClaimSubmission_AllowedWhenNeverBilled` | End-to-end version of the exemption case above |

### `PolicyCatalog.t.sol`

```bash
forge test --match-path test/PolicyCatalog.t.sol -vvv
```

| Test | What it verifies |
|---|---|
| `test_SubscribeToPolicy_IssuesAndPaysAtomically` | Self-service subscription issues the policy and collects payment in one transaction |
| `test_RevertWhen_SubscribingToInactiveTemplate` | A discontinued plan cannot be subscribed to |
| `test_DiscontinuingTemplate_DoesNotAffectExistingPolicy` | Discontinuing a plan doesn't touch policies already issued from it |
| `test_RevertWhen_InsufficientAllowanceLeavesNoOrphanedPolicy` | A failed payment leaves **no** partial policy record — proven directly, not assumed |
| `test_SubscribedPolicy_CanBeClaimedAgainstImmediately` | A freshly subscribed policy is immediately usable |
| `test_RevertWhen_ClaimingAfterSubscribedPolicyLapses` | A subscribed-and-never-renewed policy blocks claims the same way an admin-issued one does |
| `test_SubscribeToPolicy_AutoIncrementsIdsAcrossMultipleUsers` | Policy IDs increment correctly across independent subscribers |

### `Vault.t.sol`

```bash
forge test --match-path test/Vault.t.sol -vvv
```

| Test | What it verifies |
|---|---|
| `test_DepositAndMint_WithinRatio_Succeeds` | Depositing collateral and minting within the healthy ratio works |
| `test_RevertWhen_MintExceedsMinRatio` | Minting past the minimum collateralization ratio is rejected |
| `test_RevertWhen_WithdrawWouldBreachMinRatio` | Withdrawing collateral that would breach the ratio is rejected |
| `test_RepayDebt_ReducesDebtAndBurnsToken` | Repaying debt correctly reduces both the position and the token supply |
| `test_Liquidation_OnPriceDrop` | A full liquidation scenario: price crash → liquidatable → liquidated, using a realistic liquidator funding path |
| `test_RevertWhen_LiquidatingHealthyPosition` | A healthy position cannot be liquidated |
| `test_RevertWhen_PausedBlocksDeposit` | `pause()` blocks deposits |
| `test_RevertWhen_NonAdminUpdatesRiskParams` | Only `ADMIN_ROLE` (the Timelock) can change risk parameters |

### `Governance.t.sol`

```bash
forge test --match-path test/Governance.t.sol -vvv
```

| Test | What it verifies |
|---|---|
| `test_FullGovernanceCycle_UpdatesVaultRiskParams` | The complete propose → vote → queue → execute cycle actually changes a real `Vault` parameter |
| `test_RevertWhen_ExecutingBeforeTimelockDelayElapses` | Execution is blocked until the Timelock's minimum delay has passed |
| `test_RevertWhen_DirectCallBypassingGovernance` | `Vault.updateRiskParams` cannot be called directly, bypassing governance entirely |

### `ClaimGasPaymaster.t.sol`

```bash
forge test --match-path test/ClaimGasPaymaster.t.sol -vvv
```

| Test | What it verifies |
|---|---|
| `test_SponsoredClaimSubmission_SucceedsWithZeroEthInAccount` | A policyholder's smart-contract wallet holding **zero ETH** can still submit a claim — a real, signed `UserOperation` routes through `EntryPoint` → `SimpleAccount` → `ClaimRegistry.submitClaim`, with `ClaimGasPaymaster` covering every wei of gas |
| `test_RevertWhen_DailyCapExceeded` | A sponsorship request that would push a sender's daily total past `dailySponsorshipCapWei` fails validation rather than being partially sponsored |

---

## 5. Coverage target

```bash
forge coverage
```

Every contract handling funds or access control (`ClaimRegistry`,
`InsurancePolicy`, `Vault`, `OracleAdapter`) should show high line and
branch coverage given the test counts above. If `forge coverage` reports
a meaningfully lower percentage than the test count above suggests,
that's worth investigating specifically — it usually means a branch
(an `if`/`revert` path) that no test actually exercises yet.

## 6. What running these tests does *not* verify

Worth being direct about the boundary of what Section 4 covers:

- **`ClaimGasPaymaster.sol` now has real test coverage** (`ClaimGasPaymaster.t.sol`,
  added after this contract sat completely unused in the project),
  including a genuine signed `UserOperation` through a real `EntryPoint`
  — but it's the one test file in this project whose exact API
  assumptions (packing helpers, `SimpleAccountFactory`/`BasePaymaster`
  method signatures) were never independently compiler-verified in the
  environment that wrote it. Treat any mismatch `forge build` reports
  here as expected, real work — see the file's own header.
- **These are unit/integration tests against Foundry's own local EVM**,
  not against the real Besu network. The indexer and oracle-service
  projects each have their own *separate* integration test
  (`npm run test:integration` in both) that deploys these same
  contracts to a real Anvil chain and exercises them from outside
  Solidity — genuinely different coverage than anything in this
  document, and worth running too for full confidence.
- **None of this has been executed by me** — every test file and every
  fix in this project was verified against real `forge build`/`forge
  test` output *you* ran and pasted back, not by me running Foundry
  myself. This guide tells you how to run them; it isn't a report that
  they've already been run and passed.

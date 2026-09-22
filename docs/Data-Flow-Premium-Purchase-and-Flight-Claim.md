# Data flow: buying Premium insurance, then claiming a cancelled flight

**Scenario traced exactly as given:**
- Three plans exist: Basic ($11/period), Standard ($22/period), Premium ($33/period)
- User subscribes to the **Premium** plan
- Their flight is cancelled; they file a claim through the UI and receive a **$221** payout

**Currency note, stated up front rather than glossed over:** this trace
assumes an 18-decimal ERC-20 for both `premiumToken` and `payoutToken`
(the project's convention throughout — `dUSD` and the test payout token
both use 18 decimals), so `$33` on-chain is the raw `uint256` value
`33000000000000000000` (`33 × 10^18`). **These are two separately
configured tokens in the code as it stands** — nothing enforces they're
the same currency. This trace uses `$` loosely to match your framing;
the "input data" rows show the real `uint256` values a contract actually
sees.

**Example values used throughout this trace:**

| Concept | Value |
|---|---|
| Premium plan `templateId` | `3` |
| Coverage cap on the Premium plan | `500` tokens (`500e18`) — a cap, not the claim amount |
| Premium price | `33e18` per 30-day period |
| Assigned `policyId` on subscription | `101` |
| Claim amount | `221e18` |
| Assigned `claimId` | `1` |
| Oracle `requestId` | a fresh random `bytes32` each time |

---

## Phase A — Setup (happened earlier, by the insurer — context only)

| # | Detail |
|---|---|
| **Smart contract** | `InsurancePolicy.sol` |
| **Function** | `addPolicyTemplate(uint256 templateId, uint256 coverageAmount, uint256 premiumAmountPerPeriod, uint256 periodSeconds, uint256 termSeconds, bytes32 metadataHash)` |
| **Input data** | Called 3 times by `POLICY_MANAGER_ROLE`: `(1, 150e18, 11e18, 30 days, 365 days, keccak256("basic"))`, `(2, 300e18, 22e18, 30 days, 365 days, keccak256("standard"))`, `(3, 500e18, 33e18, 30 days, 365 days, keccak256("premium"))` |
| **Data traversal** | Each call builds a `PolicyTemplate` struct in memory (`coverageAmount` and `premiumAmountPerPeriod` narrowed from the `uint256` parameters to `uint128` via explicit cast — reverts at the EVM level if a value doesn't fit, though $11/$22/$33 scaled to 18 decimals are nowhere near that limit), sets `active = true`, and writes it to `policyTemplates[templateId]` storage. |
| **Output data** | No return value (`external`, no `returns`). Emits `PolicyTemplateAdded(templateId, coverageAmount, premiumAmountPerPeriod, periodSeconds, termSeconds)`. |
| **Imported contracts used in this function** | None directly — role check via `onlyRole(POLICY_MANAGER_ROLE)` uses `AccessControlUpgradeable` (OpenZeppelin), and `whenNotPaused` uses `PausableUpgradeable` (OpenZeppelin). |

At this point the on-chain catalog has three entries. Nothing else has happened yet.

---

## Phase B — User buys the Premium plan

### B1 — Approve the token spend (standard ERC-20, not custom project code)

| # | Detail |
|---|---|
| **Smart contract** | `StableCoin.sol` (inherits OpenZeppelin's `ERC20`) |
| **Function** | `approve(address spender, uint256 value)` — inherited, not overridden by `StableCoin.sol` |
| **Input data** | `spender = InsurancePolicy proxy address`, `value = 33e18` (or `type(uint256).max` if the frontend requests unlimited approval, as `FileClaim.jsx`'s pattern elsewhere in this project does) |
| **Data traversal** | Standard OpenZeppelin `ERC20._approve` — writes `_allowances[msg.sender][spender] = value` in storage. No custom logic; `StableCoin.sol` adds nothing on top of this function. |
| **Output data** | Returns `bool success = true`. Emits the standard `Approval(owner, spender, value)` event. |
| **Imported contracts used** | `@openzeppelin/contracts/token/ERC20/ERC20.sol` (the base contract this entire function comes from). |

This step happens in the user's wallet, triggered by the frontend, **before** the actual subscription call — `subscribeToPolicy` will fail without it, since it needs to pull tokens via `transferFrom`.

### B2 — Subscribe (the real entry point)

| # | Detail |
|---|---|
| **Smart contract** | `InsurancePolicy.sol` |
| **Function** | `subscribeToPolicy(uint256 templateId) external whenNotPaused nonReentrant returns (uint256 policyId)` |
| **Input data** | `templateId = 3` (uint256) |
| **Data traversal** | See step-by-step breakdown below — this function does the most internal work of anything in this trace. |
| **Output data** | Returns `policyId = 101` (uint256). Emits **two** events: `PolicyRegistered(101, userAddress, validFrom, validUntil, 500e18, keccak256("premium"))` and `PolicySubscribed(101, 3, userAddress, validUntil)`. |
| **Imported contracts used** | `SafeERC20` (OpenZeppelin) — used inside the nested `_collectPremium` call (step B2.6 below) for the actual token pull. |

**Step-by-step internal traversal of `subscribeToPolicy`:**

1. Reads `PolicyTemplate memory template = policyTemplates[3]` from storage into memory — `{coverageAmount: 500e18, premiumAmountPerPeriod: 33e18, periodSeconds: 30 days, termSeconds: 365 days, active: true, metadataHash: keccak256("premium")}`.
2. Checks `template.premiumAmountPerPeriod == 0` → false, continues. Checks `!template.active` → false (it's active), continues.
3. Reads `nextPolicyId` from storage (assume `101`, meaning 100 policies were issued before this one across the system's lifetime). Enters the bounded collision-check loop: `while (_exists[101])` — false, loop doesn't execute. `policyId = 101`.
4. Writes `nextPolicyId = 102` to storage — the counter advances **before** any external call happens (checks-effects-interactions ordering).
5. Computes `validUntil = block.timestamp + 365 days` (uint256 arithmetic).
6. Constructs the `Policy` struct in memory and writes it to `_policies[101]` in storage: `{policyId: 101 (cast to uint128), coverageAmount: 500e18 (cast to uint128), holder: userAddress, validFrom: block.timestamp (cast to uint40), validUntil: computed value (cast to uint40), revoked: false, metadataHash: keccak256("premium")}`. Sets `_exists[101] = true`.
7. Writes `premiumTerms[101] = PremiumTerms({amountPerPeriod: 33e18, periodSeconds: 30 days})` to storage — the pricing is copied from the template onto this specific policy, locking in the rate at subscription time.
8. Emits `PolicyRegistered` then `PolicySubscribed`.
9. **Calls the internal `_collectPremium(101, userAddress)`** — this is where the actual money moves:
   - Checks `premiumToken != address(0)` → passes (assuming `setPremiumConfig` was run during deployment).
   - Reads `premiumTerms[101]` back from storage → `{33e18, 30 days}`.
   - Computes `base = premiumPaidUntil[101] > block.timestamp ? premiumPaidUntil[101] : block.timestamp`. Since this policy is brand new, `premiumPaidUntil[101]` is `0`, so `base = block.timestamp`.
   - Computes `newPaidUntil = base + 30 days`. Writes `premiumPaidUntil[101] = newPaidUntil` to storage.
   - **External call**: `premiumToken.safeTransferFrom(userAddress, premiumTreasury, 33e18)` — this is a real `CALL` (not `STATICCALL`, since it mutates the token contract's balances) into `StableCoin.sol`'s inherited `transferFrom`, which checks the allowance set in step B1, decrements it, and moves `33e18` from the user's balance to `premiumTreasury`'s balance.
   - Emits `PremiumPaid(101, userAddress, 33e18, newPaidUntil)`.

**After Phase B completes:** the user holds an active `Policy` (id `101`) with a `500e18` coverage cap, `premiumPaidUntil` set ~30 days out, and `premiumTreasury` is `33e18` tokens richer. This is the entire "buy Premium insurance" flow — one `approve` and one `subscribeToPolicy` call.

---

## Phase C — Flight cancelled: filing the claim

By this point, off-chain, the user has been notified their flight was cancelled and opens the frontend's "File a new claim" page. The frontend calls the backend's `POST /claims` first (off-chain, not a smart contract — recorded only for context) to create the off-chain draft and generate the `merkleRoot` correlation value, then submits the on-chain transaction below.

| # | Detail |
|---|---|
| **Smart contract** | `ClaimRegistry.sol` |
| **Function** | `submitClaim(uint256 policyId, bytes32 merkleRoot, uint256 amount) external whenNotPaused returns (uint256 claimId)` |
| **Input data** | `policyId = 101`, `merkleRoot = <32-byte hash from the backend>`, `amount = 221e18` |
| **Data traversal** | See breakdown below — this is the function that makes **two separate cross-contract calls** into `InsurancePolicy`. |
| **Output data** | Returns `claimId = 1` (uint256). Emits `ClaimSubmitted(1, 101, userAddress, merkleRoot, 221e18, block.timestamp)`. |
| **Imported contracts used** | `IInsurancePolicyRegistry` — a **locally-declared interface** inside `ClaimRegistry.sol` itself (not a real import from another file), structurally matching `InsurancePolicy.sol`'s actual `Policy` struct and its `getPolicy`/`isPremiumCurrent` functions. `SafeERC20`/`IERC20` are also imported but not used in this specific function (they matter later, in Phase D's payout). |

**Step-by-step internal traversal of `submitClaim`:**

1. Checks `amount (221e18) > maxPayoutPerClaim` — false (assuming the configured cap is comfortably above $221), continues.
2. Checks `policyRegistry == address(0)` — false (it's configured), continues.
3. **First cross-contract call**: `IInsurancePolicyRegistry(policyRegistry).getPolicy(101)` — compiles to a `STATICCALL` (the interface declares this function `view`), meaning it's read-only and introduces no reentrancy risk. This calls into `InsurancePolicy.sol`'s real `getPolicy` function, which reads `_policies[101]` from its own storage and returns the `Policy` struct: `{policyId: 101, coverageAmount: 500e18, holder: userAddress, validFrom: <subscription time>, validUntil: <subscription time + 365 days>, revoked: false, metadataHash: keccak256("premium")}`. This return value crosses back into `ClaimRegistry`'s execution context as a `memory` struct.
4. Checks `p.revoked || block.timestamp < p.validFrom || block.timestamp > p.validUntil` — all false (the policy is active, well within its 1-year term), continues.
5. Checks `p.holder != msg.sender` — false (the caller is the actual policyholder), continues.
6. **Second cross-contract call**: `IInsurancePolicyRegistry(policyRegistry).isPremiumCurrent(101)` — another `STATICCALL`, into `InsurancePolicy.sol`'s real `isPremiumCurrent`. That function reads `premiumTerms[101].amountPerPeriod` (`33e18`, non-zero, so it's not exempt), then checks `block.timestamp <= premiumPaidUntil[101] + premiumGracePeriodSeconds`. Assuming the claim is filed well within the 30-day paid period, this returns `true`.
7. Checks `!true` — false, continues (if this had returned `false`, `submitClaim` would revert here with `PremiumNotCurrent` and nothing past this point would execute).
8. **Internal call** (not cross-contract — a `private` function on the same contract): `_consumedCoverage(101)` — loops over `policyClaims[101]` (empty, since this is the first claim ever on this policy) and returns `0`.
9. Checks `0 + 221e18 > 500e18` (consumed-so-far plus this claim, against the coverage cap) — false, `221e18` fits comfortably under the `500e18` cap, continues.
10. Only now does it mutate state: `claimId = nextClaimId++` (assume this returns `1`), writes the full `Claim` struct to `claims[1]` in storage with `status = Submitted`, pushes `1` into `policyClaims[101]`.
11. Emits `ClaimSubmitted`.

**After Phase C completes:** claim `1` exists, referencing policy `101`, status `Submitted`, for `221e18`. Nothing has been verified or paid yet.

---

## Phase D — Oracle verifies the cancellation, then payout

Since a flight cancellation is objectively checkable external data, this trace uses the **oracle path** (not a manual underwriter decision) — matching the parametric-insurance pattern discussed earlier in this project. Off-chain, `oracle-service` receives a verification request, checks the (mocked, in this project) decision logic, and produces a signed `OracleResponse`.

### D1 — Oracle signature verification and forwarding

| # | Detail |
|---|---|
| **Smart contract** | `OracleAdapter.sol` |
| **Function** | `submitVerification(OracleResponse calldata response, bytes calldata signature) external whenNotPaused` |
| **Input data** | `response = {claimId: 1, requestId: <fresh random bytes32>, approved: true, timestamp: <recent block.timestamp>}`, `signature = <65-byte ECDSA signature from the oracle's key>` |
| **Data traversal** | See breakdown below. |
| **Output data** | No return value. Emits `VerificationSubmitted(1, requestId, true, signerAddress)`. |
| **Imported contracts used** | `EIP712Upgradeable` (OpenZeppelin — supplies `_hashTypedDataV4`), `ECDSA` (OpenZeppelin — supplies `recover`), plus the locally-declared `IClaimRegistryOracleSink` interface (structurally matching `ClaimRegistry.sol`'s `recordOracleVerification`). |

**Step-by-step internal traversal of `submitVerification`:**

1. Checks `usedRequestIds[requestId]` — false (fresh request), continues.
2. Checks `response.timestamp > block.timestamp` — false, and `block.timestamp > response.timestamp + responseValidityWindow` — false (submitted promptly), continues.
3. Computes `structHash = keccak256(abi.encode(ORACLE_RESPONSE_TYPEHASH, 1, requestId, true, response.timestamp))` — the EIP-712 struct hash, using the compile-time-computed typehash.
4. Computes `digest = _hashTypedDataV4(structHash)` — folds in this contract's own domain separator (name `"DICS-OracleAdapter"`, version `"1"`, this chain ID, this contract's address).
5. `ECDSA.recover(digest, signature)` — recovers the address that actually produced the signature.
6. Checks `!hasRole(ORACLE_SIGNER_ROLE, signer)` — false (assuming the recovered address genuinely holds the role), continues.
7. Writes `usedRequestIds[requestId] = true` — this specific request can never be submitted again.
8. **Cross-contract call**: `claimRegistry.recordOracleVerification(1, requestId, true)` — a real `CALL` into `ClaimRegistry.sol`.
9. Emits `VerificationSubmitted`.

### D2 — ClaimRegistry records the verified result

| # | Detail |
|---|---|
| **Smart contract** | `ClaimRegistry.sol` |
| **Function** | `recordOracleVerification(uint256 claimId, bytes32 requestId, bool approved) external whenNotPaused onlyRole(ORACLE_ROLE)` |
| **Input data** | `claimId = 1`, `requestId = <same value from D1>`, `approved = true` — called by `OracleAdapter`'s own address, which must hold `ORACLE_ROLE` |
| **Data traversal** | Checks `usedOracleRequestIds[requestId]` (**a second, independent replay check** — `ClaimRegistry` doesn't trust `OracleAdapter`'s own replay protection alone) — false, continues. Writes `usedOracleRequestIds[requestId] = true`. Reads `claims[1]` from storage into a `storage` reference, checks `c.claimant == address(0)` — false (it exists), continues. Sets `c.status = Approved` (since `approved == true`), sets `c.processedAt = block.timestamp`. |
| **Output data** | No return value. Emits `ClaimStatusChanged(1, ClaimStatus.Approved)`. |
| **Imported contracts used** | None new for this specific function — role check via `AccessControlUpgradeable` (OpenZeppelin), already imported. |

### D3 — Payout

| # | Detail |
|---|---|
| **Smart contract** | `ClaimRegistry.sol` |
| **Function** | `payoutClaim(uint256 claimId) external whenNotPaused nonReentrant onlyRole(UNDERWRITER_ROLE)` |
| **Input data** | `claimId = 1` — called by an address holding `UNDERWRITER_ROLE` (the underwriter Safe) |
| **Data traversal** | See breakdown below. |
| **Output data** | No return value. Emits `ClaimPayout(1, userAddress, 221e18, payoutTokenAddress)`. |
| **Imported contracts used** | `IERC20` and `SafeERC20` (OpenZeppelin) — this is where they're actually used in this whole trace. |

**Step-by-step internal traversal of `payoutClaim`:**

1. Reads `claims[1]` from storage. Checks `c.claimant == address(0)` — false, continues. Checks `c.status != Approved` — false (it was just set to `Approved` in D2), continues.
2. **Internal call**: `_enforceRateLimit(221e18)` — checks whether the current rolling window's total (window resets if `block.timestamp >= _windowStart + rateLimitWindowSeconds`) plus `221e18` would exceed `maxPayoutPerWindow`. Assuming it doesn't, adds `221e18` to `_windowTotalPaid`.
3. Writes `c.status = Paid`, `c.processedAt = block.timestamp` — **state is updated before the external call below**, the checks-effects-interactions pattern that prevents reentrancy even independent of the `nonReentrant` guard already on this function.
4. **External call**: `payoutToken.safeTransfer(userAddress, 221e18)` — moves `221e18` of whatever ERC-20 `payoutToken` is configured to (see the currency note at the top of this document — this is a **different token** from the `premiumToken` used in Phase B unless a deployment deliberately configures both to point at the same address) from `ClaimRegistry`'s own balance to the user's wallet.
5. Emits `ClaimPayout`.

**After Phase D completes:** claim `1` has status `Paid`. The user's wallet balance of `payoutToken` increased by `221e18`. Separately (off-chain, not shown here), the indexer picks up the `ClaimPayout` event within one poll interval and calls the backend's `/internal/onchain-events` webhook, which updates the off-chain claim record's status to `"paid"` so the frontend's Dashboard/ClaimStatus pages reflect it on next load.

---

## Full call-stack summary (indentation shows nesting)

```
Wallet: StableCoin.approve(InsurancePolicy, 33e18)
InsurancePolicy.subscribeToPolicy(3)
  -> premiumToken.safeTransferFrom(user, treasury, 33e18)   [external, mutates StableCoin storage]

ClaimRegistry.submitClaim(101, merkleRoot, 221e18)
  -> InsurancePolicy.getPolicy(101)            [STATICCALL, read-only]
  -> InsurancePolicy.isPremiumCurrent(101)     [STATICCALL, read-only]

OracleAdapter.submitVerification(response, signature)
  -> ClaimRegistry.recordOracleVerification(1, requestId, true)   [external, mutates ClaimRegistry storage]

ClaimRegistry.payoutClaim(1)
  -> payoutToken.safeTransfer(user, 221e18)    [external, mutates payoutToken storage]
```

## Worth deciding, surfaced by tracing this precisely

**Should `premiumToken` and `payoutToken` be forced to be the same
address?** Nothing in the code currently prevents a deployment from
configuring them as two unrelated tokens, which would mean a user pays
premiums in one currency and receives claim payouts in a completely
different one — almost certainly not the intended real-world behavior,
but not something either contract currently checks or enforces. This
wasn't a deliberate design decision anywhere in this project's history;
it's a gap this trace exposed. Want me to add a check (or just point
both at the same `StableCoin` address at deployment time) so this can't
silently diverge?

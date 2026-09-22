# Data Flow — Premium Purchase → Flight-Cancellation Claim → $221 Payout

**Scenario:** Alice subscribes to the "Premium" plan ($33/period). Her
flight is later cancelled. She files a claim through the frontend and
receives $221.

**Currency decision made explicit for this document:** both the premium
and the payout are denominated in `dUSD` (`StableCoin.sol`). This is a
real, deliberate deployment choice — `ClaimRegistry`'s `payoutToken` and
`InsurancePolicy`'s `premiumToken` are both just configurable `IERC20`
addresses, and pointing both at `StableCoin` creates a single coherent
currency across the whole story. **The honest dependency this creates**:
`StableCoin` can only be minted by `Vault` (`onlyVault` modifier) —
`ClaimRegistry` has no minting rights at all. For `ClaimRegistry` to have
221+ `dUSD` on hand to pay Alice, **someone** (the insurer) must have
already minted it via their own `Vault` position and transferred it in.
That prerequisite is documented in Part 2, clearly separated from the
live claim flow itself, because it doesn't happen *during* Alice's
transaction — it has to have already happened.

All amounts below use 18-decimal fixed-point (`ether` in Solidity =
`10^18`), matching every contract in this project. `$33` = `33 ether` =
`33000000000000000000` wei-equivalent units.

---

## Part 0 — Assumed pre-state (what must already be true)

| Actor | Pre-state |
|---|---|
| Alice | Holds ≥ 33 `dUSD`, already `approve`'d `InsurancePolicy` to spend it |
| Insurer treasury | `ClaimRegistry`'s own token balance holds ≥ 221 `dUSD` |
| Oracle service | Holds `ORACLE_SIGNER_ROLE` on `OracleAdapter` |
| Underwriter Safe | Holds `UNDERWRITER_ROLE` on `ClaimRegistry` |
| `InsurancePolicy` | Has a `PolicyTemplate` at id `3` ("Premium"): `coverageAmount = 5,000 ether`, `premiumAmountPerPeriod = 33 ether`, `periodSeconds = 30 days`, `termSeconds = 365 days` |
| `InsurancePolicy` | `premiumToken` set to `StableCoin`'s address, `premiumTreasury` set to the insurer's treasury address |
| `ClaimRegistry` | `payoutToken` set to `StableCoin`'s address, `maxPayoutPerClaim ≥ 221 ether` |

How Alice and the insurer got their `dUSD` in the first place is real,
necessary context — covered in Part 2, not skipped, but kept separate
because it isn't part of the transaction sequence a block explorer would
show you for "Alice buys insurance and gets paid."

---

## Part 1 — The live transaction sequence

### Phase A — Alice subscribes to the Premium plan

#### A1. `StableCoin.sol` → `approve` *(inherited from OpenZeppelin `ERC20`, not custom code)*

- **Function:** `approve(address spender, uint256 amount)`
- **Inputs:** `spender: address` = `InsurancePolicy` proxy address; `amount: uint256` = `33 ether`
- **Data traversal:** Writes `_allowances[Alice][InsurancePolicy] = 33 ether` directly — no other logic. This is the standard **EIP-20** approval step; without it, step A3's `transferFrom` would revert.
- **Output:** `bool` (`true`), plus a standard EIP-20 `Approval(Alice, InsurancePolicy, 33 ether)` event.
- **Imports used:** None beyond OpenZeppelin's own `ERC20.sol` internals — `StableCoin.sol` doesn't override this function at all.

#### A2. `InsurancePolicy.sol` → `subscribeToPolicy`

- **Function:** `subscribeToPolicy(uint256 templateId)`
- **Inputs:** `templateId: uint256` = `3`
- **Data traversal, in order:**
  1. Reads `policyTemplates[3]` into memory → `PolicyTemplate{coverageAmount: 5000 ether, premiumAmountPerPeriod: 33 ether, periodSeconds: 30 days, termSeconds: 365 days, active: true, metadataHash: 0x...}`.
  2. Checks `premiumAmountPerPeriod != 0` (template exists) and `active == true`.
  3. Computes a fresh `policyId` from `nextPolicyId` (skip-forward loop if collision, not triggered here) — say `policyId = 1`.
  4. Builds and stores `Policy{policyId: 1, coverageAmount: 5000 ether, holder: Alice, validFrom: block.timestamp, validUntil: block.timestamp + 365 days, revoked: false, metadataHash: 0x...}` into `_policies[1]`; sets `_exists[1] = true`.
  5. Stores `premiumTerms[1] = PremiumTerms{amountPerPeriod: 33 ether, periodSeconds: 30 days}` — copied from the template, locking in Alice's rate at subscription time.
  6. Emits `PolicyRegistered(1, Alice, validFrom, validUntil, 5000 ether, metadataHash)` and `PolicySubscribed(1, 3, Alice, validUntil)`.
  7. Calls the internal `_collectPremium(1, Alice)` (Phase A3, below) — **still inside the same transaction**.
- **Output:** `uint256 policyId` = `1`. If step A3 (called internally) reverts for any reason, this entire function reverts too — no partial state.
- **Imports used:** `IERC20`/`SafeERC20` (for A3's transfer), `AccessControlUpgradeable` (role checks elsewhere in the file, not this function), `PausableUpgradeable` (`whenNotPaused` guard), `ReentrancyGuardUpgradeable` (`nonReentrant` guard — relevant because A3 makes an external token call).

#### A3. `InsurancePolicy.sol` → `_collectPremium` *(private, called only from within A2)*

- **Function:** `_collectPremium(uint256 policyId, address payer)`
- **Inputs:** `policyId: uint256` = `1`; `payer: address` = `Alice`
- **Data traversal:**
  1. Checks `premiumToken != address(0)` and `premiumTerms[1].amountPerPeriod != 0`.
  2. Computes `base = max(premiumPaidUntil[1], block.timestamp)` — since `premiumPaidUntil[1]` is `0` (brand new policy), `base = block.timestamp`.
  3. `newPaidUntil = base + 30 days`; stores it into `premiumPaidUntil[1]`.
  4. Calls `premiumToken.safeTransferFrom(Alice, premiumTreasury, 33 ether)` — this is a **STATICCALL-incapable, state-changing external call** into `StableCoin.sol` (Phase A4, below).
  5. Emits `PremiumPaid(1, Alice, 33 ether, newPaidUntil)`.
- **Output:** none (void) — success is implied by not reverting.
- **Imports used:** `IERC20`, `SafeERC20` — `SafeERC20.safeTransferFrom` is what actually invokes A4.

#### A4. `StableCoin.sol` → `transferFrom` *(inherited from OpenZeppelin `ERC20`)*

- **Function:** `transferFrom(address from, address to, uint256 amount)`
- **Inputs:** `from: address` = `Alice`; `to: address` = insurer's `premiumTreasury`; `amount: uint256` = `33 ether`
- **Data traversal:** Checks `_allowances[Alice][InsurancePolicy] >= 33 ether` (set in A1), decrements it by `33 ether`, decrements `_balances[Alice]` by `33 ether`, increments `_balances[premiumTreasury]` by `33 ether`.
- **Output:** `bool` (`true`); emits the **EIP-20** `Transfer(Alice, premiumTreasury, 33 ether)` event.
- **Imports used:** none beyond `ERC20.sol`'s own internals — same as A1, `StableCoin.sol` never overrides this.

**Phase A result:** Alice holds a valid, paid-through-next-month policy.
33 `dUSD` has physically moved from her wallet to the insurer's
treasury, via a completely standard **EIP-20** approve-then-transferFrom
pair — no custom token logic was involved at any point in this phase.

---

### Phase B — Alice logs in and files a claim (flight cancelled)

#### B1. *(Off-chain — no contract call)* Wallet login via **EIP-191**

- Frontend calls backend `GET /auth/nonce?address=Alice` → backend generates a random nonce, returns `message: "Aurelia Labs login nonce: <nonce>"`.
- Alice's wallet signs this exact string via `personal_sign` — the **EIP-191** "presonal message" format. Concretely: the wallet computes `keccak256("\x19Ethereum Signed Message:\n" + len(message) + message)` and produces an ECDSA signature `(v, r, s)` over that hash.
- Backend calls `Account.recover_message` (Python `eth_account`) on the same hash, recovers an address, and checks it equals Alice's claimed address.
- **No smart contract is involved in this step at all** — it's entirely off-chain, backend-verified. Worth being precise about that, since EIP-191 is often assumed to be an on-chain mechanism; here it authenticates an HTTP session, nothing more.

#### B2. `ClaimRegistry.sol` → `submitClaim`

- **Function:** `submitClaim(uint256 policyId, bytes32 merkleRoot, uint256 amount)`
- **Inputs:** `policyId: uint256` = `1`; `merkleRoot: bytes32` = a placeholder hash of Alice's claim description (real evidence hashing isn't built — see prior "still open" notes); `amount: uint256` = `221 ether`
- **Data traversal, in order:**
  1. Checks `221 ether <= maxPayoutPerClaim`.
  2. Checks `policyRegistry != address(0)`.
  3. Calls `IInsurancePolicyRegistry(policyRegistry).getPolicy(1)` — an external **STATICCALL** (the interface function is `view`) into `InsurancePolicy.sol` (Phase B3, below).
  4. Receives back a `Policy` struct; checks `revoked == false`, `block.timestamp` within `[validFrom, validUntil]`, and `p.holder == Alice` (the caller).
  5. Calls `IInsurancePolicyRegistry(policyRegistry).isPremiumCurrent(1)` — another STATICCALL into `InsurancePolicy.sol` (Phase B4).
  6. Receives `true` (Alice paid in Phase A); if `false`, reverts here with `PremiumNotCurrent` — this is the exact enforcement point discussed earlier in this project's history.
  7. Calls the internal `_consumedCoverage(1)` — loops `policyClaims[1]` (empty so far), returns `0`.
  8. Checks `0 + 221 ether <= 5000 ether` (coverage headroom) — passes.
  9. Assigns `claimId = nextClaimId` (`1`), stores `Claim{claimId: 1, policyId: 1, claimant: Alice, amount: 221 ether, status: Submitted, submittedAt: block.timestamp, processedAt: 0, merkleRoot}`.
  10. Pushes `1` into `policyClaims[1]`.
  11. Emits `ClaimSubmitted(1, 1, Alice, merkleRoot, 221 ether, block.timestamp)`.
- **Output:** `uint256 claimId` = `1`.
- **Imports used:** the locally-declared `IInsurancePolicyRegistry` interface (structurally duplicates `InsurancePolicy`'s `Policy` struct — see Project 1's "why" note on this), `AccessControlUpgradeable`, `PausableUpgradeable`, `ReentrancyGuardUpgradeable` (not actually needed here since this function moves no funds, but inherited), `UUPSUpgradeable`.

#### B3. `InsurancePolicy.sol` → `getPolicy` (called from B2, step 3)

- **Function:** `getPolicy(uint256 policyId) external view returns (Policy memory)`
- **Inputs:** `policyId: uint256` = `1`
- **Data traversal:** Checks `_exists[1] == true`; returns `_policies[1]` verbatim — pure lookup, no mutation (this is why it compiles to a `STATICCALL` from the caller's side, not a full transaction call).
- **Output:** `Policy{policyId: 1, coverageAmount: 5000 ether, holder: Alice, validFrom, validUntil, revoked: false, metadataHash}`.
- **Imports used:** none beyond its own base contracts — this function touches no external contract.

#### B4. `InsurancePolicy.sol` → `isPremiumCurrent` (called from B2, step 5)

- **Function:** `isPremiumCurrent(uint256 policyId) public view returns (bool)`
- **Inputs:** `policyId: uint256` = `1`
- **Data traversal:** Checks `premiumTerms[1].amountPerPeriod != 0` (it's `33 ether`, so billing is active for this policy — not exempt); returns `block.timestamp <= premiumPaidUntil[1] + premiumGracePeriodSeconds`. Since Alice just paid in Phase A, `premiumPaidUntil[1]` is roughly 30 days in the future — comfortably `true`.
- **Output:** `bool` = `true`.
- **Imports used:** none.

**Phase B result:** a `Claim` record exists on-chain with status
`Submitted`. No money has moved yet.

---

### Phase C — Oracle verifies the flight cancellation

#### C1. *(Off-chain)* Backend triggers verification

- Backend `POST /claims/1/trigger-verification` calls `oracle_client.request_verification(claim_id=1, declared_amount=221)`, which sends `POST http://oracle-service/verify` with header `X-Oracle-Service-Key` and body `{"claimId": 1, "declaredAmount": 221}`.

#### C2. *(Off-chain)* `verificationLogic.js` → `evaluateClaim`

- **Inputs:** `{claimId: 1, declaredAmount: 221}`
- **Data traversal:** `221 <= 100,000` (the mock threshold) → `approved = true`. Explicitly a placeholder decision function, not real flight-status verification — see the file's own labeling.
- **Output:** `{approved: true, reason: "MOCK: within placeholder threshold, no red flags"}`.

#### C3. *(Off-chain)* `signer.js` → `signOracleResponse` — this is where **EIP-712** happens

- **Inputs:** a wallet (the oracle's signing key) and `payload: {claimId: 1, requestId: <random 32 bytes>, approved: true, timestamp: <now>}`.
- **Data traversal, step by step:**
  1. Builds the **EIP-712 domain**: `{name: "DICS-OracleAdapter", version: "1", chainId: <network>, verifyingContract: <OracleAdapter proxy address>}`.
  2. Builds the typed-data struct hash: `keccak256(abi.encode(ORACLE_RESPONSE_TYPEHASH, 1, requestId, true, timestamp))` — where `ORACLE_RESPONSE_TYPEHASH` is the compile-time constant `keccak256("OracleResponse(uint256 claimId,bytes32 requestId,bool approved,uint256 timestamp)")`.
  3. Computes the final digest: `keccak256("\x19\x01" ‖ domainSeparator ‖ structHash)` — this `\x19\x01` prefix (vs. EIP-191's `\x19Ethereum Signed Message:\n<len>`) is the actual byte-level difference between the two signing schemes; both ultimately produce an ECDSA signature over a `bytes32` digest using the same secp256k1 math.
  4. Signs the digest with the oracle's private key, producing `(v, r, s)`.
- **Output:** a 65-byte `signature`.

#### C4. `OracleAdapter.sol` → `submitVerification`

- **Function:** `submitVerification(OracleResponse calldata response, bytes calldata signature)`
- **Inputs:** `response: {claimId: 1, requestId: <32 bytes>, approved: true, timestamp: <unix seconds>}`; `signature: bytes`
- **Data traversal, in order:**
  1. Checks `usedRequestIds[requestId] == false` (this contract's own replay guard — independent of `ClaimRegistry`'s).
  2. Checks `response.timestamp <= block.timestamp` (not from the future) and `block.timestamp <= response.timestamp + responseValidityWindow` (not expired).
  3. Recomputes the exact same struct hash and digest as C3, using `_hashTypedDataV4` (inherited from `EIP712Upgradeable`) — this internally reads the domain separator this contract cached at `initialize()` time (or recomputes it if `block.chainid` has changed since, a safety check `EIP712Upgradeable` performs automatically).
  4. Calls `ECDSA.recover(digest, signature)` → recovers an `address` — the actual cryptographic core, identical secp256k1 recovery math to what verifies an EIP-191 signature; only the digest construction differed.
  5. Checks `hasRole(ORACLE_SIGNER_ROLE, recoveredAddress)` — reverts with `UnauthorizedSigner` if the recovered address isn't the oracle's known key.
  6. Sets `usedRequestIds[requestId] = true`.
  7. Calls `claimRegistry.recordOracleVerification(1, requestId, true)` — an external, state-changing call into `ClaimRegistry.sol` (Phase C5).
  8. Emits `VerificationSubmitted(1, requestId, true, recoveredAddress)`.
- **Output:** none (void).
- **Imports used:** `EIP712Upgradeable` (digest construction), `ECDSA` (signature recovery), the locally-declared `IClaimRegistryOracleSink` interface (the minimal shape needed to call step 7), `AccessControlUpgradeable`, `PausableUpgradeable`, `UUPSUpgradeable`.

#### C5. `ClaimRegistry.sol` → `recordOracleVerification` (called from C4, step 7)

- **Function:** `recordOracleVerification(uint256 claimId, bytes32 requestId, bool approved)`
- **Inputs:** `claimId: uint256` = `1`; `requestId: bytes32`; `approved: bool` = `true`
- **Caller check:** `onlyRole(ORACLE_ROLE)` — `msg.sender` here is `OracleAdapter`'s own proxy address, which is what must hold `ORACLE_ROLE`, not the off-chain oracle key itself.
- **Data traversal:**
  1. Checks `usedOracleRequestIds[requestId] == false` — `ClaimRegistry`'s **own, separate** replay guard, deliberately redundant with `OracleAdapter`'s.
  2. Sets `usedOracleRequestIds[requestId] = true`.
  3. Looks up `claims[1]`, checks it exists.
  4. Sets `claims[1].status = Approved`, `claims[1].processedAt = block.timestamp`.
  5. Emits `ClaimStatusChanged(1, Approved)`.
- **Output:** none.
- **Imports used:** none new beyond what B2 already brought in.

**Phase C result:** the claim's status is now `Approved` on-chain. Still
no money has moved.

---

### Phase D — Underwriter triggers payout

#### D1. `ClaimRegistry.sol` → `payoutClaim`

- **Function:** `payoutClaim(uint256 claimId)`
- **Inputs:** `claimId: uint256` = `1`
- **Caller check:** `onlyRole(UNDERWRITER_ROLE)` — the underwriter Safe.
- **Data traversal, in order:**
  1. Checks `claims[1]` exists and `status == Approved`.
  2. Calls internal `_enforceRateLimit(221 ether)`: checks/resets the rolling window, checks `_windowTotalPaid + 221 ether <= maxPayoutPerWindow`, updates `_windowTotalPaid`.
  3. Sets `claims[1].status = Paid`, `claims[1].processedAt = block.timestamp`.
  4. Calls `payoutToken.safeTransfer(Alice, 221 ether)` — a state-changing external call into `StableCoin.sol` (Phase D2, since `payoutToken == StableCoin` per this document's deployment decision).
  5. Emits `ClaimPayout(1, Alice, 221 ether, address(payoutToken))`.
- **Output:** none.
- **Imports used:** `IERC20`/`SafeERC20` (for step 4), `ReentrancyGuardUpgradeable` (`nonReentrant` — genuinely load-bearing here, since step 4 is an external call and step 3 deliberately happens *before* it, checks-effects-interactions plus the guard as belt-and-suspenders).

#### D2. `StableCoin.sol` → `transfer` *(inherited from OpenZeppelin `ERC20`)*

- **Function:** `transfer(address to, uint256 amount)`
- **Inputs:** `to: address` = `Alice`; `amount: uint256` = `221 ether`
- **Data traversal:** Checks `_balances[ClaimRegistry] >= 221 ether` (true, per the Part 2 prerequisite), decrements it, increments `_balances[Alice]` by `221 ether`.
- **Output:** `bool` (`true`); emits **EIP-20** `Transfer(ClaimRegistry, Alice, 221 ether)`.
- **Imports used:** none — plain inherited `ERC20`, same as every other transfer in this document. **This is not a privileged mint** — `StableCoin.mint`/`burn` (the `onlyVault`-gated functions) are never called anywhere in this entire scenario. `ClaimRegistry` is just spending from a balance it was given in Part 2.

**Phase D result:** Alice's wallet balance increases by 221 `dUSD`. The
claim's on-chain status is `Paid` — terminal, cannot be paid again
(`payoutClaim` would revert on a second call since status is no longer
`Approved`).

---

## Part 2 — How `ClaimRegistry` got 221+ `dUSD` to pay out with

**This happens before Phase A, not during Alice's transaction sequence
at all** — included because the question "how does the user get funds"
can't be answered honestly without it.

1. The insurer deposits collateral: `Vault.sol → depositCollateral(amount)` — `IERC20(collateralToken).safeTransferFrom(insurer, Vault, amount)`, increments `positions[insurer].collateralAmount`.
2. The insurer mints against it: `Vault.sol → mintStableCoin(amount)`. Internally, `Vault` calls `_meetsMinRatio`, which calls **`PriceOracle.sol → getPrice()`** — returning the current `priceScaled` (e.g. `2,000 ether` per unit of collateral) — to compute the position's collateral value in USD and check it against `minCollateralRatioBps`. If healthy, `Vault` calls `StableCoin.sol → mint(insurer, amount)` — the **only** code path in this entire project that actually calls `StableCoin`'s privileged `mint` function, gated by `onlyVault`.
3. The insurer transfers the newly-minted `dUSD` to `ClaimRegistry`'s contract address — a plain `StableCoin.transfer` call, funding the contract that will later pay Alice.

This is the only point in the whole scenario where `Vault.sol` and
`PriceOracle.sol` are touched at all.

## Part 3 — How Alice got her 33 `dUSD`

Structurally identical to Part 2, steps 1–2, except Alice keeps the
minted `dUSD` for herself instead of transferring it onward — she'd
deposit her own collateral, mint against it, and now hold spendable
`dUSD`. (Or, equally validly, someone could simply send her `dUSD`
directly — the token doesn't care how a holder acquired it.) Not built
as a guided "get dUSD" flow anywhere in the frontend — a real gap, not
glossed over here.

---

## Part 4 — What's happening underneath *every single call above* (EIP-1967 and EIP-1822)

None of the contracts named above (`InsurancePolicy`, `ClaimRegistry`,
`OracleAdapter`, `Vault`, `PriceOracle`) are called directly at their
"logic" address. Every external call in Parts 1–3 actually targets an
`ERC1967Proxy` address, which then `delegatecall`s into whichever
implementation contract is currently active.

- **EIP-1967** standardizes *where*, in storage, a proxy keeps track of
  its implementation address — at the fixed slot
  `bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)`,
  deliberately an unlikely-to-collide slot rather than slot `0`. This is
  what lets a block explorer or `forge`/`ethers` reliably answer "what
  implementation does this proxy currently point to" without needing
  to know anything contract-specific.
- **EIP-1822 (UUPS)** is *where the upgrade logic lives*: instead of a
  separate, permanent `ProxyAdmin` contract holding upgrade authority
  (the older "Transparent Proxy" pattern), the `upgradeToAndCall`
  function lives on the **implementation** itself, inherited via
  `UUPSUpgradeable`, and gated in every contract in this project by
  `_authorizeUpgrade`'s `onlyRole(UPGRADER_ROLE)` check.

Concretely, for a call like Phase A2's `subscribeToPolicy`:

```
Alice's wallet
   → InsurancePolicy PROXY address (ERC1967Proxy.fallback())
      → delegatecall into the current Implementation contract's code
         → that code executes subscribeToPolicy's logic,
           reading/writing the PROXY's storage (not the
           implementation's own — the implementation has no
           meaningful storage of its own at all)
      ← return data flows back through the proxy
   ← Alice's wallet receives the result
```

This is also *why* every upgradeable contract in this project reserves
`__gap` storage slots — an upgrade only swaps which code runs; the
proxy's storage layout must stay byte-for-byte compatible across that
swap, or the new implementation's code would misinterpret old data sitting
in slots it now assumes mean something else.

---

## Part 5 — What's genuinely NOT part of this scenario

Named explicitly so nothing here is implied by omission:

| Contract / EIP | Role in this scenario |
|---|---|
| `DICSGovernanceToken.sol` | **Not touched.** Governs only CDP risk parameters (Part 2's `minCollateralRatioBps`, etc.), via proposals voted on separately from any individual user's deposit/mint/claim action. |
| `DICSGovernor.sol` | **Not touched**, same reason. |
| `EIP-2612` | Used by `DICSGovernanceToken` for gasless delegation (a governance-token holder can delegate voting power via signature instead of a transaction) — entirely within the governance domain, unrelated to Alice's insurance actions. |
| `ClaimGasPaymaster.sol` | **Not touched** in this trace — Alice paid her own gas as a plain EOA. See the variant below for when this *would* apply. |
| `EIP-4337` | Same — only relevant if Alice's wallet were a smart-contract account submitting via `UserOperation`s rather than an EOA sending ordinary transactions. |

### Variant: if Alice's claim submission were gas-sponsored

Had Alice used a smart-account wallet and the app chosen to sponsor her
gas, Phase B2 would instead be wrapped as follows, **before** `submitClaim`
executes:

1. Alice's smart account packages the intended `submitClaim` call into a
   `PackedUserOperation` and sends it to a bundler, not directly to the
   chain.
2. The bundler calls `EntryPoint`, which calls
   **`ClaimGasPaymaster.sol → _validatePaymasterUserOp(userOp, userOpHash, maxCost)`**
   — checks Alice's rolling daily gas-sponsorship total
   (`sponsoredToday[Alice][dayBucket]`) against `dailySponsorshipCapWei`,
   reverting if it would be exceeded.
3. `EntryPoint` executes the `UserOperation`, which is what actually
   triggers `ClaimRegistry.submitClaim` (Phase B2, unchanged from above).
4. `EntryPoint` calls **`ClaimGasPaymaster.sol → _postOp(mode, context, actualGasCost, actualUserOpFeePerGas)`**
   — records the real gas cost against Alice's daily total.

Everything from Phase B2 onward is **identical** either way — the
paymaster only changes *who pays for the transaction's gas*, never what
the transaction does. Flagged again here as in prior documentation: this
paymaster doesn't verify the sponsored call is actually `submitClaim`
specifically — it would sponsor any operation from Alice up to her cap.

---

## Summary: every named item, in one line each

| Item | Where it actually appears in this scenario |
|---|---|
| **EIP-20** | Every `dUSD` transfer: A1 (approve), A4 (transferFrom), D2 (transfer), plus Part 2/3's minting flow |
| **EIP-1967** | The storage-slot standard underlying every proxy call to every upgradeable contract used (Part 4) |
| **EIP-1822** | The UUPS upgrade-authorization pattern each of those same contracts implements (Part 4) |
| **EIP-712** | C3 (off-chain signing) and C4 (on-chain verification) of the oracle's attestation |
| **EIP-191** | B1 — Alice's off-chain wallet login only; not used on-chain anywhere in this trace |
| **EIP-2612** | Not used in this scenario at all — governance-domain only |
| **EIP-4337** | Not used in the base trace — only in the gas-sponsorship variant |
| `ClaimRegistry.sol` | B2, C5, D1 — claim lifecycle and payout |
| `InsurancePolicy.sol` | A2, A3, B3, B4 — subscription, premium, policy/premium checks |
| `OracleAdapter.sol` | C4 — signature verification and forwarding |
| `StableCoin.sol` | A1, A4, D2 (transfers); Part 2 step 2 (the only `mint` call in the whole scenario) |
| `Vault.sol` | Part 2 step 1–2, Part 3 — funding, not the live claim flow |
| `PriceOracle.sol` | Part 2 step 2 only — read once, by `Vault`, during the insurer's funding step |
| `DICSGovernanceToken.sol` | Not used |
| `DICSGovernor.sol` | Not used |
| `ClaimGasPaymaster.sol` | Not used in the base trace — gas-sponsorship variant only |

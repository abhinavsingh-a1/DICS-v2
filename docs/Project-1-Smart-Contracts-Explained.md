# Project 1 — Smart Contracts & Local Chain: Explanatory Document

**Directory bundle:** `smart-contracts/` + `besu-network/`
**Language/tooling:** Solidity ^0.8.24, Foundry, OpenZeppelin Contracts v5.7.x (Upgradeable), Hyperledger Besu (local network)

---

## 0. Version migration note (v4.9.x → v5.7.x)

This project was originally built and compiler-verified against
OpenZeppelin v4.9.x. It has since been migrated to **v5.7.0** (the
current latest release as of this writing) — done now specifically
because the project has never been deployed anywhere persistent, which
is the only genuinely safe time to make this kind of change (v5 altered
how OpenZeppelin's own base contracts manage storage internally).

**Confidence is not uniform across this migration** — stated plainly
rather than implied:

| Change | Confidence |
|---|---|
| `security/` → `utils/` import paths for `PausableUpgradeable` (`ClaimRegistry`, `InsurancePolicy`, `OracleAdapter`, `Vault`) | High — well-documented, stable v5 fact |
| `ReentrancyGuardUpgradeable` → plain `ReentrancyGuard` from the non-upgradeable package (`ClaimRegistry`, `InsurancePolicy`, `Vault`) | **Confirmed against a real `forge build` failure and OpenZeppelin's own v5 release notes** — not a folder rename at all. OpenZeppelin reclassified `ReentrancyGuard` as "stateless" in v5 and stopped shipping an Upgradeable variant entirely; the plain version is used directly, with no `__ReentrancyGuard_init()` call, because its default-zero storage slot behaves correctly with the guard logic without any explicit initialization — which is exactly why a separate Upgradeable variant became unnecessary. My first attempt at this migration wrongly assumed it was the same simple path change as `Pausable` — it wasn't, and the real error is what caught it. |
| `__UUPSUpgradeable_init()` removed from every `initialize()`; `__AccessControl_init()` and `__Pausable_init()` **restored** after being wrongly removed | **This entry itself is a correction.** An earlier pass removed all three calls, treating a forum post's claim ("empty in v5.0.1") as equivalent to "removed" for all three — but only `__UUPSUpgradeable_init()` ever had direct compiler proof behind its removal (a real "Undeclared identifier" error). A real runtime failure — `AccessControlUnauthorizedAccount` inside `InsurancePolicy.t.sol`'s `setUp()`, `DEFAULT_ADMIN_ROLE` never actually taking effect on `timelock` — traced back to this: OpenZeppelin's actual current source (`AccessControlUpgradeable.sol` on GitHub) shows `__AccessControl_init()` still exists as a real function. Restored it and `__Pausable_init()` (same weaker-evidence category) across all five contracts; `__UUPSUpgradeable_init()` stays removed, since that one still has a real compiler error behind it, not an inference from a forum post. `OracleAdapter.sol`'s `__EIP712_init("DICS-OracleAdapter", "1")` was never touched either way — it sets real domain-separator state. |
| `PriceOracle`, `StableCoin` — no changes needed | High — don't use the affected paths |
| `DICSGovernanceToken.sol` — `_update` replacing `_afterTokenTransfer`/`_mint`/`_burn`, `nonces` override reintroduced | Moderate — matches documented v5 behavior, not independently compiled |
| `DICSGovernor.sol` — `_execute` → `_executeOperations` + new `_queueOperations` | **Now verified against OpenZeppelin's own changelog and source code**, not guessed. v5 refactored Governor's queuing logic into its core module, splitting the old `_execute` into `_queueOperations` (new, returns the queued operation's ETA) and `_executeOperations` (the direct replacement, same shape as old `_execute`). |
| `DICSGovernor.sol` — override targets for `votingDelay`/`votingPeriod`/`quorum`/`supportsInterface`, plus new `proposalNeedsQueuing` | **Third real build round.** The override target for these functions genuinely flipped between build attempts (round 2 needed `IGovernor`; round 3's actual error demanded `Governor` for the same three functions) — and round 3's error output shows `Governor` itself newly inheriting `Nonces` directly, which round 2's output didn't show. That's evidence the installed OpenZeppelin commit shifted between attempts, not that either fix was wrong when applied. `proposalNeedsQueuing` is a function this file didn't have at all before round 3 — confirmed required by a distinct "Derived contract must override" error, not inferred. **Practical consequence: pin the exact commit hash, not just the `v5.7.0` tag, once this build is green — floating within a tag is what most plausibly produced this flip-flop.** |
| `DICSGovernanceToken.sol` — `nonces` override target | **Third real build round.** Neither `ERC20Permit` nor `ERC20Votes` implements `nonces` itself — both merely inherit it from `Nonces`. The correct second name is `Nonces` directly, not `ERC20Votes` — confirmed by the exact error pairing ("Invalid contract specified: ERC20Votes" / "needs to specify overridden contract Nonces"). |
| `Governance.t.sol` — `TIMELOCK_ADMIN_ROLE` → `DEFAULT_ADMIN_ROLE` | **Verified against OpenZeppelin PR #3799 and the v5.0.0-rc.0 release notes.** `TimelockController` no longer has a bespoke `TIMELOCK_ADMIN_ROLE` at all — v5 unified it onto the standard `AccessControl` `DEFAULT_ADMIN_ROLE`, specifically to make it easier to add new roles without custom migrations. The constructor's shape is unchanged (`minDelay, proposers, executors, admin`) — only the role constant used to renounce that admin access after setup needed updating. `PROPOSER_ROLE`/`CANCELLER_ROLE`/`EXECUTOR_ROLE` are untouched by this change. |
| `ClaimGasPaymaster.sol` | Unchanged risk profile — depends on `@account-abstraction/contracts` compatibility, a separate axis from this OZ migration entirely |

Every other section of this document below still describes the contracts'
*behavior* accurately — the migration only touched import paths and a
handful of override declarations, not business logic.

---

## 1. What this project is for

This is the on-chain layer of DICS v2. It defines and tests three
upgradeable smart contracts that together implement an insurance claim
settlement lifecycle — register a policy, submit a claim against it,
have an off-chain oracle attest whether the claim is valid, have an
authorized underwriter approve/reject it, and pay out an ERC-20 token if
approved — plus the local Ethereum-compatible network (`besu-network/`)
these contracts are deployed to and tested against.

The three contracts are deliberately separated by responsibility:

- **`InsurancePolicy.sol`** — the source of truth for what a policy
  covers and whether it's currently active.
- **`ClaimRegistry.sol`** — the source of truth for claims, their
  lifecycle state, and payouts; it calls into `InsurancePolicy` to
  validate a claim rather than duplicating policy logic.
- **`OracleAdapter.sol`** — the trust boundary between an off-chain
  oracle service and `ClaimRegistry`; verifies a cryptographic signature
  before ever calling into `ClaimRegistry` on the oracle's behalf.

All three follow the same architectural pattern: **UUPS upgradeable**,
**role-gated via `AccessControl`**, **pausable as an emergency brake**,
with privileged roles (`ADMIN_ROLE`, `UPGRADER_ROLE`) intended to be held
by a `TimelockController`, not a person's wallet directly.

---

## 2. EIPs used, and why

| EIP | Where | Why |
|---|---|---|
| **EIP-20** | `IERC20`/`SafeERC20` in `ClaimRegistry.sol`; `TestPayoutToken.sol` | The payout mechanism — claims are paid in an ERC-20 token, not native ETH, so the payout logic is a token transfer. |
| **EIP-1967** | `ERC1967Proxy` (used in every deploy script) | Standard storage-slot layout for proxy contracts, so the proxy's own storage (implementation address, admin) never collides with the logic contract's storage variables. This is *why* the `__gap` reserved-slot pattern in each contract matters — it protects against a different, contract-level collision, complementary to what EIP-1967 protects at the proxy level. |
| **EIP-1822 (UUPS)** | `UUPSUpgradeable` in all three contracts | The upgrade logic lives in the *implementation* contract itself (via `_authorizeUpgrade`), rather than in a separate, permanently-deployed ProxyAdmin contract (the alternative "Transparent Proxy" pattern). Chosen for lower proxy-call gas overhead and because upgrade authorization is naturally expressed as just another role-gated function. |
| **EIP-712** | `EIP712Upgradeable`, `OracleAdapter.sol` | Structured, typed data signing for oracle attestations — the signed payload has named, typed fields (`claimId`, `requestId`, `approved`, `timestamp`) rather than an opaque string, and the signature is bound to this specific contract + chain via the domain separator, so a signature can't be replayed against a different deployment. |

**EIP-191** (personal message signing) is used elsewhere in the overall
DICS v2 system (wallet login in the backend, described in Project 2's
document) but not inside this project's contracts themselves.

---

## 3. `smart-contracts/contracts/ClaimRegistry.sol`

### Purpose
The core claim lifecycle contract: submit → verify/approve/reject → pay
out. Holds all claim state and enforces every invariant (no double
payout, no unauthorized status change, no exceeding coverage, rate
limits on total payout volume).

### Imports, explained

| Import | Used for |
|---|---|
| `Initializable` | Provides the `initializer` modifier and `_disableInitializers()`, which replace a constructor for upgradeable contracts — a proxy's storage is separate from the implementation's, so a real constructor (which runs at *implementation* deploy time) can't set proxy state; `initialize()` runs once, at proxy deploy time, instead. |
| `UUPSUpgradeable` | Supplies `upgradeToAndCall` and the `_authorizeUpgrade` hook this contract overrides to gate upgrades behind `UPGRADER_ROLE`. |
| `AccessControlUpgradeable` | Role-based permissions — `onlyRole(...)`, `_grantRole`, `hasRole`. Every privileged function in this contract uses this. |
| `PausableUpgradeable` | The `whenNotPaused` modifier and `_pause()`/`_unpause()` internals backing the emergency-brake functions. |
| `ReentrancyGuardUpgradeable` | The `nonReentrant` modifier, applied to `payoutClaim` and `releaseStuckPayout` — both functions call `safeTransfer`, an external call, so both need reentrancy protection. |
| `IERC20` / `SafeERC20` | The payout token's interface and the "safe" transfer wrapper that reverts on a token that returns `false` instead of reverting on failure (some non-compliant ERC-20s do this) — using `safeTransfer` instead of raw `.transfer()` avoids silently treating a failed transfer as successful. |

### The `IInsurancePolicyRegistry` interface (top of file)
Not a real import — a locally-declared interface whose `Policy` struct
**duplicates** `InsurancePolicy.sol`'s actual struct field-for-field.
This exists so `ClaimRegistry` can call `InsurancePolicy.getPolicy()`
without importing the entire `InsurancePolicy.sol` file (which would
create a much heavier compilation dependency). Solidity resolves this
call by ABI encoding, not by type identity — as long as the field
order and types match the real contract's struct, the call decodes
correctly. The comment directly above it exists specifically to warn a
future editor: if `InsurancePolicy.sol`'s `Policy` struct ever changes,
this copy must change too, or decoding will silently misinterpret data.

### Roles (lines ~54–73)
Five `bytes32` constants, each `keccak256` of a role name string —
the standard OpenZeppelin `AccessControl` pattern (a role is just a
32-byte identifier, and `AccessControl` tracks which addresses hold
which role). `ADMIN_ROLE`/`UPGRADER_ROLE` are meant to be held by a
`TimelockController`; `PAUSER_ROLE` deliberately has a lighter bar
(can be an individual signer) because pausing needs to be fast;
`UNDERWRITER_ROLE` is meant to be a Safe multisig; `ORACLE_ROLE` is
meant to be the `OracleAdapter` contract's own address, not a person.

### `ClaimStatus` enum and `Claim` struct
`ClaimStatus` has five states in this exact order — **the order is load-
bearing**: the indexer (Project 2) decodes this enum purely by its
integer position, so reordering these values without updating the
indexer's `CLAIM_STATUS_NAMES` array would silently produce wrong status
names off-chain. `Claim` packs several fields into narrower types
(`uint128`, `uint96`, `uint40`) specifically so multiple fields fit into
fewer 256-bit storage slots — cheaper to read/write. The code comment on
`amount: uint96` exists because narrowing an amount field is exactly the
kind of "gas optimization" that could silently truncate real value if
done carelessly; it's flagged so nobody removes the comment and the
reasoning behind the width choice without re-checking it.

### Storage section
`nextClaimId` (auto-incrementing ID), `claims` (the actual claim
records, keyed by ID), `policyClaims` (an index: policy ID → list of
claim IDs on that policy, used by `_consumedCoverage`), and
`usedOracleRequestIds` (a set — mapping to `bool` — enforcing that an
oracle's `requestId` can never be consumed twice; this is the on-chain
half of oracle replay protection, complementing the off-chain half in
`OracleAdapter.sol`). `payoutToken` and `policyRegistry` hold the two
other contracts this one depends on. The rate-limiting variables
(`maxPayoutPerClaim`, `maxPayoutPerWindow`, `rateLimitWindowSeconds`,
`_windowStart`, `_windowTotalPaid`) back a rolling-window cap on total
payout volume. `__gap` is 42 unused storage slots reserved so a future
upgraded version can add new state variables without shifting the
storage position of anything declared above it — critical for UUPS
upgrade safety.

### Events and Errors
Events mirror every state-changing action (`ClaimSubmitted`,
`ClaimStatusChanged`, `ClaimPayout`, etc.) — these are what the indexer
(Project 2) actually listens for; nothing in the off-chain system reads
contract storage directly, everything is event-driven. Custom errors
(`error ClaimNotFound();` etc., used with `revert ClaimNotFound();`)
are used instead of `require(condition, "string")` because custom errors
are cheaper (no string stored in the bytecode/emitted in the revert
data) and give tests a precise, matchable identifier to assert against.

### `constructor()` (line 165)
```solidity
constructor() {
    _disableInitializers();
}
```
This constructor runs exactly once — at the *implementation* contract's
deployment, never at the proxy's. It calls `_disableInitializers()`,
which permanently marks the implementation contract itself as
initialized, so nobody can call `initialize()` directly on the
implementation address (bypassing the proxy) and hijack it. This is a
standard, required safety pattern for every UUPS contract.

### `initialize(...)` (line 173)
The real "constructor," called once by the deploying script immediately
after the proxy is created. Line by line: it calls each parent
contract's own `__X_init()` function (required — without this,
`AccessControl`'s/`Pausable`'s/`ReentrancyGuard`'s/`UUPSUpgradeable`'s
internal state would never be set up). Then it grants `DEFAULT_ADMIN_ROLE`
(OpenZeppelin's built-in "root" role, which can grant/revoke any other
role), `ADMIN_ROLE`, and `UPGRADER_ROLE` all to the same `timelockAdmin`
address — this is the single most security-critical line in the whole
project: whoever holds `timelockAdmin` effectively controls the contract,
which is exactly why every other document in this project insists this
must be a `TimelockController` address, never a raw wallet. It then
stores the payout token address, the policy registry address, sets
`nextClaimId` to 1 (not 0 — so claim ID 0 can be safely treated as "no
claim," matching the `c.claimant == address(0)` checks used throughout
as an "existence" check), and initializes the rate-limit window.

### `submitClaim(policyId, merkleRoot, amount)` (line 224)
The main entry point for a policyholder. Walking through it:
1. `if (amount > maxPayoutPerClaim) revert ClaimAmountExceedsCap();` —
   rejects a claim larger than the configured per-claim cap immediately,
   before doing any more expensive work.
2. `if (policyRegistry == address(0)) revert PolicyRegistryNotSet();` —
   guards against calling into an unconfigured dependency.
3. `IInsurancePolicyRegistry(policyRegistry).getPolicy(policyId)` — an
   external call to `InsurancePolicy`. The code comment explains this
   compiles to a `STATICCALL` because the interface declares the function
   `view` — a `STATICCALL` cannot modify any contract's state, so this
   call introduces zero reentrancy risk, unlike a normal external call.
4. Three checks against the returned `Policy` struct: not revoked, within
   its valid date range, and `msg.sender` is actually the policy's
   registered holder (not just anyone claiming to be).
5. `_consumedCoverage(policyId)` (see below) computes how much of this
   policy's coverage is already tied up in other non-rejected claims, and
   the claim is rejected if adding this one would exceed total coverage.
6. Only after all five checks pass does it actually create the `Claim`
   record, push the new claim ID into `policyClaims[policyId]` (so future
   calls to `_consumedCoverage` and `getClaimsForPolicy` can find it), and
   emit `ClaimSubmitted`.

### `_consumedCoverage(policyId)` (line 268)
A private helper: loops over every claim ID ever submitted against this
policy, and sums the `amount` of every one that is *not* `Rejected`
(i.e., Submitted, UnderReview, Approved, and Paid all still count against
coverage). The doc-comment directly above explains the deliberate design
choice this represents — and its cost (gas grows linearly with the
number of prior claims on one policy) — and why that trade-off was
accepted rather than building a more complex cross-contract "remaining
coverage" tracker in `InsurancePolicy`.

### `setClaimStatus(claimId, status)` (line 282)
The underwriter-driven path for approving/rejecting a claim: checks the
claim exists (`c.claimant == address(0)` is the "doesn't exist" check,
since a real claim always has a non-zero claimant), sets the new status,
records `processedAt` if the new status is a terminal one, and emits the
event.

### `recordOracleVerification(claimId, requestId, approved)` (line 299)
The oracle-driven equivalent of the function above, restricted to
`ORACLE_ROLE` (intended to be `OracleAdapter`'s address). The key extra
step versus `setClaimStatus`: `usedOracleRequestIds[requestId]` is
checked and then immediately set to `true` — this is the on-chain half
of the two-layer replay protection (the other half is inside
`OracleAdapter.sol` itself, checked *before* this function is ever
called) — belt-and-suspenders, since two independent checks catching the
same class of bug is safer than relying on either alone.

### `payoutClaim(claimId)` (line 315)
The actual fund-transfer function, gated by `whenNotPaused`,
`nonReentrant`, and `onlyRole(UNDERWRITER_ROLE)` together. Checks the
claim exists and is `Approved` (not `Paid` already — this is what
prevents double payout), calls `_enforceRateLimit`, flips status to
`Paid` **before** calling `safeTransfer` (this ordering — update state,
then make the external call — is the standard checks-effects-
interactions pattern that prevents reentrancy even without the
`nonReentrant` guard; here it's belt-and-suspenders alongside the guard),
transfers the token, and emits `ClaimPayout`.

### `_enforceRateLimit(amount)` (line 335)
Implements a simple rolling window: if the current time is past the
window's end, reset the window (new start time, zero accumulated total);
otherwise, check whether adding this payout would exceed the window's
cap, and if not, add it to the running total. This bounds the maximum
damage a compromised-but-"approved" payout could do even if every other
check somehow passed incorrectly.

### `pause()` / `unpause()` (lines 350, 357)
`pause()` requires only `PAUSER_ROLE` — deliberately a fast, low-
friction path. `unpause()` requires `ADMIN_ROLE` — deliberately the slow,
Timelock-gated path. This asymmetry (easy to stop, hard to resume) is
intentional: read the doc-comments directly above each function for the
reasoning.

### `updateRateLimits(...)` / `setPolicyRegistry(...)` (lines 361, 378)
Admin-only parameter updates, each emitting an event so any change is
visible off-chain.

### `rescueForeignToken(token, to, amount)` (line 392)
Recovers an ERC-20 token that isn't the payout token, sent to this
contract by mistake. The one-line guard `if (token == address(payoutToken))
revert CannotRescuePayoutToken();` is the entire point of this function's
existence as a *separate* function from `releaseStuckPayout` below —
see the design-notes comment above the "Stuck-fund recovery" section for
why this split matters.

### `releaseStuckPayout(claimId)` (line 406)
Recovers a specific claim's payout if a previous `payoutClaim` attempt
somehow left it `Approved` but not actually transferred (e.g., the
claimant address can't receive tokens). Critically, this function takes
only a `claimId`, **not** a recipient address — the money always goes to
`c.claimant`, the address already recorded on that specific claim. This
is what prevents this "recovery" path from being a backdoor to redirect
funds anywhere else.

### `getClaimsForPolicy` / `currentWindowUsage` (lines 423, 427)
Plain read-only views for off-chain code (the indexer, the frontend) to
query state without needing to decode raw storage slots.

### `_authorizeUpgrade(address newImplementation)` (line 439)
The UUPS hook: this function's body is empty (`{}`) — all the actual
work is the `onlyRole(UPGRADER_ROLE)` modifier. If the caller doesn't
hold `UPGRADER_ROLE`, this reverts and the upgrade never happens. Because
`UPGRADER_ROLE` is meant to be a `TimelockController`, every real upgrade
is queued and publicly visible for a delay before it can execute.

---

## 4. `smart-contracts/contracts/InsurancePolicy.sol`

### Purpose
The registry of insurance policies — who holds a policy, what it covers,
and whether it's currently valid. `ClaimRegistry` calls into this
contract; this contract has no dependency in the other direction.

### Imports
Same four upgradeable base contracts as `ClaimRegistry` minus
`ReentrancyGuardUpgradeable` (this contract never makes an external call
that transfers funds, so reentrancy isn't a relevant risk here) and minus
the ERC-20 imports (this contract never touches a token).

### Roles
`ADMIN_ROLE`/`UPGRADER_ROLE` (Timelock, same pattern as `ClaimRegistry`),
`PAUSER_ROLE`, and `POLICY_MANAGER_ROLE` — deliberately a **different**
role from `ClaimRegistry`'s `UNDERWRITER_ROLE`, even though both might
conceptually be "the insurer." The doc-comment on this role explains why:
registering a policy and approving a claim against it should never
require the same signer set, so a single compromised role can't do both.

### `Policy` struct
The real definition that `ClaimRegistry`'s `IInsurancePolicyRegistry`
interface duplicates. Field order matters — see Section 3's note on that
duplication.

### `initialize(timelockAdmin)`
Simpler than `ClaimRegistry`'s — no token, no policy registry dependency,
just the three role grants to `timelockAdmin`.

### `registerPolicy(...)` / `revokePolicy(...)` / `updateCoverage(...)`
All three are `POLICY_MANAGER_ROLE`-gated, `whenNotPaused`. `registerPolicy`
checks the policy ID isn't already used, the holder address isn't zero,
and the date range is sane (`validUntil > validFrom`) before writing the
record and emitting `PolicyRegistered`.

### `pause()` / `unpause()`
Same asymmetric pattern as `ClaimRegistry`.

### `getPolicy(policyId)`
The function `ClaimRegistry.submitClaim` actually calls. Reverts with
`PolicyNotFound` if the ID was never registered.

### `isPolicyActive(policyId, atTime)`
A convenience view — active means not revoked and within the date range.
Currently not called by `ClaimRegistry` (which does its own equivalent
check inline using the full `Policy` struct it already fetched) but kept
as a useful standalone query for other callers (e.g. the frontend could
call this directly to grey out an expired policy in the UI).

### `isClaimEligible(policyId, claimant, claimAmount, atTime)`
A single-call convenience combining active-check + holder-check +
coverage-check. **Not currently called by `ClaimRegistry`** — the doc-
comment directly on this function explains why: it doesn't account for
*other* claims already consuming coverage, which is exactly the
cumulative-consumption logic `ClaimRegistry._consumedCoverage` handles on
the other contract. This function is left in place as a simpler, single-
claim eligibility check useful for other callers, with the limitation
stated explicitly rather than silently.

### `_authorizeUpgrade`
Identical pattern to `ClaimRegistry`.

---

## 5. `smart-contracts/contracts/OracleAdapter.sol`

### Purpose
The security boundary between an off-chain oracle service and
`ClaimRegistry`. Nothing about "was this claim actually verified
correctly" is trusted by `ClaimRegistry` itself — `ClaimRegistry` only
trusts whatever address holds `ORACLE_ROLE`, and this contract is
designed to be the *only* thing that should ever hold that role, because
it enforces the actual cryptographic checks before forwarding anything.

### Imports
Adds `EIP712Upgradeable` (structured signature verification) and
`ECDSA` (the actual signature-recovery math) on top of the same base set
used by the other two contracts (minus `ReentrancyGuardUpgradeable` —
this contract also never transfers funds).

### `IClaimRegistryOracleSink` interface
Analogous to `ClaimRegistry`'s duplicated `Policy` struct interface —
this is the minimal shape this contract needs to call into
`ClaimRegistry`, without importing all of `ClaimRegistry.sol`.

### Roles
`ADMIN_ROLE`/`UPGRADER_ROLE` (Timelock), `PAUSER_ROLE`, and
`ORACLE_SIGNER_ROLE` — the role granted to the actual off-chain signing
key(s). The doc-comment explains the asymmetry: revoking a suspected-
compromised signer is immediate (no Timelock delay — you want to cut off
a bad key *now*), while granting a *new* signer still goes through the
normal Timelock-gated `ADMIN_ROLE` path.

### `ORACLE_RESPONSE_TYPEHASH`
```solidity
bytes32 private constant ORACLE_RESPONSE_TYPEHASH =
    keccak256("OracleResponse(uint256 claimId,bytes32 requestId,bool approved,uint256 timestamp)");
```
This is evaluated **at compile time** by the Solidity compiler because
the argument is a literal string constant — it costs zero gas at
runtime. This is the EIP-712 "typehash" — a fixed identifier for the
exact shape of the struct being signed. The comment directly above
warns against ever hand-computing and hardcoding this value as a raw hex
literal instead — an early draft of this exact file did that with a
placeholder value, which would have silently broken every signature
verification with no clear error pointing at the cause.

### `OracleResponse` struct
The typed payload being signed: which claim, a unique request ID (for
replay protection), the approve/reject decision, and a timestamp (for
expiry checking).

### Storage
`claimRegistry` (the contract this adapter forwards verified results
to), `responseValidityWindow` (how many seconds after signing a response
remains acceptable), and `usedRequestIds` — this contract's *own* replay
protection, independent of (and redundant with, deliberately) the
`usedOracleRequestIds` mapping inside `ClaimRegistry` itself.

### `initialize(timelockAdmin, claimRegistryAddress, responseValidityWindowSeconds)`
Same pattern as the other two contracts, plus
`__EIP712_init("DICS-OracleAdapter", "1")` — this sets the domain name
and version that become part of every signature's binding (see Section 6
of Project 2's document, where the off-chain signer has to match these
exact values).

### `submitVerification(response, signature)` — the core function
Walking through it in order:
1. `if (usedRequestIds[response.requestId]) revert RequestAlreadyUsed();`
   — this contract's own replay check, first.
2. Two timestamp checks: the response can't claim to be from the future
   (`response.timestamp > block.timestamp`), and it can't be older than
   `responseValidityWindow` seconds.
3. Reconstructs the exact same struct hash and EIP-712 digest the
   off-chain signer computed (`_hashTypedDataV4` — inherited from
   `EIP712Upgradeable`, folds in this contract's domain separator).
4. `ECDSA.recover(digest, signature)` — recovers the address that
   actually produced this signature. This is the entire security
   guarantee: nobody can forge a signature for a different key.
5. `if (!hasRole(ORACLE_SIGNER_ROLE, signer)) revert UnauthorizedSigner();`
   — the recovered address must hold the signer role.
6. Only after all of the above passes: mark the request ID used, call
   `claimRegistry.recordOracleVerification(...)`, and emit
   `VerificationSubmitted`.

The doc-comment on this function explains a deliberate design choice:
**anyone can call this function** — there's no `onlyRole` restriction on
the caller. The security comes entirely from the signature, not from who
submitted the transaction. This is the standard "signed message,
permissionless relay" pattern — an oracle service can sign off-chain and
let any relayer (itself, a keeper service, anyone) submit the transaction
on-chain, without that relayer needing any privileged role.

### `setClaimRegistry` / `setResponseValidityWindow` / `pause` / `unpause`
Standard admin-gated setters and the same pause asymmetry as elsewhere.

### `domainSeparatorV4()`
A public view exposing this contract's own EIP-712 domain separator —
purely so off-chain signing code and tests can pull the *real* value
from the deployed contract and assert their own computed signature
matches it, rather than trusting a copy-pasted domain configuration on
both sides.

### `oracleResponseTypehash()`
Same idea, for the typehash — exists specifically so tests (in this
project, and this contract's own Foundry test) can assert their
locally-computed value matches the contract's, rather than each side
trusting the other silently agrees.

### `_authorizeUpgrade`
Same pattern as the other two contracts.

---

## 6. `smart-contracts/contracts/mocks/`

### `MockClaimRegistrySink.sol`
A trivial stand-in implementing `IClaimRegistryOracleSink` that just
records the last call it received (`lastClaimId`, `lastApproved`,
`callCount`). Used by `OracleAdapter.t.sol` (unit tests) and
`DeployIntegrationFixture.s.sol` (the real-chain integration test) so
neither needs the full `ClaimRegistry` contract deployed just to test
`OracleAdapter`'s own logic in isolation.

### `TestPayoutToken.sol`
A minimal ERC-20 (`import "@openzeppelin/contracts/token/ERC20/ERC20.sol"`)
that mints 10,000,000 tokens to whoever deploys it. Used wherever a test
or fixture needs *some* real ERC-20 to pay out, without depending on a
real production token.

---

## 7. `smart-contracts/script/`

### `DeployIntegrationFixture.s.sol`
A Foundry deployment script (extends `forge-std`'s `Script`) used only
by `oracle-service`'s integration test. Deploys `MockClaimRegistrySink`
and a real `OracleAdapter` (implementation + `ERC1967Proxy`), grants
`ORACLE_SIGNER_ROLE` to a caller-specified address, and writes the
deployed addresses to `integration-fixture.json` via `vm.writeJson` —
this is how a JavaScript test harness (which can't directly read
Solidity return values) learns what got deployed. The doc-comment on the
contract is explicit that `deployer` is used as the admin here **only**
because this is a throwaway test fixture — never a template for a real
deployment, which must use a Timelock instead.

### `DeployIndexerFixture.s.sol`
The equivalent fixture for the indexer's integration test — deploys the
*full* real stack (`TestPayoutToken`, `InsurancePolicy`, `ClaimRegistry`),
registers one active policy, grants the deployer both `POLICY_MANAGER_ROLE`
and `UNDERWRITER_ROLE` (again, only acceptable because this is a
throwaway fixture), funds `ClaimRegistry` with tokens for payouts, and
writes `indexer-fixture.json`. Notably has **no oracle wiring at all** —
the doc-comment explains this is deliberate: this fixture's job is to
exercise the indexer's event decoding, and the underwriter role alone
(already granted to the deployer) is sufficient to drive every status
transition the indexer needs to observe, without needing to duplicate
the oracle-signing flow that's already covered by `oracle-service`'s own
integration test.

---

## 8. `smart-contracts/test/`

### `ClaimRegistryUpgrade.t.sol`
The main Foundry test suite for `ClaimRegistry`. Includes a local
`TestToken` contract (a minimal ERC20, similar to but separate from
`TestPayoutToken.sol` — this predates that shared mock and wasn't
consolidated with it) and a local `MockPolicyRegistry` implementing
`IInsurancePolicyRegistry` with a settable `Policy` per policy ID, giving
each test full control over what "policy state" `ClaimRegistry` sees
without needing a real `InsurancePolicy` deployment. Also includes
`ClaimRegistryV2`, a tiny subclass adding one new field — used by
`test_StateSurvivesUpgrade` to prove that upgrading the implementation
contract doesn't corrupt or lose existing proxy storage. Other tests
cover: unauthorized upgrade attempts revert, pause blocks `submitClaim`,
the rate-limit window is enforced exactly at its boundary, foreign-token
rescue can't touch the payout token, a claimant impersonation attempt is
rejected, a revoked/not-yet-valid policy is rejected, a claim exceeding
coverage (both on its own and cumulatively with a prior pending claim) is
rejected, and a rejected claim correctly frees up coverage for a new
submission.

### `InsurancePolicy.t.sol`
Tests policy registration (success and duplicate-ID rejection),
unauthorized registration attempts, the active/inactive/revoked date-
range logic, `isClaimEligible`'s three failure modes (wrong claimant,
exceeds coverage), and that pausing blocks registration.

### `OracleAdapter.t.sol`
Tests the full signature-verification flow: a validly-signed response
from an authorized signer succeeds and forwards to the sink; an
unauthorized signer's otherwise-valid signature is rejected; a replayed
`requestId` is rejected on the second attempt; an expired response is
rejected; a response timestamped in the future is rejected; pausing
blocks submission; and revoking a signer's role makes their previously-
valid key immediately unable to submit new (unused) responses.

---

## 9. `besu-network/` (the local chain infrastructure)

### `ibftConfigFile.json`
Configuration input for Besu's own `operator generate-blockchain-config`
tool — specifies chain ID 1337, IBFT2.0 consensus with a 2-second block
period, and asks Besu to generate 4 validator node identities. This file
is *input* to a generator, not something written by hand to be a
genesis file itself.

### `generate-network.sh`
A shell script that runs Besu's `operator generate-blockchain-config`
command (via Docker) against `ibftConfigFile.json`, producing
`networkFiles/genesis.json` and one key-pair directory per validator.
Chosen deliberately over hand-writing a genesis file and keys, because
IBFT2.0's genesis `extraData` field must encode the exact validator
addresses correctly — a hand-typo'd version of this is a common, hard-to-
debug source of a network that simply never produces blocks.

### `docker-compose.yml`
Defines four Besu container services (`validator1`–`4`), all sharing the
same generated `genesis.json` but each with its own key directory,
networked together, with `validator1` exposing RPC on the host's
`8545`. Uses a YAML anchor (`x-besu-common`) to avoid repeating the same
command-line flags four times.

### `README.md`
Documents the run order (generate → compose up → verify via a raw
`eth_blockNumber` JSON-RPC call), how to install OpenZeppelin's
upgradeable Foundry dependencies, how to deploy each contract to this
network, and — the most important section — the exact role-wiring
sequence for a real deployment: deploy a Safe, deploy a
`TimelockController` naming that Safe as proposer and a **different**
Safe as canceller, deploy the contracts pointing `initialize()`'s
`timelockAdmin` parameter at the `TimelockController`'s address, then
verify the original deployer key holds none of the privileged roles
afterward.

---

## 10. NEW — the CDP/stablecoin module, governance module, and gas paymaster

These three areas were explicitly designed earlier in this project's
history but deliberately deferred as "a separate, later-phased
initiative." This section documents them now that they've actually been
built. **Governance domain note:** this module's `ADMIN_ROLE`/upgrade
authority is deliberately controlled by its *own* `TimelockController`
(driven by `DICSGovernor`), entirely separate from the Safe +
`TimelockController` that governs `ClaimRegistry`/`InsurancePolicy`/
`OracleAdapter`. "Who can change CDP risk parameters" and "who can
approve insurance claims" are different trust boundaries with no reason
to share one point of control.

### Additional EIPs used, and why

| EIP | Where | Why |
|---|---|---|
| **EIP-2612** | `DICSGovernanceToken.sol`, via `ERC20Permit` | Gasless approval — lets a token holder sign a permit message off-chain rather than sending a separate on-chain `approve` transaction; `ERC20Votes` depends on this for its nonce-tracking machinery. |
| **EIP-4337** | `ClaimGasPaymaster.sol` | Account abstraction — lets a policyholder submit a claim without holding ETH for gas, by having this paymaster contract sponsor the transaction's gas cost through the standard `EntryPoint`/`UserOperation` flow. |

`ERC20Votes` itself isn't a formal EIP (it's an OpenZeppelin convention
commonly used to satisfy the informal "on-chain voting token" pattern
that both Compound's `Comp` token and OpenZeppelin's `Governor` system
popularized) — worth being precise about that distinction rather than
implying it's a numbered standard.

### `smart-contracts/contracts/StableCoin.sol`

**Purpose:** the mintable/burnable ERC-20 `Vault.sol` issues against
locked collateral. Explicitly labeled throughout its own NatSpec as
**not a production stablecoin** — no peg-stability mechanism exists
beyond the overcollateralization and liquidation `Vault.sol` enforces.

**Imports:** just `@openzeppelin/contracts/token/ERC20/ERC20.sol` — this
is a plain ERC-20, not upgradeable (see the `@dev` note in the file
explaining that choice deliberately, as a trust signal distinct from
every other UUPS contract in this project).

**`vault` / `deployer` / `setVault(vault_)`** — resolves a real circular
dependency: `Vault.sol` needs this token's address at its own
`initialize()` call, but this token can't take `Vault`'s address in its
constructor if `Vault` doesn't exist yet. `setVault` is callable exactly
once, only by whichever address deployed this contract — a deployment
bootstrapping step, not an ongoing governance lever.

**`mint(to, amount)` / `burn(from, amount)`** — both gated by the
`onlyVault` modifier (a simple `if (msg.sender != vault) revert
OnlyVault();` check). Both bypass the normal ERC-20 allowance system
entirely — `burn` in particular can remove tokens from any address
without that address's approval, because the authority here comes from
the CDP relationship `Vault.sol` enforces, not from a transfer
permission the token holder granted.

### `smart-contracts/contracts/PriceOracle.sol`

**Purpose:** the (explicitly mock) USD price feed `Vault.sol` reads to
value collateral. The contract's own header is blunt about this being
the single biggest real risk in the whole CDP design — price-oracle
manipulation is the most common real-world attack against systems shaped
like this one, and this contract's only job is to make that risk visible
and contained in one clearly-labeled place, not to solve it.

**Imports:** the same `Initializable`/`UUPSUpgradeable`/
`AccessControlUpgradeable` trio used throughout this project.

**Roles:** `ADMIN_ROLE`/`UPGRADER_ROLE` (the CDP module's dedicated
Timelock) and `PRICE_SETTER_ROLE` — deliberately separate from
`ADMIN_ROLE`, so day-to-day price updates don't need to go through the
full governance/Timelock delay, while changing *who* can set prices
still does.

**`setPrice(newPriceScaled)`** — a single state write plus an event;
`priceScaled` uses 18-decimal fixed-point scaling (e.g. `2_000e18` means
"$2,000 per unit of collateral"), matching the scaling convention used
throughout `Vault.sol`'s own math.

**`getPrice()`** — the read `Vault.sol` actually calls.

### `smart-contracts/contracts/Vault.sol`

**Purpose:** the core CDP contract — lock collateral, mint stablecoin
debt against it, repay, withdraw, and liquidate undercollateralized
positions. The file's header is explicit about two scope
simplifications versus the original design sketch: liquidation logic
(a separate `Liquidator.sol` contract originally) is folded directly
into this contract, and risk parameters (a separate `GovernanceParams`
contract originally) live as plain state variables here instead — both
still governance-gated via `DICSGovernor.sol`, just not factored into
their own contracts, to keep the total piece count manageable.

**Imports:** the same upgradeable base-contract set as `ClaimRegistry.sol`
(`Initializable`, `AccessControlUpgradeable`, `PausableUpgradeable`,
`ReentrancyGuardUpgradeable`, `UUPSUpgradeable`), plus `IERC20`/
`SafeERC20` for the collateral token, and direct imports of `StableCoin.sol`
and `PriceOracle.sol` (unlike `ClaimRegistry`'s duplicated-interface
pattern for `InsurancePolicy` — here a direct import was simpler since
there's no risk of circular contract-to-contract imports between `Vault`
and either of these two).

**`Position` struct** — just `collateralAmount` and `debtAmount` per
user address, held in the `positions` mapping.

**`initialize(...)`** — same pattern as every other contract's
initializer; notably does **not** set `stableCoin` (that's `setStableCoin`,
below) because of the circular-dependency bootstrapping issue described
in `StableCoin.sol`'s own section above.

**`setStableCoin(stableCoinAddress)`** — the other half of that
bootstrapping resolution: `ADMIN_ROLE`-gated, settable exactly once
(`_stableCoinSet` guards against a second call).

**`depositCollateral(amount)`** — `safeTransferFrom`s the collateral
token into the vault, increments the caller's `collateralAmount`. Simple,
but note it's `nonReentrant` — any function moving tokens in this
contract is, as a blanket policy matching `ClaimRegistry.sol`'s own
approach to `payoutClaim`.

**`withdrawCollateral(amount)`** — checks the position holds enough
collateral, then — critically — checks that *removing* this amount
wouldn't drop the position below `minCollateralRatioBps` (skipped
entirely if `debtAmount` is zero, since a debt-free position has no
ratio to violate). Only after that check passes does it actually reduce
`collateralAmount` and transfer the tokens out.

**`mintStableCoin(amount)`** — computes what the position's debt
*would* become (`p.debtAmount + amount`), checks that projected debt
against the *current* collateral via `_meetsMinRatio`, and only mints if
the resulting position would still be healthy. This ordering — check the
post-mint state before minting, not the pre-mint state — is what
actually prevents a user from minting their way into an unhealthy
position.

**`repayDebt(amount)`** — the inverse: reduces `debtAmount`, calls
`stableCoin.burn(msg.sender, amount)` (the privileged, allowance-free
burn described in `StableCoin.sol`'s section above).

**`liquidate(user, debtToCover)`** — the most involved function in this
contract. Walking through it:
1. Checks the target position is actually unhealthy
   (`_meetsMinRatio` returning `true` means it's *not* liquidatable, so
   the function reverts in that case) and that `debtToCover` doesn't
   exceed the position's actual debt.
2. Converts the debt being covered into an equivalent amount of
   collateral tokens at the current oracle price
   (`debtValueInCollateral = (debtToCover * 1e18) / price`), then adds
   the liquidation penalty on top — this bonus is the economic incentive
   that makes liquidation profitable enough for someone to actually do
   it.
3. Caps the seized amount at whatever collateral the position actually
   holds (`if (collateralSeized > p.collateralAmount) { collateralSeized
   = p.collateralAmount; }`) — a defensive clamp preventing an attempt
   to seize more than exists.
4. Reduces the target position's debt and collateral accordingly.
5. **Burns the *liquidator's* dUSD** (`msg.sender`, not `user`) to
   actually extinguish the covered debt — the code comment is explicit
   this is the real economic action making liquidation solvency-
   preserving: bad debt is removed from circulation by dUSD the
   liquidator genuinely gives up, not just bookkeeping.
6. Transfers the seized collateral to the liquidator and emits
   `PositionLiquidated`.

**`_meetsMinRatio(collateralAmount, debtAmount)`** (private) — the
shared health-check math: zero debt is always considered healthy
(nothing to be under-collateralized against); otherwise, computes
collateral value in USD and compares the resulting ratio (in basis
points) against `minCollateralRatioBps`.

**`currentCollateralRatioBps` / `isLiquidatable`** — public read-only
views wrapping the same math for external callers (a frontend, a
liquidation-bot script) to check without needing to reimplement it.

**`updateRiskParams(...)`** — `ADMIN_ROLE`-gated (i.e., the CDP
module's Timelock, driven by `DICSGovernor`). This is the actual
function `DICSGovernor.sol`'s test proposes, votes on, queues, and
executes against — see the Governance section below.

**`pause()` / `unpause()`** — the same asymmetric pattern (fast pause,
Timelock-gated unpause) used throughout this project.

### `smart-contracts/contracts/mocks/TestCollateralToken.sol`

**Purpose:** a trivial mock ERC-20 standing in for a real exogenous
collateral asset (e.g. wrapped ETH) — same pattern as `TestPayoutToken.sol`,
mints a fixed supply to its deployer at construction.

### `smart-contracts/contracts/DICSGovernanceToken.sol`

**Purpose:** the voting-weight token for CDP-module governance.

**Imports:** `ERC20`, `ERC20Permit` (EIP-2612), `ERC20Votes` — all plain
OpenZeppelin extensions, no custom logic. `ERC20Votes` requires
`ERC20Permit` as a dependency because its gasless-delegation feature
(delegating voting power via a signature rather than an on-chain
transaction) reuses the same nonce/signature machinery EIP-2612 provides.

**`constructor(initialSupply)`** — mints the entire initial supply to
the deployer; distributing it to real stakeholders afterward is a
deployment-time, off-chain decision this contract doesn't concern itself
with.

**`_update` / `nonces` overrides** — required by the Solidity compiler
whenever a contract inherits the same function from more than one parent
(here, both `ERC20`/`ERC20Votes` define `_update`, and both
`ERC20Permit`/`ERC20Votes` — via its own `Votes` base — define `nonces`).
Both overrides do nothing except delegate to `super`, resolving the
ambiguity without changing behavior — this exact pattern is what
OpenZeppelin's own Contracts Wizard generates for this combination, not
custom logic invented for this project.

### `smart-contracts/contracts/DICSGovernor.sol`

**Purpose:** the actual on-chain voting contract — propose a change,
gather votes, queue it through a Timelock, execute it.

**Imports:** `Governor` (the abstract base implementing the core
propose/vote lifecycle), and four extensions: `GovernorSettings`
(voting delay/period/threshold as configurable values instead of hard-
coded), `GovernorCountingSimple` (For/Against/Abstain vote counting),
`GovernorVotes` (reads voting power from an `IVotes`-compatible token —
`DICSGovernanceToken`, in this deployment), `GovernorVotesQuorumFraction`
(quorum expressed as a percentage of total token supply), and
`GovernorTimelockControl` (routes execution through a `TimelockController`
rather than executing immediately).

**Constructor** — sets voting delay to 1 block, voting period to
`50_400` blocks (roughly one week at a 12-second block time — a rough
estimate stated as such, worth recalibrating against Besu's actual
2-second block period configured in `besu-network/ibftConfigFile.json`),
proposal threshold to `0` (any token holder may propose), and quorum to
4% of total supply.

**The nine overridden functions** (`votingDelay`, `votingPeriod`, `quorum`,
`state`, `proposalThreshold`, `_execute`, `_cancel`, `_executor`,
`supportsInterface`) — every one exists purely to resolve the same
"inherited from multiple parents" ambiguity described for
`DICSGovernanceToken.sol` above, each simply calling `super`. **Updated
against TWO real `forge build` runs, not one** — the override target
turned out not to be uniform across these functions, which the first fix
attempt got partially wrong by assuming it was. The evidence-based rule
that emerged: `Governor` itself provides no function body at all for
`votingDelay`, `votingPeriod`, or `quorum` — they're purely virtual until
`GovernorSettings`/`GovernorVotesQuorumFraction` implement them — so
`IGovernor` (which declares them) is the correct name there, not
`Governor`. `state` and `proposalThreshold` DO have a body directly in
`Governor`, so `Governor` is correct for those two — confirmed by the
second build run reporting no error on either of them. `_execute`,
`_cancel`, `_executor`, and `supportsInterface` have not triggered any
error across either build and are left as originally written, but see
Section 12's next-actions entry: if any of those four ever do error, the
right response is trusting the compiler's exact wording over pattern-
matching from the functions above, since this diamond has already proven
non-uniform once.
left as originally written.

### `smart-contracts/contracts/ClaimGasPaymaster.sol`

**Purpose:** EIP-4337 gas sponsorship — lets a policyholder submit a
claim without holding any ETH, by having this contract cover the
transaction's gas cost. **Read the extensive header comment in the file
itself before using this contract** — it's flagged as the
highest-uncertainty piece in this entire batch, for two compounding
reasons stated explicitly there: the EIP-4337 `EntryPoint` interface has
moved through several incompatible versions faster than most EVM
standards, and this contract's exact function signatures were not
independently re-verified against live compiler output the way every
other contract in this project's tests were.

**Imports:** `BasePaymaster` and `PackedUserOperation` from
`@account-abstraction/contracts` — eth-infinitism's own reference
implementation, deliberately used instead of hand-rolling the low-level
gas-accounting and struct-packing logic, for the same reason this
project uses OpenZeppelin's audited contracts instead of writing
`AccessControl` from scratch: that low-level packing logic is a
well-documented source of subtle, security-relevant bugs.

**`dailySponsorshipCapWei` / `sponsoredToday`** — the actual sponsorship
policy this contract adds on top of `BasePaymaster`'s boilerplate: a
per-sender, per-day (via `block.timestamp / 1 days` bucketing) spending
cap.

**`_validatePaymasterUserOp(userOp, userOpHash, maxCost)`** — called by
`EntryPoint` during validation, before anything executes. Checks the
sender's already-used-today amount plus this operation's worst-case cost
(`maxCost`) against the daily cap, reverting immediately if it would be
exceeded — validation fails fast, before any execution happens, rather
than sponsoring partially. Packs `(sender, dayBucket)` into `context`,
forwarded to `_postOp` below.

**`_postOp(mode, context, actualGasCost, actualUserOpFeePerGas)`** —
called by `EntryPoint` after execution, with the *actual* gas cost
incurred (almost always less than the worst-case `maxCost` checked
above). Decodes `context`, and this is what actually updates
`sponsoredToday` — meaning the cap tracks real spending, not worst-case
estimates.

**Explicit scope simplification, stated in the file's own header:**
this paymaster does **not** parse `userOp.callData` to verify the
sponsored operation is actually a `ClaimRegistry.submitClaim` call — as
shipped, it sponsors gas for *any* operation from a sender, up to the
daily cap. Restricting it to claim submissions specifically requires
knowing the exact calldata-encoding convention of whatever smart-account
implementation is eventually chosen (none has been selected in this
project yet) — real, necessary work before this could be trusted with a
shared sponsorship budget, not done here.

### `smart-contracts/test/Vault.t.sol`

Covers: depositing and minting within the healthy ratio; minting
rejected when it would breach the minimum ratio; withdrawal rejected
when it would breach the minimum ratio; debt repayment correctly
reducing both the position and the token supply; a full liquidation
scenario (deposit, mint, crash the oracle price, confirm the position
becomes liquidatable, fund a liquidator with real dUSD via a *second*,
separate borrower position rather than a privileged mint — exercising
the realistic path a liquidator would actually take — then liquidate and
confirm the collateral transfer); liquidation correctly rejected against
a healthy position; pausing blocking deposits; and non-admin callers
rejected from updating risk parameters.

### `smart-contracts/test/Governance.t.sol`

Deploys the full governance stack (token, dedicated `TimelockController`,
`DICSGovernor`, `Vault`/`PriceOracle` both pointed at that Timelock as
their `ADMIN_ROLE` holder) and exercises the complete
propose → vote → queue → execute cycle against a real
`Vault.updateRiskParams` call, asserting the parameters actually changed
on-chain afterward. Also tests that execution reverts if attempted before
the Timelock's own minimum delay has elapsed, and that calling
`Vault.updateRiskParams` directly (bypassing governance entirely) is
rejected — confirming the Timelock is genuinely the *only* path to that
function, not merely the intended one.

**Not built in this pass:** a Foundry test for `ClaimGasPaymaster.sol`
against a real deployed `EntryPoint`. This is a distinctly larger
undertaking than the other tests in this project — it requires deploying
(or importing bytecode for) a real `EntryPoint` contract and constructing
valid, correctly-packed `PackedUserOperation` structs, which is exactly
the fast-moving, version-fragile territory the contract's own header
warns about. Flagged as an explicit gap rather than attempted and
possibly wrong.

---

## 10a. NEW — premium payment, and the stablecoin's actual role

Answers a question worth stating plainly: **before this addition, nothing
in the system collected a premium, and the stablecoin had no connection
to insurance at all.** `InsurancePolicy.sol` now has a premium module
closing that gap, and `ClaimRegistry.sol` now enforces it.

**Design decision:** premiums are paid in the CDP module's `dUSD`
(`StableCoin.sol`) — a deliberate, but loose, coupling. `InsurancePolicy`
only ever calls plain `safeTransferFrom` on whatever ERC-20 address
`premiumToken` is configured to; it has no minting privilege and no
relationship to the CDP Timelock. The two governance domains stay exactly
as separate as documented in Section 10 — only the *token* is shared, not
control over either domain. The real cost this creates isn't hidden: a
policyholder needs to already hold `dUSD` before paying a premium, which
today means opening a CDP position first (or receiving `dUSD` from
someone else) — a genuine extra step in the user journey, not solved
here.

**`InsurancePolicy.sol` additions:**
- `PremiumTerms` struct (`amountPerPeriod`, `periodSeconds`) — per-policy
  pricing, set separately from `registerPolicy` itself via
  `setPremiumTerms` (a deliberate choice: changing `registerPolicy`'s own
  signature would have broken every existing test and deploy fixture
  that calls it — adding a new, separate setter avoided that entirely).
- `setPremiumConfig(token, treasury, gracePeriodSeconds)` —
  `ADMIN_ROLE`-gated (the Timelock): which token, where payments go, and
  how much grace a lapsed policy gets.
- `payPremium(policyId)` — the policyholder-facing function. Extends
  `premiumPaidUntil` from whichever is *later*, the current paid-until
  date or now — paying early never wastes remaining coverage, paying
  late never backdates it.
- `isPremiumCurrent(policyId)` — the check `ClaimRegistry` now calls.
  **Deliberate default:** a policy whose premium terms were never set
  (`amountPerPeriod == 0`) is treated as premium-*exempt*, not
  permanently unclaimable — billing is opt-in per policy. This one
  design choice is also why every existing test and deploy fixture in
  this project kept working unchanged: none of them configure premium
  terms, so `isPremiumCurrent` returns `true` for them automatically.

**`ClaimRegistry.sol` change:** the duplicated `IInsurancePolicyRegistry`
interface gained one new function (`isPremiumCurrent`) — not a change to
the existing `Policy` struct, so nothing depending on that struct's shape
needed to change. `submitClaim` now calls it and reverts with
`PremiumNotCurrent` if the policy has lapsed.

**What had to be fixed as a result** (documented honestly rather than
silently patched): `ClaimRegistryUpgrade.t.sol`'s `MockPolicyRegistry`
test double had to gain the same new interface function (Solidity
requires full interface implementation) — given a permissive default
(`true`) plus a setter, so it can also be flipped for the one new
regression test (`test_RevertWhen_PolicyPremiumLapsed`) proving the mock
actually enforces the block correctly. `DeployIndexerFixture.s.sol`
needed **no changes at all** — the premium-exempt-by-default design
choice meant that fixture's unconfigured policy simply stayed exempt.

**`test/Premium.t.sol`** — the real proof, using the actual
`InsurancePolicy` + `ClaimRegistry` pair (not a mock): payment extends
correctly from the later of now/prior-expiry; a second early payment
stacks rather than wasting the remaining period; the grace period boundary
is exact; an unconfigured policy is exempt; a non-holder can't pay someone
else's premium; and — the end-to-end proof — a claim succeeds when premium
is current and reverts with `PremiumNotCurrent` once it's lapsed past
grace.

---

## 10b. NEW — self-service policy catalog, and closing the "born lapsed" gap

This directly answers a real problem surfaced in conversation: with only
`registerPolicy` + optional `setPremiumTerms` existing, a policy could
exist in the system with premium billing configured but **zero premium
ever actually paid** — nothing forced the two to happen together. Worse,
if billing was configured, a brand-new policy started with
`premiumPaidUntil = 0`, meaning it was already "lapsed" before the
policyholder had a chance to pay for the first time.

**The fix is atomicity, not a bugfix to the old flow.** A new self-service
path, `subscribeToPolicy(templateId)`, issues the policy **and** collects
the first payment in one transaction — it either fully succeeds (a
`Policy` record exists and `premiumPaidUntil` is already set one period
into the future) or fully reverts (nothing exists at all). There is no
reachable state in this path where a policy exists unpaid.

**`PolicyTemplate` struct and `policyTemplates` mapping** — the
"catalog": `addPolicyTemplate` (POLICY_MANAGER_ROLE) defines a plan's
coverage amount, price, billing period, and total term — this is
literally the "pick basic/standard/premium" menu from the travel-
insurance story. `setPolicyTemplateActive` discontinues a plan for new
subscribers without touching anyone already on it, the same way a real
insurer retires a product tier.

**`subscribeToPolicy(templateId)`** — the actual "user registers and
pays" function. Walking through it: looks up the template, checks it's
active, computes a fresh `policyId` (with a bounded, documented skip-
forward loop in case an admin-registered ID via the old `registerPolicy`
path happens to collide with the counter), builds the `Policy` record
with `holder = msg.sender` and `validFrom = now`, copies the template's
pricing into `premiumTerms[policyId]`, emits both `PolicyRegistered` (for
consistency with the old path) and a new `PolicySubscribed` event, and
**only then** calls the shared `_collectPremium` — which pulls the first
period's payment via `safeTransferFrom` and sets `premiumPaidUntil`
before the function returns.

**`_collectPremium` extraction** — `payPremium` (renewal) and
`subscribeToPolicy` (first payment) now share one internal
implementation, specifically so the two payment paths can never drift
apart from each other — there's exactly one definition of "what a
premium payment does," not two that happen to currently agree.

**Honest scope boundary, stated plainly**: this fix closes the gap for
the **self-service** path. The original `registerPolicy` (direct admin
issuance) is left unchanged and still allows an admin to create a policy
without premium being paid atomically — a deliberate escape hatch for
cases like a comped policy or migrating an off-chain-billed customer, not
an oversight. If every policy in a given deployment should be forced
through the paid-atomically path, the operational answer is discipline
(only ever use `subscribeToPolicy`), not a code change removing
`registerPolicy` — removing an admin's ability to hand-issue a policy
entirely would be a real product decision, not implied by anything asked
so far.

**`test/PolicyCatalog.t.sol`** — the proof: atomic issue-and-pay
succeeds and both effects are visible; subscribing to an inactive
template reverts; discontinuing a template doesn't touch an already-
issued policy; **a failed payment (revoked token allowance) leaves
provably nothing behind** — `nextPolicyId` doesn't advance and the
policy record doesn't exist, checked directly rather than assumed; a
freshly subscribed policy can be claimed against immediately; a
subscribed policy that's never renewed correctly blocks claims once it
lapses past grace; and policy IDs correctly auto-increment across
multiple independent subscribers.

---

## 11. Execution steps for this project specifically

(See the separate master execution-steps document for the full,
cross-project run order — this section is the subset relevant to just
this project, for reference.)

1. `cd besu-network && ./generate-network.sh && docker compose up -d`
2. `cd smart-contracts && forge install OpenZeppelin/openzeppelin-contracts-upgradeable@v5.7.0 OpenZeppelin/openzeppelin-contracts@v5.7.0` (pin v5.7.x — see Section 0's migration note)
3. `forge install eth-infinitism/account-abstraction` — required only for `ClaimGasPaymaster.sol`; check which tagged version corresponds to the v0.7 `EntryPoint`/`PackedUserOperation` interface at install time, per that contract's own header caveat.
4. Add the `remappings` lines to `foundry.toml` (see `besu-network/README.md`) — add a third mapping for `@account-abstraction/contracts/=lib/account-abstraction/contracts/` alongside the two OpenZeppelin ones.
5. `forge test -vvv` — run the full unit test suite, including `Vault.t.sol`, `Governance.t.sol`, `Premium.t.sol`, and `PolicyCatalog.t.sol`, against Foundry's own local EVM. `DICSGovernor.sol`'s override set has now been fixed against a real reported compile error (see Section 12) — **`ClaimGasPaymaster.sol` has not yet been build-tested and remains the one contract in this batch to watch for similar signature mismatches.**
6. Deploy the CDP module's own governance stack, separately from the claims-system Safe/Timelock from Step 6 of Section 9 above: deploy `DICSGovernanceToken`, deploy a dedicated `TimelockController` for this module, deploy `DICSGovernor` pointing at both, grant `PROPOSER_ROLE`/`CANCELLER_ROLE` on that Timelock to the Governor, then deploy `TestCollateralToken`/`PriceOracle`/`Vault`/`StableCoin` with `Vault`'s `timelockAdmin` parameter set to *this* dedicated Timelock (not the claims-system one).
7. For `ClaimGasPaymaster.sol`: deploy it pointing at whichever real `EntryPoint` address is deployed on your target network (a canonical `EntryPoint` deployment may already exist on public testnets; for a private Besu network, you'd need to deploy your own copy of eth-infinitism's `EntryPoint` contract first) — this step is not automated by any script in this bundle.
8. After deploying `InsurancePolicy`, call `setPremiumConfig` pointing `premiumToken` at the real `StableCoin` (dUSD) address, then `addPolicyTemplate` for each real-world plan you want offered (mirroring the travel/phone/pet-insurance stories) before any user can call `subscribeToPolicy`.

---

## 12. Next actions specific to this project

- **A systemic test-file bug, unrelated to the OpenZeppelin migration
  entirely, found via a full `-vvvv` trace**: `vm.prank(timelock)`
  followed immediately by `contract.grantRole(contract.SOME_ROLE(), ...)`
  doesn't do what it looks like it does. `contract.SOME_ROLE()` is
  itself a call, evaluated as an argument *before* `grantRole` executes
  — and that intermediate call consumes the single-shot `vm.prank`,
  leaving the real `grantRole` call to execute as the test contract
  itself, not the pranked address. The trace made this unambiguous: the
  `RoleGranted` events during `initialize()` proved `timelock` genuinely
  held `DEFAULT_ADMIN_ROLE`, yet `grantRole` still reverted — with the
  *test contract's* address named as unauthorized, not `timelock`'s.
  Found in **10 places across 5 files**
  (`ClaimRegistryUpgrade.t.sol` ×2, `InsurancePolicy.t.sol` ×2,
  `OracleAdapter.t.sol` ×3, `PolicyCatalog.t.sol` ×1, `Vault.t.sol` ×2),
  all fixed the same way: the role constant is read into a local
  variable *before* `vm.prank`, so no intermediate call can consume it.
  `Premium.t.sol`'s superficially similar pattern was checked and left
  alone — it uses `vm.startPrank`, which persists across calls rather
  than being single-use, so it was never actually affected.

- **`forge lint` cleanup applied** (all `test/` and `script/` files): every
  flagged `erc20-unchecked-transfer` warning fixed by wrapping the call
  in `require(...)` (12 instances); every flagged `unaliased-plain-import`
  note converted to a named import, with each file's actual symbol usage
  checked via `grep` before writing the named list — not assumed —
  specifically because a wrong guess there (e.g. omitting
  `IInsurancePolicyRegistry` from `ClaimRegistryUpgrade.t.sol`'s import,
  which that file's `MockPolicyRegistry` actually needs) would trade a
  cosmetic lint note for a real compile error. The one
  `mixed-case-variable` note (`liquidatorEOA`) was also renamed. Contract
  files under `contracts/` were left untouched — they weren't part of
  what was reported, and changing production contract imports without
  evidence they need it wasn't worth the risk.

- Pin the OpenZeppelin version (`^5.7.0` for both packages) in whatever
  dependency manifest this project uses going forward — Foundry's
  `forge install` pins by git tag/commit at install time, but nothing in
  this repo currently *enforces* v5.7.x if someone runs a bare
  `forge update`.
- Write and run the actual production `Deploy.s.sol` script (referenced
  in documentation throughout this project but not included as its own
  file in this bundle — only the test-fixture scripts are) that deploys
  the Safe + TimelockController + all three claims-system contracts
  together in the correct order, matching `besu-network/README.md`'s
  wiring instructions exactly.
- **`DICSGovernanceToken.sol` and `DICSGovernor.sol` were corrected
  against TWO real `forge build` runs** — not just reviewed logically
  like the rest of this batch, and not resolved in a single pass either.
  `ERC20Votes` in OpenZeppelin v4.9.x overrides
  `_afterTokenTransfer`/`_mint`/`_burn` (the pre-v5 hook pattern, not
  `_update`, which is v5-only) — `DICSGovernanceToken.sol` reflects this
  and has not triggered any reported error. `DICSGovernor.sol` needed
  two rounds: the first fix assumed all five `IGovernor`-adjacent
  functions (`votingDelay`, `votingPeriod`, `quorum`, `state`,
  `proposalThreshold`) needed the same override target and was wrong —
  the actual rule, learned from the compiler rather than assumed, is
  that `Governor` provides no function body at all for `votingDelay`,
  `votingPeriod`, or `quorum` (purely virtual until an extension
  implements them), so those three need `IGovernor` named, not
  `Governor`. `state` and `proposalThreshold` genuinely do have a body
  in `Governor` itself, so `Governor` is correct there — confirmed by
  the second build run reporting no error on either. This two-round
  correction is worth reading as a concrete illustration of why this
  project repeatedly said "not independently compiled" instead of
  implying confidence it didn't have: even after one real compiler
  round, the fix wasn't fully right, and a second real round was needed
  to get it actually correct. **`ClaimGasPaymaster.sol` has not received
  this same treatment** — it remains the one contract in this batch
  still unconfirmed against a real compiler; expect a similar multi-round
  correction process there once it's actually built, not a single fix.
- **Run `forge build` on `ClaimGasPaymaster.sol` specifically** — it
  still carries the strongest uncertainty caveat in this document and in
  its own source; treat any compiler error there as expected work to
  resolve, the same way the governance contracts' errors were just
  resolved above.
- Restrict `ClaimGasPaymaster.sol` to actually verify the sponsored
  operation targets `ClaimRegistry.submitClaim` specifically, once a
  smart-account implementation is chosen for policyholders to use.
- Build the EntryPoint-integration test for the paymaster, once the
  above is resolved.
- No frontend exists yet for any of this turn's additions — browsing the
  policy catalog, subscribing, paying/renewing premiums, or seeing
  premium status are all currently contract-only. The backend's
  `POST /claims` and related routes also don't yet expose the catalog.
- Separate `Liquidator.sol` back out from `Vault.sol` if this module
  ever needs multi-collateral support — the current single-collateral,
  liquidation-folded-in design was a deliberate simplification, not a
  permanent architectural decision.
- Run `forge coverage` and confirm the ≥80–90% targets referenced
  elsewhere in this project's planning are actually met, not just
  assumed — across *all* contracts now, not just the original three.
- Get an independent (non-self) security review of all contracts —
  including, and especially, the CDP module (the highest financial-risk
  addition in this batch) and the paymaster — before any deployment to a
  shared or persistent network. Every design document in this project has
  insisted on this as a hard gate, and it has not happened yet.


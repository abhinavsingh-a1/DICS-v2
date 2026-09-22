# 01 — `test/InsurancePolicy.t.sol` Explained

**Read `00-Introduction.md` first** if you haven't — this document
assumes you already know what `setUp()`, `vm.prank`, and
`vm.expectRevert` do.

## Purpose of this file

Tests `InsurancePolicy.sol` **on its own** — policy registration, the
active/inactive time-window logic, and the combined eligibility check —
without involving `ClaimRegistry`, premiums, or the self-service
catalog at all (those get their own files: `Premium.t.sol` and
`PolicyCatalog.t.sol`). This is the simplest test file in the project,
and the right one to read first.

## `setUp()` — what it builds, and why every line is there

```solidity
function setUp() public {
    InsurancePolicy implementation = new InsurancePolicy();
    bytes memory initData = abi.encodeWithSelector(InsurancePolicy.initialize.selector, timelock);
    ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);
    policy = InsurancePolicy(address(proxy));

    bytes32 policyManagerRole = policy.POLICY_MANAGER_ROLE();
    vm.prank(timelock);
    policy.grantRole(policyManagerRole, policyManager);

    vm.prank(policyManager);
    policy.registerPolicy(1, holder, 1_000, 2_000, 5_000 ether, keccak256("policy-doc"));
}
```

- **`new InsurancePolicy()`** — deploys the *implementation* contract.
  Without this, there's no code for a proxy to delegate to.
- **`ERC1967Proxy proxy = new ERC1967Proxy(...)`** — deploys the actual
  contract the test will interact with. This project's contracts are
  all UUPS upgradeable, meaning the real, permanent address is always a
  proxy, never the implementation directly — testing against the
  implementation address instead would mean testing something that
  doesn't match how this contract is ever actually used in production.
- **`policy = InsurancePolicy(address(proxy))`** — this line doesn't
  deploy anything; it tells Solidity "treat this proxy address as if
  it were an `InsurancePolicy`," so the rest of the file can call
  `policy.registerPolicy(...)` naturally instead of manually encoding
  every call. Every call still actually goes through the proxy.
- **`bytes32 policyManagerRole = policy.POLICY_MANAGER_ROLE();` before the `prank`** —
  this ordering is deliberate, not arbitrary. See `00-Introduction.md`'s
  callout on the single-shot `prank` gotcha — reversing these two lines
  would make `grantRole` silently execute as the wrong caller.
- **`policy.registerPolicy(1, holder, 1_000, 2_000, 5_000 ether, ...)`** —
  gives every test that follows a ready-made, known-good policy to test
  against (`policyId = 1`, active from timestamp `1_000` to `2_000`,
  `5_000 ether` coverage), so individual tests don't each need to
  repeat this setup. **Without this line**, every single test below
  would need its own multi-line policy registration just to have
  something to check — `setUp()` exists specifically to avoid that
  repetition.

## Every test, explained

### `test_RegisterPolicy_StoresCorrectData`
**Verifies:** the policy `setUp()` just registered was actually stored
with the exact values passed in.
**Why this test exists:** without it, nothing would catch a bug where
`registerPolicy` silently stored the wrong field into the wrong slot
(e.g. swapping `coverageAmount` and something else) — every *other*
test in this file implicitly trusts that registration stores data
correctly, so this is the one test that actually checks that trust is
justified.
**Data flow:** calls `policy.getPolicy(1)` (a plain read, no state
change), receives the `Policy` struct back, and checks three of its
fields against what was passed into `registerPolicy` in `setUp()`.

### `test_RevertWhen_DuplicatePolicyId`
**Verifies:** registering policy ID `1` a second time fails, instead of
silently overwriting the first one.
**Why this test exists:** without this guard (and without a test
proving the guard works), two different policyholders could end up
sharing one policy ID, corrupting both records — this is the test that
proves that can't happen.
**Data flow:** `vm.expectRevert(InsurancePolicy.PolicyAlreadyExists.selector)`
tells Foundry the very next call must revert with this exact custom
error; `registerPolicy(1, ...)` is then called again — since
`_exists[1]` is already `true` from `setUp()`, the real contract
reverts, and the test passes *because* it reverted as predicted.

### `test_RevertWhen_NonManagerRegisters`
**Verifies:** an address without `POLICY_MANAGER_ROLE` cannot register
a policy.
**Why this test exists:** `registerPolicy` being restricted to
`POLICY_MANAGER_ROLE` is a design decision written into the contract —
this test is what actually proves that restriction is enforced, not
just documented in a comment.
**Data flow:** `vm.prank(otherWallet)` makes the call appear to come
from an address that was never granted any role; `vm.expectRevert()`
with no specific error means "any revert is acceptable here" — used
because the exact error (`AccessControlUnauthorizedAccount` with a
specific role/account pair) is less important to this test than the
simple fact that it's blocked at all.

### `test_IsPolicyActive_TrueWithinWindow`
**Verifies:** a timestamp inside `[validFrom, validUntil]` (here, `1_500`
inside `[1_000, 2_000]`) is reported as active.
**Why this test exists:** this is the "happy path" for the active-window
check — without it, a bug that made `isPolicyActive` always return
`false` would only be caught by the *edge-case* tests below, which
wouldn't tell you the whole check was broken, just that the boundaries
were wrong.

### `test_IsPolicyActive_FalseBeforeStart`
**Verifies:** timestamp `999` — one tick before `validFrom = 1_000` —
is inactive.
**Why this test exists:** proves the *start* boundary is a closed
interval (inclusive of `validFrom` itself, exclusive of anything
before it) and is checked correctly, not off by one.

### `test_IsPolicyActive_FalseAfterExpiry`
**Verifies:** timestamp `2_001` — one tick after `validUntil = 2_000` —
is inactive.
**Why this test exists:** same reasoning as the previous test, mirrored
for the *end* boundary. Together, these two tests and
`test_IsPolicyActive_TrueWithinWindow` prove the interval is exactly
`[1_000, 2_000]` inclusive on both ends — not `[1_000, 2_000)` or
`(1_000, 2_000]`, which would be equally easy bugs to introduce
accidentally.

### `test_IsPolicyActive_FalseWhenRevoked`
**Verifies:** a policy inside its valid date range is *still* inactive
if it's been revoked.
**Why this test exists:** `revoked` and the date range are two
independent conditions in the real contract's logic — without a
dedicated test, a bug that made `isPolicyActive` ignore the `revoked`
flag entirely (only checking dates) would pass every other test in this
file and go completely undetected.
**Data flow:** `vm.prank(policyManager); policy.revokePolicy(1);` first
flips the stored `revoked` flag to `true`; then `isPolicyActive(1, 1_500)`
is checked at a timestamp that would otherwise clearly be active,
isolating revocation as the only variable that changed.

### `test_IsClaimEligible_TrueForValidClaim`
**Verifies:** the combined eligibility check (holder matches, active,
within coverage) returns `true` for a claim that satisfies all three.
**Why this test exists:** `isClaimEligible` isn't tested by simply
reusing the pieces above — it's its own function with its own logic,
so it needs its own passing case proven, not just assumed from the
individual checks passing separately.

### `test_IsClaimEligible_FalseForWrongClaimant`
**Verifies:** the same claim, same amount, same timestamp — but
requested by `otherWallet` instead of the real `holder` — is rejected.
**Why this test exists:** proves the holder-matching part of
`isClaimEligible` is actually being checked, not skipped. Without this,
anyone could claim against anyone else's policy.

### `test_IsClaimEligible_FalseWhenExceedsCoverage`
**Verifies:** a claim of `6_000 ether` against a policy with
`5_000 ether` coverage is rejected.
**Why this test exists:** proves the coverage-cap part of
`isClaimEligible` is enforced, independent of the holder-matching and
date-range checks — each of these three "false" tests changes exactly
one variable, so a failing test tells you precisely which part of the
check broke.

### `test_RevertWhen_PausedRegistration`
**Verifies:** once the contract is paused, `registerPolicy` stops
working, even for an address that legitimately holds
`POLICY_MANAGER_ROLE`.
**Why this test exists:** the emergency pause mechanism is only
meaningful if it actually blocks *everything* it's supposed to — this
test specifically distinguishes "blocked because paused" from "blocked
because unauthorized" (which `test_RevertWhen_NonManagerRegisters`
already covers), proving these are two genuinely separate guards, both
working.
**Data flow:** reads `PAUSER_ROLE()` into a local variable first (same
pattern as `setUp()`, same reason), grants it to `timelock`, calls
`policy.pause()` as `timelock`, then attempts a legitimate
`policyManager`-authorized registration — which still fails, proving
the pause check runs *before* (or independent of) the role check, not
bypassed by having the right role.

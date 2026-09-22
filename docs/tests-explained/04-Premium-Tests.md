# 04 — `test/Premium.t.sol` Explained

**Read `00-Introduction.md` and `03-ClaimRegistryUpgrade-Tests.md` first**
— this document contrasts directly with that file's use of
`MockPolicyRegistry`.

## Purpose of this file

Proves the premium-enforcement mechanism works **end-to-end**, using
the real `InsurancePolicy` and the real `ClaimRegistry` together — not
a mock standing in for either one. Where `ClaimRegistryUpgrade.t.sol`
tests `ClaimRegistry`'s logic in isolation, this file exists
specifically to prove the two real contracts correctly *talk to each
other* about premium status.

## Why this file deliberately does NOT use `MockPolicyRegistry`

This is worth understanding as a deliberate choice, not an oversight.
`MockPolicyRegistry.isPremiumCurrent` just returns whatever boolean a
test told it to return — it doesn't run any of `InsurancePolicy`'s
*actual* premium logic (grace periods, the "unconfigured is exempt"
rule, the atomic pay-and-issue flow). A test built on that mock could
never prove `InsurancePolicy`'s real premium calculation is correct —
only that `ClaimRegistry` correctly *asks* the question and correctly
*reacts* to whatever answer it's given. Both are necessary; this file
is what covers the half `ClaimRegistryUpgrade.t.sol`'s mock-based tests
structurally cannot.

## `setUp()` — what it builds, and why every line is there

```solidity
function setUp() public {
    InsurancePolicy policyImpl = new InsurancePolicy();
    // ... deploy policy proxy ...
    payoutToken = new TestPayoutToken();
    // ... deploy registry proxy, pointed at the real policy proxy ...
    require(payoutToken.transfer(address(registry), 100_000 ether), "transfer failed");

    vm.startPrank(timelock);
    policy.grantRole(policy.POLICY_MANAGER_ROLE(), policyManager);
    registry.grantRole(registry.UNDERWRITER_ROLE(), underwriter);
    vm.stopPrank();

    premiumToken = new TestPayoutToken();
    vm.prank(timelock);
    policy.setPremiumConfig(address(premiumToken), treasury, GRACE);

    vm.prank(policyManager);
    policy.registerPolicy(1, holder, 0, type(uint40).max, 1_000_000 ether, keccak256("policy-1"));
    vm.prank(policyManager);
    policy.setPremiumTerms(1, PREMIUM_AMOUNT, PERIOD);

    require(premiumToken.transfer(holder, 10_000 ether), "transfer failed");
    vm.prank(holder);
    premiumToken.approve(address(policy), type(uint256).max);
}
```

- **`registry` is deployed pointing `address(policy)` in as its policy
  registry** — this single detail is the entire point of the file: a
  real `ClaimRegistry` calling a real `InsurancePolicy`, not a mock in
  between.
- **`vm.startPrank(timelock)` / `vm.stopPrank()` for the two role
  grants** — unlike most other files' single `vm.prank` calls, this
  block grants roles on *two different contracts* back to back. Using
  `startPrank`/`stopPrank` here (rather than two separate `vm.prank`
  calls) is a legitimate style choice, not a fix for the single-shot
  gotcha — both are equally correct; `startPrank` just reads slightly
  more naturally when one actor does several things in a row. See
  `00-Introduction.md`'s cheatcode table for why either would actually
  work here (neither `grantRole` call has an inline `.ROLE()` lookup
  as an argument in this specific pair — wait, they do:
  `policy.POLICY_MANAGER_ROLE()` and `registry.UNDERWRITER_ROLE()` are
  both inline — and this is exactly why `startPrank` matters here, not
  just style: with a single-shot `vm.prank`, the *first* inline lookup
  would consume it, breaking the *first* grant, exactly like the bug
  described in the introduction. `startPrank` holding the override
  across both calls is what keeps this pattern safe.
- **`premiumToken = new TestPayoutToken();`** — deliberately a
  *separate* token instance from `payoutToken`, even though both come
  from the identical contract code. Keeping premium currency and payout
  currency as distinct token instances here means a bug that confused
  which token was meant for which purpose inside `InsurancePolicy` or
  `ClaimRegistry` would be caught by balance checks not matching up —
  the same reasoning `10-Mock-TestCollateralToken.md` gives for why
  collateral and payout tokens are kept separate in `Vault.t.sol`.
- **`policy.setPremiumTerms(1, PREMIUM_AMOUNT, PERIOD)`** — without
  this line, policy `1` would have no configured premium terms at all,
  and (per `InsurancePolicy`'s own "unconfigured is exempt" rule) every
  test in this file would find premiums simply don't apply — the
  opposite of what this file exists to test.
- **`premiumToken.approve(address(policy), type(uint256).max)`** —
  without this, every `payPremium` call in every test below would
  revert on an insufficient allowance before any of the actual premium
  logic being tested ever ran.

## Every test, explained

### `test_PayPremium_ExtendsFromNowWhenNoPriorPayment`
**Verifies:** a first-ever premium payment sets `premiumPaidUntil` to
exactly `now + PERIOD`.
**Why this test exists:** the simplest possible correctness check for
the payment math — every other payment-related test in this file
builds on the assumption this basic case is right.

### `test_PayPremium_StacksOnRemainingPeriodRatherThanWastingIt`
**Verifies:** paying early, before the current period expires, extends
from the *previous* expiry date — not from "now," which would silently
discard whatever time was left over.
**Why this test exists:** without this test, a simpler (and wrong)
implementation — always setting `premiumPaidUntil = now + PERIOD`,
regardless of what it was before — would pass every other test in this
file, since none of the others pay twice. This is the one test that
actually pays twice and checks the second payment's effect.
**Data flow:** pays once, records the resulting `premiumPaidUntil`;
`vm.warp(block.timestamp + 10 days)` jumps forward, still well inside
the 30-day period; pays again; checks the new `premiumPaidUntil` equals
the *first* payment's expiry plus another full period — proving the
remaining 20 days weren't thrown away.

### `test_IsPremiumCurrent_TrueWithinGracePeriodAfterLapse`
**Verifies:** the exact boundary of the grace period — one second
before it ends, still current; two seconds later, no longer current.
**Why this test exists:** boundary conditions are exactly where
off-by-one bugs hide — this test proves the grace period is inclusive
up to and including its last valid second, not one short or one long.
**Data flow:** pays once; warps to `paidUntil + GRACE - 1` and checks
`isPremiumCurrent` is still `true`; warps `2` seconds further (past the
boundary) and checks it's now `false`.

### `test_UnconfiguredPremiumTermsAreExempt`
**Verifies:** a policy that never had `setPremiumTerms` called on it at
all is treated as exempt — not permanently, incorrectly blocked.
**Why this test exists:** proves the "opt-in billing" design decision
(documented elsewhere in this project) is actually implemented, not
just described. Without this test, a bug that made every policy
default to *requiring* payment — even ones nobody ever intended to
bill — would silently lock out every policy issued before billing was
configured for it.
**Data flow:** registers a brand-new `policyId: 2`, deliberately
*never* calling `setPremiumTerms` for it, then checks
`isPremiumCurrent(2)` directly returns `true` with no payment ever
made.

### `test_RevertWhen_NonHolderPaysPremium`
**Verifies:** only the actual policyholder can pay their own premium —
not a stranger paying on their behalf.
**Why this test exists:** without this restriction, the specific
semantics of "who owns this policy" could become murky — anyone could
technically keep a policy "current" regardless of who's actually
supposed to be paying for it. This test proves that door is closed by
design, even though nothing stops a well-meaning third party from
funding the actual holder directly instead.
**Data flow:** creates a fresh `impostor` address, gives it tokens and
an allowance (so the *only* reason it can fail is the holder check,
nothing else), then confirms `payPremium(1)` reverts specifically with
`OnlyPolicyHolderCanPay`.

### `test_ClaimSubmission_SucceedsWhenPremiumCurrent`
**Verifies:** the actual end-to-end connection — a real, paid-up policy
lets a real claim through `ClaimRegistry`.
**Why this test exists:** this is the test that justifies this file's
whole reason for existing — proving the real `InsurancePolicy` and real
`ClaimRegistry` genuinely cooperate, not just that each one's internal
logic is individually correct.

### `test_RevertWhen_ClaimSubmittedAfterPremiumLapsed`
**Verifies:** the mirror case — a lapsed policy blocks a claim at the
`ClaimRegistry` level, using the real contracts, not the mock.
**Why this test exists:** `ClaimRegistryUpgrade.t.sol`'s
`test_RevertWhen_PolicyPremiumLapsed` already proves `ClaimRegistry`
reacts correctly to `isPremiumCurrent() == false` — but only ever as
told to by a mock. This test proves the *real* `InsurancePolicy`
actually produces `false` at the right moment, and that the real
connection between the two contracts carries that correctly through to
a blocked claim.
**Data flow:** pays once, warps past `PERIOD + GRACE + 1`, then attempts
a claim — reverts with `PremiumNotCurrent`, this time genuinely
computed by `InsurancePolicy.isPremiumCurrent`, not returned by a mock.

### `test_ClaimSubmission_AllowedWhenNeverBilled`
**Verifies:** the end-to-end version of the exemption case — a policy
with no premium terms configured can still be claimed against through
the real `ClaimRegistry`.
**Data flow:** registers `policyId: 3` with no `setPremiumTerms` call,
then submits a claim directly — succeeds, proving the exemption holds
all the way through the real inter-contract call, not just at the
`InsurancePolicy` level in isolation.

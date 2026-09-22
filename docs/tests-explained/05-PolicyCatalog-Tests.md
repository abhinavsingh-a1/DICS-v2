# 05 — `test/PolicyCatalog.t.sol` Explained

**Read `00-Introduction.md` and `04-Premium-Tests.md` first** — this
file shares the same "real contracts, no mock" philosophy.

## Purpose of this file

Tests the self-service policy catalog — `addPolicyTemplate`,
`setPolicyTemplateActive`, and above all `subscribeToPolicy`, the
function that issues a policy and collects its first premium payment
**atomically**, in one transaction. Like `Premium.t.sol`, this file
uses the real `InsurancePolicy` and real `ClaimRegistry` together.

## `setUp()` — what it builds, and why every line is there

```solidity
function setUp() public {
    // ... deploy policy and registry proxies, same pattern as Premium.t.sol ...

    bytes32 policyManagerRole = policy.POLICY_MANAGER_ROLE();
    vm.prank(timelock);
    policy.grantRole(policyManagerRole, policyManager);

    premiumToken = new TestPayoutToken();
    vm.prank(timelock);
    policy.setPremiumConfig(address(premiumToken), treasury, 7 days);

    vm.prank(policyManager);
    policy.addPolicyTemplate(TRAVEL_TEMPLATE, COVERAGE, PREMIUM, PERIOD, TERM, keccak256("travel-standard"));

    require(premiumToken.transfer(alice, 10_000 ether), "transfer failed");
    vm.prank(alice);
    premiumToken.approve(address(policy), type(uint256).max);
}
```

- **`policy.addPolicyTemplate(TRAVEL_TEMPLATE, COVERAGE, PREMIUM, PERIOD, TERM, ...)`** —
  without this line, there would be no catalog entry at all for
  `subscribeToPolicy` to look up; every test below would fail
  immediately with `PolicyTemplateNotFound`, regardless of what it was
  actually trying to test. This one line is what turns "an empty
  catalog" into "a working travel-insurance-style plan ready to be
  bought," matching the real-world story (buying travel insurance
  before a trip) this feature was originally built to support.
- **`alice`'s tokens and approval are set up in `setUp()`, not repeated
  per test** — every test in this file has Alice subscribing to the
  same template, so giving her funding and an approval once, up front,
  avoids six near-identical repetitions.

## Every test, explained

### `test_SubscribeToPolicy_IssuesAndPaysAtomically`
**Verifies:** one call to `subscribeToPolicy` results in both a fully
formed, active `Policy` record *and* a completed premium payment — the
core promise of this feature.
**Why this test exists:** this is the test that proves the feature does
what it was built for — closing the exact gap (a policy that could
exist without ever being paid for) described in this project's own
documentation. Without it, nothing would catch a regression that
un-linked issuance from payment again.
**Data flow:** `alice` calls `subscribeToPolicy(TRAVEL_TEMPLATE)`;
the returned `policyId` is used to fetch the policy back and check its
`holder` and `coverageAmount`; `isPolicyActive` and `isPremiumCurrent`
are both checked `true` in the same test, specifically because both
being true *together* is what "atomically" is supposed to guarantee;
finally, `premiumToken.balanceOf(treasury)` confirms the money actually
moved, not just that the policy record looks right.

### `test_RevertWhen_SubscribingToInactiveTemplate`
**Verifies:** a discontinued plan can't be newly subscribed to.
**Why this test exists:** proves `setPolicyTemplateActive(false)`
genuinely blocks new subscriptions, not just marks a cosmetic flag that
nothing actually checks.

### `test_DiscontinuingTemplate_DoesNotAffectExistingPolicy`
**Verifies:** discontinuing a plan **after** someone has already
subscribed doesn't retroactively break their existing coverage.
**Why this test exists:** without this test, a simpler (and wrong)
implementation of "discontinue" — one that also somehow deactivated
existing policies issued from that template — would pass the previous
test while still being a serious, unintended side effect. This is the
one test proving discontinuation only affects *future* subscribers.
**Data flow:** Alice subscribes first, *then* the template is
deactivated; her policy is checked as still active and still premium-
current afterward.

### `test_RevertWhen_InsufficientAllowanceLeavesNoOrphanedPolicy`
**Verifies:** if the payment half of `subscribeToPolicy` fails, the
policy-issuance half doesn't silently succeed anyway — proven directly,
not assumed.
**Why this test exists:** "atomic" is a strong word, and this is the
test that actually holds it to account, rather than trusting it by
description. This is arguably the single most important test in this
file.
**Data flow:** revokes Alice's token approval down to `0` (undoing what
`setUp()` granted); records `nextPolicyId` *before* the attempt;
`vm.expectRevert()` (no specific error — the exact revert reason from
deep inside `SafeERC20` isn't the point, only that it reverts) wraps
the `subscribeToPolicy` call, which fails partway through, inside the
internal payment step; then — this is the actual proof, not just an
assumption — `assertEq(policy.nextPolicyId(), nextIdBefore)` confirms
the counter never advanced, and a second `vm.expectRevert(InsurancePolicy.PolicyNotFound.selector)`
wrapped around `policy.getPolicy(nextIdBefore)` confirms no policy
record exists at that ID either. Two separate, direct checks — not one
assumption resting on the other.

### `test_SubscribedPolicy_CanBeClaimedAgainstImmediately`
**Verifies:** a policy bought through this self-service path is
immediately usable for a real claim — no waiting period, no separate
activation step.
**Why this test exists:** connects this file's feature back to
`ClaimRegistry`, the same way `Premium.t.sol` connects premium status
to claims — proving the self-service path produces a policy that's
genuinely equivalent to one issued the older, admin-driven way.

### `test_RevertWhen_ClaimingAfterSubscribedPolicyLapses`
**Verifies:** a self-service-issued policy that's never renewed lapses
and blocks claims, exactly like an admin-issued one does.
**Why this test exists:** proves the premium-enforcement guarantees
from `Premium.t.sol` apply equally to policies issued through this
newer path — not a separate, accidentally-weaker code path that
happens to look similar.

### `test_SubscribeToPolicy_AutoIncrementsIdsAcrossMultipleUsers`
**Verifies:** policy IDs correctly increment across *different*,
independent subscribers — not just repeated purchases by one person.
**Why this test exists:** without a second subscriber in the test, a
subtle ID-assignment bug specific to multi-user scenarios (for
example, IDs based on something per-address rather than a genuinely
global counter) could hide behind tests that only ever use `alice`.
**Data flow:** a second address, `bob`, is funded and given an
allowance mid-test (not in `setUp()`, since he's specific to this one
test); both `alice` and `bob` subscribe to the same template; the test
checks `id2 > id1` and that each policy's stored `holder` matches the
correct subscriber — proving the IDs and the ownership records don't
get crossed between the two independent purchases.

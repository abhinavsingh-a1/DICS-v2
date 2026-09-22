# 03 — `test/ClaimRegistryUpgrade.t.sol` Explained

**Read `00-Introduction.md` first.** This is the largest test file in
the project (13 tests) and introduces `MockPolicyRegistry` — a pattern
`04-Premium-Tests.md` and `05-PolicyCatalog-Tests.md` deliberately
*don't* reuse, for reasons explained there.

## Purpose of this file

Tests `ClaimRegistry.sol` in isolation: claim submission, status
changes, payout, rate limiting, and — its name's namesake — proof that
upgrading the contract doesn't lose existing data. It uses a mock
policy registry rather than a real `InsurancePolicy`, so every test
here is purely about `ClaimRegistry`'s own logic.

## The three helper contracts declared at the top of this file

Unlike every other test file so far, this one declares three small
contracts *before* the test contract itself. Each exists for a
different reason.

### `TestToken` — a plain payout token

```solidity
contract TestToken is ERC20 {
    constructor() ERC20("Test", "TST") {
        _mint(msg.sender, 1_000_000 ether);
    }
}
```

Functionally identical to `TestPayoutToken.sol` (see
`09-Mock-TestPayoutToken.md`) — this file simply predates that shared
version and declares its own copy inline. **Why it's still here rather
than switched to the shared one:** no functional reason — purely
because this file was written first, before the shared mock existed,
and changing it isn't necessary for correctness. Worth knowing as a
real example of incidental duplication in a codebase, not every
instance of "two things that look the same" is a bug.

### `ClaimRegistryV2` — a deliberately minimal upgraded version

```solidity
contract ClaimRegistryV2 is ClaimRegistry {
    uint256 public newFieldAddedInV2;

    function setNewField(uint256 value) external {
        newFieldAddedInV2 = value;
    }

    function version() external pure returns (string memory) {
        return "v2";
    }
}
```

**Why this exists, and what would be left out without it:** proving an
upgrade preserves data requires actually *performing* an upgrade inside
a test — which means there has to be a "version 2" to upgrade to. A
real V2 would live in its own file (the comment above the contract says
so directly), but for a test, all that's needed is *something*
different enough to prove the swap really happened: one brand-new
storage variable (`newFieldAddedInV2`) and one new function
(`version()`) that couldn't exist on the original `ClaimRegistry`.
Without this contract, `test_StateSurvivesUpgrade` (below) would have
nothing to upgrade *to*, and couldn't prove anything about upgrades at
all.

### `MockPolicyRegistry` — a controllable stand-in for `InsurancePolicy`

```solidity
contract MockPolicyRegistry is IInsurancePolicyRegistry {
    mapping(uint256 => Policy) private _policies;
    bool public premiumCurrent = true;

    function setPolicy(uint256 policyId, Policy calldata p) external {
        _policies[policyId] = p;
    }

    function getPolicy(uint256 policyId) external view override returns (Policy memory) {
        return _policies[policyId];
    }

    function isPremiumCurrent(uint256) external view override returns (bool) {
        return premiumCurrent;
    }

    function setPremiumCurrent(bool value) external {
        premiumCurrent = value;
    }
}
```

**Why this exists, and what would be left out without it:** `ClaimRegistry`
calls out to whatever contract implements `IInsurancePolicyRegistry` to
check a policy's validity before accepting a claim. A real
`InsurancePolicy` enforces its *own* rules about how a policy becomes
active, revoked, or premium-current — rules this file has nothing to do
with testing. `MockPolicyRegistry` strips all of that away: `setPolicy`
lets a test **directly force** any policy into any state it wants —
revoked, expired, whatever coverage amount — in one line, something a
real `InsurancePolicy` would never allow from outside its own
functions. Without this mock, testing "what happens when `ClaimRegistry`
receives a claim against a revoked policy" would require first
learning and replicating `InsurancePolicy`'s entire revocation
procedure — an unrelated contract's rules, standing in the way of
testing this one.

- **`bool public premiumCurrent = true;`** — defaults to permissive
  specifically so that the 11 tests in this file that have nothing to
  do with premiums don't need to think about premiums at all; only
  `test_RevertWhen_PolicyPremiumLapsed` (below) ever calls
  `setPremiumCurrent(false)` to turn this off.
- **`override` on `getPolicy` and `isPremiumCurrent`** — required by
  Solidity for the same reason covered in
  `08-Mock-MockClaimRegistrySink.md`: these functions implement an
  interface's declarations, and Solidity requires that connection to be
  explicit.

## `setUp()` — what it builds

```solidity
function setUp() public {
    vm.label(timelock, "Timelock");
    vm.label(underwriter, "Underwriter");
    vm.label(claimant, "Claimant");

    token = new TestToken();
    policyRegistryMock = new MockPolicyRegistry();

    policyRegistryMock.setPolicy(1, IInsurancePolicyRegistry.Policy({
        policyId: 1, coverageAmount: 1_000_000 ether, holder: claimant,
        validFrom: 0, validUntil: type(uint40).max, revoked: false,
        metadataHash: keccak256("policy-1")
    }));

    ClaimRegistry implementation = new ClaimRegistry();
    bytes memory initData = abi.encodeWithSelector(
        ClaimRegistry.initialize.selector, timelock, address(token),
        address(policyRegistryMock), 1_000 ether, 10_000 ether, 1 days
    );
    proxy = new ERC1967Proxy(address(implementation), initData);
    registry = ClaimRegistry(address(proxy));

    bytes32 underwriterRole = registry.UNDERWRITER_ROLE();
    vm.prank(timelock);
    registry.grantRole(underwriterRole, underwriter);

    require(token.transfer(address(registry), 50_000 ether), "transfer failed");
}
```

- **`coverageAmount: 1_000_000 ether`** on the default policy — set
  deliberately huge. The comment in the source explains why directly:
  tests that are really about rate limits, upgrades, or pausing
  shouldn't *also* incidentally be testing the coverage check — a
  small default coverage could make an unrelated test fail for the
  wrong reason (hitting the coverage cap by accident), making a
  failure harder to diagnose. Tests that specifically want to test
  coverage limits (further down the file) register their own,
  deliberately small policies instead.
- **`require(token.transfer(address(registry), 50_000 ether), ...)`** —
  without this, `registry` would hold zero payout tokens, and every
  test that reaches an actual `payoutClaim` call would fail — not
  because payout logic is broken, but simply because there'd be
  nothing to pay out. This line is what makes those tests possible at
  all.

## Every test, explained

### `test_StateSurvivesUpgrade`
**Verifies:** data written before an upgrade (a claim's claimant,
amount, and status) is still correct after upgrading to `ClaimRegistryV2`
— and that the new version's new behavior also works.
**Why this test exists:** this is the single most important guarantee
an upgradeable contract makes — storage isn't reset or scrambled by an
upgrade. Without this test, nothing in the suite would catch a storage-
layout mistake that corrupted existing data the moment an upgrade
happened (exactly the class of bug the `__gap` reserved-slots pattern,
covered elsewhere in this project's documentation, exists to prevent).
**Data flow:** submits a claim, approves it, pays it out — all under
the original implementation — then reads the claim back and checks its
fields; deploys `ClaimRegistryV2` and calls
`registry.upgradeToAndCall(address(implementationV2), "")` as `timelock`
(the only address holding `UPGRADER_ROLE`); re-wraps the *same proxy
address* as `ClaimRegistryV2` and reads the claim back *again* — same
storage, new code reading it — confirming nothing changed; then calls
the brand-new `setNewField(42)` and `version()` to prove the new code
genuinely works too, not just that the old code's data survived.

### `test_RevertWhen_NonUpgraderCallsUpgrade`
**Verifies:** an address without `UPGRADER_ROLE` cannot upgrade the
contract.
**Why this test exists:** an upgrade is the single most powerful action
possible on this contract — it can replace *all* of its logic. Without
a test proving this is locked down, there would be no automated
evidence that only the Timelock can do this.

### `test_RevertWhen_PausedRejectsSubmitClaim`
**Verifies:** the pause mechanism blocks claim submission.
**Why this test exists:** same reasoning as the pause tests in the
other two files — proves the guard reaches this specific function.

### `test_RevertWhen_ClaimExceedsRateLimitWindow`
**Verifies:** once total payouts in the current time window hit the
configured cap (`10_000 ether`), the *next* payout is blocked, even for
an otherwise perfectly valid, approved claim.
**Why this test exists:** the rate limit exists to cap financial
exposure over any given window — this test is the only place in the
suite that actually drives the running total up to the boundary and
proves the cap holds exactly there, not one payout later.
**Data flow:** a loop submits, approves, and pays out ten separate
`1_000 ether` claims — the tenth one lands exactly on the `10_000 ether`
cap and still succeeds; an eleventh claim is submitted and approved
normally (submission and approval don't check the rate limit — only
payout does), then `vm.expectRevert(ClaimRegistry.RateLimitWindowExceeded.selector)`
confirms that specific eleventh *payout* is what actually fails.

### `test_RescueForeignToken_RevertsOnPayoutToken`
**Verifies:** the admin "rescue a foreign token sent here by mistake"
function refuses to rescue the *actual* payout token.
**Why this test exists:** without this specific restriction — and a
test proving it's enforced — an admin (even an honest one, by mistake)
could drain the exact funds set aside to pay real claims, using a
function meant only for accidentally-sent, unrelated tokens.

### `test_RevertWhen_ClaimantIsNotPolicyHolder`
**Verifies:** an address that isn't the policy's holder can't submit a
claim against it.
**Why this test exists:** without this, anyone could file — and
potentially get paid on — a claim against a policy they don't own.

### `test_RevertWhen_PolicyRevoked`
**Verifies:** `submitClaim` checks the policy's `revoked` flag (via the
mock) and rejects a claim against a revoked policy.
**Data flow:** registers a *second*, separate policy (`policyId: 2`)
directly via `policyRegistryMock.setPolicy`, with `revoked: true` set
from the start — demonstrating exactly why `MockPolicyRegistry` matters
here: forcing a policy straight into a revoked state, something a real
`InsurancePolicy` has no direct external way to do (it would require
first registering, then separately calling `revokePolicy`).

### `test_RevertWhen_PolicyNotYetValid`
**Verifies:** a policy whose `validFrom` is in the future rejects a
claim submitted before that date.
**Data flow:** registers `policyId: 3` with
`validFrom: uint40(block.timestamp + 1_000)` — again, something only
possible to set up directly because of the mock.

### `test_RevertWhen_ClaimExceedsPolicyCoverage`
**Verifies:** a single claim larger than the policy's coverage is
rejected outright.
**Data flow:** registers `policyId: 4` with a deliberately small
`coverageAmount: 500 ether` (contrast with `setUp()`'s huge default —
this is exactly the case that default was designed to keep separate
from other tests), then attempts a `600 ether` claim.

### `test_RevertWhen_CumulativeNonRejectedClaimsExceedCoverage`
**Verifies:** coverage is a *shared budget* across multiple claims on
one policy, not a per-claim allowance — two `500 ether` claims against
`900 ether` coverage, individually fine, are rejected together.
**Why this test exists:** without it, a subtler bug — checking only the
new claim's amount against total coverage, forgetting to add in
*already-pending* claims — would pass every other coverage test in this
file (which each only ever submit one claim) while still allowing real
over-coverage payouts in practice.
**Data flow:** the first `500 ether` claim on `policyId: 5` succeeds
and stays `Submitted` (never approved or rejected); the second,
otherwise-identical `500 ether` claim reverts, because `500 + 500 > 900`.

### `test_RejectedClaimFreesUpCoverageForNewSubmission`
**Verifies:** the mirror image of the previous test — once a claim is
explicitly `Rejected`, it stops counting against coverage, freeing that
budget for a new claim.
**Why this test exists:** without this test, a bug that counted
*every* claim ever submitted toward coverage forever (even rejected
ones) would look identical to correct behavior in every other test —
this is the one test that proves rejection genuinely releases the
reserved amount, not just that pending claims reserve it.
**Data flow:** submits `500 ether` on `policyId: 6`, then the
underwriter explicitly rejects it (`setClaimStatus(..., Rejected)`);
a second `500 ether` claim is then submitted and — unlike the previous
test — succeeds, because the first claim no longer counts.

### `test_RevertWhen_PolicyPremiumLapsed`
**Verifies:** `submitClaim` checks `isPremiumCurrent` and blocks
submission when it returns `false`.
**Data flow:** calls `policyRegistryMock.setPremiumCurrent(false)` —
the one and only test in this file that touches this flag — then
attempts a claim against the default policy from `setUp()`, which
reverts purely because of the premium check, with every other condition
otherwise valid.

### `test_RevertWhen_PolicyRegistryNotSet`
**Verifies:** if `ClaimRegistry` was deployed without ever being told
which contract to treat as the policy registry, `submitClaim` fails
cleanly rather than crashing unpredictably.
**Why this test exists:** every *other* test in this file relies on
`setUp()` having correctly wired up `policyRegistryMock` — this is the
one test that deliberately does **not** do that, to prove the contract
handles its own absence gracefully with a clear, named error instead of
an obscure low-level failure.
**Data flow:** deploys a completely separate, second `ClaimRegistry`
proxy (not reusing `setUp()`'s `registry` at all), passing
`address(0)` as the policy registry address during initialization —
then confirms `submitClaim` reverts with the specific
`PolicyRegistryNotSet` error, not some generic failure.

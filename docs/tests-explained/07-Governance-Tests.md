# 07 — `test/Governance.t.sol` Explained

**Read `00-Introduction.md` and `06-Vault-Tests.md` first** — this file
tests the *only* legitimate way to change the parameters
`test_RevertWhen_NonAdminUpdatesRiskParams` in that file proves is
otherwise locked shut.

## Purpose of this file

Tests the complete propose → vote → queue → execute governance cycle,
proving `DICSGovernor` can actually change a real `Vault`'s risk
parameters end-to-end — and that it can't be rushed or bypassed. This
is the smallest test file in the project (3 tests) but arguably the
most conceptually dense, since it exercises four different contracts
working together across two kinds of delay (a voting period measured
in blocks, and a Timelock delay measured in time).

## `setUp()` — what it builds, and why every line is there

```solidity
function setUp() public {
    token = new DICSGovernanceToken(1_000_000 ether);
    require(token.transfer(voter, 500_000 ether), "transfer failed");
    vm.prank(voter);
    token.delegate(voter);

    address[] memory proposers = new address[](0);
    address[] memory executors = new address[](1);
    executors[0] = address(0);
    cdpTimelock = new TimelockController(MIN_DELAY, proposers, executors, address(this));

    governor = new DICSGovernor(IVotes(address(token)), cdpTimelock);

    cdpTimelock.grantRole(cdpTimelock.PROPOSER_ROLE(), address(governor));
    cdpTimelock.grantRole(cdpTimelock.CANCELLER_ROLE(), address(governor));
    cdpTimelock.renounceRole(cdpTimelock.DEFAULT_ADMIN_ROLE(), address(this));

    // ... deploy priceOracle and vault, both admin-controlled by cdpTimelock, not a Safe/EOA ...
}
```

- **`token.transfer(voter, 500_000 ether)` — exactly half the supply** —
  giving one address a clean majority (`50%+1` isn't needed since
  `500_000` of `1_000_000` is already enough against a `4%` quorum) is
  a deliberate simplification: this file isn't testing vote-counting
  edge cases (split votes, quorum math under contention) — it's testing
  whether the governance *pipeline* works at all. Concentrating voting
  power in one address removes an entire dimension of complexity that
  has nothing to do with what this file exists to check.
- **`vm.prank(voter); token.delegate(voter);`** — holding governance
  tokens and having *voting power* are two different things in
  OpenZeppelin's `ERC20Votes` design; voting power only activates once
  an address delegates (even delegating to itself). **Without this
  line**, `voter` would hold `500_000` tokens but have `0` voting
  power, and `governor.castVote` later in the file would have no effect
  — the whole test would fail two functions later, for a reason that
  wouldn't be obvious from where it actually failed.
- **`proposers = new address[](0)`** (an *empty* array) passed to the
  `TimelockController` constructor — deliberate: nobody should be able
  to queue a Timelock action **except** `DICSGovernor` itself, which is
  why the very next lines explicitly `grantRole(PROPOSER_ROLE, address(governor))`
  instead. Starting with zero proposers and adding exactly one,
  explicitly, is what proves the Governor is the *only* path in —
  starting with some default proposer would leave an unintended side
  door.
- **`executors[0] = address(0)`** — in `TimelockController`, granting
  `EXECUTOR_ROLE` to the zero address is OpenZeppelin's own documented
  convention for "anyone can execute once the delay has passed" —
  execution itself doesn't need to be restricted, since by that point
  the proposal has already survived voting *and* the delay; restricting
  *who* can trigger the already-approved action adds no real security.
- **`cdpTimelock.renounceRole(cdpTimelock.DEFAULT_ADMIN_ROLE(), address(this))`** —
  without this line, the test contract itself would retain permanent
  admin power over the Timelock forever, which would mean governance
  isn't actually the *only* path to changing anything — there'd be a
  standing back door. Renouncing it here mirrors what a real deployment
  script must also do after finishing setup, and is what makes
  `test_RevertWhen_DirectCallBypassingGovernance` (below) meaningful at
  all.
- **`Vault`'s `initialize` is called with `address(cdpTimelock)` as its
  admin, not a plain address like `timelock` in every other file** —
  this is the detail that actually connects governance to the Vault: it
  means `ADMIN_ROLE` on `Vault` belongs to the *Timelock contract
  itself*, reachable only through a successful governance proposal —
  not to any individual person or test-only address.

## Every test, explained

### `test_FullGovernanceCycle_UpdatesVaultRiskParams`
**Verifies:** the complete cycle — propose, wait out the voting delay,
vote, wait out the voting period, queue, wait out the Timelock delay,
execute — actually changes a real `Vault` parameter at the end.
**Why this test exists:** this is the test that proves governance isn't
just a collection of individually-working pieces, but a genuine,
working pipeline from a token holder's vote all the way through to a
real state change on an entirely different contract.
**Data flow, step by step:**
1. Builds a `targets`/`values`/`calldatas` triple describing exactly
   one action: call `Vault.updateRiskParams(18_000, 1_500)` (raising
   the ratio to `180%` and the penalty to `15%`).
2. `governor.propose(...)` creates the proposal and returns its ID.
3. `vm.roll(block.number + governor.votingDelay() + 1)` — advances
   **blocks**, not time, because `Governor`'s voting delay is measured
   in blocks; using `vm.warp` here would do nothing to satisfy it.
4. `governor.castVote(proposalId, 1)` — `1` is the numeric code for
   "For" in OpenZeppelin's `Governor` (`0` = Against, `1` = For, `2` =
   Abstain); cast as `voter`, whose earlier self-delegation is what
   makes this vote actually count.
5. `vm.roll(... + governor.votingPeriod() + 1)` advances past the
   voting window, letting the proposal resolve.
6. `governor.state(proposalId)` is checked against
   `IGovernor.ProposalState.Succeeded` — confirming the vote passed
   *before* trying to queue it, so a failure at the next step can't be
   confused with a voting problem.
7. `governor.queue(...)` moves the approved proposal into the Timelock;
   state is checked again, now `Queued`.
8. `vm.warp(block.timestamp + MIN_DELAY + 1)` — this time genuinely
   **time**, not blocks, because the Timelock's own delay is
   time-based, independent of the Governor's block-based voting
   periods — two different kinds of delay, advanced with two different
   cheatcodes.
9. `governor.execute(...)` actually performs the call into `Vault`.
10. `vault.minCollateralRatioBps()` and `vault.liquidationPenaltyBps()`
    are checked directly against the proposed values — the final proof
    the whole chain genuinely reached the target contract.

### `test_RevertWhen_ExecutingBeforeTimelockDelayElapses`
**Verifies:** even a proposal that's been fully voted through and
successfully queued still can't execute early.
**Why this test exists:** without this test, nothing would prove the
Timelock's delay is a *real* enforced wait, rather than a value that's
simply stored and never actually checked at execution time — the
single most important safety property a Timelock provides.
**Data flow:** repeats every step of the full cycle above through
`queue`, then — the one deliberate omission — skips the `vm.warp` step
entirely and attempts `execute` immediately; `vm.expectRevert()`
confirms it fails.

### `test_RevertWhen_DirectCallBypassingGovernance`
**Verifies:** calling `vault.updateRiskParams` directly — completely
outside the Governor/Timelock system — fails.
**Why this test exists:** this is the test that gives the *other* two
tests their real meaning. Proving the governance cycle works is only
meaningful if it's also proven to be the *only* way in — otherwise
"governance changed the parameter" would say nothing about security,
only that governance is *one possible* way to do it. This test, plus
the earlier `renounceRole` in `setUp()`, together close that gap.
**Data flow:** the test contract itself — which holds no role on
`Vault` at all — calls `vault.updateRiskParams(99_000, 9_000)` directly,
with no proposal, no vote, no Timelock involved whatsoever; it reverts,
confirming `ADMIN_ROLE` genuinely belongs only to `cdpTimelock`, exactly
as `setUp()` configured it.

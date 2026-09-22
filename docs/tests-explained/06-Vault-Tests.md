# 06 — `test/Vault.t.sol` Explained

**Read `00-Introduction.md` and `10-Mock-TestCollateralToken.md` first.**

## Purpose of this file

Tests the CDP (collateralized debt position) module — deposit
collateral, mint stablecoin against it, repay debt, withdraw, and
liquidation — entirely separate from the insurance-claims side of this
project. This is the first file in this set involving three real
contracts working together (`Vault`, `StableCoin`, `PriceOracle`), not
one contract plus a mock.

## `setUp()` — what it builds, and why every line is there

```solidity
function setUp() public {
    collateral = new TestCollateralToken();

    // deploy priceOracle, grant it PRICE_SETTER_ROLE to timelock
    // deploy vault, pointed at collateral + priceOracle

    stableCoin = new StableCoin();
    stableCoin.setVault(address(vault));
    vm.prank(timelock);
    vault.setStableCoin(address(stableCoin));

    require(collateral.transfer(alice, 100 ether), "transfer failed");
    vm.prank(alice);
    collateral.approve(address(vault), type(uint256).max);
}
```

- **`stableCoin.setVault(address(vault))` immediately followed by
  `vault.setStableCoin(address(stableCoin))`** — this pair is worth
  slowing down on, because it's a **circular wiring problem**, and the
  order matters. `StableCoin` needs to know which `Vault` is allowed to
  call its privileged `mint`/`burn`; `Vault` needs to know which
  `StableCoin` it's allowed to mint. Neither contract can be told about
  the other *during construction*, because neither address exists yet
  until *after* the other one is deployed. Both lines have to happen
  after both contracts already exist, as two separate follow-up calls
  — this is exactly the kind of "chicken and egg" deployment step a
  real production deployment script also has to handle, and `setUp()`
  is doing it the same way a real deployment would.
- **`stableCoin.setVault(...)` has no `vm.prank` before it** — this is
  deliberate, not a missing line. `StableCoin` isn't
  `AccessControlUpgradeable`-based; its `setVault` function checks
  against whoever deployed it (the test contract itself, since nothing
  overrode `msg.sender` for the `new StableCoin()` call), which is
  exactly who's calling `setVault` here too — no prank needed because
  the caller is already correct by default.
- **`collateral.approve(address(vault), type(uint256).max)` for
  `alice`** — without this, *every single test* below that has Alice
  deposit collateral would fail on the very first line, on an
  insufficient allowance, before any of the actual logic being tested
  ever ran. `type(uint256).max` (an effectively unlimited approval) is
  used here specifically so no individual test needs to think about
  approval amounts at all — it's not a value with any further meaning.

## Every test, explained

### `test_DepositAndMint_WithinRatio_Succeeds`
**Verifies:** depositing collateral and minting a healthy amount of
`dUSD` against it works, and the resulting ratio is calculated
correctly.
**Why this test exists:** the basic happy path — every other test in
this file assumes deposit-then-mint works correctly as a baseline.
**Data flow:** `vm.startPrank(alice)` (not single-shot `vm.prank`,
because Alice makes *two* calls in a row here — depositing, then
minting — and both need to appear as her); deposits `10 ether` of
collateral (worth `$20,000` at the `$2,000`/unit price set in
`setUp()`); mints `10_000 ether` of `dUSD` against it, landing at a
`200%` ratio; checks both her `dUSD` balance and
`vault.currentCollateralRatioBps(alice)` directly, rather than just
trusting the mint succeeded.

### `test_RevertWhen_MintExceedsMinRatio`
**Verifies:** minting past the minimum collateralization ratio
(`150%`, set in `setUp()`) is rejected.
**Why this test exists:** this ratio check is the entire safety
mechanism behind the CDP module — without a test proving it's actually
enforced, there'd be no automated evidence that a user (or a bug)
couldn't mint far more debt than their collateral could ever cover.
**Data flow:** deposits only `1 ether` (`$2,000`), then attempts to
mint `1_500 ether` — which would land at `133%`, below the `150%`
floor — and confirms it reverts with the specific
`BelowMinCollateralRatio` error.

### `test_RevertWhen_WithdrawWouldBreachMinRatio`
**Verifies:** the same ratio check also applies to *withdrawing*
collateral, not just minting more debt — withdrawing collateral out
from under existing debt could breach the ratio just as easily as
minting too much would.
**Why this test exists:** without a *separate* test for withdrawal,
a bug that only checked the ratio inside `mintStableCoin` (but forgot
to check it inside `withdrawCollateral` too) would pass every other
test in this file while still leaving a real way to under-collateralize
a position.
**Data flow:** deposits and mints to a healthy `200%` ratio first, then
attempts to withdraw `4 ether` of the `10 ether` collateral — which
would drop the ratio to roughly `133%` — and confirms that specific
withdrawal reverts.

### `test_RepayDebt_ReducesDebtAndBurnsToken`
**Verifies:** repaying debt actually reduces the stored debt amount
*and* burns the corresponding `dUSD` out of circulation, rather than
just relabeling something.
**Why this test exists:** proves repayment is a genuine, two-sided
accounting operation — position debt goes down, and the token
supply/balance goes down by the same amount — not just an internal
bookkeeping change with no real token movement behind it.
**Data flow:** deposits, mints `5_000 ether`, then repays `2_000 ether`;
checks the position's stored `debtAmount` directly via
`vault.positions(alice)` (a public mapping, readable as a tuple), and
separately checks `stableCoin.balanceOf(alice)` — two independent
confirmations of the same underlying change, from two different
angles.

### `test_Liquidation_OnPriceDrop`
**Verifies:** the complete liquidation flow — a price crash makes a
position liquidatable, and a liquidator can then seize collateral in
exchange for covering the debt.
**Why this test exists:** this is the single most complex test in the
whole project, and deliberately so — liquidation is the mechanism that
protects the entire system's solvency if collateral value falls, and
it needs to be proven working end-to-end, not just in isolated pieces.
**Why the liquidator gets its `dUSD` from a *second, separate* CDP
position, not simply handed a balance:** the comment in the source
explains this directly — using `Vault`'s privileged mint to hand the
liquidator funds would test a shortcut, not the real-world path. A real
liquidator has to actually acquire `dUSD` the same way anyone else
does. Routing the test through a second borrower (`funder`) mirrors
that reality, and incidentally re-uses the exact deposit/mint mechanics
`test_DepositAndMint_WithinRatio_Succeeds` already proved correct,
rather than inventing a special funding shortcut just for this one
test.
**Data flow:** Alice deposits and mints to a `200%` ratio;
`vault.isLiquidatable(alice)` confirms `false` — she starts healthy;
`priceOracle.setPrice(1_000 ether)` (called as `timelock`, who holds
`PRICE_SETTER_ROLE`) crashes the price to half its original value,
dropping Alice's ratio to roughly `100%`; `isLiquidatable` is checked
again, now `true`; a second address (`funder`) opens its own CDP
position purely to generate spendable `dUSD`, then transfers
`5_000 ether` of it to `liquidatorEoa`; finally `liquidatorEoa` calls
`vault.liquidate(alice, 5_000 ether)`, and the test checks three
separate outcomes: `seized > 0` (the liquidator actually received
collateral), Alice's remaining debt dropped by exactly the repaid
amount, and the liquidator's collateral balance matches the seized
amount exactly.

### `test_RevertWhen_LiquidatingHealthyPosition`
**Verifies:** a position that's still comfortably above the minimum
ratio cannot be liquidated.
**Why this test exists:** without this test, nothing would prove
liquidation actually *checks* health before acting — a bug that let
liquidation succeed unconditionally would only be caught here, since
the previous test only ever liquidates a position that's genuinely
unhealthy.
**Data flow:** mints at a `400%` ratio — deliberately very healthy —
then attempts liquidation anyway, confirming it reverts with
`PositionNotLiquidatable`.

### `test_RevertWhen_PausedBlocksDeposit`
**Verifies:** the pause mechanism reaches `depositCollateral` too.
**Why this test exists:** same reasoning as every other file's pause
test — proves the guard is wired into *this* specific entry point, not
assumed from it being wired into others.

### `test_RevertWhen_NonAdminUpdatesRiskParams`
**Verifies:** an ordinary user (`alice`, holding no special role at
all) cannot directly change the Vault's own risk parameters.
**Why this test exists:** `Vault`'s risk parameters are meant to be
changed only through CDP governance (see `07-Governance-Tests.md`) —
this test proves the *direct* path is closed, which is exactly what
makes governance the *only* path, not merely the intended one.

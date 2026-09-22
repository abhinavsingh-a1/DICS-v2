# 10 — `contracts/mocks/TestCollateralToken.sol` Explained

**Read `00-Introduction.md` first** if you haven't.

## The full file (13 lines)

```solidity
contract TestCollateralToken is ERC20 {
    constructor() ERC20("Test Wrapped ETH (demo)", "tWETH") {
        _mint(msg.sender, 1_000_000 ether);
    }
}
```

## Purpose of this file

Structurally identical to `TestPayoutToken.sol` (see that document for
the full line-by-line reasoning — it isn't repeated here) — the only
real difference is *what it stands in for*. Where `TestPayoutToken`
represents "some ERC-20 used as claim/premium currency,"
`TestCollateralToken` specifically represents the collateral asset a
`Vault` position is opened with — in a real deployment, something like
wrapped ETH. Its name, `"Test Wrapped ETH (demo)"`, says so directly.

## Why this needs to be a *separate* contract from `TestPayoutToken`, rather than reusing it

It would be technically possible to use one generic mock token for
every purpose across every test file. This project deliberately
doesn't, for a reason worth understanding: `Vault.t.sol` and
`Governance.t.sol` need collateral and payout/premium tokens to be
**genuinely different tokens**, because `Vault`'s own logic treats them
differently — `collateralToken` is what gets deposited and seized on
liquidation; `StableCoin` is what gets minted and burned against it. If
both were secretly the same underlying contract, a bug that confused
the two inside `Vault.sol` itself could go completely undetected — the
test would still pass by accident, because both roles happened to be
filled by the identical asset. Keeping them as two distinct contracts,
even though they're nearly line-for-line the same code, means a test
only passes if `Vault` genuinely tracks and moves the *correct* token
for the *correct* purpose at every step.

## Why the specific number `1_000_000 ether`

Distinct from `TestPayoutToken`'s `10_000_000 ether` only by
coincidence of what each token needs to cover in the tests that use it
— `Vault.t.sol`'s largest single deposit across all its tests is `50 ether`
(in `test_Liquidation_OnPriceDrop`'s second borrower position), so
`1_000_000 ether` is comfortably larger than anything any current test
needs, with no further significance to the exact figure. If a future
test needed to deposit more collateral than this supply allows, the fix
is simply raising this number — not a sign of a deeper problem.

## Data flow

Identical mechanism to `TestPayoutToken.sol`'s constructor — see that
document's "Data flow" section for the full step-by-step explanation.
The only difference is the name/symbol string and the minted amount.

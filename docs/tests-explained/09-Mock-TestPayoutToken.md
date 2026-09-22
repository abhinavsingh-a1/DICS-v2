# 09 — `contracts/mocks/TestPayoutToken.sol` Explained

**Read `00-Introduction.md` first** if you haven't.

## The full file (13 lines)

```solidity
contract TestPayoutToken is ERC20 {
    constructor() ERC20("Test Payout Token", "TPT") {
        _mint(msg.sender, 10_000_000 ether);
    }
}
```

## Purpose of this file

A plain, ordinary ERC-20 token, used everywhere tests need *some* token
to move around as claim payouts or premium payments, without caring
which specific token it is. Nearly every test file that touches
`ClaimRegistry` or `InsurancePolicy` — `ClaimRegistryUpgrade.t.sol`
(as its own inline `TestToken`, the same idea written separately before
this shared version existed), `Premium.t.sol`, `PolicyCatalog.t.sol` —
uses this or something just like it.

## Why this contract exists at all — what would be left out without it

The real payout/premium currency in this project's actual deployment
is `StableCoin.sol` (`dUSD`) — but `StableCoin` can *only* be minted by
`Vault`, which means acquiring `dUSD` requires depositing collateral
and minting against it first. If every test involving a claim payout
had to do that first, tests for `ClaimRegistry`'s payout logic would
also, incidentally, be testing `Vault`'s CDP logic — two unrelated
systems tangled together for no reason. `TestPayoutToken` breaks that
dependency: it mints a large balance straight to whoever deploys it, no
collateral or CDP position required, so a test can fund a `ClaimRegistry`
or pay a premium in a single line and move on to what it's actually
testing.

## Why each line is kept

- **`is ERC20`** — inheriting OpenZeppelin's real `ERC20` means this
  token automatically has correct, audited `transfer`, `approve`,
  `transferFrom`, and balance-tracking behavior. Without this
  inheritance, every test using this token would actually be testing
  a hand-written, unaudited token implementation instead of the real
  contracts under test — exactly the kind of hidden extra variable a
  good test avoids.
- **`ERC20("Test Payout Token", "TPT")`** — the name and symbol are
  cosmetic *for tests* (nothing in this project's tests ever checks
  them), but they're not pointless: the name plainly signals to a
  human reading the file that this is a test-only artifact, not a
  contract meant for any real deployment. This is the same reasoning
  behind `StableCoin`'s own name including "(demo)."
- **`_mint(msg.sender, 10_000_000 ether)`** — this is the entire reason
  the contract exists. `msg.sender` here is whoever *deploys* this
  contract — in every test file, that's the test contract itself
  (Foundry test contracts are the ones calling `new TestPayoutToken()`).
  `10_000_000 ether` is simply "a large, round number, comfortably
  larger than any amount a test needs to move" — not a value with any
  further significance. Without this line, the token would compile and
  deploy fine, but nobody would hold any of it, and every test trying
  to fund an account (`require(payoutToken.transfer(address(registry), 100_000 ether), ...)`)
  would immediately fail — there'd be nothing to transfer.

## Data flow — there's only one, at construction

1. **Input:** none — the constructor takes no parameters.
2. `ERC20("Test Payout Token", "TPT")` runs first (Solidity always runs
   a parent constructor before the child's own body), setting the
   token's name and symbol in `ERC20`'s own storage.
3. `_mint(msg.sender, 10_000_000 ether)` runs: this is `ERC20`'s own
   internal minting function (inherited, not overridden), which
   increases `msg.sender`'s balance by `10_000_000 ether` and increases
   `totalSupply` by the same amount, emitting the standard EIP-20
   `Transfer(address(0), msg.sender, 10_000_000 ether)` event (a mint is
   conventionally represented as a transfer *from* the zero address).
4. **Output:** nothing — a constructor never returns a value; the
   *effect* is that the deploying test contract now holds
   `10_000_000` tokens.

Every other function this contract has (`transfer`, `approve`,
`transferFrom`, `balanceOf`, ...) comes entirely from `ERC20` — nothing
in `TestPayoutToken` itself adds or changes any of them.

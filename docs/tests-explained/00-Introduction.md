# 00 — Introduction to Testing and Mocks (Read This First)

This document explains the *concepts* every other document in this set
assumes you already know. If you've never worked with automated tests
or mocks before, start here — everything after this document skips
these explanations to avoid repeating them 57 times.

---

## What is an automated test, actually?

A test is a small program that runs your real code and checks whether
the result matches what you expected. Instead of a human clicking
through an app to check "does buying a policy work?", a test does it
in code, in milliseconds, and can be re-run thousands of times for
free, forever, every time anyone changes anything.

In this project, tests live in files ending in `.t.sol`, in the `test/`
folder. Each one is a Solidity **contract** — an actual smart contract,
just like `Vault.sol` or `InsurancePolicy.sol` — except its only job is
to deploy the real contracts, poke them, and check the results. Test
contracts are never deployed to a real blockchain; they only exist
inside Foundry's local, throwaway simulated blockchain, which resets
completely every time you run `forge test`.

## What is Foundry, and what is `forge test`?

Foundry is the toolchain this project uses to compile and test Solidity
code. `forge test` does three things: compiles every `.sol` file,
deploys every test contract onto a fresh in-memory blockchain, then
runs every function whose name starts with `test` and reports which
ones passed or failed. Nothing here touches a real network or costs
real money — it's a sandbox that exists only for the seconds the test
takes to run.

## The anatomy of a test file

Every test file in this project follows the same shape:

```solidity
contract SomeTest is Test {
    // 1. State variables — the contracts and addresses this test needs
    SomeContract public thing;
    address public alice = makeAddr("alice");

    // 2. setUp() — runs fresh before EVERY test function, automatically
    function setUp() public {
        thing = new SomeContract();
        // ... get the contract into a known, ready-to-test state
    }

    // 3. Test functions — each one checks ONE specific behavior
    function test_SomethingWorks() public {
        // arrange (if needed), act, assert
    }
}
```

**Why `setUp()` runs before every single test function, not once for
the whole file:** each test needs to start from an identical, clean
state, or tests could accidentally affect each other — one test
changing a balance would corrupt the next test's assumptions. Foundry
runs `setUp()` fresh for every `test_` function automatically; you
never call it yourself.

**Why test names follow `test_DoesX` and `test_RevertWhen_Y` patterns:**
this is a convention, not a requirement — Foundry only cares that the
name starts with `test`. But `test_RevertWhen_Y` immediately tells a
reader what failure case this test proves, without opening the
function body. Consistent naming is what makes 57 test names scannable
at a glance.

## Foundry cheatcodes — the special tools tests use that real contracts can't

Real smart contracts can never fake who's calling them, jump forward
in time, or force a specific address to exist. Tests need all three, so
Foundry provides "cheatcodes" — special functions, all accessed through
a built-in object called `vm`, that only work inside a test environment
and would do nothing (or not compile) in a real deployed contract.

| Cheatcode | What it does | Why tests need it |
|---|---|---|
| `vm.prank(address)` | Makes the **next single call** appear to come from `address`, instead of the test contract itself | Every role check in this project (`onlyRole(UNDERWRITER_ROLE)`, etc.) looks at `msg.sender` — without `prank`, every call would appear to come from the test contract, and every permission check would fail |
| `vm.startPrank(address)` / `vm.stopPrank()` | Same as `prank`, but affects **every** call until `stopPrank()` | Useful when one actor needs to make several calls in a row — see the box below on the difference that actually matters |
| `vm.expectRevert(...)` | Tells Foundry "the very next call is supposed to fail — if it *doesn't* fail, that's the test failure" | This is how you prove a guard works — e.g. that a non-admin really can't call an admin function |
| `vm.warp(timestamp)` | Jumps the simulated blockchain's clock forward | Needed to test anything involving time — premium expiry, grace periods, Timelock delays |
| `vm.roll(blockNumber)` | Jumps the simulated block number forward | `DICSGovernor`'s voting delay/period are measured in blocks, not time, so tests need to advance blocks specifically |
| `makeAddr("label")` | Deterministically generates a fresh address from a text label | Gives every test human-readable, collision-free addresses without needing real private keys |
| `vm.addr(privateKey)` | Derives the address belonging to a specific private key | Needed anywhere a test must actually *sign* something (see `OracleAdapter.t.sol`) — `makeAddr` alone can't do this, because it doesn't give you a matching private key to sign with |
| `vm.sign(key, digest)` | Produces a real ECDSA signature over a hash, using a given private key | Used to construct real, valid EIP-712 signatures in tests, the same way an off-chain oracle service would |
| `vm.label(address, "name")` | Purely cosmetic — makes trace output show a name instead of a raw hex address | Makes failure output readable; changes nothing about test behavior |

<div style="border-left:3px solid #2c3e50;padding-left:12px;margin:16px 0;">

**The single-shot `prank` gotcha, worth understanding once and for all.**
`vm.prank(x)` overrides the caller for the *next call only* — and
"next call" means the next call Solidity actually makes, which
includes calls hidden inside an argument expression. This line:

```solidity
vm.prank(timelock);
policy.grantRole(policy.POLICY_MANAGER_ROLE(), policyManager);
```

looks like one statement, but `policy.POLICY_MANAGER_ROLE()` is itself
a call, evaluated *before* `grantRole` runs — so it consumes the prank,
and `grantRole` ends up executing as the test contract, not `timelock`.
This exact bug was found and fixed across 10 places in this project's
own test suite during development, traced by reading a `-vvvv` trace
and noticing the revert named the wrong caller. The fix is always the
same: read the value into a local variable *first*.

```solidity
bytes32 role = policy.POLICY_MANAGER_ROLE(); // read first — no active prank yet
vm.prank(timelock);
policy.grantRole(role, policyManager);        // prank is "spent" on THIS call
```

`vm.startPrank`/`vm.stopPrank` don't have this problem — they hold the
override for every call in between, so an in-between read doesn't
consume anything.
</div>

## What are `assert` functions, and why so many kinds?

Every test ends by checking that something is true. `assertEq(a, b)`
fails the test if `a != b`; `assertTrue(x)`/`assertFalse(x)` check a
boolean directly; `assertGt(a, b)` checks `a > b`. These exist as
separate functions (rather than one generic "assert this") because a
failure message like `"expected 500, got 300"` is only possible if
Foundry knows it was comparing two values for equality — a generic
assert could only ever say "failed."

## What is a mock, and why does this project have any?

A **mock** is a small, simplified stand-in for a real dependency —
built specifically to make testing possible or practical, never
intended to be used anywhere except inside tests.

This project needs mocks for two different reasons, and it's worth
telling them apart:

**1. Standing in for something that doesn't exist yet, or is genuinely
external.** `OracleAdapter` is designed to call into whatever contract
implements `IClaimRegistryOracleSink` — in production, that's the real
`ClaimRegistry`. But to test `OracleAdapter` in isolation, wiring up a
*complete*, fully-configured `ClaimRegistry` (which itself needs a
working `InsurancePolicy`, roles granted, a policy registered...) would
mean every `OracleAdapter` test also depends on all of `ClaimRegistry`
working correctly. `MockClaimRegistrySink` sidesteps this: it's a
20-line contract that just *records* what was called and with what
arguments, so `OracleAdapter.t.sol` can test `OracleAdapter`'s own logic
— signature verification, replay protection — without any of that
logic being entangled with `ClaimRegistry`'s.

**2. Providing a plain, predictable version of something whose real
version has business logic that would get in the way.** `TestPayoutToken`
and `TestCollateralToken` are both just plain ERC-20 tokens with a
constructor that mints a large supply to whoever deploys them. Real
tokens in this ecosystem — `StableCoin` — have *privileged* minting
(only `Vault` can call `mint`). If tests had to acquire tokens the
"real" way every single time, every single test would first need to
stand up a whole separate `Vault` position just to get spending money
— for tests that have nothing to do with the CDP module at all. The
mock token just hands out a large balance at construction, so a test
can move straight to what it's actually trying to verify.

**The rule this project follows, worth internalizing:** a mock replaces
*one specific dependency* so the test can isolate *one specific piece
of logic*. A test using a mock is deliberately not proving the mocked
part works — it's proving everything *else* works, assuming the mocked
part behaves the documented way. That's why `Premium.t.sol` and
`PolicyCatalog.t.sol` deliberately do **not** use `MockPolicyRegistry` —
they exist specifically to prove `InsurancePolicy` and `ClaimRegistry`
work correctly *together*, so mocking either one away would defeat the
entire point of those two files.

## The index — one document per file

| Document | Covers |
|---|---|
| `01-InsurancePolicy-Tests.md` | `test/InsurancePolicy.t.sol` — 11 tests |
| `02-OracleAdapter-Tests.md` | `test/OracleAdapter.t.sol` — 7 tests |
| `03-ClaimRegistryUpgrade-Tests.md` | `test/ClaimRegistryUpgrade.t.sol` — 13 tests, plus its 3 inline helper contracts |
| `04-Premium-Tests.md` | `test/Premium.t.sol` — 8 tests |
| `05-PolicyCatalog-Tests.md` | `test/PolicyCatalog.t.sol` — 7 tests |
| `06-Vault-Tests.md` | `test/Vault.t.sol` — 8 tests |
| `07-Governance-Tests.md` | `test/Governance.t.sol` — 3 tests |
| `08-Mock-MockClaimRegistrySink.md` | `contracts/mocks/MockClaimRegistrySink.sol` |
| `09-Mock-TestPayoutToken.md` | `contracts/mocks/TestPayoutToken.sol` |
| `10-Mock-TestCollateralToken.md` | `contracts/mocks/TestCollateralToken.sol` |

Read them in this order the first time — `03` in particular introduces
`MockPolicyRegistry`, a pattern that `04` and `05` deliberately contrast
themselves against.

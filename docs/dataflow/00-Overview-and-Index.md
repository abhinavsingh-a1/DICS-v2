# DICS v2 Data Flow — Overview & How to Read This Set

## Why 15 documents instead of 48

The literal request was 8 scenarios × 6 steps = 48 documents. Building
that literally would mean re-explaining the same proxy mechanics, the
same EIP-712 signing process, and the same payout logic 8 times over —
only the dollar amounts and which branch gets taken actually differ
between scenarios. That's not more understandable, it's the same
explanation with more scrolling.

Instead: **6 Step documents** hold every mechanical detail, written
once, in full depth. **8 Scenario documents** are short and concrete —
each one states exactly what's different for that case (the numbers,
the branch taken, what reverts and why) and points back to the relevant
Step document rather than repeating it. Read a Scenario document first
for the concrete story; follow its references into the Step documents
for the underlying mechanics.

## The address book — used identically across every document in this set

Fixed, synthetic addresses so every document traces the *same* values
through the *same* places, making it possible to cross-reference between
documents without re-deriving anything:

| Name | Address | Role |
|---|---|---|
| Alice | `0x1111111111111111111111111111111111AAAA` | Policyholder (primary example) |
| Bob | `0x1212121212121212121212121212121212BBBB` | Policyholder (used in multi-user scenarios) |
| Attacker | `0x9999999999999999999999999999999999CCCC` | Unauthorized actor (Scenario 8) |
| `InsurancePolicy` proxy | `0x2222222222222222222222222222222222BBBB` | Policy catalog + premium collection |
| `ClaimRegistry` proxy | `0x3333333333333333333333333333333333CCCC` | Claim lifecycle + payout |
| `OracleAdapter` proxy | `0x4444444444444444444444444444444444DDDD` | Signature verification |
| `StableCoin` (dUSD) | `0x5555555555555555555555555555555555EEEE` | Premium + payout currency |
| Premium Treasury | `0x6666666666666666666666666666666666FFFF` | Receives premium payments |
| Underwriter Safe | `0x7777777777777777777777777777777777AAAA` | Holds `UNDERWRITER_ROLE` |
| Oracle signer key | `0x8888888888888888888888888888888888BBBB` | Holds `ORACLE_SIGNER_ROLE` on `OracleAdapter` |

## The policy catalog — used identically across every document

Three self-service plans, matching the three prices given in the
request:

| `templateId` | Plan | `coverageAmount` | `premiumAmountPerPeriod` | `periodSeconds` | `termSeconds` |
|---|---|---|---|---|---|
| `1` | Basic | `2,000 ether` (2,000 dUSD) | `11 ether` ($11) | `30 days` | `365 days` |
| `2` | Standard | `5,000 ether` (5,000 dUSD) | `22 ether` ($22) | `30 days` | `365 days` |
| `3` | Premium | `10,000 ether` (10,000 dUSD) | `33 ether` ($33) | `30 days` | `365 days` |

All amounts are 18-decimal fixed point (`ether` in Solidity = `10^18`),
matching every token in this project. `$33` = `33 ether` =
`33000000000000000000` in raw `uint256` wei-equivalent units — written
out once here since every later document just uses `33 ether` for
readability.

## Index

**Step documents** (mechanics, read once):
1. `Step-1-Wallet-Auth.md` — connecting a wallet, EIP-191 login
2. `Step-2-Buy-Policy-Premium-Payment.md` — `subscribeToPolicy`, EIP-20
3. `Step-3-File-Claim.md` — `submitClaim`, the validity checks, EIP-1967/1822 proxy mechanics
4. `Step-4-Oracle-Verification.md` — EIP-712 signing and on-chain verification
5. `Step-5-Payout.md` — `payoutClaim`, the token transfer
6. `Step-6-Whats-Not-Touched.md` — `Vault`, `PriceOracle`, `DICSGovernanceToken`, `DICSGovernor`, `ClaimGasPaymaster`, EIP-2612, EIP-4337 — where they fit and where they don't

**Scenario documents** (concrete value-traces):
1. `Scenario-1-Basic-Approved.md` — $11 plan, small claim, approved
2. `Scenario-2-Standard-Approved.md` — $22 plan, mid claim, approved
3. `Scenario-3-Premium-Approved-221.md` — $33 plan, $221 claim, approved (the request's own example)
4. `Scenario-4-Premium-Rejected-By-Oracle.md` — $33 plan, claim rejected
5. `Scenario-5-Premium-Lapsed-Blocked.md` — unpaid premium blocks a claim entirely
6. `Scenario-6-Coverage-Exceeded-Blocked.md` — claim larger than coverage, blocked
7. `Scenario-7-Underwriter-Manual-Reject.md` — a human override instead of the oracle
8. `Scenario-8-Replay-Attack-Blocked.md` — a security attack attempt, and why it fails

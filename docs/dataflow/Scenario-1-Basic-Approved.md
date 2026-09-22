# Scenario 1 — Basic Plan ($11), Small Claim, Approved

**Full mechanics:** see `Step-1` through `Step-5`. This document only
states what's different for this specific case.

## Values used

| | Value |
|---|---|
| Policyholder | Alice, `0x1111...aaaa` |
| `templateId` | `1` (Basic) |
| `coverageAmount` | `2_000 ether` |
| Premium paid | `11 ether` ($11) |
| `policyId` assigned | `1` |
| Claim amount | `50 ether` ($50) |
| `claimId` assigned | `1` |
| Oracle decision | Approved (`50 <= 100,000` mock threshold) |
| Final payout | `50 ether` to Alice |

## Walkthrough (deltas from the Step documents only)

- **Step 2** (`subscribeToPolicy`): `templateId = 1` instead of `3`.
  `policyTemplates[1] = { coverageAmount: 2_000 ether, premiumAmountPerPeriod: 11 ether, ... }`.
  `_collectPremium` pulls `11 ether` from Alice to the Treasury, not `33`.
- **Step 3** (`submitClaim`): `amount = 50 ether`. Coverage check:
  `_consumedCoverage(1) + 50 ether (= 0 + 50 ether) <= 2_000 ether` — passes
  with very large headroom.
- **Step 4** (oracle): `declaredAmount = 50`, well under the mock
  threshold — approved, identical mechanics to the main trace.
- **Step 5** (`payoutClaim`): transfers `50 ether`, not `221 ether`.
  `ClaimRegistry` needs at least `50 ether` in dUSD on hand — a much
  smaller prerequisite funding requirement than the $221 trace.

## End state

```
StableCoin balance change for Alice:  -11 (premium) +50 (payout) = +39 ether net
claims[1].status:                     Paid
```

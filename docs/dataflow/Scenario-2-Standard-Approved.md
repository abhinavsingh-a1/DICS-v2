# Scenario 2 — Standard Plan ($22), Mid-Size Claim, Approved

**Full mechanics:** see `Step-1` through `Step-5`. Deltas only, below.

## Values used

| | Value |
|---|---|
| Policyholder | Bob, `0x1212...bbbb` |
| `templateId` | `2` (Standard) |
| `coverageAmount` | `5_000 ether` |
| Premium paid | `22 ether` ($22) |
| `policyId` assigned | `2` (Alice already took `1` in the main trace — IDs auto-increment across all subscribers, per `InsurancePolicy.nextPolicyId`) |
| Claim amount | `150 ether` ($150) |
| Oracle decision | Approved |
| Final payout | `150 ether` to Bob |

## Walkthrough (deltas)

- **Step 2**: caller is Bob, not Alice — `msg.sender = 0x1212...bbbb`
  throughout. `_policies[2].holder = 0x1212...bbbb`. This is the
  concrete case demonstrating `InsurancePolicy`'s auto-incrementing
  `nextPolicyId` across *different* subscribers, not just repeated
  purchases by one person — Bob gets `policyId = 2` regardless of
  whether Alice's `subscribeToPolicy` call happened moments before or
  long before his.
- **Step 3**: `holder != claimant` check compares against Bob's address,
  not Alice's — `_policies[2].holder (0x1212...bbbb) == msg.sender (0x1212...bbbb)`.
  Coverage check: `0 + 150 ether <= 5_000 ether` — passes.
- **Step 4/5**: mechanically identical, just Bob's address and `150 ether`
  in place of Alice's and `221 ether`.

## What this scenario demonstrates that Scenario 1 and 3 don't

Two independent policyholders' records never interfere with each
other — `_policies[1]` (Alice) and `_policies[2]` (Bob) are entirely
separate storage entries, and `ClaimRegistry`'s `_consumedCoverage`
check for Bob's policy only ever sums claims in *Bob's* `policyClaims[2]`
array, never Alice's.

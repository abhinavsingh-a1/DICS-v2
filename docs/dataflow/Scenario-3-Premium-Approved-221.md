# Scenario 3 — Premium Plan ($33), $221 Claim, Approved

**This is the exact scenario given in the original request** — and
because it's the one used to build the address book and all worked
values in `Step-1` through `Step-5`, this document is simply an index
into them rather than a repeat.

## Values used (identical to the Step documents throughout)

| | Value |
|---|---|
| Policyholder | Alice, `0x1111...aaaa` |
| `templateId` | `3` (Premium) |
| `coverageAmount` | `10_000 ether` |
| Premium paid | `33 ether` ($33) |
| `policyId` assigned | `1` |
| Claim amount | `221 ether` ($221) |
| `claimId` assigned | `1` |
| Oracle decision | Approved |
| Final payout | `221 ether` to Alice |

## Read in this order for the full trace

1. `Step-1-Wallet-Auth.md` — Alice connects and authenticates
2. `Step-2-Buy-Policy-Premium-Payment.md` — she buys the Premium plan, pays $33
3. `Step-3-File-Claim.md` — she files the $221 claim
4. `Step-4-Oracle-Verification.md` — it's verified and approved
5. `Step-5-Payout.md` — she receives $221
6. `Step-6-Whats-Not-Touched.md` — where the $221 in `ClaimRegistry`'s
   balance actually came from beforehand

## What makes this scenario the "baseline" the others deviate from

Every other scenario document in this set (1, 2, 4–8) explicitly states
its deltas *from this one* — different plan, different claim size,
different outcome, or a deliberately-triggered failure. If you've read
this scenario via the Step documents, every other scenario document
should be readable in under a minute each.

# 04 — `indexer` (Node.js): Run & Test Locally

## Communicates with (see `00-Communication-Map.md`)
- **Chain** (`InsurancePolicy`, `ClaimRegistry`) — read-only event scanning
- **`backend`** — sends its webhook to `POST /internal/onchain-events`
- **Postgres** — writes its own tables (`onchain_claims`, `onchain_events`,
  `onchain_policies`, `indexer_checkpoints`); this is also the table set
  `notification-service` and `underwriter-service` later read from
  directly (read-only, from their side — see `00`'s note on why that
  split is safe)

## Run locally

```bash
cd indexer
npm install
cp .env.example .env
# Fill in CLAIM_REGISTRY_ADDRESS, INSURANCE_POLICY_ADDRESS,
# BACKEND_WEBHOOK_API_KEY (must match backend/.env's
# INDEXER_WEBHOOK_API_KEY exactly), and a reachable DATABASE_URL
npm test
npm start
```

Needs a real Postgres reachable at `DATABASE_URL` even for local
running (not just tests) — `sql/schema.sql` needs to be applied first
if you're not using the docker-compose Postgres, which does this
automatically.

## Run the tests

```bash
npm test                  # pure unit tests — ABI decoding, status-name ordering
npm run test:integration  # real Anvil + real contracts + real Postgres
```

The integration test deploys real `InsurancePolicy` and `ClaimRegistry`
to a real Anvil chain via Foundry, submits/approves/pays out a real
claim, and asserts this indexer's actual `runOnePass()` correctly
reflects it in Postgres — not a simulation of the sync logic, the real
thing. Requires `anvil`, `forge`, and a reachable Postgres
(`TEST_DATABASE_URL`, defaults to
`postgres://postgres:postgres@localhost:5432/dics_indexer_test`).
Skips gracefully with a warning if any prerequisite is missing.

## Verified, not assumed: does the indexer actually see self-service policies?

Checked directly against `src/rpcClient.js` rather than guessed: its
event list only declares `PolicyRegistered`, not the newer
`PolicySubscribed`/`PremiumPaid` events added when the premium/catalog
module was built. That could have been a real gap — except
`InsurancePolicy.subscribeToPolicy` was deliberately written to emit
**both** `PolicyRegistered` and `PolicySubscribed` together (see
document `14`'s note on this), specifically for backward compatibility
with exactly this kind of older listener. So `onchain_policies` does
get populated correctly for self-service subscriptions too — confirmed
by reading the actual emitting code, not assumed from the indexer's ABI
list alone. What the indexer genuinely does NOT track: individual
`PremiumPaid` renewal events — not a problem for
`notification-service`, since it reads live premium status directly
from chain rather than from the indexer's event history (see document
`15`).

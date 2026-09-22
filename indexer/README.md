# DICS v2 — Indexer

Node.js (plain JavaScript, ethers v6) event indexer. Scans
`InsurancePolicy` and `ClaimRegistry` for events, persists them to its
own Postgres tables, and notifies the backend of claim state changes.

This also resolves an inconsistency flagged earlier in the project:
previous chat-only drafts of this indexer used ethers v5 syntax while
everything else (oracle-service, frontend hooks) used v6 — this
implementation is v6 throughout, matching the rest of the project.

## Setup

```bash
cd indexer
npm install
cp .env.example .env
# Fill in CLAIM_REGISTRY_ADDRESS, INSURANCE_POLICY_ADDRESS after deploying
npm test                    # unit tests — no external tooling required
npm start
```

## Ownership boundary — read before touching the schema

This indexer owns its **own** tables (`onchain_claims`, `onchain_events`,
`onchain_policies`, `indexer_checkpoints` — see `sql/schema.sql`).
It does **not** write into the backend's SQLAlchemy-owned `claims` table
directly, even though both ultimately live in the same Postgres instance
in this project's docker-compose setup. Two services independently
migrating and writing the same table is a recipe for drift; instead:

- The indexer maintains its own accurate mirror of on-chain state.
- It notifies the backend of claim state changes via an HTTP webhook
  (`POST {BACKEND_URL}/internal/onchain-events`), correlated by
  `merkleRoot` — the value present in both the backend's off-chain claim
  record and the on-chain `submitClaim` call.
- The backend decides what to do with that notification to its own
  table, using its own schema and its own rules.

## Duplicate event / reorg handling

- **Duplicate events**: enforced by the `(tx_hash, log_index)` UNIQUE
  constraint on `onchain_events` — not application-level bookkeeping.
  Re-scanning an already-processed block range (e.g. after a restart) is
  safe; the insert is a no-op and the handler skips its state-mutating
  side effects.
- **Reorgs**: mitigated shallowly via `REORG_SAFETY_BLOCKS` (default 2)
  — the indexer never scans right up to the chain head, holding back a
  small margin to reduce the chance of indexing a block that gets
  reorged away moments later. **This does not handle deep reorgs.** A
  reorg deeper than the safety margin would leave stale data in
  `onchain_claims`/`onchain_events` with no automatic correction — see
  "still open" below.

## Testing

- `npm test` — pure unit tests (ABI decoding, status-name ordering).
  No external tooling required.
- `npm run test:integration` — deploys real `InsurancePolicy` +
  `ClaimRegistry` to a real Anvil chain via Foundry, submits/approves/
  pays out a real claim, and asserts this indexer's actual `runOnePass()`
  correctly reflects it in Postgres. Requires `anvil`, `forge`, and a
  reachable Postgres (`TEST_DATABASE_URL`, defaults to
  `postgres://postgres:postgres@localhost:5432/dics_indexer_test`).
  Skips gracefully with a warning if any prerequisite is missing.

## What's still open

- **Deep reorg recovery is not implemented** — only the shallow
  `REORG_SAFETY_BLOCKS` mitigation above. A real reorg handler would need
  to detect a block hash mismatch against what was previously indexed
  and roll back/reprocess affected events.
- **No dead-letter handling for failed backend webhook calls** — a
  failed notification is logged and the indexer moves on; the backend's
  record just stays stale until some future reconciliation pass, which
  isn't built yet either.
- **No true reconciliation job** comparing this indexer's `onchain_claims`
  against the backend's `claims` table end-to-end — the webhook is a
  push-based sync, not a periodic verify-and-repair pass. Given both
  tables live in the same Postgres instance in this project's setup, a
  reconciliation script could join across them directly; that's a
  reasonable next piece, not built here.
- **`BACKEND_URL`/`BACKEND_WEBHOOK_API_KEY` matching the backend's own
  expectations** depends on a `POST /internal/onchain-events` endpoint
  existing on the backend side, protected the same way oracle-service
  protects `/verify` — see the backend's own changes for this addition.

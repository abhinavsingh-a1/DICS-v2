# DICS v2 — Backend

FastAPI backend: wallet-signature authentication, claim CRUD, and the
piece that was missing until now — an actual, real HTTP call into the
oracle service, matching the contract that service's own README
documented.

## Setup

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # .venv\Scripts\Activate.ps1 on Windows
pip install -r requirements.txt
cp .env.example .env
# Fill in SECRET_KEY and ORACLE_SERVICE_API_KEY
# (ORACLE_SERVICE_API_KEY must match oracle-service/.env exactly)
uvicorn app.main:app --reload
```

Runs against SQLite by default if `DATABASE_URL` isn't overridden to
Postgres — fine for a quick local check; use the docker-compose Postgres
for anything beyond that.

## Testing

```bash
pytest -v
```

No external services required — `tests/conftest.py` provides an isolated
in-memory SQLite database per test, and the oracle service HTTP calls are
mocked with `respx` (matching exactly what the oracle service's own
`/verify` endpoint expects and returns, so a change to that contract on
either side should break these tests loudly rather than silently
drifting apart). This deliberately mirrors the same unit-vs-integration
split used in oracle-service (`npm test` vs `npm run test:integration`):
what's here is the fast, no-external-tooling layer. A true integration
test — this backend running against a real oracle-service process
running against a real deployed OracleAdapter on a real Anvil chain — is
the natural next layer and isn't built yet (see "still open" below).

## The oracle-service integration, concretely

`POST /claims/{id}/trigger-verification`:

1. Looks up the claim.
2. Calls `oracle_client.request_verification()`, which sends
   `POST {ORACLE_SERVICE_URL}/verify` with header
   `X-Oracle-Service-Key: {ORACLE_SERVICE_API_KEY}` and body
   `{"claimId": ..., "declaredAmount": ...}` — exactly the contract
   documented in `oracle-service/README.md`.
3. Updates the claim's status to `approved` or `rejected` based on the
   response, and stores the returned `txHash`.
4. Supports an `Idempotency-Key` header so a client retry doesn't trigger
   the oracle service — and therefore the real on-chain transaction it
   submits — twice. Backed by a `idempotency_keys` table; see
   `app/idempotency.py`.

A `401` from the oracle service is surfaced as a distinct, clearly-worded
error (API key mismatch between the two services' `.env` files) rather
than being lumped in with "the claim was rejected" — those are very
different failure modes and shouldn't look the same in the logs.

## Deviations from earlier design — flagged explicitly

- **Wallet nonces are stored in Postgres/SQLite, not Redis**, despite
  earlier design docs specifying Redis with a TTL. This is a deliberate
  simplification for this slice: a `wallet_nonces` table with an
  `expires_at` column gives the same single-use, time-bound guarantee
  without making Redis a hard dependency for running the test suite.
  `REDIS_URL` remains in config for future use (sessions, rate limiting)
  but nothing currently depends on Redis being up. Revisit if nonce
  write volume ever makes this a bottleneck — unlikely at this project's
  scale.
- **Idempotency protection was originally scoped (in earlier planning) to
  a backend-orchestrated payout endpoint.** The architecture that
  actually got built has underwriters triggering payout directly via the
  Safe/contract, not through this API — so idempotency was applied here
  to `trigger-verification` instead, which is the actual backend-
  initiated, gas-costing action in the system as built.

## What's still open

- No integration test against a real running oracle-service process (only
  HTTP-contract-level mocking here) — see testing section above.
- No `POST /claims/{id}/documents` upload endpoint yet — `CreateClaimRequest`
  accepts document *metadata* (filename, hash, CID, proof) but this
  backend doesn't itself handle file upload / IPFS or S3 storage.
- No endpoint yet reflecting on-chain state back from the indexer — this
  backend's claim `status` field is currently only updated by
  `trigger-verification`'s own logic, not reconciled against actual
  `ClaimRegistry` events the way the indexer (designed earlier, not yet
  built as files) is supposed to do. That reconciliation gap is the
  same "off-chain vs. on-chain state can drift" problem flagged in the
  original architecture docs, and isn't resolved by this slice.
- CORS is wide open (`allow_origins=["*"]`) — fine for local dev,
  tighten before anything beyond that.

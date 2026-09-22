# 09 — After `docker compose up`: Verifying Every Link Actually Works

Each check below maps to exactly one row in `00-Communication-Map.md`'s
table. Run them in this order — later checks assume earlier ones
already passed, since e.g. nothing downstream of the chain can work if
the chain link itself is broken.

## 1. Every service is actually running

```bash
docker compose ps
```

Every service should show `running` (or `healthy` for `postgres`). If
anything shows `restarting` or `exited`, check its logs before going
further:

```bash
docker compose logs backend        # substitute any service name
```

## 2. Each service that exposes an HTTP port responds

```bash
curl http://localhost:8000/health          # backend
curl http://localhost:4100/health          # oracle-service
curl http://localhost:8090/claims/pending  # underwriter-service (empty list is fine)
curl http://localhost:8080/health          # document-service
```

`indexer` and `notification-service` expose no HTTP port at all (see
document `08`'s table) — for these two, "is it working" means checking
logs instead:

```bash
docker compose logs -f indexer               # should show periodic "scanned block N" lines
docker compose logs -f notification-service  # should show periodic "checkOnce" activity
```

## 3. `frontend` ↔ Chain, and `frontend` ↔ `backend`

Open `http://localhost:5173`, connect a wallet pointed at the same
chain. Visit `/buy-policy` — if the catalog loads, `frontend → backend
→ Chain` (backend's own chain read) is confirmed working end-to-end in
one check, since that page's data only exists if the backend
successfully read `policyTemplates` from the real chain. Subscribing to
a plan and watching MetaMask prompt for two signatures (approve, then
subscribe — see document `13`) confirms `frontend → Chain` directly.

## 4. `backend` ↔ `oracle-service`

File a claim through the frontend, then trigger verification (either
through whatever UI path calls it, or directly):

```bash
curl -X POST http://localhost:8000/claims/1/trigger-verification \
  -H "Authorization: Bearer <a real JWT from logging in>" \
  -H "Idempotency-Key: test-key-1"
```

A `502`-shaped error mentioning "oracle service" specifically (rather
than a generic failure) confirms the backend at least attempted the
call and got a meaningful response back — see `backend/README.md`'s
note on how a `401` here is surfaced distinctly from other failures,
precisely so this exact check is diagnosable. A real `200` with
`approved`/`rejected` in the body confirms the full round trip,
including `oracle-service → Chain`.

## 5. `indexer` ↔ Chain, and `indexer` ↔ `backend`

After a claim has actually been submitted on-chain (step 3 above),
check the indexer picked it up:

```bash
docker compose exec postgres psql -U postgres -d dics_db \
  -c "SELECT onchain_claim_id, status FROM onchain_claims ORDER BY onchain_claim_id DESC LIMIT 5;"
```

A row here confirms `indexer → Chain` (it actually scanned and decoded
the event). Then check the backend's own record was updated to match:

```bash
curl http://localhost:8000/claims/1
```

If `onchain_claim_id`/`tx_hash` are populated (not `null`), that
confirms `indexer → backend`'s webhook actually landed — this is the
one link that's easy to mistake for broken when it's really just slow
(the indexer polls, it doesn't push instantly; see `frontend/README.md`'s
note on this same delay).

## 6. `notification-service` ↔ Postgres, and `notification-service` ↔ Chain

```bash
docker compose logs notification-service | grep "checkOnce"
```

A log line naming a real policy ID confirms it successfully queried
Postgres for the policy list. To confirm the chain-read half and the
webhook half together, the fastest check is deliberately letting a
policy's premium lapse (or using a short `WARNING_WINDOW_DAYS` for
testing) and pointing `WEBHOOK_URL` at a throwaway local receiver:

```bash
python3 -m http.server 9000
# then watch for an incoming POST with a policy_id/holder_address/premium_paid_until body
```

## 7. `underwriter-service` ↔ Postgres, and `underwriter-service` ↔ Chain

```bash
curl http://localhost:8090/claims/pending
```

A real claim listed here (matching what step 5's Postgres query showed)
confirms the Postgres-read half. Then:

```bash
curl -X POST http://localhost:8090/claims/1/approve
```

A `200` with a real `txHash` confirms the chain-write half. Confirm it
actually landed by re-running step 5's `onchain_claims` query a few
seconds later — the indexer should have picked up the resulting
`ClaimStatusChanged` event and updated `status` to `Approved`, which is
also, at the same time, a second confirmation that the indexer/chain
link from step 5 is still working.

## 8. `document-service` — confirming it works, while confirming it's isolated

```bash
curl -F "file=@/some/local/file.txt" http://localhost:8080/claims/1/documents
curl http://localhost:8080/claims/1/merkle-root
```

A real Merkle root back confirms the service itself works fully. There
is deliberately no step here checking whether this root shows up
anywhere else in the system — per document `00`, it currently doesn't;
confirming *that* isolation is itself the correct, honest check for
this one service, not a gap in this document.

## If something in this chain doesn't work

Work backwards from wherever the check actually failed, not forwards
from where you assumed the problem was — `docker compose logs
<service>` for the specific service that returned an error or an empty
result is almost always more informative than re-running the same curl
command again. Every failure mode named across documents `01`–`07`
(wrong API key, chain not reachable, wrong contract address, role not
granted) shows up as a specific, identifiable error in that service's
own logs, not a generic timeout.

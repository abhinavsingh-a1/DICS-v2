# 08 — Containerizing Every Service via `docker-compose`

All 7 non-Solidity services, plus Postgres and Redis, are wired into
the single root `docker-compose.yml` — each with its **own** Dockerfile
(so each can also be built and run completely independently, outside
compose, if you only want one service), and compose ties them together
with the right environment variables and startup order.

## What compose does NOT do

**It does not start the chain.** `besu-network/` (or a standalone
Anvil) has to be running and have the contracts already deployed
*before* bringing this stack up — every service's `.env` needs real
deployed contract addresses, not placeholders. This is the same "run
order" rule the root README has stated since the original build; it
hasn't changed with these three new services added.

## The full service list, and how each is reached

| Service | Build context | Exposed port | Depends on (compose-enforced) |
|---|---|---|---|
| `postgres` | (image) | `5432` | — |
| `redis` | (image) | `6379` | — |
| `backend` | `./backend` | `8000` | `postgres` (healthy), `oracle-service` (started) |
| `oracle-service` | `./oracle-service` | `4100` | — |
| `indexer` | `./indexer` | (none published) | `postgres` (healthy), `backend` (started) |
| `frontend` | `./frontend` | `5173` | `backend` (started) |
| `notification-service` | `./notification-service` | (none published) | `postgres` (healthy), `indexer` (started) |
| `underwriter-service` | `./underwriter-service` | `8090` | `postgres` (healthy), `indexer` (started) |
| `document-service` | `./document-service` | `8080` | — (isolated, see document `00`) |

**Why `notification-service` and `underwriter-service` depend on**
**`indexer`, not just `postgres`:** compose's `depends_on` with
`condition: service_healthy` only guarantees Postgres itself is
*accepting connections* — it says nothing about whether the specific
tables these two services query (`onchain_policies`, `onchain_claims`)
actually exist yet. Those tables are created by the indexer's own
`sql/schema.sql` at its startup. Depending on `indexer: condition:
service_started` doesn't guarantee the schema is fully applied either
(compose's "started" just means the container began running, not that
its own internal setup finished) — worth knowing as a real, current
limitation: on a completely fresh `docker-compose up`, there's a real
possibility `notification-service` or `underwriter-service` queries
before the indexer's schema exists, and fails its first query. Both
handle this as a logged error and simply try again on the next poll
interval / request rather than crashing — see documents `15`/`16` — but
a cleaner fix (a proper healthcheck on the indexer verifying its schema
exists) isn't built.

## Why `document-service` has no `depends_on` at all

It's genuinely self-contained (see `00`'s note on its isolation) — no
other service needs to be up first, and no other service is currently
waiting on it either.

## Bringing everything up

```bash
# 1. Start the chain FIRST (separately) — e.g.:
cd besu-network && docker compose up -d
# ... deploy contracts, note down every address ...

# 2. Fill in the root .env.example → .env with every real address and key
cp .env.example .env
# (edit .env: CLAIM_REGISTRY_ADDRESS, INSURANCE_POLICY_ADDRESS,
#  ORACLE_ADAPTER_ADDRESS, STABLECOIN_ADDRESS, all the *_PRIVATE_KEY
#  values, all the *_API_KEY values)

# 3. Bring up everything else
docker compose up --build
```

`--build` matters the first time (and after any code change) — without
it, compose will happily reuse a stale image from a previous build.

## Bringing up just one new service, on its own

Since every service has its own independent Dockerfile, you don't need
the whole stack for a quick check of just one:

```bash
docker build -t dics-notification-service ./notification-service
docker run --env-file ./notification-service/.env dics-notification-service
```

This works, but note it won't be able to reach `postgres` or the chain
unless you either run it with `--network` pointed at the compose
network, or point its `.env` at real externally-reachable addresses
(e.g. `localhost` URLs if Postgres/the chain are already running
outside Docker on your host).

## Volumes — what actually persists across a restart

- `postgres-data` — the shared database (backend's claims, indexer's
  on-chain mirror)
- `document-service-data` — uploaded files and `document-service`'s
  own SQLite database

Every other service is stateless from Docker's point of view — a
restart loses nothing service-specific, since their real state lives
either on-chain or in one of the two volumes above.

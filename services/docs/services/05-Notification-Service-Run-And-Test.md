# 05 — `notification-service` (Go): Run & Test Locally

## Communicates with (see `00-Communication-Map.md`)
- **Postgres** (indexer's `onchain_policies` table) — read-only
- **Chain** (`InsurancePolicy`) — read-only, live premium status
- **An external webhook URL** — sends the actual warning (Slack
  incoming webhook, or a local test HTTP receiver)

Does **not** call `backend`, `oracle-service`, `indexer`,
`underwriter-service`, or `document-service` directly.

## Run locally

```bash
cd notification-service
go mod download
cp .env.example .env
# Fill in RPC_URL, INSURANCE_POLICY_ADDRESS, DATABASE_URL (pointed at
# the SAME Postgres the indexer writes to), WEBHOOK_URL
go run .
```

Quick way to see it actually fire without setting up Slack: run a
throwaway local receiver in a second terminal —

```bash
python3 -m http.server 9000   # or any tool that logs incoming POSTs
```

— and point `WEBHOOK_URL` at `http://localhost:9000/webhook`.

## Run the tests

```bash
go test ./... -v
```

No database, chain, or webhook endpoint needs to be running — every
test exercises the pure `ShouldNotify` decision function directly (see
document `15`). This is the one service in this project whose core
logic can be fully tested with literally zero I/O setup.

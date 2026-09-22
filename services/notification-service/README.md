# notification-service (Go)

Watches every active policy for a premium that's about to lapse (or has
already lapsed) and sends a webhook warning — closing a real gap: today,
a policyholder only discovers their premium lapsed when a claim
submission reverts with `PremiumNotCurrent`.

## Why this exists, and why Go

Explained in full in `docs/tests-explained/15-Notification-Service.md`
(purpose, why each function, line-by-line data flow, and why the
notification decision logic is deliberately a pure, easily-testable
function separate from the actual poll loop).

## Architecture in one sentence

Reads the list of active policies from the **indexer's** Postgres
tables (read-only — never writes there), reads live premium status
directly from the **chain** for each one (the indexer doesn't track
premium status at all), and POSTs a JSON warning to a configurable
webhook when a policy enters its warning window.

## Running locally

```bash
go mod download
cp .env.example .env   # fill in real values
go run .
```

## Running the tests

```bash
go test ./... -v
```

No database, chain, or webhook endpoint needs to be running for this —
`scheduler_test.go` tests the pure decision function (`ShouldNotify`)
directly, with no I/O at all.

## Docker

```bash
docker build -t dics-notification-service .
docker run --env-file .env dics-notification-service
```

## Known limitations, stated directly

- De-duplication of sent warnings is in-memory only — a restart could
  re-send one already-sent warning. See `internal/scheduler/scheduler.go`'s
  comment on why this was judged an acceptable trade-off rather than
  adding a new database table to a schema this service otherwise never
  writes to.
- The webhook is a real, generic HTTP integration, not a real
  email/SMS provider — no such provider's credentials belong in this
  project. See `internal/notifier/webhook.go`'s header.
- Like every other piece of this project, this has not been compiled
  or run by the assistant that wrote it — no Go toolchain was available
  in that environment. Run `go build ./...` and `go vet ./...` before
  trusting it further.

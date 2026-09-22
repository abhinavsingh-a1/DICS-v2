# 15 — `notification-service` (Go): Purpose, Design, and Data Flow

This document assumes you've read `11` and `12` for the general shape
of this project's testing philosophy. Go's own idioms — table-driven
tests, the `internal/` package convention, explicit error returns
instead of exceptions — are explained here from scratch, since nothing
earlier in this document set uses them.

## What is the purpose of this service, in one sentence?

It watches every active insurance policy and sends a warning before —
or right after — a premium lapses, closing a real gap: today, a
policyholder only discovers their premium expired when a claim
submission reverts with `PremiumNotCurrent` (see the data-flow
documents' Step 3).

**If this service didn't exist:** nothing in this entire project
proactively tells anyone their coverage is about to stop working. The
information (`isPremiumCurrent`, `premiumPaidUntil`) has existed on
`InsurancePolicy.sol` since the premium module was built — nothing was
ever reading it *before something went wrong*.

## Why Go, specifically, for this one service?

Not an arbitrary choice: this service's whole job is "wake up
periodically, do a small amount of work, go back to sleep, forever."
Go's standard library has exactly the tools this calls for built in —
`time.Ticker` for the periodic wake-up, goroutines and channels for
clean shutdown — with no framework needed at all. The compiled binary
this produces (via the Dockerfile's multi-stage build) is a single
~15MB executable with no runtime interpreter needed alongside it,
which matters for a small, long-running background service more than
it does for, say, an HTTP API with a large surface area.

---

## `internal/config/config.go`

### Why does `Load()` return `(*Config, error)` instead of just panicking on a missing variable?

This is worth understanding as a genuinely different convention from
Python or JavaScript, not just a stylistic quirk. Go has no built-in
exception mechanism the way Python's `raise` or JavaScript's `throw`
work — the *idiomatic* way to signal "this failed" in Go is to return
an `error` value as a normal, second return value, and the *idiomatic*
way to handle it is to check that value immediately, every time:

```go
cfg, err := config.Load()
if err != nil {
    log.Fatalf("config error: %v", err)
}
```

**What would happen if `Load()` panicked instead:** a panic in Go
*can* be recovered from, but by convention, panics are reserved for
"something is so wrong the program cannot possibly continue safely" —
a genuinely missing config value is exactly the kind of *expected,
anticipatable* failure `error` returns exist for, and `main.go`'s own
`if err != nil { log.Fatalf(...) }` is where the decision to actually
stop the program gets made explicitly, by the caller, not forced on
every caller by the callee.

### Data flow through `Load()`, with concrete values

- **Input:** nothing (reads directly from `os.Getenv`)
- **Line by line**, assuming `.env` provided
  `RPC_URL=http://localhost:8545`, `INSURANCE_POLICY_ADDRESS=0x2222...bbbb`,
  `DATABASE_URL=postgres://...`, `WEBHOOK_URL=http://localhost:9000/webhook`,
  and no `POLL_INTERVAL_SECONDS`/`WARNING_WINDOW_DAYS` set at all:
  1. Four `os.Getenv` calls populate the struct's string fields.
  2. The `for name, value := range map[string]string{...}` loop checks
     each one is non-empty — all four pass in this example.
  3. `envIntOrDefault("POLL_INTERVAL_SECONDS", 300)` — since that
     variable is unset, `os.Getenv` returns `""`, and the function
     returns the fallback, `300`, with no error.
  4. `cfg.PollInterval = time.Duration(300) * time.Second` — Go's
     `time.Duration` is itself just an `int64` counting nanoseconds
     under the hood; multiplying by `time.Second` (a predefined
     constant) converts "300 of *some* unit" into "300 of *seconds*,*
     expressed in the nanosecond count `time.Duration` actually stores.
  5. Same pattern for `WARNING_WINDOW_DAYS`, defaulting to `3`, then
     `cfg.WarningWindow = 3 * 24 * time.Hour`.
- **Output:** `&Config{RPCURL: "http://localhost:8545", ..., PollInterval: 5*time.Minute, WarningWindow: 72*time.Hour}`, `nil` error.

---

## `internal/chain/client.go`

### Why is the ABI written as a raw Go string constant (`insurancePolicyABIJSON`), the same shape as the Python backend's ABI list?

Go's `abi.JSON()` function (from the `go-ethereum` library) parses
exactly the same JSON ABI-fragment format Ethereum tooling uses
everywhere — the same format `web3.py` (Python) and `ethers.js`
(JavaScript, in a slightly different but related shape) both consume.
Writing it as a Go multi-line string literal (backtick-quoted) rather
than, say, a Go struct literal, means this file's ABI definition can be
visually compared line-by-line against the Python backend's
`INSURANCE_POLICY_ABI` (document `11`) — deliberately kept structurally
identical across the two languages, so a mismatch between them (a sign
one was updated and the other forgotten) is easy to spot by eye.

### Data flow inside `GetPremiumStatus`, with concrete values

For policy 1 — Alice's Premium-plan policy from the data-flow documents
— right after her premium has lapsed past its grace period:

- **Input:** `policyID = 1` (an `int64`)
- **Line by line:**
  1. `c.call(ctx, "isPremiumCurrent", &current, big.NewInt(1))` — this
     calls the shared `call` helper (below), which:
     - `c.contractABI.Pack("isPremiumCurrent", big.NewInt(1))` — encodes
       the function call into raw bytes: a 4-byte function selector
       (the first 4 bytes of `keccak256("isPremiumCurrent(uint256)")`)
       followed by the 32-byte-padded encoding of `1`.
     - `c.eth.CallContract(ctx, ethereum.CallMsg{To: &contractAddress, Data: encodedCall}, nil)`
       — sends this as a `eth_call` JSON-RPC request (a read, not a
       transaction — no gas spent, nothing broadcast to the network).
       For Alice's lapsed policy, the chain returns the encoded `false`.
     - `c.contractABI.UnpackIntoInterface(&current, "isPremiumCurrent", result)`
       — decodes those raw returned bytes back into the Go `bool`
       variable `current`, now holding `false`.
  2. The same three-step pattern repeats for `premiumPaidUntil`,
     decoding into a `*big.Int` — for Alice's example, the chain
     returns the encoded integer `1802592000`.
- **Output:** `&PremiumStatus{PolicyID: 1, Current: false, PaidUntil: 1802592000}`

### Why does `call` exist as one shared helper, instead of `GetPremiumStatus` doing this three-step pack/send/unpack dance twice, inline?

If a third view function were ever added to this ABI (say,
`premiumTerms`, mirroring what the Python backend also reads), writing
its own inline pack/send/unpack block would be the third *nearly*
identical copy of the same three lines, and any future fix to how
errors are handled or logged for a chain call would need updating in
every copy. One shared `call` function means there's exactly one place
that knows how to "encode, send, decode" — every actual function call
just describes *what* to call and *where the result goes*, not *how*
the call happens.

---

## `internal/db/policies.go`

### Why does this file exist as a separate package from `chain`, rather than one combined "data access" package?

Because they talk to two genuinely different systems for two genuinely
different reasons: `chain` reads live, real-time premium status
directly from the blockchain (data that changes the moment someone
pays); `db` reads a slower-changing list of *which policies exist at
all* from the indexer's own Postgres mirror. Separating them into
distinct packages makes each one's single responsibility obvious from
its name alone, and — practically — means `scheduler_test.go` (below)
never needs to touch either one directly, since the pure decision logic
it tests doesn't call `chain` or `db` at all.

### Why does `ActivePolicies` filter `WHERE revoked = false` directly in the SQL, rather than fetching everything and filtering in Go code?

Both would produce the same *correct* result. The difference is where
the filtering work happens: doing it in the `WHERE` clause means
Postgres — which is specifically built and indexed for exactly this
kind of filtering — only ever sends back the rows this service actually
needs, rather than sending every policy (revoked or not) over the
network just to immediately throw most of them away in application
code. For a table with thousands of policies, only a fraction of which
are actively revoked, this is a meaningfully smaller amount of data
moved for the exact same end result.

---

## `internal/scheduler/scheduler.go` and `scheduler_test.go`

### Why is `ShouldNotify` a package-level function taking every piece of state as a plain argument, rather than a method on `Scheduler` reading its own fields?

This is the single most important design decision in this whole
service, and it's the same underlying idea as the Python backend's
`get_insurance_policy_contract` being swappable via `patch` (document
`12`) — just achieved completely differently, because Go has no
runtime monkey-patching mechanism at all. There is no way in Go to
temporarily replace a function the way Python's `unittest.mock.patch`
does. So instead of relying on being *able* to fake `Scheduler`'s real
dependencies (a real database connection, a real chain client) during a
test, this design sidesteps needing to fake them in the first place —
`ShouldNotify` takes plain Go values (`chain.PremiumStatus`, a
`time.Time`, a `time.Duration`, an `int64`) as arguments and returns a
plain `bool`. Nothing about calling it touches a network, a database,
or the system clock (`now` is passed in, not read internally via
`time.Now()`) — which is exactly what makes `scheduler_test.go` able to
test six different scenarios in milliseconds, with no setup at all
beyond constructing a few struct literals.

### Walking through one table-driven test case in full

```go
{
    name: "premium lapsed, exactly 2 days out — inside warning window",
    status: chain.PremiumStatus{
        PolicyID:  3,
        Current:   false,
        PaidUntil: now.Add(2 * 24 * time.Hour).Unix(),
    },
    want: true,
},
```

**What this case is actually checking:** with `now` fixed at
`2026-01-15 12:00 UTC` and `warningWindow` fixed at 3 days
(from the test function's own setup), this policy's `PaidUntil` is set
to exactly 2 days from `now` — inside the 3-day warning window, so a
warning should fire. The test loop (`for _, c := range cases { t.Run(...) }`)
calls `ShouldNotify(c.status, now, warningWindow, c.lastNotifiedPaidUntil)`
and checks the real return value against `c.want`. `lastNotifiedPaidUntil`
is left as its zero value (`0`, Go's default for an unset `int64` field)
here — meaningfully different from `status.PaidUntil`, so the
"already notified for this exact period" de-dup check inside
`ShouldNotify` correctly does NOT suppress this warning.

**Why six cases, not just one "does it work" test:** each case in this
table isolates one specific *boundary* or *edge*: premium current
(never warn, regardless of dates), too far from expiry (don't warn
yet), inside the window (do warn), already past expiry entirely (still
warn — it's not just "approaching," it's actively lapsed), and the two
de-duplication cases (same period already warned about vs. a genuinely
new period). Each one is a distinct way this logic could have a bug;
testing only the "obvious" case would miss every one of these.

### Data flow inside `checkOnce`, with concrete values

- **Input:** none directly (reads from `s.database`, `s.chain`, `s.cfg`, `s.lastNotified`)
- **Line by line**, for a run where `ActivePolicies` returns exactly
  Alice's policy 1 (holder `0x1111...aaaa`, not revoked):
  1. `s.database.ActivePolicies(ctx)` → `[]db.Policy{{PolicyID: 1, HolderAddress: "0x1111...aaaa", Revoked: false}}`.
  2. For policy 1: `s.chain.GetPremiumStatus(ctx, 1)` → the
     `&PremiumStatus{PolicyID: 1, Current: false, PaidUntil: 1802592000}`
     worked example from `chain/client.go`'s section above.
  3. `ShouldNotify(*status, time.Now(), s.cfg.WarningWindow, s.lastNotified[1])`
     — assume `s.lastNotified[1]` is `0` (never notified before, Go's
     zero-value for a missing map key) and `time.Now()` is past the
     warning-window boundary — returns `true`.
  4. `daysRemaining := int(time.Until(...).Hours() / 24)` — for a
     policy already past its `PaidUntil`, `time.Until` returns a
     *negative* duration, so `daysRemaining` comes out negative too
     (e.g. `-1`) — a deliberate, honest signal in the webhook payload
     that this isn't just "approaching," it's already overdue.
  5. Builds `notifier.PremiumWarning{PolicyID: 1, HolderAddress: "0x1111...aaaa", PaidUntil: 1802592000, DaysRemaining: -1}`.
  6. `s.notify.Send(ctx, warning)` — POSTs this as JSON to the
     configured webhook URL.
  7. On success: `s.lastNotified[1] = 1802592000` — records exactly
     *which* `PaidUntil` value this warning was for, so a future call
     to `ShouldNotify` for this same still-lapsed period returns
     `false` (the de-dup case from the test table above), but a *future*
     payment that changes `PaidUntil` to a new value will correctly
     allow a fresh warning.
- **Output:** none directly — this function's effect is entirely the
  side effect of an HTTP POST and an in-memory map update; `main.go`'s
  `Run` loop just calls it again on the next tick.

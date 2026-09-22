# DICS v2 — Oracle Service

The off-chain piece that was the last missing link in the oracle flow:
evaluates a claim (currently via a clearly-labeled MOCK decision function),
signs the result as an EIP-712 `OracleResponse`, and relays it to
`OracleAdapter.submitVerification`, which verifies the signature and
forwards to `ClaimRegistry.recordOracleVerification`.

Plain JavaScript (ES modules), per the project's stated JS policy — no
TypeScript anywhere in this service.

## Setup

```bash
cd oracle-service
npm install
cp .env.example .env
# Fill in RPC_URL, CHAIN_ID, ORACLE_ADAPTER_ADDRESS, ORACLE_SIGNER_PRIVATE_KEY
npm run lint
npm test               # unit tests only — no external tooling required
npm start
```

## Testing

- `npm test` — unit tests (`test/signer.test.js`). Fast, no dependencies
  beyond Node/Jest.
- `npm run test:integration` — `test/oracle.integration.test.js`. Spins up
  a real Anvil instance, deploys a **real** `OracleAdapter` (behind a
  proxy) via Foundry, and exercises this service's actual `/verify`
  endpoint and signing/relay code against it — including replay,
  expiry, and unauthorized-signer rejection, all verified as real
  on-chain reverts, not mocked assertions. Requires `anvil` and `forge`
  (Foundry) on PATH; skips gracefully with a warning if they're not
  found, so plain `npm test` still works without Foundry installed.
- `npm run test:all` — both.

The signer key you put in `.env` for local development must correspond to
an address that's been granted `ORACLE_SIGNER_ROLE` on the deployed
`OracleAdapter` — see the besu-network README's role-wiring section.

## How it's called

```
Backend (FastAPI)
   ↓ POST /verify { claimId, declaredAmount, evidenceSummary }
Oracle service
   ↓ evaluateClaim()          — MOCK decision logic
   ↓ signOracleResponse()     — EIP-712 signature
   ↓ submitVerificationOnChain() — relays to OracleAdapter
OracleAdapter.sol
   ↓ verifies signature, checks expiry + replay
ClaimRegistry.recordOracleVerification()
```

## Security notes — read before deploying this anywhere shared

1. **`POST /verify` requires `X-Oracle-Service-Key`.** Set
   `ORACLE_SERVICE_API_KEY` in `.env` (32+ random hex chars — see the
   generation command in `.env.example`) and have the caller (the
   backend) send it as a header. Compared using a constant-time check
   (`src/auth.js`) to avoid leaking the key via response-timing. This
   closes the "anyone who can reach this service can trigger a signed
   approval" gap that existed in the first version of this service.
   **This is not a substitute for network isolation** — a shared secret
   sent over an unencrypted or publicly-reachable connection is still
   exposed. In any shared environment, this service should also sit in
   a private subnet with no public ingress, and the connection to it
   should be TLS. Defense in depth: both matter, neither alone is enough.

2. **The signer private key loads from a `.env` file.** This is
   explicitly the pattern the project's own architecture decisions say
   not to use beyond local dev (see `signer.js` → `getSigningWallet()`).
   That function is the one seam to change when swapping to HashiCorp
   Vault or AWS KMS — nothing else in this service needs to change.

3. **The relayer key is separate from the signer key** (`RELAYER_PRIVATE_KEY`
   in `.env`, falling back to the signer key with a startup warning if
   unset). Since `submitVerification` is permissionless by design, the
   relayer key needs no privileged role at all — only gas funds — so
   there's no reason for it to be as sensitive as the signing key, and
   keeping them separate limits what's exposed if the relayer's
   environment is compromised.

4. **`issuedRequestIds` is in-memory only** and resets on restart. This
   is explicitly *not* the actual replay-protection boundary — that's
   enforced on-chain by both `OracleAdapter.usedRequestIds` and
   `ClaimRegistry.usedOracleRequestIds`, which survive a service restart.
   The in-memory set here is only a development-time sanity check against
   this process generating a duplicate ID within its own lifetime.

## What's still open

- **No retry/backoff on `submitVerificationOnChain`.** A transient RPC
  failure or dropped transaction currently just returns a 502 to the
  caller with no automatic retry.
- **No persistence of verification history** — if you need "what did the
  oracle service decide and when" as an audit trail beyond what's already
  on-chain (`VerificationSubmitted` events), that's not built here.
- **The API key is a single static shared secret with no rotation
  mechanism.** Fine for local dev; production should source it from a
  secrets manager and rotate it — same pattern already called out for the
  signer private key.
- **mTLS / network isolation between backend and this service is not
  configured here** — that's an infrastructure-layer concern (Kubernetes
  NetworkPolicy, private subnet, service mesh), out of scope for this
  service's own code, but necessary alongside the API key, not instead
  of it.
- **The integration test's fixture uses a throwaway deployer-as-admin
  setup** (see `DeployIntegrationFixture.s.sol` comments) — it is
  deliberately NOT the same deployment pattern as the real Timelock-based
  role wiring documented in `besu-network/README.md`, and shouldn't be
  mistaken for a template for real deployment.
- **The backend's actual call into this service doesn't exist as code
  yet** — the FastAPI backend was only ever produced as chat text earlier
  in this project's history, not as files in this session's project
  structure. The contract this service expects from that caller: send
  `POST /verify` with `X-Oracle-Service-Key: <ORACLE_SERVICE_API_KEY>`
  and a JSON body of `{ claimId, declaredAmount, evidenceSummary? }`.

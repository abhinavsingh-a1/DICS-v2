# 03 — `oracle-service` (Node.js): Run & Test Locally

## Communicates with (see `00-Communication-Map.md`)
- **`backend`** — receives `POST /verify` from it
- **Chain** (`OracleAdapter`) — submits the signed verification transaction

## Run locally

```bash
cd oracle-service
npm install
cp .env.example .env
# Fill in RPC_URL, CHAIN_ID, ORACLE_ADAPTER_ADDRESS,
# ORACLE_SIGNER_PRIVATE_KEY, ORACLE_SERVICE_API_KEY (must match
# backend/.env exactly)
npm run lint
npm start
```

The signer key must correspond to an address actually granted
`ORACLE_SIGNER_ROLE` on the deployed `OracleAdapter` — see
`besu-network/README.md`'s role-wiring section. Without that role
grant, every real verification submission will revert with
`UnauthorizedSigner` (see the data-flow documents' Step 4).

Verify it's up: `curl http://localhost:4100/health` → `{"status":"ok"}`
(this one endpoint is deliberately unauthenticated — everything else
requires `X-Oracle-Service-Key`).

## Run the tests

```bash
npm test                  # unit tests — no external tooling required
npm run test:integration  # real Anvil + real deployed OracleAdapter via Foundry
npm run test:all
```

The integration test is the one worth understanding precisely: it
spins up a real local chain, deploys a real `OracleAdapter` behind a
real proxy, and exercises this service's actual signing and relay code
against it — replay protection, expiry, and unauthorized-signer
rejection are all verified as genuine on-chain reverts, not mocked
assertions. Requires `anvil` and `forge` (Foundry) on `PATH`; skips
gracefully with a warning if they're missing, so plain `npm test` still
works without Foundry installed at all.

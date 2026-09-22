# 02 — `frontend` (React/Vite): Run & Test Locally

## Communicates with (see `00-Communication-Map.md`)
- **`backend`** — auth, claims CRUD, policy catalog/status (the only
  service this ever calls over HTTP)
- **Chain** (`InsurancePolicy`, `ClaimRegistry`, `StableCoin`) —
  directly, via the connected wallet, for every write, plus read-only
  calls for catalog browsing

**Never calls** `oracle-service`, `indexer`, `notification-service`,
`underwriter-service`, or `document-service` directly — this is
deliberate, not missing wiring (see `00`'s "what never talks to what"
section).

## Run locally

```bash
cd frontend
npm install
cp .env.example .env
# Fill in VITE_CLAIM_REGISTRY_ADDRESS, VITE_INSURANCE_POLICY_ADDRESS,
# VITE_STABLECOIN_ADDRESS after deploying, and VITE_CHAIN_ID to match
# whichever network you're pointed at (1337 for local Anvil/Besu)
npm run dev
```

Add the same network to MetaMask (RPC URL matching
`VITE_CHAIN_RPC_URL`, chain ID matching `VITE_CHAIN_ID`) and import a
funded local account (e.g. one of Anvil's default accounts) to actually
sign and submit transactions — `BuyPolicy` and the premium-payment flow
both need real dUSD balance to do anything beyond browsing.

Open `http://localhost:5173`.

## Run the tests

```bash
npm test
```

Currently only `test/contract.test.js` — a pure unit test for the
placeholder evidence-hashing function. No component or end-to-end tests
yet, and nothing here exercises the new `BuyPolicy.jsx`/
`PremiumStatusBadge.jsx` pages at all — see documents `13`/`14` for the
two real bugs caught in those files by manual review instead, since no
automated JS test coverage exists for them.

## What actually requires the backend and chain to be running

Browsing `/buy-policy` needs the backend up (`GET /policies/catalog`).
Any button click (subscribe, pay premium, file a claim) needs a wallet
connected to a real, reachable chain with the right contracts deployed.
`npm run dev` alone gets you a page that *loads*; it doesn't get you a
page that *does* anything without the rest of the stack — see document
`09` for confirming that end-to-end.

# DICS v2 — Frontend

React (plain JavaScript, Vite), wallet-based auth, and the full claim
submission flow wired to the real backend and a real deployed
`ClaimRegistry`.

## Setup

```bash
cd frontend
npm install
cp .env.example .env
# Fill in VITE_CLAIM_REGISTRY_ADDRESS after deploying, and VITE_CHAIN_ID
# to match whichever network you're pointed at (1337 for local Anvil/Besu)
npm run dev
```

Also add the same network to MetaMask (RPC URL matching
`VITE_CHAIN_RPC_URL`, chain ID matching `VITE_CHAIN_ID`) and import a
funded local account (e.g. one of Anvil's default accounts) to actually
sign and submit transactions.

## Testing

```bash
npm test
```

Currently only `test/contract.test.js` — a pure unit test for the
placeholder evidence-hashing function. No component or end-to-end tests
yet (see "still open").

## How the pieces connect

```
FileClaim page
   ├─ POST /claims (backend)          → creates off-chain draft record
   └─ ClaimRegistry.submitClaim()     → real on-chain transaction, signed by the wallet

Indexer (separate service, not called directly by this frontend)
   ├─ picks up the ClaimSubmitted event
   └─ POST /internal/onchain-events (backend) → correlates by merkleRoot,
      updates the claim's onchain_claim_id/tx_hash/status

Dashboard / ClaimStatus pages
   └─ GET /claims, GET /claims/{id} (backend) → reflects whatever the
      indexer has synced so far — there is necessarily a short delay
      between the on-chain transaction confirming and this UI showing
      "on-chain claim ID: ..." (see Dashboard.jsx's "Not yet confirmed
      on-chain" message), because the indexer polls rather than pushing
      instantly.
```

The frontend never talks to the indexer or oracle-service directly —
only to the backend (for everything off-chain) and to the wallet /
`ClaimRegistry` contract directly (for the one on-chain transaction it
submits). This matches the API-interaction design from the earlier
architecture docs.

## What's still open

- **No document upload.** `api/contract.js`'s `placeholderMerkleRoot` is
  explicitly labeled as a stand-in — it hashes the claim description
  text alone, not real uploaded evidence. Building this means adding
  actual file upload UI, computing SHA-256 per file client-side or via a
  new backend upload endpoint (neither exists yet), and building a real
  Merkle tree — the backend's `CreateClaimRequest.documents` field
  already accepts the right shape (`filename`, `sha256_hash`, `file_cid`,
  `merkle_proof`) for whenever this is built.
- **No live-updating status** — Dashboard/ClaimStatus require a manual
  page reload or re-search to see the indexer's latest sync; no
  polling, WebSocket, or server-sent events.
- **No underwriter/reviewer view** — this frontend only covers the
  policyholder role. Reviewing and approving claims currently happens
  via direct contract calls (as exercised in the Foundry/integration
  tests), not through any UI.
- **No component or end-to-end tests** — only the one pure-function unit
  test above. A Playwright test against a real running backend +
  deployed contract (the same category as oracle-service's and the
  indexer's real-chain integration tests) is the natural next layer.
- **No reconnect-on-refresh** — deliberately not persisting the session
  token to localStorage (see `AuthContext.jsx`'s comment on the XSS
  trade-off); a page refresh requires logging in again.

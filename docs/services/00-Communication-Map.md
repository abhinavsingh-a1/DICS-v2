# 00 — Service Communication Map: What Actually Talks to What

Answering "does each service communicate with each other and with the
Solidity projects" precisely, not just "yes" — because the honest
answer is **mostly yes, with one real exception**, and knowing exactly
which links exist (and which don't) is what makes the verification
document (`09`) possible to write at all.

## The full picture

```
                              ┌─────────────────────┐
                              │   Besu / Anvil chain │
                              │ (InsurancePolicy,    │
                              │  ClaimRegistry,      │
                              │  OracleAdapter, ...)  │
                              └──────────┬───────────┘
              writes tx  ┌───────────────┼───────────────┐  reads (view calls)
                         │               │               │
              ┌──────────▼───┐   ┌───────▼──────┐  ┌─────▼──────────┐
              │ oracle-service│   │  underwriter- │  │    indexer      │
              │ (submits      │   │  service      │  │ (scans events)  │
              │  verification)│   │ (approve/     │  │                 │
              └───────▲───────┘   │  reject/payout)│  └────────┬────────┘
                      │           └───────▲────────┘           │ writes
           HTTP       │                   │ reads               │
      ┌───────────────┘                   │                     ▼
      │                          ┌─────────┴──────┐     ┌──────────────────┐
┌─────▼─────┐   HTTP webhook     │ (own Postgres   │     │  Shared Postgres  │
│  backend   │◄───────────────── │  read, no write)│     │  - indexer's own  │
│ (FastAPI)  │                   └─────────────────┘     │    onchain_* tables│
└─────▲──────┘                                           │  - backend's own  │
      │ REST                              reads           │    claims table   │
      │                          ┌─────────────────┐      └─────────▲─────────┘
┌─────┴──────┐  reads (view calls)│ notification-   │                │ reads
│  frontend   │───────────────────┤ service         │────────────────┘
│  (React)   │                   │ (polls, warns)  │
└─────┬──────┘                   └────────┬────────┘
      │ wallet txs + reads (chain, direct)         │ webhook (external, not a project service)
      └───────────────────────────────────►  [any HTTP endpoint]

┌──────────────────┐
│ document-service   │   ← ISOLATED. No arrows in or out to any other
│ (.NET)             │     service in this project. See below.
└────────────────────┘
```

## Every real link, stated as a table

| From | To | How | What for |
|---|---|---|---|
| `frontend` | Chain (`InsurancePolicy`, `ClaimRegistry`, `StableCoin`) | Wallet-signed transactions + read-only calls | `submitClaim`, `subscribeToPolicy`, `payPremium`, reading templates directly |
| `frontend` | `backend` | REST (`VITE_API_URL`) | Auth, claims CRUD, policy catalog/status |
| `backend` | Chain (`InsurancePolicy`) | Read-only calls (`web3_client.py`) | Policy catalog, premium status |
| `backend` | `oracle-service` | REST (`POST /verify`) | Trigger claim verification |
| `indexer` | Chain (`InsurancePolicy`, `ClaimRegistry`) | Read-only event scanning | Mirrors on-chain truth into Postgres |
| `indexer` | `backend` | REST webhook (`POST /internal/onchain-events`) | Notifies backend of confirmed on-chain state |
| `oracle-service` | Chain (`OracleAdapter`) | Signed transaction | Submits the EIP-712-signed verification |
| `notification-service` | Postgres (indexer's `onchain_policies` table) | Direct SQL, read-only | Which policies exist |
| `notification-service` | Chain (`InsurancePolicy`) | Read-only calls | Live premium status |
| `notification-service` | External webhook URL | HTTP POST | Sends the actual warning |
| `underwriter-service` | Postgres (indexer's `onchain_claims` table) | Direct SQL, read-only | Which claims are pending |
| `underwriter-service` | Chain (`ClaimRegistry`) | Signed transaction | `setClaimStatus`, `payoutClaim` — **superseded, see below** |
| `safe-ops` | Chain (Safe infra, `ClaimRegistry`) | Signed transactions, via owner keys | Deploy Safe infra, create the Safe, grant `UNDERWRITER_ROLE`, propose+sign+execute claim decisions |
| `safe-ops` | AWS KMS | Signing API calls | Every owner signature — no private key ever leaves KMS |
| `document-service` | — nothing — | — | See below |

## `underwriter-service`'s write path is superseded by `safe-ops`

`ClaimRegistry.UNDERWRITER_ROLE` now belongs to a Safe multisig, not a
single EOA — see `docs/services/10-Safe-Multisig-And-KMS.md` for the
full design. `underwriter-service`'s `ClaimRegistryClient.java` (a
single configured private key) will **revert** against any deployment
where this migration has run, since `msg.sender` for its calls is
always that EOA, never the Safe's own address. Its read-only endpoints
(`GET /claims/pending`, `GET /claims/{id}`) remain accurate; only the
three POST endpoints are affected. The real write path for
approve/reject/payout is now `safe-ops/scripts/04-propose-and-execute-transaction.js`.

## The one real gap: `document-service` is fully isolated

No other service calls it, and it calls no other service. This isn't a
bug — it's simply the next piece of wiring that hasn't been done yet,
named directly rather than glossed over:

- The **frontend** still calls its own `placeholderMerkleRoot` (hashing
  plain description text) instead of uploading to `document-service`
  and using the real Merkle root it would compute.
- **Nothing** reads `document-service`'s stored files back out for
  display anywhere in the frontend.
- `ClaimRegistry.sol` itself has no Merkle-proof verification logic at
  all (see document `17`), so even a fully-wired `document-service`
  wouldn't change what the contract checks — only what root gets
  submitted.

If you want this wired in next, the shape is: `BuyPolicy`/`FileClaim`
uploads documents to `document-service` first, receives back a real
`merkleRoot`, and passes *that* into `submitClaimOnChain` instead of
`placeholderMerkleRoot`'s output.

## Why some links go through shared Postgres directly, and others go through HTTP

This looks inconsistent at first glance — `notification-service` and
`underwriter-service` read the indexer's Postgres tables *directly*,
while the indexer talks to the *backend* over HTTP instead of touching
its Postgres table directly. The difference is ownership, not
carelessness: the indexer **writes** its own tables and must never have
another service also writing them (see indexer's README "ownership
boundary" section, and documents `15`/`16`'s headers) — but a
**read-only** query from a different service against a table it doesn't
own creates no such conflict, since there's still exactly one writer.
The backend's `claims` table, by contrast, has business rules
(idempotency, off-chain draft states) the indexer has no business
enforcing itself — so that link stays HTTP, going through the backend's
own code path rather than a raw table read.

## What never talks to what, deliberately

- `frontend` never calls `oracle-service`, `indexer`, `notification-service`,
  `underwriter-service`, or `document-service` directly — only `backend`
  and the chain itself.
- `oracle-service` and `indexer` never talk to each other at all — both
  independently watch the same chain, for different reasons.
- No service other than `oracle-service` and `underwriter-service` ever
  sends a signed transaction — every other chain interaction (backend,
  indexer, notification-service, and the frontend's read helpers) is
  read-only.

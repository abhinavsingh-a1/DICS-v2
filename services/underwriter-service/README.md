# underwriter-service (Java / Spring Boot)

The underwriter back-office API — flagged as missing repeatedly
elsewhere in this project. `setClaimStatus` and `payoutClaim` were only
ever reachable via raw contract calls; this service exposes them as a
real REST API.

## Why this exists, and the ownership design

Full explanation in `docs/tests-explained/16-Underwriter-Service.md`.
In short: this service reads pending claims from the **indexer's**
`onchain_claims` table (read-only — never writes to it), and performs
approve/reject/payout as real on-chain transactions via `web3j`, using
its own configured private key (standing in for the Underwriter Safe —
see `ClaimRegistryClient.java`'s own comment on that simplification).
It never writes to any database table at all; the indexer, which
already owns the job of mirroring on-chain truth, picks up the result.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| `GET` | `/claims/pending` | Every claim still `Submitted` or `UnderReview` |
| `GET` | `/claims/{id}` | One claim's current known state |
| `POST` | `/claims/{id}/approve` | Calls `setClaimStatus(id, Approved)` on-chain |
| `POST` | `/claims/{id}/reject` | Calls `setClaimStatus(id, Rejected)` on-chain |
| `POST` | `/claims/{id}/payout` | Calls `payoutClaim(id)` on-chain |

## Running locally

```bash
cp .env.example .env   # fill in real values
mvn spring-boot:run
```

## Running the tests

```bash
mvn test
```

No Postgres or chain node needs to be running — `ClaimControllerTest`
uses `@WebMvcTest` + Mockito `@MockBean` to replace both the database
repository and the chain client with controllable fakes. See
`docs/tests-explained/12` for the same underlying idea in Python, and
document `16` for this file's own walkthrough.

## Docker

```bash
docker build -t dics-underwriter-service .
docker run --env-file .env -p 8090:8090 dics-underwriter-service
```

## Known limitations, stated directly

- `UNDERWRITER_PRIVATE_KEY` is a single EOA key, not the Safe multisig
  the rest of this project's documentation describes as the intended
  production holder of `UNDERWRITER_ROLE`. See `ClaimRegistryClient.java`.
- Gas price/limit are fixed defaults (`DefaultGasProvider`), not
  estimated per-transaction — fine for local/test networks, a real gap
  for anything resembling mainnet.
- Not compiled or run by the assistant that wrote it — no Maven/JDK
  toolchain with network access to resolve dependencies was available.
  Run `mvn verify` before trusting this further.

# 06 — `underwriter-service` (Java/Spring Boot): Run & Test Locally

## Communicates with (see `00-Communication-Map.md`)
- **Postgres** (indexer's `onchain_claims` table) — read-only
- **Chain** (`ClaimRegistry`) — signed transactions (`setClaimStatus`,
  `payoutClaim`)

Does **not** call `backend`, `oracle-service`, `indexer`,
`notification-service`, or `document-service` directly. Note it writes
to the chain but never to any database — see document `16`'s header on
why (the indexer, not this service, updates `onchain_claims` after the
transaction is mined).

## Run locally

```bash
cd underwriter-service
cp .env.example .env
# Fill in DATABASE_URL/USER/PASSWORD (same Postgres the indexer uses),
# RPC_URL, CLAIM_REGISTRY_ADDRESS, UNDERWRITER_PRIVATE_KEY (an address
# actually granted UNDERWRITER_ROLE on the deployed ClaimRegistry)
mvn spring-boot:run
```

Verify it's up: `curl http://localhost:8090/claims/pending`.

## Run the tests

```bash
mvn test
```

No Postgres or chain node needs to be running — `ClaimControllerTest`
uses `@WebMvcTest` + Mockito `@MockBean` to replace both the database
repository and the chain client (see document `16` for the full
walkthrough, including why `ddl-auto: validate` in `application.yml`
means this service can never accidentally alter the indexer's schema).

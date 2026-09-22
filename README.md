# DICS v2 — Decentralized Insurance Claims & Risk Settlement Platform

**Aurelia Labs** (dummy organization). A blockchain-based insurance
platform: self-service policy subscription with atomic premium
payment, wallet-authenticated claim submission, off-chain oracle
verification, on-chain approval/payout, a full CDP/stablecoin module
with its own governance, and — as of this pass — real evidence upload,
underwriter tooling, and proactive premium-lapse notifications, each in
a different language, each independently containerized.

**This file is the front door.** For the actual architecture (who talks
to whom, precisely) see `docs/services/00-Communication-Map.md` — this
README stays at the level of "what exists and how to run it."

## What exists, as of this version

| Piece | Language | Directory |
|---|---|---|
| Smart contracts | Solidity (Foundry, OZ v5.7.x) | `smart-contracts/` |
| Local chain | Hyperledger Besu, IBFT2.0 | `besu-network/` |
| Backend | Python, FastAPI | `backend/` |
| Frontend | React (plain JS), Vite | `frontend/` |
| Oracle service | Node.js | `oracle-service/` |
| Indexer | Node.js | `indexer/` |
| Notification service | **Go** | `notification-service/` |
| Underwriter back-office | **Java, Spring Boot** | `underwriter-service/` |
| Document/evidence service | **.NET, ASP.NET Core** | `document-service/` |

**9 project directories. 8 of them (everything but the contracts
themselves) are independently containerized** — each has its own
`Dockerfile` and can be built and run entirely on its own, or all
together via the root `docker-compose.yml`.

## The smart contracts, specifically

Two governance-separated modules sharing one deployment:
- **Claims module**: `InsurancePolicy.sol` (policy catalog, self-service
  subscription, premium billing), `ClaimRegistry.sol` (claim lifecycle,
  payout), `OracleAdapter.sol` (EIP-712 verification) — governed by a
  Safe + `TimelockController`.
- **CDP module**: `Vault.sol`, `StableCoin.sol` (the `dUSD` premiums and
  payouts are denominated in), `PriceOracle.sol`, `DICSGovernanceToken.sol`,
  `DICSGovernor.sol`, `ClaimGasPaymaster.sol` — governed by its own,
  entirely separate token-voting Governor + Timelock.

All upgradeable contracts are UUPS proxies on OpenZeppelin v5.7.x —
migrated from v4.9.x mid-project; see `docs/Project-1-Smart-Contracts-Explained.md`
Section 0 for the full migration history, including several real,
compiler-verified corrections along the way (not a clean one-shot
migration — the actual process is documented honestly).

## Documentation — three complementary sets, not one giant file

| Set | What it covers | Where |
|---|---|---|
| **Data flow** (15 documents) | A concrete $33→$221 scenario traced through every function, every EIP, with real addresses and values — plus 8 alternate scenarios (rejected, lapsed, coverage-exceeded, replay attack, etc.) | `docs/dataflow/` |
| **Tests & mocks explained** (17 documents) | Junior-developer-level walkthroughs of every test file across Solidity, Python, Java, Go, and C# — why each function exists, why each line, and five languages' different idioms for the same "mock a dependency" idea | `docs/tests-explained/` |
| **Service guides** (10 documents) | Per-service run/test instructions, the full inter-service communication map, Docker Compose wiring, and a step-by-step post-deploy verification checklist | `docs/services/` |

Plus standalone documents: `docs/Project-1-Smart-Contracts-Explained.md`
(the contracts, function by function), `docs/Smart-Contract-Testing-Guide.md`
(all 57 Foundry test cases catalogued), and `docs/Execution-Steps-and-Next-Actions.md`.

**Start with `docs/services/00-Communication-Map.md`** if you want the
single highest-value document in this whole set — it's the one place
that states precisely which services talk to which, including the one
real gap (see below).

## Run order (local, from scratch)

1. **Start the chain and deploy contracts** — `besu-network/README.md`
   sections 2–5. Note every deployed proxy address: `InsurancePolicy`,
   `ClaimRegistry`, `OracleAdapter`, `StableCoin`, and (if exercising the
   CDP module) `Vault`, `PriceOracle`, `DICSGovernanceToken`, `DICSGovernor`.

2. **Fill in the root `.env`**:
   ```bash
   cp .env.example .env
   # every address from step 1, plus ORACLE_SIGNER_PRIVATE_KEY,
   # ORACLE_RELAYER_PRIVATE_KEY, UNDERWRITER_PRIVATE_KEY, and every
   # *_API_KEY the file's own comments describe
   ```

3. **Bring up everything else:**
   ```bash
   docker compose up --build
   ```
   See `docs/services/08-Docker-Compose-Containerization.md` for exactly
   what each service depends on and why (including a real, currently
   unfixed startup-race edge case between the indexer and the two
   services that read its tables).

4. Open `http://localhost:5173`, connect a wallet, visit `/buy-policy`,
   subscribe to a plan, file a claim.

5. **Verify every service is actually talking to every other one it
   should be** — don't just assume it: `docs/services/09-Post-Dockerize-Verification.md`
   gives a concrete `curl`/`psql`/log check for every single link in the
   communication map, in dependency order.

### Running one piece individually

Every service has its own `README.md` plus a dedicated run/test guide
in `docs/services/01` through `07`. Each can be built and run with
Docker entirely on its own (`docker build ./notification-service`,
etc.) without the rest of the stack.

## Testing, end to end

```bash
cd smart-contracts        && forge test -vvv          # 57 test cases, see docs/Smart-Contract-Testing-Guide.md
cd backend                && pytest -v
cd frontend                && npm test
cd oracle-service          && npm test && npm run test:integration
cd indexer                 && npm test && npm run test:integration
cd notification-service    && go test ./... -v
cd underwriter-service     && mvn test
cd document-service/document-service.Tests && dotnet test
```

Five different languages, five different mocking idioms, documented
side by side in `docs/tests-explained/12` (Python `unittest.mock`),
`13`/`14` (real bugs caught by manual review, since no JS test tooling
was available), `15` (Go's dependency-free pure functions), `16` (Java
Mockito), `17` (C# Moq).

**None of the Go, Java, or .NET code — and none of the smart contract
work before the point it was actually run — has been compiled or
executed by the assistant that built it.** No toolchains with network
access for dependency resolution were available in that environment.
Every fix throughout this project's history that *is* verified was
verified against real compiler/test output pasted back in, not assumed.
Run everything above yourself before trusting it fully.

## What's still open, consolidated and current

1. **`document-service` is fully built but fully isolated.** Nothing
   calls it and it calls nothing — the frontend still uses its own
   `placeholderMerkleRoot` instead of uploading real evidence and using
   the real Keccak256 Merkle root this service computes. See
   `docs/services/00-Communication-Map.md`'s dedicated section on this.
2. **`ClaimRegistry.sol` has no on-chain Merkle proof verification at
   all**, regardless of the above — it accepts any `bytes32 merkleRoot`
   with no check against anything. Wiring `document-service` in would
   make the root *meaningful*; it wouldn't by itself make the contract
   *verify* it.
3. **Deep reorg recovery isn't implemented** in the indexer — only a
   shallow block-count safety margin.
4. **No true reconciliation job** between the indexer's mirror and the
   backend's own claims table beyond the one-way webhook.
5. **No script deploys a real Safe or `TimelockController`** for either
   governance domain — `besu-network/README.md` documents the intended
   wiring by hand; every private key used by `oracle-service` and
   `underwriter-service` is a single EOA standing in for what should be
   multisig-controlled roles in production, flagged explicitly in both
   services' own code comments.
6. **No CI pipelines configured** — no `.github/workflows/*.yml` files.
7. **No shared, persistent (non-local) infrastructure** — everything
   here is local-development tooling.
8. **`ClaimGasPaymaster.sol` has no Foundry test at all** and remains
   the single lowest-confidence contract in the project, independent of
   the OpenZeppelin version question.
9. **Frontend has no live-updating status, no component/E2E tests, and
   no reconnect-on-refresh.**

Every item above is also documented in more depth at the specific file
or service where it's actually relevant — this list is a map to those,
not a replacement for them.

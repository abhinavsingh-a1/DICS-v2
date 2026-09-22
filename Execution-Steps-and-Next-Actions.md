# DICS v2 — Precise Execution Steps & Next Actions

This document gives the exact, ordered steps to run the entire system
from nothing, across all three projects, followed by a consolidated list
of what's left to do. It assumes you've unzipped all three project
archives into a shared parent directory as siblings:

```
dics-v2/
├── smart-contracts/       (from 01-smart-contracts.zip)
├── besu-network/          (from 01-smart-contracts.zip)
├── backend/                (from 02-api-backend-services.zip)
├── oracle-service/         (from 02-api-backend-services.zip)
├── indexer/                 (from 02-api-backend-services.zip)
└── frontend/                (from 03-ui-frontend.zip)
```

**Prerequisites:** Docker, Node.js 20+, Python 3.12+, Foundry
(`curl -L https://foundry.paradigm.xyz | bash && foundryup`).

---

## Step 1 — Start the local chain

```bash
cd besu-network
chmod +x generate-network.sh
./generate-network.sh
# Rename the generated ./networkFiles/keys/<address> directories to
# validator1..validator4 as noted at the bottom of docker-compose.yml
docker compose up -d
docker compose logs -f validator1   # confirm blocks are being produced, then Ctrl+C
```

Verify:
```bash
curl -X POST --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
  -H "Content-Type: application/json" http://localhost:8545
```

## Step 2 — Install contract dependencies and run unit tests

```bash
cd ../smart-contracts
forge install OpenZeppelin/openzeppelin-contracts-upgradeable@v4.9.6
forge install OpenZeppelin/openzeppelin-contracts@v4.9.6
```

Add to `foundry.toml`:
```toml
remappings = [
  "@openzeppelin/contracts-upgradeable/=lib/openzeppelin-contracts-upgradeable/contracts/",
  "@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/"
]
```

```bash
forge test -vvv
forge coverage
```

## Step 3 — Deploy a Safe + TimelockController, then the contracts

Follow `besu-network/README.md` section 5 exactly:
1. Deploy a Gnosis Safe (admin signers) and a second Safe (canceller
   signers, deliberately different from the first).
2. Deploy `TimelockController` with the admin Safe as proposer, the
   second Safe as canceller.
3. Deploy `InsurancePolicy` (implementation + `ERC1967Proxy`), passing
   the `TimelockController`'s address as `timelockAdmin`.
4. Deploy `ClaimRegistry` the same way, additionally passing the
   deployed token address and the `InsurancePolicy` proxy address.
5. Deploy `OracleAdapter` the same way, passing the `ClaimRegistry`
   proxy address.
6. Grant roles: `PAUSER_ROLE` to fast-response signers,
   `UNDERWRITER_ROLE` to an underwriter Safe (a **third**, distinct
   Safe), `POLICY_MANAGER_ROLE` to a business-ops Safe, `ORACLE_ROLE` on
   `ClaimRegistry` to the deployed `OracleAdapter`'s **proxy** address,
   and `ORACLE_SIGNER_ROLE` on `OracleAdapter` to your oracle service's
   actual signing address (derived in Step 4 below).
7. Verify the original deployer key holds **none** of these roles
   afterward.

Note every deployed proxy address — you'll need all three
(`InsurancePolicy`, `ClaimRegistry`, `OracleAdapter`) in every following
step.

## Step 4 — Derive local test accounts (for oracle-service and testing)

```bash
cd ../oracle-service
npm install
node -e "
const {ethers} = require('ethers');
const m = 'test test test test test test test test test test test junk';
console.log('signer :', ethers.HDNodeWallet.fromPhrase(m, undefined, \"m/44'/60'/0'/0/0\").privateKey);
console.log('relayer:', ethers.HDNodeWallet.fromPhrase(m, undefined, \"m/44'/60'/0'/0/1\").privateKey);
"
```
Grant `ORACLE_SIGNER_ROLE` (Step 3.6 above) to the address matching the
"signer" key printed here before continuing.

## Step 5 — Configure and start the backend

```bash
cd ../backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```
Edit `.env`:
- `SECRET_KEY` — generate via `python -c "import secrets; print(secrets.token_hex(32))"`
- `ORACLE_SERVICE_API_KEY` — generate via `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, remember this exact value for Step 6
- `INDEXER_WEBHOOK_API_KEY` — generate the same way, remember for Step 7

```bash
pytest -v
uvicorn app.main:app --reload
```
Leave running. Confirm `http://localhost:8000/health` responds.

## Step 6 — Configure and start the oracle service

```bash
cd ../oracle-service
cp .env.example .env
```
Edit `.env`:
- `ORACLE_ADAPTER_ADDRESS` — from Step 3
- `ORACLE_SIGNER_PRIVATE_KEY` / `RELAYER_PRIVATE_KEY` — from Step 4
- `ORACLE_SERVICE_API_KEY` — **the exact same value** set in the backend's `.env` in Step 5

```bash
npm test
npm run test:integration   # optional but recommended — requires anvil/forge
npm start
```
Leave running. Confirm `http://localhost:4100/health` responds.

## Step 7 — Configure and start the indexer

```bash
cd ../indexer
npm install
cp .env.example .env
```
Edit `.env`:
- `CLAIM_REGISTRY_ADDRESS` / `INSURANCE_POLICY_ADDRESS` — from Step 3
- `BACKEND_WEBHOOK_API_KEY` — **the exact same value** as the backend's `INDEXER_WEBHOOK_API_KEY` from Step 5

```bash
npm test
npm run test:integration   # optional but recommended — requires anvil, forge, and a reachable Postgres
npm start
```
Leave running.

## Step 8 — Configure and start the frontend

```bash
cd ../frontend
npm install
cp .env.example .env
```
Edit `.env`:
- `VITE_CLAIM_REGISTRY_ADDRESS` — from Step 3
- `VITE_CHAIN_ID` — `1337` (matches the local Besu network)
- `VITE_CHAIN_RPC_URL` — `http://localhost:8545`

```bash
npm test
npm run dev
```
Open the printed local URL. In your browser wallet, add a network
matching `VITE_CHAIN_RPC_URL`/`VITE_CHAIN_ID`, and import a funded
account (e.g. one of Besu's or Anvil's funded local accounts).

## Step 9 — Exercise the full flow manually

1. Connect wallet (top-right button) — this signs a login message and
   authenticates against the backend.
2. Go to "File a Claim," enter a policy ID that's been registered
   (Step 3), an amount, and a description; submit.
3. Confirm the wallet transaction prompt for `submitClaim` — approve it.
4. Wait a few seconds (the indexer's poll interval), then check
   "Dashboard" — the claim should show its on-chain claim ID and
   transaction hash once the indexer has synced it.
5. Go to "Claim Status," search for the claim by its backend ID, and
   click "Trigger Verification" — this calls the backend, which calls
   the oracle service, which signs and submits an on-chain verification.
6. Refresh/re-search after a few seconds — the status should now read
   "Approved" or "Rejected" depending on the mock decision logic's
   placeholder threshold.

---

## Alternative: docker-compose (once Steps 1–4 are done manually)

After the chain is running and contracts/roles are deployed (Steps 1–4
above still have to happen first — the root `docker-compose.yml` does
not start the chain or deploy contracts):

```bash
cd .. # the shared parent directory containing docker-compose.yml
cp .env.example .env   # fill in every value per its inline comments
docker compose up --build
```

This starts Postgres, backend, oracle-service, indexer, and frontend
together, wired via the environment variables in that root `.env`.

---

## Consolidated next actions (across all three projects)

In priority order:

1. **Actually run everything and fix whatever breaks.** Every line of
   documentation in the three explanatory documents was produced from
   logical review of the code, not from a confirmed passing execution —
   this is stated plainly rather than implied otherwise, and it remains
   the single highest-value next action.
2. **Deploy a real Safe + TimelockController** — every contract's role
   model assumes this, but no script in this bundle automates it; Step 3
   above is currently a manual, error-prone process that should be
   scripted.
3. **Build the document/evidence upload pipeline** — spans Projects 2
   (backend) and 3 (frontend); currently a labeled placeholder on both
   sides.
4. **Build a periodic reconciliation job** comparing the indexer's
   on-chain mirror against the backend's off-chain claim table directly
   — currently only a one-way, best-effort webhook push.
5. **Move every secret out of `.env` files** (oracle signer key, all
   three shared API keys) into a real secrets manager (Vault/AWS Secrets
   Manager/KMS) before any shared or persistent deployment.
6. **Build an underwriter/reviewer UI** — approving/rejecting a claim
   currently has no interface anywhere in this system; it only happens
   via direct contract calls in tests.
7. **Get an independent security review** of all three contracts before
   any deployment beyond a local/throwaway network — repeatedly called
   for throughout this project's own documentation, not yet done.
8. **Set up CI** (GitHub Actions) running each project's test suite on
   every change — none exist as `.github/workflows/*.yml` files yet,
   despite being planned in detail earlier in this project's history.
9. Deep reorg recovery in the indexer, live-updating frontend status,
   component/E2E tests for the frontend, rate limiting on public backend
   endpoints, and the Terraform/Ansible/monitoring stack for a shared
   (non-local) environment — all real, all lower-urgency than the items
   above for a project at this stage.

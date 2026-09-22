# 01 — `backend` (Python/FastAPI): Run & Test Locally

## Communicates with (see `00-Communication-Map.md` for the full picture)
- **Chain** (`InsurancePolicy`) — read-only, via `web3_client.py`
- **`oracle-service`** — `POST /verify`, to trigger claim verification
- **`indexer`** — receives its webhook at `POST /internal/onchain-events`
- **`frontend`** — serves it via REST

## Run locally

```bash
cd backend
python -m venv .venv
source .venv/bin/activate        # .venv\Scripts\Activate.ps1 on Windows
pip install -r requirements.txt
cp .env.example .env
# Fill in: SECRET_KEY, ORACLE_SERVICE_API_KEY (must match oracle-service/.env
# exactly), INDEXER_WEBHOOK_API_KEY (must match indexer/.env exactly),
# INSURANCE_POLICY_ADDRESS, RPC_URL
uvicorn app.main:app --reload
```

Runs against SQLite by default if `DATABASE_URL` isn't overridden —
fine for a quick check; use the docker-compose Postgres for anything
closer to the real setup (the indexer and this backend need to share
one Postgres instance for the webhook link to mean anything).

Verify it's up: `curl http://localhost:8000/health` → `{"status":"ok"}`.

## Run the tests

```bash
pytest -v
```

No external services required at all. `tests/conftest.py` gives each
test an isolated in-memory SQLite database, and the oracle-service HTTP
call is mocked with `respx` — matching that service's real `/verify`
contract closely enough that a breaking change on either side should
fail these tests loudly. `test_policies.py` additionally mocks the
chain connection itself (see `docs/tests-explained/12`) — no RPC node
needs to be running either.

**What running this does NOT verify**: a real `oracle-service` process
actually responding, or a real chain actually being reachable. Those
require the docker-compose stack up and running — see document `09`.

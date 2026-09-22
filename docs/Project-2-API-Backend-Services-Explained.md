# Project 2 — API / Backend Services: Explanatory Document

**Directory bundle:** `backend/` (Python/FastAPI) + `oracle-service/`
(Node.js) + `indexer/` (Node.js)
**Why bundled together:** all three are server-side services that
support the API layer the frontend talks to (directly, in the backend's
case) or that talk to each other behind the scenes (oracle-service and
the indexer are both called by, or call, the backend). None of the three
render any UI.

---

## Part A: `backend/` (FastAPI)

### What this project is for
The only service the frontend talks to directly. Handles wallet-signature
authentication, claim CRUD, triggers oracle verification (calling
oracle-service over HTTP), and receives on-chain state updates from the
indexer (via a webhook). It does **not** talk to the blockchain directly
at all — no RPC connection anywhere in this service.

### EIPs used, and why
| EIP | Where | Why |
|---|---|---|
| **EIP-191** | `app/auth.py`, via `eth_account`'s `encode_defunct` | The "personal sign" message format — the standard way a wallet signs a plain human-readable string (the login nonce message) rather than raw arbitrary bytes, which is what lets MetaMask show a readable prompt instead of a hex blob. |

Backend has no EIP-712 or EIP-1967/1822 usage — those belong to the
contracts (Project 1) and the oracle service (below), not here.

---

### `backend/app/config.py`
**Purpose:** the single source of runtime configuration, validated at
startup via `pydantic-settings`.

**Imports:**
- `pydantic_settings.BaseSettings, SettingsConfigDict` — the library that
  reads environment variables (and an optional `.env` file) into a typed,
  validated Python object.

**The `Settings` class, field by field:**
- `secret_key: str` — has **no default value**, meaning Pydantic requires
  it to be set or the app fails to start immediately. This is deliberate:
  a JWT-signing secret with an insecure built-in default is a real
  vulnerability class, so the code is written to make that mistake
  impossible rather than merely discouraged.
- `database_url` — defaults to a local SQLite file for zero-setup local
  runs; overridden to Postgres in `docker-compose.yml`.
- `login_message_prefix` — the exact text prefix every wallet-signed
  login message starts with. The comment above it explains this must
  match, character-for-character, whatever the frontend asks the wallet
  to sign — a single extra space here would make every signature fail to
  verify with no obvious cause.
- `oracle_service_url`, `oracle_service_api_key` (required, no default),
  `oracle_service_timeout_seconds` — everything needed to call
  oracle-service.
- `indexer_webhook_api_key` (required, no default) — the shared secret
  the indexer must present to call this backend's internal webhook.

`settings = Settings()` at the bottom is what actually triggers
validation — this line runs the moment this module is first imported
anywhere in the app, which is why every test file's `conftest.py` sets
required environment variables *before* any import of `app.config` (see
the backend testing section below).

---

### `backend/app/db.py`
**Purpose:** sets up the async SQLAlchemy engine/session and exposes the
`get_db` FastAPI dependency every route uses to get a database session.

**Imports:**
- `AsyncSession, async_sessionmaker, create_async_engine` from
  `sqlalchemy.ext.asyncio` — SQLAlchemy 2.0's async API.

**Functions:**
- `get_db()` — an `async def` generator. FastAPI's dependency injection
  calls this, receives the yielded session, passes it into the route
  function, and — because it's a generator with a `yield` — automatically
  runs whatever comes *after* the `yield` (nothing here, but the
  `async with` block's own cleanup) once the route finishes, closing the
  session either way.
- `init_db()` — creates all tables from the SQLAlchemy `Base` metadata.
  Called once at app startup (see `main.py`'s `lifespan`).

The module-level comment explains a deliberate constraint: no
Postgres-specific column types are used anywhere in `models.py`, so this
same code runs against SQLite (fast, no-setup tests) and Postgres
(docker-compose) without any conditional logic.

---

### `backend/app/models.py`
**Purpose:** every database table, as SQLAlchemy ORM classes.

**Imports:**
- `sqlalchemy` column types (`JSON, Boolean, DateTime, Enum, Float,
  ForeignKey, Integer, String`) and `DeclarativeBase, Mapped,
  mapped_column, relationship` — SQLAlchemy 2.0's typed declarative
  mapping style, where a class attribute's Python type annotation
  (`Mapped[int]`, `Mapped[str | None]`) drives the actual SQL column
  definition.

**`Base`** — the declarative base class every model inherits from;
`Base.metadata.create_all` (used in `init_db`) walks every subclass of
this to know what tables to create.

**`_utcnow()`** — a tiny helper returning the current UTC time, used as
the `default=` for every `created_at`/`updated_at` column. Written as a
named function (not an inline lambda) specifically so SQLAlchemy calls it
fresh at insert time rather than capturing one fixed timestamp at class-
definition time — a very common and easy-to-miss bug if you write
`default=datetime.now(timezone.utc)` directly instead.

**`ClaimStatus(str, enum.Enum)`** — six string values (`draft`,
`submitted`, `under_review`, `approved`, `rejected`, `paid`). The `str`
mixin means these serialize to JSON as their plain string value (e.g.
`"approved"`), not as `"ClaimStatus.APPROVED"`. These exact string values
were deliberately chosen to match the indexer's `CLAIM_STATUS_NAMES`
array one-for-one (see the indexer section below), so the webhook that
connects the two services needs no translation table.

**`Claim`** — the central table. Notable fields: `merkle_root` (nullable
— a claim can exist as a draft before evidence is ready),
`onchain_claim_id`/`tx_hash` (both nullable — populated later, by the
indexer's webhook, once the on-chain transaction is actually confirmed
and observed), `oracle_request_id` (populated by `trigger-verification`).
`documents` is a SQLAlchemy `relationship` — not a real column, but an
ORM-level link letting Python code write `claim.documents` to get the
related `ClaimDocument` rows, with `cascade="all, delete-orphan"` meaning
deleting a claim deletes its documents too.

**`ClaimDocument`** — one row per uploaded evidence file's *metadata*
(filename, hash, CID, Merkle proof) — no file content is ever stored
here (see "still open" in the backend README: there's no actual file
upload built yet, so this table currently only ever receives whatever
metadata the frontend sends, which today is a placeholder).

**`IdempotencyKey`** — backs the idempotency protection on
`trigger-verification`. The doc-comment explains a real architectural
pivot: earlier project planning assumed idempotency would guard a
backend-orchestrated *payout* endpoint, but the system that actually got
built has underwriters paying out directly via a Safe/contract, not
through this API — so this table protects the endpoint that actually
matters in the system as built, and the comment says so explicitly
rather than pretending the original plan was followed unchanged.

**`WalletNonce`** — one row per wallet address, storing its current
single-use login nonce and expiry. The doc-comment explains this
replaced an original Redis-based design: a database row with an
`expires_at` column gives the same single-use, time-bound guarantee
without making Redis a hard dependency just to run the test suite.

---

### `backend/app/schemas.py`
**Purpose:** every Pydantic request/response model — the "shape" layer
between raw HTTP JSON and the ORM models above.

**Imports:** `pydantic.BaseModel, Field` and `app.models.ClaimStatus`
(reused directly as a field type, so a response's `status` field is
validated as one of the six real enum values, not any arbitrary string).

Each class, briefly:
- `NonceResponse` — includes `message`, the *exact* string the wallet
  must sign, computed server-side and handed to the frontend, specifically
  so the frontend never has to reconstruct that string itself and risk a
  mismatch (see the design principle repeated throughout this whole
  project: never let two sides independently reconstruct a value that
  must match exactly).
- `WalletLoginRequest` — both fields use `Field(pattern=...)` — a regex
  constraint enforced by Pydantic itself, before the route function's
  own logic ever runs, rejecting an obviously malformed address or
  signature immediately with a clear 422 error.
- `TokenResponse`, `DocumentIn`, `CreateClaimRequest`, `DocumentOut`,
  `ClaimOut`, `TriggerVerificationResponse` — straightforward request/
  response shapes. `ClaimOut` and `DocumentOut` both set
  `model_config = {"from_attributes": True}` — this is what lets FastAPI
  build these response objects directly from SQLAlchemy ORM instances
  (which have Python attributes, not dict keys) rather than requiring a
  route to manually convert every field.

---

### `backend/app/auth.py`
**Purpose:** the actual wallet-signature authentication logic — nonce
issuance, ECDSA signature verification, JWT issuance/validation.

**Imports:**
- `eth_account.Account`, `eth_account.messages.encode_defunct` — the
  library that implements EIP-191 message encoding and ECDSA signature
  recovery.
- `jose.jwt, jose.JWTError` — JWT encode/decode.
- `sqlalchemy` bits for querying `WalletNonce`.

**`build_login_message(nonce)`** — returns
`f"{settings.login_message_prefix} {nonce}"`. This one-line function is
the single source of truth for the exact signed string — every other
place that needs this string (the `/auth/nonce` route, this file's own
verification logic) calls this function rather than reconstructing the
format themselves.

**`generate_nonce(db, address)`** — generates a random 32-character hex
string (`secrets.token_hex(16)`), computes an expiry 5 minutes out, and
either updates the existing `WalletNonce` row for this address or
inserts a new one. Note it always **overwrites** any previous nonce for
that address — a second `/auth/nonce` call for the same address
invalidates whatever nonce was issued before it, which is a deliberate
simplification (only the most recently issued nonce for an address is
ever valid).

**`verify_signature_and_consume_nonce(db, address, signature)`** — the
security-critical function. Walking through it:
1. Look up the stored nonce record; fail if none exists or it's already
   used.
2. Check expiry, being careful to handle SQLite's tendency to return a
   naive (no-timezone) datetime even though the column is declared
   `timezone=True` — the code explicitly re-attaches UTC if `tzinfo` is
   `None`, a defensive fix for a real SQLite quirk.
3. Reconstruct the exact signed message via `build_login_message`.
4. Attempt `Account.recover_message` inside a `try/except` — a
   malformed signature raises an exception here.
5. **Regardless of whether recovery succeeded or raised**, mark the
   nonce as used and commit. The comment directly above this explains
   this was an actual bug fix made during development: an earlier
   version only marked the nonce used on the success path, meaning a
   malformed signature could be retried indefinitely against the same
   still-valid nonce — fixed so a nonce is burned by any attempt, valid
   or not.
6. Only after committing does it return whether the recovered address
   actually matches the claimed address.

**`create_access_token(address)`** — builds a JWT with `sub` (subject —
the wallet address), `iat` (issued-at), and `exp` (expiry, `jwt_exp_minutes`
from config), signed with `settings.secret_key`.

**`get_current_address(authorization)`** — the FastAPI dependency every
protected route uses. Checks the header starts with `"Bearer "`, decodes
the JWT (catching `JWTError` for anything malformed or expired), and
returns the `sub` claim — the authenticated wallet address.

---

### `backend/app/oracle_client.py`
**Purpose:** the HTTP client calling oracle-service's `/verify` endpoint
— this is the concrete code implementing the contract documented in
oracle-service's own README.

**Imports:** `httpx` (async HTTP client) and `app.config.settings`.

**`OracleServiceError`** — a single custom exception type. The design
choice here: every possible failure mode (network error, wrong API key,
non-200 response, malformed response body) gets wrapped into this one
exception type before it reaches the calling route, so `claims_routes.py`
only needs one `except` clause, not four.

**`OracleVerificationResult`** — a plain dataclass holding the four
fields this backend actually cares about from oracle-service's response.

**`request_verification(claim_id, declared_amount, evidence_summary)`**
— walking through it: builds the request body and the
`X-Oracle-Service-Key` header, wraps the actual HTTP call in a
`try/except httpx.RequestError` (network-level failures — DNS, connection
refused, timeout — all raise this in httpx), then specifically checks for
a `401` response and raises a distinctly-worded error for it (because a
401 here means *this backend's* configured API key doesn't match
oracle-service's — a deployment misconfiguration, not a claim-specific
rejection, and the code deliberately doesn't let those two very different
situations look the same in logs), then checks for any other non-200
status, then parses the JSON body and catches a `KeyError` if the
expected fields aren't present (oracle-service returning an unexpected
shape) — every failure mode ends up as an `OracleServiceError` with a
message that actually says which failure mode it was.

---

### `backend/app/idempotency.py`
**Purpose:** the two small functions backing the `Idempotency-Key` header
support on `trigger-verification`.

**`get_cached_response(db, key, endpoint)`** — looks up a stored
`IdempotencyKey` row by its key; returns `None` (meaning "not cached,
proceed normally") if there's no row, **or** if the row exists but was
stored for a *different* endpoint (a deliberate safety check — the
comment explains this treats a misused key, reused across different
endpoints, as a fresh request rather than silently returning the wrong
cached data for this endpoint).

**`store_response(db, key, endpoint, status_code, body)`** — checks
whether a row already exists for this key first, and does nothing if so
(`return` early) — this is what makes concurrent duplicate requests
safe: whichever request's database write actually lands first "wins,"
and a second concurrent request won't overwrite it with a possibly-
different result.

---

### `backend/app/internal_auth.py`
**Purpose:** the auth check for the indexer's inbound webhook call —
structurally identical in spirit to oracle-service's own API-key
middleware, implemented in Python here since this is the backend.

**Imports:** `hmac` (Python's standard library constant-time comparison
module) and `fastapi.Header, HTTPException`.

**`require_indexer_webhook_key(x_indexer_webhook_key)`** — checks the
header is present, then uses `hmac.compare_digest` (not `==`) to compare
it against the configured key. `compare_digest` takes the same amount of
time to run regardless of *where* the first mismatched character is,
which is what prevents an attacker from using response-timing
differences to guess the secret one character at a time — the same
reasoning oracle-service's JavaScript equivalent (`timingSafeEqual`)
uses.

---

### `backend/app/routes/auth_routes.py`
**Purpose:** the two HTTP endpoints implementing wallet login.

**Imports:** the functions from `app.auth`, and the Pydantic schemas
they need.

**`GET /auth/nonce`** — takes `address` as a query parameter (itself
regex-validated by `Query(pattern=...)`), calls `generate_nonce`, and
returns the nonce plus the exact message to sign.

**`POST /auth/wallet`** — takes the validated `WalletLoginRequest` body,
calls `verify_signature_and_consume_nonce`, and either raises a `401` or
returns a fresh JWT via `create_access_token`.

---

### `backend/app/routes/claims_routes.py`
**Purpose:** claim CRUD plus the oracle-verification trigger — the
busiest route file in the backend.

**`GET /claims`** (list) — filters by `claimant_address == claimant` (the
authenticated user's own address, from the JWT), ordered newest-first.
Notably this endpoint was added *after* the frontend was built, once it
became clear the Dashboard page had nothing to call — flagged explicitly
in this project's own history as a gap noticed and closed, not part of
the original design.

**`POST /claims`** (create) — creates the `Claim` row, calls
`await db.flush()` (not yet `commit()`) specifically so `claim.id` gets
populated by the database *before* the code tries to create
`ClaimDocument` rows that reference that ID via `claim_id=claim.id` —
flushing sends the pending SQL to the database without ending the
transaction, whereas `commit()` would end it.

**`GET /claims/{claim_id}`** — a straightforward lookup by primary key
(`db.get`), 404 if missing, with an explicit `db.refresh(...,
attribute_names=["documents"])` to force-load the related documents
(SQLAlchemy's async mode doesn't lazily auto-load relationships the way
sync mode sometimes does, so this must be requested explicitly).

**`POST /claims/{claim_id}/trigger-verification`** — the most important
function in this file. Walking through it:
1. If an `Idempotency-Key` header was sent, check the cache first — if a
   cached response exists for this exact key+endpoint pair, return it
   immediately without touching the oracle service at all.
2. Look up the claim; 404 if missing.
3. Call `oracle_client.request_verification`, catching
   `OracleServiceError` and re-raising it as an HTTP `502` (not `500`) —
   the code comment explains this distinction matters: a 502 correctly
   signals "a service this backend depends on failed," not "this
   endpoint's own logic has a bug."
4. Update the claim's `status`, `oracle_request_id`, and `tx_hash` from
   the result, commit.
5. Build the response object, and — only if an idempotency key was
   provided — store it for future duplicate requests.

---

### `backend/app/routes/internal_routes.py`
**Purpose:** the one endpoint the indexer calls — closing the loop
between on-chain events and this backend's off-chain claim records.

**`OnchainEventNotification`** — the request body shape, matching
exactly what `indexer/src/backendClient.js` sends.

**`POST /internal/onchain-events`** — protected by
`Depends(require_indexer_webhook_key)`. Looks up the claim by
`merkle_root` (the correlation key — see the frontend/indexer sections
for why this specific field was chosen). Three possible outcomes, each
returned as a distinct status string rather than an error, because all
three are legitimate, expected situations, not bugs: no matching claim
found (the off-chain record may not exist yet, or ever); an
unrecognized status string (a translation-mismatch safety net, even
though the enum values were deliberately kept in sync with the
indexer's); or success, updating `onchain_claim_id`, `tx_hash`, and
`status`.

---

### `backend/app/main.py`
**Purpose:** the actual FastAPI application object and startup wiring.

**`lifespan(app)`** — an async context manager FastAPI calls at startup
(everything before `yield`) and shutdown (after, though nothing happens
there currently). Calls `init_db()` once.

The rest wires in CORS middleware (wide open — `allow_origins=["*"]` —
explicitly flagged in the README as fine for local dev only) and includes
all three route modules (`auth_routes`, `claims_routes`,
`internal_routes`).

---

### `backend/tests/`
**`conftest.py`** — sets required environment variables *before*
importing anything from `app`, then defines two fixtures: `db_session`
(a fresh in-memory SQLite database per test, using `StaticPool` so the
same in-memory database persists across the multiple connections
SQLAlchemy's async engine opens during one test — without `StaticPool`,
each connection would see an empty database) and `client` (an `httpx`
`AsyncClient` wired directly to the FastAPI app via `ASGITransport`, with
`get_db` overridden to use the test's isolated session). A third fixture,
`auth_headers`, performs a complete real nonce-and-signature login flow
and returns ready-to-use headers, so tests that need a logged-in user
but aren't themselves testing login don't have to repeat that flow.

**`test_auth.py`** — the full login flow with a real generated key pair;
wrong-signer rejection; nonce-replay rejection after a successful login;
missing-token rejection on a protected route; and the malformed-signature
regression test proving the nonce-consumption bug fix actually works.

**`test_claims.py`** — create/get/list claims; the full
trigger-verification flow with `respx` mocking the oracle service HTTP
call (both approved and rejected outcomes); oracle-service-unreachable
returning 502; and two idempotency tests — one proving the *same* key
prevents a duplicate oracle call, one proving *different* keys both
execute normally.

**`test_oracle_client.py`** — unit tests for `oracle_client.py` in
isolation: success, the distinctly-worded 401 case, a generic upstream
error, a connection failure, and a malformed response body.

**`test_internal_routes.py`** — the webhook's own auth (missing/wrong
key rejected), a successful update when a matching claim exists, and the
two graceful non-error outcomes (no matching claim, unrecognized status).

---

## Part B: `oracle-service/` (Node.js)

### What this project is for
Evaluates a claim (via a clearly-labeled mock decision function, standing
in for a real external verification source) and produces a
cryptographically signed, on-chain-verifiable attestation of that
decision — then relays it to the deployed `OracleAdapter` contract.

### EIPs used, and why
| EIP | Where | Why |
|---|---|---|
| **EIP-712** | `src/signer.js` | Must produce a signature that `OracleAdapter.sol` (Project 1) can verify — the domain, types, and struct shape here are the JavaScript mirror of that contract's Solidity-side EIP-712 setup, and must match it exactly. |
| **EIP-1193** | Indirectly, via `ethers` | Not used directly in this service's own code (this is a server, not a browser), but `ethers.Wallet` and `JsonRpcProvider` implement the same underlying JSON-RPC method conventions this EIP standardized for browser wallets. |

---

### `oracle-service/src/config.js`
**Purpose:** validated environment configuration, using `zod` for
runtime schema validation (this project's JavaScript policy explicitly
calls for runtime validation of external input, and environment
variables count as external input under that policy).

**Imports:** `dotenv/config` (loads a `.env` file's contents into
`process.env` as a side effect of being imported), `zod`.

**`envSchema`** — a `zod` object schema. Notably `CHAIN_ID` and `PORT`
use `z.coerce.number()` — environment variables are always strings, so
this coerces `"1337"` into the actual number `1337`, failing validation
if the string isn't a valid number at all.

**`loadConfig()`** — parses `process.env` against the schema; on
failure, prints the detailed error and calls `process.exit(1)` —
deliberately crashing immediately at startup rather than limping along
with `undefined` values that would fail confusingly later. Also contains
a specific check: if `RELAYER_PRIVATE_KEY` is unset, it falls back to
reusing `ORACLE_SIGNER_PRIVATE_KEY` but prints a warning explaining why a
separate relayer key is the better setup beyond local development (the
relayer only needs gas funds, no privileged role, so keeping the two
separate limits what's exposed if the relayer's environment specifically
is compromised).

`export const config = loadConfig();` — like the backend's
`settings = Settings()`, this line is what actually triggers validation
at import time.

---

### `oracle-service/src/signer.js`
**Purpose:** the EIP-712 signing logic — the JavaScript half of the
signature scheme `OracleAdapter.sol` verifies.

**Imports:** `ethers`, and `config` from the file above.

**`ORACLE_RESPONSE_TYPES`** — the EIP-712 type definition, as a plain
JS object `ethers` understands. The comment above it is explicit that
this must match `OracleAdapter.sol`'s typehash-generating string exactly,
field name and order both.

**`buildDomain()`** — constructs the EIP-712 domain object
(`name, version, chainId, verifyingContract`). The comment explains this
is the single riskiest point of mismatch in the whole signing flow — get
any one of these four fields wrong relative to the actual deployed
contract, and `ecrecover` on-chain silently returns the wrong address
(not an error) — which then surfaces only as `UnauthorizedSigner`,
looking like a permissions problem rather than a configuration typo.

**`signOracleResponse(wallet, payload)`** — one line:
`wallet.signTypedData(domain, ORACLE_RESPONSE_TYPES, payload)` — ethers'
built-in EIP-712 signing, doing the hashing and signing this function
delegates to.

**`recoverSigner(payload, signature)`** — the inverse operation, using
`ethers.verifyTypedData`. Exists specifically as a debugging tool: if
`OracleAdapter` ever rejects a submission with `UnauthorizedSigner`,
running this function locally against the same payload tells you exactly
which address your key actually produced, rather than guessing.

**`getSigningWallet(provider)` / `getRelayerWallet(provider)`** — both
just construct an `ethers.Wallet` from a private key in config. The
extensive comment on `getSigningWallet` explains this is the **one seam**
to change when moving beyond local development: swap the body to pull a
signer from HashiCorp Vault's transit engine or an AWS KMS SDK client,
keep the same return type (anything with a `.signTypedData` method), and
nothing else in this file or its callers needs to change.

---

### `oracle-service/src/verificationLogic.js`
**Purpose:** the actual claim-approval decision — explicitly and
repeatedly labeled as a **mock**, the same way `MockOracle.sol` is
labeled in Project 1.

**`evaluateClaim(evidence)`** — checks `declaredAmount` is a positive
number, then applies a single placeholder threshold
(`MOCK_APPROVAL_THRESHOLD = 100_000`) purely so a demo produces both
approve and reject outcomes rather than always returning `true`. The
comment is explicit that this whole function body should be replaced
with a call to a real external verification source (an insurer's claims
system, a weather API, a human review queue) — this is not meant to
resemble real underwriting logic.

---

### `oracle-service/src/chainClient.js`
**Purpose:** the actual blockchain connection and transaction submission.

**`ORACLE_ADAPTER_ABI`** — a minimal, hand-written ABI fragment (just the
one function and one event this service needs) rather than importing a
full compiled contract artifact — the comment flags this as
"structurally, not nominally" coupled to the real contract: if
`OracleAdapter.sol`'s `submitVerification` signature ever changes, this
must be updated by hand, in lockstep.

**`getProvider()`** — a lazily-created, cached `ethers.JsonRpcProvider`
(the `let _provider` module-level variable means the connection is only
created once, reused across calls).

**`getOracleAdapterContract()`** — builds an `ethers.Contract` instance
connected with the *relayer* wallet specifically (not the signer wallet)
— since submitting a transaction requires paying gas, and the relayer
key is the one meant to hold funds for that.

**`submitVerificationOnChain(response, signature)`** — calls
`contract.submitVerification(response, signature)` and awaits one
confirmation (`tx.wait(1)`) before returning the receipt.

---

### `oracle-service/src/auth.js`
**Purpose:** the API-key middleware protecting `/verify` — the fix for
the security gap flagged and closed partway through this project's
build (an earlier version of this service had no authentication on this
endpoint at all).

**Imports:** `node:crypto`'s `timingSafeEqual`, and `config`.

**`requireApiKey(req, res, next)`** — an Express middleware function.
Reads the `X-Oracle-Service-Key` header; if missing, responds `401`
immediately. Otherwise converts both the provided and expected key into
`Buffer`s and checks their lengths match *before* calling
`timingSafeEqual` (which throws, rather than returning `false`, if given
two buffers of different lengths — so the length check has to happen
first). The extensive comment explains the defense-in-depth framing:
this stops an unauthenticated caller that has network reach to this
service; it does not replace *not having* that network reach in the
first place, which should also be enforced at the infrastructure level
in any shared environment.

---

### `oracle-service/src/server.js`
**Purpose:** the actual Express HTTP server tying every other module
together.

**`verifyRequestSchema`** — a `zod` schema validating the `/verify`
request body — runtime-validating input at the API boundary, per this
project's stated JavaScript policy.

**`issuedRequestIds` / `generateRequestId()`** — an in-memory `Set`
tracking request IDs this specific process has generated, purely as a
development-time sanity check. The comment is explicit this is **not**
the real replay-protection boundary (that's enforced on-chain, in both
`OracleAdapter` and `ClaimRegistry`, and survives a process restart,
unlike this in-memory set).

**`GET /health`** — deliberately **not** behind `requireApiKey` — a load
balancer or Kubernetes liveness probe needs to reach this without a
secret, and it reveals nothing sensitive.

**`POST /verify`** — the main flow: validate the request body; call
`evaluateClaim`; generate a request ID and current timestamp
("promptly," per the comment, since the contract's expiry window starts
counting from this timestamp, not from whenever the transaction actually
lands); sign the payload; submit it on-chain; return the result. The
`catch` block logs the real error server-side but returns a generic `502`
with only a safe-to-expose message to the caller — a form of centralized
error handling, deciding once what's safe to reveal rather than letting
every call site make that decision inconsistently.

The bottom of the file guards `app.listen(...)` behind a check that this
file is actually the process entry point (`process.argv[1]` ends with
`server.js`) — added specifically so the integration test can `import`
the `app` object for testing without also trying to bind a real network
port every time.

---

### `oracle-service/test/`
**`signer.test.js`** — pure unit tests: sign then recover round-trips to
the same address; tampering with any field of the payload (or the
`requestId`) after signing causes recovery to produce a *different*
address, proving the signature is genuinely bound to the exact payload
content.

**`auth.test.js`** — the four cases for the API-key middleware: missing
key, wrong key, wrong-length key, and the correct key (verifying `next()`
is called exactly once and no error response is sent).

**`oracle.integration.test.js`** — the real end-to-end test: spawns a
real `anvil` process, deploys a real `OracleAdapter` via
`forge script` (Project 1's `DeployIntegrationFixture.s.sol`), derives
test accounts from Anvil's well-known default mnemonic (deliberately
*not* a hardcoded hex private key — see Project 1's document for why that
distinction mattered enough to be called out explicitly during
development), then runs the actual HTTP server against that real chain
and asserts: a valid claim gets approved and the mock sink receives the
call; an over-threshold claim gets rejected and that's recorded on-chain
too; a missing API key is rejected *before* any on-chain call happens
(proven by checking the sink's call count doesn't increment); replaying
the exact same signed response reverts on the real chain the second
time; advancing real Anvil block time past the validity window causes
the real contract to reject an otherwise-valid response; and a signature
from an address without `ORACLE_SIGNER_ROLE` is rejected by the real
contract.

---

## Part C: `indexer/` (Node.js)

### What this project is for
Scans the blockchain for events emitted by `ClaimRegistry` and
`InsurancePolicy`, persists them into its own Postgres tables (a
purpose-built mirror of on-chain truth), and notifies the backend via
webhook whenever a claim's state changes on-chain — closing the loop that
was, for a while during this project's build, an actual missing piece
(the backend had columns for `onchain_claim_id`/`tx_hash` that nothing
ever populated, until this service's webhook was built).

### EIPs used, and why
None directly — the indexer only *reads* events; it never signs anything
or submits a transaction, so none of the signing-related EIPs (191, 712)
apply here. It does rely on the same ABI-based event-decoding mechanics
`ethers` implements for any standard Solidity event log.

---

### `indexer/sql/schema.sql`
**Purpose:** the indexer's own database schema — plain SQL, run directly
(not through a migration framework), since this is a small, single-owner
schema.

**Tables:**
- `indexer_checkpoints` — one row per contract address, tracking
  `last_processed_block`. This is what lets the indexer resume correctly
  after a restart instead of rescanning from the beginning.
- `onchain_events` — every decoded event, raw. The
  `UNIQUE (tx_hash, log_index)` constraint is, per the comment directly
  above it, **the actual duplicate-event protection boundary** — not
  application-level "have I seen this" logic in JavaScript, but a
  database-enforced guarantee.
- `onchain_claims` — the indexer's mirror of claim state, one row per
  on-chain claim ID.
- `onchain_policies` — the equivalent mirror for policies.

The file's own top comment explains the ownership boundary: this schema
is deliberately separate from the backend's `claims` table (Part A above)
— two services shouldn't both own migrations for the same table.

---

### `indexer/src/config.js`
**Purpose:** validated environment configuration — the same `zod`-based
pattern as oracle-service's `config.js`, extended with indexer-specific
settings: `BLOCK_RANGE_CHUNK_SIZE` (how many blocks to request per
`eth_getLogs` call, since RPC providers enforce a maximum range),
`CLAIM_REGISTRY_DEPLOY_BLOCK`/`INSURANCE_POLICY_DEPLOY_BLOCK` (so a fresh
indexer doesn't scan from block zero on a long-lived chain), and
`REORG_SAFETY_BLOCKS` (a shallow reorg mitigation — see `listener.js`
below). Also validates that if `BACKEND_URL` is set, `BACKEND_WEBHOOK_API_KEY`
must be too (and vice versa isn't checked, but the pairing check exists
so a half-configured webhook doesn't silently fail every call with an
unauthenticated request).

---

### `indexer/src/db.js`
**Purpose:** the Postgres connection pool and schema bootstrap.

**`getPool()`** — lazily creates and caches a `pg.Pool` (connection
pool, not a single connection — allows multiple concurrent queries).

**`ensureSchema()`** — reads `sql/schema.sql` from disk and executes it
directly against the pool. Every statement in that file is
`CREATE TABLE IF NOT EXISTS`, so running this repeatedly (every time the
indexer starts) is safe.

**`closePool()`** — cleanly shuts down the pool; used by the integration
test's cleanup.

---

### `indexer/src/rpcClient.js`
**Purpose:** the blockchain connection and the ABI fragments for the two
contracts this service watches.

**`CLAIM_REGISTRY_ABI` / `INSURANCE_POLICY_ABI`** — hand-written,
events-only ABI fragments (this service never sends a transaction, only
reads logs) — the same "must stay in lockstep with the real contract"
caveat as oracle-service's ABI fragment.

**`CLAIM_STATUS_NAMES`** — a plain JavaScript array,
`['submitted', 'under_review', 'approved', 'paid', 'rejected']`. The
extensive comment explains this is not just documentation — Solidity's
`ClaimStatus` enum decodes over the wire as a plain integer (its position
in the enum), so this array's *order* is the actual mechanism mapping
that integer back to a name. If `ClaimRegistry.sol`'s enum were ever
reordered without updating this array to match, every decoded status
name would be silently wrong — no error, just incorrect data. A
dedicated unit test (`rpcClient.test.js`) exists specifically to catch
this class of drift.

**`getProvider()` / `getClaimRegistryContract()` /
`getInsurancePolicyContract()`** — construct and cache the RPC
connection and the two `ethers.Contract` instances used for event
decoding (never for sending transactions — this service is read-only
on-chain).

---

### `indexer/src/checkpoint.js`
**Purpose:** reading and writing each contract's scan progress.

**`getLastProcessedBlock(contractAddress)`** — returns `null` if no
checkpoint row exists yet, or the stored block number if one does. The
extensive comment explains this was a deliberate fix during development:
an earlier version returned the contract's *deploy block* as a sentinel
default when no checkpoint existed, which made it impossible for the
caller to distinguish "no checkpoint yet, start scanning at the deploy
block" from "a real checkpoint whose value happens to equal the deploy
block, resume one block *after* it" — those two cases need different
`+1` handling, and conflating them was a genuine off-by-one bug caught
while writing `listener.js`.

**`setLastProcessedBlock(contractAddress, blockNumber)`** — an "upsert"
(`INSERT ... ON CONFLICT ... DO UPDATE`) — works whether or not a
checkpoint row already exists for this contract.

---

### `indexer/src/backendClient.js`
**Purpose:** the outbound webhook call to the backend.

**`reportClaimEvent(event)`** — if `BACKEND_URL` isn't configured, logs
one warning (only once, via the module-level `warnedNoBackend` flag) and
does nothing further — this lets the indexer run standalone (useful for
just inspecting chain state) without requiring a backend to be running.
Otherwise, `fetch`es `POST {BACKEND_URL}/internal/onchain-events` with
the `X-Indexer-Webhook-Key` header. Critically, a failed webhook call is
**logged, not thrown** — the comment explains why: a backend notification
failure shouldn't crash the indexer's own event loop or block its
checkpoint from advancing; losing indexer progress on a real chain event
would be far worse than the backend's off-chain record staying
temporarily stale (which is recoverable later).

---

### `indexer/src/eventHandlers.js`
**Purpose:** the actual decode-and-persist logic for each event type.

**`persistRawEventOnce(log, eventName, contractAddress, data)`** — the
shared helper every handler calls first. Attempts an insert into
`onchain_events` with `ON CONFLICT (tx_hash, log_index) DO NOTHING`, then
checks `result.rowCount > 0` to know whether *this* call was the one
that actually inserted the row, versus a duplicate. This return value is
what each handler uses to decide whether to proceed with the
state-mutating side effects below it, or skip them (because this exact
event was already fully processed in an earlier run).

**`handleClaimSubmitted(log, args, contractAddress)`** — persists the
raw event; if new, inserts a fresh row into `onchain_claims` with status
`'submitted'`; then calls `backendClient.reportClaimEvent`.

**`handleClaimStatusChanged(log, args, contractAddress)`** — looks up
the new status name from `CLAIM_STATUS_NAMES` using the raw integer from
the event; persists the raw event; if new, `UPDATE`s the matching
`onchain_claims` row and `RETURNING merkle_root` in the same query
(avoiding a second round-trip just to fetch that value for the webhook
call). If no row was updated (0 rows matched), logs a warning rather than
silently doing nothing — this can legitimately happen if the scan window
started after the original submission, and the warning is a signal worth
investigating rather than hiding.

**`handleClaimPayout(log, args, contractAddress)`** — the same pattern,
setting status to `'paid'` and recording `payout_tx_hash`.

**`handlePolicyRegistered(log, args, contractAddress)` /
`handlePolicyRevoked(log, args, contractAddress)`** — the equivalent
handlers for the `InsurancePolicy` contract's two events. Notably these
do **not** call `reportClaimEvent` — the backend currently has no
concept of policies as its own entity to update (only claims), so
there's nothing to notify it about yet.

---

### `indexer/src/listener.js`
**Purpose:** the main scanning loop — the most complex file in this
service, and the one with a real, caught-and-fixed bug in it.

**`HANDLERS`** — a plain object mapping each event name string to its
handler function, used for dynamic dispatch after decoding a log.

**`scanContract(contract, deployBlock)`** — the core scanning function,
exported specifically so the integration test can call one scan pass
deterministically rather than racing a background poll interval.
Walking through it:
1. Gets the contract's address and the current chain head block number.
2. Computes `safeHead = currentHead - REORG_SAFETY_BLOCKS` — never
   scanning all the way to the literal chain tip, as a shallow mitigation
   against a very-recent block being reorged away moments after being
   read.
3. Calls `getLastProcessedBlock` and computes `fromBlock`: **if no
   checkpoint exists** (`checkpoint === null`), start at `deployBlock`
   itself (inclusive); **if a real checkpoint exists**, start at
   `checkpoint + 1`. The comment directly here explains this exact
   branch is the fix for the off-by-one bug described in
   `checkpoint.js`'s own comment above.
4. If there's nothing new to scan (`fromBlock > safeHead`), returns
   immediately with `scanned: 0`.
5. Otherwise, loops in chunks of `BLOCK_RANGE_CHUNK_SIZE`: calls
   `provider.getLogs({address, fromBlock: cursor, toBlock})`, and for
   each returned log, tries `contract.interface.parseLog(log)` — wrapped
   in a `try/catch` because a log from this same contract address that
   *isn't* one of the events this ABI fragment knows about would
   otherwise throw and crash the loop; such logs are simply skipped.
   Recognized events are dispatched to their handler via the `HANDLERS`
   lookup. After each chunk, `setLastProcessedBlock` advances the
   checkpoint — meaning a chunk, not a single log, is the unit of
   "safely resumable" progress.

**`runOnePass()`** — scans `InsurancePolicy` first, then `ClaimRegistry`
— the comment explains this ordering (not a hard on-chain dependency,
but a sensible one for any future consumer that expects a policy to
already be known before a claim referencing it appears).

**`mainLoop()`** — calls `ensureSchema()` once, then loops forever:
`runOnePass()`, log a summary if anything was processed, catch and log
any error **without exiting** (a transient RPC or DB blip should be
retried on the next interval, not crash the whole process), then sleep
for `POLL_INTERVAL_MS`.

The bottom of the file guards the actual `mainLoop()` call behind the
same "am I the real entry point" check used in oracle-service's
`server.js`, for the same reason: letting the integration test import
`scanContract`/`runOnePass` directly without also starting an infinite
background loop.

---

### `indexer/test/`
**`rpcClient.test.js`** — pure unit tests with no chain or database:
asserts `CLAIM_STATUS_NAMES`'s order exactly matches the Solidity enum's
declared order (a direct regression test for the exact class of silent
bug the comment in `rpcClient.js` warns about), and that encoding then
decoding a `ClaimSubmitted`/`ClaimStatusChanged` log round-trips
correctly through `ethers.Interface`.

**`indexer.integration.test.js`** — the real end-to-end test: deploys
the *full* real stack (`InsurancePolicy` + `ClaimRegistry`, via Project
1's `DeployIndexerFixture.s.sol`) to a real Anvil instance, connects to a
real (not mocked) Postgres database, then, as real on-chain transactions:
submits a claim, approves it, pays it out — running `runOnePass()` after
each step and asserting the `onchain_claims`/`onchain_policies` tables
reflect exactly what happened, including that a no-op pass afterward
correctly scans zero new events (proving the checkpoint actually
advanced) and that exactly four raw events total were recorded (one
`PolicyRegistered`, one each of `ClaimSubmitted`/`ClaimStatusChanged`/
`ClaimPayout`) — not three, not five, catching any accidental double-
processing or dropped event.

---

## Execution steps for this project specifically

1. **Backend**: `cd backend && python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && cp .env.example .env` — fill in `SECRET_KEY`, `ORACLE_SERVICE_API_KEY`, `INDEXER_WEBHOOK_API_KEY` — `pytest -v` to confirm tests pass, then `uvicorn app.main:app --reload`.
2. **Oracle service**: `cd oracle-service && npm install && cp .env.example .env` — fill in the deployed `OracleAdapter` address, the signer/relayer keys, and `ORACLE_SERVICE_API_KEY` (must match the backend's value from step 1) — `npm test` (unit only) then `npm run test:integration` (requires `anvil`/`forge`) — then `npm start`.
3. **Indexer**: `cd indexer && npm install && cp .env.example .env` — fill in the deployed contract addresses and `BACKEND_WEBHOOK_API_KEY` (must match the backend's value) — `npm test` then `npm run test:integration` (requires `anvil`, `forge`, and a reachable Postgres) — then `npm start`.
4. Confirm the shared secrets actually match across services:
   `ORACLE_SERVICE_API_KEY` (backend ↔ oracle-service) and
   `INDEXER_WEBHOOK_API_KEY` (backend ↔ indexer) — a mismatch here
   produces a clearly-worded error on the backend side (see
   `oracle_client.py`'s distinct 401 handling) but is worth checking
   directly rather than debugging via that error message.

## Next actions specific to this project

- **Run the tests for real.** Every explanation above was written from
  logical review of the code, not from an actual passing test run — see
  the root README's explicit statement on this. This is the single
  highest-value next action for this project specifically.
- Build the actual document/evidence upload endpoint on the backend —
  `ClaimDocument`'s schema already fits; nothing populates it with real
  data yet.
- Build a periodic reconciliation job comparing the indexer's
  `onchain_claims` against the backend's `claims` table directly (both
  live in the same Postgres instance in the docker-compose setup) —
  currently the only sync mechanism is the indexer's one-way webhook
  push, with no independent verify-and-repair pass.
- Move the oracle signer's private key and the backend/oracle/indexer
  shared API keys out of `.env` files and into a real secrets manager
  before this runs anywhere beyond a laptop — flagged repeatedly
  throughout this project's own documentation, not yet done.
- Add rate limiting to the backend's public-facing endpoints
  (`/auth/nonce`, `/auth/wallet`) — referenced in earlier project
  planning, not implemented in this build.

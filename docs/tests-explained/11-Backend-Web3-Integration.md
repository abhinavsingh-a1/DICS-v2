# 11 — Backend Chain Integration: `web3_client.py`, `policies_routes.py`, `schemas.py`

This document assumes you've read `00-Introduction.md` from the tests-
and-mocks set for general testing concepts. It covers different ground:
not test files, but the real backend code that reads live chain data —
and the one test file for it (`test_policies.py`) that uses **Python
mocking**, a different technique from anything in the Solidity test
documents, explained fully in document `12`.

---

## `app/web3_client.py`

### What is the purpose of this file?

Before this file existed, the backend had **zero** connection to the
blockchain at all — every other file either lets the frontend's wallet
talk to the chain directly (`claims_routes.py`) or reacts to the
indexer telling it what already happened (`internal_routes.py`). This
file is the backend's first and only *direct* read of live chain state,
for exactly two things: what policy plans exist, and whether a specific
policy's premium is paid up.

**If this file didn't exist:** the backend would have no way to answer
"what plans can someone buy" or "is this policy's premium current"
without either (a) making the frontend do these chain reads itself with
no server-side fallback, or (b) waiting for the indexer to eventually
sync this data (which it doesn't — the indexer only tracks claims and
policy registration events, not premium status, since that wasn't part
of its original design). `policies_routes.py` (document below) would
have nothing to call.

### Why is `INSURANCE_POLICY_ABI` written out by hand, as a list of dictionaries?

A real contract's ABI (Application Binary Interface — the description
of what functions exist, their parameter types, and return types) is
normally a huge JSON file `forge build` generates automatically. This
file deliberately does **not** import that generated file. Instead, it
hand-writes just the four function shapes this backend actually calls.

**Why keep it small on purpose, rather than importing the full ABI:**
two reasons stated directly in the file's own comment. First, it makes
it obvious by inspection that this file can only ever *read* — every
single entry says `"stateMutability": "view"`, so there's no function
here capable of spending money or changing state, even by a typo or a
future careless addition. Second, a smaller hand-copied ABI is easier
to keep honest: if `InsurancePolicy.sol` changes one of these four
functions, this file's copy goes stale and needs a manual update — a
real, acknowledged maintenance cost, the same one already accepted
elsewhere in this project (`oracle-service/src/chainClient.js`, the
indexer's `rpcClient.js`, the frontend's `contract.js`).

### Why does `get_web3()` use `@lru_cache` instead of just creating a new `Web3` object each time?

Walk through what happens without it: every single API request to
`/policies/catalog` or `/policies/{id}/status` would open a brand new
HTTP connection to the blockchain node, just to immediately throw it
away after one request. That's wasted setup work repeated on every
call, for a connection that's identical every time.

`@lru_cache` is a built-in Python decorator that remembers a function's
return value and hands back the *same* object on every subsequent call
with the same arguments — here, `get_web3()` takes no arguments at all,
so it's really just "compute this once per process, reuse forever."
The first request pays the cost of setting up the connection; every
request after that reuses it for free.

**What would happen without this line specifically:** nothing would
*break* — the code would still work, just slower, and would open one
new connection per request under load, which is the kind of thing that
looks fine in testing and becomes a real problem in production.

### Data flow inside `get_insurance_policy_contract()`

- **Input:** nothing (reads from `settings`, the global config object)
- **Line by line:**
  1. `w3 = get_web3()` — gets the cached connection from above.
  2. `address = Web3.to_checksum_address(settings.insurance_policy_address)`
     — converts whatever case the address string was written in (all
     lowercase, all uppercase, mixed) into Ethereum's official
     "checksum" capitalization pattern. This matters because some
     libraries silently reject or mishandle a non-checksummed address;
     doing this conversion explicitly here means it never depends on
     whoever wrote the `.env` file getting the casing right by hand.
  3. `w3.eth.contract(address=address, abi=INSURANCE_POLICY_ABI)` —
     builds a Python object that knows how to encode/decode calls to
     that specific address using that specific ABI.
- **Output:** a `Contract` object — not the data itself, just something
  you can then call `.functions.someFunction(args).call()` on.

---

## `app/routes/policies_routes.py`

### What is the purpose of this file?

This is the actual HTTP API surface — the two endpoints
(`GET /policies/catalog`, `GET /policies/{policy_id}/status`) a frontend
or any other HTTP client calls to get policy data, without needing to
know anything about Web3, ABIs, or how to talk to a blockchain node
directly. `web3_client.py` above is the *how*; this file is the *what a
caller actually gets*.

### Why does `get_policy_catalog` loop over a hardcoded `KNOWN_TEMPLATE_IDS` list instead of asking the contract "give me all templates"?

Because that function doesn't exist. A Solidity `mapping` — which is
what `policyTemplates` is, inside `InsurancePolicy.sol` — has no way to
be enumerated from outside the contract. You can look up a *specific*
key ("what's template 1?"), but there's no built-in "list every key
that's ever been set." If `InsurancePolicy.sol` doesn't add its own
tracking (like a separate array of every template ID ever created), the
only options for a caller are: know the IDs in advance (what this file
does), or reconstruct them by scanning every `PolicyTemplateAdded` event
ever emitted (what the indexer *could* do, but doesn't, since this
feature came after the indexer was built).

**What would happen without this hardcoded list:** the endpoint would
have no way to know which IDs to even ask about — `contract.functions.policyTemplates(???)`
needs *some* number to call it with.

### Why does the code check `premium_amount_per_period == 0` to decide "does this template exist"?

Solidity mappings have no concept of "this key was never set" versus
"this key was explicitly set to zero" — an unset entry simply reads back
as all-zeros for every field, the same as if someone had deliberately
created a free plan. `InsurancePolicy.sol` itself uses this exact same
check internally (`subscribeToPolicy` reverts with `PolicyTemplateNotFound`
under this same condition) — this backend code is just checking the
same fact a second time, from outside the contract, using the same
logic the contract itself relies on.

**What would happen without this check:** every unconfigured template
ID from `KNOWN_TEMPLATE_IDS` (imagine a future 4th or 5th ID added to
that list before the corresponding `addPolicyTemplate` call was ever
made on-chain) would show up in the catalog as a real plan with
`coverage_amount_wei: "0"` and `premium_amount_per_period_wei: "0"` — a
"free, zero-coverage" plan that isn't real, confusing anyone browsing
the catalog.

### Data flow inside `get_policy_status`, with concrete values

Using the exact address book from the data-flow document set
(`docs/dataflow/00-Overview-and-Index.md`) so this is traceable against
documents you may have already read:

- **Input:** `policy_id = 1` (a path parameter, e.g. from `GET /policies/1/status`)
- **Line by line:**
  1. `contract = get_insurance_policy_contract()` — the cached contract
     object from `web3_client.py`.
  2. `policy = contract.functions.getPolicy(1).call()` — a **read-only**
     call (`.call()`, not a transaction) asking the chain: "what does
     policy 1 look like right now?" For Alice's policy from the data-flow
     documents, this returns the tuple
     `(1, 10000 * 10**18, "0x1111...aaaa", 1_800_000_000, 1_831_536_000, False, b"\xab"*32)`.
  3. **Why this call is wrapped in `try/except`:** if policy ID `99`
     (say) was never registered at all, `getPolicy` doesn't return
     zeros the way `policyTemplates` does — it actively **reverts** with
     a custom error (`PolicyNotFound`). A revert, from Python's
     perspective through `web3.py`, surfaces as an exception. Without
     the `try/except`, that exception would crash the whole request
     with an ugly 500 error instead of a clean, informative 404.
  4. The tuple gets unpacked into named variables:
     `_policy_id, coverage_amount, holder, valid_from, valid_until, revoked, _metadata_hash`
     — note the underscore prefixes on `_policy_id` and `_metadata_hash`.
     **Why:** this is a Python convention meaning "I know this value
     exists, but this function doesn't need it" — `policy_id` is already
     known from the function's own input parameter, and
     `metadata_hash` isn't part of what this endpoint reports. Naming
     them with a leading underscore (rather than, say, just calling them
     `x` and `y`) documents *what* is being discarded, not just *that*
     something is.
  5. `premium_current = contract.functions.isPremiumCurrent(1).call()`
     — a second, separate chain read. For Alice, right after she pays,
     this returns `True`.
  6. `paid_until = contract.functions.premiumPaidUntil(1).call()` —
     returns `1_802_592_000` for Alice's example (30 days after
     subscribing).
  7. `amount_per_period, _period_seconds = contract.functions.premiumTerms(1).call()`
     — returns `(33 * 10**18, 2_592_000)` for Alice's Premium-plan
     policy; only the first value is kept.
- **Output:** a `PolicyStatusOut` object, which FastAPI automatically
  turns into this exact JSON for Alice's policy:
  ```json
  {
    "policy_id": 1,
    "holder": "0x1111111111111111111111111111111111AAAA",
    "coverage_amount_wei": "10000000000000000000000",
    "valid_from": 1800000000,
    "valid_until": 1831536000,
    "revoked": false,
    "premium_current": true,
    "premium_paid_until": 1802592000,
    "premium_amount_per_period_wei": "33000000000000000000"
  }
  ```

### Why are `coverage_amount_wei` and `premium_amount_per_period_wei` quoted strings in that JSON, not plain numbers?

This is explained in full in `schemas.py`'s own docstring (next
section), but the short version: `10000000000000000000000` (that's
`10,000 * 10^18`) is a number far too large for JavaScript to represent
exactly as its native number type. Sent as a JSON string instead, it
survives the trip to the frontend byte-for-byte, and `ethers.formatEther`
on the frontend end reads a numeric string exactly as happily as a real
number.

---

## `app/schemas.py` additions (`PolicyTemplateOut`, `PolicyStatusOut`)

### What is the purpose of these two classes?

They're **Pydantic models** — Python classes that describe exactly what
shape a piece of data must have, and validate it automatically.
FastAPI uses them for two things at once: they tell FastAPI what JSON
to generate for a response (turning a Python object into the JSON
you saw above), and they act as a safety check — if `policies_routes.py`
ever tried to return, say, a `PolicyStatusOut` missing the `holder`
field, this would fail loudly at that point rather than silently
sending broken JSON to whoever's calling the API.

### Why `coverage_amount_wei: str` instead of `coverage_amount_wei: int`?

This is the single most important line-level decision in this whole
integration, and it's worth understanding precisely, because it's a
mistake that's easy to make and easy to miss — it *was* made, and then
caught and fixed, while building this feature.

JavaScript's native number type is a 64-bit floating-point number
(a "double"), which can only represent whole numbers *exactly* up to
`2^53 - 1` (about 9 quadrillion). This project's token amounts are
18-decimal fixed-point — `10,000 dUSD` is actually the integer
`10,000,000,000,000,000,000,000` under the hood. That's roughly
`10^22`, which is nine orders of magnitude past JavaScript's safe range.

**What actually happens if you send that as a JSON number:** the number
itself is fine leaving Python (Python integers have no size limit) and
fine as text in the JSON response. The corruption happens the moment a
JavaScript engine parses it — `JSON.parse` (which `axios`, used in this
frontend, calls internally) converts a JSON number into a JavaScript
`number`, silently rounding it to the nearest value JavaScript *can*
represent. The value the frontend ends up holding would be wrong — not
crash-wrong, just silently, subtly wrong, the worst kind of bug because
nothing looks broken until someone notices a displayed amount doesn't
match what's on-chain.

**The fix:** make the field a `str` in the Pydantic model, and convert
the real integer to a string (`str(coverage_amount)`) before
constructing the response in `policies_routes.py`. A JSON *string* is
never touched by JavaScript's number-parsing logic at all — it arrives
as `"10000000000000000000000"`, exact digits intact, and
`ethers.formatEther()` on the frontend (built specifically to handle
these exact-precision blockchain amounts) parses that string correctly.

**Why `valid_from`, `valid_until`, and `premium_paid_until` stay plain
`int`:** these are Unix timestamps — numbers like `1,800,000,000` — many
orders of magnitude smaller than JavaScript's safe-integer ceiling.
There's no precision risk for these specific fields, so there's no need
to pay the (small) cost of string conversion for them.

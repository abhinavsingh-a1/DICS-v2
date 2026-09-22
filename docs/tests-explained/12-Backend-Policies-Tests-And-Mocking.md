# 12 — `test_policies.py`: Mocking in Python (A Different Technique From the Solidity Tests)

If you've read the Solidity test documents (`01` through `07`), you've
already seen one kind of "fake": `MockPolicyRegistry` and
`MockClaimRegistrySink`, which are real Solidity **contracts** written
specifically to stand in for a real one during a test. Python mocking
solves the same underlying problem — "test this code without needing
the real, slow, unpredictable thing it depends on" — completely
differently. There's no separate file, no separate contract. You
temporarily *replace a function* while a test runs, then put the real
one back automatically the moment the test ends.

## The problem this file exists to solve

`policies_routes.py`'s two endpoints both call
`get_insurance_policy_contract()` (from `web3_client.py`), which talks
to a real blockchain node over the network. If tests called that
function for real, every test run would need an actual running
blockchain (Anvil, or a real testnet) with actual policies and
templates already set up on it — slow, fragile (what if the node isn't
running?), and non-deterministic (what if someone else already changed
the test policy's data?).

**If this file didn't exist:** there would be no automated tests for
`policies_routes.py` at all, or the tests that did exist would need a
live chain running just to check that a 404 comes back for an unknown
policy ID — using a sledgehammer to check a doorknob.

## What `unittest.mock.patch` actually does — the core idea

```python
from unittest.mock import MagicMock, patch

with patch("app.routes.policies_routes.get_insurance_policy_contract", return_value=fake_contract):
    res = await client.get("/policies/1/status")
```

Read this line by line:

- `patch("app.routes.policies_routes.get_insurance_policy_contract", ...)`
  — this says: "inside the module `app.routes.policies_routes`, find
  the name `get_insurance_policy_contract`, and temporarily replace it
  with something else."
- **Why the string is the full path `app.routes.policies_routes.get_insurance_policy_contract`,
  not just `get_insurance_policy_contract`:** this is the single most
  common mistake beginners make with `patch`, so it's worth being
  precise about. Python doesn't have one single global copy of a
  function — when `policies_routes.py` does
  `from app.web3_client import get_insurance_policy_contract`, it
  creates its *own* local name pointing at that function, inside its
  *own* module's namespace. `patch` needs to know exactly *where* to
  swap the name — patching `app.web3_client.get_insurance_policy_contract`
  (the original file) would NOT affect `policies_routes.py`'s already-
  imported local copy of that name. You patch the name where it's
  *used*, not where it's *defined*.
- `return_value=fake_contract` — whenever the replaced function is
  called (with any arguments, since it normally takes none), instead of
  running its real code, it just immediately returns `fake_contract`.
- `with ... :` — this is a Python **context manager**. Everything
  indented under this line runs with the replacement in effect. The
  moment execution leaves this block (even if the test fails or raises
  an exception), Python automatically restores the *real*
  `get_insurance_policy_contract` — no manual cleanup needed, and no
  risk of one test's mock accidentally leaking into the next test.

## What `MagicMock` is, and why `_mock_contract_with` needs to build one so carefully

A `MagicMock` is an object that will accept *any* attribute access or
function call you throw at it, and hand back another `MagicMock` unless
you've told it what to return. This is what makes it flexible enough to
stand in for a real `web3.py` `Contract` object, which has a somewhat
unusual calling shape: `contract.functions.getPolicy(1).call()` — a
function call, that returns *another* callable object, which itself
needs `.call()` invoked on it to actually run.

Look at `_mock_contract_with`'s `get_policy_call` function:

```python
def get_policy_call(policy_id):
    call = MagicMock()
    if policies and policy_id in policies:
        call.call.return_value = policies[policy_id]
    else:
        call.call.side_effect = Exception("execution reverted: PolicyNotFound")
    return call

contract.functions.getPolicy.side_effect = get_policy_call
```

**Why this needs two layers (`contract.functions.getPolicy` AND then
`.call` on whatever that returns), matching web3.py's real shape
exactly:** the real code in `policies_routes.py` calls
`contract.functions.getPolicy(policy_id).call()` — two separate steps.
If the mock only faked the outer call and returned a plain tuple
directly, the real code's `.call()` on that returned value would fail,
because a plain tuple has no `.call()` method. The mock has to mimic
the *exact shape* of what it's replacing, one layer at a time, or the
code under test breaks in a way that has nothing to do with what you're
actually trying to verify.

**What `side_effect` versus `return_value` means:** `return_value` is
"always give back this exact thing." `side_effect` set to a *function*
means "run this function with whatever arguments were passed, and use
whatever IT returns" — this is why `get_policy_call` needs to be a
function that takes `policy_id` as a parameter: different test policy
IDs need different fake responses (existing vs. not found), and a
single fixed `return_value` couldn't express that.

**What `side_effect` set to an `Exception` instance does** (a different
usage, seen in the `else` branch above): instead of returning a value,
calling the mock *raises* that exception — this is how
`test_get_policy_status_404s_for_unknown_policy` simulates a real
contract revert without needing an actual contract that actually
reverts.

## Walking through one full test, with exact values

```python
@pytest.mark.asyncio
async def test_get_policy_status_returns_combined_data(client):
    alice = "0x1111111111111111111111111111111111AAAA"
    fake_contract = _mock_contract_with(
        policies={
            1: (1, 10_000 * 10**18, alice, 1_800_000_000, 1_831_536_000, False, b"\xab" * 32),
        },
        premium_current={1: True},
        premium_paid_until={1: 1_802_592_000},
        premium_terms={1: (33 * 10**18, 2_592_000)},
    )

    with patch("app.routes.policies_routes.get_insurance_policy_contract", return_value=fake_contract):
        res = await client.get("/policies/1/status")

    assert res.status_code == 200
    body = res.json()
    assert body["holder"] == alice
    assert body["premium_current"] is True
    assert body["premium_paid_until"] == 1_802_592_000
    assert body["premium_amount_per_period_wei"] == str(33 * 10**18)
```

**Input:** an HTTP `GET /policies/1/status` request, made by `client`
(the same fixture from `conftest.py` that every other backend test
file already uses — nothing new there).

**Data flow:**
1. `_mock_contract_with(...)` builds a `MagicMock` pre-programmed to
   answer exactly like a real chain would, *if* policy 1 were Alice's
   real $33 Premium-plan policy from the data-flow documents — every
   number here is deliberately the same as that worked example, so this
   test doubles as a check that this whole backend feature agrees with
   the values documented elsewhere in this project.
2. The `with patch(...)` block makes `policies_routes.py` use
   `fake_contract` instead of a real one, for exactly the duration of
   the `await client.get(...)` call.
3. Inside that call, `policies_routes.py`'s real code runs completely
   unmodified — it has no idea it's talking to a fake. It calls
   `get_insurance_policy_contract()` (gets `fake_contract`), then
   `.functions.getPolicy(1).call()` (gets the tuple above via
   `get_policy_call`'s `side_effect`), and so on for the other three
   chain reads.
4. FastAPI turns the resulting `PolicyStatusOut` object into JSON.

**Output:** `res.status_code == 200`, and a JSON body whose `holder`
field is exactly Alice's address, `premium_current` is `True`, and
`premium_amount_per_period_wei` is `"33000000000000000000"` (the string
form of `33 * 10**18`, per document `11`'s explanation of why).

**What this test actually proves:** not that the real blockchain works
(nothing here touches one) — it proves that `policies_routes.py`'s own
code correctly calls the right functions with the right arguments and
correctly assembles their results into the right response shape. A
real chain read could still fail for its own reasons (bad RPC URL, wrong
contract address) — that's a different, real-infrastructure problem
this kind of test deliberately doesn't cover, and isn't trying to.

## What running this file requires — and does not require

```bash
cd backend
pytest tests/test_policies.py -v
```

**Does NOT require:** a running Anvil node, a deployed `InsurancePolicy`
contract, an `.env` file with a real RPC URL, or any network access at
all during the test itself (the `RPC_URL`/`INSURANCE_POLICY_ADDRESS`
settings still need *some* value for `Settings()` to construct
successfully at import time — see `conftest.py`'s `os.environ.setdefault`
calls — but that value is never actually connected to, because the
mock replaces the one function that would have used it).

**Does require:** the same test dependencies every other backend test
already needs (`pytest`, `pytest-asyncio`) — no new package was added
specifically for mocking, because `unittest.mock` ships as part of
Python's own standard library.

"""
Minimal, READ-ONLY connection to the chain. No private key lives here —
this module can never send a transaction, only call view functions. That
restriction is architectural, not just a convention: `web3.py`'s `Web3`
object here is never given an account to sign with, so there is no
function in this file *capable* of writing to the chain even by
accident. Every value-moving action in this project (paying a premium,
submitting a claim) is signed by the end user's own wallet in the
frontend — see `frontend/src/api/contract.js` — never by this backend.

Same hand-maintained-ABI caveat as everywhere else in this project
(oracle-service's `chainClient.js`, the indexer's `rpcClient.js`,
`frontend/src/api/contract.js`): this ABI fragment must be kept in sync
with `InsurancePolicy.sol` by hand. If the contract's `PolicyTemplate`
struct or `getPolicy`/`isPremiumCurrent` signatures ever change, this
file needs updating to match — nothing enforces that automatically.
"""

from functools import lru_cache

from web3 import Web3

from app.config import settings

# Only the four read functions this backend actually calls. Deliberately
# not the full contract ABI — the smaller this list, the smaller the
# blast radius if the real contract's ABI drifts from this hand-copied
# version, and the easier it is to audit "does this backend have any
# path to a state-changing call" (it doesn't — every entry below is a
# `view` function).
INSURANCE_POLICY_ABI = [
    {
        "name": "policyTemplates",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "templateId", "type": "uint256"}],
        "outputs": [
            {"name": "coverageAmount", "type": "uint128"},
            {"name": "premiumAmountPerPeriod", "type": "uint128"},
            {"name": "periodSeconds", "type": "uint40"},
            {"name": "termSeconds", "type": "uint40"},
            {"name": "active", "type": "bool"},
            {"name": "metadataHash", "type": "bytes32"},
        ],
    },
    {
        "name": "getPolicy",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "policyId", "type": "uint256"}],
        "outputs": [
            {
                "name": "",
                "type": "tuple",
                "components": [
                    {"name": "policyId", "type": "uint128"},
                    {"name": "coverageAmount", "type": "uint128"},
                    {"name": "holder", "type": "address"},
                    {"name": "validFrom", "type": "uint40"},
                    {"name": "validUntil", "type": "uint40"},
                    {"name": "revoked", "type": "bool"},
                    {"name": "metadataHash", "type": "bytes32"},
                ],
            }
        ],
    },
    {
        "name": "isPremiumCurrent",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "policyId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "bool"}],
    },
    {
        "name": "premiumPaidUntil",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "policyId", "type": "uint256"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "name": "premiumTerms",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "policyId", "type": "uint256"}],
        "outputs": [
            {"name": "amountPerPeriod", "type": "uint128"},
            {"name": "periodSeconds", "type": "uint40"},
        ],
    },
]


@lru_cache
def get_web3() -> Web3:
    """
    One cached Web3 instance per process, not one per request. Opening a
    fresh HTTP connection to the RPC node on every incoming API request
    would work, but it's wasted setup cost for something that never
    changes between requests — `lru_cache` with no arguments makes this
    function a simple memoized singleton, the same pattern Python uses
    for "compute once, reuse forever" values.
    """
    return Web3(Web3.HTTPProvider(settings.rpc_url))


@lru_cache
def get_insurance_policy_contract():
    """
    Same memoization reasoning as `get_web3` — constructing a `Contract`
    object is cheap but pointless to repeat. Depends on `get_web3()`
    rather than constructing its own `Web3`, so both share the exact
    same underlying HTTP connection.
    """
    w3 = get_web3()
    address = Web3.to_checksum_address(settings.insurance_policy_address)
    return w3.eth.contract(address=address, abi=INSURANCE_POLICY_ABI)

"""
Read-only endpoints backed directly by chain state — see
`web3_client.py`'s header for why this is the one place in the backend
that talks to the chain at all, and why that's deliberately restricted
to reads only.
"""

from fastapi import APIRouter, HTTPException

from app.schemas import PolicyStatusOut, PolicyTemplateOut
from app.web3_client import get_insurance_policy_contract

router = APIRouter(prefix="/policies", tags=["policies"])

# InsurancePolicy.sol has no "list all template IDs" function — a
# template is just an entry in a mapping, and Solidity mappings can't be
# enumerated from outside. So the backend has to know which IDs might
# exist and check each one. Hardcoded to this project's actual 3-plan
# catalog (see docs/dataflow/00-Overview-and-Index.md's policy table)
# rather than over-building a general "scan IDs 1 to 1000" approach for
# a catalog that, in this project, is only ever 3 entries.
KNOWN_TEMPLATE_IDS = [1, 2, 3]


@router.get("/catalog", response_model=list[PolicyTemplateOut])
async def get_policy_catalog():
    """
    Returns every KNOWN_TEMPLATE_IDS entry that actually exists on-chain
    and is currently active — silently skips IDs that were never
    configured (amountPerPeriod == 0, the same "does this exist" check
    InsurancePolicy.sol's own solidity code uses internally) or that an
    admin has since discontinued (active == false, matching
    setPolicyTemplateActive's effect — see this project's smart-contract
    documentation for why discontinuing a plan doesn't touch existing
    policyholders, only new subscriptions).
    """
    contract = get_insurance_policy_contract()
    templates = []
    for template_id in KNOWN_TEMPLATE_IDS:
        (
            coverage_amount,
            premium_amount_per_period,
            period_seconds,
            term_seconds,
            active,
            metadata_hash,
        ) = contract.functions.policyTemplates(template_id).call()

        if premium_amount_per_period == 0:
            continue  # never configured — see the check in subscribeToPolicy itself
        if not active:
            continue  # discontinued for new subscribers

        templates.append(
            PolicyTemplateOut(
                template_id=template_id,
                coverage_amount_wei=str(coverage_amount),
                premium_amount_per_period_wei=str(premium_amount_per_period),
                period_seconds=period_seconds,
                term_seconds=term_seconds,
            )
        )
    return templates


@router.get("/{policy_id}/status", response_model=PolicyStatusOut)
async def get_policy_status(policy_id: int):
    """
    A single combined read for the frontend's policy/premium status
    display — rather than making the frontend call `getPolicy` and
    `isPremiumCurrent` as two separate chain reads itself, this endpoint
    does both server-side and returns one shaped response. Either
    individual call is also directly available to the frontend via
    `frontend/src/api/contract.js` if a page only needs one piece — this
    endpoint exists for convenience, not because the frontend is
    incapable of reading the chain itself (it already does, elsewhere,
    for the actual wallet-signed transactions).
    """
    contract = get_insurance_policy_contract()

    try:
        policy = contract.functions.getPolicy(policy_id).call()
    except Exception as exc:
        # InsurancePolicy.getPolicy reverts with a custom error
        # (PolicyNotFound) for an ID that was never registered — web3.py
        # surfaces that as a generic ContractLogicError, not a typed
        # exception we can pattern-match on the specific error name, so
        # this treats ANY revert here as "not found." That's a real
        # simplification: a different revert reason (there isn't one for
        # this function today, but a future contract change could add
        # one) would also be reported as 404, which could be misleading.
        # Flagged here rather than hidden.
        raise HTTPException(status_code=404, detail=f"Policy {policy_id} not found on-chain") from exc

    (_policy_id, coverage_amount, holder, valid_from, valid_until, revoked, _metadata_hash) = policy

    premium_current = contract.functions.isPremiumCurrent(policy_id).call()
    paid_until = contract.functions.premiumPaidUntil(policy_id).call()
    amount_per_period, _period_seconds = contract.functions.premiumTerms(policy_id).call()

    return PolicyStatusOut(
        policy_id=policy_id,
        holder=holder,
        coverage_amount_wei=str(coverage_amount),
        valid_from=valid_from,
        valid_until=valid_until,
        revoked=revoked,
        premium_current=premium_current,
        premium_paid_until=paid_until,
        premium_amount_per_period_wei=str(amount_per_period),
    )

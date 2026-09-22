"""
Tests for policies_routes.py — and the file to read first if mocking is
new. Every test here uses `unittest.mock.patch` to swap out
`get_insurance_policy_contract` (the ONE function that talks to a real
chain — see web3_client.py) for a fake object that returns whatever
canned values each test wants. This means these tests need no running
blockchain at all, run in milliseconds, and produce the exact same
result every time — no flakiness from network latency or needing Anvil
running in the background. Every mock's canned return values are
commented with what they represent, so this file doubles as worked
examples of this project's actual on-chain data shapes.
"""

from unittest.mock import MagicMock, patch

import pytest


def _mock_contract_with(
    policy_templates=None, policies=None, premium_current=None, premium_paid_until=None, premium_terms=None
):
    """
    Builds a fake object shaped just enough like a real web3.py Contract
    to satisfy policies_routes.py's calls — `contract.functions.X(args).call()`.
    This is NOT a real contract; it's a stand-in that returns exactly
    what each test tells it to, so the test controls every input
    precisely instead of depending on real chain state that could change.

    Each argument is a dict keyed by the same ID the real function would
    be called with, e.g. `policy_templates={1: (2000_ether, 11_ether, ...)}`
    mimics what `contract.functions.policyTemplates(1).call()` would
    return on-chain for template ID 1.
    """
    contract = MagicMock()

    def policy_templates_call(template_id):
        call = MagicMock()
        call.call.return_value = (policy_templates or {}).get(
            template_id, (0, 0, 0, 0, False, b"\x00" * 32)  # matches an unconfigured template
        )
        return call

    def get_policy_call(policy_id):
        call = MagicMock()
        if policies and policy_id in policies:
            call.call.return_value = policies[policy_id]
        else:
            call.call.side_effect = Exception("execution reverted: PolicyNotFound")
        return call

    def is_premium_current_call(policy_id):
        call = MagicMock()
        call.call.return_value = (premium_current or {}).get(policy_id, False)
        return call

    def premium_paid_until_call(policy_id):
        call = MagicMock()
        call.call.return_value = (premium_paid_until or {}).get(policy_id, 0)
        return call

    def premium_terms_call(policy_id):
        call = MagicMock()
        call.call.return_value = (premium_terms or {}).get(policy_id, (0, 0))
        return call

    contract.functions.policyTemplates.side_effect = policy_templates_call
    contract.functions.getPolicy.side_effect = get_policy_call
    contract.functions.isPremiumCurrent.side_effect = is_premium_current_call
    contract.functions.premiumPaidUntil.side_effect = premium_paid_until_call
    contract.functions.premiumTerms.side_effect = premium_terms_call
    return contract


@pytest.mark.asyncio
async def test_get_policy_catalog_returns_only_configured_active_templates(client):
    # Template 1 (Basic): configured and active — should appear.
    # Template 2 (Standard): configured but active=False — should be
    # skipped, same as InsurancePolicy.subscribeToPolicy would reject it.
    # Template 3 (Premium): never configured at all (amountPerPeriod==0)
    # — should be skipped, matching the real contract's own check.
    fake_contract = _mock_contract_with(
        policy_templates={
            1: (2_000 * 10**18, 11 * 10**18, 2_592_000, 31_536_000, True, b"\x11" * 32),
            2: (5_000 * 10**18, 22 * 10**18, 2_592_000, 31_536_000, False, b"\x22" * 32),
        }
    )

    with patch("app.routes.policies_routes.get_insurance_policy_contract", return_value=fake_contract):
        res = await client.get("/policies/catalog")

    assert res.status_code == 200
    body = res.json()
    assert len(body) == 1
    assert body[0]["template_id"] == 1
    assert body[0]["coverage_amount_wei"] == str(2_000 * 10**18)
    assert body[0]["premium_amount_per_period_wei"] == str(11 * 10**18)


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


@pytest.mark.asyncio
async def test_get_policy_status_404s_for_unknown_policy(client):
    # No `policies` dict entry for ID 99 — the mock's getPolicy will
    # raise, exactly as the real contract reverts with PolicyNotFound
    # for an ID that was never registered.
    fake_contract = _mock_contract_with(policies={})

    with patch("app.routes.policies_routes.get_insurance_policy_contract", return_value=fake_contract):
        res = await client.get("/policies/99/status")

    assert res.status_code == 404

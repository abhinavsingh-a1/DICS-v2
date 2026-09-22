import respx
from httpx import Response


async def _create_claim(client, auth_headers, declared_amount=500.0):
    res = await client.post(
        "/claims",
        json={"policy_id": 1, "declared_amount": declared_amount, "documents": []},
        headers=auth_headers["headers"],
    )
    return res


async def test_create_and_get_claim(client, auth_headers):
    create_res = await _create_claim(client, auth_headers)
    assert create_res.status_code == 201
    body = create_res.json()
    assert body["status"] == "draft"
    assert body["claimant_address"].lower() == auth_headers["address"].lower()

    get_res = await client.get(f"/claims/{body['id']}", headers=auth_headers["headers"])
    assert get_res.status_code == 200
    assert get_res.json()["id"] == body["id"]


async def test_list_claims_returns_only_own_claims(client, auth_headers):
    await _create_claim(client, auth_headers, declared_amount=100.0)
    await _create_claim(client, auth_headers, declared_amount=200.0)

    res = await client.get("/claims", headers=auth_headers["headers"])
    assert res.status_code == 200
    body = res.json()
    assert len(body) == 2
    assert all(c["claimant_address"].lower() == auth_headers["address"].lower() for c in body)


async def test_get_claim_not_found(client, auth_headers):
    res = await client.get("/claims/999999", headers=auth_headers["headers"])
    assert res.status_code == 404


@respx.mock
async def test_trigger_verification_approved_updates_claim_status(client, auth_headers):
    create_res = await _create_claim(client, auth_headers, declared_amount=250.0)
    claim_id = create_res.json()["id"]

    route = respx.post("http://test-oracle-service/verify").mock(
        return_value=Response(
            200,
            json={
                "claimId": claim_id,
                "requestId": "0x" + "aa" * 32,
                "approved": True,
                "reason": "MOCK: within placeholder threshold, no red flags",
                "txHash": "0x" + "bb" * 32,
                "blockNumber": 123,
            },
        )
    )

    res = await client.post(
        f"/claims/{claim_id}/trigger-verification", headers=auth_headers["headers"]
    )
    assert res.status_code == 200
    body = res.json()
    assert body["approved"] is True
    assert body["status"] == "approved"
    assert route.called

    # Confirm the sent request matches the documented contract exactly —
    # the same shape the oracle-service's real implementation expects.
    sent_request = route.calls[0].request
    assert sent_request.headers["X-Oracle-Service-Key"] == "test-oracle-api-key-not-real"

    get_res = await client.get(f"/claims/{claim_id}", headers=auth_headers["headers"])
    assert get_res.json()["status"] == "approved"


@respx.mock
async def test_trigger_verification_rejected_updates_claim_status(client, auth_headers):
    create_res = await _create_claim(client, auth_headers, declared_amount=999999.0)
    claim_id = create_res.json()["id"]

    respx.post("http://test-oracle-service/verify").mock(
        return_value=Response(
            200,
            json={
                "claimId": claim_id,
                "requestId": "0x" + "cc" * 32,
                "approved": False,
                "reason": "MOCK: declaredAmount exceeds placeholder threshold",
                "txHash": "0x" + "dd" * 32,
                "blockNumber": 124,
            },
        )
    )

    res = await client.post(
        f"/claims/{claim_id}/trigger-verification", headers=auth_headers["headers"]
    )
    assert res.status_code == 200
    assert res.json()["approved"] is False
    assert res.json()["status"] == "rejected"


@respx.mock
async def test_trigger_verification_oracle_service_down_returns_502(client, auth_headers):
    create_res = await _create_claim(client, auth_headers)
    claim_id = create_res.json()["id"]

    respx.post("http://test-oracle-service/verify").mock(side_effect=Exception("connection refused"))

    res = await client.post(
        f"/claims/{claim_id}/trigger-verification", headers=auth_headers["headers"]
    )
    assert res.status_code == 502


@respx.mock
async def test_idempotency_key_prevents_duplicate_oracle_calls(client, auth_headers):
    create_res = await _create_claim(client, auth_headers)
    claim_id = create_res.json()["id"]

    route = respx.post("http://test-oracle-service/verify").mock(
        return_value=Response(
            200,
            json={
                "claimId": claim_id,
                "requestId": "0x" + "ee" * 32,
                "approved": True,
                "reason": "MOCK",
                "txHash": "0x" + "ff" * 32,
                "blockNumber": 125,
            },
        )
    )

    headers = {**auth_headers["headers"], "Idempotency-Key": "retry-key-abc-123"}

    first = await client.post(f"/claims/{claim_id}/trigger-verification", headers=headers)
    second = await client.post(f"/claims/{claim_id}/trigger-verification", headers=headers)

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json() == second.json()

    # The actual point of this test: the oracle service — and therefore
    # the real on-chain transaction it triggers — was only called ONCE,
    # even though the client retried the request.
    assert route.call_count == 1


@respx.mock
async def test_different_idempotency_keys_both_execute(client, auth_headers):
    create_res = await _create_claim(client, auth_headers)
    claim_id = create_res.json()["id"]

    route = respx.post("http://test-oracle-service/verify").mock(
        return_value=Response(
            200,
            json={
                "claimId": claim_id,
                "requestId": "0x" + "11" * 32,
                "approved": True,
                "reason": "MOCK",
                "txHash": "0x" + "22" * 32,
                "blockNumber": 126,
            },
        )
    )

    await client.post(
        f"/claims/{claim_id}/trigger-verification",
        headers={**auth_headers["headers"], "Idempotency-Key": "key-1"},
    )
    await client.post(
        f"/claims/{claim_id}/trigger-verification",
        headers={**auth_headers["headers"], "Idempotency-Key": "key-2"},
    )

    assert route.call_count == 2

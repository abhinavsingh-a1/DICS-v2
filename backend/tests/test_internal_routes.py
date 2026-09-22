async def _create_claim(client, auth_headers, merkle_root="0x" + "ab" * 32):
    res = await client.post(
        "/claims",
        json={
            "policy_id": 1,
            "declared_amount": 500.0,
            "merkle_root": merkle_root,
            "documents": [],
        },
        headers=auth_headers["headers"],
    )
    return res.json()


async def test_webhook_rejects_missing_key(client):
    res = await client.post(
        "/internal/onchain-events",
        json={
            "onchain_claim_id": 1,
            "merkle_root": "0x" + "ab" * 32,
            "tx_hash": "0x" + "cd" * 32,
            "status": "submitted",
        },
    )
    assert res.status_code == 401


async def test_webhook_rejects_wrong_key(client):
    res = await client.post(
        "/internal/onchain-events",
        json={
            "onchain_claim_id": 1,
            "merkle_root": "0x" + "ab" * 32,
            "tx_hash": "0x" + "cd" * 32,
            "status": "submitted",
        },
        headers={"X-Indexer-Webhook-Key": "wrong-key"},
    )
    assert res.status_code == 401


async def test_webhook_updates_matching_claim(client, auth_headers):
    merkle_root = "0x" + "ee" * 32
    claim = await _create_claim(client, auth_headers, merkle_root=merkle_root)

    res = await client.post(
        "/internal/onchain-events",
        json={
            "onchain_claim_id": 42,
            "merkle_root": merkle_root,
            "tx_hash": "0x" + "ff" * 32,
            "status": "submitted",
        },
        headers={"X-Indexer-Webhook-Key": "test-indexer-webhook-key-not-real"},
    )
    assert res.status_code == 200
    assert res.json()["status"] == "updated"

    get_res = await client.get(f"/claims/{claim['id']}", headers=auth_headers["headers"])
    body = get_res.json()
    assert body["onchain_claim_id"] == 42
    assert body["status"] == "submitted"


async def test_webhook_with_no_matching_claim_does_not_error(client):
    res = await client.post(
        "/internal/onchain-events",
        json={
            "onchain_claim_id": 999,
            "merkle_root": "0x" + "99" * 32,
            "tx_hash": "0x" + "88" * 32,
            "status": "paid",
        },
        headers={"X-Indexer-Webhook-Key": "test-indexer-webhook-key-not-real"},
    )
    assert res.status_code == 200
    assert res.json()["status"] == "no_matching_claim"


async def test_webhook_with_unrecognized_status_does_not_error(client, auth_headers):
    merkle_root = "0x" + "77" * 32
    await _create_claim(client, auth_headers, merkle_root=merkle_root)

    res = await client.post(
        "/internal/onchain-events",
        json={
            "onchain_claim_id": 1,
            "merkle_root": merkle_root,
            "tx_hash": "0x" + "66" * 32,
            "status": "not_a_real_status",
        },
        headers={"X-Indexer-Webhook-Key": "test-indexer-webhook-key-not-real"},
    )
    assert res.status_code == 200
    assert res.json()["status"] == "unrecognized_status"

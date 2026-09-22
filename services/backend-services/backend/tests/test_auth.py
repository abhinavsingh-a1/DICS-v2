from eth_account import Account
from eth_account.messages import encode_defunct


async def _sign_login_message(account, message: str) -> str:
    signed = account.sign_message(encode_defunct(text=message))
    return signed.signature.hex()
    # eth_account returns raw bytes without a leading "0x" in older
    # versions — normalized below where used, to avoid depending on
    # which exact eth-account version is installed.


def _hex(sig: str) -> str:
    return sig if sig.startswith("0x") else f"0x{sig}"


async def test_full_wallet_login_flow_succeeds(client):
    account = Account.create()

    nonce_res = await client.get("/auth/nonce", params={"address": account.address})
    assert nonce_res.status_code == 200
    message = nonce_res.json()["message"]

    signature = _hex(await _sign_login_message(account, message))

    login_res = await client.post(
        "/auth/wallet", json={"address": account.address, "signature": signature}
    )
    assert login_res.status_code == 200
    assert "access_token" in login_res.json()


async def test_login_fails_with_wrong_signer(client):
    real_account = Account.create()
    impostor_account = Account.create()

    nonce_res = await client.get("/auth/nonce", params={"address": real_account.address})
    message = nonce_res.json()["message"]

    # Signed by the WRONG key, but claiming to be real_account's address
    wrong_signature = _hex(await _sign_login_message(impostor_account, message))

    login_res = await client.post(
        "/auth/wallet", json={"address": real_account.address, "signature": wrong_signature}
    )
    assert login_res.status_code == 401


async def test_nonce_cannot_be_reused_after_successful_login(client):
    account = Account.create()

    nonce_res = await client.get("/auth/nonce", params={"address": account.address})
    message = nonce_res.json()["message"]
    signature = _hex(await _sign_login_message(account, message))

    first = await client.post(
        "/auth/wallet", json={"address": account.address, "signature": signature}
    )
    assert first.status_code == 200

    # Replaying the exact same signature against the exact same
    # (now-used) nonce must fail — this is the server-side half of the
    # replay protection; the on-chain oracle response replay protection
    # tested elsewhere in this project is the same principle applied to
    # a different signed payload.
    second = await client.post(
        "/auth/wallet", json={"address": account.address, "signature": signature}
    )
    assert second.status_code == 401


async def test_protected_endpoint_rejects_missing_token(client):
    res = await client.get("/claims/1")
    assert res.status_code == 401


async def test_malformed_signature_still_consumes_the_nonce(client):
    """
    Regression test for the fix in app/auth.py: an earlier version of
    verify_signature_and_consume_nonce only marked the nonce used on the
    successful-recovery path, meaning a malformed (unparseable)
    signature could be retried indefinitely against the same nonce.
    """
    account = Account.create()
    nonce_res = await client.get("/auth/nonce", params={"address": account.address})
    assert nonce_res.status_code == 200

    malformed_attempt = await client.post(
        "/auth/wallet", json={"address": account.address, "signature": "0x" + "00" * 65}
    )
    assert malformed_attempt.status_code == 401

    # Now try again with a VALID signature over the SAME (now-consumed)
    # nonce — must still fail, proving the malformed attempt burned it.
    message = nonce_res.json()["message"]
    valid_signature = _hex(await _sign_login_message(account, message))
    second_attempt = await client.post(
        "/auth/wallet", json={"address": account.address, "signature": valid_signature}
    )
    assert second_attempt.status_code == 401

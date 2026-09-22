import httpx
import pytest
import respx
from httpx import Response

from app.oracle_client import OracleServiceError, request_verification


@respx.mock
async def test_request_verification_success():
    respx.post("http://test-oracle-service/verify").mock(
        return_value=Response(
            200,
            json={
                "claimId": 1,
                "requestId": "0x" + "11" * 32,
                "approved": True,
                "reason": "MOCK: ok",
                "txHash": "0x" + "22" * 32,
                "blockNumber": 1,
            },
        )
    )

    result = await request_verification(claim_id=1, declared_amount=100.0)
    assert result.approved is True
    assert result.tx_hash == "0x" + "22" * 32


@respx.mock
async def test_request_verification_wrong_api_key_raises_distinct_error():
    respx.post("http://test-oracle-service/verify").mock(
        return_value=Response(401, json={"error": "invalid_api_key"})
    )

    with pytest.raises(OracleServiceError, match="API key"):
        await request_verification(claim_id=1, declared_amount=100.0)


@respx.mock
async def test_request_verification_upstream_error():
    respx.post("http://test-oracle-service/verify").mock(return_value=Response(502))

    with pytest.raises(OracleServiceError):
        await request_verification(claim_id=1, declared_amount=100.0)


@respx.mock
async def test_request_verification_connection_failure():
    respx.post("http://test-oracle-service/verify").mock(
        side_effect=httpx.ConnectError("connection refused")
    )

    with pytest.raises(OracleServiceError, match="Could not reach oracle service"):
        await request_verification(claim_id=1, declared_amount=100.0)


@respx.mock
async def test_request_verification_malformed_response():
    respx.post("http://test-oracle-service/verify").mock(
        return_value=Response(200, json={"approved": True})  # missing required fields
    )

    with pytest.raises(OracleServiceError, match="missing field"):
        await request_verification(claim_id=1, declared_amount=100.0)

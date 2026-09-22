"""
Client for the oracle-service's POST /verify endpoint. Implements exactly
the contract documented in oracle-service/README.md's "still open"
section: send X-Oracle-Service-Key and a JSON body of
{ claimId, declaredAmount, evidenceSummary? }.
"""

from dataclasses import dataclass

import httpx

from app.config import settings


class OracleServiceError(Exception):
    """Raised for any failure calling the oracle service — connection,
    timeout, non-2xx response, or a malformed response body. Callers
    (the claims route) catch this one type rather than needing to know
    about httpx's exception hierarchy."""


@dataclass
class OracleVerificationResult:
    approved: bool
    reason: str
    request_id: str
    tx_hash: str


async def request_verification(
    claim_id: int, declared_amount: float, evidence_summary: str | None = None
) -> OracleVerificationResult:
    body = {"claimId": claim_id, "declaredAmount": declared_amount}
    if evidence_summary:
        body["evidenceSummary"] = evidence_summary

    headers = {"X-Oracle-Service-Key": settings.oracle_service_api_key}

    try:
        async with httpx.AsyncClient(timeout=settings.oracle_service_timeout_seconds) as client:
            response = await client.post(
                f"{settings.oracle_service_url}/verify", json=body, headers=headers
            )
    except httpx.RequestError as exc:
        raise OracleServiceError(f"Could not reach oracle service: {exc}") from exc

    if response.status_code == 401:
        # A 401 here means THIS backend's ORACLE_SERVICE_API_KEY doesn't
        # match the oracle service's configured key — a deployment/config
        # problem, not a claim-specific one. Surfaced distinctly so it's
        # not confused with a claim being rejected.
        raise OracleServiceError(
            "Oracle service rejected this backend's API key — check "
            "ORACLE_SERVICE_API_KEY matches on both sides."
        )

    if response.status_code != 200:
        raise OracleServiceError(
            f"Oracle service returned {response.status_code}: {response.text}"
        )

    data = response.json()
    try:
        return OracleVerificationResult(
            approved=data["approved"],
            reason=data["reason"],
            request_id=data["requestId"],
            tx_hash=data["txHash"],
        )
    except KeyError as exc:
        raise OracleServiceError(f"Oracle service response missing field: {exc}") from exc

from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_address
from app.db import get_db
from app.idempotency import get_cached_response, store_response
from app.models import Claim, ClaimDocument, ClaimStatus
from app.oracle_client import OracleServiceError, request_verification
from app.schemas import ClaimOut, CreateClaimRequest, TriggerVerificationResponse

router = APIRouter(prefix="/claims", tags=["claims"])


@router.get("", response_model=list[ClaimOut])
async def list_my_claims(
    claimant: Annotated[str, Depends(get_current_address)],
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Claim).where(Claim.claimant_address == claimant).order_by(Claim.created_at.desc())
    )
    claims = result.scalars().all()
    for claim in claims:
        await db.refresh(claim, attribute_names=["documents"])
    return claims


@router.post("", response_model=ClaimOut, status_code=201)
async def create_claim(
    payload: CreateClaimRequest,
    claimant: Annotated[str, Depends(get_current_address)],
    db: AsyncSession = Depends(get_db),
):
    claim = Claim(
        policy_id=payload.policy_id,
        claimant_address=claimant,
        declared_amount=payload.declared_amount,
        merkle_root=payload.merkle_root,
        status=ClaimStatus.DRAFT,
    )
    db.add(claim)
    await db.flush()  # populate claim.id before creating documents that reference it

    for doc in payload.documents:
        db.add(
            ClaimDocument(
                claim_id=claim.id,
                filename=doc.filename,
                sha256_hash=doc.sha256_hash,
                file_cid=doc.file_cid,
                merkle_proof=doc.merkle_proof,
            )
        )

    await db.commit()
    await db.refresh(claim, attribute_names=["documents"])
    return claim


@router.get("/{claim_id}", response_model=ClaimOut)
async def get_claim(
    claim_id: int,
    _claimant: Annotated[str, Depends(get_current_address)],
    db: AsyncSession = Depends(get_db),
):
    claim = await db.get(Claim, claim_id)
    if claim is None:
        raise HTTPException(status_code=404, detail="Claim not found")
    await db.refresh(claim, attribute_names=["documents"])
    return claim


@router.post("/{claim_id}/trigger-verification", response_model=TriggerVerificationResponse)
async def trigger_verification(
    claim_id: int,
    _claimant: Annotated[str, Depends(get_current_address)],
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
):
    """
    Calls the oracle service to evaluate this claim, records the
    resulting on-chain transaction hash, and updates local status.
    Idempotency-protected: this triggers a real on-chain transaction via
    the oracle service, so a client retry (network blip, double-click)
    must not cause it to fire twice.
    """
    endpoint_name = "trigger-verification"

    if idempotency_key:
        cached = await get_cached_response(db, idempotency_key, endpoint_name)
        if cached is not None:
            return TriggerVerificationResponse(**cached["body"])

    claim = await db.get(Claim, claim_id)
    if claim is None:
        raise HTTPException(status_code=404, detail="Claim not found")

    try:
        result = await request_verification(
            claim_id=claim.id, declared_amount=claim.declared_amount
        )
    except OracleServiceError as exc:
        # Deliberately 502 (upstream failure), not 500 — this failure
        # originates from a downstream service this backend depends on,
        # not from a bug in this endpoint's own logic. Distinguishing
        # the two matters for whoever is debugging an incident later.
        raise HTTPException(status_code=502, detail=str(exc))

    claim.status = ClaimStatus.APPROVED if result.approved else ClaimStatus.REJECTED
    claim.oracle_request_id = result.request_id
    claim.tx_hash = result.tx_hash
    await db.commit()

    response = TriggerVerificationResponse(
        claim_id=claim.id,
        approved=result.approved,
        reason=result.reason,
        oracle_tx_hash=result.tx_hash,
        status=claim.status,
    )

    if idempotency_key:
        await store_response(
            db, idempotency_key, endpoint_name, 200, response.model_dump(mode="json")
        )

    return response

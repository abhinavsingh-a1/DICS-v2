from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.internal_auth import require_indexer_webhook_key
from app.models import Claim, ClaimStatus

router = APIRouter(prefix="/internal", tags=["internal"])


class OnchainEventNotification(BaseModel):
    event_name: str | None = None
    onchain_claim_id: int
    merkle_root: str
    tx_hash: str
    status: str  # one of ClaimStatus's values — the indexer's
    # CLAIM_STATUS_NAMES array was deliberately kept in sync with this
    # backend's ClaimStatus enum values, so no translation table is
    # needed here; if that ever drifts, the ClaimStatus(...) construction
    # below raises a clear ValueError rather than silently accepting an
    # unrecognized status string.


@router.post("/onchain-events", status_code=200)
async def receive_onchain_event(
    payload: OnchainEventNotification,
    _auth: Annotated[None, Depends(require_indexer_webhook_key)],
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Claim).where(Claim.merkle_root == payload.merkle_root))
    claim = result.scalar_one_or_none()

    if claim is None:
        # Can legitimately happen — e.g. a claim submitted on-chain
        # whose off-chain POST /claims call never happened or hasn't
        # landed yet. The indexer logs this as a failed webhook and
        # moves on (see indexer/src/backendClient.js) rather than
        # treating it as fatal; same posture here.
        return {"status": "no_matching_claim", "merkle_root": payload.merkle_root}

    claim.onchain_claim_id = payload.onchain_claim_id
    claim.tx_hash = payload.tx_hash
    try:
        claim.status = ClaimStatus(payload.status)
    except ValueError:
        return {"status": "unrecognized_status", "received": payload.status}

    await db.commit()
    return {"status": "updated", "claim_id": claim.id}

"""
Idempotency-Key support for the one backend-initiated action in this
slice that costs real gas and must not fire twice on a client retry:
POST /claims/{id}/trigger-verification. Implemented as an explicit
helper called from the route rather than generic ASGI middleware — this
endpoint is the only one that needs it right now, and an explicit call
is easier to read and test than a middleware whose scope you have to
infer from a route decorator elsewhere.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import IdempotencyKey


async def get_cached_response(db: AsyncSession, key: str, endpoint: str) -> dict | None:
    record = await db.get(IdempotencyKey, key)
    if record is None:
        return None
    if record.endpoint != endpoint:
        # Same key reused against a different endpoint — treat as a
        # fresh request rather than silently returning a mismatched
        # cached response. This is a caller bug (keys should be
        # endpoint-scoped), surfaced as "no cache hit" rather than wrong
        # data being returned.
        return None
    return {"status_code": record.response_status, "body": record.response_body}


async def store_response(
    db: AsyncSession, key: str, endpoint: str, status_code: int, body: dict
) -> None:
    existing = await db.get(IdempotencyKey, key)
    if existing is not None:
        return  # first write wins; don't overwrite a concurrent request's stored result
    db.add(
        IdempotencyKey(
            key=key, endpoint=endpoint, response_status=status_code, response_body=body
        )
    )
    await db.commit()

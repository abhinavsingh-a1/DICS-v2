"""
Auth for inbound service-to-service calls (indexer -> backend), mirroring
oracle-service's src/auth.js: a shared-secret header, compared in
constant time. Same defense-in-depth caveat applies — this stops an
unauthenticated caller with network reach; it doesn't replace network
isolation, which should also restrict who can reach this endpoint at all
in any shared environment.
"""

import hmac

from fastapi import Header, HTTPException

from app.config import settings


async def require_indexer_webhook_key(x_indexer_webhook_key: str | None = Header(default=None)):
    if x_indexer_webhook_key is None:
        raise HTTPException(status_code=401, detail="missing_webhook_key")
    if not hmac.compare_digest(x_indexer_webhook_key, settings.indexer_webhook_api_key):
        raise HTTPException(status_code=401, detail="invalid_webhook_key")

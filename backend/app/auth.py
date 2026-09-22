"""
Wallet-signature authentication: issue a single-use nonce, verify an
EIP-191 signature over it, issue a JWT on success.
"""

import secrets
import time
from datetime import datetime, timedelta, timezone

from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi import Header, HTTPException
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import WalletNonce

NONCE_TTL_MINUTES = 5


def build_login_message(nonce: str) -> str:
    """
    The exact string the wallet must sign. Centralized here as the single
    source of truth so nothing else in the backend (or the frontend,
    which receives this via NonceResponse.message) has to reconstruct it
    and risk a mismatch — this is precisely the class of bug called out
    repeatedly earlier in this project (EIP-712 typehash, domain values):
    a hand-reconstructed constant silently produces signatures that fail
    to verify with no obvious cause.
    """
    return f"{settings.login_message_prefix} {nonce}"


async def generate_nonce(db: AsyncSession, address: str) -> str:
    address = address.lower()
    nonce = secrets.token_hex(16)
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=NONCE_TTL_MINUTES)

    existing = await db.get(WalletNonce, address)
    if existing:
        existing.nonce = nonce
        existing.expires_at = expires_at
        existing.used = False
    else:
        db.add(WalletNonce(address=address, nonce=nonce, expires_at=expires_at, used=False))
    await db.commit()
    return nonce


async def verify_signature_and_consume_nonce(db: AsyncSession, address: str, signature: str) -> bool:
    address = address.lower()
    record = await db.get(WalletNonce, address)
    if record is None or record.used:
        return False

    now = datetime.now(timezone.utc)
    expires_at = record.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if now > expires_at:
        return False

    message = build_login_message(record.nonce)
    encoded = encode_defunct(text=message)

    recovered_address: str | None
    try:
        recovered_address = Account.recover_message(encoded, signature=signature)
    except Exception:
        recovered_address = None

    # Mark used regardless of outcome — a malformed signature must
    # consume the nonce exactly the same as a validly-signed-but-wrong
    # one, or an attacker could probe indefinitely against a single
    # still-valid nonce using deliberately malformed signatures to avoid
    # burning it. The earlier version of this function only reached this
    # line on the non-exception path — fixed here.
    record.used = True
    await db.commit()

    if recovered_address is None:
        return False
    return recovered_address.lower() == address


def create_access_token(address: str) -> str:
    now = int(time.time())
    payload = {
        "sub": address.lower(),
        "iat": now,
        "exp": now + settings.jwt_exp_minutes * 60,
    }
    return jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)


async def get_current_address(authorization: str | None = Header(default=None)) -> str:
    if authorization is None or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or malformed Authorization header")
    token = authorization.removeprefix("Bearer ").strip()
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.jwt_algorithm])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return payload["sub"]

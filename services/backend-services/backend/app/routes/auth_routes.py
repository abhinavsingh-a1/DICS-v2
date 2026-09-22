from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import build_login_message, create_access_token, generate_nonce, verify_signature_and_consume_nonce
from app.db import get_db
from app.schemas import NonceResponse, TokenResponse, WalletLoginRequest

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/nonce", response_model=NonceResponse)
async def get_nonce(
    address: str = Query(pattern=r"^0x[a-fA-F0-9]{40}$"), db: AsyncSession = Depends(get_db)
):
    nonce = await generate_nonce(db, address)
    return NonceResponse(address=address, nonce=nonce, message=build_login_message(nonce))


@router.post("/wallet", response_model=TokenResponse)
async def login_wallet(payload: WalletLoginRequest, db: AsyncSession = Depends(get_db)):
    ok = await verify_signature_and_consume_nonce(db, payload.address, payload.signature)
    if not ok:
        raise HTTPException(status_code=401, detail="Invalid signature or nonce expired/already used")
    token = create_access_token(payload.address)
    return TokenResponse(access_token=token)

import os

# Env vars MUST be set before anything imports app.config — pydantic-settings
# reads them at Settings() instantiation time, same constraint documented
# in the oracle-service's JS tests (config.js reads process.env at import).
os.environ.setdefault("SECRET_KEY", "test-secret-key-not-for-production-use")
os.environ.setdefault("ORACLE_SERVICE_API_KEY", "test-oracle-api-key-not-real")
os.environ.setdefault("ORACLE_SERVICE_URL", "http://test-oracle-service")
os.environ.setdefault("INDEXER_WEBHOOK_API_KEY", "test-indexer-webhook-key-not-real")
os.environ.setdefault("INSURANCE_POLICY_ADDRESS", "0x2222222222222222222222222222222222BBBB")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite://")

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app.db import get_db
from app.main import app
from app.models import Base


@pytest_asyncio.fixture
async def db_session():
    # StaticPool required so SQLite's in-memory DB persists across the
    # multiple connections SQLAlchemy's async engine opens during a
    # single test — without it, each connection would see a fresh,
    # empty in-memory database.
    engine = create_async_engine(
        "sqlite+aiosqlite://",
        future=True,
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as session:
        yield session

    await engine.dispose()


@pytest_asyncio.fixture
async def client(db_session):
    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def auth_headers(client):
    """
    Performs a real nonce-and-signature login flow and returns headers
    ready to attach to an authenticated request, plus the wallet address
    used — for tests that need a logged-in user but aren't themselves
    testing the auth flow (that's test_auth.py's job).
    """
    from eth_account import Account
    from eth_account.messages import encode_defunct

    account = Account.create()
    nonce_res = await client.get("/auth/nonce", params={"address": account.address})
    message = nonce_res.json()["message"]
    signed = account.sign_message(encode_defunct(text=message))
    signature = signed.signature.hex()
    if not signature.startswith("0x"):
        signature = f"0x{signature}"

    login_res = await client.post(
        "/auth/wallet", json={"address": account.address, "signature": signature}
    )
    token = login_res.json()["access_token"]

    return {"headers": {"Authorization": f"Bearer {token}"}, "address": account.address}

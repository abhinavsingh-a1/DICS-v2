"""
Async SQLAlchemy engine/session setup. Deliberately avoids
Postgres-specific column types (e.g. JSONB) in models.py so the same
models run against both the production/dev docker-compose Postgres and a
lightweight SQLite file for fast unit tests — the SQLite tests validate
business logic (auth, claim lifecycle, idempotency), not
Postgres-specific behavior; a Postgres-backed integration test (the same
category as the oracle-service's real-Anvil test) is a reasonable next
step but isn't required for what's built in this pass.
"""

from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings

engine = create_async_engine(settings.database_url, echo=False, future=True)
async_session_factory = async_sessionmaker(engine, expire_on_commit=False)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_factory() as session:
        yield session


async def init_db() -> None:
    from app.models import Base

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

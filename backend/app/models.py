"""
ORM models. Column types kept portable across SQLite (tests) and
Postgres (dev/prod) — plain String/JSON/Boolean/DateTime, no
Postgres-only types — per the note in db.py.
"""

import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Enum, Float, ForeignKey, Integer, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ClaimStatus(str, enum.Enum):
    DRAFT = "draft"
    SUBMITTED = "submitted"
    UNDER_REVIEW = "under_review"
    APPROVED = "approved"
    REJECTED = "rejected"
    PAID = "paid"


class Claim(Base):
    __tablename__ = "claims"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    policy_id: Mapped[int] = mapped_column(Integer, nullable=False)
    claimant_address: Mapped[str] = mapped_column(String(42), nullable=False, index=True)
    declared_amount: Mapped[float] = mapped_column(Float, nullable=False)
    merkle_root: Mapped[str | None] = mapped_column(String(66), nullable=True)
    status: Mapped[ClaimStatus] = mapped_column(
        Enum(ClaimStatus), nullable=False, default=ClaimStatus.DRAFT
    )
    onchain_claim_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tx_hash: Mapped[str | None] = mapped_column(String(66), nullable=True)
    oracle_request_id: Mapped[str | None] = mapped_column(String(66), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    documents: Mapped[list["ClaimDocument"]] = relationship(
        back_populates="claim", cascade="all, delete-orphan"
    )


class ClaimDocument(Base):
    __tablename__ = "claim_documents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    claim_id: Mapped[int] = mapped_column(ForeignKey("claims.id"), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    sha256_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    file_cid: Mapped[str | None] = mapped_column(String(255), nullable=True)
    merkle_proof: Mapped[list | None] = mapped_column(JSON, nullable=True)
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    claim: Mapped["Claim"] = relationship(back_populates="documents")


class IdempotencyKey(Base):
    """
    Backs the idempotency middleware for POST /claims/{id}/trigger-verification
    — the sensitive, gas-costing, backend-initiated action in this slice.
    Earlier design docs scoped idempotency to a backend-orchestrated
    payout endpoint; the architecture that actually got built has
    underwriters triggering payout directly via the Safe/contract, not
    through this API, so this is the endpoint that actually needs the
    protection now — redirected rather than built against a design that
    no longer matches what exists.
    """

    __tablename__ = "idempotency_keys"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    endpoint: Mapped[str] = mapped_column(String(255), nullable=False)
    response_status: Mapped[int] = mapped_column(Integer, nullable=False)
    response_body: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class WalletNonce(Base):
    """
    Nonce storage for wallet-signature auth. Uses the DB rather than
    Redis for this slice — earlier design used Redis for the 5-minute TTL
    nonce; kept here as an explicit, documented simplification (a
    DB-backed nonce with an expires_at column, cleaned up on use, gives
    the same single-use guarantee without adding Redis as a hard
    dependency to run backend tests). Redis remains available in config
    for session/rate-limit use elsewhere; revisit if nonce volume ever
    makes DB writes a bottleneck.
    """

    __tablename__ = "wallet_nonces"

    address: Mapped[str] = mapped_column(String(42), primary_key=True)
    nonce: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used: Mapped[bool] = mapped_column(Boolean, default=False)

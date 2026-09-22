from datetime import datetime

from pydantic import BaseModel, Field

from app.models import ClaimStatus


class NonceResponse(BaseModel):
    address: str
    nonce: str
    message: str  # exact string the wallet must sign — returned so the
    # frontend never has to reconstruct the message format itself and
    # risk a whitespace/casing mismatch with what the backend verifies


class WalletLoginRequest(BaseModel):
    address: str = Field(pattern=r"^0x[a-fA-F0-9]{40}$")
    signature: str = Field(pattern=r"^0x[a-fA-F0-9]+$")


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class DocumentIn(BaseModel):
    filename: str
    sha256_hash: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    file_cid: str | None = None
    merkle_proof: list[str] | None = None


class CreateClaimRequest(BaseModel):
    policy_id: int
    declared_amount: float = Field(gt=0)
    merkle_root: str | None = Field(default=None, pattern=r"^0x[a-fA-F0-9]{64}$")
    documents: list[DocumentIn] = Field(default_factory=list)


class DocumentOut(BaseModel):
    id: str
    filename: str
    sha256_hash: str
    file_cid: str | None

    model_config = {"from_attributes": True}


class ClaimOut(BaseModel):
    id: int
    policy_id: int
    claimant_address: str
    declared_amount: float
    status: ClaimStatus
    onchain_claim_id: int | None
    tx_hash: str | None
    oracle_request_id: str | None
    created_at: datetime
    documents: list[DocumentOut] = Field(default_factory=list)

    model_config = {"from_attributes": True}


class TriggerVerificationResponse(BaseModel):
    claim_id: int
    approved: bool
    reason: str
    oracle_tx_hash: str
    status: ClaimStatus


class PolicyTemplateOut(BaseModel):
    """
    `coverage_amount_wei` and `premium_amount_per_period_wei` are typed
    as `str`, NOT `int` — deliberately, and not for the same reason
    given below about avoiding Python float rounding. These values
    round-trip through JSON to a JavaScript frontend, and JavaScript's
    `number` type is an IEEE-754 double with only ~53 bits of safe
    integer precision (`Number.MAX_SAFE_INTEGER` ≈ 9×10^15). An 18-
    decimal wei amount like `2_000 ether` is `2×10^21` — nine orders of
    magnitude past that limit. Serialized as a JSON *number*, a value
    that large would silently lose precision the instant
    `JSON.parse`/axios deserializes it, before `ethers.formatEther` ever
    sees it — a real, well-known gotcha wherever a Python/Node backend
    hands uint256-scale values to a browser. Serialized as a JSON
    *string* instead, the exact digits survive the round trip untouched,
    and `ethers.formatEther` accepts a numeric string just as happily as
    a native number. `period_seconds`/`term_seconds` stay plain `int` —
    they're durations in seconds, nowhere near this limit.
    """

    template_id: int
    coverage_amount_wei: str
    premium_amount_per_period_wei: str
    period_seconds: int
    term_seconds: int


class PolicyStatusOut(BaseModel):
    policy_id: int
    holder: str
    coverage_amount_wei: str  # see PolicyTemplateOut's docstring on why this is str, not int
    valid_from: int  # unix timestamp — small enough to be a safe JS integer
    valid_until: int  # unix timestamp
    revoked: bool
    premium_current: bool
    premium_paid_until: int  # unix timestamp, not a wei amount — safe as int
    premium_amount_per_period_wei: str  # same str reasoning as coverage_amount_wei

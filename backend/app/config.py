"""
Runtime-validated configuration via pydantic-settings. Same principle
applied throughout this project (oracle-service's config.js, the smart
contracts' explicit revert reasons): fail loudly and immediately on a
misconfiguration, rather than discovering it three requests later as a
confusing downstream error.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "dev"
    secret_key: str  # required — no insecure default; startup fails without one
    jwt_algorithm: str = "HS256"
    jwt_exp_minutes: int = 1440

    database_url: str = "sqlite+aiosqlite:///./dics_dev.db"
    redis_url: str = "redis://localhost:6379/0"

    # EIP-191 login message prefix — MUST match exactly what the frontend
    # asks the wallet to sign, character-for-character (case and
    # whitespace-sensitive), or every signature verification fails.
    # Uses the project's dummy org name throughout, never a real company.
    login_message_prefix: str = "Aurelia Labs login nonce:"

    # --- Oracle service integration ---
    oracle_service_url: str = "http://localhost:4100"
    oracle_service_api_key: str  # required — matches ORACLE_SERVICE_API_KEY in oracle-service/.env
    oracle_service_timeout_seconds: float = 10.0

    # --- Indexer webhook (inbound) ---
    # MUST match BACKEND_WEBHOOK_API_KEY in indexer/.env exactly.
    indexer_webhook_api_key: str

    # --- Read-only chain connection (NEW) ---
    # Everything else in this backend avoids talking to the chain
    # directly — claims are submitted by the frontend's own wallet, and
    # confirmed status arrives later via the indexer's webhook (see
    # internal_routes.py). This is the one deliberate exception: browsing
    # the policy catalog and checking premium status are READ-ONLY chain
    # calls, and a person should be able to see them without a wallet
    # connected at all (e.g. before deciding whether to buy a plan) — the
    # indexer doesn't sync this data, and requiring a wallet just to
    # browse would be a worse experience than a plain page load.
    rpc_url: str = "http://localhost:8545"
    insurance_policy_address: str  # required — no safe default for a contract address
    chain_id: int = 1337


settings = Settings()

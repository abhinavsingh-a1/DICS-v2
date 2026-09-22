-- Indexer-owned schema. Deliberately separate from the backend's
-- SQLAlchemy-owned `claims` table (see indexer/README.md "Ownership
-- boundary" section) — two services should not both own migrations for
-- the same table. This schema is the indexer's own mirror of on-chain
-- truth; reconciliation.js compares it against the backend's table
-- rather than the indexer writing into that table directly.

CREATE TABLE IF NOT EXISTS indexer_checkpoints (
  contract_address TEXT PRIMARY KEY,
  last_processed_block BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS onchain_events (
  id BIGSERIAL PRIMARY KEY,
  event_name TEXT NOT NULL,
  contract_address TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  event_data JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tx_hash, log_index)  -- the actual duplicate-event protection boundary
);

CREATE TABLE IF NOT EXISTS onchain_claims (
  onchain_claim_id BIGINT PRIMARY KEY,
  policy_id BIGINT NOT NULL,
  claimant_address TEXT NOT NULL,
  merkle_root TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  status TEXT NOT NULL,
  submitted_tx_hash TEXT NOT NULL,
  submitted_block BIGINT NOT NULL,
  last_status_tx_hash TEXT,
  payout_tx_hash TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS onchain_policies (
  onchain_policy_id BIGINT PRIMARY KEY,
  holder_address TEXT NOT NULL,
  coverage_amount NUMERIC NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT false,
  registered_tx_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

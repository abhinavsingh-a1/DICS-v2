import { getPool } from './db.js';
import { CLAIM_STATUS_NAMES } from './rpcClient.js';
import { reportClaimEvent } from './backendClient.js';

/**
 * Records the raw event exactly once, using the (tx_hash, log_index)
 * unique constraint from schema.sql as the actual duplicate-protection
 * boundary — not application-level "have I seen this before" logic,
 * which would need its own persistence anyway. Returns whether this
 * call was the one that inserted it (false means "already processed,
 * likely a re-scan after a restart" — the caller should skip the
 * state-mutating side effects below but the raw event row itself is
 * safely idempotent to attempt-insert repeatedly).
 */
async function persistRawEventOnce(log, eventName, contractAddress, data) {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO onchain_events (event_name, contract_address, tx_hash, log_index, block_number, event_data)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tx_hash, log_index) DO NOTHING
     RETURNING id`,
    [eventName, contractAddress.toLowerCase(), log.transactionHash, log.index, log.blockNumber, data]
  );
  return result.rowCount > 0;
}

export async function handleClaimSubmitted(log, args, contractAddress) {
  const data = {
    claimId: args.claimId.toString(),
    policyId: args.policyId.toString(),
    claimant: args.claimant,
    merkleRoot: args.merkleRoot,
    amount: args.amount.toString(),
    timestamp: args.timestamp.toString(),
  };

  const isNew = await persistRawEventOnce(log, 'ClaimSubmitted', contractAddress, data);
  if (!isNew) return;

  const pool = getPool();
  await pool.query(
    `INSERT INTO onchain_claims
       (onchain_claim_id, policy_id, claimant_address, merkle_root, amount, status, submitted_tx_hash, submitted_block)
     VALUES ($1, $2, $3, $4, $5, 'submitted', $6, $7)
     ON CONFLICT (onchain_claim_id) DO NOTHING`,
    [data.claimId, data.policyId, data.claimant.toLowerCase(), data.merkleRoot, data.amount, log.transactionHash, log.blockNumber]
  );

  await reportClaimEvent({
    eventName: 'ClaimSubmitted',
    onchainClaimId: data.claimId,
    merkleRoot: data.merkleRoot,
    txHash: log.transactionHash,
    status: 'submitted',
  });
}

export async function handleClaimStatusChanged(log, args, contractAddress) {
  const statusName = CLAIM_STATUS_NAMES[args.status] ?? `unknown(${args.status})`;
  const data = { claimId: args.claimId.toString(), status: args.status, statusName };

  const isNew = await persistRawEventOnce(log, 'ClaimStatusChanged', contractAddress, data);
  if (!isNew) return;

  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE onchain_claims
     SET status = $2, last_status_tx_hash = $3, updated_at = now()
     WHERE onchain_claim_id = $1
     RETURNING merkle_root`,
    [data.claimId, statusName, log.transactionHash]
  );

  if (rows.length === 0) {
    // A status change for a claim this indexer hasn't recorded a
    // ClaimSubmitted for yet — can legitimately happen on first sync if
    // this scan window starts after the submission block. Log rather
    // than silently drop, since it's a signal the checkpoint/deploy
    // block configuration may need review.
    // eslint-disable-next-line no-console
    console.warn(`[eventHandlers] ClaimStatusChanged for unknown claimId ${data.claimId}`);
    return;
  }

  await reportClaimEvent({
    eventName: 'ClaimStatusChanged',
    onchainClaimId: data.claimId,
    merkleRoot: rows[0].merkle_root,
    txHash: log.transactionHash,
    status: statusName,
  });
}

export async function handleClaimPayout(log, args, contractAddress) {
  const data = {
    claimId: args.claimId.toString(),
    to: args.to,
    amount: args.amount.toString(),
    token: args.token,
  };

  const isNew = await persistRawEventOnce(log, 'ClaimPayout', contractAddress, data);
  if (!isNew) return;

  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE onchain_claims
     SET status = 'paid', payout_tx_hash = $2, updated_at = now()
     WHERE onchain_claim_id = $1
     RETURNING merkle_root`,
    [data.claimId, log.transactionHash]
  );

  if (rows.length > 0) {
    await reportClaimEvent({
      eventName: 'ClaimPayout',
      onchainClaimId: data.claimId,
      merkleRoot: rows[0].merkle_root,
      txHash: log.transactionHash,
      status: 'paid',
    });
  }
}

export async function handlePolicyRegistered(log, args, contractAddress) {
  const data = {
    policyId: args.policyId.toString(),
    holder: args.holder,
    validFrom: args.validFrom.toString(),
    validUntil: args.validUntil.toString(),
    coverageAmount: args.coverageAmount.toString(),
  };

  const isNew = await persistRawEventOnce(log, 'PolicyRegistered', contractAddress, data);
  if (!isNew) return;

  const pool = getPool();
  await pool.query(
    `INSERT INTO onchain_policies
       (onchain_policy_id, holder_address, coverage_amount, valid_from, valid_until, registered_tx_hash)
     VALUES ($1, $2, $3, to_timestamp($4), to_timestamp($5), $6)
     ON CONFLICT (onchain_policy_id) DO NOTHING`,
    [data.policyId, data.holder.toLowerCase(), data.coverageAmount, data.validFrom, data.validUntil, log.transactionHash]
  );
}

export async function handlePolicyRevoked(log, args, contractAddress) {
  const data = { policyId: args.policyId.toString() };
  const isNew = await persistRawEventOnce(log, 'PolicyRevoked', contractAddress, data);
  if (!isNew) return;

  const pool = getPool();
  await pool.query(
    `UPDATE onchain_policies SET revoked = true, updated_at = now() WHERE onchain_policy_id = $1`,
    [data.policyId]
  );
}

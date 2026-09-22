import { getPool } from './db.js';

/**
 * Per-contract checkpoint (not a single global one) — ClaimRegistry and
 * InsurancePolicy are scanned independently, so a slow/failing scan of
 * one shouldn't block or corrupt the other's progress.
 *
 * Returns `null` when no checkpoint row exists yet — deliberately NOT a
 * sentinel value like the contract's deploy block, because the caller
 * needs to distinguish "no checkpoint, start scanning AT deployBlock"
 * from "a real checkpoint whose value happens to equal deployBlock,
 * resume AFTER it" — those require different +1 handling, and
 * conflating them was an actual off-by-one bug caught while writing
 * listener.js (see scanContract's resumeFromBlock computation).
 */
export async function getLastProcessedBlock(contractAddress) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT last_processed_block FROM indexer_checkpoints WHERE contract_address = $1',
    [contractAddress.toLowerCase()]
  );
  if (rows.length === 0) return null;
  return Number(rows[0].last_processed_block);
}

export async function setLastProcessedBlock(contractAddress, blockNumber) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO indexer_checkpoints (contract_address, last_processed_block)
     VALUES ($1, $2)
     ON CONFLICT (contract_address)
     DO UPDATE SET last_processed_block = EXCLUDED.last_processed_block`,
    [contractAddress.toLowerCase(), blockNumber]
  );
}

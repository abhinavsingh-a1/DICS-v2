import { config } from './config.js';
import { ensureSchema } from './db.js';
import { getProvider, getClaimRegistryContract, getInsurancePolicyContract } from './rpcClient.js';
import { getLastProcessedBlock, setLastProcessedBlock } from './checkpoint.js';
import {
  handleClaimSubmitted,
  handleClaimStatusChanged,
  handleClaimPayout,
  handlePolicyRegistered,
  handlePolicyRevoked,
} from './eventHandlers.js';

const HANDLERS = {
  ClaimSubmitted: handleClaimSubmitted,
  ClaimStatusChanged: handleClaimStatusChanged,
  ClaimPayout: handleClaimPayout,
  PolicyRegistered: handlePolicyRegistered,
  PolicyRevoked: handlePolicyRevoked,
};

/**
 * Scans one contract from its last checkpoint up to (chain head minus
 * REORG_SAFETY_BLOCKS), in chunks of BLOCK_RANGE_CHUNK_SIZE, dispatching
 * each decoded log to its handler and advancing the checkpoint after
 * each successfully-processed chunk (not after each log — a chunk is
 * the unit of "safely resumable" here).
 *
 * Exported (not just called from a top-level loop) specifically so
 * indexer.integration.test.js can call a single scan pass deterministically
 * against a real chain, rather than needing to race a background poll
 * interval in a test.
 */
export async function scanContract(contract, deployBlock) {
  const provider = getProvider();
  const address = await contract.getAddress();
  const currentHead = await provider.getBlockNumber();
  const safeHead = Math.max(0, currentHead - config.reorgSafetyBlocks);

  const checkpoint = await getLastProcessedBlock(address);
  // No checkpoint row yet → start scanning AT deployBlock (inclusive).
  // A real checkpoint exists → resume AFTER it. Conflating these two
  // cases into a single sentinel-return-value scheme was the actual
  // off-by-one bug caught while writing this — see checkpoint.js.
  const fromBlock = checkpoint === null ? deployBlock : checkpoint + 1;

  if (fromBlock > safeHead) return { scanned: 0, fromBlock, safeHead };

  let cursor = fromBlock;
  let totalScanned = 0;
  while (cursor <= safeHead) {
    const toBlock = Math.min(cursor + config.blockRangeChunkSize - 1, safeHead);

    const logs = await provider.getLogs({ address, fromBlock: cursor, toBlock });
    // Logs are returned in block/log-index order by RPC convention;
    // process in that order so, e.g., a ClaimSubmitted always lands
    // before a ClaimStatusChanged for the same claim within one chunk.
    for (const log of logs) {
      let parsed;
      try {
        parsed = contract.interface.parseLog(log);
      } catch {
        continue; // a log from this address that isn't one of our known events — ignore
      }
      const handler = HANDLERS[parsed.name];
      if (handler) {
        await handler(log, parsed.args, address);
        totalScanned += 1;
      }
    }

    await setLastProcessedBlock(address, toBlock);
    cursor = toBlock + 1;
  }

  return { scanned: totalScanned, fromBlock, safeHead };
}

export async function runOnePass() {
  const claimRegistry = getClaimRegistryContract();
  const insurancePolicy = getInsurancePolicyContract();

  const [policyResult, claimResult] = [
    await scanContract(insurancePolicy, config.insurancePolicyDeployBlock),
    // Policies scanned first — a ClaimSubmitted event's downstream
    // consumers (e.g. a future reconciliation pass) may expect the
    // policy to already be known, even though ClaimRegistry itself
    // doesn't depend on this ordering at the contract level.
    await scanContract(claimRegistry, config.claimRegistryDeployBlock),
  ];

  return { policyResult, claimResult };
}

async function mainLoop() {
  await ensureSchema();
  // eslint-disable-next-line no-console
  console.log(`[indexer] starting — chainId ${config.chainId}, poll every ${config.pollIntervalMs}ms`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const { policyResult, claimResult } = await runOnePass();
      if (policyResult.scanned > 0 || claimResult.scanned > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[indexer] processed ${policyResult.scanned} policy event(s), ${claimResult.scanned} claim event(s)`
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[indexer] scan pass failed:', err);
      // Deliberately does not exit the loop — a transient RPC or DB
      // blip should be retried on the next interval, not crash the
      // process. A sustained failure will just keep logging until
      // whatever's wrong (RPC down, DB down) is fixed.
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
}

const isEntryPoint = process.argv[1] && process.argv[1].endsWith('listener.js');
if (isEntryPoint) {
  mainLoop();
}

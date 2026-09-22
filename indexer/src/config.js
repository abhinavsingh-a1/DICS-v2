import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  RPC_URL: z.string().url(),
  CHAIN_ID: z.coerce.number().int().positive(),
  DATABASE_URL: z.string().min(1),
  CLAIM_REGISTRY_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  INSURANCE_POLICY_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3000),
  // How many blocks per eth_getLogs call — chunked to stay under RPC
  // provider log-range limits, which Besu and most public RPC providers
  // enforce (typically far below "just query from genesis to head").
  BLOCK_RANGE_CHUNK_SIZE: z.coerce.number().int().positive().default(2000),
  BACKEND_URL: z.string().url().optional(),
  BACKEND_WEBHOOK_API_KEY: z.string().min(16).optional(),
  CLAIM_REGISTRY_DEPLOY_BLOCK: z.coerce.number().int().nonnegative().default(0),
  INSURANCE_POLICY_DEPLOY_BLOCK: z.coerce.number().int().nonnegative().default(0),
  // Blocks held back from the chain head before scanning, as a shallow
  // mitigation against very-recent-block reorgs. This does NOT handle
  // deep reorgs (beyond this margin) — see README "still open".
  REORG_SAFETY_BLOCKS: z.coerce.number().int().nonnegative().default(2),
});

function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('Invalid indexer configuration:', parsed.error.format());
    process.exit(1);
  }
  const env = parsed.data;

  if (env.BACKEND_URL && !env.BACKEND_WEBHOOK_API_KEY) {
    // eslint-disable-next-line no-console
    console.error(
      'BACKEND_URL is set but BACKEND_WEBHOOK_API_KEY is not — the ' +
        'backend will reject unauthenticated webhook calls. Set both or neither.'
    );
    process.exit(1);
  }

  return {
    rpcUrl: env.RPC_URL,
    chainId: env.CHAIN_ID,
    databaseUrl: env.DATABASE_URL,
    claimRegistryAddress: env.CLAIM_REGISTRY_ADDRESS,
    insurancePolicyAddress: env.INSURANCE_POLICY_ADDRESS,
    pollIntervalMs: env.POLL_INTERVAL_MS,
    blockRangeChunkSize: env.BLOCK_RANGE_CHUNK_SIZE,
    backendUrl: env.BACKEND_URL,
    backendWebhookApiKey: env.BACKEND_WEBHOOK_API_KEY,
    claimRegistryDeployBlock: env.CLAIM_REGISTRY_DEPLOY_BLOCK,
    insurancePolicyDeployBlock: env.INSURANCE_POLICY_DEPLOY_BLOCK,
    reorgSafetyBlocks: env.REORG_SAFETY_BLOCKS,
  };
}

export const config = loadConfig();

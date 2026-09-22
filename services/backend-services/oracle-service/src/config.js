import 'dotenv/config';
import { z } from 'zod';

/**
 * Runtime-validated environment configuration. Per the project's JS
 * policy, external input — including env vars, which are just as
 * "untrusted" as network input from the perspective of "did a human typo
 * this" — is validated at the boundary rather than trusted implicitly.
 * A misconfigured EIP-712 domain or chain ID here produces signatures
 * that silently fail to verify on-chain with no helpful error, so this
 * is exactly the kind of thing worth failing loudly and immediately on
 * startup instead of discovering it via a confusing on-chain revert.
 */
const envSchema = z.object({
  RPC_URL: z.string().url(),
  CHAIN_ID: z.coerce.number().int().positive(),
  ORACLE_ADAPTER_ADDRESS: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'ORACLE_ADAPTER_ADDRESS must be a valid 20-byte address'),
  ORACLE_SIGNER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/, 'ORACLE_SIGNER_PRIVATE_KEY must be a 32-byte hex private key'),
  RELAYER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/)
    .optional()
    .or(z.literal('')),
  PORT: z.coerce.number().int().positive().default(4100),
  EIP712_DOMAIN_NAME: z.string().min(1),
  EIP712_DOMAIN_VERSION: z.string().min(1),
  ORACLE_SERVICE_API_KEY: z.string().min(16, 'ORACLE_SERVICE_API_KEY must be at least 16 characters'),
});

function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Fail loudly and immediately at startup, not on the first request.
    // eslint-disable-next-line no-console
    console.error('Invalid oracle-service configuration:');
    // eslint-disable-next-line no-console
    console.error(parsed.error.format());
    process.exit(1);
  }

  const env = parsed.data;
  const relayerKey = env.RELAYER_PRIVATE_KEY || env.ORACLE_SIGNER_PRIVATE_KEY;

  if (relayerKey === env.ORACLE_SIGNER_PRIVATE_KEY) {
    // Not fatal — the contract design permits this (submission is
    // permissionless) — but worth a visible warning, since separating
    // the signing key from the gas-paying relayer key is a meaningful
    // security improvement documented in the README.
    // eslint-disable-next-line no-console
    console.warn(
      '[config] RELAYER_PRIVATE_KEY not set — relaying with the same key ' +
        'used for ORACLE_SIGNER_PRIVATE_KEY. Fine for local development; ' +
        'use a separate relayer key beyond that. See README.'
    );
  }

  return {
    rpcUrl: env.RPC_URL,
    chainId: env.CHAIN_ID,
    oracleAdapterAddress: env.ORACLE_ADAPTER_ADDRESS,
    signerPrivateKey: env.ORACLE_SIGNER_PRIVATE_KEY,
    relayerPrivateKey: relayerKey,
    port: env.PORT,
    eip712: {
      name: env.EIP712_DOMAIN_NAME,
      version: env.EIP712_DOMAIN_VERSION,
    },
    apiKey: env.ORACLE_SERVICE_API_KEY,
  };
}

export const config = loadConfig();

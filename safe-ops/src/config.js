require('dotenv').config();

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

/**
 * Same "fail loudly, immediately, at startup" principle used by every
 * other service's config module in this project (oracle-service's
 * config.js, the backend's config.py, notification-service's
 * config.go) — a missing address or key should surface as one clear
 * error here, not a confusing failure three calls into a Safe
 * transaction.
 */
function loadConfig() {
  return {
    rpcUrl: requireEnv('RPC_URL'),
    chainId: parseInt(process.env.CHAIN_ID || '1337', 10),
    claimRegistryAddress: requireEnv('CLAIM_REGISTRY_ADDRESS'),

    awsRegion: requireEnv('AWS_REGION'),
    // One KMS key ID per employee-owner, comma-separated — deliberately
    // NOT one shared key. Each owner having their own KMS key (and
    // therefore their own IAM permissions controlling who can invoke
    // it) is what makes the "employee leaves -> remove them" story
    // actually work at the KEY level, not just the Safe level: revoking
    // one person's IAM access to their KMS key is what actually takes
    // their signing ability away, separate from and in addition to the
    // Safe-level removeOwner call.
    ownerKmsKeyIds: requireEnv('OWNER_KMS_KEY_IDS').split(',').map((s) => s.trim()),

    safeThreshold: parseInt(process.env.SAFE_THRESHOLD || '2', 10),

    // Only populated once 02-create-underwriter-safe.js has actually
    // run — every later script needs this, but the two infrastructure/
    // creation scripts deliberately don't require it to already exist.
    safeAddress: process.env.UNDERWRITER_SAFE_ADDRESS || null,

    // Populated by 01-deploy-safe-infrastructure.js's own output — see
    // that script's header for why these can't just be the canonical
    // mainnet addresses on a private Besu network.
    safeProxyFactoryAddress: process.env.SAFE_PROXY_FACTORY_ADDRESS || null,
    safeSingletonAddress: process.env.SAFE_SINGLETON_ADDRESS || null,
    safeFallbackHandlerAddress: process.env.SAFE_FALLBACK_HANDLER_ADDRESS || null,
  };
}

module.exports = { loadConfig, requireEnv };

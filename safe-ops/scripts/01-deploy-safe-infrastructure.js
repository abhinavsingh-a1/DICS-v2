/**
 * Deploys the Safe CORE contracts (the proxy factory, the Safe
 * singleton/logic contract, and the compatibility fallback handler)
 * onto Besu — a one-time, per-network setup step.
 *
 * Why this step exists at all: on Ethereum mainnet and most public
 * testnets, these contracts already exist at well-known addresses
 * (deployed once, long ago, via a deterministic CREATE2 factory so
 * every chain that has them has them at the SAME address). A private
 * Besu network has none of that history — nobody has ever deployed
 * these contracts here before. `@safe-global/protocol-kit` (used in
 * every later script) assumes these contracts already exist at some
 * address on whatever chain it's pointed at; it has no "bootstrap a
 * fresh chain" mode. This script is that bootstrap step, run exactly
 * once per network.
 *
 * Uses `@safe-global/safe-deployments` for the actual contract
 * bytecode/ABI — the same canonical artifacts Safe itself publishes and
 * that protocol-kit expects, rather than hand-copied bytecode this
 * project has no way to verify is correct. Deployed addresses will
 * differ from the canonical mainnet ones (this is a fresh, non-CREATE2
 * deployment) — every later script reads them from
 * `SAFE_PROXY_FACTORY_ADDRESS` etc. in `.env`, not from any hardcoded
 * assumption.
 *
 * NOT KMS-signed. Deliberately: this is a one-time, low-frequency,
 * infrastructure-bootstrap action, distinct from the recurring
 * "employees approve claims" flow the rest of this project cares about
 * protecting with KMS + multisig. A funded local deployer key
 * (DEPLOYER_PRIVATE_KEY) is used here, the same category of key
 * besu-network's other deploy scripts already use.
 */
const { ethers } = require('ethers');
const {
  getProxyFactoryDeployment,
  getSafeSingletonDeployment,
  getCompatibilityFallbackHandlerDeployment,
} = require('@safe-global/safe-deployments');
const { loadConfig, requireEnv } = require('../src/config');

// The Safe contracts version to deploy — pinned explicitly rather than
// left to whatever @safe-global/safe-deployments' default resolves to,
// since protocol-kit's own behavior depends on knowing exactly which
// version is live on-chain (see 02-create-underwriter-safe.js).
const SAFE_VERSION = '1.4.1';

async function deployFromArtifact(deploymentGetter, label, chainId, wallet) {
  const deployment = deploymentGetter({ version: SAFE_VERSION });
  if (!deployment) {
    throw new Error(`No ${label} deployment artifact found for Safe version ${SAFE_VERSION}`);
  }

  // safe-deployments' artifacts include network-specific metadata for
  // chains it already knows about, but the ABI/bytecode themselves are
  // chain-agnostic — what actually gets deployed here.
  const abi = deployment.abi;
  const bytecode = deployment.deployments?.canonical?.data || deployment.deployments?.eip155?.data;
  if (!bytecode) {
    throw new Error(`No deployable bytecode found in the ${label} artifact — verify @safe-global/safe-deployments' export shape for version ${SAFE_VERSION} before trusting this script further.`);
  }

  console.log(`Deploying ${label} (Safe v${SAFE_VERSION})...`);
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(`  -> ${label} deployed at ${address}`);
  return address;
}

async function main() {
  const config = loadConfig();
  const deployerPrivateKey = requireEnv('DEPLOYER_PRIVATE_KEY');

  const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
  const wallet = new ethers.Wallet(deployerPrivateKey, provider);

  console.log(`Deploying Safe infrastructure to ${config.rpcUrl} (chainId ${config.chainId})`);
  console.log(`Deployer: ${wallet.address}`);

  const singletonAddress = await deployFromArtifact(getSafeSingletonDeployment, 'Safe singleton', config.chainId, wallet);
  const proxyFactoryAddress = await deployFromArtifact(getProxyFactoryDeployment, 'SafeProxyFactory', config.chainId, wallet);
  const fallbackHandlerAddress = await deployFromArtifact(
    getCompatibilityFallbackHandlerDeployment,
    'CompatibilityFallbackHandler',
    config.chainId,
    wallet
  );

  console.log('\nDone. Add these to your .env before running any other script:\n');
  console.log(`SAFE_SINGLETON_ADDRESS=${singletonAddress}`);
  console.log(`SAFE_PROXY_FACTORY_ADDRESS=${proxyFactoryAddress}`);
  console.log(`SAFE_FALLBACK_HANDLER_ADDRESS=${fallbackHandlerAddress}`);
}

main().catch((err) => {
  console.error('Safe infrastructure deployment failed:', err);
  process.exit(1);
});

/**
 * Deploys ONE new Safe — the actual underwriter multisig — with one
 * owner per configured KMS key (one per employee) and the configured
 * threshold. Run once per Safe; re-run only to deploy a SECOND,
 * different Safe (e.g. a separate one for a different role/team).
 *
 * Owners are derived directly from each employee's own KMS key
 * (KmsSigner.getAddress()) — nobody's private key, including the
 * deployer's, is ever the thing that actually controls this Safe.
 * The deployer (DEPLOYER_PRIVATE_KEY, same key used in
 * 01-deploy-safe-infrastructure.js) only pays the gas to create the
 * Safe; it is NOT added as an owner and has no special standing once
 * deployment finishes — worth confirming directly against the
 * `owners`/`threshold` this script prints at the end, not just assumed.
 */
const { KMSClient } = require('@aws-sdk/client-kms');
const { ethers } = require('ethers');
const Safe = require('@safe-global/protocol-kit').default;
const { loadConfig, requireEnv } = require('../src/config');
const { KmsSigner } = require('../src/kmsSigner');

async function main() {
  const config = loadConfig();
  if (!config.safeProxyFactoryAddress || !config.safeSingletonAddress) {
    throw new Error(
      'SAFE_PROXY_FACTORY_ADDRESS / SAFE_SINGLETON_ADDRESS are not set — ' +
        'run 01-deploy-safe-infrastructure.js first and add its output to .env'
    );
  }

  const deployerPrivateKey = requireEnv('DEPLOYER_PRIVATE_KEY');
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
  const deployerWallet = new ethers.Wallet(deployerPrivateKey, provider);

  const kmsClient = new KMSClient({ region: config.awsRegion });

  console.log(`Resolving ${config.ownerKmsKeyIds.length} owner addresses from KMS...`);
  const ownerAddresses = [];
  for (const keyId of config.ownerKmsKeyIds) {
    const signer = new KmsSigner(kmsClient, keyId, provider);
    const address = await signer.getAddress();
    ownerAddresses.push(address);
    console.log(`  KMS key ${keyId} -> ${address}`);
  }

  if (config.safeThreshold > ownerAddresses.length) {
    throw new Error(
      `SAFE_THRESHOLD (${config.safeThreshold}) cannot exceed the number of owners (${ownerAddresses.length})`
    );
  }

  console.log(`\nDeploying Safe: ${ownerAddresses.length} owners, threshold ${config.safeThreshold}`);

  // protocol-kit's deployment flow, per its own documented pattern:
  // describe the desired Safe via `predictedSafe` (this computes the
  // Safe's future address deterministically, before it's actually
  // deployed), then explicitly send the deployment transaction using
  // the deployer wallet. See this file's header, and the design
  // document (docs/services/10), for the caveat on why this exact
  // sequence should be verified against the real installed
  // @safe-global/protocol-kit version before being trusted blind.
  const protocolKit = await Safe.init({
    provider: config.rpcUrl,
    signer: deployerPrivateKey,
    predictedSafe: {
      safeAccountConfig: {
        owners: ownerAddresses,
        threshold: config.safeThreshold,
      },
      safeDeploymentConfig: {
        safeVersion: '1.4.1',
      },
    },
  });

  const predictedAddress = await protocolKit.getAddress();
  console.log(`Predicted Safe address: ${predictedAddress}`);

  const deploymentTransaction = await protocolKit.createSafeDeploymentTransaction();
  const txResponse = await deployerWallet.sendTransaction({
    to: deploymentTransaction.to,
    data: deploymentTransaction.data,
    value: deploymentTransaction.value,
  });
  const receipt = await txResponse.wait();
  console.log(`Deployment transaction mined: ${receipt.hash}`);

  console.log('\nDone. Add this to your .env before running any other script:\n');
  console.log(`UNDERWRITER_SAFE_ADDRESS=${predictedAddress}`);
  console.log(`\nOwners:`);
  ownerAddresses.forEach((addr, i) => console.log(`  ${i + 1}. ${addr} (KMS key: ${config.ownerKmsKeyIds[i]})`));
  console.log(`Threshold: ${config.safeThreshold} of ${ownerAddresses.length}`);
}

main().catch((err) => {
  console.error('Safe creation failed:', err);
  process.exit(1);
});

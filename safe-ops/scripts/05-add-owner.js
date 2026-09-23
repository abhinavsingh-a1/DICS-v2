/**
 * Onboards a new employee onto the underwriter Safe — adds a new owner
 * address (derived from their own new KMS key, provisioned separately
 * BEFORE running this script — see docs/services/10's onboarding
 * checklist) and, if given, updates the threshold at the same time.
 *
 * Like every other Safe-state change (not just ClaimRegistry actions),
 * adding an owner is ITSELF a Safe transaction requiring the existing
 * threshold's worth of signatures — a single existing owner cannot
 * unilaterally add someone new, by the Safe contract's own design, not
 * anything specific to this script.
 *
 * Usage: node scripts/05-add-owner.js <newOwnerKmsKeyId> [newThreshold]
 */
const { KMSClient } = require('@aws-sdk/client-kms');
const { ethers } = require('ethers');
const Safe = require('@safe-global/protocol-kit').default;
const { loadConfig } = require('../src/config');
const { KmsSigner } = require('../src/kmsSigner');
const { signAndExecute } = require('../src/signAndExecute');

async function main() {
  const [, , newOwnerKmsKeyId, newThresholdArg] = process.argv;
  if (!newOwnerKmsKeyId) {
    console.error('Usage: node scripts/05-add-owner.js <newOwnerKmsKeyId> [newThreshold]');
    process.exit(1);
  }

  const config = loadConfig();
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
  const kmsClient = new KMSClient({ region: config.awsRegion });

  const newOwnerSigner = new KmsSigner(kmsClient, newOwnerKmsKeyId, provider);
  const newOwnerAddress = await newOwnerSigner.getAddress();
  console.log(`New owner: KMS key ${newOwnerKmsKeyId} -> ${newOwnerAddress}`);

  const protocolKit = await Safe.init({ provider: config.rpcUrl, safeAddress: config.safeAddress });

  const addOwnerTx = await protocolKit.createAddOwnerTx({
    ownerAddress: newOwnerAddress,
    ...(newThresholdArg ? { threshold: parseInt(newThresholdArg, 10) } : {}),
  });

  await signAndExecute(config, provider, addOwnerTx);

  console.log(
    `\nDone. Remember to also add ${newOwnerKmsKeyId} to OWNER_KMS_KEY_IDS in every ` +
      `deployment's .env that references this Safe — this script only changed on-chain ` +
      `state, not any configuration file.`
  );
}

main().catch((err) => {
  console.error('Add-owner failed:', err);
  process.exit(1);
});

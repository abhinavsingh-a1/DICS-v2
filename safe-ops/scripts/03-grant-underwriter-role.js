/**
 * Grants ClaimRegistry.UNDERWRITER_ROLE to the Safe deployed by
 * 02-create-underwriter-safe.js — the actual change that makes
 * `approve`/`reject`/`payout` require a real multisig quorum from here
 * on, replacing the single-EOA `UNDERWRITER_PRIVATE_KEY` model
 * underwriter-service's own README previously flagged as a known
 * simplification (see docs/services/10 for the full before/after).
 *
 * HONEST CAVEAT ABOUT WHO CAN ACTUALLY RUN THIS SCRIPT: `grantRole`
 * itself requires the CALLER to hold `DEFAULT_ADMIN_ROLE` on
 * ClaimRegistry — in this project's real intended design, that's the
 * claims Timelock, not any single EOA (see
 * docs/Project-1-Smart-Contracts-Explained.md's governance sections).
 * This script signs with DEPLOYER_PRIVATE_KEY and will only succeed if
 * that address genuinely holds DEFAULT_ADMIN_ROLE — true on a fresh
 * local/test deployment where the deployer hasn't yet handed admin off
 * to a Timelock, false on anything resembling a real deployment. On a
 * real deployment, this exact `grantRole(UNDERWRITER_ROLE, safeAddress)`
 * call becomes the CALLDATA for a Timelock proposal instead of a
 * directly-sent transaction — this script still tells you what that
 * calldata needs to be (see the dry-run output below), it just can't
 * be the thing that actually executes it in that case.
 */
const { ethers } = require('ethers');
const { loadConfig, requireEnv } = require('../src/config');

const CLAIM_REGISTRY_ABI = [
  'function UNDERWRITER_ROLE() external view returns (bytes32)',
  'function grantRole(bytes32 role, address account) external',
  'function hasRole(bytes32 role, address account) external view returns (bool)',
];

async function main() {
  const config = loadConfig();
  if (!config.safeAddress) {
    throw new Error('UNDERWRITER_SAFE_ADDRESS is not set — run 02-create-underwriter-safe.js first');
  }

  const deployerPrivateKey = requireEnv('DEPLOYER_PRIVATE_KEY');
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
  const wallet = new ethers.Wallet(deployerPrivateKey, provider);

  const claimRegistry = new ethers.Contract(config.claimRegistryAddress, CLAIM_REGISTRY_ABI, wallet);
  const underwriterRole = await claimRegistry.UNDERWRITER_ROLE();

  console.log(`UNDERWRITER_ROLE = ${underwriterRole}`);
  console.log(`Granting to Safe: ${config.safeAddress}`);
  console.log(`Calldata for this exact call (for a Timelock proposal, if the direct send below reverts):`);
  const calldata = claimRegistry.interface.encodeFunctionData('grantRole', [underwriterRole, config.safeAddress]);
  console.log(`  target: ${config.claimRegistryAddress}`);
  console.log(`  data:   ${calldata}`);

  const alreadyGranted = await claimRegistry.hasRole(underwriterRole, config.safeAddress);
  if (alreadyGranted) {
    console.log('\nAlready granted — nothing to do.');
    return;
  }

  const tx = await claimRegistry.grantRole(underwriterRole, config.safeAddress);
  const receipt = await tx.wait();
  console.log(`\nGranted. Transaction: ${receipt.hash}`);

  const confirmed = await claimRegistry.hasRole(underwriterRole, config.safeAddress);
  console.log(`Confirmed on-chain: hasRole(UNDERWRITER_ROLE, ${config.safeAddress}) = ${confirmed}`);
}

main().catch((err) => {
  console.error(
    'Grant failed. If the error mentions AccessControlUnauthorizedAccount, ' +
      'the DEPLOYER_PRIVATE_KEY address does not hold DEFAULT_ADMIN_ROLE — ' +
      'see this file\'s header on the Timelock-proposal path instead:',
    err
  );
  process.exit(1);
});

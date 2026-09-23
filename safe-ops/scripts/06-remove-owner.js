/**
 * Offboards a departing employee — removes their address from the
 * Safe's owner list. This is THE actual answer to "when someone leaves,
 * other owners remove them": run by the REMAINING owners (meeting the
 * current threshold among themselves — the departing person's
 * signature is never needed or used here), not by the person leaving.
 *
 * Two independent things should both happen when someone leaves, and
 * this script is only the first:
 *   1. THIS script — removes their address from the Safe's owner list
 *      on-chain. After this, even if they somehow still had their KMS
 *      key, signing with it contributes nothing — the Safe contract
 *      itself no longer counts their signature toward the threshold.
 *   2. Revoke their IAM access to their own KMS key (AWS-side, outside
 *      this repository entirely) — the actual key-level lockout,
 *      independent of the Safe-level one above. Doing only #1 and not
 *      #2 leaves a departed employee's key still technically ABLE to
 *      produce valid signatures, just signatures the Safe now ignores;
 *      doing only #2 and not #1 leaves a stale owner entry on the Safe
 *      that could still count toward quorum if that key were ever
 *      compromised through some other path. Both matter; neither alone
 *      is the whole story — see docs/services/10's offboarding checklist.
 *
 * Usage: node scripts/06-remove-owner.js <departingOwnerAddress> [newThreshold]
 */
const { ethers } = require('ethers');
const Safe = require('@safe-global/protocol-kit').default;
const { loadConfig } = require('../src/config');
const { signAndExecute } = require('../src/signAndExecute');

async function main() {
  const [, , departingOwnerAddress, newThresholdArg] = process.argv;
  if (!departingOwnerAddress) {
    console.error('Usage: node scripts/06-remove-owner.js <departingOwnerAddress> [newThreshold]');
    process.exit(1);
  }

  const config = loadConfig();
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);

  const protocolKit = await Safe.init({ provider: config.rpcUrl, safeAddress: config.safeAddress });

  const currentOwners = await protocolKit.getOwners();
  if (!currentOwners.map((a) => a.toLowerCase()).includes(departingOwnerAddress.toLowerCase())) {
    throw new Error(`${departingOwnerAddress} is not currently an owner of this Safe — nothing to remove`);
  }

  // If no new threshold is given, keep the current one — UNLESS that
  // would now equal or exceed the new (smaller) owner count, which the
  // Safe contract itself would reject; this script surfaces that as a
  // clear error up front rather than an opaque revert.
  const currentThreshold = await protocolKit.getThreshold();
  const remainingOwnerCount = currentOwners.length - 1;
  const newThreshold = newThresholdArg ? parseInt(newThresholdArg, 10) : currentThreshold;
  if (newThreshold > remainingOwnerCount) {
    throw new Error(
      `Threshold ${newThreshold} would exceed the remaining ${remainingOwnerCount} owner(s) after removal — ` +
        `pass an explicit lower newThreshold argument`
    );
  }

  console.log(`Removing owner: ${departingOwnerAddress}`);
  console.log(`Owners before: ${currentOwners.length}, threshold ${currentThreshold}`);
  console.log(`Owners after:  ${remainingOwnerCount}, threshold ${newThreshold}`);

  const removeOwnerTx = await protocolKit.createRemoveOwnerTx({
    ownerAddress: departingOwnerAddress,
    threshold: newThreshold,
  });

  await signAndExecute(config, provider, removeOwnerTx);

  console.log(
    `\nDone on-chain. Now also revoke this person's IAM access to their KMS key directly in AWS, ` +
      `and remove their key ID from OWNER_KMS_KEY_IDS in every deployment's .env — see this file's ` +
      `header for why both steps matter, not just this one.`
  );
}

main().catch((err) => {
  console.error('Remove-owner failed:', err);
  process.exit(1);
});

/**
 * The actual day-to-day operation: build a ClaimRegistry call
 * (`setClaimStatus` or `payoutClaim`), have enough configured owners
 * sign it via their own KMS keys to meet the Safe's threshold, and
 * execute it. This is the direct replacement for what
 * `underwriter-service`'s `ClaimRegistryClient.java` used to do with a
 * single `UNDERWRITER_PRIVATE_KEY` — see docs/services/10 for the full
 * before/after and why that Java service's direct-write path no longer
 * works once UNDERWRITER_ROLE belongs to a Safe instead of an EOA.
 *
 * "No UI, but fully works" (the actual design brief this script
 * answers): rather than depend on Safe's hosted/self-hosted Transaction
 * Service to relay a proposal between separate people running this at
 * separate times — real infrastructure this project doesn't stand up
 * for a private Besu network — this script has access to every
 * configured owner's KMS key directly and simply signs with enough of
 * them, in sequence, within one run. This is the right shape for a
 * small number of trusted internal signers; it is NOT how you'd want
 * this to work if owners should be able to review and sign
 * independently, at their own time, without one script/operator
 * touching every key in one process — that's a real, named limitation
 * of this "simplest" approach, not an oversight (see docs/services/10's
 * design-alternatives section).
 *
 * Usage: node scripts/04-propose-and-execute-transaction.js <claimId> <approve|reject|payout>
 */
const { ethers } = require('ethers');
const Safe = require('@safe-global/protocol-kit').default;
const { loadConfig } = require('../src/config');
const { signAndExecute } = require('../src/signAndExecute');

const CLAIM_REGISTRY_ABI = [
  'function setClaimStatus(uint256 claimId, uint8 status) external',
  'function payoutClaim(uint256 claimId) external',
];

// Matches ClaimRegistry.sol's ClaimStatus enum ORDER exactly — same
// number-is-not-arbitrary caveat documented at length in
// underwriter-service's ClaimRegistryClient.java; kept in exactly one
// place here too, for the same reason.
const CLAIM_STATUS = { SUBMITTED: 0, UNDER_REVIEW: 1, APPROVED: 2, PAID: 3, REJECTED: 4 };

function buildCalldata(action, claimId) {
  const iface = new ethers.Interface(CLAIM_REGISTRY_ABI);
  if (action === 'approve') return iface.encodeFunctionData('setClaimStatus', [claimId, CLAIM_STATUS.APPROVED]);
  if (action === 'reject') return iface.encodeFunctionData('setClaimStatus', [claimId, CLAIM_STATUS.REJECTED]);
  if (action === 'payout') return iface.encodeFunctionData('payoutClaim', [claimId]);
  throw new Error(`Unknown action "${action}" — expected approve, reject, or payout`);
}

async function main() {
  const [, , claimIdArg, action] = process.argv;
  if (!claimIdArg || !action) {
    console.error('Usage: node scripts/04-propose-and-execute-transaction.js <claimId> <approve|reject|payout>');
    process.exit(1);
  }
  const claimId = parseInt(claimIdArg, 10);

  const config = loadConfig();
  if (!config.safeAddress) {
    throw new Error('UNDERWRITER_SAFE_ADDRESS is not set — run 02-create-underwriter-safe.js first');
  }

  const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);

  const calldata = buildCalldata(action, claimId);
  console.log(`Building Safe transaction: claim ${claimId}, action "${action}"`);
  console.log(`  target:   ${config.claimRegistryAddress}`);
  console.log(`  calldata: ${calldata}`);

  const bootstrapProtocolKit = await Safe.init({
    provider: config.rpcUrl,
    safeAddress: config.safeAddress,
  });

  const safeTransaction = await bootstrapProtocolKit.createTransaction({
    transactions: [{ to: config.claimRegistryAddress, value: '0', data: calldata }],
  });

  const { hash } = await signAndExecute(config, provider, safeTransaction);
  console.log(
    `\nThe indexer should pick up the resulting ClaimStatusChanged/ClaimPayout event on its next ` +
      `poll — see docs/services/09-Post-Dockerize-Verification.md step 7 for how to confirm that.`
  );
}

main().catch((err) => {
  console.error('Propose-and-execute failed:', err);
  process.exit(1);
});

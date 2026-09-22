import { ethers } from 'ethers';
import { config } from './config.js';

/**
 * Minimal human-readable ABIs — events only, this indexer never sends
 * transactions. Kept in lockstep with the actual Solidity event
 * signatures manually rather than importing compiled artifacts, same
 * trade-off (and same "must update both sides" caveat) as
 * oracle-service/src/chainClient.js's ABI fragment.
 */
const CLAIM_REGISTRY_ABI = [
  'event ClaimSubmitted(uint256 indexed claimId, uint256 indexed policyId, address indexed claimant, bytes32 merkleRoot, uint256 amount, uint256 timestamp)',
  'event ClaimStatusChanged(uint256 indexed claimId, uint8 status)',
  'event ClaimPayout(uint256 indexed claimId, address indexed to, uint256 amount, address token)',
];

const INSURANCE_POLICY_ABI = [
  'event PolicyRegistered(uint256 indexed policyId, address indexed holder, uint256 validFrom, uint256 validUntil, uint256 coverageAmount, bytes32 metadataHash)',
  'event PolicyRevoked(uint256 indexed policyId)',
];

// Mirrors the ClaimStatus enum ordering in ClaimRegistry.sol exactly —
// Solidity enums decode over the wire as their underlying uint8 index,
// so this array's ORDER is the actual source of truth for the mapping,
// not just documentation. If the enum in ClaimRegistry.sol is ever
// reordered, this must change in lockstep, or every decoded status will
// silently be wrong (not throw — just wrong).
export const CLAIM_STATUS_NAMES = ['submitted', 'under_review', 'approved', 'paid', 'rejected'];

let _provider;

export function getProvider() {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
  }
  return _provider;
}

export function getClaimRegistryContract() {
  return new ethers.Contract(config.claimRegistryAddress, CLAIM_REGISTRY_ABI, getProvider());
}

export function getInsurancePolicyContract() {
  return new ethers.Contract(config.insurancePolicyAddress, INSURANCE_POLICY_ABI, getProvider());
}

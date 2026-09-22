import { ethers } from 'ethers';
import { config } from './config.js';
import { getRelayerWallet } from './signer.js';

/**
 * Minimal ABI — only what this service needs. Kept as a human-readable
 * fragment array rather than importing the full compiled artifact, so
 * this service doesn't take on a build-time dependency on the
 * smart-contracts package. If OracleAdapter.sol's submitVerification
 * signature changes, this must be updated in lockstep — same category of
 * "structural, not nominal" coupling noted elsewhere in this project
 * (ClaimRegistry's duplicated Policy struct, this service's duplicated
 * EIP-712 type definition).
 */
const ORACLE_ADAPTER_ABI = [
  'function submitVerification((uint256 claimId, bytes32 requestId, bool approved, uint256 timestamp) response, bytes signature) external',
  'event VerificationSubmitted(uint256 indexed claimId, bytes32 indexed requestId, bool approved, address indexed signer)',
];

let _provider;

/**
 * @returns {import('ethers').JsonRpcProvider}
 */
export function getProvider() {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
  }
  return _provider;
}

/**
 * @returns {import('ethers').Contract} OracleAdapter contract instance
 *   connected with the relayer wallet, ready to send transactions.
 */
export function getOracleAdapterContract() {
  const provider = getProvider();
  const relayer = getRelayerWallet(provider);
  return new ethers.Contract(config.oracleAdapterAddress, ORACLE_ADAPTER_ABI, relayer);
}

/**
 * Submits a signed OracleResponse to OracleAdapter.submitVerification and
 * waits for one confirmation.
 *
 * @param {{claimId: number|bigint, requestId: string, approved: boolean, timestamp: number|bigint}} response
 * @param {string} signature
 * @returns {Promise<import('ethers').TransactionReceipt>}
 */
export async function submitVerificationOnChain(response, signature) {
  const contract = getOracleAdapterContract();
  const tx = await contract.submitVerification(response, signature);
  return tx.wait(1);
}

import { ethers } from 'ethers';
import { config } from './config.js';

/**
 * EIP-712 type definition. MUST match OracleAdapter.sol's typehash exactly
 * — field names, order, and types. The contract computes its typehash at
 * compile time from the literal string
 * "OracleResponse(uint256 claimId,bytes32 requestId,bool approved,uint256 timestamp)"
 * — ethers derives the same typehash from this `types` object as long as
 * the shape below matches. If OracleAdapter.sol's struct ever changes,
 * this must change in lockstep, the same lockstep requirement noted on
 * ClaimRegistry's IInsurancePolicyRegistry interface.
 *
 * @type {Record<string, Array<{name: string, type: string}>>}
 */
const ORACLE_RESPONSE_TYPES = {
  OracleResponse: [
    { name: 'claimId', type: 'uint256' },
    { name: 'requestId', type: 'bytes32' },
    { name: 'approved', type: 'bool' },
    { name: 'timestamp', type: 'uint256' },
  ],
};

/**
 * Builds the EIP-712 domain object. MUST match the values passed to
 * OracleAdapter's `__EIP712_init(name, version)` call, plus the actual
 * deployed chain ID and contract address — get any one of these four
 * fields wrong and `ecrecover` on-chain returns a different (wrong)
 * address than the one that actually signed, which surfaces as
 * UnauthorizedSigner, not as an obvious "domain mismatch" error.
 *
 * @returns {{name: string, version: string, chainId: number, verifyingContract: string}}
 */
function buildDomain() {
  return {
    name: config.eip712.name,
    version: config.eip712.version,
    chainId: config.chainId,
    verifyingContract: config.oracleAdapterAddress,
  };
}

/**
 * @typedef {Object} OracleResponsePayload
 * @property {bigint|number} claimId
 * @property {string} requestId - bytes32 hex string
 * @property {boolean} approved
 * @property {bigint|number} timestamp - unix seconds
 */

/**
 * Signs an OracleResponse payload with the given wallet.
 *
 * Wallet construction is intentionally isolated to `getSigningWallet()`
 * below rather than inlined here, so that swapping the key source (env
 * var today; HashiCorp Vault or AWS KMS in production, per the project's
 * stated architecture decision) only requires changing that one function
 * — nothing in this signing logic or the callers needs to know where the
 * key came from.
 *
 * @param {import('ethers').Wallet} wallet
 * @param {OracleResponsePayload} payload
 * @returns {Promise<string>} signature (hex string)
 */
export async function signOracleResponse(wallet, payload) {
  const domain = buildDomain();
  return wallet.signTypedData(domain, ORACLE_RESPONSE_TYPES, payload);
}

/**
 * Recovers the signer address from a signature over a given payload.
 * Used by this service's own self-consistency test, and useful for
 * debugging a signature that OracleAdapter rejected with
 * UnauthorizedSigner — run this locally to confirm which address your
 * key actually produced, rather than guessing.
 *
 * @param {OracleResponsePayload} payload
 * @param {string} signature
 * @returns {string} recovered address
 */
export function recoverSigner(payload, signature) {
  const domain = buildDomain();
  return ethers.verifyTypedData(domain, ORACLE_RESPONSE_TYPES, payload, signature);
}

/**
 * PRODUCTION NOTE (per the project's own architecture decisions):
 * this loads a raw private key from an environment variable, which is
 * explicitly the pattern the team decided NOT to use for anything beyond
 * local development — see ADR discussion on HashiCorp Vault / AWS KMS for
 * backend-held signing keys. This function is the single seam to replace:
 * swap the body to fetch a signer from Vault's transit engine or a KMS
 * client SDK, keep the same return type (an ethers Signer-compatible
 * object with a `.signTypedData` method), and nothing else in this file
 * or its callers needs to change.
 *
 * @param {import('ethers').Provider} provider
 * @returns {import('ethers').Wallet}
 */
export function getSigningWallet(provider) {
  return new ethers.Wallet(config.signerPrivateKey, provider);
}

/**
 * Separate from the signing wallet on purpose — see config.js and the
 * README for why using a distinct relayer key (which only needs gas
 * funds, no privileged role) is the recommended setup beyond local dev.
 *
 * @param {import('ethers').Provider} provider
 * @returns {import('ethers').Wallet}
 */
export function getRelayerWallet(provider) {
  return new ethers.Wallet(config.relayerPrivateKey, provider);
}

export { ORACLE_RESPONSE_TYPES, buildDomain };

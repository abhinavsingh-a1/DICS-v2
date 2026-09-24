import { ethers } from 'ethers';

const CLAIM_REGISTRY_ADDRESS = import.meta.env.VITE_CLAIM_REGISTRY_ADDRESS;
const INSURANCE_POLICY_ADDRESS = import.meta.env.VITE_INSURANCE_POLICY_ADDRESS;
const STABLECOIN_ADDRESS = import.meta.env.VITE_STABLECOIN_ADDRESS;
const CHAIN_RPC_URL = import.meta.env.VITE_CHAIN_RPC_URL;

// Minimal ABI — only what the frontend needs to call directly. Same
// "must stay in lockstep with the actual contract" caveat noted on every
// other hand-maintained ABI fragment in this project (oracle-service's
// chainClient.js, the indexer's rpcClient.js, the backend's
// web3_client.py).
const CLAIM_REGISTRY_ABI = [
  'function submitClaim(uint256 policyId, bytes32 merkleRoot, uint256 amount) external returns (uint256)',
];

const INSURANCE_POLICY_ABI = [
  'function subscribeToPolicy(uint256 templateId) external returns (uint256)',
  'function payPremium(uint256 policyId) external',
  'function policyTemplates(uint256) external view returns (uint128 coverageAmount, uint128 premiumAmountPerPeriod, uint40 periodSeconds, uint40 termSeconds, bool active, bytes32 metadataHash)',
  'function isPremiumCurrent(uint256 policyId) external view returns (bool)',
  'function premiumPaidUntil(uint256 policyId) external view returns (uint256)',
];

// Plain ERC-20 — EIP-20's standard interface, same three functions used
// identically for premium payment here as for any other token approval
// anywhere else in web3. Not StableCoin-specific in any way.
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
];

function requireAddress(address, envVarName) {
  if (!address || address === ethers.ZeroAddress) {
    throw new Error(`${envVarName} is not configured.`);
  }
}

/**
 * A read-only provider, not a signer. Reading a template's price or a
 * policy's premium status doesn't need a connected wallet at all — this
 * is deliberately separate from the wallet-derived signer used in the
 * write functions below, so the "browse plans" page (BuyPolicy.jsx)
 * works even before the person connects a wallet. Same reasoning as the
 * backend's web3_client.py having its own read-only connection —
 * two independent clients, same underlying design choice.
 */
function getReadProvider() {
  if (!CHAIN_RPC_URL) {
    throw new Error('VITE_CHAIN_RPC_URL is not configured.');
  }
  return new ethers.JsonRpcProvider(CHAIN_RPC_URL);
}

/**
 * Submits a claim directly on-chain using the connected wallet as
 * signer. The frontend never routes this transaction through the
 * backend — the backend's role is off-chain metadata (see
 * api/client.js's createClaim) and later verification triggering, not
 * transaction relaying. `merkleRoot` is the correlation key the indexer
 * uses to match this on-chain submission back to the backend's
 * off-chain record — see indexer/src/backendClient.js.
 */
export async function submitClaimOnChain(signer, policyId, merkleRoot, amountEther) {
  requireAddress(CLAIM_REGISTRY_ADDRESS, 'VITE_CLAIM_REGISTRY_ADDRESS');
  const contract = new ethers.Contract(CLAIM_REGISTRY_ADDRESS, CLAIM_REGISTRY_ABI, signer);
  const amountWei = ethers.parseEther(String(amountEther));
  const tx = await contract.submitClaim(policyId, merkleRoot, amountWei);
  const receipt = await tx.wait();
  return receipt.hash;
}

/**
 * Reads the catalog directly from the chain. Note this duplicates what
 * the backend's GET /policies/catalog also does — deliberately: the
 * backend endpoint exists for convenience (one call instead of N), but
 * nothing about reading a `view` function requires going through a
 * backend at all. BuyPolicy.jsx currently calls the backend endpoint
 * (simpler — one HTTP call instead of looping template IDs client-side)
 * but this function is here, tested, and ready if a future page needs
 * to read a single template directly without a round trip through the
 * backend.
 */
export async function getPolicyTemplate(templateId) {
  requireAddress(INSURANCE_POLICY_ADDRESS, 'VITE_INSURANCE_POLICY_ADDRESS');
  const provider = getReadProvider();
  const contract = new ethers.Contract(INSURANCE_POLICY_ADDRESS, INSURANCE_POLICY_ABI, provider);
  const t = await contract.policyTemplates(templateId);
  return {
    coverageAmountEther: ethers.formatEther(t.coverageAmount),
    premiumAmountPerPeriodEther: ethers.formatEther(t.premiumAmountPerPeriod),
    periodSeconds: Number(t.periodSeconds),
    termSeconds: Number(t.termSeconds),
    active: t.active,
  };
}

/**
 * Two on-chain steps, two separate wallet confirmations — approve, then
 * subscribe. This mirrors EIP-20's own two-step design (see Step-2 of
 * the data-flow documentation set): the wallet must authorize
 * InsurancePolicy to pull `premiumAmountPerPeriod` in dUSD BEFORE
 * calling subscribeToPolicy, or that second call's internal
 * safeTransferFrom reverts. Returns both transaction hashes so the
 * caller (BuyPolicy.jsx) can show progress through both steps rather
 * than a single opaque "please wait."
 */
export async function subscribeToPolicyOnChain(signer, templateId, premiumAmountEther) {
  requireAddress(INSURANCE_POLICY_ADDRESS, 'VITE_INSURANCE_POLICY_ADDRESS');
  requireAddress(STABLECOIN_ADDRESS, 'VITE_STABLECOIN_ADDRESS');

  const stableCoin = new ethers.Contract(STABLECOIN_ADDRESS, ERC20_ABI, signer);
  const amountWei = ethers.parseEther(String(premiumAmountEther));
  const approveTx = await stableCoin.approve(INSURANCE_POLICY_ADDRESS, amountWei);
  const approveReceipt = await approveTx.wait();

  const policy = new ethers.Contract(INSURANCE_POLICY_ADDRESS, INSURANCE_POLICY_ABI, signer);
  const subscribeTx = await policy.subscribeToPolicy(templateId);
  const subscribeReceipt = await subscribeTx.wait();

  return { approveTxHash: approveReceipt.hash, subscribeTxHash: subscribeReceipt.hash };
}

/**
 * Renewing an existing policy's premium — same two-step approve-then-pay
 * pattern as subscribing, minus the policy-creation step since the
 * policy already exists. Used by PremiumStatusBadge.jsx's "Pay Premium"
 * button.
 */
export async function payPremiumOnChain(signer, policyId, premiumAmountEther) {
  requireAddress(INSURANCE_POLICY_ADDRESS, 'VITE_INSURANCE_POLICY_ADDRESS');
  requireAddress(STABLECOIN_ADDRESS, 'VITE_STABLECOIN_ADDRESS');

  const stableCoin = new ethers.Contract(STABLECOIN_ADDRESS, ERC20_ABI, signer);
  const amountWei = ethers.parseEther(String(premiumAmountEther));
  const approveTx = await stableCoin.approve(INSURANCE_POLICY_ADDRESS, amountWei);
  await approveTx.wait();

  const policy = new ethers.Contract(INSURANCE_POLICY_ADDRESS, INSURANCE_POLICY_ABI, signer);
  const payTx = await policy.payPremium(policyId);
  const receipt = await payTx.wait();
  return receipt.hash;
}

/**
 * A cryptographically random 32-byte salt, fresh per claim — the actual
 * fix for a real bug: without this, placeholderMerkleRoot(description)
 * alone would produce the IDENTICAL hash for two different claims that
 * happen to share the same description text (two different users
 * writing "flight cancelled" both get the same merkleRoot), which is a
 * genuine collision risk, not a cosmetic one. Uses the Web Crypto API
 * (crypto.getRandomValues) — available in every modern browser, no
 * dependency needed — never anything derived from the claimant's real
 * identity. See this file's own note above generateClaimSalt's caller
 * for why identity documents (SSN, passport number) were deliberately
 * rejected as an input here: they're low-entropy, brute-forceable once
 * hashed, and this system already has a real identity binding — the
 * claimant's own wallet signature — that a hash of anything else can't
 * strengthen.
 */
export function generateClaimSalt() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * PLACEHOLDER evidence hashing. This project's document-upload/IPFS
 * pipeline is not built yet (see backend/README.md "still open") — this
 * generates a merkleRoot from the claim description text alone, purely
 * so the end-to-end submit flow (backend record + on-chain tx +
 * indexer + webhook) can be exercised. Replace with a real Merkle tree
 * over actual uploaded document hashes when that pipeline exists (see
 * document-service, which already computes a REAL one — just not yet
 * wired into this call site); labeled clearly here rather than
 * presented as the real thing, the same way MockOracle/verificationLogic.js
 * are labeled elsewhere in this project.
 *
 * `salt` is REQUIRED, not optional — see generateClaimSalt() above for
 * why. The caller is responsible for generating one fresh salt per
 * claim (not reusing one across claims) and persisting it via the
 * backend's merkle_salt field, since losing the salt means the root can
 * never be regenerated or independently verified again.
 */
export function placeholderMerkleRoot(claimDescription, salt) {
  if (!salt) {
    throw new Error('placeholderMerkleRoot requires a salt — call generateClaimSalt() first.');
  }
  const descriptionBytes = ethers.toUtf8Bytes(claimDescription || 'no-description-provided');
  const saltBytes = ethers.getBytes(salt);
  return ethers.keccak256(ethers.concat([saltBytes, descriptionBytes]));
}


/**
 * MOCK verification logic — mirrors the role of MockOracle.sol earlier in
 * this project: a clearly-labeled placeholder standing in for a real
 * external verification source (an insurer's claims system, a weather
 * API for parametric claims, a flight-status API, a human reviewer
 * queue, etc.). Do not treat the decision rule below as a real business
 * rule; it exists so the end-to-end flow (submit → verify → sign →
 * relay → on-chain approval) can be exercised and demonstrated.
 *
 * @typedef {Object} ClaimEvidence
 * @property {number} claimId
 * @property {number} declaredAmount
 * @property {string} [evidenceSummary]
 */

/**
 * @param {ClaimEvidence} evidence
 * @returns {Promise<{approved: boolean, reason: string}>}
 */
export async function evaluateClaim(evidence) {
  if (typeof evidence.declaredAmount !== 'number' || evidence.declaredAmount <= 0) {
    return { approved: false, reason: 'MOCK: missing or non-positive declaredAmount' };
  }

  // Placeholder threshold purely to make the mock produce both outcomes
  // in a demo rather than always returning true — not a real
  // underwriting rule. Replace this whole function body with a call to
  // an actual verification source.
  const MOCK_APPROVAL_THRESHOLD = 100_000;
  if (evidence.declaredAmount > MOCK_APPROVAL_THRESHOLD) {
    return {
      approved: false,
      reason: `MOCK: declaredAmount ${evidence.declaredAmount} exceeds placeholder threshold ${MOCK_APPROVAL_THRESHOLD}`,
    };
  }

  return { approved: true, reason: 'MOCK: within placeholder threshold, no red flags' };
}

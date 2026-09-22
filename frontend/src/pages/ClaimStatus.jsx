import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { getClaim, triggerVerification } from '../api/client.js';
import ClaimStatusBadge from '../components/ClaimStatusBadge.jsx';

export default function ClaimStatus() {
  const { token } = useAuth();
  const [claimId, setClaimId] = useState('');
  const [claim, setClaim] = useState(null);
  const [error, setError] = useState(null);
  const [verifying, setVerifying] = useState(false);
  // Generated once per claim lookup, not per click — a user re-clicking
  // "Trigger Verification" while a request is in flight (or retrying
  // after a network blip showing a spinner) should reuse the SAME
  // idempotency key so the backend's protection actually applies; a
  // fresh key per click would defeat the point entirely.
  const [idempotencyKey, setIdempotencyKey] = useState(null);

  async function handleSearch() {
    setError(null);
    setClaim(null);
    try {
      const res = await getClaim(token, claimId);
      setClaim(res.data);
      setIdempotencyKey(crypto.randomUUID());
    } catch (err) {
      setError(err?.response?.data?.detail || 'Claim not found.');
    }
  }

  async function handleTriggerVerification() {
    setVerifying(true);
    setError(null);
    try {
      await triggerVerification(token, claim.id, idempotencyKey);
      const refreshed = await getClaim(token, claim.id);
      setClaim(refreshed.data);
    } catch (err) {
      setError(err?.response?.data?.detail || 'Verification request failed.');
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div>
      <h2>Check Claim Status</h2>
      <div>
        <input
          placeholder="Claim ID"
          value={claimId}
          onChange={(e) => setClaimId(e.target.value)}
        />
        <button onClick={handleSearch}>Search</button>
      </div>

      {error && <p className="error">{error}</p>}

      {claim && (
        <div className="card">
          <p>
            <b>Claim #{claim.id}</b> <ClaimStatusBadge status={claim.status} />
          </p>
          <p>Policy: {claim.policy_id}</p>
          <p>Declared amount: {claim.declared_amount}</p>
          {claim.onchain_claim_id != null && <p>On-chain claim ID: {claim.onchain_claim_id}</p>}
          {claim.tx_hash && (
            <p>
              Latest transaction: <code>{claim.tx_hash}</code>
            </p>
          )}

          {claim.status === 'submitted' && (
            <button onClick={handleTriggerVerification} disabled={verifying}>
              {verifying ? 'Requesting verification…' : 'Trigger Verification'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

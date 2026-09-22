import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { listClaims } from '../api/client.js';
import ClaimStatusBadge from '../components/ClaimStatusBadge.jsx';
import PremiumStatusBadge from '../components/PremiumStatusBadge.jsx';

export default function Dashboard() {
  const { token } = useAuth();
  const [claims, setClaims] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    listClaims(token)
      .then((res) => {
        if (!cancelled) setClaims(res.data);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.response?.data?.detail || 'Could not load claims.');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (error) return <p className="error">{error}</p>;
  if (claims === null) return <p>Loading…</p>;

  return (
    <div>
      <h2>Your Claims</h2>
      {claims.length === 0 && (
        <p>
          No claims yet. <Link to="/file-claim">File your first claim</Link>.
        </p>
      )}
      {claims.map((c) => (
        <div key={c.id} className="card">
          <div>
            <b>Claim #{c.id}</b> — Policy {c.policy_id} — {c.declared_amount}{' '}
            <ClaimStatusBadge status={c.status} />
          </div>
          {c.onchain_claim_id != null && (
            <div>
              On-chain claim ID: {c.onchain_claim_id} — tx:{' '}
              <code>
                {c.tx_hash?.slice(0, 10)}…{c.tx_hash?.slice(-6)}
              </code>
            </div>
          )}
          {c.onchain_claim_id == null && (
            <div style={{ color: '#888' }}>
              Not yet confirmed on-chain — the indexer updates this once the submission
              transaction is mined and processed.
            </div>
          )}
          {/*
            Shown per-claim (using that claim's own policy_id) rather
            than as one list of "all your policies" — there's no
            GET /policies/mine endpoint, because InsurancePolicy.sol has
            no way to enumerate policies by holder (that would need an
            indexer syncing PolicySubscribed events by address, which
            isn't built — a real gap, not hidden here). Showing it next
            to each claim still surfaces the one thing that actually
            matters at this exact moment: whether THIS claim's underlying
            policy can currently be claimed against at all.
          */}
          <div style={{ marginTop: '0.5em' }}>
            <PremiumStatusBadge policyId={c.policy_id} />
          </div>
        </div>
      ))}
    </div>
  );
}

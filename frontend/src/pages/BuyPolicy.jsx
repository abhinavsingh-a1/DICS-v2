import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ethers } from 'ethers';
import { getPolicyCatalog } from '../api/client.js';
import { subscribeToPolicyOnChain } from '../api/contract.js';

/**
 * Converts a wei-string amount (what the backend returns, per
 * schemas.py's PolicyTemplateOut docstring on why it avoids doing this
 * division itself) into a plain dollar-ish display string. Uses
 * ethers.formatEther rather than hand-rolled division specifically to
 * avoid floating-point rounding error on 18-decimal amounts — the exact
 * problem the backend's docstring flags and pushes onto whichever layer
 * actually needs a human-readable number, which is here, not the API.
 */
function formatWei(weiString) {
  return ethers.formatEther(weiString);
}

export default function BuyPolicy() {
  const navigate = useNavigate();

  const [templates, setTemplates] = useState(null);
  const [error, setError] = useState(null);
  const [subscribing, setSubscribing] = useState(null); // templateId currently in flight, or null
  const [result, setResult] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getPolicyCatalog()
      .then((res) => {
        if (!cancelled) setTemplates(res.data);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.response?.data?.detail || 'Could not load the policy catalog.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubscribe(template) {
    setError(null);
    setResult(null);
    setSubscribing(template.template_id);
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const premiumEther = formatWei(template.premium_amount_per_period_wei);

      const { approveTxHash, subscribeTxHash } = await subscribeToPolicyOnChain(
        signer,
        template.template_id,
        premiumEther
      );
      setResult({ templateId: template.template_id, approveTxHash, subscribeTxHash });
    } catch (err) {
      setError(err?.message || 'Subscription failed.');
    } finally {
      setSubscribing(null);
    }
  }

  if (error && !templates) return <p className="error">{error}</p>;
  if (templates === null) return <p>Loading plans…</p>;

  return (
    <div>
      <h2>Buy a Policy</h2>
      <p style={{ color: '#888' }}>
        Subscribing pulls one period's premium from your wallet immediately — the policy and the
        first payment happen in a single transaction, so you never end up with an unpaid policy.
      </p>

      {templates.length === 0 && <p>No plans are currently available.</p>}

      {templates.map((t) => {
        const coverage = formatWei(t.coverage_amount_wei);
        const premium = formatWei(t.premium_amount_per_period_wei);
        const periodDays = Math.round(t.period_seconds / 86400);
        return (
          <div key={t.template_id} className="card">
            <div>
              <b>Plan #{t.template_id}</b> — {coverage} dUSD coverage
            </div>
            <div>
              {premium} dUSD / {periodDays}-day period
            </div>
            <button disabled={subscribing !== null} onClick={() => handleSubscribe(t)}>
              {subscribing === t.template_id ? 'Confirm in wallet…' : 'Subscribe'}
            </button>
          </div>
        );
      })}

      {error && <p className="error">{error}</p>}

      {result && (
        <div className="card">
          <p>Subscribed to plan #{result.templateId}.</p>
          <p>
            Approval tx: <code>{result.approveTxHash}</code>
          </p>
          <p>
            Subscription tx: <code>{result.subscribeTxHash}</code>
          </p>
          <button onClick={() => navigate('/')}>Back to Dashboard</button>
        </div>
      )}
    </div>
  );
}

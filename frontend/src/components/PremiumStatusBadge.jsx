import React, { useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { getPolicyStatus } from '../api/client.js';
import { payPremiumOnChain } from '../api/contract.js';

/**
 * Self-contained: fetches its own data (given just a policyId) and
 * manages its own paying-in-progress state, rather than expecting a
 * parent page to fetch policy status and pass it down as a prop. This
 * mirrors ClaimStatusBadge.jsx's own scope (a status label, nothing
 * more) but goes one step further by also owning the "do something
 * about it" action (the Pay Premium button) — a deliberate difference,
 * because unlike claim status (which only ever changes via the oracle
 * or an underwriter, never the viewing user), premium status is
 * something the policyholder viewing this exact badge can personally
 * fix immediately, so putting the fix right next to the problem avoids
 * sending them to a different page to do it.
 */
export default function PremiumStatusBadge({ policyId, onPaid }) {
  const [status, setStatus] = useState(null); // null while loading
  // Two SEPARATE error states, deliberately not one shared `error` — a
  // failed initial load (no status data at all) and a failed payment
  // attempt (status data still valid, just the last payment didn't go
  // through) need different UI: the first has nothing else to show, the
  // second must NOT hide the button, or a rejected wallet popup would
  // permanently strand the user with no way to retry except a page
  // refresh. This was a real bug in an earlier version of this file,
  // caught by re-reading it rather than assuming it worked.
  const [loadError, setLoadError] = useState(null);
  const [payError, setPayError] = useState(null);
  const [paying, setPaying] = useState(false);
  const [txHash, setTxHash] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getPolicyStatus(policyId)
      .then((res) => {
        if (!cancelled) setStatus(res.data);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err?.response?.data?.detail || 'Could not load premium status.');
      });
    return () => {
      cancelled = true;
    };
    // Deliberately re-runs whenever txHash changes (see handlePay below) —
    // this is how the badge refreshes itself to show "current" immediately
    // after a successful payment, without the parent page needing to know
    // anything happened.
  }, [policyId, txHash]);

  async function handlePay() {
    setPayError(null);
    setPaying(true);
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const premiumEther = ethers.formatEther(status.premium_amount_per_period_wei);
      const hash = await payPremiumOnChain(signer, policyId, premiumEther);
      setTxHash(hash); // triggers the useEffect above to re-fetch status
      if (onPaid) onPaid(hash);
    } catch (err) {
      setPayError(err?.message || 'Payment failed.');
    } finally {
      setPaying(false);
    }
  }

  if (loadError) return <span className="error">{loadError}</span>;
  if (status === null) return <span style={{ color: '#888' }}>Checking premium…</span>;

  if (status.premium_current) {
    const paidUntilDate = new Date(status.premium_paid_until * 1000).toLocaleDateString();
    return <span style={{ color: '#2a7' }}>Premium current — paid through {paidUntilDate}</span>;
  }

  const premiumEther = ethers.formatEther(status.premium_amount_per_period_wei);
  return (
    <span>
      <span className="error">Premium lapsed — claims are blocked until you renew.</span>{' '}
      <button disabled={paying} onClick={handlePay}>
        {paying ? 'Confirm in wallet…' : `Pay Premium (${premiumEther} dUSD)`}
      </button>
      {payError && (
        <span className="error" style={{ marginLeft: '0.5em' }}>
          {payError}
        </span>
      )}
    </span>
  );
}

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { createClaim } from '../api/client.js';
import { submitClaimOnChain, placeholderMerkleRoot } from '../api/contract.js';

/**
 * Full flow: create the off-chain claim record (backend), then submit
 * the same merkleRoot on-chain (wallet-signed transaction), matching
 * exactly the correlation mechanism the indexer relies on — see
 * indexer/src/backendClient.js and api/contract.js's comment on why
 * merkleRoot is the correlation key rather than a separate mapping.
 */
export default function FileClaim() {
  const { token } = useAuth();
  const navigate = useNavigate();

  const [policyId, setPolicyId] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [step, setStep] = useState('idle'); // idle | creating | submitting-onchain | done
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setResult(null);

    if (!policyId || !amount) {
      setError('Policy ID and amount are required.');
      return;
    }

    const merkleRoot = placeholderMerkleRoot(description);

    try {
      setStep('creating');
      const createRes = await createClaim(token, {
        policy_id: Number(policyId),
        declared_amount: Number(amount),
        merkle_root: merkleRoot,
        documents: [],
      });
      const backendClaim = createRes.data;

      setStep('submitting-onchain');
      const { ethers } = await import('ethers');
      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const txHash = await submitClaimOnChain(signer, Number(policyId), merkleRoot, amount);

      setStep('done');
      setResult({ claimId: backendClaim.id, txHash });
    } catch (err) {
      setStep('idle');
      setError(err?.response?.data?.detail || err?.message || 'Claim submission failed.');
    }
  }

  return (
    <div>
      <h2>File a New Claim</h2>
      <p style={{ color: '#888' }}>
        Evidence upload isn't wired up yet in this build (see backend README, "still open") — this
        form generates a placeholder evidence hash from the description text alone, clearly not a
        real Merkle proof over actual documents.
      </p>
      <form onSubmit={handleSubmit} className="card">
        <div>
          <label>Policy ID: </label>
          <input value={policyId} onChange={(e) => setPolicyId(e.target.value)} />
        </div>
        <div>
          <label>Claimed Amount: </label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div>
          <label>Description: </label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <button type="submit" disabled={step !== 'idle' && step !== 'done'}>
          {step === 'creating' && 'Saving claim…'}
          {step === 'submitting-onchain' && 'Confirm in wallet…'}
          {(step === 'idle' || step === 'done') && 'Submit Claim'}
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      {result && (
        <div className="card">
          <p>Claim #{result.claimId} created and submitted on-chain.</p>
          <p>
            Transaction: <code>{result.txHash}</code>
          </p>
          <button onClick={() => navigate('/')}>Back to Dashboard</button>
        </div>
      )}
    </div>
  );
}

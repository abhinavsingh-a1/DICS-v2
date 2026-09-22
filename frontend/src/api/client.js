import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export const api = axios.create({ baseURL: API_URL });

export function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

export const getNonce = (address) => api.get('/auth/nonce', { params: { address } });

export const loginWallet = (address, signature) => api.post('/auth/wallet', { address, signature });

export const listClaims = (token) => api.get('/claims', { headers: authHeaders(token) });

export const getClaim = (token, claimId) =>
  api.get(`/claims/${claimId}`, { headers: authHeaders(token) });

export const createClaim = (token, body) => api.post('/claims', body, { headers: authHeaders(token) });

export const triggerVerification = (token, claimId, idempotencyKey) =>
  api.post(
    `/claims/${claimId}/trigger-verification`,
    {},
    { headers: { ...authHeaders(token), 'Idempotency-Key': idempotencyKey } }
  );

// These two are unauthenticated on purpose — see policies_routes.py's
// docstring: browsing plans and checking a policy's status are
// read-only chain data, viewable without a connected wallet at all.
export const getPolicyCatalog = () => api.get('/policies/catalog');

export const getPolicyStatus = (policyId) => api.get(`/policies/${policyId}/status`);

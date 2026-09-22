import express from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { evaluateClaim } from './verificationLogic.js';
import { signOracleResponse, getSigningWallet } from './signer.js';
import { getProvider, submitVerificationOnChain } from './chainClient.js';
import { requireApiKey } from './auth.js';

const app = express();
app.use(express.json());

/**
 * Request body schema for POST /verify. Runtime-validated per the
 * project's JS policy — this endpoint is called by the backend, but
 * "internal" callers still get their input validated; a malformed
 * claimId here should fail with a clear 400, not surface as a confusing
 * contract revert three steps downstream.
 */
const verifyRequestSchema = z.object({
  claimId: z.number().int().positive(),
  declaredAmount: z.number().positive(),
  evidenceSummary: z.string().optional(),
});

/**
 * Locally-tracked request IDs this process has issued, purely as an
 * extra sanity check during development — NOT a substitute for the
 * contract-level replay protection in OracleAdapter/ClaimRegistry, which
 * is the actual security boundary and holds even if this process
 * restarts and loses this in-memory set.
 * @type {Set<string>}
 */
const issuedRequestIds = new Set();

function generateRequestId() {
  let id;
  do {
    id = '0x' + randomBytes(32).toString('hex');
  } while (issuedRequestIds.has(id));
  issuedRequestIds.add(id);
  return id;
}

app.get('/health', (req, res) => {
  // Deliberately NOT behind requireApiKey — health checks (load balancer,
  // Kubernetes liveness probe, Prometheus blackbox exporter) need to hit
  // this without a secret, and it reveals nothing sensitive.
  res.json({ status: 'ok', oracleAdapter: config.oracleAdapterAddress, chainId: config.chainId });
});

app.post('/verify', requireApiKey, async (req, res) => {
  const parsed = verifyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_request', details: parsed.error.format() });
  }
  const { claimId, declaredAmount, evidenceSummary } = parsed.data;

  try {
    const decision = await evaluateClaim({ claimId, declaredAmount, evidenceSummary });

    const requestId = generateRequestId();
    // Submit promptly after computing this — the contract enforces
    // block.timestamp <= this + responseValidityWindow, so a slow path
    // between signing and relaying eats into that window.
    const timestamp = Math.floor(Date.now() / 1000);

    const payload = { claimId, requestId, approved: decision.approved, timestamp };

    const provider = getProvider();
    const signerWallet = getSigningWallet(provider);
    const signature = await signOracleResponse(signerWallet, payload);

    const receipt = await submitVerificationOnChain(payload, signature);

    return res.json({
      claimId,
      requestId,
      approved: decision.approved,
      reason: decision.reason,
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
    });
  } catch (err) {
    // Centralized error handling per the project's JS policy — one
    // place that decides what's safe to expose to the caller vs. what
    // only goes to the logs.
    // eslint-disable-next-line no-console
    console.error('[oracle-service] /verify failed:', err);
    return res.status(502).json({
      error: 'verification_or_relay_failed',
      message: err instanceof Error ? err.message : 'unknown error',
    });
  }
});

// Guarded so importing `app` (e.g. from an integration test via
// `await import('../src/server.js')`) doesn't also bind a port — only
// bind when this file is actually the process entry point (`npm start`
// / `node src/server.js`). This is the standard pattern for making an
// Express app importable-and-testable without a real listening socket.
const isEntryPoint = process.argv[1] && process.argv[1].endsWith('server.js');
if (isEntryPoint) {
  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[oracle-service] listening on :${config.port}`);
    // eslint-disable-next-line no-console
    console.log(`[oracle-service] OracleAdapter: ${config.oracleAdapterAddress} (chainId ${config.chainId})`);
  });
}

export { app };

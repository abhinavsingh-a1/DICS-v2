import { config } from './config.js';

/**
 * Reports an on-chain claim event to the backend so its off-chain
 * `claims` row can be correlated and updated. Correlation key is
 * `merkleRoot` — the same value the frontend sends both to the backend's
 * POST /claims call and to the on-chain submitClaim() transaction, so it
 * uniquely ties an off-chain record to its on-chain counterpart without
 * needing a separate mapping table. This is the piece that was missing
 * before: the backend's `onchain_claim_id`/`tx_hash` columns existed in
 * the schema but nothing ever populated them.
 *
 * BACKEND_URL/BACKEND_WEBHOOK_API_KEY are optional in config — if unset,
 * this becomes a no-op with a one-time warning, so the indexer can still
 * run standalone (e.g. for local chain-state inspection) without a
 * backend running.
 */
let warnedNoBackend = false;

export async function reportClaimEvent(event) {
  if (!config.backendUrl) {
    if (!warnedNoBackend) {
      // eslint-disable-next-line no-console
      console.warn('[backendClient] BACKEND_URL not set — skipping backend notification.');
      warnedNoBackend = true;
    }
    return;
  }

  const response = await fetch(`${config.backendUrl}/internal/onchain-events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Indexer-Webhook-Key': config.backendWebhookApiKey,
    },
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    // Logged, not thrown — a backend notification failure shouldn't
    // crash the indexer's own event loop or block checkpoint advance;
    // the backend's off-chain record staying stale is recoverable (a
    // later reconciliation pass, or manual replay), whereas losing
    // indexer progress on a chain event is not.
    const body = await response.text().catch(() => '');
    // eslint-disable-next-line no-console
    console.error(`[backendClient] webhook failed (${response.status}): ${body}`);
  }
}

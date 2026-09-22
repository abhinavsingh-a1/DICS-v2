import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

/**
 * Shared-secret API key auth for service-to-service calls (backend →
 * oracle-service). This is deliberately the simplest thing that closes
 * the real gap flagged earlier — "anything that can reach /verify can
 * trigger a signed on-chain approval" — not a claim that this is
 * sufficient on its own. Defense in depth still means: this service
 * should also sit behind network isolation (private subnet, no public
 * ingress) in any shared environment. This middleware stops an
 * unauthenticated caller that *does* have network reach; it does not
 * replace not having network reach in the first place.
 *
 * PRODUCTION NOTE: the shared secret loads from an env var here, same
 * caveat as the oracle signer's private key in signer.js — beyond local
 * development this should come from a secrets manager (Vault/AWS
 * Secrets Manager) with rotation, not a static `.env` value with no
 * expiry.
 *
 * Uses a constant-time comparison (`timingSafeEqual`) rather than `===`
 * specifically so an attacker probing the endpoint can't use response
 * timing to incrementally guess the key character-by-character — a
 * naive string comparison short-circuits on the first mismatched byte,
 * which is a measurable timing signal.
 */
export function requireApiKey(req, res, next) {
  const provided = req.header('X-Oracle-Service-Key');

  if (!provided) {
    return res.status(401).json({ error: 'missing_api_key' });
  }

  const expected = config.apiKey;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);

  // timingSafeEqual throws if lengths differ rather than returning
  // false, so check length first — this length check itself leaks
  // whether the length matched, which is an acceptable, standard
  // trade-off (the key length isn't the secret; its value is).
  const lengthMatches = providedBuf.length === expectedBuf.length;
  const valuesMatch = lengthMatches && timingSafeEqual(providedBuf, expectedBuf);

  if (!valuesMatch) {
    return res.status(401).json({ error: 'invalid_api_key' });
  }

  return next();
}

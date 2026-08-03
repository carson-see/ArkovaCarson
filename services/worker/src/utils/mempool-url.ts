/**
 * MEMPOOL_API_URL /api contract (SCRUM-3016 / BUG-2026-07-26-003).
 *
 * `config.mempoolApiUrl` (the raw `MEMPOOL_API_URL` env var) is read by five
 * call sites across two conventions that silently disagree:
 *
 *   - `chain/utxo-provider.ts` (`MempoolUtxoProvider`, `GetBlockHybridProvider`'s
 *     mempool fallback) and `chain/fee-estimator.ts` (`MempoolFeeEstimator`)
 *     build request URLs as `${baseUrl}/address/...`, `${baseUrl}/tx`,
 *     `${baseUrl}/v1/fees/...` — they never append `/api` themselves, so
 *     `baseUrl` must ALREADY include it. Their own defaults are
 *     `'https://mempool.space/api'`.
 *   - `jobs/treasury-cache.ts` matches this convention too (default
 *     `'https://mempool.space/api'`, used verbatim as `${apiBase}/address/...`).
 *   - `jobs/chain-maintenance.ts` and `jobs/check-confirmations.ts` build
 *     `${baseUrl}/api/tx/...`, `${baseUrl}/api/blocks/tip/height` — they
 *     append `/api` themselves, so `baseUrl` must NOT include it. Their own
 *     defaults are bare hosts (`'https://mempool.space'`, `'https://mempool.space/signet'`, ...).
 *
 * No single value of `MEMPOOL_API_URL` satisfies both conventions: set it
 * WITH `/api` and chain-maintenance.ts/check-confirmations.ts build
 * `.../api/api/...` (404); set it WITHOUT and utxo-provider.ts/fee-estimator.ts/
 * treasury-cache.ts build `.../address/...` with no `/api` at all (also
 * wrong — that path serves the mempool.space frontend, not its REST API).
 * This is exactly what froze 2 isolated soak rigs for ~24h before being
 * root-caused (BUG-2026-07-26-003) — prod has never hit it only because
 * `MEMPOOL_API_URL` happens to be unset there, leaving every consumer on its
 * own (mutually consistent) hardcoded default.
 *
 * Fix: every consumer resolves through ONE of the two helpers below instead
 * of reading `config.mempoolApiUrl` directly, so an operator-set value in
 * EITHER shape (with or without `/api`, with or without a trailing slash)
 * produces the correct URL for that consumer either way.
 */

/**
 * Normalize an operator-supplied mempool.space-compatible base URL to a bare
 * host: no trailing `/api` segment, no trailing slash. Returns `undefined`
 * for an unset/empty value so callers can apply their own default.
 */
export function normalizeMempoolHostUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.replace(/\/api\/?$/, '').replace(/\/$/, '');
}

/**
 * Resolve a base URL for consumers that build requests as `${base}/address/...`,
 * `${base}/tx`, `${base}/v1/fees/...` — i.e. `base` must already carry the
 * `/api` segment. Used by `chain/utxo-provider.ts`, `chain/fee-estimator.ts`,
 * `jobs/treasury-cache.ts`.
 */
export function resolveMempoolApiBase(raw: string | undefined, fallbackWithApi: string): string {
  const host = normalizeMempoolHostUrl(raw);
  return host == null ? fallbackWithApi : `${host}/api`;
}

/**
 * Resolve a base URL for consumers that build requests as
 * `${base}/api/tx/...`, `${base}/api/blocks/tip/height` — i.e. `base` must
 * NOT carry the `/api` segment (the consumer appends it). Used by
 * `jobs/chain-maintenance.ts`, `jobs/check-confirmations.ts`.
 */
export function resolveMempoolHostBase(raw: string | undefined, fallback: string): string {
  const host = normalizeMempoolHostUrl(raw);
  return host == null ? fallback : host;
}

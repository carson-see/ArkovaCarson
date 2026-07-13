/** Production Cloud Run worker origin the gateway proxies to. */
export const WORKER_ORIGIN =
  'https://arkova-worker-270018525501.us-central1.run.app';

export type Route =
  | { kind: 'proxy'; path: string }
  | { kind: 'index' }
  | { kind: 'keys' }
  | { kind: 'docs_index' }
  | { kind: 'not_found' };

const NOT_FOUND: Route = { kind: 'not_found' };

/**
 * Deliberately an allowlist, not a catch-all: only the versioned API
 * surface (/v1, /v2 and their canonical /api/v1, /api/v2 forms), /health,
 * and the OpenAPI spec are reachable through api.arkova.ai. Everything else
 * the worker mounts — /jobs/*, /webhook-retries, and the non-versioned
 * /api/admin, /api/treasury, /api/billing, /api/audit, /api/anchor-revoke
 * surfaces — is NOT public contract and must never resolve on this hostname
 * (P1 review, PR #1505).
 */
export function resolveRoute(hostname: string, pathname: string): Route {
  // Normalize away any dot-segments so /v1/../../jobs can't escape the
  // /api prefix. URL parsing collapses them; reject any that remain.
  const normalized = new URL(pathname, 'https://x').pathname;
  if (normalized.includes('..')) return NOT_FOUND;

  if (hostname === 'api.arkova.ai') {
    if (normalized === '/') return { kind: 'index' };
    if (normalized === '/health') return { kind: 'proxy', path: '/health' };
    if (normalized === '/openapi.json')
      return { kind: 'proxy', path: '/api/docs/spec.json' };
    if (normalized === '/v1' || normalized.startsWith('/v1/'))
      return { kind: 'proxy', path: `/api${normalized}` };
    if (normalized === '/v2' || normalized.startsWith('/v2/'))
      return { kind: 'proxy', path: `/api${normalized}` };
    if (normalized === '/api/v1' || normalized.startsWith('/api/v1/'))
      return { kind: 'proxy', path: normalized };
    if (normalized === '/api/v2' || normalized.startsWith('/api/v2/'))
      return { kind: 'proxy', path: normalized };
    if (normalized === '/api/docs/spec.json')
      return { kind: 'proxy', path: normalized };
    return NOT_FOUND;
  }

  if (hostname === 'docs.arkova.ai') {
    if (normalized === '/') return { kind: 'docs_index' };
    if (normalized === '/keys.json') return { kind: 'keys' };
    return NOT_FOUND;
  }

  return NOT_FOUND;
}

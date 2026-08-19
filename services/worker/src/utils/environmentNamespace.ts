/**
 * Environment namespace derivation (BUG-018 / D-8).
 *
 * One honest answer to "which deployment surface am I?", for any shared
 * external datastore whose keyspace would otherwise be global across
 * environments.
 *
 * WHY THIS IS NOT `NODE_ENV`:
 * rigs and shared staging run `NODE_ENV=production` — verified across
 * `arkova-worker-staging`, the connector side-rig and the fullsoak rig — so
 * NODE_ENV cannot discriminate between prod and a rig. `K_SERVICE` (the Cloud
 * Run service name) is the deployment-surface identity and is the honest
 * signal: only the one real production service earns the production namespace;
 * every other service is namespaced by its own name.
 *
 * This is deliberately the SAME derivation `resolveSentryEnvironment`
 * (utils/sentry.ts, MT-1 / SCRUM-2901) already uses for the Sentry environment
 * tag, and `PROD_SERVICE_NAME` is defined here and imported there so the two
 * cannot drift apart. It is kept in its own module — with no `@sentry/node`
 * import — so the rate-limiter hot path does not pull in the Sentry SDK.
 *
 * WHAT IT MUST GUARANTEE:
 *   1. two different deployment surfaces never derive the same namespace, and
 *   2. only the real production service can derive `PROD_NAMESPACE`, and
 *   3. the value is stable for the life of a service — every instance of one
 *      service derives the same namespace, or a shared counter stops being
 *      shared (see upstashRateLimit.namespace.test.ts).
 *
 * Derive NOTHING instance-local here (K_REVISION, hostname, pid, a random id):
 * that would silently un-share every shared counter, which is the defect
 * PR #2223 exists to fix.
 */

/** The one Cloud Run service whose keys may live in the production namespace. */
export const PROD_SERVICE_NAME = 'arkova-worker';

/** Reserved namespace for the real production service. */
export const PROD_NAMESPACE = 'prod';

/** Used when nothing identifies the surface — never an empty key segment. */
export const UNKNOWN_NAMESPACE = 'unknown';

/**
 * Cloud Run caps service names at 63 chars, so this never truncates a real
 * K_SERVICE; it exists to stop an arbitrarily long env var from bloating every
 * key in the datastore.
 */
const MAX_NAMESPACE_LENGTH = 64;

/**
 * Tokens a non-prod surface must never be able to land on.
 *
 * `PROD_NAMESPACE` is the one that matters: a service literally named `prod`
 * would otherwise share production's counters. `blob` is reserved because
 * `upstashRateLimit.ts` builds its legacy keyspace as `arkova:rl:blob:<ns>:`,
 * so a service named `blob` could forge a counter key that collides with it.
 */
const RESERVED_NAMESPACES = new Set<string>([PROD_NAMESPACE, 'blob']);

export interface EnvironmentNamespaceInputs {
  /** Cloud Run service name (K_SERVICE); unset off Cloud Run. */
  kService?: string;
  /** NODE_ENV — trusted only off Cloud Run, and never for 'production'. */
  nodeEnv?: string;
}

/**
 * Reduce a raw identifier to a Redis-safe key segment.
 *
 * A colon would forge an extra keyspace segment and whitespace breaks the
 * path-style REST transport, so both are folded to '-'. Real Cloud Run service
 * names (`[a-z]([-a-z0-9]*[a-z0-9])?`) pass through unchanged.
 */
function sanitize(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_NAMESPACE_LENGTH);

  return cleaned || UNKNOWN_NAMESPACE;
}

/** Keep a non-prod surface off a reserved token without losing its identity. */
function guardReserved(namespace: string): string {
  return RESERVED_NAMESPACES.has(namespace)
    ? `${namespace}-nonprod`.slice(0, MAX_NAMESPACE_LENGTH)
    : namespace;
}

/**
 * Resolve the namespace for the current deployment surface.
 *
 * Defaults to reading `process.env` so callers construct stores without
 * plumbing env through; pass explicit inputs in tests.
 */
export function resolveEnvironmentNamespace(
  inputs: EnvironmentNamespaceInputs = {
    kService: process.env.K_SERVICE,
    nodeEnv: process.env.NODE_ENV,
  },
): string {
  const kService = inputs.kService?.trim();

  if (kService) {
    // Exact match only. A prefix/substring test would hand
    // `arkova-worker-staging` production's bucket — the precise failure D-8
    // describes.
    if (kService === PROD_SERVICE_NAME) return PROD_NAMESPACE;
    return guardReserved(sanitize(kService));
  }

  const nodeEnv = inputs.nodeEnv?.trim();
  if (!nodeEnv) return UNKNOWN_NAMESPACE;

  // §1.5 honesty: a bare NODE_ENV=production without the production service
  // identity (local shell, `docker run`, a CI job) must not write into
  // production's keyspace.
  if (nodeEnv === 'production') return 'local-production';

  return guardReserved(sanitize(nodeEnv));
}

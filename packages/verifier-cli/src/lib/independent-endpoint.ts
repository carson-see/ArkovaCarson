/**
 * Independent-node endpoint guard.
 *
 * Design rule (PROOF-07 / verifier-oss-sdk-predesign §2): the verifier MUST
 * confirm the on-chain fact against a node that is NOT Arkova. This module
 * hard-refuses any arkova.* host so a misconfigured `--rpc` can never silently
 * route the confirmation back through us.
 *
 * The on-chain confirmation itself is delegated to `arkova-verifier`'s
 * `confirmInclusion` + `createEsploraFetch` (the SHARED, correct Esplora decode +
 * inclusion logic — see verify.ts). This module only owns the host policy: the
 * CLI must never be pointed at an Arkova-operated endpoint.
 */

/** Default independent node when the caller passes no --rpc. */
export const DEFAULT_ESPLORA = 'https://blockstream.info/api';

const ARKOVA_HOST_RE = /(^|\.)arkova\.(io|ai|com|app|dev)$/i;

// Cloud Run's raw *.run.app host IS an Arkova-operated endpoint even though
// it carries no arkova.* vanity domain. Refuse the whole *.run.app suffix
// rather than just Arkova's own service name: Cloud Run hostnames are
// shared, project-scoped infrastructure with no ownership signal in the
// hostname itself, so a narrower match (e.g. requiring "arkova-worker")
// would trust an operator-controlled naming convention as a security
// boundary.
//
// As of 2026-09-21 (#3035, #2986 recovery), packages/sdk's
// `DEFAULT_BASE_URL` and packages/embed's `DEFAULT_API_BASE` no longer
// default to this raw host — both now default to the public API gateway
// host `api.arkova.ai` (refused by `ARKOVA_HOST_RE` below, not this
// regex — this file deliberately never spells out a scheme + Arkova host
// as one string literal; see test/no-network.test.ts's mechanical audit).
// The raw Cloud Run host itself is still a live, directly reachable
// Arkova-operated endpoint (see CLAUDE.md §1.1: it answers publicly and
// unauthenticated, with nothing in front of it), so
// this refusal stays in place independent of which host any SDK currently
// defaults to — a caller can still type or paste the raw host into --rpc.
const CLOUD_RUN_HOST_RE = /\.run\.app$/i;

/**
 * Validate that `endpoint` is a well-formed URL pointing at a node that is NOT
 * Arkova-operated. Returns the parsed URL on success; throws otherwise. Called
 * before any on-chain confirmation so an Arkova `--rpc` is refused up front.
 */
export function assertIndependentEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Invalid --rpc endpoint: ${endpoint}`);
  }
  // A final root dot denotes the same DNS host. URL.hostname retains it,
  // so normalize it before applying the operator-host policy.
  const hostname = url.hostname.replace(/\.$/, '');
  if (ARKOVA_HOST_RE.test(hostname) || CLOUD_RUN_HOST_RE.test(hostname)) {
    throw new Error(
      `Refusing to verify against an Arkova-operated node (${url.hostname}). ` +
        'The reference verifier must confirm the on-chain fact independently. ' +
        'Pass --rpc with your own node or a third-party Esplora endpoint.',
    );
  }
  return url;
}

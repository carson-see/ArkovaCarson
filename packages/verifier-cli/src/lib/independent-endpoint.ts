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

// Cloud Run's raw *.run.app host (e.g. the SDK's DEFAULT_BASE_URL,
// packages/sdk/src/client.ts: arkova-worker-270018525501.us-central1.run.app)
// IS an Arkova-operated endpoint even though it carries no arkova.* vanity
// domain. Refuse the whole *.run.app suffix rather than just Arkova's own
// service name: Cloud Run hostnames are shared, project-scoped infrastructure
// with no ownership signal in the hostname itself, so a narrower match (e.g.
// requiring "arkova-worker") would trust an operator-controlled naming
// convention as a security boundary.
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

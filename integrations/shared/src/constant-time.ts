/**
 * Constant-time comparison for inbound webhook authentication.
 *
 * Shared by every integration that authenticates an inbound request
 * (Bullhorn's `x-arkova-webhook-secret`, Clio's HMAC-SHA256 signature).
 * Lived as a private copy in `integrations/bullhorn/src/webhook-handler.ts`
 * until 2026-09-05; a second integration needing it made a shared home the
 * right place, and one copy is one thing to get right.
 *
 * Dependency-free (Web Crypto conventions only), per this package's rule.
 */

/**
 * Constant-time string equality.
 *
 * Compares byte-by-byte with no early exit on content — the loop always
 * runs the full length and accumulates differences into a single mask, so
 * elapsed time does not vary with how many leading bytes happen to match.
 * A timing signal on *content* is what lets an attacker recover a secret one
 * byte at a time; that is the property being defended here.
 *
 * Length is compared first and leaks, exactly as Node's `timingSafeEqual`
 * does (it throws on a length mismatch). That leak is acceptable: the length
 * of an HMAC-SHA256 hex digest or a deployed shared secret is not secret,
 * and comparing unequal-length inputs byte-wise would either read out of
 * bounds or need padding that reintroduces a content-dependent branch.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

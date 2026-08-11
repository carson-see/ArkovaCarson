/**
 * Client-IP pseudonymisation for audit logs.
 *
 * WHY KEYED, NOT BARE SHA-256. The DPA warrants "hashed IP addresses". A bare
 * `sha256(ip)` does not earn that warranty for IPv4: the address space is
 * ~4.3e9 values, so the full rainbow table is computable in seconds on a
 * laptop and the digest is a reversible encoding of the address, not a
 * pseudonym. Keying the digest with a server-held pepper is what makes the
 * mapping non-invertible to anyone without the pepper — the same reasoning
 * (and the same shape) as `recipient-identity.ts` (SCRUM-2484) and the
 * `API_KEY_HMAC_SECRET` rule in CLAUDE.md §1.4.
 *
 * WHY HASH AT ALL RATHER THAN DROP. Both call sites — `GET /api/v1/verify/:id`
 * and `GET /credentials/:id/ctdl` — are ANONYMOUS public endpoints. `api_key_id`
 * is null for the traffic that matters, so an IP-derived value is the only
 * actor identifier the audit log can carry for the enumeration/scraping abuse
 * these endpoints exist to be investigated for. Dropping it outright would
 * remove the only correlation key without replacing it. A keyed digest keeps
 * "the same caller hit 10k public_ids in a minute" answerable while making
 * "which human was that" unanswerable from the log alone.
 *
 * PEPPER VALUE IS OPERATOR-PROVISIONED: `IP_HASH_PEPPER` must exist in Secret
 * Manager and be wired through `deploy-worker.yml` before deploy. `config.ts`
 * makes production refuse to boot without it, the same way it already does for
 * `API_KEY_HMAC_SECRET` — the fail is loud and at startup, not silent and at
 * the write. This module never falls back to a bare sha256, and never returns
 * the raw address under any argument shape.
 */

import { createHmac } from 'node:crypto';

export class IpPepperUnavailableError extends Error {
  constructor() {
    super(
      'IP_HASH_PEPPER is unset — refusing to hash a client IP. Falling back to bare '
        + 'sha256(ip) would be trivially reversible for IPv4 and would not satisfy the '
        + 'DPA "hashed IP addresses" warranty.',
    );
    this.name = 'IpPepperUnavailableError';
  }
}

/**
 * Canonical form of a client address, so one caller yields one digest.
 *
 * Express reports `::ffff:203.0.113.42` for an IPv4 client on a dual-stack
 * socket and `203.0.113.42` when an X-Forwarded-For hop is trusted. Left
 * unnormalized, the same abuser would occupy two distinct digests and per-IP
 * correlation would silently under-count.
 */
function normalizeIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(trimmed);
  return mapped ? mapped[1] : trimmed;
}

/**
 * Keyed HMAC-SHA256 of a normalized client IP, as 64-char hex.
 *
 * Returns `undefined` when there is no address to hash. Throws
 * {@link IpPepperUnavailableError} when the pepper is missing — fail closed,
 * never degrade to an enumerable bare digest.
 */
export function hashClientIp(ip: string | null | undefined, pepper: string | undefined): string | undefined {
  if (!ip) return undefined;
  const normalized = normalizeIp(ip);
  if (!normalized) return undefined;
  if (!pepper) throw new IpPepperUnavailableError();
  return createHmac('sha256', pepper).update(normalized, 'utf8').digest('hex');
}

/**
 * Audit-writer-safe variant: never throws, never returns a raw address.
 *
 * Audit writes are fire-and-forget on anonymous request paths (see
 * `utils/auditEvent.ts`) — throwing here would either 500 a public verification
 * or lose the whole audit row over a config gap. So the degraded state is an
 * explicit `null` ("we did not record a caller identifier"), which is honest in
 * the row and readable by an auditor, rather than a raw IP or a silent omission.
 *
 * In production this branch is unreachable: `config.ts` refuses to boot without
 * `IP_HASH_PEPPER`.
 */
export function auditIpHash(ip: string | null | undefined, pepper: string | undefined): string | null {
  try {
    return hashClientIp(ip, pepper) ?? null;
  } catch {
    return null;
  }
}

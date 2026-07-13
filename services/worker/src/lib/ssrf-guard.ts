/**
 * SSRF guard — shared private-IP / private-hostname classification.
 *
 * SCRUM-2483: extracted verbatim from webhooks/delivery.ts (INJ-02 / ARK-SEC-002)
 * so the webhook delivery guard AND the safeFetch egress primitive share ONE
 * source of truth. The classifier body is byte-identical to the delivery.ts
 * original; delivery.ts now re-exports these symbols so its behaviour is
 * unchanged (no soak-affecting delta on the webhook path).
 *
 * Covers RFC 1918, loopback, link-local, cloud metadata (169.254.169.254 +
 * metadata.google.internal), CGNAT (100.64/10), IETF assignments, benchmark
 * ranges, and the IPv6 equivalents (loopback, link-local, ULA).
 */

// ─── SSRF Protection (INJ-02) ─────────────────────────────────────────
// Block egress to private/internal IP ranges to prevent SSRF attacks.
// Covers RFC 1918, loopback, link-local, AWS metadata, and IPv6 equivalents.

export const PRIVATE_IP_PATTERNS = [
  /^127\./, // 127.0.0.0/8 loopback
  /^10\./, // 10.0.0.0/8 private
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12 private
  /^192\.168\./, // 192.168.0.0/16 private
  /^169\.254\./, // 169.254.0.0/16 link-local
  /^0\./, // 0.0.0.0/8
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 100.64.0.0/10 CGNAT
  /^192\.0\.0\./, // 192.0.0.0/24 IETF protocol assignments
  /^198\.1[89]\./, // 198.18.0.0/15 benchmark testing
  /^::1$/, // IPv6 loopback
  /^fe80:/i, // IPv6 link-local
  /^fc/i, // IPv6 unique local (fc00::/7)
  /^fd/i, // IPv6 unique local (fc00::/7)
];

export const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal', // GCP metadata
  'metadata.google',
]);

// SCRUM-2483 (HIGH): IPv4-mapped IPv6 forms (::ffff:127.0.0.1, ::ffff:7f00:1,
// the ::0:… / ::ffff: dotted or hextet encodings) let an attacker smuggle a
// private IPv4 target past a naive PRIVATE_IP_PATTERNS scan, because none of
// those patterns match a value that starts with '::ffff:'. We normalise the
// embedded IPv4 back to dotted-quad BEFORE classification. Mirrors the proven
// ipv4FromEmbeddedIpv6 logic in credential-evidence.ts (the second guard on the
// credential path) so the reusable primitive is no longer the weak link.
const EMBEDDED_IPV4_PREFIX = '(?:(?:.*::(?:ffff:)?)|(?:0:0:0:0:0:(?:ffff|0):))';
const EMBEDDED_IPV4_DOTTED_RE = new RegExp(`^${EMBEDDED_IPV4_PREFIX}(\\d{1,3}(?:\\.\\d{1,3}){3})$`);
const EMBEDDED_IPV4_HEX_RE = new RegExp(`^${EMBEDDED_IPV4_PREFIX}([0-9a-f]{1,4}):([0-9a-f]{1,4})$`);

/**
 * If `ip` is an IPv4-mapped IPv6 address, return the embedded IPv4 as a
 * dotted-quad; otherwise null. Accepts both the dotted (`::ffff:127.0.0.1`)
 * and hextet (`::ffff:7f00:1`) encodings.
 */
function ipv4FromEmbeddedIpv6(ip: string): string | null {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const dottedMatch = EMBEDDED_IPV4_DOTTED_RE.exec(normalized);
  if (dottedMatch) return dottedMatch[1]!;

  const hexMatch = EMBEDDED_IPV4_HEX_RE.exec(normalized);
  if (!hexMatch) return null;

  const high = Number.parseInt(hexMatch[1]!, 16);
  const low = Number.parseInt(hexMatch[2]!, 16);
  if (high > 0xffff || low > 0xffff) return null;
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.');
}

/**
 * Check if an IP address is private/internal.
 * Blocks RFC 1918 ranges, loopback, link-local, cloud metadata endpoints,
 * the unspecified address, and IPv4-mapped IPv6 encodings of any of the above.
 */
export function isPrivateIp(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '169.254.169.254') return true;
  // Unspecified address: '::' (and its long form) binds to 0.0.0.0 → never egress.
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;
  // IPv6 loopback long form (PRIVATE_IP_PATTERNS only matches the '::1' shorthand).
  if (normalized === '0:0:0:0:0:0:0:1') return true;
  // Unwrap an IPv4-mapped IPv6 target and classify the embedded IPv4. The
  // metadata IP 169.254.169.254 is covered by the 169.254.0.0/16 pattern below.
  const embeddedIpv4 = ipv4FromEmbeddedIpv6(normalized);
  if (embeddedIpv4 && PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(embeddedIpv4))) {
    return true;
  }
  return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Check if a hostname is a known-internal name (localhost, cloud metadata).
 * Does NOT resolve DNS — this is the static/name-based portion of the guard.
 * Callers must additionally resolve + check every IP via {@link isPrivateIp}
 * (or use {@link resolveHostToIps}) to defend against DNS rebinding.
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host === '169.254.169.254') return true;
  return false;
}

/**
 * Resolve a hostname to its A/AAAA records. Returns the union of IPv4 + IPv6
 * results. Throws only on a hard DNS error; an empty answer is returned as an
 * empty array so callers can fail closed on their own terms.
 */
export async function resolveHostToIps(hostname: string): Promise<string[]> {
  const cleanHost = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // Literal IP addresses do not need resolution.
  if (/^[\d.]+$/.test(cleanHost) || cleanHost.includes(':')) {
    return [cleanHost];
  }

  const dns = await import('node:dns');
  const { resolve4, resolve6 } = dns.promises;

  const [ipv4Results, ipv6Results] = await Promise.allSettled([
    resolve4(cleanHost),
    resolve6(cleanHost),
  ]);

  const allIps: string[] = [];
  if (ipv4Results.status === 'fulfilled') allIps.push(...ipv4Results.value);
  if (ipv6Results.status === 'fulfilled') allIps.push(...ipv6Results.value);

  return allIps;
}

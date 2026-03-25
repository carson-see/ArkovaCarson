/**
 * SEC-007: URL validation to prevent XSS via javascript: URIs in href attributes.
 *
 * React does NOT validate href attributes. javascript:, data:, and vbscript:
 * URLs in href execute arbitrary code when clicked.
 */

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * Returns true if the URL is safe for use in an href attribute.
 * Only allows http:, https:, and mailto: protocols.
 * Rejects javascript:, data:, vbscript:, and malformed URLs.
 */
export function isSafeUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false;

  // Trim whitespace and check for obvious dangerous patterns
  const trimmed = url.trim();
  if (!trimmed) return false;

  // Reject URLs with leading whitespace/control characters that could bypass checks
  if (/^[\s\x00-\x1f]/.test(url)) return false;

  try {
    // Relative URLs are safe (they inherit the page's protocol)
    if (trimmed.startsWith('/') || trimmed.startsWith('#') || trimmed.startsWith('?')) {
      return true;
    }

    const parsed = new URL(trimmed, window.location.origin);
    return SAFE_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Sanitizes a URL for use in href. Returns the URL if safe, '#' otherwise.
 */
export function sanitizeHref(url: string | null | undefined): string {
  if (!url) return '#';
  return isSafeUrl(url) ? url : '#';
}

/**
 * Error Sanitizer Middleware (CISO THREAT-4)
 *
 * Strips provider names, API versions, and internal stack details
 * from all error responses before they reach the client.
 *
 * Registered BEFORE the global error handler to intercept error bodies.
 * Works as a response interceptor on res.json().
 */

/** Provider/infrastructure keywords that must never leak to clients */
const SENSITIVE_PATTERNS = [
  /\bgemini\b/gi,
  /\bgoogle\s*(generative|ai|cloud)?\b/gi,
  /\bcloudflare\b/gi,
  /\bsupabase\b/gi,
  /\bstripe\b/gi,
  /\bsentry\b/gi,
  /\bpostgres(ql)?\b/gi,
  /\bbitcoin(js)?[-\s]?lib\b/gi,
  /\baws\s*kms\b/gi,
  /\bupstash\b/gi,
  /\bresend\b/gi,
  /\breplicate\b/gi,
  /\bvercel\b/gi,
  /\bcloud\s*run\b/gi,
  /v1beta\//gi,
  /v1alpha\//gi,
  /generativelanguage\.googleapis\.com/gi,
  /api\.stripe\.com/gi,
  // API key fragments (partial key matches like sk-... or AIza...)
  /\b(sk-[a-zA-Z0-9]{4,}|AIza[a-zA-Z0-9_-]{10,})\b/g,
];

/**
 * Sanitize a string by replacing provider/infrastructure names with generic terms.
 */
export function sanitizeErrorMessage(message: string): string {
  let sanitized = message;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}

/**
 * Deep-sanitize an error response body.
 * Only applied to 4xx/5xx responses to avoid touching success payloads.
 */
export function sanitizeErrorBody(body: unknown): unknown {
  if (typeof body === 'string') {
    return sanitizeErrorMessage(body);
  }
  if (typeof body !== 'object' || body === null) {
    return body;
  }
  if (Array.isArray(body)) {
    return body.map(sanitizeErrorBody);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === 'string') {
      result[key] = sanitizeErrorMessage(value);
    } else if (typeof value === 'object' && value !== null) {
      result[key] = sanitizeErrorBody(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

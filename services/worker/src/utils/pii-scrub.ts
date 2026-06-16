/**
 * PII string scrubbing (Constitution 1.4 + 1.6).
 *
 * SCRUM-2492 (§1.6A): extracted from `utils/sentry.ts` so there is ONE source
 * of truth for the email / fingerprint / SSN / API-key / JWT / phone / IP /
 * Supabase-ref / UUID redaction regexes. Both the Sentry `beforeSend` scrubber
 * (`utils/sentry.ts`) and the bounded connector-error `detail` builder
 * (`utils/byte-safety.ts`) run candidate strings through `scrubString` so a
 * value that is safe for Sentry is equally safe for pino logs and
 * `job_queue.last_error` (pino strips bytes but NOT PII).
 *
 * This module is intentionally dependency-free (no `@sentry/node` import) so it
 * can be pulled into the byte-safety util — which `utils/jobQueue.ts` imports —
 * without dragging the Sentry SDK into the job-queue import graph.
 */

// `?access_token=...` / `?token=...` query-string secrets → `=[FILTERED]`.
export const URL_TOKEN_REGEX = /(access_token|token|key|secret|password|auth)=[^&\s]+/gi;

// Ordered: project-ref host is scrubbed whole BEFORE the generic UUID pass
// (SCRUM-2249), so the 20-char ref isn't partially mangled.
export const TEXT_SCRUBBERS: Array<[RegExp, string]> = [
  [/\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,24}\b/gi, '[EMAIL]'],
  [/\b[a-f0-9]{64}\b/gi, '[FINGERPRINT]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]'],
  [/\bak_(live|test)_[a-zA-Z0-9]+/g, '[API_KEY]'],
  [/\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[JWT]'],
  [/(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{4}\b/g, '[PHONE]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP_ADDR]'],
  // SCRUM-2249: project-ref before UUID scrubbing so the host is replaced whole.
  [/https:\/\/[a-z0-9]{20}\.supabase\.co/gi, 'https://[SUPABASE_PROJECT].supabase.co'],
  [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    '[UUID]',
  ],
];

/** Replace PII substrings (email / fingerprint / SSN / API key / JWT / phone / IP / UUID). */
export function scrubString(str: string): string {
  return TEXT_SCRUBBERS.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    str,
  );
}

/** Scrub a URL: filter `token=`-style query secrets, then run the PII passes. */
export function scrubUrl(url: string): string {
  return scrubString(url.replace(URL_TOKEN_REGEX, '$1=[FILTERED]'));
}

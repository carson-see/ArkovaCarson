/**
 * Byte-safety helpers (SCRUM-2492 / CLAUDE.md §1.6A).
 *
 * ONE source of truth for the "does this look like raw document bytes?"
 * detection that both:
 *   - `utils/jobQueue.ts` (`sanitizeLastError`, which guards
 *     `job_queue.last_error`), and
 *   - the bounded connector-error `detail` builder (`boundedErrorDetail`,
 *     consumed by `integrations/oauth/{docusign,drive}.ts`)
 * rely on. Previously these heuristics lived inline in `jobQueue.ts`; they were
 * extracted here so there is no duplicate, drifting copy.
 *
 * §1.6A: connector-fetched document bytes must never reach a logger, Sentry, an
 * Error, `last_error`, a temp file, or Postgres. These helpers are a
 * defense-in-depth net: even when an error `detail` is built from a *parsed
 * JSON* body (the safe OAuth/API-error path), we still type-check + heuristic-
 * scan for bytes so a future caller that hands us a Buffer/typed-array (or its
 * serialized shape) gets a redaction token rather than a byte leak.
 */

import { URL_TOKEN_REGEX, scrubString } from './pii-scrub.js';

/** Token written in place of any byte-bearing value. */
export const REDACTED_BYTES_TOKEN = '[redacted: binary content]';

// `{ "type": "Buffer", "data": [ ... ] }` — Node's JSON form of a Buffer.
export const SERIALIZED_BUFFER_RE = /\{\s*"?type"?\s*:\s*"Buffer"\s*,\s*"?data"?\s*:\s*\[/i;

// A dense run of non-printable control bytes this long is not a plausible
// human/error message — it is binary content (or invalid UTF-8 decoded to
// U+FFFD) coerced to text.
const CONTROL_RUN_THRESHOLD = 8;
// A run of identical characters this long is not a plausible human/error
// message — it is a low-entropy byte fill coerced to text (e.g. a PDF padding
// region, or `Buffer.alloc(n, b).toString()`).
const REPEAT_RUN_THRESHOLD = 32;

/**
 * Is `value` a binary container we must never stringify into a sink?
 * Buffer / any TypedArray / DataView / ArrayBuffer.
 */
export function isBinaryValue(value: unknown): boolean {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return true;
  if (ArrayBuffer.isView(value as ArrayBufferView)) return true; // every TypedArray + DataView
  if (value instanceof ArrayBuffer) return true;
  return false;
}

/** The JSON-serialized form of a Buffer: `{ type: 'Buffer', data: [number,…] }`. */
export function isSerializedBufferShape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return obj.type === 'Buffer' && Array.isArray(obj.data);
}

/**
 * Heuristic: does `text` look like raw document bytes coerced to a string?
 * Two signals, both rare in real error messages:
 *   (a) a dense run of non-printable control bytes (binary content / invalid
 *       UTF-8 decoded to U+FFFD), or
 *   (b) a long run of a single repeated character (low-entropy byte fill).
 * Implemented programmatically (no control chars in source).
 */
export function looksLikeRawBytes(text: string): boolean {
  let controlRun = 0;
  let repeatRun = 1;
  let prev = -1;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);

    const isNonPrintable =
      (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f ||
      code === 0xfffd; // U+FFFD replacement char from invalid UTF-8
    if (isNonPrintable) {
      controlRun += 1;
      if (controlRun >= CONTROL_RUN_THRESHOLD) return true;
    } else {
      controlRun = 0;
    }

    if (code === prev) {
      repeatRun += 1;
      if (repeatRun >= REPEAT_RUN_THRESHOLD) return true;
    } else {
      repeatRun = 1;
      prev = code;
    }
  }
  return false;
}

// Cap for a connector-error `detail`. OAuth/API error JSON
// (`{ "error": "invalid_grant", "error_description": "..." }`) is small; 500
// chars keeps a useful tail without risking an unbounded body in a sink.
const DETAIL_MAX_LENGTH = 500;

/**
 * Build a safe, bounded `detail` string for a connector error from a *parsed
 * JSON error body* (SCRUM-2492 / §1.6A).
 *
 * The detail is byte-safe AND PII-scrubbed BY CONSTRUCTION, so it is safe in
 * BOTH pino logs (which strip bytes by type but NOT PII) and Sentry (which
 * scrubs PII but relies on the type guard for bytes):
 *
 *   - null/undefined → undefined (no detail).
 *   - Buffer / typed-array / ArrayBuffer, OR the `{ type:'Buffer', data:[…] }`
 *     shape, OR a string that *looks like* coerced raw bytes → the redaction
 *     token (defense-in-depth — the document-fetch path never calls this).
 *   - Otherwise: coerce (JSON.stringify objects; pass strings through), strip
 *     `token=`/`secret=`-style URL query secrets, PII-scrub (email / UUID / JWT
 *     / SSN / API-key / phone / IP / Supabase-ref), and cap to ~500 chars.
 *
 * MUST NOT be called with a raw document-fetch response body — that path stays
 * detail-free (status + message only). This builder is for the non-document
 * connector paths (token exchange/refresh, userinfo, Connect, Drive
 * changes/metadata/revoke) whose error body is safe OAuth/API error JSON.
 */
export function boundedErrorDetail(body: unknown): string | undefined {
  if (body === null || body === undefined) return undefined;

  // Type-level byte guard first — never stringify a binary container.
  if (isBinaryValue(body) || isSerializedBufferShape(body)) {
    return REDACTED_BYTES_TOKEN;
  }

  let text: string;
  if (typeof body === 'string') {
    text = body;
  } else {
    try {
      text = JSON.stringify(body);
    } catch {
      // Circular / non-serializable — fall back to a coarse coercion.
      text = String(body);
    }
  }

  if (text.length === 0) return undefined;

  // Heuristic byte guard (catches a Buffer already coerced to a string, or its
  // serialized shape) BEFORE we expose any of it.
  if (SERIALIZED_BUFFER_RE.test(text) || looksLikeRawBytes(text)) {
    return REDACTED_BYTES_TOKEN;
  }

  // Strip `?access_token=…` / `?secret=…` URL query secrets (which the PII
  // regexes alone don't catch — they may ride a `redirect_uri` echoed in the
  // body), THEN run the email/UUID/JWT/… PII passes. Same composition as
  // sentry's `scrubUrl`, applied over the whole detail text.
  const scrubbed = scrubString(text.replace(URL_TOKEN_REGEX, '$1=[FILTERED]'));
  return scrubbed.length > DETAIL_MAX_LENGTH ? scrubbed.slice(0, DETAIL_MAX_LENGTH) : scrubbed;
}

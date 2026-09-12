/**
 * The ONLY outbound call Arkova makes to ComputeID: `GET /v1/agents/{id}/verify`,
 * used exclusively by the scheduled passport re-check (SCRUM-4495).
 *
 * Admission (`POST /api/v1/agents/computeid/admit`) stays fully offline — it
 * verifies the receipt the agent presents against the pinned CA and never
 * touches the network. Nothing here changes that.
 *
 * SSRF posture: the origin comes from `config.computeidApiBaseUrl` and nothing
 * else. The only caller-supplied component is a passport id read out of our own
 * `agents.metadata` binding, which is rejected unless it matches the canonical
 * UUID shape and is then percent-encoded into a single path segment; the
 * resulting URL's origin is re-asserted against the configured origin before
 * the request is made, and a redirect is an error rather than something we
 * follow to an attacker-chosen host.
 *
 * Privacy: the partner's response body never reaches the logger, Sentry, an
 * `Error` message, or the DLQ. Failures carry a fixed reason code and, at most,
 * an HTTP status number.
 */
import { config } from '../../config.js';
import { DB_UUID_RE } from '../../utils/db-row-validation.js';
import { readTextBounded } from '../../utils/body-read-timeout.js';
import { ComputeIdVerifyResponse, type ComputeIdVerifyResponseT } from './schemas.js';

export const VERIFY_REQUEST_TIMEOUT_MS = 5_000;
/** Observed real responses are ~9.5 KB (the ML-DSA key and signature dominate). */
export const VERIFY_MAX_RESPONSE_BYTES = 256 * 1024;

export type VerifyFailureReason =
  | 'not_configured'
  | 'invalid_passport_id'
  | 'request_failed'
  | 'timeout'
  | 'http_error'
  | 'response_too_large'
  | 'malformed_response';

export type VerifyOutcome =
  | { ok: true; response: ComputeIdVerifyResponseT }
  | { ok: false; reason: VerifyFailureReason; status?: number };

export interface VerifyClientOptions {
  timeoutMs?: number;
  /** Injected in tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
}

/** True when the re-check has everything it needs to call the partner at all. */
export function isVerifyClientConfigured(): boolean {
  return Boolean(config.computeidApiKey?.trim());
}

export async function fetchPassportVerification(
  passportId: string,
  opts: VerifyClientOptions = {},
): Promise<VerifyOutcome> {
  const apiKey = config.computeidApiKey?.trim();
  if (!apiKey) return { ok: false, reason: 'not_configured' };
  if (!DB_UUID_RE.test(passportId)) return { ok: false, reason: 'invalid_passport_id' };

  const base = new URL(config.computeidApiBaseUrl);
  const url = new URL(`/v1/agents/${encodeURIComponent(passportId)}/verify`, base);
  // Belt and braces: a passport id can only be a UUID by the check above, so
  // this cannot fire — it is here so that a future relaxation of that check
  // cannot silently turn a stored value into a request to another host.
  if (url.origin !== base.origin) return { ok: false, reason: 'invalid_passport_id' };

  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs ?? VERIFY_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    return { ok: false, reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'request_failed' };
  }

  if (!res.ok) return { ok: false, reason: 'http_error', status: res.status };

  // Declared size first: a body that ANNOUNCES more than the cap is refused
  // without reading a byte of it, so the cap below is the backstop for a
  // response that lies or omits the header, not the only line of defence.
  const declared = Number(res.headers?.get?.('content-length') ?? '');
  if (Number.isFinite(declared) && declared > VERIFY_MAX_RESPONSE_BYTES) {
    return { ok: false, reason: 'response_too_large' };
  }

  let text: string;
  try {
    // `AbortSignal.timeout` above bounds the REQUEST, not this read: a partner
    // that sends headers and then stalls the body parks this await forever
    // (F-D0-5 / feedback_bounded_body_reads). The URL carries no credential —
    // the API key is a header — so it is safe in the timeout error's message.
    text = await readTextBounded(res, url.toString(), opts.timeoutMs ?? VERIFY_REQUEST_TIMEOUT_MS);
  } catch (err) {
    return { ok: false, reason: err instanceof Error && err.name === 'BodyReadTimeoutError' ? 'timeout' : 'request_failed' };
  }
  if (Buffer.byteLength(text, 'utf8') > VERIFY_MAX_RESPONSE_BYTES) {
    return { ok: false, reason: 'response_too_large' };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    // The parse error message would echo partner bytes. Fixed reason only.
    return { ok: false, reason: 'malformed_response' };
  }
  const parsed = ComputeIdVerifyResponse.safeParse(parsedJson);
  if (!parsed.success) return { ok: false, reason: 'malformed_response' };
  return { ok: true, response: parsed.data };
}

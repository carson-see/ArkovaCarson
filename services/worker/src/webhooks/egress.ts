/**
 * SCRUM-4983 — the ONE IP-pinned egress path for every outbound webhook
 * socket: scheduled delivery, retry, replay, the registration verification
 * ping and both test pings (API-key and self-service).
 *
 * `isPrivateUrlResolved()` is a pre-check, not a connection guard: it resolves
 * and validates the endpoint host, and a plain `fetch()` afterwards resolves
 * AGAIN. A tenant-controlled host answering a public A record during the
 * check and `169.254.169.254` (TTL 0) at dispatch reaches the GCE metadata
 * server. `webhookFetch` is `createSafeFetchImpl()` from `lib/safe-fetch.ts`:
 * resolve → validate → connect to the PINNED IP with the original Host/SNI,
 * the same primitive credential-source imports and the CTDL registry fetch
 * use. Mirrors the seam shape in `api/v1/credential-sources.ts`.
 *
 * Tests: the pinned dispatch uses undici's own `fetch`, so
 * `vi.stubGlobal('fetch', …)` does NOT intercept it. Suites that drive a real
 * dispatch site inject `__setWebhookFetchForTests((url, init) =>
 * globalThis.fetch(url, init))` at module load.
 */
import { createSafeFetchImpl, isPermanentSafeFetchError, type SafeFetchErrorCode } from '../lib/safe-fetch.js';

export type WebhookFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// createSafeFetchImpl() only captures closures; undici itself is imported
// lazily inside the dispatch, so constructing this at module load costs nothing.
const pinnedWebhookFetch: WebhookFetchFn = createSafeFetchImpl();
let webhookFetchOverride: WebhookFetchFn | null = null;

export function webhookFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return (webhookFetchOverride ?? pinnedWebhookFetch)(url, init);
}

/** Test seam — pass null to restore the pinned production dispatch. */
export function __setWebhookFetchForTests(impl: WebhookFetchFn | null): void {
  webhookFetchOverride = impl;
}

export interface EgressFailure {
  /** True when the pinned layer refused the destination itself — never retry. */
  permanent: boolean;
  code: SafeFetchErrorCode | null;
  /** Stable, log/DLQ-safe message (`egress_refused: <code>` for refusals). */
  message: string;
}

export function formatEgressFailure(error: unknown): EgressFailure {
  if (isPermanentSafeFetchError(error)) {
    return { permanent: true, code: error.code, message: `egress_refused: ${error.code}` };
  }
  return {
    permanent: false,
    code: null,
    message: error instanceof Error ? error.message : 'Unknown error',
  };
}

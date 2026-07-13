/**
 * SCRUM-2483 — the SSRF-guarded `FetchLike` for credential-source provider
 * clients (Accredible, Credly).
 *
 * These provider clients (accredible/client.ts, credly/client.ts) take an
 * injectable `fetch: FetchLike` so tests can stub HTTP. In production, the
 * injected fetch MUST be IP-pinned so a provider hostname that rebinds to a
 * private/link-local address (e.g. 169.254.169.254) cannot be reached. Wire the
 * client with `{ fetch: createSafeProviderFetch() }` — NOT the raw `fetch`
 * global — so every request resolves + validates + pins the IP.
 *
 * The clients pass a `URLSearchParams`-built absolute URL and read
 * ok/status/headers/json/text off the response — all satisfied by the WHATWG
 * `Response` that `createSafeFetchImpl` returns.
 */

import { createSafeFetchImpl } from '../../lib/safe-fetch.js';
import type { FetchLike } from './types.js';

/**
 * Build an SSRF-guarded, IP-pinned `FetchLike` suitable for injecting into the
 * Accredible / Credly provider clients. Provider clients issue single requests
 * (no redirect chains), so this uses the single-hop pinned fetch.
 */
export function createSafeProviderFetch(): FetchLike {
  const impl = createSafeFetchImpl();
  return (input, init) =>
    impl(input, init as RequestInit | undefined) as unknown as ReturnType<FetchLike>;
}

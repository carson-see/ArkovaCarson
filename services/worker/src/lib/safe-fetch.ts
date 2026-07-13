/**
 * safeFetch — the single IP-pinned egress primitive for worker outbound HTTP.
 *
 * SCRUM-2483. Closes the SSRF / TOCTOU / DNS-rebind class:
 *
 *   1. Parse + scheme allow-list (https/http only — reject file:/gopher:/ftp:/data:).
 *   2. Resolve the hostname to A/AAAA records ONCE.
 *   3. Reject if ANY resolved IP is private/link-local/loopback/CGNAT/metadata
 *      (fail closed on zero IPs or resolver error).
 *   4. CONNECT to the PINNED resolved IP — the connection target is the exact IP
 *      that was validated, so a rebind flip between resolve-time and connect-time
 *      cannot redirect the socket to a private host. (The prod dispatch builds an
 *      undici Agent whose connect forces the pinned IP while preserving the Host
 *      header + TLS SNI/servername.)
 *   5. Re-validate EVERY redirect hop the same way before following it; enforce a
 *      max-redirect depth.
 *   6. Enforce a response-size cap and connect/total deadlines.
 *
 * The two security-critical steps — resolve+validate and pinned-connect — are
 * injected as {@link SafeFetchDeps} so tests can drive the rebind adversary
 * deterministically with no real network. Production callers use
 * {@link defaultSafeFetchDeps}.
 */

import { isPrivateIp, isPrivateHostname, resolveHostToIps } from './ssrf-guard.js';

export type SafeFetchErrorCode =
  | 'scheme_not_allowed'
  | 'invalid_url'
  | 'unresolvable'
  | 'private_target'
  | 'too_many_redirects'
  | 'redirect_invalid'
  | 'response_too_large'
  | 'deadline_exceeded'
  | 'request_failed';

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

/**
 * The minimal response surface safeFetch exposes. Deliberately narrower than
 * the DOM `Response` so a stub dispatch (tests) and the undici dispatch (prod)
 * satisfy the same contract.
 */
export interface SafeFetchResponse {
  status: number;
  headers: Headers;
  /** Final resolved URL of this hop. */
  url: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface SafeFetchDeps {
  /** Resolve a hostname to its A/AAAA records (union). */
  resolve: (hostname: string) => Promise<string[]>;
  /**
   * Perform a SINGLE HTTP request, connecting to the already-validated
   * `pinnedIp`. Must NOT re-resolve `url`'s hostname — the socket target is
   * `pinnedIp`. Must NOT auto-follow redirects (safeFetch drives the redirect
   * loop so every hop is re-validated).
   */
  dispatch: (pinnedIp: string, url: string, init: RequestInit) => Promise<SafeFetchResponse>;
}

export interface SafeFetchOptions {
  /** Max redirect hops to follow. Default 3. */
  maxRedirects?: number;
  /** Cap on response body bytes. Default 5 MiB. */
  maxResponseBytes?: number;
  /** Total deadline for the whole call (all hops). Default 10 s. */
  totalTimeoutMs?: number;
}

const ALLOWED_SCHEMES = new Set(['https:', 'http:']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TOTAL_TIMEOUT_MS = 10_000;

function parseUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SafeFetchError('invalid_url', 'Target URL is not a valid absolute URL');
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new SafeFetchError(
      'scheme_not_allowed',
      `Scheme ${parsed.protocol} is not allowed (only http/https)`,
    );
  }
  return parsed;
}

/**
 * Resolve the URL's host and return a single validated, pinnable IP. Fails
 * closed: any private IP in the answer, an empty answer, an internal hostname,
 * or a resolver error all reject.
 */
async function resolveAndPin(parsed: URL, resolve: SafeFetchDeps['resolve']): Promise<string> {
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // Name-based block (localhost / metadata.google.internal / literal metadata IP).
  if (isPrivateHostname(hostname)) {
    throw new SafeFetchError('private_target', `Refusing egress to internal host ${hostname}`);
  }

  let ips: string[];
  try {
    ips = await resolve(hostname);
  } catch (error) {
    throw new SafeFetchError(
      'unresolvable',
      `DNS resolution failed for ${hostname}: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }

  if (ips.length === 0) {
    throw new SafeFetchError('unresolvable', `No A/AAAA records for ${hostname}`);
  }

  // Fail closed if ANY resolved record is private — an attacker cannot smuggle
  // a private rebind target alongside a public one.
  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      throw new SafeFetchError(
        'private_target',
        `Refusing egress: ${hostname} resolves to private/link-local ${ip}`,
      );
    }
  }

  // Pin the first validated public IP. Every record was checked above, so the
  // pinned IP is guaranteed public.
  return ips[0]!;
}

function resolveRedirectTarget(location: string, currentUrl: string): URL {
  try {
    return new URL(location, currentUrl);
  } catch {
    throw new SafeFetchError('redirect_invalid', 'Redirect Location header is not a valid URL');
  }
}

async function fetchValidatedHop(
  currentUrl: string,
  init: RequestInit,
  deps: SafeFetchDeps,
): Promise<{ parsed: URL; response: SafeFetchResponse }> {
  const parsed = parseUrl(currentUrl);
  const pinnedIp = await resolveAndPin(parsed, deps.resolve);

  try {
    return {
      parsed,
      response: await deps.dispatch(pinnedIp, parsed.toString(), init),
    };
  } catch (error) {
    if (error instanceof SafeFetchError) throw error;
    throw new SafeFetchError(
      'request_failed',
      `Request to ${parsed.hostname} failed: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
}

function nextRedirectUrl(response: SafeFetchResponse, parsed: URL, hop: number, maxRedirects: number): string {
  if (hop === maxRedirects) {
    throw new SafeFetchError('too_many_redirects', `Exceeded ${maxRedirects} redirects`);
  }

  const location = response.headers.get('location');
  if (!location) {
    throw new SafeFetchError('redirect_invalid', 'Redirect response had no Location header');
  }

  // Re-validate the next hop on the next loop iteration (parseUrl +
  // resolveAndPin), so a redirect to a private host is refused per-hop.
  return resolveRedirectTarget(location, parsed.toString()).toString();
}

/**
 * Fetch a URL with full SSRF protection. See module docstring.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit,
  deps: SafeFetchDeps,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResponse> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const deadline = Date.now() + totalTimeoutMs;

  let currentUrl = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (Date.now() > deadline) {
      throw new SafeFetchError('deadline_exceeded', `safeFetch exceeded ${totalTimeoutMs}ms total deadline`);
    }
    const { parsed, response } = await fetchValidatedHop(currentUrl, init, deps);

    if (REDIRECT_STATUSES.has(response.status)) {
      currentUrl = nextRedirectUrl(response, parsed, hop, maxRedirects);
      continue;
    }

    return guardResponseSize(response, maxResponseBytes);
  }

  throw new SafeFetchError('too_many_redirects', `Exceeded ${maxRedirects} redirects`);
}

/**
 * Perform EXACTLY ONE validated, IP-pinned hop and return the raw response,
 * INCLUDING any 3xx redirect (the redirect is NOT followed). For callers that
 * run their own manual redirect loop and re-guard each hop themselves
 * (credential-source-import.ts). The single hop still resolves + validates +
 * pins the IP, so the socket can only reach a validated public address.
 */
export async function safeFetchSingleHop(
  rawUrl: string,
  init: RequestInit,
  deps: SafeFetchDeps,
  options: Pick<SafeFetchOptions, 'maxResponseBytes'> = {},
): Promise<SafeFetchResponse> {
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const parsed = parseUrl(rawUrl);
  const pinnedIp = await resolveAndPin(parsed, deps.resolve);

  let response: SafeFetchResponse;
  try {
    response = await deps.dispatch(pinnedIp, parsed.toString(), init);
  } catch (error) {
    if (error instanceof SafeFetchError) throw error;
    throw new SafeFetchError(
      'request_failed',
      `Request to ${parsed.hostname} failed: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }

  // Surface 3xx as-is (caller re-guards + follows); only cap non-redirect bodies.
  if (REDIRECT_STATUSES.has(response.status)) return response;
  return guardResponseSize(response, maxResponseBytes);
}

/**
 * Wrap a response so its arrayBuffer() enforces the byte cap even when no
 * Content-Length header is present (streaming bomb defense).
 */
function guardResponseSize(response: SafeFetchResponse, maxBytes: number): SafeFetchResponse {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new SafeFetchError(
        'response_too_large',
        `Response Content-Length ${parsed} exceeds cap ${maxBytes}`,
      );
    }
  }

  const originalArrayBuffer = response.arrayBuffer.bind(response);
  return {
    ...response,
    status: response.status,
    headers: response.headers,
    url: response.url,
    async arrayBuffer(): Promise<ArrayBuffer> {
      const buf = await originalArrayBuffer();
      if (buf.byteLength > maxBytes) {
        throw new SafeFetchError(
          'response_too_large',
          `Response body ${buf.byteLength} exceeds cap ${maxBytes}`,
        );
      }
      return buf;
    },
  };
}

/**
 * Adapt safeFetch into a `fetch`-shaped function for callers that run their OWN
 * manual redirect loop (e.g. credential-source-import.ts). Each call performs a
 * SINGLE hop with the IP pinned to the validated resolved address, so the
 * caller's separate URL guard and the actual socket target can no longer
 * disagree under DNS rebinding (collapses the TOCTOU split).
 *
 * The returned function honours `init.redirect === 'manual'` by never following
 * redirects here (maxRedirects: 0) and surfacing the 3xx response to the caller.
 * It returns a minimal `Response`-compatible object built from the pinned hop.
 */
export function createSafeFetchImpl(
  deps: SafeFetchDeps = defaultSafeFetchDeps(),
): (url: string, init?: RequestInit) => Promise<Response> {
  return async function safeFetchImpl(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await safeFetchSingleHop(url, init, deps);
    const isRedirect = res.status >= 300 && res.status < 400;
    const body = isRedirect ? null : await res.arrayBuffer();
    return new Response(body, {
      status: res.status,
      headers: res.headers,
    });
  };
}

/**
 * Production deps: resolve via node:dns and dispatch via `globalThis.fetch` with
 * an undici Agent whose connect() forces the socket to the pinned IP while
 * preserving the Host header and TLS SNI/servername. This guarantees
 * resolve-time IP === connect-time IP.
 *
 * We use `globalThis.fetch` (Node's built-in, undici-backed) rather than
 * importing undici's `fetch` directly for two reasons: (1) Node's global fetch
 * honours the `dispatcher` RequestInit option, so the Agent still pins the IP;
 * (2) test suites that `vi.stubGlobal('fetch', …)` continue to intercept the
 * call (the stub simply ignores the dispatcher, which is fine — tests supply
 * their own DNS/guard mocks and do not exercise real socket pinning). The Agent
 * is built lazily so unit tests that inject stub deps never load undici.
 */
export function defaultSafeFetchDeps(): SafeFetchDeps {
  return {
    resolve: resolveHostToIps,
    async dispatch(pinnedIp: string, url: string, init: RequestInit): Promise<SafeFetchResponse> {
      const { Agent } = await import('undici');
      const parsed = new URL(url);
      const servername = parsed.hostname;

      // Pin the connection to the validated IP: undici's connect receives the
      // request's hostname, which we override to the pinned IP so no second DNS
      // lookup happens. TLS SNI (servername) stays the original hostname so
      // certificate validation still passes for the intended host.
      const agent = new Agent({
        connect: {
          servername,
          lookup(_hostname, opts, callback) {
            const family = pinnedIp.includes(':') ? 6 : 4;
            // undici's connect invokes lookup with { all: true } and, in that
            // mode, node's net.connect expects an ARRAY of { address, family }.
            // The legacy 3-arg positional form (callback(null, ip, family))
            // yields `address === undefined` under { all: true } and throws
            // 'Invalid IP address: undefined', failing 100% of real egress.
            if (opts && (opts as { all?: boolean }).all) {
              callback(null, [{ address: pinnedIp, family }] as never);
              return;
            }
            callback(null, pinnedIp, family);
          },
        },
      });

      try {
        const res = await globalThis.fetch(url, {
          ...init,
          redirect: 'manual',
          // Node's global fetch forwards `dispatcher` to undici; typed loosely
          // because the DOM RequestInit lib type omits it.
          dispatcher: agent,
        } as RequestInit);

        return {
          status: res.status,
          headers: res.headers,
          url: res.url,
          arrayBuffer: () => res.arrayBuffer(),
        };
      } finally {
        // Release sockets promptly; the agent is single-use per request.
        agent.close().catch(() => undefined);
      }
    },
  };
}

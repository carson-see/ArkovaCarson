/**
 * Credly HTTP client — SCRUM-1612 CSI-04B.
 *
 * Talks to Credly's issuer API via OAuth 2.0 `client_credentials` grant
 * (per-organisation, 2-hour access tokens, no refresh tokens). Per
 * researcher findings (2026-05-28) Credly does NOT offer consumer OAuth;
 * each issuer organisation provisions a `client_credentials` app.
 *
 * Scope here:
 *   - Mint an access token via POST /oauth/token, cache it until expiry
 *   - List issued badges (filter by recipient_email, paginated)
 *   - Get a single badge by id
 *
 * Out of scope (deferred to v1.1 per PRD §13):
 *   - Cryptographic verification of Open Badges 3.0 / W3C VC 2.0 proof
 *     blocks. The client returns raw badge JSON; downstream callers can
 *     detect a `proof` field but must not assert "source_signed" until
 *     proof verification ships in v1.1.
 *
 * Endpoints + scopes are configurable so the partnership team can supply
 * the exact production values when the Credly app is registered (see
 * Sprint 0 task SCRUM-2131).
 *
 * No real HTTP traffic in tests: callers inject a `fetch`-shaped function.
 * The default uses Node 20's built-in `fetch` global.
 */
import { z } from 'zod';

import type { FetchLike } from '../types.js';

// Re-exported for back-compat: callers and tests that imported `FetchLike`
// from this module continue to work. The canonical definition now lives in
// `../types.ts` so no provider client depends on another (SCRUM-1613 P2.4).
export type { FetchLike } from '../types.js';

/** Default Credly API base. Override per environment via deps. */
export const DEFAULT_CREDLY_API_BASE = 'https://api.credly.com';

/** Credly token-endpoint response. Only the fields we use are required. */
export const CredlyTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  /** Seconds. Credly tokens are documented as 2-hour lived (~7200). */
  expires_in: z.number().int().positive(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});
export type CredlyTokenResponse = z.infer<typeof CredlyTokenResponseSchema>;

/**
 * Subset of Credly's "issued badge" payload that we currently consume.
 * Credly's full payload follows Open Badges 3.0; we tolerate extra keys
 * via `.passthrough()` so partnership-time payload shape changes don't
 * crash the import pipeline — only the fields we actually map matter.
 */
export const CredlyIssuedBadgeSchema = z
  .object({
    id: z.string().min(1),
    issued_at: z.string().optional(),
    expires_at: z.string().datetime({ offset: true }).nullable().optional(),
    public_url: z.string().url().optional(),
    image_url: z.string().url().optional(),
    /** Recipient block — Credly redacts email behind a hash for non-issuers. */
    recipient: z
      .object({
        email: z.string().email().optional(),
      })
      .optional(),
    badge_template: z
      .object({
        id: z.string().optional(),
        name: z.string().optional(),
        description: z.string().optional(),
        owner: z
          .object({
            name: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    /**
     * Open Badges 3.0 — when Credly returns the OB3-formatted credential,
     * the `proof` block lives at the top level alongside `@context`.
     * Detected only — NOT verified in v1.0.
     */
    proof: z.unknown().optional(),
    '@context': z.unknown().optional(),
  })
  .strip();
export type CredlyIssuedBadge = z.infer<typeof CredlyIssuedBadgeSchema>;

export const CredlyIssuedBadgePageSchema = z.object({
  data: z.array(CredlyIssuedBadgeSchema),
  metadata: z
    .object({
      count: z.number().int().nonnegative().optional(),
      current_page: z.number().int().positive().optional(),
      total_pages: z.number().int().nonnegative().optional(),
      per_page: z.number().int().positive().optional(),
    })
    .optional(),
});
export type CredlyIssuedBadgePage = z.infer<typeof CredlyIssuedBadgePageSchema>;

/** Skew window subtracted from `expires_in` so we re-mint before expiry. */
const TOKEN_REFRESH_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const ERROR_DETAIL_MAX_LENGTH = 160;

export interface CredlyClientDeps {
  /**
   * SCRUM-2483: production callers MUST inject the IP-pinned SSRF-guarded fetch
   * (`createSafeProviderFetch()` from `../safe-provider-fetch.js`), never the raw
   * `fetch` global — a rebinding provider host must not reach a private/metadata
   * address. Tests inject a stub.
   */
  fetch: FetchLike;
  /** Returns "now" ms epoch — overridable for deterministic tests. */
  now: () => number;
  /** API base. Defaults to `DEFAULT_CREDLY_API_BASE`. */
  apiBase?: string;
}

export interface CredlyClient {
  /**
   * Returns a non-expired access token. Cached in-memory per issuer; the
   * caller is responsible for persisting the refreshed cache back to
   * `member_integrations` if it wants cross-process reuse.
   */
  getAccessToken(input: {
    clientId: string;
    clientSecret: string;
    scope?: string;
  }): Promise<string>;

  /**
   * List badges issued by the connected organisation, optionally filtered
   * by recipient email. One page per call; callers iterate.
   */
  listIssuedBadges(input: {
    accessToken: string;
    organisationId: string;
    recipientEmail?: string;
    page?: number;
    perPage?: number;
  }): Promise<CredlyIssuedBadgePage>;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

export function createCredlyClient(deps: CredlyClientDeps): CredlyClient {
  const apiBase = trimTrailingSlashes(deps.apiBase ?? DEFAULT_CREDLY_API_BASE);

  // In-memory token cache keyed by client_id.
  const tokenCache = new Map<string, { token: string; expiresAtMs: number }>();
  const tokenRefreshes = new Map<string, Promise<string>>();

  function timeoutSignal(): AbortSignal {
    return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  }

  async function boundedErrorDetail(resp: { text(): Promise<string> }) {
    const raw = await resp.text().catch(() => '');
    if (!raw) return '';
    const redacted = raw
      .replace(/"client_secret"\s*:\s*"[^"]*"/gi, '"client_secret":"[redacted]"')
      .replace(/client_secret=[^&\s"]+/gi, 'client_secret=[redacted]');
    return redacted.slice(0, ERROR_DETAIL_MAX_LENGTH);
  }

  async function throwCredlyHttpError(
    label: string,
    resp: { status: number; text(): Promise<string> },
  ): Promise<never> {
    const detail = await boundedErrorDetail(resp);
    throw new Error(
      detail
        ? `${label}: HTTP ${resp.status}: ${detail}`
        : `${label}: HTTP ${resp.status}`,
    );
  }

  async function getAccessToken({
    clientId,
    clientSecret,
    scope,
  }: {
    clientId: string;
    clientSecret: string;
    scope?: string;
  }): Promise<string> {
    const cached = tokenCache.get(clientId);
    if (cached && deps.now() < cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS) {
      return cached.token;
    }

    const inFlight = tokenRefreshes.get(clientId);
    if (inFlight) return inFlight;

    const refresh = mintAccessToken(clientId, clientSecret, scope);
    tokenRefreshes.set(clientId, refresh);
    try {
      return await refresh;
    } finally {
      tokenRefreshes.delete(clientId);
    }
  }

  async function mintAccessToken(
    clientId: string,
    clientSecret: string,
    scope?: string,
  ): Promise<string> {
    // Credly's documented form: POST /oauth/token with Basic auth + form body.
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    if (scope) body.set('scope', scope);

    const resp = await deps.fetch(`${apiBase}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: timeoutSignal(),
    });
    if (!resp.ok) {
      await throwCredlyHttpError('Credly OAuth token request failed', resp);
    }
    const parsed = CredlyTokenResponseSchema.parse(await resp.json());
    const expiresAtMs = deps.now() + parsed.expires_in * 1000;
    tokenCache.set(clientId, { token: parsed.access_token, expiresAtMs });
    return parsed.access_token;
  }

  async function listIssuedBadges({
    accessToken,
    organisationId,
    recipientEmail,
    page = 1,
    perPage = 50,
  }: {
    accessToken: string;
    organisationId: string;
    recipientEmail?: string;
    page?: number;
    perPage?: number;
  }): Promise<CredlyIssuedBadgePage> {
    const url = new URL(
      `${apiBase}/v1/organizations/${encodeURIComponent(organisationId)}/badges`,
    );
    url.searchParams.set('page[number]', String(page));
    url.searchParams.set('page[size]', String(perPage));
    if (recipientEmail) {
      // Credly's issuer API exposes recipient filtering only as a
      // server-to-server query parameter. We never log the full URL.
      url.searchParams.set('filter[recipient_email]', recipientEmail);
    }

    const resp = await deps.fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: timeoutSignal(),
    });
    if (!resp.ok) {
      await throwCredlyHttpError('Credly issued_badges request failed', resp);
    }
    return CredlyIssuedBadgePageSchema.parse(await resp.json());
  }

  return { getAccessToken, listIssuedBadges };
}

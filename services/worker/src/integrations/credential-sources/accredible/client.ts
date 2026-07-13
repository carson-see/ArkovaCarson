/**
 * Accredible HTTP client — SCRUM-1613 CSI-04C.
 *
 * Accredible uses a static API-key auth model (no OAuth). Per researcher
 * findings (2026-05-28, cited on SCRUM-1600):
 *   - Header: `Authorization: Token token=<KEY>`
 *   - Base URL: `https://api.accredible.com/v1`
 *   - `GET /v1/credentials` supports `recipient.email` filtering + pagination
 *   - Webhook HMAC spec is NOT publicly documented (partnership-time ask)
 *
 * Scope here:
 *   - List issued credentials (filter by recipient_email, paginated)
 *   - Get a single credential by id
 *
 * Out of scope (deferred to v1.1 per PRD §13):
 *   - Cryptographic verification of any signed credential payload.
 *
 * No real HTTP traffic in tests: callers inject a `fetch`-shaped function.
 */
import { z } from 'zod';
import type { FetchLike, FetchResponseLike } from '../types.js';

/** Default Accredible API base. Override per environment via deps. */
export const DEFAULT_ACCREDIBLE_API_BASE = 'https://api.accredible.com/v1';

/**
 * Abort a request after this long so a hung Accredible endpoint cannot block
 * a worker slot indefinitely (SCRUM-1613 review P2.2). Matches the Credly
 * client's bounded-request posture.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Subset of Accredible's credential payload that we currently consume.
 * Tolerant of extra keys via `.passthrough()` so partnership-time payload
 * shape changes do not crash the import pipeline.
 */
export const AccredibleCredentialSchema = z
  .object({
    id: z.union([z.string().min(1), z.number().int().positive()]),
    name: z.string().optional(),
    issued_on: z.string().optional(),
    expired_on: z.string().nullable().optional(),
    public_url: z.string().url().optional(),
    recipient: z
      .object({
        email: z.string().email().optional(),
        name: z.string().optional(),
      })
      .passthrough()
      .optional(),
    group: z
      .object({
        id: z.union([z.string(), z.number()]).optional(),
        name: z.string().optional(),
        organization: z
          .object({
            name: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    /**
     * Some Accredible plans return an OB3/VC-shaped envelope under
     * `credential_data` or as a top-level `proof` block. Detected only —
     * NOT verified in v1.0.
     */
    credential_data: z.unknown().optional(),
    proof: z.unknown().optional(),
  })
  .passthrough();
export type AccredibleCredential = z.infer<typeof AccredibleCredentialSchema>;

export const AccredibleCredentialPageSchema = z.object({
  credentials: z.array(AccredibleCredentialSchema),
  meta: z
    .object({
      total_count: z.number().int().nonnegative().optional(),
      current_page: z.number().int().positive().optional(),
      total_pages: z.number().int().nonnegative().optional(),
      per_page: z.number().int().positive().optional(),
    })
    .passthrough()
    .optional(),
});
export type AccredibleCredentialPage = z.infer<typeof AccredibleCredentialPageSchema>;

export interface AccredibleClientDeps {
  /**
   * SCRUM-2483: production callers MUST inject the IP-pinned SSRF-guarded fetch
   * (`createSafeProviderFetch()` from `../safe-provider-fetch.js`), never the raw
   * `fetch` global — a rebinding provider host must not reach a private/metadata
   * address. Tests inject a stub.
   */
  fetch: FetchLike;
  /** API base. Defaults to `DEFAULT_ACCREDIBLE_API_BASE`. */
  apiBase?: string;
}

export interface AccredibleClient {
  /**
   * List credentials issued by the connected Accredible organisation,
   * optionally filtered by recipient email. One page per call; callers
   * iterate via the `meta` block.
   */
  listIssuedCredentials(input: {
    apiKey: string;
    recipientEmail?: string;
    page?: number;
    perPage?: number;
  }): Promise<AccredibleCredentialPage>;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

/**
 * Parse a JSON response, but first guard the `Content-Type` (SCRUM-1613
 * review P2.3). If a proxy or maintenance page returns HTML with a 2xx
 * status, `resp.json()` would otherwise throw an opaque parse error. We
 * surface a clear, actionable error instead. Tolerates a missing header
 * (Node 20's `fetch` always sets it; some fakes may not).
 */
async function parseJsonResponse(resp: FetchResponseLike): Promise<unknown> {
  const contentType = resp.headers?.get('content-type');
  if (contentType && !/\bapplication\/(?:[\w.+-]+\+)?json\b/i.test(contentType)) {
    throw new Error(
      `Accredible returned a non-JSON response (content-type: ${contentType})`,
    );
  }
  return resp.json();
}

export function createAccredibleClient(deps: AccredibleClientDeps): AccredibleClient {
  const apiBase = trimTrailingSlashes(
    deps.apiBase ?? DEFAULT_ACCREDIBLE_API_BASE,
  );

  async function listIssuedCredentials({
    apiKey,
    recipientEmail,
    page = 1,
    perPage = 50,
  }: {
    apiKey: string;
    recipientEmail?: string;
    page?: number;
    perPage?: number;
  }): Promise<AccredibleCredentialPage> {
    const url = new URL(`${apiBase}/credentials`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('page_size', String(perPage));
    if (recipientEmail) {
      // Accredible's issuer API only exposes recipient filtering as a
      // server-to-server query parameter on this authenticated call. The
      // full URL (which contains the email) is never logged, surfaced to the
      // client, or embedded in a thrown error — PII discipline per
      // CLAUDE.md §1.4/§1.6A (SCRUM-1613 review P2.1).
      url.searchParams.set('recipient.email', recipientEmail);
    }

    const resp = await deps.fetch(url.toString(), {
      method: 'GET',
      headers: {
        // Accredible's published auth header: `Token token=<KEY>`. The
        // key never appears in error messages emitted by this client.
        Authorization: `Token token=${apiKey}`,
        Accept: 'application/json',
      },
      // Bound the request so a hung endpoint can't pin a worker slot (P2.2).
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      // Note: only the status is included — never the URL (which carries the
      // recipient email) and never the api_key.
      throw new Error(
        `Accredible credentials request failed: HTTP ${resp.status}`,
      );
    }
    return AccredibleCredentialPageSchema.parse(await parseJsonResponse(resp));
  }

  return { listIssuedCredentials };
}

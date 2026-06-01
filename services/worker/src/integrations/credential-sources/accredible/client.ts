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
import type { FetchLike } from '../credly/client.js';

/** Default Accredible API base. Override per environment via deps. */
export const DEFAULT_ACCREDIBLE_API_BASE = 'https://api.accredible.com/v1';

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

export function createAccredibleClient(deps: AccredibleClientDeps): AccredibleClient {
  const apiBase = (deps.apiBase ?? DEFAULT_ACCREDIBLE_API_BASE).replace(/\/+$/, '');

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
    });
    if (!resp.ok) {
      throw new Error(
        `Accredible credentials request failed: HTTP ${resp.status}`,
      );
    }
    return AccredibleCredentialPageSchema.parse(await resp.json());
  }

  return { listIssuedCredentials };
}

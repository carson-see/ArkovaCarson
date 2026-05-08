/**
 * SCRUM-1733: REST v2 ↔ MCP parity contract.
 *
 * The MCP edge tools (`services/edge/src/mcp-tools.ts`) and the REST v2
 * handlers (`services/worker/src/api/v2/`) are independent code paths
 * but MUST return identical shapes for equivalent inputs. This file is
 * the single source of truth for those shapes — both sides validate
 * their outputs against the schemas here.
 *
 * Adding a field to a response type means adding it here first. CI
 * tests below assert that v2 REST handlers' return shape conforms;
 * the equivalent edge MCP test (running in the Cloudflare Worker
 * environment) imports `MCP_PARITY_SCHEMAS` from this module and
 * asserts the same.
 *
 * Why a separate file rather than reusing `search.ts`'s local
 * interface: MCP can't import worker-side code (different runtime).
 * This module is pure Zod with no Node-only deps so it's edge-safe.
 */

import { z } from 'zod';

/** Result type union shared by REST v2 search and MCP `search` tool. */
export const SearchResultTypeSchema = z.enum(['org', 'record', 'fingerprint', 'document']);
export type SearchResultType = z.infer<typeof SearchResultTypeSchema>;

/**
 * One search result. `public_id` is nullable at the source-row layer
 * (rows still anchoring or pre-public_id schema) but the API response
 * layer drops null entries — exposed contract is non-null.
 */
export const SearchResultSchema = z.object({
  type: SearchResultTypeSchema,
  public_id: z.string().min(1).max(64),
  score: z.number().min(0).max(1),
  snippet: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type SearchResult = z.infer<typeof SearchResultSchema>;

export const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema),
  next_cursor: z.string().nullable(),
}).strict();

export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/**
 * Verify result for the public_id-keyed verify endpoint and the MCP
 * `verify` tool. Mirrors `services/worker/src/api/verify-anchor.ts`
 * VerifyAnchorResult — strict() enforces no internal-UUID fields leak.
 */
export const VerifyAnchorStatusSchema = z.enum([
  'ACTIVE', 'REVOKED', 'SUPERSEDED', 'EXPIRED', 'PENDING', 'UNKNOWN',
]);
export type VerifyAnchorStatus = z.infer<typeof VerifyAnchorStatusSchema>;

// Codex P2 PR #737: the existing /api/v2/verify handler returns
// network_receipt_id: null and record_uri: null on the not-found path,
// AND returns public success-path fields (fingerprint, public_id, title)
// that aren't internal UUID leaks. The schema must accept those without
// rejecting valid responses, so:
//   1. Optional fields are nullable so handler-emitted null doesn't reject
//   2. Schema is NOT .strict() — the no-internal-UUID rule is enforced at
//      the runtime guard layer (assertNoBannedFields below) which performs
//      a banned-field scan on any depth, rather than via Zod stripping. A
//      strict schema would reject every legitimate verify response.
export const VerifyAnchorResultSchema = z.object({
  verified: z.boolean(),
  status: VerifyAnchorStatusSchema.optional(),
  network_receipt_id: z.string().nullable().optional(),
  anchor_timestamp: z.string().nullable().optional(),
  record_uri: z.string().nullable().optional(),
  credential_type: z.string().nullable().optional(),
  issuer_name: z.string().nullable().optional(),
  jurisdiction: z.string().nullable().optional(),
  error: z.string().optional(),
  // Public-safe fields the v2 verify handler emits on the success path.
  // Listed here so the schema accepts the shape; banned-field protection
  // is via assertNoBannedFields, not via strict.
  public_id: z.string().nullable().optional(),
  fingerprint: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
});

export type VerifyAnchorResult = z.infer<typeof VerifyAnchorResultSchema>;

/** Detail-endpoint shapes — `GET /v2/{type}/{public_id}` and the MCP `get_*` tools. */
export const ResourceDetailSchema = z.object({
  type: SearchResultTypeSchema,
  public_id: z.string().min(1).max(64),
  verified: z.boolean(),
  status: z.string(),
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  credential_type: z.string().nullable().optional(),
  sub_type: z.string().nullable().optional(),
  fingerprint: z.string().nullable().optional(),
  issued_date: z.string().nullable().optional(),
  expiry_date: z.string().nullable().optional(),
  anchor_timestamp: z.string().nullable().optional(),
  network_receipt_id: z.string().nullable().optional(),
  record_uri: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type ResourceDetail = z.infer<typeof ResourceDetailSchema>;

/** Banned at the schema layer — same allowlist semantics as outbound webhooks. */
export const BANNED_RESPONSE_FIELDS = [
  'id',
  'anchor_id',
  'org_id',
  'user_id',
  'agent_id',
  'key_id',
  'endpoint_id',
  'attestation_id',
] as const;

/**
 * Top-level export for both REST v2 and MCP edge tests to import. Each
 * key maps to the schema for that response shape.
 */
export const MCP_PARITY_SCHEMAS = {
  searchResult: SearchResultSchema,
  searchResponse: SearchResponseSchema,
  verifyAnchorResult: VerifyAnchorResultSchema,
  resourceDetail: ResourceDetailSchema,
} as const;

/**
 * Helper: assert no banned field is present anywhere in the response —
 * top level OR nested in objects/arrays at any depth. Both the REST
 * and MCP code paths can call this before returning to make the
 * no-internal-UUID rule a runtime guarantee, not just a hope.
 *
 * CodeRabbit PR #737 review: the original implementation only checked
 * top-level keys, so `{ metadata: { user_id: "..." } }` slipped through.
 * Now walks the full payload graph with cycle protection. Reports the
 * full nested path of every offender in the error.
 */
export function assertNoBannedFields(obj: Record<string, unknown>, where: string): void {
  const bannedSet = new Set<string>(BANNED_RESPONSE_FIELDS);
  const offenders: string[] = [];
  const seen = new WeakSet<object>();

  const visit = (value: unknown, path: string): void => {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value as object)) return;
    seen.add(value as object);

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        visit(value[i], `${path}[${i}]`);
      }
      return;
    }

    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (bannedSet.has(key)) offenders.push(nextPath);
      visit(nested, nextPath);
    }
  };

  visit(obj, '');

  if (offenders.length > 0) {
    const fields = offenders.sort().join(', ');
    throw new Error(
      `[SCRUM-1733 parity] response shape from ${where} contains banned field(s): ${fields}. ` +
      `See services/worker/src/api/v2/mcpParity.ts BANNED_RESPONSE_FIELDS.`,
    );
  }
}

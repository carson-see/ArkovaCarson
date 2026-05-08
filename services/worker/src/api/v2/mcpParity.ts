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

export const VerifyAnchorResultSchema = z.object({
  verified: z.boolean(),
  status: VerifyAnchorStatusSchema.optional(),
  network_receipt_id: z.string().optional(),
  anchor_timestamp: z.string().optional(),
  record_uri: z.string().optional(),
  credential_type: z.string().optional(),
  issuer_name: z.string().optional(),
  jurisdiction: z.string().optional(),
  error: z.string().optional(),
}).strict();

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
 * Helper: assert no banned field is present in the response. Both
 * the REST and MCP code paths can call this before returning to make
 * the no-internal-UUID rule a runtime guarantee, not just a hope.
 */
export function assertNoBannedFields(obj: Record<string, unknown>, where: string): void {
  for (const banned of BANNED_RESPONSE_FIELDS) {
    if (banned in obj) {
      throw new Error(
        `[SCRUM-1733 parity] response shape from ${where} contains banned field "${banned}". ` +
        `See services/worker/src/api/v2/mcpParity.ts BANNED_RESPONSE_FIELDS.`,
      );
    }
  }
}

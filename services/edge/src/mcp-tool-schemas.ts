/**
 * MCP tool-argument Zod registry — MCP-SEC-07 / SCRUM-984.
 *
 * Every MCP tool's argument schema lives here. `mcp-server.ts` references
 * the registry when wiring tools; `validateToolArgs` is the shared
 * boundary validator that returns a structured MCP error envelope on
 * invalid input (no handler ever receives malformed args).
 *
 * Why a dedicated registry:
 *   - Keeps tool shapes discoverable and auditable in one place.
 *   - Tests can import + exercise each schema without spinning up the
 *     server or the MCP SDK.
 *   - A single validator means one consistent error shape across tools.
 *
 * Note: the MCP SDK also runs Zod validation internally; this registry
 * stacks on top to (1) centralise the schemas, and (2) give us an
 * externally-invocable validator for tests, audit pipes, and future
 * non-SDK transports.
 */

import { z } from 'zod';
import { SHA256_HEX_RE } from './mcp-tools';

/** Arkova public-ID pattern — `ARK-<TYPE>-<SUFFIX>`. Kept in lock-step
 *  with mcp-server.ts's inline regex so both enforcement layers stay
 *  aligned. */
export const PUBLIC_ID_RE = /^ARK-[A-Z0-9-]{3,60}$/;

// ── Leaf validators (reusable across tools) ──────────────────────────────
export const publicIdSchema = z
  .string()
  .regex(PUBLIC_ID_RE, 'public_id must match ARK-<TYPE>-<SUFFIX>')
  .max(64);

export const orgPublicIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,100}$/, 'public_id must be a stable organization public identifier')
  .max(100);

export const contentHashSchema = z
  .string()
  .regex(SHA256_HEX_RE, 'content_hash must be 64 hex chars')
  .length(64);

export const freeTextQuerySchema = z.string().min(1).max(500);

// ── Per-tool schemas ─────────────────────────────────────────────────────
export const verifyCredentialSchema = z
  .object({
    public_id: publicIdSchema,
  })
  .strict();

export const searchCredentialsSchema = z
  .object({
    query: freeTextQuerySchema,
    max_results: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export const agentSearchSchema = z
  .object({
    q: freeTextQuerySchema,
    type: z.enum(['all', 'org', 'record', 'fingerprint', 'document']).optional(),
    max_results: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const nessieQuerySchema = z
  .object({
    query: freeTextQuerySchema,
    mode: z.enum(['retrieval', 'context']).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export const anchorDocumentSchema = z
  .object({
    content_hash: contentHashSchema,
    record_type: z.string().max(50).optional(),
    source: z.string().max(50).optional(),
    title: z.string().max(500).optional(),
    source_url: z.string().url().max(2048).optional(),
  })
  .strict();

export const verifyDocumentSchema = z
  .object({
    content_hash: contentHashSchema,
  })
  .strict();

export const verifyBatchSchema = z
  .object({
    public_ids: z.array(publicIdSchema).min(1).max(100),
  })
  .strict();

export const oracleBatchVerifySchema = z
  .object({
    public_ids: z.array(publicIdSchema).min(1).max(25),
  })
  .strict();

export const listAgentsSchema = z.object({}).strict();

export const agentVerifySchema = z
  .object({
    fingerprint: contentHashSchema,
  })
  .strict();

export const agentListOrgsSchema = z.object({}).strict();

export const agentGetAnchorSchema = z
  .object({
    public_id: publicIdSchema,
  })
  .strict();

export const agentGetOrganizationSchema = z
  .object({
    public_id: orgPublicIdSchema,
  })
  .strict();

export const agentGetRecordSchema = z
  .object({
    public_id: publicIdSchema,
  })
  .strict();

export const agentGetFingerprintSchema = z
  .object({
    fingerprint: contentHashSchema,
  })
  .strict();

export const agentGetDocumentSchema = z
  .object({
    public_id: publicIdSchema,
  })
  .strict();

// ── Registry ─────────────────────────────────────────────────────────────
export const MCP_TOOL_SCHEMAS = {
  verify_credential: verifyCredentialSchema,
  search_credentials: searchCredentialsSchema,
  nessie_query: nessieQuerySchema,
  anchor_document: anchorDocumentSchema,
  verify_document: verifyDocumentSchema,
  verify_batch: verifyBatchSchema,
  search: agentSearchSchema,
  verify: agentVerifySchema,
  list_orgs: agentListOrgsSchema,
  get_anchor: agentGetAnchorSchema,
  get_organization: agentGetOrganizationSchema,
  get_record: agentGetRecordSchema,
  get_fingerprint: agentGetFingerprintSchema,
  get_document: agentGetDocumentSchema,
  oracle_batch_verify: oracleBatchVerifySchema,
  list_agents: listAgentsSchema,
} as const;

export type McpToolName = keyof typeof MCP_TOOL_SCHEMAS;

/**
 * Subset of Zod's issue shape we surface to clients. The full `ZodError`
 * contains the invalid values (and sometimes stack traces from async
 * refinements) — we strip those to prevent callers from round-tripping
 * our validator as an oracle for internal state.
 */
export interface McpToolValidationIssue {
  path: string;
  message: string;
}

export interface McpToolValidationError {
  ok: false;
  error: {
    code: 'INVALID_ARGS' | 'UNKNOWN_TOOL';
    tool: string;
    message: string;
    issues: McpToolValidationIssue[];
  };
}

export interface McpToolValidationSuccess<T> {
  ok: true;
  data: T;
}

export type McpToolValidationResult<T = unknown> =
  | McpToolValidationSuccess<T>
  | McpToolValidationError;

/**
 * Validate raw MCP tool arguments against the registry. Returns a
 * discriminated union so callers can pattern-match without try/catch.
 *
 * On invalid input the error issues list contains only `{path,message}`
 * — no received values, no stack traces, no internal schema paths.
 */
export function validateToolArgs<N extends McpToolName>(
  toolName: N,
  rawArgs: unknown,
): McpToolValidationResult<z.infer<(typeof MCP_TOOL_SCHEMAS)[N]>>;
export function validateToolArgs(
  toolName: string,
  rawArgs: unknown,
): McpToolValidationResult<unknown>;
export function validateToolArgs(
  toolName: string,
  rawArgs: unknown,
): McpToolValidationResult<unknown> {
  const schema = (MCP_TOOL_SCHEMAS as Record<string, z.ZodTypeAny>)[toolName];
  if (!schema) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_TOOL',
        tool: toolName,
        message: 'tool is not registered',
        issues: [],
      },
    };
  }

  const parsed = schema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'INVALID_ARGS',
        tool: toolName,
        message: 'tool arguments failed validation',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.map(String).join('.') || '(root)',
          message: i.message,
        })),
      },
    };
  }

  return { ok: true, data: parsed.data };
}

/**
 * Serialise a validation error into the MCP tool-call error envelope
 * (same shape `withTelemetry` returns for rate limits). Tool handlers
 * can return the output directly to the MCP SDK.
 */
export function validationErrorToToolResult(error: McpToolValidationError['error']): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: error.code,
          tool: error.tool,
          message: error.message,
          issues: error.issues,
        }),
      },
    ],
    isError: true,
  };
}

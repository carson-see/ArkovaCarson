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
export const PUBLIC_ORG_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/;

// ── Leaf validators (reusable across tools) ──────────────────────────────
export const publicIdSchema = z
  .string()
  .regex(PUBLIC_ID_RE, 'public_id must match ARK-<TYPE>-<SUFFIX>')
  .max(64);

export const orgPublicIdSchema = z
  .string()
  .regex(PUBLIC_ORG_ID_RE, 'organization public_id is invalid')
  .min(2)
  .max(128);

export const contentHashSchema = z
  .string()
  .regex(SHA256_HEX_RE, 'content_hash must be 64 hex chars')
  .length(64);

export const freeTextQuerySchema = z.string().min(1).max(500);
export const idempotencyKeySchema = z.string().uuid();

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
    limit: z.number().int().min(1).max(50).optional(),
    max_results: z.number().int().min(1).max(50).optional(),
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
    description: z.string().max(1000).optional(),
    source_url: z.string().url().max(2048).optional(),
    action: z.enum(['queue', 'instant']).optional(),
    user_tags: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
    organization_tags: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
    idempotency_key: idempotencyKeySchema.optional(),
  })
  .strict();

export const submissionStatusSchema = z.object({ public_id: publicIdSchema }).strict();

export const importRowsSchema = z.object({
  rows: z.array(z.object({
    fingerprint: contentHashSchema,
    filename: z.string().min(1).max(255),
    fingerprint_provided: z.boolean(),
    file_size: z.number().int().positive().optional(),
    credential_type: z.enum(['DEGREE', 'LICENSE', 'CERTIFICATE', 'TRANSCRIPT', 'PROFESSIONAL', 'CPE', 'CLE', 'BADGE', 'ATTESTATION', 'FINANCIAL', 'LEGAL', 'INSURANCE', 'SEC_FILING', 'PATENT', 'REGULATION', 'PUBLICATION', 'CHARITY', 'ACCREDITATION', 'FINANCIAL_ADVISOR', 'BUSINESS_ENTITY', 'RESUME', 'MEDICAL', 'MILITARY', 'IDENTITY', 'CONTRACT_PRESIGNING', 'CONTRACT_POSTSIGNING', 'OTHER']).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    recipient_email: z.string().email().optional(),
    recipient_name: z.string().max(255).optional(),
  }).strict().superRefine((row, context) => {
    // Mirrors the worker's own superRefine. The worker rejects the WHOLE
    // request for this pair, so catching it locally saves a round trip that
    // can only ever come back 400 (#3034 review).
    if (row.recipient_name && !row.recipient_email) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['recipient_name'],
        message: 'recipient_email is required when recipient_name is provided',
      });
    }
  })).min(1).max(100),
  action: z.enum(['queue', 'instant']),
  description: z.string().max(1000).optional(),
  user_tags: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
  organization_tags: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
}).strict();

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
const agentScopeSchema = z.enum(['read:records','read:orgs','read:search','write:anchors','admin:rules','verify','verify:batch','usage:read','keys:manage','compliance:read','compliance:write','oracle:read','oracle:write','anchor:write','anchor:read','attestations:write','attestations:read','webhooks:manage','agents:manage','keys:read','orgs:manage']);
const httpsUrlSchema = z.string().url().max(2048).refine((value) => new URL(value).protocol === 'https:', 'callback_url must use HTTPS');
export const registerAgentSchema = z.object({
  name: z.string().trim().min(1).max(200), description: z.string().max(1000).optional(),
  agent_type: z.enum(['llm_agent','ats_integration','hr_platform','compliance_tool','custom']).optional(),
  allowed_scopes: z.array(agentScopeSchema).min(1).max(32).optional(), framework: z.string().max(100).optional(),
  version: z.string().max(50).optional(), callback_url: httpsUrlSchema.optional(), metadata: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((value, ctx) => { if (value.metadata && Object.prototype.hasOwnProperty.call(value.metadata, 'computeid')) ctx.addIssue({ code: 'custom', path: ['metadata','computeid'], message: 'metadata.computeid is provider-managed' }); });
export const agentIdSchema = z.object({ agent_id: z.string().uuid() }).strict();
export const updateAgentSchema = z.object({ agent_id: z.string().uuid(), name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(1000).optional(), allowed_scopes: z.array(agentScopeSchema).min(1).max(32).optional(),
  status: z.enum(['active','suspended']).optional(), framework: z.string().max(100).optional(), version: z.string().max(50).optional(),
  callback_url: httpsUrlSchema.nullable().optional(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== 'agent_id'), 'at least one update field is required');
export const computeIdAdmissionSchema = z.object({
  passport_id: z.string().uuid(), name: z.string().trim().min(1).max(200).optional(), description: z.string().max(1000).optional(),
  allowed_scopes: z.array(z.enum(['verify','verify:batch','anchor:write','write:anchors','anchor:read','read:records','read:search'])).min(1).max(32).optional(),
  verification_receipt: z.object({ passport_id: z.string().uuid(), status: z.string().min(1).max(32), signature_valid: z.boolean().nullable().optional(),
    issued_at: z.string().min(1).max(100).refine((value) => Number.isFinite(Date.parse(value)), 'issued_at must be a timestamp'),
    expires_at: z.string().min(1).max(100).refine((value) => Number.isFinite(Date.parse(value)), 'expires_at must be a timestamp'), key_id: z.string().regex(/^[a-f0-9]{16}$/),
    receipt_signature: z.string().min(1).max(4096), receipt_algorithm: z.string().min(1).max(32), receipt_payload: z.string().min(2).max(16384),
  }).catchall(z.unknown()),
}).strict().refine((value) => value.passport_id === value.verification_receipt.passport_id, { path: ['verification_receipt','passport_id'], message: 'passport IDs must match' });

export const manageFoldersSchema = z.object({
  action: z.enum(['list', 'create', 'update', 'bind_connector', 'delete', 'bulk_move']),
  folder_id: z.string().uuid().optional(),
  owner_scope: z.enum(['USER', 'ORG']).optional(),
  owner_user_id: z.string().uuid().optional(),
  org_id: z.string().uuid().optional(),
  context_org_id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(100).optional(),
  parent_folder_id: z.string().uuid().nullable().optional(),
  provider: z.enum(['google_drive', 'docusign']).nullable().optional(),
  source_id: z.string().trim().min(1).max(500).nullable().optional(),
  connection_id: z.string().uuid().nullable().optional(),
  anchor_ids: z.array(z.string().uuid()).min(1).max(100).optional(),
  record_public_ids: z.array(z.string().regex(/^ARK-[A-Za-z0-9][A-Za-z0-9_-]{0,123}$/)).min(1).max(100).optional(),
}).strict().superRefine((value, ctx) => {
  if (['update', 'bind_connector', 'delete'].includes(value.action) && !value.folder_id) {
    ctx.addIssue({ code: 'custom', path: ['folder_id'], message: 'folder_id is required for this action' });
  }
  if (value.action === 'create' && (!value.name || !value.owner_scope)) {
    ctx.addIssue({ code: 'custom', path: ['name'], message: 'name and owner_scope are required for create' });
  }
  if (value.action === 'bulk_move' && Number(!!value.anchor_ids) + Number(!!value.record_public_ids) !== 1) {
    ctx.addIssue({ code: 'custom', path: ['record_public_ids'], message: 'exactly one record id list is required for bulk_move' });
  }
  if (value.action === 'bind_connector' && value.provider && (!value.source_id || !value.connection_id)) {
    ctx.addIssue({ code: 'custom', path: ['provider'], message: 'provider, source_id, and connection_id must all be set' });
  }
});

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

export const agentGetRecordSchema = agentGetAnchorSchema;

export const agentGetFingerprintSchema = z
  .object({
    fingerprint: contentHashSchema,
  })
  .strict();

export const agentGetDocumentSchema = agentGetAnchorSchema;

export const listAnchorsSchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  tag: z.string().min(1).max(64).optional(),
  tag_scope: z.enum(['user', 'organization']).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).optional(),
}).strict().refine((value) => (value.tag === undefined) === (value.tag_scope === undefined), {
  message: 'tag and tag_scope must be provided together', path: ['tag'],
});

// ── Registry ─────────────────────────────────────────────────────────────
export const MCP_TOOL_SCHEMAS = {
  arkova_verify_anchor: verifyCredentialSchema,
  arkova_search_anchors: searchCredentialsSchema,
  arkova_list_anchors: listAnchorsSchema,
  nessie_query: nessieQuerySchema,
  arkova_anchor_document: anchorDocumentSchema,
  arkova_get_submission_status: submissionStatusSchema,
  arkova_import_rows: importRowsSchema,
  arkova_verify_document: verifyDocumentSchema,
  arkova_verify_batch: verifyBatchSchema,
  arkova_search: agentSearchSchema,
  arkova_verify: agentVerifySchema,
  arkova_list_orgs: agentListOrgsSchema,
  arkova_get_anchor: agentGetAnchorSchema,
  arkova_get_organization: agentGetOrganizationSchema,
  arkova_get_record: agentGetRecordSchema,
  arkova_get_fingerprint: agentGetFingerprintSchema,
  arkova_get_document: agentGetDocumentSchema,
  arkova_oracle_batch_verify: oracleBatchVerifySchema,
  arkova_list_agents: listAgentsSchema,
  arkova_register_agent: registerAgentSchema,
  arkova_get_agent: agentIdSchema,
  arkova_update_agent: updateAgentSchema,
  arkova_revoke_agent: agentIdSchema,
  arkova_create_agent_key: agentIdSchema,
  arkova_admit_computeid_agent: computeIdAdmissionSchema,
  arkova_manage_folders: manageFoldersSchema,
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

/**
 * Arkova MCP Server — Model Context Protocol tools for record verification
 *
 * Exposes Arkova verification as MCP tools usable by Claude, OpenAI, Cursor,
 * and any MCP-compatible LLM client.
 *
 * Tools (all prefixed with arkova_ for namespace consistency — DX-04):
 *   - arkova_verify_anchor: Verify an anchored record by public ID
 *   - arkova_anchor_status: Get anchor status and proof details
 *   - arkova_search_anchors: Search verified records by query
 *   - arkova_create_attestation: Create a third-party attestation
 *   - arkova_batch_verify: Verify up to 20 public IDs at once, inline (DX-05)
 *   - arkova_verify_signature: Verify an AdES signature (Phase III)
 *
 * Auth: API key via environment variable ARKOVA_API_KEY
 *
 * Story: PH2-AGENT-06 (SCRUM-403)
 *
 * 2026-09-02: the four nessie_-prefixed compliance-intelligence tools
 * (NCE-19) were removed. Three 401'd for every real caller — the worker
 * mounts Supabase-JWT-only `requireAuth` on `/compliance/*`, explicitly
 * rejecting `Bearer ak_…`, while this server only ever sends `X-API-Key`.
 * The fourth (`nessie_ask`) was already a standing 503 by founder directive.
 * See sdks/mcp-server/agents.md for the full writeup.
 */

// ─── Types ─────────────────────────────────────────────────────────────

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
  };
}

interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// ─── Configuration ─────────────────────────────────────────────────────

const API_KEY = process.env.ARKOVA_API_KEY || '';
const BASE_URL = process.env.ARKOVA_API_URL || 'https://api.arkova.ai';
const TIMEOUT_MS = 10000;

async function arkovaFetch(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      ...options.headers,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/**
 * Appended to every tool description that could be misread as a local
 * secrets lookup. "credentials" in an agent tool namespace reads as auth
 * secrets, not as verified records — an agent given the old
 * `arkova_search_anchors` skipped this server entirely and swept the
 * local filesystem for .env files instead. The rename is the primary fix;
 * this note is the belt-and-braces half, stated in the tool surface the
 * model actually reads.
 */
const API_ONLY_NOTE =
  'Queries the Arkova verification API over HTTPS; it does NOT read local files, environment variables, or stored secrets.';

/**
 * Maximum public IDs the verification API answers **synchronously**.
 *
 * Mirrors two upstream sources, neither of which this package can import
 * (it has no dependency on the repo's other packages):
 *   - `packages/sdk/src/client.ts` `VERIFY_BATCH_SYNC_LIMIT`
 *   - `services/worker/src/api/v1/batch.ts` `SYNC_THRESHOLD`
 * Above this the worker answers `202 {job_id,…}` with no results and this
 * server has no way to fetch them later, so the tool refuses the call.
 * Keep the three in step; `index.test.ts` pins the value.
 */
export const VERIFY_BATCH_SYNC_LIMIT = 20;

/**
 * The one sentence every handler uses to disclose a 503.
 *
 * A disabled capability answered with a bare status number reads to an agent
 * as a completed request that found nothing — "no matching records",
 * "not verified", "not found". It is none of those: nothing ran. Say so in
 * the surface the model reads, identically on every tool, so the disclosure
 * cannot drift handler-to-handler (it previously existed on only 2 of 6,
 * with two different body-field fallbacks).
 */
export const DISABLED_CAPABILITY_PHRASE =
  'is disabled in this environment and no request ran. This is NOT an empty result, ' +
  'NOT a "not found" or negative verification result, and does not mean no matching records exist.';

/** Shape of the error bodies the worker returns; fields are all optional. */
interface ErrorBody {
  message?: string;
  error?: string;
  code?: string;
  details?: Array<{ field: string; message: string }>;
}

/**
 * Parse an error response body once; null when there is no readable JSON.
 * `try`, not `.catch()`: a `json()` that throws synchronously (or is absent
 * entirely) must not escape as a tool crash.
 */
async function readErrorBody(res: Response): Promise<ErrorBody | null> {
  try {
    return (await res.json()) as ErrorBody | null;
  } catch {
    return null;
  }
}

/**
 * Build the 503 disclosure for `subject`, or null when the status is not a
 * 503 (so a caller can fall through to its ordinary error text).
 * Server detail resolves `message ?? error ?? code`.
 */
function disabledCapabilityMessage(
  status: number,
  body: ErrorBody | null,
  subject: string,
): string | null {
  if (status !== 503) return null;
  const detail = body?.message ?? body?.error ?? body?.code ?? 'service_unavailable';
  return `${subject} ${DISABLED_CAPABILITY_PHRASE} Server detail: ${detail}`;
}

// ─── Tool Definitions ──────────────────────────────────────────────────

export const TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: 'arkova_verify_anchor',
    description: 'Verify an anchored record on the Arkova network by its public ID. Returns the verification result including issuer, record type, and anchor proof. ' + API_ONLY_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        public_id: {
          type: 'string',
          description: "The record's public ID (e.g., ARK-UMICH-DOC-A1B2C3)",
        },
      },
      required: ['public_id'],
    },
  },
  {
    name: 'arkova_anchor_status',
    description: 'Get the current anchor status and proof details for an anchored record on Arkova, including network anchor information and timestamp. ' + API_ONLY_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        public_id: {
          type: 'string',
          description: "The record's public ID",
        },
      },
      required: ['public_id'],
    },
  },
  {
    name: 'arkova_search_anchors',
    description: 'Search the Arkova public registry of anchored records by subject name, issuing institution, or record type. Returns matching public records. ' + API_ONLY_NOTE + ' It does not search the local filesystem and never returns API keys or authentication secrets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query — name, institution, or record type',
        },
        limit: {
          type: 'string',
          description: 'Maximum results to return (1-20, default 5)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'arkova_create_attestation',
    description: 'Create a third-party attestation that a record or entity has been verified. Any authenticated API key may create one — this does not require organization admin privileges.',
    inputSchema: {
      type: 'object',
      properties: {
        attestation_type: {
          type: 'string',
          description: 'Type of attestation',
          enum: ['VERIFICATION', 'ENDORSEMENT', 'AUDIT', 'APPROVAL', 'WITNESS', 'COMPLIANCE', 'SUPPLY_CHAIN', 'IDENTITY', 'CUSTOM'],
        },
        subject_identifier: {
          type: 'string',
          description: 'The entity being attested (public ID, name, or identifier)',
        },
        attester_name: {
          type: 'string',
          description: 'Name of the attester — the person or entity making this attestation',
        },
        claims: {
          type: 'string',
          description: 'JSON array of at least one claim object, e.g. [{"claim":"Employed 2020-2024","evidence":"HR letter"}]',
        },
        summary: {
          type: 'string',
          description: 'Brief summary of the attestation',
        },
      },
      required: ['attestation_type', 'subject_identifier', 'attester_name', 'claims', 'summary'],
    },
  },
  {
    name: 'arkova_batch_verify',
    description: `Verify up to ${VERIFY_BATCH_SYNC_LIMIT} public IDs at once; results returned inline in a single response.`,
    inputSchema: {
      type: 'object',
      properties: {
        public_ids: {
          type: 'string',
          // No `maxItems` here: the wire encoding is a JSON *string* (the
          // args shape is Record<string, string>), so the array-only JSON
          // Schema keyword never applied and no client could enforce it.
          // handleBatchVerify's runtime cap is the real one.
          description: `JSON array of up to ${VERIFY_BATCH_SYNC_LIMIT} public IDs to verify`,
        },
      },
      required: ['public_ids'],
    },
  },
  {
    name: 'arkova_verify_signature',
    description: 'Verify an AdES electronic signature\'s validity, certificate chain, timestamp token, and eIDAS compliance. Phase III feature.',
    inputSchema: {
      type: 'object',
      properties: {
        signature_id: {
          type: 'string',
          description: 'The signature public ID (e.g., ARK-ACME-SIG-X7Y8Z9)',
        },
      },
      required: ['signature_id'],
    },
  },
];

// ─── Tool Handlers ─────────────────────────────────────────────────────

export async function handleToolCall(
  name: string,
  args: Record<string, string>,
): Promise<McpToolResult> {
  try {
    switch (name) {
      case 'arkova_verify_anchor':
        return await handleVerifyCredential(args.public_id);
      case 'arkova_anchor_status':
        return await handleGetCredentialStatus(args.public_id);
      case 'arkova_search_anchors':
        return await handleSearchCredentials(args.query, parseLimit(args.limit));
      case 'arkova_create_attestation':
        return await handleCreateAttestation(args);
      case 'arkova_batch_verify':
        return await handleBatchVerify(args.public_ids);
      case 'arkova_verify_signature':
        return await handleVerifySignature(args.signature_id);
      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : 'Unknown error');
  }
}

/**
 * F10 — `parseInt(args.limit || '5', 10)` yields NaN on non-numeric input
 * (e.g. `limit: 'abc'`), which was then sent to the API as literal
 * `limit=NaN`. Guard with Number.isFinite and fall back to the same
 * default of 5 the tool description advertises.
 */
function parseLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) ? parsed : 5;
}

async function handleVerifyCredential(publicId: string): Promise<McpToolResult> {
  const res = await arkovaFetch(`/api/v1/verify/${encodeURIComponent(publicId)}`);
  if (!res.ok) {
    if (res.status === 404) return textResult('Record not found. The public ID may be incorrect.');
    const disabled = disabledCapabilityMessage(res.status, await readErrorBody(res), 'Record verification');
    if (disabled) return errorResult(disabled);
    return errorResult(`Verification API returned ${res.status}`);
  }
  const data = await res.json();
  return textResult(JSON.stringify(data, null, 2));
}

async function handleGetCredentialStatus(publicId: string): Promise<McpToolResult> {
  const res = await arkovaFetch(`/api/v1/verify/${encodeURIComponent(publicId)}`);
  if (!res.ok) {
    const disabled = disabledCapabilityMessage(res.status, await readErrorBody(res), 'Anchor status lookup');
    if (disabled) return errorResult(disabled);
    return errorResult(`API returned ${res.status}`);
  }
  const data = await res.json();
  return textResult(JSON.stringify(data, null, 2));
}

/**
 * F3 — the worker answers a disabled semantic-search capability with a 503
 * (`{"error":"service_unavailable","message":"Semantic search is not
 * currently enabled"}`). Swallowing that into a bare "returned 503" leaves
 * an agent guessing whether the search ran and found nothing, or didn't run
 * at all. Mirror the disclosure pattern used for the (now-removed)
 * nessie_ask 503 path: say in words that the capability is off in this
 * environment, that this is NOT an empty/negative result, and include the
 * server's own message.
 */
async function handleSearchCredentials(query: string, limit: number): Promise<McpToolResult> {
  const safeLimit = Math.min(Math.max(limit, 1), 20);
  const res = await arkovaFetch(`/api/v1/verify/search?q=${encodeURIComponent(query)}&limit=${safeLimit}`);
  if (!res.ok) {
    const disabled = disabledCapabilityMessage(res.status, await readErrorBody(res), 'Search');
    if (disabled) return errorResult(disabled);
    return errorResult(`Search API returned ${res.status}`);
  }
  const data = await res.json();
  return textResult(JSON.stringify(data, null, 2));
}

/**
 * F2/F11/F12 — the worker's CreateAttestationSchema
 * (services/worker/src/api/v1/attestations.ts) requires `attester_name`
 * (min length 1) and a non-empty `claims` array; without them every call
 * 400s. Both are now required inputs and passed through. On a validation
 * failure the worker returns `{error:'validation_error', details:[{field,
 * message}]}` — surface that `details` array so a caller can tell exactly
 * which field is wrong instead of a bare "API returned 400".
 */
async function handleCreateAttestation(args: Record<string, string>): Promise<McpToolResult> {
  let claims: unknown;
  try {
    claims = JSON.parse(args.claims);
  } catch {
    return errorResult('Invalid JSON for claims. Provide a JSON array of claim objects, e.g. [{"claim":"..."}].');
  }
  if (!Array.isArray(claims) || claims.length === 0) {
    return errorResult('claims must be a non-empty JSON array of claim objects.');
  }

  const res = await arkovaFetch('/api/v1/attestations', {
    method: 'POST',
    body: JSON.stringify({
      attestation_type: args.attestation_type,
      subject_identifier: args.subject_identifier,
      attester_name: args.attester_name,
      claims,
      summary: args.summary,
    }),
  });
  if (!res.ok) {
    const err = await readErrorBody(res);
    const disabled = disabledCapabilityMessage(res.status, err, 'Attestation creation');
    if (disabled) return errorResult(disabled);
    const detailText = Array.isArray(err?.details) && err.details.length > 0
      ? ` Details: ${err.details.map((d) => `${d.field}: ${d.message}`).join('; ')}`
      : '';
    return errorResult((err?.error || `API returned ${res.status}`) + detailText);
  }
  const data = await res.json();
  return textResult(JSON.stringify(data, null, 2));
}

async function handleVerifySignature(signatureId: string): Promise<McpToolResult> {
  const res = await arkovaFetch('/api/v1/verify-signature', {
    method: 'POST',
    body: JSON.stringify({ signature_id: signatureId }),
  });
  if (!res.ok) {
    if (res.status === 404) return textResult('Signature not found.');
    const disabled = disabledCapabilityMessage(res.status, await readErrorBody(res), 'Signature verification');
    if (disabled) return errorResult(disabled);
    return errorResult(`Signature verification API returned ${res.status}`);
  }
  const data = await res.json();
  return textResult(JSON.stringify(data, null, 2));
}

/**
 * D6/F7 — the worker's SYNC_THRESHOLD is VERIFY_BATCH_SYNC_LIMIT; a batch above that returns
 * `202 {job_id,…}` with no results and this tool has no way to fetch them
 * later. Cap the tool's own limit at 20 so every call this tool accepts
 * returns results inline.
 */
async function handleBatchVerify(publicIdsJson: string): Promise<McpToolResult> {
  let publicIds: string[];
  try {
    publicIds = JSON.parse(publicIdsJson);
  } catch {
    return errorResult('Invalid JSON. Provide a JSON array of public IDs.');
  }
  if (!Array.isArray(publicIds) || publicIds.length === 0) {
    return errorResult('Input must be a non-empty JSON array of public IDs.');
  }
  if (publicIds.length > VERIFY_BATCH_SYNC_LIMIT) {
    return errorResult(
      `Maximum ${VERIFY_BATCH_SYNC_LIMIT} public IDs per batch. The Arkova API processes larger batches ` +
      'asynchronously (202 + job_id) and this tool has no way to fetch results from that job — split into ' +
      `batches of ${VERIFY_BATCH_SYNC_LIMIT} or fewer.`,
    );
  }

  const res = await arkovaFetch('/api/v1/verify/batch', {
    method: 'POST',
    body: JSON.stringify({ public_ids: publicIds }),
  });
  if (!res.ok) {
    const disabled = disabledCapabilityMessage(res.status, await readErrorBody(res), 'Batch verification');
    if (disabled) return errorResult(disabled);
    return errorResult(`Batch verify API returned ${res.status}`);
  }
  const data = await res.json();
  return textResult(JSON.stringify(data, null, 2));
}

// ─── Helpers ───────────────────────────────────────────────────────────

function textResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string): McpToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

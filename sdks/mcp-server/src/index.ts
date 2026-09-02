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
    properties: Record<string, { type: string; description: string; enum?: string[]; maxItems?: number }>;
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
    description: 'Verify up to 20 public IDs at once; results returned inline in a single response.',
    inputSchema: {
      type: 'object',
      properties: {
        public_ids: {
          type: 'string',
          description: 'JSON array of up to 20 public IDs to verify',
          maxItems: 20,
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
    return errorResult(`Verification API returned ${res.status}`);
  }
  const data = await res.json();
  return textResult(JSON.stringify(data, null, 2));
}

async function handleGetCredentialStatus(publicId: string): Promise<McpToolResult> {
  const res = await arkovaFetch(`/api/v1/verify/${encodeURIComponent(publicId)}`);
  if (!res.ok) return errorResult(`API returned ${res.status}`);
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
    if (res.status === 503) {
      const body = await res.json().catch(() => null) as { message?: string; error?: string } | null;
      return errorResult(
        'Search is disabled in this environment and no search ran. This is NOT an empty result — ' +
        'it does not mean "no matching records exist". ' +
        `Server detail: ${body?.message ?? body?.error ?? 'service_unavailable'}`,
      );
    }
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
    const err = await res.json().catch(() => ({})) as { error?: string; details?: Array<{ field: string; message: string }> };
    const detailText = Array.isArray(err.details) && err.details.length > 0
      ? ` Details: ${err.details.map((d) => `${d.field}: ${d.message}`).join('; ')}`
      : '';
    return errorResult((err.error || `API returned ${res.status}`) + detailText);
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
    if (res.status === 503) {
      const body = await res.json().catch(() => null) as { message?: string; code?: string } | null;
      return errorResult(
        'Signature verification is disabled in this environment and no check ran. This is NOT a ' +
        '"not found" or negative verification result. ' +
        `Server detail: ${body?.message ?? body?.code ?? 'service_unavailable'}`,
      );
    }
    return errorResult(`Signature verification API returned ${res.status}`);
  }
  const data = await res.json();
  return textResult(JSON.stringify(data, null, 2));
}

/**
 * D6/F7 — the worker's SYNC_THRESHOLD is 20; a batch above that returns
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
  if (publicIds.length > 20) {
    return errorResult(
      'Maximum 20 public IDs per batch. The Arkova API processes larger batches asynchronously ' +
      '(202 + job_id) and this tool has no way to fetch results from that job — split into batches of 20 or fewer.',
    );
  }

  const res = await arkovaFetch('/api/v1/verify/batch', {
    method: 'POST',
    body: JSON.stringify({ public_ids: publicIds }),
  });
  if (!res.ok) return errorResult(`Batch verify API returned ${res.status}`);
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

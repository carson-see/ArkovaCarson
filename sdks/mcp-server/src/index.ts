/**
 * Arkova MCP Server — Model Context Protocol tools for credential verification
 *
 * Exposes Arkova verification as MCP tools usable by Claude, OpenAI, Cursor,
 * and any MCP-compatible LLM client.
 *
 * Tools (all prefixed with arkova_ for namespace consistency — DX-04):
 *   - arkova_verify_credential: Verify a credential by public ID or fingerprint
 *   - arkova_credential_status: Get anchor status and proof details
 *   - arkova_search_credentials: Search verified credentials by query
 *   - arkova_create_attestation: Create a third-party attestation
 *   - arkova_batch_verify: Verify multiple credentials at once (DX-05)
 *   - arkova_verify_signature: Verify an AdES signature (Phase III)
 *
 * Auth: API key via environment variable ARKOVA_API_KEY
 *
 * Story: PH2-AGENT-06 (SCRUM-403)
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

// ─── Tool Definitions ──────────────────────────────────────────────────

export const TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: 'arkova_verify_credential',
    description: 'Verify a credential\'s authenticity and Bitcoin anchor status on Arkova. Returns verification result including issuer, credential type, and anchor proof.',
    inputSchema: {
      type: 'object',
      properties: {
        public_id: {
          type: 'string',
          description: 'The credential public ID (e.g., ARK-UMICH-DOC-A1B2C3) or document fingerprint (sha256:...)',
        },
      },
      required: ['public_id'],
    },
  },
  {
    name: 'arkova_credential_status',
    description: 'Get the current status and proof details of a credential, including Bitcoin anchor information and timestamp.',
    inputSchema: {
      type: 'object',
      properties: {
        public_id: {
          type: 'string',
          description: 'The credential public ID',
        },
      },
      required: ['public_id'],
    },
  },
  {
    name: 'arkova_search_credentials',
    description: 'Search for verified credentials by name, institution, credential type, or other metadata. Returns matching public records.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query — name, institution, or credential type',
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
    description: 'Create a third-party attestation that a credential or entity has been verified. Requires organization admin privileges.',
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
        summary: {
          type: 'string',
          description: 'Brief summary of the attestation',
        },
      },
      required: ['attestation_type', 'subject_identifier', 'summary'],
    },
  },
  {
    name: 'arkova_batch_verify',
    description: 'Verify multiple credentials at once by providing an array of public IDs. Returns verification results for each credential in a single response.',
    inputSchema: {
      type: 'object',
      properties: {
        public_ids: {
          type: 'string',
          description: 'JSON array of credential public IDs to verify (max 100)',
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
      case 'arkova_verify_credential':
        return await handleVerifyCredential(args.public_id);
      case 'arkova_credential_status':
        return await handleGetCredentialStatus(args.public_id);
      case 'arkova_search_credentials':
        return await handleSearchCredentials(args.query, parseInt(args.limit || '5', 10));
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

async function handleVerifyCredential(publicId: string): Promise<McpToolResult> {
  const res = await arkovaFetch(`/api/v1/verify/${encodeURIComponent(publicId)}`);
  if (!res.ok) {
    if (res.status === 404) return textResult('Credential not found. The public ID may be incorrect.');
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

async function handleSearchCredentials(query: string, limit: number): Promise<McpToolResult> {
  const safeLimit = Math.min(Math.max(limit, 1), 20);
  const res = await arkovaFetch(`/api/v1/verify/search?q=${encodeURIComponent(query)}&limit=${safeLimit}`);
  if (!res.ok) return errorResult(`Search API returned ${res.status}`);
  const data = await res.json();
  return textResult(JSON.stringify(data, null, 2));
}

async function handleCreateAttestation(args: Record<string, string>): Promise<McpToolResult> {
  const res = await arkovaFetch('/api/v1/attestations', {
    method: 'POST',
    body: JSON.stringify({
      attestation_type: args.attestation_type,
      subject_identifier: args.subject_identifier,
      summary: args.summary,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return errorResult((err as any).error || `API returned ${res.status}`);
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
    return errorResult(`Signature verification API returned ${res.status}`);
  }
  const data = await res.json();
  return textResult(JSON.stringify(data, null, 2));
}

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
  if (publicIds.length > 100) {
    return errorResult('Maximum 100 credentials per batch.');
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

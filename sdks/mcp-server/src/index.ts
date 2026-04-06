/**
 * Arkova MCP Server — Model Context Protocol tools for credential verification
 *
 * Exposes Arkova verification as MCP tools usable by Claude, OpenAI, Cursor,
 * and any MCP-compatible LLM client.
 *
 * Tools:
 *   - verify_credential: Verify a credential by public ID or fingerprint
 *   - get_credential_status: Get anchor status and proof details
 *   - search_credentials: Search verified credentials by query
 *   - create_attestation: Create a third-party attestation
 *   - verify_signature: Verify an AdES signature (Phase III)
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
    name: 'verify_credential',
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
    name: 'get_credential_status',
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
    name: 'search_credentials',
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
    name: 'create_attestation',
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
    name: 'verify_signature',
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
      case 'verify_credential':
        return await handleVerifyCredential(args.public_id);
      case 'get_credential_status':
        return await handleGetCredentialStatus(args.public_id);
      case 'search_credentials':
        return await handleSearchCredentials(args.query, parseInt(args.limit || '5', 10));
      case 'create_attestation':
        return await handleCreateAttestation(args);
      case 'verify_signature':
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

// ─── Helpers ───────────────────────────────────────────────────────────

function textResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(message: string): McpToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

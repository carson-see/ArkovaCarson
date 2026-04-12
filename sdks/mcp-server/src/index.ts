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
  // ─── Nessie Compliance Intelligence (NCE-19) ───
  {
    name: 'nessie_compliance_score',
    description: 'Get the compliance score for an organization in a specific jurisdiction and industry. Returns score (0-100), grade (A-F), present/missing documents, and recommendations.',
    inputSchema: {
      type: 'object',
      properties: {
        jurisdiction: {
          type: 'string',
          description: 'Jurisdiction code (e.g., US-CA, US-NY, US-TX)',
        },
        industry: {
          type: 'string',
          description: 'Industry code (e.g., accounting, legal, nursing)',
        },
      },
      required: ['jurisdiction', 'industry'],
    },
  },
  {
    name: 'nessie_gap_analysis',
    description: 'Identify missing required and recommended documents for compliance in a given jurisdiction and industry. Returns prioritized gaps with regulatory citations.',
    inputSchema: {
      type: 'object',
      properties: {
        jurisdiction: {
          type: 'string',
          description: 'Jurisdiction code (e.g., US-CA, US-NY)',
        },
        industry: {
          type: 'string',
          description: 'Industry code (e.g., accounting, legal)',
        },
      },
      required: ['jurisdiction', 'industry'],
    },
  },
  {
    name: 'nessie_ask',
    description: 'Ask Nessie a compliance question. Returns an analysis with citations to anchored source documents. Supports compliance_qa, risk_analysis, and recommendation task types.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The compliance question to ask Nessie',
        },
        task: {
          type: 'string',
          description: 'Task type: compliance_qa, risk_analysis, or recommendation',
          enum: ['compliance_qa', 'risk_analysis', 'recommendation'],
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'nessie_cross_reference',
    description: 'Cross-reference multiple documents to find inconsistencies (name mismatches, duplicate credentials, jurisdiction conflicts). Provide anchor IDs to compare.',
    inputSchema: {
      type: 'object',
      properties: {
        anchor_ids: {
          type: 'string',
          description: 'JSON array of anchor UUIDs to cross-reference (min 2, max 100)',
        },
      },
      required: ['anchor_ids'],
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
      case 'nessie_compliance_score':
        return await handleNessieComplianceScore(args.jurisdiction, args.industry);
      case 'nessie_gap_analysis':
        return await handleNessieGapAnalysis(args.jurisdiction, args.industry);
      case 'nessie_ask':
        return await handleNessieAsk(args.query, args.task);
      case 'nessie_cross_reference':
        return await handleNessieCrossReference(args.anchor_ids);
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

// ─── Nessie Compliance Handlers (NCE-19) ──────────────────────────────

async function handleNessieComplianceScore(jurisdiction: string, industry: string): Promise<McpToolResult> {
  const params = new URLSearchParams({ jurisdiction, industry });
  const res = await arkovaFetch(`/api/v1/compliance/score?${params}`);
  if (!res.ok) {
    if (res.status === 404) return textResult(`No compliance rules found for ${jurisdiction} / ${industry}.`);
    return errorResult(`Compliance score API returned ${res.status}`);
  }
  const data = await res.json();
  return textResult(JSON.stringify(data, null, 2));
}

async function handleNessieGapAnalysis(jurisdiction: string, industry: string): Promise<McpToolResult> {
  const res = await arkovaFetch('/api/v1/compliance/gap-analysis', {
    method: 'POST',
    body: JSON.stringify({ jurisdiction, industry }),
  });
  if (!res.ok) {
    if (res.status === 404) return textResult(`No compliance rules found for ${jurisdiction} / ${industry}.`);
    return errorResult(`Gap analysis API returned ${res.status}`);
  }
  const data = await res.json();
  return textResult(JSON.stringify(data, null, 2));
}

async function handleNessieAsk(query: string, task?: string): Promise<McpToolResult> {
  const params = new URLSearchParams({
    q: query,
    mode: 'context',
    ...(task && { task }),
    limit: '10',
  });
  const res = await arkovaFetch(`/api/v1/nessie/query?${params}`);
  if (!res.ok) return errorResult(`Nessie query API returned ${res.status}`);
  const data = await res.json();
  return textResult(JSON.stringify(data, null, 2));
}

async function handleNessieCrossReference(anchorIdsJson: string): Promise<McpToolResult> {
  let anchorIds: string[];
  try {
    anchorIds = JSON.parse(anchorIdsJson);
  } catch {
    return errorResult('Invalid JSON. Provide a JSON array of anchor UUIDs.');
  }
  if (!Array.isArray(anchorIds) || anchorIds.length < 2) {
    return errorResult('Minimum 2 anchor IDs required for cross-reference.');
  }
  const res = await arkovaFetch('/api/v1/compliance/cross-reference', {
    method: 'POST',
    body: JSON.stringify({ anchor_ids: anchorIds }),
  });
  if (!res.ok) return errorResult(`Cross-reference API returned ${res.status}`);
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

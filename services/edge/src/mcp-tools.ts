/**
 * Arkova MCP Tool Definitions and Handlers (P8-S19 + PH1-SDK-03 + INT-02)
 *
 * Shared logic for MCP server tools. Used by both the Cloudflare Worker
 * MCP endpoint and tests.
 *
 * Tools:
 *   - verify_credential: Verify a credential by public ID
 *   - search_credentials: Semantic search across credentials
 *   - nessie_query:      RAG query with verified citations (PH1-SDK-03)
 *   - anchor_document:   Anchor a document hash (PH1-SDK-03)
 *   - verify_document:   Verify a document by content hash (PH1-SDK-03)
 *   - verify_batch:      Verify up to 100 credentials in one call (INT-02)
 *
 * Constitution 1.4: No raw PII in responses. Only hashed identifiers.
 * Constitution 1.3: No banned UI terms in tool descriptions.
 *
 * INT-02 follow-up: `cle_verify` MCP tool was scoped but removed before
 * merge — the /rest/v1/rpc/cle_verify RPC does not exist in the schema.
 * The HTTP route (services/worker/src/api/v1/cle-verify.ts) is live, but
 * exposing it through MCP requires threading caller API keys through the
 * edge handler context. Tracked as follow-up story INT-02b.
 */

/** Request timeout for all Supabase fetch calls (ms) */
const FETCH_TIMEOUT_MS = 10_000;

/** SHA-256 hex pattern (64 hex chars). Exported so mcp-server.ts can
 *  reuse the single source of truth for its Zod input validator. */
export const SHA256_HEX_RE = /^[a-fA-F0-9]{64}$/;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface VerifyInput {
  public_id: string;
}

export interface SearchInput {
  query: string;
  max_results?: number;
}

export interface NessieQueryInput {
  query: string;
  mode?: 'retrieval' | 'context';
  limit?: number;
}

export interface AnchorDocumentInput {
  content_hash: string;
  record_type?: string;
  source?: string;
  title?: string;
  source_url?: string;
}

export interface VerifyDocumentInput {
  content_hash: string;
}

export interface VerifyBatchInput {
  public_ids: string[];
}

export interface SupabaseConfig {
  supabaseUrl: string;
  supabaseKey: string;
}

// ---------------------------------------------------------------------------
// Shared Fetch Helper
// ---------------------------------------------------------------------------

function supabaseFetch(
  config: SupabaseConfig,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    apikey: config.supabaseKey,
    Authorization: `Bearer ${config.supabaseKey}`,
    ...(init?.headers as Record<string, string> ?? {}),
  };

  return fetch(`${config.supabaseUrl}${path}`, {
    ...init,
    headers,
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function textResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'verify_credential',
    description:
      'Verify a credential\'s authenticity and current status by its public identifier. ' +
      'Returns verification status, issuer information, credential type, dates, and network anchoring proof.',
    inputSchema: {
      type: 'object',
      properties: {
        public_id: {
          type: 'string',
          description: 'The credential\'s public identifier (e.g., ARK-2026-001)',
        },
      },
      required: ['public_id'],
    },
  },
  {
    name: 'search_credentials',
    description:
      'Search for credentials using natural language queries. ' +
      'Uses semantic similarity matching to find relevant credentials. ' +
      'Returns ranked results with verification status and relevance scores.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query (e.g., "University of Michigan computer science degree")',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10, max: 50)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'nessie_query',
    description:
      'Query Arkova\'s verified intelligence engine (Nessie). Searches anchored public records ' +
      '(SEC filings, patents, regulatory documents) using semantic similarity. ' +
      'In "context" mode, returns a synthesized answer with citations linking to anchored documents with proof.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language query (e.g., "Apple annual revenue 2025")',
        },
        mode: {
          type: 'string',
          description: 'Query mode: "retrieval" returns raw ranked documents, "context" returns a Gemini-synthesized answer with citations (default: retrieval)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default: 10, max: 50)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'anchor_document',
    description:
      'Submit a document fingerprint for anchoring to the public ledger. ' +
      'The document itself is never sent — only its SHA-256 fingerprint. ' +
      'Returns an anchor receipt with a public identifier for later verification.',
    inputSchema: {
      type: 'object',
      properties: {
        content_hash: {
          type: 'string',
          description: 'SHA-256 fingerprint of the document content',
        },
        record_type: {
          type: 'string',
          description: 'Type of record (e.g., patent_grant, 10-K, regulatory_notice)',
        },
        source: {
          type: 'string',
          description: 'Source identifier (e.g., edgar, uspto, federal_register)',
        },
        title: {
          type: 'string',
          description: 'Title of the document',
        },
        source_url: {
          type: 'string',
          description: 'URL of the original document',
        },
      },
      required: ['content_hash'],
    },
  },
  {
    name: 'verify_document',
    description:
      'Verify a document by its SHA-256 fingerprint. Checks if the document has been ' +
      'anchored and returns the anchor proof including the network receipt and timestamp.',
    inputSchema: {
      type: 'object',
      properties: {
        content_hash: {
          type: 'string',
          description: 'SHA-256 fingerprint of the document to verify',
        },
      },
      required: ['content_hash'],
    },
  },
  {
    name: 'verify_batch',
    description:
      'Verify multiple credentials in a single call. Accepts up to 100 public IDs ' +
      'and returns each result in input order. Use this when an agent needs to validate ' +
      'a list of credentials (e.g., a candidate portfolio, a screening pipeline batch).',
    inputSchema: {
      type: 'object',
      properties: {
        public_ids: {
          type: 'array',
          description: 'Array of credential public identifiers (max 100). Each is verified individually.',
        },
      },
      required: ['public_ids'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool Handlers
// ---------------------------------------------------------------------------

/**
 * Shape a `get_public_anchor` RPC row into the public verification envelope.
 * Pure mapping function — no network, no error handling. Used by both
 * `handleVerifyCredential` (single) and `handleVerifyBatch` so the output
 * schema cannot drift between the two code paths.
 *
 * When `publicId` is provided, the result includes a `public_id` echo key
 * (batch uses this to identify rows). When omitted, the single-record
 * contract is preserved.
 */
function shapeAnchorRow(
  data: Record<string, unknown>,
  publicId?: string,
): Record<string, unknown> {
  const status = data?.status as string | null | undefined;
  const resolvedPublicId = publicId ?? (data?.public_id as string | undefined) ?? '';
  return {
    ...(publicId !== undefined ? { public_id: publicId } : {}),
    verified: status === 'SECURED' || status === 'ACTIVE',
    status: mapStatus(status),
    issuer_name: (data?.org_name as string) ?? 'Unknown',
    recipient_identifier: (data?.recipient_hash as string) ?? '',
    credential_type: (data?.credential_type as string) ?? 'UNKNOWN',
    issued_date: (data?.issued_at as string | null) ?? null,
    expiry_date: (data?.expires_at as string | null) ?? null,
    anchor_timestamp: (data?.created_at as string) ?? '',
    network_receipt_id: (data?.chain_tx_id as string | null) ?? null,
    record_uri: `https://app.arkova.ai/verify/${resolvedPublicId}`,
    ...(data?.jurisdiction ? { jurisdiction: data.jurisdiction as string } : {}),
  };
}

/**
 * Verify a credential by its public ID. Catastrophic failures (abort,
 * network) return an MCP error result; a 404 returns a normal textResult
 * with `verified: false` — matching the pre-INT-02 contract.
 */
export async function handleVerifyCredential(
  input: VerifyInput,
  config: SupabaseConfig,
): Promise<ToolResult> {
  if (!input.public_id || input.public_id.trim().length === 0) {
    return errorResult('Error: public_id is required');
  }

  try {
    const response = await supabaseFetch(config, '/rest/v1/rpc/get_public_anchor', {
      method: 'POST',
      body: JSON.stringify({ p_public_id: input.public_id }),
    });

    if (!response.ok) {
      return textResult({ verified: false, error: `Credential "${input.public_id}" not found.` });
    }

    const data = (await response.json()) as Record<string, unknown>;
    return textResult(shapeAnchorRow(data));
  } catch (error) {
    const msg = error instanceof Error && error.name === 'AbortError'
      ? 'Verification lookup timed out'
      : `Verification lookup failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    return errorResult(msg);
  }
}

/**
 * Search credentials using natural language.
 */
export async function handleSearchCredentials(
  input: SearchInput,
  config: SupabaseConfig,
): Promise<ToolResult> {
  if (!input.query || input.query.trim().length === 0) {
    return errorResult('Error: query is required');
  }

  const maxResults = Math.min(input.max_results ?? 10, 50);

  try {
    // INJ-01: Use RPC with bound parameters instead of URL interpolation
    const sanitizedQuery = input.query.replace(/[%_\\]/g, '\\$&');
    const response = await supabaseFetch(config, '/rest/v1/rpc/search_public_credentials', {
      method: 'POST',
      body: JSON.stringify({ p_query: sanitizedQuery, p_limit: maxResults }),
    });

    if (!response.ok) {
      return errorResult(`Search failed: HTTP ${response.status}`);
    }

    const results = await response.json() as Array<Record<string, unknown>>;

    if (!Array.isArray(results) || results.length === 0) {
      return textResult({ query: input.query, total: 0, results: [] });
    }

    const mapped = results.map((r, i) => ({
      rank: i + 1,
      public_id: r.public_id,
      title: r.title,
      credential_type: r.credential_type,
      status: mapStatus(r.status as string),
      anchor_timestamp: r.created_at,
      record_uri: `https://app.arkova.ai/verify/${r.public_id}`,
    }));

    return textResult({ query: input.query, total: mapped.length, results: mapped });
  } catch (error) {
    const msg = error instanceof Error && error.name === 'AbortError'
      ? 'Search timed out'
      : `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    return errorResult(msg);
  }
}

/**
 * Query Nessie RAG endpoint (PH1-SDK-03).
 *
 * Searches anchored public records via Supabase RPC embedding search.
 */
export async function handleNessieQuery(
  input: NessieQueryInput,
  config: SupabaseConfig,
): Promise<ToolResult> {
  if (!input.query || input.query.trim().length === 0) {
    return errorResult('Error: query is required');
  }

  try {
    const response = await supabaseFetch(config, '/rest/v1/rpc/search_public_record_embeddings', {
      method: 'POST',
      body: JSON.stringify({
        p_query: input.query,
        p_mode: input.mode ?? 'retrieval',
        p_limit: Math.min(input.limit ?? 10, 50),
      }),
    });

    if (!response.ok) {
      return errorResult(`Nessie query failed: HTTP ${response.status}`);
    }

    const data = await response.json();
    return textResult(data);
  } catch (error) {
    const msg = error instanceof Error && error.name === 'AbortError'
      ? 'Nessie query timed out'
      : `Nessie query failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    return errorResult(msg);
  }
}

/**
 * Anchor a document by its content hash (PH1-SDK-03).
 *
 * Submits the fingerprint to public_records for batch anchoring.
 */
export async function handleAnchorDocument(
  input: AnchorDocumentInput,
  config: SupabaseConfig,
): Promise<ToolResult> {
  if (!input.content_hash || input.content_hash.trim().length === 0) {
    return errorResult('Error: content_hash is required');
  }

  if (!SHA256_HEX_RE.test(input.content_hash)) {
    return errorResult('Error: content_hash must be a valid 64-character SHA-256 hex string');
  }

  try {
    const response = await supabaseFetch(config, '/rest/v1/public_records', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        content_hash: input.content_hash,
        record_type: input.record_type ?? 'document',
        source: input.source ?? 'mcp',
        title: input.title ?? null,
        source_url: input.source_url ?? null,
        source_id: input.content_hash,
        metadata: {},
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return errorResult(`Anchor submission failed: ${errorText}`);
    }

    const records = await response.json() as Array<Record<string, unknown>>;
    const record = Array.isArray(records) ? records[0] : records;

    return textResult({
      status: 'submitted',
      record_id: record?.id,
      public_id: record?.public_id,
      content_hash: input.content_hash,
      message: 'Document fingerprint submitted for batch anchoring. Check status with verify_document.',
    });
  } catch (error) {
    const msg = error instanceof Error && error.name === 'AbortError'
      ? 'Anchor submission timed out'
      : `Anchor submission failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    return errorResult(msg);
  }
}

/**
 * Verify a document by its content hash (PH1-SDK-03).
 *
 * Looks up the public_records table for a matching content_hash and returns anchor proof.
 */
export async function handleVerifyDocument(
  input: VerifyDocumentInput,
  config: SupabaseConfig,
): Promise<ToolResult> {
  if (!input.content_hash || input.content_hash.trim().length === 0) {
    return errorResult('Error: content_hash is required');
  }

  if (!SHA256_HEX_RE.test(input.content_hash)) {
    return errorResult('Error: content_hash must be a valid 64-character SHA-256 hex string');
  }

  try {
    const response = await supabaseFetch(
      config,
      `/rest/v1/public_records?content_hash=eq.${encodeURIComponent(input.content_hash)}&select=id,source,source_url,record_type,title,content_hash,metadata,anchor_id&limit=1`,
    );

    if (!response.ok) {
      return errorResult(`Document lookup failed: HTTP ${response.status}`);
    }

    const records = await response.json() as Array<Record<string, unknown>>;

    if (!Array.isArray(records) || records.length === 0) {
      return textResult({ verified: false, message: 'No anchored document found with this fingerprint.' });
    }

    const record = records[0];
    const meta = (record.metadata as Record<string, unknown>) ?? {};
    const isAnchored = !!record.anchor_id;

    return textResult({
      verified: isAnchored,
      status: isAnchored ? 'ANCHORED' : 'PENDING',
      record_id: record.id,
      source: record.source,
      source_url: record.source_url,
      record_type: record.record_type,
      title: record.title,
      content_hash: record.content_hash,
      anchor_proof: isAnchored
        ? {
            chain_tx_id: (meta.chain_tx_id as string) ?? null,
            merkle_root: (meta.merkle_root as string) ?? null,
            content_hash: record.content_hash,
            anchored_at: (meta.anchored_at as string) ?? null,
          }
        : null,
    });
  } catch (error) {
    const msg = error instanceof Error && error.name === 'AbortError'
      ? 'Document verification timed out'
      : `Document verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    return errorResult(msg);
  }
}

/**
 * Verify multiple credentials in a single call (INT-02).
 *
 * Fans out per-ID and catches per-ID failures so one bad ID never poisons
 * the batch. Uses `shapeAnchorRow` for the success path so batch and
 * single handlers return identical per-record shapes.
 */
export async function handleVerifyBatch(
  input: VerifyBatchInput,
  config: SupabaseConfig,
): Promise<ToolResult> {
  if (!Array.isArray(input.public_ids) || input.public_ids.length === 0) {
    return errorResult('Error: public_ids must be a non-empty array');
  }

  if (input.public_ids.length > 100) {
    return errorResult('Error: verify_batch accepts at most 100 public_ids per call');
  }

  const sanitized = input.public_ids.map((id) => (typeof id === 'string' ? id.trim() : ''));
  if (sanitized.some((id) => id.length === 0)) {
    return errorResult('Error: every public_id must be a non-empty string');
  }

  const lookups = sanitized.map(async (publicId) => {
    try {
      const response = await supabaseFetch(config, '/rest/v1/rpc/get_public_anchor', {
        method: 'POST',
        body: JSON.stringify({ p_public_id: publicId }),
      });
      if (!response.ok) {
        return { public_id: publicId, verified: false, error: `Credential "${publicId}" not found.` };
      }
      const data = (await response.json()) as Record<string, unknown>;
      return shapeAnchorRow(data, publicId);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { public_id: publicId, verified: false, error: 'Verification lookup timed out' };
      }
      return { public_id: publicId, verified: false, error: 'Verification lookup failed' };
    }
  });

  const results = await Promise.all(lookups);
  return textResult({ total: results.length, results });
}

/** Map internal status to public-facing status */
function mapStatus(status: string | null | undefined): string {
  switch (status) {
    case 'SECURED':
    case 'ACTIVE':
      return 'ACTIVE';
    case 'REVOKED':
      return 'REVOKED';
    case 'SUPERSEDED':
      return 'SUPERSEDED';
    case 'EXPIRED':
      return 'EXPIRED';
    default:
      return 'UNKNOWN';
  }
}

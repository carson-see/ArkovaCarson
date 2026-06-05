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

/** Request timeout for Supabase fetch calls (ms). */
const SUPABASE_FETCH_TIMEOUT_MS = 10_000;

/** Request timeout for worker-proxied Nessie context generation (ms). */
const NESSIE_WORKER_FETCH_TIMEOUT_MS = 30_000;

/**
 * Embedding model used by the edge nessie vector-search path.
 *
 * WARNING (BUG-3a): this Workers AI model (`@cf/baai/bge-base-en-v1.5`,
 * 768-dim) is NOT the same model family the public-record index was built
 * with. The index is embedded by the worker with Gemini
 * `gemini-embedding-001` (see `services/worker/src/ai/gemini-config.ts`
 * `GEMINI_EMBEDDING_MODEL`). Querying a Gemini-built index with BGE vectors
 * returns semantically meaningless nearest-neighbours. PR-3 re-routes the
 * nessie vector path through the worker so both sides share ONE model.
 * Until then the edge text-fallback (`nessieTextFallback`) is the truthful
 * path. The cross-service drift-guard test
 * (`services/worker/src/nessie-embedding-drift.test.ts`) fails if this
 * literal diverges in family from the worker's index model.
 */
export const NESSIE_EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';

/** SHA-256 hex pattern (64 hex chars). Exported so mcp-server.ts can
 *  reuse the single source of truth for its Zod input validator. */
export const SHA256_HEX_RE = /^[a-fA-F0-9]{64}$/;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, ToolInputSchemaProperty>;
    required: string[];
  };
}

export interface ToolInputSchemaProperty {
  type: string;
  description: string;
  format?: string;
  items?: ToolInputSchemaProperty;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
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
  idempotency_key?: string;
}

export interface VerifyDocumentInput {
  content_hash: string;
}

export interface VerifyBatchInput {
  public_ids: string[];
}

export type AgentSearchType = 'all' | 'org' | 'record' | 'fingerprint' | 'document';

export interface AgentSearchInput {
  q: string;
  type?: AgentSearchType;
  /**
   * REST/OpenAPI v2 uses `limit`; `max_results` is accepted only as a
   * backwards-compatible MCP alias for older agent prompts.
   */
  limit?: number;
  max_results?: number;
}

export interface AgentVerifyInput {
  fingerprint: string;
}

export interface AgentGetAnchorInput {
  public_id: string;
}

export interface AgentGetOrganizationInput {
  public_id: string;
}

export interface SupabaseConfig {
  supabaseUrl: string;
  supabaseKey: string;
  userId: string;
  /**
   * Base URL of the Arkova worker (e.g. https://api.arkova.ai). When set,
   * `handleNessieQuery` proxies the vector path to the worker's single
   * Gemini embedder (`GET /api/v1/nessie/query`) instead of re-embedding
   * with Cloudflare bge-base against a Gemini-space index (BUG-3a). When
   * unset (local dev / preview without the binding), the edge degrades to
   * the lowercase text fallback only.
   */
  workerBaseUrl?: string;
  /**
   * The RAW API key the caller presented on the inbound MCP request
   * (X-API-Key auth only; absent for OAuth Bearer callers). Forwarded
   * verbatim as `X-API-Key` to the worker nessie endpoint so the worker
   * enforces the caller's org-scoping, scopes, and per-caller rate limits
   * — NOT a shared service-account key. NEVER logged.
   */
  callerApiKey?: string;
}

const PUBLIC_ID_JSON_SCHEMA: ToolInputSchemaProperty = {
  type: 'string',
  description: 'Arkova public ID matching ARK-<TYPE>-<SUFFIX>.',
  pattern: '^ARK-[A-Z0-9-]{3,60}$',
  maxLength: 64,
};

const ORG_PUBLIC_ID_JSON_SCHEMA: ToolInputSchemaProperty = {
  type: 'string',
  description: 'Organization public ID.',
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$',
  minLength: 2,
  maxLength: 128,
};

const FINGERPRINT_JSON_SCHEMA: ToolInputSchemaProperty = {
  type: 'string',
  description: '64-character SHA-256 document fingerprint.',
  pattern: '^[a-fA-F0-9]{64}$',
};

// ---------------------------------------------------------------------------
// Shared Fetch Helper
// ---------------------------------------------------------------------------

export function supabaseFetch(
  config: SupabaseConfig,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUPABASE_FETCH_TIMEOUT_MS);

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
        idempotency_key: {
          type: 'string',
          format: 'uuid',
          description: 'Client-supplied UUID for retry deduplication',
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
          items: PUBLIC_ID_JSON_SCHEMA,
          minItems: 1,
          maxItems: 100,
          description: 'Array of credential public identifiers (max 100). Each is verified individually.',
        },
      },
      required: ['public_ids'],
    },
  },
  {
    name: 'search',
    description:
      'Agent-friendly v2 search tool. Search organizations, anchored records, fingerprints, and documents by natural language query or exact fingerprint.',
    inputSchema: {
      type: 'object',
      properties: {
        q: {
          type: 'string',
          description: 'Natural language query or exact SHA-256 fingerprint.',
        },
        type: {
          type: 'string',
          description: 'Optional result filter: all, org, record, fingerprint, or document.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 50, max: 50). Capped to the record search RPC ceiling.',
        },
        max_results: {
          type: 'number',
          description: 'Deprecated alias for limit. Prefer limit for REST v2 parity.',
        },
      },
      required: ['q'],
    },
  },
  {
    name: 'verify',
    description:
      'Agent-friendly v2 verification tool. Verify whether a SHA-256 document fingerprint has been anchored.',
    inputSchema: {
      type: 'object',
      properties: {
        fingerprint: {
          type: 'string',
          description: '64-character SHA-256 document fingerprint.',
        },
      },
      required: ['fingerprint'],
    },
  },
  {
    name: 'list_orgs',
    description:
      'List the organizations available to the authenticated caller. Use to establish org context before scoped searches.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_anchor',
    description:
      'Get redacted public anchor metadata by Arkova public ID. Use after search returns a public_id.',
    inputSchema: {
      type: 'object',
      properties: {
        public_id: {
          type: 'string',
          description: 'Arkova public identifier (for example ARK-DOC-ABCDEF).',
        },
      },
      required: ['public_id'],
    },
  },
  {
    name: 'get_organization',
    description:
      'Get organization profile details by organization public_id. Use after search returns an organization public_id.',
    inputSchema: {
      type: 'object',
      properties: {
        public_id: ORG_PUBLIC_ID_JSON_SCHEMA,
      },
      required: ['public_id'],
    },
  },
  {
    name: 'get_record',
    description:
      'Get public-safe record metadata by Arkova public ID. Use after search returns a record public_id.',
    inputSchema: {
      type: 'object',
      properties: {
        public_id: PUBLIC_ID_JSON_SCHEMA,
      },
      required: ['public_id'],
    },
  },
  {
    name: 'get_fingerprint',
    description:
      'Get public-safe record metadata by SHA-256 fingerprint. Use after search returns a fingerprint result.',
    inputSchema: {
      type: 'object',
      properties: {
        fingerprint: FINGERPRINT_JSON_SCHEMA,
      },
      required: ['fingerprint'],
    },
  },
  {
    name: 'get_document',
    description:
      'Get public-safe document metadata by Arkova public ID. Use after search returns a document public_id.',
    inputSchema: {
      type: 'object',
      properties: {
        public_id: PUBLIC_ID_JSON_SCHEMA,
      },
      required: ['public_id'],
    },
  },
  {
    name: 'oracle_batch_verify',
    description:
      'Batch-verify multiple credentials via the Arkova Oracle. Use for bulk verification workflows where an envelope with query_id + per-credential results is needed.',
    inputSchema: {
      type: 'object',
      properties: {
        public_ids: {
          type: 'array',
          items: PUBLIC_ID_JSON_SCHEMA,
          minItems: 1,
          maxItems: 25,
          description: 'Array of Arkova public IDs to verify (max 25).',
        },
      },
      required: ['public_ids'],
    },
  },
  {
    name: 'list_agents',
    description:
      'List AI agents registered to the authenticated caller organization. Returns agent names, types, scopes, and status.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
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
// BUG-2 (PR-1): keys MUST match what `get_public_anchor` actually emits
// (migration 0311_scrum1599_public_anchor_provenance.sql,
// jsonb_build_object body). The prior implementation read six keys the RPC
// never returns — org_name / recipient_hash / issued_at / expires_at /
// created_at(-as-anchor-time) / chain_tx_id — so every mapped field silently
// fell back to its default ('Unknown', '', null) for SECURED anchors. The
// correct RPC keys are issuer_name / recipient_identifier / issued_date /
// expiry_date / anchor_timestamp / network_receipt_id.
//
// `anchor_timestamp` is the network-observed time (CLAUDE.md §1.5); the RPC
// gates it to NULL for PENDING anchors, so default to null (NOT '') here.
export function shapeAnchorRow(
  data: Record<string, unknown>,
  publicId?: string,
): Record<string, unknown> {
  const status = data?.status as string | null | undefined;
  const resolvedPublicId = publicId ?? (data?.public_id as string | undefined) ?? '';
  return {
    ...(publicId !== undefined ? { public_id: publicId } : {}),
    verified: status === 'SECURED' || status === 'ACTIVE',
    status: mapStatus(status),
    issuer_name: (data?.issuer_name as string) ?? 'Unknown',
    recipient_identifier: (data?.recipient_identifier as string) ?? '',
    credential_type: (data?.credential_type as string) ?? 'UNKNOWN',
    issued_date: (data?.issued_date as string | null) ?? null,
    expiry_date: (data?.expiry_date as string | null) ?? null,
    anchor_timestamp: (data?.anchor_timestamp as string | null) ?? null,
    network_receipt_id: (data?.network_receipt_id as string | null) ?? null,
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
    const sanitizedQuery = input.query.replaceAll(/[%_\\]/g, String.raw`\$&`);
    const response = await supabaseFetch(config, '/rest/v1/rpc/search_public_credentials', {
      method: 'POST',
      body: JSON.stringify({ p_query: sanitizedQuery, p_limit: maxResults }),
    });

    if (!response.ok) {
      // Capture PostgREST error body for diagnostics; fall back to direct
      // table query when the RPC fails (common cause: statement_timeout on
      // the ILIKE pattern scan in large tables).
      const errBody = await response.text().catch(() => '');
      console.error(
        `[search_credentials] RPC returned HTTP ${response.status}: ${errBody}`,
      );
      return searchCredentialsFallback(input.query, maxResults, config);
    }

    const results = await response.json() as Array<Record<string, unknown>>;

    if (!Array.isArray(results) || results.length === 0) {
      return textResult({ query: input.query, total: 0, results: [] });
    }

    return textResult({
      query: input.query,
      total: results.length,
      results: results.map((r, i) => ({
        rank: i + 1,
        public_id: r.public_id,
        title: r.title,
        credential_type: r.credential_type,
        status: mapStatus(r.status as string),
        anchor_timestamp: r.created_at,
        record_uri: `https://app.arkova.ai/verify/${r.public_id}`,
      })),
    });
  } catch (error) {
    const msg = error instanceof Error && error.name === 'AbortError'
      ? 'Search timed out'
      : `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    return errorResult(msg);
  }
}

/**
 * Fallback search when the search_public_credentials RPC fails.
 * Queries the anchors table directly via PostgREST with ILIKE on filename.
 * Scoped to non-deleted SECURED/SUBMITTED anchors.
 */
async function searchCredentialsFallback(
  query: string,
  limit: number,
  config: SupabaseConfig,
): Promise<ToolResult> {
  try {
    // PostgREST: combine filters with `and=()` so duplicate `or=` keys
    // don't collide. status uses `in.()` instead of a second `or=`.
    const encoded = encodeURIComponent(`%${query}%`);
    const params = [
      'deleted_at=is.null',
      'status=in.(SECURED,SUBMITTED)',
      `or=(filename.ilike.${encoded},description.ilike.${encoded})`,
      'select=public_id,filename,credential_type,status,created_at,org_id',
      'order=created_at.desc',
      `limit=${limit}`,
    ].join('&');

    const resp = await supabaseFetch(config, `/rest/v1/anchors?${params}`);
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return errorResult(`Search failed (fallback): HTTP ${resp.status} — ${body}`);
    }

    const rows = await resp.json() as Array<Record<string, unknown>>;
    if (!Array.isArray(rows) || rows.length === 0) {
      return textResult({ query, total: 0, results: [] });
    }

    return textResult({
      query,
      total: rows.length,
      results: rows.map((r, i) => ({
        rank: i + 1,
        public_id: r.public_id,
        title: r.filename,
        credential_type: r.credential_type,
        status: mapStatus(r.status as string),
        anchor_timestamp: r.created_at,
        record_uri: `https://app.arkova.ai/verify/${r.public_id}`,
      })),
    });
  } catch (err) {
    console.error('[search_credentials] fallback failed:', err);
    return errorResult(`Search failed: both RPC and fallback query failed — ${err instanceof Error ? err.message : 'unknown'}`);
  }
}

function parseToolJson(result: ToolResult): Record<string, unknown> | null {
  try {
    return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function searchAgentOrgs(
  query: string,
  config: SupabaseConfig,
  limit = 50,
): Promise<Array<Record<string, unknown>>> {
  const normalizedQuery = query.trim().toLowerCase();
  const pageSize = 50;
  const matches: Array<Record<string, unknown>> = [];
  const seenPublicIds = new Set<string>();

  for (let offset = 0; matches.length < limit; offset += pageSize) {
    const params = new URLSearchParams({
      user_id: `eq.${config.userId}`,
      select: 'role,organizations(public_id,display_name,description,domain,website_url,verification_status)',
      limit: String(pageSize),
      offset: String(offset),
    });

    const response = await supabaseFetch(config, `/rest/v1/org_members?${params.toString()}`);
    if (!response.ok) return matches;

    const memberships = await response.json() as Array<Record<string, unknown>>;
    if (!Array.isArray(memberships) || memberships.length === 0) break;

    for (const membership of memberships) {
      const org = membership.organizations as Record<string, unknown> | null | undefined;
      if (!org) continue;

      const publicId = typeof org.public_id === 'string' ? org.public_id : null;
      if (!publicId || seenPublicIds.has(publicId)) continue;

      const isMatch = [
        org.display_name,
        org.description,
        org.domain,
        org.website_url,
      ].some((value) => typeof value === 'string' && value.toLowerCase().includes(normalizedQuery));

      if (!isMatch) continue;

      seenPublicIds.add(publicId);
      matches.push(org);
      if (matches.length >= limit) break;
    }

    if (memberships.length < pageSize) break;
  }

  return matches.map((org) => ({
      type: 'org',
      public_id: org.public_id,
      score: 1,
      snippet: org.display_name ?? org.description ?? org.domain ?? '',
      metadata: {
        description: org.description ?? null,
        domain: org.domain ?? null,
        website_url: org.website_url ?? null,
      },
    }));
}

async function searchAgentRecords(
  input: AgentSearchInput,
  config: SupabaseConfig,
): Promise<Array<Record<string, unknown>>> {
  const maxResults = Math.min(input.limit ?? input.max_results ?? 50, 50);
  const sanitizedQuery = input.q.replaceAll(/[%_\\]/g, String.raw`\$&`);
  const response = await supabaseFetch(config, '/rest/v1/rpc/search_public_credentials', {
    method: 'POST',
    body: JSON.stringify({ p_query: sanitizedQuery, p_limit: maxResults }),
  });

  if (!response.ok) return [];

  const records = await response.json() as Array<Record<string, unknown>>;
  if (!Array.isArray(records)) return [];

  const resultType = input.type === 'document' ? 'document' : 'record';
  return records.filter((record) => record.public_id != null).map((record) => ({
    type: resultType,
    public_id: record.public_id,
    score: 1,
    snippet: record.title ?? record.description ?? record.credential_type ?? '',
    metadata: {
      credential_type: record.credential_type ?? null,
      status: record.status ?? null,
    },
  }));
}

/**
 * Agent-friendly alias for API v2 `search(q,type?)`. The legacy
 * `search_credentials` tool remains for backwards compatibility; this shape
 * matches the OpenAPI 3.1 operationId consumed by function-call importers.
 */
export async function handleAgentSearch(
  input: AgentSearchInput,
  config: SupabaseConfig,
): Promise<ToolResult> {
  if (!input.q || input.q.trim().length === 0) {
    return errorResult('Error: q is required');
  }

  const maxResults = Math.min(input.limit ?? input.max_results ?? 50, 50);
  const type = input.type ?? 'all';

  try {
    if (type === 'fingerprint') {
      if (!SHA256_HEX_RE.test(input.q)) {
        return textResult({ query: input.q, total: 0, results: [] });
      }
      const result = await handleVerifyDocument({ content_hash: input.q }, config);
      const parsed = parseToolJson(result);
      const found = parsed && !(parsed.verified === false && typeof parsed.message === 'string');
      return textResult({
        results: found && parsed?.public_id ? [{
          type: 'fingerprint',
          public_id: parsed.public_id,
          score: 1,
          // shapeAnchorRow carries no title/content_hash, so fall back to the
          // public_id as the snippet (the only human-meaningful handle here).
          snippet: parsed.public_id ?? '',
          metadata: { status: parsed.status ?? null },
        }] : [],
        next_cursor: null,
      });
    }

    if (type === 'org') {
      const orgs = await searchAgentOrgs(input.q, config, maxResults);
      return textResult({ results: orgs.slice(0, maxResults), next_cursor: null });
    }

    if (type === 'record' || type === 'document') {
      const records = await searchAgentRecords({ ...input, max_results: maxResults }, config);
      return textResult({ results: records, next_cursor: null });
    }

    const [orgs, records] = await Promise.all([
      searchAgentOrgs(input.q, config, maxResults),
      searchAgentRecords({ ...input, max_results: maxResults }, config),
    ]);
    const results = [...orgs, ...records].slice(0, maxResults);
    return textResult({ results, next_cursor: null });
  } catch (error) {
    const msg = error instanceof Error && error.name === 'AbortError'
      ? 'Agent search timed out'
      : `Agent search failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
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
  _ai?: Ai,
): Promise<ToolResult> {
  if (!input.query || input.query.trim().length === 0) {
    return errorResult('Error: query is required');
  }

  const matchCount = Math.min(input.limit ?? 10, 50);
  const mode = input.mode ?? 'retrieval';

  try {
    // BUG-3a: the edge no longer embeds the query itself. Embedding the
    // query with Cloudflare bge-base (`NESSIE_EMBEDDING_MODEL`, 768-dim) and
    // searching a Gemini-space index returned semantically meaningless
    // neighbours, so this tool silently degraded to `text_fallback`/total=0.
    // PR-3 proxies the vector path to the worker's SINGLE Gemini embedder
    // (`GET {workerBaseUrl}/api/v1/nessie/query`) and forwards the caller's
    // raw API key so the worker enforces org-scoping + per-caller rate limits.
    //
    // `_ai` is retained in the signature for backwards-compat but is no longer
    // used for embedding — the model lives entirely on the worker side now.

    // No worker configured (local dev / preview): the truthful path is the
    // lowercase text fallback (BUG-3b, PR-1). Don't pretend to do vector search.
    if (!config.workerBaseUrl || !config.callerApiKey) {
      return await nessieTextFallback(input.query, matchCount, config);
    }

    const workerResult = await nessieWorkerQuery(
      input.query,
      mode,
      matchCount,
      config,
    );
    if (workerResult) return workerResult;

    // Worker unreachable / errored — degrade gracefully to text fallback
    // (already PR-1-fixed to lowercase sources) instead of throwing.
    return await nessieTextFallback(input.query, matchCount, config);
  } catch (error) {
    const msg =
      error instanceof Error && error.name === 'AbortError'
        ? 'Nessie query timed out'
        : `Nessie query failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    return errorResult(msg);
  }
}

/** Single worker nessie result (mirror of services/worker NessieResult). */
interface WorkerNessieResult {
  record_id: string;
  source: string;
  source_url: string;
  record_type: string;
  title: string | null;
  relevance_score: number;
  anchor_proof: Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
}

/**
 * Worker context-mode citation (mirror of services/worker NessieCitation).
 * mode=context returns a synthesized answer + these citations, NOT `results`.
 */
interface WorkerNessieCitation {
  record_id: string;
  source: string;
  source_url: string;
  title: string | null;
  relevance_score: number;
  anchor_proof: Record<string, unknown> | null;
  excerpt: string;
}

/**
 * Worker mode=context response shape (mirror of services/worker
 * NessieContextResponse). NOTE: there is NO `results` field — the synthesized
 * answer lives in `answer` and the supporting documents in `citations`.
 */
interface WorkerNessieContextResponse {
  answer: string;
  citations: WorkerNessieCitation[];
  confidence: number;
  risks?: string[];
  recommendations?: string[];
  model?: string;
  query?: string;
  task_type?: string;
  tokens_used?: number;
  cached?: boolean;
  // Present only on the worker's graceful-degradation fallback branch, where
  // it falls back to retrieval and emits `results` instead of `answer`.
  results?: WorkerNessieResult[];
  fallback?: boolean;
}

/**
 * Vector search via the worker's Gemini-space endpoint (BUG-3a).
 *
 * Issues `GET {workerBaseUrl}/api/v1/nessie/query?q=&mode=&limit=` with the
 * caller's raw API key forwarded as `X-API-Key` (never the service-role key).
 *
 * The worker returns TWO different shapes depending on `mode`:
 *   - retrieval → `{results, count, query}` — mapped to the MCP
 *     `{query, mode, total, results}` contract, preserving `relevance_score`
 *     (as `similarity`) and the anchor citation.
 *   - context  → `{answer, citations, confidence, ...}` with NO `results`
 *     field — mapped to `{query, mode, answer, confidence, citations, total}`
 *     so the synthesized answer + citations survive (previously dropped → the
 *     edge silently returned total:0 for every context query).
 *
 * Returns `null` on any network/HTTP/shape failure so the caller can fall
 * back to the text path. NEVER logs `config.callerApiKey`.
 */
async function nessieWorkerQuery(
  query: string,
  mode: string,
  matchCount: number,
  config: SupabaseConfig,
): Promise<ToolResult | null> {
  let base = config.workerBaseUrl ?? '';
  while (base.endsWith('/')) base = base.slice(0, -1);
  const callerKey = config.callerApiKey;
  if (!base || !callerKey) return null;

  const params = new URLSearchParams({
    q: query,
    mode,
    limit: String(matchCount),
  });
  const url = `${base}/api/v1/nessie/query?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NESSIE_WORKER_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        // Forward the CALLER's key — preserves org-scoping, scopes, and the
        // worker's per-caller rate limits. Do NOT log this value.
        'X-API-Key': callerKey,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      // Redacted log: status only, never the key or full URL with params.
      console.warn(`[nessie_query] worker proxy HTTP ${response.status}; falling back to text search`);
      return null;
    }

    const body = (await response.json()) as WorkerNessieContextResponse & {
      results?: WorkerNessieResult[];
      count?: number;
    };

    // MODE: context — the worker returns a synthesized {answer, citations,
    // confidence} envelope with NO top-level `results` field (see
    // services/worker/src/api/v1/nessie-query.ts context branch). Mapping only
    // `body.results` here would silently drop the answer + citations and
    // report total:0. Preserve them into the MCP text contract instead.
    //
    // The one exception is the worker's graceful-degradation path: on a
    // context-generation failure it falls back to retrieval and emits
    // `{results, fallback:true}`. Detect that by the presence of `results`
    // (and absence of a synthesized `answer`) and map it like retrieval.
    const isContextEnvelope =
      mode === 'context' && !Array.isArray(body.results) && typeof body.answer === 'string';

    if (isContextEnvelope) {
      const citations = Array.isArray(body.citations) ? body.citations : [];
      const mappedCitations = citations.map((c) => ({
        record_id: c.record_id,
        title: c.title,
        source: c.source,
        source_url: c.source_url,
        similarity: c.relevance_score,
        anchor_proof: c.anchor_proof ?? null,
        excerpt: c.excerpt,
      }));

      return textResult({
        query,
        mode,
        answer: body.answer,
        confidence: body.confidence,
        citations: mappedCitations,
        // `total` reflects citation count so context queries no longer report
        // total:0 when a real synthesized answer was returned.
        total: mappedCitations.length,
        ...(body.risks ? { risks: body.risks } : {}),
        ...(body.recommendations ? { recommendations: body.recommendations } : {}),
      });
    }

    // MODE: retrieval (or context graceful-fallback emitting `results`).
    const workerResults = Array.isArray(body.results) ? body.results : [];

    const results = workerResults.map((r) => ({
      record_id: r.record_id,
      title: r.title,
      source: r.source,
      source_url: r.source_url,
      record_type: r.record_type,
      similarity: r.relevance_score,
      anchor_proof: r.anchor_proof ?? null,
      metadata: r.metadata ?? {},
    }));

    return textResult({ query, mode, total: results.length, results });
  } catch (err) {
    // AbortError or network failure — redacted (no key, no params).
    const reason = err instanceof Error ? err.name : 'unknown';
    console.warn(`[nessie_query] worker proxy failed (${reason}); falling back to text search`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Text-based fallback search on public_records (no embeddings needed).
 *  Uses equality filters on indexed columns (source, record_type) rather
 *  than ILIKE, which causes full-table scans on large tables.
 *  Wrapped in try/catch so it NEVER throws — returns errorResult instead.
 *  This is critical for the Promise.race in handleNessieQuery. */
async function nessieTextFallback(
  query: string,
  limit: number,
  config: SupabaseConfig,
): Promise<ToolResult> {
  try {
    // Extract known source keywords from the query for indexed filtering.
    // BUG-3b (PR-1): ingestion fetchers insert LOWERCASE source values —
    // 'edgar', 'uspto', 'federal_register', 'openalex' (verify in
    // services/worker/src/jobs/*Fetcher.ts). The previous UPPERCASE literals
    // ('EDGAR', ...) made `source=eq.EDGAR` never match any row, so every
    // source-scoped nessie query silently returned the unfiltered recent set.
    const q = query.toLowerCase();
    const sourceFilters: string[] = [];
    if (q.includes('sec') || q.includes('filing') || q.includes('edgar')) sourceFilters.push('edgar');
    if (q.includes('patent') || q.includes('uspto')) sourceFilters.push('uspto');
    if (q.includes('federal') || q.includes('regulation')) sourceFilters.push('federal_register');
    if (q.includes('paper') || q.includes('research') || q.includes('publication')) sourceFilters.push('openalex');

    const parts = [
      'select=id,title,source,source_url,record_type,content_hash,anchor_id,created_at',
      'order=created_at.desc',
      `limit=${limit}`,
    ];
    if (sourceFilters.length === 1) {
      parts.push(`source=eq.${sourceFilters[0]}`);
    } else if (sourceFilters.length > 1) {
      parts.push(`source=in.(${sourceFilters.join(',')})`);
    }
    // If no source keywords matched, just return recent records
    const params = parts.join('&');

    const resp = await supabaseFetch(config, `/rest/v1/public_records?${params}`);
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return errorResult(`Nessie query failed (text fallback): HTTP ${resp.status} — ${body}`);
    }

    const rows = (await resp.json()) as Array<Record<string, unknown>>;
    return textResult({
      query,
      mode: 'text_fallback',
      total: Array.isArray(rows) ? rows.length : 0,
      results: Array.isArray(rows) ? rows : [],
    });
  } catch (err) {
    console.error('[nessie_query] text fallback failed:', err);
    return errorResult(
      `Nessie text search failed: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }
}

/**
 * Anchor a document by its content hash (PH1-SDK-03).
 *
 * Submits the fingerprint to public_records for batch anchoring.
 */
function anchorSubmittedResult(record: Record<string, unknown> | undefined, contentHash: string): ToolResult {
  return textResult({
    status: 'submitted',
    public_id: record?.public_id,
    content_hash: contentHash,
    message: 'Document fingerprint submitted for batch anchoring. Check status with verify_document.',
  });
}

async function findRecentAnchorSubmission(
  config: SupabaseConfig,
  contentHash: string,
): Promise<ToolResult | null> {
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  const lookupResp = await supabaseFetch(
    config,
    `/rest/v1/public_records?content_hash=eq.${contentHash}&created_at=gte.${fiveMinAgo}&order=created_at.desc&limit=1`,
  );
  if (!lookupResp.ok) return null;

  const existing = await lookupResp.json() as Array<Record<string, unknown>>;
  if (!Array.isArray(existing) || existing.length === 0) return null;

  return textResult({
    status: 'already_submitted',
    public_id: existing[0].public_id,
    content_hash: contentHash,
    message: 'Document was already submitted within the last 5 minutes. Returning existing record.',
  });
}

async function submitAnchorViaRpc(
  input: AnchorDocumentInput,
  config: SupabaseConfig,
): Promise<ToolResult | undefined> {
  const rpcResponse = await supabaseFetch(config, '/rest/v1/rpc/mcp_anchor_document', {
    method: 'POST',
    body: JSON.stringify({
      p_user_id: config.userId,
      p_content_hash: input.content_hash,
      p_record_type: input.record_type ?? 'document',
      p_source: input.source ?? 'mcp',
      p_title: input.title ?? null,
      p_source_url: input.source_url ?? null,
    }),
  });
  if (!rpcResponse.ok) {
    if (rpcResponse.status === 404) return undefined;
    const errorText = await rpcResponse.text();
    return errorResult(`Anchor submission failed: ${errorText}`);
  }

  const records = await rpcResponse.json() as Array<Record<string, unknown>>;
  const record = Array.isArray(records) ? records[0] : records;
  return anchorSubmittedResult(record, input.content_hash);
}

async function submitAnchorDirect(
  input: AnchorDocumentInput,
  config: SupabaseConfig,
): Promise<ToolResult> {
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
  return anchorSubmittedResult(record, input.content_hash);
}

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
    if (input.idempotency_key) {
      const duplicate = await findRecentAnchorSubmission(config, input.content_hash);
      if (duplicate) return duplicate;
    }

    // MCP-SEC-03: Use scoped RPC instead of direct service-role INSERT.
    // Falls back to direct INSERT if the RPC doesn't exist yet (pre-0223).
    const rpcResult = await submitAnchorViaRpc(input, config);
    if (rpcResult) return rpcResult;

    // Fallback: direct INSERT (pre-migration-0223 compat)
    return submitAnchorDirect(input, config);
  } catch (error) {
    const msg = error instanceof Error && error.name === 'AbortError'
      ? 'Anchor submission timed out'
      : `Anchor submission failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    return errorResult(msg);
  }
}

/**
 * Verify a document by its content hash / fingerprint (PH1-SDK-03, BUG-1).
 *
 * Calls the `get_public_anchor_by_fingerprint` SECURITY DEFINER RPC
 * (migration 0335) and maps the result through `shapeAnchorRow`, so verify
 * returns the SAME truthful, redacted anchor shape as `get_anchor` /
 * `verify_credential`. The prior implementation hit
 * `/rest/v1/public_records?...&select=...public_id...` with a column set that
 * does not match the table shape — it returned HTTP 400 universally and the
 * tool was 100% broken.
 *
 * An unknown fingerprint is NOT an error: the RPC returns
 * `{ error: 'Record not found' }` and this maps to a verified:false /
 * status:UNKNOWN envelope (HTTP-200-equivalent). A `message` is retained so
 * `handleAgentSearch(type:'fingerprint')`'s found-guard still treats it as a
 * miss.
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

  // The RPC matches case-insensitively, but normalize client-side too so the
  // request body is deterministic.
  const fingerprint = input.content_hash.toLowerCase();

  try {
    const response = await supabaseFetch(config, '/rest/v1/rpc/get_public_anchor_by_fingerprint', {
      method: 'POST',
      body: JSON.stringify({ p_fingerprint: fingerprint }),
    });

    if (!response.ok) {
      return errorResult(`Document lookup failed: HTTP ${response.status}`);
    }

    const data = (await response.json()) as Record<string, unknown> | null;

    // Unknown fingerprint → RPC returns { error: 'Record not found' }.
    // Surface a verified:false envelope, NOT an MCP error result.
    if (!data || typeof data !== 'object' || 'error' in data) {
      return textResult({
        verified: false,
        status: 'UNKNOWN',
        fingerprint,
        public_id: null,
        network_receipt_id: null,
        anchor_timestamp: null,
        message: 'No anchored document found with this fingerprint.',
      });
    }

    // Pass the RPC's own public_id so the envelope echoes it AND builds the
    // correct record_uri (the single-record verify contract surfaces
    // public_id; the public verify URL is derived from it).
    return textResult(shapeAnchorRow(data, (data.public_id as string | undefined) ?? ''));
  } catch (error) {
    const msg = error instanceof Error && error.name === 'AbortError'
      ? 'Document verification timed out'
      : `Document verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    return errorResult(msg);
  }
}

/**
 * Agent-friendly alias for API v2 `verify(fingerprint)`.
 *
 * As of BUG-1 (PR-2) `handleVerifyDocument` returns the redacted
 * `shapeAnchorRow` envelope, which never carries an internal `record_id` /
 * `id`. The `record_id` strip is retained as defense-in-depth: if any future
 * change to the verify path reintroduces an internal id key, this guarantees
 * the agent-facing `get_fingerprint` contract stays public-safe.
 */
export async function handleAgentVerify(
  input: AgentVerifyInput,
  config: SupabaseConfig,
): Promise<ToolResult> {
  const result = await handleVerifyDocument({ content_hash: input.fingerprint }, config);
  if (result.isError) return result;

  const parsed = parseToolJson(result);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
  if (!('record_id' in parsed)) return result;

  const { record_id: _omit, ...publicSafe } = parsed as Record<string, unknown>;
  void _omit;
  return textResult(publicSafe);
}

/** Agent-friendly alias for API v2 `get_anchor(public_id)`. */
export async function handleAgentGetAnchor(
  input: AgentGetAnchorInput,
  config: SupabaseConfig,
): Promise<ToolResult> {
  return handleVerifyCredential({ public_id: input.public_id }, config);
}

/**
 * Public-safe organization detail. Mirrors the worker's
 * GET /api/v2/organizations/{public_id} contract by issuing a dedicated
 * org_members→organizations lookup (NOT a filter over list_orgs), so the
 * response:
 *   - never inherits the list endpoint's 50-row cap;
 *   - never leaks the internal `organizations.id` column;
 *   - includes `description`.
 *
 * Caller scope is enforced at the membership join: only memberships of the
 * authenticated `config.userId` whose embedded organization matches
 * `input.public_id` are returned. An out-of-scope `public_id` returns
 * "not found" rather than leaking org rows the caller cannot see.
 */
export async function handleAgentGetOrganization(
  input: AgentGetOrganizationInput,
  config: SupabaseConfig,
): Promise<ToolResult> {
  const params = new URLSearchParams({
    user_id: `eq.${config.userId}`,
    select: 'organizations(public_id,display_name,description,domain,website_url,verification_status)',
    'organizations.public_id': `eq.${input.public_id}`,
    limit: '1',
  });

  try {
    const response = await supabaseFetch(config, `/rest/v1/org_members?${params.toString()}`);
    if (!response.ok) {
      return errorResult(`Organization detail lookup failed: HTTP ${response.status}`);
    }

    const memberships = await response.json() as Array<Record<string, unknown>>;
    const org = Array.isArray(memberships)
      ? (memberships
          .map((m) => m.organizations)
          .find((value): value is Record<string, unknown> =>
            typeof value === 'object' && value !== null) ?? null)
      : null;

    if (!org) return errorResult(`Organization ${input.public_id} was not found.`);

    const stringOrNull = (value: unknown): string | null =>
      typeof value === 'string' && value.length > 0 ? value : null;

    return textResult({
      public_id: stringOrNull(org.public_id),
      display_name: stringOrNull(org.display_name),
      description: stringOrNull(org.description),
      domain: stringOrNull(org.domain),
      website_url: stringOrNull(org.website_url),
      verification_status: stringOrNull(org.verification_status),
    });
  } catch (error) {
    const msg = error instanceof Error && error.name === 'AbortError'
      ? 'Organization detail lookup timed out'
      : `Organization detail lookup failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    return errorResult(msg);
  }
}

/**
 * List organizations available to the authenticated MCP caller by joining
 * through org_members. The edge worker still uses the service-role key for
 * PostgREST, so the user_id filter is explicit and never delegated to RLS.
 */
export async function handleAgentListOrgs(config: SupabaseConfig): Promise<ToolResult> {
  const params = new URLSearchParams({
    user_id: `eq.${config.userId}`,
    select: 'role,organizations(public_id,display_name,domain,website_url,verification_status)',
    limit: '50',
  });

  try {
    const response = await supabaseFetch(config, `/rest/v1/org_members?${params.toString()}`);
    if (!response.ok) {
      return errorResult(`List organizations failed: HTTP ${response.status}`);
    }

    const memberships = await response.json() as Array<Record<string, unknown>>;
    const organizations = (Array.isArray(memberships) ? memberships : []).map((membership) => {
      const org = membership.organizations as Record<string, unknown> | null | undefined;
      return {
        public_id: org?.public_id,
        display_name: org?.display_name,
        domain: org?.domain ?? null,
        website_url: org?.website_url ?? null,
        verification_status: org?.verification_status ?? null,
        role: membership.role,
      };
    }).filter((org) => org.public_id);

    return textResult({ organizations });
  } catch (error) {
    const msg = error instanceof Error && error.name === 'AbortError'
      ? 'List organizations timed out'
      : `List organizations failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
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
    case 'PENDING':
      return 'PENDING';
    case 'SUBMITTED':
      return 'SUBMITTED';
    default:
      return 'UNKNOWN';
  }
}

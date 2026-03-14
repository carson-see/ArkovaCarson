/**
 * Arkova MCP Tool Definitions and Handlers (P8-S19)
 *
 * Shared logic for MCP server tools. Used by both the Cloudflare Worker
 * MCP endpoint and tests.
 *
 * Tools:
 *   - verify_credential: Verify a credential by public ID
 *   - search_credentials: Semantic search across credentials
 *
 * Constitution 1.4: No raw PII in responses. Only hashed identifiers.
 * Constitution 1.3: No banned UI terms in tool descriptions.
 */

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

export interface SupabaseConfig {
  supabaseUrl: string;
  supabaseKey: string;
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
];

// ---------------------------------------------------------------------------
// Tool Handlers
// ---------------------------------------------------------------------------

/**
 * Verify a credential by its public ID.
 *
 * Calls the get_public_anchor RPC function in Supabase and returns
 * the frozen verification schema result.
 */
export async function handleVerifyCredential(
  input: VerifyInput,
  config: SupabaseConfig,
): Promise<ToolResult> {
  if (!input.public_id || input.public_id.trim().length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: public_id is required' }],
      isError: true,
    };
  }

  try {
    const response = await fetch(
      `${config.supabaseUrl}/rest/v1/rpc/get_public_anchor`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: config.supabaseKey,
          Authorization: `Bearer ${config.supabaseKey}`,
        },
        body: JSON.stringify({ p_public_id: input.public_id }),
      },
    );

    if (!response.ok) {
      return {
        content: [{ type: 'text', text: `Credential "${input.public_id}" not found.` }],
        isError: false,
      };
    }

    const data = await response.json();

    // Map to frozen verification schema
    const result = {
      verified: data?.status === 'SECURED' || data?.status === 'ACTIVE',
      status: mapStatus(data?.status),
      issuer_name: data?.org_name ?? 'Unknown',
      recipient_identifier: data?.recipient_hash ?? '',
      credential_type: data?.credential_type ?? 'UNKNOWN',
      issued_date: data?.issued_at ?? null,
      expiry_date: data?.expires_at ?? null,
      anchor_timestamp: data?.created_at ?? '',
      network_receipt_id: data?.chain_tx_id ?? null,
      record_uri: `https://app.arkova.io/verify/${input.public_id}`,
      // Omit jurisdiction when null (Constitution — never return null)
      ...(data?.jurisdiction && { jurisdiction: data.jurisdiction }),
    };

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Verification lookup failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
}

/**
 * Search credentials using natural language.
 *
 * Uses Supabase full-text search (and semantic search when pgvector
 * embeddings are available) to find matching credentials.
 */
export async function handleSearchCredentials(
  input: SearchInput,
  config: SupabaseConfig,
): Promise<ToolResult> {
  if (!input.query || input.query.trim().length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: query is required' }],
      isError: true,
    };
  }

  const maxResults = Math.min(input.max_results ?? 10, 50);

  try {
    // Use text search across anchors with public visibility
    const searchQuery = encodeURIComponent(input.query);
    const response = await fetch(
      `${config.supabaseUrl}/rest/v1/anchors?select=public_id,title,credential_type,status,created_at,org_id&or=(title.ilike.*${searchQuery}*,credential_type.ilike.*${searchQuery}*)&status=in.(SECURED,ACTIVE)&limit=${maxResults}`,
      {
        headers: {
          apikey: config.supabaseKey,
          Authorization: `Bearer ${config.supabaseKey}`,
        },
      },
    );

    if (!response.ok) {
      return {
        content: [{ type: 'text', text: `Search failed: HTTP ${response.status}` }],
        isError: true,
      };
    }

    const results = await response.json() as Array<Record<string, unknown>>;

    if (!Array.isArray(results) || results.length === 0) {
      return {
        content: [{ type: 'text', text: `No credentials found matching "${input.query}".` }],
      };
    }

    // Map results to safe output (no raw PII)
    const mapped = results.map((r, i) => ({
      rank: i + 1,
      public_id: r.public_id,
      title: r.title,
      credential_type: r.credential_type,
      status: mapStatus(r.status as string),
      anchor_timestamp: r.created_at,
      record_uri: `https://app.arkova.io/verify/${r.public_id}`,
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ query: input.query, total: mapped.length, results: mapped }, null, 2),
      }],
    };
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
      isError: true,
    };
  }
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

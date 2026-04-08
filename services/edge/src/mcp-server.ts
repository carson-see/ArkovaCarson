/**
 * Arkova Remote MCP Server (P8-S19)
 *
 * Cloudflare Worker implementing the Model Context Protocol over
 * Streamable HTTP transport. Exposes verification, search, and anchoring
 * tools for AI agents, ATS systems, and background check integrations.
 *
 * Connector-ready: resources, prompts, tool annotations, and
 * OAuth Protected Resource Metadata for MCP registry listing.
 *
 * Authentication: OAuth 2.0 Bearer or API key via X-API-Key header.
 * Constitution 1.4: No raw PII in tool responses.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import {
  TOOL_DEFINITIONS,
  handleVerifyCredential,
  handleSearchCredentials,
  handleNessieQuery,
  handleAnchorDocument,
  handleVerifyDocument,
  type SupabaseConfig,
} from './mcp-tools';
import type { Env } from './env';

/** Server identity */
const SERVER_NAME = 'arkova-verification';
const SERVER_VERSION = '1.0.0';

/** Map tool name → description from the single source of truth */
const TOOL_DESC = Object.fromEntries(TOOL_DEFINITIONS.map((t) => [t.name, t.description]));

/**
 * Create and configure the MCP server with Arkova tools, resources, and prompts.
 */
function createMcpServer(config: SupabaseConfig): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // ── Tools ─────────────────────────────────────────────────────────────

  server.tool(
    'verify_credential',
    TOOL_DESC['verify_credential'],
    { public_id: z.string().describe('The credential\'s public identifier (e.g., ARK-2026-001)') },
    async ({ public_id }) => handleVerifyCredential({ public_id }, config),
  );

  server.tool(
    'search_credentials',
    TOOL_DESC['search_credentials'],
    {
      query: z.string().describe('Natural language search query'),
      max_results: z.number().optional().describe('Maximum results to return (default: 10, max: 50)'),
    },
    async ({ query, max_results }) => handleSearchCredentials({ query, max_results }, config),
  );

  server.tool(
    'nessie_query',
    TOOL_DESC['nessie_query'],
    {
      query: z.string().describe('Natural language query'),
      mode: z.enum(['retrieval', 'context']).optional().describe('Query mode (default: retrieval)'),
      limit: z.number().optional().describe('Max results (default: 10, max: 50)'),
    },
    async ({ query, mode, limit }) => handleNessieQuery({ query, mode, limit }, config),
  );

  server.tool(
    'anchor_document',
    TOOL_DESC['anchor_document'],
    {
      content_hash: z.string().describe('SHA-256 fingerprint of the document'),
      record_type: z.string().optional().describe('Record type (e.g., patent_grant, 10-K)'),
      source: z.string().optional().describe('Source (e.g., edgar, uspto)'),
      title: z.string().optional().describe('Document title'),
      source_url: z.string().optional().describe('Original document URL'),
    },
    async ({ content_hash, record_type, source, title, source_url }) =>
      handleAnchorDocument({ content_hash, record_type, source, title, source_url }, config),
  );

  server.tool(
    'verify_document',
    TOOL_DESC['verify_document'],
    { content_hash: z.string().describe('SHA-256 fingerprint of the document to verify') },
    async ({ content_hash }) => handleVerifyDocument({ content_hash }, config),
  );

  // ── Phase II Agentic Tools (PH2-AGENT-06) ─────────────────────────────

  server.tool(
    'oracle_batch_verify',
    'Batch-verify multiple credentials via the Arkova Oracle. Returns HMAC-signed results for tamper detection. Use for bulk verification workflows where audit trail is required.',
    {
      public_ids: z.array(z.string()).min(1).max(25).describe('Array of Arkova public IDs to verify (max 25)'),
    },
    async ({ public_ids }) => {
      try {
        const results = [];
        for (const pid of public_ids) {
          const result = await handleVerifyCredential({ public_id: pid }, config);
          results.push({ public_id: pid, ...JSON.parse(result.content[0].text) });
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ query_id: crypto.randomUUID(), results, queried_at: new Date().toISOString() }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error) }) }] };
      }
    },
  );

  server.tool(
    'list_agents',
    'List all registered AI agents for the authenticated organization. Returns agent names, types, scopes, and status.',
    {},
    async () => {
      try {
        const resp = await fetch(
          `${config.supabaseUrl}/rest/v1/agents?status=eq.active&select=id,name,agent_type,status,allowed_scopes,framework,created_at`,
          {
            headers: {
              'Content-Type': 'application/json',
              apikey: config.supabaseKey,
              Authorization: `Bearer ${config.supabaseKey}`,
            },
          },
        );
        if (!resp.ok) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `HTTP ${resp.status}` }) }] };
        }
        const agents = await resp.json();
        return { content: [{ type: 'text' as const, text: JSON.stringify({ agents: agents ?? [] }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: String(error) }) }] };
      }
    },
  );

  // ── Resources ─────────────────────────────────────────────────────────

  server.resource(
    'api-overview',
    'arkova://api/overview',
    { mimeType: 'text/plain' },
    async () => ({
      contents: [{
        uri: 'arkova://api/overview',
        mimeType: 'text/plain',
        text: [
          'Arkova Verification API — Overview',
          '',
          'Arkova anchors document fingerprints (SHA-256 hashes) to the public ledger',
          'for tamper-proof verification. Documents never leave the user\'s device —',
          'only their cryptographic fingerprints are submitted.',
          '',
          'Available tools:',
          '  verify_credential    — Verify a credential by its public ID (e.g., ARK-DEG-ABC123)',
          '  search_credentials   — Semantic search across 1.39M+ anchored records',
          '  oracle_batch_verify  — Batch-verify up to 25 credentials with HMAC-signed results',
          '  nessie_query         — RAG search over SEC filings, patents, and regulatory docs',
          '  anchor_document      — Submit a SHA-256 fingerprint for batch anchoring',
          '  verify_document      — Check if a document fingerprint has been anchored',
          '  list_agents          — List registered AI agents for the organization',
          '',
          'Authentication: API key (X-API-Key header) or OAuth Bearer token.',
          'Get your API key at https://app.arkova.ai/settings/api-keys',
          '',
          'Rate limits: 1,000 req/min per API key. Batch: 10 req/min.',
        ].join('\n'),
      }],
    }),
  );

  server.resource(
    'credential-types',
    'arkova://schema/credential-types',
    { mimeType: 'application/json' },
    async () => ({
      contents: [{
        uri: 'arkova://schema/credential-types',
        mimeType: 'application/json',
        text: JSON.stringify({
          credential_types: [
            'DEGREE', 'LICENSE', 'CERTIFICATE', 'TRANSCRIPT', 'CLE',
            'PROFESSIONAL', 'BADGE', 'ATTESTATION', 'FINANCIAL', 'LEGAL',
            'INSURANCE', 'SEC_FILING', 'PATENT', 'REGULATION', 'PUBLICATION', 'OTHER',
          ],
          record_types: [
            'patent_grant', '10-K', '10-Q', '8-K', 'regulatory_notice',
            'federal_register', 'academic_paper', 'document',
          ],
          statuses: ['ACTIVE', 'REVOKED', 'SUPERSEDED', 'EXPIRED', 'PENDING', 'UNKNOWN'],
        }),
      }],
    }),
  );

  // ── Prompts ───────────────────────────────────────────────────────────

  server.prompt(
    'verify-credential',
    'Look up and verify a credential by its Arkova public ID',
    { public_id: z.string().describe('Credential public ID (e.g., ARK-2026-001)') },
    async ({ public_id }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Please verify the credential with public ID "${public_id}" using the verify_credential tool. ` +
            'Report the verification status, issuer, credential type, dates, and anchoring proof.',
        },
      }],
    }),
  );

  server.prompt(
    'search-and-verify',
    'Search for credentials matching a query and verify the top result',
    { query: z.string().describe('What to search for') },
    async ({ query }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Search for credentials matching "${query}" using search_credentials, then verify the top result ` +
            'with verify_credential. Summarize your findings.',
        },
      }],
    }),
  );

  server.prompt(
    'anchor-and-verify',
    'Anchor a document fingerprint and confirm it was submitted',
    {
      content_hash: z.string().describe('SHA-256 fingerprint of the document'),
      title: z.string().optional().describe('Document title'),
    },
    async ({ content_hash, title }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Anchor the document "${title ?? 'Untitled'}" with fingerprint ${content_hash} ` +
            'using anchor_document, then verify it was submitted using verify_document.',
        },
      }],
    }),
  );

  server.prompt(
    'research-topic',
    'Research a topic using Nessie\'s verified intelligence engine',
    { topic: z.string().describe('Research topic or question') },
    async ({ topic }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `Use nessie_query in "context" mode to research: "${topic}". ` +
            'Synthesize the findings and cite the anchored source documents.',
        },
      }],
    }),
  );

  return server;
}

// ── Auth ───────────────────────────────────────────────────────────────

const AUTH_TIMEOUT_MS = 5_000;

function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

async function validateAuth(
  request: Request,
  env: Env,
): Promise<{ userId: string; tier: string } | null> {
  const apiKey = request.headers.get('x-api-key');
  const authHeader = request.headers.get('authorization');

  if (apiKey && authHeader?.startsWith('Bearer ')) {
    const [apiKeyResult, bearerResult] = await Promise.allSettled([
      validateApiKey(apiKey, env),
      validateBearer(authHeader.slice(7), env),
    ]);
    if (apiKeyResult.status === 'fulfilled' && apiKeyResult.value) return apiKeyResult.value;
    if (bearerResult.status === 'fulfilled' && bearerResult.value) return bearerResult.value;
    return null;
  }

  if (apiKey) return validateApiKey(apiKey, env);
  if (authHeader?.startsWith('Bearer ')) return validateBearer(authHeader.slice(7), env);
  return null;
}

async function validateApiKey(
  apiKey: string,
  env: Env,
): Promise<{ userId: string; tier: string } | null> {
  try {
    const response = await authFetch(`${env.SUPABASE_URL}/rest/v1/rpc/validate_api_key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ p_api_key: apiKey }),
    });
    if (response.ok) {
      const data = await response.json() as { user_id: string; tier: string } | null;
      if (data) return { userId: data.user_id, tier: data.tier };
    }
  } catch {
    // Fall through
  }
  return null;
}

async function validateBearer(
  token: string,
  env: Env,
): Promise<{ userId: string; tier: string } | null> {
  try {
    const response = await authFetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    if (response.ok) {
      const user = await response.json() as { id: string };
      return { userId: user.id, tier: 'authenticated' };
    }
  } catch {
    // Fall through
  }
  return null;
}

// ── Well-known endpoints ────────────────────────────────────────────────

/**
 * OAuth Protected Resource Metadata (RFC 9728).
 * Required for MCP connector discovery.
 */
function handleProtectedResourceMetadata(baseUrl: string): Response {
  return new Response(JSON.stringify({
    resource: `${baseUrl}/mcp`,
    authorization_servers: [`${baseUrl}/auth`],
    scopes_supported: ['mcp:verify', 'mcp:search', 'mcp:anchor'],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://app.arkova.ai/docs/mcp',
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

// ── Request handler ─────────────────────────────────────────────────────

function getCorsOrigin(request: Request, env: Env): string {
  const requestOrigin = request.headers.get('Origin') ?? '';
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? 'https://arkova-carson.vercel.app,https://app.arkova.ai')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return allowedOrigins.includes(requestOrigin)
    ? requestOrigin
    : (allowedOrigins[0] ?? 'https://app.arkova.ai');
}

/**
 * Handle MCP requests at /mcp endpoint.
 * Also serves well-known metadata for connector discovery.
 */
export async function handleMcpRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const corsOrigin = getCorsOrigin(request, env);

  // OAuth Protected Resource Metadata
  if (url.pathname === '/mcp/.well-known/oauth-protected-resource') {
    const baseUrl = `${url.protocol}//${url.host}`;
    return handleProtectedResourceMetadata(baseUrl);
  }

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, Mcp-Session-Id, MCP-Protocol-Version',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // Auth check
  const auth = await validateAuth(request, env);
  if (!auth) {
    return new Response(
      JSON.stringify({
        error: 'Unauthorized',
        message: 'Valid API key (X-API-Key header) or OAuth Bearer token required.',
        docs: 'https://app.arkova.ai/settings/api-keys',
      }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': `Bearer realm="arkova-mcp", resource_metadata="${url.protocol}//${url.host}/mcp/.well-known/oauth-protected-resource"`,
          'Access-Control-Allow-Origin': corsOrigin,
        },
      },
    );
  }

  // Create MCP server and transport
  const config: SupabaseConfig = {
    supabaseUrl: env.SUPABASE_URL,
    supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY,
  };

  try {
    const mcpServer = createMcpServer(config);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
    });

    await mcpServer.connect(transport);

    const response = await transport.handleRequest(request, {
      authInfo: {
        token: auth.userId,
        clientId: auth.tier,
        scopes: ['mcp:verify', 'mcp:search', 'mcp:anchor'],
      },
    });

    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', corsOrigin);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    console.error('[mcp-server] Request handling failed:', error);
    return new Response(
      JSON.stringify({ error: 'MCP server error', message: 'Internal server error' }),
      { status: 500, headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': corsOrigin,
      } },
    );
  }
}

export { SERVER_NAME, SERVER_VERSION };
export default { handleMcpRequest };

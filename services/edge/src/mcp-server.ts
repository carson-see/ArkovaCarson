/**
 * Arkova Remote MCP Server (P8-S19)
 *
 * Cloudflare Worker implementing the Model Context Protocol over
 * Streamable HTTP transport. Exposes verification and semantic search
 * tools for AI agents, ATS systems, and background check integrations.
 *
 * Uses @modelcontextprotocol/sdk McpServer + WebStandardStreamableHTTPServerTransport
 * for Cloudflare Workers compatibility.
 *
 * Authentication: OAuth 2.0 or API key via X-API-Key header.
 * Constitution 1.4: No raw PII in tool responses.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import {
  handleVerifyCredential,
  handleSearchCredentials,
  type SupabaseConfig,
} from './mcp-tools';
import type { Env } from './env';

/**
 * Create and configure the MCP server with Arkova tools.
 */
function createMcpServer(config: SupabaseConfig): McpServer {
  const server = new McpServer({
    name: 'arkova-verification',
    version: '1.0.0',
  });

  // ── Tool: verify_credential ──────────────────────────────────────────
  server.tool(
    'verify_credential',
    'Verify a credential\'s authenticity and current status by its public identifier. ' +
    'Returns verification status, issuer information, credential type, dates, and network anchoring proof.',
    {
      public_id: z.string().describe('The credential\'s public identifier (e.g., ARK-2026-001)'),
    },
    async ({ public_id }) => {
      return handleVerifyCredential({ public_id }, config);
    },
  );

  // ── Tool: search_credentials ─────────────────────────────────────────
  server.tool(
    'search_credentials',
    'Search for credentials using natural language queries. ' +
    'Uses semantic similarity matching to find relevant credentials. ' +
    'Returns ranked results with verification status and relevance scores.',
    {
      query: z.string().describe('Natural language search query'),
      max_results: z.number().optional().describe('Maximum results to return (default: 10, max: 50)'),
    },
    async ({ query, max_results }) => {
      return handleSearchCredentials({ query, max_results }, config);
    },
  );

  return server;
}

/**
 * Validate API key or OAuth token from request headers.
 * Returns auth info if valid, null if unauthorized.
 */
async function validateAuth(
  request: Request,
  env: Env,
): Promise<{ userId: string; tier: string } | null> {
  // Check X-API-Key header
  const apiKey = request.headers.get('x-api-key');
  if (apiKey) {
    // Validate against Supabase api_keys table (HMAC-SHA256 hashed)
    try {
      const response = await fetch(
        `${env.SUPABASE_URL}/rest/v1/rpc/validate_api_key`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          },
          body: JSON.stringify({ p_api_key: apiKey }),
        },
      );

      if (response.ok) {
        const data = await response.json() as { user_id: string; tier: string } | null;
        if (data) {
          return { userId: data.user_id, tier: data.tier };
        }
      }
    } catch {
      // Fall through to unauthorized
    }
  }

  // Check Bearer token (OAuth)
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const response = await fetch(
        `${env.SUPABASE_URL}/auth/v1/user`,
        {
          headers: {
            apikey: env.SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${token}`,
          },
        },
      );

      if (response.ok) {
        const user = await response.json() as { id: string };
        return { userId: user.id, tier: 'authenticated' };
      }
    } catch {
      // Fall through to unauthorized
    }
  }

  return null;
}

/**
 * Handle MCP requests at /mcp endpoint.
 */
export async function handleMcpRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
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
        docs: 'https://app.arkova.io/settings/api-keys',
      }),
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  // Create MCP server and transport
  const config: SupabaseConfig = {
    supabaseUrl: env.SUPABASE_URL,
    supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY,
  };

  const mcpServer = createMcpServer(config);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
  });

  await mcpServer.connect(transport);

  // Handle the request
  const response = await transport.handleRequest(request, {
    authInfo: {
      token: auth.userId,
      clientId: auth.tier,
      scopes: ['verify', 'search'],
    },
  });

  // Add CORS headers to response
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default { handleMcpRequest };

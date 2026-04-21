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
  handleVerifyBatch,
  type SupabaseConfig,
  type ToolResult,
} from './mcp-tools';
import type { Env } from './env';
import { fireAndForgetAudit, type McpAuditEntry } from './mcp-audit-log';
import { enforceRateLimit } from './mcp-rate-limit';
import { fenceUserInput, SAFETY_PREFIX } from './mcp-prompt-safety';

/** Server identity */
const SERVER_NAME = 'arkova-verification';
const SERVER_VERSION = '1.0.0';

/** Map tool name → description from the single source of truth */
const TOOL_DESC = Object.fromEntries(TOOL_DEFINITIONS.map((t) => [t.name, t.description]));

// ── Input validators ─────────────────────────────────────────────────────
// Tightened after the 2026-04-20 MCP security audit — bare `z.string()` let
// callers submit arbitrary shapes into tools that hand the value to
// Supabase REST / RPC paths. Explicit format checks fail closed.
const PUBLIC_ID_RE = /^ARK-[A-Z0-9-]{3,60}$/;
const SHA256_HEX_RE = /^[a-fA-F0-9]{64}$/;
const publicIdSchema = z.string().regex(PUBLIC_ID_RE, 'public_id must match ARK-<TYPE>-<SUFFIX>').max(64);
const contentHashSchema = z.string().regex(SHA256_HEX_RE, 'content_hash must be 64 hex chars').length(64);
const freeTextQuerySchema = z.string().min(1).max(500);

/** Scrub tool handler errors before they reach the MCP client — raw
 *  `String(error)` was leaking stack traces + internal URLs. */
function safeErrorText(err: unknown, context: string): string {
  console.error(`[mcp-server] ${context}:`, err);
  return JSON.stringify({ error: `${context} failed`, code: 'TOOL_ERROR' });
}

/** Extended handler config — now includes the authenticated caller's
 *  user id so tools can scope queries instead of running service-role
 *  with no filter (the 2026-04-20 `list_agents` cross-org leak). */
interface ScopedConfig extends SupabaseConfig {
  userId: string;
}

/** Per-request telemetry context — threaded into every tool invocation so
 *  SEC-01 rate limiting + SEC-06 audit logging can scope to the caller. */
interface RequestTelemetryContext {
  env: Env;
  execCtx: ExecutionContext;
  apiKeyId: string | null;
  userId: string;
  clientIp: string | null;
}

/** Higher-order wrapper that gives every tool handler:
 *   1. per-API-key rate limiting (SEC-01)
 *   2. fire-and-forget audit logging with (toolName, outcome, latencyMs) (SEC-06)
 *
 *  Rate-limit denial returns an MCP tool error (no HTTP 429 — that'd bypass
 *  the SDK's response envelope). Downstream agents can parse the error body
 *  to read `retry_after_seconds`.
 *
 *  The `args` type is loosely-typed `Record<string, any>` to match the MCP
 *  SDK's `ToolCb` signature (see `ToolCb` alias above). Call-sites destructure
 *  the shape they expect; Zod has already validated the input by the time
 *  this wrapper runs. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyArgs = Record<string, any>;
function withTelemetry(
  toolName: string,
  handler: (args: AnyArgs) => Promise<ToolResult>,
  telemetry: RequestTelemetryContext,
): (args: AnyArgs) => Promise<ToolResult> {
  return async (args: AnyArgs): Promise<ToolResult> => {
    const started = Date.now();
    const argsJson = JSON.stringify(args ?? {});
    let outcome: McpAuditEntry['outcome'] = 'success';

    const logOnce = (): void =>
      fireAndForgetAudit(
        telemetry.env,
        {
          apiKeyId: telemetry.apiKeyId,
          userId: telemetry.userId,
          toolName,
          argsJson,
          outcome,
          latencyMs: Date.now() - started,
          clientIp: telemetry.clientIp,
        },
        telemetry.execCtx,
      );

    const decision = await enforceRateLimit(telemetry.env, telemetry.apiKeyId, toolName);
    if (!decision.ok) {
      outcome = 'rate_limited';
      logOnce();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: 'rate_limit_exceeded',
            tool: decision.toolName,
            limit_per_minute: decision.limit,
            retry_after_seconds: decision.retryAfterSeconds,
          }),
        }],
        isError: true,
      };
    }

    try {
      const result = await handler(args);
      if (result.isError) outcome = 'tool_error';
      return result;
    } catch (err) {
      outcome = 'tool_error';
      throw err;
    } finally {
      logOnce();
    }
  };
}

/**
 * Create and configure the MCP server with Arkova tools, resources, and prompts.
 *
 * `telemetry` carries the per-request context needed by SEC-01 rate limiting
 * + SEC-06 audit logging. Every tool handler is wrapped by `withTelemetry`.
 */
function createMcpServer(config: ScopedConfig, telemetry: RequestTelemetryContext): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // Workaround for TS2589 "Type instantiation is excessively deep" on zod
  // 3.25 + @modelcontextprotocol/sdk 1.29. The generic inference on
  // `server.tool(name, desc, shape, cb)` AND `server.prompt(name, desc, shape, cb)`
  // blows up when Zod's recursive types meet the SDK's ZodRawShapeCompat
  // overload. The non-deprecated `registerTool` / `registerPrompt` APIs don't
  // hit this — full migration tracked as a follow-up. For now locally-typed
  // aliases bypass the deep inference while preserving the callback contract.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type ToolCb = (args: Record<string, any>) => Promise<unknown> | unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool: (name: string, description: string, shape: Record<string, unknown>, cb: ToolCb) => unknown = server.tool.bind(server) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type PromptCb = (args: Record<string, any>) => Promise<unknown> | unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prompt: (name: string, description: string, shape: Record<string, unknown>, cb: PromptCb) => unknown = server.prompt.bind(server) as any;

  // ── Tools ─────────────────────────────────────────────────────────────

  tool(
    'verify_credential',
    TOOL_DESC['verify_credential'],
    { public_id: publicIdSchema.describe('The credential\'s public identifier (e.g., ARK-2026-001)') },
    withTelemetry(
      'verify_credential',
      async ({ public_id }) => handleVerifyCredential({ public_id }, config),
      telemetry,
    ),
  );

  tool(
    'search_credentials',
    TOOL_DESC['search_credentials'],
    {
      query: freeTextQuerySchema.describe('Natural language search query'),
      max_results: z.number().int().min(1).max(50).optional().describe('Maximum results to return (default: 10, max: 50)'),
    },
    withTelemetry(
      'search_credentials',
      async ({ query, max_results }) => handleSearchCredentials({ query, max_results }, config),
      telemetry,
    ),
  );

  tool(
    'nessie_query',
    TOOL_DESC['nessie_query'],
    {
      query: freeTextQuerySchema.describe('Natural language query'),
      mode: z.enum(['retrieval', 'context']).optional().describe('Query mode (default: retrieval)'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default: 10, max: 50)'),
    },
    withTelemetry(
      'nessie_query',
      async ({ query, mode, limit }) => handleNessieQuery({ query, mode, limit }, config),
      telemetry,
    ),
  );

  tool(
    'anchor_document',
    TOOL_DESC['anchor_document'],
    {
      content_hash: contentHashSchema.describe('SHA-256 fingerprint of the document'),
      record_type: z.string().max(50).optional().describe('Record type (e.g., patent_grant, 10-K)'),
      source: z.string().max(50).optional().describe('Source (e.g., edgar, uspto)'),
      title: z.string().max(500).optional().describe('Document title'),
      source_url: z.string().url().max(2048).optional().describe('Original document URL'),
    },
    withTelemetry(
      'anchor_document',
      async ({ content_hash, record_type, source, title, source_url }) =>
        handleAnchorDocument({ content_hash, record_type, source, title, source_url }, config),
      telemetry,
    ),
  );

  tool(
    'verify_document',
    TOOL_DESC['verify_document'],
    { content_hash: contentHashSchema.describe('SHA-256 fingerprint of the document to verify') },
    withTelemetry(
      'verify_document',
      async ({ content_hash }) => handleVerifyDocument({ content_hash }, config),
      telemetry,
    ),
  );

  // ── INT-02: Batch verification ────────────────────────────────────────

  tool(
    'verify_batch',
    TOOL_DESC['verify_batch'],
    {
      public_ids: z
        .array(publicIdSchema)
        .min(1)
        .max(100)
        .describe('Array of credential public IDs (max 100). Results returned in input order.'),
    },
    withTelemetry(
      'verify_batch',
      async ({ public_ids }) => handleVerifyBatch({ public_ids }, config),
      telemetry,
    ),
  );

  // ── Phase II Agentic Tools (PH2-AGENT-06) ─────────────────────────────

  tool(
    'oracle_batch_verify',
    // NOTE 2026-04-20 MCP security audit: description previously claimed
    // "HMAC-signed results for tamper detection" — implementation did no
    // such signing. Claim removed; real HMAC signing tracked as MCP-SEC-02.
    'Batch-verify multiple credentials via the Arkova Oracle. Use for bulk verification workflows where an envelope with query_id + per-credential results is needed.',
    {
      public_ids: z.array(publicIdSchema).min(1).max(25).describe('Array of Arkova public IDs to verify (max 25)'),
    },
    withTelemetry(
      'oracle_batch_verify',
      async ({ public_ids }) => {
        try {
          const results = [];
          for (const pid of public_ids) {
            const result = await handleVerifyCredential({ public_id: pid }, config);
            results.push({ public_id: pid, ...JSON.parse(result.content[0].text) });
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify({ query_id: crypto.randomUUID(), results, queried_at: new Date().toISOString() }, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text' as const, text: safeErrorText(error, 'oracle_batch_verify') }], isError: true };
        }
      },
      telemetry,
    ),
  );

  tool(
    'list_agents',
    'List AI agents registered to the authenticated caller\'s organization. Returns agent names, types, scopes, and status.',
    {},
    withTelemetry(
      'list_agents',
      async () => {
        // MCP security fix 2026-04-20: prior implementation queried
        // /rest/v1/agents?status=eq.active with the service-role key and no
        // org filter — cross-org data leak. Replaced with SECURITY DEFINER
        // RPC get_agents_for_user(p_user_id) (migration 0221) that joins
        // through org_members and returns only the caller's org's agents.
        try {
          const resp = await fetch(
            `${config.supabaseUrl}/rest/v1/rpc/get_agents_for_user`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                apikey: config.supabaseKey,
                Authorization: `Bearer ${config.supabaseKey}`,
              },
              body: JSON.stringify({ p_user_id: config.userId }),
            },
          );
          if (!resp.ok) {
            return { content: [{ type: 'text' as const, text: safeErrorText(new Error(`HTTP ${resp.status}`), 'list_agents') }], isError: true };
          }
          const agents = await resp.json();
          return { content: [{ type: 'text' as const, text: JSON.stringify({ agents: Array.isArray(agents) ? agents : [] }, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text' as const, text: safeErrorText(error, 'list_agents') }], isError: true };
        }
      },
      telemetry,
    ),
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
          '  search_credentials   — Semantic search across the anchored records corpus',
          '  oracle_batch_verify  — Batch-verify up to 25 credentials with query-envelope metadata',
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

  // NOTE: 2026-04-20 MCP security audit (SCRUM-923 / MCP-SEC-05) —
  // user-supplied strings are wrapped in <user_input> fences via
  // `fenceUserInput` + the `SAFETY_PREFIX` preamble tells the downstream
  // LLM to treat fenced blocks as DATA, not INSTRUCTIONS. Prevents prompt
  // injection of the form `query="ignore previous instructions..."`.

  prompt(
    'verify-credential',
    'Look up and verify a credential by its Arkova public ID',
    { public_id: publicIdSchema.describe('Credential public ID (e.g., ARK-2026-001)') },
    async ({ public_id }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text:
            `${SAFETY_PREFIX}\n\n` +
            `Please verify the credential whose public ID is provided below using the verify_credential tool. ` +
            'Report the verification status, issuer, credential type, dates, and anchoring proof.\n\n' +
            fenceUserInput(public_id, 'public_id'),
        },
      }],
    }),
  );

  prompt(
    'search-and-verify',
    'Search for credentials matching a query and verify the top result',
    { query: freeTextQuerySchema.describe('What to search for') },
    async ({ query }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text:
            `${SAFETY_PREFIX}\n\n` +
            `Run search_credentials with the query provided below, then verify the top result with verify_credential. ` +
            'Summarize your findings.\n\n' +
            fenceUserInput(query, 'query'),
        },
      }],
    }),
  );

  prompt(
    'anchor-and-verify',
    'Anchor a document fingerprint and confirm it was submitted',
    {
      content_hash: contentHashSchema.describe('SHA-256 fingerprint of the document'),
      title: z.string().max(500).optional().describe('Document title'),
    },
    async ({ content_hash, title }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text:
            `${SAFETY_PREFIX}\n\n` +
            `Anchor the document described below using anchor_document, then verify it was submitted using verify_document.\n\n` +
            fenceUserInput(title ?? 'Untitled', 'title') + '\n' +
            fenceUserInput(content_hash, 'content_hash'),
        },
      }],
    }),
  );

  prompt(
    'research-topic',
    'Research a topic using Nessie\'s verified intelligence engine',
    { topic: freeTextQuerySchema.describe('Research topic or question') },
    async ({ topic }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text:
            `${SAFETY_PREFIX}\n\n` +
            `Use nessie_query in "context" mode to research the topic provided below. ` +
            'Synthesize the findings and cite the anchored source documents.\n\n' +
            fenceUserInput(topic, 'topic'),
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

/** Auth result shape — `apiKeyId` is present for X-API-Key auth, null for
 *  OAuth Bearer. Rate limiting + audit logging use it as the actor id when
 *  the caller is an API-key-holding agent. */
interface AuthResult {
  userId: string;
  tier: string;
  apiKeyId: string | null;
}

async function validateAuth(
  request: Request,
  env: Env,
): Promise<AuthResult | null> {
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
): Promise<AuthResult | null> {
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
      // The RPC may or may not return `api_key_id`; accept either shape.
      // When absent the rate limiter degrades to per-user bucketing via
      // userId (still accurate for per-caller counting).
      const data = await response.json() as
        | { user_id: string; tier: string; api_key_id?: string; id?: string }
        | null;
      if (data) {
        return {
          userId: data.user_id,
          tier: data.tier,
          apiKeyId: data.api_key_id ?? data.id ?? null,
        };
      }
    }
  } catch {
    // Fall through
  }
  return null;
}

async function validateBearer(
  token: string,
  env: Env,
): Promise<AuthResult | null> {
  try {
    const response = await authFetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    if (response.ok) {
      const user = await response.json() as { id: string };
      return { userId: user.id, tier: 'authenticated', apiKeyId: null };
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
  // 2026-04-20 MCP security audit: previous default listed the stale
  // `arkova-carson.vercel.app` host. Current prod front-end is
  // `arkova-26.vercel.app`; canonical is `app.arkova.ai`. Env var override
  // (`ALLOWED_ORIGINS`) still wins.
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? 'https://arkova-26.vercel.app,https://app.arkova.ai')
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
  ctx: ExecutionContext,
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

  // Create MCP server and transport. userId threaded through so tools can
  // org-scope their queries (see `list_agents` + get_agents_for_user RPC).
  const config: ScopedConfig = {
    supabaseUrl: env.SUPABASE_URL,
    supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY,
    userId: auth.userId,
  };

  // Per-request telemetry context for SEC-01 rate limiting + SEC-06 audit.
  // CF-Connecting-IP is the canonical client IP header on Cloudflare; falls
  // back to X-Forwarded-For if the edge is behind a different proxy.
  const clientIp =
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    null;

  const telemetry: RequestTelemetryContext = {
    env,
    execCtx: ctx,
    apiKeyId: auth.apiKeyId,
    userId: auth.userId,
    clientIp,
  };

  try {
    const mcpServer = createMcpServer(config, telemetry);

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

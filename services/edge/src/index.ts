/**
 * Arkova Edge Workers — Entry Point
 *
 * Routes requests to the appropriate edge worker handler.
 * Handles both HTTP fetch and Queue message consumption.
 *
 * AUDIT-03: All internal routes (/report, /ai-fallback, /crawl) require
 * authentication via X-Cron-Secret header. Only /mcp is API-key authenticated
 * (handled internally by mcp-server.ts).
 *
 * ADR: docs/confluence/15_zero_trust_edge_architecture.md
 */

import type { Env, BatchQueueMessage } from './env';

/**
 * Verify internal service auth via shared CRON_SECRET.
 * Returns null if valid, or a 401 Response if invalid.
 */
function verifyInternalAuth(request: Request, env: Env): Response | null {
  const secret = request.headers.get('X-Cron-Secret');
  if (!env.CRON_SECRET || !secret) {
    return new Response(
      JSON.stringify({ error: 'Authentication required' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Constant-time comparison to prevent timing attacks
  const expected = new TextEncoder().encode(env.CRON_SECRET);
  const actual = new TextEncoder().encode(secret);
  if (expected.length !== actual.length) {
    return new Response(
      JSON.stringify({ error: 'Invalid credentials' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }

  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected[i] ^ actual[i];
  }
  if (mismatch !== 0) {
    return new Response(
      JSON.stringify({ error: 'Invalid credentials' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }

  return null; // Auth passed
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check — no auth required
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'arkova-edge' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Internal routes — require CRON_SECRET auth
    if (url.pathname.startsWith('/report') || url.pathname.startsWith('/ai-fallback') || url.pathname.startsWith('/crawl')) {
      const authError = verifyInternalAuth(request, env);
      if (authError) return authError;
    }

    if (url.pathname.startsWith('/report')) {
      const { default: handler } = await import('./report-generator');
      return handler.fetch(request, env, ctx);
    }

    if (url.pathname.startsWith('/ai-fallback')) {
      const { default: handler } = await import('./ai-fallback');
      return handler.fetch(request, env, ctx);
    }

    if (url.pathname.startsWith('/crawl')) {
      const { default: handler } = await import('./cloudflare-crawler');
      return handler.fetch(request, env, ctx);
    }

    // x402 Facilitator (Item #16, RISK-7) — public endpoint for payment verification
    if (url.pathname.startsWith('/x402')) {
      const { handleX402Facilitator } = await import('./x402-facilitator');
      return handleX402Facilitator(request, env);
    }

    // MCP server — uses its own API key auth (handled internally)
    if (url.pathname.startsWith('/mcp')) {
      const { handleMcpRequest } = await import('./mcp-server');
      return handleMcpRequest(request, env);
    }

    return new Response('arkova-edge: no matching route', { status: 404 });
  },

  async queue(batch: MessageBatch<BatchQueueMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
    const { default: handler } = await import('./batch-queue');
    return handler.queue(batch, env, ctx);
  },
};

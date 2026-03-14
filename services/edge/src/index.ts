/**
 * Arkova Edge Workers — Entry Point
 *
 * Routes requests to the appropriate edge worker handler.
 * Handles both HTTP fetch and Queue message consumption.
 *
 * ADR: docs/confluence/15_zero_trust_edge_architecture.md
 */

import type { Env, BatchQueueMessage } from './env';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

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

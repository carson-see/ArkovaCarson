/**
 * Arkova Edge Workers — Entry Point
 *
 * Routes requests to the appropriate edge worker handler.
 * All workers are stubs until their INFRA stories are started.
 *
 * ADR: docs/confluence/15_zero_trust_edge_architecture.md
 */

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/report')) {
      const { default: handler } = await import('./report-generator');
      return handler.fetch(request, env, ctx);
    }

    if (url.pathname.startsWith('/ai-fallback')) {
      const { default: handler } = await import('./ai-fallback');
      return handler.fetch(request, env, ctx);
    }

    return new Response('arkova-edge: no matching route', { status: 404 });
  },

  async queue(batch: MessageBatch<unknown>, env: unknown, ctx: ExecutionContext): Promise<void> {
    const { default: handler } = await import('./batch-queue');
    return handler.queue(batch, env, ctx);
  },
};

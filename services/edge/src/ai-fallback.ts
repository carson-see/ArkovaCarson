/**
 * Cloudflare Workers AI Fallback Provider (INFRA-05)
 *
 * CloudflareAIProvider implementing IAIProvider interface.
 * Activates only when Gemini is unavailable (circuit breaker pattern).
 * Never called as primary — fallback only.
 *
 * Gated by ENABLE_AI_FALLBACK feature flag (default: false).
 *
 * STATUS: STUB — scaffolding only. No application logic until INFRA-05 is started.
 * DEPENDS ON: P8-S13 (IAIProvider interface)
 * ADR: docs/confluence/15_zero_trust_edge_architecture.md Section 3
 */

export default {
  async fetch(_request: Request, _env: unknown, _ctx: ExecutionContext): Promise<Response> {
    return new Response('ai-fallback: not implemented', { status: 501 });
  },
};

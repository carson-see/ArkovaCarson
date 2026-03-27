/**
 * Cloudflare Workers AI Fallback Provider (P8-S17)
 *
 * Uses Cloudflare Workers AI (Nemotron) as a FALLBACK when Gemini is unavailable.
 * NEVER used as primary provider (Constitution 1.1: @cloudflare/ai is fallback-only).
 *
 * Gated by ENABLE_AI_FALLBACK flag (default: false).
 *
 * In Express worker context (no Workers AI binding), this operates in degraded mode
 * returning lower-confidence results. Full Workers AI integration runs in the edge
 * worker (services/edge/src/ai-fallback.ts).
 */

import type { IAIProvider, ExtractionRequest, ExtractionResult, EmbeddingResult, ProviderHealth } from './types.js';

const CF_AI_MODEL = process.env.CF_AI_MODEL ?? '@cf/nvidia/nemotron';

export class CloudflareFallbackProvider implements IAIProvider {
  readonly name = 'cloudflare-workers-ai';
  private readonly model: string;

  constructor(model?: string) {
    this.model = model ?? CF_AI_MODEL;
  }

  async extractMetadata(request: ExtractionRequest): Promise<ExtractionResult> {
    // Degraded mode: basic heuristic extraction when no Workers AI binding
    // Real Workers AI inference happens in edge worker
    const fields = this.heuristicExtract(request.strippedText, request.credentialType);

    return {
      fields,
      confidence: 0.4, // Low confidence for heuristic fallback
      provider: this.name,
      tokensUsed: 0,
    };
  }

  async generateEmbedding(text: string, _taskType?: import('./types.js').EmbeddingTaskType): Promise<EmbeddingResult> {
    // Deterministic fallback embedding (hash-based)
    // Real embeddings come from Workers AI in edge worker
    const embedding = new Array(768).fill(0).map((_, i) => {
      const hash = this.simpleHash(text + i.toString());
      return (hash % 1000) / 1000;
    });

    return {
      embedding,
      model: `cloudflare-fallback/${this.model}`,
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const start = Date.now();

    // Check if we're in degraded mode (no Workers AI binding)
    const isDegraded = !process.env.CF_AI_BINDING;

    return {
      healthy: true,
      provider: this.name,
      latencyMs: Date.now() - start,
      mode: isDegraded ? 'degraded-heuristic' : 'workers-ai',
    };
  }

  /** Basic heuristic field extraction (no AI, just pattern matching) */
  private heuristicExtract(text: string, credentialType: string): Record<string, string> {
    const fields: Record<string, string> = { credentialType };

    // Extract year-like patterns as potential dates
    const yearMatch = text.match(/\b(19|20)\d{2}\b/);
    if (yearMatch) {
      fields.issuedDate = `${yearMatch[0]}-01-01`;
    }

    // Extract institution-like phrases (capitalized multi-word)
    const institutionMatch = text.match(/(?:University|College|Institute|School)\s+of\s+[\w\s]+/i);
    if (institutionMatch) {
      fields.issuerName = institutionMatch[0].trim();
    }

    return fields;
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return Math.abs(hash);
  }
}

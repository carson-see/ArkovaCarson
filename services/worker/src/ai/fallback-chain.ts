/**
 * GME-19: Multi-Model Fallback Chain
 *
 * Wraps multiple IAIProvider instances in a priority chain.
 * On retriable errors (429, 503, deprecation), automatically falls
 * back to the next provider. Non-retriable errors (validation, parse)
 * are thrown immediately — those are content issues, not model issues.
 *
 * Default chain: Gemini Tuned → Gemini Base → Nessie v5 → error
 *
 * Tracks per-model metrics for observability.
 */

import type {
  IAIProvider,
  ExtractionRequest,
  ExtractionResult,
  EmbeddingResult,
  EmbeddingTaskType,
  ProviderHealth,
} from './types.js';

/** Per-model success/failure counters */
export interface ModelMetrics {
  successes: number;
  failures: number;
  lastUsed: string | null;
  lastError: string | null;
}

export type FallbackMetrics = Record<string, ModelMetrics>;

export type FallbackReason =
  | 'rate_limit'
  | 'provider_unavailable'
  | 'timeout'
  | 'model_deprecated'
  | 'provider_error';

export interface ProviderFallbackEvent {
  event: 'provider_fallback';
  fromProvider: string;
  toProvider: string;
  reason: FallbackReason;
}

export interface FallbackChainOptions {
  onFallback?: (event: ProviderFallbackEvent) => void;
}

/** Errors that should trigger fallback to next provider */
function isRetriableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  // HTTP status-based retriable errors
  const status = (error as Error & { status?: number }).status;
  if (status === 429 || status === 503 || status === 502 || status === 504) {
    return true;
  }

  // Deprecation errors
  const msg = error.message.toLowerCase();
  if (msg.includes('deprecated') || msg.includes('unavailable') || msg.includes('not found')) {
    return true;
  }

  // Rate limit messages
  if (msg.includes('rate limit') || msg.includes('quota exceeded')) {
    return true;
  }

  return false;
}

function fallbackReason(error: unknown): FallbackReason {
  if (!(error instanceof Error)) return 'provider_error';

  const status = (error as Error & { status?: number }).status;
  if (status === 429) return 'rate_limit';
  if (status === 502 || status === 503 || status === 504) return 'provider_unavailable';

  const msg = error.message.toLowerCase();
  if (msg.includes('rate limit') || msg.includes('quota exceeded')) return 'rate_limit';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('deprecated')) return 'model_deprecated';
  if (msg.includes('unavailable') || msg.includes('not found')) return 'provider_unavailable';

  return 'provider_error';
}

export class FallbackChainProvider implements IAIProvider {
  readonly name = 'fallback-chain';
  private readonly metrics: FallbackMetrics = {};

  constructor(
    private readonly providers: IAIProvider[],
    private readonly options: FallbackChainOptions = {},
  ) {
    if (providers.length === 0) {
      throw new Error('FallbackChainProvider requires at least one provider');
    }
    for (const p of providers) {
      this.metrics[p.name] = {
        successes: 0,
        failures: 0,
        lastUsed: null,
        lastError: null,
      };
    }
  }

  async extractMetadata(request: ExtractionRequest): Promise<ExtractionResult> {
    let lastError: Error | undefined;

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i];
      try {
        const result = await provider.extractMetadata(request);
        this.metrics[provider.name].successes++;
        this.metrics[provider.name].lastUsed = new Date().toISOString();
        return result;
      } catch (error) {
        this.metrics[provider.name].failures++;
        this.metrics[provider.name].lastError =
          error instanceof Error ? error.message : String(error);

        if (!isRetriableError(error)) {
          // Non-retriable: don't fall back, throw immediately
          throw error;
        }

        lastError = error instanceof Error ? error : new Error(String(error));

        // Last provider in chain — no more fallbacks
        if (i === this.providers.length - 1) {
          throw lastError;
        }

        this.options.onFallback?.({
          event: 'provider_fallback',
          fromProvider: provider.name,
          toProvider: this.providers[i + 1].name,
          reason: fallbackReason(error),
        });

        // Fall through to next provider
      }
    }

    // Should never reach here, but TypeScript needs it
    throw lastError ?? new Error('All providers in fallback chain failed');
  }

  async generateEmbedding(
    text: string,
    taskType?: EmbeddingTaskType,
  ): Promise<EmbeddingResult> {
    // Embeddings: try first provider that supports it
    for (const provider of this.providers) {
      try {
        return await provider.generateEmbedding(text, taskType);
      } catch {
        continue;
      }
    }
    throw new Error('No provider in fallback chain supports embeddings');
  }

  async healthCheck(): Promise<ProviderHealth> {
    const results = await Promise.allSettled(
      this.providers.map((p) => p.healthCheck()),
    );

    const statuses = results.map((r, i) => {
      const name = this.providers[i].name;
      if (r.status === 'fulfilled') {
        return `${name}:${r.value.healthy ? 'up' : 'down'}`;
      }
      return `${name}:error`;
    });

    const anyHealthy = results.some(
      (r) => r.status === 'fulfilled' && r.value.healthy,
    );

    const maxLatency = results.reduce((max, r) => {
      if (r.status === 'fulfilled') return Math.max(max, r.value.latencyMs);
      return max;
    }, 0);

    return {
      healthy: anyHealthy,
      provider: this.name,
      latencyMs: maxLatency,
      mode: statuses.join(','),
    };
  }

  /** Get per-model metrics for observability */
  getMetrics(): FallbackMetrics {
    return { ...this.metrics };
  }
}

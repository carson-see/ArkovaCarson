/**
 * AI Provider Factory (P8-S17)
 *
 * Routes to the correct IAIProvider implementation based on AI_PROVIDER env var.
 *
 * Provider routing:
 *   'gemini'     → GeminiProvider (default when GEMINI_API_KEY set)
 *   'nessie'     → NessieProvider (fine-tuned Llama 3.1 8B on RunPod vLLM)
 *   'together'   → TogetherProvider (Together AI hosted inference)
 *   'cloudflare' → CloudflareFallbackProvider (ENABLE_AI_FALLBACK must be true)
 *   'openai'     → Not yet implemented (Phase 1.5+)
 *   'anthropic'  → Not yet implemented (Phase 1.5+)
 *   'mock'       → MockAIProvider (tests and development)
 *
 * Hybrid routing: When both Nessie and Gemini are available, routes per-request
 * based on credential type. Nessie handles types where v5 scored >85% weighted F1;
 * Gemini handles weaker types and user uploads.
 *
 * Constitution: @cloudflare/ai is fallback-only, gated by ENABLE_AI_FALLBACK.
 */

import type { IAIProvider, ExtractionRequest, ExtractionResult, EmbeddingResult, EmbeddingTaskType, ProviderHealth } from './types.js';
import { MockAIProvider } from './mock.js';
import { CloudflareFallbackProvider } from './cloudflare-fallback.js';
import { ReplicateProvider } from './replicate.js';
import { GeminiProvider } from './gemini.js';
import { TogetherProvider } from './together.js';
import { NessieProvider } from './nessie.js';
import { logger } from '../utils/logger.js';

// Cached singletons so circuit breaker state persists across requests
let geminiInstance: GeminiProvider | null = null;
let togetherInstance: TogetherProvider | null = null;
let nessieInstance: NessieProvider | null = null;

/**
 * Get the provider name that will be used based on current env.
 */
export function getProviderName(): string {
  const explicit = process.env.AI_PROVIDER;
  if (explicit) return explicit;

  // Default: gemini if key exists, else mock
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return 'mock';
}

/**
 * Create the AI provider based on AI_PROVIDER env var.
 *
 * Reads env on each call — supports hot-swap without restart (P8-S17 AC).
 */
export function createAIProvider(): IAIProvider {
  const providerName = getProviderName();

  switch (providerName) {
    case 'mock':
      return new MockAIProvider();

    case 'cloudflare': {
      const fallbackEnabled = process.env.ENABLE_AI_FALLBACK === 'true';
      if (!fallbackEnabled) {
        throw new Error(
          'ENABLE_AI_FALLBACK must be "true" to use Cloudflare Workers AI provider. ' +
          'Constitution 1.1: @cloudflare/ai is fallback-only and gated by this flag.',
        );
      }
      return new CloudflareFallbackProvider();
    }

    case 'gemini':
    case 'gemini-direct':
      if (!geminiInstance) {
        geminiInstance = new GeminiProvider();
      }
      return geminiInstance;

    case 'together':
      if (!togetherInstance) {
        togetherInstance = new TogetherProvider();
      }
      return togetherInstance;

    case 'nessie':
      if (!nessieInstance) {
        nessieInstance = new NessieProvider();
      }
      return nessieInstance;

    case 'replicate': {
      // Production check is in ReplicateProvider constructor (Constitution 1.1)
      return new ReplicateProvider();
    }

    case 'openai':
      throw new Error('OpenAI provider not yet implemented (Phase 1.5+)');

    case 'anthropic':
      throw new Error('Anthropic provider not yet implemented (Phase 1.5+)');

    default:
      throw new Error(`Unknown AI provider: "${providerName}". Valid: gemini, nessie, together, cloudflare, replicate, openai, anthropic, mock`);
  }
}

/** Document source categories for two-model routing. */
export type DocumentSource = 'user_upload' | 'pipeline' | 'institutional';

/**
 * Credential types where Nessie v5 scores >85% weighted F1.
 * Based on eval-nessie_v5_fp16-2026-03-31 (100 samples).
 * Types not in this set route to Gemini for better extraction quality.
 */
export const NESSIE_STRONG_TYPES = new Set([
  'DEGREE',        // 98.5% wF1 (n=11)
  'PATENT',        // 97.1% wF1 (n=4)
  'LICENSE',       // 96.6% wF1 (n=10)
  'PROFESSIONAL',  // 95.8% wF1 (n=7)
  'INSURANCE',     // 93.3% wF1 (n=4)
  'LEGAL',         // 92.9% wF1 (n=3)
  'CLE',           // 91.1% wF1 (n=2)
  'CERTIFICATE',   // 88.1% wF1 (n=14)
  'FINANCIAL',     // 100%  wF1 (n=2, small sample)
  'TRANSCRIPT',    // 100%  wF1 (n=2, small sample)
  'RESUME',        // 100%  wF1 (n=2, small sample)
]);

/**
 * Check if a credential type should be routed to Nessie.
 */
export function shouldUseNessie(credentialType?: string): boolean {
  if (!credentialType) return false;
  return NESSIE_STRONG_TYPES.has(credentialType.toUpperCase());
}

/**
 * Hybrid provider that routes extraction requests to Nessie or Gemini
 * based on credential type. Nessie handles types where v5 eval showed
 * >85% weighted F1; Gemini handles weaker types (OTHER, MILITARY,
 * MEDICAL, IDENTITY, PUBLICATION, ATTESTATION, BADGE, SEC_FILING, REGULATION).
 *
 * Embeddings always delegate to Gemini (Nessie is extraction-only).
 */
class HybridProvider implements IAIProvider {
  readonly name = 'hybrid';
  constructor(
    private readonly nessie: NessieProvider,
    private readonly gemini: GeminiProvider,
  ) {}

  async extractMetadata(request: ExtractionRequest): Promise<ExtractionResult> {
    const useNessie = shouldUseNessie(request.credentialType);
    const provider = useNessie ? this.nessie : this.gemini;
    logger.info(
      { credentialType: request.credentialType, provider: provider.name, hybrid: true },
      'Hybrid routing: selected provider for extraction',
    );
    return provider.extractMetadata(request);
  }

  async generateEmbedding(text: string, taskType?: EmbeddingTaskType): Promise<EmbeddingResult> {
    return this.gemini.generateEmbedding(text, taskType);
  }

  async healthCheck(): Promise<ProviderHealth> {
    // Check both providers — report healthy if at least one works
    const [nessieHealth, geminiHealth] = await Promise.all([
      this.nessie.healthCheck(),
      this.gemini.healthCheck(),
    ]);
    return {
      healthy: nessieHealth.healthy || geminiHealth.healthy,
      provider: this.name,
      latencyMs: Math.max(nessieHealth.latencyMs, geminiHealth.latencyMs),
      mode: `nessie:${nessieHealth.healthy ? 'up' : 'down'},gemini:${geminiHealth.healthy ? 'up' : 'down'}`,
    };
  }
}

/**
 * Create an AI provider for extraction, routing based on document source
 * and credential type.
 *
 * Routing strategy:
 *   - user_upload  → Gemini (best general-purpose extraction)
 *   - pipeline/institutional → HybridProvider when both available:
 *       - Nessie for strong types (DEGREE, LICENSE, PATENT, etc.)
 *       - Gemini for weak types (OTHER, MILITARY, SEC_FILING, etc.)
 *
 * Only activates when both GEMINI_API_KEY and RUNPOD_API_KEY are configured.
 * Falls back to single-provider mode (AI_PROVIDER) when only one is available.
 */
export function createExtractionProvider(source: DocumentSource = 'user_upload'): IAIProvider {
  const hasNessie = !!(process.env.RUNPOD_API_KEY && process.env.RUNPOD_ENDPOINT_ID);
  const hasGemini = !!process.env.GEMINI_API_KEY;

  // If dual-model routing isn't possible, use the default provider
  if (!hasNessie || !hasGemini) {
    return createAIProvider();
  }

  // User uploads → Gemini (better at diverse, messy, one-off documents)
  if (source === 'user_upload') {
    if (!geminiInstance) {
      geminiInstance = new GeminiProvider();
    }
    return geminiInstance;
  }

  // Pipeline/institutional → Hybrid routing by credential type
  if (!nessieInstance) {
    nessieInstance = new NessieProvider();
  }
  if (!geminiInstance) {
    geminiInstance = new GeminiProvider();
  }
  return new HybridProvider(nessieInstance, geminiInstance);
}

/**
 * Create an AI provider specifically for embedding generation.
 * Falls back to Gemini when the active provider doesn't support embeddings
 * (e.g., NessieProvider is extraction-only).
 */
export function createEmbeddingProvider(): IAIProvider {
  const providerName = getProviderName();
  // Nessie doesn't support embeddings — always use Gemini for embeddings
  if (providerName === 'nessie') {
    if (!geminiInstance) {
      geminiInstance = new GeminiProvider();
    }
    return geminiInstance;
  }
  return createAIProvider();
}

/** Reset cached provider instances (for testing only). */
export function resetProviderCache(): void {
  geminiInstance = null;
  togetherInstance = null;
  nessieInstance = null;
}

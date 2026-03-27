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
 * Constitution: @cloudflare/ai is fallback-only, gated by ENABLE_AI_FALLBACK.
 */

import type { IAIProvider } from './types.js';
import { MockAIProvider } from './mock.js';
import { CloudflareFallbackProvider } from './cloudflare-fallback.js';
import { ReplicateProvider } from './replicate.js';
import { GeminiProvider } from './gemini.js';
import { TogetherProvider } from './together.js';
import { NessieProvider } from './nessie.js';

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
 * Create an AI provider for extraction, routing based on document source.
 *
 * Two-model routing strategy:
 *   - user_upload  → Gemini (best general-purpose extraction)
 *   - pipeline     → Nessie if available, else Gemini (fine-tuned for bulk docs)
 *   - institutional → Nessie if available, else Gemini
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

  // Route based on document source
  if (source === 'user_upload') {
    // User uploads → Gemini (better at diverse, messy, one-off documents)
    if (!geminiInstance) {
      geminiInstance = new GeminiProvider();
    }
    return geminiInstance;
  }

  // Pipeline/institutional → Nessie (fine-tuned for structured, bulk documents)
  if (!nessieInstance) {
    nessieInstance = new NessieProvider();
  }
  return nessieInstance;
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

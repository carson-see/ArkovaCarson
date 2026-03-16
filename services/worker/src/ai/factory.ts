/**
 * AI Provider Factory (P8-S17)
 *
 * Routes to the correct IAIProvider implementation based on AI_PROVIDER env var.
 *
 * Provider routing:
 *   'gemini'     → GeminiADKProvider (default when GEMINI_API_KEY set)
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

// Cached singleton so circuit breaker state persists across requests
let geminiInstance: GeminiProvider | null = null;

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

    case 'replicate': {
      // Production check is in ReplicateProvider constructor (Constitution 1.1)
      return new ReplicateProvider();
    }

    case 'openai':
      throw new Error('OpenAI provider not yet implemented (Phase 1.5+)');

    case 'anthropic':
      throw new Error('Anthropic provider not yet implemented (Phase 1.5+)');

    default:
      throw new Error(`Unknown AI provider: "${providerName}". Valid: gemini, cloudflare, replicate, openai, anthropic, mock`);
  }
}

/** Reset cached provider instances (for testing only). */
export function resetProviderCache(): void {
  geminiInstance = null;
}

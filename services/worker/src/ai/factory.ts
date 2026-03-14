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
      // Gemini providers (GeminiADKProvider / GeminiProvider) not yet implemented.
      // Fall through to mock with a warning for now.
      // Not using structured logger here — factory may be imported before config is loaded in tests
      console.warn(`[AI Factory] Gemini provider "${providerName}" not yet implemented — using mock`);
      return new MockAIProvider();

    case 'openai':
      throw new Error('OpenAI provider not yet implemented (Phase 1.5+)');

    case 'anthropic':
      throw new Error('Anthropic provider not yet implemented (Phase 1.5+)');

    default:
      throw new Error(`Unknown AI provider: "${providerName}". Valid: gemini, cloudflare, openai, anthropic, mock`);
  }
}

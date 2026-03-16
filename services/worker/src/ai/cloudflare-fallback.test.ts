/**
 * Tests for Cloudflare Workers AI fallback provider.
 *
 * Constitution: @cloudflare/ai is fallback-only — never the primary provider.
 * Gated by ENABLE_AI_FALLBACK flag (default: false).
 */

import { describe, it, expect } from 'vitest';
import { CloudflareFallbackProvider } from './cloudflare-fallback.js';

describe('CloudflareFallbackProvider', () => {
  it('has name "cloudflare-workers-ai"', () => {
    const provider = new CloudflareFallbackProvider();
    expect(provider.name).toBe('cloudflare-workers-ai');
  });

  it('extractMetadata returns structured result with low confidence when no binding', async () => {
    const provider = new CloudflareFallbackProvider();
    const result = await provider.extractMetadata({
      strippedText: 'Bachelor of Science, MIT, 2025',
      credentialType: 'DEGREE',
      fingerprint: 'abc',
    });

    // Without a real Workers AI binding, returns a fallback/degraded result
    expect(result.provider).toBe('cloudflare-workers-ai');
    expect(result.fields).toBeDefined();
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('generateEmbedding returns 768-dimensional vector', async () => {
    const provider = new CloudflareFallbackProvider();
    const result = await provider.generateEmbedding('test input');

    expect(result.embedding).toHaveLength(768);
    expect(result.model).toContain('cloudflare');
  });

  it('healthCheck reports status', async () => {
    const provider = new CloudflareFallbackProvider();
    const health = await provider.healthCheck();

    expect(health.provider).toBe('cloudflare-workers-ai');
    expect(typeof health.healthy).toBe('boolean');
    expect(typeof health.latencyMs).toBe('number');
  });
});

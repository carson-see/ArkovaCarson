/**
 * Tests for AI provider factory (P8-S17).
 *
 * Factory routes to the correct provider based on AI_PROVIDER env var.
 * Cloudflare Workers AI fallback gated by ENABLE_AI_FALLBACK.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

// Mock logger to avoid config dependency (gemini.ts now imports logger)
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createAIProvider, createEmbeddingProvider, createExtractionProvider,
  getProviderName, resetProviderCache, shouldUseNessie, NESSIE_STRONG_TYPES,
} from './factory.js';
import { MockAIProvider } from './mock.js';
import { CloudflareFallbackProvider } from './cloudflare-fallback.js';
import { TogetherProvider } from './together.js';
import { NessieProvider } from './nessie.js';

describe('createAIProvider factory', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    resetProviderCache();
  });

  it('returns MockAIProvider when AI_PROVIDER=mock', () => {
    process.env.AI_PROVIDER = 'mock';
    const provider = createAIProvider();
    expect(provider).toBeInstanceOf(MockAIProvider);
    expect(provider.name).toBe('mock');
  });

  it('defaults to mock when AI_PROVIDER is not set and no Gemini key', () => {
    delete process.env.AI_PROVIDER;
    delete process.env.GEMINI_API_KEY;
    const provider = createAIProvider();
    expect(provider).toBeInstanceOf(MockAIProvider);
  });

  it('returns CloudflareFallbackProvider when AI_PROVIDER=cloudflare', () => {
    process.env.AI_PROVIDER = 'cloudflare';
    process.env.ENABLE_AI_FALLBACK = 'true';
    const provider = createAIProvider();
    expect(provider).toBeInstanceOf(CloudflareFallbackProvider);
    expect(provider.name).toBe('cloudflare-workers-ai');
  });

  it('throws when AI_PROVIDER=cloudflare but ENABLE_AI_FALLBACK=false', () => {
    process.env.AI_PROVIDER = 'cloudflare';
    process.env.ENABLE_AI_FALLBACK = 'false';
    expect(() => createAIProvider()).toThrow('ENABLE_AI_FALLBACK');
  });

  it('returns TogetherProvider when AI_PROVIDER=together', () => {
    process.env.AI_PROVIDER = 'together';
    process.env.TOGETHER_API_KEY = 'test-key-123';
    const provider = createAIProvider();
    expect(provider).toBeInstanceOf(TogetherProvider);
    expect(provider.name).toBe('together');
  });

  it('caches TogetherProvider singleton', () => {
    process.env.AI_PROVIDER = 'together';
    process.env.TOGETHER_API_KEY = 'test-key-123';
    const p1 = createAIProvider();
    const p2 = createAIProvider();
    expect(p1).toBe(p2);
  });

  it('returns NessieProvider when AI_PROVIDER=nessie', () => {
    process.env.AI_PROVIDER = 'nessie';
    process.env.RUNPOD_API_KEY = 'test-key';
    process.env.RUNPOD_ENDPOINT_ID = 'test-endpoint';
    const provider = createAIProvider();
    expect(provider).toBeInstanceOf(NessieProvider);
    expect(provider.name).toBe('nessie');
  });

  it('caches NessieProvider singleton', () => {
    process.env.AI_PROVIDER = 'nessie';
    process.env.RUNPOD_API_KEY = 'test-key';
    process.env.RUNPOD_ENDPOINT_ID = 'test-endpoint';
    const p1 = createAIProvider();
    const p2 = createAIProvider();
    expect(p1).toBe(p2);
  });

  it('throws for unknown provider names', () => {
    process.env.AI_PROVIDER = 'nonexistent';
    expect(() => createAIProvider()).toThrow('Unknown AI provider');
  });
});

describe('createEmbeddingProvider', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    resetProviderCache();
  });

  it('returns GeminiProvider regardless of AI_PROVIDER (embeddings are Gemini-only)', () => {
    // Embedding routing always goes to Gemini — Nessie has no embedding support
    // and Together retired its embedding model. AI_PROVIDER=mock here only changes
    // extraction routing; embedding still uses Gemini. Tests assert that contract.
    process.env.AI_PROVIDER = 'mock';
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    const provider = createEmbeddingProvider();
    expect(provider.name).toBe('gemini');
  });

  it('falls back to GeminiProvider when AI_PROVIDER=nessie', () => {
    process.env.AI_PROVIDER = 'nessie';
    process.env.RUNPOD_API_KEY = 'test-key';
    process.env.RUNPOD_ENDPOINT_ID = 'test-endpoint';
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    const provider = createEmbeddingProvider();
    // Should return Gemini, not Nessie (Nessie doesn't support embeddings)
    expect(provider.name).toBe('gemini');
  });
});

describe('getProviderName', () => {
  it('returns "mock" when AI_PROVIDER=mock', () => {
    process.env.AI_PROVIDER = 'mock';
    expect(getProviderName()).toBe('mock');
  });

  it('returns "gemini" when AI_PROVIDER=gemini', () => {
    process.env.AI_PROVIDER = 'gemini';
    expect(getProviderName()).toBe('gemini');
  });

  it('returns "mock" as default when nothing is set', () => {
    delete process.env.AI_PROVIDER;
    delete process.env.GEMINI_API_KEY;
    expect(getProviderName()).toBe('mock');
  });
});

describe('shouldUseNessie', () => {
  it('returns true for Nessie-strong credential types', () => {
    expect(shouldUseNessie('DEGREE')).toBe(true);
    expect(shouldUseNessie('LICENSE')).toBe(true);
    expect(shouldUseNessie('PATENT')).toBe(true);
    expect(shouldUseNessie('PROFESSIONAL')).toBe(true);
    expect(shouldUseNessie('INSURANCE')).toBe(true);
    expect(shouldUseNessie('CERTIFICATE')).toBe(true);
  });

  it('returns false for Nessie-weak credential types', () => {
    expect(shouldUseNessie('OTHER')).toBe(false);
    expect(shouldUseNessie('MILITARY')).toBe(false);
    expect(shouldUseNessie('MEDICAL')).toBe(false);
    expect(shouldUseNessie('SEC_FILING')).toBe(false);
    expect(shouldUseNessie('BADGE')).toBe(false);
    expect(shouldUseNessie('ATTESTATION')).toBe(false);
  });

  it('handles case-insensitive input', () => {
    expect(shouldUseNessie('degree')).toBe(true);
    expect(shouldUseNessie('Degree')).toBe(true);
    expect(shouldUseNessie('other')).toBe(false);
  });

  it('returns false for undefined/empty input', () => {
    expect(shouldUseNessie(undefined)).toBe(false);
    expect(shouldUseNessie('')).toBe(false);
  });

  it('covers all 11 strong types', () => {
    expect(NESSIE_STRONG_TYPES.size).toBe(11);
  });
});

describe('createExtractionProvider hybrid routing', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    resetProviderCache();
  });

  it('returns Gemini for user_upload source', () => {
    process.env.RUNPOD_API_KEY = 'test-key';
    process.env.RUNPOD_ENDPOINT_ID = 'test-endpoint';
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    const provider = createExtractionProvider('user_upload');
    expect(provider.name).toBe('gemini');
  });

  it('returns HybridProvider for pipeline source when both available', () => {
    process.env.RUNPOD_API_KEY = 'test-key';
    process.env.RUNPOD_ENDPOINT_ID = 'test-endpoint';
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    const provider = createExtractionProvider('pipeline');
    expect(provider.name).toBe('hybrid');
  });

  it('returns HybridProvider for institutional source when both available', () => {
    process.env.RUNPOD_API_KEY = 'test-key';
    process.env.RUNPOD_ENDPOINT_ID = 'test-endpoint';
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    const provider = createExtractionProvider('institutional');
    expect(provider.name).toBe('hybrid');
  });

  it('falls back to default provider when only Gemini available', () => {
    delete process.env.RUNPOD_API_KEY;
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.AI_PROVIDER = 'gemini';
    const provider = createExtractionProvider('pipeline');
    expect(provider.name).toBe('gemini');
  });

  it('falls back to default provider when only Nessie available', () => {
    process.env.RUNPOD_API_KEY = 'test-key';
    process.env.RUNPOD_ENDPOINT_ID = 'test-endpoint';
    delete process.env.GEMINI_API_KEY;
    process.env.AI_PROVIDER = 'nessie';
    const provider = createExtractionProvider('pipeline');
    expect(provider.name).toBe('nessie');
  });
});

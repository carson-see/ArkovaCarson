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

import { createAIProvider, getProviderName, resetProviderCache } from './factory.js';
import { MockAIProvider } from './mock.js';
import { CloudflareFallbackProvider } from './cloudflare-fallback.js';
import { TogetherProvider } from './together.js';

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

  it('throws for unknown provider names', () => {
    process.env.AI_PROVIDER = 'nonexistent';
    expect(() => createAIProvider()).toThrow('Unknown AI provider');
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

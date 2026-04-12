/**
 * GME-18: Flash Lite Model Configuration Tests
 *
 * Verifies that a lighter/cheaper model can be configured for
 * lightweight tasks (tag generation, template classification).
 */

import { describe, it, expect, afterEach } from 'vitest';

describe('GME-18: Flash Lite Model Configuration', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('exports GEMINI_LITE_MODEL from gemini-config', async () => {
    const { GEMINI_LITE_MODEL } = await import('./gemini-config.js');
    expect(GEMINI_LITE_MODEL).toBeDefined();
    expect(typeof GEMINI_LITE_MODEL).toBe('string');
    expect(GEMINI_LITE_MODEL.length).toBeGreaterThan(0);
  });

  it('GEMINI_LITE_MODEL defaults to a lightweight model variant', async () => {
    delete process.env.GEMINI_LITE_MODEL;
    const { getGeminiConfig } = await import('./gemini-config.js');
    const config = getGeminiConfig();
    expect(config).toHaveProperty('liteModel');
    expect(config.liteModel).toMatch(/lite|flash/i);
  });

  it('GEMINI_LITE_MODEL respects env var override', async () => {
    process.env.GEMINI_LITE_MODEL = 'custom-lite-model';
    const { getGeminiConfig } = await import('./gemini-config.js');
    const config = getGeminiConfig();
    expect(config.liteModel).toBe('custom-lite-model');
  });

  it('MODEL_VERSION_PINS includes lite model', async () => {
    const { MODEL_VERSION_PINS } = await import('./gemini-config.js');
    expect(MODEL_VERSION_PINS).toHaveProperty('lite');
    expect(MODEL_VERSION_PINS.lite.modelId).toBeDefined();
  });
});

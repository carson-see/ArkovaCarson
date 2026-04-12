/**
 * GME-15: Context Window Optimization Tests
 *
 * Verifies context window configuration and token budget tracking.
 */

import { describe, it, expect } from 'vitest';
import {
  getContextWindowConfig,
  estimateTokenCount,
  calculateRemainingBudget,
} from './context-window.js';

describe('GME-15: Context Window Optimization', () => {
  it('getContextWindowConfig returns model-specific limits', () => {
    const config = getContextWindowConfig('gemini-3-flash-preview');
    expect(config.maxInputTokens).toBeGreaterThan(0);
    expect(config.maxOutputTokens).toBeGreaterThan(0);
    expect(config.modelId).toBe('gemini-3-flash-preview');
  });

  it('Gemini 3 has larger context window than 2.5', () => {
    const g3 = getContextWindowConfig('gemini-3-flash-preview');
    const g25 = getContextWindowConfig('gemini-2.5-flash');
    expect(g3.maxInputTokens).toBeGreaterThanOrEqual(g25.maxInputTokens);
  });

  it('estimateTokenCount provides rough token count', () => {
    const short = estimateTokenCount('Hello world');
    const long = estimateTokenCount('a'.repeat(4000));
    expect(short).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(short);
  });

  it('calculateRemainingBudget accounts for system prompt and user text', () => {
    const budget = calculateRemainingBudget({
      modelId: 'gemini-3-flash-preview',
      systemPromptTokens: 5000,
      userTextTokens: 2000,
    });
    expect(budget.remaining).toBeGreaterThan(0);
    expect(budget.usedPercent).toBeLessThan(100);
    expect(budget.canAddFewShot).toBeDefined();
  });
});

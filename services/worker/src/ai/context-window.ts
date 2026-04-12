/**
 * GME-15: Context Window Configuration
 *
 * Model-specific context window limits and token budget tracking.
 * Used to optimize prompt construction and determine how many
 * few-shot examples can fit in the extraction prompt.
 */

export interface ContextWindowConfig {
  modelId: string;
  maxInputTokens: number;
  maxOutputTokens: number;
}

/** Known context window sizes by model family */
const MODEL_CONTEXT_WINDOWS: Record<string, { input: number; output: number }> = {
  'gemini-3-flash-preview': { input: 1_000_000, output: 65_536 },
  'gemini-3-flash-lite-preview': { input: 500_000, output: 32_768 },
  'gemini-2.5-flash': { input: 1_000_000, output: 8_192 },
  'gemini-2.5-pro': { input: 2_000_000, output: 8_192 },
  'gemini-2.0-flash': { input: 1_000_000, output: 8_192 },
};

const DEFAULT_CONTEXT = { input: 128_000, output: 8_192 };

/**
 * Get context window configuration for a specific model.
 */
export function getContextWindowConfig(modelId: string): ContextWindowConfig {
  const known = MODEL_CONTEXT_WINDOWS[modelId] ?? DEFAULT_CONTEXT;
  return {
    modelId,
    maxInputTokens: known.input,
    maxOutputTokens: known.output,
  };
}

/**
 * Rough token count estimation (4 chars ≈ 1 token for English text).
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface TokenBudget {
  modelId: string;
  maxInputTokens: number;
  systemPromptTokens: number;
  userTextTokens: number;
  remaining: number;
  usedPercent: number;
  /** Whether there's room for additional few-shot examples (~500 tokens each) */
  canAddFewShot: boolean;
}

/**
 * Calculate remaining token budget after system prompt and user text.
 */
export function calculateRemainingBudget(params: {
  modelId: string;
  systemPromptTokens: number;
  userTextTokens: number;
}): TokenBudget {
  const config = getContextWindowConfig(params.modelId);
  const used = params.systemPromptTokens + params.userTextTokens;
  const remaining = Math.max(0, config.maxInputTokens - used);
  const usedPercent = (used / config.maxInputTokens) * 100;

  return {
    modelId: params.modelId,
    maxInputTokens: config.maxInputTokens,
    systemPromptTokens: params.systemPromptTokens,
    userTextTokens: params.userTextTokens,
    remaining,
    usedPercent,
    canAddFewShot: remaining > 500,
  };
}

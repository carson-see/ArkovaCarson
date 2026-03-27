/**
 * Together AI Provider (PH1-INT-04)
 *
 * Implements IAIProvider using Together AI's OpenAI-compatible inference API.
 * Primary use: Nessie fine-tuned model (Llama 3.1 8B QLoRA) for credential
 * metadata extraction and RAG synthesis.
 *
 * Together AI supports:
 *   - Chat completions (OpenAI-compatible: /v1/chat/completions)
 *   - Embeddings (/v1/embeddings)
 *   - Fine-tuned model hosting (custom model IDs)
 *
 * Constitution 4A: Only PII-stripped metadata flows to this provider.
 * Constitution 1.6: Document bytes never reach this provider.
 *
 * Retry logic: exponential backoff with 3 attempts + jitter.
 * Circuit breaker: fails open after 5 consecutive errors (60s cooldown).
 */

import type {
  IAIProvider,
  ExtractionRequest,
  ExtractionResult,
  EmbeddingResult,
  ProviderHealth,
} from './types.js';
import { ExtractedFieldsSchema } from './schemas.js';
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionPrompt } from './prompts/extraction.js';
import { logger } from '../utils/logger.js';
import { verifyGrounding } from './grounding.js';
import { runCrossFieldChecks, sanitizeCLEFields } from './crossFieldFraudChecks.js';

const TOGETHER_API_BASE = 'https://api.together.xyz/v1';
const DEFAULT_MODEL = 'meta-llama/Meta-Llama-3.1-8B-Instruct';
const DEFAULT_EMBEDDING_MODEL = 'togethercomputer/m2-bert-80M-8k-retrieval';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 30_000;

// Circuit breaker config
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

interface CircuitState {
  consecutiveFailures: number;
  lastFailureAt: number;
  isOpen: boolean;
}

export class TogetherProvider implements IAIProvider {
  readonly name = 'together';
  private readonly apiKey: string;
  private readonly modelName: string;
  private readonly embeddingModelName: string;
  private circuit: CircuitState = {
    consecutiveFailures: 0,
    lastFailureAt: 0,
    isOpen: false,
  };

  constructor(apiKey?: string, model?: string, embeddingModel?: string) {
    const key = apiKey ?? process.env.TOGETHER_API_KEY;
    if (!key) {
      throw new Error('TOGETHER_API_KEY is required for TogetherProvider');
    }
    this.apiKey = key;
    // Support custom fine-tuned models via env var
    this.modelName = model ?? process.env.TOGETHER_MODEL ?? DEFAULT_MODEL;
    this.embeddingModelName =
      embeddingModel ?? process.env.TOGETHER_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
  }

  async extractMetadata(request: ExtractionRequest): Promise<ExtractionResult> {
    this.checkCircuit();

    const prompt = buildExtractionPrompt(
      request.strippedText,
      request.credentialType,
      request.issuerHint,
    );

    const result = await this.withRetry(async () => {
      const response = await this.chatCompletion(
        EXTRACTION_SYSTEM_PROMPT,
        prompt,
        { temperature: 0.1, response_format: { type: 'json_object' as const } },
      );

      const text = response.choices[0]?.message?.content ?? '';
      const parsed = JSON.parse(text);
      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
      const { confidence: _, ...rawFields } = parsed;
      const validated = ExtractedFieldsSchema.safeParse(rawFields);
      if (!validated.success) {
        logger.warn(
          { zodError: validated.error.message, model: this.modelName },
          'Together AI extraction schema validation failed',
        );
        throw new Error('Extraction schema validation failed');
      }

      return {
        fields: validated.data,
        confidence,
        tokensUsed: response.usage?.total_tokens,
      };
    });

    // CRIT-5/GAP-3: Grounding verification
    const groundingReport = verifyGrounding(
      result.fields as Record<string, unknown>,
      request.strippedText,
    );

    let adjustedConfidence = Math.min(
      1,
      Math.max(0, result.confidence + groundingReport.confidenceAdjustment),
    );

    // Strip CLE-only fields from non-CLE results (hard guardrail)
    const strippedFields = sanitizeCLEFields(result.fields);
    if (strippedFields.length > 0) {
      logger.info({ strippedFields, credentialType: result.fields.credentialType },
        'Together AI: Sanitized CLE-only fields from non-CLE extraction');
    }

    // Cross-field consistency fraud checks (parity with GeminiProvider)
    const crossFieldReport = runCrossFieldChecks(result.fields);
    adjustedConfidence = Math.min(
      1,
      Math.max(0, adjustedConfidence + crossFieldReport.confidenceAdjustment),
    );

    const existingSignals = result.fields.fraudSignals ?? [];
    const mergedSignals = [...new Set([...existingSignals, ...crossFieldReport.additionalFraudSignals])];

    if (crossFieldReport.warnings.length > 0) {
      logger.info(
        { warnings: crossFieldReport.warnings, signals: crossFieldReport.additionalFraudSignals },
        'Together AI: Cross-field fraud checks produced warnings',
      );
    }

    return {
      fields: {
        ...result.fields,
        ...(mergedSignals.length > 0 ? { fraudSignals: mergedSignals } : {}),
      },
      confidence: adjustedConfidence,
      provider: this.name,
      tokensUsed: result.tokensUsed,
    };
  }

  async generateEmbedding(text: string, _taskType?: import('./types.js').EmbeddingTaskType): Promise<EmbeddingResult> {
    this.checkCircuit();

    const result = await this.withRetry(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(`${TOGETHER_API_BASE}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.embeddingModelName,
            input: text,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorBody = await response.text();
          logger.error(
            { status: response.status, errorBody, model: this.embeddingModelName },
            'Together AI embedding API error',
          );
          throw new Error(`Embedding generation failed (status ${response.status})`);
        }

        const data = (await response.json()) as {
          data: Array<{ embedding: number[] }>;
          model: string;
        };
        if (!data.data || data.data.length === 0 || !data.data[0].embedding) {
          throw new Error('Together API returned empty embedding data');
        }
        return data.data[0].embedding;
      } finally {
        clearTimeout(timeout);
      }
    });

    return {
      embedding: result,
      model: this.embeddingModelName,
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const start = Date.now();

    try {
      const response = await this.chatCompletion(
        'You are a health check assistant.',
        'ping',
        { temperature: 0, max_tokens: 5 },
      );

      if (response.choices?.[0]?.message) {
        this.resetCircuit();
        return {
          healthy: true,
          provider: this.name,
          latencyMs: Date.now() - start,
          mode: 'together-inference',
        };
      }
      throw new Error('Unexpected response shape');
    } catch {
      return {
        healthy: false,
        provider: this.name,
        latencyMs: Date.now() - start,
        mode: 'together-inference',
      };
    }
  }

  /**
   * Generate a RAG synthesis response using Together AI's chat completion.
   * Used by Nessie context mode to replace hardcoded Gemini calls.
   */
  async generateRAGResponse(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<{ text: string; tokensUsed?: number }> {
    this.checkCircuit();

    const response = await this.withRetry(async () => {
      return this.chatCompletion(systemPrompt, userPrompt, {
        temperature: 0.2,
        response_format: { type: 'json_object' as const },
      });
    });

    return {
      text: response.choices[0]?.message?.content ?? '',
      tokensUsed: response.usage?.total_tokens,
    };
  }

  // ─── Private helpers ───

  private async chatCompletion(
    systemPrompt: string,
    userPrompt: string,
    options: {
      temperature?: number;
      max_tokens?: number;
      response_format?: { type: 'json_object' | 'text' };
    } = {},
  ): Promise<TogetherChatResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${TOGETHER_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.modelName,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: options.temperature ?? 0.2,
          max_tokens: options.max_tokens ?? 4096,
          ...(options.response_format ? { response_format: options.response_format } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(
          { status: response.status, errorBody, model: this.modelName },
          'Together AI chat completion error',
        );
        throw new Error(`Together AI request failed (status ${response.status})`);
      }

      return (await response.json()) as TogetherChatResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  private checkCircuit(): void {
    if (!this.circuit.isOpen) return;

    const elapsed = Date.now() - this.circuit.lastFailureAt;
    if (elapsed > CIRCUIT_BREAKER_COOLDOWN_MS) {
      this.circuit.isOpen = false;
      return;
    }

    throw new Error(
      `TogetherProvider circuit breaker open: ${this.circuit.consecutiveFailures} consecutive failures. ` +
        `Retry after ${Math.ceil((CIRCUIT_BREAKER_COOLDOWN_MS - elapsed) / 1000)}s.`,
    );
  }

  private resetCircuit(): void {
    this.circuit.consecutiveFailures = 0;
    this.circuit.isOpen = false;
  }

  private recordFailure(): void {
    this.circuit.consecutiveFailures++;
    this.circuit.lastFailureAt = Date.now();
    if (this.circuit.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      this.circuit.isOpen = true;
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const result = await fn();
        this.resetCircuit();
        return result;
      } catch (err) {
        const original = err instanceof Error ? err : new Error(String(err));
        lastError = new Error(original.message);
        lastError.name = original.name;

        // Don't retry on auth errors
        if (
          lastError.message.includes('401') ||
          lastError.message.includes('403') ||
          lastError.message.includes('API_KEY')
        ) {
          this.recordFailure();
          throw lastError;
        }

        if (attempt < MAX_RETRIES - 1) {
          const baseDelay = BASE_DELAY_MS * Math.pow(2, attempt);
          const delay = baseDelay * (0.5 + Math.random() * 0.5);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    this.recordFailure();
    throw lastError;
  }
}

// ─── Type definitions for Together AI API responses ───

interface TogetherChatResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

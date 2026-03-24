/**
 * Gemini AI Provider (P8-S1)
 *
 * Implements IAIProvider using Google's Generative AI SDK (@google/generative-ai).
 * Uses Gemini Flash for fast, cost-efficient credential metadata extraction.
 *
 * Constitution 4A: Only PII-stripped metadata flows to this provider.
 * Constitution 1.6: Document bytes never reach this provider.
 *
 * Retry logic: exponential backoff with 3 attempts.
 * Circuit breaker: fails open after 5 consecutive errors (60s cooldown).
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
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

// GAP-5: Pin to specific model versions to prevent silent quality drift.
// Before upgrading: run eval suite, compare F1, document delta, update pin.
const DEFAULT_MODEL = 'gemini-2.0-flash-001';
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-004';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

// Circuit breaker state
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

interface CircuitState {
  consecutiveFailures: number;
  lastFailureAt: number;
  isOpen: boolean;
}

export class GeminiProvider implements IAIProvider {
  readonly name = 'gemini';
  private readonly client: GoogleGenerativeAI;
  private readonly modelName: string;
  private readonly embeddingModelName: string;
  private circuit: CircuitState = {
    consecutiveFailures: 0,
    lastFailureAt: 0,
    isOpen: false,
  };

  constructor(apiKey?: string, model?: string, embeddingModel?: string) {
    const key = apiKey ?? process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error('GEMINI_API_KEY is required for GeminiProvider');
    }
    this.client = new GoogleGenerativeAI(key);
    this.modelName = model ?? process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
    this.embeddingModelName = embeddingModel ?? process.env.GEMINI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
  }

  async extractMetadata(request: ExtractionRequest): Promise<ExtractionResult> {
    this.checkCircuit();

    const prompt = buildExtractionPrompt(
      request.strippedText,
      request.credentialType,
      request.issuerHint,
    );

    const result = await this.withRetry(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      try {
        const model = this.client.getGenerativeModel({
          model: this.modelName,
          systemInstruction: EXTRACTION_SYSTEM_PROMPT,
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
          },
        });

        const response = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        });
        const text = response.response.text();
        const usage = response.response.usageMetadata;

        // Parse and validate inside retry so malformed output is retried
        const parsed = JSON.parse(text);
        const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
        const { confidence: _, ...rawFields } = parsed;
        const validated = ExtractedFieldsSchema.safeParse(rawFields);
        if (!validated.success) {
          logger.warn({ zodError: validated.error.message, model: this.modelName }, 'Extraction schema validation failed');
          throw new Error('Extraction schema validation failed');
        }

        return { fields: validated.data, confidence, tokensUsed: usage?.totalTokenCount };
      } finally {
        clearTimeout(timeout);
      }
    });

    // CRIT-5/GAP-3: Grounding verification — check extracted fields against source text
    const groundingReport = verifyGrounding(
      result.fields as Record<string, unknown>,
      request.strippedText,
    );

    // Apply confidence adjustment for ungrounded fields
    const adjustedConfidence = Math.min(
      1,
      Math.max(0, result.confidence + groundingReport.confidenceAdjustment),
    );

    return {
      fields: result.fields,
      confidence: adjustedConfidence,
      provider: this.name,
      tokensUsed: result.tokensUsed,
    };
  }

  async generateEmbedding(text: string): Promise<EmbeddingResult> {
    this.checkCircuit();

    const result = await this.withRetry(async () => {
      // CRIT-1 fix: Use header auth instead of URL query parameter to prevent API key leakage in logs/proxies.
      // CRIT-2 fix: Log full error server-side, return generic message to caller.
      const apiKey = process.env.GEMINI_API_KEY;
      const model = this.embeddingModelName;
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey!,
          },
          body: JSON.stringify({
            model: `models/${model}`,
            content: { parts: [{ text }] },
            outputDimensionality: 768,
          }),
        },
      );

      if (!response.ok) {
        const errorBody = await response.text();
        // Log full error server-side for debugging, but never surface to client
        logger.error({ status: response.status, errorBody, model }, 'Gemini embedding API error');
        throw new Error(`Embedding generation failed (status ${response.status})`);
      }

      const data = (await response.json()) as { embedding: { values: number[] } };
      return data.embedding;
    });

    return {
      embedding: result.values,
      model: this.embeddingModelName,
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const start = Date.now();

    try {
      const model = this.client.getGenerativeModel({ model: this.modelName });
      await model.generateContent('ping');

      this.resetCircuit();
      return {
        healthy: true,
        provider: this.name,
        latencyMs: Date.now() - start,
        mode: 'direct',
      };
    } catch {
      return {
        healthy: false,
        provider: this.name,
        latencyMs: Date.now() - start,
        mode: 'direct',
      };
    }
  }

  private checkCircuit(): void {
    if (!this.circuit.isOpen) return;

    const elapsed = Date.now() - this.circuit.lastFailureAt;
    if (elapsed > CIRCUIT_BREAKER_COOLDOWN_MS) {
      // Half-open: allow one request through
      this.circuit.isOpen = false;
      return;
    }

    throw new Error(
      `GeminiProvider circuit breaker open: ${this.circuit.consecutiveFailures} consecutive failures. ` +
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
        lastError = undefined; // Release error reference on success
        this.resetCircuit();
        return result;
      } catch (err) {
        // Store only message + name, not full error object (prevents holding
        // large API response bodies, stack traces, and request context in memory
        // during sustained Gemini API degradation — see LEAK-4)
        const original = err instanceof Error ? err : new Error(String(err));
        lastError = new Error(original.message);
        lastError.name = original.name;

        // Don't retry on auth/validation errors
        if (lastError.message.includes('API_KEY') || lastError.message.includes('INVALID_ARGUMENT')) {
          this.recordFailure();
          throw lastError;
        }

        if (attempt < MAX_RETRIES - 1) {
          // EFF-2: Add jitter to prevent thundering herd on transient outages
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

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

const DEFAULT_MODEL = 'gemini-2.0-flash';
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
          throw new Error(`Schema validation failed: ${validated.error.message}`);
        }

        return { fields: validated.data, confidence, tokensUsed: usage?.totalTokenCount };
      } finally {
        clearTimeout(timeout);
      }
    });

    return {
      fields: result.fields,
      confidence: Math.min(1, Math.max(0, result.confidence)),
      provider: this.name,
      tokensUsed: result.tokensUsed,
    };
  }

  async generateEmbedding(text: string): Promise<EmbeddingResult> {
    this.checkCircuit();

    const result = await this.withRetry(async () => {
      const model = this.client.getGenerativeModel({ model: this.embeddingModelName });
      const response = await model.embedContent(text);
      return response.embedding;
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
        this.resetCircuit();
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't retry on auth/validation errors
        if (lastError.message.includes('API_KEY') || lastError.message.includes('INVALID_ARGUMENT')) {
          this.recordFailure();
          throw lastError;
        }

        if (attempt < MAX_RETRIES - 1) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    this.recordFailure();
    throw lastError;
  }
}

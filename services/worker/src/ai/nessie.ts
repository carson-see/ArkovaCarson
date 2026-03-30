/**
 * Nessie AI Provider (RunPod vLLM)
 *
 * Implements IAIProvider using Nessie v2 (fine-tuned Llama 3.1 8B) hosted on
 * RunPod Serverless via vLLM with OpenAI-compatible API.
 *
 * Endpoint: https://api.runpod.ai/v2/{ENDPOINT_ID}/openai/v1/chat/completions
 *
 * Designed for pipeline/institutional document processing where Nessie's
 * fine-tuned extraction outperforms general-purpose models.
 *
 * Constitution 4A: Only PII-stripped metadata flows to this provider.
 * Constitution 1.6: Document bytes never reach this provider.
 *
 * Retry logic: exponential backoff with 3 attempts + jitter.
 * Circuit breaker: fails open after 5 consecutive errors (60s cooldown).
 * Cold start handling: RunPod serverless has 0 min workers — first request
 * after idle may take 30-60s for GPU allocation.
 */

import type {
  IAIProvider,
  ExtractionRequest,
  ExtractionResult,
  EmbeddingResult,
  EmbeddingTaskType,
  ProviderHealth,
} from './types.js';
import { ExtractedFieldsSchema } from './schemas.js';
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionPrompt } from './prompts/extraction.js';
import { logger } from '../utils/logger.js';
import { verifyGrounding } from './grounding.js';
import { runCrossFieldChecks, sanitizeCLEFields } from './crossFieldFraudChecks.js';
import { computeAdjustedConfidence } from './confidence-model.js';
import { routeToDomain, isDomainRoutingEnabled } from './nessie-domain-router.js';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000; // Higher base delay for serverless cold starts
const REQUEST_TIMEOUT_MS = 90_000; // 90s to account for RunPod cold start

// Circuit breaker config
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_COOLDOWN_MS = 120_000; // 2 min — longer cooldown for serverless

interface CircuitState {
  consecutiveFailures: number;
  lastFailureAt: number;
  isOpen: boolean;
}

const DEFAULT_NESSIE_MODEL = 'carson_6cec/Meta-Llama-3.1-8B-Instruct-Reference-arkova-nessie-v3-22458d86';

export class NessieProvider implements IAIProvider {
  readonly name = 'nessie';
  private readonly apiKey: string;
  private readonly endpointId: string;
  private readonly modelName: string;
  private readonly apiBase: string;
  private circuit: CircuitState = {
    consecutiveFailures: 0,
    lastFailureAt: 0,
    isOpen: false,
  };

  constructor(apiKey?: string, endpointId?: string, model?: string) {
    const key = apiKey ?? process.env.RUNPOD_API_KEY;
    if (!key) {
      throw new Error('RUNPOD_API_KEY is required for NessieProvider');
    }
    this.apiKey = key;

    const endpoint = endpointId ?? process.env.RUNPOD_ENDPOINT_ID;
    if (!endpoint) {
      throw new Error('RUNPOD_ENDPOINT_ID is required for NessieProvider');
    }
    this.endpointId = endpoint;
    this.modelName = model ?? process.env.NESSIE_MODEL ?? DEFAULT_NESSIE_MODEL;
    this.apiBase = `https://api.runpod.ai/v2/${this.endpointId}/openai/v1`;
  }

  async extractMetadata(request: ExtractionRequest): Promise<ExtractionResult> {
    this.checkCircuit();

    const prompt = buildExtractionPrompt(
      request.strippedText,
      request.credentialType,
      request.issuerHint,
    );

    // Domain routing: select adapter based on credential type + text content
    let modelOverride: string | undefined;
    if (isDomainRoutingEnabled()) {
      const adapter = routeToDomain(request.credentialType, request.strippedText);
      modelOverride = adapter.modelId;
      logger.info(
        { domain: adapter.domain, modelId: adapter.modelId, credentialType: request.credentialType },
        'Nessie: routed to domain adapter',
      );
    }

    const result = await this.withRetry(async () => {
      const response = await this.chatCompletion(
        EXTRACTION_SYSTEM_PROMPT,
        prompt,
        { temperature: 0.1, model: modelOverride },
      );

      let text = response.choices[0]?.message?.content ?? '';

      // Support reasoning-augmented output: strip <reasoning>...</reasoning> tags
      // if present (Nessie reasoning model wraps analysis before JSON)
      const reasoningMatch = text.match(/<reasoning>([\s\S]*?)<\/reasoning>\s*/);
      if (reasoningMatch) {
        const reasoning = reasoningMatch[1].trim();
        text = text.slice(reasoningMatch[0].length).trim();
        logger.info(
          { reasoningLength: reasoning.length },
          'Nessie: extracted reasoning trace from response',
        );
      }

      const parsed = JSON.parse(text);
      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
      const { confidence: _, ...rawFields } = parsed;
      const validated = ExtractedFieldsSchema.safeParse(rawFields);
      if (!validated.success) {
        logger.warn(
          { zodError: validated.error.message, model: this.modelName },
          'Nessie extraction schema validation failed',
        );
        throw new Error('Extraction schema validation failed');
      }

      return {
        fields: validated.data,
        confidence,
        tokensUsed: response.usage?.total_tokens,
      };
    });

    // Grounding verification
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
        'Nessie: Sanitized CLE-only fields from non-CLE extraction');
    }

    // Cross-field consistency fraud checks
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
        'Nessie: Cross-field fraud checks produced warnings',
      );
    }

    // Apply confidence meta-model v2: uses extraction features, grounding score,
    // provider identity, and fraud signals for better-calibrated confidence.
    const finalFields = {
      ...result.fields,
      ...(mergedSignals.length > 0 ? { fraudSignals: mergedSignals } : {}),
    };
    const metaModelConfidence = computeAdjustedConfidence(
      finalFields,
      adjustedConfidence,
      request.strippedText,
      {
        groundingScore: groundingReport.groundingScore,
        provider: this.name,
        fraudSignalCount: mergedSignals.length,
      },
    );
    // Meta-model must never override fraud-signal penalties
    const finalConfidence = Math.min(metaModelConfidence, adjustedConfidence);

    return {
      fields: finalFields,
      confidence: finalConfidence,
      provider: this.name,
      tokensUsed: result.tokensUsed,
      modelVersion: this.modelName,
    };
  }

  /**
   * Nessie doesn't have its own embedding model — delegate to Gemini.
   * This is expected: Nessie is extraction-only, embeddings use Gemini's
   * dedicated embedding model for better quality.
   */
  async generateEmbedding(_text: string, _taskType?: EmbeddingTaskType): Promise<EmbeddingResult> {
    throw new Error(
      'NessieProvider does not support embeddings. Use GeminiProvider for embedding generation.',
    );
  }

  async healthCheck(): Promise<ProviderHealth> {
    const start = Date.now();

    try {
      const response = await this.chatCompletion(
        'You are a health check assistant.',
        'Respond with exactly: {"status":"ok"}',
        { temperature: 0, max_tokens: 20 },
      );

      if (response.choices?.[0]?.message) {
        this.resetCircuit();
        return {
          healthy: true,
          provider: this.name,
          latencyMs: Date.now() - start,
          mode: 'runpod-serverless',
        };
      }
      throw new Error('Unexpected response shape');
    } catch {
      return {
        healthy: false,
        provider: this.name,
        latencyMs: Date.now() - start,
        mode: 'runpod-serverless',
      };
    }
  }

  /**
   * Generate a RAG synthesis response using Nessie.
   * Used by Nessie context mode for verified intelligence queries.
   */
  async generateRAGResponse(
    systemPrompt: string,
    userPrompt: string,
    credentialType?: string,
  ): Promise<{ text: string; tokensUsed?: number }> {
    this.checkCircuit();

    // Domain routing for RAG queries too
    let modelOverride: string | undefined;
    if (isDomainRoutingEnabled()) {
      const adapter = routeToDomain(credentialType, userPrompt);
      modelOverride = adapter.modelId;
      logger.info(
        { domain: adapter.domain, modelId: adapter.modelId },
        'Nessie RAG: routed to domain adapter',
      );
    }

    const response = await this.withRetry(async () => {
      return this.chatCompletion(systemPrompt, userPrompt, {
        temperature: 0.2,
        model: modelOverride,
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
      model?: string;
    } = {},
  ): Promise<RunPodChatResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: options.model ?? this.modelName,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: options.temperature ?? 0.1,
          max_tokens: options.max_tokens ?? 4096,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(
          { status: response.status, errorBody, endpoint: this.endpointId },
          'Nessie RunPod API error',
        );
        throw new Error(`Nessie request failed (status ${response.status})`);
      }

      return (await response.json()) as RunPodChatResponse;
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
      `NessieProvider circuit breaker open: ${this.circuit.consecutiveFailures} consecutive failures. ` +
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
          // Longer backoff for serverless cold starts
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

// ─── Type definitions for RunPod vLLM API responses (OpenAI-compatible) ───

interface RunPodChatResponse {
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

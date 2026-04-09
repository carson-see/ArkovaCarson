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
  EmbeddingTaskType,
  ProviderHealth,
} from './types.js';
import { ExtractedFieldsSchema } from './schemas.js';
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionPrompt } from './prompts/extraction.js';
import {
  TEMPLATE_RECONSTRUCTION_SYSTEM_PROMPT,
  buildTemplateReconstructionPrompt,
  TAGS_SYSTEM_PROMPT,
  buildTagsPrompt,
} from './prompts/template-reconstruction.js';
import { logger } from '../utils/logger.js';
import { verifyGrounding } from './grounding.js';
import { runCrossFieldChecks, validateFieldsForType } from './crossFieldFraudChecks.js';
import { computeAdjustedConfidence } from './confidence-model.js';
import { runEnsembleExtraction } from './ensembleConfidence.js';
import type { EnsembleResult } from './ensembleConfidence.js';
import { stripJsonComments } from './strip-json-comments.js';

// GAP-5: Pin to specific model versions to prevent silent quality drift.
// Before upgrading: run eval suite, compare F1, document delta, update pin.
const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

// Vertex AI tuned model config (Gemini Golden fine-tune)
// Set GEMINI_TUNED_MODEL to the Vertex AI endpoint resource path to enable.
// Example: projects/270018525501/locations/us-central1/endpoints/481340352117080064
// (Eval result: Weighted F1=90.4% vs 82.1% baseline, 100 samples, 2026-03-30)
const VERTEX_AI_REGION = 'us-central1';
const VERTEX_AI_API_BASE = `https://${VERTEX_AI_REGION}-aiplatform.googleapis.com/v1beta1`;

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
  private readonly apiKey: string;
  private readonly modelName: string;
  private readonly embeddingModelName: string;
  /** Vertex AI tuned model resource path (e.g., projects/.../models/...) */
  private readonly tunedModelPath: string | null;
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
    this.apiKey = key;
    this.client = new GoogleGenerativeAI(key);
    this.modelName = model ?? process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
    this.embeddingModelName = embeddingModel ?? process.env.GEMINI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
    this.tunedModelPath = process.env.GEMINI_TUNED_MODEL ?? null;

    if (this.tunedModelPath) {
      logger.info(
        { tunedModel: this.tunedModelPath },
        'GeminiProvider: using Vertex AI fine-tuned model for extraction',
      );
    }
  }

  async extractMetadata(request: ExtractionRequest): Promise<ExtractionResult> {
    this.checkCircuit();

    const prompt = buildExtractionPrompt(
      request.strippedText,
      request.credentialType,
      request.issuerHint,
    );

    const result = await this.withRetry(async () => {
      let text: string;
      let tokensUsed: number | undefined;

      if (this.tunedModelPath) {
        // Use Vertex AI fine-tuned model — trained on golden dataset
        const tunedResult = await this.callTunedModel(EXTRACTION_SYSTEM_PROMPT, prompt);
        text = tunedResult.text;
        tokensUsed = tunedResult.tokensUsed;
        logger.info({ tunedModel: this.tunedModelPath, tokensUsed }, 'Gemini: extraction via tuned model');
      } else {
        // Standard Gemini API path
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

          const response = await model.generateContent(
            { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
            { signal: controller.signal },
          );
          text = response.response.text();
          const usage = response.response.usageMetadata;
          tokensUsed = usage?.totalTokenCount;
        } finally {
          clearTimeout(timeout);
        }
      }

      // Parse and validate (shared path for both tuned and standard)
      // NMT-02: Strip JS-style comments that tuned/reasoning models may emit
      const parsed = JSON.parse(stripJsonComments(text));
      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
      const { confidence: _, ...rawFields } = parsed;
      const validated = ExtractedFieldsSchema.safeParse(rawFields);
      if (!validated.success) {
        logger.warn({ zodError: validated.error.message, model: this.tunedModelPath ?? this.modelName }, 'Extraction schema validation failed');
        throw new Error('Extraction schema validation failed');
      }

      return { fields: validated.data, confidence, tokensUsed };
    });

    // CRIT-5/GAP-3: Grounding verification — check extracted fields against source text
    const groundingReport = verifyGrounding(
      result.fields as Record<string, unknown>,
      request.strippedText,
    );

    // Apply confidence adjustment for ungrounded fields
    let adjustedConfidence = Math.min(
      1,
      Math.max(0, result.confidence + groundingReport.confidenceAdjustment),
    );

    // Validate fields against per-type allowlists (replaces CLE-only sanitization)
    const validation = validateFieldsForType(result.fields);
    if (validation.stripped.length > 0) {
      logger.info({ strippedFields: validation.stripped, credentialType: result.fields.credentialType },
        'Stripped invalid fields for credential type');
    }
    for (const key of validation.stripped) {
      delete (result.fields as Record<string, unknown>)[key];
    }

    // Cross-field consistency fraud checks
    const crossFieldReport = runCrossFieldChecks(result.fields);
    adjustedConfidence = Math.min(
      1,
      Math.max(0, adjustedConfidence + crossFieldReport.confidenceAdjustment),
    );

    // Merge cross-field fraud signals into the result
    const existingSignals = result.fields.fraudSignals ?? [];
    const mergedSignals = [...new Set([...existingSignals, ...crossFieldReport.additionalFraudSignals])];

    if (crossFieldReport.warnings.length > 0) {
      logger.info(
        { warnings: crossFieldReport.warnings, signals: crossFieldReport.additionalFraudSignals },
        'Cross-field fraud checks produced warnings',
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
      modelVersion: this.tunedModelPath ?? this.modelName,
    };
  }

  /**
   * Extract metadata using ensemble confidence scoring.
   * Runs 3 extractions with different prompt framings and measures agreement.
   * Produces better-calibrated confidence scores (target r > 0.70).
   *
   * Use this for high-stakes verifications where confidence accuracy matters.
   * Cost: ~3x a single extraction.
   */
  async extractWithEnsemble(request: ExtractionRequest): Promise<EnsembleResult> {
    return runEnsembleExtraction(this, request);
  }

  /**
   * Generate tags and document classification from extracted fields.
   * Lightweight alternative to full template reconstruction.
   */
  async generateTags(
    extractedFields: Record<string, unknown>,
  ): Promise<TagsResult> {
    this.checkCircuit();

    const prompt = buildTagsPrompt(extractedFields);

    const result = await this.withRetry(async () => {
      const model = this.client.getGenerativeModel({
        model: this.modelName,
        systemInstruction: TAGS_SYSTEM_PROMPT,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      });

      const response = await model.generateContent(
        { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
        { signal: AbortSignal.timeout(15_000) },
      );

      const text = response.response.text();
      return JSON.parse(text) as TagsResult;
    });

    return result;
  }

  /**
   * Reconstruct a clean template representation from extracted metadata.
   * Produces a structured template with sections, tags, and summary.
   */
  async reconstructTemplate(
    extractedFields: Record<string, unknown>,
    confidence: number,
  ): Promise<TemplateReconstructionResult> {
    this.checkCircuit();

    const prompt = buildTemplateReconstructionPrompt(
      extractedFields,
      confidence,
      this.name,
    );

    const result = await this.withRetry(async () => {
      const model = this.client.getGenerativeModel({
        model: this.modelName,
        systemInstruction: TEMPLATE_RECONSTRUCTION_SYSTEM_PROMPT,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
          maxOutputTokens: 4096,
        },
      });

      const response = await model.generateContent(
        { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
        { signal: AbortSignal.timeout(30_000) },
      );

      const text = response.response.text();
      const parsed = JSON.parse(text) as TemplateReconstructionResult;
      const usage = response.response.usageMetadata;
      parsed.tokensUsed = usage?.totalTokenCount;
      return parsed;
    });

    return result;
  }

  async generateEmbedding(text: string, taskType?: EmbeddingTaskType): Promise<EmbeddingResult> {
    this.checkCircuit();

    const result = await this.withRetry(async () => {
      // CRIT-1 fix: Use header auth instead of URL query parameter to prevent API key leakage in logs/proxies.
      // CRIT-2 fix: Log full error server-side, return generic message to caller.
      const apiKey = this.apiKey;
      const model = this.embeddingModelName;
      const body: Record<string, unknown> = {
        model: `models/${model}`,
        content: { parts: [{ text }] },
        outputDimensionality: 768,
      };
      if (taskType) {
        body.taskType = taskType;
      }
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey!,
          },
          body: JSON.stringify(body),
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

  /**
   * Call the Vertex AI fine-tuned model for extraction.
   * Uses Application Default Credentials (ADC) via gcloud access token
   * or GCP metadata server (Cloud Run gets this automatically).
   */
  private async callTunedModel(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<{ text: string; tokensUsed?: number }> {
    if (!this.tunedModelPath) {
      throw new Error('No tuned model configured');
    }

    // Get access token — Cloud Run provides this via metadata server,
    // local dev uses gcloud auth
    let accessToken: string;
    try {
      // Try GCP metadata server first (Cloud Run / GCE)
      const metaRes = await fetch(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2000) },
      );
      if (metaRes.ok) {
        const data = (await metaRes.json()) as { access_token: string };
        accessToken = data.access_token;
      } else {
        throw new Error('metadata server unavailable');
      }
    } catch {
      // ARK-SEC-025: Removed execSync('gcloud auth print-access-token') fallback.
      // Use GOOGLE_APPLICATION_CREDENTIALS or service account key file instead.
      const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      if (keyPath) {
        const { readFileSync } = await import('node:fs');
        const { createSign } = await import('node:crypto');
        const key = JSON.parse(readFileSync(keyPath, 'utf-8')) as {
          client_email: string; private_key: string; token_uri: string;
        };
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
        const payload = Buffer.from(JSON.stringify({
          iss: key.client_email, sub: key.client_email,
          aud: key.token_uri, iat: now, exp: now + 3600,
          scope: 'https://www.googleapis.com/auth/cloud-platform',
        })).toString('base64url');
        const sig = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key.private_key, 'base64url');
        const jwt = `${header}.${payload}.${sig}`;
        const tokenRes = await fetch(key.token_uri, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
        });
        if (tokenRes.ok) {
          const tokenData = (await tokenRes.json()) as { access_token: string };
          accessToken = tokenData.access_token;
        } else {
          throw new Error('Failed to get access token from service account key');
        }
      } else {
        throw new Error('No GCP credentials available — set GOOGLE_APPLICATION_CREDENTIALS');
      }
    }

    // Vertex AI tuned models are called via their deployed endpoint.
    // GEMINI_TUNED_MODEL can be either:
    //   - Endpoint path: projects/{p}/locations/{l}/endpoints/{endpointId}
    //   - Model path: projects/{p}/locations/{l}/models/{modelId}[@version]
    // Both use :generateContent on the v1beta1 API.
    let resourcePath = this.tunedModelPath;
    if (resourcePath.includes('/models/') && !resourcePath.includes('/endpoints/')) {
      // Strip @version suffix for endpoint lookup — caller should use endpoint path
      logger.warn(
        { tunedModel: resourcePath },
        'GEMINI_TUNED_MODEL points to a model, not an endpoint. Use the endpoint path for deployed tuned models.',
      );
    }
    const url = `${VERTEX_AI_API_BASE}/${resourcePath}:generateContent`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errBody = await response.text();
      logger.error(
        { status: response.status, errBody, tunedModel: this.tunedModelPath },
        'Vertex AI tuned model error',
      );
      throw new Error(`Vertex AI tuned model error (${response.status})`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content: { parts: Array<{ text: string }> } }>;
      usageMetadata?: { totalTokenCount: number };
    };

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return { text, tokensUsed: data.usageMetadata?.totalTokenCount };
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

// ─── Template Reconstruction Types ───

export interface TemplateReconstructionResult {
  templateType: 'formal' | 'compact' | 'table';
  documentTitle: string;
  sections: Array<{
    heading: string;
    fields: Array<{
      label: string;
      value: string;
      displayType: 'text' | 'date' | 'badge' | 'status';
    }>;
  }>;
  tags: string[];
  documentType: string;
  summary: string;
  verificationNotes: string | null;
  tokensUsed?: number;
}

export interface TagsResult {
  tags: string[];
  documentType: string;
  category: string;
  subcategory: string;
}

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
  ExtractedFields,
  EmbeddingResult,
  BatchEmbeddingInput,
  BatchEmbeddingResult,
  EmbeddingTaskType,
  ProviderHealth,
} from './types.js';
import { ExtractedFieldsSchema } from './schemas.js';
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionPrompt } from './prompts/extraction.js';
import { EXTRACTION_V6_SYSTEM_PROMPT, buildV6UserPrompt } from './prompts/extraction-v6.js';
import { isV6PromptActive } from './featureFlags.js';
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
import { getExtractionResponseSchema } from './structured-output.js';
import { traceAiProviderCall } from './observability.js';

// GAP-5: Model versions centralized in gemini-config.ts (GME-01).
// Before upgrading: run eval suite, compare F1, document delta, update pin.
import {
  GEMINI_GENERATION_MODEL,
  GEMINI_EMBEDDING_MODEL,
  GEMINI_LITE_MODEL,
} from './gemini-config.js';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const GEMINI_EMBEDDING_DIMENSIONS = 768;
const STRING_EXTRACTION_FIELDS = new Set([
  'credentialType',
  'subType',
  'issuerName',
  'recipientIdentifier',
  'issuedDate',
  'expiryDate',
  'fieldOfStudy',
  'degreeLevel',
  'licenseNumber',
  'accreditingBody',
  'jurisdiction',
  'creditType',
  'barNumber',
  'activityNumber',
  'courseId',
  'providerName',
  'approvedBy',
  'deliveryMethod',
  'nasbaStatus',
  'einNumber',
  'taxExemptStatus',
  'governingBody',
  'crdNumber',
  'firmName',
  'finraRegistration',
  'seriesLicenses',
  'entityType',
  'stateOfFormation',
  'registeredAgent',
  'goodStandingStatus',
  'suggestedType',
  'reasoning',
  'confidenceReasoning',
  'description',
]);
const NUMBER_EXTRACTION_FIELDS = new Set(['creditHours', 'ethicsHours']);
const STRING_ARRAY_EXTRACTION_FIELDS = new Set(['fraudSignals', 'concerns']);
const BOOLEAN_EXTRACTION_FIELDS = new Set(['issuerVerified']);

function validateGeminiBatchEmbeddingValues(
  embeddings: Array<{ values?: unknown }>,
  model: string,
): Array<{ values: number[] }> {
  return embeddings.map((embedding, index) => {
    const values = embedding.values;
    const isValid = Array.isArray(values)
      && values.length === GEMINI_EMBEDDING_DIMENSIONS
      && values.every((value) => typeof value === 'number' && Number.isFinite(value));

    if (!isValid) {
      logger.error(
        {
          index,
          expectedDim: GEMINI_EMBEDDING_DIMENSIONS,
          actualDim: Array.isArray(values) ? values.length : undefined,
          valuesType: Array.isArray(values) ? 'array' : typeof values,
          model,
        },
        'Gemini batch embedding API returned malformed embedding data',
      );
      throw new Error('Batch embedding generation returned malformed embedding data');
    }

    return { values };
  });
}

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
    this.modelName = model ?? GEMINI_GENERATION_MODEL;
    this.embeddingModelName = embeddingModel ?? GEMINI_EMBEDDING_MODEL;
    this.tunedModelPath = process.env.GEMINI_TUNED_MODEL ?? null;

    if (this.tunedModelPath) {
      logger.info(
        { tunedModel: this.tunedModelPath },
        'GeminiProvider: using Vertex AI fine-tuned model for extraction',
      );
    }
  }

  async extractMetadata(request: ExtractionRequest): Promise<ExtractionResult> {
    // BUG-2026-06-24-015: in-provider §1.6 launch-gate. The production extraction
    // path must fail closed on its own — not rely solely on route middleware — so
    // a routing regression cannot bypass the launch gate. Fails closed ONLY when
    // ENABLE_AI_EXTRACTION is explicitly not "true" (prod default is "true").
    assertExtractionEnabled();
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
        // GME2 v6: v6 endpoints require the v6 prompts they were trained on;
        // using the v5 prompt on v6 regresses toward base behavior (emits
        // untrained reasoning fields, skips description/subType).
        const useV6 = isV6PromptActive();
        const systemPromptToUse = useV6 ? EXTRACTION_V6_SYSTEM_PROMPT : EXTRACTION_SYSTEM_PROMPT;
        const userPromptToUse = useV6
          ? buildV6UserPrompt(request.strippedText, request.credentialType, request.issuerHint)
          : prompt;
        const tunedResult = await this.callTunedModel(systemPromptToUse, userPromptToUse);
        text = tunedResult.text;
        tokensUsed = tunedResult.tokensUsed;
        logger.info({ tunedModel: this.tunedModelPath, tokensUsed, v6Prompt: useV6 }, 'Gemini: extraction via tuned model');
      } else {
        // Standard Gemini API path
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);

        try {
          // GME-14: Zod-derived JSON Schema available via getExtractionResponseSchema()
          // for native structured output enforcement. Currently using responseMimeType
          // only — responseSchema causes over-generation of optional fields on Gemini 3.
          // Re-enable once Gemini 3 GA handles optional schema fields correctly.
          const model = this.client.getGenerativeModel({
            model: this.modelName,
            systemInstruction: EXTRACTION_SYSTEM_PROMPT,
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.1,
              // SCRUM-1281 (R3-8 sub-C) — cap output. extractMetadata returns a
              // bounded JSON object; runaway emission can blow Vertex/Gemini
              // quota when the prompt is malformed.
              maxOutputTokens: 2048,
            },
          });

          const response = await traceAiProviderCall(
            {
              provider: 'gemini',
              operation: 'generate',
              model: this.modelName,
              inputCharacterCount: prompt.length,
            },
            () => model.generateContent(
              { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
              { signal: controller.signal },
            ),
            (generated) => ({ tokensUsed: generated.response.usageMetadata?.totalTokenCount }),
          );
          text = response.response.text();
          const usage = response.response.usageMetadata;
          tokensUsed = usage?.totalTokenCount;
        } finally {
          clearTimeout(timeout);
        }
      }

      // Parse and validate (shared path for both tuned and standard)
      // NMT-02 / BUG-2026-06-24-014: shared hardened pipeline (fence strip +
      // comment strip + brace-salvage) — same helper used by tags/template.
      let parsed: Record<string, unknown>;
      try {
        parsed = parseModelJson(text);
      } catch (parseError) {
        if (!isProfessionalEducationText(request.strippedText, request.credentialType)) {
          throw parseError;
        }
        logger.warn(
          { error: parseError, credentialType: request.credentialType },
          'Gemini professional-education JSON parse failed; recovering from source text',
        );
        parsed = { credentialType: request.credentialType, confidence: 0.55 };
      }
      const confidence = coerceConfidence(parsed.confidence);
      const { confidence: _, ...rawFields } = parsed;
      const sanitizedFields = sanitizeExtractedFields(rawFields);
      const validated = ExtractedFieldsSchema.safeParse(sanitizedFields);
      if (!validated.success) {
        logger.warn({
          zodError: validated.error.message,
          model: this.tunedModelPath ?? this.modelName,
          rawKeys: Object.keys(rawFields),
          sanitizedKeys: Object.keys(sanitizedFields),
        }, 'Extraction schema validation failed after salvage');
        throw new Error('Extraction schema validation failed');
      }

      return {
        fields: normalizeProfessionalEducationFields(
          validated.data,
          request.strippedText,
          request.credentialType,
        ),
        confidence,
        tokensUsed,
      };
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
   * Raw JSON generate with an explicit system + user prompt (PeRawModel).
   *
   * Bypasses the generic EXTRACTION_SYSTEM_PROMPT and the per-type field strip so
   * the professional-education eval can measure the model's raw ability to read
   * gate fields (deliveryMethod / nasbaStatus / ethicsHours / courseId) off the
   * document. Routes to the tuned Vertex endpoint when GEMINI_TUNED_MODEL is set,
   * otherwise the base Gemini model. Returns the raw model text — parsing/scoring
   * is the caller's job. Not part of the production extraction path.
   */
  async generateExtractionJson(args: {
    systemPrompt: string;
    userPrompt: string;
  }): Promise<{ text: string; tokensUsed?: number }> {
    // Launch-gate parity (Constitution §1.6): the raw extraction path is still
    // an AI-extraction code path, so it must fail closed when the flag is off —
    // no "raw mode" bypass. Shared guard with extractMetadata (BUG-2026-06-24-015).
    // Prod sets ENABLE_AI_EXTRACTION=true via deploy; off-prod defaults false.
    assertExtractionEnabled();
    this.checkCircuit();

    return this.withRetry(async () => {
      if (this.tunedModelPath) {
        return this.callTunedModel(args.systemPrompt, args.userPrompt);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const model = this.client.getGenerativeModel({
          model: this.modelName,
          systemInstruction: args.systemPrompt,
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.1,
            maxOutputTokens: 2048,
          },
        });
        const response = await traceAiProviderCall(
          {
            provider: 'gemini',
            operation: 'generate',
            model: this.modelName,
            inputCharacterCount: args.userPrompt.length,
          },
          () =>
            model.generateContent(
              { contents: [{ role: 'user', parts: [{ text: args.userPrompt }] }] },
              { signal: controller.signal },
            ),
          (generated) => ({ tokensUsed: generated.response.usageMetadata?.totalTokenCount }),
        );
        return {
          text: response.response.text(),
          tokensUsed: response.response.usageMetadata?.totalTokenCount,
        };
      } finally {
        clearTimeout(timeout);
      }
    });
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
      // GME-18: Route lightweight tasks to Flash Lite for cost savings
      const model = this.client.getGenerativeModel({
        model: GEMINI_LITE_MODEL,
        systemInstruction: TAGS_SYSTEM_PROMPT,
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
          // SCRUM-1281 (R3-8 sub-C) — cap output. generateTags returns a small
          // tag list (≈10–50 tokens typical). 1024 leaves headroom without
          // letting a malformed prompt run the model to its default ceiling.
          maxOutputTokens: 1024,
        },
      });

      const response = await traceAiProviderCall(
        {
          provider: 'gemini',
          operation: 'tags',
          model: GEMINI_LITE_MODEL,
          inputCharacterCount: prompt.length,
        },
        () => model.generateContent(
          { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
          { signal: AbortSignal.timeout(15_000) },
        ),
        (generated) => ({ tokensUsed: generated.response.usageMetadata?.totalTokenCount }),
      );

      const text = response.response.text();
      // BUG-2026-06-24-014: hardened parse — Flash Lite ```json-fences/truncates.
      return parseModelJson<TagsResult>(text);
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

      const response = await traceAiProviderCall(
        {
          provider: 'gemini',
          operation: 'template',
          model: this.modelName,
          inputCharacterCount: prompt.length,
        },
        () => model.generateContent(
          { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
          { signal: AbortSignal.timeout(30_000) },
        ),
        (generated) => ({ tokensUsed: generated.response.usageMetadata?.totalTokenCount }),
      );

      const text = response.response.text();
      // BUG-2026-06-24-014: hardened parse — Flash ```json-fences/truncates.
      const parsed = parseModelJson<TemplateReconstructionResult>(text);
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
      return await traceAiProviderCall<{ values: number[] }>(
        {
          provider: 'gemini',
          operation: 'embed',
          model,
          inputCharacterCount: text.length,
        },
        async () => {
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
        },
      );
    });

    return {
      embedding: result.values,
      model: this.embeddingModelName,
    };
  }

  async generateEmbeddings(
    inputs: BatchEmbeddingInput[],
    taskType?: EmbeddingTaskType,
  ): Promise<BatchEmbeddingResult> {
    this.checkCircuit();

    if (inputs.length === 0) {
      return { embeddings: [], model: this.embeddingModelName };
    }

    const result = await this.withRetry(async () => {
      const apiKey = this.apiKey;
      const model = this.embeddingModelName;
      const requests = inputs.map((input) => {
        const request: Record<string, unknown> = {
          model: `models/${model}`,
          content: { parts: [{ text: input.text }] },
          outputDimensionality: 768,
        };
        const resolvedTaskType = input.taskType ?? taskType;
        if (resolvedTaskType) request.taskType = resolvedTaskType;
        if (input.title) request.title = input.title;
        return request;
      });

      return await traceAiProviderCall<Array<{ values: number[] }>>(
        {
          provider: 'gemini',
          operation: 'batchEmbed',
          model,
          inputCharacterCount: inputs.reduce((sum, input) => sum + input.text.length, 0),
        },
        async () => {
          const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey!,
              },
              body: JSON.stringify({ requests }),
              signal: AbortSignal.timeout(30_000),
            },
          );

          if (!response.ok) {
            // Discard raw error body — it may echo request content containing PII.
            // Log only HTTP status and content-length for debugging.
            const contentLength = response.headers.get('content-length');
            await response.text(); // drain body
            logger.error({ status: response.status, contentLength, model }, 'Gemini batch embedding API error');
            throw new Error(`Batch embedding generation failed (status ${response.status})`);
          }

          const data = (await response.json()) as { embeddings?: Array<{ values?: unknown }> };
          if (!Array.isArray(data.embeddings) || data.embeddings.length !== inputs.length) {
            logger.error(
              { expected: inputs.length, actual: data.embeddings?.length ?? 0, model },
              'Gemini batch embedding API returned unexpected embedding count',
            );
            throw new Error('Batch embedding generation returned an unexpected embedding count');
          }

          return validateGeminiBatchEmbeddingValues(data.embeddings, model);
        },
      );
    });

    return {
      embeddings: result.map((embedding) => ({
        embedding: embedding.values,
        model: this.embeddingModelName,
      })),
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
    const resourcePath = this.tunedModelPath;
    if (resourcePath.includes('/models/') && !resourcePath.includes('/endpoints/')) {
      // Strip @version suffix for endpoint lookup — caller should use endpoint path
      logger.warn(
        { tunedModel: resourcePath },
        'GEMINI_TUNED_MODEL points to a model, not an endpoint. Use the endpoint path for deployed tuned models.',
      );
    }
    const url = `${VERTEX_AI_API_BASE}/${resourcePath}:generateContent`;

    // GME2 v7 bet 3: optional responseSchema belt-and-suspenders JSON enforcement.
    // Enable via GEMINI_TUNED_RESPONSE_SCHEMA=true (default off — prior testing on
    // base gemini-3-flash-preview showed over-generation of optional fields, but
    // a tuned model on gemini-2.5-flash may behave differently; flag lets us A/B).
    const generationConfig: Record<string, unknown> = {
      temperature: 0.1,
      responseMimeType: 'application/json',
    };
    if (process.env.GEMINI_TUNED_RESPONSE_SCHEMA === 'true') {
      generationConfig.responseSchema = getExtractionResponseSchema();
    }

    return await traceAiProviderCall<{ text: string; tokensUsed?: number }>(
      {
        provider: 'vertex',
        operation: 'generate',
        model: resourcePath,
        inputCharacterCount: systemPrompt.length + userPrompt.length,
      },
      async () => {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
            generationConfig,
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
      },
      (result) => ({ tokensUsed: result.tokensUsed }),
    );
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

/**
 * BUG-2026-06-24-015: shared §1.6 fail-closed launch-gate guard.
 *
 * Both the production extraction path (extractMetadata) and the raw eval path
 * (generateExtractionJson) call this so neither depends solely on route
 * middleware to enforce the launch gate. Fails closed ONLY when
 * ENABLE_AI_EXTRACTION is explicitly not "true" — the production default IS
 * "true" (§1.6: set on via switchboard + deploy-worker env fallback), so this
 * does not break prod; it just blocks extraction off-prod or on a flag flip.
 */
function assertExtractionEnabled(): void {
  if (process.env.ENABLE_AI_EXTRACTION !== 'true') {
    throw new Error('AI extraction is disabled (ENABLE_AI_EXTRACTION is not "true")');
  }
}

/**
 * BUG-2026-06-24-014: shared hardened JSON parse for ALL raw Gemini text output.
 *
 * Gemini Flash routinely wraps JSON in ```json fences and occasionally appends
 * stray continuation tokens / prose past the final `}`. A naked `JSON.parse`
 * throws SyntaxError, which surfaces as HTTP 500 on the extraction/tags/template
 * endpoints. This pipeline (strip JS-style comments → strip markdown fence →
 * brace-salvage) recovers the object. Used by extractMetadata, generateTags, and
 * reconstructTemplate so every model-text parse path is equally resilient.
 *
 * Returns a parsed object whose shape the caller is responsible for validating
 * (extractMetadata runs Zod; tags/template cast to their result types).
 */
function parseModelJson<T = Record<string, unknown>>(text: string): T {
  const cleaned = stripJsonComments(text).trim();
  const unfenced = stripMarkdownJsonFence(cleaned);

  try {
    return ensureJsonObject(JSON.parse(unfenced)) as T;
  } catch (initialError) {
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start >= 0 && end > start) {
      const candidate = unfenced.slice(start, end + 1);
      try {
        return ensureJsonObject(JSON.parse(candidate)) as T;
      } catch {
        return ensureJsonObject(JSON.parse(repairModelJson(candidate))) as T;
      }
    }
    const repaired = repairModelJson(unfenced);
    if (repaired !== unfenced) return ensureJsonObject(JSON.parse(repaired)) as T;
    throw initialError;
  }
}

function repairModelJson(text: string): string {
  const withoutControlChars = text
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
  const withoutTrailingCommas = withoutControlChars.replace(/,\s*([}\]])/g, '$1');
  const balanced = balanceJsonDelimiters(withoutTrailingCommas);
  return escapeBareNewlinesInStrings(balanced);
}

function balanceJsonDelimiters(text: string): string {
  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (const char of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') stack.push('}');
    if (char === '[') stack.push(']');
    if ((char === '}' || char === ']') && stack[stack.length - 1] === char) stack.pop();
  }

  return text + stack.reverse().join('');
}

function escapeBareNewlinesInStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      out += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      out += char;
      continue;
    }
    if (inString && char === '\n') {
      out += '\\n';
      continue;
    }
    if (inString && char === '\r') {
      out += '\\r';
      continue;
    }
    out += char;
  }

  return out;
}

function stripMarkdownJsonFence(cleaned: string): string {
  if (!cleaned.startsWith('```')) return cleaned;

  const firstLineBreak = cleaned.indexOf('\n');
  const withoutOpeningFence = firstLineBreak >= 0
    ? cleaned.slice(firstLineBreak + 1)
    : cleaned.slice(3);
  const trimmed = withoutOpeningFence.trim();

  return trimmed.endsWith('```')
    ? trimmed.slice(0, -3).trim()
    : trimmed;
}

function ensureJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error('Extraction response was not a JSON object');
}

function coerceConfidence(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0.5;
}

function sanitizeExtractedFields(rawFields: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(rawFields)) {
    const coerced = coerceExtractionField(key, value);
    if (coerced !== undefined) sanitized[key] = coerced;
  }

  return sanitized;
}

function coerceExtractionField(key: string, value: unknown): unknown {
  if (STRING_EXTRACTION_FIELDS.has(key)) {
    return coerceString(value, key === 'description' ? 500 : undefined);
  }

  if (NUMBER_EXTRACTION_FIELDS.has(key)) {
    return coerceNumber(value);
  }

  if (STRING_ARRAY_EXTRACTION_FIELDS.has(key)) {
    const coerced = coerceStringArray(value);
    return coerced.length > 0 ? coerced : undefined;
  }

  if (BOOLEAN_EXTRACTION_FIELDS.has(key)) {
    return coerceBoolean(value);
  }

  return undefined;
}

function coerceString(value: unknown, maxLength?: number): string | undefined {
  let text: string | undefined;
  if (typeof value === 'string') text = value;
  if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
  if (Array.isArray(value)) {
    text = value
      .map((item) => coerceString(item))
      .filter((item): item is string => Boolean(item))
      .join(', ');
  }

  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function coerceStringArray(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((item) => {
      if (typeof item === 'object' && item !== null) {
        const record = item as Record<string, unknown>;
        return coerceString(record.signal ?? record.code ?? record.description ?? record.message ?? JSON.stringify(record));
      }
      return coerceString(item);
    })
    .filter((item): item is string => Boolean(item));
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^true$/i.test(value.trim())) return true;
    if (/^false$/i.test(value.trim())) return false;
  }
  return undefined;
}

function normalizeProfessionalEducationFields(
  fields: ExtractedFields,
  strippedText: string,
  credentialTypeHint: string,
): ExtractedFields {
  const normalized: ExtractedFields = { ...fields };
  const text = strippedText.replace(/\s+/g, ' ').trim();
  const { isCpe, isCle } = detectProfessionalEducation(text, credentialTypeHint);

  if (!isCpe && !isCle) return normalized;

  normalized.credentialType = isCle && !isCpe ? 'CLE' : 'CPE';
  const baseCreditType = isCle && !isCpe ? 'CLE' : 'CPE';
  if (/regulatory ethics|professional ethics|ethics requirement/i.test(text)) {
    normalized.creditType = `${baseCreditType} Ethics`;
  } else if (!normalized.creditType || !/^C(?:P|L)E(?:\s+Ethics)?$/i.test(normalized.creditType)) {
    normalized.creditType = baseCreditType;
  }

  const creditHours = extractFirstNumber(text, [
    /\bCPE\s+(?:Credits?|Hours?)\s*[:\-]?\s*(\d+(?:\.\d+)?)/i,
    /\bCredits?\s+Awarded\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*(?:CPE|CLE)?/i,
    /\b(?:Total\s+)?(?:CLE|CPE)?\s*Credits?\s*[:\-]?\s*(\d+(?:\.\d+)?)/i,
    /\b(?:Credit|Contact)\s+Hours?\s*[:\-]?\s*(\d+(?:\.\d+)?)/i,
    /\b(\d+(?:\.\d+)?)\s+(?:CPE|CLE)\b/i,
  ]);
  if (creditHours !== undefined) normalized.creditHours = creditHours;

  const ethicsHours = extractFirstNumber(text, [
    /\b(?:Ethics|Regulatory Ethics|Professional Responsibility)\s*(?:Credits?|Hours?)\s*[:\-]?\s*(\d+(?:\.\d+)?)/i,
    /\b(\d+(?:\.\d+)?)\s+(?:Regulatory\s+)?Ethics\b/i,
  ]);
  if (ethicsHours !== undefined) normalized.ethicsHours = ethicsHours;

  const courseId = extractFirstText(text, [
    /\bC\s*o\s*u\s*r\s*s\s*e\s+(?:ID|Number)\s*[:\-]\s*([A-Z0-9][A-Z0-9._/-]*(?:-[A-Z0-9._/-]+)*)/i,
    /\bCourse\s+(?:ID|Number|Code)\s*[:\-]\s*([A-Z0-9][A-Z0-9._/-]*(?:-[A-Z0-9._/-]+)*)/i,
    /\bProgram\s+Code\s+([A-Z0-9][A-Z0-9._/-]*(?:-[A-Z0-9._/-]+)*)/i,
    /\bProgram\s+ID\s*[:\-]\s*([A-Z0-9][A-Z0-9._/-]*(?:-[A-Z0-9._/-]+)*)/i,
    /\bModule\s+ID\s*[:\-]\s*([A-Z0-9][A-Z0-9._/-]*(?:-[A-Z0-9._/-]+)*)/i,
    /\bConference\s+Code\s*[:\-]\s*([A-Z0-9][A-Z0-9._/-]*(?:-[A-Z0-9._/-]+)*)/i,
    /\bActivity\s+Number\s*[:\-]\s*([A-Z0-9][A-Z0-9._/-]*(?:-[A-Z0-9._/-]+)*)/i,
  ]);
  if (courseId) {
    normalized.courseId = courseId;
    if (!normalized.activityNumber) normalized.activityNumber = courseId;
  }

  const deliveryMethod = extractFirstText(text, [
    /\bDelivery\s+Method\s*[:\-]\s*([^.;]+)/i,
    /\bDelivery\s*[:\-]\s*([^.;]+)/i,
    /\bDeli\s*very\s*[:\-]\s*([^.;]+)/i,
  ]);
  if (deliveryMethod) normalized.deliveryMethod = deliveryMethod;

  const nasbaStatus = extractFirstText(text, [
    /\bNASBA\s+(?:Sponsor\s+)?Registry(?:\s+Status)?\s*[:\-]\s*(active|lapsed|pending|revoked|not registered)/i,
    /\bNASBA\s+(?:National\s+)?Registry\s+of\s+CPE\s+Sponsors\s*[:\-]\s*(active|lapsed|pending|revoked|not registered)/i,
    /\bNASBA\s+Sponsor\s+Status\s*[:\-]\s*(active|lapsed|pending|revoked|not registered)/i,
    /\bNASBA\s+Spon\s*sor\s+Regis\s*try\s*[:\-]\s*(active|lapsed|pending|revoked|not registered)/i,
  ]);
  if (nasbaStatus) normalized.nasbaStatus = nasbaStatus.toLowerCase();

  const providerName = extractFirstText(text, [
    /\bSponsor\s*[:\-]\s*([^.;]+)/i,
    /\bProvider\s*[:\-]\s*([^.;]+)/i,
    /^(.+?)\s+(?:hereby certifies|Certificate of|CPE Certificate|—\s+Certificate|Annual Assurance Conference)/i,
  ]);
  if (providerName) {
    normalized.providerName = providerName;
    if (!normalized.issuerName) normalized.issuerName = providerName;
  }

  if (/nasba/i.test(text)) normalized.accreditingBody = 'NASBA';

  const jurisdiction = extractFirstText(text, [
    /\bJurisdiction\s*[:\-]\s*([^.;]+)/i,
    /\bLocation\s*[:\-]\s*[^,.;]+,\s*([A-Z][a-z]+)\b/i,
    /\bApproved\s+for\s+([A-Z][a-z]+)\s+State\s+Board/i,
  ]);
  if (jurisdiction) normalized.jurisdiction = jurisdiction.replace(/,\s*USA$/i, '');
  else if (!normalized.jurisdiction) normalized.jurisdiction = 'United States';

  const issuedDate = extractIsoDate(text, [
    /\bCompletion\s+Date\s*[:\-]?\s*([A-Z][a-z]+\s+\d{1,2}\s*,\s*\d{4})/i,
    /\bDate\s+of\s+Completion\s*[:\-]?\s*([A-Z][a-z]+\s+\d{1,2}\s*,\s*\d{4})/i,
    /\bCompleted\s*[:\-]?\s*([A-Z][a-z]+\s+\d{1,2}\s*,\s*\d{4})/i,
    /\bDate\s*[:\-]?\s*([A-Z][a-z]+\s+\d{1,2}\s*,\s*\d{4})/i,
    /\bon\s+([A-Z][a-z]+\s+\d{1,2}\s*,\s*\d{4})/i,
  ]);
  if (issuedDate) normalized.issuedDate = issuedDate;

  return normalized;
}

function isProfessionalEducationText(strippedText: string, credentialTypeHint: string): boolean {
  const { isCpe, isCle } = detectProfessionalEducation(strippedText, credentialTypeHint);
  return isCpe || isCle;
}

function detectProfessionalEducation(text: string, credentialTypeHint: string): { isCpe: boolean; isCle: boolean } {
  const lower = text.toLowerCase();
  const hint = credentialTypeHint.toUpperCase();
  const isCpe = hint === 'CPE'
    || /\bcpe\b/.test(lower)
    || /continuing professional education/i.test(text)
    || /nasba/i.test(text);
  const isCle = hint === 'CLE'
    || /\bcle\b/.test(lower)
    || /continuing legal education/i.test(text)
    || /\bbar\b/i.test(text)
    || /\bmcle\b/i.test(text);
  return { isCpe, isCle };
}

function extractFirstNumber(text: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function extractFirstText(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1]?.trim().replace(/\s+/g, ' ').replace(/[.,;:]+$/, '');
    if (value) return value;
  }
  return undefined;
}

function extractIsoDate(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    const parsed = new Date(match[1]);
    if (Number.isNaN(parsed.getTime())) continue;
    const year = parsed.getUTCFullYear();
    const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
    const day = String(parsed.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return undefined;
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

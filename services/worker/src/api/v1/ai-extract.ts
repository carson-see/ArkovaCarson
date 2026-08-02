/**
 * AI Extraction Endpoint (P8-S4)
 *
 * POST /api/v1/ai/extract — Extract structured credential metadata
 * from PII-stripped text using AI.
 *
 * Constitution 4A: Only PII-stripped metadata arrives at this endpoint.
 * Document bytes and raw OCR text never leave the client.
 *
 * Flow: client OCR → client PII strip → this endpoint → AI provider → response
 */

import { Router, Request, Response } from 'express';
import { ExtractionRequestSchema } from '../../ai/schemas.js';
import { createExtractionProvider } from '../../ai/factory.js';
import { checkAICredits, deductAICredits, logAIUsageEvent } from '../../ai/cost-tracker.js';
import { captureCreditRpcFailureAlert } from '../../utils/sentry.js';
import { getExtractionPromptVersion } from '../../ai/prompts/extraction.js';
import { calibrateConfidenceByProvider } from '../../ai/eval/calibration.js';
import { buildExtractionManifest } from '../../ai/extraction-manifest.js';
import { GeminiProvider } from '../../ai/gemini.js';
import type { ExtractedFields, ExtractionResult } from '../../ai/types.js';
import type { Json } from '../../types/database.types.js';
import { db } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const router = Router();
export const AI_EXTRACTION_LATENCY_BUDGET_MS = 4_500;
const ISSUER_KEYWORDS = [
  'university',
  'college',
  'institute',
  'school',
  'academy',
  'board',
  'council',
  'commission',
  'department',
  'ministry',
  'authority',
  'registry',
  'corporation',
  'corp',
  'inc',
  'ltd',
  'llc',
  'society',
] as const;
const ISO_LIKE_DATE_PATTERN = /\b(?:20|19)\d{2}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])\b/;

class ExtractionLatencyError extends Error {
  constructor(budgetMs: number) {
    super(`AI extraction latency budget exceeded (${budgetMs}ms)`);
    this.name = 'ExtractionLatencyError';
  }
}

export function resolveExtractionLatencyBudgetMs(
  env: { AI_EXTRACTION_LATENCY_BUDGET_MS?: string } = process.env,
): number {
  const raw = env.AI_EXTRACTION_LATENCY_BUDGET_MS?.trim();
  if (!raw) return AI_EXTRACTION_LATENCY_BUDGET_MS;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return AI_EXTRACTION_LATENCY_BUDGET_MS;
  return parsed;
}

function withLatencyBudget<T>(operation: Promise<T>, budgetMs = resolveExtractionLatencyBudgetMs()): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new ExtractionLatencyError(budgetMs)), budgetMs);
  });

  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function buildFastFallbackExtraction(params: {
  strippedText: string;
  credentialType: string;
  issuerHint?: string;
  reason: string;
}): ExtractionResult {
  const fields: ExtractedFields = {
    credentialType: params.credentialType,
  };

  const issuerName = inferIssuerName(params.strippedText, params.issuerHint);
  if (issuerName) fields.issuerName = issuerName;

  const issuedDate = inferIssuedDate(params.strippedText);
  if (issuedDate) fields.issuedDate = issuedDate;

  const jurisdiction = inferJurisdiction(params.strippedText);
  if (jurisdiction) fields.jurisdiction = jurisdiction;

  return {
    fields,
    confidence: issuerName ? 0.35 : 0.25,
    provider: 'fast-fallback',
    modelVersion: 'fast-fallback-v1',
    confidenceReasoning: `Degraded extraction returned because ${params.reason}.`,
  };
}

function inferIssuerName(strippedText: string, issuerHint?: string): string | undefined {
  const hint = issuerHint?.trim();
  if (hint) return hint.slice(0, 160);

  const lines = strippedText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 2 && line.length <= 160)
    .filter((line) => !/^\[[A-Z_]+_REDACTED\]$/.test(line));

  const issuerLine = lines.find((line) => {
    const normalized = line.toLowerCase();
    return ISSUER_KEYWORDS.some((keyword) => normalized.includes(keyword));
  });

  return issuerLine ?? lines[0];
}

function inferIssuedDate(strippedText: string): string | undefined {
  const dateMatch = ISO_LIKE_DATE_PATTERN.exec(strippedText);
  return dateMatch?.[0]?.replaceAll('/', '-').replaceAll('.', '-');
}

// bug hunt fix: `\b` binds only to the FIRST/LAST alternative of a `|`-chain,
// not to each alternative individually — the interior alternatives (KDPA,
// OAIC/AHPRA/TEQSA, USA) previously had no word-boundary constraint on either
// side, so they matched as unanchored substrings anywhere in the text (e.g.
// "CAUSATION" contains "USA" and incorrectly matched United States).
//
// Kenya/Australia: every alternative starts and ends with a plain word
// character, so wrapping the whole non-capturing group in `\b(?:...)\b`
// correctly enforces a word boundary on both sides of whichever alternative
// matches.
//
// United States: "U.S.A." and "U.S." end in a literal `.` (non-word), so a
// trailing `\b` right after them almost never holds — `\b` requires a
// word/non-word transition, and a period is virtually always followed by
// whitespace, punctuation, or end-of-string (also non-word), so the
// transition never occurs. That means the ORIGINAL code's `U\.S\.\b`
// alternative was already latently broken (it could not match in realistic
// text). A trailing negative lookahead `(?!\w)` — "not immediately followed
// by a word character" — gives the same "not glued to a longer word"
// protection without depending on the character immediately preceding the
// boundary, so it works uniformly whether the alternative ends in a letter
// ("USA") or a period ("U.S.A.", "U.S.").
const KENYA_JURISDICTION_PATTERN = /\b(?:Kenya|KDPA|ODPC)\b/i;
const AUSTRALIA_JURISDICTION_PATTERN = /\b(?:Australia|OAIC|AHPRA|TEQSA|Privacy Act)\b/i;
const UNITED_STATES_JURISDICTION_PATTERN = /\b(?:United States|USA|U\.S\.A\.|U\.S\.)(?!\w)/i;

export function inferJurisdiction(strippedText: string): string | undefined {
  if (KENYA_JURISDICTION_PATTERN.test(strippedText)) return 'Kenya';
  if (AUSTRALIA_JURISDICTION_PATTERN.test(strippedText)) return 'Australia';
  if (UNITED_STATES_JURISDICTION_PATTERN.test(strippedText)) return 'United States';
  return undefined;
}

function enqueueTagGeneration(fields: Record<string, unknown>): void {
  void Promise.resolve()
    .then(async () => {
      const gemini = new GeminiProvider();
      await gemini.generateTags(fields);
    })
    .catch((tagErr: unknown) => {
      logger.warn({ error: tagErr }, 'Auto-tagging failed (non-fatal)');
    });
}

router.post('/', async (req: Request, res: Response) => {
  const userId = req.authUserId;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  // Validate request body
  const parsed = ExtractionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'validation_error',
      details: parsed.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }

  const { strippedText, credentialType, fingerprint, issuerHint } = parsed.data;

  try {
    // Parallel: fetch profile + check extraction cache simultaneously
    const [profileResult, cacheResult] = await Promise.all([
      db.from('profiles').select('org_id').eq('id', userId).single(),
      db
        .from('ai_usage_events')
        .select('result_json, confidence')
        .eq('fingerprint', fingerprint)
        .eq('event_type', 'extraction')
        .eq('success', true)
        .not('result_json', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1),
    ]);

    const profile = profileResult.data;
    const orgId = profile?.org_id ?? undefined;

    // EFF-1: Check for cached extraction result by fingerprint before calling AI.
    // Saves ~30% of extraction costs from re-uploads, shared documents, error retries.
    const cachedResult = cacheResult.data;

    if (cachedResult && cachedResult.length > 0 && cachedResult[0].result_json) {
      logger.info(
        { fingerprint, userId, orgId },
        'AI extraction cache hit — returning cached result',
      );
      res.json({
        fields: cachedResult[0].result_json,
        confidence: cachedResult[0].confidence ?? 0.5,
        provider: 'cache',
        cached: true,
        creditsRemaining: null,
      });
      return;
    }

    // RISK-6: Synchronous credit check and deduction.
    // Deduction is blocking — if it fails, return 402 Payment Required.
    // Beta mode: check_ai_credits returns unlimited via migration 0084 override.
    const creditBalance = await checkAICredits(orgId, userId);
    if (creditBalance && !creditBalance.hasCredits) {
      res.status(402).json({
        error: 'insufficient_credits',
        message: 'AI extraction credits exhausted. Upgrade your plan for more credits.',
        used: creditBalance.usedThisMonth,
        limit: creditBalance.monthlyAllocation,
      });
      return;
    }

    const deducted = await deductAICredits(orgId, userId, 1);
    if (!deducted && creditBalance) {
      // Deduction failed but credits existed — DB error, not insufficient balance.
      // Behavior is intentionally unchanged here (fail OPEN — proceed with the
      // extraction) per the RISK-6 product decision; this is a REVENUE LEAK
      // (free AI extraction) and must page, not just log.
      logger.error({ orgId, userId }, 'AI credit deduction failed — proceeding with extraction');
      captureCreditRpcFailureAlert({
        rpc: 'deduct_ai_credits',
        operation: 'ai-extract.deductAICredits',
        failMode: 'open',
        error: new Error('deduct_ai_credits failed — proceeding with FREE AI extraction'),
        orgId,
        userId,
        extra: { amount: 1 },
      });
    }

    // Call AI provider
    const startMs = Date.now();
    const provider = createExtractionProvider('user_upload');
    let result: ExtractionResult;
    let degraded = false;
    let fallbackReason: string | undefined;
    let deductedCredit = false;
    try {
      deductedCredit = deducted === true;
      result = await withLatencyBudget(
        provider.extractMetadata({
          strippedText,
          credentialType,
          fingerprint,
          issuerHint,
        }),
      );
    } catch (extractionError) {
      fallbackReason = extractionError instanceof ExtractionLatencyError
        ? 'provider latency budget was exceeded'
        : 'provider extraction failed';
      degraded = true;

      // RISK-6: Synchronous refund on extraction failure
      if (deductedCredit) {
        const refunded = await deductAICredits(orgId, userId, -1);
        if (!refunded) {
          logger.warn({ orgId, userId }, 'Failed to refund AI credit after extraction failure');
        }
      }

      logger.warn(
        { error: extractionError, provider: provider.name, credentialType, fingerprint },
        'AI extraction provider unavailable; returning fast fallback metadata',
      );
      result = buildFastFallbackExtraction({
        strippedText,
        credentialType,
        issuerHint,
        reason: fallbackReason,
      });
    }
    const durationMs = Date.now() - startMs;

    // Apply confidence calibration (AI-EVAL-02 / NMT-03): maps raw model confidence
    // to calibrated confidence that better reflects actual extraction accuracy.
    // Provider-routed — Gemini is underconfident (knots map UP), Nessie is
    // overconfident (knots map DOWN). Using the Gemini function on a Nessie
    // result re-inflates already-calibrated values.
    const rawConfidence = result.confidence;
    const calibrated = degraded
      ? rawConfidence
      : calibrateConfidenceByProvider(result.provider, rawConfidence);

    // Structured observability log — AI extraction latency + quality metrics
    logger.info({
      event: 'ai.extraction.complete',
      provider: result.provider,
      credentialType,
      rawConfidence,
      calibratedConfidence: calibrated,
      fieldsExtracted: Object.keys(result.fields).length,
      tokensUsed: result.tokensUsed ?? 0,
      durationMs,
      userId,
      orgId,
    }, `AI extraction: ${result.provider} ${durationMs}ms conf=${rawConfidence.toFixed(2)}→${calibrated.toFixed(2)} fields=${Object.keys(result.fields).length}`);

    // Log usage event with result cache (EFF-1: enables cache-by-fingerprint)
    // Store calibrated confidence in the cache for consistency
    const promptVersion = getExtractionPromptVersion();
    logAIUsageEvent({
      orgId,
      userId,
      eventType: 'extraction',
      provider: result.provider,
      tokensUsed: result.tokensUsed,
      creditsConsumed: degraded ? 0 : 1,
      fingerprint,
      confidence: calibrated,
      durationMs,
      success: true,
      promptVersion,
      resultJson: result.fields as Record<string, unknown>,
      errorMessage: fallbackReason,
    }).catch(() => {
      // Swallow — logging should not fail the request
    });

    // VAI-01: Build and store extraction manifest — cryptographic binding
    const manifest = buildExtractionManifest({
      fingerprint,
      modelId: result.provider,
      modelVersion: result.modelVersion ?? result.provider,
      extractedFields: result.fields,
      confidenceScores: {
        overall: calibrated,
      },
      promptVersion,
    });

    // Non-blocking DB insert — manifest is audit trail, should not fail extraction
    void Promise.resolve(db.from('extraction_manifests').insert({
      fingerprint: manifest.fingerprint,
      model_id: manifest.modelId,
      model_version: manifest.modelVersion,
      extracted_fields: manifest.extractedFields as Json,
      confidence_scores: manifest.confidenceScores as unknown as Json,
      manifest_hash: manifest.manifestHash,
      org_id: orgId ?? null,
      user_id: userId,
      extraction_timestamp: manifest.extractionTimestamp,
      prompt_version: manifest.promptVersion ?? null,
    })).then(({ error }) => {
      if (error) {
        logger.warn({ error, fingerprint }, 'Failed to store extraction manifest');
      }
    }).catch((err: unknown) => {
      logger.warn({ error: err, fingerprint }, 'Failed to store extraction manifest');
    });

    const fields = result.fields as Record<string, unknown>;
    if (!degraded) {
      // Auto-tagging is enrichment only. It must never block the upload hot path.
      enqueueTagGeneration(fields);
    }

    let creditsRemaining: number | null = null;
    if (creditBalance) {
      creditsRemaining = degraded ? creditBalance.remaining : creditBalance.remaining - 1;
    }

    res.json({
      fields,
      confidence: calibrated,
      provider: result.provider,
      creditsRemaining,
      manifestHash: manifest.manifestHash,
      confidenceScores: manifest.confidenceScores ?? null,
      subType: fields.subType ?? null,
      // API-RICH-02 (SCRUM-895): surface description top-level so HakiChain-style
      // integrators don't have to dig into `fields`.
      description: (fields.description as string | undefined) ?? null,
      fraudSignals: fields.fraudSignals ?? null,
      degraded,
      fallbackReason: fallbackReason ?? null,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ error: err, userId }, 'AI extraction failed');

    // Log failed usage event (non-blocking)
    logAIUsageEvent({
      userId,
      eventType: 'extraction',
      provider: 'unknown',
      success: false,
      errorMessage,
    }).catch(() => {});

    if (errorMessage.includes('circuit breaker')) {
      res.status(503).json({
        error: 'service_unavailable',
        message: 'AI service temporarily unavailable. Please try again later.',
      });
      return;
    }

    res.status(500).json({
      error: 'extraction_failed',
      message: 'Failed to extract credential metadata',
    });
  }
});

export { router as aiExtractRouter };

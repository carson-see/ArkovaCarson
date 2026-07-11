/**
 * scripts/staging/ai-eval/eval-core.ts — pure eval-scoring core for the live
 * AI eval-gate runner. Side-effect-free so the scoring path is unit-testable
 * without a live worker.
 *
 * Flow: golden entry → buildExtractPayload → (HTTP /ai/extract) →
 * fieldsFromExtractResponse → scoreEntry → buildEvalRecord (SCRUM-2382 verdict).
 */

import { createHash } from 'node:crypto';

import {
  compareFields,
  computeFieldMetrics,
  evaluateGate,
  matchesGate,
  SCRUM_2382_GATE,
  type EntryEvalResult,
  type GateEvaluation,
  type GoldenEntry,
} from './scoring.js';
import type { ExtractRequestBody } from './ai-client.js';
import type { ReliabilityReport } from './reliability.js';

/** Deterministic 64-hex fingerprint from the entry id + optional run salt. */
export function fingerprintForEntry(entryId: string, salt = ''): string {
  return createHash('sha256').update(`${entryId}:${salt}`).digest('hex');
}

/**
 * Per-round fingerprint salt. The worker caches extraction results in
 * ai_usage_events keyed by fingerprint (EFF-1, api/v1/ai-extract.ts): a
 * run-level salt only busts that cache for round 1 — every later round of a
 * multi-round soak replays round 1's cached answers as provider=cache, so a
 * --require-live soak degrades to exactly ONE live round (root cause of the
 * PR #1413 window-2/window-3 repeating signature, 2026-07-10/11). Suffixing
 * the round number gives every round fresh cache keys → real inference.
 */
export function saltForRound(runSalt: string, round: number): string {
  return `${runSalt}#round-${round}`;
}

/** Map a golden entry to the POST /api/v1/ai/extract request body. */
export function buildExtractPayload(entry: GoldenEntry, salt = ''): ExtractRequestBody {
  const payload: ExtractRequestBody = {
    strippedText: entry.strippedText,
    credentialType: entry.credentialTypeHint,
    fingerprint: fingerprintForEntry(entry.id, salt),
  };
  if (entry.issuerHint) payload.issuerHint = entry.issuerHint;
  return payload;
}

/**
 * Pull the flat `fields` map out of a /ai/extract response body. Error / gate
 * responses (no `fields`) yield an empty map, which scores as all-missing.
 */
export function fieldsFromExtractResponse(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object' && 'fields' in body) {
    const fields = (body as { fields?: unknown }).fields;
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
      return fields as Record<string, unknown>;
    }
  }
  return {};
}

/**
 * Score one golden entry's extracted fields against its ground truth. An
 * extraction error is retained on the result so a dead / gated AI path is
 * VISIBLE in the evidence (never silently scored as a legitimate 0).
 */
export function scoreEntry(
  entry: GoldenEntry,
  extractedFields: Record<string, unknown>,
  extractionError?: string,
  falseReading?: boolean,
): EntryEvalResult {
  return {
    entryId: entry.id,
    tags: entry.tags,
    fieldResults: compareFields(entry.groundTruth, extractedFields),
    extractionError,
    falseReading,
  };
}

export interface FieldMetricRecord {
  f1: number;
  precision: number;
  recall: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  minimumF1: number;
  passed: boolean;
}

export interface Misclassification {
  entryId: string;
  field: string;
  expected: unknown;
  actual: unknown;
  matchType: string;
}

export interface EvalRecord {
  sampledAt: string;
  apiBase: string;
  provider: string;
  sampleCount: number;
  gateSampleCount: number;
  extractionErrorCount: number;
  /** False readings this round: degraded / fast-fallback 2xx (timeout budget hit). */
  falseReadingCount: number;
  /** Round reliability (429/timeout/false-reading rates) when supplied. */
  reliability?: ReliabilityReport;
  gate: GateEvaluation;
  perField: Record<string, FieldMetricRecord>;
  misclassifications: Misclassification[];
}

/** Providers that represent REAL model inference — a meaningful eval. */
export const LIVE_PROVIDERS = new Set(['gemini', 'gemini-direct', 'nessie', 'together', 'hybrid']);
/** Providers that are NOT real inference — an eval against these is worthless. */
export const NON_LIVE_PROVIDERS = new Set(['mock', 'fast-fallback', 'cache']);

/** Extract the server-reported provider name from an /ai/extract response body. */
export function providerFromBody(body: unknown): string {
  if (body && typeof body === 'object' && 'provider' in body) {
    const p = (body as { provider?: unknown }).provider;
    if (typeof p === 'string') return p;
  }
  return 'unknown';
}

export interface RoundCertification {
  merited: boolean;
  notes: string[];
}

/**
 * A round is merge-grade only if the SCRUM-2382 gate passed AND — when
 * `requireLive` is set — every observed provider was a real model (no
 * mock / fast-fallback / cache). This is the guard against certifying an eval
 * that actually scored deterministic mock output because the rig was missing
 * GEMINI_API_KEY.
 */
export function certifyRound(
  record: EvalRecord,
  providersSeen: Iterable<string>,
  requireLive: boolean,
): RoundCertification {
  const providers = [...providersSeen];
  const notes: string[] = [];
  const ranNonLive = providers.some((p) => NON_LIVE_PROVIDERS.has(p));
  const ranLive = providers.some((p) => LIVE_PROVIDERS.has(p));
  if (record.extractionErrorCount > 0) {
    notes.push(`${record.extractionErrorCount} extraction error(s) this round — AI path returned non-2xx or transport error.`);
  }
  if (ranNonLive) {
    notes.push(
      `Non-live provider(s) observed: ${providers.filter((p) => NON_LIVE_PROVIDERS.has(p)).join(', ')}. ` +
        'Set GEMINI_API_KEY on the rig for real inference.',
    );
  }
  let merited = record.gate.passed;
  if (requireLive && (!ranLive || ranNonLive)) {
    merited = false;
    notes.push('--require-live: round NOT merge-grade because a non-live/mock provider was observed.');
  }
  return { merited, notes };
}

export interface BuildEvalRecordInput {
  sampledAt: string;
  apiBase: string;
  provider: string;
  scored: EntryEvalResult[];
  maxMisclassifications?: number;
  reliability?: ReliabilityReport;
}

/**
 * Assemble one rolling structured eval record: the SCRUM-2382 gate verdict,
 * per-required-field precision/recall/F1, and a bounded sample of
 * misclassifications for triage.
 */
export function buildEvalRecord(input: BuildEvalRecordInput): EvalRecord {
  const { sampledAt, apiBase, provider, scored, maxMisclassifications = 20, reliability } = input;
  const gateEntries = scored.filter(matchesGate);
  const gate = evaluateGate(scored);

  const perField: Record<string, FieldMetricRecord> = {};
  for (const requirement of SCRUM_2382_GATE.requiredFields) {
    const m = computeFieldMetrics(gateEntries, requirement.field);
    perField[requirement.field] = {
      f1: m.f1,
      precision: m.precision,
      recall: m.recall,
      truePositives: m.truePositives,
      falsePositives: m.falsePositives,
      falseNegatives: m.falseNegatives,
      minimumF1: requirement.minimumF1,
      passed: m.f1 >= requirement.minimumF1,
    };
  }

  const misclassifications: Misclassification[] = [];
  for (const entry of gateEntries) {
    for (const fieldResult of entry.fieldResults) {
      if (misclassifications.length >= maxMisclassifications) break;
      if (!fieldResult.correct) {
        misclassifications.push({
          entryId: entry.entryId,
          field: fieldResult.field,
          expected: fieldResult.expected,
          actual: fieldResult.actual,
          matchType: fieldResult.matchType,
        });
      }
    }
    if (misclassifications.length >= maxMisclassifications) break;
  }

  return {
    sampledAt,
    apiBase,
    provider,
    sampleCount: scored.length,
    gateSampleCount: gateEntries.length,
    extractionErrorCount: scored.filter((s) => s.extractionError).length,
    falseReadingCount: scored.filter((s) => s.falseReading).length,
    reliability,
    gate,
    perField,
    misclassifications,
  };
}

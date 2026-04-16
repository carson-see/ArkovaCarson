/**
 * AI Eval Runner (AI-EVAL-01)
 *
 * Executes extraction against the golden dataset and computes metrics.
 * Can run against any IAIProvider (mock, gemini, cloudflare).
 */

import crypto from 'crypto';
import type { IAIProvider, ExtractionRequest } from '../types.js';
import type {
  GoldenDatasetEntry,
  EntryEvalResult,
  EvalRunResult,
} from './types.js';
import { compareFields, computeAggregateMetrics } from './scoring.js';
import { calibrateConfidence } from './calibration.js';
import { computeAdjustedConfidence } from '../confidence-model.js';
import { EXTRACTION_SYSTEM_PROMPT } from '../prompts/extraction.js';

/**
 * Generate a deterministic fake fingerprint for eval (SHA-256 of entry ID).
 */
function fakeFingerprint(entryId: string): string {
  return crypto.createHash('sha256').update(entryId).digest('hex');
}

/**
 * Hash the current extraction prompt for versioning.
 */
export function getPromptVersionHash(): string {
  return crypto
    .createHash('sha256')
    .update(EXTRACTION_SYSTEM_PROMPT)
    .digest('hex')
    .substring(0, 12);
}

export interface EvalRunOptions {
  /** Provider to test */
  provider: IAIProvider;
  /** Dataset entries to evaluate (defaults to full golden dataset) */
  entries: GoldenDatasetEntry[];
  /** Concurrency limit for parallel extraction calls */
  concurrency?: number;
  /** Callback for progress reporting */
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Evaluate a single golden dataset entry against the provider.
 */
async function evaluateEntry(
  provider: IAIProvider,
  entry: GoldenDatasetEntry,
): Promise<EntryEvalResult> {
  const request: ExtractionRequest = {
    strippedText: entry.strippedText,
    credentialType: entry.credentialTypeHint,
    fingerprint: fakeFingerprint(entry.id),
    issuerHint: entry.issuerHint,
  };

  const start = Date.now();
  let extractedFields: Record<string, unknown> = {};
  let confidence = 0;
  let tokensUsed = 0;

  let extractionError: string | undefined;
  try {
    const result = await provider.extractMetadata(request);
    extractedFields = result.fields as Record<string, unknown>;
    confidence = result.confidence;
    tokensUsed = result.tokensUsed ?? 0;
  } catch (err) {
    // Extraction failed — capture the error so the bug is visible in eval output
    // (silent swallowing here is what masked the dead-RunPod-endpoint bug + the
    // Together-non-serverless bug for months — never go back to silent catch)
    extractedFields = {};
    confidence = 0;
    extractionError = err instanceof Error ? err.message : String(err);
    if (process.env.EVAL_VERBOSE === '1') {
      // eslint-disable-next-line no-console
      console.error(`[eval] entry=${entry.id} provider=${provider.name} ERROR: ${extractionError}`);
    }
  }

  const latencyMs = Date.now() - start;
  const fieldResults = compareFields(entry.groundTruth, extractedFields);
  const correctCount = fieldResults.filter(r => r.correct).length;
  const actualAccuracy = fieldResults.length > 0 ? correctCount / fieldResults.length : 0;

  return {
    entryId: entry.id,
    credentialType: entry.groundTruth.credentialType || entry.credentialTypeHint,
    category: entry.category,
    tags: entry.tags,
    fieldResults,
    reportedConfidence: confidence,
    calibratedConfidence: calibrateConfidence(confidence),
    adjustedConfidence: computeAdjustedConfidence(
      extractedFields as import('../types.js').ExtractedFields,
      confidence,
      entry.strippedText,
    ),
    actualAccuracy,
    latencyMs,
    provider: provider.name,
    tokensUsed,
  };
}

/**
 * Run extraction eval against the golden dataset.
 */
export async function runEval(options: EvalRunOptions): Promise<EvalRunResult> {
  const { provider, entries, concurrency = 5, onProgress } = options;
  const entryResults: EntryEvalResult[] = [];
  let completed = 0;

  // Process in batches for concurrency control
  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(entry => evaluateEntry(provider, entry)),
    );
    entryResults.push(...batchResults);
    completed += batchResults.length;
    onProgress?.(completed, entries.length);
  }

  // Compute overall metrics
  const overall = computeAggregateMetrics('ALL', entryResults);

  // Compute per-credential-type metrics
  const typeGroups = new Map<string, EntryEvalResult[]>();
  for (const result of entryResults) {
    const type = result.credentialType;
    const existing = typeGroups.get(type) || [];
    existing.push(result);
    typeGroups.set(type, existing);
  }
  const byCredentialType = Array.from(typeGroups.entries()).map(
    ([type, results]) => computeAggregateMetrics(type, results),
  );

  return {
    timestamp: new Date().toISOString(),
    provider: provider.name,
    promptVersionHash: getPromptVersionHash(),
    totalEntries: entries.length,
    entryResults,
    overall,
    byCredentialType,
  };
}

/**
 * Format eval results as a human-readable markdown report.
 */
export function formatEvalReport(result: EvalRunResult): string {
  const lines: string[] = [];

  lines.push('# AI Extraction Eval Report');
  lines.push('');
  lines.push(`- **Date:** ${result.timestamp}`);
  lines.push(`- **Provider:** ${result.provider}`);
  lines.push(`- **Prompt Version:** ${result.promptVersionHash}`);
  lines.push(`- **Entries Evaluated:** ${result.totalEntries}`);
  lines.push('');

  // Overall metrics
  lines.push('## Overall Metrics');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Macro F1 | ${(result.overall.macroF1 * 100).toFixed(1)}% |`);
  lines.push(`| Weighted F1 | ${(result.overall.weightedF1 * 100).toFixed(1)}% |`);
  lines.push(`| Mean Reported Confidence | ${(result.overall.meanReportedConfidence * 100).toFixed(1)}% |`);
  lines.push(`| Mean Actual Accuracy | ${(result.overall.meanActualAccuracy * 100).toFixed(1)}% |`);
  lines.push(`| Confidence Correlation (r) — raw | ${result.overall.confidenceCorrelation.toFixed(3)} |`);
  if (result.overall.calibratedCorrelation !== undefined) {
    lines.push(`| Confidence Correlation (r) — calibrated | ${result.overall.calibratedCorrelation.toFixed(3)} |`);
    lines.push(`| Mean Calibrated Confidence | ${((result.overall.meanCalibratedConfidence ?? 0) * 100).toFixed(1)}% |`);
  }
  lines.push(`| Mean Latency | ${result.overall.meanLatencyMs.toFixed(0)}ms |`);
  lines.push('');

  // Per-field metrics
  lines.push('## Per-Field Metrics');
  lines.push('');
  lines.push('| Field | Precision | Recall | F1 | TP | FP | FN |');
  lines.push('|-------|-----------|--------|----|----|----|----|');
  for (const fm of result.overall.fieldMetrics) {
    lines.push(
      `| ${fm.field} | ${(fm.precision * 100).toFixed(1)}% | ${(fm.recall * 100).toFixed(1)}% | ${(fm.f1 * 100).toFixed(1)}% | ${fm.truePositives} | ${fm.falsePositives} | ${fm.falseNegatives} |`,
    );
  }
  lines.push('');

  // Per-credential-type metrics
  lines.push('## Per-Credential-Type Metrics');
  lines.push('');
  lines.push('| Type | Entries | Macro F1 | Weighted F1 | Confidence Corr |');
  lines.push('|------|---------|----------|-------------|-----------------|');
  for (const tm of result.byCredentialType) {
    lines.push(
      `| ${tm.scope} | ${tm.totalEntries} | ${(tm.macroF1 * 100).toFixed(1)}% | ${(tm.weightedF1 * 100).toFixed(1)}% | ${tm.confidenceCorrelation.toFixed(3)} |`,
    );
  }
  lines.push('');

  // Worst-performing entries
  const worst = [...result.entryResults]
    .sort((a, b) => a.actualAccuracy - b.actualAccuracy)
    .slice(0, 10);
  lines.push('## Worst-Performing Entries (Bottom 10)');
  lines.push('');
  lines.push('| Entry | Type | Accuracy | Confidence | Errors |');
  lines.push('|-------|------|----------|------------|--------|');
  for (const entry of worst) {
    const errors = entry.fieldResults
      .filter(r => !r.correct)
      .map(r => `${r.field}: ${r.matchType}`)
      .join(', ');
    lines.push(
      `| ${entry.entryId} | ${entry.credentialType} | ${(entry.actualAccuracy * 100).toFixed(0)}% | ${(entry.reportedConfidence * 100).toFixed(0)}% | ${errors} |`,
    );
  }

  // Confidence calibration
  lines.push('');
  lines.push('## Confidence Calibration');
  lines.push('');
  const buckets = [
    { min: 0, max: 0.3, label: '0-30%' },
    { min: 0.3, max: 0.5, label: '30-50%' },
    { min: 0.5, max: 0.7, label: '50-70%' },
    { min: 0.7, max: 0.9, label: '70-90%' },
    { min: 0.9, max: 1.01, label: '90-100%' },
  ];
  lines.push('| Confidence Bucket | Count | Mean Accuracy | Calibration Gap |');
  lines.push('|-------------------|-------|---------------|-----------------|');
  for (const bucket of buckets) {
    const entries = result.entryResults.filter(
      e => e.reportedConfidence >= bucket.min && e.reportedConfidence < bucket.max,
    );
    if (entries.length === 0) {
      lines.push(`| ${bucket.label} | 0 | — | — |`);
      continue;
    }
    const meanAcc = entries.reduce((s, e) => s + e.actualAccuracy, 0) / entries.length;
    const midpoint = (bucket.min + bucket.max) / 2;
    const gap = meanAcc - midpoint;
    lines.push(
      `| ${bucket.label} | ${entries.length} | ${(meanAcc * 100).toFixed(1)}% | ${gap > 0 ? '+' : ''}${(gap * 100).toFixed(1)}pp |`,
    );
  }

  return lines.join('\n');
}

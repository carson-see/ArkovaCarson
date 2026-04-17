/**
 * NVI-07 — Teacher-response validation pipeline (SCRUM-811).
 *
 * Every response from the teacher model (Claude Opus) passes this pipeline
 * before being allowed into the distilled training JSONL. Rejection is
 * cheap — we only keep responses that meet every bar.
 *
 * Bars:
 *   1. Structural validity: non-empty `analysis`, `risks`, `recommendations`,
 *      `citations` all present; `confidence` in [0.55, 0.99]; jurisdiction
 *      present; applicable_law present.
 *   2. Citation anchoring: every `citations[i].record_id` must exist in the
 *      verified source registry (`verification-status.json` output from
 *      NVI-01..04) — and that registry entry must pass overallPassed=true.
 *   3. Minimum evidence: at least one citation is expected by the template
 *      (per `variation.expectedSources`), or the teacher must cite at least
 *      one verified source overall. "Naked" answers without anchors are
 *      rejected.
 *
 * The validator is pure — all I/O is through the registry shape passed in,
 * not loaded from disk. This keeps it unit-testable offline.
 */

import type { IntelligenceAnswer } from '../intelligence-dataset/types';
import type { Registry } from '../intelligence-dataset/validators/verification-registry';
import type { ValidationResult, VariationQuery } from './types';

export interface ValidateOpts {
  /** Verified-source registry from NVI-01..04 runs. */
  registry: Registry;
}

export function validateTeacherAnswer(
  variation: VariationQuery,
  answer: IntelligenceAnswer,
  opts: ValidateOpts,
): ValidationResult {
  const reasons: string[] = [];
  const { registry } = opts;

  // 1. Structural validity.
  if (!answer.analysis || answer.analysis.trim().length === 0) reasons.push('empty analysis');
  if (!Array.isArray(answer.risks) || answer.risks.length === 0) reasons.push('empty risks');
  if (!Array.isArray(answer.recommendations) || answer.recommendations.length === 0) reasons.push('empty recommendations');
  if (!Array.isArray(answer.citations)) reasons.push('citations is not an array');
  if (typeof answer.confidence !== 'number' || answer.confidence < 0.55 || answer.confidence > 0.99) {
    reasons.push(`confidence out of range [0.55, 0.99]: ${answer.confidence}`);
  }
  if (!answer.jurisdiction) reasons.push('missing jurisdiction');
  if (!answer.applicable_law) reasons.push('missing applicable_law');

  // 2. Citation anchoring.
  const citations = Array.isArray(answer.citations) ? answer.citations : [];
  const unverified: string[] = [];
  for (const c of citations) {
    if (!c || typeof c.record_id !== 'string' || c.record_id.length === 0) {
      reasons.push('citation entry missing record_id');
      continue;
    }
    const entry = registry.sources[c.record_id];
    if (!entry) {
      unverified.push(`${c.record_id} (not in registry)`);
      continue;
    }
    if (!entry.overallPassed || entry.orphaned) {
      unverified.push(`${c.record_id} (registry entry not passing)`);
    }
  }
  if (unverified.length > 0) {
    reasons.push(`unverified citations: ${unverified.join(', ')}`);
  }

  // 3. Minimum evidence.
  if (citations.length === 0) {
    reasons.push('no citations at all — naked answer');
  }

  const accepted = reasons.length === 0;
  return { variationId: variation.id, accepted, reasons, answer };
}

/** Roll up accepted/rejected counts + rejection-reason histogram. */
export function summariseValidations(results: ValidationResult[]): {
  accepted: number;
  rejectedByReason: Record<string, number>;
} {
  const summary = { accepted: 0, rejectedByReason: {} as Record<string, number> };
  for (const r of results) {
    if (r.accepted) {
      summary.accepted++;
      continue;
    }
    for (const reason of r.reasons) {
      // Drop the dynamic suffix after colons so different specific offenders
      // merge under the same generic bucket.
      const bucket = reason.split(':')[0];
      summary.rejectedByReason[bucket] = (summary.rejectedByReason[bucket] ?? 0) + 1;
    }
  }
  return summary;
}

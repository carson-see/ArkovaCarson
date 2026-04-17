/**
 * NVI-11 — Professional FCRA gold-standard benchmark (SCRUM-815).
 *
 * The existing FCRA eval (`eval/fcra-50-eval.ts` etc.) was written by the
 * same system that wrote the training data — there's inherent self-eval
 * bias. This module defines the SHAPE of a professionally-authored
 * benchmark so an external FCRA compliance attorney can populate it
 * without touching any code.
 *
 * Attorney deliverable per question:
 *   - `question`            — realistic client scenario
 *   - `referenceAnswer`     — what an FCRA attorney would write
 *   - `requiredCitations`   — statute / case / agency IDs the answer MUST carry
 *   - `requiredRiskKeywords`— key phrases the answer's `risks` must surface
 *   - `requiredRecommendationKeywords`
 *                           — key phrases the `recommendations` must surface
 *   - `rubric`              — criteria for each of the five 0–4 tiers
 *   - `authorCredential`    — bar number / firm / signed-date (populated by
 *                             attorney when question is finalised)
 *
 * The benchmark MUST be held-out — any question id that appears in
 * training contaminates the measurement. `ensureHeldOut()` is the guard.
 */

import type { IntelligenceAnswer, IntelligenceScenario } from '../types';

export type BenchmarkQuadrant =
  | 'pre-adverse'           // §604(b)(3)
  | 'adverse-action'        // §615(a)
  | 'permissible-purpose'   // §604(a)
  | 'disputes'              // §611, §623
  | 'state-variations'      // CA, NY, IL, MA overlays
  | 'risk-patterns'         // ID fraud, diploma mill, sanctions
  | 'cross-reg';            // FCRA × ADA / Title VII / GINA / HIPAA

/** Five-tier scoring rubric (0 = missed, 4 = expert-level). */
export interface BenchmarkRubric {
  expertCriteria: string;
  goodCriteria: string;
  adequateCriteria: string;
  partialCriteria: string;
  missedCriteria: string;
}

export interface BenchmarkQuestion {
  /** Stable kebab-case id. Must NEVER appear in training scenarios. */
  id: string;
  quadrant: BenchmarkQuadrant;
  question: string;
  /** Attorney's reference answer — the gold-standard to score against. */
  referenceAnswer: IntelligenceAnswer;
  /** Source IDs from the verified-source registry the candidate answer MUST cite. */
  requiredCitations: string[];
  /** Substrings the candidate's `risks` entries must collectively contain. */
  requiredRiskKeywords: string[];
  /** Substrings the candidate's `recommendations` must collectively contain. */
  requiredRecommendationKeywords: string[];
  rubric: BenchmarkRubric;
  /** Attorney credential + signed-date string. "pending attorney review" until reviewed. */
  authorCredential: string;
  /** Must be true for every benchmark item — prevents training-set contamination. */
  heldOut: boolean;
}

export interface BenchmarkIndex {
  byId: Map<string, BenchmarkQuestion>;
  byQuadrant: Map<BenchmarkQuadrant, BenchmarkQuestion[]>;
}

// ---------------------------------------------------------------------------
// Validation + indexing
// ---------------------------------------------------------------------------

export function validateBenchmark(items: BenchmarkQuestion[]): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  for (const q of items) {
    if (seen.has(q.id)) {
      errs.push(`duplicate id: ${q.id}`);
      continue;
    }
    seen.add(q.id);

    if (!q.question || q.question.trim().length === 0) errs.push(`${q.id}: empty question`);
    if (!q.heldOut) errs.push(`${q.id}: heldOut must be true (benchmark contaminates eval otherwise)`);
    if (!q.authorCredential) errs.push(`${q.id}: authorCredential required (use "pending attorney review" as placeholder)`);
    if (!q.requiredCitations || q.requiredCitations.length === 0) errs.push(`${q.id}: requiredCitations is empty`);

    const rubricKeys: (keyof BenchmarkRubric)[] = [
      'expertCriteria', 'goodCriteria', 'adequateCriteria', 'partialCriteria', 'missedCriteria',
    ];
    for (const k of rubricKeys) {
      if (!q.rubric || !q.rubric[k] || q.rubric[k].trim().length === 0) {
        errs.push(`${q.id}: rubric.${k} is empty`);
      }
    }
  }
  return errs;
}

export function buildBenchmarkIndex(items: BenchmarkQuestion[]): BenchmarkIndex {
  const byId = new Map<string, BenchmarkQuestion>();
  const byQuadrant = new Map<BenchmarkQuadrant, BenchmarkQuestion[]>();
  for (const q of items) {
    byId.set(q.id, q);
    const bucket = byQuadrant.get(q.quadrant) ?? [];
    bucket.push(q);
    byQuadrant.set(q.quadrant, bucket);
  }
  return { byId, byQuadrant };
}

/**
 * Hard guard: no benchmark id may appear in training. Throws if so.
 * Intended for the build pipeline + CI.
 */
export function ensureHeldOut(
  benchmark: BenchmarkQuestion[],
  training: IntelligenceScenario[],
): void {
  const benchIds = new Set(benchmark.map((b) => b.id));
  const collisions: string[] = [];
  for (const sc of training) {
    if (benchIds.has(sc.id)) collisions.push(sc.id);
  }
  if (collisions.length > 0) {
    throw new Error(
      `benchmark held-out violation: ${collisions.length} training scenario id(s) overlap benchmark: ${collisions.join(', ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Rubric scoring
// ---------------------------------------------------------------------------

export interface BenchmarkScore {
  questionId: string;
  tier: 0 | 1 | 2 | 3 | 4;
  components: {
    citationCoverage: number;      // 0..1 — fraction of requiredCitations present
    riskCoverage: number;          // 0..1 — fraction of requiredRiskKeywords found
    recommendationCoverage: number;// 0..1 — fraction of requiredRecommendationKeywords found
  };
  missing: {
    citations: string[];
    riskKeywords: string[];
    recommendationKeywords: string[];
  };
}

function fraction(found: number, total: number): number {
  if (total === 0) return 1;
  return found / total;
}

/**
 * Map an aggregate score in [0, 1] to a tier. The thresholds reflect the
 * rubric's five-level scale: 0 (missed), 1 (partial), 2 (adequate), 3
 * (good), 4 (expert). Tuned so an answer that meets all requirements
 * scores 4 — tighten in subsequent iterations if inter-rater shows drift.
 */
function aggregateToTier(agg: number): 0 | 1 | 2 | 3 | 4 {
  if (agg >= 0.95) return 4;
  if (agg >= 0.80) return 3;
  if (agg >= 0.60) return 2;
  if (agg >= 0.30) return 1;
  return 0;
}

export function scoreBenchmarkAnswer(
  q: BenchmarkQuestion,
  candidate: IntelligenceAnswer,
): BenchmarkScore {
  const candidateCitationIds = new Set(candidate.citations.map((c) => c.record_id));
  const missingCitations = q.requiredCitations.filter((id) => !candidateCitationIds.has(id));
  const citationCoverage = fraction(
    q.requiredCitations.length - missingCitations.length,
    q.requiredCitations.length,
  );

  const risksBlob = candidate.risks.join(' ').toLowerCase();
  const missingRiskKeywords = q.requiredRiskKeywords.filter((k) => !risksBlob.includes(k.toLowerCase()));
  const riskCoverage = fraction(
    q.requiredRiskKeywords.length - missingRiskKeywords.length,
    q.requiredRiskKeywords.length,
  );

  const recsBlob = candidate.recommendations.join(' ').toLowerCase();
  const missingRecommendationKeywords = q.requiredRecommendationKeywords.filter(
    (k) => !recsBlob.includes(k.toLowerCase()),
  );
  const recommendationCoverage = fraction(
    q.requiredRecommendationKeywords.length - missingRecommendationKeywords.length,
    q.requiredRecommendationKeywords.length,
  );

  const aggregate = (citationCoverage + riskCoverage + recommendationCoverage) / 3;
  let tier = aggregateToTier(aggregate);
  // Citation-floor: a compliance answer that doesn't carry the required
  // primary-source anchors can't be "adequate" or higher regardless of
  // keyword coverage. This mirrors how an attorney would grade: "great
  // reasoning, no statute cited" is a partial answer at best.
  if (citationCoverage === 0 && tier > 1) tier = 1;
  else if (citationCoverage < 0.5 && tier > 2) tier = 2;

  return {
    questionId: q.id,
    tier,
    components: { citationCoverage, riskCoverage, recommendationCoverage },
    missing: {
      citations: missingCitations,
      riskKeywords: missingRiskKeywords,
      recommendationKeywords: missingRecommendationKeywords,
    },
  };
}

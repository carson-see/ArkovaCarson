/**
 * NVI-13 — Production canary + feedback loop (SCRUM-817).
 *
 * Pure-function routing + review + promotion-gate logic. All I/O and
 * model-calling glue stays outside this module so the decision logic is
 * deterministic and test-friendly.
 *
 * Lifecycle:
 *   1. `routeToCanary(request, config, rng)` → decide which model serves
 *      this query (`canary` | `baseline`), whether to shadow-log both.
 *   2. HybridProvider (elsewhere) calls both models if `shadow=true`,
 *      returns baseline to the user, writes a `CanaryShadowRecord`.
 *   3. Compliance-team reviewer labels each shadow record
 *      (`better` | `equal` | `worse`) via admin UI.
 *   4. `promotionDecision()` computes whether to bump the canary % based
 *      on the reviewed sample.
 *   5. `captureFailureAsScenario()` turns a "worse" shadow record into a
 *      production-failure training scenario for the next training cycle.
 */

/**
 * Canonical shape duplicated from `scripts/intelligence-dataset/types.ts`
 * because worker `tsconfig.rootDir` forbids `src/ → scripts/` imports.
 * Keep the fields here structurally identical; a field drift makes
 * `captureFailureAsScenario()` silently wrong.
 */
export interface IntelligenceAnswer {
  analysis: string;
  citations: Array<{ record_id: string; quote: string; source: string }>;
  risks: string[];
  recommendations: string[];
  confidence: number;
  jurisdiction: string;
  applicable_law: string;
  should_refuse?: boolean;
  escalation_trigger?: boolean;
}

export type CategoryId = string;

export interface IntelligenceScenario {
  id: string;
  category: CategoryId;
  query: string;
  expected: IntelligenceAnswer;
  notes?: string;
}

export type CanaryDomain = 'fcra' | 'hipaa' | 'ferpa';

export interface CanaryConfig {
  /** Fraction in [0, 1]. 0.05 = 5%. */
  canaryPercent: number;
  /** Which domains the canary applies to. */
  enabledDomains: CanaryDomain[];
  /** When true, call baseline + canary, return baseline, log both. */
  shadow: boolean;
}

export interface CanaryRequest {
  domain: CanaryDomain;
}

export interface CanaryDecision {
  model: 'canary' | 'baseline';
  shadow: boolean;
  reason: string;
}

export interface CanaryShadowRecord {
  /** Storage-assigned id. */
  id: string;
  query: string;
  domain: CanaryDomain;
  /** The intelligence-dataset category (used when capturing failures as scenarios). */
  category: CategoryId;
  baselineAnswer: IntelligenceAnswer;
  canaryAnswer: IntelligenceAnswer;
  servedAt: string;
}

export interface CanaryReview {
  shadowRecordId: string;
  /** Compliance-reviewer verdict on canary vs baseline. */
  label: 'better' | 'equal' | 'worse';
  reviewerId: string;
  reviewedAt: string;
  notes: string;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export function routeToCanary(
  req: CanaryRequest,
  cfg: CanaryConfig,
  rng: () => number = Math.random,
): CanaryDecision {
  if (cfg.canaryPercent < 0 || cfg.canaryPercent > 1) {
    throw new Error(`canaryPercent must be in [0, 1]; got ${cfg.canaryPercent}`);
  }
  if (!cfg.enabledDomains.includes(req.domain)) {
    return { model: 'baseline', shadow: false, reason: `domain ${req.domain} not enabled for canary` };
  }
  if (cfg.canaryPercent === 0) {
    return { model: 'baseline', shadow: cfg.shadow, reason: 'canaryPercent=0' };
  }
  const r = rng();
  if (r < cfg.canaryPercent) {
    return { model: 'canary', shadow: cfg.shadow, reason: `sampled (${r.toFixed(3)} < ${cfg.canaryPercent})` };
  }
  return { model: 'baseline', shadow: cfg.shadow, reason: `sampled (${r.toFixed(3)} ≥ ${cfg.canaryPercent})` };
}

// ---------------------------------------------------------------------------
// Review summary + promotion gate
// ---------------------------------------------------------------------------

export interface ReviewSummary {
  better: number;
  equal: number;
  worse: number;
  total: number;
}

export function summariseReviews(reviews: CanaryReview[]): ReviewSummary {
  const s: ReviewSummary = { better: 0, equal: 0, worse: 0, total: reviews.length };
  for (const r of reviews) s[r.label] += 1;
  return s;
}

export interface PromotionCriteria {
  /** Minimum reviewed records before any promotion decision is possible. */
  minReviewed: number;
  /** Fraction of (better + equal) over total required. 0.70 = 70%. */
  matchRatePct: number;
  /** The next canary % to advance to when the gate opens. */
  nextPercent: number;
}

export interface PromotionDecision {
  canPromote: boolean;
  nextPercent: number;
  matchRate: number;
  reason: string;
}

export function promotionDecision(
  reviews: CanaryReview[],
  criteria: PromotionCriteria,
): PromotionDecision {
  const s = summariseReviews(reviews);
  if (s.total < criteria.minReviewed) {
    return {
      canPromote: false,
      nextPercent: criteria.nextPercent,
      matchRate: 0,
      reason: `insufficient reviews: ${s.total} < minimum ${criteria.minReviewed}`,
    };
  }
  const matchRate = (s.better + s.equal) / s.total;
  if (matchRate < criteria.matchRatePct) {
    return {
      canPromote: false,
      nextPercent: criteria.nextPercent,
      matchRate,
      reason: `match rate ${(matchRate * 100).toFixed(1)}% below gate ${(criteria.matchRatePct * 100).toFixed(0)}%`,
    };
  }
  return {
    canPromote: true,
    nextPercent: criteria.nextPercent,
    matchRate,
    reason: `match rate ${(matchRate * 100).toFixed(1)}% ≥ gate ${(criteria.matchRatePct * 100).toFixed(0)}%`,
  };
}

// ---------------------------------------------------------------------------
// Failure capture
// ---------------------------------------------------------------------------

/**
 * Turn a shadow record flagged "worse" into an `IntelligenceScenario`
 * the training pipeline can pick up. By default uses the baseline
 * answer as ground truth — reviewers can override with an attorney-
 * corrected answer from NVI-05 tier-3 packets.
 */
export function captureFailureAsScenario(
  shadow: CanaryShadowRecord,
  opts: { correctAnswer?: IntelligenceAnswer } = {},
): IntelligenceScenario {
  return {
    id: `prod-failure::${shadow.id}`,
    category: shadow.category,
    query: shadow.query,
    expected: opts.correctAnswer ?? shadow.baselineAnswer,
  };
}

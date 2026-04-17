/**
 * Recommendation Engine (NCA-05)
 *
 * Turns the gaps emitted by `org-audit.ts` into a prioritised, grouped,
 * actionable list of recommendations for the org admin.
 *
 * Priority formula:
 *   priority = severityWeight * jurisdictionPenaltyRisk / effortHours
 *
 * Grouping:
 *   - Quick Wins: priority >= 5 AND effort_hours <= 2
 *   - Critical: severity === 'critical'
 *   - Upcoming: category === 'EXPIRING_SOON'
 *   - Standard: everything else
 *
 * Jira: SCRUM-760 (NCA-05)
 */

import type { AuditGap } from './org-audit.js';

export type RecommendationGroup =
  | 'QUICK_WIN'
  | 'CRITICAL'
  | 'UPCOMING'
  | 'STANDARD';

export interface Recommendation {
  id: string;
  title: string;
  description: string;
  expected_score_improvement: number;
  effort_hours: number;
  affected_jurisdictions: string[];
  deadline: string | null;
  group: RecommendationGroup;
  priority_score: number;
  /** ids of gaps this recommendation addresses (drill-down linking). */
  gap_keys: string[];
  severity: AuditGap['severity'];
}

export interface BuildRecommendationsInput {
  gaps: AuditGap[];
  /**
   * Optional jurisdiction penalty risk multipliers. Higher = harsher
   * regulator / larger fines. Default 1.0 when unset.
   */
  jurisdictionPenaltyRisk?: Record<string, number>;
  /** Upper bound on returned recommendations. Default 20. */
  maxRecommendations?: number;
  /** Clock override for deterministic tests (ms since epoch). */
  now?: number;
}

export interface BuildRecommendationsResult {
  recommendations: Recommendation[];
  overflow_count: number;
  grouped: {
    quick_wins: Recommendation[];
    critical: Recommendation[];
    upcoming: Recommendation[];
    standard: Recommendation[];
  };
}

const SEVERITY_WEIGHT: Record<AuditGap['severity'], number> = {
  critical: 10,
  high: 6,
  medium: 3,
  low: 1,
};

/** Hours of engineering / admin effort to resolve a given gap type. */
const EFFORT_HOURS_BY_TYPE: Record<string, number> = {
  LICENSE: 4,
  PROFESSIONAL: 3,
  ATTESTATION: 1,
  CERTIFICATE: 2,
  CONTINUING_EDUCATION: 2,
  DEGREE: 6,
  TRANSCRIPT: 2,
  INSURANCE: 2,
  OTHER: 2,
};

/** Extra hours added on top of the base when the gap is an expired/insufficient doc. */
const EFFORT_ADJUSTMENT: Record<AuditGap['category'], number> = {
  MISSING: 0,
  EXPIRED: 1,
  EXPIRING_SOON: 1,
  INSUFFICIENT: 3,
};

function effortHoursFor(gap: AuditGap): number {
  const base = EFFORT_HOURS_BY_TYPE[gap.type] ?? EFFORT_HOURS_BY_TYPE.OTHER;
  return base + EFFORT_ADJUSTMENT[gap.category];
}

/**
 * Deterministic key so we can dedupe gaps (same type + category +
 * jurisdiction) into one recommendation.
 */
function gapKey(gap: AuditGap): string {
  return `${gap.jurisdiction_code}::${gap.type}::${gap.category}`;
}

function titleFor(gap: AuditGap): string {
  switch (gap.category) {
    case 'MISSING':
      return `Upload missing ${gap.type} for ${gap.jurisdiction_code}`;
    case 'EXPIRED':
      return `Renew expired ${gap.type}`;
    case 'EXPIRING_SOON':
      return `Renew ${gap.type} before expiry`;
    case 'INSUFFICIENT':
      return `Re-verify ${gap.type} (fraud flags present)`;
  }
}

function deadlineFor(gap: AuditGap, now: number): string | null {
  if (gap.category !== 'EXPIRING_SOON' || gap.days_remaining == null) return null;
  return new Date(now + gap.days_remaining * 86_400_000).toISOString();
}

function groupFor(
  severity: AuditGap['severity'],
  category: AuditGap['category'],
  priorityScore: number,
  effortHours: number,
): RecommendationGroup {
  if (severity === 'critical') return 'CRITICAL';
  if (category === 'EXPIRING_SOON') return 'UPCOMING';
  if (priorityScore >= 5 && effortHours <= 2) return 'QUICK_WIN';
  return 'STANDARD';
}

/**
 * Collapse duplicate gaps into one recommendation. When two gaps share a
 * (jurisdiction, type, category) triplet, we take the higher severity one
 * and merge the affected_jurisdictions list across the set of sources.
 */
export function buildRecommendations(
  input: BuildRecommendationsInput,
): BuildRecommendationsResult {
  const now = input.now ?? Date.now();
  const riskMap = input.jurisdictionPenaltyRisk ?? {};
  const max = input.maxRecommendations ?? 20;

  // Group gaps by (type, category) across jurisdictions so duplicates
  // merge rather than producing N identical cards.
  type Bucket = {
    baseGap: AuditGap;
    gap_keys: Set<string>;
    jurisdictions: Set<string>;
    severities: Set<AuditGap['severity']>;
  };
  const byTypeCategory = new Map<string, Bucket>();

  for (const gap of input.gaps) {
    const bucketKey = `${gap.type}::${gap.category}`;
    const existing = byTypeCategory.get(bucketKey);
    if (existing) {
      existing.gap_keys.add(gapKey(gap));
      existing.jurisdictions.add(gap.jurisdiction_code);
      existing.severities.add(gap.severity);
      if (SEVERITY_WEIGHT[gap.severity] > SEVERITY_WEIGHT[existing.baseGap.severity]) {
        existing.baseGap = gap;
      }
      continue;
    }
    byTypeCategory.set(bucketKey, {
      baseGap: gap,
      gap_keys: new Set([gapKey(gap)]),
      jurisdictions: new Set([gap.jurisdiction_code]),
      severities: new Set([gap.severity]),
    });
  }

  const recs: Recommendation[] = [];
  for (const bucket of byTypeCategory.values()) {
    const gap = bucket.baseGap;
    const severityWeight = SEVERITY_WEIGHT[gap.severity];
    const penaltyRisk = Math.max(
      ...[...bucket.jurisdictions].map((j) => riskMap[j] ?? 1.0),
    );
    const effortHours = effortHoursFor(gap);
    const priorityScore = (severityWeight * penaltyRisk) / effortHours;

    // Score improvement is a simple estimate: severity weight scaled by
    // jurisdiction count (wider reach = higher improvement).
    const expectedScoreImprovement = Math.min(
      30,
      Math.round(severityWeight * 1.5 * bucket.jurisdictions.size),
    );

    recs.push({
      id: `rec-${gap.category.toLowerCase()}-${gap.type.toLowerCase()}`,
      title: titleFor(gap),
      description: gap.remediation_hint,
      expected_score_improvement: expectedScoreImprovement,
      effort_hours: effortHours,
      affected_jurisdictions: [...bucket.jurisdictions].sort(),
      deadline: deadlineFor(gap, now),
      group: groupFor(gap.severity, gap.category, priorityScore, effortHours),
      priority_score: Number(priorityScore.toFixed(2)),
      gap_keys: [...bucket.gap_keys].sort(),
      severity: gap.severity,
    });
  }

  recs.sort((a, b) => b.priority_score - a.priority_score);

  const overflow = Math.max(0, recs.length - max);
  const truncated = recs.slice(0, max);

  return {
    recommendations: truncated,
    overflow_count: overflow,
    grouped: {
      quick_wins: truncated.filter((r) => r.group === 'QUICK_WIN'),
      critical: truncated.filter((r) => r.group === 'CRITICAL'),
      upcoming: truncated.filter((r) => r.group === 'UPCOMING'),
      standard: truncated.filter((r) => r.group === 'STANDARD'),
    },
  };
}

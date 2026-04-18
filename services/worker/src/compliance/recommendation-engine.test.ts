import { describe, expect, it } from 'vitest';
import { buildRecommendations } from './recommendation-engine.js';
import type { AuditGap } from './org-audit.js';

function gap(partial: Partial<AuditGap>): AuditGap {
  return {
    type: partial.type ?? 'LICENSE',
    category: partial.category ?? 'MISSING',
    requirement: partial.requirement ?? 'Required: LICENSE',
    jurisdiction_code: partial.jurisdiction_code ?? 'US-CA',
    industry_code: partial.industry_code ?? 'accounting',
    regulatory_reference: partial.regulatory_reference ?? null,
    severity: partial.severity ?? 'high',
    remediation_hint: partial.remediation_hint ?? 'Do the thing',
    days_remaining: partial.days_remaining,
    anchor_id: partial.anchor_id,
  };
}

const FIXED_NOW = Date.UTC(2026, 3, 17);

describe('NCA-05 buildRecommendations', () => {
  it('returns an empty result when there are no gaps', () => {
    const r = buildRecommendations({ gaps: [] });
    expect(r.recommendations).toEqual([]);
    expect(r.overflow_count).toBe(0);
    expect(r.grouped.quick_wins).toEqual([]);
    expect(r.grouped.critical).toEqual([]);
    expect(r.grouped.upcoming).toEqual([]);
    expect(r.grouped.standard).toEqual([]);
  });

  it('sorts by priority_score descending', () => {
    const r = buildRecommendations({
      gaps: [
        gap({ type: 'LICENSE', severity: 'low', category: 'MISSING' }),
        gap({ type: 'LICENSE', severity: 'critical', category: 'EXPIRED' }),
        gap({ type: 'LICENSE', severity: 'high', category: 'EXPIRING_SOON', days_remaining: 30 }),
        gap({ type: 'LICENSE', severity: 'medium', category: 'INSUFFICIENT' }),
      ],
    });
    // Same type across gaps so effort variance is small; severity dominates.
    expect(r.recommendations[0].severity).toBe('critical');
    expect(r.recommendations[r.recommendations.length - 1].severity).toBe('low');
    for (let i = 1; i < r.recommendations.length; i++) {
      expect(r.recommendations[i].priority_score).toBeLessThanOrEqual(
        r.recommendations[i - 1].priority_score,
      );
    }
  });

  it('dedupes gaps with the same (type, category) across jurisdictions', () => {
    const r = buildRecommendations({
      gaps: [
        gap({ type: 'LICENSE', jurisdiction_code: 'US-CA' }),
        gap({ type: 'LICENSE', jurisdiction_code: 'US-NY' }),
        gap({ type: 'LICENSE', jurisdiction_code: 'US-TX' }),
      ],
    });
    expect(r.recommendations.length).toBe(1);
    expect(r.recommendations[0].affected_jurisdictions).toEqual(['US-CA', 'US-NY', 'US-TX']);
    expect(r.recommendations[0].gap_keys.length).toBe(3);
  });

  it('classifies quick wins (high priority + low effort) into QUICK_WIN group', () => {
    const r = buildRecommendations({
      gaps: [
        // ATTESTATION: effort 1h, severity high → priority = 6/1 = 6 → QUICK_WIN
        gap({ type: 'ATTESTATION', severity: 'high' }),
      ],
    });
    expect(r.grouped.quick_wins.length).toBe(1);
    expect(r.grouped.critical.length).toBe(0);
    expect(r.recommendations[0].group).toBe('QUICK_WIN');
    expect(r.recommendations[0].effort_hours).toBeLessThanOrEqual(2);
  });

  it('classifies critical severity into CRITICAL group regardless of effort', () => {
    const r = buildRecommendations({
      gaps: [gap({ type: 'DEGREE', severity: 'critical' })],
    });
    expect(r.grouped.critical.length).toBe(1);
    expect(r.recommendations[0].group).toBe('CRITICAL');
  });

  it('classifies EXPIRING_SOON into UPCOMING and sets a deadline', () => {
    const r = buildRecommendations({
      gaps: [
        gap({ type: 'LICENSE', category: 'EXPIRING_SOON', severity: 'high', days_remaining: 14 }),
      ],
      now: FIXED_NOW,
    });
    expect(r.grouped.upcoming.length).toBe(1);
    expect(r.recommendations[0].group).toBe('UPCOMING');
    expect(r.recommendations[0].deadline).toBe(new Date(FIXED_NOW + 14 * 86_400_000).toISOString());
  });

  it('applies jurisdictionPenaltyRisk multiplier when provided', () => {
    const base = buildRecommendations({
      gaps: [gap({ type: 'LICENSE', jurisdiction_code: 'US-CA' })],
    });
    const boosted = buildRecommendations({
      gaps: [gap({ type: 'LICENSE', jurisdiction_code: 'US-CA' })],
      jurisdictionPenaltyRisk: { 'US-CA': 2.5 },
    });
    expect(boosted.recommendations[0].priority_score).toBeGreaterThan(
      base.recommendations[0].priority_score,
    );
  });

  it('truncates to maxRecommendations and records overflow_count', () => {
    const gaps = Array.from({ length: 25 }, (_, i) =>
      gap({
        type: 'OTHER',
        jurisdiction_code: `X-${String(i).padStart(2, '0')}`,
      }),
    );
    // All 25 have same (type, category) so the dedupe folds to 1; push 25
    // distinct buckets by varying category + type.
    const variedGaps: AuditGap[] = [];
    const cats: AuditGap['category'][] = ['MISSING', 'EXPIRED', 'EXPIRING_SOON', 'INSUFFICIENT'];
    const types = [
      'LICENSE', 'PROFESSIONAL', 'ATTESTATION', 'CERTIFICATE',
      'CONTINUING_EDUCATION', 'DEGREE', 'TRANSCRIPT', 'INSURANCE',
    ];
    for (const t of types) {
      for (const c of cats) {
        variedGaps.push(gap({ type: t, category: c, severity: 'medium' }));
      }
    }
    expect(variedGaps.length).toBe(32);
    const r = buildRecommendations({ gaps: variedGaps, maxRecommendations: 20 });
    expect(r.recommendations.length).toBe(20);
    expect(r.overflow_count).toBe(12);
    // reference unused var for lint
    expect(gaps.length).toBe(25);
  });

  it('groups a mixed set across CRITICAL / UPCOMING / QUICK_WIN / STANDARD', () => {
    const r = buildRecommendations({
      gaps: [
        gap({ type: 'LICENSE', severity: 'critical' }), // CRITICAL
        gap({ type: 'CERTIFICATE', category: 'EXPIRING_SOON', severity: 'high', days_remaining: 20 }), // UPCOMING
        gap({ type: 'ATTESTATION', severity: 'high' }), // QUICK_WIN
        gap({ type: 'DEGREE', severity: 'medium' }), // STANDARD
      ],
    });
    expect(r.grouped.critical.length).toBe(1);
    expect(r.grouped.upcoming.length).toBe(1);
    expect(r.grouped.quick_wins.length).toBe(1);
    expect(r.grouped.standard.length).toBe(1);
  });

  it('links recommendations back to the gaps that produced them (gap_keys)', () => {
    const r = buildRecommendations({
      gaps: [
        gap({ type: 'LICENSE', jurisdiction_code: 'US-CA' }),
        gap({ type: 'LICENSE', jurisdiction_code: 'US-NY' }),
      ],
    });
    expect(r.recommendations[0].gap_keys).toEqual(
      ['US-CA::LICENSE::MISSING', 'US-NY::LICENSE::MISSING'],
    );
  });

  it('computes expected_score_improvement scaled by jurisdiction reach', () => {
    const single = buildRecommendations({
      gaps: [gap({ type: 'LICENSE', severity: 'high', jurisdiction_code: 'US-CA' })],
    });
    const multi = buildRecommendations({
      gaps: [
        gap({ type: 'LICENSE', severity: 'high', jurisdiction_code: 'US-CA' }),
        gap({ type: 'LICENSE', severity: 'high', jurisdiction_code: 'US-NY' }),
        gap({ type: 'LICENSE', severity: 'high', jurisdiction_code: 'US-TX' }),
      ],
    });
    expect(multi.recommendations[0].expected_score_improvement).toBeGreaterThan(
      single.recommendations[0].expected_score_improvement,
    );
    // Hard cap at 30
    expect(multi.recommendations[0].expected_score_improvement).toBeLessThanOrEqual(30);
  });
});

import { describe, expect, it } from 'vitest';
import {
  computeRegulatoryChangeImpact,
  detectRuleChangesSince,
  type RuleChangeSignal,
} from './regulatory-change.js';
import type { OrgAuditResult, AuditGap } from './org-audit.js';

function gap(partial: Partial<AuditGap>): AuditGap {
  return {
    type: partial.type ?? 'LICENSE',
    category: partial.category ?? 'MISSING',
    requirement: partial.requirement ?? 'Required',
    jurisdiction_code: partial.jurisdiction_code ?? 'US-CA',
    industry_code: partial.industry_code ?? 'accounting',
    regulatory_reference: partial.regulatory_reference ?? null,
    severity: partial.severity ?? 'high',
    remediation_hint: partial.remediation_hint ?? 'Do the thing',
    days_remaining: partial.days_remaining,
    anchor_id: partial.anchor_id,
  };
}

function audit(score: number, gaps: AuditGap[]): OrgAuditResult {
  return {
    overall_score: score,
    overall_grade: score >= 80 ? 'B' : 'F',
    per_jurisdiction: [],
    gaps,
    quarantines: [],
    // recommendations not needed for this test
    recommendations: {
      recommendations: [],
      overflow_count: 0,
      grouped: { quick_wins: [], critical: [], upcoming: [], standard: [] },
    },
  };
}

const EMPTY_CHANGE: RuleChangeSignal = {
  changed_rule_ids: [],
  changed_regulations: [],
  added_rule_ids: [],
  deprecated_rule_ids: [],
};

describe('NCA-06 computeRegulatoryChangeImpact', () => {
  it('returns severity NONE when nothing changed', () => {
    const r = computeRegulatoryChangeImpact(audit(90, []), audit(90, []), EMPTY_CHANGE);
    expect(r.severity).toBe('NONE');
    expect(r.delta).toBe(0);
    expect(r.new_gap_keys).toEqual([]);
  });

  it('returns IN_APP severity for a 5-9 point drop', () => {
    const r = computeRegulatoryChangeImpact(
      audit(90, []),
      audit(83, []),
      { ...EMPTY_CHANGE, changed_rule_ids: ['r1'] },
    );
    expect(r.severity).toBe('IN_APP');
    expect(r.delta).toBe(-7);
  });

  it('returns EMAIL severity for a >=10 point drop', () => {
    const r = computeRegulatoryChangeImpact(
      audit(90, []),
      audit(75, []),
      { ...EMPTY_CHANGE, changed_rule_ids: ['r1'] },
    );
    expect(r.severity).toBe('EMAIL');
    expect(r.delta).toBe(-15);
  });

  it('IN_APP when new gaps appear with a rule change but no big drop', () => {
    const r = computeRegulatoryChangeImpact(
      audit(90, []),
      audit(88, [gap({ type: 'ATTESTATION', jurisdiction_code: 'US-CA' })]),
      { ...EMPTY_CHANGE, changed_rule_ids: ['r1'] },
    );
    expect(r.severity).toBe('IN_APP');
    expect(r.new_gap_keys).toContain('US-CA::ATTESTATION::MISSING');
  });

  it('INFO when only administrative rule changes with no behaviour shift', () => {
    const r = computeRegulatoryChangeImpact(
      audit(90, []),
      audit(90, []),
      { ...EMPTY_CHANGE, changed_rule_ids: ['r1'] },
    );
    expect(r.severity).toBe('INFO');
  });

  it('diffs new and resolved gaps correctly', () => {
    const prev = audit(80, [
      gap({ type: 'LICENSE' }),
      gap({ type: 'CERTIFICATE' }),
    ]);
    const next = audit(80, [
      gap({ type: 'LICENSE' }),
      gap({ type: 'ATTESTATION' }),
    ]);
    const r = computeRegulatoryChangeImpact(prev, next, { ...EMPTY_CHANGE, changed_rule_ids: ['r1'] });
    expect(r.new_gap_keys).toEqual(['US-CA::ATTESTATION::MISSING']);
    expect(r.resolved_gap_keys).toEqual(['US-CA::CERTIFICATE::MISSING']);
  });

  it('produces a human-readable summary line', () => {
    const r = computeRegulatoryChangeImpact(
      audit(90, []),
      audit(80, [gap({ type: 'ATTESTATION' })]),
      {
        changed_rule_ids: ['r1'],
        changed_regulations: ['FCRA §604'],
        added_rule_ids: ['r2'],
        deprecated_rule_ids: [],
      },
    );
    expect(r.summary).toContain('Score dropped by 10 points');
    expect(r.summary).toContain('1 new rule');
    expect(r.summary).toContain('1 rule(s) updated');
    expect(r.summary).toContain('1 new gap');
  });

  it('deduplicates changed_regulations in output', () => {
    const r = computeRegulatoryChangeImpact(audit(90, []), audit(85, []), {
      changed_rule_ids: ['r1', 'r2'],
      changed_regulations: ['FCRA §604', 'FCRA §604'],
      added_rule_ids: [],
      deprecated_rule_ids: [],
    });
    expect(r.changed_regulations).toEqual(['FCRA §604']);
  });
});

describe('NCA-06 detectRuleChangesSince', () => {
  const REF = '2026-04-01T00:00:00Z';

  it('classifies newly-created, updated, and deprecated rules correctly', () => {
    const signal = detectRuleChangesSince(
      [
        { id: 'r-new', created_at: '2026-04-05T00:00:00Z', updated_at: '2026-04-05T00:00:00Z', regulatory_reference: 'FCRA §604' },
        { id: 'r-upd', created_at: '2025-01-01T00:00:00Z', updated_at: '2026-04-10T00:00:00Z', regulatory_reference: 'HIPAA §164' },
        { id: 'r-depr', created_at: '2023-01-01T00:00:00Z', updated_at: '2023-06-01T00:00:00Z', deprecated_at: '2026-04-03T00:00:00Z', regulatory_reference: 'SOX §302' },
        { id: 'r-stale', created_at: '2023-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', regulatory_reference: 'FERPA' },
      ],
      REF,
    );
    expect(signal.added_rule_ids).toEqual(['r-new']);
    expect(signal.changed_rule_ids).toEqual(['r-upd']);
    expect(signal.deprecated_rule_ids).toEqual(['r-depr']);
    expect(signal.changed_regulations.sort()).toEqual(['FCRA §604', 'HIPAA §164', 'SOX §302']);
  });

  it('returns an empty signal when no rules have moved', () => {
    const signal = detectRuleChangesSince(
      [
        { id: 'r1', created_at: '2023-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z', regulatory_reference: 'x' },
      ],
      REF,
    );
    expect(signal.added_rule_ids).toEqual([]);
    expect(signal.changed_rule_ids).toEqual([]);
    expect(signal.deprecated_rule_ids).toEqual([]);
    expect(signal.changed_regulations).toEqual([]);
  });
});

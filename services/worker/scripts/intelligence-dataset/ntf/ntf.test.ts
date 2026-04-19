/**
 * NTF-01..07 (SCRUM-773..779) — unified test suite.
 *
 * One file per module keeps the run fast and the blast radius small.
 * Every branch in every module has a pass-case and a fail-case.
 */

import { describe, expect, it } from 'vitest';
import {
  NTF02_LORA_RANK_ABLATION,
  isEdgeCase,
  pickAblationWinner,
  scoreReasoningQuality,
  type NtfAblationResult,
} from './reasoning-quality';
import {
  COMPLIANCE_QA_SEED,
  buildComplianceQaReport,
  scoreComplianceQaEntry,
  type ComplianceQaAnswerCandidate,
} from './compliance-qa-eval';
import {
  NTF04_ACCURACY_TARGET,
  crossReferenceClaim,
  scoreCrossRefAccuracy,
} from './cross-ref-verification';
import {
  INTERSTATE_COMPACTS,
  NTF05_ACCURACY_TARGET,
  analyzePortability,
  scorePortabilityAccuracy,
} from './portability';
import {
  NTF06_ACCURACY_TARGET,
  resolveConflict,
  scoreConflictAccuracy,
} from './regulatory-conflict';
import {
  NTF07_COMPLETENESS_TARGET,
  NTF07_SEVERITY_TARGET,
  classifySeverity,
  priorityForSeverity,
  renderFinding,
  scoreFindings,
  validateFindingStructure,
  type AuditFinding,
  type SeverityInput,
} from './audit-finding';

// ---------------------------------------------------------------------------
// NTF-01/02 reasoning quality + ablation
// ---------------------------------------------------------------------------

describe('NTF-01 reasoning quality scorer', () => {
  const answer = {
    analysis: 'Per FCRA §604(b)(3) [15 U.S.C. §1681b(b)(3)] the employer must send pre-adverse-action notice.',
    citations: [{ record_id: 'fcra-604-b-3', quote: '15 U.S.C. §1681b(b)(3)', source: 'FCRA §604(b)(3)' }],
    risks: ['non-delivery timing gap'],
    recommendations: ['send the notice at least 5 business days before adverse action'],
    confidence: 0.88,
    jurisdiction: 'federal' as const,
    applicable_law: 'FCRA §604(b)(3)',
  };
  const sources = [
    {
      id: 'fcra-604-b-3',
      quote: '15 U.S.C. §1681b(b)(3) — pre-adverse-action notice required',
      source: 'FCRA §604(b)(3)',
      lastVerified: '2026-04-18',
      tags: ['statute'],
      jurisdiction: 'federal' as const,
    },
  ];
  const fullReasoning = {
    step1_question_kind: 'compliance_qa' as const,
    step2_federal_statutes: ['§604(b)(3)', '15 U.S.C. §1681b(b)(3)'],
    step3_statutory_exceptions: 'none apply',
    step4_state_overlays: 'CA ICRAA adds §1786.40 notification',
    step5_risks: ['non-delivery timing gap'],
    step6_recommendations: ['send the notice at least 5 business days before adverse action'],
    step7_confidence_band: 'clear-statute',
    step8_escalation_trigger: 'none',
  };

  it('perfect inputs produce overall ≥ 0.9', () => {
    const r = scoreReasoningQuality({ answer, reasoning: fullReasoning, sources });
    expect(r.overall).toBeGreaterThanOrEqual(0.9);
    expect(r.issues).toEqual([]);
  });

  it('missing reasoning steps penalise coherence', () => {
    const sparse = { ...fullReasoning, step2_federal_statutes: [], step4_state_overlays: '', step5_risks: [] };
    const r = scoreReasoningQuality({ answer, reasoning: sparse, sources });
    expect(r.coherence).toBeLessThan(1);
  });

  it('zero citations collapses factual accuracy to 0', () => {
    const r = scoreReasoningQuality({ answer: { ...answer, citations: [] }, reasoning: fullReasoning, sources });
    expect(r.factualAccuracy).toBe(0);
  });

  it('citation to unknown source is flagged as an issue', () => {
    const ans = { ...answer, citations: [{ record_id: 'unknown', quote: 'x', source: 'x' }] };
    const r = scoreReasoningQuality({ answer: ans, reasoning: fullReasoning, sources });
    expect(r.issues.some((i) => i.includes('unknown source'))).toBe(true);
  });

  it('answer statute references not mentioned in reasoning lower completeness', () => {
    const sparse = { ...fullReasoning, step2_federal_statutes: [], step3_statutory_exceptions: '', step4_state_overlays: '' };
    const r = scoreReasoningQuality({ answer, reasoning: sparse, sources });
    expect(r.completeness).toBeLessThan(1);
  });
});

describe('NTF-02 edge-case detection', () => {
  const baseAns = {
    analysis: 'a',
    citations: [],
    risks: ['x'],
    recommendations: ['y'],
    confidence: 0.8,
    jurisdiction: 'federal' as const,
    applicable_law: 'FCRA',
  };
  const reasoning = {
    step1_question_kind: 'compliance_qa' as const,
    step2_federal_statutes: [],
    step3_statutory_exceptions: '',
    step4_state_overlays: '',
    step5_risks: [],
    step6_recommendations: [],
    step7_confidence_band: '',
    step8_escalation_trigger: '',
  };

  it('flags scenario when coherence is low', () => {
    expect(isEdgeCase(baseAns, reasoning)).toBe(true);
  });

  it('flags refusal scenario regardless of coherence', () => {
    const full = { ...reasoning, step1_question_kind: 'compliance_qa' as const, step2_federal_statutes: ['a'], step3_statutory_exceptions: 'a', step4_state_overlays: 'a', step5_risks: ['a'], step6_recommendations: ['a'], step7_confidence_band: 'a', step8_escalation_trigger: 'a' };
    expect(isEdgeCase({ ...baseAns, should_refuse: true }, full)).toBe(true);
  });
});

describe('NTF-02 LoRA ablation winner selection', () => {
  const mk = (rank: number, macro: number, edge: number, latency: number): NtfAblationResult => ({
    rank: rank as (typeof NTF02_LORA_RANK_ABLATION)[number],
    macroF1: macro,
    edgeCaseMacroF1: edge,
    trainMinutes: 120,
    p50LatencyMs: latency,
  });

  it('picks the rank that wins edge cases when none regress', () => {
    const r = pickAblationWinner([mk(32, 0.85, 0.7, 100), mk(64, 0.86, 0.8, 110), mk(128, 0.86, 0.82, 120)], 0.84);
    expect(r.winner.rank).toBe(128);
  });

  it('rejects ranks that regress macro F1 below baseline', () => {
    const r = pickAblationWinner([mk(32, 0.85, 0.7, 100), mk(64, 0.8, 0.9, 110)], 0.84);
    expect(r.winner.rank).toBe(32);
    expect(r.rejected.find((x) => x.rank === 64)).toBeTruthy();
  });

  it('rejects ranks whose latency doubles', () => {
    const r = pickAblationWinner([mk(32, 0.85, 0.7, 100), mk(64, 0.86, 0.95, 300)], 0.84);
    expect(r.winner.rank).toBe(32);
    expect(r.rejected.find((x) => x.rank === 64 && x.reason.includes('latency'))).toBeTruthy();
  });

  it('throws when every rank regresses', () => {
    expect(() => pickAblationWinner([mk(32, 0.7, 0.6, 100)], 0.84)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// NTF-03 compliance Q&A eval
// ---------------------------------------------------------------------------

describe('NTF-03 compliance Q&A eval', () => {
  it('seed covers all five domains with ≥1 entry each', () => {
    const domains = new Set(COMPLIANCE_QA_SEED.map((e) => e.domain));
    expect(domains.size).toBe(5);
  });

  it('perfect answer scores combined 1.0', () => {
    const entry = COMPLIANCE_QA_SEED[0];
    const answer: ComplianceQaAnswerCandidate = {
      id: entry.id,
      text: entry.expectedKeyPoints.join(' '),
      confidence: 0.95,
      risks: entry.expectedRisks,
    };
    const r = scoreComplianceQaEntry(entry, answer);
    expect(r.combined).toBe(1);
    expect(r.confidenceOk).toBe(true);
  });

  it('low confidence flips confidenceOk off', () => {
    const entry = COMPLIANCE_QA_SEED[0];
    const r = scoreComplianceQaEntry(entry, {
      id: entry.id,
      text: entry.expectedKeyPoints.join(' '),
      confidence: 0.1,
      risks: entry.expectedRisks,
    });
    expect(r.confidenceOk).toBe(false);
  });

  it('builds a report that aggregates across domains', () => {
    const results = COMPLIANCE_QA_SEED.map((e) => scoreComplianceQaEntry(e, {
      id: e.id,
      text: e.expectedKeyPoints.join(' '),
      confidence: 0.9,
      risks: e.expectedRisks,
    }));
    const report = buildComplianceQaReport(results, COMPLIANCE_QA_SEED);
    expect(report.entriesScored).toBe(COMPLIANCE_QA_SEED.length);
    expect(report.meanKeyPointRecall).toBe(1);
    expect(report.confidenceOkRate).toBe(1);
    expect(report.byDomain.ferpa.n).toBeGreaterThan(0);
  });

  it('flags below-threshold entries as failing', () => {
    const e = COMPLIANCE_QA_SEED[0];
    const r = scoreComplianceQaEntry(e, { id: e.id, text: '', confidence: 0, risks: [] });
    const report = buildComplianceQaReport([r], [e]);
    expect(report.failing.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// NTF-04 cross-reference verification
// ---------------------------------------------------------------------------

describe('NTF-04 cross-reference verification', () => {
  it('returns MATCH when every field lines up', () => {
    const v = crossReferenceClaim(
      { credentialType: 'MEDICAL', subject: { name: 'Jane Doe', identifiers: { NPI: '1' } }, claimed: { specialty: 'cardiology' } },
      { source: 'NPPES', actual: { specialty: 'cardiology', registeredName: 'Jane Doe' }, fetchedAt: '2026-04-18', registryStatus: 'ACTIVE' },
    );
    expect(v.verdict).toBe('MATCH');
  });

  it('detects diploma mill when claim date is after institution closure', () => {
    const v = crossReferenceClaim(
      { credentialType: 'DEGREE', subject: { name: 'Alice Smith', identifiers: {} }, claimed: { conferralDate: '2020-06-01' } },
      { source: 'IPEDS', actual: { closureDate: '2015-01-01', registeredName: 'Alice Smith' }, fetchedAt: '2026-04-18', registryStatus: 'CLOSED' },
    );
    expect(v.verdict).toBe('FABRICATED');
    expect(v.confidence).toBeGreaterThan(0.9);
  });

  it('flags EXPIRED when the registry expired and the claim says active', () => {
    const v = crossReferenceClaim(
      { credentialType: 'MEDICAL', subject: { name: 'Bob Jones', identifiers: {} }, claimed: { status: 'active' } },
      { source: 'STATE_LICENSE', actual: { registeredName: 'Bob Jones' }, fetchedAt: '2026-04-18', registryStatus: 'EXPIRED' },
    );
    expect(v.verdict).toBe('EXPIRED');
  });

  it('name divergence trumps specialty match', () => {
    const v = crossReferenceClaim(
      { credentialType: 'LEGAL', subject: { name: 'Carol A', identifiers: {} }, claimed: { barNumber: '123' } },
      { source: 'BAR', actual: { barNumber: '123', registeredName: 'Zane X' }, fetchedAt: '2026-04-18' },
    );
    expect(v.verdict).toBe('FABRICATED');
  });

  it('single-token legitimate name (Madonna) is not flagged as FABRICATED', () => {
    const v = crossReferenceClaim(
      { credentialType: 'LEGAL', subject: { name: 'Madonna', identifiers: {} }, claimed: { barNumber: '123' } },
      { source: 'BAR', actual: { barNumber: '123', registeredName: 'Madonna' }, fetchedAt: '2026-04-18' },
    );
    expect(v.verdict).not.toBe('FABRICATED');
  });

  it('one field mismatch → PARTIAL_MATCH', () => {
    const v = crossReferenceClaim(
      { credentialType: 'MEDICAL', subject: { name: 'Jane Doe', identifiers: {} }, claimed: { specialty: 'cardiology' } },
      { source: 'NPPES', actual: { specialty: 'internal medicine', registeredName: 'Jane Doe' }, fetchedAt: '2026-04-18' },
    );
    expect(v.verdict).toBe('PARTIAL_MATCH');
  });

  it('scoreCrossRefAccuracy runs on a mini eval set', () => {
    const entries = [
      {
        claim: { credentialType: 'MEDICAL', subject: { name: 'Jane Doe', identifiers: {} }, claimed: { specialty: 'cardiology' } },
        record: { source: 'NPPES' as const, actual: { specialty: 'cardiology', registeredName: 'Jane Doe' }, fetchedAt: '2026-04-18', registryStatus: 'ACTIVE' as const },
        expected: 'MATCH' as const,
      },
      {
        claim: { credentialType: 'DEGREE', subject: { name: 'Alice Smith', identifiers: {} }, claimed: { conferralDate: '2020-06-01' } },
        record: { source: 'IPEDS' as const, actual: { closureDate: '2015-01-01', registeredName: 'Alice Smith' }, fetchedAt: '2026-04-18', registryStatus: 'CLOSED' as const },
        expected: 'FABRICATED' as const,
      },
    ];
    const r = scoreCrossRefAccuracy(entries);
    expect(r.accuracy).toBeGreaterThanOrEqual(NTF04_ACCURACY_TARGET);
  });
});

// ---------------------------------------------------------------------------
// NTF-05 portability
// ---------------------------------------------------------------------------

describe('NTF-05 portability analyzer', () => {
  it('compact pairing returns FULL_PORTABILITY', () => {
    const r = analyzePortability({ profession: 'RN', sourceState: 'TX', targetState: 'CO', licenseStatus: 'ACTIVE' });
    expect(r.outcome).toBe('FULL_PORTABILITY');
    expect(r.compactId).toBe('nlc');
  });

  it('suspended license forces FULL_REAPPLICATION', () => {
    const r = analyzePortability({ profession: 'RN', sourceState: 'TX', targetState: 'CO', licenseStatus: 'SUSPENDED' });
    expect(r.outcome).toBe('FULL_REAPPLICATION');
    expect(r.compactId).toBeNull();
  });

  it('non-compact state for physician returns ENDORSEMENT', () => {
    const r = analyzePortability({ profession: 'Physician', sourceState: 'CA', targetState: 'NY', licenseStatus: 'ACTIVE' });
    expect(r.outcome).toBe('ENDORSEMENT');
  });

  it('covers NLC, IMLC, ASWB, PSYPACT, PT Compact at minimum', () => {
    const ids = new Set(INTERSTATE_COMPACTS.map((c) => c.id));
    expect(ids.has('nlc')).toBe(true);
    expect(ids.has('imlc')).toBe(true);
    expect(ids.has('aswb')).toBe(true);
    expect(ids.has('psypact')).toBe(true);
    expect(ids.has('pt-compact')).toBe(true);
  });

  it('accuracy on a clean seed hits the target', () => {
    const entries = [
      { query: { profession: 'RN', sourceState: 'TX', targetState: 'CO', licenseStatus: 'ACTIVE' as const }, expectedOutcome: 'FULL_PORTABILITY' as const },
      { query: { profession: 'RN', sourceState: 'TX', targetState: 'CO', licenseStatus: 'SUSPENDED' as const }, expectedOutcome: 'FULL_REAPPLICATION' as const },
      { query: { profession: 'Physician', sourceState: 'CA', targetState: 'NY', licenseStatus: 'ACTIVE' as const }, expectedOutcome: 'ENDORSEMENT' as const },
    ];
    const r = scorePortabilityAccuracy(entries);
    expect(r.accuracy).toBeGreaterThanOrEqual(NTF05_ACCURACY_TARGET);
  });
});

// ---------------------------------------------------------------------------
// NTF-06 regulatory conflict
// ---------------------------------------------------------------------------

describe('NTF-06 regulatory conflict resolver', () => {
  it('floor preemption with stricter state + dual compliance → STATE_CONTROLS', () => {
    const r = resolveConflict({
      federalRule: 'HIPAA Privacy Rule',
      federalPosture: 'FLOOR',
      stateRule: 'CA CMIA',
      stateMoreStringent: true,
      dualComplianceFeasible: true,
    });
    expect(r.outcome).toBe('STATE_CONTROLS');
  });

  it('floor preemption + impossibility → FEDERAL_CONTROLS', () => {
    const r = resolveConflict({
      federalRule: 'HIPAA',
      federalPosture: 'FLOOR',
      stateRule: 'hypothetical conflicting state law',
      stateMoreStringent: true,
      dualComplianceFeasible: false,
    });
    expect(r.outcome).toBe('FEDERAL_CONTROLS');
  });

  it('ceiling preemption with stricter state → STATE_INVALID', () => {
    const r = resolveConflict({
      federalRule: 'federal rule with ceiling',
      federalPosture: 'CEILING',
      stateRule: 'state exceeds ceiling',
      stateMoreStringent: true,
      dualComplianceFeasible: true,
    });
    expect(r.outcome).toBe('STATE_INVALID');
  });

  it('express preemption invalidates state law regardless of stringency', () => {
    const strict = resolveConflict({
      federalRule: 'federal rule',
      federalPosture: 'EXPRESS',
      stateRule: 'stricter state rule',
      stateMoreStringent: true,
      dualComplianceFeasible: true,
    });
    const lax = resolveConflict({
      federalRule: 'federal rule',
      federalPosture: 'EXPRESS',
      stateRule: 'laxer state rule',
      stateMoreStringent: false,
      dualComplianceFeasible: true,
    });
    expect(strict.outcome).toBe('STATE_INVALID');
    expect(lax.outcome).toBe('STATE_INVALID');
  });

  it('field preemption always → STATE_INVALID', () => {
    const r = resolveConflict({
      federalRule: 'ERISA',
      federalPosture: 'FIELD',
      stateRule: 'state employee benefits regulation',
      stateMoreStringent: false,
      dualComplianceFeasible: true,
    });
    expect(r.outcome).toBe('STATE_INVALID');
  });

  it('no preemption → CONCURRENT_COMPLIANCE', () => {
    const r = resolveConflict({
      federalRule: 'federal adjacent rule',
      federalPosture: 'NONE',
      stateRule: 'state rule',
      stateMoreStringent: true,
      dualComplianceFeasible: true,
    });
    expect(r.outcome).toBe('CONCURRENT_COMPLIANCE');
  });

  it('accuracy on a clean seed hits the target', () => {
    const entries = [
      { query: { federalRule: 'HIPAA', federalPosture: 'FLOOR' as const, stateRule: 'CA CMIA', stateMoreStringent: true, dualComplianceFeasible: true }, expectedOutcome: 'STATE_CONTROLS' as const },
      { query: { federalRule: 'ERISA', federalPosture: 'FIELD' as const, stateRule: 'state', stateMoreStringent: false, dualComplianceFeasible: true }, expectedOutcome: 'STATE_INVALID' as const },
      { query: { federalRule: 'FDA drug regulation', federalPosture: 'EXPRESS' as const, stateRule: 'state drug rule', stateMoreStringent: true, dualComplianceFeasible: true }, expectedOutcome: 'STATE_INVALID' as const },
    ];
    const r = scoreConflictAccuracy(entries);
    expect(r.accuracy).toBeGreaterThanOrEqual(NTF06_ACCURACY_TARGET);
  });
});

// ---------------------------------------------------------------------------
// NTF-07 audit findings
// ---------------------------------------------------------------------------

describe('NTF-07 audit findings', () => {
  const baseFinding: AuditFinding = {
    id: 'finding-001',
    framework: 'SOX',
    controlObjective: 'Segregate duties between AP approval and initiation',
    condition: 'One individual both approved and initiated vendor payments for 6 months',
    criteria: 'COSO Control Environment + SOX §404',
    cause: 'Staff turnover led to role consolidation without compensating control',
    effect: 'Increased fraud risk; potential material misstatement of AP balances',
    recommendations: ['Split approval from initiation', 'Add detective review until split is live'],
    quantifiedExposureUsd: 2_500_000,
    severity: 'SIGNIFICANT_DEFICIENCY',
  };

  it('complete finding passes validation', () => {
    expect(validateFindingStructure(baseFinding)).toEqual([]);
  });

  it('partial finding returns the missing components', () => {
    const missing = validateFindingStructure({ ...baseFinding, condition: '', cause: '', recommendations: [] });
    expect(missing.toSorted((a, b) => a.localeCompare(b))).toEqual(['cause', 'condition', 'recommendations']);
  });

  it('severity: financial impact above materiality + no compensating control = MATERIAL_WEAKNESS', () => {
    const input: SeverityInput = {
      framework: 'SOX',
      financialStatementImpact: true,
      compensatingControl: false,
      recurring: false,
      exposureUsd: 5_000_000,
      materialityUsd: 1_000_000,
    };
    expect(classifySeverity(input)).toBe('MATERIAL_WEAKNESS');
  });

  it('severity: recurring deficiency without compensating control = SIGNIFICANT_DEFICIENCY', () => {
    const input: SeverityInput = {
      framework: 'SOX',
      financialStatementImpact: false,
      compensatingControl: false,
      recurring: true,
    };
    expect(classifySeverity(input)).toBe('SIGNIFICANT_DEFICIENCY');
  });

  it('severity: isolated + compensating = CONTROL_DEFICIENCY', () => {
    const input: SeverityInput = {
      framework: 'SOC2',
      financialStatementImpact: false,
      compensatingControl: true,
      recurring: false,
    };
    expect(classifySeverity(input)).toBe('CONTROL_DEFICIENCY');
  });

  it('priority map: MW=1, SD=2, CD=3', () => {
    expect(priorityForSeverity('MATERIAL_WEAKNESS')).toBe(1);
    expect(priorityForSeverity('SIGNIFICANT_DEFICIENCY')).toBe(2);
    expect(priorityForSeverity('CONTROL_DEFICIENCY')).toBe(3);
  });

  it('rendering includes every component', () => {
    const md = renderFinding(baseFinding);
    expect(md).toContain('Control objective');
    expect(md).toContain('Condition');
    expect(md).toContain('Criteria');
    expect(md).toContain('Cause');
    expect(md).toContain('Effect');
    expect(md).toContain('Recommendations');
    expect(md).toContain('$2,500,000');
  });

  it('scoreFindings hits completeness + severity targets on the seed', () => {
    const r = scoreFindings([
      {
        finding: baseFinding,
        expectedSeverity: 'SIGNIFICANT_DEFICIENCY',
        severityInput: {
          framework: 'SOX',
          financialStatementImpact: true,
          compensatingControl: true,
          recurring: false,
          exposureUsd: 2_500_000,
          materialityUsd: 1_000_000,
        },
      },
    ]);
    expect(r.completenessRate).toBeGreaterThanOrEqual(NTF07_COMPLETENESS_TARGET);
    expect(r.severityAccuracy).toBeGreaterThanOrEqual(NTF07_SEVERITY_TARGET);
  });
});

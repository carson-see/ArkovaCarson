/**
 * SCRUM-1549 — Golden Distribution Audit tests.
 *
 * Pure-function coverage. No filesystem reads in these tests; loadJsonlRows
 * is exercised separately in an integration smoke test that lives outside
 * the unit suite (golden files are too large to fixture inline).
 */

import { describe, expect, it } from 'vitest';
import {
  auditDistribution,
  computeGap,
  DEFAULT_EXPECTED_CREDENTIAL_TYPES,
  formatSourceFile,
  parseGoldenLine,
  renderMarkdownReport,
  type AcceptanceGate,
  type DistributionAudit,
  type GoldenRow,
} from './golden-distribution-audit';

function makeAudit(overrides: Partial<DistributionAudit> = {}): DistributionAudit {
  const defaults: DistributionAudit = {
    totalRows: 100,
    unparseableRows: 0,
    fraudPositive: 5,
    byType: { DEGREE: 50, LICENSE: 50 },
  };
  return { ...defaults, ...overrides, byType: overrides.byType ?? defaults.byType };
}

function makeGate(overrides: Partial<AcceptanceGate> = {}): AcceptanceGate {
  return {
    minTotal: 5000,
    minPerType: 30,
    minFraudPositive: 200,
    expectedTypes: ['DEGREE', 'LICENSE'],
    ...overrides,
  };
}

describe('parseGoldenLine', () => {
  it('extracts credentialType from vertex format model output', () => {
    const line = JSON.stringify({
      systemInstruction: { role: 'system', parts: [{ text: 'sys' }] },
      contents: [
        { role: 'user', parts: [{ text: 'extract this' }] },
        {
          role: 'model',
          parts: [{ text: '{"credentialType":"DEGREE","issuerName":"X"}' }],
        },
      ],
    });
    expect(parseGoldenLine(line)).toEqual({
      credentialType: 'DEGREE',
      fraudPositive: false,
    });
  });

  it('extracts credentialType from chat-completions messages format', () => {
    const line = JSON.stringify({
      messages: [
        { role: 'system', content: 'extract' },
        {
          role: 'user',
          content: 'Credential type hint: PUBLICATION\n--- text ---',
        },
        { role: 'assistant', content: '{"credentialType":"PUBLICATION"}' },
      ],
    });
    expect(parseGoldenLine(line).credentialType).toBe('PUBLICATION');
  });

  it('prefers assistant output over prompt examples when extracting credentialType', () => {
    const line = JSON.stringify({
      messages: [
        { role: 'system', content: 'Example: {"credentialType":"DEGREE"}' },
        { role: 'user', content: 'Credential type hint: DEGREE\n--- text ---' },
        { role: 'assistant', content: '{"credentialType":"LICENSE","fraudSignals":[]}' },
      ],
    });
    expect(parseGoldenLine(line)).toEqual({
      credentialType: 'LICENSE',
      fraudPositive: false,
    });
  });

  it('falls back to credential-type hint regex when JSON not embedded', () => {
    const line = JSON.stringify({
      messages: [
        { role: 'user', content: 'Credential type hint: LICENSE\nbody' },
      ],
    });
    expect(parseGoldenLine(line).credentialType).toBe('LICENSE');
  });

  it('flags fraud-positive when fraudSignals array is non-empty', () => {
    const line = JSON.stringify({
      contents: [
        {
          role: 'model',
          parts: [
            { text: '{"credentialType":"DEGREE","fraudSignals":["defunct-institution"]}' },
          ],
        },
      ],
    });
    expect(parseGoldenLine(line)).toEqual({
      credentialType: 'DEGREE',
      fraudPositive: true,
    });
  });

  it('flags fraud-positive when structured output.fraudSignals is non-empty', () => {
    const line = JSON.stringify({
      output: {
        credentialType: 'LICENSE',
        fraudSignals: ['issuer-domain-mismatch'],
      },
    });
    expect(parseGoldenLine(line)).toEqual({
      credentialType: 'LICENSE',
      fraudPositive: true,
    });
  });

  it('does not count prompt-only fraud examples when assistant output is clean', () => {
    const line = JSON.stringify({
      messages: [
        { role: 'system', content: 'Example: {"credentialType":"DEGREE","fraudSignals":["sample"]}' },
        { role: 'assistant', content: '{"credentialType":"DEGREE","fraudSignals":[]}' },
      ],
    });
    expect(parseGoldenLine(line)).toEqual({
      credentialType: 'DEGREE',
      fraudPositive: false,
    });
  });

  it('flags fraud-positive when fraudSignals contains structured objects', () => {
    const line = JSON.stringify({
      messages: [
        {
          role: 'assistant',
          content: '{"credentialType":"DEGREE","fraudSignals":[{"signal":"date-conflict"}]}',
        },
      ],
    });
    expect(parseGoldenLine(line)).toEqual({
      credentialType: 'DEGREE',
      fraudPositive: true,
    });
  });

  it('treats empty fraudSignals array as not fraud-positive', () => {
    const line = JSON.stringify({
      contents: [
        { role: 'model', parts: [{ text: '{"credentialType":"DEGREE","fraudSignals":[]}' }] },
      ],
    });
    expect(parseGoldenLine(line).fraudPositive).toBe(false);
  });

  it('returns nulls for unparseable input', () => {
    expect(parseGoldenLine('not json')).toEqual({
      credentialType: null,
      fraudPositive: false,
    });
    expect(parseGoldenLine('')).toEqual({
      credentialType: null,
      fraudPositive: false,
    });
  });

  it('reads top-level credentialType when not buried in chat blob', () => {
    const line = JSON.stringify({ credentialType: 'BADGE' });
    expect(parseGoldenLine(line).credentialType).toBe('BADGE');
  });
});

describe('auditDistribution', () => {
  const sample: GoldenRow[] = [
    { credentialType: 'DEGREE', fraudPositive: false },
    { credentialType: 'DEGREE', fraudPositive: true },
    { credentialType: 'LICENSE', fraudPositive: false },
    { credentialType: null, fraudPositive: false },
  ];

  it('counts rows by type, fraud-positive, and unparseable separately', () => {
    const audit = auditDistribution(sample);
    expect(audit.totalRows).toBe(4);
    expect(audit.unparseableRows).toBe(1);
    expect(audit.fraudPositive).toBe(1);
    expect(audit.byType).toEqual({ DEGREE: 2, LICENSE: 1 });
  });

  it('handles empty input', () => {
    const audit = auditDistribution([]);
    expect(audit).toEqual({
      totalRows: 0,
      unparseableRows: 0,
      fraudPositive: 0,
      byType: {},
    });
  });

  it('counts fraud-positive rows even when the credential type is unparseable', () => {
    const audit = auditDistribution([
      { credentialType: null, fraudPositive: true },
      { credentialType: 'DEGREE', fraudPositive: false },
    ]);
    expect(audit.unparseableRows).toBe(1);
    expect(audit.fraudPositive).toBe(1);
  });
});

describe('computeGap', () => {
  const gate: AcceptanceGate = {
    minTotal: 100,
    minPerType: 10,
    minFraudPositive: 5,
    expectedTypes: ['DEGREE', 'LICENSE'],
  };

  it('reports zero gap and passed=true when audit meets all gates', () => {
    const r = computeGap(makeAudit(), gate);
    expect(r.passed).toBe(true);
    expect(r.totalGap).toBe(0);
    expect(r.fraudGap).toBe(0);
    expect(r.unparseableGap).toBe(0);
    expect(r.typesUnderFloor).toEqual([]);
  });

  it('flags total gap when row count below threshold', () => {
    const audit = makeAudit({
      totalRows: 80,
      byType: { DEGREE: 80 },
    });
    const r = computeGap(audit, gate);
    expect(r.passed).toBe(false);
    expect(r.totalGap).toBe(20);
  });

  it('flags fraud gap when fraud-positives below threshold', () => {
    const audit = makeAudit({
      fraudPositive: 2,
      byType: { DEGREE: 100 },
    });
    const r = computeGap(audit, gate);
    expect(r.fraudGap).toBe(3);
    expect(r.passed).toBe(false);
  });

  it('lists types under floor sorted by deficit descending', () => {
    const audit = makeAudit({
      byType: { DEGREE: 50, LICENSE: 8, MEDICAL: 3, BADGE: 39 },
    });
    const r = computeGap(audit, gate);
    expect(r.typesUnderFloor.map((t) => t.type)).toEqual(['MEDICAL', 'LICENSE']);
    expect(r.typesUnderFloor[0].deficit).toBe(7);
    expect(r.typesUnderFloor[1].deficit).toBe(2);
    expect(r.passed).toBe(false);
  });

  it('fails closed when an expected credential type has zero rows', () => {
    const audit = makeAudit({
      byType: { DEGREE: 100 },
    });
    const r = computeGap(audit, gate);
    expect(r.passed).toBe(false);
    expect(r.typesUnderFloor).toContainEqual({ type: 'LICENSE', count: 0, deficit: 10 });
  });

  it('fails closed when any row is unparseable', () => {
    const audit = makeAudit({
      unparseableRows: 1,
    });
    const r = computeGap(audit, gate);
    expect(r.unparseableGap).toBe(1);
    expect(r.passed).toBe(false);
  });

  it('uses the full launch credential taxonomy by default', () => {
    const audit = makeAudit({
      totalRows: 5000,
      fraudPositive: 200,
      byType: Object.fromEntries(DEFAULT_EXPECTED_CREDENTIAL_TYPES.map((type) => [type, 30])),
    });
    const r = computeGap(audit, { minTotal: 5000, minPerType: 30, minFraudPositive: 200 });
    expect(r.expectedTypes).toEqual([...DEFAULT_EXPECTED_CREDENTIAL_TYPES].sort((a, b) => a.localeCompare(b)));
    expect(r.passed).toBe(true);
  });
});

describe('formatSourceFile', () => {
  it('keeps in-repo paths readable without leaking absolute workstation prefixes', () => {
    expect(formatSourceFile('/opt/arkova/outside/full-golden.jsonl')).toBe('full-golden.jsonl');
  });
});

describe('renderMarkdownReport', () => {
  it('renders verdict, summary table, and per-type distribution', () => {
    const audit = makeAudit({
      totalRows: 1314,
      fraudPositive: 45,
      byType: { CERTIFICATE: 187, DEGREE: 146, MEDICAL: 18 },
    });
    const gate = makeGate({
      expectedTypes: ['CERTIFICATE', 'DEGREE', 'MEDICAL'],
    });
    const report = computeGap(audit, gate);
    const md = renderMarkdownReport(report, ['fixture.jsonl']);
    expect(md).toContain('FAILED');
    expect(md).toContain('| Total rows | 1314 | 5000 | +3686 |');
    expect(md).toContain('| Fraud-positive entries | 45 | 200 | +155 |');
    expect(md).toContain('CERTIFICATE');
    expect(md).toContain('UNDER (need +12)');
  });

  it('sanitizes absolute source paths in the report header', () => {
    const audit = makeAudit({
      totalRows: 5000,
      fraudPositive: 200,
      byType: { DEGREE: 2500, LICENSE: 2500 },
    });
    const gate = makeGate();
    const report = computeGap(audit, gate);
    const md = renderMarkdownReport(report, ['/opt/arkova/outside/full-golden.jsonl']);
    expect(md).toContain('**Sources.** full-golden.jsonl');
    expect(md).not.toContain('/opt/arkova');
  });

  it('renders PASSED verdict when gate is met', () => {
    const audit = makeAudit({
      totalRows: 5000,
      fraudPositive: 200,
      byType: { DEGREE: 2500, LICENSE: 2500 },
    });
    const gate = makeGate();
    const report = computeGap(audit, gate);
    const md = renderMarkdownReport(report, ['fixture.jsonl']);
    expect(md).toContain('PASSED');
    expect(md).not.toContain('Types under floor (sorted by deficit)');
  });
});

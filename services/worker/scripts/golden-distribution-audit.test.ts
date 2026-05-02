/**
 * SCRUM-1549 — Golden Distribution Audit tests.
 *
 * Pure-function coverage plus a fixture-backed smoke test for the CLI's
 * file-loading path. The large production golden files stay out of tests.
 */

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  auditDistribution,
  computeGap,
  DEFAULT_EXPECTED_CREDENTIAL_TYPES,
  formatSourceFile,
  loadJsonlRows,
  parseCliArgs,
  parseGoldenLine,
  renderMarkdownReport,
  runAudit,
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

function passingTwoTypeReport() {
  return computeGap(
    makeAudit({
      totalRows: 5000,
      fraudPositive: 200,
      byType: { DEGREE: 2500, LICENSE: 2500 },
    }),
    makeGate(),
  );
}

function chatLine(messages: Array<Record<string, unknown>>): string {
  return JSON.stringify({ messages });
}

function modelLine(text: string): string {
  return JSON.stringify({ contents: [{ role: 'model', parts: [{ text }] }] });
}

function expectParsed(line: string, expected: GoldenRow): void {
  expect(parseGoldenLine(line)).toEqual(expected);
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
    expectParsed(line, {
      credentialType: 'DEGREE',
      fraudPositive: false,
    });
  });

  it('extracts credentialType from chat-completions messages format', () => {
    const line = chatLine([
      { role: 'system', content: 'extract' },
      { role: 'user', content: 'Credential type hint: PUBLICATION\n--- text ---' },
      { role: 'assistant', content: '{"credentialType":"PUBLICATION"}' },
    ]);
    expect(parseGoldenLine(line).credentialType).toBe('PUBLICATION');
  });

  it('prefers assistant output over prompt examples when extracting credentialType', () => {
    const line = chatLine([
      { role: 'system', content: 'Example: {"credentialType":"DEGREE"}' },
      { role: 'user', content: 'Credential type hint: DEGREE\n--- text ---' },
      { role: 'assistant', content: '{"credentialType":"LICENSE","fraudSignals":[]}' },
    ]);
    expectParsed(line, {
      credentialType: 'LICENSE',
      fraudPositive: false,
    });
  });

  it('falls back to credential-type hint regex when JSON not embedded', () => {
    const line = chatLine([{ role: 'user', content: 'Credential type hint: LICENSE\nbody' }]);
    expect(parseGoldenLine(line).credentialType).toBe('LICENSE');
  });

  it('flags fraud-positive when fraudSignals array is non-empty', () => {
    const line = modelLine('{"credentialType":"DEGREE","fraudSignals":["defunct-institution"]}');
    expectParsed(line, {
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
    expectParsed(line, {
      credentialType: 'LICENSE',
      fraudPositive: true,
    });
  });

  it('does not count prompt-only fraud examples when assistant output is clean', () => {
    const line = chatLine([
      { role: 'system', content: 'Example: {"credentialType":"DEGREE","fraudSignals":["sample"]}' },
      { role: 'assistant', content: '{"credentialType":"DEGREE","fraudSignals":[]}' },
    ]);
    expectParsed(line, {
      credentialType: 'DEGREE',
      fraudPositive: false,
    });
  });

  it('does not count prompt-only fraud examples when assistant output is absent', () => {
    const line = chatLine([
      { role: 'system', content: 'Example: {"credentialType":"DEGREE","fraudSignals":["sample"]}' },
      { role: 'user', content: 'Credential type hint: DEGREE\n--- text ---' },
    ]);
    expectParsed(line, {
      credentialType: 'DEGREE',
      fraudPositive: false,
    });
  });

  it('flags fraud-positive when fraudSignals contains structured objects', () => {
    const line = chatLine([
      {
        role: 'assistant',
        content: '{"credentialType":"DEGREE","fraudSignals":[{"signal":"date-conflict"}]}',
      },
    ]);
    expectParsed(line, {
      credentialType: 'DEGREE',
      fraudPositive: true,
    });
  });

  it('treats empty fraudSignals array as not fraud-positive', () => {
    const line = modelLine('{"credentialType":"DEGREE","fraudSignals":[]}');
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
    expect(formatSourceFile('/workspace/arkova/services/worker/training-data/full-golden.jsonl')).toBe(
      'training-data/full-golden.jsonl',
    );
  });

  it('falls back to basenames for absolute paths outside the worker tree', () => {
    expect(formatSourceFile('/opt/arkova/outside/full-golden.jsonl')).toBe('full-golden.jsonl');
  });
});

describe('parseCliArgs', () => {
  it('parses explicit options and trims expected type lists', () => {
    const parsed = parseCliArgs([
      '--input',
      'training-data/fixtures/golden-fixture.jsonl',
      '--min-total',
      '10',
      '--min-per-type',
      '2',
      '--min-fraud-positive',
      '1',
      '--expected-types',
      ' degree, license ',
      '--json',
      '--out',
      'docs/eval/out.json',
    ]);

    expect(parsed.inputs[0]).toMatch(/training-data\/fixtures\/golden-fixture\.jsonl$/);
    expect(parsed.gate).toEqual({
      minTotal: 10,
      minPerType: 2,
      minFraudPositive: 1,
      expectedTypes: ['degree', 'license'],
    });
    expect(parsed.jsonOutput).toBe(true);
    expect(parsed.outPath).toMatch(/docs\/eval\/out\.json$/);
  });

  it.each([
    [['--input'], 'Missing value for --input'],
    [['--input', '--json'], 'Missing value for --input'],
    [['--min-total', 'NaN'], 'Invalid value for --min-total: NaN'],
    [['--min-per-type', '-1'], 'Invalid value for --min-per-type: -1'],
    [['--expected-types', ','], 'Invalid value for --expected-types'],
    [['--surprise'], 'Unknown flag: --surprise'],
  ])('fails fast for malformed CLI arguments %#', (args, message) => {
    expect(() => parseCliArgs(args)).toThrow(message);
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
    const md = renderMarkdownReport(passingTwoTypeReport(), ['/opt/arkova/outside/full-golden.jsonl']);
    expect(md).toContain('**Sources.** full-golden.jsonl');
    expect(md).not.toContain('/opt/arkova');
  });

  it('renders PASSED verdict when gate is met', () => {
    const md = renderMarkdownReport(passingTwoTypeReport(), ['fixture.jsonl']);
    expect(md).toContain('PASSED');
    expect(md).not.toContain('Types under floor (sorted by deficit)');
  });
});

describe('runAudit integration', () => {
  const fixturePath = resolve(import.meta.dirname ?? '.', '../training-data/fixtures/golden-fixture.jsonl');

  it('loads JSONL rows and audits the fixture end to end', () => {
    const rows = loadJsonlRows(fixturePath);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.credentialType === 'ATTESTATION')).toBe(true);

    const { report, rowCount } = runAudit([fixturePath], {
      minTotal: rows.length,
      minPerType: 0,
      minFraudPositive: 0,
      expectedTypes: [],
    });

    expect(rowCount).toBe(rows.length);
    expect(report.audit.totalRows).toBe(rows.length);
    expect(report.audit.byType.ATTESTATION).toBeGreaterThan(0);
    expect(report.passed).toBe(true);
  });
});

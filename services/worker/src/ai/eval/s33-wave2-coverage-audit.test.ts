import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  auditS33Wave2Coverage,
  parseS33Wave2Top15Registry,
  s33Wave2CoverageReportSha256,
  type S33AcceptedCoverageEntry,
} from './s33-wave2-coverage-audit.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TEST_DIR, '../../../../..');
const REGISTRY_PATH = resolve(REPOSITORY_ROOT, 'docs/lane4/s33-wave2-top15-registry.json');
const BASELINE_EVIDENCE_PATH = resolve(
  REPOSITORY_ROOT,
  'docs/lane4/evidence/s33-wave2-coverage-baseline.json',
);

function readRegistry(): unknown {
  return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function gitBlobSha1(path: string): string {
  const bytes = readFileSync(path);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function acceptedEntry(
  id: string,
  overrides: Partial<S33AcceptedCoverageEntry> = {},
): S33AcceptedCoverageEntry {
  return {
    id,
    registryTypeId: 'legal-01-contract',
    batchId: 'S33-W2-L01-05',
    credentialType: 'LEGAL',
    subType: 'contract',
    authorshipMethod: 'independently-authored',
    generatorDerived: false,
    trainingExposed: false,
    intendedSplit: 'held-out',
    productionValidSubstantiveFieldCount: 5,
    edgeCase: false,
    acceptance: {
      lane: 'lane3',
      artifactSha256: 'a'.repeat(64),
      acceptedHeadCommit: 'b'.repeat(40),
    },
    ...overrides,
  };
}

describe('S3.3 Wave 2 top-15 registry', () => {
  it('pins exactly three ordered domains and 45 unique types', () => {
    const registry = parseS33Wave2Top15Registry(readRegistry());

    expect(registry.domains.map((domain) => domain.id)).toEqual(['legal', 'financial', 'education']);
    expect(registry.domains.map((domain) => domain.types.length)).toEqual([15, 15, 15]);
    expect(new Set(registry.domains.flatMap((domain) => domain.types.map((type) => type.id))).size).toBe(45);
    expect(registry.productionOrder).toHaveLength(45);
    expect(new Set(registry.productionOrder).size).toBe(45);
  });

  it('uses the CTO-ratified domain-interleaved tranche order', () => {
    const registry = parseS33Wave2Top15Registry(readRegistry());

    expect(registry.productionOrder.slice(0, 15)).toEqual([
      'legal-01-contract',
      'legal-02-service-agreement',
      'legal-03-nondisclosure-agreement',
      'legal-04-settlement-agreement',
      'legal-05-court-opinion',
      'financial-01-pay-stub',
      'financial-02-w2',
      'financial-03-1099',
      'financial-04-bank-statement',
      'financial-05-income-verification',
      'education-01-associate',
      'education-02-bachelor',
      'education-03-master',
      'education-04-doctorate',
      'education-05-professional-degree',
    ]);
    expect(registry.productionOrder.slice(-5)).toEqual([
      'education-11-trade-certification',
      'education-12-training-certificate',
      'education-13-completion-certificate',
      'education-14-accreditation',
      'education-15-microcredential',
    ]);
  });

  it('pins the merged Wave 1 baseline without claiming top-15 coverage', () => {
    const registry = parseS33Wave2Top15Registry(readRegistry());

    expect(registry.acceptedBaseline).toMatchObject({
      batchId: 'S33-W1',
      revision: 12,
      pullRequest: 1544,
      producerHeadCommit: '618e08d5a11cb73cb61394bc0343d33f4353ef39',
      mergeCommit: '42530fd73f9bd0cb7e4e70fc1259324810780b2c',
      entryCount: 81,
      top15CoverageDisposition: 'NOT_PROVIDED_IN_WAVE_1',
      countedTop15EntryIds: [],
    });
  });

  it('recomputes the Wave 1 document and source-blob pins from repository bytes', () => {
    const registry = parseS33Wave2Top15Registry(readRegistry());
    const baseline = registry.acceptedBaseline;

    expect(sha256File(resolve(REPOSITORY_ROOT, 'docs/lane4/s33-wave1-batch-manifest.json')))
      .toBe(baseline.manifestRawSha256);
    expect(sha256File(resolve(REPOSITORY_ROOT, 'docs/lane4/s33-wave1-entry-datasheet.json')))
      .toBe(baseline.entryDatasheetRawSha256);
    expect(sha256File(resolve(REPOSITORY_ROOT, 'docs/lane4/s33-corpus-datasheet.md')))
      .toBe(baseline.corpusDatasheetRawSha256);
    expect(gitBlobSha1(resolve(REPOSITORY_ROOT, 'services/worker/src/ai/eval/golden-dataset-s33-licensing-heldout.ts')))
      .toBe(baseline.sourceBlobs.licensing);
    expect(gitBlobSha1(resolve(REPOSITORY_ROOT, 'services/worker/src/ai/eval/golden-dataset-s33-au-ke-heldout.ts')))
      .toBe(baseline.sourceBlobs.auKe);
    expect(gitBlobSha1(resolve(REPOSITORY_ROOT, 'services/worker/src/ai/eval/golden-dataset-s33-ood-negatives.ts')))
      .toBe(baseline.sourceBlobs.ood);
  });

  it('rejects a production-order change', () => {
    const registry = structuredClone(readRegistry()) as { productionOrder: string[] };
    [registry.productionOrder[0], registry.productionOrder[1]] = [
      registry.productionOrder[1]!,
      registry.productionOrder[0]!,
    ];

    expect(() => parseS33Wave2Top15Registry(registry)).toThrow(/production order/i);
  });

  it('rejects an unratified production taxonomy mapping', () => {
    const registry = structuredClone(readRegistry()) as {
      domains: Array<{ types: Array<{ mappings: Array<{ credentialType: string; subType: string }> }> }>;
    };
    registry.domains[0]!.types[0]!.mappings[0]!.subType = 'invented_contract_type';

    expect(() => parseS33Wave2Top15Registry(registry)).toThrow(/unratified mapping/i);
  });
});

describe('S3.3 Wave 2 accepted-held-out coverage audit', () => {
  it('reports the honest Wave 1 baseline as 45 gaps and 540 missing rows', () => {
    const report = auditS33Wave2Coverage(readRegistry(), []);

    expect(report).toMatchObject({
      planningBaseCommit: '42530fd73f9bd0cb7e4e70fc1259324810780b2c',
      registryTypeCount: 45,
      acceptedEntryCount: 0,
      completeTypeCount: 0,
      incompleteTypeCount: 45,
      minimumRequiredEntryCount: 540,
      missingEntryCount: 540,
    });
    expect(report.types).toHaveLength(45);
    expect(report.types.every((type) => type.qualifyingCount === 0 && type.missingCount === 12)).toBe(true);
  });

  it('reproduces the committed pre-corpus evidence from exact registry bytes', () => {
    const evidence = JSON.parse(readFileSync(BASELINE_EVIDENCE_PATH, 'utf8')) as {
      registryRawSha256: string;
      reportCanonicalSha256: string;
      summary: Record<string, number>;
      productionOrder: string[];
    };
    const report = auditS33Wave2Coverage(readRegistry(), []);

    expect(evidence.registryRawSha256).toBe(sha256File(REGISTRY_PATH));
    expect(evidence.reportCanonicalSha256).toBe(s33Wave2CoverageReportSha256(report));
    expect(evidence.summary).toEqual({
      registryTypeCount: report.registryTypeCount,
      acceptedEntryCount: report.acceptedEntryCount,
      completeTypeCount: report.completeTypeCount,
      incompleteTypeCount: report.incompleteTypeCount,
      minimumRequiredEntryCount: report.minimumRequiredEntryCount,
      missingEntryCount: report.missingEntryCount,
      missingPerType: 12,
    });
    expect(evidence.productionOrder).toEqual(report.productionOrder);
  });

  it('counts only exact Lane-3-accepted entries under the mapped source form', () => {
    const entries = Array.from({ length: 12 }, (_, index) => acceptedEntry(`GD-S33-W2-L-C-${index + 1}`, {
      edgeCase: index < 4,
    }));
    const report = auditS33Wave2Coverage(readRegistry(), entries);
    const first = report.types[0];

    expect(first).toMatchObject({
      registryTypeId: 'legal-01-contract',
      qualifyingCount: 12,
      edgeCaseCount: 4,
      missingCount: 0,
      complete: true,
    });
    expect(report.completeTypeCount).toBe(1);
    expect(report.missingEntryCount).toBe(528);
  });

  it('produces a deterministic canonical report digest', () => {
    const reportA = auditS33Wave2Coverage(readRegistry(), [acceptedEntry('GD-S33-W2-L-C-001')]);
    const reportB = auditS33Wave2Coverage(readRegistry(), [acceptedEntry('GD-S33-W2-L-C-001')]);

    expect(s33Wave2CoverageReportSha256(reportA)).toMatch(/^[a-f0-9]{64}$/);
    expect(s33Wave2CoverageReportSha256(reportA)).toBe(s33Wave2CoverageReportSha256(reportB));
  });

  it('rejects a duplicate accepted entry id', () => {
    const duplicate = acceptedEntry('GD-S33-W2-DUPLICATE');
    expect(() => auditS33Wave2Coverage(readRegistry(), [duplicate, duplicate]))
      .toThrow(/duplicate accepted held-out entry id/i);
  });

  it('rejects unknown registry types instead of silently dropping them', () => {
    expect(() => auditS33Wave2Coverage(readRegistry(), [
      acceptedEntry('GD-S33-W2-UNKNOWN', { registryTypeId: 'legal-99-unknown' }),
    ])).toThrow(/unknown registry type/i);
  });

  it('rejects a credential/subtype mapping mismatch', () => {
    expect(() => auditS33Wave2Coverage(readRegistry(), [
      acceptedEntry('GD-S33-W2-MISMATCH', { credentialType: 'LEGAL', subType: 'court_order' }),
    ])).toThrow(/does not match.+ratified taxonomy mapping/i);
  });

  it('rejects insufficient production-valid substantive depth', () => {
    expect(() => auditS33Wave2Coverage(readRegistry(), [
      acceptedEntry('GD-S33-W2-SHALLOW', { productionValidSubstantiveFieldCount: 4 }),
    ])).toThrow(/insufficient production-valid substantive depth/i);
  });

  it.each([
    ['generator-derived input', { generatorDerived: true }],
    ['training-exposed input', { trainingExposed: true }],
    ['non-held-out split', { intendedSplit: 'training' }],
    ['self-acceptance', { acceptance: { lane: 'lane4', artifactSha256: 'a'.repeat(64), acceptedHeadCommit: 'b'.repeat(40) } }],
  ])('fails closed for %s', (_name, mutation) => {
    const entry = { ...acceptedEntry('GD-S33-W2-UNTRUSTED'), ...mutation };
    expect(() => auditS33Wave2Coverage(readRegistry(), [entry])).toThrow();
  });
});

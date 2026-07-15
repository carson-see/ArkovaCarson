import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { normalizeForFingerprint } from './golden-dataset-s33-types.js';
import {
  acceptS33Wave2BatchCandidate,
  consumeMergedS33Wave2Batches,
  preflightS33Wave2BatchCandidate,
  type S33Wave2CandidateSnapshot,
  type S33Wave2ReviewEvidence,
} from './s33-wave2-batch-acceptance.js';
import { buildS33Wave2BaseCorpusRegistry } from './s33-wave2-corpus-registry.js';
import { parseS33ProducerModuleWithLimit } from './s33-wave1-producer-parser.js';

const repositoryRoot = execFileSync('/usr/bin/git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const verificationHeadSha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const registry = buildS33Wave2BaseCorpusRegistry({ repositoryRoot, verificationHeadSha });
const candidateHeadSha = 'a'.repeat(40);
const sourcePath = 'services/worker/src/ai/eval/golden-dataset-s33-wave2-depth-audit-heldout.ts';
const testPath = 'services/worker/src/ai/eval/golden-dataset-s33-wave2-depth-audit-heldout.test.ts';
const manifestPath = 'docs/lane4/s33-wave2-batches/depth-audit/manifest.json';
const datasheetPath = 'docs/lane4/s33-wave2-batches/depth-audit/datasheet.json';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function fixture() {
  const rows = Array.from({ length: 4 }, (_, index) => {
    const suffix = index + 1;
    const strippedText = `Quasar willow ember cobalt lantern ${suffix} verifies synthetic board record with isolated wording alpha${suffix} beta${suffix} gamma${suffix}.`;
    return {
      id: `GD-S33-W2-DEPTH-${String(suffix).padStart(3, '0')}`,
      description: `Wave-2 independently authored depth row ${suffix}`,
      strippedText,
      source: `authored/s33-wave2/depth-audit-${suffix}`,
      tags: ['held-out', 's33', 'authored'],
      provenance: 'authored-s33-lane4',
      edgeCase: index === 0,
      jurisdictionSlice: 'US',
      groundTruth: {
        credentialType: 'LICENSE', subType: 'nursing_rn', fraudSignals: [],
        issuerName: `Synthetic Board ${suffix}`, recipientIdentifier: '[NAME_REDACTED]',
        issuedDate: '2026-06-01', expiryDate: '2027-06-01',
        licenseNumber: `SYN-W2-${suffix}`, jurisdiction: 'US-MI',
      },
    };
  });
  const manifest = {
    schemaVersion: 1,
    artifactType: 'arkova-s33-wave2-batch-manifest',
    batchId: 'S33-W2-DEPTH-AUDIT',
    revision: 1,
    producerLane: 'Lane 4',
    acceptanceAuthority: 'Lane 3',
    status: 'PRODUCER_CANDIDATE_PENDING_L3_ACCEPTANCE',
    intendedSplit: 'held-out-candidate',
    acceptanceScope: 'whole-batch-only',
    baseRegistryDigestSha256: registry.registryDigestSha256,
    source: { path: sourcePath, exportName: 'S33_WAVE2_DEPTH_AUDIT_HELDOUT', blobSha: 'b'.repeat(40) },
    datasheet: { path: datasheetPath, blobSha: 'c'.repeat(40) },
    testPath,
    entryCount: rows.length,
    entries: rows.map((row) => ({
      id: row.id, domain: 'professional-licensing', credentialType: 'LICENSE',
      normalizedInputSha256: sha256(normalizeForFingerprint(row.strippedText)),
    })),
  };
  const datasheet = {
    schemaVersion: 1,
    artifactType: 'arkova-s33-wave2-batch-datasheet',
    batchId: manifest.batchId,
    revision: 1,
    producerLane: 'Lane 4',
    acceptanceAuthority: 'Lane 3',
    status: 'PRODUCER_CANDIDATE_PENDING_L3_ACCEPTANCE',
    containsProductionUserDocuments: false,
    authorshipNote: 'Every row was independently curated without generators or templates.',
    entryCount: rows.length,
    rows: rows.map((row, index) => ({
      id: row.id, domain: 'professional-licensing', credentialType: 'LICENSE', subType: 'nursing_rn',
      jurisdiction: 'US', edgeCase: row.edgeCase, edgeClass: index === 0 ? 'date-trap' : null,
      realOrSynthetic: 'synthetic-realistic', independentlyCurated: true,
      generatorName: null, generatorVersion: null, seed: null, templateId: null,
      sourceGrounding: 'Synthetic Michigan nursing-board record authored from public schema facts.',
      curationAuthor: 'Arkova Lane 4', curationDate: '2026-07-15',
      licenseConsentNote: 'Arkova-authored synthetic text; no third-party document or personal data was used.',
    })),
  };
  const snapshot: S33Wave2CandidateSnapshot = {
    candidateBaseSha: registry.verificationHeadSha,
    candidateHeadSha,
    candidateTreeSha: 'd'.repeat(40),
    changedPaths: [manifestPath, datasheetPath, sourcePath, testPath].map((path) => ({
      status: 'A', path, mode: '100644', objectType: 'blob',
      blobSha: path === sourcePath ? 'b'.repeat(40) : path === datasheetPath ? 'c'.repeat(40) : 'f'.repeat(40),
    })),
    manifestPath,
    manifestContent: JSON.stringify(manifest),
    sourceContent: 'export const inertCandidate = true;',
    datasheetContent: JSON.stringify(datasheet),
    testContent: 'export {};',
    parsedEntries: rows,
    leakageCorpus: [
      { path: 'training-data/a.jsonl', content: 'tundra' },
      { path: 'src/ai/a.ts', content: 'monsoon' },
      { path: 'scripts/a.ts', content: 'solstice' },
    ],
    leakageCorpusRootCounts: { 'training-data': 1, 'src/ai': 1, scripts: 1 },
  };
  const review: S33Wave2ReviewEvidence = {
    schemaVersion: 1,
    artifactType: 'arkova-s33-wave2-exact-head-review',
    repositoryIdentity: 'carson-see/ArkovaCarson',
    pullRequestNumber: 1600,
    candidateHeadSha,
    authorLogin: 'lane4-author', authorLane: 'Lane 4',
    reviewerLogin: 'lane3-reviewer', reviewerLane: 'Lane 3',
    reviewState: 'APPROVED', reviewCommitSha: candidateHeadSha,
    reviewUrl: 'https://github.com/carson-see/ArkovaCarson/pull/1600#pullrequestreview-1',
    scope: 'whole-batch',
  };
  return { rows, manifest, datasheet, snapshot, review };
}

describe('S3.3 Wave-2 whole-batch acceptance', () => {
  it('keeps the immutable base registry when trusted main has no merged Wave-2 batches', () => {
    expect(consumeMergedS33Wave2Batches({
      trustedMainRepositoryRoot: repositoryRoot,
      registry,
    })).toBe(registry);
  });

  it('accepts one complete, non-leaking, independently curated batch', () => {
    const value = fixture();
    const accepted = acceptS33Wave2BatchCandidate({
      registry, snapshot: value.snapshot, review: value.review,
      acceptedEntryIds: value.rows.map(({ id }) => id),
    });
    expect(accepted.verdict).toBe('APPROVED_WHOLE_BATCH');
    expect(accepted.resultingRegistry.entries).toHaveLength(85);
  });

  it.each([
    ['stale review', (value: ReturnType<typeof fixture>) => ({ ...value.review, reviewCommitSha: 'e'.repeat(40) }), /stale/iu],
    ['self review', (value: ReturnType<typeof fixture>) => ({ ...value.review, reviewerLogin: value.review.authorLogin }), /self-review/iu],
  ])('rejects %s', (_label, mutate, pattern) => {
    const value = fixture();
    expect(() => acceptS33Wave2BatchCandidate({
      registry, snapshot: value.snapshot,
      review: mutate(value) as S33Wave2ReviewEvidence,
      acceptedEntryIds: value.rows.map(({ id }) => id),
    })).toThrow(pattern);
  });

  it('rejects partial acceptance', () => {
    const value = fixture();
    expect(() => acceptS33Wave2BatchCandidate({
      registry, snapshot: value.snapshot, review: value.review,
      acceptedEntryIds: value.rows.slice(0, 3).map(({ id }) => id),
    })).toThrow(/partial acceptance/iu);
  });

  it('rejects a stale candidate base and a partial exact n=6 corpus overlap', () => {
    const stale = fixture();
    expect(() => preflightS33Wave2BatchCandidate(registry, {
      ...stale.snapshot, candidateBaseSha: '9'.repeat(40),
    })).toThrow(/base is stale/iu);

    const lexical = fixture();
    expect(() => preflightS33Wave2BatchCandidate(registry, {
      ...lexical.snapshot,
      leakageCorpus: [
        ...lexical.snapshot.leakageCorpus,
        { path: 'src/ai/prompt.ts', content: 'prefix quasar willow ember cobalt lantern 1 suffix' },
      ],
      leakageCorpusRootCounts: { ...lexical.snapshot.leakageCorpusRootCounts, 'src/ai': 2 },
    })).toThrow(/exact lexical leakage at n=6/iu);
  });

  it('rejects unauthorized paths, empty roots, leakage, PII, shallow truth, and duplicate ids', () => {
    const unauthorized = fixture();
    expect(() => preflightS33Wave2BatchCandidate(registry, {
      ...unauthorized.snapshot,
      changedPaths: [...unauthorized.snapshot.changedPaths, {
        status: 'A', path: 'src/runtime.ts', mode: '100644', objectType: 'blob', blobSha: 'e'.repeat(40),
      }],
    })).toThrow(/unauthorized paths/iu);

    const emptyRoot = fixture();
    expect(() => preflightS33Wave2BatchCandidate(registry, {
      ...emptyRoot.snapshot, leakageCorpusRootCounts: { ...emptyRoot.snapshot.leakageCorpusRootCounts, scripts: 0 },
    })).toThrow(/root is empty/iu);

    const leaking = fixture();
    expect(() => preflightS33Wave2BatchCandidate(registry, {
      ...leaking.snapshot,
      leakageCorpus: [
        ...leaking.snapshot.leakageCorpus,
        { path: 'src/ai/prompt.ts', content: leaking.rows[0].strippedText },
      ],
      leakageCorpusRootCounts: { ...leaking.snapshot.leakageCorpusRootCounts, 'src/ai': 2 },
    })).toThrow(/leakage/iu);

    const pii = fixture();
    const piiEntries = pii.rows.map((row, index) => index === 0 ? { ...row, strippedText: `${row.strippedText} jane@example.com` } : row);
    const piiManifest = {
      ...pii.manifest,
      entries: pii.manifest.entries.map((entry, index) => index === 0
        ? { ...entry, normalizedInputSha256: sha256(normalizeForFingerprint(piiEntries[0].strippedText)) }
        : entry),
    };
    expect(() => preflightS33Wave2BatchCandidate(registry, {
      ...pii.snapshot,
      manifestContent: JSON.stringify(piiManifest),
      parsedEntries: piiEntries,
    })).toThrow(/PII/iu);

    const shallow = fixture();
    const shallowEntries = shallow.rows.map((row, index) => index === 0
      ? { ...row, groundTruth: { credentialType: 'LICENSE', subType: 'nursing_rn', fraudSignals: [] } }
      : row);
    expect(() => preflightS33Wave2BatchCandidate(registry, { ...shallow.snapshot, parsedEntries: shallowEntries })).toThrow(/depth/iu);

    const duplicate = fixture();
    const duplicateEntries = duplicate.rows.map((row, index) => index === 0 ? { ...row, id: registry.entries[0].id } : row);
    expect(() => preflightS33Wave2BatchCandidate(registry, { ...duplicate.snapshot, parsedEntries: duplicateEntries })).toThrow(/bijection|duplicate/iu);

    const missingProvenance = fixture();
    const unprovenancedEntries = missingProvenance.rows.map((row, index) => index === 0
      ? { ...row, provenance: 'unknown' }
      : row);
    expect(() => preflightS33Wave2BatchCandidate(registry, {
      ...missingProvenance.snapshot, parsedEntries: unprovenancedEntries,
    })).toThrow(/provenance/iu);
  });

  it('parses candidate arrays without executing candidate statements and enforces explicit limits', () => {
    const source = `
      throw new Error('candidate code executed');
      export const S33_WAVE2_TEST_HELDOUT = [{ id: 'one' }, { id: 'two' }] as const;
    `;
    expect(parseS33ProducerModuleWithLimit(source, 'candidate.ts', 'S33_WAVE2_TEST_HELDOUT', 2)).toHaveLength(2);
    expect(() => parseS33ProducerModuleWithLimit(source, 'candidate.ts', 'S33_WAVE2_TEST_HELDOUT', 1)).toThrow(/maximum 1-row/iu);
  });
});

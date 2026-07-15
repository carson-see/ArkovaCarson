import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  S33_EDGE_CLASSES,
  assertS33HeldoutGroundTruthContract,
  countS33SubstantiveGroundTruthFields,
  normalizeForFingerprint,
} from './golden-dataset-s33-types.js';
import { checkHeldoutLeakage, loadLeakageCorpus } from './heldout-leakage.js';
import { S33_WAVE2_TOP15_01_05_HELDOUT } from './golden-dataset-s33-wave2-top15-01-05-heldout.js';
import { S33_WAVE2_TOP15_06_10_HELDOUT } from './golden-dataset-s33-wave2-top15-06-10-heldout.js';

const BATCH_ID = 'S33-W2-TOP15-06-10';
const REGISTRY_DIGEST_SHA256 = '412a08227608a58172569a4fcbf3cd1025dc67fc1beeaddd6c163d22c4cb80d6';
const SOURCE_PATH = 'services/worker/src/ai/eval/golden-dataset-s33-wave2-top15-06-10-heldout.ts';
const MANIFEST_PATH = 'docs/lane4/s33-wave2-batches/top15-06-10/manifest.json';
const DATASHEET_PATH = 'docs/lane4/s33-wave2-batches/top15-06-10/datasheet.json';
const workerRoot = fileURLToPath(new URL('../../../', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

const EXPECTED_TYPE_ORDER = [
  'legal-06-court-order',
  'legal-07-custody-divorce-decree',
  'legal-08-affidavit-declaration',
  'legal-09-power-of-attorney',
  'legal-10-bar-admission',
  'financial-06-financial-aid-award',
  'financial-07-tax-return-assessment',
  'financial-08-audit-report',
  'financial-09-financial-statements',
  'financial-10-sec-10k',
  'education-06-official-undergraduate-transcript',
  'education-07-official-graduate-transcript',
  'education-08-unofficial-transcript',
  'education-09-high-school-diploma',
  'education-10-professional-certification',
] as const;

interface ManifestEntry {
  id: string;
  domain: string;
  registryTypeId: string;
  credentialType: string;
  normalizedInputSha256: string;
}

interface Manifest {
  schemaVersion: number;
  artifactType: string;
  batchId: string;
  revision: number;
  producerLane: string;
  acceptanceAuthority: string;
  status: string;
  intendedSplit: string;
  acceptanceScope: string;
  baseRegistryDigestSha256: string;
  source: { path: string; exportName: string; blobSha: string };
  datasheet: { path: string; blobSha: string };
  testPath: string;
  entryCount: number;
  entries: ManifestEntry[];
}

interface DatasheetRow {
  id: string;
  domain: string;
  credentialType: string;
  subType: string;
  jurisdiction: string;
  edgeCase: boolean;
  edgeClass: string | null;
  authorshipMethod: string;
  realOrSynthetic: string;
  independentlyCurated: boolean;
  generatorDerived: boolean;
  trainingExposed: boolean;
  generatorName: null;
  generatorVersion: null;
  seed: null;
  templateId: null;
  sourceGrounding: string;
  curationAuthor: string;
  curationDate: string;
  licenseConsentNote: string;
}

interface Datasheet {
  schemaVersion: number;
  artifactType: string;
  batchId: string;
  revision: number;
  producerLane: string;
  acceptanceAuthority: string;
  status: string;
  entryCount: number;
  containsProductionUserDocuments: boolean;
  authorshipNote: string;
  rows: DatasheetRow[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(`${repositoryRoot}/${path}`, 'utf8')) as T;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function gitBlobSha1(value: string): string {
  return createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest('hex');
}

function leakageTokens(value: string): string[] {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/u).filter(Boolean);
}

function exactNgramHits(
  heldout: readonly Readonly<{ id: string; text: string }>[],
  corpus: readonly Readonly<{ id: string; text: string }>[],
): string[] {
  const nValues = [6, 7, 8, 9, 10, 11, 12, 13] as const;
  const candidates = new Map<number, Map<string, Set<string>>>(
    nValues.map((n) => [n, new Map<string, Set<string>>()]),
  );
  for (const record of heldout) {
    const tokens = leakageTokens(record.text);
    for (const n of nValues) {
      const index = candidates.get(n)!;
      for (let offset = 0; offset + n <= tokens.length; offset += 1) {
        const ngram = tokens.slice(offset, offset + n).join(' ');
        const ids = index.get(ngram) ?? new Set<string>();
        ids.add(record.id);
        index.set(ngram, ids);
      }
    }
  }
  const hits = new Set<string>();
  for (const record of corpus) {
    const tokens = leakageTokens(record.text);
    for (const n of nValues) {
      const index = candidates.get(n)!;
      for (let offset = 0; offset + n <= tokens.length; offset += 1) {
        const ngram = tokens.slice(offset, offset + n).join(' ');
        for (const id of index.get(ngram) ?? []) hits.add(`${id}:${record.id}:n=${n}:${ngram}`);
      }
    }
  }
  return [...hits].sort();
}

describe('S3.3 Wave 3 top-15 tranche 06-10', () => {
  const manifest = readJson<Manifest>(MANIFEST_PATH);
  const datasheet = readJson<Datasheet>(DATASHEET_PATH);

  it('is one immutable producer-only 180-row, 15-type whole batch', () => {
    expect(Object.keys(manifest).sort()).toEqual([
      'acceptanceAuthority', 'acceptanceScope', 'artifactType', 'baseRegistryDigestSha256',
      'batchId', 'datasheet', 'entries', 'entryCount', 'intendedSplit', 'producerLane',
      'revision', 'schemaVersion', 'source', 'status', 'testPath',
    ].sort());
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      artifactType: 'arkova-s33-wave2-batch-manifest',
      batchId: BATCH_ID,
      revision: 1,
      producerLane: 'Lane 4',
      acceptanceAuthority: 'Lane 3',
      status: 'PRODUCER_CANDIDATE_PENDING_L3_ACCEPTANCE',
      intendedSplit: 'held-out-candidate',
      acceptanceScope: 'whole-batch-only',
      baseRegistryDigestSha256: REGISTRY_DIGEST_SHA256,
      entryCount: 180,
    });
    expect(manifest.source).toMatchObject({ path: SOURCE_PATH, exportName: 'S33_WAVE2_TOP15_06_10_HELDOUT' });
    expect(manifest.datasheet.path).toBe(DATASHEET_PATH);
    expect(manifest.testPath).toBe(SOURCE_PATH.replace(/\.ts$/u, '.test.ts'));
    expect(manifest.entries).toHaveLength(180);
    expect(Object.keys(datasheet).sort()).toEqual([
      'acceptanceAuthority', 'artifactType', 'authorshipNote', 'batchId',
      'containsProductionUserDocuments', 'entryCount', 'producerLane', 'revision',
      'rows', 'schemaVersion', 'status',
    ].sort());
    expect(datasheet).toMatchObject({
      schemaVersion: 1,
      artifactType: 'arkova-s33-wave2-batch-datasheet',
      batchId: BATCH_ID,
      revision: 1,
      producerLane: 'Lane 4',
      acceptanceAuthority: 'Lane 3',
      status: 'PRODUCER_CANDIDATE_PENDING_L3_ACCEPTANCE',
      entryCount: 180,
      containsProductionUserDocuments: false,
    });
    expect(datasheet.authorshipNote).toMatch(/independent/iu);
    expect(datasheet.rows).toHaveLength(180);
    expect(S33_WAVE2_TOP15_06_10_HELDOUT).toHaveLength(180);
  });

  it('binds source and datasheet blobs and preserves the exact frozen 06-10 order', () => {
    expect(manifest.source.blobSha).toBe(gitBlobSha1(readFileSync(`${repositoryRoot}/${SOURCE_PATH}`, 'utf8')));
    expect(manifest.datasheet.blobSha).toBe(gitBlobSha1(readFileSync(`${repositoryRoot}/${DATASHEET_PATH}`, 'utf8')));
    expect([...new Set(manifest.entries.map(({ registryTypeId }) => registryTypeId))]).toEqual(EXPECTED_TYPE_ORDER);
    for (const typeId of EXPECTED_TYPE_ORDER) {
      const rows = manifest.entries.filter(({ registryTypeId }) => registryTypeId === typeId);
      expect(rows, typeId).toHaveLength(12);
      expect(rows.map(({ id }) => datasheet.rows.find((candidate) => candidate.id === id)?.edgeCase).filter(Boolean), typeId)
        .toHaveLength(4);
    }
    expect(manifest.entries.slice(0, 60).every(({ domain }) => domain === 'legal')).toBe(true);
    expect(manifest.entries.slice(60, 120).every(({ domain }) => domain === 'financial')).toBe(true);
    expect(manifest.entries.slice(120).every(({ domain }) => domain === 'education')).toBe(true);
  });

  it('keeps source, manifest, and datasheet in an exact ordered bijection disjoint from 01-05', () => {
    const priorIds = new Set(S33_WAVE2_TOP15_01_05_HELDOUT.map(({ id }) => id));
    const priorFingerprints = new Set(S33_WAVE2_TOP15_01_05_HELDOUT.map(({ strippedText }) => (
      sha256(normalizeForFingerprint(strippedText))
    )));
    const ids = new Set<string>();
    const fingerprints = new Set<string>();
    for (const [index, entry] of S33_WAVE2_TOP15_06_10_HELDOUT.entries()) {
      const manifestRow = manifest.entries[index];
      const datasheetRow = datasheet.rows[index];
      const fingerprint = sha256(normalizeForFingerprint(entry.strippedText));
      expect(entry.id).toBe(manifestRow.id);
      expect(entry.id).toBe(datasheetRow.id);
      expect(entry.groundTruth.credentialType).toBe(manifestRow.credentialType);
      expect(entry.groundTruth.subType).toBe(datasheetRow.subType);
      expect(entry.jurisdictionSlice).toBe(datasheetRow.jurisdiction);
      expect(entry.edgeCase).toBe(datasheetRow.edgeCase);
      expect(fingerprint).toBe(manifestRow.normalizedInputSha256);
      expect(ids.has(entry.id) || priorIds.has(entry.id)).toBe(false);
      expect(fingerprints.has(fingerprint) || priorFingerprints.has(fingerprint)).toBe(false);
      ids.add(entry.id);
      fingerprints.add(fingerprint);
    }
  });

  it('keeps each row literal, deep, concrete, held out, and provenance complete', () => {
    const edgeClasses = new Set(S33_EDGE_CLASSES);
    for (const [index, entry] of S33_WAVE2_TOP15_06_10_HELDOUT.entries()) {
      const row = datasheet.rows[index];
      expect(entry.provenance).toBe('authored-s33-lane4');
      expect(entry.source.startsWith('authored/s33-wave2/top15-06-10/')).toBe(true);
      expect(entry.tags).toEqual(expect.arrayContaining(['held-out', 's33', 'authored']));
      expect(entry.tags.join(' ')).not.toMatch(/train|generator|template/iu);
      expect(assertS33HeldoutGroundTruthContract([entry])).toBeUndefined();
      expect(countS33SubstantiveGroundTruthFields(entry.groundTruth), entry.id).toBeGreaterThanOrEqual(5);
      expect(entry.strippedText).not.toMatch(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu);
      expect(entry.strippedText).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/u);
      expect(entry.strippedText).not.toMatch(/(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/u);
      expect(entry.strippedText).not.toMatch(/(?:sk-|ghp_|AKIA)[A-Za-z0-9_-]{12,}/u);
      expect(entry.groundTruth.subType).not.toBe('other');
      expect(row).toMatchObject({
        authorshipMethod: 'independently-authored',
        realOrSynthetic: 'synthetic-realistic',
        independentlyCurated: true,
        generatorDerived: false,
        trainingExposed: false,
        generatorName: null,
        generatorVersion: null,
        seed: null,
        templateId: null,
        curationAuthor: 'Arkova Lane 4',
        curationDate: '2026-07-15',
      });
      expect(row.sourceGrounding.length).toBeGreaterThanOrEqual(20);
      expect(row.licenseConsentNote.length).toBeGreaterThanOrEqual(20);
      expect(row.edgeCase ? edgeClasses.has(row.edgeClass ?? '') : row.edgeClass === null).toBe(true);
    }
  });

  it('has zero full-text/id and exact normalized 6-13-gram leakage', () => {
    const corpus = loadLeakageCorpus(workerRoot, { failOnUnreadable: true })
      .filter(({ path }) => path !== SOURCE_PATH.replace('services/worker/', ''));
    expect(checkHeldoutLeakage(S33_WAVE2_TOP15_06_10_HELDOUT, corpus)).toEqual([]);
    const comparisons = [
      ...corpus.map(({ path, content }) => ({ id: path, text: content })),
      ...S33_WAVE2_TOP15_01_05_HELDOUT.map(({ id, strippedText }) => ({ id, text: strippedText })),
    ];
    expect(exactNgramHits(
      S33_WAVE2_TOP15_06_10_HELDOUT.map(({ id, strippedText }) => ({ id, text: strippedText })),
      comparisons,
    )).toEqual([]);
  }, 30_000);
});

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

const BATCH_ID = 'S33-W2-TOP15-01-05';
const REGISTRY_DIGEST_SHA256 = '412a08227608a58172569a4fcbf3cd1025dc67fc1beeaddd6c163d22c4cb80d6';
const SOURCE_PATH = 'services/worker/src/ai/eval/golden-dataset-s33-wave2-top15-01-05-heldout.ts';
const MANIFEST_PATH = 'docs/lane4/s33-wave2-batches/top15-01-05/manifest.json';
const DATASHEET_PATH = 'docs/lane4/s33-wave2-batches/top15-01-05/datasheet.json';
const workerRoot = fileURLToPath(new URL('../../../', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

const EXPECTED_TYPE_ORDER = [
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
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
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

describe('S3.3 Wave 3 top-15 tranche 01-05', () => {
  const manifest = readJson<Manifest>(MANIFEST_PATH);
  const datasheet = readJson<Datasheet>(DATASHEET_PATH);

  it('is exactly one immutable 180-row, 15-type whole batch', () => {
    expect(Object.keys(manifest).sort()).toEqual([
      'acceptanceAuthority', 'acceptanceScope', 'artifactType', 'baseRegistryDigestSha256',
      'batchId', 'datasheet', 'entries', 'entryCount', 'intendedSplit', 'producerLane',
      'revision', 'schemaVersion', 'source', 'status', 'testPath',
    ].sort());
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.artifactType).toBe('arkova-s33-wave2-batch-manifest');
    expect(manifest.batchId).toBe(BATCH_ID);
    expect(manifest.revision).toBe(1);
    expect(manifest.producerLane).toBe('Lane 4');
    expect(manifest.acceptanceAuthority).toBe('Lane 3');
    expect(manifest.status).toBe('PRODUCER_CANDIDATE_PENDING_L3_ACCEPTANCE');
    expect(manifest.intendedSplit).toBe('held-out-candidate');
    expect(manifest.acceptanceScope).toBe('whole-batch-only');
    expect(manifest.baseRegistryDigestSha256).toBe(REGISTRY_DIGEST_SHA256);
    expect(manifest.source.path).toBe(SOURCE_PATH);
    expect(manifest.source.exportName).toBe('S33_WAVE2_TOP15_01_05_HELDOUT');
    expect(manifest.testPath).toBe(SOURCE_PATH.replace(/\.ts$/u, '.test.ts'));
    expect(manifest.datasheet.path).toBe(DATASHEET_PATH);
    expect(manifest.entryCount).toBe(180);
    expect(manifest.entries).toHaveLength(180);
    expect(Object.keys(datasheet).sort()).toEqual([
      'acceptanceAuthority', 'artifactType', 'authorshipNote', 'batchId',
      'containsProductionUserDocuments', 'entryCount', 'producerLane', 'revision',
      'rows', 'schemaVersion', 'status',
    ].sort());
    expect(datasheet.schemaVersion).toBe(1);
    expect(datasheet.artifactType).toBe('arkova-s33-wave2-batch-datasheet');
    expect(datasheet.batchId).toBe(BATCH_ID);
    expect(datasheet.revision).toBe(1);
    expect(datasheet.producerLane).toBe('Lane 4');
    expect(datasheet.acceptanceAuthority).toBe('Lane 3');
    expect(datasheet.status).toBe('PRODUCER_CANDIDATE_PENDING_L3_ACCEPTANCE');
    expect(datasheet.entryCount).toBe(180);
    expect(datasheet.containsProductionUserDocuments).toBe(false);
    expect(datasheet.authorshipNote).toMatch(/independent/iu);
    expect(datasheet.rows).toHaveLength(180);
    expect(S33_WAVE2_TOP15_01_05_HELDOUT).toHaveLength(180);
  });

  it('binds source and datasheet Git blobs without a caller-supplied digest', () => {
    const source = readFileSync(`${repositoryRoot}/${SOURCE_PATH}`, 'utf8');
    const datasheetRaw = readFileSync(`${repositoryRoot}/${DATASHEET_PATH}`, 'utf8');
    expect(manifest.source.blobSha).toBe(gitBlobSha1(source));
    expect(manifest.datasheet.blobSha).toBe(gitBlobSha1(datasheetRaw));
  });

  it('preserves authenticated registry order with 12 rows and 4 edge cases per type', () => {
    const typeOrder: string[] = [];
    for (const typeId of EXPECTED_TYPE_ORDER) {
      const rows = manifest.entries.filter(({ registryTypeId }) => registryTypeId === typeId);
      expect(rows, typeId).toHaveLength(12);
      expect(rows.map(({ id }) => datasheet.rows.find((candidate) => candidate.id === id)?.edgeCase)
        .filter(Boolean), typeId).toHaveLength(4);
      typeOrder.push(typeId);
    }
    expect([...new Set(manifest.entries.map(({ registryTypeId }) => registryTypeId))]).toEqual(typeOrder);
    expect(manifest.entries.slice(0, 60).every(({ domain }) => domain === 'legal')).toBe(true);
    expect(manifest.entries.slice(60, 120).every(({ domain }) => domain === 'financial')).toBe(true);
    expect(manifest.entries.slice(120).every(({ domain }) => domain === 'education')).toBe(true);
  });

  it('keeps source, manifest, and datasheet in an exact ordered bijection', () => {
    const ids = new Set<string>();
    const fingerprints = new Set<string>();
    for (const [index, entry] of S33_WAVE2_TOP15_01_05_HELDOUT.entries()) {
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
      expect(ids.has(entry.id)).toBe(false);
      expect(fingerprints.has(fingerprint)).toBe(false);
      ids.add(entry.id);
      fingerprints.add(fingerprint);
    }
  });

  it('keeps every row literal, held-out, post-validation-deep, and PII-free', () => {
    const edgeClasses = new Set(S33_EDGE_CLASSES);
    for (const [index, entry] of S33_WAVE2_TOP15_01_05_HELDOUT.entries()) {
      const row = datasheet.rows[index];
      expect(entry.provenance).toBe('authored-s33-lane4');
      expect(entry.source.startsWith('authored/s33-wave2/')).toBe(true);
      expect(entry.tags).toEqual(expect.arrayContaining(['held-out', 's33', 'authored']));
      expect(entry.tags.join(' ')).not.toMatch(/train|generator|template/iu);
      expect(assertS33HeldoutGroundTruthContract([entry])).toBeUndefined();
      expect(countS33SubstantiveGroundTruthFields(entry.groundTruth), entry.id).toBeGreaterThanOrEqual(5);
      expect(entry.strippedText).not.toMatch(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu);
      expect(entry.strippedText).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/u);
      expect(entry.strippedText).not.toMatch(/(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/u);
      expect(row.authorshipMethod).toBe('independently-authored');
      expect(row.realOrSynthetic).toBe('synthetic-realistic');
      expect(row.independentlyCurated).toBe(true);
      expect(row.generatorDerived).toBe(false);
      expect(row.trainingExposed).toBe(false);
      expect([row.generatorName, row.generatorVersion, row.seed, row.templateId]).toEqual([null, null, null, null]);
      expect(row.curationAuthor).toBe('Arkova Lane 4');
      expect(row.curationDate).toBe('2026-07-15');
      expect(row.sourceGrounding.length).toBeGreaterThanOrEqual(20);
      expect(row.licenseConsentNote.length).toBeGreaterThanOrEqual(20);
      expect(row.edgeCase ? edgeClasses.has(row.edgeClass ?? '') : row.edgeClass === null).toBe(true);
    }
  });

  it('has zero full-text/id and exact normalized n=6..13 leakage', () => {
    const corpus = loadLeakageCorpus(workerRoot, { failOnUnreadable: true })
      .filter(({ path }) => path !== SOURCE_PATH.replace('services/worker/', ''));
    expect(checkHeldoutLeakage(S33_WAVE2_TOP15_01_05_HELDOUT, corpus)).toEqual([]);
    const exact = exactNgramHits(
      S33_WAVE2_TOP15_01_05_HELDOUT.map(({ id, strippedText }) => ({ id, text: strippedText })),
      corpus.map(({ path, content }) => ({ id: path, text: content })),
    );
    expect(exact).toEqual([]);
  }, 20_000);
});

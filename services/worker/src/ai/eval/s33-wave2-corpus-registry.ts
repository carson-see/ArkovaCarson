/**
 * Trusted-main S3.3 Wave-2 corpus registry.
 *
 * The registry starts from the immutable PR #1544 merge tuple. It never trusts
 * a caller-supplied list of Wave-1 rows: the exact merged Git objects and raw
 * artifact digests are re-read from the repository named by `verificationHeadSha`.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { canonicaliseJson } from '../../utils/canonical-json.js';
import {
  parseStrictJsonDocument,
  WAVE1_CORPUS_DATASHEET_PATH,
  WAVE1_ENTRY_DATASHEET_PATH,
  WAVE1_ENTRY_IDS,
  WAVE1_MANIFEST_PATH,
  WAVE1_SOURCE_BLOB_PATHS,
  WAVE1_TYPES_PATH,
  type BatchManifestEntry,
} from './s33-batch-acceptance.js';

const GIT = '/usr/bin/git';
const GIT_ENV = Object.freeze({
  PATH: '/usr/bin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_COUNT: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
});
const GIT_OBJECT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const S33_WAVE1_IMMUTABLE_TUPLE = Object.freeze({
  pullRequestNumber: 1544,
  mergeCommitSha: '42530fd73f9bd0cb7e4e70fc1259324810780b2c',
  mergeParentSha: '67302fffcbdc5d72005aca7966b753a2fa74e4d0',
  producerHeadSha: '618e08d5a11cb73cb61394bc0343d33f4353ef39',
  producerParentSha: '48c42dcee17eb121bc79323f94c62d7c5b9ff5b9',
  producerTreeSha: '7401db53a9af3cb17c9c18a5abb9fd1fc68473d1',
  mergeTreeSha: '86cafa2afbb1e0c7049753261f7e4e96508e3a7d',
  typesBlobSha: 'cb93acd8c536a75e2ef9bb4928877a6d46eb3ed7',
  manifestRawSha256: 'eeb7c1b4bbd71642b4a7429864c0e04e9a5e3daf74b2cd78dd26442592f56e20',
  entryDatasheetRawSha256: 'da27f796454edf975b2adcb1a21a37fbbb9daecbe79b8c693a9963f4a83bdd64',
  packetBlobs: Object.freeze({
    [WAVE1_CORPUS_DATASHEET_PATH]: '693c756117e5744fe4a532449ee932c61fc7dcb9',
    [WAVE1_MANIFEST_PATH]: 'ebee08ac088f2b8f195d9b827a38f5b774c6e1b9',
    [WAVE1_ENTRY_DATASHEET_PATH]: '6ccd8f2b60c561cffa8a5537584c7e3d6570dae1',
    [WAVE1_SOURCE_BLOB_PATHS[0]]: '78090443bad793d248fdd1e3d22f7e468d618777',
    [WAVE1_SOURCE_BLOB_PATHS[1]]: '7826dc6a34b475bdf2c73f9059026b8d19ec1b1f',
    [WAVE1_SOURCE_BLOB_PATHS[2]]: 'a261cf690c930040f7dee0361ed29d73d1d23426',
  }),
  packetRawSha256: Object.freeze({
    [WAVE1_MANIFEST_PATH]: 'eeb7c1b4bbd71642b4a7429864c0e04e9a5e3daf74b2cd78dd26442592f56e20',
    [WAVE1_ENTRY_DATASHEET_PATH]: 'da27f796454edf975b2adcb1a21a37fbbb9daecbe79b8c693a9963f4a83bdd64',
    [WAVE1_SOURCE_BLOB_PATHS[0]]: 'f6fba82b45e0ffd7b7a6bcfb25c2457d766682f296f0366808af14361e0ac553',
    [WAVE1_SOURCE_BLOB_PATHS[1]]: '35756a6047ae3b3009d8c9497427e878132a00e4b089d136ae5b858627c1d965',
    [WAVE1_SOURCE_BLOB_PATHS[2]]: '95996b75b98f18b57e05f99a26834bc93f0cc25b4a93c5740561df607aae77d9',
  }),
});

export interface S33Wave2RegistryEntry extends BatchManifestEntry {
  readonly batchId: string;
  readonly revision: number;
  readonly sourcePath: string;
}

export interface S33Wave2RegistryBatch {
  readonly batchId: string;
  readonly revision: number;
  readonly manifestPath: string;
  readonly manifestRawSha256: string;
  readonly sourcePath: string;
  readonly sourceBlobSha: string;
  readonly datasheetPath: string;
  readonly datasheetBlobSha: string;
  readonly entryCount: number;
}

export interface S33Wave2CorpusRegistry {
  readonly schemaVersion: 1;
  readonly artifactType: 'arkova-s33-wave2-corpus-registry';
  readonly algorithmVersion: 's33-wave2-corpus-registry-v1';
  readonly repositoryIdentity: 'carson-see/ArkovaCarson';
  readonly verificationHeadSha: string;
  readonly verificationTreeSha: string;
  readonly wave1Tuple: typeof S33_WAVE1_IMMUTABLE_TUPLE;
  readonly acceptedBatches: readonly S33Wave2RegistryBatch[];
  readonly entries: readonly S33Wave2RegistryEntry[];
  readonly registryDigestSha256: string;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function git(repositoryRoot: string, args: readonly string[], encoding: 'utf8'): string;
function git(repositoryRoot: string, args: readonly string[]): Buffer;
function git(repositoryRoot: string, args: readonly string[], encoding?: 'utf8'): string | Buffer {
  return execFileSync(GIT, ['-C', repositoryRoot, ...args], {
    encoding,
    env: GIT_ENV,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function assertObject(value: string, label: string): void {
  if (!GIT_OBJECT.test(value)) throw new Error(`${label} must be a full lowercase SHA-1 Git object id`);
}

function readPath(repositoryRoot: string, commit: string, path: string): Buffer {
  try {
    return git(repositoryRoot, ['show', `${commit}:${path}`]);
  } catch (error) {
    throw new Error(`Immutable S3.3 packet path is missing at ${commit}: ${path}`, { cause: error });
  }
}

function blobAt(repositoryRoot: string, commit: string, path: string): string {
  return git(repositoryRoot, ['rev-parse', `${commit}:${path}`], 'utf8').trim();
}

function exactString(value: unknown, expected: string, label: string): void {
  if (value !== expected) throw new Error(`${label} must be exactly ${expected}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function computeRegistryDigest(
  registry: Omit<S33Wave2CorpusRegistry, 'registryDigestSha256'>,
): string {
  // The content identity must remain stable across unrelated trusted-main
  // commits. Freshness is enforced independently by `verificationHeadSha`.
  const { verificationHeadSha: _head, verificationTreeSha: _tree, ...corpusIdentity } = registry;
  return sha256(canonicaliseJson(corpusIdentity));
}

/** Verify and consume the exact merged PR #1544 Wave-1 corpus from trusted main. */
export function buildS33Wave2BaseCorpusRegistry(input: Readonly<{
  repositoryRoot: string;
  verificationHeadSha: string;
}>): S33Wave2CorpusRegistry {
  assertObject(input.verificationHeadSha, 'Wave-2 registry verification head');
  const repositoryRoot = realpathSync(input.repositoryRoot);
  const resolvedHead = git(repositoryRoot, ['rev-parse', `${input.verificationHeadSha}^{commit}`], 'utf8').trim();
  if (resolvedHead !== input.verificationHeadSha) throw new Error('Wave-2 registry verification head is not exact');

  try {
    git(repositoryRoot, ['merge-base', '--is-ancestor', S33_WAVE1_IMMUTABLE_TUPLE.mergeCommitSha, resolvedHead]);
  } catch (error) {
    throw new Error('Wave-2 trusted main does not descend from the immutable PR #1544 merge', { cause: error });
  }

  const mergeLineage = git(repositoryRoot, [
    'rev-list', '--parents', '-n', '1', S33_WAVE1_IMMUTABLE_TUPLE.mergeCommitSha,
  ], 'utf8').trim().split(/\s+/u);
  const expectedMergeLineage = [
    S33_WAVE1_IMMUTABLE_TUPLE.mergeCommitSha,
    S33_WAVE1_IMMUTABLE_TUPLE.mergeParentSha,
    S33_WAVE1_IMMUTABLE_TUPLE.producerHeadSha,
  ];
  if (canonicaliseJson(mergeLineage) !== canonicaliseJson(expectedMergeLineage)) {
    throw new Error('PR #1544 merge ancestry does not match the immutable tuple');
  }
  const producerLineage = git(repositoryRoot, [
    'rev-list', '--parents', '-n', '1', S33_WAVE1_IMMUTABLE_TUPLE.producerHeadSha,
  ], 'utf8').trim().split(/\s+/u);
  if (producerLineage.length !== 2
    || producerLineage[0] !== S33_WAVE1_IMMUTABLE_TUPLE.producerHeadSha
    || producerLineage[1] !== S33_WAVE1_IMMUTABLE_TUPLE.producerParentSha) {
    throw new Error('PR #1544 producer ancestry does not match the immutable tuple');
  }
  for (const [commit, expectedTree, label] of [
    [S33_WAVE1_IMMUTABLE_TUPLE.producerHeadSha, S33_WAVE1_IMMUTABLE_TUPLE.producerTreeSha, 'producer'],
    [S33_WAVE1_IMMUTABLE_TUPLE.mergeCommitSha, S33_WAVE1_IMMUTABLE_TUPLE.mergeTreeSha, 'merge'],
  ] as const) {
    if (git(repositoryRoot, ['rev-parse', `${commit}^{tree}`], 'utf8').trim() !== expectedTree) {
      throw new Error(`PR #1544 ${label} tree does not match the immutable tuple`);
    }
  }
  if (blobAt(repositoryRoot, resolvedHead, WAVE1_TYPES_PATH) !== S33_WAVE1_IMMUTABLE_TUPLE.typesBlobSha) {
    throw new Error('Wave-1 evaluator types blob drifted after PR #1544');
  }

  for (const [path, expectedBlob] of Object.entries(S33_WAVE1_IMMUTABLE_TUPLE.packetBlobs)) {
    const producerBlob = blobAt(repositoryRoot, S33_WAVE1_IMMUTABLE_TUPLE.producerHeadSha, path);
    const consumedBlob = blobAt(repositoryRoot, resolvedHead, path);
    if (producerBlob !== expectedBlob || consumedBlob !== expectedBlob) {
      throw new Error(`Wave-1 immutable packet blob drifted: ${path}`);
    }
  }
  for (const [path, expectedDigest] of Object.entries(S33_WAVE1_IMMUTABLE_TUPLE.packetRawSha256)) {
    const content = readPath(repositoryRoot, resolvedHead, path);
    if (!SHA256.test(expectedDigest) || sha256(content) !== expectedDigest) {
      throw new Error(`Wave-1 immutable packet raw digest drifted: ${path}`);
    }
  }

  const manifestContent = readPath(repositoryRoot, resolvedHead, WAVE1_MANIFEST_PATH);
  const manifestDocument = parseStrictJsonDocument(manifestContent, 'immutable Wave-1 manifest');
  if (manifestDocument.rawSha256 !== S33_WAVE1_IMMUTABLE_TUPLE.manifestRawSha256) {
    throw new Error('Immutable Wave-1 manifest raw digest mismatch');
  }
  const manifest = manifestDocument.parsed;
  exactString(manifest.batchId, 'S33-W1', 'Immutable Wave-1 batchId');
  exactString(manifest.status, 'PRODUCER_R12_CANDIDATE_PENDING_L3_FORMAL_ACCEPTANCE', 'Immutable Wave-1 status');
  exactString(manifest.acceptanceScope, 'whole-batch-only', 'Immutable Wave-1 acceptance scope');
  if (manifest.schemaVersion !== 1 || manifest.revision !== 12 || manifest.entryCount !== 81
    || !Array.isArray(manifest.entries) || manifest.entries.length !== 81) {
    throw new Error('Immutable Wave-1 manifest shape/count/revision mismatch');
  }
  const entries = manifest.entries.map((candidate, index): S33Wave2RegistryEntry => {
    const entry = record(candidate, `Immutable Wave-1 manifest entry ${index}`);
    const id = String(entry.id ?? '');
    const domain = String(entry.domain ?? '');
    const credentialType = String(entry.credentialType ?? '');
    const normalizedInputSha256 = String(entry.normalizedInputSha256 ?? '');
    if (id !== WAVE1_ENTRY_IDS[index] || !domain || !credentialType || !SHA256.test(normalizedInputSha256)) {
      throw new Error(`Immutable Wave-1 manifest entry ${index} is invalid`);
    }
    return {
      id,
      domain,
      credentialType,
      normalizedInputSha256,
      batchId: 'S33-W1',
      revision: 12,
      sourcePath: 'immutable-pr-1544-wave1-packet',
    };
  });
  if (new Set(entries.map(({ id }) => id)).size !== 81
    || new Set(entries.map(({ normalizedInputSha256 }) => normalizedInputSha256)).size !== 81) {
    throw new Error('Immutable Wave-1 registry contains duplicate ids or normalized inputs');
  }

  const datasheetContent = readPath(repositoryRoot, resolvedHead, WAVE1_ENTRY_DATASHEET_PATH);
  const datasheetDocument = parseStrictJsonDocument(datasheetContent, 'immutable Wave-1 entry datasheet');
  if (datasheetDocument.rawSha256 !== S33_WAVE1_IMMUTABLE_TUPLE.entryDatasheetRawSha256) {
    throw new Error('Immutable Wave-1 entry datasheet raw digest mismatch');
  }
  const datasheet = datasheetDocument.parsed;
  if (datasheet.manifestSha256 !== manifestDocument.rawSha256
    || datasheet.entryCount !== 81
    || !Array.isArray(datasheet.rows)
    || datasheet.rows.length !== 81
    || datasheet.rows.some((candidate, index) => record(candidate, 'Wave-1 datasheet row').id !== entries[index].id)) {
    throw new Error('Immutable Wave-1 manifest/source/datasheet bijection failed');
  }

  const verificationTreeSha = git(repositoryRoot, ['rev-parse', `${resolvedHead}^{tree}`], 'utf8').trim();
  const withoutDigest: Omit<S33Wave2CorpusRegistry, 'registryDigestSha256'> = {
    schemaVersion: 1,
    artifactType: 'arkova-s33-wave2-corpus-registry',
    algorithmVersion: 's33-wave2-corpus-registry-v1',
    repositoryIdentity: 'carson-see/ArkovaCarson',
    verificationHeadSha: resolvedHead,
    verificationTreeSha,
    wave1Tuple: S33_WAVE1_IMMUTABLE_TUPLE,
    acceptedBatches: [{
      batchId: 'S33-W1',
      revision: 12,
      manifestPath: WAVE1_MANIFEST_PATH,
      manifestRawSha256: manifestDocument.rawSha256,
      sourcePath: 'immutable-pr-1544-wave1-packet',
      sourceBlobSha: S33_WAVE1_IMMUTABLE_TUPLE.producerTreeSha,
      datasheetPath: WAVE1_ENTRY_DATASHEET_PATH,
      datasheetBlobSha: S33_WAVE1_IMMUTABLE_TUPLE.packetBlobs[WAVE1_ENTRY_DATASHEET_PATH],
      entryCount: 81,
    }],
    entries,
  };
  return deepFreeze({ ...withoutDigest, registryDigestSha256: computeRegistryDigest(withoutDigest) });
}

/** Append one fully validated, whole-batch Wave-2 tranche to an immutable registry. */
export function extendS33Wave2CorpusRegistry(
  registry: S33Wave2CorpusRegistry,
  batch: S33Wave2RegistryBatch,
  entries: readonly S33Wave2RegistryEntry[],
): S33Wave2CorpusRegistry {
  if (batch.entryCount !== entries.length || entries.length === 0) {
    throw new Error('Wave-2 registry extension must contain one complete non-empty batch');
  }
  if (registry.acceptedBatches.some(({ batchId }) => batchId === batch.batchId)) {
    throw new Error(`Wave-2 registry batch is duplicated: ${batch.batchId}`);
  }
  const knownIds = new Set(registry.entries.map(({ id }) => id));
  const knownFingerprints = new Set(registry.entries.map(({ normalizedInputSha256 }) => normalizedInputSha256));
  for (const entry of entries) {
    if (entry.batchId !== batch.batchId || entry.revision !== batch.revision) {
      throw new Error(`Wave-2 registry entry ${entry.id} batch binding mismatch`);
    }
    if (knownIds.has(entry.id)) throw new Error(`Wave-2 duplicate entry id: ${entry.id}`);
    if (knownFingerprints.has(entry.normalizedInputSha256)) {
      throw new Error(`Wave-2 duplicate normalized input: ${entry.id}`);
    }
    knownIds.add(entry.id);
    knownFingerprints.add(entry.normalizedInputSha256);
  }
  const { registryDigestSha256: _priorDigest, ...priorRegistry } = registry;
  const withoutDigest: Omit<S33Wave2CorpusRegistry, 'registryDigestSha256'> = {
    ...priorRegistry,
    acceptedBatches: [...registry.acceptedBatches, batch],
    entries: [...registry.entries, ...entries],
  };
  return deepFreeze({ ...withoutDigest, registryDigestSha256: computeRegistryDigest(withoutDigest) });
}

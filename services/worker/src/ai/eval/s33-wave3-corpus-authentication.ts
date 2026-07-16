/**
 * S3.3 held-out corpus authentication and v7.1 zero-overlap proof.
 *
 * This module is offline-only. It can canonicalize public corpus facts, emit
 * exact detached-signing bytes, and verify a detached signature under the
 * already code-bound public release/corpus root. It has no signer, private-key
 * input, cloud client, upload, tuning, endpoint, rig, or soak capability.
 */

import {
  createHash,
  createPublicKey,
  verify as verifyEd25519,
} from 'node:crypto';
import { canonicaliseJson } from '../../utils/canonical-json.js';
import {
  S33_DETACHED_SIGNING_TRUST_POLICY_V2,
  getS33DetachedSigningAuthorityV2,
} from './s33-wave3-detached-signing-v2.js';

const REPOSITORY_IDENTITY = 'carson-see/ArkovaCarson' as const;
const HELDOUT_SOURCE_HEAD_SHA = 'c9a230195ed30149252c819d37e9a48b16a4d4e9' as const;
const HELDOUT_SOURCE_TREE_SHA = 'd90a82ccdc7d632070a01b60437cccd109728eda' as const;
const V71_SOURCE_HEAD_SHA = '251d32b98cea2ec3ba6f5051a261ff0a80f671dd' as const;
const V71_SOURCE_TREE_SHA = 'a14ceb19202d2e16e09238e3e24ea8683d48f5f4' as const;
const CORPUS_REGISTRY_DIGEST_SHA256 =
  '7d6ffd131230d13483d3f1bacdb170b3cfcc53a4383d59f6689e415c99e6089e' as const;
const V71_FROZEN_DIGESTS = Object.freeze({
  sourceOrderedIdsSha256: 'd7d41cc1a956e9d76cd60ce30f728adde80e854e31ec24df213caf4546a2fa0f',
  sourceContentCanonicalSha256: '1ee0d9a41c3f5af2e4a00bb76cb43a1cd5ec1cef2d362b8f1cb879ecfddf6e48',
  retainedTargetsCanonicalSha256: '6a069b6c8eeae631f9c49bdedbbf6ba00476bc7eb519807630f53aca095e6831',
  trainJsonlSha256: 'f9581728f0656cb832afea3d1f1c1796ee3b10c9ed38ef6787f93be27fbe2303',
  validationJsonlSha256: 'a61723ff24864df7717faf1869847153870aed9d51ab200e6dc72b2d499b8d9f',
  surgeryManifestCanonicalSha256: '0b7f5dd2c504e9fb0cdd342d575d53f271c90e56d529b87d9b665b70c9fd3b0b',
  trainIdentityOrderSha256: 'cf0e7c2360938eb2cf742e45152d74e2d55451745304a2a0bbc8da1961c61a3b',
  validationIdentityOrderSha256: '2b68ad62638b007d34a924e818fd56f2224971a755acc1de0dbf1286724e0f99',
  combinedIdentitySetCanonicalSha256: 'c9e91fcd88d8c56dd0e8196c9a92d9f8f30302f4a01a67e2915a67a9edb756cb',
  normalizedContentSetCanonicalSha256: '4aeff5549357195fb99af6c64704331187ea6ba8ae626210da8afee09addd1e5',
});
const DOMAIN_SEPARATOR = 'arkova:s33:heldout-corpus-authentication:v1\n' as const;
const SIGNATURE_ALGORITHM = 'Ed25519' as const;
const SIGNER_IDENTITY = 'arkova-s33-cto-release' as const;
const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;

type JsonRecord = Record<string, unknown>;

const SOURCES = Object.freeze([
  {
    path: 'services/worker/src/ai/eval/golden-dataset-s33-licensing-heldout.ts',
    exportName: 'S33_LICENSING_HELDOUT',
    expectedCount: 50,
    blobSha: '78090443bad793d248fdd1e3d22f7e468d618777',
    rawSha256: 'f6fba82b45e0ffd7b7a6bcfb25c2457d766682f296f0366808af14361e0ac553',
  },
  {
    path: 'services/worker/src/ai/eval/golden-dataset-s33-au-ke-heldout.ts',
    exportName: 'S33_AU_KE_HELDOUT',
    expectedCount: 22,
    blobSha: '7826dc6a34b475bdf2c73f9059026b8d19ec1b1f',
    rawSha256: '35756a6047ae3b3009d8c9497427e878132a00e4b089d136ae5b858627c1d965',
  },
  {
    path: 'services/worker/src/ai/eval/golden-dataset-s33-ood-negatives.ts',
    exportName: 'S33_OOD_NEGATIVES',
    expectedCount: 9,
    blobSha: 'a261cf690c930040f7dee0361ed29d73d1d23426',
    rawSha256: '95996b75b98f18b57e05f99a26834bc93f0cc25b4a93c5740561df607aae77d9',
  },
  {
    path: 'services/worker/src/ai/eval/golden-dataset-s33-wave2-top15-01-05-heldout.ts',
    exportName: 'S33_WAVE2_TOP15_01_05_HELDOUT',
    expectedCount: 180,
    blobSha: 'e880162adb59eaf87742573b36fcea571abb9410',
    rawSha256: 'a30e7e0a4e96e0c8ea382db69d8f49e70ad020b1277521472dd667892ccbebbf',
  },
  {
    path: 'services/worker/src/ai/eval/golden-dataset-s33-wave2-top15-06-10-heldout.ts',
    exportName: 'S33_WAVE2_TOP15_06_10_HELDOUT',
    expectedCount: 180,
    blobSha: 'dd85110330e4e784e06636e490a6abf157e7c209',
    rawSha256: 'b8733f3f00ddc86445a3701febf8ac99648e4bc4010697e55c4776f7d26e23c3',
  },
  {
    path: 'services/worker/src/ai/eval/golden-dataset-s33-wave2-top15-11-15-heldout.ts',
    exportName: 'S33_WAVE2_TOP15_11_15_HELDOUT',
    expectedCount: 180,
    blobSha: '8684234456f270ce0f9119588b305427f2c43407',
    rawSha256: 'f095a2150cb99afb9c508ce265e9d2c9edb6efd2537c49635c7cccc51533a690',
  },
] as const);

export const S33_HELDOUT_CORPUS_AUTHENTICATION_CONSTANTS = Object.freeze({
  repositoryIdentity: REPOSITORY_IDENTITY,
  heldoutSourceHeadSha: HELDOUT_SOURCE_HEAD_SHA,
  heldoutSourceTreeSha: HELDOUT_SOURCE_TREE_SHA,
  v71SourceHeadSha: V71_SOURCE_HEAD_SHA,
  v71SourceTreeSha: V71_SOURCE_TREE_SHA,
  corpusRegistryDigestSha256: CORPUS_REGISTRY_DIGEST_SHA256,
  domainSeparator: DOMAIN_SEPARATOR,
  sources: SOURCES,
  heldoutSchema: Object.freeze({
    path: 'services/worker/src/ai/eval/golden-dataset-s33-types.ts',
    blobSha: 'cb93acd8c536a75e2ef9bb4928877a6d46eb3ed7',
    rawSha256: '01dedf96d38a66bd0ada7a738f44f0e2153ec27879aafce6249d36dc45c378bb',
  }),
  coverageRegistry: Object.freeze({
    path: 'docs/lane4/s33-wave2-top15-registry.json',
    blobSha: '0cb24b9485c0a1eadddd3a51ae6e8f92e4cac48b',
    rawSha256: '1716bfd035bd481669dfa28c0fb8eb07c33f928da57dc17107228dc6d372f813',
    canonicalSha256: '20c940d17c497c9adec30e8b1491b81b5508e34e83099cf5b0a00bd155848c5f',
  }),
});

export interface S33HeldoutSourceInput {
  readonly path: string;
  readonly exportName: string;
  readonly expectedCount: number;
  readonly blobSha: string;
  readonly rawSha256: string;
  readonly sourceText: string;
  readonly rows: readonly JsonRecord[];
}

export interface S33CorpusIdentityRow {
  readonly id: string;
  readonly sourcePath: string;
  readonly sourceIndex: number;
  readonly corpusIndex: number;
  readonly normalizedInputSha256: string;
  readonly canonicalRowSha256: string;
}

export interface S33V71ExportIdentity {
  readonly id: string;
  readonly normalizedInputSha256: string;
}

export interface S33V71ExportIdentityInput {
  readonly sourceHeadSha: string;
  readonly sourceTreeSha: string;
  readonly sourceCount: number;
  readonly retainedCount: number;
  readonly trainCount: number;
  readonly validationCount: number;
  readonly uniqueIdCount: number;
  readonly uniqueNormalizedContentCount: number;
  readonly sourceOrderedIdsSha256: string;
  readonly sourceContentCanonicalSha256: string;
  readonly retainedTargetsCanonicalSha256: string;
  readonly trainJsonlSha256: string;
  readonly validationJsonlSha256: string;
  readonly surgeryManifestCanonicalSha256: string;
  readonly trainIdentityOrderSha256: string;
  readonly validationIdentityOrderSha256: string;
  readonly combinedIdentitySetCanonicalSha256: string;
  readonly normalizedContentSetCanonicalSha256: string;
  readonly train: readonly S33V71ExportIdentity[];
  readonly validation: readonly S33V71ExportIdentity[];
}

interface S33HeldoutIdentitySet {
  readonly count: number;
  readonly uniqueIdCount: number;
  readonly uniqueNormalizedContentCount: number;
  readonly entryOrderSha256: string;
  readonly entrySetCanonicalSha256: string;
  readonly normalizedContentOrderSha256: string;
  readonly normalizedContentSetCanonicalSha256: string;
  readonly canonicalRowsOrderSha256: string;
  readonly sourceOrderSha256: string;
  readonly sources: readonly Readonly<{
    path: string;
    exportName: string;
    blobSha: string;
    rawSha256: string;
    rowCount: number;
    rowOrderSha256: string;
    canonicalRowsSha256: string;
  }>[];
  readonly rows: readonly S33CorpusIdentityRow[];
}

export interface S33HeldoutCorpusIdentityIndex {
  readonly schemaVersion: 1;
  readonly artifactType: 'arkova-s33-heldout-corpus-zero-overlap-index';
  readonly repositoryIdentity: typeof REPOSITORY_IDENTITY;
  readonly heldoutSourceHeadSha: typeof HELDOUT_SOURCE_HEAD_SHA;
  readonly heldoutSourceTreeSha: typeof HELDOUT_SOURCE_TREE_SHA;
  readonly strictRegistryDigestSha256: typeof CORPUS_REGISTRY_DIGEST_SHA256;
  readonly heldout: S33HeldoutIdentitySet;
  readonly v71: S33V71ExportIdentityInput;
  readonly overlap: Readonly<{
    heldoutToV71IdCount: 0;
    heldoutToV71NormalizedContentCount: 0;
    heldoutToV71Ids: readonly string[];
    heldoutToV71NormalizedContentSha256: readonly string[];
  }>;
}

export interface S33HeldoutCorpusAuthenticationPayload {
  readonly schemaVersion: 1;
  readonly artifactType: 'arkova-s33-heldout-corpus-authentication-payload';
  readonly verdict: 'AUTHENTICATE_EXACT_HELDOUT_CORPUS';
  readonly authorityScope: 'CORPUS_ONLY_NO_RC_NO_SOAK_NO_SPEND';
  readonly repositoryIdentity: typeof REPOSITORY_IDENTITY;
  readonly sourceBindings: Readonly<{
    heldoutHeadSha: typeof HELDOUT_SOURCE_HEAD_SHA;
    heldoutTreeSha: typeof HELDOUT_SOURCE_TREE_SHA;
    v71HeadSha: typeof V71_SOURCE_HEAD_SHA;
    v71TreeSha: typeof V71_SOURCE_TREE_SHA;
    finalReleaseCandidate: Readonly<{
      status: 'PENDING_COMPOSITION';
      headSha: null;
      treeSha: null;
    }>;
    heldoutSchema: typeof S33_HELDOUT_CORPUS_AUTHENTICATION_CONSTANTS.heldoutSchema;
    coverageRegistry: typeof S33_HELDOUT_CORPUS_AUTHENTICATION_CONSTANTS.coverageRegistry;
  }>;
  readonly corpus: Readonly<{
    count: 621;
    uniqueIdCount: 621;
    uniqueNormalizedContentCount: 621;
    strictRegistryDigestSha256: typeof CORPUS_REGISTRY_DIGEST_SHA256;
    identityIndexCanonicalSha256: string;
    entryOrderSha256: string;
    entrySetCanonicalSha256: string;
    canonicalRowsOrderSha256: string;
  }>;
  readonly v71: Readonly<{
    trainCount: 865;
    validationCount: 96;
    uniqueIdCount: 961;
    sourceOrderedIdsSha256: string;
    sourceContentCanonicalSha256: string;
    retainedTargetsCanonicalSha256: string;
    trainJsonlSha256: string;
    validationJsonlSha256: string;
    surgeryManifestCanonicalSha256: string;
  }>;
  readonly zeroOverlap: Readonly<{
    identityAlgorithm: 'exact-entry-id-set-v1';
    contentAlgorithm: 'lowercase-collapse-whitespace-sha256-v1';
    heldoutToV71IdCount: 0;
    heldoutToV71NormalizedContentCount: 0;
  }>;
  readonly executionState: Readonly<{
    corpusAuthentication: 'VALID_ONLY_WITH_MATCHING_DETACHED_SIGNATURE';
    evaluation: 'NOT_RUN_AUTHENTICATION_HOLD';
    v71Tuning: 'HOLD';
    finalReleaseCandidate: 'PENDING_COMPOSITION';
    rigProvisioning: 'NOT_AUTHORIZED_BY_THIS_PAYLOAD';
    soak: 'NOT_AUTHORIZED_BY_THIS_PAYLOAD';
    spend: 'NOT_AUTHORIZED_BY_THIS_PAYLOAD';
  }>;
  readonly signingPolicy: Readonly<{
    signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
    signerIdentity: typeof SIGNER_IDENTITY;
    signingKeyId: string;
    publicKeyFingerprintSha256: string;
    authorizedOperator: string;
    activatedAtUtc: string;
  }>;
}

export interface S33HeldoutCorpusAuthenticationRequest {
  readonly schemaVersion: 1;
  readonly artifactType: 'arkova-s33-heldout-corpus-authentication-request';
  readonly signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
  readonly signerIdentity: typeof SIGNER_IDENTITY;
  readonly signingKeyId: string;
  readonly domainSeparator: typeof DOMAIN_SEPARATOR;
  readonly payload: S33HeldoutCorpusAuthenticationPayload;
  readonly payloadCanonicalJson: string;
  readonly payloadCanonicalSha256: string;
  readonly signingBytesBase64Url: string;
  readonly signingBytesSha256: string;
  readonly requestDigestSha256: string;
}

export interface S33HeldoutCorpusSignatureArtifact {
  readonly schemaVersion: 1;
  readonly artifactType: 'arkova-s33-heldout-corpus-authentication-signature';
  readonly status: 'SIGNED';
  readonly signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
  readonly signerIdentity: typeof SIGNER_IDENTITY;
  readonly signingKeyId: string;
  readonly publicKeyFingerprintSha256: string;
  readonly requestDigestSha256: string;
  readonly payloadCanonicalSha256: string;
  readonly signingBytesSha256: string;
  readonly signatureBase64Url: string;
  readonly artifactDigestSha256: string;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalDigest(value: unknown): string {
  return sha256(canonicaliseJson(value));
}

function gitBlobSha1(sourceText: string): string {
  const bytes = Buffer.from(sourceText, 'utf8');
  return createHash('sha1') // NOSONAR -- exact Git object identity, not a security primitive.
    .update(`blob ${bytes.byteLength}\0`, 'utf8')
    .update(bytes)
    .digest('hex');
}

function normalizeInput(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, ' ').trim();
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  }
  return value;
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(compareStrings);
  const wanted = [...expected].sort(compareStrings);
  if (canonicaliseJson(actual) !== canonicaliseJson(wanted)) {
    throw new Error(`${label} keys do not match the exact schema`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be non-empty`);
  return value;
}

function digest(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!SHA256.test(parsed)) throw new Error(`${label} must be a lowercase SHA-256`);
  return parsed;
}

function gitObject(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (!SHA1.test(parsed)) throw new Error(`${label} must be a full lowercase Git object id`);
  return parsed;
}

function safeCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function canonicalSetDigest(values: readonly string[]): string {
  return canonicalDigest([...new Set(values)].sort(compareStrings));
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate identities`);
}

function validateV71Identity(value: unknown, label: string): S33V71ExportIdentity {
  const identity = record(value, label);
  exactKeys(identity, ['id', 'normalizedInputSha256'], label);
  return {
    id: text(identity.id, `${label}.id`),
    normalizedInputSha256: digest(
      identity.normalizedInputSha256,
      `${label}.normalizedInputSha256`,
    ),
  };
}

function validateV71(value: unknown): S33V71ExportIdentityInput {
  const v71 = record(value, 'S3.3 v7.1 identity index');
  exactKeys(v71, [
    'sourceHeadSha', 'sourceTreeSha', 'sourceCount', 'retainedCount', 'trainCount',
    'validationCount', 'uniqueIdCount', 'uniqueNormalizedContentCount',
    'sourceOrderedIdsSha256', 'sourceContentCanonicalSha256',
    'retainedTargetsCanonicalSha256', 'trainJsonlSha256', 'validationJsonlSha256',
    'surgeryManifestCanonicalSha256', 'trainIdentityOrderSha256',
    'validationIdentityOrderSha256', 'combinedIdentitySetCanonicalSha256',
    'normalizedContentSetCanonicalSha256', 'train', 'validation',
  ], 'S3.3 v7.1 identity index');
  if (!Array.isArray(v71.train) || !Array.isArray(v71.validation)) {
    throw new Error('S3.3 v7.1 identity index train/validation must be arrays');
  }
  const train = v71.train.map((identity, index) => (
    validateV71Identity(identity, `S3.3 v7.1 train[${index}]`)
  ));
  const validation = v71.validation.map((identity, index) => (
    validateV71Identity(identity, `S3.3 v7.1 validation[${index}]`)
  ));
  const identities = [...train, ...validation];
  const ids = identities.map(({ id }) => id);
  const content = identities.map(({ normalizedInputSha256 }) => normalizedInputSha256);
  assertUnique(ids, 'S3.3 v7.1 train/validation ids');

  const parsed: S33V71ExportIdentityInput = {
    sourceHeadSha: gitObject(v71.sourceHeadSha, 'S3.3 v7.1 source head'),
    sourceTreeSha: gitObject(v71.sourceTreeSha, 'S3.3 v7.1 source tree'),
    sourceCount: safeCount(v71.sourceCount, 'S3.3 v7.1 source count'),
    retainedCount: safeCount(v71.retainedCount, 'S3.3 v7.1 retained count'),
    trainCount: safeCount(v71.trainCount, 'S3.3 v7.1 train count'),
    validationCount: safeCount(v71.validationCount, 'S3.3 v7.1 validation count'),
    uniqueIdCount: safeCount(v71.uniqueIdCount, 'S3.3 v7.1 unique id count'),
    uniqueNormalizedContentCount: safeCount(
      v71.uniqueNormalizedContentCount,
      'S3.3 v7.1 unique normalized-content count',
    ),
    sourceOrderedIdsSha256: digest(v71.sourceOrderedIdsSha256, 'S3.3 v7.1 source id digest'),
    sourceContentCanonicalSha256: digest(
      v71.sourceContentCanonicalSha256,
      'S3.3 v7.1 source content digest',
    ),
    retainedTargetsCanonicalSha256: digest(
      v71.retainedTargetsCanonicalSha256,
      'S3.3 v7.1 retained-target digest',
    ),
    trainJsonlSha256: digest(v71.trainJsonlSha256, 'S3.3 v7.1 train JSONL digest'),
    validationJsonlSha256: digest(
      v71.validationJsonlSha256,
      'S3.3 v7.1 validation JSONL digest',
    ),
    surgeryManifestCanonicalSha256: digest(
      v71.surgeryManifestCanonicalSha256,
      'S3.3 v7.1 surgery-manifest digest',
    ),
    trainIdentityOrderSha256: digest(
      v71.trainIdentityOrderSha256,
      'S3.3 v7.1 train identity-order digest',
    ),
    validationIdentityOrderSha256: digest(
      v71.validationIdentityOrderSha256,
      'S3.3 v7.1 validation identity-order digest',
    ),
    combinedIdentitySetCanonicalSha256: digest(
      v71.combinedIdentitySetCanonicalSha256,
      'S3.3 v7.1 combined identity-set digest',
    ),
    normalizedContentSetCanonicalSha256: digest(
      v71.normalizedContentSetCanonicalSha256,
      'S3.3 v7.1 normalized-content-set digest',
    ),
    train,
    validation,
  };
  if (parsed.sourceHeadSha !== V71_SOURCE_HEAD_SHA || parsed.sourceTreeSha !== V71_SOURCE_TREE_SHA
    || parsed.sourceCount !== 2656 || parsed.retainedCount !== 961
    || parsed.trainCount !== train.length || parsed.trainCount !== 865
    || parsed.validationCount !== validation.length || parsed.validationCount !== 96
    || parsed.uniqueIdCount !== ids.length || parsed.uniqueIdCount !== 961
    || parsed.uniqueNormalizedContentCount !== new Set(content).size
    || parsed.trainIdentityOrderSha256 !== canonicalDigest(train)
    || parsed.validationIdentityOrderSha256 !== canonicalDigest(validation)
    || parsed.combinedIdentitySetCanonicalSha256 !== canonicalSetDigest(ids)
    || parsed.normalizedContentSetCanonicalSha256 !== canonicalSetDigest(content)
    || parsed.uniqueNormalizedContentCount !== 878
    || (Object.keys(V71_FROZEN_DIGESTS) as Array<keyof typeof V71_FROZEN_DIGESTS>)
      .some((key) => parsed[key] !== V71_FROZEN_DIGESTS[key])) {
    throw new Error('S3.3 v7.1 identity count/digest/source binding drifted');
  }
  return deepFreeze(parsed);
}

function deriveHeldout(sourcesValue: readonly S33HeldoutSourceInput[]): S33HeldoutIdentitySet {
  if (sourcesValue.length !== SOURCES.length) throw new Error('S3.3 held-out source set is incomplete');
  const rows: S33CorpusIdentityRow[] = [];
  const sources = sourcesValue.map((source, sourceIndex) => {
    const expected = SOURCES[sourceIndex];
    if (source.path !== expected.path || source.exportName !== expected.exportName
      || source.expectedCount !== expected.expectedCount || source.blobSha !== expected.blobSha
      || source.rawSha256 !== expected.rawSha256 || sha256(source.sourceText) !== expected.rawSha256
      || gitBlobSha1(source.sourceText) !== expected.blobSha
      || source.rows.length !== expected.expectedCount) {
      throw new Error(`S3.3 held-out source binding drifted: ${expected.path}`);
    }
    const sourceRows = source.rows.map((candidate, rowIndex): S33CorpusIdentityRow => {
      const row = record(candidate, `S3.3 held-out ${source.path}[${rowIndex}]`);
      const id = text(row.id, `S3.3 held-out ${source.path}[${rowIndex}].id`);
      const strippedText = text(
        row.strippedText,
        `S3.3 held-out ${source.path}[${rowIndex}].strippedText`,
      );
      return {
        id,
        sourcePath: source.path,
        sourceIndex: rowIndex,
        corpusIndex: rows.length + rowIndex,
        normalizedInputSha256: sha256(normalizeInput(strippedText)),
        canonicalRowSha256: canonicalDigest(row),
      };
    });
    rows.push(...sourceRows);
    return {
      path: source.path,
      exportName: source.exportName,
      blobSha: source.blobSha,
      rawSha256: source.rawSha256,
      rowCount: sourceRows.length,
      rowOrderSha256: canonicalDigest(sourceRows.map(({ id }) => id)),
      canonicalRowsSha256: canonicalDigest(source.rows),
    };
  });
  const ids = rows.map(({ id }) => id);
  const content = rows.map(({ normalizedInputSha256 }) => normalizedInputSha256);
  assertUnique(ids, 'S3.3 held-out ids');
  assertUnique(content, 'S3.3 held-out normalized content');
  if (rows.length !== 621) throw new Error(`S3.3 held-out corpus expected 621 derived rows, got ${rows.length}`);
  return deepFreeze({
    count: rows.length,
    uniqueIdCount: new Set(ids).size,
    uniqueNormalizedContentCount: new Set(content).size,
    entryOrderSha256: canonicalDigest(ids),
    entrySetCanonicalSha256: canonicalSetDigest(ids),
    normalizedContentOrderSha256: canonicalDigest(content),
    normalizedContentSetCanonicalSha256: canonicalSetDigest(content),
    canonicalRowsOrderSha256: canonicalDigest(rows.map(({ canonicalRowSha256 }) => canonicalRowSha256)),
    sourceOrderSha256: canonicalDigest(sources),
    sources,
    rows,
  });
}

function overlapProof(
  heldout: S33HeldoutIdentitySet,
  v71: S33V71ExportIdentityInput,
): S33HeldoutCorpusIdentityIndex['overlap'] {
  const v71Identities = [...v71.train, ...v71.validation];
  const v71Ids = new Set(v71Identities.map(({ id }) => id));
  const v71Content = new Set(v71Identities.map(({ normalizedInputSha256 }) => normalizedInputSha256));
  const ids = [...new Set(heldout.rows.map(({ id }) => id).filter((id) => v71Ids.has(id)))]
    .sort(compareStrings);
  const content = [...new Set(heldout.rows
    .map(({ normalizedInputSha256 }) => normalizedInputSha256)
    .filter((hash) => v71Content.has(hash)))]
    .sort(compareStrings);
  if (ids.length !== 0 || content.length !== 0) {
    throw new Error('S3.3 held-out/v7.1 identity or content overlap is non-zero');
  }
  return deepFreeze({
    heldoutToV71IdCount: 0,
    heldoutToV71NormalizedContentCount: 0,
    heldoutToV71Ids: ids,
    heldoutToV71NormalizedContentSha256: content,
  });
}

function validateHeldout(value: unknown): S33HeldoutIdentitySet {
  const heldout = record(value, 'S3.3 held-out identity set');
  exactKeys(heldout, [
    'count', 'uniqueIdCount', 'uniqueNormalizedContentCount', 'entryOrderSha256',
    'entrySetCanonicalSha256', 'normalizedContentOrderSha256',
    'normalizedContentSetCanonicalSha256', 'canonicalRowsOrderSha256',
    'sourceOrderSha256', 'sources', 'rows',
  ], 'S3.3 held-out identity set');
  if (!Array.isArray(heldout.sources) || !Array.isArray(heldout.rows)) {
    throw new Error('S3.3 held-out identity sources/rows must be arrays');
  }
  const sources = heldout.sources.map((candidate, index) => {
    const source = record(candidate, `S3.3 held-out source[${index}]`);
    exactKeys(source, [
      'path', 'exportName', 'blobSha', 'rawSha256', 'rowCount',
      'rowOrderSha256', 'canonicalRowsSha256',
    ], `S3.3 held-out source[${index}]`);
    const expected = SOURCES[index];
    const parsed = {
      path: text(source.path, `S3.3 held-out source[${index}].path`),
      exportName: text(source.exportName, `S3.3 held-out source[${index}].exportName`),
      blobSha: gitObject(source.blobSha, `S3.3 held-out source[${index}].blobSha`),
      rawSha256: digest(source.rawSha256, `S3.3 held-out source[${index}].rawSha256`),
      rowCount: safeCount(source.rowCount, `S3.3 held-out source[${index}].rowCount`),
      rowOrderSha256: digest(
        source.rowOrderSha256,
        `S3.3 held-out source[${index}].rowOrderSha256`,
      ),
      canonicalRowsSha256: digest(
        source.canonicalRowsSha256,
        `S3.3 held-out source[${index}].canonicalRowsSha256`,
      ),
    };
    if (!expected || parsed.path !== expected.path || parsed.exportName !== expected.exportName
      || parsed.blobSha !== expected.blobSha || parsed.rawSha256 !== expected.rawSha256
      || parsed.rowCount !== expected.expectedCount) {
      throw new Error(`S3.3 held-out source[${index}] binding drifted`);
    }
    return parsed;
  });
  const rows = heldout.rows.map((candidate, index): S33CorpusIdentityRow => {
    const row = record(candidate, `S3.3 held-out identity row[${index}]`);
    exactKeys(row, [
      'id', 'sourcePath', 'sourceIndex', 'corpusIndex',
      'normalizedInputSha256', 'canonicalRowSha256',
    ], `S3.3 held-out identity row[${index}]`);
    return {
      id: text(row.id, `S3.3 held-out identity row[${index}].id`),
      sourcePath: text(row.sourcePath, `S3.3 held-out identity row[${index}].sourcePath`),
      sourceIndex: safeCount(row.sourceIndex, `S3.3 held-out identity row[${index}].sourceIndex`),
      corpusIndex: safeCount(row.corpusIndex, `S3.3 held-out identity row[${index}].corpusIndex`),
      normalizedInputSha256: digest(
        row.normalizedInputSha256,
        `S3.3 held-out identity row[${index}].normalizedInputSha256`,
      ),
      canonicalRowSha256: digest(
        row.canonicalRowSha256,
        `S3.3 held-out identity row[${index}].canonicalRowSha256`,
      ),
    };
  });
  const ids = rows.map(({ id }) => id);
  const content = rows.map(({ normalizedInputSha256 }) => normalizedInputSha256);
  const count = safeCount(heldout.count, 'S3.3 held-out count');
  const uniqueIdCount = safeCount(heldout.uniqueIdCount, 'S3.3 held-out unique id count');
  const uniqueNormalizedContentCount = safeCount(
    heldout.uniqueNormalizedContentCount,
    'S3.3 held-out unique normalized-content count',
  );
  assertUnique(ids, 'S3.3 held-out index ids');
  assertUnique(content, 'S3.3 held-out index normalized content');
  if (sources.length !== SOURCES.length || rows.length !== 621 || count !== rows.length
    || uniqueIdCount !== new Set(ids).size || uniqueIdCount !== 621
    || uniqueNormalizedContentCount !== new Set(content).size
    || uniqueNormalizedContentCount !== 621
    || rows.some((row, index) => row.corpusIndex !== index)
    || sources.reduce((total, source) => total + source.rowCount, 0) !== rows.length
    || digest(heldout.entryOrderSha256, 'S3.3 held-out entry-order digest') !== canonicalDigest(ids)
    || digest(heldout.entrySetCanonicalSha256, 'S3.3 held-out entry-set digest') !== canonicalSetDigest(ids)
    || digest(heldout.normalizedContentOrderSha256, 'S3.3 held-out content-order digest')
      !== canonicalDigest(content)
    || digest(heldout.normalizedContentSetCanonicalSha256, 'S3.3 held-out content-set digest')
      !== canonicalSetDigest(content)
    || digest(heldout.canonicalRowsOrderSha256, 'S3.3 held-out canonical-row digest')
      !== canonicalDigest(rows.map(({ canonicalRowSha256 }) => canonicalRowSha256))
    || digest(heldout.sourceOrderSha256, 'S3.3 held-out source-order digest')
      !== canonicalDigest(sources)) {
    throw new Error('S3.3 held-out count/order/set/content/source digest binding drifted');
  }
  let offset = 0;
  for (const source of sources) {
    const sourceRows = rows.slice(offset, offset + source.rowCount);
    if (sourceRows.some((row, index) => row.sourcePath !== source.path || row.sourceIndex !== index)
      || source.rowOrderSha256 !== canonicalDigest(sourceRows.map(({ id }) => id))) {
      throw new Error(`S3.3 held-out source row binding drifted: ${source.path}`);
    }
    offset += source.rowCount;
  }
  return deepFreeze({
    count,
    uniqueIdCount,
    uniqueNormalizedContentCount,
    entryOrderSha256: heldout.entryOrderSha256 as string,
    entrySetCanonicalSha256: heldout.entrySetCanonicalSha256 as string,
    normalizedContentOrderSha256: heldout.normalizedContentOrderSha256 as string,
    normalizedContentSetCanonicalSha256: heldout.normalizedContentSetCanonicalSha256 as string,
    canonicalRowsOrderSha256: heldout.canonicalRowsOrderSha256 as string,
    sourceOrderSha256: heldout.sourceOrderSha256 as string,
    sources,
    rows,
  });
}

export function validateS33HeldoutCorpusIdentityIndex(
  value: unknown,
): S33HeldoutCorpusIdentityIndex {
  const index = record(value, 'S3.3 held-out corpus identity index');
  exactKeys(index, [
    'schemaVersion', 'artifactType', 'repositoryIdentity', 'heldoutSourceHeadSha',
    'heldoutSourceTreeSha', 'strictRegistryDigestSha256', 'heldout', 'v71', 'overlap',
  ], 'S3.3 held-out corpus identity index');
  if (index.schemaVersion !== 1
    || index.artifactType !== 'arkova-s33-heldout-corpus-zero-overlap-index'
    || index.repositoryIdentity !== REPOSITORY_IDENTITY
    || index.heldoutSourceHeadSha !== HELDOUT_SOURCE_HEAD_SHA
    || index.heldoutSourceTreeSha !== HELDOUT_SOURCE_TREE_SHA
    || index.strictRegistryDigestSha256 !== CORPUS_REGISTRY_DIGEST_SHA256) {
    throw new Error('S3.3 held-out corpus identity index authority/source binding drifted');
  }
  const heldout = validateHeldout(index.heldout);
  const v71 = validateV71(index.v71);
  const overlap = record(index.overlap, 'S3.3 held-out/v7.1 overlap proof');
  exactKeys(overlap, [
    'heldoutToV71IdCount', 'heldoutToV71NormalizedContentCount',
    'heldoutToV71Ids', 'heldoutToV71NormalizedContentSha256',
  ], 'S3.3 held-out/v7.1 overlap proof');
  const expectedOverlap = overlapProof(heldout, v71);
  if (canonicaliseJson(overlap) !== canonicaliseJson(expectedOverlap)) {
    throw new Error('S3.3 held-out/v7.1 overlap proof binding drifted');
  }
  return deepFreeze({
    schemaVersion: 1,
    artifactType: 'arkova-s33-heldout-corpus-zero-overlap-index',
    repositoryIdentity: REPOSITORY_IDENTITY,
    heldoutSourceHeadSha: HELDOUT_SOURCE_HEAD_SHA,
    heldoutSourceTreeSha: HELDOUT_SOURCE_TREE_SHA,
    strictRegistryDigestSha256: CORPUS_REGISTRY_DIGEST_SHA256,
    heldout,
    v71,
    overlap: expectedOverlap,
  });
}

function buildPayload(index: S33HeldoutCorpusIdentityIndex): S33HeldoutCorpusAuthenticationPayload {
  const authority = getS33DetachedSigningAuthorityV2();
  return deepFreeze({
    schemaVersion: 1,
    artifactType: 'arkova-s33-heldout-corpus-authentication-payload',
    verdict: 'AUTHENTICATE_EXACT_HELDOUT_CORPUS',
    authorityScope: 'CORPUS_ONLY_NO_RC_NO_SOAK_NO_SPEND',
    repositoryIdentity: REPOSITORY_IDENTITY,
    sourceBindings: {
      heldoutHeadSha: HELDOUT_SOURCE_HEAD_SHA,
      heldoutTreeSha: HELDOUT_SOURCE_TREE_SHA,
      v71HeadSha: V71_SOURCE_HEAD_SHA,
      v71TreeSha: V71_SOURCE_TREE_SHA,
      finalReleaseCandidate: {
        status: 'PENDING_COMPOSITION',
        headSha: null,
        treeSha: null,
      },
      heldoutSchema: S33_HELDOUT_CORPUS_AUTHENTICATION_CONSTANTS.heldoutSchema,
      coverageRegistry: S33_HELDOUT_CORPUS_AUTHENTICATION_CONSTANTS.coverageRegistry,
    },
    corpus: {
      count: 621,
      uniqueIdCount: 621,
      uniqueNormalizedContentCount: 621,
      strictRegistryDigestSha256: CORPUS_REGISTRY_DIGEST_SHA256,
      identityIndexCanonicalSha256: canonicalDigest(index),
      entryOrderSha256: index.heldout.entryOrderSha256,
      entrySetCanonicalSha256: index.heldout.entrySetCanonicalSha256,
      canonicalRowsOrderSha256: index.heldout.canonicalRowsOrderSha256,
    },
    v71: {
      trainCount: 865,
      validationCount: 96,
      uniqueIdCount: 961,
      sourceOrderedIdsSha256: index.v71.sourceOrderedIdsSha256,
      sourceContentCanonicalSha256: index.v71.sourceContentCanonicalSha256,
      retainedTargetsCanonicalSha256: index.v71.retainedTargetsCanonicalSha256,
      trainJsonlSha256: index.v71.trainJsonlSha256,
      validationJsonlSha256: index.v71.validationJsonlSha256,
      surgeryManifestCanonicalSha256: index.v71.surgeryManifestCanonicalSha256,
    },
    zeroOverlap: {
      identityAlgorithm: 'exact-entry-id-set-v1',
      contentAlgorithm: 'lowercase-collapse-whitespace-sha256-v1',
      heldoutToV71IdCount: 0,
      heldoutToV71NormalizedContentCount: 0,
    },
    executionState: {
      corpusAuthentication: 'VALID_ONLY_WITH_MATCHING_DETACHED_SIGNATURE',
      evaluation: 'NOT_RUN_AUTHENTICATION_HOLD',
      v71Tuning: 'HOLD',
      finalReleaseCandidate: 'PENDING_COMPOSITION',
      rigProvisioning: 'NOT_AUTHORIZED_BY_THIS_PAYLOAD',
      soak: 'NOT_AUTHORIZED_BY_THIS_PAYLOAD',
      spend: 'NOT_AUTHORIZED_BY_THIS_PAYLOAD',
    },
    signingPolicy: {
      signatureAlgorithm: SIGNATURE_ALGORITHM,
      signerIdentity: authority.signerIdentity,
      signingKeyId: authority.signingKeyId,
      publicKeyFingerprintSha256: authority.publicKeyFingerprintSha256,
      authorizedOperator: authority.authorizedOperator,
      activatedAtUtc: authority.activatedAtUtc,
    },
  });
}

function requestWithoutDigest(
  request: Omit<S33HeldoutCorpusAuthenticationRequest, 'requestDigestSha256'>,
): Omit<S33HeldoutCorpusAuthenticationRequest, 'requestDigestSha256'> {
  return request;
}

function buildRequest(
  payload: S33HeldoutCorpusAuthenticationPayload,
): S33HeldoutCorpusAuthenticationRequest {
  const payloadCanonicalJson = canonicaliseJson(payload);
  const signingBytes = Buffer.from(`${DOMAIN_SEPARATOR}${payloadCanonicalJson}`, 'utf8');
  const withoutDigest = requestWithoutDigest({
    schemaVersion: 1,
    artifactType: 'arkova-s33-heldout-corpus-authentication-request',
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    signerIdentity: SIGNER_IDENTITY,
    signingKeyId: payload.signingPolicy.signingKeyId,
    domainSeparator: DOMAIN_SEPARATOR,
    payload,
    payloadCanonicalJson,
    payloadCanonicalSha256: sha256(payloadCanonicalJson),
    signingBytesBase64Url: signingBytes.toString('base64url'),
    signingBytesSha256: sha256(signingBytes),
  });
  return deepFreeze({ ...withoutDigest, requestDigestSha256: canonicalDigest(withoutDigest) });
}

export function buildS33HeldoutCorpusAuthentication(input: Readonly<{
  sources: readonly S33HeldoutSourceInput[];
  v71: S33V71ExportIdentityInput;
}>): Readonly<{
  identityIndex: S33HeldoutCorpusIdentityIndex;
  request: S33HeldoutCorpusAuthenticationRequest;
}> {
  const heldout = deriveHeldout(input.sources);
  const v71 = validateV71(input.v71);
  const identityIndex = validateS33HeldoutCorpusIdentityIndex({
    schemaVersion: 1,
    artifactType: 'arkova-s33-heldout-corpus-zero-overlap-index',
    repositoryIdentity: REPOSITORY_IDENTITY,
    heldoutSourceHeadSha: HELDOUT_SOURCE_HEAD_SHA,
    heldoutSourceTreeSha: HELDOUT_SOURCE_TREE_SHA,
    strictRegistryDigestSha256: CORPUS_REGISTRY_DIGEST_SHA256,
    heldout,
    v71,
    overlap: overlapProof(heldout, v71),
  });
  return deepFreeze({ identityIndex, request: buildRequest(buildPayload(identityIndex)) });
}

function validatePayload(value: unknown): S33HeldoutCorpusAuthenticationPayload {
  const payload = record(value, 'S3.3 corpus-authentication payload');
  exactKeys(payload, [
    'schemaVersion', 'artifactType', 'verdict', 'authorityScope', 'repositoryIdentity',
    'sourceBindings', 'corpus', 'v71', 'zeroOverlap', 'executionState', 'signingPolicy',
  ], 'S3.3 corpus-authentication payload');
  const expectedIdentity = {
    schemaVersion: 1,
    artifactType: 'arkova-s33-heldout-corpus-authentication-payload',
    verdict: 'AUTHENTICATE_EXACT_HELDOUT_CORPUS',
    authorityScope: 'CORPUS_ONLY_NO_RC_NO_SOAK_NO_SPEND',
    repositoryIdentity: REPOSITORY_IDENTITY,
  };
  for (const [key, expected] of Object.entries(expectedIdentity)) {
    if (payload[key] !== expected) throw new Error(`S3.3 corpus payload ${key} binding drifted`);
  }
  const authority = getS33DetachedSigningAuthorityV2();
  const signingPolicy = record(payload.signingPolicy, 'S3.3 corpus signing policy');
  if (signingPolicy.signatureAlgorithm !== SIGNATURE_ALGORITHM
    || signingPolicy.signerIdentity !== SIGNER_IDENTITY
    || signingPolicy.signingKeyId !== authority.signingKeyId
    || signingPolicy.publicKeyFingerprintSha256 !== authority.publicKeyFingerprintSha256
    || signingPolicy.authorizedOperator !== authority.authorizedOperator
    || signingPolicy.activatedAtUtc !== authority.activatedAtUtc) {
    throw new Error('S3.3 corpus payload signing-policy binding drifted');
  }
  const sourceBindings = record(payload.sourceBindings, 'S3.3 corpus source bindings');
  const finalRc = record(sourceBindings.finalReleaseCandidate, 'S3.3 corpus final RC binding');
  exactKeys(sourceBindings, [
    'heldoutHeadSha', 'heldoutTreeSha', 'v71HeadSha', 'v71TreeSha',
    'finalReleaseCandidate', 'heldoutSchema', 'coverageRegistry',
  ], 'S3.3 corpus source bindings');
  exactKeys(finalRc, ['status', 'headSha', 'treeSha'], 'S3.3 corpus final RC binding');
  if (canonicaliseJson(sourceBindings.heldoutSchema)
      !== canonicaliseJson(S33_HELDOUT_CORPUS_AUTHENTICATION_CONSTANTS.heldoutSchema)
    || canonicaliseJson(sourceBindings.coverageRegistry)
      !== canonicaliseJson(S33_HELDOUT_CORPUS_AUTHENTICATION_CONSTANTS.coverageRegistry)) {
    throw new Error('S3.3 corpus schema/coverage-registry binding drifted');
  }
  if (sourceBindings.heldoutHeadSha !== HELDOUT_SOURCE_HEAD_SHA
    || sourceBindings.heldoutTreeSha !== HELDOUT_SOURCE_TREE_SHA
    || sourceBindings.v71HeadSha !== V71_SOURCE_HEAD_SHA
    || sourceBindings.v71TreeSha !== V71_SOURCE_TREE_SHA
    || finalRc.status !== 'PENDING_COMPOSITION' || finalRc.headSha !== null || finalRc.treeSha !== null) {
    throw new Error('S3.3 corpus source/final-RC binding drifted');
  }
  const corpus = record(payload.corpus, 'S3.3 corpus payload corpus facts');
  const v71 = record(payload.v71, 'S3.3 corpus payload v7.1 facts');
  const zeroOverlap = record(payload.zeroOverlap, 'S3.3 corpus payload zero-overlap facts');
  const execution = record(payload.executionState, 'S3.3 corpus payload execution state');
  exactKeys(corpus, [
    'count', 'uniqueIdCount', 'uniqueNormalizedContentCount',
    'strictRegistryDigestSha256', 'identityIndexCanonicalSha256',
    'entryOrderSha256', 'entrySetCanonicalSha256', 'canonicalRowsOrderSha256',
  ], 'S3.3 corpus payload corpus facts');
  exactKeys(v71, [
    'trainCount', 'validationCount', 'uniqueIdCount', 'sourceOrderedIdsSha256',
    'sourceContentCanonicalSha256', 'retainedTargetsCanonicalSha256',
    'trainJsonlSha256', 'validationJsonlSha256', 'surgeryManifestCanonicalSha256',
  ], 'S3.3 corpus payload v7.1 facts');
  exactKeys(zeroOverlap, [
    'identityAlgorithm', 'contentAlgorithm', 'heldoutToV71IdCount',
    'heldoutToV71NormalizedContentCount',
  ], 'S3.3 corpus payload zero-overlap facts');
  exactKeys(execution, [
    'corpusAuthentication', 'evaluation', 'v71Tuning', 'finalReleaseCandidate',
    'rigProvisioning', 'soak', 'spend',
  ], 'S3.3 corpus payload execution state');
  exactKeys(signingPolicy, [
    'signatureAlgorithm', 'signerIdentity', 'signingKeyId',
    'publicKeyFingerprintSha256', 'authorizedOperator', 'activatedAtUtc',
  ], 'S3.3 corpus signing policy');
  if (corpus.count !== 621 || corpus.uniqueIdCount !== 621
    || corpus.uniqueNormalizedContentCount !== 621
    || corpus.strictRegistryDigestSha256 !== CORPUS_REGISTRY_DIGEST_SHA256
    || v71.trainCount !== 865 || v71.validationCount !== 96 || v71.uniqueIdCount !== 961
    || zeroOverlap.heldoutToV71IdCount !== 0
    || zeroOverlap.heldoutToV71NormalizedContentCount !== 0
    || execution.evaluation !== 'NOT_RUN_AUTHENTICATION_HOLD'
    || execution.v71Tuning !== 'HOLD'
    || execution.finalReleaseCandidate !== 'PENDING_COMPOSITION'
    || execution.rigProvisioning !== 'NOT_AUTHORIZED_BY_THIS_PAYLOAD'
    || execution.soak !== 'NOT_AUTHORIZED_BY_THIS_PAYLOAD'
    || execution.spend !== 'NOT_AUTHORIZED_BY_THIS_PAYLOAD') {
    throw new Error('S3.3 corpus payload count/overlap/HOLD binding drifted');
  }
  for (const [label, value] of [
    ['identity index', corpus.identityIndexCanonicalSha256],
    ['entry order', corpus.entryOrderSha256],
    ['entry set', corpus.entrySetCanonicalSha256],
    ['canonical rows', corpus.canonicalRowsOrderSha256],
    ['v7.1 source ids', v71.sourceOrderedIdsSha256],
    ['v7.1 source content', v71.sourceContentCanonicalSha256],
    ['v7.1 retained targets', v71.retainedTargetsCanonicalSha256],
    ['v7.1 train JSONL', v71.trainJsonlSha256],
    ['v7.1 validation JSONL', v71.validationJsonlSha256],
    ['v7.1 surgery manifest', v71.surgeryManifestCanonicalSha256],
  ] as const) digest(value, `S3.3 corpus payload ${label} digest`);
  return deepFreeze(payload as unknown as S33HeldoutCorpusAuthenticationPayload);
}

export function validateS33HeldoutCorpusAuthenticationRequest(
  value: unknown,
): S33HeldoutCorpusAuthenticationRequest {
  const request = record(value, 'S3.3 corpus-authentication request');
  exactKeys(request, [
    'schemaVersion', 'artifactType', 'signatureAlgorithm', 'signerIdentity',
    'signingKeyId', 'domainSeparator', 'payload', 'payloadCanonicalJson',
    'payloadCanonicalSha256', 'signingBytesBase64Url', 'signingBytesSha256',
    'requestDigestSha256',
  ], 'S3.3 corpus-authentication request');
  if (request.schemaVersion !== 1
    || request.artifactType !== 'arkova-s33-heldout-corpus-authentication-request'
    || request.signatureAlgorithm !== SIGNATURE_ALGORITHM
    || request.signerIdentity !== SIGNER_IDENTITY
    || request.domainSeparator !== DOMAIN_SEPARATOR) {
    throw new Error('S3.3 corpus-authentication request identity binding drifted');
  }
  const payload = validatePayload(request.payload);
  const authority = getS33DetachedSigningAuthorityV2();
  if (request.signingKeyId !== authority.signingKeyId
    || payload.signingPolicy.signingKeyId !== authority.signingKeyId) {
    throw new Error('S3.3 corpus-authentication request key binding drifted');
  }
  const payloadCanonicalJson = text(
    request.payloadCanonicalJson,
    'S3.3 corpus-authentication canonical payload',
  );
  if (payloadCanonicalJson !== canonicaliseJson(payload)
    || digest(request.payloadCanonicalSha256, 'S3.3 corpus payload digest')
      !== sha256(payloadCanonicalJson)) {
    throw new Error('S3.3 corpus-authentication canonical payload digest drifted');
  }
  const signingBytes = Buffer.from(`${DOMAIN_SEPARATOR}${payloadCanonicalJson}`, 'utf8');
  const signingBytesBase64Url = text(
    request.signingBytesBase64Url,
    'S3.3 corpus-authentication signing bytes',
  );
  if (Buffer.from(signingBytesBase64Url, 'base64url').toString('base64url') !== signingBytesBase64Url
    || !Buffer.from(signingBytesBase64Url, 'base64url').equals(signingBytes)
    || digest(request.signingBytesSha256, 'S3.3 corpus signing-bytes digest') !== sha256(signingBytes)) {
    throw new Error('S3.3 corpus-authentication signing bytes drifted');
  }
  const withoutDigest = requestWithoutDigest({
    schemaVersion: 1,
    artifactType: 'arkova-s33-heldout-corpus-authentication-request',
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    signerIdentity: SIGNER_IDENTITY,
    signingKeyId: authority.signingKeyId,
    domainSeparator: DOMAIN_SEPARATOR,
    payload,
    payloadCanonicalJson,
    payloadCanonicalSha256: request.payloadCanonicalSha256 as string,
    signingBytesBase64Url,
    signingBytesSha256: request.signingBytesSha256 as string,
  });
  const requestDigestSha256 = digest(
    request.requestDigestSha256,
    'S3.3 corpus-authentication request digest',
  );
  if (requestDigestSha256 !== canonicalDigest(withoutDigest)) {
    throw new Error('S3.3 corpus-authentication request digest drifted');
  }
  return deepFreeze({ ...withoutDigest, requestDigestSha256 });
}

function signatureWithoutDigest(
  artifact: Omit<S33HeldoutCorpusSignatureArtifact, 'artifactDigestSha256'>,
): Omit<S33HeldoutCorpusSignatureArtifact, 'artifactDigestSha256'> {
  return artifact;
}

export function validateS33HeldoutCorpusSignatureArtifact(
  value: unknown,
): S33HeldoutCorpusSignatureArtifact {
  const artifact = record(value, 'S3.3 corpus-authentication signature artifact');
  exactKeys(artifact, [
    'schemaVersion', 'artifactType', 'status', 'signatureAlgorithm', 'signerIdentity',
    'signingKeyId', 'publicKeyFingerprintSha256', 'requestDigestSha256',
    'payloadCanonicalSha256', 'signingBytesSha256', 'signatureBase64Url',
    'artifactDigestSha256',
  ], 'S3.3 corpus-authentication signature artifact');
  const authority = getS33DetachedSigningAuthorityV2();
  if (artifact.schemaVersion !== 1
    || artifact.artifactType !== 'arkova-s33-heldout-corpus-authentication-signature'
    || artifact.status !== 'SIGNED'
    || artifact.signatureAlgorithm !== SIGNATURE_ALGORITHM
    || artifact.signerIdentity !== SIGNER_IDENTITY
    || artifact.signingKeyId !== authority.signingKeyId
    || artifact.publicKeyFingerprintSha256 !== authority.publicKeyFingerprintSha256) {
    throw new Error('S3.3 corpus-authentication signature authority binding drifted');
  }
  const signatureBase64Url = text(
    artifact.signatureBase64Url,
    'S3.3 corpus-authentication signature',
  );
  if (!BASE64URL_SIGNATURE.test(signatureBase64Url)
    || Buffer.from(signatureBase64Url, 'base64url').length !== 64
    || Buffer.from(signatureBase64Url, 'base64url').toString('base64url') !== signatureBase64Url) {
    throw new Error('S3.3 corpus-authentication signature is not canonical 64-byte Ed25519');
  }
  const withoutDigest = signatureWithoutDigest({
    schemaVersion: 1,
    artifactType: 'arkova-s33-heldout-corpus-authentication-signature',
    status: 'SIGNED',
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    signerIdentity: SIGNER_IDENTITY,
    signingKeyId: authority.signingKeyId,
    publicKeyFingerprintSha256: authority.publicKeyFingerprintSha256,
    requestDigestSha256: digest(artifact.requestDigestSha256, 'S3.3 signature request digest'),
    payloadCanonicalSha256: digest(artifact.payloadCanonicalSha256, 'S3.3 signature payload digest'),
    signingBytesSha256: digest(artifact.signingBytesSha256, 'S3.3 signature bytes digest'),
    signatureBase64Url,
  });
  const artifactDigestSha256 = digest(
    artifact.artifactDigestSha256,
    'S3.3 signature artifact digest',
  );
  if (artifactDigestSha256 !== canonicalDigest(withoutDigest)) {
    throw new Error('S3.3 corpus-authentication signature artifact digest drifted');
  }
  return deepFreeze({ ...withoutDigest, artifactDigestSha256 });
}

export function verifyS33HeldoutCorpusSignature(
  requestValue: unknown,
  artifactValue: unknown,
): S33HeldoutCorpusSignatureArtifact {
  const request = validateS33HeldoutCorpusAuthenticationRequest(requestValue);
  const artifact = validateS33HeldoutCorpusSignatureArtifact(artifactValue);
  if (artifact.requestDigestSha256 !== request.requestDigestSha256
    || artifact.payloadCanonicalSha256 !== request.payloadCanonicalSha256
    || artifact.signingBytesSha256 !== request.signingBytesSha256) {
    throw new Error('S3.3 corpus-authentication signature/request binding drifted');
  }
  const policy = S33_DETACHED_SIGNING_TRUST_POLICY_V2;
  if (policy.state !== 'ACTIVE' || policy.publicKeySpkiPem === null
    || policy.publicKeyFingerprintSha256 !== artifact.publicKeyFingerprintSha256) {
    throw new Error('S3.3 corpus-authentication public trust policy is not ACTIVE/exact');
  }
  const publicKey = createPublicKey(policy.publicKeySpkiPem);
  if (publicKey.asymmetricKeyType !== 'ed25519'
    || sha256(publicKey.export({ type: 'spki', format: 'der' }))
      !== policy.publicKeyFingerprintSha256) {
    throw new Error('S3.3 corpus-authentication public key/fingerprint binding drifted');
  }
  if (!verifyEd25519(
    null,
    Buffer.from(request.signingBytesBase64Url, 'base64url'),
    publicKey,
    Buffer.from(artifact.signatureBase64Url, 'base64url'),
  )) {
    throw new Error('S3.3 held-out corpus detached Ed25519 signature is invalid');
  }
  return artifact;
}

export function buildS33HeldoutCorpusSignatureArtifact(
  requestValue: unknown,
  signatureBase64UrlValue: string,
): S33HeldoutCorpusSignatureArtifact {
  const request = validateS33HeldoutCorpusAuthenticationRequest(requestValue);
  const authority = getS33DetachedSigningAuthorityV2();
  const withoutDigest = signatureWithoutDigest({
    schemaVersion: 1,
    artifactType: 'arkova-s33-heldout-corpus-authentication-signature',
    status: 'SIGNED',
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    signerIdentity: SIGNER_IDENTITY,
    signingKeyId: authority.signingKeyId,
    publicKeyFingerprintSha256: authority.publicKeyFingerprintSha256,
    requestDigestSha256: request.requestDigestSha256,
    payloadCanonicalSha256: request.payloadCanonicalSha256,
    signingBytesSha256: request.signingBytesSha256,
    signatureBase64Url: signatureBase64UrlValue,
  });
  const candidate = validateS33HeldoutCorpusSignatureArtifact({
    ...withoutDigest,
    artifactDigestSha256: canonicalDigest(withoutDigest),
  });
  return verifyS33HeldoutCorpusSignature(request, candidate);
}

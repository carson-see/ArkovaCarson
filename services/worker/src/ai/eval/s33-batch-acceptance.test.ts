import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicaliseJson } from '../../utils/canonical-json.js';
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionPrompt } from '../prompts/extraction.js';
import * as acceptanceModule from './s33-batch-acceptance.js';
import * as ledgerModule from './s33-acceptance-ledger.js';
// @ts-expect-error — the audit transcript state machine must remain module-private.
type _ForbiddenDirectLedgerImport = import('./s33-acceptance-ledger.js').DurableAcceptanceLedger;
import {
  canonicalManifestHash,
  compareEmbeddingLeakage,
  createTestOnlyS33Wave1AcceptanceArtifact,
  createS33Wave1AcceptanceArtifactFromAuthenticatedEvidence,
  createProductionS33AcceptanceOrchestrator,
  createTestOnlyS33AcceptanceOrchestrator,
  parseBatchManifest,
  rawManifestHash,
  S33_WAVE1_REVISION10_PRODUCTION_PINS,
  S33_WAVE1_REVISION11_PRODUCTION_PINS,
  scanEmbeddingLeakage,
  type EmbeddingBatchProvider,
  type ConsumptionRegistryRecord,
  type LexicalLeakagePolicyPayload,
  type ManifestFreezePayload,
  type SaltCommitmentPayload,
  type SaltRevealRecord,
  type SelectionPolicyPayload,
  type SignedPolicyArtifact,
  type SamplingTrustRoot,
  type TestOnlyS33Wave1AcceptanceArtifactInput,
  type S33AcceptanceOrchestrator,
  type Wave1Revision10Pins,
  type Wave1Revision11Pins,
} from './s33-batch-acceptance.js';

// @ts-expect-error — callers cannot advance chronology with an arbitrary event.
type _ForbiddenOrchestratorAppend = S33AcceptanceOrchestrator['append'];

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

interface ProductionManifestFixtureEntry {
  id: string;
  domain: 'au-ke-priority-documents' | 'professional-licensing' | 'out-of-distribution';
  credentialType: string;
  normalizedInputSha256: string;
}

const WAVE1_MANIFEST_PATH = 'docs/lane4/s33-wave1-batch-manifest.json';
const WAVE1_CORPUS_DATASHEET_PATH = 'docs/lane4/s33-corpus-datasheet.md';
const WAVE1_TYPES_PATH = 'services/worker/src/ai/eval/golden-dataset-s33-types.ts';
const WAVE1_SOURCE_PATHS = [
  'services/worker/src/ai/eval/golden-dataset-s33-licensing-heldout.ts',
  'services/worker/src/ai/eval/golden-dataset-s33-au-ke-heldout.ts',
  'services/worker/src/ai/eval/golden-dataset-s33-ood-negatives.ts',
] as const;
const WAVE1_PACKET_PATHS = [
  'docs/lane4/s33-corpus-datasheet.md',
  WAVE1_MANIFEST_PATH,
  'docs/lane4/s33-wave1-entry-datasheet.json',
  'services/worker/src/ai/eval/golden-dataset-s33-au-ke-heldout.ts',
  'services/worker/src/ai/eval/golden-dataset-s33-licensing-heldout.ts',
  'services/worker/src/ai/eval/golden-dataset-s33-ood-negatives.ts',
] as const;
const WAVE1_INITIAL_LANE3_SUPPORT_COMMIT = 'dd3ae1edecb005730762277daf17e15d8009459d';
const WAVE1_TEST_SUPPORT_MARKER_PATH = 'services/worker/src/ai/eval/.s33-r10-test-support';
const WAVE1_REVISION9_COMMIT = 'b9bb1d3221d3567dbb08e1b23cab4dd687486738';
const WAVE1_REVISION9_PREDECESSOR_COMMIT = '506ff62340db8f838ce68bc46ddfa6407735ce3c';
const WAVE1_REVISION10_COMMIT = '1018e36844834537df29fb60eb871cb54475bc14';
const WAVE1_REVISION10_SUPPORT_COMMIT = 'ee7bba26fc0e34a7a58bb684f45e4e3c4e6b2977';
const WAVE1_R10_SUPPORT_REVIEW_STATE = 'LANE3_TOOLING_EXACT_HEAD_REVIEW_PASS';
const WAVE1_REVISION9_ENTRIES_SHA256 = '591b4f4b37e188f1ad7286f8bc2a7a6b407eb89674ed6321e898123c347800c0';
const WAVE1_REVISION9_NORMALIZED_PINS_SHA256 = '8b4af182dcc161a041a8d933ec5d7277f2131f32cc6709ad75a2cd5acde2e7e2';
const WAVE1_REVISION9_ENTRY_ROWS_SHA256 = '37f0e9d32b9f25422c93aeec985a624b2840deab3f33e7a453c14531591befdf';
const WAVE1_REVISION9_SOURCE_BLOBS = {
  [WAVE1_SOURCE_PATHS[0]]: '4ac117c1663c6aefb63c7715440744af0e0b6a23',
  [WAVE1_SOURCE_PATHS[1]]: '5000824f2bd4dd7ac9cd58243daeb7ba23c4c0cd',
  [WAVE1_SOURCE_PATHS[2]]: 'a261cf690c930040f7dee0361ed29d73d1d23426',
} as const;

interface ManifestFixtureBindings {
  supportCommit: string;
  supportTypesBlob: string;
  predecessorCommit: string;
  sourceBlobs: Record<(typeof WAVE1_SOURCE_PATHS)[number], string>;
}

const CORPUS_SLICE_BY_DOMAIN = {
  'au-ke-priority-documents': 's33-au-ke-heldout',
  'professional-licensing': 's33-licensing-heldout',
  'out-of-distribution': 's33-ood-negative',
} as const;

const REVIEWED_WAVE1_DEFAULT_CREDENTIAL_TYPE = {
  KE: 'LICENSE',
  NUR: 'CERTIFICATE',
  CPA: 'CPE',
  BAR: 'CLE',
  PDH: 'CERTIFICATE',
  AU: 'LICENSE',
  OOD: 'OTHER',
} as const;

const REVIEWED_WAVE1_CREDENTIAL_TYPE_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  'GD-S33-KE-006': 'IDENTITY',
  'GD-S33-KE-007': 'ATTESTATION',
  'GD-S33-KE-008': 'BUSINESS_ENTITY',
  'GD-S33-KE-009': 'ATTESTATION',
  'GD-S33-KE-010': 'CERTIFICATE',
  'GD-S33-KE-011': 'DEGREE',
  'GD-S33-NUR-006': 'LICENSE',
  'GD-S33-CPA-006': 'LICENSE',
  'GD-S33-CPA-012': 'LICENSE',
  'GD-S33-BAR-006': 'LICENSE',
  'GD-S33-BAR-009': 'ATTESTATION',
  'GD-S33-PDH-002': 'LICENSE',
  'GD-S33-PDH-009': 'LICENSE',
  'GD-S33-AU-006': 'DEGREE',
  'GD-S33-AU-007': 'TRANSCRIPT',
  'GD-S33-AU-008': 'CERTIFICATE',
  'GD-S33-AU-009': 'CERTIFICATE',
  'GD-S33-AU-010': 'FINANCIAL',
  'GD-S33-AU-011': 'BUSINESS_ENTITY',
});

// Immutable reviewed r9/r10 entry pins; revision 11 preserves the same entry
// and normalized-input digests. Keeping these bytes hermetic catches seams
// between synthetic test taxonomy and the production pin descriptor.
const REVIEWED_WAVE1_NORMALIZED_INPUT_BY_ID: Readonly<Record<string, string>> = Object.freeze({
  'GD-S33-KE-001': '645c1f9a06b0458839e100425052c1b80a972d0bd5d9a3461283c389d3907593',
  'GD-S33-KE-002': 'a4d0c194fb80a7e94a21525bcc87eb5dd556c7aadb5eb72a02b14c6686cfee23',
  'GD-S33-KE-003': '84f0671c2bf9eddaef054c8bebc03c7ad901ca40a17c7f237f36e7486bb7c608',
  'GD-S33-KE-004': '9c564704c5e644d2b5fdb051ee5495fe4ce038e984bc1daae65c85ddcfd53e49',
  'GD-S33-KE-005': '11c1773fe4c613ae0c336bf18025a67008f888712d9e349df0c61004618ce6fc',
  'GD-S33-KE-006': 'f50ef6d1447459ca54c6a1348884cdc3e326763ba066084031bd99ccaa305727',
  'GD-S33-KE-007': '12081c016ac59b171a02d30f51ac2924a626eb3bdccbb8c5d14821d89eb35bbb',
  'GD-S33-KE-008': 'c12e5e797269a62d94bff341e6cf2c0217aa35a1798903e1076cf0886ed71f2b',
  'GD-S33-KE-009': '6ca53d0a7bf19e9ba69f2c7380b6bd48cda0355784ce23b8f26afd8ca01b2d90',
  'GD-S33-KE-010': 'ce82032fb54edbd163f67cab7f94b03f5a17a39ab511822d361765fe1b8a17f6',
  'GD-S33-KE-011': '9e5ed6796a770da6da5c6886fbdc55bb4814c759a18ff88d4115ab09dc9365c3',
  'GD-S33-NUR-001': 'c28f61da8430d4572e88e343b107bf7d96b0ba025729d3e2ca2929a00f8aecf5',
  'GD-S33-NUR-002': 'd85e24c90fe0e21e9c1afcc553a7632a8b0a74acf099749d7cc551cd6c5e38db',
  'GD-S33-NUR-003': 'd5e0743d93a38c05bb4919efa45933e81be16c332e6d514793e28e8b3eeb035f',
  'GD-S33-NUR-004': '5cf701df727878e681e156e1c2f2cc1f8ad9df124e7668c6843e33eab806bc0d',
  'GD-S33-NUR-005': '68085d32defe764e6a6462a936c8493844e8c4213ff27943a51ff7026d0c90b9',
  'GD-S33-NUR-006': 'a45859a89c9d176f1f441619f520ea1c3c37fa3895fe849c0334a220207b8149',
  'GD-S33-NUR-007': '59023621de09b65b4cc85e4cc890664190e87381aef1e8b8bce18707cf45458a',
  'GD-S33-NUR-008': '5bb1f67abc5a3c1eb5bff93223cf8cafb152c76e06ea323b3fce0549fc5b5d1a',
  'GD-S33-NUR-009': '751fd5db1bf2723c794d20f11aa73ac5a35b026111ee6966dc34a8c92a0deced',
  'GD-S33-NUR-010': '569a500f8900723e8f5ffd3f2818cafd3ab88d16d6b27e9a91b86ace6c03f491',
  'GD-S33-NUR-011': 'dc5ed8e9a44e6eba3a224018dc146de6de5ba79ecc473e60c10fdc3bbb3298a4',
  'GD-S33-NUR-012': '343c6d243c1c47bb742beb8655124920504d0daadf2174f139e32b048856a159',
  'GD-S33-CPA-001': '9be94967199b447cc8905cb4c0345d06a7623dfadb2c58c093a0926e0e46d5d5',
  'GD-S33-CPA-002': '95b8319b327ab84270892de8f0623571cf19032cf6025bc6860d54eb12cbd95a',
  'GD-S33-CPA-003': '823e0dbd9dfd9ccc13f7a5a5e4807e992c4404d66582b323bcb32d9612b80b08',
  'GD-S33-CPA-004': 'f6ae5fc58db8183ef1482b770ca381a5fcb232a010e514467affbf742d082afd',
  'GD-S33-CPA-005': 'ee49a2671a6b8d72ae35ca5d63ba1aec16235196a0ddbd0dcd9abbe2fafea344',
  'GD-S33-CPA-006': '8932c96ae385c735541be2beaab59b47bab4a11bf9977be839acf34fed832277',
  'GD-S33-CPA-007': '5398d33898c9f536b03143036ccfc5982b5f646740a5ea5cb42acc311dc7cbaf',
  'GD-S33-CPA-008': '700033d05a59c84e412e7c1089e6bcbd94f798ce1424834ff2bee75130fb6a42',
  'GD-S33-CPA-009': 'fbfb31fad049b16d2e559561aed43e15c6bcd0f77830fefa4e53181e540b703a',
  'GD-S33-CPA-010': '7c6d4827503b8e5074b0e4ed7905d1360aadf4954b2ce27ded7fb3e63fc6a08c',
  'GD-S33-CPA-011': 'cac5a0a74aaaf1f3d510bbbcb2f832974b2bd9f70e66ee838b7b1598da97deac',
  'GD-S33-CPA-012': 'e0c714a0de0ae64975ad749b4b0a2d168eb25394902f9987cab7a461548d5c6a',
  'GD-S33-CPA-013': 'e7711ae12d2d4e060d41eea4fd452ff38dbe1268d5fe17c1d27c16e6f4e6eca3',
  'GD-S33-BAR-001': '17249229201823dcd33f1bdfe1ae5d255a4cfdcefeb5bcc9bfe5954fee5b39a5',
  'GD-S33-BAR-002': 'bcbe9725b397be508662b637eaeec91d966da4345d734d496013a3fbd479b02d',
  'GD-S33-BAR-003': 'b3d2e8e7a4afeccba1f2544c90d70e48202c97020b5f98e36a006c0c72afc9ae',
  'GD-S33-BAR-004': '5d38a00b66fff319e384acf930f4e36df5aa2ccf8cc0860d1cb17f0cb74665d2',
  'GD-S33-BAR-005': '7070e5d2d883defd2c617682eb37eb6931671dbe4d2c2c5a31850a01a73b1803',
  'GD-S33-BAR-006': '9efa59f6e5f367f66f580843a5760695bdc80572cb84d8b0e66161ad44455219',
  'GD-S33-BAR-007': '7136a0690efbc805ab22934e2446935e4984ee4aaa1cc19171f7a615013acb65',
  'GD-S33-BAR-008': 'c3bbc2ef8168e444f4e31fd804ee3d317e3f6f146d75ac05016b51aef087fbde',
  'GD-S33-BAR-009': '038bdd9254f6623fd0030c8ad77e287b305d97473e245e40bb661e420ba96d86',
  'GD-S33-BAR-010': '3e477a5da9f7b37813fe0ba503244db33710892f11357e138973dc684b92fc98',
  'GD-S33-BAR-011': 'ddfa9aab8dc3411b1f2a5f75fd686116b9a0ccd2fbaf91fe88e476055dc2c60d',
  'GD-S33-BAR-012': '07417ba6594ab2d55c0bf4b271238cd74af9080b4d7a19b1f0a4d4cca2b43fc1',
  'GD-S33-BAR-013': 'e04c783e7f404411547593bfb2407099954aa05bbedec2de5b79eba19a20c7d4',
  'GD-S33-PDH-001': 'cb85dc592154125f6aa06e8f8adcaa19f7d71270e980dfcbdfcc7bc29e4d0425',
  'GD-S33-PDH-002': '7a92970e27597f2a2fc08e64fd8644780ca124e94face5a920f2a97b7fa7ce2e',
  'GD-S33-PDH-003': '5081fb6f2304fdb19904c90df1db0826272f84cb718e90c0d718c990329becd8',
  'GD-S33-PDH-004': '479037e9b0b964ad15dd2ae5fe19495afcbf3a42ee7c115759ecb08a3495828c',
  'GD-S33-PDH-005': '9725d1d9758982055f9de66925404b107656881ee68bad858d715cdbd96051ff',
  'GD-S33-PDH-006': 'ae38feebb935a0ff36e74439ae0c167369156c07143d52952bfac26bc6099df2',
  'GD-S33-PDH-007': '647ce4116d8d36017f31e9cd9174157922592f1bc7e6c59135ae893d71e8d7c0',
  'GD-S33-PDH-008': 'ac6c421654b08a59c8bc21df07b597227960969bfe53cc4fafa31cae0d6cb4ab',
  'GD-S33-PDH-009': '62dc6e4c91f96a4612213b5f879201623706a07fd4d07e3aa29c03231bd1f6eb',
  'GD-S33-PDH-010': 'b078bb5d6ee46ac0232c1df7289da8d6905f0b0870ec4a00eca07e8f90a1f679',
  'GD-S33-PDH-011': 'dfd2788949848e54dcddf9f81817c4316eeca649ce8aa9963c3d77c4de274ce5',
  'GD-S33-PDH-012': 'e20eedc7f9cf4376eb5aac2436f93074ec181498c00cf47ab7e66412e19d5960',
  'GD-S33-AU-001': '262d1b07704e9abbd754ef0a77c563f1f43e57dda02310e715fd418530de4a7a',
  'GD-S33-AU-002': 'ec320ce8418e4ff0adab38a2be0c589c9b7f589252e4c300923d2e3f03250afb',
  'GD-S33-AU-003': 'b73bca5adffd85f9dbb514ae798549cdd93904fd5fba77b410ffd1efabfe8e3a',
  'GD-S33-AU-004': '0e7a7cf07243efe6f735bd2e6d5418e24301cde51bcc930e941e044943357f8e',
  'GD-S33-AU-005': 'b4492230cb9fbaf7c3809315fb9d92b6db98a59728a493cb07bc247cad5b7fbc',
  'GD-S33-AU-006': 'ef3aa3e2da761f28b093ae0b57bc2be6da9d653b3896df0104d6f88caa366e0e',
  'GD-S33-AU-007': '818025a8b825e49a16e1f207d467790ec40d5b0bdaa3950c97c14bd9fd58262b',
  'GD-S33-AU-008': 'ef02391fdfd561ce043bf07d51d033a626a29cd9762f76d696447672dc11e873',
  'GD-S33-AU-009': '2e079b9ea1d4e78aadd65827d7db8b0a04d9c2aad154411eddabc634e6a8e267',
  'GD-S33-AU-010': 'bc7f3a77b2b94bfbbc96f4adc37158c532cce8e2beae033c80e83678c589a838',
  'GD-S33-AU-011': '6da044092708ca3f6c9dcbd0014e87e9d1dd124f800460e3501102c0d6df357b',
  'GD-S33-OOD-001': '5d30f859adc08bc338e01b86d48d677641b65f939181f63494d3401ce4b3e168',
  'GD-S33-OOD-002': '882a7ce5065b55e28f70dd3d35ddcc094484b18006ec4138f9e5ddb5c7309d7f',
  'GD-S33-OOD-003': 'fe603b0d71bdd65f891b2b133d8459180c376bf7a9daa402f8a5c7abb0741003',
  'GD-S33-OOD-004': '575446305f461c617544fb15994f04a6a9805ad61d353597d24a9a45bab0b941',
  'GD-S33-OOD-005': '49b2f3454b9603ad0ffcca4f4bd9a44442dbe9b79369a9e273314ec36b1ac14c',
  'GD-S33-OOD-006': '6afa9b780f3f536b3da1253ca205888361752fb4f316ff0ce9994f0a1a53eddc',
  'GD-S33-OOD-007': 'b0a036b6f52fda9fae564ac8f6342a3a91b26cff8740c53ec83c17515cc0ca68',
  'GD-S33-OOD-008': '7a7f4869ab9b4f80719571411f2235c44f136b8679b006004178102f44b80240',
  'GD-S33-OOD-009': 'dde1e4f23d6d8913c8a259ca206d53feef0083659d83c73c1a6784fc84c5affc',
});

function countByFixtureField(
  entries: readonly ProductionManifestFixtureEntry[],
  field: 'domain' | 'credentialType',
): Record<string, number> {
  return entries.reduce<Record<string, number>>((counts, entry) => {
    counts[entry[field]] = (counts[entry[field]] ?? 0) + 1;
    return counts;
  }, {});
}

function productionManifestFixture(bindings: ManifestFixtureBindings = {
  supportCommit: 'd'.repeat(40),
  supportTypesBlob: 'c'.repeat(40),
  predecessorCommit: '5'.repeat(40),
  sourceBlobs: {
    [WAVE1_SOURCE_PATHS[0]]: '1'.repeat(40),
    [WAVE1_SOURCE_PATHS[1]]: '2'.repeat(40),
    [WAVE1_SOURCE_PATHS[2]]: '3'.repeat(40),
  },
}): Record<string, unknown> {
  const makeEntries = (
    prefix: string,
    count: number,
    domain: ProductionManifestFixtureEntry['domain'],
  ): ProductionManifestFixtureEntry[] => Array.from({ length: count }, (_, index) => {
    const id = `GD-S33-${prefix}-${String(index + 1).padStart(3, '0')}`;
    const normalizedInputSha256 = REVIEWED_WAVE1_NORMALIZED_INPUT_BY_ID[id];
    const defaultCredentialType = REVIEWED_WAVE1_DEFAULT_CREDENTIAL_TYPE[
      prefix as keyof typeof REVIEWED_WAVE1_DEFAULT_CREDENTIAL_TYPE
    ];
    if (!normalizedInputSha256 || !defaultCredentialType) {
      throw new Error(`Missing hermetic reviewed Wave-1 fixture pin for ${id}`);
    }
    return {
      id,
      domain,
      credentialType: REVIEWED_WAVE1_CREDENTIAL_TYPE_OVERRIDES[id] ?? defaultCredentialType,
      normalizedInputSha256,
    };
  });
  const entries: ProductionManifestFixtureEntry[] = [
    ...makeEntries('KE', 11, 'au-ke-priority-documents'),
    ...makeEntries('NUR', 12, 'professional-licensing'),
    ...makeEntries('CPA', 13, 'professional-licensing'),
    ...makeEntries('BAR', 13, 'professional-licensing'),
    ...makeEntries('PDH', 12, 'professional-licensing'),
    ...makeEntries('AU', 11, 'au-ke-priority-documents'),
    ...makeEntries('OOD', 9, 'out-of-distribution'),
  ];
  const kenyaEntryIds = entries.filter(({ id }) => id.startsWith('GD-S33-KE-')).map(({ id }) => id);
  const oodEntryIds = entries.filter(({ domain }) => domain === 'out-of-distribution').map(({ id }) => id);
  const byCorpusSlice = entries.reduce<Record<string, number>>((counts, entry) => {
    const slice = CORPUS_SLICE_BY_DOMAIN[entry.domain];
    counts[slice] = (counts[slice] ?? 0) + 1;
    return counts;
  }, {});
  const entryHash = (id: string): string => entries.find((entry) => entry.id === id)!.normalizedInputSha256;
  return {
    schemaVersion: 1,
    batchId: 'S33-W1',
    revision: 9,
    producerLane: 'Lane 4',
    acceptanceAuthority: 'Lane 3',
    status: 'PRODUCER_RESUBMISSION_BLOCKED_L3_REVIEW',
    corpusRevisionParentCommit: bindings.predecessorCommit,
    producerRevisionPredecessorCommit: bindings.predecessorCommit,
    lane3SupportBase: {
      commit: bindings.supportCommit,
      typesPath: WAVE1_TYPES_PATH,
      typesBlob: bindings.supportTypesBlob,
      reviewState: 'PENDING_LANE3_REVIEW_PR',
    },
    corpusSourceBlobs: bindings.sourceBlobs,
    intendedSplit: 'held-out-candidate',
    reviewOrder: 'kenya-first',
    acceptanceScope: 'whole-batch-only',
    entryCount: 81,
    counts: {
      byDomain: countByFixtureField(entries, 'domain'),
      byCredentialType: countByFixtureField(entries, 'credentialType'),
      byCorpusSlice,
    },
    kenyaEntryIds,
    selfChecks: {
      exactCorpusManifestDatasheetBijection: { status: 'PASS', entryCount: 81 },
      normalizedInputFingerprintsPinned: {
        status: 'PASS',
        algorithm: 'sha256(normalizeForFingerprint(strippedText))',
      },
      authorizedDocumentRevisions: {
        status: 'PASS',
        revisions: [
          {
            revision: 2,
            authority: 'RTE protocol-required Wave 1 overlap revision',
            changedEntryIds: ['GD-S33-NUR-011', 'GD-S33-CPA-011', 'GD-S33-BAR-011', 'GD-S33-PDH-010'],
            normalizedInputChanged: true,
          },
          {
            revision: 3,
            authority: 'Lane 3 reject-and-return: material Kenya truth defect',
            changedEntryIds: ['GD-S33-KE-010'],
            change: 'removed ungrounded issuedDate 2013-11-30; source states only November 2013',
            normalizedInputChanged: false,
            remainingSubstantiveGroundTruthFields: 6,
          },
          {
            revision: 4,
            authority: 'Lane 3 reject-and-return: union sample grounded-truth adjudication',
            changedEntryIds: ['GD-S33-AU-007', 'GD-S33-NUR-003'],
            changes: [
              'AU-007 fieldOfStudy corrected from Commerce to text-grounded Accounting',
              'NUR-003 ungrounded ANCC accreditingBody removed',
            ],
            normalizedInputChanged: false,
            remainingSubstantiveGroundTruthFields: { 'GD-S33-AU-007': 7, 'GD-S33-NUR-003': 11 },
          },
          {
            revision: 5,
            authority: 'Lane 3 reject-and-return: full non-OOD grounded-truth review',
            changedEntryIds: ['GD-S33-AU-008', 'GD-S33-NUR-004', 'GD-S33-NUR-005', 'GD-S33-PDH-007'],
            changes: [
              'AU-008 unsupported courseId and deliveryMethod removed',
              'NUR-004 recommendation date not labeled as expiryDate and unstated deliveryMethod removed',
              'NUR-005 per-course completion date not labeled as transcript issuedDate and unstated deliveryMethod removed',
              'PDH-007 self-authored activity log replaced with provider-issued completion evidence under the existing CERTIFICATE/completion_certificate ontology',
            ],
            normalizedInputChanged: true,
            normalizedInputChangedEntryIds: ['GD-S33-PDH-007'],
            remainingSubstantiveGroundTruthFields: {
              'GD-S33-AU-008': 6, 'GD-S33-NUR-004': 7, 'GD-S33-NUR-005': 7, 'GD-S33-PDH-007': 11,
            },
          },
          {
            revision: 6,
            authority: 'Lane 3 internal review reject: PDH-007 grounded-truth jurisdiction',
            changedEntryIds: ['GD-S33-PDH-007'],
            change: 'removed unsupported jurisdiction United States because the source names no country or state; source text was not changed',
            normalizedInputChanged: false,
            recomputedNormalizedInputSha256: { 'GD-S33-PDH-007': entryHash('GD-S33-PDH-007') },
            remainingSubstantiveGroundTruthFields: { 'GD-S33-PDH-007': 10 },
          },
          {
            revision: 7,
            authority: 'RTE clean producer resubmission stacked on the Lane 3 support prerequisite',
            changedEntryIds: [],
            change: 'transplanted revision 6 corpus bytes onto Lane 3 support commit dd3ae1ed; producer packet metadata now proves the six-file protocol scope',
            corpusDataChanged: false,
            normalizedInputChanged: false,
            producerRevisionPredecessorCommit: 'dcbe0abd741a66401744a2cf916a583e865e2c9f',
            directBaseCommit: bindings.supportCommit,
            sourceBlobsUnchangedFromRevision6: true,
          },
          {
            revision: 8,
            authority: 'Team 4 same-lane review reject: NUR-004/NUR-005 grounded-truth correction',
            changedEntryIds: ['GD-S33-NUR-004', 'GD-S33-NUR-005'],
            changes: [
              'NUR-004 unsupported jurisdiction United States removed because the source names no country or state',
              'NUR-005 unsupported jurisdiction United States removed because the source names no country or state',
              'NUR-005 source minimally re-authored as an issuer-backed CERTIFICATE OF COMPLETION containing continuing-education transcript rows, grounding the existing CERTIFICATE/completion_certificate truth',
            ],
            normalizedInputChanged: true,
            normalizedInputChangedEntryIds: ['GD-S33-NUR-005'],
            recomputedNormalizedInputSha256: {
              'GD-S33-NUR-004': entryHash('GD-S33-NUR-004'),
              'GD-S33-NUR-005': entryHash('GD-S33-NUR-005'),
            },
            remainingSubstantiveGroundTruthFields: { 'GD-S33-NUR-004': 6, 'GD-S33-NUR-005': 6 },
            producerRevisionPredecessorCommit: 'c56bc9958f774471ff62a31418c304149afd4bc6',
            lane3SupportBaseCommit: bindings.supportCommit,
          },
          {
            revision: 9,
            authority: 'RTE Supermemory P1 truth correction and live PR review comment 3570778621',
            changedEntryIds: ['GD-S33-AU-002', 'GD-S33-AU-011', ...oodEntryIds],
            verifiedUnchangedEntryIds: ['GD-S33-NUR-004', 'GD-S33-NUR-005', 'GD-S33-AU-008'],
            changes: [
              'All nine OOD entries now carry pure abstention ground truth only: credentialType OTHER, subType other, and empty fraudSignals',
              'AU-002 issuedDate now uses the explicit extract-generated date 2026-04-22 rather than historical First Registered date 2015-02-02',
              'AU-011 issuedDate now uses the explicit extract-prepared date 2026-04-16 rather than historical company registration date 2021-11-03',
              'NUR-004, NUR-005, and AU-008 were re-verified to contain no deliveryMethod and their already-correct corpus bytes were preserved',
            ],
            corpusSourceTextChanged: false,
            normalizedInputChanged: false,
            normalizedInputPinsPreservedFromRevision8: true,
            remainingSubstantiveGroundTruthFields: {
              'GD-S33-AU-002': 9, 'GD-S33-AU-011': 8, nonOodMinimum: 5, oodPureAbstention: 2,
            },
            producerRevisionPredecessorCommit: bindings.predecessorCommit,
            lane3SupportBaseCommit: bindings.supportCommit,
          },
        ],
      },
      withinTypeTokenOverlap: {
        status: 'PASS',
        threshold: 0.8,
        metric: 'multiset overlap coefficient (shared token occurrences / shorter input token count)',
        violations: [],
        remediatedPairScores: [
          { leftId: 'GD-S33-NUR-001', rightId: 'GD-S33-NUR-011', credentialType: 'CERTIFICATE', overlap: 0.34 },
          { leftId: 'GD-S33-CPA-001', rightId: 'GD-S33-CPA-011', credentialType: 'CPE', overlap: 0.37 },
          { leftId: 'GD-S33-BAR-001', rightId: 'GD-S33-BAR-011', credentialType: 'CLE', overlap: 0.4 },
          { leftId: 'GD-S33-PDH-001', rightId: 'GD-S33-PDH-010', credentialType: 'CERTIFICATE', overlap: 0.28 },
        ],
      },
      oodFiveFieldSemantics: {
        status: 'BLOCKED_PROTOCOL_CONTRADICTION_CTO_L3',
        entryIds: oodEntryIds,
        producerTruth: 'Pure abstention labels contain only the protocol-declared fields.',
        contradiction: 'The producer must not invent extraction labels to pad abstention truth.',
        resolutionOwner: 'Lane 3 / CTO',
      },
      cpeSubtypeRatification: { status: 'BLOCKED_CTO_L3' },
      taxonomyAdjudicationSet: {
        status: 'BLOCKED_CTO_L3',
        entryIds: ['GD-S33-KE-003', 'GD-S33-AU-003', 'GD-S33-KE-006', 'GD-S33-AU-010'],
      },
      issuedDateAdjudicationSet: {
        status: 'BLOCKED_CTO_L3',
        entryIds: ['GD-S33-BAR-010', 'GD-S33-PDH-012'],
        resolvedEntryIdsInRevision9: ['GD-S33-AU-002', 'GD-S33-AU-011'],
      },
      batchScopeOnly: {
        status: 'PASS',
        excludedFromBatch: [
          '.sonarcloud.properties',
          'docs/lane4/s33-lane4-plan.md',
          'services/worker/src/ai/eval/golden-dataset-s33-heldout.test.ts',
          WAVE1_TYPES_PATH,
        ],
        protocolAllowedDiffPaths: [...WAVE1_PACKET_PATHS],
        dependency: {
          owner: 'Lane 3',
          branch: 'codex/s33-l3-acceptance-tooling',
          commit: bindings.supportCommit,
          typesPath: WAVE1_TYPES_PATH,
          typesBlob: bindings.supportTypesBlob,
          presentIdenticallyInBase: true,
          includedInProducerDiff: false,
          reviewState: 'PENDING_LANE3_REVIEW_PR',
        },
        reason: 'The producer diff is limited to the protocol-owned corpus packet.',
        authority: 'Batch protocol section 1',
      },
      lane3Acceptance: { status: 'NOT_RUN_PRODUCER_BOUNDARY' },
    },
    entries,
  };
}

function repositoryRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim();
}

function revision10ManifestFixture(bindings: ManifestFixtureBindings): Record<string, unknown> {
  const manifest = productionManifestFixture({
    supportCommit: WAVE1_INITIAL_LANE3_SUPPORT_COMMIT,
    supportTypesBlob: bindings.supportTypesBlob,
    predecessorCommit: WAVE1_REVISION9_PREDECESSOR_COMMIT,
    sourceBlobs: bindings.sourceBlobs,
  });
  manifest.revision = 10;
  manifest.corpusRevisionParentCommit = bindings.supportCommit;
  manifest.producerRevisionPredecessorCommit = WAVE1_REVISION9_COMMIT;
  manifest.corpusSourceBlobs = bindings.sourceBlobs;

  const support = manifest.lane3SupportBase as Record<string, unknown>;
  support.commit = bindings.supportCommit;
  support.typesBlob = bindings.supportTypesBlob;
  support.reviewState = WAVE1_R10_SUPPORT_REVIEW_STATE;

  const selfChecks = manifest.selfChecks as Record<string, unknown>;
  const revisions = (selfChecks.authorizedDocumentRevisions as {
    revisions: Array<Record<string, unknown>>;
  }).revisions;
  revisions.push({
    revision: 10,
    authority: 'RTE history-preserving restack onto the reviewed final Team 3 prerequisite',
    changedEntryIds: [],
    change: 'transplanted revision 9 corpus truth onto the reviewed final Team 3 prerequisite without changing corpus source blobs or normalized-input pins',
    corpusDataChanged: false,
    normalizedInputChanged: false,
    sourceBlobsUnchangedFromRevision9: true,
    normalizedInputPinsPreservedFromRevision9: true,
    producerRevisionPredecessorCommit: WAVE1_REVISION9_COMMIT,
    directBaseCommit: bindings.supportCommit,
    lane3SupportBaseCommit: bindings.supportCommit,
  });
  const dependency = (selfChecks.batchScopeOnly as {
    dependency: Record<string, unknown>;
  }).dependency;
  dependency.commit = bindings.supportCommit;
  dependency.typesBlob = bindings.supportTypesBlob;
  dependency.reviewState = WAVE1_R10_SUPPORT_REVIEW_STATE;
  return manifest;
}

function revision10ParserFixture(): Record<string, unknown> {
  return revision10ManifestFixture({
    supportCommit: 'a'.repeat(40),
    supportTypesBlob: 'c'.repeat(40),
    predecessorCommit: WAVE1_REVISION9_COMMIT,
    sourceBlobs: { ...WAVE1_REVISION9_SOURCE_BLOBS },
  });
}

function revision11ManifestFixture(bindings: ManifestFixtureBindings): Record<string, unknown> {
  const manifest = revision10ManifestFixture({
    supportCommit: WAVE1_REVISION10_SUPPORT_COMMIT,
    supportTypesBlob: bindings.supportTypesBlob,
    predecessorCommit: WAVE1_REVISION9_COMMIT,
    sourceBlobs: { ...WAVE1_REVISION9_SOURCE_BLOBS },
  });
  manifest.revision = 11;
  manifest.corpusRevisionParentCommit = bindings.supportCommit;
  manifest.producerRevisionPredecessorCommit = bindings.predecessorCommit;
  manifest.corpusSourceBlobs = bindings.sourceBlobs;

  const support = manifest.lane3SupportBase as Record<string, unknown>;
  support.commit = bindings.supportCommit;
  support.typesBlob = bindings.supportTypesBlob;
  support.reviewState = WAVE1_R10_SUPPORT_REVIEW_STATE;

  const selfChecks = manifest.selfChecks as Record<string, unknown>;
  const revisions = (selfChecks.authorizedDocumentRevisions as {
    revisions: Array<Record<string, unknown>>;
  }).revisions;
  revisions.push({
    revision: 11,
    authority: 'Lane 4 same-lane review reject: source-grounding corrections and issued-date adjudication declaration',
    changedEntryIds: ['GD-S33-AU-002', 'GD-S33-AU-011', 'GD-S33-KE-009'],
    changes: [
      'AU-002 issuerName corrected from expanded Australian Health Practitioner Regulation Agency to source-stated Ahpra',
      'KE-009 removed the derived expiryDate because the source states only issue date and 12-month validity, not the exact expiry date',
      'AU-002 and AU-011 issuedDate choices declared BLOCKED_CTO_L3 pending L3/CTO adjudication rather than self-certified',
    ],
    corpusSourceTextChanged: false,
    normalizedInputChanged: false,
    normalizedInputPinsPreservedFromRevision10: true,
    remainingSubstantiveGroundTruthFields: {
      'GD-S33-AU-002': 9,
      'GD-S33-AU-011': 8,
      'GD-S33-KE-009': 6,
      nonOodMinimum: 5,
      oodPureAbstention: 2,
    },
    producerRevisionPredecessorCommit: bindings.predecessorCommit,
    lane3SupportBaseCommit: bindings.supportCommit,
  });
  selfChecks.issuedDateAdjudicationSet = {
    status: 'BLOCKED_CTO_L3',
    entryIds: ['GD-S33-AU-002', 'GD-S33-AU-011', 'GD-S33-BAR-010', 'GD-S33-PDH-012'],
  };
  const dependency = (selfChecks.batchScopeOnly as {
    dependency: Record<string, unknown>;
  }).dependency;
  dependency.commit = bindings.supportCommit;
  dependency.typesBlob = bindings.supportTypesBlob;
  dependency.reviewState = WAVE1_R10_SUPPORT_REVIEW_STATE;
  return manifest;
}

function revision11ParserFixture(): Record<string, unknown> {
  return revision11ManifestFixture({
    supportCommit: 'f'.repeat(40),
    supportTypesBlob: 'c'.repeat(40),
    predecessorCommit: WAVE1_REVISION10_COMMIT,
    sourceBlobs: {
      ...WAVE1_REVISION9_SOURCE_BLOBS,
      [WAVE1_SOURCE_PATHS[1]]: 'b'.repeat(40),
    },
  });
}

function syntheticEntryDatasheetRows(manifest: Record<string, unknown>): Array<Record<string, unknown>> {
  return (manifest.entries as ProductionManifestFixtureEntry[]).map(({ id, domain, credentialType }) => ({
    id,
    domain,
    realOrSynthetic: 'synthetic',
    authorshipMethod: 'independently-authored',
    generatorDerived: false,
    sourceProvenance: `test-only/${id}`,
    lawfulBasis: 'test-only synthetic fixture',
    generator: {
      name: 'none-independent-human-authorship',
      version: 'not-applicable-no-generator',
      seed: 'not-applicable-no-rng',
      templateId: 'not-applicable-no-template',
    },
    jurisdiction: domain === 'out-of-distribution' ? 'KE' : 'US',
    jurisdictionDetail: domain === 'out-of-distribution' ? null : 'Test jurisdiction',
    credentialType,
    subType: domain === 'out-of-distribution' ? 'other' : 'test-subtype',
    curationAuthor: 'Arkova Lane 4 test fixture',
    curationDate: '2026-07-10',
    licenseConsentNote: 'test-only synthetic fixture',
  }));
}

function corpusDatasheetFixture(manifest: Record<string, unknown>, manifestSha256: string): string {
  const revision = manifest.revision as number;
  const parent = manifest.corpusRevisionParentCommit as string;
  const predecessor = manifest.producerRevisionPredecessorCommit as string;
  const support = manifest.lane3SupportBase as Record<string, string>;
  return [
    `# S3.3 Golden Held-Out Corpus — Datasheet (Wave 1, Revision ${revision})`,
    '',
    `**Revision ${revision}:** test-only producer packet`,
    '',
    `- Current producer revision: \`S33-W1\` revision ${revision}; exact raw-file SHA-256 \`${manifestSha256}\`.`,
    '- The manifest and datasheet each contain exactly 81 unique rows in exact bijection with the corpus.',
    `- Shared type definitions: blob \`${support.typesBlob}\` on commit \`${support.commit}\`.`,
    '',
    `Revision ${revision} has sole physical parent, direct base, and Lane-3 support commit \`${parent}\`; its logical producer predecessor is exact commit \`${predecessor}\`.`,
    '',
  ].join('\n');
}

function syntheticRevision10Pins(
  manifest: Record<string, unknown>,
  rows: readonly Record<string, unknown>[] = syntheticEntryDatasheetRows(manifest),
  sourceBlobs: ManifestFixtureBindings['sourceBlobs'] = manifest.corpusSourceBlobs as ManifestFixtureBindings['sourceBlobs'],
): Wave1Revision10Pins {
  const entries = manifest.entries as ProductionManifestFixtureEntry[];
  return {
    sourceBlobs: { ...sourceBlobs },
    entriesSha256: sha256(canonicaliseJson(entries)),
    normalizedPinsSha256: sha256(canonicaliseJson(entries.map(({ id, normalizedInputSha256 }) => ({
      id,
      normalizedInputSha256,
    })))),
    entryRowsSha256: sha256(canonicaliseJson(rows)),
  };
}

function parseRevision10WithSyntheticPins(manifest: Record<string, unknown>) {
  const { trustRoot } = testKey();
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'arkova-s33-r10-parser-'));
  tempRoots.push(evidenceRoot);
  return createTestOnlyS33AcceptanceOrchestrator({
    trustRoot,
    consumptionRegistry: new TestConsumptionRegistry(),
    ledgerPath: join(evidenceRoot, 'acceptance-ledger.jsonl'),
    repositoryRoot: repositoryRoot(),
    repositoryIdentity: 'test/ArkovaCarson',
    verificationCommitSha: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot(),
      encoding: 'utf8',
    }).trim(),
    revision10Pins: syntheticRevision10Pins(manifest),
  }).parseBatchManifestForTest(JSON.stringify(manifest));
}

function parseRevision11WithSyntheticPins(manifest: Record<string, unknown>) {
  const { trustRoot } = testKey();
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'arkova-s33-r11-parser-'));
  tempRoots.push(evidenceRoot);
  return createTestOnlyS33AcceptanceOrchestrator({
    trustRoot,
    consumptionRegistry: new TestConsumptionRegistry(),
    ledgerPath: join(evidenceRoot, 'acceptance-ledger.jsonl'),
    repositoryRoot: repositoryRoot(),
    repositoryIdentity: 'test/ArkovaCarson',
    verificationCommitSha: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot(),
      encoding: 'utf8',
    }).trim(),
    revision10Pins: syntheticRevision10Pins(revision10ParserFixture()),
    revision11Pins: syntheticRevision10Pins(manifest),
  }).parseBatchManifestForTest(JSON.stringify(manifest));
}

function manifestContent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...productionManifestFixture(), ...overrides }, null, 2);
}

function testKey(): {
  privateKey: KeyObject;
  trustRoot: SamplingTrustRoot;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const publicKeyDer = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return {
    privateKey,
    trustRoot: {
      signerIdentity: 'Arkova CTO',
      signingKeyId: 'cto-policy-test-key-1',
      publicKeyPem,
      publicKeyFingerprintSha256: sha256(publicKeyDer),
    },
  };
}

interface SignedArtifactFixture<P extends object> {
  object: SignedPolicyArtifact<P>;
  content: string;
}

function signedArtifact<P extends object>(
  payload: P,
  privateKey: KeyObject,
): SignedArtifactFixture<P> {
  const payloadDigestSha256 = sha256(canonicaliseJson(payload));
  const signature = {
    algorithm: 'Ed25519' as const,
    value: sign(
      null,
      Buffer.from(canonicaliseJson({ payload, payloadDigestSha256 }), 'utf8'),
      privateKey,
    ).toString('base64url'),
  };
  const object = {
    payload,
    payloadDigestSha256,
    signature,
    artifactDigestSha256: sha256(canonicaliseJson({ payload, payloadDigestSha256, signature })),
  };
  return { object, content: JSON.stringify(object, null, 2) };
}

class TestConsumptionRegistry {
  readonly keys = new Set<string>();

  async createIfAbsent(record: Readonly<ConsumptionRegistryRecord>): Promise<boolean> {
    if (this.keys.has(record.uniqueKey)) return false;
    this.keys.add(record.uniqueKey);
    return true;
  }
}

type ManifestMutator = (manifest: Record<string, unknown>) => void;

interface GitFixtureMutation {
  setupSupport?: (root: string) => void;
  mutateFreezeTree?: (root: string) => void;
  mutateFreezeIndex?: (root: string, predecessorCommit: string) => void;
}

function gitRepo(mutateManifest?: ManifestMutator, mutateGit?: GitFixtureMutation): {
  root: string;
  manifest: string;
  manifestPath: string;
  freezeCommitSha: string;
  verificationCommitSha: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'arkova-s33-git-'));
  tempRoots.push(root);
  const manifestPath = WAVE1_MANIFEST_PATH;
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'lane3-test@arkova.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Lane3 Test'], { cwd: root });

  mkdirSync(join(root, 'services/worker/src/ai/eval'), { recursive: true });
  writeFileSync(join(root, WAVE1_TYPES_PATH), 'export type Wave1FixtureType = string;\n', 'utf8');
  mutateGit?.setupSupport?.(root);
  execFileSync('git', ['add', '--all'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'lane 3 support base'], { cwd: root });
  const supportCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const supportTypesBlob = execFileSync('git', ['rev-parse', `${supportCommit}:${WAVE1_TYPES_PATH}`], {
    cwd: root, encoding: 'utf8',
  }).trim();

  for (const [index, path] of WAVE1_SOURCE_PATHS.entries()) {
    writeFileSync(join(root, path), `export const initialFixture${index} = ${index};\n`, 'utf8');
  }
  execFileSync('git', ['add', ...WAVE1_SOURCE_PATHS], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'producer revision predecessor'], { cwd: root });
  const predecessorCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

  mkdirSync(join(root, 'docs/lane4'), { recursive: true });
  writeFileSync(join(root, 'docs/lane4/s33-corpus-datasheet.md'), '# Corpus datasheet\n', 'utf8');
  writeFileSync(join(root, 'docs/lane4/s33-wave1-entry-datasheet.json'), '{"entries":81}\n', 'utf8');
  writeFileSync(join(root, WAVE1_SOURCE_PATHS[1]), 'export const revisedAuKeFixture = 9;\n', 'utf8');
  writeFileSync(join(root, WAVE1_SOURCE_PATHS[2]), 'export const revisedOodFixture = 9;\n', 'utf8');
  mutateGit?.mutateFreezeTree?.(root);
  const sourceBlobs = Object.fromEntries(WAVE1_SOURCE_PATHS.map((path) => [
    path,
    execFileSync('git', ['hash-object', path], { cwd: root, encoding: 'utf8' }).trim(),
  ])) as ManifestFixtureBindings['sourceBlobs'];
  const manifestObject = productionManifestFixture({
    supportCommit,
    supportTypesBlob,
    predecessorCommit,
    sourceBlobs,
  });
  mutateManifest?.(manifestObject);
  const manifest = JSON.stringify(manifestObject, null, 2);
  writeFileSync(join(root, manifestPath), manifest, 'utf8');
  execFileSync('git', ['add', '--all'], { cwd: root });
  mutateGit?.mutateFreezeIndex?.(root, predecessorCommit);
  execFileSync('git', ['commit', '-qm', 'freeze manifest'], { cwd: root });
  const freezeCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  writeFileSync(join(root, 'verification.txt'), 'verification descendant\n', 'utf8');
  execFileSync('git', ['add', 'verification.txt'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'verification descendant'], { cwd: root });
  const verificationCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return { root, manifest, manifestPath, freezeCommitSha, verificationCommitSha };
}

interface Revision10GitMutation {
  mergeFreezeCommit?: boolean;
  mutateEntryDatasheet?: ManifestMutator;
  mutateCorpusDatasheet?: (content: string) => string;
  mutateManifest?: ManifestMutator;
  mutateSourceBytes?: boolean;
  repinMutatedEntryRows?: boolean;
}

function revision10GitRepo(
  mutation: Revision10GitMutation = {},
  supportObjectRepository = repositoryRoot(),
): {
  root: string;
  manifest: string;
  manifestPath: string;
  supportCommit: string;
  revision10Pins: Wave1Revision10Pins;
  freezeCommitSha: string;
  verificationCommitSha: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'arkova-s33-r10-git-'));
  tempRoots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', [
    'fetch', '-q', '--no-tags', supportObjectRepository, WAVE1_INITIAL_LANE3_SUPPORT_COMMIT,
  ], { cwd: root });
  execFileSync('git', ['switch', '-q', '--detach', 'FETCH_HEAD'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'lane3-test@arkova.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Lane3 Test'], { cwd: root });
  writeFileSync(
    join(root, WAVE1_TEST_SUPPORT_MARKER_PATH),
    'Hermetic test-only Team 3 support descendant.\n',
    'utf8',
  );
  execFileSync('git', ['add', WAVE1_TEST_SUPPORT_MARKER_PATH], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'synthetic Team 3 support descendant'], { cwd: root });
  const supportCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8',
  }).trim();
  const supportTypesBlob = execFileSync('git', ['rev-parse', `${supportCommit}:${WAVE1_TYPES_PATH}`], {
    cwd: root, encoding: 'utf8',
  }).trim();
  for (const [index, path] of WAVE1_SOURCE_PATHS.entries()) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      `export const syntheticRevision10Fixture${index} = 'test-only-${index}';\n`,
      'utf8',
    );
  }
  const pinnedSourceBlobs = Object.fromEntries(WAVE1_SOURCE_PATHS.map((path) => [
    path,
    execFileSync('git', ['hash-object', path], { cwd: root, encoding: 'utf8' }).trim(),
  ])) as ManifestFixtureBindings['sourceBlobs'];
  const pinnedManifest = revision10ManifestFixture({
    supportCommit,
    supportTypesBlob,
    predecessorCommit: WAVE1_REVISION9_COMMIT,
    sourceBlobs: pinnedSourceBlobs,
  });
  const pinnedRows = syntheticEntryDatasheetRows(pinnedManifest);
  let revision10Pins = syntheticRevision10Pins(pinnedManifest, pinnedRows, pinnedSourceBlobs);
  if (mutation.mutateSourceBytes) {
    writeFileSync(join(root, WAVE1_SOURCE_PATHS[0]), 'export const changedAfterRevision9 = true;\n', 'utf8');
  }
  const sourceBlobs = Object.fromEntries(WAVE1_SOURCE_PATHS.map((path) => [
    path,
    execFileSync('git', ['hash-object', path], { cwd: root, encoding: 'utf8' }).trim(),
  ])) as ManifestFixtureBindings['sourceBlobs'];
  const manifestObject = revision10ManifestFixture({
    supportCommit,
    supportTypesBlob,
    predecessorCommit: WAVE1_REVISION9_COMMIT,
    sourceBlobs,
  });
  mutation.mutateManifest?.(manifestObject);
  const manifest = JSON.stringify(manifestObject, null, 2);
  const manifestPath = WAVE1_MANIFEST_PATH;
  mkdirSync(join(root, 'docs/lane4'), { recursive: true });
  writeFileSync(join(root, manifestPath), manifest, 'utf8');
  const entryDatasheetPath = 'docs/lane4/s33-wave1-entry-datasheet.json';
  const entryDatasheet: Record<string, unknown> = {
    schemaVersion: 1,
    batchId: 'S33-W1',
    revision: 10,
    manifestSha256: sha256(manifest),
    producerLane: 'Lane 4',
    acceptanceAuthority: 'Lane 3',
    status: 'PRODUCER_RESUBMISSION_BLOCKED_L3_REVIEW',
    entryCount: 81,
    reviewOrder: 'kenya-first',
    acceptanceScope: 'whole-batch-only',
    authorshipNote: 'All rows are independently authored synthetic-realistic heldout candidates; no template generator or random seed was used.',
    rows: pinnedRows,
  };
  mutation.mutateEntryDatasheet?.(entryDatasheet);
  if (mutation.repinMutatedEntryRows) {
    revision10Pins = {
      ...revision10Pins,
      entryRowsSha256: sha256(canonicaliseJson(entryDatasheet.rows)),
    };
  }
  writeFileSync(join(root, entryDatasheetPath), JSON.stringify(entryDatasheet, null, 2), 'utf8');
  const corpusDatasheetPath = WAVE1_CORPUS_DATASHEET_PATH;
  const corpusDatasheet = corpusDatasheetFixture(manifestObject, sha256(manifest));
  writeFileSync(
    join(root, corpusDatasheetPath),
    mutation.mutateCorpusDatasheet?.(corpusDatasheet) ?? corpusDatasheet,
    'utf8',
  );
  execFileSync('git', ['add', '--all'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'revision 10 metadata-only restack'], { cwd: root });
  let freezeCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8',
  }).trim();
  if (mutation.mergeFreezeCommit) {
    const tree = execFileSync('git', ['rev-parse', `${freezeCommitSha}^{tree}`], {
      cwd: root, encoding: 'utf8',
    }).trim();
    freezeCommitSha = execFileSync('git', [
      'commit-tree', tree, '-p', supportCommit, '-p', WAVE1_INITIAL_LANE3_SUPPORT_COMMIT,
    ], { cwd: root, encoding: 'utf8', input: 'invalid merge-parent freeze\n' }).trim();
    const verificationCommitSha = execFileSync('git', [
      'commit-tree', tree, '-p', freezeCommitSha,
    ], { cwd: root, encoding: 'utf8', input: 'verification descendant\n' }).trim();
    return { root, manifest, manifestPath, supportCommit, revision10Pins, freezeCommitSha, verificationCommitSha };
  }
  writeFileSync(join(root, 'verification.txt'), 'verification descendant\n', 'utf8');
  execFileSync('git', ['add', 'verification.txt'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'verification descendant'], { cwd: root });
  const verificationCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8',
  }).trim();
  return { root, manifest, manifestPath, supportCommit, revision10Pins, freezeCommitSha, verificationCommitSha };
}

function outerCheckoutWithPacketPaths(): string {
  const root = mkdtempSync(join(tmpdir(), 'arkova-s33-r10-outer-'));
  tempRoots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', [
    'fetch', '-q', '--no-tags', repositoryRoot(), WAVE1_INITIAL_LANE3_SUPPORT_COMMIT,
  ], { cwd: root });
  execFileSync('git', ['switch', '-q', '--detach', 'FETCH_HEAD'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'lane3-test@arkova.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Lane3 Test'], { cwd: root });
  for (const [index, path] of WAVE1_PACKET_PATHS.entries()) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `synthetic outer-checkout packet path ${index}\n`, 'utf8');
  }
  execFileSync('git', ['add', '--all'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'outer checkout already contains packet'], { cwd: root });
  return root;
}

function revision10Ceremony(mutation: Revision10GitMutation = {}) {
  const repo = revision10GitRepo(mutation);
  const { privateKey, trustRoot } = testKey();
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'arkova-s33-r10-ledger-'));
  tempRoots.push(evidenceRoot);
  const orchestrator = createTestOnlyS33AcceptanceOrchestrator({
    trustRoot,
    consumptionRegistry: new TestConsumptionRegistry(),
    ledgerPath: join(evidenceRoot, 'acceptance-ledger.jsonl'),
    repositoryRoot: repo.root,
    repositoryIdentity: 'test/ArkovaCarson',
    verificationCommitSha: repo.verificationCommitSha,
    revision10Pins: repo.revision10Pins,
  });
  const commitment = signedArtifact<SaltCommitmentPayload>({
    artifactType: 'arkova-s33-salt-commitment',
    artifactVersion: '1.0.0',
    commitmentId: 'S33-W1-r10-commitment-1',
    signerIdentity: 'Arkova CTO',
    signingKeyId: 'cto-policy-test-key-1',
    signedAtUtc: '2026-07-13T14:00:00.000Z',
    saltCommitment: { algorithm: 'sha256', value: sha256('33'.repeat(32)) },
  }, privateKey);
  const freeze = signedArtifact<ManifestFreezePayload>({
    artifactType: 'arkova-s33-manifest-freeze',
    artifactVersion: '1.0.0',
    freezeId: 'S33-W1-r10-freeze-1',
    signerIdentity: 'Arkova CTO',
    signingKeyId: 'cto-policy-test-key-1',
    signedAtUtc: '2026-07-13T14:01:00.000Z',
    commitmentArtifactCanonicalSha256: canonicalManifestHash(commitment.content),
    batchId: 'S33-W1',
    revision: 10,
    manifestRawSha256: rawManifestHash(repo.manifest),
    manifestCanonicalSha256: canonicalManifestHash(repo.manifest),
    gitEvidence: {
      repositoryIdentity: 'test/ArkovaCarson',
      freezeCommitSha: repo.freezeCommitSha,
      manifestPath: repo.manifestPath,
    },
  }, privateKey);
  return { repo, orchestrator, commitment, freeze };
}

function githubCiAcceptanceInput(
  repo: ReturnType<typeof revision10GitRepo>,
): TestOnlyS33Wave1AcceptanceArtifactInput {
  const evidenceReportDirectory = mkdtempSync(join(tmpdir(), 'arkova-s33-wave1-reports-'));
  tempRoots.push(evidenceReportDirectory);
  const manifest = JSON.parse(repo.manifest) as Record<string, unknown>;
  const entries = manifest.entries as Array<Record<string, unknown>>;
  const manifestRawSha256 = sha256(repo.manifest);
  const sampleEntryIds = entries.map(({ id }) => String(id))
    .map((id) => ({ id, rank: sha256(`${manifestRawSha256}\0${id}`) }))
    .sort((left, right) => left.rank < right.rank
      ? -1
      : left.rank > right.rank ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    .slice(0, 9)
    .map(({ id }) => id);
  const producerTreeSha = execFileSync('git', ['rev-parse', `${repo.freezeCommitSha}^{tree}`], {
    cwd: repo.root,
    encoding: 'utf8',
  }).trim();
  const common = {
    schemaVersion: 1,
    batchId: 'S33-W1',
    producerHeadSha: repo.freezeCommitSha,
    manifestRawSha256,
    status: 'PASS',
  };
  const writeReport = (filename: string, artifactType: string, payload: Record<string, unknown>) => {
    const report = {
      ...common,
      artifactType,
      payload,
    };
    const text = JSON.stringify(report, null, 2);
    writeFileSync(join(evidenceReportDirectory, filename), text);
    return { rawSha256: sha256(text), canonicalSha256: sha256(canonicaliseJson(report)) };
  };
  writeReport('cross-review.json', 'arkova-s33-wave1-cross-review', {
    sampleAlgorithm: 'sha256-manifest-entry-rank-v1',
    sampleRule: 'ceil(10%),minimum-5,capped-at-entry-count',
    manifestEntryCount: 81,
    sampleEntryIds,
    materialLabelDefectCount: 0,
    adjudications: sampleEntryIds.map((entryId) => ({
      entryId,
      verdict: 'PASS',
      note: 'Independent source-grounded review passed.',
    })),
    wholeBatchVerdict: 'ACCEPT',
    githubAuthentication: {
      status: 'APPROVED',
      headSha: repo.freezeCommitSha,
      url: 'https://github.com/carson-see/ArkovaCarson/pull/1498#pullrequestreview-1',
      reviewId: 'PRR_kwDO-test',
      reviewDatabaseId: 1,
      submittedAt: '2026-07-14T12:57:00Z',
      authorityKind: 'primary',
      reviewer: {
        login: 'chatgpt-codex-connector[bot]',
        databaseId: 199175422,
        id: 'BOT_kgDOC98s_g',
      },
    },
  });
  const universeSha256 = sha256(canonicaliseJson(entries.map(({ id }) => id)));
  const prodModelConfig = {
    promptModule: 'services/worker/src/ai/prompts/extraction.ts',
    promptModuleRawSha256: sha256(readFileSync(join(process.cwd(), 'src/ai/prompts/extraction.ts'))),
    systemPromptExport: 'EXTRACTION_SYSTEM_PROMPT',
    systemPromptSha256: sha256(EXTRACTION_SYSTEM_PROMPT),
    promptBuilder: 'buildExtractionPrompt',
    promptBuilderProbeSha256: sha256(buildExtractionPrompt('__S33_PIN__', 'OTHER', undefined)),
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 2048,
    },
    absentFlags: ['GEMINI_TUNED_MODEL', 'GEMINI_V6_PROMPT', 'GEMINI_TUNED_RESPONSE_SCHEMA'],
    timeoutMs: 30_000,
    concurrency: 1,
    maxRequests: 81,
    maxEntryCharacters: 50_000,
    maxAggregateInputCharacters: 4_050_000,
  };
  const prodReport = writeReport('prod-model-diff.json', 'arkova-s33-wave1-prod-model-diff', {
    mode: 'offline-prod-parity-replay',
    producerTreeSha,
    manifestCanonicalSha256: canonicalManifestHash(repo.manifest),
    entryUniverseSha256: universeSha256,
    providerSurface: 'google-generative-language-developer-api',
    model: 'gemini-2.5-flash',
    modelConfig: prodModelConfig,
    modelConfigCanonicalSha256: sha256(canonicaliseJson(prodModelConfig)),
    workflowRunId: 123,
    workflowRunAttempt: 1,
    trustedMainRunSha: 'a'.repeat(40),
    workflowPath: '.github/workflows/s33-wave1-prerequisites.yml',
    startedAtUtc: '2026-07-14T12:48:00.000Z',
    completedAtUtc: '2026-07-14T12:58:00.000Z',
    requestCount: 81,
    retryCount: 0,
    entryCount: 81,
    results: entries.map(({ id }) => ({
      id,
      modelOutputRawSha256: '1'.repeat(64),
      modelOutputCanonicalSha256: '2'.repeat(64),
      groundTruthCanonicalSha256: '3'.repeat(64),
      classification: 'MATCH',
      differingFields: [],
    })),
    rawReportSha256: '4'.repeat(64),
    rawReportCanonicalSha256: '5'.repeat(64),
  });
  writeReport('lexical-leakage.json', 'arkova-s33-wave1-lexical-leakage', {
    algorithm: 'normalized-token-exact-ngram-v1',
    normalization: 'NFKC;lowercase;non-alphanumeric-space;whitespace-collapse',
    n: [6, 7, 8, 9, 10, 11, 12, 13],
    producerTreeSha,
    manifestCanonicalSha256: canonicalManifestHash(repo.manifest),
    entryCount: 81,
    trainingCorpusFileCount: 1,
    trainingManifestSha256: '4'.repeat(64),
    exactMatchCount: 0,
    hits: [],
  });
  const embeddingModelConfig = {
    taskType: 'SEMANTIC_SIMILARITY',
    outputDimensionality: 3072,
    batchSize: 16,
    timeoutMs: 30_000,
    concurrency: 1,
    retryCount: 0,
    chunkTokens: 1500,
    chunkOverlapTokens: 128,
    maxTrainingChunks: 2048,
    maxVectorInputs: 2129,
    maxHttpRequests: 134,
  };
  writeReport('embedding-diagnostic.json', 'arkova-s33-wave1-embedding-diagnostic', {
    role: 'diagnostic-only',
    canOverrideExactScan: false,
    producerTreeSha,
    manifestCanonicalSha256: canonicalManifestHash(repo.manifest),
    entryUniverseSha256: universeSha256,
    providerSurface: 'google-generative-language-developer-api',
    model: 'gemini-embedding-001',
    modelConfig: embeddingModelConfig,
    modelConfigCanonicalSha256: sha256(canonicaliseJson(embeddingModelConfig)),
    workflowRunId: 123,
    workflowRunAttempt: 1,
    trustedMainRunSha: 'a'.repeat(40),
    workflowPath: '.github/workflows/s33-wave1-prerequisites.yml',
    startedAtUtc: '2026-07-14T12:48:00.000Z',
    completedAtUtc: '2026-07-14T12:59:00.000Z',
    heldoutRecordCount: 81,
    trainingFileCount: 1,
    trainingChunkCount: 1,
    vectorInputCount: 82,
    requestCount: 6,
    retryCount: 0,
    lexicalTrainingManifestSha256: '4'.repeat(64),
    trainingChunkManifestCanonicalSha256: '7'.repeat(64),
    entryCount: 81,
    results: entries.map(({ id }) => ({
      id,
      nearestTrainingDocumentSha256: '8'.repeat(64),
      nearestTrainingChunkSha256: '9'.repeat(64),
      cosineSimilarity: 0.25,
    })),
    rawReportSha256: 'a'.repeat(64),
    rawReportCanonicalSha256: 'b'.repeat(64),
  });
  return {
    repositoryRoot: repo.root,
    repositoryIdentity: 'carson-see/ArkovaCarson',
    pullRequestNumber: 1498,
    producerHeadSha: repo.freezeCommitSha,
    acceptedAtUtc: '2026-07-14T13:00:00.000Z',
    githubVerdict: {
      status: 'APPROVED',
      headSha: repo.freezeCommitSha,
      url: 'https://github.com/carson-see/ArkovaCarson/pull/1498#issuecomment-1',
      checks: [
        {
          name: 'Tests', conclusion: 'SUCCESS', headSha: repo.freezeCommitSha,
          detailsUrl: 'https://github.com/carson-see/ArkovaCarson/actions/runs/1',
        },
        {
          name: 'Staging Soak Evidence Gate', conclusion: 'SUCCESS', headSha: repo.freezeCommitSha,
          detailsUrl: 'https://github.com/carson-see/ArkovaCarson/actions/runs/2',
        },
      ],
    },
    evidenceReportDirectory,
    prodDiffAdjudication: {
      schemaVersion: 1,
      artifactType: 'arkova-s33-wave1-prod-diff-adjudication',
      batchId: 'S33-W1',
      producerHeadSha: repo.freezeCommitSha,
      manifestRawSha256,
      prerequisite: {
        workflowRunId: 123,
        workflowRunNumber: 1,
        workflowRunAttempt: 1,
        trustedMainRunSha: 'a'.repeat(40),
        prodModelDiffArtifactId: 456,
        prodModelDiffArchiveSha256: 'c'.repeat(64),
        prodModelDiffReportRawSha256: prodReport.rawSha256,
        prodModelDiffReportCanonicalSha256: prodReport.canonicalSha256,
      },
      mismatchCount: 0,
      adjudications: [],
    },
  };
}

function mutateWorkflowReport(
  input: TestOnlyS33Wave1AcceptanceArtifactInput,
  filename: string,
  mutate: (report: Record<string, unknown>) => void,
): void {
  const path = join(input.evidenceReportDirectory, filename);
  const report = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  mutate(report);
  writeFileSync(path, JSON.stringify(report, null, 2));
}

function ceremony(mutateManifest?: ManifestMutator, mutateGit?: GitFixtureMutation) {
  const repo = gitRepo(mutateManifest, mutateGit);
  const manifest = repo.manifest;
  const { privateKey, trustRoot } = testKey();
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'arkova-s33-ledger-'));
  tempRoots.push(evidenceRoot);
  const consumptionRegistry = new TestConsumptionRegistry();
  const orchestrator = createTestOnlyS33AcceptanceOrchestrator({
    trustRoot,
    consumptionRegistry,
    ledgerPath: join(evidenceRoot, 'acceptance-ledger.jsonl'),
    repositoryRoot: repo.root,
    repositoryIdentity: 'test/ArkovaCarson',
    verificationCommitSha: repo.verificationCommitSha,
  });
  const salt = '11'.repeat(32);
  const commitment = signedArtifact<SaltCommitmentPayload>({
    artifactType: 'arkova-s33-salt-commitment',
    artifactVersion: '1.0.0',
    commitmentId: 'S33-W1-commitment-1',
    signerIdentity: 'Arkova CTO',
    signingKeyId: 'cto-policy-test-key-1',
    signedAtUtc: '2026-07-13T13:00:00.000Z',
    saltCommitment: { algorithm: 'sha256', value: sha256(salt) },
  }, privateKey);
  const freeze = signedArtifact<ManifestFreezePayload>({
    artifactType: 'arkova-s33-manifest-freeze',
    artifactVersion: '1.0.0',
    freezeId: 'S33-W1-r9-freeze-1',
    signerIdentity: 'Arkova CTO',
    signingKeyId: 'cto-policy-test-key-1',
    signedAtUtc: '2026-07-13T13:01:00.000Z',
    commitmentArtifactCanonicalSha256: canonicalManifestHash(commitment.content),
    batchId: 'S33-W1',
    revision: 9,
    manifestRawSha256: rawManifestHash(manifest),
    manifestCanonicalSha256: canonicalManifestHash(manifest),
    gitEvidence: {
      repositoryIdentity: 'test/ArkovaCarson',
      freezeCommitSha: repo.freezeCommitSha,
      manifestPath: repo.manifestPath,
    },
  }, privateKey);
  const policy = signedArtifact<SelectionPolicyPayload>({
    artifactType: 'arkova-s33-selection-policy',
    artifactVersion: '1.0.0',
    policyId: 'S33-W1-r9-selection-1',
    signerIdentity: 'Arkova CTO',
    signingKeyId: 'cto-policy-test-key-1',
    signedAtUtc: '2026-07-13T13:02:00.000Z',
    commitmentArtifactCanonicalSha256: canonicalManifestHash(commitment.content),
    freezeArtifactCanonicalSha256: canonicalManifestHash(freeze.content),
    batchId: 'S33-W1',
    revision: 9,
    prng: 'xorshift32-v1',
    sampleRule: 'ceil(10%),minimum-5,capped-at-entry-count',
  }, privateKey);
  const reveal: SaltRevealRecord = {
    schemaVersion: 1,
    revealId: 'S33-W1-r9-reveal-1',
    commitmentArtifactCanonicalSha256: canonicalManifestHash(commitment.content),
    freezeArtifactCanonicalSha256: canonicalManifestHash(freeze.content),
    policyArtifactCanonicalSha256: canonicalManifestHash(policy.content),
    salt,
    revealedAtUtc: '2026-07-13T13:03:00.000Z',
  };
  const revealContent = JSON.stringify(reveal, null, 2);
  return {
    orchestrator,
    manifest,
    repo,
    privateKey,
    trustRoot,
    consumptionRegistry,
    commitment,
    freeze,
    policy,
    reveal,
    revealContent,
    evidenceRoot,
  };
}

function recordThroughReveal(context: ReturnType<typeof ceremony>): void {
  context.orchestrator.recordSaltCommitment(context.commitment.content);
  context.orchestrator.recordManifestFreeze(context.freeze.content, context.manifest);
  context.orchestrator.recordSelectionPolicy(context.policy.content);
  context.orchestrator.recordSaltReveal(context.revealContent);
}

describe('S3.3 authenticated, durable sampling ceremony', { timeout: 30_000 }, () => {
  it('rejects every serialized or plain-object production acceptance bundle', () => {
    expect(() => createS33Wave1AcceptanceArtifactFromAuthenticatedEvidence({} as never))
      .toThrow(/in-memory Team-2 authenticated evidence bundle/i);
    expect(() => createS33Wave1AcceptanceArtifactFromAuthenticatedEvidence(
      JSON.parse('{"repositoryIdentity":"carson-see/ArkovaCarson"}') as never,
    )).toThrow(/in-memory Team-2 authenticated evidence bundle/i);
  });
  it('builds a signer-free GitHub/CI acceptance artifact bound to the exact producer head/tree/manifest', () => {
    const repo = revision10GitRepo();
    const artifact = createTestOnlyS33Wave1AcceptanceArtifact(githubCiAcceptanceInput(repo));
    const expectedTree = execFileSync('git', ['rev-parse', `${repo.freezeCommitSha}^{tree}`], {
      cwd: repo.root,
      encoding: 'utf8',
    }).trim();

    expect(artifact).toMatchObject({
      schemaVersion: 1,
      artifactType: 'arkova-s33-wave1-acceptance',
      batchId: 'S33-W1',
      revision: 10,
      acceptanceAuthority: 'Lane 3',
      trustRoot: 'github-authenticated-exact-head-ci',
      repositoryIdentity: 'carson-see/ArkovaCarson',
      pullRequestNumber: 1498,
      producerHeadSha: repo.freezeCommitSha,
      producerTreeSha: expectedTree,
      manifestPath: WAVE1_MANIFEST_PATH,
      manifestRawSha256: sha256(repo.manifest),
      githubVerdict: { status: 'APPROVED', headSha: repo.freezeCommitSha },
      evidence: {
        lexicalLeakage: { exactMatchCount: 0, n: [6, 7, 8, 9, 10, 11, 12, 13] },
        embedding: { role: 'diagnostic-only', canOverrideExactScan: false },
      },
    });
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(JSON.stringify(artifact)).not.toMatch(/signer|signature|registry|ceremony/i);
    const { artifactDigestSha256, ...unsigned } = artifact;
    expect(artifactDigestSha256).toBe(sha256(canonicaliseJson(unsigned)));
  });

  it('rejects a Wave-1 artifact unless CI is green and the normalized 6-13 exact scan has zero hits', () => {
    const repo = revision10GitRepo();
    const failedCheck = githubCiAcceptanceInput(repo);
    failedCheck.githubVerdict.checks[0] = {
      ...failedCheck.githubVerdict.checks[0],
      conclusion: 'FAILURE' as never,
    };
    expect(() => createTestOnlyS33Wave1AcceptanceArtifact(failedCheck)).toThrow(/GitHub.*check.*SUCCESS/i);

    const lexicalHit = githubCiAcceptanceInput(repo);
    mutateWorkflowReport(lexicalHit, 'lexical-leakage.json', (report) => {
      const payload = report.payload as Record<string, unknown>;
      payload.exactMatchCount = 1;
      payload.hits = [{ entryId: 'GD-S33-KE-001', n: 6, ngramSha256: '7'.repeat(64) }];
    });
    expect(() => createTestOnlyS33Wave1AcceptanceArtifact(lexicalHit)).toThrow(/exact.*zero/i);

    const incompleteN = githubCiAcceptanceInput(repo);
    mutateWorkflowReport(incompleteN, 'lexical-leakage.json', (report) => {
      (report.payload as Record<string, unknown>).n = [6, 7, 8];
    });
    expect(() => createTestOnlyS33Wave1AcceptanceArtifact(incompleteN)).toThrow(/6.*13/i);

    const legacyEmbeddingConfig = githubCiAcceptanceInput(repo);
    mutateWorkflowReport(legacyEmbeddingConfig, 'embedding-diagnostic.json', (report) => {
      const payload = report.payload as Record<string, unknown>;
      const config = payload.modelConfig as Record<string, unknown>;
      config.dimensions = config.outputDimensionality;
      delete config.outputDimensionality;
      payload.modelConfigCanonicalSha256 = sha256(canonicaliseJson(config));
    });
    expect(() => createTestOnlyS33Wave1AcceptanceArtifact(legacyEmbeddingConfig))
      .toThrow(/embedding.*modelConfig must contain exactly/i);
  });

  it('rejects GitHub approval or CI evidence that is not bound to the exact producer head', () => {
    const repo = revision10GitRepo();
    const staleApproval = githubCiAcceptanceInput(repo);
    staleApproval.githubVerdict.headSha = 'a'.repeat(40);
    expect(() => createTestOnlyS33Wave1AcceptanceArtifact(staleApproval)).toThrow(/APPROVED.*exact.*producer head/i);

    const staleCheck = githubCiAcceptanceInput(repo);
    staleCheck.githubVerdict.checks[0].headSha = 'b'.repeat(40);
    expect(() => createTestOnlyS33Wave1AcceptanceArtifact(staleCheck)).toThrow(/CI check.*exact.*producer head/i);
  });

  it('requires the complete CTO-authorized reviewer identity tuple', () => {
    const repo = revision10GitRepo();
    const wrongPrimaryNode = githubCiAcceptanceInput(repo);
    mutateWorkflowReport(wrongPrimaryNode, 'cross-review.json', (report) => {
      const payload = report.payload as Record<string, unknown>;
      const authentication = payload.githubAuthentication as Record<string, unknown>;
      const reviewer = authentication.reviewer as Record<string, unknown>;
      reviewer.id = 'BOT_wrong';
    });
    expect(() => createTestOnlyS33Wave1AcceptanceArtifact(wrongPrimaryNode))
      .toThrow(/CTO-authorized authority identity/i);

    const fallback = githubCiAcceptanceInput(repo);
    mutateWorkflowReport(fallback, 'cross-review.json', (report) => {
      const payload = report.payload as Record<string, unknown>;
      const authentication = payload.githubAuthentication as Record<string, unknown>;
      authentication.authorityKind = 'fallback';
      authentication.reviewer = {
        login: 'BestNessie',
        databaseId: 129661809,
        id: 'U_kgDOB7p7cQ',
      };
    });
    expect(() => createTestOnlyS33Wave1AcceptanceArtifact(fallback)).not.toThrow();
  });

  it('runs the approved cross-artifact and committed corpus provenance checks on the active path', () => {
    const domainDrift = revision10GitRepo({
      mutateEntryDatasheet(datasheet): void {
        (datasheet.rows as Array<Record<string, unknown>>)[0].domain = 'out-of-distribution';
      },
      repinMutatedEntryRows: true,
    });
    expect(() => createTestOnlyS33Wave1AcceptanceArtifact(githubCiAcceptanceInput(domainDrift)))
      .toThrow(/entry datasheet.*domain/i);

    const corpusDrift = revision10GitRepo({
      mutateCorpusDatasheet: (content) => content.replace('**Revision 10:**', '**Revision 9:**'),
    });
    expect(() => createTestOnlyS33Wave1AcceptanceArtifact(githubCiAcceptanceInput(corpusDrift)))
      .toThrow(/corpus datasheet.*revision/i);
  });
  it('requires an atomic registry with a callable create-if-absent operation', () => {
    const context = ceremony();
    expect(() => createTestOnlyS33AcceptanceOrchestrator({
      trustRoot: context.trustRoot,
      consumptionRegistry: {},
      ledgerPath: join(context.evidenceRoot, 'invalid-registry-ledger.jsonl'),
      repositoryRoot: context.repo.root,
      repositoryIdentity: 'test/ArkovaCarson',
      verificationCommitSha: context.repo.verificationCommitSha,
    } as never)).toThrow(TypeError);
  });

  it('does not expose a ledger or arbitrary event append capability', () => {
    const context = ceremony();
    expect(ledgerModule).not.toHaveProperty('DurableAcceptanceLedger');
    expect(context.orchestrator).not.toHaveProperty('append');
    expect(context.orchestrator).not.toHaveProperty('transcript');
    expect(() => (context.orchestrator as unknown as { append(): void }).append()).toThrow(/not a function/i);
  });

  it('uses the injected monotonic registry as the one-time consumption authority', async () => {
    const context = ceremony();
    const createIfAbsent = vi.fn(async (record: Readonly<ConsumptionRegistryRecord>) => {
      expect(Object.isFrozen(record)).toBe(true);
      return true;
    });
    const orchestrator = createTestOnlyS33AcceptanceOrchestrator({
      trustRoot: context.trustRoot,
      ledgerPath: join(context.evidenceRoot, 'registry-ledger.jsonl'),
      repositoryRoot: context.repo.root,
      repositoryIdentity: 'test/ArkovaCarson',
      verificationCommitSha: context.repo.verificationCommitSha,
      consumptionRegistry: { createIfAbsent },
    } as never);
    orchestrator.recordSaltCommitment(context.commitment.content);
    orchestrator.recordManifestFreeze(context.freeze.content, context.manifest);
    orchestrator.recordSelectionPolicy(context.policy.content);
    orchestrator.recordSaltReveal(context.revealContent);
    await orchestrator.selectAndConsumeSample({
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    });
    expect(createIfAbsent).toHaveBeenCalledOnce();
  });

  it('keeps the external key consumed when transcript append fails before return', async () => {
    const context = ceremony();
    const transcriptPath = join(context.evidenceRoot, 'crash-ledger.jsonl');
    const keys = new Set<string>();
    let transcriptBeforeConsumption = '';
    const consumptionRegistry = {
      async createIfAbsent(record: Readonly<ConsumptionRegistryRecord>): Promise<boolean> {
        if (keys.has(record.uniqueKey)) return false;
        keys.add(record.uniqueKey);
        transcriptBeforeConsumption = readFileSync(transcriptPath, 'utf8');
        writeFileSync(transcriptPath, `${transcriptBeforeConsumption.slice(0, -2)}X\n`, 'utf8');
        return true;
      },
    };
    const orchestrator = createTestOnlyS33AcceptanceOrchestrator({
      trustRoot: context.trustRoot,
      consumptionRegistry,
      ledgerPath: transcriptPath,
      repositoryRoot: context.repo.root,
      repositoryIdentity: 'test/ArkovaCarson',
      verificationCommitSha: context.repo.verificationCommitSha,
    });
    orchestrator.recordSaltCommitment(context.commitment.content);
    orchestrator.recordManifestFreeze(context.freeze.content, context.manifest);
    orchestrator.recordSelectionPolicy(context.policy.content);
    orchestrator.recordSaltReveal(context.revealContent);
    const input = {
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    };
    await expect(orchestrator.selectAndConsumeSample(input)).rejects.toThrow(/transcript|JSON|digest/i);
    expect(keys.size).toBe(1);
    writeFileSync(transcriptPath, transcriptBeforeConsumption, 'utf8');
    await expect(orchestrator.selectAndConsumeSample(input)).rejects
      .toThrow(/already consumed.*monotonic registry/i);
  });

  it('fails closed when the external registry loses its acknowledgement after atomic create', async () => {
    const context = ceremony();
    const keys = new Set<string>();
    let loseAcknowledgement = true;
    const consumptionRegistry = {
      async createIfAbsent(record: Readonly<ConsumptionRegistryRecord>): Promise<boolean> {
        if (keys.has(record.uniqueKey)) return false;
        keys.add(record.uniqueKey);
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error('simulated lost acknowledgement after atomic create');
        }
        return true;
      },
    };
    const orchestrator = createTestOnlyS33AcceptanceOrchestrator({
      trustRoot: context.trustRoot,
      consumptionRegistry,
      ledgerPath: join(context.evidenceRoot, 'lost-ack-ledger.jsonl'),
      repositoryRoot: context.repo.root,
      repositoryIdentity: 'test/ArkovaCarson',
      verificationCommitSha: context.repo.verificationCommitSha,
    });
    orchestrator.recordSaltCommitment(context.commitment.content);
    orchestrator.recordManifestFreeze(context.freeze.content, context.manifest);
    orchestrator.recordSelectionPolicy(context.policy.content);
    orchestrator.recordSaltReveal(context.revealContent);
    const input = {
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    };
    await expect(orchestrator.selectAndConsumeSample(input)).rejects.toThrow(/lost acknowledgement/i);
    await expect(orchestrator.selectAndConsumeSample(input)).rejects
      .toThrow(/already consumed.*monotonic registry/i);
  });

  it('rejects live getter/proxy signed-artifact objects before reading them', () => {
    const context = ceremony();
    let reads = 0;
    const liveArtifact = new Proxy(context.commitment.object, {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => context.orchestrator.recordSaltCommitment(liveArtifact as never))
      .toThrow(/artifact.*bytes|UTF-8.*JSON|string/i);
    expect(reads).toBe(0);
    const proxiedBytes = new Proxy(Buffer.from(context.commitment.content, 'utf8'), {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => context.orchestrator.recordSaltCommitment(proxiedBytes))
      .toThrow(/artifact.*bytes|UTF-8.*JSON|string/i);
    expect(reads).toBe(0);
  });

  it('never rereads mutable caller bytes after producing verified frozen snapshots', async () => {
    const context = ceremony();
    let releaseRegistry: ((created: boolean) => void) | undefined;
    const consumptionRegistry = {
      createIfAbsent(): Promise<boolean> {
        return new Promise((resolve) => {
          releaseRegistry = resolve;
        });
      },
    };
    const orchestrator = createTestOnlyS33AcceptanceOrchestrator({
      trustRoot: context.trustRoot,
      consumptionRegistry,
      ledgerPath: join(context.evidenceRoot, 'immutable-snapshot-ledger.jsonl'),
      repositoryRoot: context.repo.root,
      repositoryIdentity: 'test/ArkovaCarson',
      verificationCommitSha: context.repo.verificationCommitSha,
    });
    orchestrator.recordSaltCommitment(context.commitment.content);
    orchestrator.recordManifestFreeze(context.freeze.content, context.manifest);
    orchestrator.recordSelectionPolicy(context.policy.content);
    orchestrator.recordSaltReveal(context.revealContent);
    const inputs = {
      manifestContent: Buffer.from(context.manifest),
      commitmentArtifactContent: Buffer.from(context.commitment.content),
      freezeArtifactContent: Buffer.from(context.freeze.content),
      policyArtifactContent: Buffer.from(context.policy.content),
      revealContent: Buffer.from(context.revealContent),
    };
    const pending = orchestrator.selectAndConsumeSample(inputs);
    for (const input of Object.values(inputs)) input.fill(0x58);
    expect(releaseRegistry).toBeTypeOf('function');
    releaseRegistry?.(true);
    const result = await pending;
    expect(result.manifest).toEqual({ batchId: 'S33-W1', revision: 9, entryCount: 81 });
  });

  it('deep-freezes the returned selection graph and keeps its registry evidence digest stable', async () => {
    const context = ceremony();
    let registryRecord: Readonly<ConsumptionRegistryRecord> | undefined;
    const orchestrator = createTestOnlyS33AcceptanceOrchestrator({
      trustRoot: context.trustRoot,
      consumptionRegistry: {
        async createIfAbsent(record: Readonly<ConsumptionRegistryRecord>): Promise<boolean> {
          registryRecord = record;
          return true;
        },
      },
      ledgerPath: join(context.evidenceRoot, 'frozen-result-ledger.jsonl'),
      repositoryRoot: context.repo.root,
      repositoryIdentity: 'test/ArkovaCarson',
      verificationCommitSha: context.repo.verificationCommitSha,
    });
    orchestrator.recordSaltCommitment(context.commitment.content);
    orchestrator.recordManifestFreeze(context.freeze.content, context.manifest);
    orchestrator.recordSelectionPolicy(context.policy.content);
    orchestrator.recordSaltReveal(context.revealContent);
    const result = await orchestrator.selectAndConsumeSample({
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.sampleEntryIds)).toBe(true);
    expect(Object.isFrozen(result.manifest)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Object.isFrozen(result.evidence.durableSequence)).toBe(true);
    expect(() => (result.sampleEntryIds as string[]).push('attacker-selected-id')).toThrow(TypeError);
    expect(() => {
      (result.evidence as { sampleSize: number }).sampleSize = 1;
    }).toThrow(TypeError);

    const reconstructedConsumptionEvidence = {
      commitmentArtifactCanonicalSha256: result.evidence.commitmentArtifactCanonicalSha256,
      commitmentArtifactRawSha256: result.evidence.commitmentArtifactRawSha256,
      freezeArtifactCanonicalSha256: result.evidence.freezeArtifactCanonicalSha256,
      freezeArtifactRawSha256: result.evidence.freezeArtifactRawSha256,
      policyArtifactCanonicalSha256: result.evidence.policyArtifactCanonicalSha256,
      policyArtifactRawSha256: result.evidence.policyArtifactRawSha256,
      revealCanonicalSha256: result.evidence.revealCanonicalSha256,
      revealRawSha256: result.evidence.revealRawSha256,
      manifestRawSha256: result.evidence.manifestRawSha256,
      manifestCanonicalSha256: result.evidence.manifestCanonicalSha256,
      sampleEntryIdsSha256: sha256(canonicaliseJson(result.sampleEntryIds)),
      sampleSize: result.evidence.sampleSize,
    };
    expect(registryRecord).toBeDefined();
    expect(sha256(canonicaliseJson(reconstructedConsumptionEvidence)))
      .toBe(registryRecord?.evidenceCanonicalSha256);
  });

  it('strict-parses the complete Wave-1 production manifest contract and Kenya-first order', () => {
    const parsed = parseBatchManifest(manifestContent());
    const manifest = parsed.parsedJson;
    expect(Object.keys(manifest).sort()).toEqual([
      'acceptanceAuthority', 'acceptanceScope', 'batchId', 'corpusRevisionParentCommit',
      'corpusSourceBlobs', 'counts', 'entries', 'entryCount', 'intendedSplit', 'kenyaEntryIds',
      'lane3SupportBase', 'producerLane', 'producerRevisionPredecessorCommit', 'reviewOrder',
      'revision', 'schemaVersion', 'selfChecks', 'status',
    ].sort());
    expect(parsed.entryCount).toBe(81);
    expect(parsed.entries.slice(0, 11).map(({ id }) => id))
      .toEqual((manifest.kenyaEntryIds as string[]));
    expect((manifest.counts as { byCorpusSlice: Record<string, number> }).byCorpusSlice)
      .toEqual({
        's33-au-ke-heldout': 22,
        's33-licensing-heldout': 50,
        's33-ood-negative': 9,
      });
    expect((manifest.selfChecks as Record<string, { status: string }>).oodFiveFieldSemantics.status)
      .toBe('BLOCKED_PROTOCOL_CONTRADICTION_CTO_L3');
    expect((manifest.selfChecks as Record<string, { status: string }>).lane3Acceptance.status)
      .toBe('NOT_RUN_PRODUCER_BOUNDARY');
  });

  it('accepts the hermetic reviewed producer entries with the immutable production pins', () => {
    const manifest = revision10ManifestFixture({
      supportCommit: WAVE1_REVISION10_SUPPORT_COMMIT,
      supportTypesBlob: 'dcc94b716f18240787640ba07dcdd4ad46a7cfe6',
      predecessorCommit: WAVE1_REVISION9_COMMIT,
      sourceBlobs: { ...WAVE1_REVISION9_SOURCE_BLOBS },
    });
    const entries = manifest.entries as ProductionManifestFixtureEntry[];
    expect(sha256(canonicaliseJson(entries))).toBe(WAVE1_REVISION9_ENTRIES_SHA256);
    expect(sha256(canonicaliseJson(entries.map(({ id, normalizedInputSha256 }) => ({
      id,
      normalizedInputSha256,
    }))))).toBe(WAVE1_REVISION9_NORMALIZED_PINS_SHA256);
    expect((manifest.counts as { byCredentialType: Record<string, number> }).byCredentialType)
      .toEqual({
        ATTESTATION: 3,
        BUSINESS_ENTITY: 2,
        CERTIFICATE: 24,
        CLE: 11,
        CPE: 11,
        DEGREE: 2,
        FINANCIAL: 1,
        IDENTITY: 1,
        LICENSE: 16,
        OTHER: 9,
        TRANSCRIPT: 1,
      });
    expect(() => parseBatchManifest(JSON.stringify(manifest))).not.toThrow();
  });

  it('locks immutable exact production r9 pins without resolving the logical r9 Git object', () => {
    expect(S33_WAVE1_REVISION10_PRODUCTION_PINS).toEqual({
      sourceBlobs: WAVE1_REVISION9_SOURCE_BLOBS,
      entriesSha256: WAVE1_REVISION9_ENTRIES_SHA256,
      normalizedPinsSha256: WAVE1_REVISION9_NORMALIZED_PINS_SHA256,
      entryRowsSha256: WAVE1_REVISION9_ENTRY_ROWS_SHA256,
    });
    expect(Object.isFrozen(S33_WAVE1_REVISION10_PRODUCTION_PINS)).toBe(true);
    expect(Object.isFrozen(S33_WAVE1_REVISION10_PRODUCTION_PINS.sourceBlobs)).toBe(true);
    expect(() => {
      (S33_WAVE1_REVISION10_PRODUCTION_PINS.sourceBlobs as Record<string, string>)[WAVE1_SOURCE_PATHS[0]] = '0'.repeat(40);
    }).toThrow(TypeError);
  });

  it('locks the reviewed revision-11 truth-correction pins independently from revision 10', () => {
    const pins: Wave1Revision11Pins = S33_WAVE1_REVISION11_PRODUCTION_PINS;
    expect(pins).toEqual({
      sourceBlobs: {
        [WAVE1_SOURCE_PATHS[0]]: WAVE1_REVISION9_SOURCE_BLOBS[WAVE1_SOURCE_PATHS[0]],
        [WAVE1_SOURCE_PATHS[1]]: 'a1578a511e47bd839fda9ae31e5f3f93c99a3857',
        [WAVE1_SOURCE_PATHS[2]]: WAVE1_REVISION9_SOURCE_BLOBS[WAVE1_SOURCE_PATHS[2]],
      },
      entriesSha256: WAVE1_REVISION9_ENTRIES_SHA256,
      normalizedPinsSha256: WAVE1_REVISION9_NORMALIZED_PINS_SHA256,
      entryRowsSha256: '65a8a8a93cc098d2a7a3e284462f3e208ad7037bd950f077effe31456571da06',
    });
    expect(Object.isFrozen(pins)).toBe(true);
    expect(Object.isFrozen(pins.sourceBlobs)).toBe(true);
  });

  it('accepts only the exact revision-11 truth-correction history shape with reviewed synthetic pins', () => {
    const manifest = revision11ParserFixture();
    const parsed = parseRevision11WithSyntheticPins(manifest).parsedJson;
    const revisions = ((parsed.selfChecks as Record<string, unknown>).authorizedDocumentRevisions as {
      revisions: Array<Record<string, unknown>>;
    }).revisions;
    expect(parsed.revision).toBe(11);
    expect(revisions.at(-2)).toMatchObject({
      revision: 10,
      directBaseCommit: WAVE1_REVISION10_SUPPORT_COMMIT,
      lane3SupportBaseCommit: WAVE1_REVISION10_SUPPORT_COMMIT,
    });
    expect(revisions.at(-1)).toEqual({
      revision: 11,
      authority: 'Lane 4 same-lane review reject: source-grounding corrections and issued-date adjudication declaration',
      changedEntryIds: ['GD-S33-AU-002', 'GD-S33-AU-011', 'GD-S33-KE-009'],
      changes: [
        'AU-002 issuerName corrected from expanded Australian Health Practitioner Regulation Agency to source-stated Ahpra',
        'KE-009 removed the derived expiryDate because the source states only issue date and 12-month validity, not the exact expiry date',
        'AU-002 and AU-011 issuedDate choices declared BLOCKED_CTO_L3 pending L3/CTO adjudication rather than self-certified',
      ],
      corpusSourceTextChanged: false,
      normalizedInputChanged: false,
      normalizedInputPinsPreservedFromRevision10: true,
      remainingSubstantiveGroundTruthFields: {
        'GD-S33-AU-002': 9,
        'GD-S33-AU-011': 8,
        'GD-S33-KE-009': 6,
        nonOodMinimum: 5,
        oodPureAbstention: 2,
      },
      producerRevisionPredecessorCommit: WAVE1_REVISION10_COMMIT,
      lane3SupportBaseCommit: 'f'.repeat(40),
    });
    expect((parsed.selfChecks as Record<string, unknown>).issuedDateAdjudicationSet).toEqual({
      status: 'BLOCKED_CTO_L3',
      entryIds: ['GD-S33-AU-002', 'GD-S33-AU-011', 'GD-S33-BAR-010', 'GD-S33-PDH-012'],
    });
  });

  it.each([
    ['authority', 'unreviewed correction'],
    ['changedEntryIds', ['GD-S33-AU-002']],
    ['changes', ['partial correction']],
    ['corpusSourceTextChanged', true],
    ['normalizedInputChanged', true],
    ['normalizedInputPinsPreservedFromRevision10', false],
    ['remainingSubstantiveGroundTruthFields', { 'GD-S33-AU-002': 4 }],
    ['producerRevisionPredecessorCommit', 'd'.repeat(40)],
    ['lane3SupportBaseCommit', 'd'.repeat(40)],
  ] satisfies Array<[string, unknown]>)('rejects a revision-11 history mutation of %s', (field, replacement) => {
    const manifest = revision11ParserFixture();
    const revisions = ((manifest.selfChecks as Record<string, unknown>).authorizedDocumentRevisions as {
      revisions: Array<Record<string, unknown>>;
    }).revisions;
    revisions.at(-1)![field] = replacement;
    expect(() => parseRevision11WithSyntheticPins(manifest)).toThrow();
  });

  it.each([
    ['status', 'PASS'],
    ['entryIds', ['GD-S33-BAR-010', 'GD-S33-PDH-012']],
    ['resolvedEntryIdsInRevision9', ['GD-S33-AU-002', 'GD-S33-AU-011']],
  ] satisfies Array<[string, unknown]>)('rejects a revision-11 issuedDate adjudication mutation of %s', (field, replacement) => {
    const manifest = revision11ParserFixture();
    const issuedDate = (manifest.selfChecks as Record<string, unknown>).issuedDateAdjudicationSet as Record<string, unknown>;
    issuedDate[field] = replacement;
    expect(() => parseRevision11WithSyntheticPins(manifest)).toThrow();
  });

  it('cannot override production r10 pins through the public parser or production factory', () => {
    const manifest = revision10ParserFixture();
    (manifest.entries as ProductionManifestFixtureEntry[])[0].normalizedInputSha256 = '0'.repeat(64);
    const syntheticPins = syntheticRevision10Pins(manifest);
    expect(() => parseRevision10WithSyntheticPins(manifest)).not.toThrow();

    const adversarialPublicParser = parseBatchManifest as unknown as (
      content: string,
      pins: Wave1Revision10Pins,
    ) => unknown;
    expect(() => adversarialPublicParser(JSON.stringify(manifest), syntheticPins))
      .toThrow(/revision-10 .*reviewed revision-9/i);

    const productionInput: Parameters<typeof createProductionS33AcceptanceOrchestrator>[0] = {
      ledgerPath: join(tmpdir(), 'must-not-create.jsonl'),
      repositoryRoot: repositoryRoot(),
      verificationCommitSha: 'a'.repeat(40),
      // @ts-expect-error — production input intentionally exposes no test-pin seam.
      revision10Pins: syntheticPins,
    };
    expect(() => createProductionS33AcceptanceOrchestrator(productionInput))
      .toThrow(/retired.*CTO ruling 102498305.*GitHub\/CI-bound/i);
  });

  it('never seeds r10 support from an outer checkout HEAD that already contains the packet', () => {
    const outerRoot = outerCheckoutWithPacketPaths();
    const outerHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: outerRoot, encoding: 'utf8',
    }).trim();
    const outerPacketPaths = execFileSync('git', [
      'ls-tree', '-r', '--name-only', outerHead, '--', ...WAVE1_PACKET_PATHS,
    ], { cwd: outerRoot, encoding: 'utf8' }).trim().split('\n').sort();
    expect(outerPacketPaths).toEqual([...WAVE1_PACKET_PATHS].sort());

    const repo = revision10GitRepo({}, outerRoot);
    const supportLineage = execFileSync('git', [
      'rev-list', '--parents', '-n', '1', repo.supportCommit,
    ], { cwd: repo.root, encoding: 'utf8' }).trim().split(/\s+/);
    expect(supportLineage).toEqual([repo.supportCommit, WAVE1_INITIAL_LANE3_SUPPORT_COMMIT]);
    expect(repo.supportCommit).not.toBe(outerHead);
    expect(execFileSync('git', [
      'ls-tree', '-r', '--name-only', repo.supportCommit, '--', ...WAVE1_PACKET_PATHS,
    ], { cwd: repo.root, encoding: 'utf8' }).toString()).toBe('');
    expect(execFileSync('git', [
      'ls-tree', '-r', '--name-only', repo.supportCommit, '--',
      WAVE1_TYPES_PATH, WAVE1_TEST_SUPPORT_MARKER_PATH,
    ], { cwd: repo.root, encoding: 'utf8' }).toString().trim().split('\n').sort()).toEqual([
      WAVE1_TEST_SUPPORT_MARKER_PATH,
      WAVE1_TYPES_PATH,
    ].sort());

    const packetDiff = execFileSync('git', [
      'diff', '--raw', '--no-abbrev', repo.supportCommit, repo.freezeCommitSha,
    ], { cwd: repo.root, encoding: 'utf8' }).trim().split('\n');
    expect(packetDiff).toHaveLength(6);
    expect(packetDiff.every((line) => /^:000000 100644 [0-9a-f]{40} [0-9a-f]{40} A\t/u.test(line))).toBe(true);
  });

  it('accepts only the history-preserving r10 restack onto the exact reviewed Team-3 support head', () => {
    const context = revision10Ceremony();
    const parsed = context.orchestrator.parseBatchManifestForTest(context.repo.manifest).parsedJson;
    const support = parsed.lane3SupportBase as Record<string, unknown>;
    const revisions = ((parsed.selfChecks as Record<string, unknown>).authorizedDocumentRevisions as {
      revisions: Array<Record<string, unknown>>;
    }).revisions;
    const revision10 = revisions.at(-1)!;
    expect(parsed.revision).toBe(10);
    expect(parsed.corpusRevisionParentCommit).toBe(context.repo.supportCommit);
    expect(parsed.producerRevisionPredecessorCommit).toBe(WAVE1_REVISION9_COMMIT);
    expect(support.commit).toBe(context.repo.supportCommit);
    expect(support.reviewState).toBe(WAVE1_R10_SUPPORT_REVIEW_STATE);
    expect(revisions[5].directBaseCommit).toBe(WAVE1_INITIAL_LANE3_SUPPORT_COMMIT);
    expect(revisions[6].lane3SupportBaseCommit).toBe(WAVE1_INITIAL_LANE3_SUPPORT_COMMIT);
    expect(revisions[7].producerRevisionPredecessorCommit).toBe(WAVE1_REVISION9_PREDECESSOR_COMMIT);
    expect(revisions[7].lane3SupportBaseCommit).toBe(WAVE1_INITIAL_LANE3_SUPPORT_COMMIT);
    expect(revision10).toMatchObject({
      revision: 10,
      changedEntryIds: [],
      corpusDataChanged: false,
      normalizedInputChanged: false,
      sourceBlobsUnchangedFromRevision9: true,
      normalizedInputPinsPreservedFromRevision9: true,
      producerRevisionPredecessorCommit: WAVE1_REVISION9_COMMIT,
      directBaseCommit: context.repo.supportCommit,
      lane3SupportBaseCommit: context.repo.supportCommit,
    });

    const freezeLineage = execFileSync('git', [
      'rev-list', '--parents', '-n', '1', context.repo.freezeCommitSha,
    ], { cwd: context.repo.root, encoding: 'utf8' }).trim().split(/\s+/);
    expect(freezeLineage).toEqual([context.repo.freezeCommitSha, context.repo.supportCommit]);
    expect(() => execFileSync('git', [
      'cat-file', '-e', `${WAVE1_REVISION9_COMMIT}^{commit}`,
    ], { cwd: context.repo.root, stdio: 'ignore' })).toThrow();
    const rawDiff = execFileSync('git', [
      'diff', '--raw', '--no-abbrev', context.repo.supportCommit, context.repo.freezeCommitSha,
    ], { cwd: context.repo.root, encoding: 'utf8' }).trim().split('\n');
    expect(rawDiff).toHaveLength(6);
    expect(rawDiff.every((line) => /^:000000 100644 [0-9a-f]{40} [0-9a-f]{40} A\t/u.test(line))).toBe(true);

    context.orchestrator.recordSaltCommitment(context.commitment.content);
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.repo.manifest))
      .not.toThrow();
  });

  it.each([
    ['revision', 11],
    ['authority', 'unreviewed restack'],
    ['changedEntryIds', ['GD-S33-KE-001']],
    ['change', 'corpus bytes may have changed'],
    ['corpusDataChanged', true],
    ['normalizedInputChanged', true],
    ['sourceBlobsUnchangedFromRevision9', false],
    ['normalizedInputPinsPreservedFromRevision9', false],
    ['producerRevisionPredecessorCommit', 'd'.repeat(40)],
    ['directBaseCommit', 'd'.repeat(40)],
    ['lane3SupportBaseCommit', 'd'.repeat(40)],
  ] satisfies Array<[string, unknown]>)('rejects an r10 history mutation of %s', (field, replacement) => {
    const manifest = revision10ParserFixture();
    const revisions = ((manifest.selfChecks as Record<string, unknown>).authorizedDocumentRevisions as {
      revisions: Array<Record<string, unknown>>;
    }).revisions;
    revisions.at(-1)![field] = replacement;
    expect(() => parseRevision10WithSyntheticPins(manifest)).toThrow();
  });

  it.each([
    ['corpus parent', (manifest: Record<string, unknown>) => {
      manifest.corpusRevisionParentCommit = 'd'.repeat(40);
    }],
    ['logical predecessor', (manifest: Record<string, unknown>) => {
      manifest.producerRevisionPredecessorCommit = WAVE1_REVISION9_PREDECESSOR_COMMIT;
    }],
    ['support commit', (manifest: Record<string, unknown>) => {
      (manifest.lane3SupportBase as Record<string, unknown>).commit = 'd'.repeat(40);
    }],
    ['support types path', (manifest: Record<string, unknown>) => {
      (manifest.lane3SupportBase as Record<string, unknown>).typesPath = 'services/worker/src/ai/eval/other.ts';
    }],
    ['support types blob', (manifest: Record<string, unknown>) => {
      (manifest.lane3SupportBase as Record<string, unknown>).typesBlob = 'd'.repeat(40);
    }],
    ['support review state', (manifest: Record<string, unknown>) => {
      (manifest.lane3SupportBase as Record<string, unknown>).reviewState = 'PENDING_LANE3_REVIEW_PR';
    }],
    ['dependency commit', (manifest: Record<string, unknown>) => {
      const selfChecks = manifest.selfChecks as Record<string, unknown>;
      ((selfChecks.batchScopeOnly as { dependency: Record<string, unknown> }).dependency).commit = 'd'.repeat(40);
    }],
    ['dependency types path', (manifest: Record<string, unknown>) => {
      const selfChecks = manifest.selfChecks as Record<string, unknown>;
      ((selfChecks.batchScopeOnly as { dependency: Record<string, unknown> }).dependency).typesPath = 'other.ts';
    }],
    ['dependency types blob', (manifest: Record<string, unknown>) => {
      const selfChecks = manifest.selfChecks as Record<string, unknown>;
      ((selfChecks.batchScopeOnly as { dependency: Record<string, unknown> }).dependency).typesBlob = 'd'.repeat(40);
    }],
    ['dependency review state', (manifest: Record<string, unknown>) => {
      const selfChecks = manifest.selfChecks as Record<string, unknown>;
      ((selfChecks.batchScopeOnly as { dependency: Record<string, unknown> }).dependency).reviewState = 'PENDING_LANE3_REVIEW_PR';
    }],
    ['dependency presence flag', (manifest: Record<string, unknown>) => {
      const selfChecks = manifest.selfChecks as Record<string, unknown>;
      ((selfChecks.batchScopeOnly as { dependency: Record<string, unknown> }).dependency).presentIdenticallyInBase = false;
    }],
    ['dependency diff flag', (manifest: Record<string, unknown>) => {
      const selfChecks = manifest.selfChecks as Record<string, unknown>;
      ((selfChecks.batchScopeOnly as { dependency: Record<string, unknown> }).dependency).includedInProducerDiff = true;
    }],
  ] satisfies Array<[string, ManifestMutator]>)('rejects an r10 binding mutation of %s', (_case, mutate) => {
    const manifest = revision10ParserFixture();
    mutate(manifest);
    expect(() => parseRevision10WithSyntheticPins(manifest)).toThrow();
  });

  it.each([
    ['revision-7 initial support', 5, 'directBaseCommit'],
    ['revision-8 initial support', 6, 'lane3SupportBaseCommit'],
    ['revision-9 predecessor', 7, 'producerRevisionPredecessorCommit'],
    ['revision-9 initial support', 7, 'lane3SupportBaseCommit'],
  ] satisfies Array<[string, number, string]>)('rejects an r10 restack that rewrites the %s anchor', (
    _case,
    revisionIndex,
    field,
  ) => {
    const manifest = revision10ParserFixture();
    const revisions = ((manifest.selfChecks as Record<string, unknown>).authorizedDocumentRevisions as {
      revisions: Array<Record<string, unknown>>;
    }).revisions;
    revisions[revisionIndex][field] = 'd'.repeat(40);
    expect(() => parseRevision10WithSyntheticPins(manifest)).toThrow();
  });

  it('rejects an r10 freeze with multiple physical parents', () => {
    const context = revision10Ceremony({ mergeFreezeCommit: true });
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.repo.manifest))
      .toThrow(/exactly one parent|lineage/i);
  });

  it('rejects r10 corpus-source blob drift from the reviewed r9 commit', () => {
    const context = revision10Ceremony({ mutateSourceBytes: true });
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.repo.manifest))
      .toThrow(/revision-10 corpus source blob.*reviewed revision-9 pin/i);
  });

  it('rejects r10 entry-datasheet row drift from the reviewed r9 packet', () => {
    const context = revision10Ceremony({
      mutateEntryDatasheet(datasheet): void {
        const rows = datasheet.rows as Array<Record<string, unknown>>;
        rows[0].jurisdiction = 'CA';
      },
    });
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.repo.manifest))
      .toThrow(/entry datasheet rows.*reviewed revision-9 canonical row set/i);
  });

  it.each([
    ['manifest domain', (row: Record<string, unknown>) => { row.domain = 'out-of-distribution'; }],
    ['manifest credential type', (row: Record<string, unknown>) => { row.credentialType = 'OTHER'; }],
    ['required provenance', (row: Record<string, unknown>) => { delete row.sourceProvenance; }],
    ['generator contract', (row: Record<string, unknown>) => {
      delete (row.generator as Record<string, unknown>).templateId;
    }],
  ] satisfies Array<[string, (row: Record<string, unknown>) => void]>) (
    'rejects repinned entry-datasheet %s cross-artifact drift',
    (_case, mutateRow) => {
      const context = revision10Ceremony({
        mutateEntryDatasheet(datasheet): void {
          mutateRow((datasheet.rows as Array<Record<string, unknown>>)[0]);
        },
        repinMutatedEntryRows: true,
      });
      context.orchestrator.recordSaltCommitment(context.commitment.content);
      expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.repo.manifest))
        .toThrow(/entry datasheet.*(?:domain|credentialType|schema|sourceProvenance|generator)/i);
    },
  );

  it.each([
    ['revision marker', (content: string) => content.replace('**Revision 10:**', '**Revision 9:**')],
    ['manifest digest', (content: string) => content.replace(
      /(?<=exact raw-file SHA-256 `)[0-9a-f]{64}(?=`)/u,
      '0'.repeat(64),
    )],
    ['support binding', (content: string) => content.replace(
      /(?<=on commit `)[0-9a-f]{40}(?=`)/u,
      '0'.repeat(40),
    )],
    ['producer predecessor', (content: string) => content.replace(WAVE1_REVISION9_COMMIT, '0'.repeat(40))],
  ] satisfies Array<[string, (content: string) => string]>) (
    'rejects corpus-Markdown %s provenance drift',
    (_case, mutateCorpusDatasheet) => {
      const context = revision10Ceremony({ mutateCorpusDatasheet });
      context.orchestrator.recordSaltCommitment(context.commitment.content);
      expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.repo.manifest))
        .toThrow(/corpus datasheet.*(?:revision|digest|support|predecessor|provenance)/i);
    },
  );

  it.each([
    ['stale revision', (datasheet: Record<string, unknown>) => { datasheet.revision = 9; }],
    ['wrong manifest hash', (datasheet: Record<string, unknown>) => { datasheet.manifestSha256 = '0'.repeat(64); }],
    ['unknown approval field', (datasheet: Record<string, unknown>) => { datasheet.operatorApproval = true; }],
    ['false acceptance status', (datasheet: Record<string, unknown>) => { datasheet.status = 'ACCEPTED'; }],
  ] satisfies Array<[string, ManifestMutator]>)('rejects r10 entry-datasheet %s metadata', (_case, mutate) => {
    const context = revision10Ceremony({ mutateEntryDatasheet: mutate });
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.repo.manifest))
      .toThrow(/revision-10 entry datasheet/i);
  });

  it('rejects r10 normalized-input pin drift from the reviewed r9 manifest', () => {
    const context = revision10Ceremony({
      mutateManifest(manifest): void {
        const entries = manifest.entries as Array<Record<string, unknown>>;
        entries[0].normalizedInputSha256 = 'f'.repeat(64);
      },
    });
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.repo.manifest))
      .toThrow(/revision-10 normalized-input pins.*reviewed revision-9 pin set/i);
  });

  it('rejects r10 non-pin ground-truth drift from the reviewed r9 manifest', () => {
    const context = revision10Ceremony({
      mutateManifest(manifest): void {
        const entries = manifest.entries as Array<Record<string, unknown>>;
        entries[0].credentialType = 'CERTIFICATE';
      },
    });
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.repo.manifest))
      .toThrow(/revision-10 entries.*reviewed revision-9 ground-truth set/i);
  });

  it('rejects missing or unknown nested production fields, count drift, and Kenya order drift', () => {
    const withUnknown = productionManifestFixture();
    (withUnknown.lane3SupportBase as Record<string, unknown>).reviewerOverride = true;
    expect(() => parseBatchManifest(JSON.stringify(withUnknown)))
      .toThrow(/lane3SupportBase.*unknown.*reviewerOverride/i);

    const missingSource = productionManifestFixture();
    delete (missingSource.corpusSourceBlobs as Record<string, unknown>)[
      'services/worker/src/ai/eval/golden-dataset-s33-ood-negatives.ts'
    ];
    expect(() => parseBatchManifest(JSON.stringify(missingSource)))
      .toThrow(/corpusSourceBlobs.*missing.*ood-negatives/i);

    const unknownSelfCheck = productionManifestFixture();
    const unknownSelfChecks = unknownSelfCheck.selfChecks as {
      withinTypeTokenOverlap: Record<string, unknown>;
    };
    unknownSelfChecks.withinTypeTokenOverlap.reviewerOverride = true;
    expect(() => parseBatchManifest(JSON.stringify(unknownSelfCheck)))
      .toThrow(/withinTypeTokenOverlap.*unknown.*reviewerOverride/i);

    const missingSelfCheck = productionManifestFixture();
    const missingSelfChecks = missingSelfCheck.selfChecks as {
      batchScopeOnly: Record<string, unknown>;
    };
    delete missingSelfChecks.batchScopeOnly.dependency;
    expect(() => parseBatchManifest(JSON.stringify(missingSelfCheck)))
      .toThrow(/batchScopeOnly.*missing.*dependency/i);

    const countDrift = productionManifestFixture();
    const countMap = (countDrift.counts as { byCorpusSlice: Record<string, number> }).byCorpusSlice;
    countMap['s33-au-ke-heldout'] += 1;
    expect(() => parseBatchManifest(JSON.stringify(countDrift)))
      .toThrow(/byCorpusSlice.*reconcile/i);

    const kenyaOrderDrift = productionManifestFixture();
    (kenyaOrderDrift.kenyaEntryIds as string[]).reverse();
    expect(() => parseBatchManifest(JSON.stringify(kenyaOrderDrift)))
      .toThrow(/Kenya.*order/i);
  });

  it('rejects internally reconciled attempts to shrink or substitute the exact Wave-1 universe', () => {
    const shrunken = productionManifestFixture();
    const entries = shrunken.entries as ProductionManifestFixtureEntry[];
    const removed = entries.splice(entries.findIndex(({ id }) => id === 'GD-S33-NUR-012'), 1)[0];
    shrunken.entryCount = 80;
    const counts = shrunken.counts as {
      byDomain: Record<string, number>;
      byCredentialType: Record<string, number>;
      byCorpusSlice: Record<string, number>;
    };
    counts.byDomain[removed.domain] -= 1;
    counts.byCredentialType[removed.credentialType] -= 1;
    counts.byCorpusSlice[CORPUS_SLICE_BY_DOMAIN[removed.domain]] -= 1;
    ((shrunken.selfChecks as Record<string, unknown>)
      .exactCorpusManifestDatasheetBijection as Record<string, unknown>).entryCount = 80;
    expect(() => parseBatchManifest(JSON.stringify(shrunken)))
      .toThrow(/exact Wave-1.*81|81-entry Wave-1/i);

    const substitutedKenya = productionManifestFixture();
    const kenyaEntries = substitutedKenya.entries as ProductionManifestFixtureEntry[];
    kenyaEntries.find(({ id }) => id === 'GD-S33-KE-011')!.id = 'GD-S33-KE-012';
    (substitutedKenya.kenyaEntryIds as string[])[10] = 'GD-S33-KE-012';
    expect(() => parseBatchManifest(JSON.stringify(substitutedKenya)))
      .toThrow(/exact Wave-1 Kenya.*11|Kenya.*exact/i);

    const substitutedOod = productionManifestFixture();
    const oodEntries = substitutedOod.entries as ProductionManifestFixtureEntry[];
    oodEntries.find(({ id }) => id === 'GD-S33-OOD-009')!.id = 'GD-S33-OOD-010';
    const oodSemantics = ((substitutedOod.selfChecks as Record<string, unknown>)
      .oodFiveFieldSemantics as { entryIds: string[] });
    oodSemantics.entryIds[8] = 'GD-S33-OOD-010';
    expect(() => parseBatchManifest(JSON.stringify(substitutedOod)))
      .toThrow(/exact Wave-1 OOD.*9|OOD.*exact/i);
  });

  it('rejects duplicate JSON keys and unknown nested manifest fields', () => {
    const duplicate = manifestContent().replace('"revision": 9,', '"revision": 9,\n  "revision": 9,');
    expect(() => parseBatchManifest(duplicate)).toThrow(/duplicate.*revision/i);
    const withUnknown = manifestContent({
      entries: Array.from({ length: 6 }, (_, index) => ({
        id: `GD-S33-${String(index + 1).padStart(3, '0')}`,
        domain: 'professional-licensing',
        credentialType: 'LICENSE',
        normalizedInputSha256: sha256(`entry-${index + 1}`),
        reviewerOverride: true,
      })),
    });
    expect(() => parseBatchManifest(withUnknown)).toThrow(/unknown.*reviewerOverride/i);
  });

  it('rejects incomplete revision history and false or incomplete declared Wave-1 sets', () => {
    const incompleteHistory = productionManifestFixture();
    const history = ((incompleteHistory.selfChecks as Record<string, unknown>)
      .authorizedDocumentRevisions as { revisions: unknown[] }).revisions;
    history.splice(3, 1);
    expect(() => parseBatchManifest(JSON.stringify(incompleteHistory)))
      .toThrow(/revision history.*contiguous|revisions.*2.*9/i);

    const fabricatedScope = productionManifestFixture();
    const scope = ((fabricatedScope.selfChecks as Record<string, unknown>)
      .batchScopeOnly as { protocolAllowedDiffPaths: string[] });
    scope.protocolAllowedDiffPaths[0] = 'docs/lane4/fabricated-datasheet.md';
    expect(() => parseBatchManifest(JSON.stringify(fabricatedScope)))
      .toThrow(/protocolAllowedDiffPaths.*complete.*scope|six-path/i);

    const falseTaxonomy = productionManifestFixture();
    const taxonomy = ((falseTaxonomy.selfChecks as Record<string, unknown>)
      .taxonomyAdjudicationSet as { entryIds: string[] });
    taxonomy.entryIds[0] = 'GD-S33-KE-004';
    expect(() => parseBatchManifest(JSON.stringify(falseTaxonomy)))
      .toThrow(/taxonomy.*complete.*set/i);

    const missingIssuedDate = productionManifestFixture();
    const issuedDate = ((missingIssuedDate.selfChecks as Record<string, unknown>)
      .issuedDateAdjudicationSet as { entryIds: string[] });
    issuedDate.entryIds.pop();
    expect(() => parseBatchManifest(JSON.stringify(missingIssuedDate)))
      .toThrow(/issuedDate.*complete.*set/i);

    const extraOverlapPair = productionManifestFixture();
    const pairScores = ((extraOverlapPair.selfChecks as Record<string, unknown>)
      .withinTypeTokenOverlap as { remediatedPairScores: unknown[] }).remediatedPairScores;
    pairScores.push({
      leftId: 'GD-S33-KE-001', rightId: 'GD-S33-KE-002', credentialType: 'LICENSE', overlap: 0.1,
    });
    expect(() => parseBatchManifest(JSON.stringify(extraOverlapPair)))
      .toThrow(/remediated.*pair.*complete.*set/i);

    const nearThreshold = productionManifestFixture();
    ((nearThreshold.selfChecks as Record<string, unknown>)
      .withinTypeTokenOverlap as { threshold: number }).threshold = 0.8000000000000002;
    expect(() => parseBatchManifest(JSON.stringify(nearThreshold)))
      .toThrow(/overlap threshold must be 0\.8/i);
  });

  it('rejects every one-field mutation of the exact r2-r9 revision-history contract', () => {
    type JsonPath = Array<string | number>;
    const base = productionManifestFixture();
    const authoritative = ((base.selfChecks as Record<string, unknown>)
      .authorizedDocumentRevisions as Record<string, unknown>);
    const leaves: JsonPath[] = [];
    const collectLeaves = (value: unknown, path: JsonPath): void => {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => collectLeaves(entry, [...path, index]));
      } else if (value !== null && typeof value === 'object') {
        Object.entries(value as Record<string, unknown>)
          .forEach(([key, entry]) => collectLeaves(entry, [...path, key]));
      } else {
        leaves.push(path);
      }
    };
    collectLeaves(authoritative, []);

    for (const path of leaves) {
      const mutated = structuredClone(base);
      let target = ((mutated.selfChecks as Record<string, unknown>)
        .authorizedDocumentRevisions as Record<string, unknown> | unknown[]);
      for (const segment of path.slice(0, -1)) {
        target = (target as Record<string | number, Record<string, unknown> | unknown[]>)[segment];
      }
      const leaf = path.at(-1)!;
      const current = (target as Record<string | number, unknown>)[leaf];
      let replacement: unknown;
      if (typeof current === 'boolean') {
        replacement = !current;
      } else if (typeof current === 'number') {
        replacement = current + 1;
      } else if (typeof current === 'string' && current.startsWith('GD-S33-')) {
        replacement = current === 'GD-S33-KE-001' ? 'GD-S33-KE-002' : 'GD-S33-KE-001';
      } else if (typeof current === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(current)) {
        replacement = (current.startsWith('a') ? 'b' : 'a').repeat(current.length);
      } else {
        replacement = `${String(current)} [mutated]`;
      }
      (target as Record<string | number, unknown>)[leaf] = replacement;
      expect.soft(
        () => parseBatchManifest(JSON.stringify(mutated)),
        `mutation at authorizedDocumentRevisions.${path.join('.')}`,
      ).toThrow();
    }
  });

  it.each([39, 41, 63, 65])(
    'rejects a %i-character Git declaration before any ceremony record is written',
    (length) => {
      const malformed = productionManifestFixture();
      (malformed.corpusSourceBlobs as Record<string, string>)[WAVE1_SOURCE_PATHS[0]] = 'a'.repeat(length);
      expect(() => parseBatchManifest(JSON.stringify(malformed)))
      .toThrow(/corpusSourceBlobs.*exact hexadecimal Git object/i);
    },
  );

  it('durably records commitment < freeze < policy < reveal < verification and selects the fixed floor', async () => {
    const context = ceremony();
    recordThroughReveal(context);
    const result = await context.orchestrator.selectAndConsumeSample({
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    });

    expect(result.sampleEntryIds).toHaveLength(9);
    expect(new Set(result.sampleEntryIds)).toHaveLength(9);
    expect(result.evidence.durableSequence).toEqual([
      'salt-commitment-recorded',
      'manifest-freeze-recorded',
      'selection-policy-recorded',
      'salt-reveal-recorded',
      'selection-consumed',
    ]);
    expect(result.evidence.freezeCommitSha).toBe(context.repo.freezeCommitSha);
    const ledger = readFileSync(join(context.evidenceRoot, 'acceptance-ledger.jsonl'), 'utf8');
    expect(ledger.trim().split('\n')).toHaveLength(5);
  });

  it('keeps the signed salt commitment strictly manifest-free', () => {
    const context = ceremony();
    const poisonedPayload = {
      ...context.commitment.object.payload,
      manifestSha256: rawManifestHash(context.manifest),
    };
    const poisoned = signedArtifact(poisonedPayload, context.privateKey);
    expect(() => context.orchestrator.recordSaltCommitment(poisoned.content))
      .toThrow(/manifest-free|unknown.*manifestSha256/i);
  });

  it('strict-parses signed artifacts and rejects duplicate or unknown nested fields', () => {
    const context = ceremony();
    const duplicate = context.commitment.content.replace(
      '"commitmentId": "S33-W1-commitment-1",',
      '"commitmentId": "S33-W1-commitment-1",\n    "commitmentId": "S33-W1-commitment-1",',
    );
    expect(() => context.orchestrator.recordSaltCommitment(duplicate)).toThrow(/duplicate.*commitmentId/i);
    const nestedUnknown = signedArtifact({
      ...context.commitment.object.payload,
      saltCommitment: {
        ...context.commitment.object.payload.saltCommitment,
        operatorOverride: true,
      },
    }, context.privateKey);
    expect(() => context.orchestrator.recordSaltCommitment(nestedUnknown.content))
      .toThrow(/unknown.*operatorOverride/i);
  });

  it('rejects freeze or reveal when durable predecessor records do not exist', () => {
    const context = ceremony();
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.manifest))
      .toThrow(/commitment.*durably recorded/i);
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    expect(() => context.orchestrator.recordSaltReveal(context.revealContent))
      .toThrow(/freeze|policy.*durably recorded/i);
  });

  it('rejects a reveal that does not open the durably recorded signed commitment', () => {
    const context = ceremony();
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    context.orchestrator.recordManifestFreeze(context.freeze.content, context.manifest);
    context.orchestrator.recordSelectionPolicy(context.policy.content);
    expect(() => context.orchestrator.recordSaltReveal(JSON.stringify({
      ...context.reveal,
      salt: '22'.repeat(32),
    }))).toThrow(/does not match.*durably recorded.*commitment/i);
  });

  it('verifies the frozen Git blob and ancestor relation, not asserted timestamps alone', () => {
    const context = ceremony();
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    const wrongCommit = signedArtifact<ManifestFreezePayload>({
      ...context.freeze.object.payload,
      gitEvidence: {
        ...context.freeze.object.payload.gitEvidence,
        freezeCommitSha: '00'.repeat(20),
      },
    }, context.privateKey);
    expect(() => context.orchestrator.recordManifestFreeze(wrongCommit.content, context.manifest))
      .toThrow(/git|commit|ancestor/i);
  });

  it('ignores PATH shadowing and Git-environment redirection at the freeze trust boundary', () => {
    const context = ceremony();
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    const hostileBin = mkdtempSync(join(tmpdir(), 'arkova-s33-hostile-path-'));
    tempRoots.push(hostileBin);
    const hostileGit = join(hostileBin, 'git');
    writeFileSync(hostileGit, '#!/bin/sh\nexit 97\n', 'utf8');
    chmodSync(hostileGit, 0o755);
    const hostileEnvironment = {
      PATH: hostileBin,
      GIT_DIR: join(hostileBin, 'attacker-git-dir'),
      GIT_WORK_TREE: join(hostileBin, 'attacker-work-tree'),
      GIT_OBJECT_DIRECTORY: join(hostileBin, 'attacker-object-directory'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(hostileBin, 'attacker-alternate-objects'),
      GIT_CONFIG_GLOBAL: join(hostileBin, 'attacker-global-config'),
      GIT_CONFIG_SYSTEM: join(hostileBin, 'attacker-system-config'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.bare',
      GIT_CONFIG_VALUE_0: 'true',
    } as const;
    const originalEnvironment = Object.fromEntries(
      Object.keys(hostileEnvironment).map((key) => [key, process.env[key]]),
    );
    try {
      Object.assign(process.env, hostileEnvironment);
      expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.manifest))
        .not.toThrow();
    } finally {
      for (const [key, value] of Object.entries(originalEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('ignores repository-local replacement refs for every signed Git object lookup', () => {
    const context = ceremony();
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    const predecessorCommit = execFileSync('git', [
      'rev-parse', `${context.repo.freezeCommitSha}^`,
    ], { cwd: context.repo.root, encoding: 'utf8' }).trim();
    execFileSync('git', [
      'replace', context.repo.freezeCommitSha, predecessorCommit,
    ], { cwd: context.repo.root });

    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.manifest))
      .not.toThrow();
  });

  it('rejects a mixed-chain reveal before it can poison a valid commitment', () => {
    const context = ceremony();
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    context.orchestrator.recordManifestFreeze(context.freeze.content, context.manifest);
    context.orchestrator.recordSelectionPolicy(context.policy.content);

    const secondSalt = '22'.repeat(32);
    const secondCommitment = signedArtifact<SaltCommitmentPayload>({
      ...context.commitment.object.payload,
      commitmentId: 'S33-W1-commitment-2',
      signedAtUtc: '2026-07-13T13:04:00.000Z',
      saltCommitment: { algorithm: 'sha256', value: sha256(secondSalt) },
    }, context.privateKey);
    const secondFreeze = signedArtifact<ManifestFreezePayload>({
      ...context.freeze.object.payload,
      freezeId: 'S33-W1-r9-freeze-2',
      signedAtUtc: '2026-07-13T13:05:00.000Z',
      commitmentArtifactCanonicalSha256: canonicalManifestHash(secondCommitment.content),
    }, context.privateKey);
    const secondPolicy = signedArtifact<SelectionPolicyPayload>({
      ...context.policy.object.payload,
      policyId: 'S33-W1-r9-selection-2',
      signedAtUtc: '2026-07-13T13:06:00.000Z',
      commitmentArtifactCanonicalSha256: canonicalManifestHash(secondCommitment.content),
      freezeArtifactCanonicalSha256: canonicalManifestHash(secondFreeze.content),
    }, context.privateKey);
    context.orchestrator.recordSaltCommitment(secondCommitment.content);
    context.orchestrator.recordManifestFreeze(secondFreeze.content, context.manifest);
    context.orchestrator.recordSelectionPolicy(secondPolicy.content);

    expect(() => context.orchestrator.recordSaltReveal(JSON.stringify({
      ...context.reveal,
      revealId: 'S33-W1-r9-mixed-reveal',
      freezeArtifactCanonicalSha256: canonicalManifestHash(secondFreeze.content),
      policyArtifactCanonicalSha256: canonicalManifestHash(secondPolicy.content),
    }))).toThrow(/same authenticated commitment.*freeze.*policy|mixed ceremony chain/i);

    expect(() => context.orchestrator.recordSaltReveal(context.revealContent)).not.toThrow();
  });

  it('binds the freeze parent, support ancestry, and every declared source blob to Git truth', () => {
    const zeroParent = ceremony((manifest) => {
      const zero = '0'.repeat(40);
      manifest.corpusRevisionParentCommit = zero;
      manifest.producerRevisionPredecessorCommit = zero;
      const revisions = (((manifest.selfChecks as Record<string, unknown>)
        .authorizedDocumentRevisions as { revisions: Array<Record<string, unknown>> }).revisions);
      revisions.at(-1)!.producerRevisionPredecessorCommit = zero;
    });
    zeroParent.orchestrator.recordSaltCommitment(zeroParent.commitment.content);
    expect(() => zeroParent.orchestrator.recordManifestFreeze(zeroParent.freeze.content, zeroParent.manifest))
      .toThrow(/predecessor|parent.*Git|missing.*commit/i);

    const foreignSupport = ceremony((manifest) => {
      const foreign = 'f'.repeat(40);
      const support = manifest.lane3SupportBase as Record<string, unknown>;
      support.commit = foreign;
      const selfChecks = manifest.selfChecks as Record<string, unknown>;
      const dependency = (selfChecks.batchScopeOnly as { dependency: Record<string, unknown> }).dependency;
      dependency.commit = foreign;
      const revisions = (selfChecks.authorizedDocumentRevisions as {
        revisions: Array<Record<string, unknown>>;
      }).revisions;
      revisions[5].directBaseCommit = foreign;
      revisions[6].lane3SupportBaseCommit = foreign;
      revisions.at(-1)!.lane3SupportBaseCommit = foreign;
    });
    foreignSupport.orchestrator.recordSaltCommitment(foreignSupport.commitment.content);
    expect(() => foreignSupport.orchestrator.recordManifestFreeze(foreignSupport.freeze.content, foreignSupport.manifest))
      .toThrow(/support.*commit|support.*ancestor|missing.*Git/i);

    const foreignBlob = ceremony((manifest) => {
      const support = manifest.lane3SupportBase as { typesBlob: string };
      (manifest.corpusSourceBlobs as Record<string, string>)[WAVE1_SOURCE_PATHS[0]] = support.typesBlob;
    });
    foreignBlob.orchestrator.recordSaltCommitment(foreignBlob.commitment.content);
    expect(() => foreignBlob.orchestrator.recordManifestFreeze(foreignBlob.freeze.content, foreignBlob.manifest))
      .toThrow(/source blob.*does not match|blob.*path/i);
  });

  it.each([
    ['a seventh path', {
      mutateFreezeTree(root: string): void {
        writeFileSync(join(root, 'docs/lane4/seventh-path.txt'), 'not authorized\n', 'utf8');
      },
    }],
    ['a copy from an unchanged support-tree source', {
      setupSupport(root: string): void {
        mkdirSync(join(root, 'docs/lane4'), { recursive: true });
        writeFileSync(join(root, 'docs/lane4/unchanged-copy-source.md'), '# Corpus datasheet\n', 'utf8');
      },
    }],
    ['a deletion', {
      setupSupport(root: string): void {
        mkdirSync(join(root, 'docs/lane4'), { recursive: true });
        writeFileSync(join(root, 'docs/lane4/support-only.txt'), 'must not be deleted\n', 'utf8');
      },
      mutateFreezeTree(root: string): void {
        rmSync(join(root, 'docs/lane4/support-only.txt'));
      },
    }],
    ['a rename', {
      setupSupport(root: string): void {
        mkdirSync(join(root, 'docs/lane4'), { recursive: true });
        writeFileSync(join(root, 'docs/lane4/pre-rename.txt'), 'renamed content\n', 'utf8');
      },
      mutateFreezeTree(root: string): void {
        renameSync(
          join(root, 'docs/lane4/pre-rename.txt'),
          join(root, 'docs/lane4/post-rename.txt'),
        );
      },
    }],
    ['an executable mode', {
      mutateFreezeTree(root: string): void {
        chmodSync(join(root, 'docs/lane4/s33-corpus-datasheet.md'), 0o755);
      },
    }],
    ['a symbolic-link mode', {
      mutateFreezeTree(root: string): void {
        const path = join(root, 'docs/lane4/s33-corpus-datasheet.md');
        rmSync(path);
        symlinkSync('s33-wave1-batch-manifest.json', path);
      },
    }],
    ['a submodule/gitlink mode', {
      mutateFreezeIndex(root: string, predecessorCommit: string): void {
        execFileSync('git', [
          'update-index', '--add', '--cacheinfo', '160000', predecessorCommit,
          'docs/lane4/s33-corpus-datasheet.md',
        ], { cwd: root });
      },
    }],
  ] satisfies Array<[string, GitFixtureMutation]>)('rejects a support-to-freeze diff containing %s', (
    _case,
    mutateGit,
  ) => {
    const context = ceremony(undefined, mutateGit);
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.manifest))
      .toThrow(/producer diff|six authorized paths|status|mode|rename|deletion/i);
  });

  it('atomically consumes each policy/batch/revision once across contenders', async () => {
    const context = ceremony();
    recordThroughReveal(context);
    const input = {
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    };
    const contender = createTestOnlyS33AcceptanceOrchestrator({
      trustRoot: context.trustRoot,
      consumptionRegistry: context.consumptionRegistry,
      ledgerPath: join(context.evidenceRoot, 'acceptance-ledger.jsonl'),
      repositoryRoot: context.repo.root,
      repositoryIdentity: 'test/ArkovaCarson',
      verificationCommitSha: context.repo.verificationCommitSha,
    });
    const attempts = await Promise.allSettled([
      context.orchestrator.selectAndConsumeSample(input),
      contender.selectAndConsumeSample(input),
    ]);
    expect(attempts.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const winner = attempts.find((attempt) => attempt.status === 'fulfilled');
    expect(winner?.status === 'fulfilled' ? winner.value.sampleEntryIds : []).toHaveLength(9);
    expect(context.consumptionRegistry.keys.size).toBe(1);
  });

  it('binds raw bytes separately from canonical content before consuming a registry key', async () => {
    const context = ceremony();
    recordThroughReveal(context);
    const rawVariant = `${context.commitment.content}\n`;
    expect(canonicalManifestHash(rawVariant)).toBe(canonicalManifestHash(context.commitment.content));
    expect(rawManifestHash(rawVariant)).not.toBe(rawManifestHash(context.commitment.content));
    await expect(context.orchestrator.selectAndConsumeSample({
      manifestContent: context.manifest,
      commitmentArtifactContent: rawVariant,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    })).rejects.toThrow(/raw artifact bytes.*transcript/i);
    expect(context.consumptionRegistry.keys.size).toBe(0);
  });

  it('fails closed when the append-only ledger hash chain is modified', () => {
    const context = ceremony();
    context.orchestrator.recordSaltCommitment(context.commitment.content);
    const ledgerPath = join(context.evidenceRoot, 'acceptance-ledger.jsonl');
    const tampered = readFileSync(ledgerPath, 'utf8').replace('commitment-1', 'commitment-X');
    writeFileSync(ledgerPath, tampered, 'utf8');
    expect(() => context.orchestrator.recordManifestFreeze(context.freeze.content, context.manifest))
      .toThrow(/transcript|digest|tamper/i);
  });

  it('rejects an adversarial transcript symlink swap and permissive file mode', () => {
    const swapped = ceremony();
    swapped.orchestrator.recordSaltCommitment(swapped.commitment.content);
    const swappedPath = join(swapped.evidenceRoot, 'acceptance-ledger.jsonl');
    const originalPath = join(swapped.evidenceRoot, 'acceptance-ledger-original.jsonl');
    renameSync(swappedPath, originalPath);
    symlinkSync(originalPath, swappedPath);
    expect(() => swapped.orchestrator.recordManifestFreeze(swapped.freeze.content, swapped.manifest))
      .toThrow(/symbolic|regular file|nofollow/i);

    const parentSwapped = ceremony();
    parentSwapped.orchestrator.recordSaltCommitment(parentSwapped.commitment.content);
    const originalDirectory = `${parentSwapped.evidenceRoot}-original`;
    const attackerDirectory = `${parentSwapped.evidenceRoot}-attacker`;
    tempRoots.push(originalDirectory, attackerDirectory);
    const validTranscript = readFileSync(
      join(parentSwapped.evidenceRoot, 'acceptance-ledger.jsonl'),
      'utf8',
    );
    renameSync(parentSwapped.evidenceRoot, originalDirectory);
    mkdirSync(attackerDirectory, { mode: 0o700 });
    writeFileSync(join(attackerDirectory, 'acceptance-ledger.jsonl'), validTranscript, { mode: 0o600 });
    symlinkSync(attackerDirectory, parentSwapped.evidenceRoot, 'dir');
    expect(() => parentSwapped.orchestrator.recordManifestFreeze(
      parentSwapped.freeze.content,
      parentSwapped.manifest,
    )).toThrow(/containment|directory/i);

    const permissive = ceremony();
    permissive.orchestrator.recordSaltCommitment(permissive.commitment.content);
    chmodSync(join(permissive.evidenceRoot, 'acceptance-ledger.jsonl'), 0o644);
    expect(() => permissive.orchestrator.recordManifestFreeze(permissive.freeze.content, permissive.manifest))
      .toThrow(/permissions|mode|0600/i);
  });

  it('rejects transcript hard links and non-regular replacements', () => {
    const hardLinked = ceremony();
    hardLinked.orchestrator.recordSaltCommitment(hardLinked.commitment.content);
    const hardLinkedPath = join(hardLinked.evidenceRoot, 'acceptance-ledger.jsonl');
    linkSync(hardLinkedPath, join(hardLinked.evidenceRoot, 'acceptance-ledger-alias.jsonl'));
    expect(() => hardLinked.orchestrator.recordManifestFreeze(hardLinked.freeze.content, hardLinked.manifest))
      .toThrow(/exactly one filesystem link|hard.?link/i);

    const nonRegular = ceremony();
    nonRegular.orchestrator.recordSaltCommitment(nonRegular.commitment.content);
    const nonRegularPath = join(nonRegular.evidenceRoot, 'acceptance-ledger.jsonl');
    renameSync(nonRegularPath, `${nonRegularPath}.original`);
    mkdirSync(nonRegularPath, { mode: 0o600 });
    expect(() => nonRegular.orchestrator.recordManifestFreeze(nonRegular.freeze.content, nonRegular.manifest))
      .toThrow(/regular file/i);
  });

  it('gives a fail-closed stale-lock recovery procedure without altering the transcript', () => {
    const context = ceremony();
    writeFileSync(join(context.evidenceRoot, 'acceptance-ledger.jsonl.lock'), '999999\n', { mode: 0o600 });
    expect(() => context.orchestrator.recordSaltCommitment(context.commitment.content))
      .toThrow(/confirm.*process.*not running.*remove only.*\.lock.*never.*transcript/i);
  });

  it('retires the legacy signer/registry production factory in favor of GitHub/CI evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'arkova-s33-production-'));
    tempRoots.push(root);
    expect(() => createProductionS33AcceptanceOrchestrator({
      ledgerPath: join(root, 'ledger.jsonl'),
      repositoryRoot: root,
      verificationCommitSha: '00'.repeat(20),
    })).toThrow(/retired.*CTO ruling 102498305.*GitHub\/CI-bound/i);
  });

  it('parses the complete 81-entry Wave-1 universe and cannot lower its fixed sample floor', async () => {
    const context = ceremony();
    recordThroughReveal(context);
    await expect(context.orchestrator.selectAndConsumeSample({
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
      sampleRatio: 0.01,
      entryIds: ['GD-S33-001'],
    } as never)).rejects.toThrow(/unknown caller controls.*sampleRatio.*entryIds/i);
    const result = await context.orchestrator.selectAndConsumeSample({
      manifestContent: context.manifest,
      commitmentArtifactContent: context.commitment.content,
      freezeArtifactContent: context.freeze.content,
      policyArtifactContent: context.policy.content,
      revealContent: context.revealContent,
    });
    expect(result.sampleEntryIds).toHaveLength(9);
    expect(parseBatchManifest(context.manifest).entries).toHaveLength(81);
  });
});

function lexicalTextArtifact(
  role: 'heldout' | 'corpus',
  records: Array<{ id: string; text: string }>,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    algorithmVersion: 's33-lexical-text-artifact-v1',
    artifactId: `S33-${role}-1`,
    role,
    records: records.map(({ id, text }) => ({ id, text, contentSha256: sha256(text) })),
  }, null, 2);
}

describe('S3.3 authenticated lexical scan boundary', () => {
  it('loads authenticated text artifacts and recomputes n=6..13 before verdict', () => {
    const context = ceremony();
    const heldout = lexicalTextArtifact('heldout', [{
      id: 'KE-001',
      text: 'Nursing Council registration certificate for a licensed practitioner in Nairobi County',
    }]);
    const corpus = lexicalTextArtifact('corpus', [{
      id: 'training/example:4',
      text: 'A nursing council registration certificate for a licensed practitioner in Nairobi County was supplied',
    }]);
    const policy = signedArtifact<LexicalLeakagePolicyPayload>({
      artifactType: 'arkova-s33-lexical-leakage-policy',
      artifactVersion: '1.0.0',
      policyId: 'S33-lexical-policy-test-1',
      signerIdentity: 'Arkova CTO',
      signingKeyId: 'cto-policy-test-key-1',
      signedAtUtc: '2026-07-13T13:00:00.000Z',
      metricAlgorithmVersion: 'token-set-ngram-v1',
      heldoutArtifactId: 'S33-heldout-1',
      heldoutArtifactRawSha256: rawManifestHash(heldout),
      heldoutArtifactCanonicalSha256: canonicalManifestHash(heldout),
      corpusArtifactId: 'S33-corpus-1',
      corpusArtifactRawSha256: rawManifestHash(corpus),
      corpusArtifactCanonicalSha256: canonicalManifestHash(corpus),
      normalization: {
        unicodeForm: 'NFKC',
        caseFold: 'lowercase',
        nonAlphanumeric: 'space',
        whitespace: 'collapse',
      },
      allowedN: [6, 7, 8, 9, 10, 11, 12, 13],
      minimumSharedNgrams: 3,
      minimumHeldoutContainment: 0.5,
      combination: 'all',
    }, context.privateKey);
    const result = context.orchestrator.scanAuthenticatedLexicalLeakage({
      heldoutArtifactContent: heldout,
      corpusArtifactContent: corpus,
      policyArtifactContent: policy.content,
    });
    expect(result.metrics).toHaveLength(8);
    expect(result.hits.some((hit) => hit.n === 6)).toBe(true);
    expect(result.evidence.metricAlgorithmVersion).toBe('token-set-ngram-v1');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.metrics)).toBe(true);
    expect(Object.isFrozen(result.metrics[0])).toBe(true);
    expect(Object.isFrozen(result.hits)).toBe(true);
    expect(Object.isFrozen(result.hits[0])).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(() => (result.metrics as unknown[]).pop()).toThrow(TypeError);
    expect(() => {
      (result.evidence as { metricCount: number }).metricCount = 0;
    }).toThrow(TypeError);
    const duplicateHeldout = heldout.replace('"id": "KE-001",', '"id": "KE-001",\n      "id": "KE-001",');
    expect(() => context.orchestrator.scanAuthenticatedLexicalLeakage({
      heldoutArtifactContent: duplicateHeldout,
      corpusArtifactContent: corpus,
      policyArtifactContent: policy.content,
    })).toThrow(/duplicate.*id/i);
  });

  it('has no public policy-only API and rejects a complete fabricated all-zero matrix', () => {
    expect(acceptanceModule).not.toHaveProperty('applyLexicalLeakagePolicy');
    expect(acceptanceModule).not.toHaveProperty('computeLexicalLeakageMetrics');
    const context = ceremony();
    const heldout = lexicalTextArtifact('heldout', [{ id: 'H', text: 'one two three four five six seven eight' }]);
    const corpus = lexicalTextArtifact('corpus', [{ id: 'C', text: 'one two three four five six seven eight' }]);
    const policy = signedArtifact<LexicalLeakagePolicyPayload>({
      artifactType: 'arkova-s33-lexical-leakage-policy',
      artifactVersion: '1.0.0',
      policyId: 'S33-lexical-policy-test-2',
      signerIdentity: 'Arkova CTO',
      signingKeyId: 'cto-policy-test-key-1',
      signedAtUtc: '2026-07-13T13:00:00.000Z',
      metricAlgorithmVersion: 'token-set-ngram-v1',
      heldoutArtifactId: 'S33-heldout-1',
      heldoutArtifactRawSha256: rawManifestHash(heldout),
      heldoutArtifactCanonicalSha256: canonicalManifestHash(heldout),
      corpusArtifactId: 'S33-corpus-1',
      corpusArtifactRawSha256: rawManifestHash(corpus),
      corpusArtifactCanonicalSha256: canonicalManifestHash(corpus),
      normalization: { unicodeForm: 'NFKC', caseFold: 'lowercase', nonAlphanumeric: 'space', whitespace: 'collapse' },
      allowedN: [6, 7, 8, 9, 10, 11, 12, 13],
      minimumSharedNgrams: 1,
      minimumHeldoutContainment: 0.1,
      combination: 'all',
    }, context.privateKey);
    const fabricated = Array.from({ length: 8 }, (_, index) => ({
      heldoutId: 'H', corpusId: 'C', n: index + 6,
      heldoutNgrams: 0, corpusNgrams: 0, sharedNgrams: 0,
      heldoutContainment: 0, jaccard: 0,
    }));
    expect(() => context.orchestrator.scanAuthenticatedLexicalLeakage({
      heldoutArtifactContent: heldout,
      corpusArtifactContent: corpus,
      policyArtifactContent: policy.content,
      metrics: fabricated,
    } as never)).toThrow(/unknown.*metrics|precomputed.*not accepted/i);
  });

  it('rejects text-content hash or signed artifact binding mismatches', () => {
    const context = ceremony();
    const heldout = lexicalTextArtifact('heldout', [{ id: 'H', text: 'one two three four five six' }]);
    const corpusObject = JSON.parse(lexicalTextArtifact('corpus', [{ id: 'C', text: 'one two three four five six' }])) as {
      records: Array<{ text: string }>;
    };
    corpusObject.records[0].text = 'tampered text with unchanged content hash';
    const corpus = JSON.stringify(corpusObject);
    const policy = signedArtifact<LexicalLeakagePolicyPayload>({
      artifactType: 'arkova-s33-lexical-leakage-policy', artifactVersion: '1.0.0',
      policyId: 'S33-lexical-policy-test-3', signerIdentity: 'Arkova CTO', signingKeyId: 'cto-policy-test-key-1',
      signedAtUtc: '2026-07-13T13:00:00.000Z', metricAlgorithmVersion: 'token-set-ngram-v1',
      heldoutArtifactId: 'S33-heldout-1', heldoutArtifactRawSha256: rawManifestHash(heldout),
      heldoutArtifactCanonicalSha256: canonicalManifestHash(heldout), corpusArtifactId: 'S33-corpus-1',
      corpusArtifactRawSha256: rawManifestHash(corpus), corpusArtifactCanonicalSha256: canonicalManifestHash(corpus),
      normalization: { unicodeForm: 'NFKC', caseFold: 'lowercase', nonAlphanumeric: 'space', whitespace: 'collapse' },
      allowedN: [6, 7, 8, 9, 10, 11, 12, 13], minimumSharedNgrams: 1,
      minimumHeldoutContainment: 0.1, combination: 'all',
    }, context.privateKey);
    expect(() => context.orchestrator.scanAuthenticatedLexicalLeakage({
      heldoutArtifactContent: heldout,
      corpusArtifactContent: corpus,
      policyArtifactContent: policy.content,
    })).toThrow(/content hash/i);
  });
});

describe('S3.3 embedding arithmetic', () => {
  it('clamps harmless floating-point cosine overshoot and reports the exact duplicate', () => {
    const identical = Array.from({ length: 64 }, (_, index) => index + 1);
    const hits = compareEmbeddingLeakage(
      [{ id: 'held', model: 'model-a', vector: identical }],
      [{ id: 'corpus', model: 'model-a', vector: identical }],
      { model: 'model-a', minimumCosineSimilarity: 0.99 },
    );
    expect(hits).toEqual([{
      heldoutId: 'held',
      corpusId: 'corpus',
      model: 'model-a',
      cosineSimilarity: 1,
    }]);
  });

  it('rejects non-finite derived dot/norm/cosine arithmetic', () => {
    expect(() => compareEmbeddingLeakage(
      [{ id: 'held', model: 'model-a', vector: [1e308, 1e308] }],
      [{ id: 'corpus', model: 'model-a', vector: [1e308, 1e308] }],
      { model: 'model-a', minimumCosineSimilarity: 0.9 },
    )).toThrow(/overflow|non-finite|arithmetic/i);
  });

  it('propagates provider failures and rejects incomplete output', async () => {
    const failedProvider: EmbeddingBatchProvider = {
      embed: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    };
    await expect(scanEmbeddingLeakage(
      [{ id: 'held', text: 'held text' }],
      [{ id: 'corpus', text: 'corpus text' }],
      failedProvider,
      { model: 'model-a', minimumCosineSimilarity: 0.9 },
    )).rejects.toThrow(/provider unavailable/i);
  });

  it('marks caller-controlled provider and policy results as diagnostic-only', async () => {
    const provider: EmbeddingBatchProvider = {
      embed: vi.fn(async (records: readonly { id: string; text: string }[], model: string) => records.map(({ id }) => ({
        id,
        model,
        vector: [1, 0],
      }))),
    };
    const result = await scanEmbeddingLeakage(
      [{ id: 'held', text: 'held text' }],
      [{ id: 'corpus', text: 'corpus text' }],
      provider,
      { model: 'model-a', minimumCosineSimilarity: 0.9 },
    );
    expect(result).toMatchObject({
      evidenceGrade: 'diagnostic-untrusted',
      limitations: ['caller-supplied-policy', 'caller-supplied-provider'],
      hits: [{ heldoutId: 'held', corpusId: 'corpus', cosineSimilarity: 1 }],
    });
  });
});

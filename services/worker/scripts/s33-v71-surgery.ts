/**
 * S3.3 v7.1 deterministic dataset surgery (SCRUM-2679).
 *
 * Offline only: this module has no upload, tuning-job, endpoint, or deployment
 * capability. It binds the historical April v7 source, records every row's
 * disposition, and emits deterministic in-memory artifacts for independent
 * review before any separately authorized Vertex operation.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { GOLDEN_DATASET } from '../src/ai/eval/golden-dataset.js';
import { GOLDEN_DATASET_EXTENDED } from '../src/ai/eval/golden-dataset-extended.js';
import { GOLDEN_DATASET_PHASE2 } from '../src/ai/eval/golden-dataset-phase2.js';
import { GOLDEN_DATASET_PHASE3 } from '../src/ai/eval/golden-dataset-phase3.js';
import { GOLDEN_DATASET_PHASE4 } from '../src/ai/eval/golden-dataset-phase4.js';
import { GOLDEN_DATASET_PHASE5 } from '../src/ai/eval/golden-dataset-phase5.js';
import { GOLDEN_DATASET_PHASE6 } from '../src/ai/eval/golden-dataset-phase6.js';
import { GOLDEN_DATASET_PHASE7 } from '../src/ai/eval/golden-dataset-phase7.js';
import { GOLDEN_DATASET_PHASE8 } from '../src/ai/eval/golden-dataset-phase8.js';
import { GOLDEN_DATASET_PHASE9 } from '../src/ai/eval/golden-dataset-phase9.js';
import { GOLDEN_DATASET_PHASE10 } from '../src/ai/eval/golden-dataset-phase10.js';
import { GOLDEN_DATASET_PHASE11 } from '../src/ai/eval/golden-dataset-phase11.js';
import { GOLDEN_DATASET_PHASE12 } from '../src/ai/eval/golden-dataset-phase12.js';
import { GOLDEN_DATASET_PHASE13_FCRA } from '../src/ai/eval/golden-dataset-phase13-fcra.js';
import { GOLDEN_DATASET_PHASE14 } from '../src/ai/eval/golden-dataset-phase14.js';
import { GOLDEN_DATASET_PHASE15 } from '../src/ai/eval/golden-dataset-phase15-reasoning.js';
import { GOLDEN_DATASET_PHASE17 } from '../src/ai/eval/golden-dataset-phase17-expansion.js';
import { GOLDEN_DATASET_PHASE18_V7 } from '../src/ai/eval/golden-dataset-phase18-v7-expansion.js';
import { SUBTYPE_BACKFILL } from '../src/ai/eval/golden-dataset-subtype-backfill.js';
import {
  S33_WAVE3_FROZEN_SUBTYPE_TAXONOMY,
  type S33Wave3SurgeryEvidence,
} from '../src/ai/eval/s33-wave3-deterministic-eval-gates.js';
import type { GoldenDatasetEntry } from '../src/ai/eval/types.js';
import {
  EXTRACTION_V6_SYSTEM_PROMPT,
  buildV6UserPrompt,
} from '../src/ai/prompts/extraction-v6.js';
import { canonicaliseJson } from '../src/utils/canonical-json.js';
import {
  buildDescription,
  buildTargetOutput,
  canonicalizeCredentialType,
} from './enrich-gemini-golden-v6.js';

const EXPECTED_SOURCE_COUNT = 2656;
const EXPECTED_SOURCE_ORDERED_IDS_SHA256 =
  'd7d41cc1a956e9d76cd60ce30f728adde80e854e31ec24df213caf4546a2fa0f';
const EXPECTED_SOURCE_CONTENT_SHA256 =
  '1ee0d9a41c3f5af2e4a00bb76cb43a1cd5ec1cef2d362b8f1cb879ecfddf6e48';
const EXPECTED_ARTIFACT_DIGESTS = Object.freeze({
  dispositionsCanonicalSha256: '96eb79575ca6747c2f97c6d92a68235ad3e6aacdd14f4b6f9206f22223cbdac6',
  retainedTargetsCanonicalSha256: '6a069b6c8eeae631f9c49bdedbbf6ba00476bc7eb519807630f53aca095e6831',
  trainJsonlSha256: 'f9581728f0656cb832afea3d1f1c1796ee3b10c9ed38ef6787f93be27fbe2303',
  validationJsonlSha256: 'a61723ff24864df7717faf1869847153870aed9d51ab200e6dc72b2d499b8d9f',
  fraudSplitJsonlSha256: '216478bca21e62229dc33e23edfc7c671712400f0f7a6feb5b39d693c1e2ca6a',
  unresolvedCanonicalSha256: '08ca3400685cb99b514eadbc21d837e3e65ae094c777e5071f22a9c5b1a281c0',
  manifestCanonicalSha256: '0b7f5dd2c504e9fb0cdd342d575d53f271c90e56d529b87d9b665b70c9fd3b0b',
} as const);
const EXPECTED_ARTIFACT_DIGEST_NAMES: ReadonlyArray<
  keyof typeof EXPECTED_ARTIFACT_DIGESTS
> = [
  'dispositionsCanonicalSha256',
  'retainedTargetsCanonicalSha256',
  'trainJsonlSha256',
  'validationJsonlSha256',
  'fraudSplitJsonlSha256',
  'unresolvedCanonicalSha256',
  'manifestCanonicalSha256',
];
const SPLIT_SEED = 4216;
const MAX_BUDGET_USD = 40;

const S33_V71_FROZEN_ADJUDICATIONS = Object.freeze([{
  id: 'GD-1920',
  credentialType: 'BUSINESS_ENTITY',
  subType: 'corporation',
  basis: 'groundTruth.entityType=Corporation',
  rawSourceMutated: false,
}] as const);

export const S33_V71_TOXIC_FINANCIAL_IDS = Object.freeze(
  Array.from({ length: 15 }, (_, index) => `GD-${3030 + index}`),
);

export const S33_V71_SOURCE_MODULES = Object.freeze([
  { name: 'base', count: GOLDEN_DATASET.length, entries: GOLDEN_DATASET },
  { name: 'extended', count: GOLDEN_DATASET_EXTENDED.length, entries: GOLDEN_DATASET_EXTENDED },
  { name: 'phase2', count: GOLDEN_DATASET_PHASE2.length, entries: GOLDEN_DATASET_PHASE2 },
  { name: 'phase3', count: GOLDEN_DATASET_PHASE3.length, entries: GOLDEN_DATASET_PHASE3 },
  { name: 'phase4', count: GOLDEN_DATASET_PHASE4.length, entries: GOLDEN_DATASET_PHASE4 },
  { name: 'phase5', count: GOLDEN_DATASET_PHASE5.length, entries: GOLDEN_DATASET_PHASE5 },
  { name: 'phase6', count: GOLDEN_DATASET_PHASE6.length, entries: GOLDEN_DATASET_PHASE6 },
  { name: 'phase7', count: GOLDEN_DATASET_PHASE7.length, entries: GOLDEN_DATASET_PHASE7 },
  { name: 'phase8', count: GOLDEN_DATASET_PHASE8.length, entries: GOLDEN_DATASET_PHASE8 },
  { name: 'phase9', count: GOLDEN_DATASET_PHASE9.length, entries: GOLDEN_DATASET_PHASE9 },
  { name: 'phase10', count: GOLDEN_DATASET_PHASE10.length, entries: GOLDEN_DATASET_PHASE10 },
  { name: 'phase11', count: GOLDEN_DATASET_PHASE11.length, entries: GOLDEN_DATASET_PHASE11 },
  { name: 'phase12', count: GOLDEN_DATASET_PHASE12.length, entries: GOLDEN_DATASET_PHASE12 },
  { name: 'phase13-fcra', count: GOLDEN_DATASET_PHASE13_FCRA.length, entries: GOLDEN_DATASET_PHASE13_FCRA },
  { name: 'phase14', count: GOLDEN_DATASET_PHASE14.length, entries: GOLDEN_DATASET_PHASE14 },
  { name: 'phase15', count: GOLDEN_DATASET_PHASE15.length, entries: GOLDEN_DATASET_PHASE15 },
  { name: 'phase17', count: GOLDEN_DATASET_PHASE17.length, entries: GOLDEN_DATASET_PHASE17 },
  { name: 'phase18-v7', count: GOLDEN_DATASET_PHASE18_V7.length, entries: GOLDEN_DATASET_PHASE18_V7 },
] as const);

export const S33_V71_HISTORICAL_SOURCE: readonly GoldenDatasetEntry[] = Object.freeze(
  S33_V71_SOURCE_MODULES.flatMap(({ entries }) => entries),
);

type SubtypeSource = 'ground_truth' | 'backfill' | 'deduced' | 'adjudicated';
type Disposition = 'toxic_dropped' | 'fraud_split' | 'train' | 'validation' | 'unresolved';
const UNRESOLVED_CANDIDATE_SOURCES: ReadonlySet<string> = new Set([
  'ground_truth',
  'backfill',
  'deduced',
]);

export interface S33V71RetainedRow {
  readonly id: string;
  readonly credentialType: string;
  readonly subType: string;
  readonly subtypeSource: SubtypeSource;
  readonly sourceEntry: GoldenDatasetEntry;
  readonly target: Record<string, unknown>;
  readonly vertex: Readonly<{
    systemInstruction: { role: 'system'; parts: Array<{ text: string }> };
    contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>;
  }>;
}

export interface S33V71Disposition {
  readonly id: string;
  readonly disposition: Disposition;
  readonly reason: string;
  readonly credentialType: string;
  readonly subType?: string;
  readonly subtypeSource?: SubtypeSource;
}

interface S33V71UnresolvedRow {
  readonly id: string;
  readonly credentialType: string;
  readonly candidateSubType?: string;
  readonly candidateSubTypes?: readonly string[];
  readonly candidateSource?: 'ground_truth' | 'backfill' | 'deduced';
  readonly reason: string;
}

interface S33V71FraudSplitRow {
  readonly id: string;
  readonly entry: GoldenDatasetEntry;
}

export interface S33V71SurgeryManifest {
  readonly schemaVersion: 'arkova.s33.v71.surgery-manifest/v1';
  readonly artifactType: 'arkova-s33-v71-dataset-surgery';
  readonly algorithmVersion: 's33-v71-unique-candidate-adjudication-v1';
  readonly source: {
    readonly count: 2656;
    readonly orderedModuleCounts: ReadonlyArray<Readonly<{ name: string; count: number }>>;
    readonly orderedIdsSha256: string;
    readonly contentCanonicalSha256: string;
  };
  readonly counts: {
    readonly source: number;
    readonly toxicDropped: number;
    readonly fraudSplit: number;
    readonly retained: number;
    readonly unresolved: number;
    readonly train: number;
    readonly validation: number;
  };
  readonly subtypeSources: Record<SubtypeSource, number>;
  readonly split: {
    readonly algorithm: 'lcg-fisher-yates';
    readonly seed: 4216;
    readonly validationRatio: 0.1;
  };
  readonly adjudications: typeof S33_V71_FROZEN_ADJUDICATIONS;
  readonly toxicDroppedIds: readonly string[];
  readonly fraudArtifactSubmissionEligible: false;
  readonly additiveOrGeneratedRows: 0;
  readonly heldoutIdNamespaceRows: 0;
  readonly heldoutLeakageScanStatus: 'NOT_RUN_AUTHENTICATION_HOLD';
  readonly digests: {
    readonly sourceOrderedIdsSha256: string;
    readonly sourceContentCanonicalSha256: string;
    readonly dispositionsCanonicalSha256: string;
    readonly retainedTargetsCanonicalSha256: string;
    readonly trainJsonlSha256: string;
    readonly validationJsonlSha256: string;
    readonly fraudSplitJsonlSha256: string;
    readonly unresolvedCanonicalSha256: string;
    readonly manifestCanonicalSha256: string;
  };
}

export interface S33V71SurgeryResult {
  readonly manifest: S33V71SurgeryManifest;
  readonly dispositions: readonly S33V71Disposition[];
  readonly toxicDroppedRows: readonly GoldenDatasetEntry[];
  readonly fraudSplitRows: readonly S33V71FraudSplitRow[];
  readonly unresolvedRows: readonly S33V71UnresolvedRow[];
  readonly retainedRows: readonly S33V71RetainedRow[];
  readonly trainRows: readonly S33V71RetainedRow[];
  readonly validationRows: readonly S33V71RetainedRow[];
  readonly trainJsonl: string;
  readonly validationJsonl: string;
  readonly fraudSplitJsonl: string;
  readonly surgeryEvidence: S33Wave3SurgeryEvidence;
}

export interface S33V71OfflineArtifactIndex {
  readonly schemaVersion: 'arkova.s33.v71.offline-artifact-index/v1';
  readonly submissionEligible: false;
  readonly sourceManifestCanonicalSha256: string;
  readonly counts: S33V71SurgeryManifest['counts'];
  readonly files: Readonly<Record<string, Readonly<{
    sha256: string;
    bytes: number;
  }>>>;
}

export interface S33V71TuningRequestTemplate {
  readonly schemaVersion: 'arkova.s33.v71.tuning-request-template/v1';
  readonly project: 'arkova1';
  readonly location: 'us-central1';
  readonly maxBudgetUsd: 40;
  readonly submissionAuthorized: false;
  readonly admission: 'HOLD';
  readonly holdReasons: readonly string[];
  readonly exportManifestCanonicalSha256: string;
  readonly request: {
    readonly baseModel: 'gemini-2.5-flash';
    readonly tunedModelDisplayName: 'arkova-gemini-golden-v7-1';
    readonly supervisedTuningSpec: {
      readonly trainingDatasetUri: string;
      readonly validationDatasetUri: string;
      readonly exportLastCheckpointOnly: true;
      readonly hyperParameters: {
        readonly epochCount: 6;
        readonly adapterSize: 'ADAPTER_SIZE_FOUR';
        readonly learningRateMultiplier: 1;
      };
    };
  };
}

type S33V71ManifestBaseDigests = Omit<
  S33V71SurgeryManifest['digests'],
  'manifestCanonicalSha256'
>;
type S33V71ManifestWithoutSelf = Omit<S33V71SurgeryManifest, 'digests'> & Readonly<{
  digests: S33V71ManifestBaseDigests;
}>;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalDigest(value: unknown): string {
  return sha256(canonicaliseJson(value));
}

function assertCanonicalEqual(label: string, actual: unknown, expected: unknown): void {
  if (canonicaliseJson(actual) !== canonicaliseJson(expected)) {
    throw new Error(`S3.3 v7.1 ${label} drifted`);
  }
}

function deepFreezeOwned<T extends object>(value: T): T {
  for (const property of Reflect.ownKeys(value)) {
    const nested = Reflect.get(value, property);
    if (nested !== null && (typeof nested === 'object' || typeof nested === 'function')) {
      deepFreezeOwned(nested);
    }
  }
  return Object.freeze(value);
}

function detachAndFreezeResult(result: S33V71SurgeryResult): S33V71SurgeryResult {
  return deepFreezeOwned(structuredClone(result));
}

function assertHistoricalSource(source: readonly GoldenDatasetEntry[]): void {
  const orderedIdsSha256 = canonicalDigest(source.map(({ id }) => id));
  const contentCanonicalSha256 = canonicalDigest(source);
  const ids = new Set(source.map(({ id }) => id));
  if (source.length !== EXPECTED_SOURCE_COUNT
    || ids.size !== EXPECTED_SOURCE_COUNT
    || orderedIdsSha256 !== EXPECTED_SOURCE_ORDERED_IDS_SHA256
    || contentCanonicalSha256 !== EXPECTED_SOURCE_CONTENT_SHA256) {
    throw new Error('S3.3 v7.1 historical source count, order, ids, or content drifted');
  }
}

function taxonomyValid(credentialType: string, subType: string): boolean {
  return S33_WAVE3_FROZEN_SUBTYPE_TAXONOMY[credentialType]?.includes(subType) === true;
}

function deduceUnambiguousSubtypeCandidates(entry: GoldenDatasetEntry): readonly string[] {
  const credentialType = canonicalizeCredentialType(
    entry.groundTruth.credentialType ?? entry.credentialTypeHint,
  );
  const text = entry.strippedText;
  const textLower = text.toLowerCase();
  const groundTruth = entry.groundTruth;
  const degreeLevel = (groundTruth.degreeLevel ?? '').toLowerCase();
  const field = (groundTruth.fieldOfStudy ?? '').toLowerCase();
  const issuer = (groundTruth.issuerName ?? '').toLowerCase();
  const candidates = new Set<string>();
  const add = (condition: boolean, subType: string): void => {
    if (condition && taxonomyValid(credentialType, subType)) candidates.add(subType);
  };

  if (credentialType === 'DEGREE') {
    add(/\bbachelor|\bb\.?s\.?\b|\bb\.?a\.?\b|\bbba\b|\bbsn\b/iu.test(text)
      || degreeLevel.startsWith('bachelor'), 'bachelor');
    add(/\bmaster|\bm\.?s\.?\b|\bm\.?a\.?\b|\bmba\b|\bmsw\b|\bmfa\b|\bmeng\b/iu.test(text)
      || degreeLevel.startsWith('master'), 'master');
    add(/\bdoctor of medicine|\bm\.?d\.?\b|\bdo\b|\bmbbs\b/iu.test(text)
      && field.includes('medicin'), 'professional_md');
    add(/\bjuris doctor|\bj\.?d\.?\b/iu.test(text) || field.includes('law'), 'professional_jd');
    add(/\bed\.?d\.?\b|\bdoctor of education\b/iu.test(text), 'professional_edd');
    add(/\bdoctor of dental surgery|\bdds\b|\bdmd\b/iu.test(text), 'professional_dds');
    add(/\bdnp\b|\bdoctor of nursing practice\b/iu.test(text), 'professional_dnp');
    add(/\bdoctorate|\bph\.?d\.?\b|\bdoctor of\b/iu.test(text)
      || degreeLevel.startsWith('doctorate') || degreeLevel.startsWith('doctor'), 'doctorate');
    add(/\bassociate|\baa\b|\bas\b|\baas\b/iu.test(text)
      || degreeLevel.startsWith('associate'), 'associate');
  } else if (credentialType === 'LICENSE') {
    add(/\bregistered nurse|\brn\b|board of (registered )?nursing/iu.test(text)
      || field.includes('nursing'), 'nursing_rn');
    add(/\blpn\b|licensed practical nurse|midwife|midwifery/iu.test(text), 'nursing_lpn');
    add(/\bmedical (board|license|licence)|\bmd\b|doctor of medicine|physician.{0,30}licen/iu.test(text)
      || field.includes('medicin'), 'medical_md');
    add(/\bdental|\bdds\b|\bdentist|dental hygienist/iu.test(text)
      || field.includes('dental'), 'dental');
    add(/\bpharmacist|\bpharmacy license|board of pharmacy/iu.test(text)
      || field.includes('pharmac'), 'pharmacist');
    add(/\bveterinar/iu.test(text) || field.includes('veterinar'), 'veterinary');
    add(/\bbar (admission|exam)|attorney.{0,30}licen|admitted to.{0,20}bar|state bar of/iu.test(text)
      || field.includes('law'), 'law_bar_admission');
    add(/\bprofessional engineer|\bpe license|\bp\.?e\.?\b/iu.test(text)
      || field.includes('engineering'), 'engineering_pe');
    add(/\barchitect/iu.test(text) || field.includes('architect'), 'architect');
    add(/\bcertified public accountant|\bcpa\b|accountancy board/iu.test(text)
      || field.includes('accounting'), 'cpa');
    add(/\breal estate|\bbroker|\bsalesperson|real estate commission/iu.test(text)
      || field.includes('real estate'), 'real_estate');
    add(/\bteaching license|teacher certification|department of education/iu.test(text)
      || field.includes('teach'), 'teaching');
    add(/\bpsycholog/iu.test(text) || field.includes('psycholog'), 'psychology');
    add(/\bchiropract/iu.test(text) || field.includes('chiropract'), 'chiropractic');
    add(/\boptomet/iu.test(text) || field.includes('optomet'), 'optometry');
    add(/\bsocial work/iu.test(text) || field.includes('social work'), 'social_work');
    add(/\bspeech.{0,10}language|\bslp\b/iu.test(text)
      || field.includes('speech'), 'speech_language_pathology');
    add(/\bnotary|notarial/iu.test(text) || field.includes('notary'), 'notary');
    add(/\belectric/iu.test(text) || field.includes('electric'), 'electrician');
    add(/\bplumber|plumbing license/iu.test(text) || field.includes('plumb'), 'plumber');
    add(/\bcosmetolog/iu.test(text) || field.includes('cosmetolog'), 'cosmetology');
  } else if (credentialType === 'CERTIFICATE') {
    add(/\baws\b|amazon web services|\bazure\b|\bgcp\b|google cloud|\bkubernetes\b|\bckad\b|\bcka\b|\bcissp\b|\bcisa\b|\bcism\b|\bceh\b|\boscp\b|\bcomptia|\bcisco\b|\bccnp\b|\bccna\b|\boracle|terraform|docker|salesforce|tableau|itil|togaf/iu.test(text), 'it_certification');
    add(/\bpmp\b|\bpmi\b|project management|\bshrm\b|\bphr\b|\bcfa\b|\bcpa\b|\bcma\b|\bfrm\b|six sigma|scrum master|\bleed\b|actuarial|emt|\bcfe\b|clinical research/iu.test(text), 'professional_certification');
    add(/welding|inspector|trade certif/iu.test(text), 'trade_certification');
    add(/\bcpr\b|\bbls\b|\bacls\b|\bpals\b|first aid|osha|food handler|ged\b/iu.test(text), 'training_certificate');
    add(/coursera|udacity|edx|bootcamp|completion|completed the course|online course/iu.test(text), 'completion_certificate');
  } else if (credentialType === 'CLE') {
    add(/\bethics\b|professional responsibility/iu.test(text), 'ethics_cle');
    add(/elimination of bias|bias|diversity/iu.test(text), 'elimination_of_bias');
    add(/\bgeneral (cle|credit)/iu.test(text)
      || /\b(substance abuse|technology|immigration|bankruptcy|tax|securities)\b/iu.test(text), 'specialized_cle');
  } else if (credentialType === 'TRANSCRIPT') {
    add(degreeLevel.startsWith('master') || degreeLevel.startsWith('doctor')
      || /\bmba\b|\bjd\b|\bmd\b|graduate school|law school|medical school/iu.test(text), 'official_graduate');
    add(/\bunofficial/iu.test(text), 'unofficial');
  } else if (credentialType === 'PROFESSIONAL') {
    add(/board.{0,20}certif/iu.test(text) || /\babms\b|abim|abs\b/iu.test(text), 'board_certification');
    add(/\bfellowship/iu.test(text), 'fellowship');
    add(/\bresidency|internship/iu.test(text), 'residency');
  } else if (credentialType === 'SEC_FILING') {
    add(/\b10-?k\b/iu.test(text), 'form_10k');
    add(/\b10-?q\b/iu.test(text), 'form_10q');
    add(/\b8-?k\b/iu.test(text), 'form_8k');
    add(/def 14a|proxy statement/iu.test(text), 'form_def14a');
    add(/\bs-?1\b|registration statement/iu.test(text), 'form_s1');
    add(/\b13-?f\b/iu.test(text), 'form_13f');
    add(/\b20-?f\b/iu.test(text), 'form_20f');
    add(/\bform 4\b|insider transaction/iu.test(text), 'form_4');
  } else if (credentialType === 'REGULATION') {
    add(/federal register|cfr\b|code of federal/iu.test(text), 'federal');
    add(/state of|state regulatory|state agency/iu.test(textLower), 'state');
    add(/local|municipal|county|city ordinance/iu.test(textLower), 'local');
  } else if (credentialType === 'LEGAL') {
    add(/opinion|ruling|decision|court of appeals|supreme court/iu.test(text), 'court_opinion');
    add(/order|injunction|judgment/iu.test(textLower) && !/contract/iu.test(textLower), 'court_order');
    add(/contract|agreement|nda|non-?disclosure/iu.test(textLower), 'contract');
    add(/affidavit|sworn statement/iu.test(textLower), 'affidavit');
  } else if (credentialType === 'PATENT') {
    add(/design patent/iu.test(text), 'design');
    add(/plant patent/iu.test(text), 'plant');
    add(/provisional/iu.test(text), 'provisional');
  } else if (credentialType === 'INSURANCE') {
    add(/liability|commercial general/iu.test(textLower), 'liability');
    add(/auto|automobile|vehicle/iu.test(textLower), 'auto');
    add(/health|medical insurance/iu.test(textLower), 'health');
    add(/property|homeowners/iu.test(textLower), 'property');
    add(/professional|e&o|errors and omissions|workers comp/iu.test(textLower), 'professional');
  } else if (credentialType === 'ATTESTATION') {
    add(/employment verification|employed by|work verification/iu.test(textLower), 'employment_verification');
    add(/education verification|enrolled|degree verification/iu.test(textLower), 'education_verification');
    add(/good standing|certificate of good standing/iu.test(textLower), 'good_standing');
    add(/reference|letter of recommendation/iu.test(textLower), 'reference');
  } else if (credentialType === 'BADGE') {
    add(issuer.includes('aws') || issuer.includes('google') || issuer.includes('microsoft')
      || issuer.includes('linkedin'), 'vendor_skill');
  } else if (credentialType === 'MEDICAL') {
    add(/prescription|rx\b/iu.test(text), 'prescription');
    add(/diagnosis|icd-?10/iu.test(textLower), 'diagnosis');
  } else if (credentialType === 'IDENTITY') {
    add(/passport/iu.test(textLower), 'passport');
    add(/driver/iu.test(textLower), 'drivers_license');
  } else if (credentialType === 'RESUME') {
    add(/\bcv\b|curriculum vitae/iu.test(textLower), 'cv');
  } else if (credentialType === 'FINANCIAL') {
    add(/tax return|1040|w-?2/iu.test(textLower), 'tax_return');
    add(/audit report|audited by/iu.test(textLower), 'audit_report');
  } else if (credentialType === 'MILITARY') {
    add(/\bdd-?214\b/iu.test(text), 'dd214');
    add(/discharge/iu.test(textLower), 'discharge');
  } else if (credentialType === 'CHARITY') {
    add(/501\(c\)\(3\)/iu.test(text), '501c3');
    add(/501\(c\)\(4\)/iu.test(text), '501c4');
    add(/501\(c\)\(6\)/iu.test(text), '501c6');
  } else if (credentialType === 'FINANCIAL_ADVISOR') {
    add(/finra/iu.test(textLower), 'finra_registered');
    add(/\bsec\b/iu.test(text), 'sec_registered');
  } else if (credentialType === 'BUSINESS_ENTITY') {
    add(/\bllc\b|limited liability/iu.test(textLower), 'llc');
    add(/\bcorp(oration)?\b|\binc\b/iu.test(textLower), 'corporation');
    add(/partnership/iu.test(textLower), 'partnership');
    add(/sole proprietor/iu.test(textLower), 'sole_proprietor');
  } else if (credentialType === 'ACCREDITATION') {
    add(/bureau veritas|bsi group|joint commission|iso \d{4,5}|dnv gl|sgs|tüv|tuv /iu.test(text), 'industry');
    add(/\babet\b|\baacsb\b|\blcme\b|\baacn\b|\bcaahep\b|\baba\b|\bnaeyc\b|\befmd\b|\bnaab\b|\bcommission on accreditation\b|\baccreditation commission for\b|national architectural accrediting/iu.test(text), 'programmatic');
    add(/higher learning commission|middle states|southern association|northwest commission|new england commission|wasc|chea|council for higher education|quality assurance agency|tertiary education quality|universal accreditation council/iu.test(text), 'institutional');
  }

  return [...candidates];
}

export function normalizeS33V71GoodStandingStatus(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  throw new TypeError('S3.3 v7.1 goodStandingStatus must already be a non-empty string');
}

function resolveSubtype(entry: GoldenDatasetEntry): Readonly<{
  credentialType: string;
  subType?: string;
  candidateSubTypes?: readonly string[];
  subtypeSource?: SubtypeSource;
  reason?: string;
}> {
  const credentialType = canonicalizeCredentialType(
    entry.groundTruth.credentialType ?? entry.credentialTypeHint,
  );

  if (entry.id === 'GD-1920') {
    const adjudication = S33_V71_FROZEN_ADJUDICATIONS[0];
    if (credentialType !== adjudication.credentialType
      || entry.groundTruth.subType !== 'certificate_of_good_standing'
      || entry.groundTruth.entityType?.trim().toLowerCase() !== 'corporation'
      || !taxonomyValid(credentialType, adjudication.subType)) {
      throw new Error('S3.3 v7.1 GD-1920 frozen adjudication premise drifted');
    }
    return {
      credentialType,
      subType: adjudication.subType,
      subtypeSource: 'adjudicated',
    };
  }

  const backfill = SUBTYPE_BACKFILL[entry.id]?.subType;
  if (backfill) {
    return taxonomyValid(credentialType, backfill)
      ? { credentialType, subType: backfill, subtypeSource: 'backfill' }
      : {
        credentialType,
        subType: backfill,
        subtypeSource: 'backfill',
        reason: 'frozen backfill is outside the frozen credentialType/subType taxonomy',
      };
  }

  const groundTruth = entry.groundTruth.subType?.trim();
  if (groundTruth) {
    return taxonomyValid(credentialType, groundTruth)
      ? { credentialType, subType: groundTruth, subtypeSource: 'ground_truth' }
      : {
        credentialType,
        subType: groundTruth,
        subtypeSource: 'ground_truth',
        reason: 'ground-truth subtype is outside the frozen credentialType/subType taxonomy',
      };
  }

  const candidates = deduceUnambiguousSubtypeCandidates(entry);
  if (candidates.length === 0) {
    return { credentialType, reason: 'no concrete deterministic subtype rule matched' };
  }
  if (candidates.length > 1) {
    return {
      credentialType,
      candidateSubTypes: candidates,
      reason: 'multiple concrete deterministic subtype rules matched',
    };
  }
  return { credentialType, subType: candidates[0], subtypeSource: 'deduced' };
}

function buildRetainedRow(
  entry: GoldenDatasetEntry,
  credentialType: string,
  subType: string,
  subtypeSource: SubtypeSource,
): S33V71RetainedRow {
  const description = buildDescription(entry, subType);
  const target = JSON.parse(buildTargetOutput(entry, subType, description)) as Record<string, unknown>;

  delete target.fraudSignals;
  if (Object.hasOwn(target, 'goodStandingStatus')) {
    if (typeof entry.groundTruth.goodStandingStatus !== 'string'
      || entry.groundTruth.goodStandingStatus.trim().length === 0) {
      throw new TypeError(
        `S3.3 v7.1 retained row ${entry.id} goodStandingStatus is not a source string`,
      );
    }
    target.goodStandingStatus = normalizeS33V71GoodStandingStatus(target.goodStandingStatus);
  }
  target.credentialType = credentialType;
  target.subType = subType;

  if (Object.keys(target).some((key) => /fraud/iu.test(key))) {
    throw new Error(`S3.3 v7.1 retained row ${entry.id} still contains a fraud field`);
  }
  if (!taxonomyValid(credentialType, subType)) {
    throw new Error(`S3.3 v7.1 retained row ${entry.id} has an invalid taxonomy pair`);
  }

  const vertex = {
    systemInstruction: {
      role: 'system' as const,
      parts: [{ text: EXTRACTION_V6_SYSTEM_PROMPT }],
    },
    contents: [
      {
        role: 'user' as const,
        parts: [{ text: buildV6UserPrompt(entry.strippedText, entry.credentialTypeHint, entry.issuerHint) }],
      },
      { role: 'model' as const, parts: [{ text: JSON.stringify(target) }] },
    ],
  };

  return { id: entry.id, credentialType, subType, subtypeSource, sourceEntry: entry, target, vertex };
}

function deterministicSplit(rows: readonly S33V71RetainedRow[]): Readonly<{
  trainRows: S33V71RetainedRow[];
  validationRows: S33V71RetainedRow[];
}> {
  let state = SPLIT_SEED;
  const random = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const shuffled = [...rows];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  const validationSize = Math.max(Math.floor(shuffled.length * 0.1), 10);
  return {
    validationRows: shuffled.slice(0, validationSize),
    trainRows: shuffled.slice(validationSize),
  };
}

function toJsonl(values: readonly unknown[]): string {
  return `${values.map((value) => JSON.stringify(value)).join('\n')}\n`;
}

function buildS33V71SurgeryEvidence(
  retainedRows: readonly S33V71RetainedRow[],
  fraudSplitRows: readonly S33V71FraudSplitRow[],
): S33Wave3SurgeryEvidence {
  const exportedTrainingRows: S33Wave3SurgeryEvidence['exportedTrainingRows'] = retainedRows.map(({
    id,
    credentialType,
    subType,
    target,
  }) => ({
    ...target,
    id,
    credentialType,
    subType,
  }));
  return {
    sourceTrainingRowIds: [
      ...S33_V71_TOXIC_FINANCIAL_IDS,
      ...retainedRows.map(({ id }) => id),
    ],
    exportedTrainingRows,
    fraudStream: { mode: 'split', rowIds: fraudSplitRows.map(({ id }) => id) },
    exportLastCheckpointOnly: true,
  };
}

function buildS33V71Manifest(input: Readonly<{
  source: readonly GoldenDatasetEntry[];
  dispositions: readonly S33V71Disposition[];
  toxicDroppedRows: readonly GoldenDatasetEntry[];
  fraudSplitRows: readonly S33V71FraudSplitRow[];
  unresolvedRows: readonly S33V71UnresolvedRow[];
  retainedRows: readonly S33V71RetainedRow[];
  trainRows: readonly S33V71RetainedRow[];
  validationRows: readonly S33V71RetainedRow[];
  trainJsonl: string;
  validationJsonl: string;
  fraudSplitJsonl: string;
}>): S33V71SurgeryManifest {
  const subtypeSources = input.retainedRows.reduce<Record<SubtypeSource, number>>((counts, row) => {
    counts[row.subtypeSource] += 1;
    return counts;
  }, { ground_truth: 0, backfill: 0, deduced: 0, adjudicated: 0 });
  const sourceOrderedIdsSha256 = canonicalDigest(input.source.map(({ id }) => id));
  const sourceContentCanonicalSha256 = canonicalDigest(input.source);
  const baseDigests: S33V71ManifestBaseDigests = {
    sourceOrderedIdsSha256,
    sourceContentCanonicalSha256,
    dispositionsCanonicalSha256: canonicalDigest(input.dispositions),
    retainedTargetsCanonicalSha256: canonicalDigest(input.retainedRows.map(
      ({ id, target }) => ({ id, target }),
    )),
    trainJsonlSha256: sha256(input.trainJsonl),
    validationJsonlSha256: sha256(input.validationJsonl),
    fraudSplitJsonlSha256: sha256(input.fraudSplitJsonl),
    unresolvedCanonicalSha256: canonicalDigest(input.unresolvedRows),
  };
  const manifestWithoutSelf: S33V71ManifestWithoutSelf = {
    schemaVersion: 'arkova.s33.v71.surgery-manifest/v1',
    artifactType: 'arkova-s33-v71-dataset-surgery',
    algorithmVersion: 's33-v71-unique-candidate-adjudication-v1',
    source: {
      count: EXPECTED_SOURCE_COUNT,
      orderedModuleCounts: S33_V71_SOURCE_MODULES.map(({ name, count }) => ({ name, count })),
      orderedIdsSha256: sourceOrderedIdsSha256,
      contentCanonicalSha256: sourceContentCanonicalSha256,
    },
    counts: {
      source: input.source.length,
      toxicDropped: input.toxicDroppedRows.length,
      fraudSplit: input.fraudSplitRows.length,
      retained: input.retainedRows.length,
      unresolved: input.unresolvedRows.length,
      train: input.trainRows.length,
      validation: input.validationRows.length,
    },
    subtypeSources,
    split: {
      algorithm: 'lcg-fisher-yates',
      seed: SPLIT_SEED,
      validationRatio: 0.1,
    },
    adjudications: S33_V71_FROZEN_ADJUDICATIONS,
    toxicDroppedIds: [...S33_V71_TOXIC_FINANCIAL_IDS],
    fraudArtifactSubmissionEligible: false,
    additiveOrGeneratedRows: 0,
    heldoutIdNamespaceRows: 0,
    heldoutLeakageScanStatus: 'NOT_RUN_AUTHENTICATION_HOLD',
    digests: baseDigests,
  };
  return {
    ...manifestWithoutSelf,
    digests: {
      ...baseDigests,
      manifestCanonicalSha256: canonicalDigest(manifestWithoutSelf),
    },
  };
}

function assertFrozenArtifactDigests(manifest: S33V71SurgeryManifest): void {
  if (manifest.digests.sourceOrderedIdsSha256 !== EXPECTED_SOURCE_ORDERED_IDS_SHA256
    || manifest.digests.sourceContentCanonicalSha256 !== EXPECTED_SOURCE_CONTENT_SHA256) {
    throw new Error('S3.3 v7.1 frozen source digest drifted');
  }
  for (const name of EXPECTED_ARTIFACT_DIGEST_NAMES) {
    if (manifest.digests[name] !== EXPECTED_ARTIFACT_DIGESTS[name]) {
      throw new Error(`S3.3 v7.1 frozen artifact digest drifted: ${name}`);
    }
  }
}

function assertSourceEntryMatches(
  sourceById: ReadonlyMap<string, GoldenDatasetEntry>,
  label: string,
  id: string,
  entry: GoldenDatasetEntry,
): void {
  const expected = sourceById.get(id);
  if (!expected || entry.id !== id || canonicaliseJson(entry) !== canonicaliseJson(expected)) {
    throw new Error(`S3.3 v7.1 ${label} ${id} source content drifted`);
  }
}

function assertRetainedRowSequence(
  label: string,
  actual: readonly S33V71RetainedRow[],
  expected: readonly S33V71RetainedRow[],
): void {
  if (actual.length !== expected.length) {
    throw new Error(`S3.3 v7.1 ${label} length drifted`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (canonicaliseJson(actual[index]) !== canonicaliseJson(expected[index])) {
      throw new Error(`S3.3 v7.1 ${label} row ${index} drifted`);
    }
  }
}

/**
 * Produces an owned, validated snapshot without resolving a path or touching
 * the filesystem. Every derived value is rebuilt before the writer proceeds.
 */
function snapshotS33V71SurgeryForWrite(
  supplied: S33V71SurgeryResult,
): S33V71SurgeryResult {
  const snapshot = structuredClone(supplied);
  assertHistoricalSource(S33_V71_HISTORICAL_SOURCE);

  const expectedCounts: S33V71SurgeryManifest['counts'] = {
    source: EXPECTED_SOURCE_COUNT,
    toxicDropped: snapshot.toxicDroppedRows.length,
    fraudSplit: snapshot.fraudSplitRows.length,
    retained: snapshot.retainedRows.length,
    unresolved: snapshot.unresolvedRows.length,
    train: snapshot.trainRows.length,
    validation: snapshot.validationRows.length,
  };
  assertCanonicalEqual('manifest counts', snapshot.manifest.counts, expectedCounts);

  const expectedSubtypeSources = snapshot.retainedRows.reduce<Record<SubtypeSource, number>>(
    (counts, row) => {
      counts[row.subtypeSource] += 1;
      return counts;
    },
    { ground_truth: 0, backfill: 0, deduced: 0, adjudicated: 0 },
  );
  assertCanonicalEqual(
    'manifest subtype-source counts',
    snapshot.manifest.subtypeSources,
    expectedSubtypeSources,
  );
  assertFrozenArtifactDigests(snapshot.manifest);

  const sourceById = new Map(S33_V71_HISTORICAL_SOURCE.map((entry) => [entry.id, entry]));
  const sourceIds = S33_V71_HISTORICAL_SOURCE.map(({ id }) => id);
  const partitionIds = [
    ...snapshot.toxicDroppedRows.map(({ id }) => id),
    ...snapshot.fraudSplitRows.map(({ id }) => id),
    ...snapshot.unresolvedRows.map(({ id }) => id),
    ...snapshot.retainedRows.map(({ id }) => id),
  ];
  if (partitionIds.length !== sourceIds.length
    || new Set(partitionIds).size !== sourceIds.length
    || partitionIds.some((id) => !sourceById.has(id))) {
    throw new Error('S3.3 v7.1 source partitions are not disjoint and exhaustive');
  }
  if (snapshot.toxicDroppedRows.map(({ id }) => id).join('\n')
    !== S33_V71_TOXIC_FINANCIAL_IDS.join('\n')) {
    throw new Error('S3.3 v7.1 toxic FINANCIAL partition drifted');
  }

  for (const entry of snapshot.toxicDroppedRows) {
    assertSourceEntryMatches(sourceById, 'toxic row', entry.id, entry);
  }
  for (const row of snapshot.fraudSplitRows) {
    assertSourceEntryMatches(sourceById, 'fraud row', row.id, row.entry);
    if ((row.entry.groundTruth.fraudSignals?.length ?? 0) === 0) {
      throw new Error(`S3.3 v7.1 fraud row ${row.id} has no source fraud signal`);
    }
  }
  for (const row of snapshot.unresolvedRows) {
    if (row.candidateSource !== undefined
      && !UNRESOLVED_CANDIDATE_SOURCES.has(row.candidateSource)) {
      throw new Error(`S3.3 v7.1 unresolved row ${row.id} candidate source is not permitted`);
    }
  }
  for (const row of snapshot.retainedRows) {
    assertSourceEntryMatches(sourceById, 'retained row', row.id, row.sourceEntry);
    if (row.id !== row.sourceEntry.id
      || row.target.credentialType !== row.credentialType
      || row.target.subType !== row.subType
      || !taxonomyValid(row.credentialType, row.subType)) {
      throw new Error(`S3.3 v7.1 retained row ${row.id} binding drifted`);
    }
  }

  const dispositionIds = snapshot.dispositions.map(({ id }) => id);
  if (dispositionIds.length !== sourceIds.length
    || dispositionIds.some((id, index) => id !== sourceIds[index])) {
    throw new Error('S3.3 v7.1 disposition source order drifted');
  }

  const expectedSplit = deterministicSplit(snapshot.retainedRows);
  assertRetainedRowSequence('train split', snapshot.trainRows, expectedSplit.trainRows);
  assertRetainedRowSequence(
    'validation split',
    snapshot.validationRows,
    expectedSplit.validationRows,
  );
  const regeneratedTrainJsonl = toJsonl(snapshot.trainRows.map(({ vertex }) => vertex));
  const regeneratedValidationJsonl = toJsonl(
    snapshot.validationRows.map(({ vertex }) => vertex),
  );
  const regeneratedFraudSplitJsonl = toJsonl(snapshot.fraudSplitRows.map(({ id, entry }) => ({
    schemaVersion: 'arkova.s33.v71.fraud-split-row/v1',
    submissionEligible: false,
    id,
    sourceEntry: entry,
  })));
  if (snapshot.trainJsonl !== regeneratedTrainJsonl
    || snapshot.validationJsonl !== regeneratedValidationJsonl
    || snapshot.fraudSplitJsonl !== regeneratedFraudSplitJsonl) {
    throw new Error('S3.3 v7.1 regenerated JSONL source, order, or content drifted');
  }

  const regeneratedManifest = buildS33V71Manifest({
    source: S33_V71_HISTORICAL_SOURCE,
    dispositions: snapshot.dispositions,
    toxicDroppedRows: snapshot.toxicDroppedRows,
    fraudSplitRows: snapshot.fraudSplitRows,
    unresolvedRows: snapshot.unresolvedRows,
    retainedRows: snapshot.retainedRows,
    trainRows: snapshot.trainRows,
    validationRows: snapshot.validationRows,
    trainJsonl: regeneratedTrainJsonl,
    validationJsonl: regeneratedValidationJsonl,
    fraudSplitJsonl: regeneratedFraudSplitJsonl,
  });
  assertFrozenArtifactDigests(regeneratedManifest);
  assertCanonicalEqual('manifest', snapshot.manifest, regeneratedManifest);

  const regeneratedSurgeryEvidence = buildS33V71SurgeryEvidence(
    snapshot.retainedRows,
    snapshot.fraudSplitRows,
  );
  assertCanonicalEqual(
    'surgery evidence',
    snapshot.surgeryEvidence,
    regeneratedSurgeryEvidence,
  );

  return deepFreezeOwned({
    ...snapshot,
    manifest: regeneratedManifest,
    trainJsonl: regeneratedTrainJsonl,
    validationJsonl: regeneratedValidationJsonl,
    fraudSplitJsonl: regeneratedFraudSplitJsonl,
    surgeryEvidence: regeneratedSurgeryEvidence,
  });
}

export function buildS33V71Surgery(
  source: readonly GoldenDatasetEntry[] = S33_V71_HISTORICAL_SOURCE,
): S33V71SurgeryResult {
  assertHistoricalSource(source);
  const toxicSet = new Set(S33_V71_TOXIC_FINANCIAL_IDS);
  const toxicDroppedRows: GoldenDatasetEntry[] = [];
  const fraudSplitRows: S33V71FraudSplitRow[] = [];
  const unresolvedRows: S33V71UnresolvedRow[] = [];
  const retainedRows: S33V71RetainedRow[] = [];
  const preliminary = new Map<string, Omit<S33V71Disposition, 'disposition'> & {
    disposition: Exclude<Disposition, 'train' | 'validation'> | 'retained';
  }>();

  for (const entry of source) {
    const credentialType = canonicalizeCredentialType(
      entry.groundTruth.credentialType ?? entry.credentialTypeHint,
    );
    if (toxicSet.has(entry.id)) {
      toxicDroppedRows.push(entry);
      preliminary.set(entry.id, {
        id: entry.id,
        disposition: 'toxic_dropped',
        reason: 'binding toxic FINANCIAL removal GD-3030..GD-3044',
        credentialType,
      });
      continue;
    }

    if ((entry.groundTruth.fraudSignals?.length ?? 0) > 0) {
      fraudSplitRows.push({ id: entry.id, entry });
      preliminary.set(entry.id, {
        id: entry.id,
        disposition: 'fraud_split',
        reason: 'whole row split to non-submitted fraud artifact',
        credentialType,
      });
      continue;
    }

    const resolved = resolveSubtype(entry);
    if (resolved.reason || !resolved.subType || !resolved.subtypeSource) {
      if (resolved.subtypeSource === 'adjudicated') {
        throw new Error(
          `S3.3 v7.1 unresolved row ${entry.id} cannot carry an adjudicated candidate source`,
        );
      }
      const unresolved = {
        id: entry.id,
        credentialType: resolved.credentialType,
        ...(resolved.subType ? { candidateSubType: resolved.subType } : {}),
        ...(resolved.candidateSubTypes ? { candidateSubTypes: resolved.candidateSubTypes } : {}),
        ...(resolved.subtypeSource ? { candidateSource: resolved.subtypeSource } : {}),
        reason: resolved.reason ?? 'subtype resolution failed closed',
      } satisfies S33V71UnresolvedRow;
      unresolvedRows.push(unresolved);
      preliminary.set(entry.id, {
        id: entry.id,
        disposition: 'unresolved',
        reason: unresolved.reason,
        credentialType: resolved.credentialType,
        ...(resolved.subType ? { subType: resolved.subType } : {}),
        ...(resolved.subtypeSource ? { subtypeSource: resolved.subtypeSource } : {}),
      });
      continue;
    }

    retainedRows.push(buildRetainedRow(
      entry,
      resolved.credentialType,
      resolved.subType,
      resolved.subtypeSource,
    ));
    preliminary.set(entry.id, {
      id: entry.id,
      disposition: 'retained',
      reason: 'concrete frozen taxonomy pair',
      credentialType: resolved.credentialType,
      subType: resolved.subType,
      subtypeSource: resolved.subtypeSource,
    });
  }

  if (toxicDroppedRows.map(({ id }) => id).join('\n') !== S33_V71_TOXIC_FINANCIAL_IDS.join('\n')) {
    throw new Error('S3.3 v7.1 toxic FINANCIAL rows are missing or out of order');
  }
  if (fraudSplitRows.length !== 201) {
    throw new Error(`S3.3 v7.1 fraud split drifted: expected 201, got ${fraudSplitRows.length}`);
  }

  const { trainRows, validationRows } = deterministicSplit(retainedRows);
  const trainIds = new Set(trainRows.map(({ id }) => id));
  const validationIds = new Set(validationRows.map(({ id }) => id));
  const dispositions = source.map(({ id }): S33V71Disposition => {
    const value = preliminary.get(id);
    if (!value) throw new Error(`S3.3 v7.1 source row ${id} has no disposition`);
    if (value.disposition !== 'retained') return value as S33V71Disposition;
    if (trainIds.has(id)) return { ...value, disposition: 'train' };
    if (validationIds.has(id)) return { ...value, disposition: 'validation' };
    throw new Error(`S3.3 v7.1 retained row ${id} is absent from train/validation`);
  });

  if (new Set(dispositions.map(({ id }) => id)).size !== source.length
    || trainRows.length + validationRows.length !== retainedRows.length) {
    throw new Error('S3.3 v7.1 row reconciliation is not bijective');
  }

  const trainJsonl = toJsonl(trainRows.map(({ vertex }) => vertex));
  const validationJsonl = toJsonl(validationRows.map(({ vertex }) => vertex));
  const fraudSplitJsonl = toJsonl(fraudSplitRows.map(({ id, entry }) => ({
    schemaVersion: 'arkova.s33.v71.fraud-split-row/v1',
    submissionEligible: false,
    id,
    sourceEntry: entry,
  })));
  const manifest = buildS33V71Manifest({
    source,
    dispositions,
    toxicDroppedRows,
    fraudSplitRows,
    unresolvedRows,
    retainedRows,
    trainRows,
    validationRows,
    trainJsonl,
    validationJsonl,
    fraudSplitJsonl,
  });
  assertFrozenArtifactDigests(manifest);
  const surgeryEvidence = buildS33V71SurgeryEvidence(retainedRows, fraudSplitRows);

  return detachAndFreezeResult({
    manifest,
    dispositions,
    toxicDroppedRows,
    fraudSplitRows,
    unresolvedRows,
    retainedRows,
    trainRows,
    validationRows,
    trainJsonl,
    validationJsonl,
    fraudSplitJsonl,
    surgeryEvidence,
  });
}

function writeAtomicFile(directory: string, name: string, content: string): void {
  const temporaryPath = join(directory, `.${name}.tmp`);
  const finalPath = join(directory, name);
  writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  renameSync(temporaryPath, finalPath);
}

/**
 * Writes reviewable local files only. This deliberately has no GCS upload,
 * Vertex job submission, endpoint deployment, or spend-authority path.
 */
export function writeS33V71OfflineArtifacts(input: Readonly<{
  surgery: S33V71SurgeryResult;
  outputDirectory: string;
}>): S33V71OfflineArtifactIndex {
  const surgery = snapshotS33V71SurgeryForWrite(input.surgery);
  const outputDirectory = resolve(input.outputDirectory);
  mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });

  const artifacts = {
    'manifest.json': `${canonicaliseJson(surgery.manifest)}\n`,
    'dispositions.json': `${canonicaliseJson(surgery.dispositions)}\n`,
    'unresolved.json': `${canonicaliseJson(surgery.unresolvedRows)}\n`,
    'retained-targets.json': `${canonicaliseJson(surgery.retainedRows.map(
      ({ id, target }) => ({ id, target }),
    ))}\n`,
    'train.jsonl': surgery.trainJsonl,
    'validation.jsonl': surgery.validationJsonl,
    'fraud-split.jsonl': surgery.fraudSplitJsonl,
    'surgery-evidence.json': `${canonicaliseJson(surgery.surgeryEvidence)}\n`,
  } as const;

  try {
    for (const [name, content] of Object.entries(artifacts)) {
      writeAtomicFile(outputDirectory, name, content);
    }
    const index: S33V71OfflineArtifactIndex = {
      schemaVersion: 'arkova.s33.v71.offline-artifact-index/v1',
      submissionEligible: false,
      sourceManifestCanonicalSha256:
        surgery.manifest.digests.manifestCanonicalSha256,
      counts: surgery.manifest.counts,
      files: Object.fromEntries(Object.entries(artifacts).map(([name, content]) => [
        name,
        { sha256: sha256(content), bytes: Buffer.byteLength(content, 'utf8') },
      ])),
    };
    writeAtomicFile(outputDirectory, 'artifact-index.json', `${canonicaliseJson(index)}\n`);
    return index;
  } catch (error) {
    rmSync(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

function assertGcsJsonlUri(value: string, label: string): void {
  if (!/^gs:\/\/[a-z0-9][a-z0-9._-]*\/.+\.jsonl$/u.test(value)) {
    throw new Error(`S3.3 v7.1 ${label} must be a gs:// JSONL URI`);
  }
}

export function buildS33V71TuningRequestTemplate(input: Readonly<{
  surgery: S33V71SurgeryResult;
  trainingDatasetUri: string;
  validationDatasetUri: string;
}>): Readonly<S33V71TuningRequestTemplate> {
  assertGcsJsonlUri(input.trainingDatasetUri, 'training dataset URI');
  assertGcsJsonlUri(input.validationDatasetUri, 'validation dataset URI');
  if (input.surgery.manifest.digests.sourceOrderedIdsSha256 !== EXPECTED_SOURCE_ORDERED_IDS_SHA256
    || input.surgery.manifest.digests.sourceContentCanonicalSha256 !== EXPECTED_SOURCE_CONTENT_SHA256) {
    throw new Error('S3.3 v7.1 tuning request source binding drifted');
  }
  const template: S33V71TuningRequestTemplate = {
    schemaVersion: 'arkova.s33.v71.tuning-request-template/v1',
    project: 'arkova1',
    location: 'us-central1',
    maxBudgetUsd: MAX_BUDGET_USD,
    submissionAuthorized: false,
    admission: 'HOLD',
    holdReasons: Object.freeze([
      'production CTO trust root and detached signatures are not configured',
      '621-row held-out evaluation corpus is not production-authenticated/frozen',
      'explicit founder/CTO spend admission is not attached',
    ]),
    exportManifestCanonicalSha256: input.surgery.manifest.digests.manifestCanonicalSha256,
    request: {
      baseModel: 'gemini-2.5-flash',
      tunedModelDisplayName: 'arkova-gemini-golden-v7-1',
      supervisedTuningSpec: {
        trainingDatasetUri: input.trainingDatasetUri,
        validationDatasetUri: input.validationDatasetUri,
        exportLastCheckpointOnly: true,
        hyperParameters: {
          epochCount: 6,
          adapterSize: 'ADAPTER_SIZE_FOUR',
          learningRateMultiplier: 1,
        },
      },
    },
  };
  return Object.freeze(template);
}

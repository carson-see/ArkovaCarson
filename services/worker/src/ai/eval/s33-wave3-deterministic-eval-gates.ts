/**
 * S3.3 Wave-3 deterministic offline release gates (SCRUM-2681/2686/2687).
 *
 * This module is deliberately inert: it reads no files, environment variables,
 * model endpoints, or production runtime modules. Callers must supply the exact
 * frozen registries, accepted corpus snapshot, arm manifests, and raw scored
 * observations. Missing, non-finite, unpaired, or digest-mismatched evidence is
 * rejected; measured threshold misses return an honest NO-GO report.
 */

import { createHash, createPublicKey } from 'node:crypto';
import { canonicaliseJson } from '../../utils/canonical-json.js';
import { validateFieldsForType } from '../crossFieldFraudChecks.js';
import type { ExtractedFields } from '../types.js';
import { parseS33ProducerModuleWithLimit } from './s33-wave1-producer-parser.js';
import {
  computeS33Wave2AcceptedEntryOrderSha256,
  S33_WAVE2_ACCEPTANCE_CONSTANTS,
  S33_WAVE2_CTO_RELEASE_TRUST_ROOT,
  verifyS33Wave2AuthenticatedBatchAcceptance,
  type S33Wave2AcceptanceTrustRoot,
  type S33Wave2AuthenticatedBatchAcceptance,
} from './s33-wave2-acceptance-envelope.js';

type JsonRecord = Record<string, unknown>;
type ArmName = 'public' | 'v6' | 'v71';
type FounderDomain = 'legal' | 'financial' | 'education';

const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const GATE_REGISTRY_RAW_SHA256 = '1a12bb3d38f07250c6c2e19772c06f8e405380c7db135138fcb9059f4cf0472d';
const GATE_REGISTRY_CANONICAL_SHA256 = 'dce7bbae2579db6199a768db44e456cb8c88e9317aaeb6812594953294b75132';
const WAVE1_MERGE_COMMIT = '42530fd73f9bd0cb7e4e70fc1259324810780b2c';
const WAVE1_BASE_REGISTRY_DIGEST_SHA256 = '412a08227608a58172569a4fcbf3cd1025dc67fc1beeaddd6c163d22c4cb80d6';
const BOOTSTRAP_REPLICATES = 2000;
const REGRESSION_FLOOR = -0.05;
const JURISDICTION_PUBLIC_BASELINE_F1 = 0.663;
const SMALL_N_WORDING = 'measured, small-n — directional' as const;
const MAX_TRUSTED_GOLD_ROWS = 10_000;
const TOP15_BATCH_CONTRACT = Object.freeze([
  'S33-W2-TOP15-01-05',
  'S33-W2-TOP15-06-10',
  'S33-W2-TOP15-11-15',
] as const);
const WAVE1_PACKET_SOURCE_EXPORTS = Object.freeze({
  'services/worker/src/ai/eval/golden-dataset-s33-licensing-heldout.ts': 'S33_LICENSING_HELDOUT',
  'services/worker/src/ai/eval/golden-dataset-s33-au-ke-heldout.ts': 'S33_AU_KE_HELDOUT',
  'services/worker/src/ai/eval/golden-dataset-s33-ood-negatives.ts': 'S33_OOD_NEGATIVES',
} as const);
export const S33_WAVE3_FROZEN_WAVE1_TUPLE = deepFreeze({
  pullRequestNumber: 1544,
  mergeCommitSha: WAVE1_MERGE_COMMIT,
  mergeParentSha: '67302fffcbdc5d72005aca7966b753a2fa74e4d0',
  producerHeadSha: '618e08d5a11cb73cb61394bc0343d33f4353ef39',
  producerParentSha: '48c42dcee17eb121bc79323f94c62d7c5b9ff5b9',
  producerTreeSha: '7401db53a9af3cb17c9c18a5abb9fd1fc68473d1',
  mergeTreeSha: '86cafa2afbb1e0c7049753261f7e4e96508e3a7d',
  typesBlobSha: 'cb93acd8c536a75e2ef9bb4928877a6d46eb3ed7',
  manifestRawSha256: 'eeb7c1b4bbd71642b4a7429864c0e04e9a5e3daf74b2cd78dd26442592f56e20',
  entryDatasheetRawSha256: 'da27f796454edf975b2adcb1a21a37fbbb9daecbe79b8c693a9963f4a83bdd64',
  packetBlobs: {
    'docs/lane4/s33-corpus-datasheet.md': '693c756117e5744fe4a532449ee932c61fc7dcb9',
    'docs/lane4/s33-wave1-batch-manifest.json': 'ebee08ac088f2b8f195d9b827a38f5b774c6e1b9',
    'docs/lane4/s33-wave1-entry-datasheet.json': '6ccd8f2b60c561cffa8a5537584c7e3d6570dae1',
    'services/worker/src/ai/eval/golden-dataset-s33-licensing-heldout.ts': '78090443bad793d248fdd1e3d22f7e468d618777',
    'services/worker/src/ai/eval/golden-dataset-s33-au-ke-heldout.ts': '7826dc6a34b475bdf2c73f9059026b8d19ec1b1f',
    'services/worker/src/ai/eval/golden-dataset-s33-ood-negatives.ts': 'a261cf690c930040f7dee0361ed29d73d1d23426',
  },
  packetRawSha256: {
    'docs/lane4/s33-wave1-batch-manifest.json': 'eeb7c1b4bbd71642b4a7429864c0e04e9a5e3daf74b2cd78dd26442592f56e20',
    'docs/lane4/s33-wave1-entry-datasheet.json': 'da27f796454edf975b2adcb1a21a37fbbb9daecbe79b8c693a9963f4a83bdd64',
    'services/worker/src/ai/eval/golden-dataset-s33-licensing-heldout.ts': 'f6fba82b45e0ffd7b7a6bcfb25c2457d766682f296f0366808af14361e0ac553',
    'services/worker/src/ai/eval/golden-dataset-s33-au-ke-heldout.ts': '35756a6047ae3b3009d8c9497427e878132a00e4b089d136ae5b858627c1d965',
    'services/worker/src/ai/eval/golden-dataset-s33-ood-negatives.ts': '95996b75b98f18b57e05f99a26834bc93f0cc25b4a93c5740561df607aae77d9',
  },
});

export const S33_WAVE3_GATE_IDS = Object.freeze([
  'G01_CORPUS_INTEGRITY',
  'G02_SURGERY_CONFIG',
  'G03_JSON_PARSE',
  'G04_MACRO_F1',
  'G05_WEIGHTED_F1',
  'G06_ALL_TYPE_FLOOR',
  'G07_CRITICAL_TYPE_FLOORS',
  'G08_TYPE_REGRESSION',
  'G09_LEGAL_UPLIFT',
  'G10_FINANCIAL_UPLIFT',
  'G11_EDUCATION_UPLIFT',
  'G12_SUBTYPE_EMISSION',
  'G13_DESCRIPTION_EMISSION',
  'G14_EFFICIENCY',
  'G15_CALIBRATION_GAP',
  'G16_CALIBRATION_ECE',
] as const);

export const S33_WAVE3_FROZEN_CREDENTIAL_TYPES = Object.freeze([
  'DEGREE',
  'LICENSE',
  'CERTIFICATE',
  'CLE',
  'TRANSCRIPT',
  'PROFESSIONAL',
  'PUBLICATION',
  'SEC_FILING',
  'REGULATION',
  'LEGAL',
  'PATENT',
  'INSURANCE',
  'ATTESTATION',
  'ACCREDITATION',
  'BADGE',
  'MEDICAL',
  'IDENTITY',
  'RESUME',
  'FINANCIAL',
  'MILITARY',
  'CHARITY',
  'FINANCIAL_ADVISOR',
  'BUSINESS_ENTITY',
  'OTHER',
] as const);

/** Exact 105-value subtype block in the current extraction-v6 prompt. */
export const S33_WAVE3_FROZEN_SUBTYPE_TAXONOMY: Readonly<Record<string, readonly string[]>> = deepFreeze({
  DEGREE: [
    'bachelor', 'master', 'doctorate', 'associate', 'professional_md',
    'professional_jd', 'professional_edd', 'professional_dds', 'professional_dnp',
  ],
  LICENSE: [
    'medical_md', 'nursing_rn', 'nursing_lpn', 'dental', 'pharmacist',
    'veterinary', 'law_bar_admission', 'engineering_pe', 'architect', 'cpa',
    'real_estate', 'teaching', 'psychology', 'chiropractic', 'optometry',
    'social_work', 'speech_language_pathology', 'notary', 'electrician',
    'plumber', 'cosmetology', 'general',
  ],
  CERTIFICATE: [
    'it_certification', 'professional_certification', 'trade_certification',
    'training_certificate', 'completion_certificate',
  ],
  CLE: ['ethics_cle', 'general_cle', 'specialized_cle', 'elimination_of_bias'],
  TRANSCRIPT: ['official_undergraduate', 'official_graduate', 'unofficial'],
  PROFESSIONAL: ['board_certification', 'fellowship', 'residency', 'membership'],
  ACCREDITATION: ['institutional', 'programmatic', 'industry'],
  SEC_FILING: [
    'form_10k', 'form_10q', 'form_8k', 'form_def14a', 'form_s1', 'form_13f',
    'form_20f', 'form_4',
  ],
  REGULATION: ['federal', 'state', 'local', 'agency'],
  LEGAL: ['court_opinion', 'court_order', 'contract', 'affidavit'],
  PATENT: ['utility', 'design', 'plant', 'provisional'],
  INSURANCE: ['liability', 'auto', 'health', 'property', 'professional'],
  ATTESTATION: ['employment_verification', 'education_verification', 'good_standing', 'reference'],
  BADGE: ['vendor_skill', 'educational_microcredential'],
  MEDICAL: ['prescription', 'medical_record', 'diagnosis'],
  IDENTITY: ['passport', 'drivers_license', 'government_id'],
  RESUME: ['resume', 'cv'],
  FINANCIAL: ['tax_return', 'financial_statement', 'audit_report'],
  MILITARY: ['dd214', 'discharge', 'service_record'],
  CHARITY: ['501c3', '501c4', '501c6'],
  FINANCIAL_ADVISOR: ['finra_registered', 'sec_registered', 'state_registered'],
  BUSINESS_ENTITY: ['llc', 'corporation', 'partnership', 'sole_proprietor'],
});

/** Exact post-production-validation depth fields used by the S3.3 corpus contract. */
export const S33_WAVE3_SUBSTANTIVE_FIELDS = Object.freeze([
  'issuerName',
  'recipientIdentifier',
  'issuedDate',
  'expiryDate',
  'fieldOfStudy',
  'degreeLevel',
  'licenseNumber',
  'accreditingBody',
  'jurisdiction',
  'creditHours',
  'creditType',
  'barNumber',
  'activityNumber',
  'courseId',
  'providerName',
  'approvedBy',
  'deliveryMethod',
  'ethicsHours',
  'nasbaStatus',
  'entityType',
  'stateOfFormation',
  'registeredAgent',
  'goodStandingStatus',
  'einNumber',
  'taxExemptStatus',
  'governingBody',
  'crdNumber',
  'firmName',
  'finraRegistration',
  'seriesLicenses',
  'contractType',
  'contractReasoningType',
  'parties',
  'signatories',
  'effectiveDate',
  'termLength',
  'autoRenewalTerms',
  'noticeDeadline',
  'paymentTerms',
  'deliverables',
  'liabilityCap',
  'indemnificationScope',
  'terminationRights',
  'governingLaw',
  'venue',
  'arbitrationClause',
  'confidentialityTerm',
  'riskFlags',
  'recommendationUrls',
  'templateDeviation',
  'crossDocumentReference',
  'signatoryAuthority',
  'regulatoryGap',
] as const);

export const S33_WAVE3_JURISDICTION_MANIFESTS = deepFreeze({
  AU: Array.from({ length: 11 }, (_, index) => `GD-S33-AU-${String(index + 1).padStart(3, '0')}`),
  KE: Array.from({ length: 11 }, (_, index) => `GD-S33-KE-${String(index + 1).padStart(3, '0')}`),
});

const FOUNDER_MAPPING_ROWS = [
  'legal|legal-01-contract|Contract|LEGAL:contract',
  'legal|legal-02-service-agreement|Service agreement|LEGAL:contract',
  'legal|legal-03-nondisclosure-agreement|Non-disclosure agreement|LEGAL:contract',
  'legal|legal-04-settlement-agreement|Settlement agreement|LEGAL:contract',
  'legal|legal-05-court-opinion|Court opinion|LEGAL:court_opinion',
  'legal|legal-06-court-order|Court order|LEGAL:court_order',
  'legal|legal-07-custody-divorce-decree|Custody or divorce decree|LEGAL:court_order',
  'legal|legal-08-affidavit-declaration|Affidavit or declaration|LEGAL:affidavit',
  'legal|legal-09-power-of-attorney|Power of attorney|LEGAL:affidavit',
  'legal|legal-10-bar-admission|Bar admission or practising certificate|LICENSE:law_bar_admission',
  'legal|legal-11-general-cle|General CLE completion|CLE:general_cle',
  'legal|legal-12-ethics-cle|Ethics CLE completion|CLE:ethics_cle',
  'legal|legal-13-specialized-cle|Specialized CLE completion|CLE:specialized_cle',
  'legal|legal-14-utility-patent|Utility patent or grant|PATENT:utility',
  'legal|legal-15-regulatory-instrument|Federal or state regulatory instrument|REGULATION:federal,REGULATION:state',
  'financial|financial-01-pay-stub|Pay stub or income statement|FINANCIAL:financial_statement',
  'financial|financial-02-w2|W-2|FINANCIAL:tax_return',
  'financial|financial-03-1099|1099|FINANCIAL:tax_return',
  'financial|financial-04-bank-statement|Bank statement|FINANCIAL:financial_statement',
  'financial|financial-05-income-verification|Income verification letter|ATTESTATION:employment_verification',
  'financial|financial-06-financial-aid-award|Financial-aid award|FINANCIAL:financial_statement',
  'financial|financial-07-tax-return-assessment|Tax return or assessment|FINANCIAL:tax_return',
  'financial|financial-08-audit-report|Independent audit report|FINANCIAL:audit_report',
  'financial|financial-09-financial-statements|Financial statements|FINANCIAL:financial_statement',
  'financial|financial-10-sec-10k|SEC Form 10-K|SEC_FILING:form_10k',
  'financial|financial-11-sec-10q|SEC Form 10-Q|SEC_FILING:form_10q',
  'financial|financial-12-sec-8k|SEC Form 8-K|SEC_FILING:form_8k',
  'financial|financial-13-sec-def14a|SEC proxy or DEF 14A|SEC_FILING:form_def14a',
  'financial|financial-14-finra-broker|FINRA broker record|FINANCIAL_ADVISOR:finra_registered',
  'financial|financial-15-investment-adviser|SEC or state investment-adviser record|FINANCIAL_ADVISOR:sec_registered,FINANCIAL_ADVISOR:state_registered',
  "education|education-01-associate|Associate degree|DEGREE:associate",
  "education|education-02-bachelor|Bachelor's degree|DEGREE:bachelor",
  "education|education-03-master|Master's degree|DEGREE:master",
  'education|education-04-doctorate|Doctorate|DEGREE:doctorate',
  'education|education-05-professional-degree|Professional degree (JD, MD, EdD, DDS, or DNP)|DEGREE:professional_jd,DEGREE:professional_md,DEGREE:professional_edd,DEGREE:professional_dds,DEGREE:professional_dnp',
  'education|education-06-official-undergraduate-transcript|Official undergraduate transcript|TRANSCRIPT:official_undergraduate',
  'education|education-07-official-graduate-transcript|Official graduate transcript|TRANSCRIPT:official_graduate',
  'education|education-08-unofficial-transcript|Unofficial transcript|TRANSCRIPT:unofficial',
  'education|education-09-high-school-diploma|High-school diploma or equivalency|CERTIFICATE:completion_certificate',
  'education|education-10-professional-certification|Professional certification|CERTIFICATE:professional_certification',
  'education|education-11-trade-certification|Trade certification|CERTIFICATE:trade_certification',
  'education|education-12-training-certificate|Training certificate|CERTIFICATE:training_certificate',
  'education|education-13-completion-certificate|Course completion certificate|CERTIFICATE:completion_certificate',
  'education|education-14-accreditation|Institutional or program accreditation|ACCREDITATION:institutional,ACCREDITATION:programmatic',
  'education|education-15-microcredential|Educational microcredential|BADGE:educational_microcredential',
] as const;

export interface S33Wave3FounderMapping {
  domain: FounderDomain;
  id: string;
  documentType: string;
  mappings: Array<{ credentialType: string; subType: string }>;
}

export const S33_WAVE3_FOUNDER_MAPPING_CONTRACT: readonly S33Wave3FounderMapping[] = deepFreeze(
  FOUNDER_MAPPING_ROWS.map((row): S33Wave3FounderMapping => {
    const [domain, id, documentType, mappingsText] = row.split('|');
    if (!domain || !id || !documentType || !mappingsText) throw new Error('Invalid frozen founder mapping row');
    return {
      domain: domain as FounderDomain,
      id,
      documentType,
      mappings: mappingsText.split(',').map((mapping) => {
        const [credentialType, subType] = mapping.split(':');
        if (!credentialType || !subType) throw new Error('Invalid frozen founder taxonomy mapping');
        return { credentialType, subType };
      }),
    };
  }),
);

const FROZEN_TYPE_SET = new Set<string>(S33_WAVE3_FROZEN_CREDENTIAL_TYPES);
const EXPLICIT_SUBTYPE_TYPE_SET = new Set(Object.keys(S33_WAVE3_FROZEN_SUBTYPE_TAXONOMY));
const WAVE1_LEGACY_CPE_SUBTYPES = new Set(['general_cpe', 'ethics_cpe', 'specialized_cpe']);
const SUBSTANTIVE_FIELD_SET = new Set<string>(S33_WAVE3_SUBSTANTIVE_FIELDS);
const FOUNDER_DOMAINS: readonly FounderDomain[] = ['legal', 'financial', 'education'];
const DROPPED_TRAINING_IDS = Object.freeze(
  Array.from({ length: 15 }, (_, index) => `GD-${3030 + index}`),
);

export interface S33Wave3FieldComparison {
  field: string;
  expectedPresent: boolean;
  actualPresent: boolean;
  matched: boolean;
}

export interface S33Wave3ArmObservation {
  parsed: boolean;
  predictedCredentialType: string | null;
  suggestedType: string | null;
  subType: string | null;
  description: string | null;
  extractedFields: Record<string, unknown>;
  calibratedConfidence: number;
  latencyMs: number;
  tokensUsed: number;
}

export interface S33Wave3Observation {
  entryId: string;
  domain: string;
  actualCredentialType: string;
  actualSubType: string;
  normalizedInputSha256: string;
  founderTypeId: string | null;
  arms: Record<ArmName, S33Wave3ArmObservation>;
}

export interface S33Wave3ArmManifest {
  schemaVersion: 1;
  artifactType: 'arkova-s33-wave3-eval-arm-manifest';
  arm: ArmName;
  corpusRegistryDigestSha256: string;
  entryIds: string[];
  manifestDigestSha256: string;
}

export interface S33Wave3IntegrityEvidence {
  validationErrors: string[];
  heldoutLeakageNgram6To13Findings: string[];
  trainingOrGeneratorDerivedRowIds: string[];
  productionCustomerDocumentIds: string[];
}

export interface S33Wave3SurgeryEvidence {
  sourceTrainingRowIds: string[];
  exportedTrainingRows: Array<{
    id: string;
    credentialType: string;
    subType: string;
    [key: string]: unknown;
  }>;
  fraudStream: { mode: string; rowIds: string[] };
  exportLastCheckpointOnly: boolean;
}

export interface S33Wave3EvaluationInput {
  gateRegistryJson: string;
  founderCoverageRegistryJson: string;
  acceptedCorpusRegistry: unknown;
  trustedGoldSources: S33Wave3TrustedGoldSource[];
  authenticatedBatchAcceptances: unknown[];
  testOnlyAcceptanceTrustRoot?: S33Wave2AcceptanceTrustRoot;
  armManifests: Record<ArmName, S33Wave3ArmManifest>;
  observations: S33Wave3Observation[];
  integrityEvidence: S33Wave3IntegrityEvidence;
  surgeryEvidence: S33Wave3SurgeryEvidence;
  jurisdictionManifests: { AU: readonly string[]; KE: readonly string[] };
  inputPacketDigests: S33Wave3InputPacketDigests;
}

export interface S33Wave3InputPacketDigests {
  observationsCanonicalSha256: string;
  integrityEvidenceCanonicalSha256: string;
  surgeryEvidenceCanonicalSha256: string;
  jurisdictionManifestsCanonicalSha256: string;
  trustedGoldSourcesCanonicalSha256: string;
  authenticatedBatchAcceptancesCanonicalSha256: string;
}

export interface S33Wave3TrustedGoldSource {
  sourcePath: string;
  sourceBlobSha: string;
  exportName: string;
  sourceText: string;
}

/** Post-verification facts consumed by the pure release-corpus freeze reducer. */
export interface S33Wave3VerifiedCorpusFreezeSnapshot {
  suppliedCorpusRegistryDigestSha256: string;
  acceptedCorpusEntries: readonly { batchId: string }[];
  acceptedCorpusBatches: readonly { batchId: string; entryCount: number }[];
  authenticatedBatchAcceptances: readonly S33Wave2AuthenticatedBatchAcceptance[];
}

export type S33Wave3RawInputPackets = Pick<
  S33Wave3EvaluationInput,
  'observations' | 'integrityEvidence' | 'surgeryEvidence' | 'jurisdictionManifests'
  | 'trustedGoldSources' | 'authenticatedBatchAcceptances'
>;

export interface S33Wave3FieldScore {
  standardF1: number;
  coverageAdjustedF1: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  missingBothCount: number;
  presentMatchCount: number;
}

export interface S33Wave3GateResult {
  id: typeof S33_WAVE3_GATE_IDS[number];
  passed: boolean;
  metrics: Record<string, unknown>;
}

export interface S33Wave3BootstrapInterval {
  sampleSize: number;
  replicates: number;
  meanPairedDelta: number;
  ci95Lower: number;
  ci95Upper: number;
  seedSha256: string;
}

export interface S33Wave3EvaluationReport {
  schemaVersion: 'arkova.s33.wave3.deterministic-eval/v1';
  artifactType: 'arkova-s33-wave3-deterministic-eval-report';
  evidenceClass: 'offline-code-only' | 'fixture-only';
  liveEvidenceDeferred: true;
  verdict: 'GO' | 'NO-GO';
  bindings: {
    gateRegistryRawSha256: string;
    gateRegistryCanonicalSha256: string;
    founderMappingCanonicalSha256: string;
    acceptedCorpusRegistryDigestSha256: string;
    frozenTaxonomyCanonicalSha256: string;
    armManifestDigests: Record<ArmName, string>;
    deterministicSeedSha256: string;
    inputPacketDigests: S33Wave3InputPacketDigests;
    acceptanceAuthority: {
      verificationMode: 'configured-cto-policy' | 'test-injected';
      publicKeyFingerprintSha256: string;
      authenticatedBatchCount: number;
      releaseAuthority: boolean;
    };
  };
  gates: S33Wave3GateResult[];
  bootstrap: {
    replicates: number;
    confidenceLevel: 0.95;
    domainsPooled: false;
    byDomain: Record<FounderDomain, S33Wave3BootstrapInterval>;
    knownDeltaControls: {
      positive: S33Wave3BootstrapInterval;
      negative: S33Wave3BootstrapInterval;
      passed: boolean;
    };
  };
  scoring: {
    macroF1: number;
    weightedF1: number;
    coverageAdjustedF1: number;
    perTypeF1: Record<string, number>;
    perTypeCoverageAdjustedF1: Record<string, number>;
  };
  regression: {
    perTypeDeltaVsV6: Record<string, number>;
    perTypeDeltaVsPublic: Record<string, number>;
    perTypeCoverageAdjustedDeltaVsPublic: Record<string, number>;
    minimumPerTypeDeltaVsV6: number;
    minimumPerTypeDeltaVsPublic: number;
    minimumCoverageAdjustedDeltaVsPublic: number;
    publicBaselineGuardPassed: boolean;
  };
  corpusFreeze: {
    expectedTotalEntryCount: 621;
    actualTotalEntryCount: number;
    immutableWave1EntryCount: number;
    expectedPostWave1BatchIds: readonly string[];
    actualPostWave1BatchIds: string[];
    postWave1BatchEntryCounts: Record<string, number>;
    authenticatedBatchCount: number;
    founderTypeCounts: Record<string, number>;
    founderTypeEdgeCaseCounts: Record<string, number>;
    minimumFounderTypeCount: number;
    minimumFounderTypeEdgeCaseCount: number;
    finalAuthenticatedRegistryDigestSha256: string | null;
    suppliedCorpusRegistryDigestSha256: string;
    finalRegistryDigestMatches: boolean;
    orderedBatchContractPassed: boolean;
    founderCountContractPassed: boolean;
    edgeCaseContractPassed: boolean;
    passed: boolean;
  };
  calibration: {
    meanGap: number;
    ece: number;
    bins: Array<{
      lower: number;
      upper: number;
      count: number;
      meanConfidence: number;
      meanAccuracy: number;
      absoluteGap: number;
    }>;
  };
  diagnostics: {
    confusionByDomain: Record<string, {
      total: number;
      matrix: Record<string, Record<string, number>>;
    }>;
    top20ConfusedPairs: Array<{ actual: string; predicted: string; count: number }>;
    crossDomainConfusions: number;
    abstention: {
      count: number;
      rate: number;
      precisionAtAbstention: number;
      malformedSuggestedTypeCount: number;
      contractPassed: boolean;
    };
    coverageAccuracyCurve: Array<{ coverage: number; accuracy: number; threshold: number }>;
  };
  founderCoverage: {
    mappingCount: 45;
    frozenCredentialTypes: readonly string[];
    frozenSubtypeTaxonomy: Readonly<Record<string, readonly string[]>>;
    results: Array<{
      domain: FounderDomain;
      founderTypeId: string;
      sampleSize: number;
      candidateF1: number;
      disposition: 'covered-by-prompt+base' | 'needs-tuning-data' | 'needs-taxonomy-extension';
    }>;
  };
  jurisdictions: Record<'AU' | 'KE', {
    sampleSize: number;
    candidateF1: number;
    baselineF1: 0.663;
    deltaVsBaseline: number;
    wording: typeof SMALL_N_WORDING;
    marketingAllowed: false;
  }>;
  releaseGuards: {
    allRegistryGatesPassed: boolean;
    publicBaselineGuardPassed: boolean;
    abstentionContractPassed: boolean;
    bootstrapControlPassed: boolean;
    releaseAuthorityVerified: boolean;
    corpusFreezeVerified: boolean;
  };
  artifactDigestSha256: string;
}

interface AcceptedEntry {
  id: string;
  domain: string;
  credentialType: string;
  normalizedInputSha256: string;
  batchId: string;
  revision: number;
  sourcePath: string;
}

interface AcceptedBatch {
  batchId: string;
  revision: number;
  sourcePath: string;
  sourceBlobSha: string;
  manifestPath: string;
  manifestRawSha256: string;
  datasheetBlobSha: string;
  entryCount: number;
}

interface TrustedGoldEntry {
  id: string;
  strippedText: string;
  source: string;
  groundTruth: JsonRecord;
  scoringGroundTruth: JsonRecord;
  credentialType: string;
  subType: string;
  founderTypeId: string | null;
  edgeCase: boolean;
  sourcePath: string;
  sourceBlobSha: string;
}

interface ValidatedArmObservation extends S33Wave3ArmObservation {
  fieldComparisons: S33Wave3FieldComparison[];
}

interface ValidatedObservation extends Omit<S33Wave3Observation, 'arms'> {
  arms: Record<ArmName, ValidatedArmObservation>;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalDigest(value: unknown): string {
  return sha256(canonicaliseJson(value));
}

export function createS33Wave3InputPacketDigests(
  packets: S33Wave3RawInputPackets,
): S33Wave3InputPacketDigests {
  const candidate = record(packets, 'Wave-3 raw input packets') as unknown as S33Wave3RawInputPackets;
  return deepFreeze({
    observationsCanonicalSha256: canonicalDigest(candidate.observations),
    integrityEvidenceCanonicalSha256: canonicalDigest(candidate.integrityEvidence),
    surgeryEvidenceCanonicalSha256: canonicalDigest(candidate.surgeryEvidence),
    jurisdictionManifestsCanonicalSha256: canonicalDigest(candidate.jurisdictionManifests),
    trustedGoldSourcesCanonicalSha256: canonicalDigest(candidate.trustedGoldSources),
    authenticatedBatchAcceptancesCanonicalSha256: canonicalDigest(candidate.authenticatedBatchAcceptances),
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as JsonRecord)) deepFreeze(child);
  }
  return value;
}

function compareUtf16CodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function nullableNonEmpty(value: unknown, label: string): string | null {
  if (value === null) return null;
  return nonEmpty(value, label);
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be finite`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function sha(value: unknown, pattern: RegExp, label: string): string {
  const parsed = nonEmpty(value, label);
  if (!pattern.test(parsed)) throw new Error(`${label} must be a full lowercase digest`);
  return parsed;
}

function exactStringArray(value: unknown, label: string): string[] {
  const parsed = array(value, label).map((item, index) => nonEmpty(item, `${label}[${index}]`));
  if (new Set(parsed).size !== parsed.length) throw new Error(`${label} contains duplicates`);
  return parsed;
}

function assertSameOrderedStrings(actual: readonly string[], expected: readonly string[], label: string): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} does not match the frozen ordered contract`);
  }
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  assertSameOrderedStrings(
    Object.keys(value).sort(compareUtf16CodeUnits),
    [...expected].sort(compareUtf16CodeUnits),
    `${label} keys`,
  );
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new Error('Cannot compute a mean without samples');
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function f1(tp: number, fp: number, fn: number): number {
  const denominator = (2 * tp) + fp + fn;
  return denominator === 0 ? 0 : (2 * tp) / denominator;
}

export function scoreS33FieldComparisons(
  comparisons: readonly S33Wave3FieldComparison[],
): S33Wave3FieldScore {
  if (comparisons.length === 0) throw new Error('Field comparisons are missing');
  const names = new Set<string>();
  let presentMatchCount = 0;
  let missingBothCount = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const [index, comparison] of comparisons.entries()) {
    const candidate = record(comparison, `Field comparison ${index}`);
    exactKeys(candidate, [
      'field', 'expectedPresent', 'actualPresent', 'matched',
    ], `Field comparison ${index}`);
    const field = nonEmpty(candidate.field, `Field comparison ${index} field`);
    if (names.has(field)) throw new Error(`Field comparison ${field} is duplicated`);
    names.add(field);
    const expectedPresent = boolean(candidate.expectedPresent, `${field} expectedPresent`);
    const actualPresent = boolean(candidate.actualPresent, `${field} actualPresent`);
    const matched = boolean(candidate.matched, `${field} matched`);

    if (!expectedPresent && !actualPresent) {
      if (!matched) throw new Error(`${field} missing-both comparison must be matched`);
      missingBothCount += 1;
    } else if (expectedPresent && actualPresent) {
      if (matched) presentMatchCount += 1;
      else {
        falsePositive += 1;
        falseNegative += 1;
      }
    } else {
      if (matched) throw new Error(`${field} one-sided comparison cannot be matched`);
      if (expectedPresent) falseNegative += 1;
      else falsePositive += 1;
    }
  }

  return {
    standardF1: f1(presentMatchCount + missingBothCount, falsePositive, falseNegative),
    coverageAdjustedF1: f1(presentMatchCount, falsePositive, falseNegative),
    truePositive: presentMatchCount + missingBothCount,
    falsePositive,
    falseNegative,
    missingBothCount,
    presentMatchCount,
  };
}

function aggregateScores(comparisons: readonly S33Wave3FieldComparison[][]): S33Wave3FieldScore {
  return scoreS33FieldComparisons(comparisons.flatMap((entry, entryIndex) => (
    entry.map((comparison) => ({
      ...comparison,
      field: `${entryIndex}:${comparison.field}`,
    }))
  )));
}

function validateGateRegistry(content: string): { rawSha256: string; canonicalSha256: string } {
  if (typeof content !== 'string' || content.length === 0) throw new Error('Wave-3 gate registry JSON is missing');
  const rawSha256 = sha256(content);
  if (rawSha256 !== GATE_REGISTRY_RAW_SHA256) throw new Error('Wave-3 gate registry raw digest mismatch');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error('Wave-3 gate registry is not valid JSON', { cause: error });
  }
  const canonicalSha256 = canonicalDigest(parsed);
  if (canonicalSha256 !== GATE_REGISTRY_CANONICAL_SHA256) {
    throw new Error('Wave-3 gate registry canonical digest mismatch');
  }
  const registry = record(parsed, 'Wave-3 gate registry');
  if (registry.allMustPass !== true
    || registry.missingMetricDisposition !== 'FAIL'
    || registry.nonFiniteMetricDisposition !== 'FAIL'
    || registry.corpusDigestMismatchDisposition !== 'FAIL') {
    throw new Error('Wave-3 gate registry is not fail-closed');
  }
  const bootstrap = record(registry.pairedBootstrap, 'Wave-3 paired bootstrap registry');
  if (bootstrap.replicates !== BOOTSTRAP_REPLICATES
    || bootstrap.seedPolicy !== 'sha256-frozen-corpus-and-arm-manifests'
    || bootstrap.confidenceLevel !== 0.95
    || bootstrap.domainsPooled !== false) {
    throw new Error('Wave-3 paired bootstrap registry drifted');
  }
  const gateIds = array(registry.gates, 'Wave-3 gates').map((gate, index) => (
    nonEmpty(record(gate, `Wave-3 gate ${index}`).id, `Wave-3 gate ${index} id`)
  ));
  assertSameOrderedStrings(gateIds, S33_WAVE3_GATE_IDS, 'Wave-3 gate ids');
  return { rawSha256, canonicalSha256 };
}

function validateFounderRegistry(content: string): string {
  if (typeof content !== 'string' || content.length === 0) throw new Error('Founder coverage registry JSON is missing');
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error('Founder coverage registry is not valid JSON', { cause: error });
  }
  const registry = record(parsed, 'Founder coverage registry');
  if (registry.schemaVersion !== 1
    || registry.artifactType !== 'arkova-s33-wave2-top15-registry'
    || registry.status !== 'CTO_SIGNED_SCOPE') {
    throw new Error('Founder coverage registry identity/status mismatch');
  }
  const baseline = record(registry.acceptedBaseline, 'Founder accepted baseline');
  if (baseline.pullRequest !== 1544 || baseline.mergeCommit !== WAVE1_MERGE_COMMIT || baseline.entryCount !== 81) {
    throw new Error('Founder coverage registry accepted baseline mismatch');
  }
  const policy = record(registry.coveragePolicy, 'Founder coverage policy');
  if (policy.minimumHeldoutPerType !== 12
    || policy.generatorDerivedAllowed !== false
    || policy.trainingExposedAllowed !== false
    || policy.acceptanceLane !== 'lane3') {
    throw new Error('Founder coverage policy mismatch');
  }
  assertSameOrderedStrings(
    exactStringArray(registry.productionOrder, 'Founder production order'),
    S33_WAVE3_FOUNDER_MAPPING_CONTRACT.map(({ id }) => id),
    'Founder production order',
  );

  const projected: Array<{
    domain: string;
    id: string;
    documentType: string;
    mappings: Array<{ credentialType: string; subType: string }>;
  }> = [];
  const domains = array(registry.domains, 'Founder coverage domains');
  if (domains.length !== FOUNDER_DOMAINS.length) throw new Error('Founder coverage mapping must contain three domains');
  FOUNDER_DOMAINS.forEach((expectedDomain, domainIndex) => {
    const domain = record(domains[domainIndex], `Founder domain ${domainIndex}`);
    if (domain.id !== expectedDomain || domain.order !== domainIndex + 1) {
      throw new Error('Founder domain mapping/order mismatch');
    }
    const expectedTypes = S33_WAVE3_FOUNDER_MAPPING_CONTRACT.filter(({ domain: id }) => id === expectedDomain);
    const types = array(domain.types, `Founder ${expectedDomain} types`);
    if (types.length !== 15) throw new Error(`Founder ${expectedDomain} mapping must contain exactly 15 types`);
    types.forEach((candidate, typeIndex) => {
      const type = record(candidate, `Founder ${expectedDomain} type ${typeIndex}`);
      const expected = expectedTypes[typeIndex];
      if (type.id !== expected.id || type.order !== typeIndex + 1 || type.documentType !== expected.documentType) {
        throw new Error(`Founder ${expectedDomain} mapping identity/order mismatch`);
      }
      const mappings = array(type.mappings, `Founder ${expected.id} mappings`).map((mapping, mappingIndex) => {
        const pair = record(mapping, `Founder ${expected.id} mapping ${mappingIndex}`);
        const keys = Object.keys(pair).sort(compareUtf16CodeUnits);
        if (keys.length !== 2 || keys[0] !== 'credentialType' || keys[1] !== 'subType') {
          throw new Error(`Founder ${expected.id} mapping is not strict`);
        }
        return {
          credentialType: nonEmpty(pair.credentialType, `Founder ${expected.id} credentialType`),
          subType: nonEmpty(pair.subType, `Founder ${expected.id} subType`),
        };
      });
      projected.push({
        domain: expectedDomain,
        id: expected.id,
        documentType: expected.documentType,
        mappings,
      });
    });
  });
  if (canonicaliseJson(projected) !== canonicaliseJson(S33_WAVE3_FOUNDER_MAPPING_CONTRACT)) {
    throw new Error('Founder coverage mapping does not match the frozen 3x15 taxonomy contract');
  }
  for (const mapping of projected.flatMap(({ mappings }) => mappings)) {
    if (!S33_WAVE3_FROZEN_SUBTYPE_TAXONOMY[mapping.credentialType]?.includes(mapping.subType)) {
      throw new Error('Founder coverage mapping is outside the frozen 105-value subtype taxonomy');
    }
  }
  return canonicalDigest(projected);
}

function validateCorpusRegistry(value: unknown): {
  digest: string;
  entries: AcceptedEntry[];
  batches: AcceptedBatch[];
  wave1PacketBlobs: Readonly<Record<string, string>>;
} {
  const registry = record(value, 'Accepted corpus registry');
  if (registry.schemaVersion !== 1
    || registry.artifactType !== 'arkova-s33-wave2-corpus-registry'
    || registry.algorithmVersion !== 's33-wave2-corpus-registry-v1'
    || registry.repositoryIdentity !== 'carson-see/ArkovaCarson') {
    throw new Error('Accepted corpus registry identity mismatch');
  }
  sha(registry.verificationHeadSha, SHA1, 'Accepted corpus verification head');
  sha(registry.verificationTreeSha, SHA1, 'Accepted corpus verification tree');
  const digest = sha(registry.registryDigestSha256, SHA256, 'Accepted corpus registry digest');
  const corpusIdentity = { ...registry };
  delete corpusIdentity.verificationHeadSha;
  delete corpusIdentity.verificationTreeSha;
  delete corpusIdentity.registryDigestSha256;
  if (canonicalDigest(corpusIdentity) !== digest) throw new Error('Accepted corpus registry digest mismatch');

  const wave1Tuple = record(registry.wave1Tuple, 'Accepted corpus Wave-1 tuple');
  if (canonicaliseJson(wave1Tuple) !== canonicaliseJson(S33_WAVE3_FROZEN_WAVE1_TUPLE)) {
    throw new Error('Accepted corpus full Wave-1 immutable tuple/source-blob mismatch');
  }
  const batchCandidates = array(registry.acceptedBatches, 'Accepted corpus batches');
  if (batchCandidates.length === 0) throw new Error('Accepted corpus batches are missing');
  const batchKeys = new Map<string, AcceptedBatch>();
  const batches: AcceptedBatch[] = [];
  for (const [index, candidate] of batchCandidates.entries()) {
    const batch = record(candidate, `Accepted corpus batch ${index}`);
    const batchId = nonEmpty(batch.batchId, `Accepted corpus batch ${index} id`);
    const revision = finite(batch.revision, `Accepted corpus batch ${batchId} revision`);
    const entryCount = finite(batch.entryCount, `Accepted corpus batch ${batchId} entryCount`);
    const sourcePath = nonEmpty(batch.sourcePath, `Accepted corpus batch ${batchId} sourcePath`);
    const sourceBlobSha = sha(batch.sourceBlobSha, SHA1, `Accepted corpus batch ${batchId} source blob`);
    const manifestPath = nonEmpty(batch.manifestPath, `Accepted corpus batch ${batchId} manifestPath`);
    const manifestRawSha256 = sha(
      batch.manifestRawSha256,
      SHA256,
      `Accepted corpus batch ${batchId} manifest raw digest`,
    );
    const datasheetBlobSha = sha(
      batch.datasheetBlobSha,
      SHA1,
      `Accepted corpus batch ${batchId} datasheet blob`,
    );
    if (!Number.isInteger(revision) || revision < 1 || !Number.isInteger(entryCount) || entryCount < 1) {
      throw new Error(`Accepted corpus batch ${batchId} revision/count is invalid`);
    }
    if (batchKeys.has(batchId)) throw new Error(`Accepted corpus batch ${batchId} is duplicated`);
    const acceptedBatch = {
      batchId,
      revision,
      entryCount,
      sourcePath,
      sourceBlobSha,
      manifestPath,
      manifestRawSha256,
      datasheetBlobSha,
    };
    if (batchId === 'S33-W1' && (index !== 0
      || revision !== 12
      || entryCount !== 81
      || sourcePath !== 'immutable-pr-1544-wave1-packet'
      || sourceBlobSha !== S33_WAVE3_FROZEN_WAVE1_TUPLE.producerTreeSha)) {
      throw new Error('Accepted corpus Wave-1 batch tuple mismatch');
    }
    batchKeys.set(batchId, acceptedBatch);
    batches.push(acceptedBatch);
  }

  const ids = new Set<string>();
  const hashes = new Set<string>();
  const batchCounts = new Map<string, number>();
  const entries = array(registry.entries, 'Accepted corpus entries').map((candidate, index): AcceptedEntry => {
    const entry = record(candidate, `Accepted corpus entry ${index}`);
    const id = nonEmpty(entry.id, `Accepted corpus entry ${index} id`);
    const domain = nonEmpty(entry.domain, `Accepted corpus entry ${id} domain`);
    const credentialType = nonEmpty(entry.credentialType, `Accepted corpus entry ${id} credentialType`);
    const normalizedInputSha256 = sha(
      entry.normalizedInputSha256,
      SHA256,
      `Accepted corpus entry ${id} normalized input`,
    );
    const batchId = nonEmpty(entry.batchId, `Accepted corpus entry ${id} batchId`);
    const revision = finite(entry.revision, `Accepted corpus entry ${id} revision`);
    const sourcePath = nonEmpty(entry.sourcePath, `Accepted corpus entry ${id} sourcePath`);
    const batch = batchKeys.get(batchId);
    if (!FROZEN_TYPE_SET.has(credentialType) && !(batchId === 'S33-W1' && credentialType === 'CPE')) {
      throw new Error(`Accepted corpus entry ${id} is outside the frozen 24 types/Wave-1 legacy quarantine`);
    }
    if (!batch || batch.revision !== revision || batch.sourcePath !== sourcePath) {
      throw new Error(`Accepted corpus entry ${id} batch binding mismatch`);
    }
    if (ids.has(id) || hashes.has(normalizedInputSha256)) throw new Error('Accepted corpus ids/normalized inputs are not unique');
    ids.add(id);
    hashes.add(normalizedInputSha256);
    batchCounts.set(batchId, (batchCounts.get(batchId) ?? 0) + 1);
    return { id, domain, credentialType, normalizedInputSha256, batchId, revision, sourcePath };
  });
  if (entries.length === 0) throw new Error('Accepted corpus entries are missing');
  for (const [batchId, batch] of batchKeys) {
    if ((batchCounts.get(batchId) ?? 0) !== batch.entryCount) {
      throw new Error(`Accepted corpus batch ${batchId} entry count mismatch`);
    }
  }
  const wave1PacketBlobsCandidate = wave1Tuple.packetBlobs;
  const wave1PacketBlobs = wave1PacketBlobsCandidate === undefined
    ? {}
    : Object.fromEntries(Object.entries(record(
      wave1PacketBlobsCandidate,
      'Accepted corpus Wave-1 packet blobs',
    )).map(([path, blob]) => [path, sha(blob, SHA1, `Accepted corpus Wave-1 packet blob ${path}`)]));
  return { digest, entries, batches, wave1PacketBlobs };
}

function expectedProducerExportName(sourcePath: string): string {
  const wave1Export = (WAVE1_PACKET_SOURCE_EXPORTS as Readonly<Record<string, string>>)[sourcePath];
  if (wave1Export) return wave1Export;
  const match = sourcePath.match(
    /^services\/worker\/src\/ai\/eval\/golden-dataset-s33-wave2-([a-z0-9-]+)-heldout\.ts$/u,
  );
  if (!match) throw new Error(`Accepted gold source path has no frozen export contract: ${sourcePath}`);
  return `S33_WAVE2_${match[1].toUpperCase().replaceAll('-', '_')}_HELDOUT`;
}

function gitBlobSha1(sourceText: string): string {
  const bytes = Buffer.from(sourceText, 'utf8');
  return createHash('sha1')
    .update(`blob ${bytes.byteLength}\0`, 'utf8')
    .update(bytes)
    .digest('hex');
}

function normalizedInputSha256(strippedText: string): string {
  return sha256(strippedText.toLowerCase().replace(/\s+/gu, ' ').trim());
}

function hasScoredValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasScoredValue);
  if (typeof value === 'object') return Object.values(value as JsonRecord).some(hasScoredValue);
  return true;
}

function assertFiniteLiteral(value: unknown, label: string): void {
  if (value === null) return;
  if (value === undefined) throw new Error(`${label} cannot be undefined`);
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertFiniteLiteral(child, `${label}[${index}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as JsonRecord)) {
      assertFiniteLiteral(child, `${label}.${key}`);
    }
  } else if (!['string', 'number', 'boolean'].includes(typeof value)) {
    throw new Error(`${label} is not a literal JSON-compatible value`);
  }
}

export function deriveS33Wave3ValidatedGoldFields(groundTruth: Record<string, unknown>): {
  fields: Record<string, unknown>;
  substantiveDepth: number;
} {
  const candidate = record(groundTruth, 'Wave-3 raw gold fields');
  assertFiniteLiteral(candidate, 'Wave-3 raw gold fields');
  const fields = validateFieldsForType({ ...candidate } as ExtractedFields).fields as unknown as JsonRecord;
  const substantiveDepth = S33_WAVE3_SUBSTANTIVE_FIELDS.filter((field) => (
    hasScoredValue(fields[field])
  )).length;
  return { fields, substantiveDepth };
}

function deriveFounderTypeId(
  entry: AcceptedEntry,
  source: string,
  credentialType: string,
  subType: string,
): string | null {
  const pathSegments = new Set(source.split('/'));
  const matches = S33_WAVE3_FOUNDER_MAPPING_CONTRACT.filter(({ id }) => pathSegments.has(id));
  if (FOUNDER_DOMAINS.includes(entry.domain as FounderDomain)) {
    if (matches.length !== 1) {
      throw new Error(`Trusted gold row ${entry.id} must bind exactly one frozen founder type in source`);
    }
    const [match] = matches;
    if (match.domain !== entry.domain || !match.mappings.some((mapping) => (
      mapping.credentialType === credentialType && mapping.subType === subType
    ))) {
      throw new Error(`Trusted gold row ${entry.id} founder source/taxonomy binding mismatch`);
    }
    return match.id;
  }
  if (matches.length !== 0) {
    throw new Error(`Trusted gold row ${entry.id} has a founder source outside a frozen founder domain`);
  }
  return null;
}

function validateTrustedGoldSources(
  value: unknown,
  corpus: ReturnType<typeof validateCorpusRegistry>,
): { sources: S33Wave3TrustedGoldSource[]; entries: TrustedGoldEntry[] } {
  const expectedSources: Array<{ sourcePath: string; sourceBlobSha: string; exportName: string }> = [];
  const seenExpected = new Set<string>();
  for (const batch of corpus.batches) {
    if (batch.sourcePath === 'immutable-pr-1544-wave1-packet') {
      for (const [sourcePath, exportName] of Object.entries(WAVE1_PACKET_SOURCE_EXPORTS)) {
        const sourceBlobSha = corpus.wave1PacketBlobs[sourcePath];
        if (!sourceBlobSha) throw new Error(`Accepted corpus Wave-1 source blob is missing: ${sourcePath}`);
        const key = `${sourcePath}\0${sourceBlobSha}`;
        if (!seenExpected.has(key)) expectedSources.push({ sourcePath, sourceBlobSha, exportName });
        seenExpected.add(key);
      }
    } else {
      const exportName = expectedProducerExportName(batch.sourcePath);
      const key = `${batch.sourcePath}\0${batch.sourceBlobSha}`;
      if (!seenExpected.has(key)) {
        expectedSources.push({ sourcePath: batch.sourcePath, sourceBlobSha: batch.sourceBlobSha, exportName });
      }
      seenExpected.add(key);
    }
  }

  const sourceCandidates = array(value, 'Wave-3 trusted gold sources');
  if (sourceCandidates.length !== expectedSources.length) {
    throw new Error('Wave-3 trusted gold source binding count mismatch');
  }
  const trustedSources = sourceCandidates.map((candidate, index): S33Wave3TrustedGoldSource => {
    const source = record(candidate, `Wave-3 trusted gold source ${index}`);
    exactKeys(source, ['sourcePath', 'sourceBlobSha', 'exportName', 'sourceText'], `Wave-3 trusted gold source ${index}`);
    const expected = expectedSources[index];
    const sourcePath = nonEmpty(source.sourcePath, `Wave-3 trusted gold source ${index} path`);
    const sourceBlobSha = sha(source.sourceBlobSha, SHA1, `Wave-3 trusted gold source ${index} blob`);
    const exportName = nonEmpty(source.exportName, `Wave-3 trusted gold source ${index} export`);
    const sourceText = nonEmpty(source.sourceText, `Wave-3 trusted gold source ${index} text`);
    if (sourcePath !== expected.sourcePath
      || sourceBlobSha !== expected.sourceBlobSha
      || exportName !== expected.exportName) {
      throw new Error(`Wave-3 trusted gold source ${index} accepted-source binding mismatch`);
    }
    if (gitBlobSha1(sourceText) !== sourceBlobSha) {
      throw new Error(`Wave-3 trusted gold source ${sourcePath} Git blob mismatch`);
    }
    return { sourcePath, sourceBlobSha, exportName, sourceText };
  });

  const parsedRows = new Map<string, { row: JsonRecord; source: S33Wave3TrustedGoldSource }>();
  for (const source of trustedSources) {
    const rows = parseS33ProducerModuleWithLimit(
      source.sourceText,
      source.sourcePath,
      source.exportName,
      MAX_TRUSTED_GOLD_ROWS,
    );
    for (const row of rows) {
      const id = nonEmpty(row.id, `${source.sourcePath} trusted gold id`);
      if (parsedRows.has(id)) throw new Error(`Trusted gold row ${id} is duplicated`);
      parsedRows.set(id, { row, source });
    }
  }
  if (parsedRows.size !== corpus.entries.length) {
    throw new Error('Trusted gold rows do not bijectively cover accepted corpus ids');
  }

  const entries = corpus.entries.map((entry): TrustedGoldEntry => {
    const parsed = parsedRows.get(entry.id);
    if (!parsed) throw new Error(`Trusted gold row is missing for accepted id ${entry.id}`);
    const { row, source: goldSource } = parsed;
    const strippedText = nonEmpty(row.strippedText, `Trusted gold row ${entry.id} strippedText`);
    if (normalizedInputSha256(strippedText) !== entry.normalizedInputSha256) {
      throw new Error(`Trusted gold row ${entry.id} normalized input mismatch`);
    }
    if (entry.sourcePath !== 'immutable-pr-1544-wave1-packet' && goldSource.sourcePath !== entry.sourcePath) {
      throw new Error(`Trusted gold row ${entry.id} accepted source path mismatch`);
    }
    const groundTruth = record(row.groundTruth, `Trusted gold row ${entry.id} groundTruth`);
    assertFiniteLiteral(groundTruth, `Trusted gold row ${entry.id} groundTruth`);
    const credentialType = nonEmpty(
      groundTruth.credentialType,
      `Trusted gold row ${entry.id} credentialType`,
    );
    const subType = nonEmpty(groundTruth.subType, `Trusted gold row ${entry.id} subType`);
    if (credentialType !== entry.credentialType) {
      throw new Error(`Trusted gold row ${entry.id} credentialType contradicts accepted registry`);
    }
    const allowedSubtypes = S33_WAVE3_FROZEN_SUBTYPE_TAXONOMY[credentialType];
    const wave1LegacyCpe = entry.batchId === 'S33-W1'
      && credentialType === 'CPE'
      && WAVE1_LEGACY_CPE_SUBTYPES.has(subType);
    if (!wave1LegacyCpe && (allowedSubtypes ? !allowedSubtypes.includes(subType) : subType !== 'other')) {
      throw new Error(`Trusted gold row ${entry.id} subtype is outside the frozen taxonomy`);
    }
    const exactOod = /^GD-S33-OOD-\d{3}$/u.test(entry.id)
      && credentialType === 'OTHER'
      && subType === 'other'
      && Array.isArray(groundTruth.fraudSignals)
      && groundTruth.fraudSignals.length === 0
      && Object.keys(groundTruth).sort(compareUtf16CodeUnits).join(',') === 'credentialType,fraudSignals,subType';
    const { fields: scoringGroundTruth, substantiveDepth } = deriveS33Wave3ValidatedGoldFields(groundTruth);
    if (!exactOod && substantiveDepth < 5) {
      throw new Error(`Trusted gold row ${entry.id} substantive field depth is below 5`);
    }
    const source = nonEmpty(row.source, `Trusted gold row ${entry.id} source`);
    const edgeCase = boolean(row.edgeCase, `Trusted gold row ${entry.id} edgeCase`);
    return {
      id: entry.id,
      strippedText,
      source,
      groundTruth,
      scoringGroundTruth,
      credentialType,
      subType,
      founderTypeId: deriveFounderTypeId(entry, source, credentialType, subType),
      edgeCase,
      sourcePath: goldSource.sourcePath,
      sourceBlobSha: goldSource.sourceBlobSha,
    };
  });
  return { sources: trustedSources, entries };
}

function validateAuthenticatedAcceptanceChain(
  value: unknown,
  corpus: ReturnType<typeof validateCorpusRegistry>,
  goldEntries: readonly TrustedGoldEntry[],
  testOnlyTrustRoot?: S33Wave2AcceptanceTrustRoot,
): readonly S33Wave2AuthenticatedBatchAcceptance[] {
  const acceptances = array(value, 'Wave-3 authenticated batch acceptances');
  const wave1Batch = corpus.batches.find(({ batchId }) => batchId === 'S33-W1');
  if (!wave1Batch && testOnlyTrustRoot === undefined) {
    throw new Error('Accepted corpus omits the immutable Wave-1 baseline batch');
  }
  if (wave1Batch) {
    const wave1Entries = corpus.entries.filter(({ batchId }) => batchId === 'S33-W1');
    if (wave1Entries.length !== 81) throw new Error('Accepted corpus Wave-1 baseline entry count mismatch');
  }

  const authenticatedBatches = corpus.batches.filter(({ batchId }) => batchId !== 'S33-W1');
  if (acceptances.length !== authenticatedBatches.length) {
    throw new Error('Wave-3 authenticated acceptance count does not match post-Wave-1 batches');
  }
  if (authenticatedBatches.length === 0 && corpus.digest !== WAVE1_BASE_REGISTRY_DIGEST_SHA256) {
    throw new Error('Accepted corpus base-only digest is not the immutable Wave-1 registry digest');
  }

  const goldById = new Map(goldEntries.map((entry) => [entry.id, entry]));
  let previousRegistryDigest = WAVE1_BASE_REGISTRY_DIGEST_SHA256;
  return authenticatedBatches.map((batch, index) => {
    const envelopeCandidate = record(acceptances[index], `Wave-3 batch acceptance ${index}`);
    const payload = record(envelopeCandidate.payload, `Wave-3 batch acceptance ${index} payload`);
    if (payload.baseRegistryDigestSha256 !== previousRegistryDigest) {
      throw new Error(`Wave-3 batch ${batch.batchId} acceptance registry chain is broken`);
    }
    const resultingRegistryDigestSha256 = sha(
      payload.resultingRegistryDigestSha256,
      SHA256,
      `Wave-3 batch ${batch.batchId} resulting registry digest`,
    );
    if (index === authenticatedBatches.length - 1 && resultingRegistryDigestSha256 !== corpus.digest) {
      throw new Error('Wave-3 final authenticated registry digest does not bind the supplied corpus');
    }
    const batchEntries = corpus.entries.filter(({ batchId }) => batchId === batch.batchId);
    const acceptedEntryOrderSha256 = computeS33Wave2AcceptedEntryOrderSha256(
      batchEntries.map(({ id }) => id),
    );
    const verified = verifyS33Wave2AuthenticatedBatchAcceptance(
      envelopeCandidate,
      {
        repositoryIdentity: 'carson-see/ArkovaCarson',
        pullRequestNumber: finite(payload.pullRequestNumber, `Wave-3 batch ${batch.batchId} pull request`),
        candidateBaseSha: nonEmpty(payload.candidateBaseSha, `Wave-3 batch ${batch.batchId} candidate base`),
        candidateHeadSha: nonEmpty(payload.candidateHeadSha, `Wave-3 batch ${batch.batchId} candidate head`),
        candidateTreeSha: nonEmpty(payload.candidateTreeSha, `Wave-3 batch ${batch.batchId} candidate tree`),
        batchId: batch.batchId,
        revision: batch.revision,
        manifestPath: batch.manifestPath,
        manifestRawSha256: batch.manifestRawSha256,
        manifestCanonicalSha256: nonEmpty(
          payload.manifestCanonicalSha256,
          `Wave-3 batch ${batch.batchId} manifest canonical digest`,
        ),
        sourceBlobSha: batch.sourceBlobSha,
        datasheetBlobSha: batch.datasheetBlobSha,
        preflightArtifactDigestSha256: nonEmpty(
          payload.preflightArtifactDigestSha256,
          `Wave-3 batch ${batch.batchId} preflight digest`,
        ),
        baseRegistryDigestSha256: previousRegistryDigest,
        resultingRegistryDigestSha256,
        coverageRegistryPath: 'docs/lane4/s33-wave2-top15-registry.json',
        coverageRegistryRawSha256: nonEmpty(
          payload.coverageRegistryRawSha256,
          `Wave-3 batch ${batch.batchId} coverage registry raw digest`,
        ),
        coverageRegistryCanonicalSha256: nonEmpty(
          payload.coverageRegistryCanonicalSha256,
          `Wave-3 batch ${batch.batchId} coverage registry canonical digest`,
        ),
        acceptedEntryOrderSha256,
      },
      testOnlyTrustRoot ? { testOnlyTrustRoot } : undefined,
    );
    if (verified.payload.acceptedEntries.length !== batchEntries.length) {
      throw new Error(`Wave-3 batch ${batch.batchId} signed entry count mismatch`);
    }
    verified.payload.acceptedEntries.forEach((signed, entryIndex) => {
      const accepted = batchEntries[entryIndex];
      const gold = goldById.get(accepted.id);
      if (!gold
        || signed.id !== accepted.id
        || signed.batchId !== accepted.batchId
        || signed.revision !== accepted.revision
        || signed.credentialType !== accepted.credentialType
        || signed.normalizedInputSha256 !== accepted.normalizedInputSha256
        || signed.sourceBlobSha !== batch.sourceBlobSha
        || signed.subType !== gold.subType
        || signed.groundTruthSha256 !== canonicalDigest(gold.groundTruth)) {
        throw new Error(`Wave-3 batch ${batch.batchId} signed entry ${accepted.id} truth/source binding mismatch`);
      }
      const substantiveDepth = deriveS33Wave3ValidatedGoldFields(gold.groundTruth).substantiveDepth;
      if (signed.productionValidSubstantiveFieldCount !== substantiveDepth) {
        throw new Error(`Wave-3 batch ${batch.batchId} signed entry ${accepted.id} depth binding mismatch`);
      }
      if (gold.founderTypeId === null) {
        throw new Error(`Wave-3 batch ${batch.batchId} signed entry ${accepted.id} is outside the founder corpus`);
      }
      if (signed.registryTypeId !== gold.founderTypeId) {
        throw new Error(`Wave-3 batch ${batch.batchId} signed entry ${accepted.id} founder binding mismatch`);
      }
      if (signed.edgeCase !== gold.edgeCase) {
        throw new Error(`Wave-3 batch ${batch.batchId} signed entry ${accepted.id} edgeCase binding mismatch`);
      }
    });
    previousRegistryDigest = resultingRegistryDigestSha256;
    return verified;
  });
}

function validateAcceptanceTrustRootFingerprint(value: unknown): string {
  const root = record(value, 'Wave-3 acceptance trust root');
  exactKeys(root, [
    'signerIdentity', 'signingKeyId', 'publicKeySpkiPem', 'publicKeyFingerprintSha256',
  ], 'Wave-3 acceptance trust root');
  if (root.signerIdentity !== S33_WAVE2_ACCEPTANCE_CONSTANTS.signerIdentity
    || root.signingKeyId !== S33_WAVE2_ACCEPTANCE_CONSTANTS.signingKeyId) {
    throw new Error('Wave-3 acceptance trust root uses the wrong signing authority');
  }
  const fingerprint = sha(
    root.publicKeyFingerprintSha256,
    SHA256,
    'Wave-3 acceptance trust-root fingerprint',
  );
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey(nonEmpty(root.publicKeySpkiPem, 'Wave-3 acceptance trust-root SPKI PEM'));
  } catch (error) {
    throw new Error('Wave-3 acceptance trust-root SPKI PEM is invalid', { cause: error });
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Wave-3 acceptance trust-root key must be Ed25519');
  }
  if (sha256(publicKey.export({ type: 'spki', format: 'der' })) !== fingerprint) {
    throw new Error('Wave-3 acceptance trust-root fingerprint does not match its public SPKI');
  }
  return fingerprint;
}

function expectedFounderIdsForBatch(batchIndex: number): string[] {
  const rangeStart = batchIndex * 5;
  return FOUNDER_DOMAINS.flatMap((domain) => (
    S33_WAVE3_FOUNDER_MAPPING_CONTRACT
      .filter((mapping) => mapping.domain === domain)
      .slice(rangeStart, rangeStart + 5)
      .map(({ id }) => id)
  ));
}

export function assessS33Wave3ReleaseCorpusFreeze(
  snapshot: S33Wave3VerifiedCorpusFreezeSnapshot,
): S33Wave3EvaluationReport['corpusFreeze'] {
  const corpusDigest = sha(
    snapshot.suppliedCorpusRegistryDigestSha256,
    SHA256,
    'Wave-3 release-corpus supplied registry digest',
  );
  const corpusEntries = snapshot.acceptedCorpusEntries;
  const corpusBatches = snapshot.acceptedCorpusBatches;
  const acceptances = snapshot.authenticatedBatchAcceptances;
  const founderIds = S33_WAVE3_FOUNDER_MAPPING_CONTRACT.map(({ id }) => id);
  const founderTypeCounts = Object.fromEntries(founderIds.map((id) => [id, 0]));
  const founderTypeEdgeCaseCounts = Object.fromEntries(founderIds.map((id) => [id, 0]));
  let batchPartitionPassed = true;
  acceptances.forEach((acceptance, batchIndex) => {
    const expectedFounderIds = new Set(expectedFounderIdsForBatch(batchIndex));
    const batchFounderCounts = new Map<string, number>();
    for (const signed of acceptance.payload.acceptedEntries) {
      if (!(signed.registryTypeId in founderTypeCounts) || !expectedFounderIds.has(signed.registryTypeId)) {
        batchPartitionPassed = false;
        continue;
      }
      founderTypeCounts[signed.registryTypeId] += 1;
      if (signed.edgeCase) founderTypeEdgeCaseCounts[signed.registryTypeId] += 1;
      batchFounderCounts.set(signed.registryTypeId, (batchFounderCounts.get(signed.registryTypeId) ?? 0) + 1);
    }
    if (acceptance.payload.acceptedEntries.length !== 180
      || expectedFounderIds.size !== 15
      || [...expectedFounderIds].some((id) => batchFounderCounts.get(id) !== 12)) {
      batchPartitionPassed = false;
    }
  });

  const immutableWave1EntryCount = corpusEntries.filter(({ batchId }) => batchId === 'S33-W1').length;
  const postWave1Batches = corpusBatches.filter(({ batchId }) => batchId !== 'S33-W1');
  const actualPostWave1BatchIds = postWave1Batches.map(({ batchId }) => batchId);
  const postWave1BatchEntryCounts = Object.fromEntries(
    postWave1Batches.map(({ batchId, entryCount }) => [batchId, entryCount]),
  );
  const orderedBatchContractPassed = canonicaliseJson(actualPostWave1BatchIds)
    === canonicaliseJson(TOP15_BATCH_CONTRACT)
    && postWave1Batches.every(({ entryCount }) => entryCount === 180)
    && acceptances.length === TOP15_BATCH_CONTRACT.length
    && acceptances.every(({ payload }, index) => payload.batchId === TOP15_BATCH_CONTRACT[index])
    && batchPartitionPassed;
  const founderCounts = Object.values(founderTypeCounts);
  const founderEdgeCaseCounts = Object.values(founderTypeEdgeCaseCounts);
  const founderCountContractPassed = founderCounts.every((count) => count === 12);
  const edgeCaseContractPassed = founderEdgeCaseCounts.every((count) => count >= 4);
  const finalAuthenticatedRegistryDigestSha256 = acceptances.at(-1)?.payload.resultingRegistryDigestSha256 ?? null;
  const finalRegistryDigestMatches = finalAuthenticatedRegistryDigestSha256 === corpusDigest;
  const passed = immutableWave1EntryCount === 81
    && corpusEntries.length === 621
    && orderedBatchContractPassed
    && founderCountContractPassed
    && edgeCaseContractPassed
    && finalRegistryDigestMatches;
  return {
    expectedTotalEntryCount: 621,
    actualTotalEntryCount: corpusEntries.length,
    immutableWave1EntryCount,
    expectedPostWave1BatchIds: TOP15_BATCH_CONTRACT,
    actualPostWave1BatchIds,
    postWave1BatchEntryCounts,
    authenticatedBatchCount: acceptances.length,
    founderTypeCounts,
    founderTypeEdgeCaseCounts,
    minimumFounderTypeCount: Math.min(...founderCounts),
    minimumFounderTypeEdgeCaseCount: Math.min(...founderEdgeCaseCounts),
    finalAuthenticatedRegistryDigestSha256,
    suppliedCorpusRegistryDigestSha256: corpusDigest,
    finalRegistryDigestMatches,
    orderedBatchContractPassed,
    founderCountContractPassed,
    edgeCaseContractPassed,
    passed,
  };
}

export function createS33Wave3ArmManifest(
  arm: ArmName,
  corpusRegistryDigestSha256: string,
  entryIds: readonly string[],
): S33Wave3ArmManifest {
  if (!['public', 'v6', 'v71'].includes(arm)) throw new Error('Wave-3 arm is invalid');
  sha(corpusRegistryDigestSha256, SHA256, 'Wave-3 arm corpus registry digest');
  const ids = exactStringArray([...entryIds], `Wave-3 ${arm} arm entry ids`);
  const withoutDigest = {
    schemaVersion: 1 as const,
    artifactType: 'arkova-s33-wave3-eval-arm-manifest' as const,
    arm,
    corpusRegistryDigestSha256,
    entryIds: ids,
  };
  return deepFreeze({
    ...withoutDigest,
    manifestDigestSha256: canonicalDigest(withoutDigest),
  });
}

function validateArmManifest(
  value: unknown,
  expectedArm: ArmName,
  corpusDigest: string,
  entryIds: readonly string[],
): S33Wave3ArmManifest {
  const manifest = record(value, `Wave-3 ${expectedArm} arm manifest`);
  exactKeys(manifest, [
    'schemaVersion',
    'artifactType',
    'arm',
    'corpusRegistryDigestSha256',
    'entryIds',
    'manifestDigestSha256',
  ], `Wave-3 ${expectedArm} arm manifest`);
  if (manifest.schemaVersion !== 1
    || manifest.artifactType !== 'arkova-s33-wave3-eval-arm-manifest'
    || manifest.arm !== expectedArm) {
    throw new Error(`Wave-3 ${expectedArm} arm manifest identity mismatch`);
  }
  if (manifest.corpusRegistryDigestSha256 !== corpusDigest) {
    throw new Error(`Wave-3 ${expectedArm} arm corpus digest mismatch`);
  }
  const ids = exactStringArray(manifest.entryIds, `Wave-3 ${expectedArm} arm entry ids`);
  assertSameOrderedStrings(ids, entryIds, `Wave-3 ${expectedArm} arm accepted ids`);
  const manifestDigestSha256 = sha(
    manifest.manifestDigestSha256,
    SHA256,
    `Wave-3 ${expectedArm} arm manifest digest`,
  );
  const expected = createS33Wave3ArmManifest(expectedArm, corpusDigest, ids);
  if (manifestDigestSha256 !== expected.manifestDigestSha256) {
    throw new Error(`Wave-3 ${expectedArm} arm manifest digest mismatch`);
  }
  return expected;
}

function normalizedComparable(value: unknown): unknown {
  if (typeof value === 'string') return value.trim().replace(/\s+/gu, ' ').toLowerCase();
  if (Array.isArray(value)) {
    return value
      .map(normalizedComparable)
      .sort((left, right) => compareUtf16CodeUnits(canonicaliseJson(left), canonicaliseJson(right)));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as JsonRecord)
      .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
      .map(([key, child]) => [key, normalizedComparable(child)]));
  }
  return value;
}

function valuesMatch(expected: unknown, actual: unknown): boolean {
  return canonicaliseJson(normalizedComparable(expected)) === canonicaliseJson(normalizedComparable(actual));
}

function deriveFieldComparisons(
  gold: TrustedGoldEntry,
  arm: Pick<S33Wave3ArmObservation, 'predictedCredentialType' | 'subType' | 'extractedFields'>,
): S33Wave3FieldComparison[] {
  return ['credentialType', 'subType', 'fraudSignals', ...S33_WAVE3_SUBSTANTIVE_FIELDS].map((field) => {
    const expected = gold.scoringGroundTruth[field];
    const actual = field === 'credentialType'
      ? arm.predictedCredentialType
      : field === 'subType'
        ? arm.subType
        : arm.extractedFields[field];
    const expectedPresent = hasScoredValue(expected);
    const actualPresent = hasScoredValue(actual);
    return {
      field,
      expectedPresent,
      actualPresent,
      matched: (!expectedPresent && !actualPresent)
        || (expectedPresent && actualPresent && valuesMatch(expected, actual)),
    };
  });
}

function validateArmObservation(
  value: unknown,
  label: string,
  gold: TrustedGoldEntry,
): ValidatedArmObservation {
  const arm = record(value, label);
  exactKeys(arm, [
    'parsed',
    'predictedCredentialType',
    'suggestedType',
    'subType',
    'description',
    'extractedFields',
    'calibratedConfidence',
    'latencyMs',
    'tokensUsed',
  ], label);
  const parsed = boolean(arm.parsed, `${label} parsed`);
  const predictedCredentialType = arm.predictedCredentialType === null
    ? null
    : nonEmpty(arm.predictedCredentialType, `${label} predictedCredentialType`);
  if (parsed && (predictedCredentialType === null || !FROZEN_TYPE_SET.has(predictedCredentialType))) {
    throw new Error(`${label} parsed prediction is outside the frozen 24 types`);
  }
  if (!parsed && predictedCredentialType !== null) throw new Error(`${label} unparsed prediction must be null`);
  const calibratedConfidence = finite(arm.calibratedConfidence, `${label} calibratedConfidence`);
  const latencyMs = finite(arm.latencyMs, `${label} latencyMs`);
  const tokensUsed = finite(arm.tokensUsed, `${label} tokensUsed`);
  if (calibratedConfidence < 0 || calibratedConfidence > 1 || latencyMs < 0 || tokensUsed < 0) {
    throw new Error(`${label} metric is outside its finite range`);
  }
  const extractedFields = record(arm.extractedFields, `${label} extractedFields`);
  for (const [field, rawValue] of Object.entries(extractedFields)) {
    if (field !== 'fraudSignals' && !SUBSTANTIVE_FIELD_SET.has(field)) {
      throw new Error(`${label} extracted field ${field} is outside the deterministic scorer contract`);
    }
    assertFiniteLiteral(rawValue, `${label} extractedFields.${field}`);
  }
  const validated = {
    parsed,
    predictedCredentialType,
    suggestedType: nullableNonEmpty(arm.suggestedType, `${label} suggestedType`),
    subType: nullableNonEmpty(arm.subType, `${label} subType`),
    description: nullableNonEmpty(arm.description, `${label} description`),
    extractedFields,
    calibratedConfidence,
    latencyMs,
    tokensUsed,
  };
  if (!parsed && (validated.suggestedType !== null
    || validated.subType !== null
    || validated.description !== null
    || Object.keys(extractedFields).length !== 0)) {
    throw new Error(`${label} unparsed output cannot contain extracted values`);
  }
  const fieldComparisons = deriveFieldComparisons(gold, validated);
  scoreS33FieldComparisons(fieldComparisons);
  return { ...validated, fieldComparisons };
}

function validateObservations(
  values: unknown,
  entries: readonly AcceptedEntry[],
  goldEntries: readonly TrustedGoldEntry[],
): ValidatedObservation[] {
  const observations = array(values, 'Wave-3 observations');
  if (observations.length !== entries.length) throw new Error('Wave-3 observation accepted-id count mismatch');
  const seen = new Set<string>();
  return observations.map((candidate, index): ValidatedObservation => {
    const observation = record(candidate, `Wave-3 observation ${index}`);
    exactKeys(observation, [
      'entryId',
      'domain',
      'actualCredentialType',
      'actualSubType',
      'normalizedInputSha256',
      'founderTypeId',
      'arms',
    ], `Wave-3 observation ${index}`);
    const entry = entries[index];
    const gold = goldEntries[index];
    if (gold.id !== entry.id) throw new Error('Trusted gold/accepted corpus ordering mismatch');
    const entryId = nonEmpty(observation.entryId, `Wave-3 observation ${index} entryId`);
    if (entryId !== entry.id || seen.has(entryId)) throw new Error('Wave-3 observation accepted ids are not exact/unique');
    seen.add(entryId);
    const domain = nonEmpty(observation.domain, `Wave-3 observation ${entryId} domain`);
    const actualCredentialType = nonEmpty(
      observation.actualCredentialType,
      `Wave-3 observation ${entryId} actualCredentialType`,
    );
    const actualSubType = nonEmpty(observation.actualSubType, `Wave-3 observation ${entryId} actualSubType`);
    const normalizedInputSha256 = sha(
      observation.normalizedInputSha256,
      SHA256,
      `Wave-3 observation ${entryId} normalized input`,
    );
    if (domain !== entry.domain) throw new Error(`Wave-3 observation ${entryId} corpus domain binding mismatch`);
    if (actualCredentialType !== entry.credentialType || actualCredentialType !== gold.credentialType) {
      throw new Error(`Wave-3 observation ${entryId} corpus credentialType binding mismatch`);
    }
    if (actualSubType !== gold.subType) {
      throw new Error(`Wave-3 observation ${entryId} corpus subtype binding mismatch`);
    }
    if (normalizedInputSha256 !== entry.normalizedInputSha256) {
      throw new Error(`Wave-3 observation ${entryId} corpus normalized-input binding mismatch`);
    }
    const founderTypeId = observation.founderTypeId === null
      ? null
      : nonEmpty(observation.founderTypeId, `Wave-3 observation ${entryId} founderTypeId`);
    if (founderTypeId !== gold.founderTypeId) {
      throw new Error(`Wave-3 observation ${entryId} founder mapping contradicts trusted gold source`);
    }
    const arms = record(observation.arms, `Wave-3 observation ${entryId} arms`);
    exactKeys(arms, ['public', 'v6', 'v71'], `Wave-3 observation ${entryId} arms`);
    return {
      entryId,
      domain,
      actualCredentialType,
      actualSubType,
      normalizedInputSha256,
      founderTypeId,
      arms: {
        public: validateArmObservation(arms.public, `${entryId} public arm`, gold),
        v6: validateArmObservation(arms.v6, `${entryId} v6 arm`, gold),
        v71: validateArmObservation(arms.v71, `${entryId} v71 arm`, gold),
      },
    };
  });
}

function seed32(seedSha256: string): number {
  const parsed = Number.parseInt(seedSha256.slice(0, 8), 16) >>> 0;
  return parsed === 0 ? 0x9e3779b9 : parsed;
}

function pairedBootstrap(
  deltas: readonly number[],
  seedSha256: string,
  replicates = BOOTSTRAP_REPLICATES,
): S33Wave3BootstrapInterval {
  if (deltas.length < 2) throw new Error('Paired bootstrap has insufficient samples');
  if (!Number.isInteger(replicates) || replicates < BOOTSTRAP_REPLICATES) {
    throw new Error('Paired bootstrap replicates must be >=2000');
  }
  deltas.forEach((delta, index) => finite(delta, `Paired bootstrap delta ${index}`));
  let state = seed32(seedSha256);
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
  const samples = new Array<number>(replicates);
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    let sum = 0;
    for (let index = 0; index < deltas.length; index += 1) {
      sum += deltas[Math.floor(next() * deltas.length)];
    }
    samples[replicate] = sum / deltas.length;
  }
  samples.sort((left, right) => left - right);
  return {
    sampleSize: deltas.length,
    replicates,
    meanPairedDelta: mean(deltas),
    ci95Lower: samples[Math.floor((replicates - 1) * 0.025)],
    ci95Upper: samples[Math.ceil((replicates - 1) * 0.975)],
    seedSha256,
  };
}

function validateIntegrityEvidence(value: unknown): {
  validationErrorCount: number;
  heldoutLeakageNgram6To13Count: number;
  trainingOrGeneratorDerivedRowCount: number;
  productionCustomerDocumentCount: number;
} {
  const evidence = record(value, 'Wave-3 integrity evidence');
  exactKeys(evidence, [
    'validationErrors',
    'heldoutLeakageNgram6To13Findings',
    'trainingOrGeneratorDerivedRowIds',
    'productionCustomerDocumentIds',
  ], 'Wave-3 integrity evidence');
  return {
    validationErrorCount: exactStringArray(evidence.validationErrors, 'Integrity validation errors').length,
    heldoutLeakageNgram6To13Count: exactStringArray(
      evidence.heldoutLeakageNgram6To13Findings,
      'Integrity leakage findings',
    ).length,
    trainingOrGeneratorDerivedRowCount: exactStringArray(
      evidence.trainingOrGeneratorDerivedRowIds,
      'Integrity training/generator rows',
    ).length,
    productionCustomerDocumentCount: exactStringArray(
      evidence.productionCustomerDocumentIds,
      'Integrity production customer documents',
    ).length,
  };
}

function validateSurgeryEvidence(value: unknown): {
  droppedTrainingIds: string[];
  goodStandingStatusTrainingType: string;
  concreteSubtypeRate: number;
  invalidTaxonomyRowIds: string[];
  fraudStream: string;
  exportLastCheckpointOnly: boolean;
} {
  const evidence = record(value, 'Wave-3 surgery evidence');
  exactKeys(evidence, [
    'sourceTrainingRowIds',
    'exportedTrainingRows',
    'fraudStream',
    'exportLastCheckpointOnly',
  ], 'Wave-3 surgery evidence');
  const sourceIds = exactStringArray(evidence.sourceTrainingRowIds, 'Surgery source training row ids');
  const exported = array(evidence.exportedTrainingRows, 'Surgery exported training rows');
  if (exported.length === 0) throw new Error('Surgery exported training rows are missing');
  const exportedIds = new Set<string>();
  let concreteSubtypeCount = 0;
  let goodStandingCount = 0;
  let goodStandingStrings = true;
  let exportedFraudFieldCount = 0;
  const invalidTaxonomyRowIds: string[] = [];
  for (const [index, candidate] of exported.entries()) {
    const row = record(candidate, `Surgery exported training row ${index}`);
    const id = nonEmpty(row.id, `Surgery exported training row ${index} id`);
    if (exportedIds.has(id)) throw new Error(`Surgery exported training row ${id} is duplicated`);
    exportedIds.add(id);
    const credentialType = nonEmpty(row.credentialType, `Surgery exported training row ${id} credentialType`);
    const subType = nonEmpty(row.subType, `Surgery exported training row ${id} subType`);
    const explicitSubtypes = S33_WAVE3_FROZEN_SUBTYPE_TAXONOMY[credentialType];
    const taxonomyValid = explicitSubtypes?.includes(subType) === true
      || ((credentialType === 'OTHER' || credentialType === 'PUBLICATION') && subType === 'other');
    if (!FROZEN_TYPE_SET.has(credentialType) || !taxonomyValid) invalidTaxonomyRowIds.push(id);
    if (explicitSubtypes?.includes(subType) === true) concreteSubtypeCount += 1;
    if (Object.hasOwn(row, 'goodStandingStatus')) {
      goodStandingCount += 1;
      goodStandingStrings = goodStandingStrings
        && typeof row.goodStandingStatus === 'string'
        && row.goodStandingStatus.trim().length > 0;
    }
    exportedFraudFieldCount += Object.keys(row).filter((key) => /fraud/iu.test(key)).length;
  }
  const sourceSet = new Set(sourceIds);
  for (const id of exportedIds) {
    if (!sourceSet.has(id)) throw new Error(`Surgery exported row ${id} is absent from source rows`);
  }
  const droppedTrainingIds = sourceIds.filter((id) => !exportedIds.has(id)).sort(compareUtf16CodeUnits);
  const fraudStream = record(evidence.fraudStream, 'Surgery fraud stream');
  exactKeys(fraudStream, ['mode', 'rowIds'], 'Surgery fraud stream');
  const fraudRowIds = exactStringArray(fraudStream.rowIds, 'Surgery fraud stream row ids');
  if (fraudRowIds.length === 0) throw new Error('Surgery fraud stream rows are missing');
  const fraudSeparated = fraudStream.mode === 'split'
    && exportedFraudFieldCount === 0
    && fraudRowIds.every((id) => !exportedIds.has(id));
  return {
    droppedTrainingIds,
    goodStandingStatusTrainingType: goodStandingCount > 0 && goodStandingStrings ? 'string' : 'missing-or-non-string',
    concreteSubtypeRate: concreteSubtypeCount / exported.length,
    invalidTaxonomyRowIds,
    fraudStream: fraudSeparated ? 'split' : 'not-split',
    exportLastCheckpointOnly: boolean(evidence.exportLastCheckpointOnly, 'Surgery exportLastCheckpointOnly'),
  };
}

function validateJurisdictionManifests(
  value: unknown,
  acceptedIds: ReadonlySet<string>,
): { AU: readonly string[]; KE: readonly string[] } {
  const manifests = record(value, 'Wave-3 jurisdiction manifests');
  exactKeys(manifests, ['AU', 'KE'], 'Wave-3 jurisdiction manifests');
  const result = {} as { AU: readonly string[]; KE: readonly string[] };
  for (const jurisdiction of ['AU', 'KE'] as const) {
    const ids = exactStringArray(manifests[jurisdiction], `${jurisdiction} jurisdiction manifest`);
    assertSameOrderedStrings(ids, S33_WAVE3_JURISDICTION_MANIFESTS[jurisdiction], `${jurisdiction} jurisdiction manifest`);
    if (ids.length < 10 || ids.some((id) => !acceptedIds.has(id))) {
      throw new Error(`${jurisdiction} jurisdiction manifest is not an accepted >=10 slice`);
    }
    result[jurisdiction] = ids;
  }
  return result;
}

function validateInputPacketDigests(
  value: unknown,
  packets: S33Wave3RawInputPackets,
): S33Wave3InputPacketDigests {
  const supplied = record(value, 'Wave-3 input packet digests');
  const expectedKeys = [
    'authenticatedBatchAcceptancesCanonicalSha256',
    'integrityEvidenceCanonicalSha256',
    'jurisdictionManifestsCanonicalSha256',
    'observationsCanonicalSha256',
    'surgeryEvidenceCanonicalSha256',
    'trustedGoldSourcesCanonicalSha256',
  ];
  assertSameOrderedStrings(
    Object.keys(supplied).sort(compareUtf16CodeUnits),
    expectedKeys,
    'Wave-3 input packet digest keys',
  );
  const expected = createS33Wave3InputPacketDigests(packets);
  for (const key of expectedKeys as Array<keyof S33Wave3InputPacketDigests>) {
    const actual = sha(supplied[key], SHA256, `Wave-3 ${key}`);
    if (actual !== expected[key]) throw new Error(`Wave-3 ${key} mismatch`);
  }
  return expected;
}

function latencyPercentile(values: readonly number[], percentile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1];
}

function calibration(observations: readonly ValidatedObservation[]): S33Wave3EvaluationReport['calibration'] {
  const rows = observations.map((observation) => ({
    confidence: observation.arms.v71.calibratedConfidence,
    accuracy: scoreS33FieldComparisons(observation.arms.v71.fieldComparisons).standardF1,
  }));
  const meanGap = Math.abs(mean(rows.map(({ confidence }) => confidence)) - mean(rows.map(({ accuracy }) => accuracy)));
  const bins: S33Wave3EvaluationReport['calibration']['bins'] = [];
  let ece = 0;
  for (let index = 0; index < 10; index += 1) {
    const lower = index / 10;
    const upper = (index + 1) / 10;
    const selected = rows.filter(({ confidence }) => (
      confidence >= lower && (index === 9 ? confidence <= upper : confidence < upper)
    ));
    const meanConfidence = selected.length === 0 ? 0 : mean(selected.map(({ confidence }) => confidence));
    const meanAccuracy = selected.length === 0 ? 0 : mean(selected.map(({ accuracy }) => accuracy));
    const absoluteGap = selected.length === 0 ? 0 : Math.abs(meanConfidence - meanAccuracy);
    ece += (selected.length / rows.length) * absoluteGap;
    bins.push({ lower, upper, count: selected.length, meanConfidence, meanAccuracy, absoluteGap });
  }
  return { meanGap, ece, bins };
}

function diagnostics(observations: readonly ValidatedObservation[]): S33Wave3EvaluationReport['diagnostics'] {
  const confusionByDomain: S33Wave3EvaluationReport['diagnostics']['confusionByDomain'] = {};
  const confused = new Map<string, number>();
  const typeDomains = new Map<string, Set<FounderDomain>>();
  for (const contract of S33_WAVE3_FOUNDER_MAPPING_CONTRACT) {
    for (const { credentialType } of contract.mappings) {
      const domains = typeDomains.get(credentialType) ?? new Set<FounderDomain>();
      domains.add(contract.domain);
      typeDomains.set(credentialType, domains);
    }
  }
  let crossDomainConfusions = 0;
  let abstentionCount = 0;
  let correctAbstentions = 0;
  let malformedSuggestedTypeCount = 0;
  for (const observation of observations) {
    const predicted = observation.arms.v71.predictedCredentialType ?? 'UNPARSED';
    const domain = confusionByDomain[observation.domain] ?? { total: 0, matrix: {} };
    domain.total += 1;
    const row = domain.matrix[observation.actualCredentialType] ?? {};
    row[predicted] = (row[predicted] ?? 0) + 1;
    domain.matrix[observation.actualCredentialType] = row;
    confusionByDomain[observation.domain] = domain;
    if (predicted !== observation.actualCredentialType) {
      const key = `${observation.actualCredentialType}\u0000${predicted}`;
      confused.set(key, (confused.get(key) ?? 0) + 1);
      if (FOUNDER_DOMAINS.includes(observation.domain as FounderDomain)) {
        const predictedDomains = typeDomains.get(predicted);
        if (predictedDomains?.size === 1 && !predictedDomains.has(observation.domain as FounderDomain)) {
          crossDomainConfusions += 1;
        }
      }
    }
    if (predicted === 'OTHER') {
      abstentionCount += 1;
      if (observation.actualCredentialType === 'OTHER') correctAbstentions += 1;
      if (observation.arms.v71.suggestedType === null) malformedSuggestedTypeCount += 1;
    }
  }
  const top20ConfusedPairs = [...confused.entries()]
    .map(([key, count]) => {
      const [actual, predicted] = key.split('\u0000');
      return { actual, predicted, count };
    })
    .sort((left, right) => right.count - left.count
      || compareUtf16CodeUnits(left.actual, right.actual)
      || compareUtf16CodeUnits(left.predicted, right.predicted))
    .slice(0, 20);
  const ordered = [...observations].sort((left, right) => (
    right.arms.v71.calibratedConfidence - left.arms.v71.calibratedConfidence
      || compareUtf16CodeUnits(left.entryId, right.entryId)
  ));
  let correct = 0;
  const coverageAccuracyCurve = ordered.map((observation, index) => {
    if (observation.arms.v71.predictedCredentialType === observation.actualCredentialType) correct += 1;
    return {
      coverage: (index + 1) / ordered.length,
      accuracy: correct / (index + 1),
      threshold: observation.arms.v71.calibratedConfidence,
    };
  });
  return {
    confusionByDomain,
    top20ConfusedPairs,
    crossDomainConfusions,
    abstention: {
      count: abstentionCount,
      rate: abstentionCount / observations.length,
      precisionAtAbstention: abstentionCount === 0 ? 0 : correctAbstentions / abstentionCount,
      malformedSuggestedTypeCount,
      contractPassed: malformedSuggestedTypeCount === 0,
    },
    coverageAccuracyCurve,
  };
}

function gate(
  id: typeof S33_WAVE3_GATE_IDS[number],
  passed: boolean,
  metrics: Record<string, unknown>,
): S33Wave3GateResult {
  return { id, passed, metrics };
}

export function evaluateS33Wave3OfflineGates(input: S33Wave3EvaluationInput): S33Wave3EvaluationReport {
  const candidate = record(input, 'Wave-3 evaluation input') as unknown as S33Wave3EvaluationInput;
  const usesTestAuthority = candidate.testOnlyAcceptanceTrustRoot !== undefined;
  const acceptanceTrustRoot = usesTestAuthority
    ? candidate.testOnlyAcceptanceTrustRoot
    : S33_WAVE2_CTO_RELEASE_TRUST_ROOT;
  if (acceptanceTrustRoot === null || acceptanceTrustRoot === undefined) {
    throw new Error('Wave-3 CTO release trust root is not configured; evaluation fails closed');
  }
  const acceptanceTrustRootFingerprintSha256 = validateAcceptanceTrustRootFingerprint(
    acceptanceTrustRoot,
  );
  const gateBinding = validateGateRegistry(candidate.gateRegistryJson);
  const founderMappingCanonicalSha256 = validateFounderRegistry(candidate.founderCoverageRegistryJson);
  const corpus = validateCorpusRegistry(candidate.acceptedCorpusRegistry);
  const trustedGold = validateTrustedGoldSources(candidate.trustedGoldSources, corpus);
  const authenticatedBatchAcceptances = validateAuthenticatedAcceptanceChain(
    candidate.authenticatedBatchAcceptances,
    corpus,
    trustedGold.entries,
    candidate.testOnlyAcceptanceTrustRoot,
  );
  if (authenticatedBatchAcceptances.some(
    ({ publicKeyFingerprintSha256 }) => publicKeyFingerprintSha256 !== acceptanceTrustRootFingerprintSha256,
  )) {
    throw new Error('Wave-3 authenticated acceptance trust-root fingerprint binding mismatch');
  }
  const corpusFreeze = assessS33Wave3ReleaseCorpusFreeze({
    suppliedCorpusRegistryDigestSha256: corpus.digest,
    acceptedCorpusEntries: corpus.entries,
    acceptedCorpusBatches: corpus.batches,
    authenticatedBatchAcceptances,
  });
  const acceptedIds = corpus.entries.map(({ id }) => id);
  const manifests = {
    public: validateArmManifest(candidate.armManifests?.public, 'public', corpus.digest, acceptedIds),
    v6: validateArmManifest(candidate.armManifests?.v6, 'v6', corpus.digest, acceptedIds),
    v71: validateArmManifest(candidate.armManifests?.v71, 'v71', corpus.digest, acceptedIds),
  };
  const deterministicSeedSha256 = canonicalDigest({
    corpusRegistryDigestSha256: corpus.digest,
    armManifestDigests: {
      public: manifests.public.manifestDigestSha256,
      v6: manifests.v6.manifestDigestSha256,
      v71: manifests.v71.manifestDigestSha256,
    },
  });
  const observations = validateObservations(candidate.observations, corpus.entries, trustedGold.entries);
  const integrity = validateIntegrityEvidence(candidate.integrityEvidence);
  const surgery = validateSurgeryEvidence(candidate.surgeryEvidence);
  const jurisdictionManifests = validateJurisdictionManifests(
    candidate.jurisdictionManifests,
    new Set(acceptedIds),
  );
  const inputPacketDigests = validateInputPacketDigests(candidate.inputPacketDigests, {
    observations: candidate.observations,
    integrityEvidence: candidate.integrityEvidence,
    surgeryEvidence: candidate.surgeryEvidence,
    jurisdictionManifests: candidate.jurisdictionManifests,
    trustedGoldSources: candidate.trustedGoldSources,
    authenticatedBatchAcceptances: candidate.authenticatedBatchAcceptances,
  });

  const scoreByArm = Object.fromEntries((['public', 'v6', 'v71'] as const).map((armName) => [
    armName,
    new Map(observations.map((observation) => [
      observation.entryId,
      scoreS33FieldComparisons(observation.arms[armName].fieldComparisons),
    ])),
  ])) as Record<ArmName, Map<string, S33Wave3FieldScore>>;

  const perTypeF1: Record<string, number> = {};
  const perTypeCoverageAdjustedF1: Record<string, number> = {};
  const perTypeV6F1: Record<string, number> = {};
  const perTypePublicF1: Record<string, number> = {};
  const perTypePublicCoverageF1: Record<string, number> = {};
  const support: Record<string, number> = {};
  for (const credentialType of S33_WAVE3_FROZEN_CREDENTIAL_TYPES) {
    const rows = observations.filter((observation) => observation.actualCredentialType === credentialType);
    support[credentialType] = rows.length;
    if (rows.length === 0) {
      perTypeF1[credentialType] = 0;
      perTypeCoverageAdjustedF1[credentialType] = 0;
      perTypeV6F1[credentialType] = 0;
      perTypePublicF1[credentialType] = 0;
      perTypePublicCoverageF1[credentialType] = 0;
      continue;
    }
    const v71 = aggregateScores(rows.map((row) => row.arms.v71.fieldComparisons));
    const v6 = aggregateScores(rows.map((row) => row.arms.v6.fieldComparisons));
    const publicBaseline = aggregateScores(rows.map((row) => row.arms.public.fieldComparisons));
    perTypeF1[credentialType] = v71.standardF1;
    perTypeCoverageAdjustedF1[credentialType] = v71.coverageAdjustedF1;
    perTypeV6F1[credentialType] = v6.standardF1;
    perTypePublicF1[credentialType] = publicBaseline.standardF1;
    perTypePublicCoverageF1[credentialType] = publicBaseline.coverageAdjustedF1;
  }
  const supportedTypes = S33_WAVE3_FROZEN_CREDENTIAL_TYPES.filter((type) => support[type] > 0);
  const macroF1 = mean(supportedTypes.map((type) => perTypeF1[type]));
  const totalSupport = Object.values(support).reduce((sum, count) => sum + count, 0);
  const weightedF1 = S33_WAVE3_FROZEN_CREDENTIAL_TYPES.reduce(
    (sum, type) => sum + (perTypeF1[type] * support[type]),
    0,
  ) / totalSupport;
  const coverageAdjustedF1 = aggregateScores(
    observations.map((observation) => observation.arms.v71.fieldComparisons),
  ).coverageAdjustedF1;
  const perTypeDeltaVsV6 = Object.fromEntries(S33_WAVE3_FROZEN_CREDENTIAL_TYPES.map((type) => [
    type,
    perTypeF1[type] - perTypeV6F1[type],
  ]));
  const perTypeDeltaVsPublic = Object.fromEntries(S33_WAVE3_FROZEN_CREDENTIAL_TYPES.map((type) => [
    type,
    perTypeF1[type] - perTypePublicF1[type],
  ]));
  const perTypeCoverageAdjustedDeltaVsPublic = Object.fromEntries(
    S33_WAVE3_FROZEN_CREDENTIAL_TYPES.map((type) => [
      type,
      perTypeCoverageAdjustedF1[type] - perTypePublicCoverageF1[type],
    ]),
  );
  const minimumPerTypeDeltaVsV6 = Math.min(...Object.values(perTypeDeltaVsV6));
  const minimumPerTypeDeltaVsPublic = Math.min(...Object.values(perTypeDeltaVsPublic));
  const minimumCoverageAdjustedDeltaVsPublic = Math.min(
    ...Object.values(perTypeCoverageAdjustedDeltaVsPublic),
  );
  const publicBaselineGuardPassed = minimumPerTypeDeltaVsPublic >= REGRESSION_FLOOR
    && minimumCoverageAdjustedDeltaVsPublic >= REGRESSION_FLOOR;

  const bootstrapByDomain = {} as Record<FounderDomain, S33Wave3BootstrapInterval>;
  for (const domain of FOUNDER_DOMAINS) {
    const rows = observations.filter((observation) => observation.domain === domain);
    if (rows.length < 10) throw new Error(`${domain} paired bootstrap has insufficient samples`);
    const deltas = rows.map((row) => (
      scoreByArm.v71.get(row.entryId)!.standardF1 - scoreByArm.v6.get(row.entryId)!.standardF1
    ));
    bootstrapByDomain[domain] = pairedBootstrap(
      deltas,
      sha256(`${deterministicSeedSha256}:${domain}`),
    );
  }
  const positiveControl = pairedBootstrap(
    Array.from({ length: 32 }, () => 0.1),
    sha256(`${deterministicSeedSha256}:known-positive-control`),
  );
  const negativeControl = pairedBootstrap(
    Array.from({ length: 32 }, () => -0.1),
    sha256(`${deterministicSeedSha256}:known-negative-control`),
  );
  const bootstrapControlPassed = positiveControl.ci95Lower > 0 && negativeControl.ci95Upper < 0;

  const jsonParseRate = observations.filter(({ arms }) => arms.v71.parsed).length / observations.length;
  const criticalFloors = {
    RESUME: 0.75,
    FINANCIAL: 0.8,
    LEGAL: 0.8,
    MEDICAL: 0.8,
    CHARITY: 0.8,
    BUSINESS_ENTITY: 0.75,
  } as const;
  const explicitSubtypeRows = observations.filter(({ actualCredentialType }) => (
    EXPLICIT_SUBTYPE_TYPE_SET.has(actualCredentialType)
  ));
  const concreteSubtypeEmissionRate = explicitSubtypeRows.filter(({ arms }) => {
    const predictedType = arms.v71.predictedCredentialType;
    return predictedType !== null
      && arms.v71.subType !== null
      && S33_WAVE3_FROZEN_SUBTYPE_TAXONOMY[predictedType]?.includes(arms.v71.subType) === true;
  }).length / explicitSubtypeRows.length;
  const descriptionEmissionRate = observations.filter(({ arms }) => arms.v71.description !== null).length
    / observations.length;
  const candidateLatencies = observations.map(({ arms }) => arms.v71.latencyMs);
  const v6Latencies = observations.map(({ arms }) => arms.v6.latencyMs);
  const candidateTokens = observations.map(({ arms }) => arms.v71.tokensUsed);
  const v6Tokens = observations.map(({ arms }) => arms.v6.tokensUsed);
  const efficiency = {
    meanLatencyDeltaVsV6Ms: mean(candidateLatencies) - mean(v6Latencies),
    p50LatencyMs: latencyPercentile(candidateLatencies, 0.5),
    p95LatencyMs: latencyPercentile(candidateLatencies, 0.95),
    meanTokensDeltaVsV6: mean(candidateTokens) - mean(v6Tokens),
  };
  const calibrationReport = calibration(observations);
  const diagnosticReport = diagnostics(observations);

  const gates: S33Wave3GateResult[] = [
    gate('G01_CORPUS_INTEGRITY', Object.values(integrity).every((count) => count === 0), integrity),
    gate('G02_SURGERY_CONFIG',
      canonicaliseJson(surgery.droppedTrainingIds) === canonicaliseJson([...DROPPED_TRAINING_IDS].sort(compareUtf16CodeUnits))
        && surgery.goodStandingStatusTrainingType === 'string'
        && surgery.concreteSubtypeRate === 1
        && surgery.invalidTaxonomyRowIds.length === 0
        && surgery.fraudStream === 'split'
        && surgery.exportLastCheckpointOnly,
      surgery),
    gate('G03_JSON_PARSE', jsonParseRate === 1, { jsonParseRate }),
    gate('G04_MACRO_F1', macroF1 >= 0.82, { macroF1 }),
    gate('G05_WEIGHTED_F1', weightedF1 >= 0.85, { weightedF1 }),
    gate('G06_ALL_TYPE_FLOOR', Math.min(...Object.values(perTypeF1)) >= 0.75
      && Math.min(...Object.values(perTypeCoverageAdjustedF1)) >= 0.75, {
      minF1AcrossFrozen24TypeMap: Math.min(...Object.values(perTypeF1)),
      minCoverageAdjustedF1AcrossFrozen24TypeMap: Math.min(
        ...Object.values(perTypeCoverageAdjustedF1),
      ),
    }),
    gate('G07_CRITICAL_TYPE_FLOORS', Object.entries(criticalFloors).every(
      ([type, threshold]) => perTypeF1[type] >= threshold
        && perTypeCoverageAdjustedF1[type] >= threshold,
    ), {
      perTypeF1: Object.fromEntries(Object.keys(criticalFloors).map((type) => [type, perTypeF1[type]])),
      perTypeCoverageAdjustedF1: Object.fromEntries(
        Object.keys(criticalFloors).map((type) => [type, perTypeCoverageAdjustedF1[type]]),
      ),
    }),
    gate('G08_TYPE_REGRESSION', minimumPerTypeDeltaVsV6 >= REGRESSION_FLOOR, {
      minPerTypeDeltaVsV6: minimumPerTypeDeltaVsV6,
    }),
    gate('G09_LEGAL_UPLIFT', bootstrapByDomain.legal.meanPairedDelta >= 0.05
      && bootstrapByDomain.legal.ci95Lower > 0
      && bootstrapByDomain.legal.replicates >= BOOTSTRAP_REPLICATES, { ...bootstrapByDomain.legal }),
    gate('G10_FINANCIAL_UPLIFT', bootstrapByDomain.financial.meanPairedDelta >= 0.05
      && bootstrapByDomain.financial.ci95Lower > 0
      && bootstrapByDomain.financial.replicates >= BOOTSTRAP_REPLICATES, { ...bootstrapByDomain.financial }),
    gate('G11_EDUCATION_UPLIFT', bootstrapByDomain.education.meanPairedDelta >= 0.05
      && bootstrapByDomain.education.ci95Lower > 0
      && bootstrapByDomain.education.replicates >= BOOTSTRAP_REPLICATES, { ...bootstrapByDomain.education }),
    gate('G12_SUBTYPE_EMISSION', concreteSubtypeEmissionRate >= 0.9, { concreteSubtypeEmissionRate }),
    gate('G13_DESCRIPTION_EMISSION', descriptionEmissionRate === 1, { descriptionEmissionRate }),
    gate('G14_EFFICIENCY', efficiency.meanLatencyDeltaVsV6Ms <= 0
      && efficiency.p50LatencyMs <= 3500
      && efficiency.p95LatencyMs <= 5500
      && efficiency.meanTokensDeltaVsV6 <= 0, efficiency),
    gate('G15_CALIBRATION_GAP', calibrationReport.meanGap <= 0.05, {
      calibratedMeanGap: calibrationReport.meanGap,
    }),
    gate('G16_CALIBRATION_ECE', calibrationReport.ece <= 0.1, {
      calibratedECE: calibrationReport.ece,
    }),
  ];
  assertSameOrderedStrings(gates.map(({ id }) => id), S33_WAVE3_GATE_IDS, 'Computed Wave-3 gate ids');

  const founderResults: S33Wave3EvaluationReport['founderCoverage']['results'] =
    S33_WAVE3_FOUNDER_MAPPING_CONTRACT.map((contract) => {
      const rows = observations.filter(({ founderTypeId }) => founderTypeId === contract.id);
      const taxonomySupported = contract.mappings.every(({ credentialType, subType }) => (
        FROZEN_TYPE_SET.has(credentialType)
          && S33_WAVE3_FROZEN_SUBTYPE_TAXONOMY[credentialType]?.includes(subType) === true
      ));
      const candidateF1 = rows.length === 0
        ? 0
        : aggregateScores(rows.map((row) => row.arms.v71.fieldComparisons)).standardF1;
      const disposition = !taxonomySupported
        ? 'needs-taxonomy-extension' as const
        : rows.length >= 12 && candidateF1 >= 0.75
          ? 'covered-by-prompt+base' as const
          : 'needs-tuning-data' as const;
      return {
        domain: contract.domain,
        founderTypeId: contract.id,
        sampleSize: rows.length,
        candidateF1,
        disposition,
      };
    });

  const jurisdictionReport = Object.fromEntries((['AU', 'KE'] as const).map((jurisdiction) => {
    const ids = new Set(jurisdictionManifests[jurisdiction]);
    const rows = observations.filter(({ entryId }) => ids.has(entryId));
    const candidateF1 = aggregateScores(rows.map((row) => row.arms.v71.fieldComparisons)).standardF1;
    return [jurisdiction, {
      sampleSize: rows.length,
      candidateF1,
      baselineF1: JURISDICTION_PUBLIC_BASELINE_F1,
      deltaVsBaseline: candidateF1 - JURISDICTION_PUBLIC_BASELINE_F1,
      wording: SMALL_N_WORDING,
      marketingAllowed: false as const,
    }];
  })) as S33Wave3EvaluationReport['jurisdictions'];

  const allRegistryGatesPassed = gates.every(({ passed }) => passed);
  const releaseGuards = {
    allRegistryGatesPassed,
    publicBaselineGuardPassed,
    abstentionContractPassed: diagnosticReport.abstention.contractPassed,
    bootstrapControlPassed,
    releaseAuthorityVerified: !usesTestAuthority
      && authenticatedBatchAcceptances.length === TOP15_BATCH_CONTRACT.length,
    corpusFreezeVerified: corpusFreeze.passed,
  };
  const verdict = Object.values(releaseGuards).every(Boolean) ? 'GO' as const : 'NO-GO' as const;
  const withoutDigest: Omit<S33Wave3EvaluationReport, 'artifactDigestSha256'> = {
    schemaVersion: 'arkova.s33.wave3.deterministic-eval/v1',
    artifactType: 'arkova-s33-wave3-deterministic-eval-report',
    evidenceClass: usesTestAuthority ? 'fixture-only' : 'offline-code-only',
    liveEvidenceDeferred: true,
    verdict,
    bindings: {
      gateRegistryRawSha256: gateBinding.rawSha256,
      gateRegistryCanonicalSha256: gateBinding.canonicalSha256,
      founderMappingCanonicalSha256,
      acceptedCorpusRegistryDigestSha256: corpus.digest,
      frozenTaxonomyCanonicalSha256: canonicalDigest({
        credentialTypes: S33_WAVE3_FROZEN_CREDENTIAL_TYPES,
        subtypeTaxonomy: S33_WAVE3_FROZEN_SUBTYPE_TAXONOMY,
      }),
      armManifestDigests: {
        public: manifests.public.manifestDigestSha256,
        v6: manifests.v6.manifestDigestSha256,
        v71: manifests.v71.manifestDigestSha256,
      },
      deterministicSeedSha256,
      inputPacketDigests,
      acceptanceAuthority: {
        verificationMode: usesTestAuthority ? 'test-injected' : 'configured-cto-policy',
        publicKeyFingerprintSha256: acceptanceTrustRootFingerprintSha256,
        authenticatedBatchCount: authenticatedBatchAcceptances.length,
        releaseAuthority: !usesTestAuthority
          && authenticatedBatchAcceptances.length === TOP15_BATCH_CONTRACT.length,
      },
    },
    gates,
    bootstrap: {
      replicates: BOOTSTRAP_REPLICATES,
      confidenceLevel: 0.95,
      domainsPooled: false,
      byDomain: bootstrapByDomain,
      knownDeltaControls: {
        positive: positiveControl,
        negative: negativeControl,
        passed: bootstrapControlPassed,
      },
    },
    scoring: {
      macroF1,
      weightedF1,
      coverageAdjustedF1,
      perTypeF1,
      perTypeCoverageAdjustedF1,
    },
    regression: {
      perTypeDeltaVsV6,
      perTypeDeltaVsPublic,
      perTypeCoverageAdjustedDeltaVsPublic,
      minimumPerTypeDeltaVsV6,
      minimumPerTypeDeltaVsPublic,
      minimumCoverageAdjustedDeltaVsPublic,
      publicBaselineGuardPassed,
    },
    corpusFreeze,
    calibration: calibrationReport,
    diagnostics: diagnosticReport,
    founderCoverage: {
      mappingCount: 45,
      frozenCredentialTypes: S33_WAVE3_FROZEN_CREDENTIAL_TYPES,
      frozenSubtypeTaxonomy: S33_WAVE3_FROZEN_SUBTYPE_TAXONOMY,
      results: founderResults,
    },
    jurisdictions: jurisdictionReport,
    releaseGuards,
  };
  return deepFreeze({
    ...withoutDigest,
    artifactDigestSha256: canonicalDigest(withoutDigest),
  });
}

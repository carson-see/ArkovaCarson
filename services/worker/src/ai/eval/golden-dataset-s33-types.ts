/**
 * S3.3 Lane-3-owned shared held-out types and v6 taxonomy support.
 *
 * This module deliberately contains no corpus entries. Lane 4 produces corpus
 * batches; Lane 3 owns the support contract, leakage gates, and batch
 * acceptance. Landing this file does not accept a batch or ratify a proposed
 * taxonomy extension.
 */

import { validateFieldsForType } from '../crossFieldFraudChecks.js';
import type { GoldenDatasetEntry, GroundTruthFields } from './types.js';

/** Jurisdiction slice marker for the S3.3 corpus. */
export type S33Jurisdiction = 'US' | 'AU' | 'KE';

/**
 * Standard eval shape plus producer provenance and edge-case metadata. The
 * literal provenance identifies authorship only; it is not an acceptance mark.
 */
export interface S33HeldoutEntry extends GoldenDatasetEntry {
  provenance: 'authored-s33-lane4';
  edgeCase: boolean;
  jurisdictionSlice: S33Jurisdiction;
}

/**
 * Ratified extraction-v6 subtype taxonomy, mirrored verbatim from
 * EXTRACTION_V6_SYSTEM_PROMPT. The adjacent drift test parses the prompt and
 * fails if either side moves independently.
 */
export const V6_SUBTYPE_TAXONOMY: Readonly<Record<string, readonly string[]>> = {
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
};

/**
 * PROPOSED subtype extensions — NOT part of the ratified v6 taxonomy.
 *
 * Existing eval data scores continuing professional education as CPE, while
 * extraction-v6 has no CPE subtype branch. These values remain quarantined and
 * must not be used by a tuning export or represented as approved until the CTO
 * resolves the taxonomy decision.
 */
export const S33_PROPOSED_SUBTYPES: Readonly<Record<string, readonly string[]>> = {
  CPE: ['general_cpe', 'ethics_cpe', 'specialized_cpe'],
};

/** Supported corpus edge-case tags; this vocabulary is not a truth label. */
export const S33_EDGE_CLASSES: readonly string[] = [
  'ocr-noise',
  'fractional',
  'near-duplicate',
  'ambiguous-provider',
  'decoy-id',
  'near-miss',
  'unit-trap',
  'hallucination-trap',
  'multi-course',
  'date-trap',
  'ethics-split',
  'legacy-paper',
  'stamp-noise',
  'hint-trap',
];

const S33_SUBSTANTIVE_DEPTH_FIELDS = [
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
] as const satisfies readonly (keyof GroundTruthFields)[];

export const S33_COVERED_MINIMUM_POST_VALIDATION_DEPTH = 5;

const S33_OOD_ID_PATTERN = /^GD-S33-OOD-\d{3}$/;
const S33_OOD_GROUND_TRUTH_KEYS = ['credentialType', 'fraudSignals', 'subType'] as const;

export interface S33HeldoutGroundTruthContractResult {
  accepted: boolean;
  entryId: string;
  errors: readonly string[];
  kind: 'covered' | 'ood-abstention';
  postValidationDepth: number | null;
  strippedFields: readonly string[];
}

function hasS33SubstantiveGroundTruthValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.some((item) => (
      typeof item === 'string' ? item.trim().length > 0 : item !== null && item !== undefined
    ));
  }
  return true;
}

/**
 * Count extraction facts for the covered-entry five-field quality floor.
 * Taxonomy labels, fraud-signal bookkeeping, evaluator-only controls, and
 * present-but-empty values cannot make a shallow truth row look complete. OOD
 * depth remains a separate CTO-owned protocol decision.
 */
export function countS33SubstantiveGroundTruthFields(
  groundTruth: Readonly<GroundTruthFields>,
): number {
  const { fields } = validateFieldsForType({ ...groundTruth });
  return S33_SUBSTANTIVE_DEPTH_FIELDS
    .filter((key) => hasS33SubstantiveGroundTruthValue(fields[key]))
    .length;
}

function isExactS33OodAbstentionTruth(groundTruth: Readonly<GroundTruthFields>): boolean {
  const keys = Object.keys(groundTruth).sort();
  return keys.length === S33_OOD_GROUND_TRUTH_KEYS.length
    && keys.every((key, index) => key === S33_OOD_GROUND_TRUTH_KEYS[index])
    && groundTruth.credentialType === 'OTHER'
    && groundTruth.subType === 'other'
    && Array.isArray(groundTruth.fraudSignals)
    && groundTruth.fraudSignals.length === 0;
}

/**
 * Apply the CTO-ratified Wave-1 truth contract to one held-out row.
 *
 * Covered rows are measured only after the production per-type validator has
 * removed fields that the extraction path would discard. The nine OOD rows
 * instead carry one exact abstention truth shape and are exempt from depth and
 * concrete-subtype floors.
 */
export function evaluateS33HeldoutGroundTruthContract(entry: Readonly<{
  id: string;
  groundTruth: Readonly<GroundTruthFields>;
}>): S33HeldoutGroundTruthContractResult {
  const kind = S33_OOD_ID_PATTERN.test(entry.id) ? 'ood-abstention' : 'covered';
  if (kind === 'ood-abstention') {
    const accepted = isExactS33OodAbstentionTruth(entry.groundTruth);
    return Object.freeze({
      accepted,
      entryId: entry.id,
      errors: Object.freeze(accepted ? [] : [
        'OOD truth must be exactly credentialType=OTHER, subType=other, fraudSignals=[]',
      ]),
      kind,
      postValidationDepth: null,
      strippedFields: Object.freeze([]),
    });
  }

  const validation = validateFieldsForType({ ...entry.groundTruth });
  const postValidationDepth = S33_SUBSTANTIVE_DEPTH_FIELDS
    .filter((key) => hasS33SubstantiveGroundTruthValue(validation.fields[key]))
    .length;
  const errors: string[] = [];
  if (postValidationDepth < S33_COVERED_MINIMUM_POST_VALIDATION_DEPTH) {
    errors.push(
      `post-production validation depth ${postValidationDepth} is below minimum ${S33_COVERED_MINIMUM_POST_VALIDATION_DEPTH}`,
    );
  }
  if (typeof validation.fields.subType !== 'string'
    || validation.fields.subType.trim().length === 0
    || validation.fields.subType.toLowerCase() === 'other') {
    errors.push('covered entry requires a concrete non-other subType');
  }
  if (validation.fields.credentialType === 'OTHER') {
    errors.push('covered entry cannot use the OOD credentialType OTHER');
  }

  return Object.freeze({
    accepted: errors.length === 0,
    entryId: entry.id,
    errors: Object.freeze(errors),
    kind,
    postValidationDepth,
    strippedFields: Object.freeze([...validation.stripped]),
  });
}

/** Validate every row; a valid prefix cannot hide a shallow final entry. */
export function assertS33HeldoutGroundTruthContract(entries: readonly Readonly<{
  id: string;
  groundTruth: Readonly<GroundTruthFields>;
}>[]): void {
  const failures = entries
    .map(evaluateS33HeldoutGroundTruthContract)
    .filter(({ accepted }) => !accepted);
  if (failures.length === 0) return;
  throw new Error(failures.map(({ entryId, errors }) => `${entryId}: ${errors.join('; ')}`).join('\n'));
}

/** Normalize document text for duplicate/fingerprint comparison. */
export function normalizeForFingerprint(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

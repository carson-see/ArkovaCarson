/**
 * AI Eval Framework Types (AI-EVAL-01)
 *
 * Type definitions for the extraction accuracy evaluation framework.
 * Golden dataset entries, eval results, and scoring metrics.
 */

/**
 * A single field-level ground truth label.
 * Every extractable field for a credential is listed with its expected value.
 */
export interface GroundTruthFields {
  credentialType?: string;
  /** GRE-01: Fine-grained sub-type (e.g., 'official_undergraduate', 'nursing_rn') */
  subType?: string;
  issuerName?: string;
  recipientIdentifier?: string;
  issuedDate?: string;
  expiryDate?: string;
  fieldOfStudy?: string;
  degreeLevel?: string;
  licenseNumber?: string;
  accreditingBody?: string;
  jurisdiction?: string;
  // CLE-specific
  creditHours?: number;
  creditType?: string;
  barNumber?: string;
  activityNumber?: string;
  providerName?: string;
  approvedBy?: string;
  // BUSINESS_ENTITY-specific
  entityType?: string;
  stateOfFormation?: string;
  registeredAgent?: string;
  goodStandingStatus?: string;
  // CHARITY-specific
  einNumber?: string;
  taxExemptStatus?: string;
  governingBody?: string;
  // FINANCIAL_ADVISOR-specific
  crdNumber?: string;
  firmName?: string;
  finraRegistration?: string;
  seriesLicenses?: string;
  // Fraud signals
  fraudSignals?: string[];
  // GME10 contract-specific extraction fields
  contractType?: string;
  contractReasoningType?: string;
  parties?: string[];
  signatories?: string[];
  effectiveDate?: string;
  termLength?: string;
  autoRenewalTerms?: string;
  noticeDeadline?: string;
  paymentTerms?: string;
  deliverables?: string[];
  liabilityCap?: string;
  indemnificationScope?: string;
  terminationRights?: string;
  governingLaw?: string;
  venue?: string;
  arbitrationClause?: string;
  confidentialityTerm?: string;
  riskFlags?: string[];
  recommendationUrls?: string[];
  templateDeviation?: string;
  crossDocumentReference?: string;
  signatoryAuthority?: string;
  regulatoryGap?: string;
  // GRE-02: Reasoning fields (optional — existing entries don't need these)
  /** Expected reasoning pattern (for eval — does Gemini's reasoning match?) */
  reasoning?: string;
  /** Expected concerns (for eval) */
  concerns?: string[];
}

/**
 * A single entry in the golden evaluation dataset.
 */
export interface GoldenDatasetEntry {
  /** Unique identifier for this eval entry */
  id: string;
  /** Human-readable description */
  description: string;
  /** The PII-stripped text that would be sent to extraction */
  strippedText: string;
  /** Credential type hint provided to extraction */
  credentialTypeHint: string;
  /** Optional issuer hint */
  issuerHint?: string;
  /** Ground truth fields — the correct extraction result */
  groundTruth: GroundTruthFields;
  /** Source of this entry (e.g., "test-data/diploma_umich_cs_2025.html") */
  source: string;
  /** Category for grouping (e.g., "degree", "license", "edge-case") */
  category: string;
  /** Tags for filtering (e.g., ["clean", "ambiguous", "partial", "multi-issuer"]) */
  tags: string[];
}

/**
 * Per-field comparison result.
 */
export interface FieldResult {
  field: string;
  expected: string | number | string[] | undefined;
  actual: string | number | string[] | undefined;
  /** true = correct extraction, false = incorrect/missing */
  correct: boolean;
  /** Match type: exact, normalized, missing_both, false_positive, false_negative */
  matchType: 'exact' | 'normalized' | 'missing_both' | 'false_positive' | 'false_negative' | 'mismatch';
}

/**
 * Result of evaluating one golden dataset entry.
 */
export interface EntryEvalResult {
  entryId: string;
  credentialType: string;
  category: string;
  tags: string[];
  /** Per-field results */
  fieldResults: FieldResult[];
  /** AI-reported confidence (raw model output) */
  reportedConfidence: number;
  /** Post-hoc calibrated confidence (after applying calibration layer) */
  calibratedConfidence?: number;
  /** Feature-based meta-model adjusted confidence */
  adjustedConfidence?: number;
  /** Actual accuracy for this entry (fraction of fields correct) */
  actualAccuracy: number;
  /** Extraction latency in ms */
  latencyMs: number;
  /** Provider used */
  provider: string;
  /** Tokens consumed */
  tokensUsed: number;
  /**
   * Raw extracted fields from the provider. Useful for post-eval analysis of
   * fields NOT in ALL_FIELDS (e.g., v6's subType, description emission rates).
   * Kept optional so existing eval JSON readers don't break.
   */
  extractedFields?: Record<string, unknown>;
}

/**
 * Precision, recall, F1 for a single field across all entries.
 */
export interface FieldMetrics {
  field: string;
  /** How many entries had this field in ground truth */
  totalExpected: number;
  /** How many entries had this field extracted */
  totalExtracted: number;
  /** True positives: extracted and correct */
  truePositives: number;
  /** False positives: extracted but wrong or not expected */
  falsePositives: number;
  /** False negatives: expected but not extracted */
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
}

/**
 * Aggregate metrics for a credential type or the full dataset.
 */
export interface AggregateMetrics {
  /** Scope label (e.g., "DEGREE", "LICENSE", "ALL") */
  scope: string;
  totalEntries: number;
  /** Per-field metrics */
  fieldMetrics: FieldMetrics[];
  /** Macro-averaged F1 across all fields */
  macroF1: number;
  /** Weighted F1 (weighted by field frequency) */
  weightedF1: number;
  /** Mean reported confidence */
  meanReportedConfidence: number;
  /** Mean actual accuracy */
  meanActualAccuracy: number;
  /** Confidence-accuracy correlation (Pearson r) — raw model confidence */
  confidenceCorrelation: number;
  /** Confidence-accuracy correlation (Pearson r) — after calibration layer */
  calibratedCorrelation?: number;
  /** Mean calibrated confidence */
  meanCalibratedConfidence?: number;
  /** Mean extraction latency */
  meanLatencyMs: number;
}

/**
 * Full eval run results.
 */
export interface EvalRunResult {
  /** ISO timestamp of eval run */
  timestamp: string;
  /** Provider tested */
  provider: string;
  /** Prompt version hash */
  promptVersionHash: string;
  /** Total entries evaluated */
  totalEntries: number;
  /** Per-entry results */
  entryResults: EntryEvalResult[];
  /** Overall aggregate metrics */
  overall: AggregateMetrics;
  /** Per-credential-type metrics */
  byCredentialType: AggregateMetrics[];
}

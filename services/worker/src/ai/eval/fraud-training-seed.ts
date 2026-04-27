/**
 * Fraud Training Seed Dataset (Gemini Fraud Stream v1)
 *
 * Hand-curated fraud patterns from real-world enforcement actions.
 * Used to build training-output/gemini-fraud-v1-vertex.jsonl for tuning
 * gemini-2.5-pro. See docs/plans/gemini-training-parameters-v1.md.
 *
 * Sources:
 * - FTC enforcement actions (diploma mills): https://www.ftc.gov/enforcement
 * - Oregon ODA unaccredited list (long-running diploma mill registry)
 * - GAO Reports on diploma mills (GAO-04-1024T)
 * - HHS-OIG provider exclusion list
 * - State medical board enforcement actions
 *
 * Each entry: extracted credential metadata (post-Nessie) + expected fraud signals.
 *
 * Data lives in fraud-training-seed.data.json so that SonarCloud's CPD
 * (which scans .ts but not .json) does not flag the structurally-repetitive
 * entries as duplicated code. To regenerate: edit the JSON, then run the
 * test suite to validate shape.
 */

import seedData from './fraud-training-seed.data.json' with { type: 'json' };

export interface FraudTrainingEntry {
  id: string;
  description: string;
  /** Input — what Nessie produced */
  extractedFields: Record<string, unknown>;
  /** Expected output from Gemini fraud stream */
  expectedOutput: {
    fraudSignals: string[];
    confidence: number; // 0-1, fraud-detection confidence
    reasoning: string;
  };
  category: 'diploma_mill' | 'license_forgery' | 'document_tampering' | 'identity_mismatch' | 'sophisticated';
  source: string;
}

export const FRAUD_TRAINING_SEED: FraudTrainingEntry[] = seedData as FraudTrainingEntry[];

/**
 * Target dataset size for SCRUM-792 (GME2-01) DoD: 100+ patterns.
 * Pinned here so a CI test can assert progress and block accidental regression.
 * Update this constant only when the actual dataset grows toward the target.
 */
export const FRAUD_TRAINING_TARGET_COUNT = 100;

/**
 * Generate the system prompt for the fraud detection capability.
 * Locked alongside the dataset; both versioned together.
 */
export const FRAUD_SYSTEM_PROMPT = `You are a credential fraud auditor analyzing extracted credential metadata. Your job is to identify fraud signals using only the structured fields provided plus your knowledge of:
- Diploma mills (FTC enforcement actions, GAO reports, state unaccredited lists like Oregon ODA)
- License number formats per jurisdiction (NPI must be 10 digits, state-specific medical/bar formats)
- Institution legitimacy (founding dates, program offerings, accreditation status)
- Temporal consistency (issue dates vs issuer existence, chronology of multiple credentials)

Return a strict JSON object:
{
  "fraudSignals": [<array of signal codes>],
  "confidence": <float 0-1, your confidence in the fraud assessment>,
  "reasoning": <one paragraph explaining the analysis>
}

Valid fraud signal codes:
KNOWN_DIPLOMA_MILL, UNVERIFIABLE_ISSUER, ENFORCEMENT_ACTION, INVALID_FORMAT,
INCONSISTENT_ISSUER, SUSPICIOUS_DATES, SUSPICIOUS_TIMELINE, MATERIAL_MISSTATEMENT,
EXPIRED_ISSUER, EXPIRED_CREDENTIAL, REVOKED_STATUS, DUPLICATE_REGISTRATION,
RETRACTED_VERIFICATION

If no fraud detected, return fraudSignals: []. Confidence should be high (>0.85) for clean credentials and high (>0.85) for unambiguous fraud; use 0.5-0.7 only for cases requiring external verification.`;

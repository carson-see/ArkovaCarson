/**
 * Held-out Fraud Eval Set (SCRUM-1467 follow-up).
 *
 * 20 entries DISJOINT from FRAUD_TRAINING_SEED, in the same
 * `extractedFields → expectedOutput` schema. Used to compute the true
 * generalization F1 / FP-rate of the tuned Gemini model produced by
 * tuningJobs/6387124463783116800. None of these institutions, license
 * numbers, or specific patterns appear verbatim in the training seed —
 * the model has to apply learned patterns to unseen inputs.
 *
 * Distribution mirrors the training set so per-category metrics are
 * comparable: 4 diploma_mill, 4 license_forgery, 3 document_tampering,
 * 3 identity_mismatch, 3 sophisticated, 3 clean.
 *
 * Data lives in fraud-holdout-set.data.json so SonarCloud's CPD (which
 * scans .ts but not .json) does not flag the structurally-repetitive
 * entries as duplicated code (same pattern as fraud-training-seed.ts).
 */

import type { FraudTrainingEntry } from './fraud-training-seed.js';
import seedData from './fraud-holdout-set.data.json' with { type: 'json' };

export const FRAUD_HOLDOUT_SET: FraudTrainingEntry[] = seedData as FraudTrainingEntry[];

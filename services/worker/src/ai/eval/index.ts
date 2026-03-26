/**
 * AI Eval Framework (AI-EVAL-01)
 *
 * Extraction accuracy evaluation: golden dataset, scoring engine, eval runner.
 */

export type {
  GoldenDatasetEntry,
  GroundTruthFields,
  FieldResult,
  EntryEvalResult,
  FieldMetrics,
  AggregateMetrics,
  EvalRunResult,
} from './types.js';

export {
  GOLDEN_DATASET,
  FULL_GOLDEN_DATASET,
  getEntriesByType,
  getEntriesByTag,
  getEntriesByCategory,
} from './golden-dataset.js';

export { GOLDEN_DATASET_EXTENDED } from './golden-dataset-extended.js';
export { GOLDEN_DATASET_PHASE2 } from './golden-dataset-phase2.js';
export { GOLDEN_DATASET_PHASE5 } from './golden-dataset-phase5.js';

export {
  compareField,
  compareFields,
  computeFieldMetrics,
  computeAggregateMetrics,
  normalizeString,
  normalizeDate,
  pearsonCorrelation,
} from './scoring.js';

export {
  runEval,
  formatEvalReport,
  getPromptVersionHash,
} from './runner.js';
export type { EvalRunOptions } from './runner.js';

export {
  analyzeCalibration,
  analyzeCalibrationByType,
  deriveCalibrationKnots,
  getCurrentCalibrationKnots,
  formatCalibrationReport,
  calibrateConfidence,
} from './calibration.js';
export type { CalibrationResult, CalibrationBucket, TypeCalibrationResult } from './calibration.js';

export {
  FRAUD_EVAL_DATASET,
  getCleanEntries,
  getTamperedEntries,
  getEntriesByTamperingCategory,
  getFraudEntriesByType,
} from './fraud-eval-dataset.js';
export type { FraudEvalEntry } from './fraud-eval-dataset.js';

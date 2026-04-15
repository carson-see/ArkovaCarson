/**
 * Training Data Pipeline (Phase 3 + NPH-12)
 *
 * Fine-tune data preparation for Nessie models.
 */

export {
  formatTrainingExample,
  stratifyByType,
  exportFineTuneData,
  exportForAllTargets,
} from './finetune-exporter.js';

export type {
  FineTuneExportConfig,
  ExportStats,
  RawTrainingRecord,
} from './finetune-exporter.js';

export {
  generateFraudTrainingData,
  augmentFraudExample,
  formatFraudTrainingLine,
  deduplicateExamples,
  DIPLOMA_MILLS,
  SUSPICIOUS_PHRASES,
} from './fraud-training-pipeline.js';

export type {
  FraudTrainingExample,
  FraudTrainingOutput,
  FraudPipelineOptions,
  FraudPipelineResult,
} from './fraud-training-pipeline.js';

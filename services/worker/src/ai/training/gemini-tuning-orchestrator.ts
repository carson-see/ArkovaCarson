/**
 * Gemini Golden Fine-Tuning Orchestrator
 *
 * Exports golden dataset in Gemini tuning format and submits
 * a fine-tuning job via the Google Generative AI API.
 *
 * Gemini tuning uses Google's infrastructure (Vertex AI / AI Studio),
 * NOT RunPod. Billing goes to the GCP project or API key.
 *
 * API: https://generativelanguage.googleapis.com/v1beta/tunedModels
 *
 * Constitution refs:
 *   - 1.6: Only PII-stripped metadata
 *   - 4A: No raw document content
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { FULL_GOLDEN_DATASET } from '../eval/golden-dataset.js';
import type { GoldenDatasetEntry } from '../eval/types.js';

// ============================================================================
// TYPES
// ============================================================================

export interface GeminiTuningConfig {
  /** Google AI API key */
  apiKey: string;
  /** Base model for tuning (default: models/gemini-2.0-flash-001) */
  baseModel?: string;
  /** Output directory for exported data */
  outputDir: string;
  /** Training epochs (default 4) */
  epochCount?: number;
  /** Batch size (default 4) */
  batchSize?: number;
  /** Learning rate multiplier (default 1.0) */
  learningRateMultiplier?: number;
  /** Display name for the tuned model */
  displayName?: string;
  /** If true, export data only — don't submit tuning job */
  dryRun?: boolean;
  /** Maximum examples per credential type */
  maxPerType?: number;
}

export interface GeminiTuningResult {
  exportStats: {
    totalExamples: number;
    byType: Record<string, number>;
    filtered: number;
  };
  jsonlPath: string;
  tuningJobName?: string;
  status: 'exported' | 'submitted' | 'error';
  error?: string;
}

interface GeminiTrainingExample {
  text_input: string;
  output: string;
}

// ============================================================================
// GOLDEN DATASET → GEMINI TUNING FORMAT
// ============================================================================

const MIN_TEXT_LENGTH = 50;
const MAX_TEXT_LENGTH = 15_000;

/**
 * Convert a golden dataset entry to Gemini tuning format.
 * Gemini uses simple text_input/output pairs.
 */
function goldenEntryToGeminiFormat(entry: GoldenDatasetEntry): GeminiTrainingExample | null {
  if (!entry.strippedText || entry.strippedText.length < MIN_TEXT_LENGTH) return null;
  if (entry.strippedText.length > MAX_TEXT_LENGTH) return null;
  if (!entry.groundTruth.credentialType) return null;

  const textInput = `Extract metadata from the following PII-stripped credential text.\nCredential type hint: ${entry.credentialTypeHint || entry.groundTruth.credentialType}\n\n${entry.strippedText}`;

  // Build expected output — KEEP reasoning + concerns so Gemini learns to explain
  const output: Record<string, unknown> = { ...entry.groundTruth };

  if (!output.fraudSignals) {
    output.fraudSignals = [];
  }

  // Gemini tuning expects confidence as a number
  if (!output.confidence) {
    // Estimate based on field completeness
    const fieldCount = Object.keys(output).filter(k => output[k] !== undefined && k !== 'fraudSignals').length;
    output.confidence = Math.min(0.95, 0.50 + fieldCount * 0.06);
  }

  return {
    text_input: textInput,
    output: JSON.stringify(output),
  };
}

// ============================================================================
// DEDUPLICATION
// ============================================================================

function deduplicateGeminiExamples(examples: GeminiTrainingExample[]): GeminiTrainingExample[] {
  const seen = new Set<string>();
  return examples.filter(ex => {
    const hash = createHash('sha256').update(ex.text_input).digest('hex');
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
}

// ============================================================================
// ORCHESTRATOR
// ============================================================================

/**
 * Run a complete Gemini Golden fine-tuning data export and optional job submission.
 *
 * Default mode is dry-run. Set dryRun: false to submit the tuning job.
 */
export async function runGeminiTuning(
  config: GeminiTuningConfig,
): Promise<GeminiTuningResult> {
  const {
    apiKey,
    baseModel = 'models/gemini-2.0-flash-001',
    outputDir,
    epochCount = 4,
    batchSize = 4,
    learningRateMultiplier = 1.0,
    displayName = `arkova-golden-v4-${new Date().toISOString().slice(0, 10)}`,
    dryRun = true,
    maxPerType = 300,
  } = config;

  logger.info('[gemini-tuning] Starting Gemini Golden export...');
  mkdirSync(outputDir, { recursive: true });

  // Step 1: Convert golden dataset to Gemini format
  const examples: GeminiTrainingExample[] = [];
  const byType: Record<string, number> = {};
  const typeCounts = new Map<string, number>();
  let filtered = 0;

  for (const entry of FULL_GOLDEN_DATASET) {
    const type = entry.groundTruth.credentialType || 'OTHER';
    const currentCount = typeCounts.get(type) || 0;

    // Cap per type
    if (currentCount >= maxPerType) {
      filtered++;
      continue;
    }

    const example = goldenEntryToGeminiFormat(entry);
    if (example) {
      examples.push(example);
      typeCounts.set(type, currentCount + 1);
      byType[type] = (byType[type] || 0) + 1;
    } else {
      filtered++;
    }
  }

  // Step 2: Deduplicate
  const deduped = deduplicateGeminiExamples(examples);
  const dupeCount = examples.length - deduped.length;
  if (dupeCount > 0) {
    logger.info(`[gemini-tuning] Removed ${dupeCount} duplicates`);
    filtered += dupeCount;
  }

  logger.info(`[gemini-tuning] ${deduped.length} examples from ${FULL_GOLDEN_DATASET.length} entries (${filtered} filtered)`);

  // Step 3: Write JSONL
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonlPath = join(outputDir, `gemini-golden-v4-${timestamp}.jsonl`);
  const jsonlContent = deduped.map(ex => JSON.stringify(ex)).join('\n');
  writeFileSync(jsonlPath, jsonlContent, 'utf-8');
  logger.info(`[gemini-tuning] Wrote ${deduped.length} examples to ${jsonlPath}`);

  const result: GeminiTuningResult = {
    exportStats: {
      totalExamples: deduped.length,
      byType,
      filtered,
    },
    jsonlPath,
    status: 'exported',
  };

  // Step 4: Submit tuning job (if not dry run)
  if (!dryRun) {
    if (!apiKey) {
      result.status = 'error';
      result.error = 'Missing GEMINI_API_KEY';
      return result;
    }

    try {
      logger.info(`[gemini-tuning] Submitting tuning job to Google AI...`);

      // Build inline training data for the API
      const trainingExamples = deduped.map(ex => ({
        text_input: ex.text_input,
        output: ex.output,
      }));

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/tunedModels?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            display_name: displayName,
            base_model: baseModel,
            tuning_task: {
              hyperparameters: {
                epoch_count: epochCount,
                batch_size: batchSize,
                learning_rate_multiplier: learningRateMultiplier,
              },
              training_data: {
                examples: {
                  examples: trainingExamples,
                },
              },
            },
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Google AI API error ${response.status}: ${errorText}`);
      }

      const data = await response.json() as { name: string; metadata?: unknown };
      result.tuningJobName = data.name;
      result.status = 'submitted';
      logger.info(`[gemini-tuning] Tuning job submitted: ${data.name}`);
    } catch (err) {
      result.status = 'error';
      result.error = err instanceof Error ? err.message : String(err);
      logger.error(`[gemini-tuning] Failed to submit: ${result.error}`);
    }
  }

  return result;
}

/**
 * Check status of a Gemini tuning job.
 */
export async function checkGeminiTuningStatus(
  apiKey: string,
  jobName: string,
): Promise<{ state: string; tunedModel?: string; metadata?: unknown }> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${jobName}?key=${apiKey}`,
  );

  if (!response.ok) {
    throw new Error(`Google AI API error ${response.status}`);
  }

  const data = await response.json() as { state: string; name?: string; metadata?: unknown };
  return {
    state: data.state,
    tunedModel: data.name,
    metadata: data.metadata,
  };
}

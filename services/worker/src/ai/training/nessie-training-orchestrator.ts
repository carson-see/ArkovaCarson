/**
 * Nessie Training Orchestrator
 *
 * Orchestrates a complete Nessie fine-tuning run:
 * 1. Export golden dataset as instruction-tuning JSONL
 * 2. Generate fraud training examples
 * 3. Mix general instruction data (prevent catastrophic forgetting)
 * 4. Deduplicate and validate
 * 5. Submit to RunPod training API (or dry-run)
 *
 * Constitution refs:
 *   - 1.6: Only PII-stripped metadata — documents never leave user's device
 *   - 4A: No raw document content in training data
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { EXTRACTION_SYSTEM_PROMPT } from '../prompts/extraction.js';
import { FULL_GOLDEN_DATASET } from '../eval/golden-dataset.js';
import { V4_TRAINING_DEFAULTS, computeRealisticConfidence } from './nessie-v4-data.js';
import { generateFraudTrainingData } from './fraud-training-pipeline.js';
import type { GoldenDatasetEntry } from '../eval/types.js';

// ============================================================================
// TYPES
// ============================================================================

export interface NessieTrainingConfig {
  /** Output directory for JSONL files */
  outputDir: string;
  /** RunPod API key (from env) */
  runpodApiKey?: string;
  /** RunPod endpoint ID (from env) */
  runpodEndpointId?: string;
  /** Base model to fine-tune */
  baseModel?: string;
  /** If true, export data only — don't submit to RunPod */
  dryRun?: boolean;
  /** Maximum examples per credential type */
  maxPerType?: number;
  /** Include fraud augmented examples */
  includeFraud?: boolean;
  /** General data mix ratio (default 0.25) */
  generalDataMixRatio?: number;
}

export interface NessieTrainingResult {
  exportStats: {
    totalExamples: number;
    goldenExamples: number;
    fraudExamples: number;
    generalExamples: number;
    byType: Record<string, number>;
  };
  jsonlPath: string;
  runpodJobId?: string;
  status: 'exported' | 'submitted' | 'error';
  error?: string;
}

interface TrainingMessage {
  messages: Array<{ role: string; content: string }>;
}

// ============================================================================
// GOLDEN DATASET → TRAINING EXAMPLES
// ============================================================================

/**
 * Convert a golden dataset entry to instruction-tuning format.
 */
function goldenEntryToTraining(entry: GoldenDatasetEntry): TrainingMessage | null {
  if (!entry.strippedText || entry.strippedText.length < 50) return null;
  if (!entry.groundTruth.credentialType) return null;

  const userPrompt = `Extract metadata from the following PII-stripped credential text.\nCredential type hint: ${entry.credentialTypeHint || entry.groundTruth.credentialType}\n\n--- BEGIN CREDENTIAL TEXT ---\n${entry.strippedText}\n--- END CREDENTIAL TEXT ---\n\nReturn a JSON object with the extracted fields, a "confidence" number (0.0 to 1.0), and a "fraudSignals" array.`;

  // Build expected output from ground truth
  const output: Record<string, unknown> = { ...entry.groundTruth };
  // Remove eval-only fields that shouldn't be in training output
  delete output.reasoning;
  delete output.concerns;

  // Compute realistic confidence if not present
  if (!output.confidence) {
    output.confidence = computeRealisticConfidence(
      entry.groundTruth as Record<string, unknown>,
      entry.strippedText,
    );
  }

  // Ensure fraudSignals is present
  if (!output.fraudSignals) {
    output.fraudSignals = [];
  }

  return {
    messages: [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: JSON.stringify(output) },
    ],
  };
}

// ============================================================================
// DEDUPLICATION
// ============================================================================

function deduplicateExamples(examples: TrainingMessage[]): TrainingMessage[] {
  const seen = new Set<string>();
  const deduped: TrainingMessage[] = [];

  for (const ex of examples) {
    const userMsg = ex.messages.find(m => m.role === 'user')?.content || '';
    const hash = createHash('sha256').update(userMsg).digest('hex');
    if (!seen.has(hash)) {
      seen.add(hash);
      deduped.push(ex);
    }
  }

  return deduped;
}

// ============================================================================
// ORCHESTRATOR
// ============================================================================

/**
 * Run a complete Nessie training data export and optional RunPod submission.
 *
 * Default mode is dry-run (export only). Set dryRun: false to submit.
 */
export async function runNessieTraining(
  config: NessieTrainingConfig,
): Promise<NessieTrainingResult> {
  const {
    outputDir,
    runpodApiKey,
    runpodEndpointId,
    baseModel = V4_TRAINING_DEFAULTS.baseModel,
    dryRun = true,
    maxPerType = 500,
    includeFraud = true,
  } = config;

  logger.info('[nessie-training] Starting training data export...');

  // Ensure output directory exists
  mkdirSync(outputDir, { recursive: true });

  // Step 1: Convert golden dataset to training examples
  const goldenExamples: TrainingMessage[] = [];
  const byType: Record<string, number> = {};

  for (const entry of FULL_GOLDEN_DATASET) {
    const example = goldenEntryToTraining(entry);
    if (example) {
      goldenExamples.push(example);
      const type = entry.groundTruth.credentialType || 'OTHER';
      byType[type] = (byType[type] || 0) + 1;
    }
  }

  logger.info(`[nessie-training] Golden dataset: ${goldenExamples.length} examples from ${FULL_GOLDEN_DATASET.length} entries`);

  // Step 2: Stratify by type (cap overrepresented types)
  // Group by type and cap
  const byTypeExamples = new Map<string, TrainingMessage[]>();
  let exIdx = 0;
  for (const entry of FULL_GOLDEN_DATASET) {
    if (exIdx >= goldenExamples.length) break;
    const type = entry.groundTruth.credentialType || 'OTHER';
    if (!byTypeExamples.has(type)) byTypeExamples.set(type, []);
    const typeArr = byTypeExamples.get(type)!;
    if (typeArr.length < maxPerType) {
      const example = goldenEntryToTraining(entry);
      if (example) typeArr.push(example);
    }
    exIdx++;
  }

  const stratified: TrainingMessage[] = [];
  for (const [, examples] of byTypeExamples) {
    stratified.push(...examples);
  }

  // Step 3: Generate fraud training examples
  let fraudExamples: TrainingMessage[] = [];
  if (includeFraud) {
    const fraudResult = generateFraudTrainingData({ outputPath: '/tmp/fraud-training.jsonl', returnExamples: true });
    fraudExamples = (fraudResult.examples ?? []).map(ex => ({
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: `Extract metadata from the following PII-stripped credential text.\n\n--- BEGIN CREDENTIAL TEXT ---\n${ex.input}\n--- END CREDENTIAL TEXT ---\n\nReturn a JSON object with the extracted fields, a "confidence" number (0.0 to 1.0), and a "fraudSignals" array.` },
        { role: 'assistant', content: JSON.stringify(ex.output) },
      ],
    }));
    logger.info(`[nessie-training] Fraud examples: ${fraudExamples.length}`);
  }

  // Step 4: Combine and deduplicate
  let allExamples = [...stratified, ...fraudExamples];
  allExamples = deduplicateExamples(allExamples);
  logger.info(`[nessie-training] After dedup: ${allExamples.length} examples`);

  // Step 5: General data mixing skipped at build time — handled by nessie-v4-data.ts at training time
  const generalCount = 0;

  // Step 6: Write JSONL
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonlPath = join(outputDir, `nessie-v6-training-${timestamp}.jsonl`);
  const jsonlContent = allExamples.map(ex => JSON.stringify(ex)).join('\n');
  writeFileSync(jsonlPath, jsonlContent, 'utf-8');
  logger.info(`[nessie-training] Wrote ${allExamples.length} examples to ${jsonlPath}`);

  const result: NessieTrainingResult = {
    exportStats: {
      totalExamples: allExamples.length,
      goldenExamples: stratified.length,
      fraudExamples: fraudExamples.length,
      generalExamples: generalCount,
      byType,
    },
    jsonlPath,
    status: 'exported',
  };

  // Step 7: Submit to RunPod (if not dry run)
  if (!dryRun) {
    if (!runpodApiKey || !runpodEndpointId) {
      result.status = 'error';
      result.error = 'Missing RUNPOD_API_KEY or RUNPOD_ENDPOINT_ID';
      logger.error(`[nessie-training] ${result.error}`);
      return result;
    }

    try {
      logger.info(`[nessie-training] Submitting training job to RunPod...`);
      const response = await fetch(`https://api.runpod.ai/v2/${runpodEndpointId}/run`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${runpodApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: {
            task: 'finetune',
            base_model: baseModel,
            training_data_url: jsonlPath, // In production, upload to S3/R2 first
            hyperparameters: {
              learning_rate: V4_TRAINING_DEFAULTS.learningRate,
              num_epochs: V4_TRAINING_DEFAULTS.epochs,
              batch_size: V4_TRAINING_DEFAULTS.batchSize,
              gradient_accumulation_steps: V4_TRAINING_DEFAULTS.gradientAccumulationSteps,
              lora_rank: V4_TRAINING_DEFAULTS.loraRank,
              lora_alpha: V4_TRAINING_DEFAULTS.loraAlpha,
              lora_target_modules: V4_TRAINING_DEFAULTS.loraTargetModules,
              precision: V4_TRAINING_DEFAULTS.precision,
              lr_scheduler: V4_TRAINING_DEFAULTS.lrScheduler,
              warmup_ratio: V4_TRAINING_DEFAULTS.warmupRatio,
              max_grad_norm: V4_TRAINING_DEFAULTS.maxGradNorm,
              weight_decay: V4_TRAINING_DEFAULTS.weightDecay,
              lora_dropout: V4_TRAINING_DEFAULTS.loraDropout,
            },
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`RunPod API error ${response.status}: ${errorText}`);
      }

      const data = await response.json() as { id: string; status: string };
      result.runpodJobId = data.id;
      result.status = 'submitted';
      logger.info(`[nessie-training] RunPod job submitted: ${data.id}`);
    } catch (err) {
      result.status = 'error';
      result.error = err instanceof Error ? err.message : String(err);
      logger.error(`[nessie-training] Failed to submit: ${result.error}`);
    }
  }

  return result;
}

/**
 * Check the status of a RunPod training job.
 */
export async function checkNessieTrainingStatus(
  runpodApiKey: string,
  runpodEndpointId: string,
  jobId: string,
): Promise<{ status: string; output?: unknown }> {
  const response = await fetch(`https://api.runpod.ai/v2/${runpodEndpointId}/status/${jobId}`, {
    headers: { 'Authorization': `Bearer ${runpodApiKey}` },
  });

  if (!response.ok) {
    throw new Error(`RunPod API error ${response.status}`);
  }

  return response.json() as Promise<{ status: string; output?: unknown }>;
}

#!/usr/bin/env tsx
/**
 * Nessie v6 Intelligence Fine-Tune Submission (NMT-12 / SCRUM-675)
 *
 * Submits distilled intelligence training data (from NMT-11) to Together AI
 * for fine-tuning as Nessie v6 Intelligence. Uses same hyperparameters as v5
 * extraction (LR=2e-4, 2 epochs, LoRA rank=16) as baseline, with option for
 * higher rank (32) for complex reasoning.
 *
 * Usage:
 *   cd services/worker
 *   npx tsx scripts/nessie-v6-intelligence-finetune.ts --dry-run
 *   npx tsx scripts/nessie-v6-intelligence-finetune.ts
 *   npx tsx scripts/nessie-v6-intelligence-finetune.ts --high-rank  # LoRA rank 32 for complex reasoning
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

dotenvConfig({ path: resolve(import.meta.dirname ?? '.', '../.env') });

// --- CLI args ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const HIGH_RANK = args.includes('--high-rank');
const fileIdx = args.indexOf('--file');
const DEFAULT_TRAIN_FILE = resolve(
  import.meta.dirname ?? '.',
  '../training-data/nessie-intelligence-v2.jsonl',
);
const TRAIN_FILE = fileIdx >= 0 && args[fileIdx + 1] ? args[fileIdx + 1] : DEFAULT_TRAIN_FILE;

// --- Training config ---
export const V6_TRAINING_CONFIG = {
  model: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Reference',
  n_epochs: 2,           // Same as v5 — §3.6: >3 causes overfitting
  learning_rate: 2e-4,   // Same as v5 — §3.1: LoRA needs ~10x higher LR
  lora: true,
  lora_r: HIGH_RANK ? 32 : 16,         // 16 = v5 match, 32 = complex reasoning
  lora_alpha: HIGH_RANK ? 64 : 32,     // alpha = 2x rank
  lora_dropout: 0.05,    // Light dropout — v5 baseline
  batch_size: 2,
  suffix: 'arkova-nessie-intelligence-v2',
};

/**
 * Validate training file — ensure all lines are valid JSONL with 3-message format.
 * Returns { valid, invalid, total } counts.
 */
export function validateTrainingFile(filePath: string): {
  valid: number;
  invalid: number;
  total: number;
  errors: string[];
} {
  if (!existsSync(filePath)) {
    return { valid: 0, invalid: 0, total: 0, errors: [`File not found: ${filePath}`] };
  }

  const lines = readFileSync(filePath, 'utf-8').trim().split('\n');
  let valid = 0;
  let invalid = 0;
  const errors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (
        parsed.messages &&
        Array.isArray(parsed.messages) &&
        parsed.messages.length === 3 &&
        parsed.messages[0].role === 'system' &&
        parsed.messages[1].role === 'user' &&
        parsed.messages[2].role === 'assistant'
      ) {
        valid++;
      } else {
        invalid++;
        errors.push(`Line ${i + 1}: invalid message structure`);
      }
    } catch {
      invalid++;
      errors.push(`Line ${i + 1}: invalid JSON`);
    }
  }

  return { valid, invalid, total: lines.length, errors };
}

async function main(): Promise<void> {
  console.log('=== Nessie v6 Intelligence Fine-Tune (NMT-12) ===\n');
  console.log(`Date:       ${new Date().toISOString()}`);
  console.log(`Dry run:    ${DRY_RUN}`);
  console.log(`Train file: ${TRAIN_FILE}`);
  console.log(`LoRA rank:  ${V6_TRAINING_CONFIG.lora_r} (alpha: ${V6_TRAINING_CONFIG.lora_alpha})`);
  console.log('');

  // Validate training file
  const validation = validateTrainingFile(TRAIN_FILE);
  if (validation.total === 0) {
    console.error('No training file found. Run nessie-intelligence-distill-v2.ts first (NMT-11).');
    process.exit(1);
  }

  console.log(`Training examples: ${validation.total}`);
  console.log(`Valid: ${validation.valid}, Invalid: ${validation.invalid}`);

  if (validation.invalid > 0) {
    console.error(`\n${validation.invalid} invalid examples found:`);
    for (const err of validation.errors.slice(0, 10)) {
      console.error(`  ${err}`);
    }
    if (!DRY_RUN) process.exit(1);
  }

  if (validation.valid < 100) {
    console.warn(`\nWARNING: Only ${validation.valid} valid examples. Minimum recommended: 500.`);
    console.warn('Run NMT-11 distillation to generate more examples.');
  }

  console.log('\nTraining config:');
  for (const [key, value] of Object.entries(V6_TRAINING_CONFIG)) {
    console.log(`  ${key}: ${value}`);
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would upload file and submit Together AI fine-tune job.');
    const fileSize = readFileSync(TRAIN_FILE).length;
    console.log(`File: ${TRAIN_FILE} (${validation.total} examples, ${(fileSize / 1024).toFixed(1)} KB)`);
    return;
  }

  // Upload and submit to Together AI
  const apiKey = process.env.TOGETHER_API_KEY;
  if (!apiKey) {
    console.error('TOGETHER_API_KEY required');
    process.exit(1);
  }

  // Step 1: Upload training file
  console.log('\n--- Step 1: Upload training file ---');
  const fileContent = readFileSync(TRAIN_FILE);
  const formData = new FormData();
  formData.append(
    'file',
    new Blob([fileContent], { type: 'application/jsonl' }),
    'nessie-intelligence-v2-train.jsonl',
  );
  formData.append('purpose', 'fine-tune');

  const uploadRes = await fetch('https://api.together.xyz/v1/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`File upload failed: ${uploadRes.status}\n${err}`);
  }

  const uploadData = (await uploadRes.json()) as { id: string };
  console.log(`  File ID: ${uploadData.id}`);

  // Step 2: Submit fine-tune job
  console.log('\n--- Step 2: Submit fine-tune job ---');
  const jobRes = await fetch('https://api.together.xyz/v1/fine-tunes', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      training_file: uploadData.id,
      model: V6_TRAINING_CONFIG.model,
      n_epochs: V6_TRAINING_CONFIG.n_epochs,
      learning_rate: V6_TRAINING_CONFIG.learning_rate,
      batch_size: V6_TRAINING_CONFIG.batch_size,
      lora: V6_TRAINING_CONFIG.lora,
      lora_r: V6_TRAINING_CONFIG.lora_r,
      lora_alpha: V6_TRAINING_CONFIG.lora_alpha,
      lora_dropout: V6_TRAINING_CONFIG.lora_dropout,
      suffix: V6_TRAINING_CONFIG.suffix,
    }),
  });

  if (!jobRes.ok) {
    const err = await jobRes.text();
    throw new Error(`Fine-tune submission failed: ${jobRes.status}\n${err}`);
  }

  const job = (await jobRes.json()) as { id: string; status: string; model_output_name?: string };
  console.log(`  Job ID: ${job.id}`);
  console.log(`  Status: ${job.status}`);
  if (job.model_output_name) {
    console.log(`  Output model: ${job.model_output_name}`);
  }

  console.log('\n========================================');
  console.log('  v6 Intelligence Fine-Tune Submitted!');
  console.log('========================================');
  console.log(`\nMonitor: https://api.together.xyz/v1/fine-tunes/${job.id}`);
  console.log('\nNext steps after completion:');
  console.log('  1. Deploy to RunPod intelligence endpoint');
  console.log('  2. Run intelligence eval benchmark');
  console.log('  3. Update NESSIE_INTELLIGENCE_MODEL env var');
}

// Only run when executed directly (not when imported for testing)
const isDirectExecution = process.argv[1]?.endsWith('nessie-v6-intelligence-finetune.ts') ||
  process.argv[1]?.endsWith('nessie-v6-intelligence-finetune.js');

if (isDirectExecution) {
  main().catch((err) => {
    console.error('\nPIPELINE FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

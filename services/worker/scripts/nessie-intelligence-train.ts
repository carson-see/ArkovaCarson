#!/usr/bin/env tsx
/**
 * Nessie Intelligence Fine-Tune Submission (NMT-07, Phase D)
 *
 * Submits distilled intelligence training data to Together AI for fine-tuning.
 * Uses LoRA rank 32 (higher than extraction v5's rank 16) because compliance
 * reasoning is more complex than field extraction.
 *
 * CRITICAL: Nessie is a compliance intelligence engine, NOT an extraction model.
 * This script trains Nessie for its actual job.
 *
 * Usage:
 *   cd services/worker
 *   npx tsx scripts/nessie-intelligence-train.ts --dry-run
 *   npx tsx scripts/nessie-intelligence-train.ts --file training-data/intelligence/intelligence-train-*.jsonl
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

dotenvConfig({ path: resolve(import.meta.dirname ?? '.', '../.env') });

// --- CLI args ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const fileIdx = args.indexOf('--file');
const TRAIN_FILE = fileIdx >= 0 ? args[fileIdx + 1] : findLatestTrainFile();

// --- Training config (per Best Practices doc) ---
const TRAINING_CONFIG = {
  model: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Reference',
  n_epochs: 2,                     // §3.6: >3 epochs causes overfitting
  learning_rate: 2e-4,             // §3.1: LoRA needs ~10x higher LR
  lora: true,
  lora_r: 32,                      // §3.2: rank 32 for complex domain tasks
  lora_alpha: 64,                  // §3.2: alpha = 2x rank
  lora_dropout: 0.1,               // §3.7: moderate dropout for regularization
  batch_size: 2,                   // §3.4: small batch with grad accumulation
  n_gradient_accumulation: 8,      // effective batch = 16
  suffix: 'arkova-nessie-intelligence-v1',
};

function findLatestTrainFile(): string {
  const dir = resolve(import.meta.dirname ?? '.', '../training-data/intelligence');
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('intelligence-train-') && f.endsWith('.jsonl'))
      .sort()
      .reverse();
    if (files.length > 0) return resolve(dir, files[0]);
  } catch {
    // dir doesn't exist yet
  }
  return '';
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  console.log('=== Nessie Intelligence Fine-Tune Submission ===');
  console.log(`Date:       ${new Date().toISOString()}`);
  console.log(`Dry run:    ${DRY_RUN}`);
  console.log(`Train file: ${TRAIN_FILE || '(none found)'}`);
  console.log();

  if (!TRAIN_FILE) {
    console.error('No training file found. Run nessie-intelligence-distill.ts first.');
    process.exit(1);
  }

  // Validate training file
  const lines = readFileSync(TRAIN_FILE, 'utf-8').trim().split('\n');
  console.log(`Training examples: ${lines.length}`);

  // Validate each line is valid JSON with messages
  let validCount = 0;
  let invalidCount = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.messages && Array.isArray(parsed.messages) && parsed.messages.length === 3) {
        validCount++;
      } else {
        invalidCount++;
      }
    } catch {
      invalidCount++;
    }
  }

  console.log(`Valid: ${validCount}, Invalid: ${invalidCount}`);
  if (invalidCount > 0) {
    console.error(`${invalidCount} invalid examples found. Fix before submitting.`);
    if (!DRY_RUN) process.exit(1);
  }

  console.log('\nTraining config:');
  for (const [key, value] of Object.entries(TRAINING_CONFIG)) {
    console.log(`  ${key}: ${value}`);
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would upload file and submit Together AI fine-tune job.');
    console.log(`File: ${TRAIN_FILE} (${lines.length} examples, ${(readFileSync(TRAIN_FILE).length / 1024).toFixed(1)} KB)`);
    return;
  }

  // Upload file to Together AI
  const apiKey = process.env.TOGETHER_API_KEY;
  if (!apiKey) {
    console.error('TOGETHER_API_KEY required');
    process.exit(1);
  }

  console.log('\n--- Step 1: Upload training file ---');
  const fileContent = readFileSync(TRAIN_FILE);
  const formData = new FormData();
  formData.append('file', new Blob([fileContent]), 'intelligence-train.jsonl');
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

  const uploadData = (await uploadRes.json()) as { id: string; filename: string };
  console.log(`  File ID: ${uploadData.id}`);

  // Submit fine-tune job
  console.log('\n--- Step 2: Submit fine-tune job ---');
  const jobRes = await fetch('https://api.together.xyz/v1/fine-tunes', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      training_file: uploadData.id,
      model: TRAINING_CONFIG.model,
      n_epochs: TRAINING_CONFIG.n_epochs,
      learning_rate: TRAINING_CONFIG.learning_rate,
      batch_size: TRAINING_CONFIG.batch_size,
      n_gradient_accumulation: TRAINING_CONFIG.n_gradient_accumulation,
      lora: TRAINING_CONFIG.lora,
      lora_r: TRAINING_CONFIG.lora_r,
      lora_alpha: TRAINING_CONFIG.lora_alpha,
      lora_dropout: TRAINING_CONFIG.lora_dropout,
      suffix: TRAINING_CONFIG.suffix,
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

  // Poll for completion
  console.log('\n--- Step 3: Polling for completion ---');
  const MAX_POLLS = 360; // 6 hours at 60s intervals
  for (let i = 0; i < MAX_POLLS; i++) {
    await delay(60_000);

    const pollRes = await fetch(`https://api.together.xyz/v1/fine-tunes/${job.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!pollRes.ok) {
      console.log(`  Poll error: ${pollRes.status}`);
      continue;
    }

    const pollData = (await pollRes.json()) as {
      status: string;
      model_output_name?: string;
      events?: Array<{ message: string; created_at: string }>;
    };

    if (i % 5 === 0 || pollData.status !== 'running') {
      console.log(`  [${i}min] Status: ${pollData.status}`);
    }

    if (pollData.status === 'completed') {
      console.log('\n========================================');
      console.log('  Intelligence Fine-Tune Complete!');
      console.log('========================================');
      console.log(`  Job: ${job.id}`);
      console.log(`  Model: ${pollData.model_output_name}`);
      console.log(`  Training examples: ${validCount}`);
      console.log('\nNext steps:');
      console.log('  1. Deploy to RunPod for evaluation');
      console.log('  2. Run intelligence eval benchmark');
      console.log('  3. Update NESSIE_MODEL env var if performance exceeds targets');
      return;
    }

    if (pollData.status === 'failed' || pollData.status === 'cancelled') {
      throw new Error(`Job ${pollData.status}: ${pollData.events?.slice(-1)[0]?.message ?? 'unknown'}`);
    }
  }

  throw new Error('Timed out after 6 hours');
}

main().catch((err) => {
  console.error('\nPIPELINE FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});

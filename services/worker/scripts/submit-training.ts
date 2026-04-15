#!/usr/bin/env npx tsx
/**
 * Submit Training — Actually submits fine-tuning jobs.
 *
 * Nessie: Together.ai fine-tuning API (LoRA on Llama 3.1 8B)
 * Gemini: Google AI tuning API (supervised tuning on Gemini Flash)
 *
 * Usage:
 *   npx tsx scripts/submit-training.ts                    # Submit both
 *   npx tsx scripts/submit-training.ts --nessie-only      # Nessie only
 *   npx tsx scripts/submit-training.ts --gemini-only      # Gemini only
 *   npx tsx scripts/submit-training.ts --check <job-id>   # Check job status
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import 'dotenv/config';

// ============================================================================
// CONFIG
// ============================================================================

const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const args = process.argv.slice(2);
const NESSIE_ONLY = args.includes('--nessie-only');
const GEMINI_ONLY = args.includes('--gemini-only');
const CHECK_MODE = args.includes('--check');
const CHECK_JOB_ID = CHECK_MODE ? args[args.indexOf('--check') + 1] : '';

const OUTPUT_DIR = join(process.cwd(), 'training-output');

// ============================================================================
// TOGETHER.AI FINE-TUNING (Nessie)
// ============================================================================

async function submitNessieToTogether() {
  if (!TOGETHER_API_KEY) {
    console.error('[NESSIE] TOGETHER_API_KEY not set in .env');
    process.exit(1);
  }

  // Use the combined clean JSONL (3,807 examples)
  const jsonlPath = join(OUTPUT_DIR, 'nessie-v6-combined-clean.jsonl');
  if (!existsSync(jsonlPath)) {
    console.error(`[NESSIE] Training data not found: ${jsonlPath}`);
    console.error('[NESSIE] Run: npx tsx scripts/run-training.ts --dry-run first');
    process.exit(1);
  }

  const data = readFileSync(jsonlPath, 'utf-8');
  const lineCount = data.split('\n').filter(l => l.trim()).length;
  console.log(`[NESSIE] Training data: ${jsonlPath} (${lineCount} examples)`);

  // Step 1: Upload training file to Together.ai
  console.log('[NESSIE] Uploading training file to Together.ai...');

  const formData = new FormData();
  const blob = new Blob([data], { type: 'application/jsonl' });
  formData.append('file', blob, 'nessie-v6-training.jsonl');
  formData.append('purpose', 'fine-tune');

  const uploadResponse = await fetch('https://api.together.xyz/v1/files', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOGETHER_API_KEY}`,
    },
    body: formData,
  });

  if (!uploadResponse.ok) {
    const errText = await uploadResponse.text();
    console.error(`[NESSIE] Upload failed (${uploadResponse.status}): ${errText}`);
    process.exit(1);
  }

  const uploadResult = await uploadResponse.json() as { id: string; filename: string; bytes: number };
  console.log(`[NESSIE] File uploaded: ${uploadResult.id} (${uploadResult.bytes} bytes)`);

  // Step 2: Submit fine-tuning job
  console.log('[NESSIE] Submitting fine-tuning job...');

  const ftResponse = await fetch('https://api.together.xyz/v1/fine-tunes', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOGETHER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      training_file: uploadResult.id,
      model: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Reference',
      // LoRA hyperparameters — per nessie-v4-data.ts best practices
      n_epochs: 2,
      learning_rate: 2e-4,
      batch_size: 2,
      // Together.ai LoRA params
      lora: true,
      lora_r: 16,
      lora_alpha: 32,
      lora_dropout: 0.1,
      suffix: 'arkova-nessie-v6',
    }),
  });

  if (!ftResponse.ok) {
    const errText = await ftResponse.text();
    console.error(`[NESSIE] Fine-tune submission failed (${ftResponse.status}): ${errText}`);
    process.exit(1);
  }

  const ftResult = await ftResponse.json() as { id: string; status: string; model: string };
  console.log(`[NESSIE] Fine-tuning job submitted!`);
  console.log(`[NESSIE]   Job ID: ${ftResult.id}`);
  console.log(`[NESSIE]   Status: ${ftResult.status}`);
  console.log(`[NESSIE]   Model: ${ftResult.model}`);
  console.log(`[NESSIE]   Check: npx tsx scripts/submit-training.ts --check ${ftResult.id}`);

  // Save job info
  const jobInfo = {
    provider: 'together',
    jobId: ftResult.id,
    fileId: uploadResult.id,
    model: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Reference',
    trainingExamples: lineCount,
    submittedAt: new Date().toISOString(),
    hyperparameters: {
      n_epochs: 2,
      learning_rate: 2e-4,
      batch_size: 2,
      lora_r: 16,
      lora_alpha: 32,
      lora_dropout: 0.1,
    },
  };
  const jobInfoPath = join(OUTPUT_DIR, `nessie-v6-job-${ftResult.id}.json`);
  writeFileSync(jobInfoPath, JSON.stringify(jobInfo, null, 2));
  console.log(`[NESSIE]   Job info saved: ${jobInfoPath}`);

  return ftResult;
}

// ============================================================================
// GOOGLE AI FINE-TUNING (Gemini)
// ============================================================================

async function submitGeminiTuning() {
  if (!GEMINI_API_KEY) {
    console.error('[GEMINI] GEMINI_API_KEY not set in .env');
    process.exit(1);
  }

  // Use the Vertex-format JSONL
  const jsonlPath = join(OUTPUT_DIR, 'gemini-golden-v4-combined-vertex.jsonl');
  if (!existsSync(jsonlPath)) {
    console.error(`[GEMINI] Training data not found: ${jsonlPath}`);
    process.exit(1);
  }

  const data = readFileSync(jsonlPath, 'utf-8');
  const lines = data.split('\n').filter(l => l.trim());
  console.log(`[GEMINI] Training data: ${jsonlPath} (${lines.length} examples)`);

  // Parse examples for inline submission
  const examples = lines.map(line => {
    const parsed = JSON.parse(line) as { text_input: string; output: string };
    return { text_input: parsed.text_input, output: parsed.output };
  });

  const displayName = `arkova-golden-v4-${new Date().toISOString().slice(0, 10)}`;
  console.log(`[GEMINI] Submitting tuning job: ${displayName}...`);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/tunedModels?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name: displayName,
        base_model: 'models/gemini-2.0-flash-001',
        tuning_task: {
          hyperparameters: {
            epoch_count: 4,
            batch_size: 4,
            learning_rate_multiplier: 1.0,
          },
          training_data: {
            examples: { examples },
          },
        },
      }),
    },
  );

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[GEMINI] Tuning failed (${response.status}): ${errText}`);
    // Don't exit — Nessie may have succeeded
    return null;
  }

  const result = await response.json() as { name: string; metadata?: unknown };
  console.log(`[GEMINI] Tuning job submitted!`);
  console.log(`[GEMINI]   Job name: ${result.name}`);
  console.log(`[GEMINI]   Check: curl "https://generativelanguage.googleapis.com/v1beta/${result.name}?key=$GEMINI_API_KEY"`);

  const jobInfo = {
    provider: 'google',
    jobName: result.name,
    baseModel: 'models/gemini-2.0-flash-001',
    displayName,
    trainingExamples: examples.length,
    submittedAt: new Date().toISOString(),
  };
  const jobInfoPath = join(OUTPUT_DIR, `gemini-v4-job-${Date.now()}.json`);
  writeFileSync(jobInfoPath, JSON.stringify(jobInfo, null, 2));
  console.log(`[GEMINI]   Job info saved: ${jobInfoPath}`);

  return result;
}

// ============================================================================
// CHECK JOB STATUS
// ============================================================================

async function checkTogetherJob(jobId: string) {
  if (!TOGETHER_API_KEY) {
    console.error('TOGETHER_API_KEY not set');
    process.exit(1);
  }

  const response = await fetch(`https://api.together.xyz/v1/fine-tunes/${jobId}`, {
    headers: { 'Authorization': `Bearer ${TOGETHER_API_KEY}` },
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`Error (${response.status}): ${errText}`);
    process.exit(1);
  }

  const result = await response.json() as Record<string, unknown>;
  console.log(JSON.stringify(result, null, 2));
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('=== Arkova Training Submission ===');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log('');

  if (CHECK_MODE) {
    console.log(`Checking job: ${CHECK_JOB_ID}`);
    await checkTogetherJob(CHECK_JOB_ID);
    return;
  }

  if (!GEMINI_ONLY) {
    console.log('--- NESSIE (Together.ai) ---');
    try {
      await submitNessieToTogether();
    } catch (err) {
      console.error(`[NESSIE] Error: ${err}`);
    }
    console.log('');
  }

  if (!NESSIE_ONLY) {
    console.log('--- GEMINI (Google AI) ---');
    try {
      await submitGeminiTuning();
    } catch (err) {
      console.error(`[GEMINI] Error: ${err}`);
    }
    console.log('');
  }

  console.log('=== Done ===');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

#!/usr/bin/env npx tsx
/**
 * Run Training — Actually kicks off Nessie + Gemini fine-tuning.
 *
 * Usage:
 *   npx tsx scripts/run-training.ts --dry-run    # Export data only
 *   npx tsx scripts/run-training.ts --submit      # Export + submit jobs
 *   npx tsx scripts/run-training.ts --nessie-only  # Nessie only
 *   npx tsx scripts/run-training.ts --gemini-only  # Gemini only
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import 'dotenv/config';

// ============================================================================
// CONFIG
// ============================================================================

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY || '';
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--submit');
const NESSIE_ONLY = args.includes('--nessie-only');
const GEMINI_ONLY = args.includes('--gemini-only');

const OUTPUT_DIR = join(process.cwd(), 'training-output');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

console.log('=== Arkova Training Runner ===');
console.log(`Mode: ${DRY_RUN ? 'DRY RUN (export only)' : '🔥 LIVE SUBMIT'}`);
console.log(`Output: ${OUTPUT_DIR}`);
console.log('');

mkdirSync(OUTPUT_DIR, { recursive: true });

// ============================================================================
// IMPORT GOLDEN DATASET DYNAMICALLY
// ============================================================================

// We import from compiled JS — ensure the project is built
// For now, inline the dataset loading from source files

async function loadGoldenDataset() {
  // Dynamic import from the eval module
  const mod = await import('../src/ai/eval/golden-dataset.js');
  return mod.FULL_GOLDEN_DATASET;
}

async function loadExtractionPrompt() {
  const mod = await import('../src/ai/prompts/extraction.js');
  return mod.EXTRACTION_SYSTEM_PROMPT;
}

// ============================================================================
// NESSIE TRAINING
// ============================================================================

async function runNessieExport() {
  console.log('[NESSIE] Loading golden dataset...');
  const dataset = await loadGoldenDataset();
  const systemPrompt = await loadExtractionPrompt();
  console.log(`[NESSIE] Loaded ${dataset.length} golden entries`);

  const examples: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const byType: Record<string, number> = {};

  for (const entry of dataset) {
    if (!entry.strippedText || entry.strippedText.length < 50) continue;
    if (!entry.groundTruth.credentialType) continue;

    const output: Record<string, unknown> = { ...entry.groundTruth };
    delete output.reasoning;
    delete output.concerns;
    if (!output.fraudSignals) output.fraudSignals = [];

    // Compute confidence based on field completeness
    const fieldCount = Object.keys(output).filter(
      k => output[k] !== undefined && k !== 'fraudSignals' && k !== 'concerns' && k !== 'reasoning',
    ).length;
    output.confidence = Math.min(0.95, 0.45 + fieldCount * 0.07);

    examples.push({
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Extract metadata from the following PII-stripped credential text.\nCredential type hint: ${entry.credentialTypeHint || entry.groundTruth.credentialType}\n\n--- BEGIN CREDENTIAL TEXT ---\n${entry.strippedText}\n--- END CREDENTIAL TEXT ---\n\nReturn a JSON object with the extracted fields, a "confidence" number (0.0 to 1.0), and a "fraudSignals" array.`,
        },
        { role: 'assistant', content: JSON.stringify(output) },
      ],
    });

    const type = entry.groundTruth.credentialType;
    byType[type] = (byType[type] || 0) + 1;
  }

  // Deduplicate
  const seen = new Set<string>();
  const deduped = examples.filter(ex => {
    const hash = createHash('sha256')
      .update(ex.messages[1]?.content || '')
      .digest('hex');
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });

  const jsonlPath = join(OUTPUT_DIR, `nessie-v6-${TIMESTAMP}.jsonl`);
  writeFileSync(jsonlPath, deduped.map(ex => JSON.stringify(ex)).join('\n'), 'utf-8');

  console.log(`[NESSIE] Exported ${deduped.length} training examples`);
  console.log(`[NESSIE] By type:`, JSON.stringify(byType, null, 2));
  console.log(`[NESSIE] JSONL: ${jsonlPath}`);

  return { jsonlPath, count: deduped.length, byType };
}

async function submitNessieTraining(jsonlPath: string, count: number) {
  if (!RUNPOD_API_KEY || !RUNPOD_ENDPOINT_ID) {
    console.error('[NESSIE] Missing RUNPOD_API_KEY or RUNPOD_ENDPOINT_ID');
    return;
  }

  console.log(`[NESSIE] Submitting ${count} examples to RunPod endpoint ${RUNPOD_ENDPOINT_ID}...`);

  // RunPod serverless training job
  const response = await fetch(`https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/run`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RUNPOD_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: {
        task: 'finetune',
        base_model: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Reference',
        training_data_path: jsonlPath,
        output_model_name: `arkova-nessie-v6-${TIMESTAMP}`,
        hyperparameters: {
          learning_rate: 2e-4,
          num_epochs: 2,
          batch_size: 2,
          gradient_accumulation_steps: 8,
          lora_rank: 16,
          lora_alpha: 32,
          lora_target_modules: ['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj'],
          precision: 'bf16',
          lr_scheduler: 'cosine',
          warmup_ratio: 0.05,
          max_grad_norm: 0.3,
          weight_decay: 0.05,
          lora_dropout: 0.1,
        },
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`[NESSIE] RunPod error ${response.status}: ${text}`);
    return;
  }

  const data = (await response.json()) as { id: string; status: string };
  console.log(`[NESSIE] ✅ RunPod job submitted: ${data.id}`);
  console.log(`[NESSIE] Status: ${data.status}`);
  console.log(`[NESSIE] Check: curl -H "Authorization: Bearer $RUNPOD_API_KEY" https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}/status/${data.id}`);
}

// ============================================================================
// GEMINI TRAINING
// ============================================================================

async function runGeminiExport() {
  console.log('[GEMINI] Loading golden dataset...');
  const dataset = await loadGoldenDataset();
  console.log(`[GEMINI] Loaded ${dataset.length} golden entries`);

  const examples: Array<{ text_input: string; output: string }> = [];
  const byType: Record<string, number> = {};

  for (const entry of dataset) {
    if (!entry.strippedText || entry.strippedText.length < 50) continue;
    if (entry.strippedText.length > 15000) continue;
    if (!entry.groundTruth.credentialType) continue;

    const output: Record<string, unknown> = { ...entry.groundTruth };
    delete output.reasoning;
    delete output.concerns;
    if (!output.fraudSignals) output.fraudSignals = [];

    const fieldCount = Object.keys(output).filter(
      k => output[k] !== undefined && k !== 'fraudSignals',
    ).length;
    output.confidence = Math.min(0.95, 0.50 + fieldCount * 0.06);

    examples.push({
      text_input: `Extract metadata from the following PII-stripped credential text.\nCredential type hint: ${entry.credentialTypeHint || entry.groundTruth.credentialType}\n\n${entry.strippedText}`,
      output: JSON.stringify(output),
    });

    const type = entry.groundTruth.credentialType;
    byType[type] = (byType[type] || 0) + 1;
  }

  // Deduplicate
  const seen = new Set<string>();
  const deduped = examples.filter(ex => {
    const hash = createHash('sha256').update(ex.text_input).digest('hex');
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });

  const jsonlPath = join(OUTPUT_DIR, `gemini-golden-v4-${TIMESTAMP}.jsonl`);
  writeFileSync(jsonlPath, deduped.map(ex => JSON.stringify(ex)).join('\n'), 'utf-8');

  console.log(`[GEMINI] Exported ${deduped.length} training examples`);
  console.log(`[GEMINI] By type:`, JSON.stringify(byType, null, 2));
  console.log(`[GEMINI] JSONL: ${jsonlPath}`);

  return { jsonlPath, count: deduped.length, byType, examples: deduped };
}

async function submitGeminiTuning(
  examples: Array<{ text_input: string; output: string }>,
  count: number,
) {
  if (!GEMINI_API_KEY) {
    console.error('[GEMINI] Missing GEMINI_API_KEY');
    return;
  }

  console.log(`[GEMINI] Submitting ${count} examples to Google AI tuning API...`);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/tunedModels?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name: `arkova-golden-v4-${TIMESTAMP}`,
        base_model: 'models/gemini-2.0-flash-001',
        tuning_task: {
          hyperparameters: {
            epoch_count: 4,
            batch_size: 4,
            learning_rate_multiplier: 1.0,
          },
          training_data: {
            examples: {
              examples: examples,
            },
          },
        },
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    console.error(`[GEMINI] Google AI error ${response.status}: ${text}`);
    return;
  }

  const data = (await response.json()) as { name: string; metadata?: unknown };
  console.log(`[GEMINI] ✅ Tuning job submitted: ${data.name}`);
  console.log(`[GEMINI] Check: curl "https://generativelanguage.googleapis.com/v1beta/${data.name}?key=$GEMINI_API_KEY"`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  try {
    if (!GEMINI_ONLY) {
      const nessie = await runNessieExport();
      if (!DRY_RUN) {
        await submitNessieTraining(nessie.jsonlPath, nessie.count);
      } else {
        console.log('[NESSIE] Dry run — skipping RunPod submission. Use --submit to train.');
      }
      console.log('');
    }

    if (!NESSIE_ONLY) {
      const gemini = await runGeminiExport();
      if (!DRY_RUN) {
        await submitGeminiTuning(gemini.examples, gemini.count);
      } else {
        console.log('[GEMINI] Dry run — skipping Google AI submission. Use --submit to train.');
      }
      console.log('');
    }

    console.log('=== Done ===');
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
}

main();

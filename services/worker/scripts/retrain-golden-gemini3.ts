#!/usr/bin/env tsx
/**
 * GME-10: Retrain Gemini Golden v2 on Gemini 3 Base
 *
 * Submits a Vertex AI fine-tuning job on gemini-3-flash-preview base
 * with the full golden dataset. Evaluates the result against baseline.
 *
 * Prerequisites:
 *   - gcloud auth (application default credentials)
 *   - GCS bucket: gs://arkova-training-data
 *   - Golden dataset exported as Vertex AI JSONL
 *
 * Usage:
 *   cd services/worker
 *   GOOGLE_APPLICATION_CREDENTIALS=... npx tsx scripts/retrain-golden-gemini3.ts [--dry-run] [--epochs N]
 */

import 'dotenv/config';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { GEMINI_GENERATION_MODEL } from '../src/ai/gemini-config.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const EPOCHS = parseInt(args.includes('--epochs') ? args[args.indexOf('--epochs') + 1] : '8', 10);

const GCP_PROJECT = 'arkova1';
const GCP_REGION = 'us-central1';
const GCS_BUCKET = 'gs://arkova-training-data';
const VERTEX_API_BASE = `https://${GCP_REGION}-aiplatform.googleapis.com/v1beta1`;
const BASE_MODEL = GEMINI_GENERATION_MODEL;

async function main() {
  console.log(`\n=== GME-10: Retrain Gemini Golden v2 on Gemini 3 ===`);
  console.log(`  Base model: ${BASE_MODEL}`);
  console.log(`  Epochs:     ${EPOCHS}`);
  console.log(`  Dry run:    ${DRY_RUN}`);
  console.log('');

  // Step 1: Check training data exists
  const trainingDir = resolve(import.meta.dirname ?? '.', '../training-data');
  const trainFile = resolve(trainingDir, 'gemini-train.jsonl');
  const valFile = resolve(trainingDir, 'gemini-validation.jsonl');

  if (!existsSync(trainFile)) {
    console.error(`Training data not found: ${trainFile}`);
    console.error('Run gemini-golden-finetune.ts first to export training data.');
    process.exit(1);
  }

  const trainLines = readFileSync(trainFile, 'utf-8').trim().split('\n').length;
  const valLines = existsSync(valFile) ? readFileSync(valFile, 'utf-8').trim().split('\n').length : 0;
  console.log(`  Training examples: ${trainLines}`);
  console.log(`  Validation examples: ${valLines}`);
  console.log('');

  // Step 2: Upload to GCS
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
  const gcsTrainPath = `${GCS_BUCKET}/gemini3-golden-${timestamp}/train.jsonl`;
  const gcsValPath = `${GCS_BUCKET}/gemini3-golden-${timestamp}/validation.jsonl`;

  if (!DRY_RUN) {
    console.log('Uploading training data to GCS...');
    try {
      execSync(`gsutil cp ${trainFile} ${gcsTrainPath}`, { stdio: 'inherit' });
      if (existsSync(valFile)) {
        execSync(`gsutil cp ${valFile} ${gcsValPath}`, { stdio: 'inherit' });
      }
    } catch (err) {
      console.error('GCS upload failed. Check gcloud auth.');
      process.exit(1);
    }
  } else {
    console.log('[DRY RUN] Would upload to GCS:');
    console.log(`  ${trainFile} → ${gcsTrainPath}`);
    console.log(`  ${valFile} → ${gcsValPath}`);
  }

  // Step 3: Submit Vertex AI fine-tuning job
  const requestBody = {
    baseModel: BASE_MODEL,
    supervisedTuningSpec: {
      trainingDatasetUri: gcsTrainPath,
      ...(valLines > 0 ? { validationDatasetUri: gcsValPath } : {}),
      hyperParameters: {
        epochCount: EPOCHS,
        learningRateMultiplier: 1.0,
        adapterSize: 'ADAPTER_SIZE_FOUR',
      },
    },
    tunedModelDisplayName: `arkova-golden-gemini3-${timestamp}`,
  };

  console.log('\nFine-tune job config:');
  console.log(JSON.stringify(requestBody, null, 2));

  if (!DRY_RUN) {
    console.log('\nSubmitting to Vertex AI...');
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const token = await auth.getAccessToken();

    const response = await fetch(
      `${VERTEX_API_BASE}/projects/${GCP_PROJECT}/locations/${GCP_REGION}/tuningJobs`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      console.error(`Vertex AI error: ${response.status} ${text}`);
      process.exit(1);
    }

    const job = await response.json();
    console.log('\nFine-tune job submitted:');
    console.log(`  Job name: ${job.name}`);
    console.log(`  State:    ${job.state}`);
    console.log(`  Display:  ${requestBody.tunedModelDisplayName}`);
    console.log('\nMonitor with:');
    console.log(`  gcloud ai tuning-jobs describe ${job.name} --region=${GCP_REGION}`);

    // Save job reference
    const outputDir = resolve(import.meta.dirname ?? '.', '../../docs/eval/');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      resolve(outputDir, `golden-gemini3-job-${timestamp}.json`),
      JSON.stringify({ ...job, config: requestBody }, null, 2),
    );
  } else {
    console.log('\n[DRY RUN] Would submit fine-tune job. Run without --dry-run to proceed.');
  }
}

main().catch((err) => {
  console.error('\nFINE-TUNE FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});

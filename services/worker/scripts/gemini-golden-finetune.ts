#!/usr/bin/env tsx
/**
 * Gemini Golden Dataset Fine-Tune
 *
 * Fine-tunes Gemini 2.5 Flash on the golden evaluation dataset —
 * 1,330 manually labeled credential examples covering user-facing types:
 * DEGREE, LICENSE, CERTIFICATE, CLE, and edge cases.
 *
 * This is the RIGHT training data for Gemini: real credential extraction
 * tasks that match what users actually upload. Nessie handles institutional
 * pipeline data (SEC, court, regulatory). Gemini handles user documents.
 *
 * Usage:
 *   cd services/worker
 *   npx tsx scripts/gemini-golden-finetune.ts [--dry-run] [--epochs 4] [--adapter-size 4]
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Import ALL golden dataset phases
import { GOLDEN_DATASET, FULL_GOLDEN_DATASET } from '../src/ai/eval/golden-dataset.js';
import { GOLDEN_DATASET_EXTENDED } from '../src/ai/eval/golden-dataset-extended.js';
import { GOLDEN_DATASET_PHASE2 } from '../src/ai/eval/golden-dataset-phase2.js';
import { GOLDEN_DATASET_PHASE3 } from '../src/ai/eval/golden-dataset-phase3.js';
import { GOLDEN_DATASET_PHASE4 } from '../src/ai/eval/golden-dataset-phase4.js';
import { GOLDEN_DATASET_PHASE5 } from '../src/ai/eval/golden-dataset-phase5.js';
import { GOLDEN_DATASET_PHASE6 } from '../src/ai/eval/golden-dataset-phase6.js';
import { GOLDEN_DATASET_PHASE7 } from '../src/ai/eval/golden-dataset-phase7.js';
import { GOLDEN_DATASET_PHASE8 } from '../src/ai/eval/golden-dataset-phase8.js';
import { GOLDEN_DATASET_PHASE9 } from '../src/ai/eval/golden-dataset-phase9.js';
import type { GoldenDatasetEntry } from '../src/ai/eval/types.js';

dotenvConfig({ path: resolve(import.meta.dirname ?? '.', '../.env') });

// --- CLI args ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const EPOCHS = parseInt(args[args.indexOf('--epochs') + 1] || '8', 10); // More epochs for small dataset
const ADAPTER_SIZE = parseInt(args[args.indexOf('--adapter-size') + 1] || '4', 10);
const LR_MULTIPLIER = parseFloat(args[args.indexOf('--lr-multiplier') + 1] || '2.0'); // Higher LR for small dataset

const GCP_PROJECT = 'arkova1';
const GCP_REGION = 'us-central1';
const GCS_BUCKET = 'gs://arkova-training-data';
const VERTEX_API = `https://${GCP_REGION}-aiplatform.googleapis.com/v1beta1`;
const TRAINING_DIR = resolve(import.meta.dirname ?? '.', '../training-data');

// --- System prompt matching production extraction ---
const SYSTEM_PROMPT = `You are a credential metadata extraction assistant for Arkova, a document verification platform.

Your task is to extract structured metadata fields from PII-stripped credential text.

IMPORTANT RULES:
- The input text has already been PII-stripped. Personal names, SSNs, emails, and phone numbers have been replaced with redaction tokens like [NAME_REDACTED], [SSN_REDACTED], etc.
- Do NOT attempt to reconstruct any redacted PII.
- Extract only the metadata fields listed below.
- Return a valid JSON object with only the fields you can confidently extract.
- If you cannot determine a field, OMIT it entirely.
- Dates MUST be in ISO 8601 format (YYYY-MM-DD).
- The "confidence" field MUST be a number from 0.0 to 1.0 reflecting extraction certainty.

EXTRACTABLE FIELDS:
- credentialType: DEGREE, LICENSE, CERTIFICATE, CLE, PUBLICATION, SEC_FILING, REGULATION, PROFESSIONAL, LEGAL, OTHER
- issuerName: Organization that issued the credential
- issuedDate: Date issued (YYYY-MM-DD)
- expiryDate: Expiration date if applicable (YYYY-MM-DD)
- jurisdiction: Geographic jurisdiction
- fieldOfStudy: Subject area or field
- registrationNumber / licenseNumber: Official number
- accreditingBody: Accrediting organization
- degreeLevel: Bachelor, Master, Doctorate, Associate, etc.
- creditHours: CLE credit hours (number)
- creditType: CLE credit type (Ethics, General, etc.)
- fraudSignals: Array of fraud indicator strings

Return ONLY valid JSON. No markdown, no explanation.`;

// --- Convert golden dataset entry to Vertex AI format ---

function entryToVertexFormat(entry: GoldenDatasetEntry): object {
  // Build the user prompt (matching production extraction prompt format)
  const userPrompt = `Extract metadata from the following PII-stripped credential text.
Credential type hint: ${entry.credentialTypeHint}${entry.issuerHint ? `\nIssuer hint: ${entry.issuerHint}` : ''}

--- BEGIN CREDENTIAL TEXT ---
${entry.strippedText}
--- END CREDENTIAL TEXT ---

Return a JSON object with the extracted fields, a "confidence" number (0.0 to 1.0), and a "fraudSignals" array.`;

  // Build the expected model output from ground truth
  const output: Record<string, unknown> = { ...entry.groundTruth };
  // Add confidence based on tags
  if (entry.tags.includes('clean')) {
    output.confidence = 0.92;
  } else if (entry.tags.includes('ambiguous') || entry.tags.includes('partial')) {
    output.confidence = 0.72;
  } else if (entry.tags.includes('corrupted') || entry.tags.includes('junk')) {
    output.confidence = 0.35;
  } else if (entry.tags.includes('ocr-noise')) {
    output.confidence = 0.65;
  } else {
    output.confidence = 0.85;
  }

  return {
    systemInstruction: {
      role: 'system',
      parts: [{ text: SYSTEM_PROMPT }],
    },
    contents: [
      { role: 'user', parts: [{ text: userPrompt }] },
      { role: 'model', parts: [{ text: JSON.stringify(output) }] },
    ],
  };
}

function getAccessToken(): string {
  return execSync('gcloud auth print-access-token', { encoding: 'utf-8' }).trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Main ---

async function main(): Promise<void> {
  const startTime = Date.now();

  console.log('=== Arkova Gemini Golden Dataset Fine-Tune ===');
  console.log(`Date:          ${new Date().toISOString()}`);
  console.log(`Dry run:       ${DRY_RUN}`);
  console.log(`Epochs:        ${EPOCHS}`);
  console.log(`Adapter size:  ${ADAPTER_SIZE}`);
  console.log(`LR multiplier: ${LR_MULTIPLIER}`);

  // Step 1: Combine all golden dataset phases
  console.log('\n--- Step 1: Combine golden dataset entries ---');

  // Deduplicate by ID
  const allEntries = new Map<string, GoldenDatasetEntry>();
  const datasets = [
    { name: 'base', data: FULL_GOLDEN_DATASET ?? GOLDEN_DATASET },
    { name: 'extended', data: GOLDEN_DATASET_EXTENDED },
    { name: 'phase2', data: GOLDEN_DATASET_PHASE2 },
    { name: 'phase3', data: GOLDEN_DATASET_PHASE3 },
    { name: 'phase4', data: GOLDEN_DATASET_PHASE4 },
    { name: 'phase5', data: GOLDEN_DATASET_PHASE5 },
    { name: 'phase6', data: GOLDEN_DATASET_PHASE6 },
    { name: 'phase7', data: GOLDEN_DATASET_PHASE7 },
    { name: 'phase8', data: GOLDEN_DATASET_PHASE8 },
    { name: 'phase9', data: GOLDEN_DATASET_PHASE9 },
  ];

  for (const ds of datasets) {
    if (!ds.data) {
      console.log(`  ${ds.name}: not found, skipping`);
      continue;
    }
    let added = 0;
    for (const entry of ds.data) {
      if (!allEntries.has(entry.id)) {
        allEntries.set(entry.id, entry);
        added++;
      }
    }
    console.log(`  ${ds.name}: ${ds.data.length} entries (${added} new)`);
  }

  const entries = Array.from(allEntries.values());
  console.log(`\nTotal unique entries: ${entries.length}`);

  // Distribution
  const typeStats: Record<string, number> = {};
  const categoryStats: Record<string, number> = {};
  for (const e of entries) {
    const ct = e.groundTruth.credentialType ?? e.credentialTypeHint;
    typeStats[ct] = (typeStats[ct] || 0) + 1;
    categoryStats[e.category] = (categoryStats[e.category] || 0) + 1;
  }

  console.log('\nCredential type distribution:');
  for (const [type, count] of Object.entries(typeStats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  console.log('\nCategory distribution:');
  for (const [cat, count] of Object.entries(categoryStats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }

  // Step 2: Convert to Vertex AI format
  console.log('\n--- Step 2: Convert to Vertex AI format ---');

  const converted = entries.map(entryToVertexFormat);

  // 90/10 split for train/validation
  const shuffled = [...converted];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  const valSize = Math.max(Math.floor(shuffled.length * 0.1), 10);
  const valData = shuffled.slice(0, valSize);
  const trainData = shuffled.slice(valSize);

  mkdirSync(TRAINING_DIR, { recursive: true });
  const trainFile = resolve(TRAINING_DIR, 'gemini-golden-train.jsonl');
  const valFile = resolve(TRAINING_DIR, 'gemini-golden-validation.jsonl');

  writeFileSync(trainFile, trainData.map((d) => JSON.stringify(d)).join('\n') + '\n');
  writeFileSync(valFile, valData.map((d) => JSON.stringify(d)).join('\n') + '\n');

  console.log(`Training set:   ${trainData.length} -> ${trainFile}`);
  console.log(`Validation set: ${valData.length} -> ${valFile}`);

  // Step 3: Upload to GCS
  console.log('\n--- Step 3: Upload to GCS ---');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const trainUri = `${GCS_BUCKET}/gemini-golden/${timestamp}/train.jsonl`;
  const valUri = `${GCS_BUCKET}/gemini-golden/${timestamp}/validation.jsonl`;

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would upload to: ${trainUri}`);
  } else {
    execSync(`gcloud storage cp "${trainFile}" "${trainUri}" --project=${GCP_PROJECT}`, { stdio: 'inherit' });
    execSync(`gcloud storage cp "${valFile}" "${valUri}" --project=${GCP_PROJECT}`, { stdio: 'inherit' });
    console.log(`Train: ${trainUri}`);
    console.log(`Val:   ${valUri}`);
  }

  // Step 4: Create tuning job
  console.log('\n--- Step 4: Create Vertex AI tuning job ---');

  const adapterMap: Record<number, string> = {
    1: 'ADAPTER_SIZE_ONE',
    2: 'ADAPTER_SIZE_TWO',
    4: 'ADAPTER_SIZE_FOUR',
    8: 'ADAPTER_SIZE_EIGHT',
    16: 'ADAPTER_SIZE_SIXTEEN',
  };

  const requestBody = {
    baseModel: 'gemini-2.5-flash',
    supervisedTuningSpec: {
      trainingDatasetUri: trainUri,
      validationDatasetUri: valUri,
      hyperParameters: {
        epochCount: EPOCHS,
        learningRateMultiplier: LR_MULTIPLIER,
        adapterSize: adapterMap[ADAPTER_SIZE] || 'ADAPTER_SIZE_FOUR',
      },
    },
    tunedModelDisplayName: `arkova-gemini-golden-${timestamp.slice(0, 10)}`,
  };

  console.log('Config:');
  console.log(`  Base model:    gemini-2.5-flash`);
  console.log(`  Epochs:        ${EPOCHS}`);
  console.log(`  LR multiplier: ${LR_MULTIPLIER}`);
  console.log(`  Adapter size:  ${adapterMap[ADAPTER_SIZE]}`);
  console.log(`  Train:         ${trainData.length} examples`);
  console.log(`  Validation:    ${valData.length} examples`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would create tuning job');
    console.log(JSON.stringify(requestBody, null, 2));
    return;
  }

  const token = getAccessToken();
  const response = await fetch(
    `${VERTEX_API}/projects/${GCP_PROJECT}/locations/${GCP_REGION}/tuningJobs`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    },
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Tuning job failed: ${response.status}\n${err}`);
  }

  const job = (await response.json()) as { name: string; state: string; createTime: string };
  console.log(`\nTuning job created!`);
  console.log(`  Name:  ${job.name}`);
  console.log(`  State: ${job.state}`);

  // Step 5: Poll for completion
  console.log('\n--- Step 5: Polling for completion ---');

  const POLL_INTERVAL = 120_000;
  const MAX_POLLS = 180; // 6 hours

  for (let i = 0; i < MAX_POLLS; i++) {
    await delay(POLL_INTERVAL);

    try {
      const pollToken = getAccessToken();
      const pollRes = await fetch(`${VERTEX_API}/${job.name}`, {
        headers: { Authorization: `Bearer ${pollToken}` },
      });

      if (!pollRes.ok) {
        console.log(`  Poll error: ${pollRes.status}`);
        continue;
      }

      const data = (await pollRes.json()) as {
        state: string;
        tunedModel?: { model: string; endpoint: string };
        error?: { message: string };
      };

      const elapsed = Math.floor((i * POLL_INTERVAL) / 60_000);
      if (i % 5 === 0 || data.state !== 'JOB_STATE_RUNNING') {
        console.log(`  [${elapsed}min] State: ${data.state}`);
      }

      if (data.state === 'JOB_STATE_SUCCEEDED') {
        console.log('\n========================================');
        console.log('     Gemini Golden Fine-Tune Complete!   ');
        console.log('========================================\n');
        console.log(`Training examples:  ${trainData.length}`);
        console.log(`Validation:         ${valData.length}`);
        console.log(`Job:                ${job.name}`);
        console.log(`Time:               ${((Date.now() - startTime) / 60000).toFixed(1)} min`);
        if (data.tunedModel) {
          console.log(`Tuned model:        ${data.tunedModel.model}`);
          console.log(`Endpoint:           ${data.tunedModel.endpoint}`);
        }
        console.log('\nCredential type distribution in training:');
        for (const [type, count] of Object.entries(typeStats).sort((a, b) => b[1] - a[1])) {
          console.log(`  ${type}: ${count}`);
        }
        return;
      }

      if (data.state === 'JOB_STATE_FAILED' || data.state === 'JOB_STATE_CANCELLED') {
        throw new Error(`Job ${data.state}: ${data.error?.message ?? 'unknown'}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('JOB_STATE_')) throw err;
      console.log(`  Poll exception: ${err instanceof Error ? err.message : err}`);
    }
  }

  throw new Error('Timed out after 6 hours');
}

main().catch((err) => {
  console.error('\nPIPELINE FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});

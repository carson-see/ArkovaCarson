#!/usr/bin/env tsx
/**
 * Gemini Fine-Tuning Pipeline (Vertex AI)
 *
 * Converts existing Nessie training data to Vertex AI format,
 * uploads to GCS, and launches a supervised fine-tuning job.
 *
 * Usage:
 *   cd services/worker
 *   npx tsx scripts/gemini-train-pipeline.ts [options]
 *
 * Options:
 *   --skip-convert     Reuse existing converted data in GCS
 *   --dry-run          Validate data but don't launch job
 *   --epochs N         Number of training epochs (default: 4)
 *   --adapter-size N   LoRA adapter size: 1,2,4,8,16 (default: 4)
 *   --lr-multiplier N  Learning rate multiplier (default: 1.0)
 *   --base-model NAME  Base model (default: gemini-2.0-flash-001)
 *   --max-examples N   Cap training examples (default: unlimited)
 *   --validation-split N  Validation fraction 0.0-0.3 (default: 0.1)
 *
 * Requires:
 *   - gcloud auth (application default credentials)
 *   - GCS bucket: gs://arkova-training-data
 *   - Vertex AI API enabled on arkova1
 *   - Existing training data in training-data/finetune-server-8b.jsonl
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream, createWriteStream, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';

dotenvConfig({ path: resolve(import.meta.dirname ?? '.', '../.env') });

// --- CLI arg parsing ---

const args = process.argv.slice(2);

function getFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

function getArg(name: string, defaultVal: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const SKIP_CONVERT = getFlag('skip-convert');
const DRY_RUN = getFlag('dry-run');
const EPOCHS = parseInt(getArg('epochs', '4'), 10);
const ADAPTER_SIZE = parseInt(getArg('adapter-size', '4'), 10);
const LR_MULTIPLIER = parseFloat(getArg('lr-multiplier', '1.0'));
const BASE_MODEL = getArg('base-model', 'gemini-2.5-flash');
const MAX_EXAMPLES = parseInt(getArg('max-examples', '0'), 10); // 0 = unlimited
const VALIDATION_SPLIT = parseFloat(getArg('validation-split', '0.1'));

const GCP_PROJECT = 'arkova1';
const GCP_REGION = 'us-central1';
const GCS_BUCKET = 'gs://arkova-training-data';
const VERTEX_API_BASE = `https://${GCP_REGION}-aiplatform.googleapis.com/v1beta1`;

const TRAINING_DIR = resolve(import.meta.dirname ?? '.', '../training-data');
const SOURCE_FILE = resolve(TRAINING_DIR, 'finetune-server-8b.jsonl');
const GEMINI_TRAIN_FILE = resolve(TRAINING_DIR, 'gemini-train.jsonl');
const GEMINI_VAL_FILE = resolve(TRAINING_DIR, 'gemini-validation.jsonl');

// Valid adapter sizes for Gemini fine-tuning
const VALID_ADAPTER_SIZES = [1, 2, 4, 8, 16];

// --- System prompt (matches production extraction prompt) ---

const SYSTEM_PROMPT = `You are a credential metadata extraction assistant for Arkova, a document verification platform.

Your task is to extract structured metadata fields from PII-stripped credential text.

IMPORTANT RULES:
- The input text has already been PII-stripped.
- Do NOT attempt to reconstruct any redacted PII.
- Extract only the metadata fields listed below.
- Return a valid JSON object with only the fields you can confidently extract.
- If you cannot determine a field, OMIT it entirely.
- Dates MUST be in ISO 8601 format (YYYY-MM-DD).
- The "confidence" field MUST be a number from 0.0 to 1.0 reflecting extraction certainty.

EXTRACTABLE FIELDS:
- credentialType: One of DEGREE, LICENSE, CERTIFICATE, PUBLICATION, SEC_FILING, REGULATION, PROFESSIONAL, LEGAL, OTHER
- issuerName: Organization that issued the credential
- issuedDate: Date issued (YYYY-MM-DD)
- expiryDate: Expiration date if applicable (YYYY-MM-DD)
- jurisdiction: Geographic jurisdiction (e.g., "California, USA", "United Kingdom")
- fieldOfStudy: Subject area or field
- registrationNumber: Official registration/license number
- accreditingBody: Accrediting organization if different from issuer
- fraudSignals: Array of fraud indicator strings (empty if none detected)

Return ONLY valid JSON. No markdown, no explanation.`;

// --- Helpers ---

function getAccessToken(): string {
  return execSync('gcloud auth print-access-token', { encoding: 'utf-8' }).trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface NessieMessage {
  role: string;
  content: string;
}

interface NessieExample {
  messages: NessieMessage[];
}

interface VertexContent {
  role: string;
  parts: Array<{ text: string }>;
}

interface VertexExample {
  systemInstruction: { role: string; parts: Array<{ text: string }> };
  contents: VertexContent[];
}

/**
 * Convert a Nessie (OpenAI chat format) training example to Vertex AI format.
 */
function convertToVertexFormat(nessieExample: NessieExample): VertexExample | null {
  const messages = nessieExample.messages;
  if (!messages || messages.length < 2) return null;

  const contents: VertexContent[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue; // We use systemInstruction instead
    if (msg.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: msg.content }] });
    } else if (msg.role === 'assistant') {
      contents.push({ role: 'model', parts: [{ text: msg.content }] });
    }
  }

  if (contents.length < 2) return null;

  return {
    systemInstruction: {
      role: 'system',
      parts: [{ text: SYSTEM_PROMPT }],
    },
    contents,
  };
}

// --- Pipeline steps ---

async function stepConvert(): Promise<{ trainCount: number; valCount: number; stats: Record<string, number> }> {
  console.log('\n--- Step 1: Convert training data to Vertex AI format ---');

  if (!existsSync(SOURCE_FILE)) {
    throw new Error(
      `Source training file not found: ${SOURCE_FILE}\n` +
      'Run nessie-train-pipeline.ts first to generate training data.',
    );
  }

  mkdirSync(TRAINING_DIR, { recursive: true });

  // Stream-process to avoid memory issues with large files
  const tmpFile = resolve(TRAINING_DIR, 'gemini-all.jsonl');
  writeFileSync(tmpFile, '', 'utf-8');

  const stats: Record<string, number> = {};
  let totalConverted = 0;
  let skipped = 0;

  const rl = createInterface({
    input: createReadStream(SOURCE_FILE, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  // Use reservoir sampling if MAX_EXAMPLES is set to get a random subset
  // without needing all lines in memory
  const reservoir: string[] = [];
  const useReservoir = MAX_EXAMPLES > 0;
  let lineNum = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    lineNum++;

    try {
      const example = JSON.parse(line) as NessieExample;
      const vertexExample = convertToVertexFormat(example);
      if (!vertexExample) {
        skipped++;
        continue;
      }

      // Extract credential type for stats
      const modelContent = vertexExample.contents.find((c) => c.role === 'model');
      if (modelContent) {
        try {
          const parsed = JSON.parse(modelContent.parts[0].text);
          const ct = parsed.credentialType || 'OTHER';
          stats[ct] = (stats[ct] || 0) + 1;
        } catch {
          // Skip stats for malformed JSON
        }
      }

      const jsonLine = JSON.stringify(vertexExample);
      totalConverted++;

      if (useReservoir) {
        // Reservoir sampling for random subset
        if (reservoir.length < MAX_EXAMPLES) {
          reservoir.push(jsonLine);
        } else {
          const r = Math.floor(Math.random() * totalConverted);
          if (r < MAX_EXAMPLES) {
            reservoir[r] = jsonLine;
          }
        }
      } else {
        appendFileSync(tmpFile, jsonLine + '\n');
      }

      if (totalConverted % 50000 === 0) {
        console.log(`  Processed ${totalConverted} examples...`);
      }
    } catch {
      skipped++;
    }
  }

  console.log(`Converted: ${totalConverted}, Skipped: ${skipped}`);

  // If using reservoir sampling, write the reservoir to file
  if (useReservoir) {
    const effectiveCount = Math.min(MAX_EXAMPLES, totalConverted);
    console.log(`Sampled ${effectiveCount} of ${totalConverted} examples`);
    writeFileSync(tmpFile, reservoir.slice(0, effectiveCount).join('\n') + '\n', 'utf-8');
  }

  // Split into train/validation using line counting (stream-friendly)
  const allLines = readFileSync(tmpFile, 'utf-8').trim().split('\n').filter((l) => l.length > 0);
  const valSize = Math.min(
    Math.max(Math.floor(allLines.length * VALIDATION_SPLIT), 10),
    5000,
  );

  // Fisher-Yates shuffle for split
  for (let i = allLines.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allLines[i], allLines[j]] = [allLines[j], allLines[i]];
  }

  const valExamples = allLines.slice(0, valSize);
  const trainExamples = allLines.slice(valSize);

  writeFileSync(GEMINI_TRAIN_FILE, trainExamples.join('\n') + '\n', 'utf-8');
  writeFileSync(GEMINI_VAL_FILE, valExamples.join('\n') + '\n', 'utf-8');

  // Clean up temp file
  try { execSync(`rm "${tmpFile}"`); } catch { /* ignore */ }

  console.log(`Training set: ${trainExamples.length} -> ${GEMINI_TRAIN_FILE}`);
  console.log(`Validation set: ${valExamples.length} -> ${GEMINI_VAL_FILE}`);

  return { trainCount: trainExamples.length, valCount: valExamples.length, stats };
}

function stepUpload(): { trainUri: string; valUri: string } {
  console.log('\n--- Step 2: Upload to GCS ---');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const trainUri = `${GCS_BUCKET}/gemini-finetune/${timestamp}/train.jsonl`;
  const valUri = `${GCS_BUCKET}/gemini-finetune/${timestamp}/validation.jsonl`;

  if (DRY_RUN) {
    console.log('[DRY RUN] Would upload to:');
    console.log(`  Train: ${trainUri}`);
    console.log(`  Validation: ${valUri}`);
    return { trainUri, valUri };
  }

  console.log('Uploading training data...');
  execSync(`gcloud storage cp "${GEMINI_TRAIN_FILE}" "${trainUri}" --project=${GCP_PROJECT}`, {
    stdio: 'inherit',
  });

  console.log('Uploading validation data...');
  execSync(`gcloud storage cp "${GEMINI_VAL_FILE}" "${valUri}" --project=${GCP_PROJECT}`, {
    stdio: 'inherit',
  });

  console.log(`Train URI: ${trainUri}`);
  console.log(`Validation URI: ${valUri}`);

  return { trainUri, valUri };
}

async function stepCreateTuningJob(
  trainUri: string,
  valUri: string,
): Promise<{ jobName: string; displayName: string }> {
  console.log('\n--- Step 3: Create Vertex AI tuning job ---');

  if (!VALID_ADAPTER_SIZES.includes(ADAPTER_SIZE)) {
    throw new Error(`Invalid adapter size ${ADAPTER_SIZE}. Must be one of: ${VALID_ADAPTER_SIZES.join(', ')}`);
  }

  const adapterSizeEnum = `ADAPTER_SIZE_${ADAPTER_SIZE === 16 ? 'SIXTEEN' : ['ONE', 'TWO', 'FOUR', 'EIGHT'][Math.log2(ADAPTER_SIZE)]}`;

  const timestamp = new Date().toISOString().slice(0, 10);
  const displayName = `arkova-gemini-extraction-${timestamp}`;

  const requestBody = {
    baseModel: BASE_MODEL,
    supervisedTuningSpec: {
      trainingDatasetUri: trainUri,
      validationDatasetUri: valUri,
      hyperParameters: {
        epochCount: EPOCHS,
        learningRateMultiplier: LR_MULTIPLIER,
        adapterSize: adapterSizeEnum,
      },
    },
    tunedModelDisplayName: displayName,
  };

  console.log('Tuning job config:');
  console.log(`  Base model:    ${BASE_MODEL}`);
  console.log(`  Display name:  ${displayName}`);
  console.log(`  Epochs:        ${EPOCHS}`);
  console.log(`  LR multiplier: ${LR_MULTIPLIER}`);
  console.log(`  Adapter size:  ${adapterSizeEnum}`);
  console.log(`  Train URI:     ${trainUri}`);
  console.log(`  Validation URI:${valUri}`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would create tuning job with:');
    console.log(JSON.stringify(requestBody, null, 2));
    return { jobName: 'dry-run-job', displayName };
  }

  const token = getAccessToken();
  const url = `${VERTEX_API_BASE}/projects/${GCP_PROJECT}/locations/${GCP_REGION}/tuningJobs`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Tuning job creation failed: ${response.status}\n${errorBody}`);
  }

  const data = (await response.json()) as {
    name: string;
    state: string;
    tunedModelDisplayName: string;
    createTime: string;
  };

  console.log(`\nTuning job created!`);
  console.log(`  Name:    ${data.name}`);
  console.log(`  State:   ${data.state}`);
  console.log(`  Created: ${data.createTime}`);

  return { jobName: data.name, displayName };
}

async function stepPoll(jobName: string): Promise<{
  state: string;
  tunedModelEndpoint?: string;
  tunedModelName?: string;
}> {
  console.log('\n--- Step 4: Polling for tuning job completion ---');

  if (DRY_RUN) {
    console.log('[DRY RUN] Skipping poll');
    return { state: 'dry-run' };
  }

  const POLL_INTERVAL_MS = 120_000; // 2 minutes
  const MAX_POLLS = 360; // 12 hours max

  for (let i = 0; i < MAX_POLLS; i++) {
    try {
      const token = getAccessToken();
      const response = await fetch(`${VERTEX_API_BASE}/${jobName}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        console.log(`  Poll error: ${response.status} — retrying in 2min`);
        await delay(POLL_INTERVAL_MS);
        continue;
      }

      const data = (await response.json()) as {
        name: string;
        state: string;
        tunedModel?: {
          model: string;
          endpoint: string;
        };
        tuningDataStats?: {
          tunedModelId?: string;
          supervisedTuningDataStats?: {
            tuningDatasetExampleCount: string;
            totalTuningCharacterCount: string;
          };
        };
        error?: { message: string };
        endTime?: string;
      };

      const state = data.state;
      const elapsed = Math.floor((i * POLL_INTERVAL_MS) / 60_000);

      if (i % 5 === 0 || state !== 'JOB_STATE_RUNNING') {
        console.log(`  [${elapsed}min] State: ${state}`);
      }

      if (state === 'JOB_STATE_SUCCEEDED') {
        console.log('\nTuning job completed successfully!');
        if (data.tunedModel) {
          console.log(`  Model:    ${data.tunedModel.model}`);
          console.log(`  Endpoint: ${data.tunedModel.endpoint}`);
        }
        return {
          state,
          tunedModelEndpoint: data.tunedModel?.endpoint,
          tunedModelName: data.tunedModel?.model,
        };
      }

      if (state === 'JOB_STATE_FAILED' || state === 'JOB_STATE_CANCELLED') {
        const errorMsg = data.error?.message ?? 'unknown error';
        throw new Error(`Tuning job ${state}: ${errorMsg}`);
      }

      await delay(POLL_INTERVAL_MS);
    } catch (err) {
      if (err instanceof Error && (err.message.includes('JOB_STATE_FAILED') || err.message.includes('JOB_STATE_CANCELLED'))) {
        throw err;
      }
      console.log(`  Poll exception: ${err instanceof Error ? err.message : err} — retrying`);
      await delay(POLL_INTERVAL_MS);
    }
  }

  throw new Error('Tuning job timed out after 12 hours');
}

function stepReport(params: {
  trainCount: number;
  valCount: number;
  stats: Record<string, number>;
  jobName: string;
  displayName: string;
  state: string;
  tunedModelEndpoint?: string;
  tunedModelName?: string;
  startTime: number;
}): void {
  console.log('\n========================================');
  console.log('     Gemini Fine-Tuning Pipeline Report  ');
  console.log('========================================\n');

  const elapsed = ((Date.now() - params.startTime) / 1000 / 60).toFixed(1);

  console.log(`Training examples:     ${params.trainCount}`);
  console.log(`Validation examples:   ${params.valCount}`);
  console.log(`Tuning job name:       ${params.jobName}`);
  console.log(`Model display name:    ${params.displayName}`);
  console.log(`Final state:           ${params.state}`);
  console.log(`Time elapsed:          ${elapsed} minutes`);

  if (params.tunedModelName) {
    console.log(`\nTuned model:           ${params.tunedModelName}`);
  }
  if (params.tunedModelEndpoint) {
    console.log(`Tuned endpoint:        ${params.tunedModelEndpoint}`);
  }

  console.log(`\nHyperparameters:`);
  console.log(`  Base model:        ${BASE_MODEL}`);
  console.log(`  Epochs:            ${EPOCHS}`);
  console.log(`  LR multiplier:     ${LR_MULTIPLIER}`);
  console.log(`  Adapter size:      ${ADAPTER_SIZE}`);
  console.log(`  Validation split:  ${VALIDATION_SPLIT}`);

  console.log(`\nCredential type distribution:`);
  for (const [type, count] of Object.entries(params.stats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  console.log(`\nNext steps:`);
  console.log(`  1. Test tuned model via Vertex AI:`);
  console.log(`     gcloud ai endpoints predict ${params.tunedModelEndpoint ?? '<endpoint>'} --json-request=test-request.json`);
  console.log(`  2. Update GeminiProvider to use tuned model endpoint`);
  console.log(`  3. Run eval suite to compare base vs tuned`);
  console.log('');
}

// --- Main ---

async function main(): Promise<void> {
  const startTime = Date.now();

  console.log('=== Arkova Gemini Fine-Tuning Pipeline (Vertex AI) ===');
  console.log(`Date:          ${new Date().toISOString()}`);
  console.log(`Dry run:       ${DRY_RUN}`);
  console.log(`Skip convert:  ${SKIP_CONVERT}`);
  console.log(`Base model:    ${BASE_MODEL}`);
  console.log(`Epochs:        ${EPOCHS}`);
  console.log(`Adapter size:  ${ADAPTER_SIZE}`);
  console.log(`LR multiplier: ${LR_MULTIPLIER}`);
  console.log(`Max examples:  ${MAX_EXAMPLES || 'unlimited'}`);

  // Step 1: Convert
  let trainCount = 0;
  let valCount = 0;
  let stats: Record<string, number> = {};

  if (SKIP_CONVERT) {
    console.log('\n--- Step 1: Convert SKIPPED (--skip-convert) ---');
    if (!existsSync(GEMINI_TRAIN_FILE)) {
      throw new Error(`Gemini training file not found: ${GEMINI_TRAIN_FILE}\nRun without --skip-convert to generate it.`);
    }
    trainCount = readFileSync(GEMINI_TRAIN_FILE, 'utf-8').trim().split('\n').filter((l) => l.length > 0).length;
    valCount = existsSync(GEMINI_VAL_FILE)
      ? readFileSync(GEMINI_VAL_FILE, 'utf-8').trim().split('\n').filter((l) => l.length > 0).length
      : 0;
    console.log(`Using existing: ${trainCount} train, ${valCount} validation`);
  } else {
    const result = await stepConvert();
    trainCount = result.trainCount;
    valCount = result.valCount;
    stats = result.stats;
  }

  // Step 2: Upload to GCS
  const { trainUri, valUri } = stepUpload();

  // Step 3: Create tuning job
  const { jobName, displayName } = await stepCreateTuningJob(trainUri, valUri);

  // Step 4: Poll
  const { state, tunedModelEndpoint, tunedModelName } = await stepPoll(jobName);

  // Step 5: Report
  stepReport({
    trainCount,
    valCount,
    stats,
    jobName,
    displayName,
    state,
    tunedModelEndpoint,
    tunedModelName,
    startTime,
  });
}

main().catch((err) => {
  console.error('\nPIPELINE FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});

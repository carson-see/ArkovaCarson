#!/usr/bin/env tsx
/**
 * Nessie Automated Training Pipeline
 *
 * Chains: export production data -> validate -> fine-tune -> monitor -> report
 *
 * Usage:
 *   cd services/worker
 *   npx tsx scripts/nessie-train-pipeline.ts [--skip-export] [--dry-run] [--epochs 5] [--learning-rate 5e-6]
 *
 * Requires: TOGETHER_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or --from-gcp)
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Load .env from worker directory
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

const SKIP_EXPORT = getFlag('skip-export');
const DRY_RUN = getFlag('dry-run');
const FROM_GCP = getFlag('from-gcp');
const AUGMENT = getFlag('augment');
const EPOCHS = parseInt(getArg('epochs', '4'), 10);
const LEARNING_RATE = parseFloat(getArg('learning-rate', '5e-6'));
const BATCH_SIZE = parseInt(getArg('batch-size', '8'), 10);
const WARMUP_RATIO = parseFloat(getArg('warmup-ratio', '0.1'));
const LR_SCHEDULER = getArg('lr-scheduler', 'cosine');

const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY;
const TOGETHER_BASE_URL = 'https://api.together.xyz/v1';
const BASE_MODEL = 'meta-llama/Meta-Llama-3.1-8B-Instruct-Reference';

const TRAINING_DIR = resolve(import.meta.dirname ?? '.', '../training-data');
const TRAINING_FILE = resolve(TRAINING_DIR, 'finetune-server-8b.jsonl');
const HOLDOUT_FILE = resolve(TRAINING_DIR, 'holdout-eval.jsonl');

// --- Credential type mapping (mirrors export-production-training.ts) ---

const SOURCE_TO_CREDENTIAL_TYPE: Record<string, string> = {
  'sec_filing': 'SEC_FILING',
  'article': 'PUBLICATION',
  'notice': 'REGULATION',
  'rule': 'REGULATION',
  'proposed_rule': 'REGULATION',
  'presidential_document': 'REGULATION',
  'accreditation': 'PROFESSIONAL',
  'charity_registration': 'CERTIFICATE',
  'opinion': 'LEGAL',
  'court_opinion': 'LEGAL',
};

const PAGE_SIZE = 1000;

interface PublicRecord {
  id: string;
  source: string;
  record_type: string;
  title: string;
  metadata: Record<string, unknown>;
  content_hash: string;
}

// --- Helpers ---

function getCredentialType(record: PublicRecord): string {
  return SOURCE_TO_CREDENTIAL_TYPE[record.record_type] || 'OTHER';
}

function buildExtractedFields(record: PublicRecord): Record<string, unknown> {
  const meta = record.metadata;
  const credType = getCredentialType(record);
  const fields: Record<string, unknown> = {
    credentialType: credType,
    confidence: 0.92,
  };

  if (meta.entity_name) fields.issuerName = meta.entity_name;
  if (meta.charity_legal_name) fields.issuerName = meta.charity_legal_name;
  if (meta.jurisdiction) fields.jurisdiction = meta.jurisdiction;

  switch (record.source) {
    case 'edgar':
      if (meta.entity_name) fields.issuerName = meta.entity_name;
      if (meta.form_type) fields.documentType = meta.form_type;
      if (meta.filing_date) fields.issuedDate = meta.filing_date;
      if (meta.ciks) fields.registrationNumber = (meta.ciks as string[])[0];
      fields.fieldOfStudy = 'Securities & Exchange';
      fields.jurisdiction = 'United States';
      break;
    case 'openalex':
      if (meta.authors) fields.issuerName = (meta.authors as string[])[0] || 'Unknown';
      if (meta.journal) fields.issuerName = meta.journal;
      if (meta.publication_date) fields.issuedDate = meta.publication_date;
      if (meta.doi) fields.registrationNumber = meta.doi;
      if (meta.topics && (meta.topics as string[]).length > 0) {
        fields.fieldOfStudy = (meta.topics as string[])[0];
      } else {
        fields.fieldOfStudy = 'Academic Research';
      }
      break;
    case 'federal_register':
      if (meta.agencies && (meta.agencies as string[]).length > 0) {
        fields.issuerName = (meta.agencies as string[])[0];
      }
      if (meta.publication_date) fields.issuedDate = meta.publication_date;
      if (meta.document_number) fields.registrationNumber = meta.document_number;
      fields.fieldOfStudy = 'Federal Regulation';
      fields.jurisdiction = 'United States';
      break;
    case 'dapip':
      if (meta.institution_name) fields.issuerName = meta.institution_name;
      if (meta.accreditor) fields.accreditingBody = meta.accreditor;
      if (meta.state) fields.jurisdiction = `${meta.state}, USA`;
      fields.fieldOfStudy = 'Higher Education Accreditation';
      break;
    case 'acnc':
      if (meta.charity_legal_name) fields.issuerName = meta.charity_legal_name;
      if (meta.registration_date) fields.issuedDate = meta.registration_date;
      if (meta.abn) fields.registrationNumber = meta.abn;
      if (meta.purposes && (meta.purposes as string[]).length > 0) {
        fields.fieldOfStudy = (meta.purposes as string[])[0];
      }
      if (meta.state) fields.jurisdiction = `${meta.state}, Australia`;
      else fields.jurisdiction = 'Australia';
      fields.accreditingBody = 'Australian Charities and Not-for-profits Commission';
      break;
    case 'courtlistener':
      if (meta.court_name) fields.issuerName = meta.court_name;
      if (meta.case_name) fields.title = meta.case_name;
      if (meta.date_filed) fields.issuedDate = meta.date_filed;
      if (meta.court_id) {
        const courtId = meta.court_id as string;
        if (['scotus', 'ca1', 'ca2', 'ca3', 'ca4', 'ca5', 'ca6', 'ca7', 'ca8', 'ca9', 'ca10', 'ca11', 'cadc', 'cafc'].includes(courtId)) {
          fields.jurisdiction = 'United States (Federal)';
        } else {
          fields.jurisdiction = 'United States';
        }
      }
      if (meta.nature_of_suit && typeof meta.nature_of_suit === 'string' && meta.nature_of_suit.length > 0) {
        fields.fieldOfStudy = meta.nature_of_suit;
      } else {
        fields.fieldOfStudy = 'Case Law';
      }
      if (meta.citations && Array.isArray(meta.citations) && (meta.citations as string[]).length > 0) {
        fields.registrationNumber = (meta.citations as string[])[0];
      }
      break;
  }

  fields.fraudSignals = [];
  return fields;
}

function formatAsConversation(record: PublicRecord): { messages: Array<{ role: string; content: string }> } | null {
  if (!record.title || record.title.length < 10) return null;

  const credType = getCredentialType(record);
  const extractedFields = buildExtractedFields(record);

  let textRepr = record.title;
  const meta = record.metadata;
  const metaLines: string[] = [];

  if (meta.entity_name) metaLines.push(`Entity: ${meta.entity_name}`);
  if (meta.charity_legal_name) metaLines.push(`Organization: ${meta.charity_legal_name}`);
  if (meta.form_type) metaLines.push(`Form Type: ${meta.form_type}`);
  if (meta.filing_date) metaLines.push(`Filing Date: ${meta.filing_date}`);
  if (meta.publication_date) metaLines.push(`Publication Date: ${meta.publication_date}`);
  if (meta.registration_date) metaLines.push(`Registration Date: ${meta.registration_date}`);
  if (meta.journal) metaLines.push(`Journal: ${meta.journal}`);
  if (meta.doi) metaLines.push(`DOI: ${meta.doi}`);
  if (meta.abn) metaLines.push(`ABN: ${meta.abn}`);
  if (meta.state) metaLines.push(`State: ${meta.state}`);
  if (meta.jurisdiction) metaLines.push(`Jurisdiction: ${meta.jurisdiction}`);
  if (meta.agencies) metaLines.push(`Agencies: ${(meta.agencies as string[]).join(', ')}`);
  if (meta.purposes) metaLines.push(`Purposes: ${(meta.purposes as string[]).join(', ')}`);
  if (meta.accreditor) metaLines.push(`Accreditor: ${meta.accreditor}`);
  if (meta.institution_name) metaLines.push(`Institution: ${meta.institution_name}`);
  if (meta.document_number) metaLines.push(`Document Number: ${meta.document_number}`);
  if (meta.file_description) metaLines.push(`Description: ${meta.file_description}`);
  if (meta.court_name) metaLines.push(`Court: ${meta.court_name}`);
  if (meta.case_name) metaLines.push(`Case Name: ${meta.case_name}`);
  if (meta.date_filed) metaLines.push(`Date Filed: ${meta.date_filed}`);
  if (meta.docket_number) metaLines.push(`Docket Number: ${meta.docket_number}`);
  if (meta.citations && Array.isArray(meta.citations) && (meta.citations as string[]).length > 0) {
    metaLines.push(`Citation: ${(meta.citations as string[]).join('; ')}`);
  }
  if (meta.nature_of_suit) metaLines.push(`Nature of Suit: ${meta.nature_of_suit}`);
  if (meta.precedential_status) metaLines.push(`Precedential Status: ${meta.precedential_status}`);

  if (metaLines.length > 0) {
    textRepr += '\n\n' + metaLines.join('\n');
  }

  const userPrompt = `Extract metadata from the following PII-stripped credential text.\nCredential type hint: ${credType}\n\n--- BEGIN CREDENTIAL TEXT ---\n${textRepr}\n--- END CREDENTIAL TEXT ---\n\nReturn a JSON object with the extracted fields, a "confidence" number (0.0 to 1.0), and a "fraudSignals" array.`;

  return {
    messages: [
      { role: 'system', content: 'You are a credential metadata extraction assistant. Extract structured metadata from PII-stripped credential text. Return JSON with credentialType, issuerName, issuedDate, jurisdiction, fieldOfStudy, registrationNumber, accreditingBody, confidence (0.0-1.0), and fraudSignals array. Omit fields you cannot determine.' },
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: JSON.stringify(extractedFields) },
    ],
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Data augmentation ---

/**
 * Augment underrepresented credential types by paraphrasing existing examples.
 * Shuffles field order and slightly varies prompt formatting to improve generalization.
 */
function augmentTrainingData(
  lines: string[],
  stats: Record<string, number>,
  targetMin: number = 200,
): { augmentedLines: string[]; augmentedCount: number } {
  const underrepresented = Object.entries(stats).filter(([, count]) => count < targetMin);
  if (underrepresented.length === 0) return { augmentedLines: [], augmentedCount: 0 };

  const augmentedLines: string[] = [];
  const linesByType = new Map<string, string[]>();

  // Index lines by credential type
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const assistantMsg = obj.messages?.find((m: { role: string }) => m.role === 'assistant')?.content;
      if (assistantMsg) {
        const parsed = JSON.parse(assistantMsg);
        const ct = parsed.credentialType || 'OTHER';
        if (!linesByType.has(ct)) linesByType.set(ct, []);
        linesByType.get(ct)!.push(line);
      }
    } catch {
      // Skip malformed
    }
  }

  for (const [type, count] of underrepresented) {
    const existing = linesByType.get(type) ?? [];
    if (existing.length === 0) continue;

    const needed = Math.min(targetMin - count, existing.length * 2); // Cap at 2x duplication
    for (let i = 0; i < needed; i++) {
      const source = existing[i % existing.length];
      try {
        const obj = JSON.parse(source);
        // Vary prompt: add/remove "Please" prefix, change credential type hint casing
        const userMsg = obj.messages.find((m: { role: string }) => m.role === 'user');
        if (userMsg) {
          const variants = [
            (s: string) => s.replace('Extract metadata', 'Please extract metadata'),
            (s: string) => s.replace('Credential type hint:', 'Document type:'),
            (s: string) => s.replace('Return a JSON object', 'Output a JSON object'),
          ];
          const variant = variants[i % variants.length];
          userMsg.content = variant(userMsg.content);
        }
        augmentedLines.push(JSON.stringify(obj));
      } catch {
        // Skip
      }
    }
  }

  return { augmentedLines, augmentedCount: augmentedLines.length };
}

// --- Pipeline steps ---

async function stepExport(): Promise<{ totalExported: number; stats: Record<string, number> }> {
  console.log('\n--- Step 1: Export production training data ---');

  let supabaseUrl = process.env.SUPABASE_URL;
  let supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (FROM_GCP || !supabaseUrl || !supabaseKey) {
    console.log('Fetching credentials from GCP Secret Manager...');
    const gcpEnv = 'GOOGLE_APPLICATION_CREDENTIALS=/Users/carson/.config/gcloud/application_default_credentials.json';
    supabaseUrl = execSync(`${gcpEnv} gcloud secrets versions access latest --secret=supabase-url --project=arkova1`, { encoding: 'utf-8' }).trim();
    supabaseKey = execSync(`${gcpEnv} gcloud secrets versions access latest --secret=supabase-service-role-key --project=arkova1`, { encoding: 'utf-8' }).trim();
  }

  const supabase = createClient(supabaseUrl!, supabaseKey!);

  const { count, error: countError } = await supabase
    .from('public_records')
    .select('*', { count: 'exact', head: true })
    .not('metadata', 'is', null)
    .not('title', 'is', null);

  if (countError) {
    throw new Error(`Count query failed: ${countError.message}`);
  }

  console.log(`Total records available: ${count}`);

  mkdirSync(dirname(TRAINING_FILE), { recursive: true });
  writeFileSync(TRAINING_FILE, '', 'utf-8');

  const stats: Record<string, number> = {};
  let totalExported = 0;
  let filtered = 0;
  let page = 0;

  while (true) {
    const { data, error } = await supabase
      .from('public_records')
      .select('id, source, record_type, title, metadata, content_hash')
      .not('metadata', 'is', null)
      .not('title', 'is', null)
      .order('created_at', { ascending: true })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (error) throw new Error(`Fetch page ${page} failed: ${error.message}`);
    if (!data || data.length === 0) break;

    let pageBuf = '';
    for (const record of data as PublicRecord[]) {
      const example = formatAsConversation(record);
      if (!example) { filtered++; continue; }
      const credType = getCredentialType(record);
      stats[credType] = (stats[credType] || 0) + 1;
      pageBuf += JSON.stringify(example) + '\n';
      totalExported++;
    }
    appendFileSync(TRAINING_FILE, pageBuf);
    page++;

    if (page % 10 === 0) {
      console.log(`  Page ${page}: ${totalExported} examples exported so far`);
    }

    if (data.length < PAGE_SIZE) break;
  }

  console.log(`Export complete: ${totalExported} examples, ${filtered} filtered`);
  console.log(`Output: ${TRAINING_FILE}`);

  return { totalExported, stats };
}

function stepValidate(stats: Record<string, number>): { totalExamples: number; warnings: string[] } {
  console.log('\n--- Step 2: Validate training data ---');

  if (!existsSync(TRAINING_FILE)) {
    throw new Error(`Training file not found: ${TRAINING_FILE}`);
  }

  const content = readFileSync(TRAINING_FILE, 'utf-8');
  const lines = content.trim().split('\n').filter(l => l.length > 0);
  const totalExamples = lines.length;

  console.log(`Total examples: ${totalExamples}`);

  if (totalExamples < 10) {
    throw new Error(`Too few training examples (${totalExamples}). Minimum 10 required.`);
  }

  // If stats not passed (--skip-export), compute from file
  if (Object.keys(stats).length === 0) {
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const assistantContent = obj.messages?.find((m: { role: string }) => m.role === 'assistant')?.content;
        if (assistantContent) {
          const parsed = JSON.parse(assistantContent);
          const ct = parsed.credentialType || 'OTHER';
          stats[ct] = (stats[ct] || 0) + 1;
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  const warnings: string[] = [];
  console.log('\nDistribution by credential type:');
  for (const [type, count] of Object.entries(stats).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / totalExamples) * 100).toFixed(1);
    console.log(`  ${type}: ${count} (${pct}%)`);
    if (count < 50) {
      warnings.push(`${type} has only ${count} examples (< 50 recommended minimum)`);
    }
  }

  if (warnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of warnings) {
      console.log(`  WARNING: ${w}`);
    }
  }

  return { totalExamples, warnings };
}

function stepSplit(totalExamples: number): { trainCount: number; holdoutCount: number } {
  console.log('\n--- Step 3: Create holdout evaluation set ---');

  const content = readFileSync(TRAINING_FILE, 'utf-8');
  const lines = content.trim().split('\n').filter(l => l.length > 0);

  // 10% holdout, minimum 10, maximum 5000
  const holdoutSize = Math.min(Math.max(Math.floor(lines.length * 0.1), 10), 5000);

  // Fisher-Yates shuffle to get random holdout indices
  const indices = Array.from({ length: lines.length }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  const holdoutIndices = new Set(indices.slice(0, holdoutSize));
  const trainLines: string[] = [];
  const holdoutLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (holdoutIndices.has(i)) {
      holdoutLines.push(lines[i]);
    } else {
      trainLines.push(lines[i]);
    }
  }

  // Overwrite training file with train split only
  writeFileSync(TRAINING_FILE, trainLines.join('\n') + '\n', 'utf-8');
  writeFileSync(HOLDOUT_FILE, holdoutLines.join('\n') + '\n', 'utf-8');

  console.log(`Training set: ${trainLines.length} examples -> ${TRAINING_FILE}`);
  console.log(`Holdout set:  ${holdoutLines.length} examples -> ${HOLDOUT_FILE}`);

  return { trainCount: trainLines.length, holdoutCount: holdoutLines.length };
}

async function stepFineTune(): Promise<{ jobId: string; modelOutputName: string }> {
  console.log('\n--- Step 4: Upload and start fine-tune ---');

  if (!TOGETHER_API_KEY) {
    throw new Error('TOGETHER_API_KEY required in environment');
  }

  const content = readFileSync(TRAINING_FILE, 'utf-8');
  const lineCount = content.trim().split('\n').filter(l => l.length > 0).length;

  console.log(`Uploading ${lineCount} training examples to Together AI...`);
  console.log(`Config: epochs=${EPOCHS}, lr=${LEARNING_RATE}, batch_size=${BATCH_SIZE}`);

  if (DRY_RUN) {
    console.log('[DRY RUN] Skipping actual upload and fine-tune launch');
    return { jobId: 'dry-run-job-id', modelOutputName: 'dry-run-model' };
  }

  // Upload file
  const formData = new FormData();
  formData.append('file', new Blob([content], { type: 'application/jsonl' }), 'training.jsonl');
  formData.append('file_name', 'arkova-nessie-training.jsonl');
  formData.append('purpose', 'fine-tune');

  const uploadRes = await fetch(`${TOGETHER_BASE_URL}/files/upload`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOGETHER_API_KEY}` },
    body: formData,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Upload failed: ${uploadRes.status} ${err}`);
  }

  const uploadData = await uploadRes.json() as { id: string; filename: string };
  console.log(`File uploaded: ${uploadData.id}`);

  // Start fine-tune with v3 config: warmup + cosine LR schedule
  const ftRes = await fetch(`${TOGETHER_BASE_URL}/fine-tunes`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOGETHER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      training_file: uploadData.id,
      model: BASE_MODEL,
      n_epochs: EPOCHS,
      n_checkpoints: Math.min(EPOCHS, 5),
      learning_rate: LEARNING_RATE,
      batch_size: BATCH_SIZE,
      warmup_ratio: WARMUP_RATIO,
      lr_scheduler_type: LR_SCHEDULER,
      suffix: 'arkova-nessie-v3',
    }),
  });

  if (!ftRes.ok) {
    const err = await ftRes.text();
    throw new Error(`Fine-tune creation failed: ${ftRes.status} ${err}`);
  }

  const ftData = await ftRes.json() as { id: string; status: string; model_output_name: string };
  console.log(`Fine-tune job created: ${ftData.id}`);
  console.log(`Status: ${ftData.status}`);
  console.log(`Output model: ${ftData.model_output_name}`);

  return { jobId: ftData.id, modelOutputName: ftData.model_output_name };
}

async function stepPoll(jobId: string): Promise<string> {
  console.log('\n--- Step 5: Polling for fine-tune completion ---');

  if (DRY_RUN) {
    console.log('[DRY RUN] Skipping poll');
    return 'completed';
  }

  if (!TOGETHER_API_KEY) {
    throw new Error('TOGETHER_API_KEY required');
  }

  const POLL_INTERVAL_MS = 60_000;
  const MAX_POLLS = 720; // 12 hours max

  for (let i = 0; i < MAX_POLLS; i++) {
    const res = await fetch(`${TOGETHER_BASE_URL}/fine-tunes/${jobId}`, {
      headers: { 'Authorization': `Bearer ${TOGETHER_API_KEY}` },
    });

    if (!res.ok) {
      console.log(`  Poll error: ${res.status} — retrying in 60s`);
      await delay(POLL_INTERVAL_MS);
      continue;
    }

    const data = await res.json() as { id: string; status: string; events?: Array<{ message: string; created_at: string }> };
    const status = data.status;

    if (i % 5 === 0 || status !== 'running') {
      const elapsed = Math.floor((i * POLL_INTERVAL_MS) / 60_000);
      console.log(`  [${elapsed}min] Status: ${status}`);
    }

    if (status === 'completed' || status === 'succeeded') {
      console.log('Fine-tune completed successfully!');
      return status;
    }

    if (status === 'failed' || status === 'cancelled' || status === 'error') {
      const lastEvent = data.events?.[data.events.length - 1]?.message ?? 'unknown';
      throw new Error(`Fine-tune ${status}: ${lastEvent}`);
    }

    await delay(POLL_INTERVAL_MS);
  }

  throw new Error('Fine-tune timed out after 12 hours');
}

function stepReport(params: {
  totalExamples: number;
  trainCount: number;
  holdoutCount: number;
  stats: Record<string, number>;
  warnings: string[];
  jobId: string;
  modelOutputName: string;
  finalStatus: string;
  startTime: number;
}): void {
  console.log('\n========================================');
  console.log('     Nessie Training Pipeline Report    ');
  console.log('========================================\n');

  const elapsed = ((Date.now() - params.startTime) / 1000).toFixed(0);
  const elapsedMin = (parseFloat(elapsed) / 60).toFixed(1);

  console.log(`Total examples exported:  ${params.totalExamples}`);
  console.log(`Training set size:        ${params.trainCount}`);
  console.log(`Holdout evaluation set:   ${params.holdoutCount}`);
  console.log(`Fine-tune job ID:         ${params.jobId}`);
  console.log(`Output model ID:          ${params.modelOutputName}`);
  console.log(`Final status:             ${params.finalStatus}`);
  console.log(`Time elapsed:             ${elapsedMin} minutes`);
  console.log(`\nHyperparameters (v3):`);
  console.log(`  Epochs:        ${EPOCHS}`);
  console.log(`  Learning rate: ${LEARNING_RATE}`);
  console.log(`  Warmup ratio:  ${WARMUP_RATIO}`);
  console.log(`  LR scheduler:  ${LR_SCHEDULER}`);
  console.log(`  Batch size:    ${BATCH_SIZE}`);
  console.log(`  Base model:    ${BASE_MODEL}`);

  console.log(`\nCredential type distribution:`);
  for (const [type, count] of Object.entries(params.stats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  if (params.warnings.length > 0) {
    console.log(`\nWarnings:`);
    for (const w of params.warnings) {
      console.log(`  - ${w}`);
    }
  }

  console.log(`\nNext steps:`);
  console.log(`  1. Evaluate holdout set: npx tsx scripts/eval-holdout.ts --model ${params.modelOutputName}`);
  console.log(`  2. Set in worker .env: TOGETHER_MODEL=${params.modelOutputName}`);
  console.log(`  3. Redeploy worker to use the fine-tuned model`);
  console.log('');
}

// --- Main ---

async function main(): Promise<void> {
  const startTime = Date.now();

  console.log('=== Arkova Nessie Automated Training Pipeline ===');
  console.log(`Date:       ${new Date().toISOString()}`);
  console.log(`Dry run:    ${DRY_RUN}`);
  console.log(`Skip export:${SKIP_EXPORT}`);
  console.log(`Augment:    ${AUGMENT}`);
  console.log(`Epochs:     ${EPOCHS}`);
  console.log(`LR:         ${LEARNING_RATE}`);
  console.log(`Warmup:     ${WARMUP_RATIO}`);
  console.log(`Scheduler:  ${LR_SCHEDULER}`);
  console.log(`Batch size: ${BATCH_SIZE}`);

  // Step 1: Export
  let stats: Record<string, number> = {};
  let totalExported = 0;

  if (SKIP_EXPORT) {
    console.log('\n--- Step 1: Export SKIPPED (--skip-export) ---');
    if (!existsSync(TRAINING_FILE)) {
      throw new Error(`Training file not found: ${TRAINING_FILE}\nRun without --skip-export to generate it.`);
    }
    const lines = readFileSync(TRAINING_FILE, 'utf-8').trim().split('\n').filter(l => l.length > 0);
    totalExported = lines.length;
    console.log(`Using existing training file: ${totalExported} examples`);
  } else {
    const exportResult = await stepExport();
    totalExported = exportResult.totalExported;
    stats = exportResult.stats;
  }

  // Step 2: Validate
  const validation = stepValidate(stats);
  stats = { ...stats }; // stats may have been updated by stepValidate

  // Step 2.5: Augment underrepresented types (optional)
  if (AUGMENT) {
    console.log('\n--- Step 2.5: Data augmentation ---');
    const lines = readFileSync(TRAINING_FILE, 'utf-8').trim().split('\n').filter(l => l.length > 0);
    const { augmentedLines, augmentedCount } = augmentTrainingData(lines, stats);
    if (augmentedCount > 0) {
      appendFileSync(TRAINING_FILE, augmentedLines.join('\n') + '\n');
      totalExported += augmentedCount;
      console.log(`Augmented: +${augmentedCount} examples (total now ${totalExported})`);
    } else {
      console.log('No augmentation needed — all types above threshold');
    }
  }

  // Step 3: Split
  const { trainCount, holdoutCount } = stepSplit(AUGMENT ? totalExported : validation.totalExamples);

  // Step 4: Fine-tune
  const { jobId, modelOutputName } = await stepFineTune();

  // Step 5: Poll
  const finalStatus = await stepPoll(jobId);

  // Step 6: Report
  stepReport({
    totalExamples: totalExported,
    trainCount,
    holdoutCount,
    stats,
    warnings: validation.warnings,
    jobId,
    modelOutputName,
    finalStatus,
    startTime,
  });
}

main().catch((err) => {
  console.error('\nPIPELINE FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});

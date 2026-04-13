#!/usr/bin/env tsx
/**
 * Nessie v7 Training Data Export (NMT-15)
 *
 * Exports expanded golden dataset (phases 1-14) as Together AI JSONL.
 * v7 improvements over v5:
 * 1. +80 phase 12 entries (weakness remediation: PUBLICATION, MILITARY, IDENTITY, REGULATION)
 * 2. +120 phase 14 entries (rare types: CHARITY, ACCREDITATION, BADGE, ATTESTATION, MEDICAL, edge cases)
 * 3. Total: ~2,100+ training examples (vs 1,903 in v5)
 * 4. Better coverage of underrepresented credential types
 *
 * Usage:
 *   cd services/worker
 *   npx tsx scripts/nessie-v7-export.ts
 *   npx tsx scripts/nessie-v7-export.ts --train      # auto-submit to Together AI
 *   npx tsx scripts/nessie-v7-export.ts --dry-run     # show stats only
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { createHash } from 'node:crypto';

dotenvConfig({ path: resolve(import.meta.dirname ?? '.', '../.env') });

import { FULL_GOLDEN_DATASET } from '../src/ai/eval/golden-dataset.js';
import {
  computeRealisticConfidence,
  deduplicateByContent,
} from '../src/ai/training/nessie-v4-data.js';

/**
 * Condensed system prompt — must match nessie.ts NESSIE_CONDENSED_PROMPT exactly.
 * Duplicated here to avoid importing nessie.ts (which pulls in worker runtime deps).
 */
const NESSIE_CONDENSED_PROMPT = `You are a credential metadata extraction assistant. Extract structured metadata from PII-stripped credential text.

RULES:
- Input is PII-stripped. Never reconstruct redacted PII.
- Return valid JSON with only fields you can confidently extract.
- Omit fields you cannot determine (no null or empty strings).
- Dates in ISO 8601 (YYYY-MM-DD).
- confidence: 0.0-1.0 reflecting extraction certainty.

FIELDS:
- credentialType: DEGREE, LICENSE, CERTIFICATE, BADGE, SEC_FILING, LEGAL, REGULATION, PATENT, PUBLICATION, ATTESTATION, INSURANCE, FINANCIAL, MILITARY, CLE, RESUME, MEDICAL, IDENTITY, TRANSCRIPT, PROFESSIONAL, OTHER
- issuerName: Organization that issued the credential (board/department, not state name)
- issuedDate: Date issued (ISO 8601)
- expiryDate: Expiration date if applicable
- fieldOfStudy: Subject area or discipline
- degreeLevel: For DEGREE type (Bachelor, Master, Ph.D., etc.)
- licenseNumber: Only if visible (not [REDACTED])
- accreditingBody: Separate accrediting organization if named
- jurisdiction: State/country. US states as "State" (e.g., "California"). International as country name.
- fraudSignals: Array of flags: EXPIRED_ISSUER, SUSPICIOUS_DATES, KNOWN_DIPLOMA_MILL, INVALID_FORMAT, INCONSISTENT_ISSUER, UNVERIFIABLE_ISSUER, EXPIRED_CREDENTIAL, REVOKED_STATUS, SUSPICIOUS_TIMELINE, MATERIAL_MISSTATEMENT, DUPLICATE_REGISTRATION, RETRACTED_VERIFICATION, ENFORCEMENT_ACTION

CLE FIELDS (for CLE type only):
- creditHours: Number of CLE credits
- creditType: Ethics, General, Technology, Substantive, Professional Responsibility, etc.
- barNumber: Attorney bar number (only if visible)
- activityNumber: CLE course/activity number
- providerName: CLE provider organization
- approvedBy: CLE approving authority

CONFIDENCE:
- 0.90-0.95: Clean document, all key fields present
- 0.80-0.89: Most fields present, minor ambiguities
- 0.65-0.79: Several fields missing or ambiguous
- 0.45-0.64: Sparse text, many inferences
- 0.20-0.44: Very little extractable content`;

// --- CLI ---
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const AUTO_TRAIN = args.includes('--train');
const VAL_RATIO = 0.1; // 10% holdout
const GENERAL_MIX_RATIO = 0.25; // 25% general instruction data

const OUTPUT_DIR = resolve(import.meta.dirname ?? '.', '../training-data');
const TRAIN_PATH = resolve(OUTPUT_DIR, 'nessie-v7-train.jsonl');
const VAL_PATH = resolve(OUTPUT_DIR, 'nessie-v7-val.jsonl');

interface TrainingMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface TrainingExample {
  messages: TrainingMessage[];
}

/**
 * Convert a golden dataset entry to a training example.
 */
function entryToTrainingExample(entry: typeof FULL_GOLDEN_DATASET[0]): TrainingExample {
  // Build ground truth JSON with realistic confidence
  const gt = { ...entry.groundTruth };
  const confidence = computeRealisticConfidence(gt as Record<string, unknown>, entry.strippedText);

  const assistantResponse = JSON.stringify({
    ...gt,
    confidence: Math.round(confidence * 100) / 100,
  });

  return {
    messages: [
      { role: 'system', content: NESSIE_CONDENSED_PROMPT },
      { role: 'user', content: entry.strippedText },
      { role: 'assistant', content: assistantResponse },
    ],
  };
}

/**
 * Deterministic shuffle for reproducible train/val split.
 */
function deterministicShuffle<T>(arr: T[], seed: string): T[] {
  const copy = [...arr];
  let hash = createHash('sha256').update(seed).digest();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = hash.readUInt32BE(0) % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
    hash = createHash('sha256').update(hash).digest();
  }
  return copy;
}

async function main() {
  console.log('=== Nessie v7 Training Data Export (NMT-15) ===\n');

  // Step 1: Convert golden dataset to training examples
  console.log('Step 1: Converting golden dataset entries...');
  const examples = FULL_GOLDEN_DATASET.map(entryToTrainingExample);
  console.log(`  ${examples.length} entries converted.`);

  // Step 2: Deduplicate by user message content
  console.log('\nStep 2: Deduplicating...');
  const dedupedExamples = deduplicateByContent(
    examples.map(e => ({
      messages: e.messages,
      tag: 'golden',
    })),
  );
  console.log(`  ${examples.length} → ${dedupedExamples.length} after dedup`);

  // Step 3: Show type distribution
  console.log('\nStep 3: Credential type distribution:');
  const typeCounts: Record<string, number> = {};
  for (const example of dedupedExamples) {
    try {
      const parsed = JSON.parse(example.messages[2].content);
      const type = parsed.credentialType || 'UNKNOWN';
      typeCounts[type] = (typeCounts[type] || 0) + 1;
    } catch {
      typeCounts['PARSE_ERROR'] = (typeCounts['PARSE_ERROR'] || 0) + 1;
    }
  }
  const sortedTypes = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
  for (const [type, count] of sortedTypes) {
    console.log(`  ${type}: ${count}`);
  }
  console.log(`  Total: ${dedupedExamples.length}`);

  // Step 4: Deterministic train/val split
  console.log('\nStep 4: Train/val split...');
  const shuffled = deterministicShuffle(dedupedExamples, 'nessie-v7-split');
  const valSize = Math.max(10, Math.min(500, Math.floor(shuffled.length * VAL_RATIO)));
  const valExamples = shuffled.slice(0, valSize);
  const trainExamples = shuffled.slice(valSize);
  console.log(`  Train: ${trainExamples.length}`);
  console.log(`  Val: ${valExamples.length}`);

  // Step 5: Mix general instruction data (if available)
  const generalDataPath = resolve(OUTPUT_DIR, 'general-instruction-mix.jsonl');
  let finalTrainExamples = trainExamples;
  if (existsSync(generalDataPath)) {
    console.log('\nStep 5: Mixing general instruction data...');
    const generalLines = readFileSync(generalDataPath, 'utf-8')
      .split('\n')
      .filter(l => l.trim());
    const generalCount = Math.floor(trainExamples.length * GENERAL_MIX_RATIO);
    const generalExamples = generalLines
      .slice(0, generalCount)
      .map(l => JSON.parse(l) as { messages: TrainingMessage[] });
    finalTrainExamples = [...trainExamples, ...generalExamples];
    console.log(`  Added ${generalExamples.length} general examples (${GENERAL_MIX_RATIO * 100}% mix)`);
    console.log(`  Final train size: ${finalTrainExamples.length}`);
  } else {
    console.log('\nStep 5: No general instruction data found (skipping mix).');
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would export:');
    console.log(`  Train: ${finalTrainExamples.length} → ${TRAIN_PATH}`);
    console.log(`  Val: ${valExamples.length} → ${VAL_PATH}`);
    process.exit(0);
  }

  // Step 6: Export JSONL
  console.log('\nStep 6: Exporting JSONL...');
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const trainJsonl = finalTrainExamples.map(e => JSON.stringify({ messages: e.messages })).join('\n');
  writeFileSync(TRAIN_PATH, trainJsonl);
  console.log(`  Train: ${finalTrainExamples.length} examples → ${TRAIN_PATH}`);

  const valJsonl = valExamples.map(e => JSON.stringify({ messages: e.messages })).join('\n');
  writeFileSync(VAL_PATH, valJsonl);
  console.log(`  Val: ${valExamples.length} examples → ${VAL_PATH}`);

  // Step 7: Submit to Together AI (if --train)
  if (AUTO_TRAIN) {
    console.log('\nStep 7: Submitting to Together AI...');
    const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY;
    if (!TOGETHER_API_KEY) {
      console.error('Error: TOGETHER_API_KEY not set');
      process.exit(1);
    }

    // Upload training file
    const formData = new FormData();
    formData.append('file', new Blob([trainJsonl], { type: 'application/json' }), 'nessie-v7-train.jsonl');
    formData.append('purpose', 'fine-tune');

    const uploadResp = await fetch('https://api.together.xyz/v1/files', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOGETHER_API_KEY}` },
      body: formData,
    });

    if (!uploadResp.ok) {
      console.error(`Upload failed: ${uploadResp.status} ${await uploadResp.text()}`);
      process.exit(1);
    }

    const uploadData = await uploadResp.json() as { id: string };
    console.log(`  Training file uploaded: ${uploadData.id}`);

    // Upload validation file
    const valFormData = new FormData();
    valFormData.append('file', new Blob([valJsonl], { type: 'application/json' }), 'nessie-v7-val.jsonl');
    valFormData.append('purpose', 'fine-tune');

    const valUploadResp = await fetch('https://api.together.xyz/v1/files', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOGETHER_API_KEY}` },
      body: valFormData,
    });

    if (!valUploadResp.ok) {
      console.error(`Val upload failed: ${valUploadResp.status}`);
      process.exit(1);
    }

    const valUploadData = await valUploadResp.json() as { id: string };
    console.log(`  Validation file uploaded: ${valUploadData.id}`);

    // Create fine-tune job
    const ftResp = await fetch('https://api.together.xyz/v1/fine-tunes', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOGETHER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        training_file: uploadData.id,
        validation_file: valUploadData.id,
        model: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Reference',
        n_epochs: 2,
        learning_rate: 2e-4,
        batch_size: 2,
        suffix: 'arkova-nessie-v7',
        lora: true,
        lora_r: 16,
        lora_alpha: 32,
      }),
    });

    if (!ftResp.ok) {
      console.error(`Fine-tune creation failed: ${ftResp.status} ${await ftResp.text()}`);
      process.exit(1);
    }

    const ftData = await ftResp.json() as { id: string };
    console.log(`\n  Fine-tune job created: ${ftData.id}`);
    console.log('  Monitor at: https://api.together.xyz/v1/fine-tunes');
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

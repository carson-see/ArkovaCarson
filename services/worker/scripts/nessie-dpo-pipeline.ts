#!/usr/bin/env tsx
/**
 * Nessie DPO (Direct Preference Optimization) Training Pipeline
 *
 * Trains Nessie to prefer accurate, well-cited responses over
 * hallucinated or low-quality extractions.
 *
 * DPO teaches the model: "this response is BETTER than that response"
 * rather than SFT's "this is the right response." This is critical for:
 *   - Citation accuracy (prefer real doc references over fabricated ones)
 *   - Confidence calibration (prefer honest uncertainty over false confidence)
 *   - Field accuracy (prefer omitting unknown fields over hallucinating them)
 *
 * Preference pairs are generated from existing golden + training data:
 *   - Chosen: ground truth extraction (correct fields, honest confidence)
 *   - Rejected: degraded version (hallucinated fields, wrong dates, inflated confidence)
 *
 * Together AI DPO format:
 *   {"prompt": "<system+user>", "chosen": "<good response>", "rejected": "<bad response>"}
 *
 * Usage:
 *   cd services/worker
 *   npx tsx scripts/nessie-dpo-pipeline.ts [options]
 *
 * Options:
 *   --source golden|training|both    Data source (default: both)
 *   --max-pairs <n>                  Max preference pairs (default: 10000)
 *   --dry-run                        Generate pairs only, don't train
 *   --epochs <n>                     Training epochs (default: 2)
 *   --learning-rate <f>              Learning rate (default: 1e-6)
 *   --base-model <id>                Base model to DPO from (default: latest v3)
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  createReadStream,
} from 'node:fs';
import { createInterface } from 'node:readline';

dotenvConfig({ path: resolve(import.meta.dirname ?? '.', '../.env') });

// --- CLI ---

const args = process.argv.slice(2);

function getFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

function getArg(name: string, defaultVal: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const SOURCE = getArg('source', 'both') as 'golden' | 'training' | 'both';
const MAX_PAIRS = parseInt(getArg('max-pairs', '10000'), 10);
const DRY_RUN = getFlag('dry-run');
const EPOCHS = parseInt(getArg('epochs', '2'), 10);
const LEARNING_RATE = parseFloat(getArg('learning-rate', '1e-6'));
// Together AI DPO docs confirm Meta-Llama-3.1-8B-Instruct-Reference supports DPO.
const BASE_MODEL = getArg(
  'base-model',
  'meta-llama/Meta-Llama-3.1-8B-Instruct-Reference',
);

const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY;
const TOGETHER_BASE_URL = 'https://api.together.xyz/v1';
const TRAINING_DIR = resolve(import.meta.dirname ?? '.', '../training-data');
const DPO_DIR = resolve(TRAINING_DIR, 'dpo');

// --- Degradation strategies for generating "rejected" responses ---

/**
 * Strategy 1: Hallucinate fields
 * Add fields that don't exist in the source text.
 */
function hallucinateFields(chosen: Record<string, unknown>): Record<string, unknown> {
  const rejected = { ...chosen };

  // Add hallucinated registration number if not present
  if (!chosen.licenseNumber && !chosen.registrationNumber) {
    rejected.licenseNumber = `HAL-${Math.floor(Math.random() * 900000 + 100000)}`;
  }

  // Add hallucinated accrediting body
  if (!chosen.accreditingBody) {
    const fakeAccreditors = [
      'International Standards Board',
      'Global Compliance Authority',
      'Universal Accreditation Council',
      'World Professional Standards Organization',
      'International Verification Institute',
    ];
    rejected.accreditingBody = fakeAccreditors[Math.floor(Math.random() * fakeAccreditors.length)];
  }

  // Inflate confidence
  rejected.confidence = Math.min(0.99, (chosen.confidence as number || 0.85) + 0.15);

  return rejected;
}

/**
 * Strategy 2: Wrong dates
 * Shift dates by random amounts — common LLM hallucination.
 */
function corruptDates(chosen: Record<string, unknown>): Record<string, unknown> {
  const rejected = { ...chosen };

  if (chosen.issuedDate && typeof chosen.issuedDate === 'string') {
    const date = new Date(chosen.issuedDate as string);
    if (!isNaN(date.getTime())) {
      // Shift by 1-3 years
      date.setFullYear(date.getFullYear() + Math.floor(Math.random() * 3) + 1);
      rejected.issuedDate = date.toISOString().split('T')[0];
    }
  }

  if (chosen.expiryDate && typeof chosen.expiryDate === 'string') {
    const date = new Date(chosen.expiryDate as string);
    if (!isNaN(date.getTime())) {
      date.setFullYear(date.getFullYear() - Math.floor(Math.random() * 2) - 1);
      rejected.expiryDate = date.toISOString().split('T')[0];
    }
  }

  // Keep high confidence (bad — model shouldn't be confident about wrong dates)
  rejected.confidence = Math.min(0.95, (chosen.confidence as number || 0.85) + 0.1);

  return rejected;
}

/**
 * Strategy 3: Wrong credential type
 * Misclassify the document type.
 */
function wrongCredentialType(chosen: Record<string, unknown>): Record<string, unknown> {
  const rejected = { ...chosen };
  const types = ['DEGREE', 'LICENSE', 'CERTIFICATE', 'PROFESSIONAL', 'SEC_FILING', 'REGULATION', 'LEGAL', 'PUBLICATION'];
  const currentType = chosen.credentialType as string;

  // Pick a different type
  const otherTypes = types.filter((t) => t !== currentType);
  rejected.credentialType = otherTypes[Math.floor(Math.random() * otherTypes.length)];

  // Wrong type with high confidence = bad behavior
  rejected.confidence = 0.92;

  return rejected;
}

/**
 * Strategy 4: Wrong jurisdiction
 * Assign incorrect geographic jurisdiction.
 */
function wrongJurisdiction(chosen: Record<string, unknown>): Record<string, unknown> {
  const rejected = { ...chosen };

  if (chosen.jurisdiction) {
    const fakeJurisdictions = [
      'Cayman Islands',
      'British Virgin Islands',
      'Luxembourg',
      'Singapore',
      'Isle of Man',
      'Bermuda',
      'Hong Kong SAR',
    ];
    rejected.jurisdiction = fakeJurisdictions[Math.floor(Math.random() * fakeJurisdictions.length)];
  }

  rejected.confidence = 0.88;
  return rejected;
}

/**
 * Strategy 5: Overconfident on sparse data
 * Remove most fields but keep very high confidence.
 */
function overconfidentSparse(chosen: Record<string, unknown>): Record<string, unknown> {
  const rejected: Record<string, unknown> = {
    credentialType: chosen.credentialType ?? 'OTHER',
    confidence: 0.95, // Very high confidence with almost no data
    fraudSignals: [],
  };

  // Keep only 1-2 fields
  if (chosen.issuerName) rejected.issuerName = chosen.issuerName;

  return rejected;
}

/**
 * Strategy 6: Missing fraud signals
 * Remove fraud signals that should be there, or add false ones.
 */
function corruptFraudSignals(chosen: Record<string, unknown>): Record<string, unknown> {
  const rejected = { ...chosen };
  const signals = chosen.fraudSignals as string[] | undefined;

  if (signals && signals.length > 0) {
    // Remove real fraud signals (dangerous — model should keep them)
    rejected.fraudSignals = [];
    rejected.confidence = 0.95;
  } else {
    // Add false fraud signals to clean docs (cry wolf)
    rejected.fraudSignals = [
      'SUSPICIOUS_DATE_FORMAT',
      'UNVERIFIED_ISSUER',
      'POSSIBLE_TEMPLATE_MISMATCH',
    ];
    rejected.confidence = 0.35;
  }

  return rejected;
}

// All strategies with weights (some are more important than others)
const DEGRADATION_STRATEGIES = [
  { fn: hallucinateFields, weight: 3, name: 'hallucinate_fields' },
  { fn: corruptDates, weight: 2, name: 'corrupt_dates' },
  { fn: wrongCredentialType, weight: 2, name: 'wrong_type' },
  { fn: wrongJurisdiction, weight: 2, name: 'wrong_jurisdiction' },
  { fn: overconfidentSparse, weight: 2, name: 'overconfident_sparse' },
  { fn: corruptFraudSignals, weight: 1, name: 'corrupt_fraud_signals' },
];

function pickStrategy(): (typeof DEGRADATION_STRATEGIES)[0] {
  const totalWeight = DEGRADATION_STRATEGIES.reduce((s, d) => s + d.weight, 0);
  let r = Math.random() * totalWeight;
  for (const strategy of DEGRADATION_STRATEGIES) {
    r -= strategy.weight;
    if (r <= 0) return strategy;
  }
  return DEGRADATION_STRATEGIES[0];
}

// --- Build DPO pair from training example ---

/**
 * Together AI DPO format requires prompt/chosen/rejected to be arrays of
 * message objects (chat-style), NOT raw strings.
 *
 * Format:
 *   prompt:   [{ role: "system", content: "..." }, { role: "user", content: "..." }]
 *   chosen:   [{ role: "assistant", content: "..." }]
 *   rejected: [{ role: "assistant", content: "..." }]
 */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface DPOPair {
  prompt: ChatMessage[];
  chosen: ChatMessage[];
  rejected: ChatMessage[];
  _meta?: {
    strategy: string;
    credentialType: string;
    source: string;
  };
}

function buildDPOPair(
  systemPrompt: string,
  userPrompt: string,
  chosenFields: Record<string, unknown>,
  source: string,
): DPOPair | null {
  const strategy = pickStrategy();
  const rejectedFields = strategy.fn(chosenFields);

  // Ensure rejected is actually different
  const chosenStr = JSON.stringify(chosenFields);
  const rejectedStr = JSON.stringify(rejectedFields);
  if (chosenStr === rejectedStr) return null;

  return {
    prompt: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    chosen: [
      { role: 'assistant', content: chosenStr },
    ],
    rejected: [
      { role: 'assistant', content: rejectedStr },
    ],
    _meta: {
      strategy: strategy.name,
      credentialType: (chosenFields.credentialType as string) ?? 'UNKNOWN',
      source,
    },
  };
}

// --- Step 1: Generate preference pairs from golden dataset ---

async function loadGoldenPairs(): Promise<DPOPair[]> {
  console.log('  Loading golden dataset pairs...');
  const pairs: DPOPair[] = [];

  // Import golden datasets
  const goldenModules = [
    '../src/ai/eval/golden-dataset.js',
    '../src/ai/eval/golden-dataset-extended.js',
    '../src/ai/eval/golden-dataset-phase2.js',
    '../src/ai/eval/golden-dataset-phase3.js',
    '../src/ai/eval/golden-dataset-phase4.js',
    '../src/ai/eval/golden-dataset-phase5.js',
    '../src/ai/eval/golden-dataset-phase6.js',
    '../src/ai/eval/golden-dataset-phase7.js',
    '../src/ai/eval/golden-dataset-phase8.js',
    '../src/ai/eval/golden-dataset-phase9.js',
  ];

  const allEntries = new Map<string, { strippedText: string; credentialTypeHint: string; groundTruth: Record<string, unknown>; tags: string[] }>();

  for (const mod of goldenModules) {
    try {
      const module = await import(mod);
      const datasets = Object.values(module).filter(Array.isArray) as Array<Array<{ id: string; strippedText: string; credentialTypeHint: string; groundTruth: Record<string, unknown>; tags: string[] }>>;
      for (const dataset of datasets) {
        for (const entry of dataset) {
          if (entry.id && !allEntries.has(entry.id)) {
            allEntries.set(entry.id, entry);
          }
        }
      }
    } catch {
      // Skip missing modules
    }
  }

  console.log(`  Found ${allEntries.size} golden entries`);

  const systemPrompt = 'You are a credential metadata extraction assistant. Extract structured metadata from PII-stripped credential text. Return JSON with credentialType, issuerName, issuedDate, jurisdiction, fieldOfStudy, registrationNumber, accreditingBody, confidence (0.0-1.0), and fraudSignals array. Omit fields you cannot determine.';

  for (const entry of allEntries.values()) {
    const userPrompt = `Extract metadata from the following PII-stripped credential text.\nCredential type hint: ${entry.credentialTypeHint}\n\n--- BEGIN CREDENTIAL TEXT ---\n${entry.strippedText}\n--- END CREDENTIAL TEXT ---\n\nReturn a JSON object with the extracted fields, a "confidence" number (0.0 to 1.0), and a "fraudSignals" array.`;

    // Assign confidence based on tags (matching golden finetune logic)
    const chosenFields = { ...entry.groundTruth };
    if (entry.tags.includes('clean')) {
      chosenFields.confidence = 0.92;
    } else if (entry.tags.includes('ambiguous') || entry.tags.includes('partial')) {
      chosenFields.confidence = 0.72;
    } else if (entry.tags.includes('corrupted') || entry.tags.includes('junk')) {
      chosenFields.confidence = 0.35;
    } else {
      chosenFields.confidence = 0.85;
    }
    if (!chosenFields.fraudSignals) chosenFields.fraudSignals = [];

    // Generate multiple DPO pairs per golden entry (different degradation strategies)
    const strategiesPerEntry = 3;
    for (let i = 0; i < strategiesPerEntry; i++) {
      const pair = buildDPOPair(systemPrompt, userPrompt, chosenFields, 'golden');
      if (pair) pairs.push(pair);
    }
  }

  console.log(`  Generated ${pairs.length} golden DPO pairs`);
  return pairs;
}

// --- Step 2: Generate preference pairs from training data ---

async function loadTrainingPairs(maxPairs: number): Promise<DPOPair[]> {
  console.log('  Loading training data pairs...');
  const pairs: DPOPair[] = [];

  const trainFile = resolve(TRAINING_DIR, 'finetune-server-8b.jsonl');
  if (!existsSync(trainFile)) {
    console.log(`  Training file not found: ${trainFile}`);
    return pairs;
  }

  const rl = createInterface({
    input: createReadStream(trainFile, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  let processed = 0;

  for await (const line of rl) {
    if (!line.trim() || pairs.length >= maxPairs) break;
    processed++;

    try {
      const obj = JSON.parse(line);
      const messages = obj.messages;
      if (!messages || messages.length < 3) continue;

      const systemPrompt = messages[0].content;
      const userPrompt = messages[1].content;
      const chosenFields = JSON.parse(messages[2].content);

      const pair = buildDPOPair(systemPrompt, userPrompt, chosenFields, 'training');
      if (pair) pairs.push(pair);
    } catch {
      // Skip malformed
    }

    if (processed % 10000 === 0) {
      console.log(`  Processed ${processed} training examples, ${pairs.length} pairs`);
    }
  }

  console.log(`  Generated ${pairs.length} training DPO pairs`);
  return pairs;
}

// --- Step 3: Write and upload ---

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const startTime = Date.now();

  console.log('=== Nessie DPO Training Pipeline ===');
  console.log(`Date:         ${new Date().toISOString()}`);
  console.log(`Source:       ${SOURCE}`);
  console.log(`Max pairs:    ${MAX_PAIRS}`);
  console.log(`Base model:   ${BASE_MODEL}`);
  console.log(`Epochs:       ${EPOCHS}`);
  console.log(`LR:           ${LEARNING_RATE}`);
  console.log(`Dry run:      ${DRY_RUN}`);

  mkdirSync(DPO_DIR, { recursive: true });

  // Step 1: Generate preference pairs
  console.log('\n--- Step 1: Generate preference pairs ---');

  let allPairs: DPOPair[] = [];

  if (SOURCE === 'golden' || SOURCE === 'both') {
    const goldenPairs = await loadGoldenPairs();
    allPairs.push(...goldenPairs);
  }

  if (SOURCE === 'training' || SOURCE === 'both') {
    const remaining = MAX_PAIRS - allPairs.length;
    if (remaining > 0) {
      const trainingPairs = await loadTrainingPairs(remaining);
      allPairs.push(...trainingPairs);
    }
  }

  // Shuffle
  for (let i = allPairs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allPairs[i], allPairs[j]] = [allPairs[j], allPairs[i]];
  }

  // Cap at max
  if (allPairs.length > MAX_PAIRS) {
    allPairs = allPairs.slice(0, MAX_PAIRS);
  }

  console.log(`\nTotal DPO pairs: ${allPairs.length}`);

  // Strategy distribution
  const stratStats: Record<string, number> = {};
  const typeStats: Record<string, number> = {};
  const sourceStats: Record<string, number> = {};
  for (const pair of allPairs) {
    if (pair._meta) {
      stratStats[pair._meta.strategy] = (stratStats[pair._meta.strategy] || 0) + 1;
      typeStats[pair._meta.credentialType] = (typeStats[pair._meta.credentialType] || 0) + 1;
      sourceStats[pair._meta.source] = (sourceStats[pair._meta.source] || 0) + 1;
    }
  }

  console.log('\nStrategy distribution:');
  for (const [strat, count] of Object.entries(stratStats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${strat}: ${count} (${((count / allPairs.length) * 100).toFixed(1)}%)`);
  }

  console.log('\nCredential type distribution:');
  for (const [type, count] of Object.entries(typeStats).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${type}: ${count}`);
  }

  console.log('\nSource distribution:');
  for (const [src, count] of Object.entries(sourceStats)) {
    console.log(`  ${src}: ${count}`);
  }

  // Step 2: Write DPO file
  console.log('\n--- Step 2: Write DPO training file ---');

  // Remove _meta before writing (not part of training format)
  const cleanPairs = allPairs.map(({ prompt, chosen, rejected }) => ({ prompt, chosen, rejected }));

  // 90/10 split
  const valSize = Math.max(Math.floor(cleanPairs.length * 0.1), 10);
  const valPairs = cleanPairs.slice(0, valSize);
  const trainPairs = cleanPairs.slice(valSize);

  const trainFile = resolve(DPO_DIR, 'dpo-train.jsonl');
  const valFile = resolve(DPO_DIR, 'dpo-validation.jsonl');

  writeFileSync(trainFile, trainPairs.map((p) => JSON.stringify(p)).join('\n') + '\n');
  writeFileSync(valFile, valPairs.map((p) => JSON.stringify(p)).join('\n') + '\n');

  console.log(`Train: ${trainPairs.length} pairs -> ${trainFile}`);
  console.log(`Val:   ${valPairs.length} pairs -> ${valFile}`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Skipping upload and training');
    console.log('\nSample preference pair:');
    const sample = allPairs[0];
    console.log(`  Strategy: ${sample._meta?.strategy}`);
    console.log(`  Type: ${sample._meta?.credentialType}`);
    console.log(`  Chosen (first 200): ${sample.chosen[0]?.content.slice(0, 200)}`);
    console.log(`  Rejected (first 200): ${sample.rejected[0]?.content.slice(0, 200)}`);
    return;
  }

  // Step 3: Upload to Together AI
  console.log('\n--- Step 3: Upload and launch DPO training ---');

  if (!TOGETHER_API_KEY) {
    throw new Error('TOGETHER_API_KEY required');
  }

  const content = readFileSync(trainFile, 'utf-8');

  const formData = new FormData();
  formData.append(
    'file',
    new Blob([content], { type: 'application/jsonl' }),
    'dpo-training.jsonl',
  );
  formData.append('file_name', 'arkova-nessie-dpo-training.jsonl');
  formData.append('purpose', 'fine-tune');

  const uploadRes = await fetch(`${TOGETHER_BASE_URL}/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOGETHER_API_KEY}` },
    body: formData,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Upload failed: ${uploadRes.status} ${err}`);
  }

  const uploadData = (await uploadRes.json()) as { id: string };
  console.log(`File uploaded: ${uploadData.id}`);

  // Launch DPO fine-tune
  const ftRes = await fetch(`${TOGETHER_BASE_URL}/fine-tunes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOGETHER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      training_file: uploadData.id,
      model: BASE_MODEL,
      n_epochs: EPOCHS,
      n_checkpoints: Math.min(EPOCHS, 3),
      learning_rate: LEARNING_RATE,
      batch_size: 8,
      suffix: 'arkova-nessie-dpo-v1',
      training_method: {
        method: 'dpo',
      },
    }),
  });

  if (!ftRes.ok) {
    const err = await ftRes.text();
    throw new Error(`DPO fine-tune creation failed: ${ftRes.status} ${err}`);
  }

  const ftData = (await ftRes.json()) as { id: string; status: string; model_output_name: string };
  console.log(`DPO job created: ${ftData.id}`);
  console.log(`Status: ${ftData.status}`);
  console.log(`Output model: ${ftData.model_output_name}`);

  // Step 4: Poll for completion
  console.log('\n--- Step 4: Polling for completion ---');

  const POLL_INTERVAL = 60_000;
  const MAX_POLLS = 360; // 6 hours

  for (let i = 0; i < MAX_POLLS; i++) {
    await delay(POLL_INTERVAL);

    try {
      const res = await fetch(`${TOGETHER_BASE_URL}/fine-tunes/${ftData.id}`, {
        headers: { Authorization: `Bearer ${TOGETHER_API_KEY}` },
      });

      if (!res.ok) continue;

      const data = (await res.json()) as { status: string };

      if (i % 5 === 0 || data.status !== 'running') {
        console.log(`  [${Math.floor((i * POLL_INTERVAL) / 60000)}min] Status: ${data.status}`);
      }

      if (data.status === 'completed' || data.status === 'succeeded') {
        const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
        console.log('\n========================================');
        console.log('     Nessie DPO Training Complete!       ');
        console.log('========================================\n');
        console.log(`Total pairs:    ${allPairs.length}`);
        console.log(`Train/Val:      ${trainPairs.length} / ${valPairs.length}`);
        console.log(`Job ID:         ${ftData.id}`);
        console.log(`Output model:   ${ftData.model_output_name}`);
        console.log(`Base model:     ${BASE_MODEL}`);
        console.log(`Time:           ${elapsed} min`);
        console.log(`\nStrategies used:`);
        for (const [strat, count] of Object.entries(stratStats).sort((a, b) => b[1] - a[1])) {
          console.log(`  ${strat}: ${count}`);
        }
        console.log('\nNext steps:');
        console.log('  1. Evaluate DPO model against holdout set');
        console.log('  2. Compare citation accuracy: base SFT vs DPO');
        console.log('  3. Update NESSIE_MODEL env var if DPO improves quality');
        console.log('  4. Deploy to RunPod');
        return;
      }

      if (data.status === 'failed' || data.status === 'cancelled' || data.status === 'error') {
        throw new Error(`DPO job ${data.status}`);
      }
    } catch (err) {
      if (err instanceof Error && (err.message.includes('DPO job') || err.message.includes('failed'))) throw err;
      console.log(`  Poll error: ${err instanceof Error ? err.message : err}`);
    }
  }

  throw new Error('DPO training timed out after 6 hours');
}

main().catch((err) => {
  console.error('\nDPO PIPELINE FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});

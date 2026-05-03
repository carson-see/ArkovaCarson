#!/usr/bin/env tsx
/**
 * Build a single-domain training dataset from the golden dataset.
 *
 * Conforms to docs/plans/nessie-training-parameters-v1.md:
 *   - JSON output, ExtractedFieldsSchema-validated
 *   - System prompt = NESSIE_CONDENSED_PROMPT (the prompt v5 was trained with;
 *     production worker uses it too — Best Practices §7.2)
 *   - 80/20 train/test split, deterministic by entry ID
 *   - Test entries listed separately so they're never trained on
 *
 * Usage:
 *   npx tsx scripts/build-domain-dataset.ts DEGREE
 *   npx tsx scripts/build-domain-dataset.ts CLE
 *
 * Output:
 *   training-output/nessie-<domain>-v1-train.jsonl
 *   training-output/nessie-<domain>-v1-test.jsonl
 *   training-output/nessie-<domain>-v1.manifest.json
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { FULL_GOLDEN_DATASET } from '../src/ai/eval/golden-dataset.js';
import { NESSIE_CONDENSED_PROMPT } from '../src/ai/prompts/nessie-condensed.js';
import { ExtractedFieldsSchema } from '../src/ai/schemas.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TARGET_DOMAIN = (process.argv[2] || 'DEGREE').toUpperCase();

if (!TARGET_DOMAIN) {
  console.error('Usage: build-domain-dataset.ts <CREDENTIAL_TYPE>');
  process.exit(1);
}

console.log(`\n📚 Building ${TARGET_DOMAIN}-only Nessie training dataset...`);

// Filter golden dataset to the target domain
const domainEntries = FULL_GOLDEN_DATASET.filter(
  (e) => (e.groundTruth.credentialType || e.credentialTypeHint) === TARGET_DOMAIN,
);

console.log(`   Found ${domainEntries.length} entries with credentialType=${TARGET_DOMAIN}`);

if (domainEntries.length < 30) {
  console.error(`   ❌ Need at least 30 entries; only have ${domainEntries.length}. Aborting.`);
  process.exit(1);
}

// Validate every entry's groundTruth against the schema
let validCount = 0;
let invalidCount = 0;
const validEntries: typeof domainEntries = [];
for (const entry of domainEntries) {
  const parsed = ExtractedFieldsSchema.safeParse(entry.groundTruth);
  if (parsed.success) {
    validCount++;
    validEntries.push(entry);
  } else {
    invalidCount++;
    console.warn(`   ⚠️  ${entry.id}: schema validation failed — ${parsed.error.issues[0]?.message}`);
  }
}
console.log(`   Validated: ${validCount} pass, ${invalidCount} fail`);

if (validEntries.length < 30) {
  console.error(`   ❌ After validation, only ${validEntries.length} valid entries. Aborting.`);
  process.exit(1);
}

// Deterministic 80/20 split by sorted entry ID — same split every run
validEntries.sort((a, b) => a.id.localeCompare(b.id));
const trainEntries: typeof validEntries = [];
const testEntries: typeof validEntries = [];
validEntries.forEach((entry, idx) => {
  // Every 5th entry → test (gives ~20% holdout, evenly spread)
  if (idx % 5 === 4) {
    testEntries.push(entry);
  } else {
    trainEntries.push(entry);
  }
});

console.log(`   Split: ${trainEntries.length} train / ${testEntries.length} test`);

// Build Together-format JSONL
function buildExample(entry: (typeof validEntries)[0]) {
  // Build a confidence value tied to dataset richness — discourages overconfidence
  // Hand-curated entries: 0.92; auto-generated: 0.85; if missing several fields: 0.75
  const fieldCount = Object.keys(entry.groundTruth).filter(
    (k) => k !== 'fraudSignals' && entry.groundTruth[k as keyof typeof entry.groundTruth] != null,
  ).length;
  let confidence = 0.92;
  if (entry.tags?.includes('synthetic')) confidence = 0.85;
  if (fieldCount <= 3) confidence = 0.75;

  const assistantPayload = {
    ...entry.groundTruth,
    confidence,
  };

  return {
    messages: [
      { role: 'system', content: NESSIE_CONDENSED_PROMPT },
      {
        role: 'user',
        content: `Extract credential metadata from the following PII-stripped text:\n\n${entry.strippedText}`,
      },
      { role: 'assistant', content: JSON.stringify(assistantPayload) },
    ],
  };
}

// Verify each line will be re-parseable (the assistant string must be valid JSON
// and round-trip through the schema)
function verifyLine(line: { messages: { role: string; content: string }[] }) {
  const assistantContent = line.messages[2].content;
  const parsed = JSON.parse(assistantContent);
  const { confidence: _, ...fields } = parsed;
  const validated = ExtractedFieldsSchema.safeParse(fields);
  if (!validated.success) throw new Error(`Round-trip schema fail`);
  if (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 1) {
    throw new Error(`Invalid confidence: ${parsed.confidence}`);
  }
}

// Output
const outDir = resolve(__dirname, '..', 'training-output');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const lowerDomain = TARGET_DOMAIN.toLowerCase();
const trainPath = resolve(outDir, `nessie-${lowerDomain}-v1-train.jsonl`);
const testPath = resolve(outDir, `nessie-${lowerDomain}-v1-test.jsonl`);
const manifestPath = resolve(outDir, `nessie-${lowerDomain}-v1.manifest.json`);

const trainLines: string[] = [];
for (const entry of trainEntries) {
  const line = buildExample(entry);
  verifyLine(line);
  trainLines.push(JSON.stringify(line));
}

const testLines: string[] = [];
for (const entry of testEntries) {
  const line = buildExample(entry);
  verifyLine(line);
  testLines.push(JSON.stringify(line));
}

writeFileSync(trainPath, trainLines.join('\n') + '\n', 'utf-8');
writeFileSync(testPath, testLines.join('\n') + '\n', 'utf-8');

const manifest = {
  domain: TARGET_DOMAIN,
  version: 'v1',
  builtAt: new Date().toISOString(),
  systemPromptHash: crypto
    .createHash('sha256')
    .update(NESSIE_CONDENSED_PROMPT)
    .digest('hex')
    .substring(0, 16),
  totals: {
    candidate: domainEntries.length,
    valid: validEntries.length,
    train: trainEntries.length,
    test: testEntries.length,
  },
  trainIds: trainEntries.map((e) => e.id),
  testIds: testEntries.map((e) => e.id),
  paths: {
    train: trainPath,
    test: testPath,
  },
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

console.log(`\n✅ Wrote:`);
console.log(`   ${trainPath}  (${trainLines.length} lines)`);
console.log(`   ${testPath}   (${testLines.length} lines)`);
console.log(`   ${manifestPath}`);
console.log(`\n   Next step: validate then upload to Together`);
console.log(`   $ npx tsx scripts/validate-training-jsonl.ts ${trainPath}`);
console.log(`   $ together files upload ${trainPath}`);

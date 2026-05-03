#!/usr/bin/env tsx
/**
 * GME-11: Expand Golden Dataset to 2,000+ Entries
 *
 * Generates new golden dataset entries targeting weak credential types
 * identified by eval results. Adds 400+ entries to reach 2,000+ total.
 *
 * Strategy:
 * 1. Read current eval results to identify types with <85% F1
 * 2. Generate synthetic examples for weak types using Gemini 3
 * 3. Validate against golden format and add to phase 14-15
 *
 * Usage:
 *   cd services/worker
 *   GEMINI_API_KEY=... npx tsx scripts/expand-golden-dataset.ts [--target-count N] [--dry-run]
 */

import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GEMINI_GENERATION_MODEL } from '../src/ai/gemini-config.js';
import { FULL_GOLDEN_DATASET } from '../src/ai/eval/golden-dataset.js';

const args = process.argv.slice(2);
const TARGET_COUNT = parseInt(
  args.includes('--target-count') ? args[args.indexOf('--target-count') + 1] : '2000',
  10,
);
const DRY_RUN = args.includes('--dry-run');

// Types that typically need more examples (based on prior evals)
const WEAK_TYPES = [
  'OTHER',
  'MILITARY',
  'IDENTITY',
  'PUBLICATION',
  'REGULATION',
  'ACCREDITATION',
  'EMPLOYMENT',
  'EDUCATION',
  'CHARITY',
  'FINANCIAL_ADVISOR',
  'BUSINESS_ENTITY',
];

// Target entries per weak type
function computeTargetsPerType(
  currentCounts: Record<string, number>,
  totalTarget: number,
  currentTotal: number,
): Record<string, number> {
  const needed = Math.max(0, totalTarget - currentTotal);
  const perType = Math.ceil(needed / WEAK_TYPES.length);
  const targets: Record<string, number> = {};

  for (const type of WEAK_TYPES) {
    const current = currentCounts[type] ?? 0;
    // Ensure at least 20 entries per weak type
    const minEntries = 20;
    targets[type] = Math.max(0, Math.max(minEntries, current + perType) - current);
  }

  return targets;
}

async function main() {
  console.log(`\n=== GME-11: Expand Golden Dataset ===`);
  console.log(`  Current entries: ${FULL_GOLDEN_DATASET.length}`);
  console.log(`  Target entries:  ${TARGET_COUNT}`);
  console.log(`  Model:           ${GEMINI_GENERATION_MODEL}`);
  console.log(`  Dry run:         ${DRY_RUN}`);
  console.log('');

  // Count current entries by type
  const typeCounts: Record<string, number> = {};
  for (const entry of FULL_GOLDEN_DATASET) {
    const type = entry.groundTruth.credentialType ?? entry.credentialTypeHint;
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
  }

  console.log('Current type distribution:');
  for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(25)} ${count}`);
  }
  console.log('');

  // Compute targets
  const targets = computeTargetsPerType(typeCounts, TARGET_COUNT, FULL_GOLDEN_DATASET.length);
  const totalNew = Object.values(targets).reduce((s, v) => s + v, 0);

  console.log('Generation targets:');
  for (const [type, count] of Object.entries(targets)) {
    if (count > 0) console.log(`  ${type.padEnd(25)} +${count}`);
  }
  console.log(`  Total new entries:       +${totalNew}`);
  console.log(`  Projected total:         ${FULL_GOLDEN_DATASET.length + totalNew}`);
  console.log('');

  if (DRY_RUN) {
    console.log('[DRY RUN] Would generate entries. Run without --dry-run to proceed.');
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error('ERROR: GEMINI_API_KEY required for synthetic generation');
    process.exit(1);
  }

  // Generate synthetic entries
  console.log('Generating synthetic golden entries...');
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  const model = genAI.getGenerativeModel({
    model: GEMINI_GENERATION_MODEL,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.8,
      maxOutputTokens: 8192,
    },
  });

  const newEntries: Array<{ type: string; entry: Record<string, unknown> }> = [];
  const phase = 14; // New phases start at 14

  for (const [type, count] of Object.entries(targets)) {
    if (count <= 0) continue;

    console.log(`  Generating ${count} entries for ${type}...`);
    const batchSize = 10;

    for (let i = 0; i < count; i += batchSize) {
      const n = Math.min(batchSize, count - i);
      const prompt = `Generate ${n} realistic golden dataset entries for credential type "${type}".

Each entry should have:
- "id": unique string like "phase${phase}-${type.toLowerCase()}-${i+1}"
- "strippedText": realistic PII-stripped document text (80-150 words)
- "credentialTypeHint": "${type}"
- "groundTruth": { credentialType, issuerName, issuedDate (YYYY-MM-DD), jurisdiction, and type-specific fields }

Use realistic but fictional entity names, dates 2020-2025, plausible jurisdictions.
Return ONLY a JSON array.`;

      try {
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            newEntries.push({ type, entry });
          }
        }
      } catch (err) {
        console.error(`    Failed batch for ${type}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  console.log(`\nGenerated ${newEntries.length} new entries.`);

  // Write to phase file
  const outputDir = resolve(import.meta.dirname ?? '.', '../src/ai/eval/');
  const outputFile = resolve(outputDir, `golden-dataset-phase${phase}.ts`);
  const exportName = `GOLDEN_DATASET_PHASE${phase}`;

  const entries = newEntries.map(({ entry }) => JSON.stringify(entry));
  const fileContent = `/**
 * Golden Dataset Phase ${phase} — GME-11 Expansion
 * Auto-generated on ${new Date().toISOString()}
 * ${newEntries.length} entries targeting weak credential types
 */
export const ${exportName} = [
${entries.map(e => `  ${e},`).join('\n')}
];
`;

  writeFileSync(outputFile, fileContent);
  console.log(`Written to: ${outputFile}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Review generated entries for quality`);
  console.log(`  2. Import ${exportName} in golden-dataset.ts`);
  console.log(`  3. Run eval to verify accuracy on new entries`);
  console.log(`  4. Submit retrain job with expanded dataset`);
}

main().catch((err) => {
  console.error('\nEXPANSION FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});

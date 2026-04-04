#!/usr/bin/env tsx
/**
 * Generate DPO preference pairs from existing SFT training data.
 * Usage: cd services/worker && npx tsx scripts/generate-dpo-pairs.ts
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateDPOPairsFromSFT, dpoPairsToJSONL, validateDPOPair, getDPOStats } from '../src/ai/training/nessie-dpo-data.js';

const INTEL_DIR = resolve(import.meta.dirname ?? '.', '../training-data/intelligence');
const DPO_DIR = resolve(import.meta.dirname ?? '.', '../training-data/dpo');

// Find the latest intelligence training file
const trainFiles = readdirSync(INTEL_DIR)
  .filter((f) => f.startsWith('intelligence-train-') && f.endsWith('.jsonl'))
  .sort()
  .reverse();

if (trainFiles.length === 0) {
  console.error('No intelligence training files found. Run nessie-intelligence-distill.ts first.');
  process.exit(1);
}

const trainFile = resolve(INTEL_DIR, trainFiles[0]);
console.log('Loading SFT data:', trainFile);

const lines = readFileSync(trainFile, 'utf-8').trim().split('\n');
const sftExamples = lines.map((l) => JSON.parse(l) as { messages: Array<{ role: string; content: string }> });
console.log('SFT examples:', sftExamples.length);

// Generate DPO pairs
const pairs = generateDPOPairsFromSFT(sftExamples);
console.log('DPO pairs generated:', pairs.length);

// Validate
let valid = 0;
let invalid = 0;
const validPairs = pairs.filter((p) => {
  const err = validateDPOPair(p);
  if (err) { invalid++; return false; }
  valid++;
  return true;
});
console.log(`Valid: ${valid}, Invalid: ${invalid}`);

// Stats
const stats = getDPOStats(validPairs);
console.log('Strategy distribution:');
for (const [s, c] of Object.entries(stats)) {
  console.log(`  ${s}: ${c}`);
}

// Export
mkdirSync(DPO_DIR, { recursive: true });
const jsonl = dpoPairsToJSONL(validPairs);
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outFile = resolve(DPO_DIR, `nessie-dpo-${timestamp}.jsonl`);
writeFileSync(outFile, jsonl);
console.log(`Written: ${outFile} (${validPairs.length} pairs, ${(jsonl.length / 1024).toFixed(1)} KB)`);

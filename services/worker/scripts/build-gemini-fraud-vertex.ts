#!/usr/bin/env tsx
/**
 * Build Gemini fraud tuning dataset in Vertex AI format.
 *
 * Conforms to docs/plans/gemini-training-parameters-v1.md.
 *
 * Output: training-output/gemini-fraud-v1-vertex.jsonl
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { FRAUD_TRAINING_SEED, FRAUD_SYSTEM_PROMPT } from '../src/ai/eval/fraud-training-seed.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('\n🔍 Building Gemini fraud tuning dataset (Vertex format)...');
console.log(`   Seed entries: ${FRAUD_TRAINING_SEED.length}`);

// Vertex AI tuning format:
// { "systemInstruction": {...}, "contents": [{role:"user"}, {role:"model"}] }

const lines: string[] = [];
for (const entry of FRAUD_TRAINING_SEED) {
  const userInput = JSON.stringify(entry.extractedFields, null, 2);
  const modelOutput = JSON.stringify(entry.expectedOutput, null, 2);
  const example = {
    systemInstruction: {
      role: 'system',
      parts: [{ text: FRAUD_SYSTEM_PROMPT }],
    },
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `Analyze the following extracted credential metadata for fraud signals:\n\n${userInput}`,
          },
        ],
      },
      {
        role: 'model',
        parts: [{ text: modelOutput }],
      },
    ],
  };
  lines.push(JSON.stringify(example));
}

const outDir = resolve(__dirname, '..', 'training-output');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, 'gemini-fraud-v1-vertex.jsonl');
writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8');

console.log(`\n✅ Wrote ${lines.length} examples to:`);
console.log(`   ${outPath}`);
console.log(`\n   Next steps:`);
console.log(`   $ gsutil cp ${outPath} gs://arkova-training-data/gemini-fraud-v1.jsonl`);
console.log(`   $ gcloud ai supervised-tuning create \\`);
console.log(`       --project=arkova1 --region=us-central1 \\`);
console.log(`       --source-model=gemini-2.5-pro \\`);
console.log(`       --tuned-model-display-name=arkova-gemini-fraud-v1 \\`);
console.log(`       --training-dataset-uri=gs://arkova-training-data/gemini-fraud-v1.jsonl \\`);
console.log(`       --epoch-count=5`);

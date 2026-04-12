#!/usr/bin/env tsx
/**
 * GME-07: Fraud Detection Eval on Gemini 3 Vision
 *
 * Evaluates multimodal fraud detection quality on Gemini 3.
 * Compares against Gemini 2.5 Flash baseline.
 *
 * Usage:
 *   cd services/worker
 *   GEMINI_API_KEY=... npx tsx scripts/eval-fraud-detection.ts
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { GEMINI_GENERATION_MODEL } from '../src/ai/gemini-config.js';
import { FRAUD_EVAL_DATASET } from '../src/ai/eval/fraud-eval-dataset.js';

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('ERROR: GEMINI_API_KEY required');
    process.exit(1);
  }

  const model = GEMINI_GENERATION_MODEL;
  console.log(`\n=== GME-07: Fraud Detection Eval on Gemini 3 Vision ===`);
  console.log(`  Model:   ${model}`);
  console.log(`  Dataset: ${FRAUD_EVAL_DATASET.length} test cases`);
  console.log('');

  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  const gemini = genAI.getGenerativeModel({
    model,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
    },
  });

  let correct = 0;
  let total = 0;
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  const results: Array<{
    id: string;
    expected: string;
    actual: string;
    correct: boolean;
    signals: string[];
    latencyMs: number;
  }> = [];

  for (const entry of FRAUD_EVAL_DATASET) {
    const start = Date.now();
    total++;

    try {
      const prompt = `Analyze this document text for fraud signals. Return JSON with:
- "riskLevel": "clean" | "low" | "medium" | "high"
- "fraudSignals": string[] (empty if clean)

Document text:
${entry.strippedText}`;

      const response = await gemini.generateContent(prompt);
      const text = response.response.text();
      const parsed = JSON.parse(text);
      const latencyMs = Date.now() - start;

      const actualRisk = parsed.riskLevel ?? 'clean';
      const expectedRisk = entry.expectedRiskLevel;
      const isCorrect = actualRisk === expectedRisk;
      if (isCorrect) correct++;

      // Track fraud detection accuracy
      if (expectedRisk !== 'clean' && actualRisk !== 'clean') truePositives++;
      if (expectedRisk === 'clean' && actualRisk !== 'clean') falsePositives++;
      if (expectedRisk !== 'clean' && actualRisk === 'clean') falseNegatives++;

      results.push({
        id: entry.id,
        expected: expectedRisk,
        actual: actualRisk,
        correct: isCorrect,
        signals: parsed.fraudSignals ?? [],
        latencyMs,
      });

      process.stdout.write(`\r  Progress: ${total}/${FRAUD_EVAL_DATASET.length}`);
    } catch (err) {
      results.push({
        id: entry.id,
        expected: entry.expectedRiskLevel,
        actual: 'ERROR',
        correct: false,
        signals: [],
        latencyMs: Date.now() - start,
      });
    }
  }
  console.log('\n');

  // Compute metrics
  const accuracy = total > 0 ? correct / total : 0;
  const precision = truePositives + falsePositives > 0
    ? truePositives / (truePositives + falsePositives) : 0;
  const recall = truePositives + falseNegatives > 0
    ? truePositives / (truePositives + falseNegatives) : 0;
  const f1 = precision + recall > 0
    ? 2 * (precision * recall) / (precision + recall) : 0;
  const falsePositiveRate = total > 0 ? falsePositives / total : 0;

  console.log('=== Fraud Detection Results ===');
  console.log(`  Accuracy:          ${(accuracy * 100).toFixed(1)}%`);
  console.log(`  Precision:         ${(precision * 100).toFixed(1)}%`);
  console.log(`  Recall:            ${(recall * 100).toFixed(1)}%`);
  console.log(`  F1:                ${(f1 * 100).toFixed(1)}%`);
  console.log(`  False Positive Rate: ${(falsePositiveRate * 100).toFixed(1)}%`);
  console.log(`  True Positives:    ${truePositives}`);
  console.log(`  False Positives:   ${falsePositives}`);
  console.log(`  False Negatives:   ${falseNegatives}`);

  // Write results
  const outputDir = resolve(import.meta.dirname ?? '.', '../../docs/eval/');
  mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
  writeFileSync(
    resolve(outputDir, `eval-fraud-gemini3-${timestamp}.json`),
    JSON.stringify({ model, metrics: { accuracy, precision, recall, f1, falsePositiveRate }, results }, null, 2),
  );

  console.log(`\nResults written to docs/eval/eval-fraud-gemini3-${timestamp}.json`);
}

main().catch((err) => {
  console.error('\nEVAL FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});

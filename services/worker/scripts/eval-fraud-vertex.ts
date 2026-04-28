#!/usr/bin/env tsx
/**
 * SCRUM-1467 / GME2-01: Fraud Detection Eval against tuned Vertex Gemini.
 *
 * Calls the Vertex-deployed tuned Gemini endpoint via REST :generateContent
 * with the same prompt shape used during supervised tuning. Computes
 * precision / recall / F1 / FP-rate against the held-out FRAUD_EVAL_DATASET
 * (disjoint from the 100-entry training seed in fraud-training-seed.ts).
 *
 * Usage:
 *   cd services/worker
 *   gcloud auth print-access-token | TUNED_ENDPOINT_ID=3265514899878445056 \
 *     PROJECT_ID=arkova1 npx tsx scripts/eval-fraud-vertex.ts
 *
 * DoD per SCRUM-792: F1 >= 60%, FP rate <= 5%.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { FRAUD_TRAINING_SEED, FRAUD_SYSTEM_PROMPT } from '../src/ai/eval/fraud-training-seed.js';
import { FRAUD_HOLDOUT_SET } from '../src/ai/eval/fraud-holdout-set.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ID = process.env.PROJECT_ID || 'arkova1';
const REGION = process.env.REGION || 'us-central1';
const ENDPOINT_ID = process.env.TUNED_ENDPOINT_ID || '3265514899878445056';
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY || 4);

interface VertexResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: { code: number; message: string };
}

interface ModelOutput {
  fraudSignals?: string[];
  confidence?: number;
  reasoning?: string;
}

interface Result {
  id: string;
  category: string;
  expectedSignals: string[];
  expectedTampered: boolean;
  predictedSignals: string[];
  predictedTampered: boolean;
  predictedConfidence: number | null;
  expectedConfidence: number;
  correct: boolean;
  latencyMs: number;
  raw?: string;
  error?: string;
}

function getAccessToken(): string {
  const t = execSync('gcloud auth print-access-token', { encoding: 'utf-8' }).trim();
  if (!t) throw new Error('gcloud auth print-access-token returned empty');
  return t;
}

async function callVertex(token: string, userText: string): Promise<{ text: string | null; error?: string }> {
  const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/endpoints/${ENDPOINT_ID}:generateContent`;
  const body = {
    systemInstruction: {
      parts: [{ text: FRAUD_SYSTEM_PROMPT }],
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: userText }],
      },
    ],
    generationConfig: {
      // responseMimeType:'application/json' was truncating output on the
      // tuned endpoint after the opening `{`. Letting the model emit
      // free-form text and parsing JSON with a regex fallback works
      // around the issue.
      temperature: 0.1,
      maxOutputTokens: 1024,
    },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    return { text: null, error: `HTTP ${resp.status} ${await resp.text()}` };
  }
  const data = (await resp.json()) as VertexResponse;
  if (data.error) return { text: null, error: `${data.error.code} ${data.error.message}` };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  return { text };
}

function parseModelOutput(raw: string | null): ModelOutput | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ModelOutput;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as ModelOutput;
    } catch {
      return null;
    }
  }
}

async function evalOne(token: string, entry: typeof FRAUD_TRAINING_SEED[number]): Promise<Result> {
  const start = Date.now();
  const userInput = JSON.stringify(entry.extractedFields, null, 2);
  const userText = `Analyze the following extracted credential metadata for fraud signals:\n\n${userInput}`;
  const { text, error } = await callVertex(token, userText);
  const latencyMs = Date.now() - start;
  const expectedSignals = entry.expectedOutput.fraudSignals;
  const expectedTampered = expectedSignals.length > 0;
  if (error || !text) {
    return {
      id: entry.id,
      category: entry.category,
      expectedSignals,
      expectedTampered,
      predictedSignals: [],
      predictedTampered: false,
      predictedConfidence: null,
      expectedConfidence: entry.expectedOutput.confidence,
      correct: false,
      latencyMs,
      error: error || 'no text',
    };
  }
  const parsed = parseModelOutput(text);
  const predictedSignals = parsed?.fraudSignals ?? [];
  const predictedTampered = predictedSignals.length > 0;
  return {
    id: entry.id,
    category: entry.category,
    expectedSignals,
    expectedTampered,
    predictedSignals,
    predictedTampered,
    predictedConfidence: parsed?.confidence ?? null,
    expectedConfidence: entry.expectedOutput.confidence,
    correct: expectedTampered === predictedTampered,
    latencyMs,
    raw: text.slice(0, 600),
  };
}

async function pool<T, U>(items: T[], n: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
      process.stdout.write(`\r  progress: ${idx}/${items.length}`);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  // EVAL_MODE controls which dataset:
  //   "holdout" (default) → FRAUD_HOLDOUT_SET (20 disjoint entries; true generalization)
  //   "train"             → FRAUD_TRAINING_SEED (100 entries; memorization floor)
  // The DoD gate (F1 ≥ 60%, FP ≤ 5%) is a generalization claim and only
  // produces PASS/FAIL in holdout mode. Train mode prints metrics labelled
  // "memorization floor" and emits verdict `MEMORIZATION_FLOOR` so a
  // passing train-mode F1 is never confused for a passing DoD.
  const mode = (process.env.EVAL_MODE || 'holdout').toLowerCase();
  const dataset = mode === 'train' ? FRAUD_TRAINING_SEED : FRAUD_HOLDOUT_SET;
  const datasetLabel = mode === 'train' ? 'training seed (memorization floor)' : 'held-out set (true generalization)';
  console.log(`\n=== SCRUM-1467 / GME2-01 fraud eval against Vertex tuned Gemini ===`);
  console.log(`  Endpoint:   ${ENDPOINT_ID}`);
  console.log(`  Project:    ${PROJECT_ID}`);
  console.log(`  Region:     ${REGION}`);
  console.log(`  Mode:       ${mode}`);
  console.log(`  Dataset:    ${dataset.length} entries (${datasetLabel})`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log('');

  const token = getAccessToken();
  const results = await pool<typeof FRAUD_TRAINING_SEED[number], Result>(dataset, CONCURRENCY, e => evalOne(token, e));
  console.log('\n');

  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let trueNegatives = 0;
  let errors = 0;
  for (const r of results) {
    if (r.error) errors++;
    if (r.expectedTampered && r.predictedTampered) truePositives++;
    else if (!r.expectedTampered && r.predictedTampered) falsePositives++;
    else if (r.expectedTampered && !r.predictedTampered) falseNegatives++;
    else if (!r.expectedTampered && !r.predictedTampered) trueNegatives++;
  }

  const total = results.length;
  const accuracy = total > 0 ? (truePositives + trueNegatives) / total : 0;
  const precision = truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : 0;
  const recall = truePositives + falseNegatives > 0 ? truePositives / (truePositives + falseNegatives) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const cleanCount = results.filter(r => !r.expectedTampered).length;
  const fpRate = cleanCount > 0 ? falsePositives / cleanCount : 0;

  const dodF1 = f1 >= 0.6;
  const dodFp = fpRate <= 0.05;
  const isHoldout = mode === 'holdout';
  const verdict: 'PASS' | 'FAIL' | 'MEMORIZATION_FLOOR' = !isHoldout
    ? 'MEMORIZATION_FLOOR'
    : dodF1 && dodFp
      ? 'PASS'
      : 'FAIL';

  console.log('=== Metrics ===');
  console.log(`  Accuracy:        ${(accuracy * 100).toFixed(1)}%`);
  console.log(`  Precision:       ${(precision * 100).toFixed(1)}%`);
  console.log(`  Recall:          ${(recall * 100).toFixed(1)}%`);
  if (isHoldout) {
    console.log(`  F1:              ${(f1 * 100).toFixed(1)}%   (DoD ≥60% ${dodF1 ? 'PASS' : 'FAIL'})`);
    console.log(`  FP rate (of clean): ${(fpRate * 100).toFixed(1)}%   (DoD ≤5% ${dodFp ? 'PASS' : 'FAIL'})`);
  } else {
    console.log(`  F1:              ${(f1 * 100).toFixed(1)}%   (memorization floor — not a DoD gate)`);
    console.log(`  FP rate (of clean): ${(fpRate * 100).toFixed(1)}%   (memorization floor — not a DoD gate)`);
  }
  console.log(`  TP=${truePositives}  FP=${falsePositives}  FN=${falseNegatives}  TN=${trueNegatives}  errors=${errors}`);
  console.log(`  VERDICT: ${verdict}`);

  const outputDir = resolve(__dirname, '..', '..', '..', 'docs', 'eval');
  mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
  // Mode in filename: holdout vs train runs are repeated and need to be
  // distinguishable on disk for trend-tracking.
  const outPath = resolve(outputDir, `eval-fraud-vertex-${mode}-${timestamp}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        endpoint: `projects/${PROJECT_ID}/locations/${REGION}/endpoints/${ENDPOINT_ID}`,
        mode,
        timestamp: new Date().toISOString(),
        metrics: { accuracy, precision, recall, f1, fpRate, truePositives, falsePositives, falseNegatives, trueNegatives, errors },
        verdict,
        dod: isHoldout ? { f1Min: 0.6, fpMax: 0.05, f1Pass: dodF1, fpPass: dodFp } : { note: 'memorization-floor run; DoD gate not applicable' },
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\nResults: ${outPath}`);

  // Only fail process exit on holdout-mode FAIL — train mode never
  // produces a CI-failable verdict.
  if (verdict === 'FAIL') process.exitCode = 1;
}

main().catch(err => {
  console.error('\nEVAL FAILED:', err instanceof Error ? err.stack : err);
  process.exit(1);
});

#!/usr/bin/env tsx
/**
 * GME-16: Latency & Cost Benchmarking — Gemini 3 vs 2.5
 *
 * Benchmarks Gemini 3 on latency (P50/P95/P99), throughput,
 * and cost per extraction/embedding.
 *
 * Usage:
 *   cd services/worker
 *   GEMINI_API_KEY=... npx tsx scripts/eval-latency-benchmark.ts [--requests N]
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { GEMINI_GENERATION_MODEL, GEMINI_EMBEDDING_MODEL } from '../src/ai/gemini-config.js';
import { FULL_GOLDEN_DATASET } from '../src/ai/eval/golden-dataset.js';

const args = process.argv.slice(2);
const requestCount = args.includes('--requests')
  ? parseInt(args[args.indexOf('--requests') + 1], 10)
  : 100;

// Gemini 3 Flash pricing (estimated — update when GA pricing published)
const INPUT_COST_PER_1K = 0.00015;  // $/1K input tokens
const OUTPUT_COST_PER_1K = 0.0006;  // $/1K output tokens

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('ERROR: GEMINI_API_KEY required');
    process.exit(1);
  }

  console.log(`\n=== GME-16: Latency & Cost Benchmarking ===`);
  console.log(`  Generation Model:  ${GEMINI_GENERATION_MODEL}`);
  console.log(`  Embedding Model:   ${GEMINI_EMBEDDING_MODEL}`);
  console.log(`  Requests:          ${requestCount}`);
  console.log('');

  // Sample entries for benchmarking
  const samples = FULL_GOLDEN_DATASET.slice(0, requestCount);

  const { GeminiProvider } = await import('../src/ai/gemini.js');
  const provider = new GeminiProvider();

  // Extraction latency benchmark
  console.log('Running extraction latency benchmark...');
  const extractionLatencies: number[] = [];
  const extractionTokens: Array<{ input: number; output: number }> = [];
  let errors = 0;

  for (let i = 0; i < samples.length; i++) {
    const entry = samples[i];
    const start = Date.now();
    try {
      const result = await provider.extractMetadata({
        strippedText: entry.strippedText,
        credentialType: entry.credentialTypeHint,
        fingerprint: 'a'.repeat(64),
      });
      extractionLatencies.push(Date.now() - start);
      // Estimate token counts from text length (rough)
      const inputTokens = Math.ceil(entry.strippedText.length / 4);
      const outputTokens = result.tokensUsed ? result.tokensUsed - inputTokens : 200;
      extractionTokens.push({ input: Math.max(inputTokens, 0), output: Math.max(outputTokens, 50) });
    } catch {
      errors++;
      extractionLatencies.push(Date.now() - start);
    }
    if ((i + 1) % 10 === 0) {
      process.stdout.write(`\r  Extraction: ${i + 1}/${samples.length}`);
    }
  }
  console.log('');

  // Embedding latency benchmark (10 requests)
  console.log('Running embedding latency benchmark...');
  const embeddingLatencies: number[] = [];
  for (let i = 0; i < Math.min(10, samples.length); i++) {
    const start = Date.now();
    try {
      await provider.generateEmbedding(samples[i].strippedText);
      embeddingLatencies.push(Date.now() - start);
    } catch {
      embeddingLatencies.push(Date.now() - start);
    }
  }

  // Compute percentiles
  const p = (arr: number[], pct: number) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.ceil(pct * sorted.length) - 1] ?? 0;
  };

  // Cost estimates
  const totalInputTokens = extractionTokens.reduce((s, t) => s + t.input, 0);
  const totalOutputTokens = extractionTokens.reduce((s, t) => s + t.output, 0);
  const extractionCost = (totalInputTokens / 1000 * INPUT_COST_PER_1K) + (totalOutputTokens / 1000 * OUTPUT_COST_PER_1K);
  const costPerExtraction = extractionLatencies.length > 0 ? extractionCost / extractionLatencies.length : 0;

  console.log(`\n=== Extraction Latency (${extractionLatencies.length} requests) ===`);
  console.log(`  P50:  ${p(extractionLatencies, 0.5).toFixed(0)}ms`);
  console.log(`  P95:  ${p(extractionLatencies, 0.95).toFixed(0)}ms`);
  console.log(`  P99:  ${p(extractionLatencies, 0.99).toFixed(0)}ms`);
  console.log(`  Mean: ${(extractionLatencies.reduce((a, b) => a + b, 0) / extractionLatencies.length).toFixed(0)}ms`);
  console.log(`  Errors: ${errors}`);
  console.log('');

  console.log(`=== Embedding Latency (${embeddingLatencies.length} requests) ===`);
  console.log(`  P50:  ${p(embeddingLatencies, 0.5).toFixed(0)}ms`);
  console.log(`  P95:  ${p(embeddingLatencies, 0.95).toFixed(0)}ms`);
  console.log(`  Mean: ${(embeddingLatencies.reduce((a, b) => a + b, 0) / embeddingLatencies.length).toFixed(0)}ms`);
  console.log('');

  console.log(`=== Cost Estimates ===`);
  console.log(`  Total tokens: ${totalInputTokens + totalOutputTokens}`);
  console.log(`  Total cost:   $${extractionCost.toFixed(4)}`);
  console.log(`  Per extraction: $${costPerExtraction.toFixed(6)}`);
  console.log('');

  // Throughput
  const totalTimeS = extractionLatencies.reduce((a, b) => a + b, 0) / 1000;
  console.log(`=== Throughput ===`);
  console.log(`  Sequential: ${(extractionLatencies.length / totalTimeS).toFixed(1)} req/s`);
  console.log(`  At 3x concurrency: ~${(3 * extractionLatencies.length / totalTimeS).toFixed(1)} req/s`);

  // Write results
  const outputDir = resolve(import.meta.dirname ?? '.', '../../docs/eval/');
  mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
  writeFileSync(
    resolve(outputDir, `eval-latency-gemini3-${timestamp}.json`),
    JSON.stringify({
      model: GEMINI_GENERATION_MODEL,
      embeddingModel: GEMINI_EMBEDDING_MODEL,
      requestCount: extractionLatencies.length,
      extraction: {
        p50: p(extractionLatencies, 0.5),
        p95: p(extractionLatencies, 0.95),
        p99: p(extractionLatencies, 0.99),
        mean: extractionLatencies.reduce((a, b) => a + b, 0) / extractionLatencies.length,
        errors,
      },
      embedding: {
        p50: p(embeddingLatencies, 0.5),
        p95: p(embeddingLatencies, 0.95),
        mean: embeddingLatencies.reduce((a, b) => a + b, 0) / (embeddingLatencies.length || 1),
      },
      cost: {
        totalTokens: totalInputTokens + totalOutputTokens,
        totalCost: extractionCost,
        perExtraction: costPerExtraction,
      },
    }, null, 2),
  );
  console.log(`\nResults written to docs/eval/`);
}

main().catch((err) => {
  console.error('\nBENCHMARK FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});

#!/usr/bin/env tsx
/**
 * RunPod v5 Deployment & Smoke Test (NMT-09)
 *
 * Updates the RunPod serverless endpoint to serve Nessie v5,
 * then runs a 10-sample smoke test to verify inference works.
 *
 * Usage:
 *   cd services/worker
 *   npx tsx scripts/runpod-deploy-v5.ts
 *   npx tsx scripts/runpod-deploy-v5.ts --smoke-only   # skip deploy, just test
 *   npx tsx scripts/runpod-deploy-v5.ts --sample 20     # more samples
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';

dotenvConfig({ path: resolve(import.meta.dirname ?? '.', '../.env') });

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY;
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID;
const NESSIE_V5_MODEL = 'carson_6cec/Meta-Llama-3.1-8B-Instruct-Reference-arkova-nessie-v5-87e1d401';

if (!RUNPOD_API_KEY) {
  console.error('Error: RUNPOD_API_KEY not set');
  process.exit(1);
}
if (!RUNPOD_ENDPOINT_ID) {
  console.error('Error: RUNPOD_ENDPOINT_ID not set');
  process.exit(1);
}

// --- CLI ---
const args = process.argv.slice(2);
const SMOKE_ONLY = args.includes('--smoke-only');
const sampleIdx = args.indexOf('--sample');
const SAMPLE_SIZE = parseInt(
  (sampleIdx >= 0 && args[sampleIdx + 1]) ? args[sampleIdx + 1] : '10',
  10,
);

const RUNPOD_API_BASE = `https://api.runpod.ai/v2/${RUNPOD_ENDPOINT_ID}`;

/**
 * Send a chat completion request to the RunPod vLLM endpoint.
 */
async function callRunPodInference(
  systemPrompt: string,
  userMessage: string,
): Promise<{ content: string; latencyMs: number }> {
  const start = Date.now();
  const resp = await fetch(`${RUNPOD_API_BASE}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RUNPOD_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: NESSIE_V5_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.1,
      max_tokens: 2048,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`RunPod API error ${resp.status}: ${body}`);
  }

  const data = await resp.json() as {
    choices: Array<{ message: { content: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? '';
  return { content, latencyMs: Date.now() - start };
}

/**
 * Smoke test: send sample extraction requests and verify responses parse.
 */
async function smokeTest(sampleSize: number): Promise<boolean> {
  console.log(`\n=== Smoke Test (${sampleSize} samples) ===\n`);

  // Import condensed prompt and golden dataset
  const { NESSIE_CONDENSED_PROMPT } = await import('../src/ai/prompts/nessie-condensed.js');
  const { FULL_GOLDEN_DATASET } = await import('../src/ai/eval/golden-dataset.js');

  const entries = FULL_GOLDEN_DATASET
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, sampleSize);

  let passed = 0;
  let failed = 0;
  const latencies: number[] = [];

  for (const entry of entries) {
    try {
      const { content, latencyMs } = await callRunPodInference(
        NESSIE_CONDENSED_PROMPT,
        entry.strippedText,
      );
      latencies.push(latencyMs);

      // Verify response is valid JSON with expected fields
      const parsed = JSON.parse(content);
      if (parsed.credentialType || parsed.issuerName || parsed.confidence !== undefined) {
        passed++;
        console.log(`  [PASS] ${entry.id} (${latencyMs}ms) — ${parsed.credentialType || 'no type'}`);
      } else {
        failed++;
        console.log(`  [FAIL] ${entry.id} (${latencyMs}ms) — no extractable fields in response`);
      }
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [FAIL] ${entry.id} — ${msg.slice(0, 100)}`);
    }
  }

  const avgLatency = latencies.length > 0
    ? latencies.reduce((a, b) => a + b, 0) / latencies.length
    : 0;

  console.log(`\n--- Results ---`);
  console.log(`  Passed: ${passed}/${sampleSize}`);
  console.log(`  Failed: ${failed}/${sampleSize}`);
  console.log(`  Avg Latency: ${avgLatency.toFixed(0)}ms`);
  console.log(`  Pass Rate: ${((passed / sampleSize) * 100).toFixed(1)}%`);

  // Pass if >80% of samples succeed (cold start can cause 1-2 failures)
  const passRate = passed / sampleSize;
  if (passRate >= 0.8) {
    console.log('\nSmoke test PASSED.\n');
    return true;
  } else {
    console.log('\nSmoke test FAILED — too many extraction failures.\n');
    return false;
  }
}

/**
 * Check current endpoint health.
 */
async function checkEndpointHealth(): Promise<void> {
  console.log('=== Endpoint Health Check ===\n');
  console.log(`  Endpoint ID: ${RUNPOD_ENDPOINT_ID}`);
  console.log(`  Target Model: ${NESSIE_V5_MODEL}`);

  try {
    const resp = await fetch(`${RUNPOD_API_BASE}/health`, {
      headers: { 'Authorization': `Bearer ${RUNPOD_API_KEY}` },
    });
    if (resp.ok) {
      const data = await resp.json() as Record<string, unknown>;
      console.log(`  Status: ${JSON.stringify(data)}`);
    } else {
      console.log(`  Health check returned ${resp.status}`);
    }
  } catch (err) {
    console.log(`  Health check failed: ${err instanceof Error ? err.message : err}`);
  }
  console.log('');
}

async function main() {
  console.log('=== RunPod v5 Deployment Script (NMT-09) ===\n');

  if (!SMOKE_ONLY) {
    console.log('NOTE: RunPod endpoint model updates must be done via the RunPod dashboard.');
    console.log('This script verifies the endpoint is serving v5 correctly.\n');
    console.log(`1. Go to: https://www.runpod.io/console/serverless`);
    console.log(`2. Find endpoint: ${RUNPOD_ENDPOINT_ID}`);
    console.log(`3. Update model to: ${NESSIE_V5_MODEL}`);
    console.log(`4. Re-run this script with --smoke-only to verify.\n`);
  }

  await checkEndpointHealth();

  const passed = await smokeTest(SAMPLE_SIZE);
  process.exit(passed ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(2);
});

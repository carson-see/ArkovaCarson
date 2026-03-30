#!/usr/bin/env tsx
/**
 * Model Comparison Eval Script
 *
 * Compares Nessie v3 (baseline) vs reasoning model on Together AI inference.
 * Uses a sample of the golden dataset for quick iteration.
 *
 * Usage:
 *   cd services/worker
 *   npx tsx scripts/eval-model-comparison.ts [--sample 50] [--concurrency 3]
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

dotenvConfig({ path: resolve(import.meta.dirname ?? '.', '../.env') });

import type {
  IAIProvider,
  ExtractionRequest,
  ExtractionResult,
  EmbeddingResult,
  EmbeddingTaskType,
  ProviderHealth,
} from '../src/ai/types.js';
import { ExtractedFieldsSchema } from '../src/ai/schemas.js';
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionPrompt } from '../src/ai/prompts/extraction.js';
import { FULL_GOLDEN_DATASET } from '../src/ai/eval/golden-dataset.js';
import { runEval, formatEvalReport } from '../src/ai/eval/runner.js';
import { analyzeCalibration } from '../src/ai/eval/calibration.js';

// --- CLI ---
const args = process.argv.slice(2);
function getArg(name: string, defaultVal: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const SAMPLE_SIZE = parseInt(getArg('sample', '100'), 10);
const CONCURRENCY = parseInt(getArg('concurrency', '3'), 10);

const POD_URL = getArg('pod-url', '');

const RUNPOD_API_KEY = process.env.RUNPOD_API_KEY ?? '';
const RUNPOD_ENDPOINT_ID = process.env.RUNPOD_ENDPOINT_ID ?? '';
if (!POD_URL && (!RUNPOD_API_KEY || !RUNPOD_ENDPOINT_ID)) {
  console.error('ERROR: Either --pod-url or RUNPOD_API_KEY+RUNPOD_ENDPOINT_ID required');
  process.exit(1);
}

const MODELS: Record<string, string> = {
  v2_baseline: 'carsonarkova/nessie-v2-llama-3.1-8b',
  v3_baseline: 'carson_6cec/Meta-Llama-3.1-8B-Instruct-Reference-arkova-nessie-v3-22458d86',
  reasoning_v1: 'carson_6cec/Meta-Llama-3.1-8B-Instruct-Reference-arkova-nessie-reasoning-v1-54f2324d',
  dpo_v1: 'carson_6cec/Meta-Llama-3.1-8B-Instruct-Reference-arkova-nessie-dpo-v1-d81529d8',
};

/**
 * RunPod vLLM provider for eval. Uses the RunPod OpenAI-compatible endpoint.
 * Handles cold starts with extended timeout on first request.
 *
 * NOTE: RunPod vLLM serves whatever model is configured in the endpoint template.
 * To test a different model, update the MODEL_NAME in the RunPod template and
 * restart the endpoint. The model ID in the request is used for logging only;
 * vLLM ignores it and serves the loaded model.
 *
 * For comparing models, we run eval twice:
 *   1. With the current RunPod model (v3 baseline)
 *   2. After updating RunPod to the new model (reasoning v1)
 * This script runs one model at a time based on --model flag.
 */
class RunPodProvider implements IAIProvider {
  readonly name: string;
  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly modelId: string;
  private warmedUp = false;
  private warmUpPromise: Promise<void> | null = null;

  constructor(name: string, modelId: string, apiKey: string, endpointIdOrPodUrl: string) {
    this.name = name;
    this.apiKey = apiKey;
    this.modelId = modelId;
    // Support direct Pod URL (https://pod-id-8000.proxy.runpod.net) or serverless endpoint ID
    if (endpointIdOrPodUrl.startsWith('http')) {
      this.apiBase = `${endpointIdOrPodUrl}/v1`;
    } else {
      this.apiBase = `https://api.runpod.ai/v2/${endpointIdOrPodUrl}/openai/v1`;
    }
  }

  async warmUp(): Promise<void> {
    if (this.warmedUp) return;
    // Mutex: if another caller is already warming up, wait for that result
    if (this.warmUpPromise) return this.warmUpPromise;
    this.warmUpPromise = this._doWarmUp();
    return this.warmUpPromise;
  }

  private async _doWarmUp(): Promise<void> {
    console.log('   Warming up RunPod endpoint (cold start may take 2-5 min on first deploy)...');
    const start = Date.now();
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const res = await this.chatCompletion(
          'You are a test assistant.',
          'Respond with: {"status":"ok"}',
          300_000, // 5 min timeout for cold start with model download
        );
        if (res.choices?.[0]?.message?.content) {
          this.warmedUp = true;
          console.log(`   Endpoint warm (${((Date.now() - start) / 1000).toFixed(1)}s)`);
          return;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`   Warm-up attempt ${attempt + 1}/10: ${msg}`);
        if (attempt < 9) await new Promise(r => setTimeout(r, 30_000)); // 30s between retries
      }
    }
    this.warmUpPromise = null;
    throw new Error('RunPod endpoint failed to warm up after 10 attempts');
  }

  async extractMetadata(request: ExtractionRequest): Promise<ExtractionResult> {
    await this.warmUp();

    const prompt = buildExtractionPrompt(
      request.strippedText,
      request.credentialType,
      request.issuerHint,
    );

    const response = await this.chatCompletion(EXTRACTION_SYSTEM_PROMPT, prompt);

    let text = response.choices[0]?.message?.content ?? '';

    // Support reasoning-augmented output: strip <reasoning>...</reasoning> tags
    const reasoningMatch = text.match(/<reasoning>([\s\S]*?)<\/reasoning>\s*/);
    if (reasoningMatch) {
      text = text.slice(reasoningMatch[0].length).trim();
    }

    // Extract JSON from potential markdown code blocks
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      text = jsonMatch[1].trim();
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Log first few parse failures
      console.log(`\n   [DEBUG] JSON parse failed. Raw text: ${text.substring(0, 200)}`);
      throw new Error(`JSON parse failed`);
    }
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
    const { confidence: _, ...rawFields } = parsed;

    return {
      fields: rawFields as Record<string, unknown>,
      confidence,
      provider: this.name,
      tokensUsed: response.usage?.total_tokens,
    };
  }

  async generateEmbedding(_text: string, _taskType?: EmbeddingTaskType): Promise<EmbeddingResult> {
    throw new Error('Not supported');
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { healthy: this.warmedUp, provider: this.name, latencyMs: 0, mode: 'runpod-serverless' };
  }

  private async chatCompletion(
    systemPrompt: string,
    userPrompt: string,
    timeoutMs = 180_000,
  ): Promise<{
    choices: Array<{ message: { content: string } }>;
    usage?: { total_tokens: number };
  }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${this.apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.modelId,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.1,
          max_tokens: 2048,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`RunPod API error ${res.status}: ${err}`);
      }

      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Run eval against the currently deployed RunPod model.
 *
 * Usage:
 *   npx tsx scripts/eval-model-comparison.ts --label v3_baseline --sample 100
 *   # ... swap model on RunPod ...
 *   npx tsx scripts/eval-model-comparison.ts --label reasoning_v1 --sample 100
 *   # ... then compare the two JSON result files
 */
async function main() {
  const label = getArg('label', 'current');
  const modelId = MODELS[label as keyof typeof MODELS] ?? 'unknown';

  console.log('=== Nessie Eval (RunPod) ===');
  console.log(`Date:        ${new Date().toISOString()}`);
  console.log(`Label:       ${label}`);
  console.log(`Model:       ${modelId}`);
  console.log(`Dataset:     ${FULL_GOLDEN_DATASET.length} total entries`);
  console.log(`Sample:      ${SAMPLE_SIZE}`);
  console.log(`Concurrency: ${CONCURRENCY}`);

  // Deterministic sample
  const step = Math.max(1, Math.floor(FULL_GOLDEN_DATASET.length / SAMPLE_SIZE));
  const evalEntries = FULL_GOLDEN_DATASET.filter((_, i) => i % step === 0).slice(0, SAMPLE_SIZE);
  console.log(`Sampled ${evalEntries.length} entries\n`);

  const outputDir = resolve(import.meta.dirname ?? '.', '../docs/eval');
  mkdirSync(outputDir, { recursive: true });

  const provider = new RunPodProvider(label, modelId, RUNPOD_API_KEY, POD_URL || RUNPOD_ENDPOINT_ID);

  const result = await runEval({
    provider,
    entries: evalEntries,
    concurrency: CONCURRENCY,
    onProgress: (completed, total) => {
      process.stdout.write(`\r   Progress: ${completed}/${total} (${((completed / total) * 100).toFixed(0)}%)`);
    },
  });

  console.log('');
  console.log(`\n--- Results: ${label} ---`);
  console.log(`   Macro F1:         ${(result.overall.macroF1 * 100).toFixed(1)}%`);
  console.log(`   Weighted F1:      ${(result.overall.weightedF1 * 100).toFixed(1)}%`);
  console.log(`   Mean Confidence:  ${(result.overall.meanReportedConfidence * 100).toFixed(1)}%`);
  console.log(`   Mean Accuracy:    ${(result.overall.meanActualAccuracy * 100).toFixed(1)}%`);
  console.log(`   Conf Corr (r):    ${result.overall.confidenceCorrelation.toFixed(3)}`);
  console.log(`   Mean Latency:     ${result.overall.meanLatencyMs.toFixed(0)}ms`);

  const cal = analyzeCalibration(result.entryResults);
  console.log(`   ECE:              ${(cal.expectedCalibrationError * 100).toFixed(1)}%`);
  console.log(`   Calibrated:       ${cal.isCalibrated ? 'YES' : 'NO'}`);

  // Per-type
  console.log('\n   Per-type:');
  for (const tm of result.byCredentialType.sort((a, b) => b.totalEntries - a.totalEntries)) {
    console.log(`     ${tm.scope.padEnd(18)} F1: ${(tm.macroF1 * 100).toFixed(1).padStart(5)}%  n=${tm.totalEntries}`);
  }

  // Save
  const report = formatEvalReport(result);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const reportPath = resolve(outputDir, `eval-${label}-${timestamp}.md`);
  const jsonPath = resolve(outputDir, `eval-${label}-${timestamp}.json`);
  writeFileSync(reportPath, report);
  writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  console.log(`\nReport: ${reportPath}`);
  console.log(`JSON:   ${jsonPath}`);
}

main().catch((err) => {
  console.error('\nEval failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});

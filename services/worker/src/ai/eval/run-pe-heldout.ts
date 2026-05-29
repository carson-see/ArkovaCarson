#!/usr/bin/env tsx
/**
 * Professional-education HELD-OUT eval runner (SCRUM-2200 Track A).
 *
 * Measures real field-level F1 on the held-out TEST split — entries the merge
 * gates never scored and the tuning exporter HARD-REFUSES. This is
 * generalization evidence, NOT a merge gate: held-out numbers are reported,
 * never used to pass/fail a PR. Gating on the test set would turn it into a
 * training signal and destroy the only honest read we have on generalization.
 * The merge gates live in run-pe-gates.ts and score curated fixtures.
 *
 * Usage:
 *   npx tsx services/worker/src/ai/eval/run-pe-heldout.ts \
 *       [--provider mock|gemini] [--output docs/eval/] [--model <endpoint-path>]
 *
 * mock   → echoes ground truth (free CI smoke of the runner wiring; F1≈100%).
 * gemini → real F1 against the tuned Vertex golden-v* endpoint
 *          (GEMINI_TUNED_MODEL=projects/.../endpoints/{id} + ADC).
 *
 * Vertex hygiene (Constitution §7): deploy the golden-v* model, run this once,
 * UNDEPLOY immediately. Endpoints bill per deployed model.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROFESSIONAL_EDUCATION_HELDOUT } from './golden-dataset-pe-heldout.js';
import {
  runEval,
  formatEvalReport,
  getPromptVersionHash,
  type EntryExtractor,
  type EvalRunOptions,
} from './runner.js';
import { createPeEntryExtractor } from './pe-eval-extraction.js';
import type { IAIProvider } from '../types.js';
import type { EvalRunResult } from './types.js';

/**
 * Mock extractor: echoes the held-out ground truth so the runner wiring
 * smoke-tests deterministically (F1≈100%) without a real model call. Proves the
 * dataset → score → report plumbing; does NOT measure model quality.
 */
export const echoHeldoutGroundTruthExtractor: EntryExtractor = async (_provider, entry) => ({
  fields: { ...(entry.groundTruth as Record<string, unknown>) },
  confidence: 0.99,
  tokensUsed: 0,
});

/** Run the held-out PE split through an extractor and return the scored result. */
export function runHeldoutEval(
  provider: IAIProvider,
  extract: EntryExtractor,
  opts: { concurrency?: number; onProgress?: EvalRunOptions['onProgress'] } = {},
): Promise<EvalRunResult> {
  return runEval({
    provider,
    entries: PROFESSIONAL_EDUCATION_HELDOUT,
    concurrency: opts.concurrency ?? 10,
    extract,
    onProgress: opts.onProgress,
  });
}

function argValue(args: string[], flag: string, fallback?: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : fallback;
}

async function buildProvider(providerArg: string, modelOverride: string | undefined): Promise<IAIProvider> {
  if (providerArg === 'mock') {
    const { MockAIProvider } = await import('../mock.js');
    return new MockAIProvider();
  }
  if (providerArg === 'gemini') {
    if (!process.env.GEMINI_API_KEY && !process.env.GEMINI_TUNED_MODEL) {
      console.error('ERROR: gemini provider needs GEMINI_API_KEY (base) or GEMINI_TUNED_MODEL + ADC (Vertex)');
      process.exit(2);
    }
    const { GeminiProvider } = await import('../gemini.js');
    return new GeminiProvider();
  }
  console.error(`ERROR: Unknown provider "${providerArg}". Use mock|gemini.`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const providerArg = argValue(args, '--provider', 'mock') ?? 'mock';
  const outputDir = argValue(args, '--output') ?? resolve(process.cwd(), 'docs', 'eval');
  const modelOverride = argValue(args, '--model');

  // Launch-gate parity (Constitution §1.6): the eval extraction flow is an
  // AI-extraction code path and must fail closed when the flag is off — the
  // mock provider (no model call) is exempt so the smoke stays green.
  if (providerArg !== 'mock' && process.env.ENABLE_AI_EXTRACTION !== 'true') {
    console.error('ERROR: ENABLE_AI_EXTRACTION must be "true" to run live held-out eval extraction.');
    process.exit(2);
  }

  if (modelOverride) {
    process.env.GEMINI_TUNED_MODEL = modelOverride;
  }

  console.log('\n🔬 Professional-Education HELD-OUT Eval (SCRUM-2200 Track A)');
  console.log(`   Provider: ${providerArg}`);
  console.log(`   Held-out entries: ${PROFESSIONAL_EDUCATION_HELDOUT.length}`);
  console.log(`   Prompt version: ${getPromptVersionHash()}`);
  console.log('   NOTE: held-out F1 is generalization evidence, NOT a merge gate.');
  console.log('');

  const provider = await buildProvider(providerArg, modelOverride);
  const extract: EntryExtractor =
    providerArg === 'mock' ? echoHeldoutGroundTruthExtractor : createPeEntryExtractor();

  const result = await runHeldoutEval(provider, extract, {
    concurrency: providerArg === 'gemini' ? 1 : 10,
    onProgress: (completed, total) => {
      const pct = ((completed / total) * 100).toFixed(0);
      process.stdout.write(`\r   Progress: ${completed}/${total} (${pct}%)`);
    },
  });

  console.log('\n');
  console.log('--- HELD-OUT RESULTS (measurement only) ---');
  console.log(`Overall weighted F1: ${(result.overall.weightedF1 * 100).toFixed(1)}%`);
  console.log(`Overall macro F1:    ${(result.overall.macroF1 * 100).toFixed(1)}%`);
  console.log(`Mean accuracy:       ${(result.overall.meanActualAccuracy * 100).toFixed(1)}%`);

  mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const mdPath = resolve(outputDir, `pe-heldout-${providerArg}-${timestamp}.md`);
  const jsonPath = resolve(outputDir, `pe-heldout-${providerArg}-${timestamp}.json`);
  writeFileSync(mdPath, formatEvalReport(result), 'utf-8');
  writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf-8');
  console.log(`\nReport: ${mdPath}`);
  console.log(`Raw: ${jsonPath}`);
}

// Run only as a CLI entrypoint — importing this module for unit-testing the
// pure helpers above must not execute the runner or call process.exit.
const invokedPath = process.argv[1];
const isEntrypoint = invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href;
if (isEntrypoint) {
  main().catch((err) => {
    console.error('PE held-out eval failed:', err);
    process.exit(1);
  });
}

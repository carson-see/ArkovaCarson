#!/usr/bin/env tsx
/**
 * Professional-education eval gate runner (SCRUM-2188).
 *
 * Runs the professional-education golden dataset (CPE / CLE / course-id) through
 * an extraction provider, scores field-level F1, and applies the merge gates
 * defined in eval-gates.ts:
 *   - SCRUM-1962  CPE extraction gate           (blocks SCRUM-1854)
 *   - SCRUM-1963  CLE ethics-hours gate          (blocks SCRUM-1880)
 *   - SCRUM-2187  course-id extraction gate      (blocks SCRUM-1921)
 *
 * Fail-closed: exits non-zero if any requested gate does not pass, so CI and the
 * live-eval operator both treat a coverage/quality miss as a hard block.
 *
 * Usage:
 *   npx tsx services/worker/src/ai/eval/run-pe-gates.ts [--provider mock|gemini|nessie|together] \
 *       [--output docs/eval/] [--gates SCRUM-1962,SCRUM-1963,SCRUM-2187]
 *
 * mock  → deterministic, free, green-in-CI smoke of the gate wiring.
 * gemini → real F1 against Gemini (GEMINI_API_KEY) or Vertex (GEMINI_TUNED_MODEL + ADC).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GOLDEN_DATASET_PROFESSIONAL_EDUCATION } from './golden-dataset-professional-education.js';
import { runEval, getPromptVersionHash, type EntryExtractor } from './runner.js';
import { createPeEntryExtractor } from './pe-eval-extraction.js';
import {
  EVAL_GATE_CONFIGS,
  evaluateEvalGates,
  type EvalGateConfig,
  type EvalGateResult,
} from './eval-gates.js';
import type { IAIProvider } from '../types.js';

const ALL_GATE_IDS = EVAL_GATE_CONFIGS.map((gate) => gate.gateId);

type RequestedGates = Array<EvalGateConfig['gateId']>;

/**
 * Resolve the --gates argument into the gate set to evaluate. Fail-closed:
 * an omitted flag means "all gates", but an explicitly-provided-but-empty value
 * (`--gates ""`, whitespace, or only commas) is an error — never an empty set,
 * which would make `gateResults.every(...)` vacuously pass and bypass the gates.
 */
export function resolveRequestedGates(
  rawGatesArg: string | undefined,
): { gates: RequestedGates } | { error: string } {
  if (rawGatesArg === undefined) {
    return { gates: [...ALL_GATE_IDS] };
  }
  const parsed = rawGatesArg
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (parsed.length === 0) {
    return { error: `--gates was provided but empty. Known: ${ALL_GATE_IDS.join(', ')}` };
  }
  const unknownGate = parsed.find((id) => !ALL_GATE_IDS.includes(id as EvalGateConfig['gateId']));
  if (unknownGate) {
    return { error: `Unknown gate "${unknownGate}". Known: ${ALL_GATE_IDS.join(', ')}` };
  }
  return { gates: parsed as RequestedGates };
}

/**
 * Default the report directory to `<repo>/docs/eval` relative to the current
 * working directory — NOT `../../docs/eval`, which climbs out of the repo when
 * the CLI is run from the repository root. An explicit --output always wins.
 */
export function resolveOutputDir(outputArg: string | undefined, cwd: string): string {
  return outputArg ?? resolve(cwd, 'docs', 'eval');
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
  if (providerArg === 'nessie') {
    if (!process.env.RUNPOD_API_KEY || !process.env.RUNPOD_ENDPOINT_ID) {
      console.error('ERROR: nessie provider needs RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID');
      process.exit(2);
    }
    const { NessieProvider } = await import('../nessie.js');
    return new NessieProvider(undefined, undefined, modelOverride);
  }
  if (providerArg === 'together') {
    if (!process.env.TOGETHER_API_KEY) {
      console.error('ERROR: together provider needs TOGETHER_API_KEY');
      process.exit(2);
    }
    const { TogetherProvider } = await import('../together.js');
    return new TogetherProvider(undefined, modelOverride);
  }
  console.error(`ERROR: Unknown provider "${providerArg}". Use mock|gemini|nessie|together.`);
  process.exit(2);
}

/**
 * Mock extractor: echoes the golden ground truth so the gate wiring smoke-tests
 * deterministically green in CI without spending a real model call. It proves the
 * PE field plumbing (prompt routing → parse → score → gate) end to end; it does
 * NOT measure model quality. Real F1 comes from the createPeEntryExtractor path.
 */
const echoGroundTruthExtractor: EntryExtractor = async (_provider, entry) => ({
  fields: { ...(entry.groundTruth as Record<string, unknown>) },
  confidence: 0.99,
  tokensUsed: 0,
});

function selectExtractor(providerArg: string): EntryExtractor {
  return providerArg === 'mock' ? echoGroundTruthExtractor : createPeEntryExtractor();
}

function gateReasonLabel(reason: EvalGateResult['reason']): string {
  switch (reason) {
    case 'passed':
      return 'PASS';
    case 'dataset_coverage_missing':
      return 'FAIL — dataset coverage below minimum';
    case 'field_threshold_failed':
      return 'FAIL — required field F1 below threshold';
    case 'aggregate_threshold_failed':
      return 'FAIL — aggregate weighted F1 below threshold';
    default:
      return 'FAIL';
  }
}

function formatGateReport(
  gateResults: EvalGateResult[],
  meta: { provider: string; promptVersionHash: string; timestamp: string; totalEntries: number },
): string {
  const lines: string[] = [];
  lines.push('# Professional-Education Eval Gate Report');
  lines.push('');
  lines.push(`- **Date:** ${meta.timestamp}`);
  lines.push(`- **Provider:** ${meta.provider}`);
  lines.push(`- **Prompt Version:** ${meta.promptVersionHash}`);
  lines.push(`- **PE entries evaluated:** ${meta.totalEntries}`);
  lines.push(`- **Overall:** ${gateResults.every((g) => g.passed) ? '✅ ALL GATES PASS' : '❌ GATE FAILURE'}`);
  lines.push('');
  lines.push('| Gate | Blocks | Entries | Weighted F1 | Min | Result |');
  lines.push('|------|--------|---------|-------------|-----|--------|');
  for (const gate of gateResults) {
    lines.push(
      `| ${gate.gateId} (${gate.label}) | ${gate.blocksStory} | ${gate.matchingEntries} | ` +
        `${(gate.weightedF1 * 100).toFixed(1)}% | ${(gate.minimumWeightedF1 * 100).toFixed(0)}% | ${gateReasonLabel(gate.reason)} |`,
    );
  }
  lines.push('');
  lines.push('## Required field F1');
  lines.push('');
  lines.push('| Gate | Field | F1 | Min | Result |');
  lines.push('|------|-------|----|----|--------|');
  for (const gate of gateResults) {
    for (const field of gate.fieldResults) {
      lines.push(
        `| ${gate.gateId} | ${field.field} | ${(field.f1 * 100).toFixed(1)}% | ` +
          `${(field.minimumF1 * 100).toFixed(0)}% | ${field.passed ? 'PASS' : 'FAIL'} |`,
      );
    }
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const providerArg = argValue(args, '--provider', 'mock') ?? 'mock';
  const outputDir = resolveOutputDir(argValue(args, '--output'), process.cwd());
  const modelOverride = argValue(args, '--model');

  // Launch-gate parity (Constitution §1.6): the eval extraction flow is an
  // AI-extraction code path and must fail closed when the flag is off — the
  // mock provider (no model call) is exempt so the gate-wiring smoke stays green.
  if (providerArg !== 'mock' && process.env.ENABLE_AI_EXTRACTION !== 'true') {
    console.error('ERROR: ENABLE_AI_EXTRACTION must be "true" to run live PE eval extraction.');
    process.exit(2);
  }

  const gateSelection = resolveRequestedGates(argValue(args, '--gates'));
  if ('error' in gateSelection) {
    console.error(`ERROR: ${gateSelection.error}`);
    process.exit(2);
  }
  const requestedGates = gateSelection.gates;

  console.log('\n🔬 Professional-Education Eval Gate Runner (SCRUM-2188)');
  console.log(`   Provider: ${providerArg}`);
  console.log(`   PE dataset: ${GOLDEN_DATASET_PROFESSIONAL_EDUCATION.length} entries`);
  console.log(`   Gates: ${requestedGates.join(', ')}`);
  console.log(`   Prompt version: ${getPromptVersionHash()}`);
  console.log('');

  const provider = await buildProvider(providerArg, modelOverride);

  const result = await runEval({
    provider,
    entries: GOLDEN_DATASET_PROFESSIONAL_EDUCATION,
    concurrency: providerArg === 'gemini' ? 1 : 10,
    extract: selectExtractor(providerArg),
    onProgress: (completed, total) => {
      const pct = ((completed / total) * 100).toFixed(0);
      process.stdout.write(`\r   Progress: ${completed}/${total} (${pct}%)`);
    },
  });

  console.log('\n');

  const gateResults = evaluateEvalGates(result, requestedGates);

  console.log('--- GATE RESULTS ---');
  for (const gate of gateResults) {
    console.log(
      `${gate.passed ? '✅' : '❌'} ${gate.gateId} (${gate.label}) → blocks ${gate.blocksStory} | ` +
        `n=${gate.matchingEntries} weightedF1=${(gate.weightedF1 * 100).toFixed(1)}% | ${gateReasonLabel(gate.reason)}`,
    );
    for (const field of gate.fieldResults) {
      console.log(
        `     ${field.passed ? '·' : '✗'} ${field.field}: F1=${(field.f1 * 100).toFixed(1)}% (min ${(field.minimumF1 * 100).toFixed(0)}%)`,
      );
    }
  }

  mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const reportMeta = {
    provider: result.provider,
    promptVersionHash: result.promptVersionHash,
    timestamp: result.timestamp,
    totalEntries: result.totalEntries,
  };
  const mdPath = resolve(outputDir, `pe-gates-${providerArg}-${timestamp}.md`);
  const jsonPath = resolve(outputDir, `pe-gates-${providerArg}-${timestamp}.json`);
  writeFileSync(mdPath, formatGateReport(gateResults, reportMeta), 'utf-8');
  writeFileSync(jsonPath, JSON.stringify({ meta: reportMeta, gates: gateResults }, null, 2), 'utf-8');
  console.log(`\nReport: ${mdPath}`);
  console.log(`Raw: ${jsonPath}`);

  const allPassed = gateResults.every((gate) => gate.passed);
  console.log(`\n${allPassed ? '✅ ALL GATES PASS' : '❌ GATE FAILURE — fail-closed exit 1'}`);
  process.exit(allPassed ? 0 : 1);
}

// Run only as a CLI entrypoint — importing this module (e.g. for unit-testing
// the pure helpers above) must not execute the runner or call process.exit.
const invokedPath = process.argv[1];
const isEntrypoint = invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href;
if (isEntrypoint) {
  main().catch((err) => {
    console.error('PE gate runner failed:', err);
    process.exit(1);
  });
}

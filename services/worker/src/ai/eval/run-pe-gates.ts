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

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { GOLDEN_DATASET_PROFESSIONAL_EDUCATION } from './golden-dataset-professional-education.js';
import {
  CPE_CLE_S3_GATE_ENTRIES,
  CPE_CLE_S3_HELDOUT_ENTRIES,
} from './golden-dataset-cpe-cle-s3.js';
import {
  checkHeldoutLeakage,
  loadLeakageCorpus,
  type LeakageViolation,
} from './heldout-leakage.js';
import { runEval, getPromptVersionHash, type EntryExtractor } from './runner.js';
import { createPeEntryExtractor } from './pe-eval-extraction.js';
import {
  EVAL_GATE_CONFIGS,
  evaluateEvalGates,
  type EvalGateConfig,
  type EvalGateResult,
} from './eval-gates.js';
import type { GoldenDatasetEntry } from './types.js';
import type { IAIProvider } from '../types.js';

const ALL_GATE_IDS = EVAL_GATE_CONFIGS.map((gate) => gate.gateId);

/** The three professional-education gates that ran here before AI-02. */
const PE_GATE_IDS: Array<EvalGateConfig['gateId']> = ['SCRUM-1962', 'SCRUM-1963', 'SCRUM-2187'];

/**
 * Committed deterministic replay fixture for the SCRUM-2382 CI gate
 * (worker-root-relative). Seeded from the mock (ground-truth echo) path —
 * see the file's `meta.note`: it is NOT a live-model measurement until the
 * nightly live-Gemini recording replaces it.
 */
export const S3_RECORDED_OUTPUTS_DEFAULT_PATH = 'src/ai/eval/recorded/s3-cpe-cle-recorded.json';

type RequestedGates = Array<EvalGateConfig['gateId']>;

/**
 * Resolve the --gates argument into the gate set to evaluate. Fail-closed:
 * an omitted flag means "the selected dataset's default gates", but an
 * explicitly-provided-but-empty value (`--gates ""`, whitespace, or only
 * commas) is an error — never an empty set, which would make
 * `gateResults.every(...)` vacuously pass and bypass the gates.
 */
export function resolveRequestedGates(
  rawGatesArg: string | undefined,
  defaultGates: RequestedGates = PE_GATE_IDS,
): { gates: RequestedGates } | { error: string } {
  if (rawGatesArg === undefined) {
    return { gates: [...defaultGates] };
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

// ─── AI-02 (SCRUM-2382): dataset selection + fixture replay provider mode ───

export interface DatasetSelection {
  name: 'pe' | 's3';
  entries: GoldenDatasetEntry[];
  defaultGates: RequestedGates;
}

/**
 * Resolve --dataset. `pe` (default) is the professional-education set with its
 * three original gates. `s3` is the AI-01 CPE/CLE golden set's GATE split —
 * held-out entries are never gate-scored here (they exist for generalization
 * measurement and are protected by the leakage check below).
 */
export function resolveDataset(
  rawDatasetArg: string | undefined,
): DatasetSelection | { error: string } {
  const name = rawDatasetArg ?? 'pe';
  if (name === 'pe') {
    return {
      name: 'pe',
      entries: GOLDEN_DATASET_PROFESSIONAL_EDUCATION,
      defaultGates: [...PE_GATE_IDS],
    };
  }
  if (name === 's3') {
    return {
      name: 's3',
      entries: CPE_CLE_S3_GATE_ENTRIES,
      defaultGates: ['SCRUM-2382'],
    };
  }
  return { error: `Unknown dataset "${name}". Use pe|s3.` };
}

const RecordedOutputsSchema = z.object({
  meta: z.object({
    recordedFrom: z.string(),
    recordedAt: z.string(),
    datasetTag: z.string(),
    note: z.string(),
  }),
  outputs: z.record(
    z.string(),
    z.object({
      fields: z.record(z.string(), z.unknown()),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

export type RecordedOutputs = z.infer<typeof RecordedOutputsSchema>;

/** Load + validate a recorded-outputs replay fixture. Throws on malformed files. */
export function loadRecordedOutputs(path: string): RecordedOutputs {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
  const parsed = RecordedOutputsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Recorded outputs file ${path} is malformed: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/**
 * Fixture replay extractor — REPLAYS recorded model outputs. Zero live model
 * calls. Fail-closed: an entry with no recorded output throws (an incomplete
 * fixture must never score as a silent field miss OR pass).
 */
export function createFixtureReplayExtractor(recorded: RecordedOutputs): EntryExtractor {
  return async (_provider, entry) => {
    const output = recorded.outputs[entry.id];
    if (!output) {
      throw new Error(
        `Fixture replay: no recorded output for entry ${entry.id}. ` +
          'Re-seed the recorded fixture file (--seed-recorded) or record a fresh run.',
      );
    }
    return {
      fields: { ...output.fields },
      confidence: output.confidence,
      tokensUsed: 0,
    };
  };
}

/**
 * Seed a recorded-outputs fixture from the ground truth (the mock echo path).
 * Deterministic by construction and clearly marked: F1 computed from this seed
 * proves the gate WIRING, not model quality.
 */
export function buildRecordedOutputsFromGroundTruth(
  entries: readonly GoldenDatasetEntry[],
): RecordedOutputs {
  const outputs: RecordedOutputs['outputs'] = {};
  for (const entry of entries) {
    outputs[entry.id] = {
      fields: { ...(entry.groundTruth as Record<string, unknown>) },
      confidence: 0.99,
    };
  }
  return {
    meta: {
      recordedFrom: 'mock-echo',
      recordedAt: new Date().toISOString().slice(0, 10),
      datasetTag: 's3-cpe-cle',
      note:
        'DETERMINISTIC MOCK SEED — ground-truth echo, NOT a live-model measurement. ' +
        'Replace via a nightly live-Gemini recording before treating the gate F1 as a real model score.',
    },
    outputs,
  };
}

/**
 * AI-01 leakage precondition, wired into the s3 gate run: the held-out split
 * must be absent from every committed prompt/few-shot/tuning corpus. Returns
 * violations (fixture ids + corpus paths only — never fixture content).
 */
export function checkS3LeakagePrecondition(workerRoot: string): LeakageViolation[] {
  return checkHeldoutLeakage(CPE_CLE_S3_HELDOUT_ENTRIES, loadLeakageCorpus(workerRoot));
}

/**
 * Gemini selects its tuned Vertex endpoint from GEMINI_TUNED_MODEL, read at
 * construction time (gemini.ts) — not from a constructor arg. So `--model` for
 * the gemini provider must flow through the env, mirroring run-pe-heldout.ts.
 * Without this, `--provider gemini --model <endpoint>` silently scored whatever
 * endpoint was already in env (or the base model), producing gate evidence for
 * the wrong endpoint. nessie/together take the override as a constructor arg
 * instead, so this is a no-op for them.
 */
export function applyGeminiModelOverride(
  providerArg: string,
  modelOverride: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (providerArg === 'gemini' && modelOverride) {
    env.GEMINI_TUNED_MODEL = modelOverride;
  }
}

async function buildProvider(providerArg: string, modelOverride: string | undefined): Promise<IAIProvider> {
  if (providerArg === 'mock' || providerArg === 'fixture') {
    // `fixture` needs no live provider — replay happens in the extractor. The
    // inert mock satisfies the runner's provider interface without any network.
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
  console.error(`ERROR: Unknown provider "${providerArg}". Use mock|fixture|gemini|nessie|together.`);
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

function selectExtractor(providerArg: string, recorded: RecordedOutputs | null): EntryExtractor {
  if (providerArg === 'fixture') {
    if (!recorded) {
      throw new Error('fixture provider requires --recorded <path> (or the committed default).');
    }
    return createFixtureReplayExtractor(recorded);
  }
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

/**
 * Format the gate report. VALUE-OMISSION CONTRACT (AI-02): the report carries
 * field NAMES + scores only — never fixture/extraction field values.
 */
export function formatGateReport(
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
  // mock and fixture providers (no model call, no document text egress) are
  // exempt so the deterministic CI gate stays green.
  if (providerArg !== 'mock' && providerArg !== 'fixture' && process.env.ENABLE_AI_EXTRACTION !== 'true') {
    console.error('ERROR: ENABLE_AI_EXTRACTION must be "true" to run live PE eval extraction.');
    process.exit(2);
  }

  // Route --model to the gemini provider via GEMINI_TUNED_MODEL before the
  // provider is constructed (gemini reads the endpoint from env at construction).
  applyGeminiModelOverride(providerArg, modelOverride);

  const dataset = resolveDataset(argValue(args, '--dataset'));
  if ('error' in dataset) {
    console.error(`ERROR: ${dataset.error}`);
    process.exit(2);
  }

  // AI-01→AI-02 leakage precondition: an s3 gate run on a contaminated repo is
  // not evidence. Fail-closed before any scoring. Violations print fixture ids
  // and corpus paths ONLY — never fixture content.
  if (dataset.name === 's3') {
    const violations = checkS3LeakagePrecondition(process.cwd());
    if (violations.length > 0) {
      console.error('ERROR: held-out leakage detected — s3 gate run aborted (fail-closed):');
      for (const violation of violations) {
        console.error(`   ${violation.kind}-leak: ${violation.fixtureId} found in ${violation.corpusFile}`);
      }
      process.exit(2);
    }
  }

  // --seed-recorded <path>: write a deterministic mock-echo replay fixture and
  // exit. Explicitly NOT a live-model measurement (see meta.note).
  const seedPath = argValue(args, '--seed-recorded');
  if (seedPath) {
    const seeded = buildRecordedOutputsFromGroundTruth(dataset.entries);
    writeFileSync(resolve(process.cwd(), seedPath), JSON.stringify(seeded, null, 2) + '\n', 'utf-8');
    console.log(`Seeded recorded outputs (${Object.keys(seeded.outputs).length} entries) → ${seedPath}`);
    console.log('NOTE: mock-echo seed — replace via a nightly live-Gemini recording before treating F1 as real.');
    process.exit(0);
  }

  let recorded: RecordedOutputs | null = null;
  if (providerArg === 'fixture') {
    const recordedPath = argValue(args, '--recorded', S3_RECORDED_OUTPUTS_DEFAULT_PATH)!;
    recorded = loadRecordedOutputs(resolve(process.cwd(), recordedPath));
    console.log(`   Replay fixture: ${recordedPath} (recordedFrom=${recorded.meta.recordedFrom})`);
    if (recorded.meta.recordedFrom === 'mock-echo') {
      console.log('   ⚠ mock-echo seed — gate proves WIRING determinism, not model quality.');
    }
  }

  const gateSelection = resolveRequestedGates(argValue(args, '--gates'), dataset.defaultGates);
  if ('error' in gateSelection) {
    console.error(`ERROR: ${gateSelection.error}`);
    process.exit(2);
  }
  const requestedGates = gateSelection.gates;

  console.log('\n🔬 Professional-Education Eval Gate Runner (SCRUM-2188 / SCRUM-2382)');
  console.log(`   Provider: ${providerArg}`);
  console.log(`   Dataset: ${dataset.name} (${dataset.entries.length} entries)`);
  console.log(`   Gates: ${requestedGates.join(', ')}`);
  console.log(`   Prompt version: ${getPromptVersionHash()}`);
  console.log('');

  const provider = await buildProvider(providerArg, modelOverride);

  const result = await runEval({
    provider,
    entries: dataset.entries,
    concurrency: providerArg === 'gemini' ? 1 : 10,
    extract: selectExtractor(providerArg, recorded),
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

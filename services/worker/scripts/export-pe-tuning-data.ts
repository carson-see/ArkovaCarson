#!/usr/bin/env tsx
/**
 * Professional-education Vertex Gemini tuning-data export CLI (SCRUM-2200).
 *
 * Generates the synthetic PE TRAIN split and writes Vertex AI Gemini
 * supervised-tuning JSONL. Fully synthetic + seeded — no Supabase, no prod data,
 * no PII (Constitution §1.6). We tune the model we serve (Gemini/Vertex), so this
 * targets the golden-v5 tuned-endpoint format, NOT the legacy Together/Llama path.
 *
 * Usage:
 *   cd services/worker
 *   npx tsx scripts/export-pe-tuning-data.ts [--count 2000] [--seed 1] \
 *       [--cpe 0.5] [--cle 0.5] [--output ./training-data/pe-gemini-train.jsonl]
 *
 * Next steps after export:
 *   1. Review the JSONL for quality.
 *   2. Upload to a GCS bucket and start a Vertex Gemini supervised-tuning job
 *      against the base model, producing the next golden-v* tuned endpoint.
 *   3. Re-run the held-out eval (run-pe-gates against the new endpoint), then
 *      UNDEPLOY the endpoint immediately (Vertex bills per deployed model).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportPeTuningDataset } from '../src/ai/eval/pe-tuning-exporter.js';

function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const count = Number(argValue(args, '--count') ?? '2000');
  const seed = Number(argValue(args, '--seed') ?? '1');
  const cpe = argValue(args, '--cpe');
  const cle = argValue(args, '--cle');
  const mix = cpe !== undefined || cle !== undefined
    ? { cpe: Number(cpe ?? '0.5'), cle: Number(cle ?? '0.5') }
    : undefined;

  if (!Number.isInteger(count) || count <= 0) {
    console.error(`ERROR: --count must be a positive integer (got "${count}")`);
    process.exit(2);
  }

  const outputPath = argValue(args, '--output')
    ? resolve(argValue(args, '--output')!)
    : resolve(process.cwd(), 'training-data', `pe-gemini-train-seed${seed}-n${count}.jsonl`);

  console.log('=== Arkova PE Vertex Gemini Tuning Export (SCRUM-2200) ===\n');
  console.log(`Count: ${count}  Seed: ${seed}  Mix: ${mix ? `cpe ${mix.cpe} / cle ${mix.cle}` : 'default (even)'}`);

  const { jsonl, exampleCount, byCredential } = exportPeTuningDataset({ count, seed, mix });

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, jsonl, 'utf-8');

  console.log(`\nExported ${exampleCount} examples (CPE ${byCredential.cpe} / CLE ${byCredential.cle})`);
  console.log(`Output: ${outputPath}`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    main();
  } catch (err) {
    console.error('PE tuning export failed:', err);
    process.exit(1);
  }
}

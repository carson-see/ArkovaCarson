/**
 * scripts/staging/ai-eval/golden.ts — loader for the vendored AI-01 golden set.
 *
 * Reads the JSON snapshot (golden-cpe-cle-s3.json) that was exported from
 * services/worker/src/ai/eval/golden-dataset-cpe-cle-s3.ts on PR #1413
 * (SCRUM-2381). The JSON is DATA-only (60 stratified CPE/CLE fixtures, all
 * synthetic — zero real PII), so vendoring it keeps this tooling standalone
 * from the excluded `services/` TS project without duplicating the TS builders.
 *
 * Regenerate the snapshot when #1413's golden set changes:
 *   git show origin/lane3/s3-ai:services/worker/src/ai/eval/golden-dataset-cpe-cle-s3.ts > /tmp/golden.ts
 *   git show origin/lane3/s3-ai:services/worker/src/ai/eval/types.ts > /tmp/types.ts
 *   # tiny export script imports GOLDEN_DATASET_CPE_CLE_S3 and writes JSON; wrap
 *   # under `entries` with the `_provenance` block. See PR body for the one-liner.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type { GoldenEntry } from './scoring.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const GOLDEN_JSON_PATH = resolve(HERE, 'golden-cpe-cle-s3.json');

/** Tag applied to the 12 held-out fixtures — excluded from every merge gate. */
export const HELD_OUT_TAG = 'held-out';
/** Dataset tag the SCRUM-2382 gate matches on. */
export const DATASET_TAG = 's3-cpe-cle';

interface GoldenFile {
  _provenance: {
    source: string;
    sourceRef: string;
    sourceCommit: string;
    totalEntries: number;
    gateEntries: number;
    heldOutEntries: number;
  };
  entries: GoldenEntry[];
}

let cache: GoldenFile | undefined;

function loadFile(path: string = GOLDEN_JSON_PATH): GoldenFile {
  if (cache && path === GOLDEN_JSON_PATH) return cache;
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as GoldenFile;
  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
    throw new Error(`Golden snapshot at ${path} has no entries — refusing to run an empty eval.`);
  }
  if (path === GOLDEN_JSON_PATH) cache = parsed;
  return parsed;
}

export function goldenProvenance(path?: string): GoldenFile['_provenance'] {
  return loadFile(path)._provenance;
}

/** All 60 fixtures (gate + held-out). */
export function allGoldenEntries(path?: string): GoldenEntry[] {
  return loadFile(path).entries;
}

/**
 * The 48-entry GATE split scored by the SCRUM-2382 merge gate — held-out
 * fixtures are excluded (they measure generalization, never merge evidence).
 */
export function gateGoldenEntries(path?: string): GoldenEntry[] {
  return allGoldenEntries(path).filter((entry) => !entry.tags.includes(HELD_OUT_TAG));
}

/** The 12-entry held-out split (generalization measurement only). */
export function heldOutGoldenEntries(path?: string): GoldenEntry[] {
  return allGoldenEntries(path).filter((entry) => entry.tags.includes(HELD_OUT_TAG));
}

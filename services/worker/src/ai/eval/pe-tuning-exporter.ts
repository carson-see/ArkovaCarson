/**
 * Professional-education Vertex Gemini supervised-tuning exporter (SCRUM-2200).
 *
 * Turns the synthetic PE TRAIN split into Vertex AI Gemini supervised-tuning
 * JSONL. Each line mirrors the EXACT inference contract the eval/gate path uses
 * (PE_EVAL_SYSTEM_PROMPT + buildPeUserPrompt), with the synthetic ground truth
 * as the model target — so we train on precisely what we measure.
 *
 * Vertex Gemini tuning line shape (one JSON object per line):
 *   {
 *     "systemInstruction": { "role": "system", "parts": [{ "text": "..." }] },
 *     "contents": [
 *       { "role": "user",  "parts": [{ "text": "<prompt>" }] },
 *       { "role": "model", "parts": [{ "text": "<ground-truth JSON>" }] }
 *     ]
 *   }
 *
 * We tune the model we serve: production extraction is Gemini (Constitution §1.1),
 * and the gates already score the golden-v5 tuned Vertex endpoint — so the tuning
 * target is Vertex Gemini, NOT the legacy Together/Llama finetune-exporter path.
 *
 * Train/test discipline: this exporter consumes the synthetic-train split only
 * and HARD-REFUSES any held-out TEST entry (see buildVertexTuningExample). The
 * held-out set and curated gate fixtures are eval evidence — never training data.
 *
 * Constitution §1.6: the synthetic generator never emits raw PII, so the target
 * JSON (built from ground truth) and the rendered prompt are PII-free by
 * construction; pe-tuning-exporter.test.ts asserts this on the serialized output.
 */

import type { GoldenDatasetEntry } from './types.js';
import { PE_EVAL_SYSTEM_PROMPT, buildPeUserPrompt } from './pe-eval-extraction.js';
import { generatePeSyntheticDataset, type PeSyntheticOptions } from './pe-synthetic-generator.js';

export interface VertexTuningExample {
  systemInstruction: { role: 'system'; parts: Array<{ text: string }> };
  contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>;
}

export interface PeTuningExportResult {
  jsonl: string;
  exampleCount: number;
  byCredential: { cpe: number; cle: number };
}

/**
 * Ground-truth keys that are eval-control metadata, not document fields. The
 * model must never be trained to emit them (they would become hallucinated
 * output at inference).
 */
const NON_EMITTED_GROUND_TRUTH_FIELDS = new Set(['manualReviewExpected', 'parseFailureExpected']);

function hasTag(entry: GoldenDatasetEntry, tag: string): boolean {
  return entry.tags.some((entryTag) => entryTag.toLowerCase() === tag);
}

/**
 * Serialize an entry's ground truth into the JSON the model should produce.
 * Drops null/undefined and eval-control fields, and pins confidence to 1 (the
 * target is by-construction correct).
 */
export function buildTuningTargetJson(entry: GoldenDatasetEntry): string {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry.groundTruth)) {
    if (value === null || value === undefined) continue;
    if (NON_EMITTED_GROUND_TRUTH_FIELDS.has(key)) continue;
    fields[key] = value;
  }
  fields.confidence = 1;
  return JSON.stringify(fields);
}

/**
 * Build one Vertex Gemini tuning example for a PE entry. Refuses held-out TEST
 * entries — training on the held-out split is exactly the contamination this
 * track exists to prevent.
 */
export function buildVertexTuningExample(entry: GoldenDatasetEntry): VertexTuningExample {
  if (hasTag(entry, 'held-out')) {
    throw new Error(
      `Refusing to export held-out entry ${entry.id} as TRAIN data — train/test contamination guard.`,
    );
  }
  // Fail closed: only the explicit synthetic TRAIN split is exportable. The
  // curated gate fixtures and held-out set are eval evidence — without this
  // guard a caller could pass a gate fixture and silently train on the exact
  // data that scores the merge gate, inflating future F1.
  if (!hasTag(entry, 'synthetic-train')) {
    throw new Error(
      `Refusing to export entry ${entry.id} without the 'synthetic-train' split tag — only the synthetic TRAIN split may be exported as tuning data.`,
    );
  }
  return {
    systemInstruction: { role: 'system', parts: [{ text: PE_EVAL_SYSTEM_PROMPT }] },
    contents: [
      { role: 'user', parts: [{ text: buildPeUserPrompt(entry) }] },
      { role: 'model', parts: [{ text: buildTuningTargetJson(entry) }] },
    ],
  };
}

/** Serialize entries to Vertex tuning JSONL (one object per line, trailing newline). */
export function toTuningJsonl(entries: GoldenDatasetEntry[]): string {
  if (entries.length === 0) return '';
  return `${entries.map((entry) => JSON.stringify(buildVertexTuningExample(entry))).join('\n')}\n`;
}

/**
 * Generate the synthetic PE TRAIN split and serialize it to Vertex tuning JSONL.
 * Deterministic for a given seed/count/mix (the generator is seeded).
 */
export function exportPeTuningDataset(options: PeSyntheticOptions): PeTuningExportResult {
  const entries = generatePeSyntheticDataset(options);
  const jsonl = toTuningJsonl(entries);
  return {
    jsonl,
    exampleCount: entries.length,
    byCredential: {
      cpe: entries.filter((entry) => hasTag(entry, 'cpe')).length,
      cle: entries.filter((entry) => hasTag(entry, 'cle')).length,
    },
  };
}

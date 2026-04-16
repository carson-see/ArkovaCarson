#!/usr/bin/env tsx
/**
 * Gemini Golden v6 — Post-Eval Analyzer (GME2 / SCRUM-772)
 *
 * Reads a raw eval JSON dump from `run-eval.ts --provider gemini --output docs/eval/`
 * and computes v6-specific metrics that the standard eval runner doesn't measure:
 *   - subType emission rate (overall, non-"other", by credentialType)
 *   - description emission rate
 *   - JSON parse success rate (inferred from empty extractedFields)
 *   - Latency p50 / p95 / p99
 *   - Per-subType accuracy where ground truth has subType
 *
 * Usage:
 *   npx tsx scripts/analyze-gemini-golden-v6-eval.ts \
 *     --input docs/eval/eval-gemini-2026-04-16T16-30-00.json \
 *     [--output docs/eval/v6-analysis-2026-04-16.md]
 *
 * Prints a markdown report to stdout (and optionally writes to --output).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ---- CLI ----
const args = process.argv.slice(2);
const inputIdx = args.indexOf('--input');
if (inputIdx < 0) {
  console.error('ERROR: --input <path-to-eval-json> is required');
  process.exit(1);
}
const inputPath = resolve(args[inputIdx + 1]);
const outputIdx = args.indexOf('--output');
const outputPath = outputIdx >= 0 ? resolve(args[outputIdx + 1]) : null;

// ---- Shape of raw eval JSON ----
interface EntryResult {
  entryId: string;
  credentialType: string;
  latencyMs: number;
  reportedConfidence: number;
  actualAccuracy: number;
  extractedFields?: Record<string, unknown>;
  fieldResults: Array<{ field: string; expected?: unknown; actual?: unknown; correct: boolean; matchType: string }>;
}

interface EvalJson {
  timestamp: string;
  provider: string;
  totalEntries: number;
  entryResults: EntryResult[];
  overall: {
    macroF1: number;
    weightedF1: number;
    meanLatencyMs: number;
    meanReportedConfidence: number;
    meanActualAccuracy: number;
    confidenceCorrelation: number;
  };
  byCredentialType: Array<{
    scope: string;
    totalEntries: number;
    macroF1: number;
    weightedF1: number;
  }>;
}

// ---- Helpers ----
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function fmtMs(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${n.toFixed(0)}ms`;
}

// ---- Main ----
const data: EvalJson = JSON.parse(readFileSync(inputPath, 'utf-8'));
const entries = data.entryResults;
const N = entries.length;

// 1. JSON parse success (proxy: extractedFields present and non-empty)
const parseFailures = entries.filter(e => !e.extractedFields || Object.keys(e.extractedFields).length === 0).length;
const parseSuccess = N - parseFailures;

// 2. subType emission
const withSubType = entries.filter(e => {
  const st = e.extractedFields?.subType;
  return typeof st === 'string' && st.length > 0;
});
const nonOtherSubType = withSubType.filter(e => e.extractedFields?.subType !== 'other');

// 3. description emission
const withDescription = entries.filter(e => {
  const d = e.extractedFields?.description;
  return typeof d === 'string' && d.length > 0;
});

// 4. Latency percentiles
const latencies = entries.map(e => e.latencyMs).sort((a, b) => a - b);
const p50 = percentile(latencies, 50);
const p95 = percentile(latencies, 95);
const p99 = percentile(latencies, 99);
const mean = latencies.reduce((s, v) => s + v, 0) / (N || 1);

// 5. subType emission by credentialType
const byCt: Record<string, { total: number; withSubType: number; nonOther: number }> = {};
for (const e of entries) {
  const ct = e.credentialType;
  if (!byCt[ct]) byCt[ct] = { total: 0, withSubType: 0, nonOther: 0 };
  byCt[ct].total++;
  const st = e.extractedFields?.subType;
  if (typeof st === 'string' && st.length > 0) {
    byCt[ct].withSubType++;
    if (st !== 'other') byCt[ct].nonOther++;
  }
}

// 6. DoD check
const DOD = {
  macroF1: { target: 0.75, actual: data.overall.macroF1, pass: data.overall.macroF1 >= 0.75 },
  weightedF1: { target: 0.80, actual: data.overall.weightedF1, pass: data.overall.weightedF1 >= 0.80 },
  p50: { target: 2000, actual: p50, pass: p50 < 2000 },
  p95: { target: 3000, actual: p95, pass: p95 < 3000 },
  subTypeEmissionNonOther: { target: 0.80, actual: nonOtherSubType.length / N, pass: nonOtherSubType.length / N > 0.80 },
  descriptionEmission: { target: 1.0, actual: withDescription.length / N, pass: withDescription.length / N >= 0.99 },
  jsonParse: { target: 1.0, actual: parseSuccess / N, pass: parseSuccess / N >= 0.99 },
};

// ---- Format report ----
const lines: string[] = [];
lines.push(`# Gemini Golden v6 — Post-Eval Analysis`);
lines.push('');
lines.push(`**Input:** \`${inputPath}\``);
lines.push(`**Provider:** ${data.provider}`);
lines.push(`**Eval timestamp:** ${data.timestamp}`);
lines.push(`**Entries evaluated:** ${N}`);
lines.push('');
lines.push(`## Definition of Done`);
lines.push('');
lines.push(`| Metric | Target | Actual | Pass |`);
lines.push(`|---|---|---|:---:|`);
lines.push(`| Macro F1 | ≥75% | ${(DOD.macroF1.actual * 100).toFixed(1)}% | ${DOD.macroF1.pass ? '✅' : '❌'} |`);
lines.push(`| Weighted F1 | ≥80% | ${(DOD.weightedF1.actual * 100).toFixed(1)}% | ${DOD.weightedF1.pass ? '✅' : '❌'} |`);
lines.push(`| p50 latency | <2s | ${fmtMs(DOD.p50.actual)} | ${DOD.p50.pass ? '✅' : '❌'} |`);
lines.push(`| p95 latency | <3s | ${fmtMs(DOD.p95.actual)} | ${DOD.p95.pass ? '✅' : '❌'} |`);
lines.push(`| subType emission (non-"other") | >80% | ${(DOD.subTypeEmissionNonOther.actual * 100).toFixed(1)}% | ${DOD.subTypeEmissionNonOther.pass ? '✅' : '❌'} |`);
lines.push(`| description emission | 100% | ${(DOD.descriptionEmission.actual * 100).toFixed(1)}% | ${DOD.descriptionEmission.pass ? '✅' : '❌'} |`);
lines.push(`| JSON parse success | 100% | ${(DOD.jsonParse.actual * 100).toFixed(1)}% | ${DOD.jsonParse.pass ? '✅' : '❌'} |`);
lines.push('');
const allPass = Object.values(DOD).every(d => d.pass);
lines.push(`**Overall verdict:** ${allPass ? '✅ ALL DoD TARGETS MET — proceed with production cutover' : '❌ AT LEAST ONE DoD TARGET MISSED — hold cutover, investigate'}`);
lines.push('');
lines.push(`## Latency distribution (ms)`);
lines.push('');
lines.push(`| Percentile | Latency |`);
lines.push(`|---|---|`);
lines.push(`| p50 | ${fmtMs(p50)} |`);
lines.push(`| p95 | ${fmtMs(p95)} |`);
lines.push(`| p99 | ${fmtMs(p99)} |`);
lines.push(`| mean | ${fmtMs(mean)} |`);
lines.push(`| min | ${fmtMs(latencies[0] ?? 0)} |`);
lines.push(`| max | ${fmtMs(latencies[latencies.length - 1] ?? 0)} |`);
lines.push('');
lines.push(`## Overall extraction metrics`);
lines.push('');
lines.push(`| Metric | Value |`);
lines.push(`|---|---|`);
lines.push(`| Macro F1 | ${(data.overall.macroF1 * 100).toFixed(1)}% |`);
lines.push(`| Weighted F1 | ${(data.overall.weightedF1 * 100).toFixed(1)}% |`);
lines.push(`| Mean reported confidence | ${(data.overall.meanReportedConfidence * 100).toFixed(1)}% |`);
lines.push(`| Mean actual accuracy | ${(data.overall.meanActualAccuracy * 100).toFixed(1)}% |`);
lines.push(`| Confidence correlation (r) | ${data.overall.confidenceCorrelation.toFixed(3)} |`);
lines.push('');
lines.push(`## subType emission by credentialType`);
lines.push('');
lines.push(`| credentialType | Entries | Any subType | % | Non-"other" | % |`);
lines.push(`|---|---:|---:|---:|---:|---:|`);
for (const [ct, s] of Object.entries(byCt).sort((a, b) => b[1].total - a[1].total)) {
  const anyPct = s.total > 0 ? (s.withSubType / s.total) * 100 : 0;
  const nonOtherPct = s.total > 0 ? (s.nonOther / s.total) * 100 : 0;
  lines.push(`| ${ct} | ${s.total} | ${s.withSubType} | ${anyPct.toFixed(0)}% | ${s.nonOther} | ${nonOtherPct.toFixed(0)}% |`);
}
lines.push('');
lines.push(`## Per-credential-type F1`);
lines.push('');
lines.push(`| credentialType | N | Macro F1 | Weighted F1 |`);
lines.push(`|---|---:|---:|---:|`);
for (const tm of data.byCredentialType.sort((a, b) => b.totalEntries - a.totalEntries)) {
  lines.push(`| ${tm.scope} | ${tm.totalEntries} | ${(tm.macroF1 * 100).toFixed(1)}% | ${(tm.weightedF1 * 100).toFixed(1)}% |`);
}
lines.push('');
lines.push(`## Sample subType + description outputs (first 5)`);
lines.push('');
lines.push(`| entryId | credentialType | subType | description |`);
lines.push(`|---|---|---|---|`);
for (const e of entries.slice(0, 5)) {
  const ct = e.credentialType;
  const st = e.extractedFields?.subType ?? '';
  const desc = (e.extractedFields?.description ?? '').toString().replace(/\|/g, '\\|').slice(0, 120);
  lines.push(`| ${e.entryId} | ${ct} | \`${st}\` | ${desc} |`);
}
lines.push('');
lines.push(`## Failure cases (empty or missing fields)`);
lines.push('');
if (parseFailures === 0) {
  lines.push(`All ${N} entries returned non-empty extractedFields.`);
} else {
  lines.push(`${parseFailures}/${N} entries returned empty extractedFields (possible JSON parse / network / schema-validation error):`);
  lines.push('');
  lines.push('| entryId | credentialType |');
  lines.push('|---|---|');
  for (const e of entries.filter(x => !x.extractedFields || Object.keys(x.extractedFields).length === 0)) {
    lines.push(`| ${e.entryId} | ${e.credentialType} |`);
  }
}
lines.push('');
lines.push(`## Next step`);
lines.push('');
if (allPass) {
  lines.push(`All DoD targets met. Proceed with production cutover:`);
  lines.push('');
  lines.push(`\`\`\`bash`);
  lines.push(`gcloud run services update arkova-worker --region us-central1 --project arkova1 \\`);
  lines.push(`  --update-env-vars "GEMINI_TUNED_MODEL=<v6-endpoint-path>"`);
  lines.push(`\`\`\``);
} else {
  const failed = Object.entries(DOD).filter(([, d]) => !d.pass).map(([k]) => k);
  lines.push(`Blocked on: ${failed.join(', ')}. Do NOT cut over. Keep v5-reasoning in production.`);
}
lines.push('');

const report = lines.join('\n');
console.log(report);

if (outputPath) {
  writeFileSync(outputPath, report);
  console.error(`\n[analyzer] Report written to ${outputPath}`);
}

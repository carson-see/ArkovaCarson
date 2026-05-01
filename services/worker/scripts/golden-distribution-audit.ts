#!/usr/bin/env tsx
/**
 * Golden Distribution Audit (SCRUM-1549, child of SCRUM-710).
 *
 * Reads one or more curated-golden jsonl files (vertex or chat-completions
 * format) and reports per-credentialType counts, fraud-positive count, and
 * the gap to a configurable acceptance gate (default: 5,000 rows total,
 * each type ≥30, fraud-positive ≥200).
 *
 * Pure-function core lives below; the bottom of the file has the CLI shim.
 *
 * Usage:
 *   npx tsx scripts/golden-distribution-audit.ts \
 *     --input training-data/gemini-golden-train.jsonl \
 *     --input training-data/gemini-golden-validation.jsonl \
 *     [--min-total 5000] [--min-per-type 30] [--min-fraud-positive 200] \
 *     [--json]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface GoldenRow {
  credentialType: string | null;
  fraudPositive: boolean;
}

export interface DistributionAudit {
  totalRows: number;
  unparseableRows: number;
  fraudPositive: number;
  byType: Record<string, number>;
}

export interface AcceptanceGate {
  minTotal: number;
  minPerType: number;
  minFraudPositive: number;
  expectedTypes?: string[];
}

export interface GapReport {
  audit: DistributionAudit;
  gate: AcceptanceGate;
  totalGap: number;
  fraudGap: number;
  typesUnderFloor: Array<{ type: string; count: number; deficit: number }>;
  expectedTypes: string[];
  passed: boolean;
}

export const DEFAULT_EXPECTED_CREDENTIAL_TYPES = [
  'DEGREE',
  'CERTIFICATE',
  'LICENSE',
  'TRANSCRIPT',
  'PROFESSIONAL',
  'CLE',
  'BADGE',
  'ATTESTATION',
  'FINANCIAL',
  'LEGAL',
  'INSURANCE',
  'RESUME',
  'MEDICAL',
  'MILITARY',
  'IDENTITY',
  'SEC_FILING',
  'PATENT',
  'REGULATION',
  'PUBLICATION',
  'OTHER',
] as const;

const CREDENTIAL_TYPE_RE = /"credentialType"\s*:\s*"([A-Z_]+)"/;
const CREDENTIAL_HINT_RE = /credential\s*type\s*hint\s*[:=]\s*([A-Z_]+)/i;
const FRAUD_POSITIVE_RE = /"fraudSignals"\s*:\s*\[\s*(?!\])/;

function normalizeTypes(types: string[]): string[] {
  return [...new Set(types.map((type) => type.trim().toUpperCase()).filter(Boolean))].sort();
}

function hasStructuredFraudSignals(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * Extract credentialType + fraud-positive flag from a single jsonl line.
 * Handles both vertex AI (`{contents: [{role, parts: [{text}]}]}`) and chat
 * completions (`{messages: [{role, content}]}`) shapes by flattening every
 * text payload and regex-matching. Robust to nested JSON-in-strings.
 */
export function parseGoldenLine(line: string): GoldenRow {
  if (!line.trim()) return { credentialType: null, fraudPositive: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { credentialType: null, fraudPositive: false };
  }
  const blobs: string[] = [];
  let structuredFraudPositive = false;
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.contents)) {
      for (const c of obj.contents as Array<Record<string, unknown>>) {
        if (Array.isArray(c.parts)) {
          for (const p of c.parts as Array<Record<string, unknown>>) {
            if (typeof p.text === 'string') blobs.push(p.text);
          }
        }
      }
    }
    if (Array.isArray(obj.messages)) {
      for (const m of obj.messages as Array<Record<string, unknown>>) {
        if (typeof m.content === 'string') blobs.push(m.content);
      }
    }
    if (typeof obj.credentialType === 'string') blobs.push(`"credentialType":"${obj.credentialType}"`);
    if (hasStructuredFraudSignals(obj.fraudSignals)) structuredFraudPositive = true;
    if (obj.output && typeof obj.output === 'object') {
      const out = obj.output as Record<string, unknown>;
      if (typeof out.credentialType === 'string') blobs.push(`"credentialType":"${out.credentialType}"`);
      if (hasStructuredFraudSignals(out.fraudSignals)) structuredFraudPositive = true;
    }
  }
  const full = blobs.join('\n');
  let credentialType: string | null = null;
  const m = full.match(CREDENTIAL_TYPE_RE);
  if (m) credentialType = m[1];
  if (!credentialType) {
    const m2 = full.match(CREDENTIAL_HINT_RE);
    if (m2) credentialType = m2[1].toUpperCase();
  }
  const fraudPositive = structuredFraudPositive || FRAUD_POSITIVE_RE.test(full);
  return { credentialType, fraudPositive };
}

export function auditDistribution(rows: GoldenRow[]): DistributionAudit {
  const byType: Record<string, number> = {};
  let fraudPositive = 0;
  let unparseable = 0;
  for (const r of rows) {
    if (!r.credentialType) {
      unparseable += 1;
      continue;
    }
    byType[r.credentialType] = (byType[r.credentialType] ?? 0) + 1;
    if (r.fraudPositive) fraudPositive += 1;
  }
  return { totalRows: rows.length, unparseableRows: unparseable, fraudPositive, byType };
}

export function computeGap(audit: DistributionAudit, gate: AcceptanceGate): GapReport {
  const totalGap = Math.max(0, gate.minTotal - audit.totalRows);
  const fraudGap = Math.max(0, gate.minFraudPositive - audit.fraudPositive);
  const typesUnderFloor: Array<{ type: string; count: number; deficit: number }> = [];
  const expectedTypes = normalizeTypes(gate.expectedTypes ?? [...DEFAULT_EXPECTED_CREDENTIAL_TYPES]);
  const typesToCheck = normalizeTypes([...expectedTypes, ...Object.keys(audit.byType)]);
  for (const type of typesToCheck) {
    const count = audit.byType[type] ?? 0;
    if (count < gate.minPerType) {
      typesUnderFloor.push({ type, count, deficit: gate.minPerType - count });
    }
  }
  typesUnderFloor.sort((a, b) => b.deficit - a.deficit);
  const passed = totalGap === 0 && fraudGap === 0 && typesUnderFloor.length === 0;
  return { audit, gate, totalGap, fraudGap, typesUnderFloor, expectedTypes, passed };
}

export function renderMarkdownReport(report: GapReport, sourceFiles: string[]): string {
  const { audit, gate, totalGap, fraudGap, typesUnderFloor, expectedTypes, passed } = report;
  const lines: string[] = [];
  lines.push(`# Golden Distribution Audit\n`);
  lines.push(`**Sources.** ${sourceFiles.join(', ')}\n`);
  lines.push(`**Acceptance gate.** ≥${gate.minTotal} rows, every type ≥${gate.minPerType}, fraud-positive ≥${gate.minFraudPositive}\n`);
  lines.push(`**Expected types.** ${expectedTypes.join(', ')}\n`);
  lines.push(`**Verdict.** ${passed ? 'PASSED' : 'FAILED'}\n`);
  lines.push(`## Summary\n`);
  lines.push(`| Metric | Current | Target | Gap |`);
  lines.push(`|---|---:|---:|---:|`);
  lines.push(`| Total rows | ${audit.totalRows} | ${gate.minTotal} | ${totalGap > 0 ? `+${totalGap}` : '0'} |`);
  lines.push(`| Fraud-positive entries | ${audit.fraudPositive} | ${gate.minFraudPositive} | ${fraudGap > 0 ? `+${fraudGap}` : '0'} |`);
  lines.push(`| Types under ${gate.minPerType}-sample floor | ${typesUnderFloor.length} | 0 | ${typesUnderFloor.length} |`);
  lines.push(`| Unparseable rows | ${audit.unparseableRows} | 0 | ${audit.unparseableRows} |\n`);
  const sorted = normalizeTypes([...expectedTypes, ...Object.keys(audit.byType)])
    .map((type) => [type, audit.byType[type] ?? 0] as const)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  lines.push(`## Per-type distribution\n`);
  lines.push(`| Type | Count | Status |`);
  lines.push(`|---|---:|---|`);
  for (const [type, count] of sorted) {
    const status = count >= gate.minPerType ? 'OK' : `UNDER (need +${gate.minPerType - count})`;
    lines.push(`| ${type} | ${count} | ${status} |`);
  }
  if (typesUnderFloor.length > 0) {
    lines.push(`\n## Types under floor (sorted by deficit)\n`);
    for (const t of typesUnderFloor) {
      lines.push(`- **${t.type}** — ${t.count} / ${gate.minPerType} (need +${t.deficit})`);
    }
  }
  return lines.join('\n') + '\n';
}

export function loadJsonlRows(filePath: string): GoldenRow[] {
  const raw = readFileSync(filePath, 'utf-8');
  const rows: GoldenRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    rows.push(parseGoldenLine(line));
  }
  return rows;
}

export function runAudit(
  filePaths: string[],
  gate: AcceptanceGate,
): { report: GapReport; rowCount: number } {
  const allRows: GoldenRow[] = [];
  for (const fp of filePaths) {
    allRows.push(...loadJsonlRows(fp));
  }
  const audit = auditDistribution(allRows);
  const report = computeGap(audit, gate);
  return { report, rowCount: allRows.length };
}

// ---------------------------------------------------------------------------
// CLI shim — only runs when invoked directly, not when imported by tests.
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const inputs: string[] = [];
  let minTotal = 5000;
  let minPerType = 30;
  let minFraudPositive = 200;
  const expectedTypes: string[] = [];
  let jsonOutput = false;
  let outPath: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--input') inputs.push(resolve(args[++i]));
    else if (a === '--min-total') minTotal = parseInt(args[++i], 10);
    else if (a === '--min-per-type') minPerType = parseInt(args[++i], 10);
    else if (a === '--min-fraud-positive') minFraudPositive = parseInt(args[++i], 10);
    else if (a === '--expected-type') expectedTypes.push(args[++i]);
    else if (a === '--expected-types') expectedTypes.push(...args[++i].split(','));
    else if (a === '--json') jsonOutput = true;
    else if (a === '--out') outPath = resolve(args[++i]);
  }
  if (inputs.length === 0) {
    // Local-developer default: full curated golden if it exists.
    // CI default falls back to the committed fixture (services/worker/training-data/fixtures/),
    // so the audit can always run regardless of whether the gitignored canonical file is present.
    const canonicalTrain = resolve('training-data/gemini-golden-train.jsonl');
    const canonicalValidation = resolve('training-data/gemini-golden-validation.jsonl');
    const fixture = resolve('training-data/fixtures/golden-fixture.jsonl');
    try {
      readFileSync(canonicalTrain, 'utf-8');
      inputs.push(canonicalTrain, canonicalValidation);
    } catch {
      inputs.push(fixture);
    }
  }
  const gate: AcceptanceGate = {
    minTotal,
    minPerType,
    minFraudPositive,
    ...(expectedTypes.length > 0 ? { expectedTypes } : {}),
  };
  const { report } = runAudit(inputs, gate);
  if (jsonOutput) {
    const out = JSON.stringify(report, null, 2);
    if (outPath) writeFileSync(outPath, out);
    else process.stdout.write(out + '\n');
  } else {
    const md = renderMarkdownReport(report, inputs);
    if (outPath) writeFileSync(outPath, md);
    else process.stdout.write(md);
  }
  process.exit(report.passed ? 0 : 1);
}

const invokedPath = process.argv[1] ?? '';
if (invokedPath.endsWith('golden-distribution-audit.ts') || invokedPath.endsWith('golden-distribution-audit.js')) {
  main();
}

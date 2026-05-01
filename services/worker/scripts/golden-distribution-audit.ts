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

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';

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
  unparseableGap: number;
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
const ASSISTANT_ROLES = new Set(['assistant', 'model']);
const DEFAULT_MIN_TOTAL = 5000;
const DEFAULT_MIN_PER_TYPE = 30;
const DEFAULT_MIN_FRAUD_POSITIVE = 200;

interface TextBlobs {
  outputBlobs: string[];
  promptBlobs: string[];
  structuredFraudPositive: boolean;
}

interface CliOptions {
  inputs: string[];
  gate: AcceptanceGate;
  jsonOutput: boolean;
  outPath: string | null;
}

function normalizeTypes(types: string[]): string[] {
  return [...new Set(types.map((type) => type.trim().toUpperCase()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

export function formatSourceFile(filePath: string): string {
  const relativePath = relative(process.cwd(), filePath);
  if (relativePath && !relativePath.startsWith('..')) return relativePath;
  return basename(filePath);
}

function hasStructuredFraudSignals(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function normalizedRole(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function isAssistantRole(value: unknown): boolean {
  return ASSISTANT_ROLES.has(normalizedRole(value));
}

function createTextBlobs(): TextBlobs {
  return {
    outputBlobs: [],
    promptBlobs: [],
    structuredFraudPositive: false,
  };
}

function appendPartTexts(parts: unknown, target: string[]): void {
  if (!Array.isArray(parts)) return;
  for (const part of parts) {
    if (isRecord(part) && typeof part.text === 'string') target.push(part.text);
  }
}

function collectVertexContents(contents: unknown, blobs: TextBlobs): void {
  if (!Array.isArray(contents)) return;
  for (const content of contents) {
    if (!isRecord(content)) continue;
    const target = isAssistantRole(content.role) ? blobs.outputBlobs : blobs.promptBlobs;
    appendPartTexts(content.parts, target);
  }
}

function collectChatMessages(messages: unknown, blobs: TextBlobs): void {
  if (!Array.isArray(messages)) return;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const target = isAssistantRole(message.role) ? blobs.outputBlobs : blobs.promptBlobs;
    if (typeof message.content === 'string') target.push(message.content);
  }
}

function collectStructuredOutput(obj: Record<string, unknown>, blobs: TextBlobs): void {
  if (typeof obj.credentialType === 'string') {
    blobs.outputBlobs.push(JSON.stringify({ credentialType: obj.credentialType }));
  }
  if (hasStructuredFraudSignals(obj.fraudSignals)) blobs.structuredFraudPositive = true;
  if (!isRecord(obj.output)) return;

  blobs.outputBlobs.push(JSON.stringify(obj.output));
  if (hasStructuredFraudSignals(obj.output.fraudSignals)) blobs.structuredFraudPositive = true;
}

function collectTextBlobs(parsed: unknown): TextBlobs {
  const blobs = createTextBlobs();
  if (!isRecord(parsed)) return blobs;
  collectVertexContents(parsed.contents, blobs);
  collectChatMessages(parsed.messages, blobs);
  collectStructuredOutput(parsed, blobs);
  return blobs;
}

function findCredentialType(outputText: string, fallbackText: string): string | null {
  const credentialMatch = CREDENTIAL_TYPE_RE.exec(outputText) ?? CREDENTIAL_TYPE_RE.exec(fallbackText);
  if (credentialMatch) return credentialMatch[1];

  const hintMatch = CREDENTIAL_HINT_RE.exec(fallbackText);
  return hintMatch ? hintMatch[1].toUpperCase() : null;
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
  const { outputBlobs, promptBlobs, structuredFraudPositive } = collectTextBlobs(parsed);
  const outputText = outputBlobs.join('\n');
  const fallbackText = [outputText, promptBlobs.join('\n')].filter(Boolean).join('\n');
  const credentialType = findCredentialType(outputText, fallbackText);
  const fraudPositive = structuredFraudPositive || FRAUD_POSITIVE_RE.test(outputText || fallbackText);
  return { credentialType, fraudPositive };
}

export function auditDistribution(rows: GoldenRow[]): DistributionAudit {
  const byType: Record<string, number> = {};
  let fraudPositive = 0;
  let unparseable = 0;
  for (const r of rows) {
    if (r.fraudPositive) fraudPositive += 1;
    if (!r.credentialType) {
      unparseable += 1;
      continue;
    }
    byType[r.credentialType] = (byType[r.credentialType] ?? 0) + 1;
  }
  return { totalRows: rows.length, unparseableRows: unparseable, fraudPositive, byType };
}

export function computeGap(audit: DistributionAudit, gate: AcceptanceGate): GapReport {
  const totalGap = Math.max(0, gate.minTotal - audit.totalRows);
  const fraudGap = Math.max(0, gate.minFraudPositive - audit.fraudPositive);
  const unparseableGap = audit.unparseableRows;
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
  const passed = totalGap === 0 && fraudGap === 0 && unparseableGap === 0 && typesUnderFloor.length === 0;
  return { audit, gate, totalGap, fraudGap, unparseableGap, typesUnderFloor, expectedTypes, passed };
}

export function renderMarkdownReport(report: GapReport, sourceFiles: string[]): string {
  const { audit, gate, totalGap, fraudGap, unparseableGap, typesUnderFloor, expectedTypes, passed } = report;
  const sorted = normalizeTypes([...expectedTypes, ...Object.keys(audit.byType)])
    .map((type) => [type, audit.byType[type] ?? 0] as const)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const summaryRows = [
    `| Total rows | ${audit.totalRows} | ${gate.minTotal} | ${formatGap(totalGap)} |`,
    `| Fraud-positive entries | ${audit.fraudPositive} | ${gate.minFraudPositive} | ${formatGap(fraudGap)} |`,
    `| Types under ${gate.minPerType}-sample floor | ${typesUnderFloor.length} | 0 | ${typesUnderFloor.length} |`,
    `| Unparseable rows | ${audit.unparseableRows} | 0 | ${unparseableGap} |`,
  ];
  const perTypeRows = sorted.map(([type, count]) => {
    const deficit = gate.minPerType - count;
    const status = deficit <= 0 ? 'OK' : `UNDER (need +${deficit})`;
    return `| ${type} | ${count} | ${status} |`;
  });
  const underFloorSection =
    typesUnderFloor.length === 0
      ? []
      : [
          '',
          '## Types under floor (sorted by deficit)',
          '',
          ...typesUnderFloor.map((t) => `- **${t.type}** — ${t.count} / ${gate.minPerType} (need +${t.deficit})`),
        ];

  return [
    '# Golden Distribution Audit',
    '',
    `**Sources.** ${sourceFiles.map(formatSourceFile).join(', ')}`,
    '',
    `**Acceptance gate.** ≥${gate.minTotal} rows, every type ≥${gate.minPerType}, fraud-positive ≥${gate.minFraudPositive}`,
    '',
    `**Expected types.** ${expectedTypes.join(', ')}`,
    '',
    `**Verdict.** ${passed ? 'PASSED' : 'FAILED'}`,
    '',
    '## Summary',
    '',
    '| Metric | Current | Target | Gap |',
    '|---|---:|---:|---:|',
    ...summaryRows,
    '',
    '## Per-type distribution',
    '',
    '| Type | Count | Status |',
    '|---|---:|---|',
    ...perTypeRows,
    ...underFloorSection,
    '',
  ].join('\n');
}

function formatGap(gap: number): string {
  return gap > 0 ? `+${gap}` : '0';
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

function resolveDefaultInputs(): string[] {
  const canonicalTrain = resolve('training-data/gemini-golden-train.jsonl');
  const canonicalValidation = resolve('training-data/gemini-golden-validation.jsonl');
  const fixture = resolve('training-data/fixtures/golden-fixture.jsonl');
  return existsSync(canonicalTrain) ? [canonicalTrain, canonicalValidation] : [fixture];
}

function readArgValue(args: string[], index: number): string {
  return args[index + 1] ?? '';
}

function parseCliArgs(args: string[]): CliOptions {
  const inputs: string[] = [];
  let minTotal = DEFAULT_MIN_TOTAL;
  let minPerType = DEFAULT_MIN_PER_TYPE;
  let minFraudPositive = DEFAULT_MIN_FRAUD_POSITIVE;
  const expectedTypes: string[] = [];
  let jsonOutput = false;
  let outPath: string | null = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = readArgValue(args, i);
    switch (arg) {
      case '--json':
        jsonOutput = true;
        break;
      case '--input':
        inputs.push(resolve(value));
        i += 1;
        break;
      case '--min-total':
        minTotal = Number.parseInt(value, 10);
        i += 1;
        break;
      case '--min-per-type':
        minPerType = Number.parseInt(value, 10);
        i += 1;
        break;
      case '--min-fraud-positive':
        minFraudPositive = Number.parseInt(value, 10);
        i += 1;
        break;
      case '--expected-type':
        expectedTypes.push(value);
        i += 1;
        break;
      case '--expected-types':
        expectedTypes.push(...value.split(','));
        i += 1;
        break;
      case '--out':
        outPath = resolve(value);
        i += 1;
        break;
    }
  }

  const gate: AcceptanceGate = {
    minTotal,
    minPerType,
    minFraudPositive,
    ...(expectedTypes.length > 0 ? { expectedTypes } : {}),
  };
  return {
    inputs: inputs.length > 0 ? inputs : resolveDefaultInputs(),
    gate,
    jsonOutput,
    outPath,
  };
}

// ---------------------------------------------------------------------------
// CLI shim — only runs when invoked directly, not when imported by tests.
// ---------------------------------------------------------------------------

function main(): void {
  const { inputs, gate, jsonOutput, outPath } = parseCliArgs(process.argv.slice(2));
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

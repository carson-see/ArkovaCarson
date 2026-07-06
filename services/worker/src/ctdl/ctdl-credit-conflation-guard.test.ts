/**
 * SCRUM-2375 (CE-04) — CONFLATION GUARD (lint-style test).
 *
 * "Credit" is dangerously overloaded at Arkova:
 *
 *   1. CE ContactHour credit — the CTDL `ceterms:creditValue` ValueProfile on a
 *      continuing-education credential (how many contact hours the CPE/CLE
 *      offering awards). Public, class-level credential metadata.
 *   2. Billing credits — the `credit_ledger` balance an org spends to anchor
 *      instantly (fee & credit model). Private, money-adjacent state.
 *
 * These MUST NEVER be conflated: the CTDL serializer path must not import,
 * query, or reference anything credit_ledger/billing-related, and the billing
 * ledger must never source a CTDL credit value. This test scans the actual
 * module sources so a future edit that wires the two together fails loudly.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const CTDL_DIR = path.dirname(fileURLToPath(import.meta.url));
const API_V1_DIR = path.resolve(CTDL_DIR, '..', 'api', 'v1');

/** Production sources that make up the CTDL/CE serialization + endpoint path. */
function ctdlProductionSources(): string[] {
  const ctdlFiles = fs
    .readdirSync(CTDL_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => path.join(CTDL_DIR, name));
  return [...ctdlFiles, path.join(API_V1_DIR, 'credentials-ctdl.ts')];
}

/**
 * Strip line comments and block comments so the scan sees CODE
 * only. Guard comments in the CTDL modules deliberately NAME the credit_ledger
 * distinction (that documentation is the point); only an actual import, query,
 * or identifier reference in executable code may fail this test.
 */
function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//');
      return index === -1 ? line : line.slice(0, index);
    })
    .join('\n');
}

/** Billing-ledger references that must never appear in the CTDL path. */
const BILLING_LEDGER_PATTERNS: readonly RegExp[] = [
  /credit_ledger/i,
  /creditLedger/,
  /credit_balance/i,
  /creditBalance/,
  /deductAICredits/,
  /from\s*\(\s*['"`]credits?/i, // db.from('credit...' / 'credits...')
  /billing\/(?:entitlements|credits)/, // imports from the billing module
];

describe('CE-04 conflation guard — CE ContactHour credit vs billing credit_ledger', () => {
  it('finds the expected CTDL production sources (guard is not scanning an empty set)', () => {
    const sources = ctdlProductionSources();
    expect(sources.length).toBeGreaterThanOrEqual(5);
    expect(sources.some((f) => f.endsWith('ctdl-serializer.ts'))).toBe(true);
    expect(sources.some((f) => f.endsWith('credentials-ctdl.ts'))).toBe(true);
  });

  it('CTDL serializer path never imports/queries/references the billing credit ledger', () => {
    const offenders: string[] = [];
    for (const file of ctdlProductionSources()) {
      const source = stripComments(fs.readFileSync(file, 'utf-8'));
      for (const pattern of BILLING_LEDGER_PATTERNS) {
        if (pattern.test(source)) {
          offenders.push(`${path.basename(file)} matches ${String(pattern)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('CTDL modules do not import from the billing directory at all', () => {
    const offenders: string[] = [];
    for (const file of ctdlProductionSources()) {
      const source = stripComments(fs.readFileSync(file, 'utf-8'));
      for (const line of source.split('\n')) {
        if (/^\s*import\b.*['"][^'"]*\/billing\//.test(line)) {
          offenders.push(`${path.basename(file)}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

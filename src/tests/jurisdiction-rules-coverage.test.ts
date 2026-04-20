/**
 * jurisdiction_rules coverage (NCA-FU3) — SCRUM-907
 *
 * Validates that the combined jurisdiction_rules seed across migrations
 * 0194, 0216, and 0219 meets the NCA-FU3 coverage targets:
 *   - ≥100 total rules
 *   - ≥20 distinct jurisdiction codes
 *   - ≥10 distinct industry codes
 *   - At least 1 rule for each Tier 2 regulation (BR, TH, MY, MX, CO)
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations');

const MIGRATION_FILES = [
  '0194_jurisdiction_rules.sql',
  '0216_nca01_jurisdiction_rules_expansion.sql',
  '0219_nca_fu3_tier2_regulations.sql',
];

/**
 * Parse INSERT rows from a jurisdiction_rules migration file.
 *
 * Each row in a VALUES clause looks like:
 *   ('US-CA', 'accounting', 'California CPA Requirements', ...)
 *
 * We extract jurisdiction_code (1st quoted string) and industry_code
 * (2nd quoted string) from every such line.
 */
function parseRules(sql: string): Array<{ jurisdiction: string; industry: string }> {
  const rules: Array<{ jurisdiction: string; industry: string }> = [];

  // Match lines that start a VALUES tuple: ('jurisdiction', 'industry', ...
  // The pattern captures the first two single-quoted strings on lines
  // beginning with optional whitespace followed by ('
  const rowPattern = /^\s*\('([^']+)',\s*'([^']+)'/gm;
  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(sql)) !== null) {
    rules.push({ jurisdiction: match[1], industry: match[2] });
  }

  return rules;
}

describe('jurisdiction_rules coverage (NCA-FU3)', () => {
  // Read and parse all three migration files
  const allRules: Array<{ jurisdiction: string; industry: string }> = [];

  for (const file of MIGRATION_FILES) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(filePath, 'utf8');
    allRules.push(...parseRules(sql));
  }

  const distinctJurisdictions = new Set(allRules.map((r) => r.jurisdiction));
  const distinctIndustries = new Set(allRules.map((r) => r.industry));

  it('contains ≥100 total rules across all three migrations', () => {
    expect(allRules.length).toBeGreaterThanOrEqual(100);
  });

  it('covers ≥20 distinct jurisdiction codes', () => {
    expect(distinctJurisdictions.size).toBeGreaterThanOrEqual(20);
  });

  it('covers ≥10 distinct industry codes', () => {
    expect(distinctIndustries.size).toBeGreaterThanOrEqual(10);
  });

  it('includes LGPD (BR) rules', () => {
    const brRules = allRules.filter((r) => r.jurisdiction === 'BR');
    expect(brRules.length).toBeGreaterThanOrEqual(1);
  });

  it('includes Thailand PDPA (TH) rules', () => {
    const thRules = allRules.filter((r) => r.jurisdiction === 'TH');
    expect(thRules.length).toBeGreaterThanOrEqual(1);
  });

  it('includes Malaysia PDPA (MY) rules', () => {
    const myRules = allRules.filter((r) => r.jurisdiction === 'MY');
    expect(myRules.length).toBeGreaterThanOrEqual(1);
  });

  it('includes Mexico LFPDPPP (MX) rules', () => {
    const mxRules = allRules.filter((r) => r.jurisdiction === 'MX');
    expect(mxRules.length).toBeGreaterThanOrEqual(1);
  });

  it('includes Colombia Law 1581 (CO) rules', () => {
    const coRules = allRules.filter((r) => r.jurisdiction === 'CO');
    expect(coRules.length).toBeGreaterThanOrEqual(1);
  });
});

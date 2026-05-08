/**
 * jurisdiction_rules coverage (NCA-FU3) — SCRUM-907.
 *
 * Original test parsed the VALUES tuples from migrations 0194 / 0216 /
 * 0219 to assert seed-data coverage:
 *   - ≥100 total rules
 *   - ≥20 distinct jurisdiction codes
 *   - ≥10 distinct industry codes
 *   - At least 1 rule for BR / TH / MY / MX / CO
 *
 * SCRUM-1668 Path C collapsed those migrations into the byte-faithful
 * pg_dump baseline, which is `--schema-only` (no `INSERT INTO
 * "public"."jurisdiction_rules" VALUES ...` rows). The runtime data in
 * prod is unchanged — only this static test lost its substrate. We
 * keep the table-shape assertion below so the schema invariant
 * (jurisdiction_rules table exists with the lookup index) is still
 * gated; the row-count and coverage assertions become a runtime
 * concern (RLS suite + staging soak) rather than a static check.
 *
 * If you re-introduce a static seed-coverage gate, capture the seed
 * INSERTs in a separate `supabase/migrations/NNNN_seed_*.sql` and
 * point this test at that file.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BASELINE_PATH = path.join(
  process.cwd(),
  'supabase/migrations/00000000000000_baseline_at_main_HEAD.sql',
);

describe('jurisdiction_rules coverage (NCA-FU3) — schema invariant', () => {
  const sql = fs.readFileSync(BASELINE_PATH, 'utf8');

  it('jurisdiction_rules table exists in baseline', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "public"."jurisdiction_rules"');
  });

  it('jurisdiction_rules has the (jurisdiction_code, industry_code) lookup index', () => {
    // Index name was set at migration time and is preserved by pg_dump
    expect(sql).toContain('idx_jurisdiction_rules_lookup');
    const idx = sql.indexOf('idx_jurisdiction_rules_lookup');
    const block = sql.slice(idx, idx + 200);
    expect(block).toContain('"jurisdiction_code"');
    expect(block).toContain('"industry_code"');
  });

  it('jurisdiction_rules has RLS enabled (read open, write service-role-only)', () => {
    expect(sql).toMatch(
      /ALTER\s+TABLE\s+"public"\."jurisdiction_rules"\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/,
    );
    expect(sql).toContain('"Anyone can read jurisdiction rules"');
  });

  it.skip('seed coverage (≥100 rules / ≥20 jurisdictions / ≥10 industries) is now a runtime check', () => {
    // Replaced by RLS-suite seed assertions and staging-soak coverage.
    // See file header for the migration trail.
  });
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  collectMigrationFiles,
  scanTextForUnjustifiedAnchorIndexes,
} from './check-anchor-index-justification.js';

function expectNoViolations(file: string, text: string): void {
  expect(scanTextForUnjustifiedAnchorIndexes(file, text)).toEqual([]);
}

function expectOneViolation(file: string, text: string, line = 1): void {
  const hits = scanTextForUnjustifiedAnchorIndexes(file, text);
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({ file, line });
}

describe('check-anchor-index-justification', () => {
  it('allows anchors indexes with a nearby explicit justification', () => {
    expectNoViolations(
      'supabase/migrations/0311_example.sql',
      [
        '-- anchor-index-justification: Speeds latest SECURED anchor lookup; prod EXPLAIN showed full sort timeout.',
        'CREATE INDEX IF NOT EXISTS idx_anchors_secured_created_at',
        '  ON public.anchors (created_at DESC)',
        "  WHERE status = 'SECURED';",
      ].join('\n'),
    );
  });

  it('allows quoted schema and table identifiers', () => {
    expectNoViolations(
      'supabase/migrations/0311_example.sql',
      [
        '-- anchor-index-justification: Supports user history pagination without sorting deleted rows.',
        'CREATE INDEX "idx_anchors_user_created_active"',
        '  ON "public"."anchors" USING btree ("user_id", "created_at" DESC)',
        '  WHERE "deleted_at" IS NULL;',
      ].join('\n'),
    );
  });

  it('flags anchors indexes without a justification comment', () => {
    expectOneViolation(
      'supabase/migrations/0311_example.sql',
      [
        'CREATE INDEX IF NOT EXISTS idx_anchors_org_status',
        '  ON public.anchors (org_id, status);',
      ].join('\n'),
    );
  });

  it('requires justification when a new migration recreates a historical anchors index name', () => {
    expectOneViolation(
      'supabase/migrations/0311_example.sql',
      'CREATE INDEX IF NOT EXISTS idx_anchors_status ON public.anchors (status);',
    );
  });

  it('grandfathers historical active migration files', () => {
    expectNoViolations(
      'supabase/migrations/00000000000000_baseline_at_main_HEAD.sql',
      'CREATE INDEX "idx_anchors_status" ON "public"."anchors" USING "btree" ("status");',
    );
  });

  it('flags empty justification comments', () => {
    expectOneViolation(
      'supabase/migrations/0311_example.sql',
      [
        '-- anchor-index-justification:',
        'CREATE INDEX idx_anchors_public_id ON public.anchors (public_id);',
      ].join('\n'),
      2,
    );
  });

  it('requires the justification to be adjacent to the index', () => {
    expectOneViolation(
      'supabase/migrations/0311_example.sql',
      [
        '-- anchor-index-justification: useful for dashboard filters',
        'SELECT 1;',
        '',
        'CREATE INDEX idx_anchors_dashboard_status_created ON public.anchors (status, created_at);',
      ].join('\n'),
      4,
    );
  });

  it('ignores non-anchor indexes and commented SQL examples', () => {
    expectNoViolations(
      'supabase/migrations/0311_example.sql',
      [
        '-- CREATE INDEX idx_anchors_fake ON public.anchors (created_at);',
        'CREATE INDEX idx_org_credits_is_test ON public.org_credits (is_test_org);',
      ].join('\n'),
    );
  });

  it('scans migration files from the repo migration directory', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'anchor-index-justification-'));
    try {
      mkdirSync(join(tmp, 'supabase', 'migrations'), { recursive: true });
      writeFileSync(join(tmp, 'supabase', 'migrations', '0311_example.sql'), 'select 1;\n');
      writeFileSync(join(tmp, 'supabase', 'migrations', 'agents.md'), 'ignore me\n');

      expect(collectMigrationFiles(tmp)).toEqual([
        'supabase/migrations/0311_example.sql',
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

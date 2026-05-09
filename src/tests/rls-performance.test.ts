/**
 * RLS Performance Fix Tests — SCRUM-348, 349, 350, 351, 352.
 *
 * Originally checked properties of migration 0152 directly. After
 * SCRUM-1668 Path C, that migration is collapsed into the byte-faithful
 * pg_dump baseline. The properties below now read the baseline; tests
 * that asserted comment-only or rollback-comment content from the
 * migration file are retired (the runtime properties they proxied for
 * are still asserted via the schema checks).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BASELINE_PATH = path.join(
  process.cwd(),
  'supabase/migrations/00000000000000_baseline_at_main_HEAD.sql',
);

let baselineCache: string | null = null;
function baseline(): string {
  if (baselineCache === null) {
    baselineCache = fs.readFileSync(BASELINE_PATH, 'utf8');
  }
  return baselineCache;
}

describe('SCRUM-348/349/352: RLS performance — baseline state', () => {
  it('is_current_user_platform_admin() exists as SECURITY DEFINER helper', () => {
    const sql = baseline();
    expect(sql).toContain('FUNCTION "public"."is_current_user_platform_admin"');
    const start = sql.indexOf('FUNCTION "public"."is_current_user_platform_admin"');
    const end = sql.indexOf('$$;', start) + 3;
    const block = sql.slice(start, end);
    expect(block).toContain('SECURITY DEFINER');
    expect(block).toContain('SET "search_path"');
    expect(block).toMatch(/"?is_platform_admin"?\s+FROM\s+"?profiles"?/i);
  });

  it('is_current_user_platform_admin is granted to authenticated (or ALL)', () => {
    const sql = baseline();
    // pg_dump emits either an explicit `GRANT EXECUTE ON FUNCTION ... TO authenticated`
    // or a generic `GRANT ALL ON FUNCTION ... TO authenticated`. Accept either.
    expect(sql).toMatch(
      /GRANT[^;]+ON\s+FUNCTION\s+"public"\."is_current_user_platform_admin"[^;]*TO\s+"?authenticated"?/i,
    );
  });

  it('platform admin bypass policy on anchors exists', () => {
    const sql = baseline();
    expect(sql).toContain('"anchors_select_platform_admin"');
    const idx = sql.indexOf('"anchors_select_platform_admin"');
    const block = sql.slice(idx, idx + 500);
    expect(block).toContain('is_current_user_platform_admin');
  });

  it('platform admin bypass policy on attestations exists', () => {
    const sql = baseline();
    expect(sql).toContain('"attestations_select_platform_admin"');
  });

  it('attestations_select policy uses EXISTS subquery (not IN) on anchors', () => {
    const sql = baseline();
    expect(sql).toContain('"attestations_select"');
    const idx = sql.indexOf('"attestations_select"');
    const block = sql.slice(idx, idx + 1500);
    expect(block).toMatch(/EXISTS\s*\(/i);
    // The IN pattern must not appear in the active policy
    expect(block).not.toMatch(/anchor_id\s+IN\s*\(\s*SELECT\s+id\s+FROM\s+anchors/i);
  });

  it('search_public_credentials does not run metadata::text ILIKE (was the perf killer)', () => {
    const sql = baseline();
    expect(sql).toContain('FUNCTION "public"."search_public_credentials"');
    const start = sql.indexOf('FUNCTION "public"."search_public_credentials"');
    const end = sql.indexOf('$$;', start) + 3;
    const block = sql.slice(start, end);
    expect(block).not.toMatch(/metadata::text\s+ILIKE\s+v_pattern/i);
  });

  it('search_public_credentials rejects short queries', () => {
    const sql = baseline();
    const start = sql.indexOf('FUNCTION "public"."search_public_credentials"');
    const end = sql.indexOf('$$;', start) + 3;
    const block = sql.slice(start, end);
    expect(block).toMatch(/length\s*\(\s*trim\s*\(\s*p_query\s*\)\s*\)\s*<\s*2/i);
  });

  it('idx_anchors_filename_trgm trigram index exists (introduced in 0150)', () => {
    const sql = baseline();
    expect(sql).toContain('idx_anchors_filename_trgm');
  });
});

describe('SCRUM-350: useProfile redirect race condition fix', () => {
  it('treats authenticated user with null profile as loading, not onboarding', () => {
    const profilePath = path.join(process.cwd(), 'src/hooks/useProfile.ts');
    const content = fs.readFileSync(profilePath, 'utf8');

    // The fix: when user is authenticated but profile is null, return '/auth'
    // (loading state) instead of '/onboarding/role'
    // Check that the comment explaining the fix exists
    expect(content).toContain('Fixes SCRUM-350');

    // The old pattern (profile null → onboarding) should NOT exist
    // The code should return '/auth' for null profile (not '/onboarding/role')
    const lines = content.split('\n');
    const profileNullLine = lines.findIndex((l) => l.includes('if (!profile)'));
    if (profileNullLine >= 0) {
      // The line after the null check block should return '/auth', not '/onboarding/role'
      const blockAfter = lines.slice(profileNullLine, profileNullLine + 5).join('\n');
      expect(blockAfter).toContain("'/auth'");
    }
  });
});

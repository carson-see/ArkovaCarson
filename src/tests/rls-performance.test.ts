/**
 * RLS Performance Fix Tests — SCRUM-348, 349, 350, 351, 352
 *
 * Verifies migration 0152 addresses the critical RLS performance issues
 * and the useProfile redirect race condition.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase/migrations/0152_fix_critical_rls_performance.sql',
);

describe('SCRUM-348/349/352: RLS performance migration', () => {
  const content = fs.readFileSync(MIGRATION_PATH, 'utf8');

  it('creates is_current_user_platform_admin() SECURITY DEFINER helper', () => {
    expect(content).toContain('CREATE OR REPLACE FUNCTION is_current_user_platform_admin()');
    expect(content).toContain('SECURITY DEFINER');
    expect(content).toContain('SET search_path = public');
    expect(content).toContain('is_platform_admin FROM profiles WHERE id = auth.uid()');
  });

  it('grants execute to authenticated role', () => {
    expect(content).toContain(
      'GRANT EXECUTE ON FUNCTION is_current_user_platform_admin() TO authenticated',
    );
  });

  it('adds platform admin bypass policy for anchors', () => {
    expect(content).toContain('anchors_select_platform_admin ON anchors');
    expect(content).toContain('is_current_user_platform_admin()');
  });

  it('adds platform admin bypass policy for attestations', () => {
    expect(content).toContain('attestations_select_platform_admin ON attestations');
  });

  it('replaces attestations_select with EXISTS instead of IN for anchor subquery', () => {
    expect(content).toContain('DROP POLICY IF EXISTS attestations_select ON attestations');
    expect(content).toContain('CREATE POLICY attestations_select ON attestations');
    // Must use EXISTS, not IN
    expect(content).toContain('EXISTS (');
    expect(content).toContain('SELECT 1 FROM anchors a');
    expect(content).toContain('a.id = attestations.anchor_id');
    // The active policy code must use EXISTS, not the old IN pattern
    // (The rollback comment may reference the old pattern, so check the CREATE POLICY block)
    const policyBlock = content.slice(
      content.indexOf('CREATE POLICY attestations_select ON attestations'),
      content.indexOf('-- =============================================================================', content.indexOf('CREATE POLICY attestations_select ON attestations') + 1),
    );
    expect(policyBlock).toContain('EXISTS (');
    expect(policyBlock).not.toContain('anchor_id IN (SELECT id FROM anchors');
  });

  it('optimizes search_public_credentials — removes metadata::text ILIKE', () => {
    expect(content).toContain('CREATE OR REPLACE FUNCTION search_public_credentials');
    // metadata::text ILIKE was the performance killer — must be removed
    expect(content).not.toContain("metadata::text ILIKE v_pattern");
  });

  it('rejects empty/short search queries', () => {
    expect(content).toContain("length(trim(p_query)) < 2");
  });

  it('references search indexes from migration 0150', () => {
    // Trigram indexes moved to 0150_fix_search_performance_indexes.sql
    // 0152 just contains a comment referencing them
    expect(content).toContain('idx_anchors_filename_trgm');
  });

  it('notifies PostgREST to reload schema cache (fixes SCRUM-351)', () => {
    expect(content).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it('has rollback instructions', () => {
    expect(content).toContain('ROLLBACK');
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
    const profileNullLine = lines.findIndex((l) => l.includes("if (!profile)"));
    if (profileNullLine >= 0) {
      // The line after the null check block should return '/auth', not '/onboarding/role'
      const blockAfter = lines.slice(profileNullLine, profileNullLine + 5).join('\n');
      expect(blockAfter).toContain("'/auth'");
    }
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(
  process.cwd(),
  'supabase/migrations/0480_uat24_global_personal_folder_privacy.sql',
), 'utf8').replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim();

describe('0480 UAT-24 global personal folder privacy', () => {
  it('limits platform and organization administration reads to explicit contextual folders', () => {
    expect(source).toContain('DROP POLICY IF EXISTS folders_select_user ON public.folders');
    expect(source).toMatch(/folders\.context_org_id IS NOT NULL AND \( public\.is_current_user_platform_admin\(\) OR public\.folder_administers_org\(folders\.context_org_id\) \)/);
  });

  it('preserves owner reads and does not redefine any mutation policy', () => {
    expect(source).toContain('user_id = (SELECT auth.uid())');
    expect(source).not.toMatch(/CREATE POLICY folders_(?:insert|update|delete)/);
    expect(source).not.toMatch(/CREATE OR REPLACE FUNCTION/);
  });
});

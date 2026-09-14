import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'supabase/migrations/0462_scrum5142_folder_hierarchy_authority.sql',
);

function sql(): string {
  return readFileSync(migrationPath, 'utf8')
    .replace(/--.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('0462 UAT-24 canonical folder hierarchy and authority', () => {
  it('extends the existing folders table without introducing a duplicate model', () => {
    const source = sql();
    expect(source).toContain('ALTER TABLE public.folders');
    expect(source).toContain('ADD COLUMN IF NOT EXISTS parent_folder_id uuid');
    expect(source).toContain('ADD COLUMN IF NOT EXISTS context_org_id uuid');
    expect(source).toContain('ADD COLUMN IF NOT EXISTS public_id text NOT NULL');
    expect(source).not.toMatch(/CREATE TABLE(?: IF NOT EXISTS)? public\.(?:record_folders|nested_folders)/i);
  });

  it('keeps personal admin visibility tied to an explicit organization context', () => {
    const source = sql();
    expect(source).toContain('folders.context_org_id IS NOT NULL');
    expect(source).toContain('public.folder_administers_org(folders.context_org_id)');
    expect(source).toContain('user_id = (SELECT auth.uid())');
    expect(source).toContain('profiles_select_approved_ancestor_admin');
    expect(source).toContain('anchors_select_approved_ancestor_admin');
  });

  it('allows only exact-org administrators to mutate organization folders', () => {
    const source = sql();
    expect(source).toContain('public.folder_administers_org_exact(org_id)');
    expect(source).toContain('public.folder_administers_org(folders.org_id)');
    expect(source).toContain("m.role::text IN ('owner', 'admin', 'ORG_ADMIN')");
    expect(source).not.toMatch(/m\.role IN \([^)]*ORG_ADMIN/);
  });

  it('rejects cross-owner parents and recursive cycles', () => {
    const source = sql();
    expect(source).toContain('folder parent owner must match child owner');
    expect(source).toContain('folder hierarchy cycle');
    expect(source).toMatch(/WITH RECURSIVE ancestors/i);
    expect(source).toContain('trg_enforce_folder_hierarchy');
    expect(source).toContain('pg_advisory_xact_lock');
  });

  it('binds personal records to their folder organization context and org records to exact org folders', () => {
    const source = sql();
    expect(source).toContain('f.context_org_id IS NOT NULL AND f.context_org_id IS DISTINCT FROM NEW.org_id');
    expect(source).toContain('f.org_id IS DISTINCT FROM NEW.org_id');
    expect(source).toContain('UPDATE OF folder_id, user_id, org_id ON public.anchors');
  });

  it('exposes a bounded partial-result bulk move RPC with authenticated-only execution', () => {
    const source = sql();
    expect(source).toContain('CREATE OR REPLACE FUNCTION public.bulk_move_records_to_folder');
    expect(source).toContain('cardinality(p_anchor_ids) > 100');
    expect(source).toContain("'moved'");
    expect(source).toContain("'failed'");
    expect(source).toContain('REVOKE ALL ON FUNCTION public.bulk_move_records_to_folder');
    expect(source).toContain('GRANT EXECUTE ON FUNCTION public.bulk_move_records_to_folder');
    expect(source).toContain('TO authenticated');
  });

  it('stores connector destinations on canonical folder rows with owner-scoped uniqueness', () => {
    const source = sql();
    expect(source).toContain('connector_provider');
    expect(source).toContain('connector_source_id');
    expect(source).toContain('idx_folders_connector_destination_unique');
    expect(source).toContain("connector_provider IN ('google_drive', 'docusign')");
    expect(source).toContain('TG_OP = \'INSERT\'');
    expect(source).toContain('active connector connection required');
    expect(source).toContain('route_connector_anchor_to_folder');
  });

  it('keeps service API mutations atomic and caps organization keys at their key organization', () => {
    const source = sql();
    expect(source).toContain('CREATE OR REPLACE FUNCTION public.folder_api_list');
    expect(source).toContain('CREATE OR REPLACE FUNCTION public.folder_api_bulk_move');
    expect(source).toContain('p_context_org_id IS DISTINCT FROM p_api_org_id');
    expect(source).toContain('p_api_org_id IS NOT NULL AND a.org_id=p_api_org_id');
    expect(source).toContain('p_actor_user_id IS NULL');
    expect(source).toContain('created_by_api_key_id');
    expect(source).toContain('p_api_org_id IS NOT DISTINCT FROM p_org_id');
    expect(source).toContain('IS NOT TRUE');
    expect(source).toContain('v_have_event_org boolean := false');
    expect(source).toContain("'event_org_id',CASE WHEN v_event_org_mixed THEN NULL");
    expect(source).toContain('TO service_role');
  });
});

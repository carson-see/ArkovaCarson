import { describe, expect, it } from 'vitest';
import { readMigration } from './migrations.js';

const migration = readMigration('0314_professional_education_foundations.sql');

describe('0314 professional education foundations migration', () => {
  it('adds CPE and CLE metadata columns with object-shape checks', () => {
    expect(migration).toContain("ALTER TYPE public.credential_type ADD VALUE IF NOT EXISTS 'CPE'");
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS cpe_metadata jsonb');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS cle_metadata jsonb');
    expect(migration).toContain('anchors_cpe_metadata_is_object');
    expect(migration).toContain('anchors_cle_metadata_is_object');
  });

  it('creates provider registries with RLS and service-role-only mutation', () => {
    for (const table of ['cpe_provider_registry', 'cle_provider_registry']) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(`CREATE POLICY "${table}_service_role_all"`);
      expect(migration).toContain(`GRANT ALL ON public.${table} TO service_role`);
      expect(migration).not.toMatch(new RegExp(`CREATE POLICY "[^"]+" ON public\\.${table}[^;]+TO (anon|authenticated)[^;]+FOR (INSERT|UPDATE|DELETE)`, 'i'));
      expect(migration).not.toContain(`GRANT ALL ON public.${table} TO anon`);
      expect(migration).not.toContain(`GRANT ALL ON public.${table} TO authenticated`);
    }
  });

  it('extends anchor metadata immutability to CPE and CLE columns', () => {
    expect(migration).toContain('OLD.cpe_metadata IS NOT DISTINCT FROM NEW.cpe_metadata');
    expect(migration).toContain('OLD.cle_metadata IS NOT DISTINCT FROM NEW.cle_metadata');
    expect(migration).toContain('Cannot modify cpe_metadata after anchor has been secured');
    expect(migration).toContain('Cannot modify cle_metadata after anchor has been secured');
  });
});

import { describe, expect, it } from 'vitest';
import { readMigration } from './migrations.js';

const migration = readMigration('0315_provider_registry_refresh_controls.sql');

describe('0315 provider registry refresh controls migration', () => {
  it('documents SCRUM-1949 purpose and rollback path', () => {
    expect(migration).toContain('SCRUM-1949');
    expect(migration).toContain('provider_registry.updated');
    expect(migration).toContain('-- ROLLBACK:');
    expect(migration).toContain('DROP TRIGGER IF EXISTS cpe_provider_registry_audit_refresh');
    expect(migration).toContain('DROP TRIGGER IF EXISTS cle_provider_registry_audit_refresh');
  });

  it('installs SECURITY DEFINER helpers with an explicit public search_path', () => {
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = public');
  });

  it('audits inserts and updates for both provider registries', () => {
    for (const table of ['cpe_provider_registry', 'cle_provider_registry']) {
      expect(migration).toContain(`CREATE TRIGGER ${table}_audit_refresh`);
      expect(migration).toContain(`AFTER INSERT OR UPDATE ON public.${table}`);
      expect(migration).toContain('EXECUTE FUNCTION public.audit_provider_registry_refresh()');
    }
  });

  it('captures SOC 2 evidence fields in the audit event details', () => {
    expect(migration).toContain("'provider_registry.updated'");
    expect(migration).toContain("'COMPLIANCE'");
    expect(migration).toContain("'operator_id'");
    expect(migration).toContain("'provider_name'");
    expect(migration).toContain("'fields_changed'");
    expect(migration).toContain("'old_values'");
    expect(migration).toContain("'new_values'");
    expect(migration).toContain("'last_verified_date'");
  });
});

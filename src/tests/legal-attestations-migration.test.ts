import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');

function readLegalAttestationsMigration(): string {
  const migration = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .find((file) => {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      return sql.includes('legally_binding_attestations');
    });

  if (!migration) {
    throw new Error('Missing legally_binding_attestations migration');
  }

  return fs.readFileSync(path.join(migrationsDir, migration), 'utf8');
}

describe('SCRUM-1871 legally binding attestations migration', () => {
  const sql = readLegalAttestationsMigration();

  it('creates the legal attestation foundation table with no raw document storage', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.legally_binding_attestations');
    expect(sql).toContain('attestation_id text NOT NULL');
    expect(sql).toContain("attestation_id LIKE 'ARK-ATT-%'");
    expect(sql).toContain('attestation_type text NOT NULL');
    expect(sql).toContain('attesting_org_id uuid NOT NULL');
    expect(sql).toContain('subject_credential_id uuid');
    expect(sql).toContain('attestation_statement text NOT NULL');
    expect(sql).toContain('docusign_envelope_id text');
    expect(sql).toContain('public_verification_url text');
    expect(sql).not.toMatch(/\bdocument_(content|body|bytes|base64)\b/i);
    expect(sql).not.toMatch(/\braw_(document|payload|body)\b/i);
  });

  it('pins state-machine transitions and anchored immutability in a trigger', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.enforce_legally_binding_attestation_state');
    expect(sql).toContain("OLD.status = 'draft' AND NEW.status = 'pending_notarization'");
    expect(sql).toContain("OLD.status = 'pending_notarization' AND NEW.status = 'notarized'");
    expect(sql).toContain("OLD.status = 'notarized' AND NEW.status = 'anchored'");
    expect(sql).toContain("NEW.status = 'requires_review'");
    expect(sql).toContain("OLD.status = 'anchored' AND NEW.status <> 'anchored'");
    expect(sql).toContain('legally_binding_attestations_state_machine');
  });

  it('enforces idempotency and the VERIFIED-org gate for notarized attestations', () => {
    expect(sql).toContain('idx_legally_binding_attestations_docusign_envelope_id_unique');
    expect(sql).toContain('WHERE docusign_envelope_id IS NOT NULL');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.enforce_legally_binding_attestation_org_gate');
    expect(sql).toContain("NEW.attestation_type = 'notarized'");
    expect(sql).toContain("o.verification_status = 'VERIFIED'");
  });

  it('enables RLS with org-scoped reads and writes only', () => {
    expect(sql).toContain('ALTER TABLE public.legally_binding_attestations ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE public.legally_binding_attestations FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('legally_binding_attestations_insert_org');
    expect(sql).toContain('attesting_org_id = public.get_user_org_id()');
    expect(sql).toContain('legally_binding_attestations_update_org');
    expect(sql).not.toContain('legally_binding_attestations_select_public_anchored');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON public.legally_binding_attestations TO authenticated');
    expect(sql).not.toContain('GRANT SELECT ON public.legally_binding_attestations TO anon');
    expect(sql).toContain('Public verification must be API-mediated and redacted.');
  });
});

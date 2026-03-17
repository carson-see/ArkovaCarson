/**
 * Security Tier 1 Tests — CISO Audit Findings
 *
 * Tests for:
 * - PII-01: audit_events actor_email always NULL (trigger defense)
 * - PII-02: anonymize_user_data RPC contract
 * - INJ-01: search_public_credentials parameterization
 * - RLS-02: api_keys admin-only access
 * - PII-03: cleanup_expired_data retention policy
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ===========================================================================
// PII-01: Verify audit_events PII protection
// ===========================================================================

describe('PII-01: audit_events PII protection', () => {
  it('migration 0061 creates null_audit_pii_fields trigger', () => {
    const migrationPath = path.join(
      process.cwd(),
      'supabase/migrations/0061_gdpr_pii_erasure.sql',
    );
    const content = fs.readFileSync(migrationPath, 'utf8');

    expect(content).toContain('CREATE OR REPLACE FUNCTION null_audit_actor_email()');
    expect(content).toContain('NEW.actor_email := NULL');
    expect(content).toContain('NEW.actor_ip := NULL');
    expect(content).toContain('NEW.actor_user_agent := NULL');
    expect(content).toContain('CREATE TRIGGER null_audit_pii_fields');
  });

  it('migration 0061 anonymizes all existing actor_email values', () => {
    const migrationPath = path.join(
      process.cwd(),
      'supabase/migrations/0061_gdpr_pii_erasure.sql',
    );
    const content = fs.readFileSync(migrationPath, 'utf8');

    expect(content).toContain('UPDATE audit_events');
    expect(content).toContain('SET actor_email = NULL');
  });

  it('client-side auditLog.ts never sends actor_email', () => {
    const auditLogPath = path.join(process.cwd(), 'src/lib/auditLog.ts');
    const content = fs.readFileSync(auditLogPath, 'utf8');

    // Should NOT contain actor_email in the insert
    expect(content).not.toMatch(/actor_email\s*:/);
    // Should contain the GDPR comment
    expect(content).toContain('GDPR Art. 5(1)(c)');
    // Should only use actor_id
    expect(content).toContain('actor_id: user?.id');
  });
});

// ===========================================================================
// PII-02: Right-to-erasure infrastructure
// ===========================================================================

describe('PII-02: Right-to-erasure infrastructure', () => {
  it('migration 0061 creates anonymize_user_data() SECURITY DEFINER RPC', () => {
    const migrationPath = path.join(
      process.cwd(),
      'supabase/migrations/0061_gdpr_pii_erasure.sql',
    );
    const content = fs.readFileSync(migrationPath, 'utf8');

    expect(content).toContain('CREATE OR REPLACE FUNCTION anonymize_user_data(p_user_id uuid)');
    expect(content).toContain('SECURITY DEFINER');
    expect(content).toContain('SET search_path = public');
    // Must be service_role only
    expect(content).toContain("auth.role() != 'service_role'");
    expect(content).toContain('REVOKE ALL ON FUNCTION anonymize_user_data(uuid) FROM authenticated');
  });

  it('migration 0065 adds deleted_at to profiles', () => {
    const migrationPath = path.join(
      process.cwd(),
      'supabase/migrations/0065_account_deletion.sql',
    );
    const content = fs.readFileSync(migrationPath, 'utf8');

    expect(content).toContain('ALTER TABLE profiles');
    expect(content).toContain('deleted_at timestamptz');
    expect(content).toContain('profiles_hide_deleted');
    expect(content).toContain('AS RESTRICTIVE');
    expect(content).toContain('deleted_at IS NULL');
  });

  it('migration 0065 creates delete_own_account() RPC', () => {
    const migrationPath = path.join(
      process.cwd(),
      'supabase/migrations/0065_account_deletion.sql',
    );
    const content = fs.readFileSync(migrationPath, 'utf8');

    expect(content).toContain('CREATE OR REPLACE FUNCTION delete_own_account()');
    expect(content).toContain('SECURITY DEFINER');
    expect(content).toContain("'ACCOUNT_DELETED'");
    expect(content).toContain("'gdpr_article', '17'");
  });

  it('account-delete worker endpoint exists', () => {
    const endpointPath = path.join(
      process.cwd(),
      'services/worker/src/api/account-delete.ts',
    );
    const content = fs.readFileSync(endpointPath, 'utf8');

    expect(content).toContain('handleAccountDelete');
    expect(content).toContain('anonymize_user_data');
    expect(content).toContain('deleted_at');
    expect(content).toContain('auth.admin.deleteUser');
  });

  it('DeleteAccountDialog component exists', () => {
    const componentPath = path.join(
      process.cwd(),
      'src/components/auth/DeleteAccountDialog.tsx',
    );
    const content = fs.readFileSync(componentPath, 'utf8');

    expect(content).toContain('DeleteAccountDialog');
    expect(content).toContain('CONFIRMATION_TEXT');
    expect(content).toContain('workerFetch');
    expect(content).toContain('/api/account');
  });
});

// ===========================================================================
// INJ-01: PostgREST injection prevention
// ===========================================================================

describe('INJ-01: PostgREST injection prevention', () => {
  it('migration 0062 creates search_public_credentials() with parameterized query', () => {
    const migrationPath = path.join(
      process.cwd(),
      'supabase/migrations/0062_security_hardening_high.sql',
    );
    const content = fs.readFileSync(migrationPath, 'utf8');

    expect(content).toContain('CREATE OR REPLACE FUNCTION search_public_credentials');
    expect(content).toContain('p_query text');
    expect(content).toContain('SECURITY DEFINER');
    expect(content).toContain('SET search_path = public');
    // Uses ILIKE with parameter binding, not string interpolation
    expect(content).toContain('ILIKE v_pattern');
    // Clamps limit
    expect(content).toContain('LEAST(GREATEST');
  });

  it('mcp-tools.ts uses RPC instead of raw URL interpolation', () => {
    const mcpToolsPath = path.join(
      process.cwd(),
      'services/edge/src/mcp-tools.ts',
    );
    const content = fs.readFileSync(mcpToolsPath, 'utf8');

    // Should call the RPC endpoint
    expect(content).toContain('rpc/search_public_credentials');
    // Should sanitize LIKE wildcards
    expect(content).toContain(String.raw`replace(/[%_\\]/g`);
    // Should NOT contain direct PostgREST filter interpolation
    expect(content).not.toContain('anchors?title=ilike');
    expect(content).not.toContain('anchors?or=');
  });
});

// ===========================================================================
// RLS-01: GRANT to authenticated
// ===========================================================================

describe('RLS-01: GRANT to authenticated on 13 tables', () => {
  it('migration 0062 grants access to all 13 tables', () => {
    const migrationPath = path.join(
      process.cwd(),
      'supabase/migrations/0062_security_hardening_high.sql',
    );
    const content = fs.readFileSync(migrationPath, 'utf8');

    const expectedTables = [
      'credential_templates',
      'memberships',
      'verification_events',
      'institution_ground_truth',
      'anchor_recipients',
      'credits',
      'credit_transactions',
      'api_keys',
      'api_key_usage',
      'ai_credits',
      'ai_usage_events',
      'credential_embeddings',
      'invitations',
    ];

    for (const table of expectedTables) {
      expect(content).toContain(`ON ${table} TO authenticated`);
    }
  });
});

// ===========================================================================
// RLS-02: api_keys admin-only
// ===========================================================================

describe('RLS-02: api_keys admin-only access', () => {
  it('migration 0062 restricts api_keys SELECT to ORG_ADMIN', () => {
    const migrationPath = path.join(
      process.cwd(),
      'supabase/migrations/0062_security_hardening_high.sql',
    );
    const content = fs.readFileSync(migrationPath, 'utf8');

    expect(content).toContain('DROP POLICY IF EXISTS api_keys_select ON api_keys');
    expect(content).toContain('CREATE POLICY api_keys_select ON api_keys');
    expect(content).toContain("'ORG_ADMIN'");
  });

  it('migration 0062 restricts api_key_usage SELECT to ORG_ADMIN', () => {
    const migrationPath = path.join(
      process.cwd(),
      'supabase/migrations/0062_security_hardening_high.sql',
    );
    const content = fs.readFileSync(migrationPath, 'utf8');

    expect(content).toContain('DROP POLICY IF EXISTS api_key_usage_select ON api_key_usage');
    expect(content).toContain('CREATE POLICY api_key_usage_select ON api_key_usage');
  });
});

// ===========================================================================
// PII-03: Data retention
// ===========================================================================

describe('PII-03: Data retention policy', () => {
  it('migration 0062 creates cleanup_expired_data() with retention windows', () => {
    const migrationPath = path.join(
      process.cwd(),
      'supabase/migrations/0062_security_hardening_high.sql',
    );
    const content = fs.readFileSync(migrationPath, 'utf8');

    expect(content).toContain('CREATE OR REPLACE FUNCTION cleanup_expired_data()');
    expect(content).toContain('SECURITY DEFINER');
    // Retention windows
    expect(content).toContain("'90 days'");
    expect(content).toContain("'1 year'");
    expect(content).toContain("'2 years'");
    // Legal hold protection
    expect(content).toContain('legal_hold = true');
    // Service-role only
    expect(content).toContain("auth.role() != 'service_role'");
    expect(content).toContain('REVOKE ALL ON FUNCTION cleanup_expired_data() FROM authenticated');
  });

  it('worker cron job is configured for daily retention cleanup', () => {
    const indexPath = path.join(
      process.cwd(),
      'services/worker/src/index.ts',
    );
    const content = fs.readFileSync(indexPath, 'utf8');

    expect(content).toContain('cleanup_expired_data');
    expect(content).toContain('0 2 * * *');
  });
});

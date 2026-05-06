/**
 * SEC-009: View SECURITY INVOKER Audit
 * SEC-010: SSRF via HTTP Extension Prevention
 *
 * Static tests verifying migration 0112 includes the required security fixes.
 */

import { describe, it, expect } from 'vitest';
import { readMigration } from '../utils/migrations.js';

const migration = readMigration('0112_security_view_invoker_ssrf.sql');

describe('SEC-009: View SECURITY INVOKER', () => {
  it('migration 0112 recreates views with security_invoker = true', () => {
    expect(migration).toContain('security_invoker = true');
    expect(migration).toContain('pg_views');
    expect(migration).toContain("schemaname = 'public'");
  });
});

describe('SEC-010: SSRF via HTTP Extension', () => {
  it('migration 0112 revokes http_get from anon and authenticated', () => {
    expect(migration).toContain('REVOKE ALL ON FUNCTION http_get(text) FROM anon, authenticated');
  });

  it('migration 0112 revokes http_post from anon and authenticated', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION http_post(text, text) FROM anon, authenticated',
    );
  });

  it('migration 0112 revokes http_delete, http_put, http_head', () => {
    expect(migration).toContain('http_delete');
    expect(migration).toContain('http_put');
    expect(migration).toContain('http_head');
  });

  it('migration 0112 has rollback instructions', () => {
    expect(migration).toContain('ROLLBACK');
  });
});

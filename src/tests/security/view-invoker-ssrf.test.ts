/**
 * SEC-009: View SECURITY INVOKER Audit
 * SEC-010: SSRF via HTTP Extension Prevention
 *
 * Static tests verifying migration 0112 includes the required security fixes.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

function migrationPath(name: string): string {
  const livePath = path.join(process.cwd(), 'supabase/migrations', name);
  if (fs.existsSync(livePath)) return livePath;
  return path.join(process.cwd(), 'docs/migrations-archive', name);
}

const MIGRATION_PATH = migrationPath('0112_security_view_invoker_ssrf.sql');

describe('SEC-009: View SECURITY INVOKER', () => {
  it('migration 0112 recreates views with security_invoker = true', () => {
    const content = fs.readFileSync(MIGRATION_PATH, 'utf8');
    expect(content).toContain('security_invoker = true');
    expect(content).toContain('pg_views');
    expect(content).toContain("schemaname = 'public'");
  });
});

describe('SEC-010: SSRF via HTTP Extension', () => {
  it('migration 0112 revokes http_get from anon and authenticated', () => {
    const content = fs.readFileSync(MIGRATION_PATH, 'utf8');
    expect(content).toContain('REVOKE ALL ON FUNCTION http_get(text) FROM anon, authenticated');
  });

  it('migration 0112 revokes http_post from anon and authenticated', () => {
    const content = fs.readFileSync(MIGRATION_PATH, 'utf8');
    expect(content).toContain('REVOKE ALL ON FUNCTION http_post(text, text) FROM anon, authenticated');
  });

  it('migration 0112 revokes http_delete, http_put, http_head', () => {
    const content = fs.readFileSync(MIGRATION_PATH, 'utf8');
    expect(content).toContain('http_delete');
    expect(content).toContain('http_put');
    expect(content).toContain('http_head');
  });

  it('migration 0112 has rollback instructions', () => {
    const content = fs.readFileSync(MIGRATION_PATH, 'utf8');
    expect(content).toContain('ROLLBACK');
  });
});

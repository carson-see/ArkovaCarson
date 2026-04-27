/**
 * SCRUM-1187 (AUDIT-06) — payment_ledger view must run as SECURITY INVOKER.
 *
 * The Supabase advisor `security_definer_view` is ERROR-level. PG15+ views
 * default to SECURITY DEFINER, which bypasses RLS on the underlying tables.
 * Migration 0160 already restricted GRANT-level access to service_role +
 * the platform-admin wrapper, but the view itself still runs with creator
 * privileges. We pin it to SECURITY INVOKER so the underlying RLS policies
 * govern the read.
 *
 * Static check: at least one migration must run either
 *   ALTER VIEW payment_ledger SET (security_invoker = true)
 * or recreate the view with
 *   CREATE [OR REPLACE] VIEW payment_ledger WITH (security_invoker = true) AS …
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('SCRUM-1187 (AUDIT-06): payment_ledger view is SECURITY INVOKER', () => {
  const dir = path.join(process.cwd(), 'supabase/migrations');
  const allSql = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');

  it('payment_ledger view has security_invoker = true', () => {
    const alter = /ALTER\s+VIEW\s+(?:public\.)?payment_ledger\s+SET\s*\(\s*security_invoker\s*=\s*true\s*\)/i;
    const createWith =
      /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+(?:public\.)?payment_ledger\s+WITH\s*\(\s*security_invoker\s*=\s*true\s*\)/i;
    expect(
      alter.test(allSql) || createWith.test(allSql),
      'payment_ledger view must be made SECURITY INVOKER (Supabase advisor security_definer_view, ERROR)',
    ).toBe(true);
  });
});

/**
 * Coverage for the SCRUM-1278 bare-`auth.uid()` linter.
 *
 * The rule is about ONE thing: an `auth.uid()` that Postgres re-evaluates
 * once per candidate row. That is what turned a 1.4M-row `anchors` scan into
 * a 60s+ query in the 2026-04-25 outage (R0-1 retro), and wrapping it as
 * `(SELECT auth.uid())` lets the planner hoist it into an initplan.
 *
 * The linter used to be a bare regex over raw file text, so it also reported
 * three shapes that cannot re-evaluate per row. PR #2572 hit all three at
 * once: 16 findings across migrations 0429–0432, which between them contain
 * zero `CREATE POLICY` statements. These tests pin each shape so the scan
 * cannot regress back to matching prose.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  scanFiles,
  maskNonCode,
  isAssignmentRhs,
  migrationPrefix,
  FIRST_ENFORCED_PREFIX,
  SKIPPED_FILES,
} from './check-rls-auth-uid-wrap';

const M = (n: string) => `supabase/migrations/${n}`;

function findings(name: string, body: string) {
  return scanFiles([{ name, body }]).map((f) => `${f.line}:${f.context}`);
}

describe('maskNonCode', () => {
  it('preserves length and newlines so line numbers stay truthful', () => {
    const sql = "SELECT 1; -- auth.uid()\nSELECT 2;\n";
    const masked = maskNonCode(sql);
    expect(masked).toHaveLength(sql.length);
    expect(masked.split('\n')).toHaveLength(sql.split('\n').length);
  });

  it('blanks a trailing -- comment but keeps the code before it', () => {
    const masked = maskNonCode("v := p_caller;   -- was auth.uid()");
    expect(masked).toContain('v := p_caller;');
    expect(masked).not.toContain('auth.uid()');
  });

  it('blanks single-quoted string literals', () => {
    const masked = maskNonCode("COMMENT ON FUNCTION f IS 'because auth.uid() is NULL';");
    expect(masked).not.toContain('auth.uid()');
    expect(masked).toContain('COMMENT ON FUNCTION f IS');
  });

  it("does not desync on a '' escape inside a string", () => {
    const masked = maskNonCode("SELECT 'it''s fine'; SELECT auth.uid();");
    expect(masked).toContain('auth.uid()');
  });

  it('blanks nested block comments', () => {
    const masked = maskNonCode('/* outer /* inner auth.uid() */ still comment */ SELECT 1;');
    expect(masked).not.toContain('auth.uid()');
    expect(masked).toContain('SELECT 1;');
  });

  it('keeps dollar-quoted function bodies as code (that is where policy helpers live)', () => {
    const masked = maskNonCode('AS $function$ BEGIN RETURN auth.uid(); END $function$');
    expect(masked).toContain('auth.uid()');
  });
});

describe('isAssignmentRhs', () => {
  it('is true for a DECLARE-block hoist', () => {
    const code = '  v_caller uuid := auth.uid();';
    expect(isAssignmentRhs(code, code.indexOf('auth.uid()'))).toBe(true);
  });

  it('is false for a policy predicate on the same shape of line', () => {
    const code = '  USING (user_id = auth.uid());';
    expect(isAssignmentRhs(code, code.indexOf('auth.uid()'))).toBe(false);
  });
});

describe('scanFiles — what it MUST still flag', () => {
  it('flags a bare call in a CREATE POLICY USING predicate', () => {
    expect(
      findings(M('0500_x.sql'), 'CREATE POLICY p ON t USING (owner = auth.uid());'),
    ).toEqual(['1:CREATE POLICY p ON t USING (owner = auth.uid());']);
  });

  it('flags a bare call in a WITH CHECK predicate', () => {
    expect(findings(M('0500_x.sql'), 'CREATE POLICY p ON t WITH CHECK (owner = auth.uid());')).toHaveLength(1);
  });

  it('flags a bare call inlined in a dollar-quoted helper body', () => {
    const sql = [
      'CREATE FUNCTION owns(r uuid) RETURNS boolean AS $$',
      '  SELECT r IN (SELECT id FROM m WHERE user_id = auth.uid());',
      '$$ LANGUAGE sql STABLE;',
    ].join('\n');
    expect(findings(M('0500_x.sql'), sql)).toHaveLength(1);
  });

  it('does not flag an already-wrapped call', () => {
    expect(findings(M('0500_x.sql'), 'CREATE POLICY p ON t USING (owner = (SELECT auth.uid()));')).toEqual([]);
  });
});

describe('scanFiles — the three PR #2572 false-positive shapes', () => {
  it('does not flag a TRAILING comment (the old skip only caught line-leading --)', () => {
    const sql = '  v_caller         uuid := p_caller_user_id;   -- 0430: was auth.uid()';
    expect(findings(M('0430_suborg_credit_rpc_caller_identity.sql'), sql)).toEqual([]);
  });

  it('does not flag prose inside a COMMENT ON string literal', () => {
    const sql =
      "COMMENT ON FUNCTION public.allocate_credits_to_sub_org(uuid) IS\n" +
      "  'SCRUM-3865: worker-callable overload taking an explicit caller id, because auth.uid() is NULL under the worker service_role client.';";
    expect(findings(M('0430_suborg_credit_rpc_caller_identity.sql'), sql)).toEqual([]);
  });

  it('does not flag a PL/pgSQL assignment — it runs once per call, not per row', () => {
    const sql = ['AS $function$', 'DECLARE', '  v_caller        uuid := auth.uid();', 'BEGIN', '  RETURN v_caller;', 'END', '$function$'].join('\n');
    expect(findings(M('0431_suborg_suspension_audit_fix_and_caller_identity.sql'), sql)).toEqual([]);
  });

  it('reports zero findings for a file with no CREATE POLICY and only those shapes', () => {
    const sql = [
      'AS $function$',
      'DECLARE',
      '  v_caller        uuid := auth.uid();',
      '  v_other         uuid := p_caller_user_id;   -- 0431: was auth.uid()',
      'BEGIN',
      '  RETURN v_caller;',
      'END',
      '$function$;',
      "COMMENT ON FUNCTION f() IS 'because auth.uid() is NULL under service_role';",
    ].join('\n');
    expect(scanFiles([{ name: M('0432_suborg_rpc_role_enum_coercion_fix.sql'), body: sql }])).toEqual([]);
  });

  it('still flags a real policy predicate sitting in the same file as those shapes', () => {
    const sql = [
      'DECLARE',
      '  v_caller uuid := auth.uid();   -- hoisted, fine',
      'CREATE POLICY p ON t USING (owner = auth.uid());',
    ].join('\n');
    expect(findings(M('0432_x.sql'), sql)).toEqual(['3:CREATE POLICY p ON t USING (owner = auth.uid());']);
  });
});

describe('file-level exemptions are unchanged', () => {
  it('skips migrations below the first enforced prefix', () => {
    expect(FIRST_ENFORCED_PREFIX).toBe(280);
    expect(findings(M('0279_old.sql'), 'CREATE POLICY p ON t USING (o = auth.uid());')).toEqual([]);
    expect(findings(M('0280_rls_auth_uid_subquery_wrap.sql'), 'CREATE POLICY p ON t USING (o = auth.uid());')).toEqual([]);
  });

  it('keeps the four historical file exemptions', () => {
    expect([...SKIPPED_FILES].sort()).toEqual([
      'supabase/migrations/00000000000000_baseline_at_main_HEAD.sql',
      'supabase/migrations/0280_rls_auth_uid_subquery_wrap.sql',
      'supabase/migrations/0398_fix_audit_events_actor_email_dropped_column.sql',
      // 0481: applied to prod as-is on 2026-09-20 before PR #3033 merged. Its
      // text is immutable, so the exemption is permanent; migration 0490 is the
      // compensating initplan wrap that replaces the five calls at runtime.
      'supabase/migrations/0481_uat14_profile_brand_media.sql',
    ]);
  });

  it('0481 still carries exactly the five bare calls that 0490 compensates for', () => {
    // Read the real file and scan it under a NON-skipped name: if someone edits
    // 0481 (forbidden — it is live on prod) or the scanner stops seeing helper
    // bodies, this count moves and the 0490 rationale is no longer true.
    const body = readFileSync(resolve(__dirname, '..', '..', M('0481_uat14_profile_brand_media.sql')), 'utf8');
    const hits = findings(M('0481_as_if_not_skipped.sql'), body);
    expect(hits).toHaveLength(5);
    expect(hits.filter((h) => h.includes('can_read') || h.includes('can_write'))).toEqual([]);
    expect(hits.map((h) => h.split(':')[0])).toEqual(['42', '52', '64', '67', '71']);
  });

  it('0490 (the compensating wrap for 0481) has zero bare calls and is NOT exempted', () => {
    const name = M('0490_wrap_auth_uid_profile_media_helpers.sql');
    expect(SKIPPED_FILES.has(name)).toBe(false);
    const body = readFileSync(resolve(__dirname, '..', '..', name), 'utf8');
    expect(findings(name, body)).toEqual([]);
    // The wrap must actually be present in code, not just absent from findings:
    // five wrapped occurrences, matching 0481's five bare ones.
    const code = maskNonCode(body);
    expect(code.match(/\(SELECT auth\.uid\(\)\)/g)).toHaveLength(5);
  });

  it('parses the numeric prefix out of a migration path', () => {
    expect(migrationPrefix(M('0429_suborg_tenancy_foundations.sql'))).toBe(429);
    expect(migrationPrefix('scripts/ci/whatever.ts')).toBeNull();
  });
});

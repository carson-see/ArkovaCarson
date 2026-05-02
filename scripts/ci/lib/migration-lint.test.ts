import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadMigrations,
  stripDollarQuoted,
  stripSqlComments,
  stripSqlCommentsAndStringLiterals,
} from './migration-lint';

function newlineCount(text: string): number {
  return (text.match(/\n/g) ?? []).length;
}

describe('stripDollarQuoted', () => {
  it('strips anonymous dollar-quoted blocks while preserving newlines', () => {
    const sql = `CREATE TABLE before_it(id int);
DO $$
BEGIN
  EXECUTE 'CREATE VIEW public.dynamic AS SELECT 1';
END $$;
CREATE TABLE after_it(id int);`;

    const stripped = stripDollarQuoted(sql);

    expect(stripped).not.toContain('CREATE VIEW public.dynamic');
    expect(stripped).toContain('CREATE TABLE before_it');
    expect(stripped).toContain('CREATE TABLE after_it');
    expect(newlineCount(stripped)).toBe(newlineCount(sql));
  });

  it('strips tagged dollar-quoted blocks', () => {
    const sql = `$body$
BEGIN
  RAISE NOTICE 'CREATE VIEW public.dynamic AS SELECT 1';
END
$body$;`;

    const stripped = stripDollarQuoted(sql);

    expect(stripped).not.toContain('CREATE VIEW public.dynamic');
    expect(newlineCount(stripped)).toBe(newlineCount(sql));
  });

  it('strips adjacent dollar-quoted blocks independently', () => {
    const sql = `DO $$CREATE VIEW public.first AS SELECT 1$$;
DO $body$CREATE VIEW public.second AS SELECT 2$body$;`;

    const stripped = stripDollarQuoted(sql);

    expect(stripped).not.toContain('public.first');
    expect(stripped).not.toContain('public.second');
    expect(newlineCount(stripped)).toBe(newlineCount(sql));
  });

  it('accepts tags containing underscores and digits after the first character', () => {
    const sql = `$tag_1$
SELECT 'CREATE VIEW public.dynamic AS SELECT 1';
$tag_1$;`;

    const stripped = stripDollarQuoted(sql);

    expect(stripped).not.toContain('CREATE VIEW public.dynamic');
    expect(newlineCount(stripped)).toBe(newlineCount(sql));
  });
});

describe('stripSqlComments', () => {
  it('strips line and block comments while preserving newlines', () => {
    const sql = `-- CREATE POLICY fake_policy ON public.audit_events
CREATE TABLE public.audit_events(id uuid);
/* ALTER VIEW public.audit_summary SET (security_invoker = true); */
CREATE POLICY real_policy ON public.audit_events USING (true);`;

    const stripped = stripSqlComments(sql);

    expect(stripped).not.toContain('fake_policy');
    expect(stripped).not.toContain('audit_summary');
    expect(stripped).toContain('CREATE TABLE public.audit_events');
    expect(stripped).toContain('CREATE POLICY real_policy');
    expect(newlineCount(stripped)).toBe(newlineCount(sql));
  });

  it('does not treat comment markers inside quoted strings or identifiers as comments', () => {
    const sql = `COMMENT ON TABLE public.quarantine IS 'Deny-all by design -- no user access';
CREATE TABLE public."/*not_a_comment*/"(id int);`;

    const stripped = stripSqlComments(sql);

    expect(stripped).toContain("'Deny-all by design -- no user access'");
    expect(stripped).toContain('"/*not_a_comment*/"');
    expect(newlineCount(stripped)).toBe(newlineCount(sql));
  });

  it('strips nested block comments like PostgreSQL does', () => {
    const sql = `/* outer comment
  /* nested fake SQL */
  CREATE POLICY fake_policy ON public.audit_events USING (true);
*/
CREATE POLICY real_policy ON public.audit_events USING (true);`;

    const stripped = stripSqlComments(sql);

    expect(stripped).not.toContain('fake_policy');
    expect(stripped).toContain('CREATE POLICY real_policy');
    expect(newlineCount(stripped)).toBe(newlineCount(sql));
  });
});

describe('stripSqlCommentsAndStringLiterals', () => {
  it('strips string-literal contents after removing comments', () => {
    const sql = `-- CREATE POLICY fake_policy ON public.audit_events
SELECT 'CREATE POLICY fake_policy ON public.audit_events';
CREATE POLICY real_policy ON public.audit_events USING (true);`;

    const stripped = stripSqlCommentsAndStringLiterals(sql);

    expect(stripped).not.toContain('fake_policy');
    expect(stripped).toContain("SELECT '");
    expect(stripped).toContain('CREATE POLICY real_policy');
    expect(newlineCount(stripped)).toBe(newlineCount(sql));
  });
});

describe('loadMigrations', () => {
  it('fails closed when the migrations directory is missing', () => {
    const missingDir = join(tmpdir(), `arkova-missing-migrations-${Date.now()}`);

    expect(() => loadMigrations(missingDir)).toThrow(
      /Migrations directory not found: .*Manual RLS\/view scans must cover \*\*\/\*\.\{ts,tsx,js,jsx,sql\}/,
    );
  });

  it('loads sql migrations sorted while skipping scratchpad files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arkova-migrations-'));
    try {
      writeFileSync(join(dir, '0002_second.sql'), 'select 2;');
      writeFileSync(join(dir, '_scratch.sql'), 'select 999;');
      writeFileSync(join(dir, '0001_first.sql'), 'DO $$ SELECT 1; $$;');

      const migrations = loadMigrations(dir);

      expect(migrations.map((migration) => migration.file)).toEqual(['0001_first.sql', '0002_second.sql']);
      expect(migrations[0].sql).toContain('SELECT 1');
      expect(migrations[0].stripped).not.toContain('SELECT 1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** SCRUM-5145: forward-only restoration of auth.users trigger wiring. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dbUrl = process.env.UAT17_DATABASE_URL
  ?? process.env.UAT03_DATABASE_URL
  ?? 'postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres';
const fixtureUrl = new URL(dbUrl);
const socketHost = fixtureUrl.searchParams.get('host');
if (!['postgres:', 'postgresql:'].includes(fixtureUrl.protocol)
  || !(socketHost === '/tmp' || ['127.0.0.1', 'localhost', '[::1]'].includes(fixtureUrl.hostname))
  || !(socketHost === '/tmp' || ['54322', '55503', '15422', '16422', '17422', '18422', '19422'].includes(fixtureUrl.port))) {
  throw new Error('Auth trigger restoration regression requires an owned loopback PostgreSQL fixture');
}

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0459_scrum5145_restore_auth_user_triggers.sql'),
  'utf8',
).replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');

const setup = `
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE TABLE IF NOT EXISTS auth.users (
    id uuid PRIMARY KEY,
    email text,
    email_confirmed_at timestamptz
  );
  DO $setup$
  BEGIN
    IF to_regprocedure('public.create_profile_for_new_user()') IS NULL THEN
      EXECUTE 'CREATE FUNCTION public.create_profile_for_new_user() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RETURN NEW; END $body$';
    END IF;
    IF to_regprocedure('public.handle_auth_user_email_verified_org_join()') IS NULL THEN
      EXECUTE 'CREATE FUNCTION public.handle_auth_user_email_verified_org_join() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RETURN NEW; END $body$';
    END IF;
  END
  $setup$;
`;

function sql(body: string) {
  try {
    return execFileSync('psql', ['-X', dbUrl, '-v', 'ON_ERROR_STOP=1', '-At'], {
      input: `BEGIN; ${body}; ROLLBACK;`,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    const primaryError = stderr.match(/^ERROR:[ \t]+([^\r\n]+)/m)?.[1];
    throw new Error(primaryError || stderr.split(/\r?\n/, 1)[0] || 'PostgreSQL fixture command failed');
  }
}

describe('SCRUM-5145 auth.users trigger restoration', () => {
  it('creates both canonical triggers when a fresh replay omitted them', () => {
    const output = sql(`${setup}
      DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
      DROP TRIGGER IF EXISTS zz_auth_user_auto_associate_org ON auth.users;
      ${migration}
      SELECT jsonb_agg(jsonb_build_object(
        'name',t.tgname,
        'function',t.tgfoid::regprocedure::text,
        'enabled',t.tgenabled,
        'type',t.tgtype
      ) ORDER BY t.tgname)
      FROM pg_trigger t
      WHERE t.tgrelid='auth.users'::regclass
        AND t.tgname IN ('on_auth_user_created','zz_auth_user_auto_associate_org')`);

    expect(output).toContain('on_auth_user_created');
    expect(output).toContain('create_profile_for_new_user()');
    expect(output).toContain('zz_auth_user_auto_associate_org');
    expect(output).toContain('handle_auth_user_email_verified_org_join()');
    expect(output).toContain('"type": 5');
    expect(output).toContain('"type": 21');
    expect(output.match(/"enabled": "O"/g)).toHaveLength(2);
  });

  it('preserves the OID and definition of existing canonical triggers', () => {
    const output = sql(`${setup}
      DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
      DROP TRIGGER IF EXISTS zz_auth_user_auto_associate_org ON auth.users;
      CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
        FOR EACH ROW EXECUTE FUNCTION public.create_profile_for_new_user();
      CREATE TRIGGER zz_auth_user_auto_associate_org
        AFTER INSERT OR UPDATE OF email_confirmed_at, email ON auth.users
        FOR EACH ROW EXECUTE FUNCTION public.handle_auth_user_email_verified_org_join();
      CREATE TEMP TABLE before_triggers AS
        SELECT tgname,oid,tgfoid,pg_get_triggerdef(oid) AS definition
        FROM pg_trigger
        WHERE tgrelid='auth.users'::regclass
          AND tgname IN ('on_auth_user_created','zz_auth_user_auto_associate_org');
      ${migration}
      SELECT bool_and(b.oid=t.oid AND b.tgfoid=t.tgfoid AND b.definition=pg_get_triggerdef(t.oid))
      FROM before_triggers b JOIN pg_trigger t USING(tgname)`);

    expect(output).toContain('\nt\n');
  });

  it('fails closed instead of replacing a divergent same-name trigger', () => {
    expect(() => sql(`${setup}
      DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
      CREATE TRIGGER on_auth_user_created AFTER UPDATE ON auth.users
        FOR EACH ROW EXECUTE FUNCTION public.create_profile_for_new_user();
      ${migration}`))
      .toThrow('0459 refuses divergent auth.users trigger on_auth_user_created');
  });

  it('rejects a same-function trigger whose WHEN clause disables behavior', () => {
    expect(() => sql(`${setup}
      DROP TRIGGER IF EXISTS zz_auth_user_auto_associate_org ON auth.users;
      CREATE TRIGGER zz_auth_user_auto_associate_org
        AFTER INSERT OR UPDATE OF email_confirmed_at, email ON auth.users
        FOR EACH ROW WHEN (false)
        EXECUTE FUNCTION public.handle_auth_user_email_verified_org_join();
      ${migration}`))
      .toThrow('0459 refuses divergent auth.users trigger zz_auth_user_auto_associate_org');
  });
});

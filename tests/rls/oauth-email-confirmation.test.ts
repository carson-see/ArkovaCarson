/** SCRUM-4035: real PostgreSQL authority, not mocked RLS results. */
import { promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
// Role-corruption fixtures need the local bootstrap administrator. Supabase's
// normal postgres principal cannot perform every adversarial role setup below.
// This stock CLI credential is accepted only on the owned loopback ports.
const dbUrl = process.env.UAT03_DATABASE_URL ?? 'postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres';
const fixtureUrl = new URL(dbUrl);
if (!['postgres:', 'postgresql:'].includes(fixtureUrl.protocol)
  || !['127.0.0.1', 'localhost', '[::1]'].includes(fixtureUrl.hostname)
  || !['54322', '55503', '15422', '16422', '17422', '18422', '19422'].includes(fixtureUrl.port)) {
  throw new Error('OAuth confirmation regression requires an owned loopback PostgreSQL fixture or repository CI port block');
}
function sql(body: string) {
  try {
    return execFileSync('psql', ['-X', dbUrl, '-v', 'ON_ERROR_STOP=1', '-At', '-c', `BEGIN; ${body}; ROLLBACK;`], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    // Node's default error contains the command, including every expected RAISE
    // message in roleGuard. Match actual server stderr, never that supplied SQL.
    const stderr = (error as { stderr?: string }).stderr;
    throw new Error(stderr?.trim() || 'Local PostgreSQL fixture command failed');
  }
}
function user(id: string, provider = 'google', age = '0 seconds') {
  return `INSERT INTO auth.users(id,email,raw_app_meta_data,created_at,email_confirmed_at) VALUES ('${id}','${id}@example.invalid','{"provider":"${provider}"}',now()-interval '${age}',now())`;
}
const roleGuard = readFileSync(new URL('../../supabase/migrations/0436_scrum4035_oauth_email_confirmation.sql', import.meta.url), 'utf8').match(/DO \$\$[\s\S]+?END \$\$;/)?.[0];
if (!roleGuard) throw new Error('Pending-role installation guard was not found');
const enable = "UPDATE private.oauth_email_confirmation_policy SET enabled_at=now()-interval '1 second' WHERE singleton";
// Recreate only inside the rolled-back fixture so an existing hosted-style
// postgres creator grant cannot mask the deliberately injected invalid grant.
const freshPendingRole = 'DROP ROLE arkova_email_pending; CREATE ROLE arkova_email_pending NOLOGIN NOINHERIT';

describe('SCRUM-4035 OAuth confirmation SQL boundary', () => {
  beforeAll(() => {
    // A refused connection or ordinary migration principal must fail setup,
    // not accidentally satisfy a negative assertion about a permission error.
    expect(sql('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).toContain('\nt\n');
  });
  it('reports the server error without matching supplied SQL text', () => {
    let failure: unknown;
    try { sql("SELECT 'Pending email role must have no runtime members'; SELECT 1/0"); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('division by zero');
    expect((failure as Error).message).not.toContain('Pending email role must have no runtime members');
  });
  it('installs the role under a hosted-style non-superuser migration principal', () => {
    const owner = `uat03_owner_${randomUUID().replaceAll('-', '')}`;
    const output = sql(`DROP ROLE arkova_email_pending;
      CREATE ROLE ${owner} CREATEROLE BYPASSRLS;
      SET SESSION AUTHORIZATION ${owner}; ${roleGuard};
      SELECT 'creator_guard_passed'; RESET SESSION AUTHORIZATION`);
    expect(output).toContain('creator_guard_passed');
  });
  it('installs under a superuser with no creator membership', () => {
    expect(sql(`DROP ROLE arkova_email_pending; ${roleGuard}; SELECT 'superuser_guard_passed'`))
      .toContain('superuser_guard_passed');
  });
  it.each(['authenticator', 'authenticated'])('rejects pending-role membership for %s', (member) => {
    expect(() => sql(`${freshPendingRole}; GRANT arkova_email_pending TO ${member}; ${roleGuard}`))
      .toThrow(/Pending email role must have no runtime members/);
  });
  it('rejects a parent role that would give pending identities inherited authority', () => {
    expect(() => sql(`${freshPendingRole}; GRANT authenticated TO arkova_email_pending; ${roleGuard}`))
      .toThrow(/Pending email role must have no parent roles/);
  });

  it('rejects a migration-principal grant that can assume the role', () => {
    const owner = `uat03_owner_${randomUUID().replaceAll('-', '')}`;
    expect(() => sql(`DROP ROLE arkova_email_pending; CREATE ROLE ${owner} CREATEROLE BYPASSRLS;
      SET SESSION AUTHORIZATION ${owner}; CREATE ROLE arkova_email_pending NOLOGIN NOINHERIT;
      RESET SESSION AUTHORIZATION; DO $grant$ BEGIN
        IF current_setting('server_version_num')::int >= 160000 THEN
          EXECUTE 'GRANT arkova_email_pending TO ${owner} WITH SET TRUE';
        ELSE
          EXECUTE 'GRANT arkova_email_pending TO ${owner} WITH ADMIN OPTION';
        END IF;
      END $grant$; SET SESSION AUTHORIZATION ${owner}; ${roleGuard}`))
      .toThrow(/Pending email role must have no runtime members/);
  });
  it('still rejects elevated attributes on an existing pending role', () => {
    expect(() => sql(`ALTER ROLE arkova_email_pending LOGIN; ${roleGuard}`))
      .toThrow(/Pending email role must have no elevated role attributes/);
  });
  it('enrolls a new OAuth identity but preserves existing and email-signup users', () => {
    const pending = randomUUID(); const existing = randomUUID(); const email = randomUUID();
    const output = sql(`${enable}; ${user(pending)}; ${user(existing, 'google', '1 day')}; ${user(email, 'email')};
      SELECT jsonb_build_array(private.requires_oauth_email_confirmation('${pending}'),private.requires_oauth_email_confirmation('${existing}'),private.requires_oauth_email_confirmation('${email}'))`);
    expect(output).toContain('[true, false, false]');
  });
  it('enrolls an unconfirmed email signup converted by Google, preserving confirmed email accounts', () => {
    const pending = randomUUID(); const confirmed = randomUUID();
    const output = sql(`${enable}; ${user(pending, 'email')}; ${user(confirmed, 'email')};
      UPDATE auth.users SET email_confirmed_at=NULL WHERE id='${pending}';
      UPDATE auth.users SET raw_app_meta_data='{"provider":"google"}' WHERE id IN ('${pending}','${confirmed}');
      UPDATE auth.users SET email_confirmed_at=now() WHERE id='${pending}';
      SELECT jsonb_build_array(
        public.manage_oauth_email_confirmation('claim','${pending}')->'required',
        private.requires_oauth_email_confirmation('${confirmed}'))`);
    expect(output).toContain('[true, false]');
  });
  it('defers new-user domain membership until completion and associates exactly once', () => {
    const id = randomUUID(); const org = randomUUID(); const digest = 'c'.repeat(64);
    const email = `${id}@${org}.invalid`;
    const output = sql(`${enable};
      INSERT INTO public.organizations(id,display_name,domain,domain_verified,verification_status)
        VALUES('${org}','UAT03 isolated fixture','${org}.invalid',true,'VERIFIED');
      INSERT INTO auth.users(id,email,raw_app_meta_data,created_at,email_confirmed_at)
        VALUES('${id}','${email}','{"provider":"google"}',now(),now());
      SELECT 'before='||count(*) FROM public.org_members WHERE user_id='${id}';
      CREATE TEMP TABLE attempt AS SELECT public.manage_oauth_email_confirmation('claim','${id}') AS v;
      SELECT public.manage_oauth_email_confirmation('register','${id}','${email}','${digest}',(SELECT (v->>'attemptId')::uuid FROM attempt));
      SELECT public.manage_oauth_email_confirmation('complete','${id}','${email}','${digest}');
      SELECT public.auto_associate_profile_to_org_by_email_domain('${id}','${email}');
      SELECT 'after='||count(*) FROM public.org_members WHERE user_id='${id}';
      SELECT org_id='${org}' FROM public.profiles WHERE id='${id}'`);
    expect(output).toContain('before=0');
    expect(output).toContain('after=1');
    expect(output).toContain('\nt\n');
  });
  it('rejects expired proof and leaves the identity pending', () => {
    const id = randomUUID(); const digest = 'd'.repeat(64);
    const output = sql(`${enable}; ${user(id)};
      UPDATE private.oauth_email_confirmations SET challenge_digest='${digest}',expires_at=now()-interval '1 second' WHERE user_id='${id}';
      SELECT public.manage_oauth_email_confirmation('lookup',p_challenge_digest=>'${digest}')->>'error';
      SELECT public.manage_oauth_email_confirmation('complete','${id}','${id}@example.invalid','${digest}')->>'error';
      SELECT private.requires_oauth_email_confirmation('${id}')`);
    expect(output.match(/invalid_link/g)).toHaveLength(2);
    expect(output).toContain('\nt\n');
  });
  it('keeps enrollment pending after provider metadata changes and token refresh', () => {
    const id = randomUUID();
    const output = sql(`${enable}; ${user(id)}; UPDATE auth.users SET raw_app_meta_data='{"provider":"email"}' WHERE id='${id}';
      SELECT private.oauth_email_confirmation_token_hook(jsonb_build_object('user_id','${id}','claims',jsonb_build_object('role','authenticated'),'authentication_method','token_refresh'))->'claims'->>'role'`);
    expect(output).toContain('arkova_email_pending');
  });
  it('makes the confirmation RPC service-only and the pending role unreachable to the API', () => {
    const output = sql(`SELECT jsonb_build_array(
      has_function_privilege('anon','public.manage_oauth_email_confirmation(text,uuid,text,text,uuid)','EXECUTE'),
      has_function_privilege('authenticated','public.manage_oauth_email_confirmation(text,uuid,text,text,uuid)','EXECUTE'),
      has_function_privilege('service_role','public.manage_oauth_email_confirmation(text,uuid,text,text,uuid)','EXECUTE'),
      pg_has_role('authenticator','arkova_email_pending','MEMBER'),
      has_function_privilege('authenticated','public.auto_associate_profile_to_org_by_email_domain(uuid,text)','EXECUTE'))`);
    expect(output).toContain('[false, false, true, false, false]');
  });
  it('claims one resend window, binds the issued challenge and consumes exactly once', () => {
    const id = randomUUID(); const digest = 'a'.repeat(64);
    const output = sql(`${enable}; ${user(id)};
      CREATE TEMP TABLE attempt AS SELECT public.manage_oauth_email_confirmation('claim','${id}') AS v;
      SELECT public.manage_oauth_email_confirmation('claim','${id}')->>'error';
      SELECT public.manage_oauth_email_confirmation('register','${id}','${id}@example.invalid','${digest}',(SELECT (v->>'attemptId')::uuid FROM attempt))->>'required';
      SELECT public.manage_oauth_email_confirmation('complete','${id}','${id}@example.invalid','${digest}')->>'required';
      SELECT public.manage_oauth_email_confirmation('complete','${id}','${id}@example.invalid','${digest}')->>'error';
      SELECT private.requires_oauth_email_confirmation('${id}')`);
    expect(output).toContain('cooldown');
    expect(output).toContain('invalid_link');
    expect(output).toContain('\nf\n');
  });
  it('serializes competing claims and completion attempts against the same identity', async () => {
    const id = randomUUID(); const digest = 'e'.repeat(64);
    const committed = (body: string) => execFileSync('psql', ['-X', dbUrl, '-v', 'ON_ERROR_STOP=1', '-At', '-c', body], { encoding: 'utf8' });
    const call = async (body: string) => (await execFileAsync('psql', ['-X', dbUrl, '-v', 'ON_ERROR_STOP=1', '-At', '-c', body])).stdout;
    const previousEnabledAt = committed("SELECT COALESCE(enabled_at::text,'') FROM private.oauth_email_confirmation_policy WHERE singleton").trim();
    const restoreEnabledAt = previousEnabledAt ? `'${previousEnabledAt.replaceAll("'", "''")}'::timestamptz` : 'NULL';
    try {
      committed(`${enable}; ${user(id)}`);
      const claims = await Promise.all(Array.from({ length: 4 }, () => call(`SELECT public.manage_oauth_email_confirmation('claim','${id}')`)));
      expect(claims.filter((value) => value.includes('attemptId'))).toHaveLength(1);
      expect(claims.filter((value) => value.includes('cooldown'))).toHaveLength(3);
      committed(`SELECT public.manage_oauth_email_confirmation('register','${id}','${id}@example.invalid','${digest}',(SELECT attempt_id FROM private.oauth_email_confirmations WHERE user_id='${id}'))`);
      const completions = await Promise.all(Array.from({ length: 4 }, () => call(`SELECT public.manage_oauth_email_confirmation('complete','${id}','${id}@example.invalid','${digest}')`)));
      expect(completions.filter((value) => value.includes('false'))).toHaveLength(1);
      expect(completions.filter((value) => value.includes('invalid_link'))).toHaveLength(3);
    } finally {
      committed(`DELETE FROM auth.users WHERE id='${id}'; DELETE FROM public.profiles WHERE id='${id}'; UPDATE private.oauth_email_confirmation_policy SET enabled_at=${restoreEnabledAt} WHERE singleton`);
    }
  });
  it('refuses proof for a changed email', () => {
    const id = randomUUID(); const digest = 'b'.repeat(64);
    const output = sql(`${enable}; ${user(id)};
      CREATE TEMP TABLE attempt AS SELECT public.manage_oauth_email_confirmation('claim','${id}') AS v;
      SELECT public.manage_oauth_email_confirmation('register','${id}','${id}@example.invalid','${digest}',(SELECT (v->>'attemptId')::uuid FROM attempt));
      UPDATE auth.users SET email='changed@example.invalid' WHERE id='${id}';
      SELECT public.manage_oauth_email_confirmation('complete','${id}','${id}@example.invalid','${digest}')->>'error';
      SELECT private.requires_oauth_email_confirmation('${id}')`);
    expect(output).toContain('invalid_link');
    expect(output).toContain('\nt\n');
  });
});

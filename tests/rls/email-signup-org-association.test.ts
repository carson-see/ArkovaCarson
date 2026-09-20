/** SCRUM-5145: verified email signup triggers organization membership. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const dbUrl = process.env.UAT17_DATABASE_URL
  ?? process.env.UAT03_DATABASE_URL
  ?? 'postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres';
const fixtureUrl = new URL(dbUrl);
if (!['postgres:', 'postgresql:'].includes(fixtureUrl.protocol)
  || !['127.0.0.1', 'localhost', '[::1]'].includes(fixtureUrl.hostname)
  || !['5432', '54322', '55503', '15422', '16422', '17422', '18422', '19422'].includes(fixtureUrl.port)) {
  throw new Error('Email signup organization regression requires an owned loopback PostgreSQL fixture');
}

function sql(body: string) {
  return execFileSync('psql', ['-X', dbUrl, '-v', 'ON_ERROR_STOP=1', '-At'], {
    input: `BEGIN; ${body}; ROLLBACK;`,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

const signupProfileTrigger = 'CREATE OR REPLACE TRIGGER on_auth_user_created AFTER INSERT ON auth.users '
  + 'FOR EACH ROW EXECUTE FUNCTION public.create_profile_for_new_user()';
const verifiedEmailTrigger = 'CREATE OR REPLACE TRIGGER zz_auth_user_auto_associate_org '
  + 'AFTER INSERT OR UPDATE OF email_confirmed_at, email ON auth.users '
  + 'FOR EACH ROW EXECUTE FUNCTION public.handle_auth_user_email_verified_org_join()';

describe('SCRUM-5145 email signup organization association', () => {
  beforeAll(() => {
    const expectedDatabase = fixtureUrl.pathname.replace(/^\//, '');
    expect(expectedDatabase).not.toBe('');
    expect(sql('SELECT current_database()')).toContain(expectedDatabase);
  });

  it('waits for mailbox confirmation, then creates exactly one domain membership', () => {
    const userId = randomUUID();
    const orgId = randomUUID();
    const domain = `${orgId}.invalid`;
    const output = sql(`${signupProfileTrigger}; ${verifiedEmailTrigger};
      INSERT INTO public.organizations(id,legal_name,display_name,domain,domain_verified,verification_status)
        VALUES('${orgId}','UAT17 fixture LLC','UAT17 fixture','${domain}',true,'VERIFIED');
      INSERT INTO auth.users(id,email,raw_app_meta_data,created_at,email_confirmed_at)
        VALUES('${userId}','member@${domain}','{"provider":"email"}',now(),NULL);
      SELECT 'before='||count(*) FROM public.org_members WHERE user_id='${userId}';
      UPDATE auth.users SET email_confirmed_at=now() WHERE id='${userId}';
      UPDATE auth.users SET email_confirmed_at=email_confirmed_at WHERE id='${userId}';
      SELECT 'after='||count(*) FROM public.org_members WHERE user_id='${userId}';
      SELECT org_id='${orgId}' FROM public.profiles WHERE id='${userId}'`);

    expect(output).toContain('before=0');
    expect(output).toContain('after=1');
    expect(output).toContain('\nt\n');
  });
});

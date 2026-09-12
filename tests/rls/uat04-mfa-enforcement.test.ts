/** UAT-04: live GoTrue, PostgREST, and PostgreSQL MFA authority checks. */
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totp } from '../../e2e/helpers/totp';
import { acquireSharedFixtureLock } from './shared-fixture-lock';

const supabaseUrl = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const jwtSecret = process.env.SUPABASE_JWT_SECRET!;
const dbUrl = process.env.UAT04_DATABASE_URL
  ?? 'postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres';

if (!supabaseUrl || !anonKey || !serviceKey || !jwtSecret) {
  throw new Error('UAT-04 RLS test requires the local Supabase test environment');
}

function sqlCommit(body: string): string {
  return execFileSync('psql', ['-X', dbUrl, '-v', 'ON_ERROR_STOP=1', '-At'], {
    input: body, encoding: 'utf8', stdio: 'pipe',
  });
}
const endpoint = new URL(supabaseUrl);
const database = new URL(dbUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
  || !['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)) {
  throw new Error('UAT-04 RLS test only runs against an owned loopback fixture');
}

function sql(body: string): string {
  try {
    return execFileSync('psql', ['-X', dbUrl, '-v', 'ON_ERROR_STOP=1', '-At'], {
      input: `BEGIN; ${body}; ROLLBACK;`, encoding: 'utf8', stdio: 'pipe',
    });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr;
    const primary = stderr?.match(/^ERROR:[ \t]+([^\r\n]+)/m)?.[1];
    throw new Error(primary ?? 'Local PostgreSQL fixture command failed');
  }
}

function claims(role: string, aal: string, sub = '55555555-0000-4000-8000-000000000002') {
  return JSON.stringify({ role, aal, sub }).replaceAll("'", "''");
}

function jwtClaims(accessToken: string): Record<string, unknown> {
  const encoded = accessToken.split('.')[1];
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function signedUserJwt(userId: string, aal: 'aal1' | 'aal2'): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    aud: 'authenticated', exp: now + 3600, iat: now, iss: `${supabaseUrl}/auth/v1`,
    sub: userId, role: 'authenticated', aal, email: 'uat04-fixture@example.invalid',
  })).toString('base64url');
  const signature = createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

const service = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const disposableUserIds: string[] = [];
const storageBucket = `uat04-${randomUUID()}`;
let releasePolicyLock: (() => void) | undefined;
let previousPolicyEnabledAt: string | null | undefined;

describe('UAT-04 live MFA authority boundary', () => {
  beforeAll(async () => {
    releasePolicyLock = await acquireSharedFixtureLock('oauth-email-confirmation-policy', dbUrl);
    try {
      const snapshot = sqlCommit("SELECT COALESCE(enabled_at::text,'__NULL__') FROM private.oauth_email_confirmation_policy WHERE singleton").trim();
      previousPolicyEnabledAt = snapshot === '__NULL__' ? null : snapshot;
      expect(sql("SELECT current_user <> ''")).toContain('\nt\n');
    } catch (error) {
      previousPolicyEnabledAt = undefined;
      releasePolicyLock();
      releasePolicyLock = undefined;
      throw error;
    }
  });

  afterAll(async () => {
    if (!releasePolicyLock) return;
    const release = releasePolicyLock;
    try {
      sqlCommit('DROP POLICY IF EXISTS uat04_storage_fixture_select ON storage.objects;');
      await service.storage.emptyBucket(storageBucket);
      await service.storage.deleteBucket(storageBucket);
      for (const userId of disposableUserIds) await service.auth.admin.deleteUser(userId);
    } finally {
      try {
        if (previousPolicyEnabledAt !== undefined) {
          const prior = previousPolicyEnabledAt === null
            ? 'NULL'
            : `'${previousPolicyEnabledAt.replaceAll("'", "''")}'::timestamptz`;
          sqlCommit(`UPDATE private.oauth_email_confirmation_policy SET enabled_at=${prior} WHERE singleton;`);
        }
      } finally {
        release();
        releasePolicyLock = undefined;
      }
    }
  });

  it('denies legacy AAL1 before a SECURITY DEFINER RPC and preserves an existing pre-request hook', () => {
    expect(() => sql(`SET LOCAL ROLE authenticated;
      SELECT set_config('request.jwt.claims','${claims('authenticated', 'aal1')}',true);
      SELECT private.enforce_human_mfa_pre_request()`))
      .toThrow('MFA verification required');

    const output = sql(`
      CREATE FUNCTION public.uat04_previous_request() RETURNS void LANGUAGE plpgsql AS
        $$ BEGIN PERFORM set_config('uat04.previous_called','yes',true); END $$;
      GRANT EXECUTE ON FUNCTION public.uat04_previous_request() TO authenticated;
      UPDATE private.mfa_pre_request_chain SET previous_call='public.uat04_previous_request()';
      SET LOCAL ROLE authenticated;
      SELECT set_config('request.jwt.claims','${claims('authenticated', 'aal2')}',true);
      SELECT private.enforce_human_mfa_pre_request();
      SELECT current_setting('uat04.previous_called',true)`);
    expect(output).toContain('yes');
  });

  it('allows AAL2, service, and anonymous requests while restrictive RLS denies direct AAL1 reads', async () => {
    const missingPolicies = sql(`SELECT count(*)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p') AND c.relrowsecurity
        AND (n.nspname='public' OR (n.nspname='storage' AND c.relname='objects'))
        AND NOT EXISTS (
          SELECT 1 FROM pg_policy p
          WHERE p.polrelid=c.oid AND p.polname='mfa_verified_authenticated'
            AND NOT p.polpermissive
            AND p.polcmd='*'
            AND p.polroles @> ARRAY[(SELECT oid FROM pg_roles WHERE rolname='authenticated')]
        )`);
    expect(missingPolicies).toContain('\n0\n');

    const aal1 = sql(`SET LOCAL ROLE authenticated;
      SELECT set_config('request.jwt.claims','${claims('authenticated', 'aal1')}',true);
      SELECT count(*) FROM public.profiles WHERE id='55555555-0000-4000-8000-000000000002'`);
    expect(aal1).toContain('\n0\n');

    const aal2 = sql(`SET LOCAL ROLE authenticated;
      SELECT set_config('request.jwt.claims','${claims('authenticated', 'aal2')}',true);
      SELECT private.enforce_human_mfa_pre_request();
      SELECT count(*) FROM public.profiles WHERE id='55555555-0000-4000-8000-000000000002'`);
    expect(aal2).toContain('\n1\n');

    expect(sql(`SET LOCAL ROLE service_role;
      SELECT set_config('request.jwt.claims','${claims('service_role', 'aal1')}',true);
      SELECT private.enforce_human_mfa_pre_request(); SELECT 'service_ok'`)).toContain('service_ok');
    expect(sql(`SET LOCAL ROLE anon;
      SELECT set_config('request.jwt.claims','${claims('anon', 'aal1', '')}',true);
      SELECT private.enforce_human_mfa_pre_request(); SELECT 'anon_ok'`)).toContain('anon_ok');

    const publicResponse = await fetch(`${supabaseUrl}/rest/v1/plans?select=id&limit=1`, {
      headers: { apikey: anonKey, authorization: `Bearer ${anonKey}` },
    });
    expect(publicResponse.status).toBe(200);
  });

  it('mints MFA-pending at sign-in, permits enrollment, and restores authenticated only after real verification', async () => {
    const email = `uat04-${randomUUID()}@example.invalid`;
    const password = `Uat04-${randomUUID()}!`;
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error).toBeNull();
    const disposableUserId = created.data.user!.id;
    disposableUserIds.push(disposableUserId);

    const human = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const signedIn = await human.auth.signInWithPassword({ email, password });
    expect(signedIn.error).toBeNull();
    expect(jwtClaims(signedIn.data.session!.access_token)).toMatchObject({
      role: 'arkova_mfa_pending', aal: 'aal1', sub: disposableUserId,
    });

    const denied = await human.from('profiles').select('id').limit(1);
    expect(denied.error).not.toBeNull();

    const enrolled = await human.auth.mfa.enroll({ factorType: 'totp' });
    expect(enrolled.error).toBeNull();
    const challenged = await human.auth.mfa.challenge({ factorId: enrolled.data!.id });
    expect(challenged.error).toBeNull();
    const verified = await human.auth.mfa.verify({
      factorId: enrolled.data!.id,
      challengeId: challenged.data!.id,
      code: totp(enrolled.data!.totp.secret),
    });
    expect(verified.error).toBeNull();
    expect(jwtClaims(verified.data!.access_token)).toMatchObject({
      role: 'authenticated', aal: 'aal2', sub: disposableUserId,
    });
  });

  it('keeps email-pending precedence even when MFA verification reaches AAL2', async () => {
    sqlCommit("UPDATE private.oauth_email_confirmation_policy SET enabled_at=clock_timestamp() WHERE singleton;");
    const email = `uat04-oauth-${randomUUID()}@example.invalid`;
    const password = `Uat04-${randomUUID()}!`;
    const created = await service.auth.admin.createUser({
      email, password, email_confirm: true,
      app_metadata: { provider: 'google', providers: ['google'] },
    });
    expect(created.error).toBeNull();
    const userId = created.data.user!.id;
    disposableUserIds.push(userId);

    const human = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const signedIn = await human.auth.signInWithPassword({ email, password });
    expect(jwtClaims(signedIn.data.session!.access_token)).toMatchObject({
      role: 'arkova_email_pending', aal: 'aal1', sub: userId,
    });
    const enrolled = await human.auth.mfa.enroll({ factorType: 'totp' });
    const challenged = await human.auth.mfa.challenge({ factorId: enrolled.data!.id });
    const verified = await human.auth.mfa.verify({
      factorId: enrolled.data!.id,
      challengeId: challenged.data!.id,
      code: totp(enrolled.data!.totp.secret),
    });
    expect(verified.error).toBeNull();
    expect(jwtClaims(verified.data!.access_token)).toMatchObject({
      role: 'arkova_email_pending', aal: 'aal2', sub: userId,
    });
    expect((await human.from('profiles').select('id').limit(1)).error).not.toBeNull();

    sqlCommit(`UPDATE private.oauth_email_confirmations SET confirmed_at=clock_timestamp()
      WHERE user_id='${userId}'::uuid;`);
    const refreshed = await human.auth.refreshSession();
    expect(refreshed.error).toBeNull();
    expect(jwtClaims(refreshed.data.session!.access_token)).toMatchObject({
      role: 'authenticated', aal: 'aal2', sub: userId,
    });
  });

  it('denies an old signed authenticated/AAL1 token on protected Storage', async () => {
    const email = `uat04-surface-${randomUUID()}@example.invalid`;
    const created = await service.auth.admin.createUser({ email, email_confirm: true });
    expect(created.error).toBeNull();
    const userId = created.data.user!.id;
    disposableUserIds.push(userId);
    const aal1 = signedUserJwt(userId, 'aal1');
    const aal2 = signedUserJwt(userId, 'aal2');

    expect((await service.storage.createBucket(storageBucket, { public: false })).error).toBeNull();
    expect((await service.storage.from(storageBucket).upload('proof.txt', 'uat04')).error).toBeNull();
    sqlCommit(`UPDATE storage.objects SET owner_id='${userId}' WHERE bucket_id='${storageBucket}';
      CREATE POLICY uat04_storage_fixture_select ON storage.objects FOR SELECT TO authenticated
        USING (bucket_id='${storageBucket}' AND owner_id=(SELECT auth.uid()::text));`);

    const readStorage = (token: string) => fetch(
      `${supabaseUrl}/storage/v1/object/${storageBucket}/proof.txt`,
      { headers: { apikey: anonKey, authorization: `Bearer ${token}` } },
    );
    expect((await readStorage(aal1)).status).not.toBe(200);
    const allowedStorage = await readStorage(aal2);
    expect(allowedStorage.status).toBe(200);
    expect(await allowedStorage.text()).toBe('uat04');

    sqlCommit('DROP POLICY uat04_storage_fixture_select ON storage.objects;');
  });

  it('has no Realtime-published RLS table missing the restrictive MFA policy', () => {
    const missing = sql(`SELECT count(*)
      FROM pg_publication_tables published
      JOIN pg_class c ON c.relname=published.tablename
      JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname=published.schemaname
      WHERE published.pubname='supabase_realtime'
        AND c.relrowsecurity
        AND NOT EXISTS (
          SELECT 1 FROM pg_policy p
          WHERE p.polrelid=c.oid AND p.polname='mfa_verified_authenticated'
            AND NOT p.polpermissive
            AND p.polroles @> ARRAY[(SELECT oid FROM pg_roles WHERE rolname='authenticated')]
        )`);
    expect(missing).toContain('\n0\n');
  });
});

/**
 * SCRUM-5280 / SCRUM-5282 — organization domain-verification write authority.
 *
 * Three live defects, all proven against the real schema rather than a mock,
 * because every one of them is enforced (or not) by SQL:
 *
 *   A (SCRUM-5280) `organizations_update_admin` grants an org admin UPDATE on
 *     EVERY column of their own row, and `protect_org_tenancy_fields()` guarded
 *     only the three sub-org tenancy columns from 0429. So an org admin could
 *     `UPDATE organizations SET domain='victim.com', domain_verified=true` and,
 *     via 0470's `auto_associate_profile_to_org_by_email_domain`, capture every
 *     later confirmed @victim.com signup as a member of their org.
 *
 *   B 0470's `add_existing_org_member` authorized a third way: a profile whose
 *     `role = 'ORG_ADMIN'` and `org_id = p_org_id`, with no `org_members` row.
 *     That is a stale-role fallback — `profiles.role` outlives a membership
 *     demotion — and 0477 deliberately removed the same fallback from the queue
 *     RPC. Removed here too.
 *
 *   C (SCRUM-5282) the 3-argument `resolve_anchor_queue_by_public_id` overload
 *     is SECURITY DEFINER, authorizes on `profiles.role = 'ORG_ADMIN'` (the same
 *     stale-role source as B) and holds EXECUTE for `anon` and `authenticated`.
 *     0477 hardened only the 4-arg service-role overload. No browser or SDK
 *     caller uses the 3-arg form, so EXECUTE is revoked here.
 *
 * Every negative case is paired with a POSITIVE CONTROL: a guard that also
 * blocks the legitimate write is an outage, not a fix.
 *
 * Fixture: an owned loopback PostgreSQL carrying the Arkova schema, driven
 * through `psql` inside a single rolled-back transaction, in the shape
 * established by `email-signup-org-association.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

const dbUrl = process.env.SCRUM5280_DATABASE_URL
  ?? process.env.UAT17_DATABASE_URL
  ?? process.env.UAT03_DATABASE_URL
  ?? 'postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres';
const fixtureUrl = new URL(dbUrl);
if (!['postgres:', 'postgresql:'].includes(fixtureUrl.protocol)
  || !['127.0.0.1', 'localhost', '[::1]'].includes(fixtureUrl.hostname)
  || !['5432', '54322', '55503', '15422', '16422', '17422', '18422', '19422'].includes(fixtureUrl.port)) {
  throw new Error('SCRUM-5280 domain-verification guard requires an owned loopback PostgreSQL fixture');
}

function sql(body: string): string {
  return execFileSync('psql', ['-X', dbUrl, '-v', 'ON_ERROR_STOP=1', '-At'], {
    input: `BEGIN; ${body}; ROLLBACK;`,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

/**
 * Act as a real signed-in organization administrator: `authenticated` role,
 * an `auth.uid()`-resolvable JWT subject, and `aal: aal2` so the restrictive
 * `mfa_verified_authenticated` policy does not mask the result. `SET LOCAL
 * ROLE` is what makes RLS and FORCE ROW LEVEL SECURITY actually apply — a
 * superuser session would sail past both and prove nothing.
 */
function asOrgAdmin(userId: string): string {
  return `
    SELECT set_config('request.jwt.claims',
      json_build_object('sub','${userId}','role','authenticated','aal','aal2')::text, true);
    SELECT set_config('request.jwt.claim.role','authenticated',true);
    SET LOCAL ROLE authenticated;`;
}

const asServiceRole = `
  RESET ROLE;
  SELECT set_config('request.jwt.claim.role','service_role',true);
  SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);`;

/** A confirmed-signup auth user plus the profile its trigger creates. */
function seedUser(userId: string, email: string): string {
  return `
    INSERT INTO auth.users(id,email,raw_app_meta_data,created_at,email_confirmed_at)
      VALUES('${userId}','${email}','{"provider":"email"}',now(),now());
    INSERT INTO public.profiles(id,email) VALUES('${userId}','${email}')
      ON CONFLICT (id) DO NOTHING;`;
}

/** Wrap a statement expected to raise `insufficient_privilege` (42501). */
function expectDenied(label: string, statement: string): string {
  return `
    DO $do$ BEGIN
      ${statement};
      RAISE EXCEPTION 'GUARD_MISSING ${label}';
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'denied ${label}';
    END $do$;
    SELECT 'denied=${label}';`;
}

describe('SCRUM-5280 organization domain verification write authority', () => {
  beforeAll(() => {
    const expectedDatabase = fixtureUrl.pathname.replace(/^\//, '');
    expect(expectedDatabase).not.toBe('');
    expect(sql('SELECT current_database()')).toContain(expectedDatabase);
  });

  // ── A. self-asserted domain verification ──────────────────────────────────

  it('refuses an org admin who self-asserts domain_verified on their own row', () => {
    const adminId = randomUUID();
    const orgId = randomUUID();
    const victim = `victim-${orgId}.invalid`;
    const output = sql(`
      ${seedUser(adminId, `admin-${adminId}@attacker.invalid`)}
      INSERT INTO public.organizations(id,legal_name,display_name,domain,domain_verified,verification_status)
        VALUES('${orgId}','Attacker LLC','Attacker','attacker-${orgId}.invalid',false,'UNVERIFIED');
      INSERT INTO public.org_members(user_id,org_id,role) VALUES('${adminId}','${orgId}','admin');
      ${asOrgAdmin(adminId)}
      ${expectDenied('domain_verified', `UPDATE public.organizations SET domain='${victim}', domain_verified=true WHERE id='${orgId}'`)}
      ${expectDenied('verification_status', `UPDATE public.organizations SET verification_status='VERIFIED' WHERE id='${orgId}'`)}
      ${expectDenied('domain_verification_method', `UPDATE public.organizations SET domain_verification_method='dns' WHERE id='${orgId}'`)}
      ${expectDenied('domain_verified_at', `UPDATE public.organizations SET domain_verified_at=now() WHERE id='${orgId}'`)}
      ${expectDenied('domain_verification_token', `UPDATE public.organizations SET domain_verification_token='123456:forged' WHERE id='${orgId}'`)}
      ${expectDenied('token_expiry', `UPDATE public.organizations SET domain_verification_token_expires_at=now()+interval '1 day' WHERE id='${orgId}'`)}
      ${asServiceRole}
      SELECT 'final_verified='||domain_verified::text||' final_status='||verification_status||' final_token='||coalesce(domain_verification_token,'<null>')
        FROM public.organizations WHERE id='${orgId}'`);

    expect(output).toContain('denied=domain_verified');
    expect(output).toContain('denied=verification_status');
    expect(output).toContain('denied=domain_verification_method');
    expect(output).toContain('denied=domain_verified_at');
    // The token is the ONLY secret /api/v1/orgs/confirm-domain checks. An org
    // admin who can write it self-verifies any domain through the worker's own
    // service_role path, which would leave the guard above decorative.
    expect(output).toContain('denied=domain_verification_token');
    expect(output).toContain('denied=token_expiry');
    expect(output).toContain('final_verified=false final_status=UNVERIFIED final_token=<null>');
  });

  it('drops an existing verification when an org admin edits the domain', () => {
    const adminId = randomUUID();
    const orgId = randomUUID();
    const output = sql(`
      ${seedUser(adminId, `admin-${adminId}@realco.invalid`)}
      INSERT INTO public.organizations(id,legal_name,display_name,domain,domain_verified,
                                       domain_verification_method,domain_verified_at,
                                       domain_verification_token,domain_verification_token_expires_at)
        VALUES('${orgId}','Real Co','Real Co','realco-${orgId}.invalid',true,'email',now(),
               '654321:tok',now()+interval '1 day');
      INSERT INTO public.org_members(user_id,org_id,role) VALUES('${adminId}','${orgId}','admin');
      ${asOrgAdmin(adminId)}
      UPDATE public.organizations SET domain='victim-${orgId}.invalid' WHERE id='${orgId}';
      ${asServiceRole}
      SELECT 'after_edit domain='||domain
           ||' verified='||domain_verified::text
           ||' method='||coalesce(domain_verification_method,'<null>')
           ||' at='||coalesce(domain_verified_at::text,'<null>')
           ||' token='||coalesce(domain_verification_token,'<null>')
        FROM public.organizations WHERE id='${orgId}'`);

    expect(output).toContain(`after_edit domain=victim-${orgId}.invalid`);
    expect(output).toContain('verified=false');
    expect(output).toContain('method=<null>');
    expect(output).toContain('at=<null>');
    expect(output).toContain('token=<null>');
  });

  it('POSITIVE CONTROL: re-saving an unchanged domain does not demote a verified org', () => {
    // `useOrganization.updateOrganization` PATCHes the whole `EditableOrgFields`
    // object, `domain` included, on every settings save. If the demotion fired
    // on assignment rather than on a real change, one cosmetic save would
    // un-verify every verified organization in production. This is the
    // regression that matters more than the guard itself.
    //
    // The demotion compares `lower(trim(trailing '.' from ...))` NULL-safely,
    // matching 0470's own normalization. A differing-but-equivalent literal
    // (`EXAMPLE.invalid.`) cannot be constructed through this table: the
    // `organizations_domain_format` CHECK rejects uppercase and a trailing dot
    // outright, so the normalization is defense-in-depth for legacy rows only
    // and the reachable case is the identical re-save asserted here.
    const adminId = randomUUID();
    const orgId = randomUUID();
    const domain = `stable-${orgId}.invalid`;
    const output = sql(`
      ${seedUser(adminId, `admin-${adminId}@stable.invalid`)}
      INSERT INTO public.organizations(id,legal_name,display_name,domain,domain_verified,
                                       domain_verification_method,domain_verified_at)
        VALUES('${orgId}','Stable Co','Stable Co','${domain}',true,'email',now());
      INSERT INTO public.org_members(user_id,org_id,role) VALUES('${adminId}','${orgId}','admin');
      ${asOrgAdmin(adminId)}
      UPDATE public.organizations SET description='no change to the domain' WHERE id='${orgId}';
      UPDATE public.organizations SET domain='${domain}', display_name='Stable Co' WHERE id='${orgId}';
      ${asServiceRole}
      SELECT 'stable verified='||domain_verified::text||' method='||coalesce(domain_verification_method,'<null>')
        FROM public.organizations WHERE id='${orgId}'`);

    expect(output).toContain('stable verified=true method=email');
  });

  it('POSITIVE CONTROL: an org admin can still edit the domain and ordinary profile fields', () => {
    const adminId = randomUUID();
    const orgId = randomUUID();
    const output = sql(`
      ${seedUser(adminId, `admin-${adminId}@ordinary.invalid`)}
      INSERT INTO public.organizations(id,legal_name,display_name,domain)
        VALUES('${orgId}','Ordinary LLC','Ordinary','ordinary-${orgId}.invalid');
      INSERT INTO public.org_members(user_id,org_id,role) VALUES('${adminId}','${orgId}','admin');
      ${asOrgAdmin(adminId)}
      UPDATE public.organizations
         SET domain='renamed-${orgId}.invalid',
             display_name='Ordinary Renamed',
             description='still editable',
             website_url='https://example.invalid',
             industry_tag='legal_tech'
       WHERE id='${orgId}';
      ${asServiceRole}
      SELECT 'edited domain='||domain||' name='||display_name||' tag='||industry_tag
        FROM public.organizations WHERE id='${orgId}'`);

    expect(output).toContain(`edited domain=renamed-${orgId}.invalid name=Ordinary Renamed tag=legal_tech`);
  });

  it('POSITIVE CONTROL: service_role still performs the real verification write', () => {
    const orgId = randomUUID();
    const output = sql(`
      INSERT INTO public.organizations(id,legal_name,display_name,domain)
        VALUES('${orgId}','Worker Verified LLC','Worker Verified','worker-${orgId}.invalid');
      ${asServiceRole}
      UPDATE public.organizations
         SET domain_verification_token='123456:tok',
             domain_verification_token_expires_at=now()+interval '1 day'
       WHERE id='${orgId}';
      UPDATE public.organizations
         SET domain_verified=true, domain_verification_method='email',
             domain_verified_at=now(), domain_verification_token=NULL,
             domain_verification_token_expires_at=NULL, verification_status='VERIFIED'
       WHERE id='${orgId}';
      SELECT 'worker verified='||domain_verified::text||' method='||domain_verification_method||' status='||verification_status
        FROM public.organizations WHERE id='${orgId}'`);

    expect(output).toContain('worker verified=true method=email status=VERIFIED');
  });

  it('does not auto-associate a confirmed signup to a self-asserted verified domain', () => {
    // The end-to-end shape of SCRUM-5280: the capture only works if the org
    // admin's own UPDATE lands. It must not.
    const adminId = randomUUID();
    const victimId = randomUUID();
    const orgId = randomUUID();
    const victimDomain = `victim-${orgId}.invalid`;
    const output = sql(`
      ${seedUser(adminId, `admin-${adminId}@attacker.invalid`)}
      INSERT INTO public.organizations(id,legal_name,display_name,domain)
        VALUES('${orgId}','Attacker LLC','Attacker','attacker-${orgId}.invalid');
      INSERT INTO public.org_members(user_id,org_id,role) VALUES('${adminId}','${orgId}','admin');
      ${asOrgAdmin(adminId)}
      DO $do$ BEGIN
        UPDATE public.organizations
           SET domain='${victimDomain}', domain_verified=true WHERE id='${orgId}';
      EXCEPTION WHEN insufficient_privilege THEN NULL; END $do$;
      ${asServiceRole}
      SELECT 'org_claims_victim='||(lower(trim(trailing '.' from coalesce(domain,'')))='${victimDomain}' AND domain_verified)::text
        FROM public.organizations WHERE id='${orgId}';
      INSERT INTO auth.users(id,email,raw_app_meta_data,created_at,email_confirmed_at)
        VALUES('${victimId}','newhire@${victimDomain}','{"provider":"email"}',now(),now());
      SELECT 'captured='||count(*)::text FROM public.org_members
        WHERE user_id='${victimId}' AND org_id='${orgId}';
      SELECT 'victim_profile_org='||coalesce(org_id::text,'null') FROM public.profiles WHERE id='${victimId}'`);

    expect(output).toContain('org_claims_victim=false');
    expect(output).toContain('captured=0');
    expect(output).toContain('victim_profile_org=null');
  });

  // ── B. add_existing_org_member stale-role fallback ────────────────────────

  it('rejects an add_existing_org_member actor holding only the stale profile role', () => {
    const actorId = randomUUID();
    const targetId = randomUUID();
    const orgId = randomUUID();
    const targetEmail = `${targetId}@example.invalid`;
    const output = sql(`
      ${seedUser(actorId, `actor-${actorId}@example.invalid`)}
      ${seedUser(targetId, targetEmail)}
      INSERT INTO public.organizations(id,legal_name,display_name)
        VALUES('${orgId}','Stale Role LLC','Stale Role');
      ${asServiceRole}
      -- The demoted-admin shape: profiles still carries ORG_ADMIN + org_id long
      -- after the org_members row was removed. Seeded through the trigger's own
      -- service_role bypass, which is the only privileged path that may write
      -- profiles.org_id (protect_privileged_profile_fields).
      UPDATE public.profiles SET org_id='${orgId}', role='ORG_ADMIN' WHERE id='${actorId}';
      SELECT 'memberships='||count(*)::text FROM public.org_members
        WHERE user_id='${actorId}' AND org_id='${orgId}';
      DO $do$ BEGIN
        PERFORM public.add_existing_org_member('${actorId}','${orgId}','${targetEmail}','INDIVIDUAL');
        RAISE EXCEPTION 'STALE_ROLE_ACCEPTED';
      EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'stale role rejected'; END $do$;
      SELECT 'added='||count(*)::text FROM public.org_members
        WHERE user_id='${targetId}' AND org_id='${orgId}'`);

    expect(output).toContain('memberships=0');
    expect(output).toContain('added=0');
  });

  it('POSITIVE CONTROL: an exact org_members admin still adds an existing account', () => {
    const actorId = randomUUID();
    const targetId = randomUUID();
    const orgId = randomUUID();
    const targetEmail = `${targetId}@example.invalid`;
    const output = sql(`
      ${seedUser(actorId, `actor-${actorId}@example.invalid`)}
      ${seedUser(targetId, targetEmail)}
      INSERT INTO public.organizations(id,legal_name,display_name)
        VALUES('${orgId}','Exact Member LLC','Exact Member');
      INSERT INTO public.org_members(user_id,org_id,role) VALUES('${actorId}','${orgId}','admin');
      ${asServiceRole}
      SELECT idempotent FROM public.add_existing_org_member(
        '${actorId}','${orgId}','${targetEmail}','INDIVIDUAL');
      SELECT 'added='||count(*)::text FROM public.org_members
        WHERE user_id='${targetId}' AND org_id='${orgId}'`);

    expect(output).toContain('added=1');
  });

  // ── C. the 3-argument queue overload ──────────────────────────────────────

  it('revokes anon and authenticated EXECUTE on the 3-arg queue resolution overload', () => {
    const output = sql(`
      SELECT 'anon='||has_function_privilege('anon',
        'public.resolve_anchor_queue_by_public_id(text,text,text)','EXECUTE')::text;
      SELECT 'authenticated='||has_function_privilege('authenticated',
        'public.resolve_anchor_queue_by_public_id(text,text,text)','EXECUTE')::text;
      SELECT 'public='||has_function_privilege('public',
        'public.resolve_anchor_queue_by_public_id(text,text,text)','EXECUTE')::text;
      -- POSITIVE CONTROL: the overload the worker actually calls is untouched,
      -- so "anon cannot call it" cannot pass because the function vanished.
      SELECT 'service_role_3arg='||has_function_privilege('service_role',
        'public.resolve_anchor_queue_by_public_id(text,text,text)','EXECUTE')::text;
      SELECT 'service_role_4arg='||has_function_privilege('service_role',
        'public.resolve_anchor_queue_by_public_id(text,text,text,uuid)','EXECUTE')::text`);

    expect(output).toContain('anon=false');
    expect(output).toContain('authenticated=false');
    expect(output).toContain('public=false');
    expect(output).toContain('service_role_3arg=true');
    expect(output).toContain('service_role_4arg=true');
  });
});

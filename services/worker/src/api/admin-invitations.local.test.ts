/**
 * Opt-in local integration for UAT-22.
 *
 * Runs the mounted Express routers against a real local Supabase stack. Only
 * the outbound sender is captured, so no message leaves the process. Invoke
 * with UAT22_LOCAL_INTEGRATION=1 and the local Supabase URL/keys.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { decodeJwt } from 'jose';

const { capturedSendEmail } = vi.hoisted(() => ({
  capturedSendEmail: vi.fn(async () => ({ success: true, messageId: 'uat22-captured' })),
}));
vi.mock('../email/sender.js', () => ({ sendEmail: capturedSendEmail }));

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import express from 'express';
import request from 'supertest';
import { adminRouter } from '../routes/admin.js';
import { anchorRouter } from '../routes/anchor.js';
import { totp } from '../../../../e2e/helpers/totp.js';

const runLocal = process.env.UAT22_LOCAL_INTEGRATION === '1';
const suite = runLocal ? describe : describe.skip;
const password = 'Uat22-local-only-Password9!';
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const emails = {
  admin: `uat22-admin-${suffix}@example.test`,
  ordinary: `uat22-ordinary-${suffix}@example.test`,
  existingElsewhere: `uat22-existing-${suffix}@example.test`,
  alreadyMember: `uat22-member-${suffix}@example.test`,
  newMember: `uat22-new-${suffix}@example.test`,
};

suite('UAT-22 selected-org invitation — real local DB and mounted routes', () => {
  let service: SupabaseClient;
  let homeOrgId: string;
  let selectedOrgId: string;
  let adminId: string;
  let ordinaryId: string;
  let existingId: string;
  let alreadyMemberId: string;

  function application() {
    const app = express();
    app.use(express.json());
    app.use('/api', anchorRouter);
    app.use('/api', adminRouter);
    return app;
  }

  async function createUser(email: string): Promise<string> {
    const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw error ?? new Error('Synthetic user creation returned no user');
    const { data: profile, error: profileError } = await service
      .from('profiles')
      .select('id')
      .eq('id', data.user.id)
      .maybeSingle();
    if (profileError) throw profileError;
    if (!profile) {
      const { error: insertError } = await service.from('profiles').insert({
        id: data.user.id,
        email,
        subscription_tier: 'free',
      });
      if (insertError) throw insertError;
    }
    return data.user.id;
  }

  async function placeUser(userId: string, orgId: string, role: 'INDIVIDUAL' | 'ORG_ADMIN', orgRole: 'member' | 'admin') {
    const roleResult = await service.rpc('admin_change_user_role', { p_user_id: userId, p_new_role: role });
    if (roleResult.error) throw roleResult.error;
    const orgResult = await service.rpc('admin_set_user_org', {
      p_user_id: userId,
      p_org_id: orgId,
      p_org_role: orgRole,
    });
    if (orgResult.error) throw orgResult.error;
  }

  async function authenticatedSessions(email: string): Promise<{ aal1: string; aal2: string }> {
    const human = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data, error } = await human.auth.signInWithPassword({ email, password });
    if (error || !data.session) throw error ?? new Error('Synthetic sign-in returned no session');
    const aal1 = data.session.access_token;
    const enrolled = await human.auth.mfa.enroll({ factorType: 'totp' });
    if (enrolled.error || !enrolled.data) throw enrolled.error ?? new Error('Synthetic MFA enrollment failed');
    const challenged = await human.auth.mfa.challenge({ factorId: enrolled.data.id });
    if (challenged.error || !challenged.data) throw challenged.error ?? new Error('Synthetic MFA challenge failed');
    const verified = await human.auth.mfa.verify({
      factorId: enrolled.data.id,
      challengeId: challenged.data.id,
      code: totp(enrolled.data.totp.secret),
    });
    if (verified.error || !verified.data) throw verified.error ?? new Error('Synthetic MFA verification failed');
    expect(decodeJwt(aal1).aal).toBe('aal1');
    expect(decodeJwt(verified.data.access_token)).toMatchObject({ aal: 'aal2', role: 'authenticated' });
    return { aal1, aal2: verified.data.access_token };
  }

  beforeAll(async () => {
    service = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data: orgs, error: orgError } = await service
      .from('organizations')
      .insert([
        { legal_name: `UAT22 Home ${suffix}`, display_name: `UAT22 Home ${suffix}` },
        { legal_name: `UAT22 Selected ${suffix}`, display_name: `UAT22 Selected ${suffix}` },
      ])
      .select('id, display_name');
    if (orgError || !orgs || orgs.length !== 2) throw orgError ?? new Error('Synthetic org creation failed');
    homeOrgId = orgs.find((org) => org.display_name.includes('Home'))!.id;
    selectedOrgId = orgs.find((org) => org.display_name.includes('Selected'))!.id;

    adminId = await createUser(emails.admin);
    ordinaryId = await createUser(emails.ordinary);
    existingId = await createUser(emails.existingElsewhere);
    alreadyMemberId = await createUser(emails.alreadyMember);
    await placeUser(adminId, homeOrgId, 'ORG_ADMIN', 'admin');
    await placeUser(ordinaryId, homeOrgId, 'INDIVIDUAL', 'member');
    await placeUser(existingId, homeOrgId, 'INDIVIDUAL', 'member');
    await placeUser(alreadyMemberId, selectedOrgId, 'INDIVIDUAL', 'member');
    const adminResult = await service.rpc('admin_set_platform_admin', { p_user_id: adminId, p_is_admin: true });
    if (adminResult.error) throw adminResult.error;
  }, 30_000);

  afterAll(async () => {
    const dbUrl = process.env.SUPABASE_DB_URL;
    if (!dbUrl) throw new Error('SUPABASE_DB_URL is required to clean immutable local audit fixtures');
    // audit_events is intentionally immutable. session_replication_role is
    // transaction-local to this psql session, so concurrent test sessions keep
    // their triggers while this uniquely-prefixed fixture is removed.
    const sql = `
      begin;
      set local session_replication_role=replica;
      delete from public.audit_events where actor_id in
        (select id from public.profiles where email like 'uat22-%-${suffix}@example.test')
        or org_id in (select id from public.organizations where display_name like 'UAT22 % ${suffix}');
      delete from public.invitations where email like 'uat22-%-${suffix}@example.test'
        or org_id in (select id from public.organizations where display_name like 'UAT22 % ${suffix}');
      delete from public.org_members where user_id in
        (select id from public.profiles where email like 'uat22-%-${suffix}@example.test')
        or org_id in (select id from public.organizations where display_name like 'UAT22 % ${suffix}');
      delete from public.profiles where email like 'uat22-%-${suffix}@example.test';
      delete from auth.users where email like 'uat22-%-${suffix}@example.test';
      delete from public.organizations where display_name like 'UAT22 % ${suffix}';
      commit;
    `;
    execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'ignore' });
  }, 30_000);

  it('authorizes a foreign selected-org platform admin, rejects negatives, replays safely, and preserves chosen roles', async () => {
    const app = application();
    const adminSessions = await authenticatedSessions(emails.admin);
    const ordinarySessions = await authenticatedSessions(emails.ordinary);
    const existingSessions = await authenticatedSessions(emails.existingElsewhere);
    const adminToken = adminSessions.aal2;
    const ordinaryToken = ordinarySessions.aal2;
    const existingToken = existingSessions.aal2;

    const selectedOrg = await request(app)
      .get(`/api/admin/organizations/${selectedOrgId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(selectedOrg.status).toBe(200);
    expect(selectedOrg.body.organization).toMatchObject({
      id: selectedOrgId,
      display_name: `UAT22 Selected ${suffix}`,
    });

    // The combined UAT04 worker must reject the pre-step-up platform token at
    // the auth envelope. Baseline main does not yet contain that worker gate,
    // so the live assertion is opt-in for root's combined-candidate run.
    if (process.env.UAT22_EXPECT_AAL2_GATE === '1') {
      const aal1Denied = await request(app)
        .post(`/api/admin/organizations/${selectedOrgId}/invitations`)
        .set('Authorization', `Bearer ${adminSessions.aal1}`)
        .send({ email: emails.newMember, role: 'INDIVIDUAL', idempotency_key: crypto.randomUUID() });
      expect(aal1Denied.status).toBe(401);
    }

    const deniedKey = crypto.randomUUID();
    const denied = await request(app)
      .post(`/api/admin/organizations/${selectedOrgId}/invitations`)
      .set('Authorization', `Bearer ${ordinaryToken}`)
      .send({ email: emails.newMember, role: 'INDIVIDUAL', idempotency_key: deniedKey });
    expect(denied.status).toBe(403);
    const { data: deniedRow } = await service.from('invitations').select('id').eq('id', deniedKey).maybeSingle();
    expect(deniedRow).toBeNull();

    const existingMemberKey = crypto.randomUUID();
    const alreadyMember = await request(app)
      .post(`/api/admin/organizations/${selectedOrgId}/invitations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: emails.alreadyMember, role: 'ORG_ADMIN', idempotency_key: existingMemberKey });
    expect(alreadyMember.status).toBe(409);
    expect(alreadyMember.body.code).toBe('already_member');

    const adminInviteKey = crypto.randomUUID();
    const adminInviteBody = {
      email: emails.existingElsewhere,
      role: 'ORG_ADMIN',
      idempotency_key: adminInviteKey,
      orgName: 'client-spoofed-name',
      inviterName: 'client-spoofed-actor',
    };
    const first = await request(app)
      .post(`/api/admin/organizations/${selectedOrgId}/invitations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(adminInviteBody);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ sent: true, invitationId: adminInviteKey, replayed: false });

    const replay = await request(app)
      .post(`/api/admin/organizations/${selectedOrgId}/invitations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(adminInviteBody);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ sent: true, invitationId: adminInviteKey, replayed: true });

    const { data: adminRows, error: adminRowsError } = await service
      .from('invitations')
      .select('id, token, role, org_id, email')
      .eq('id', adminInviteKey);
    if (adminRowsError) throw adminRowsError;
    expect(adminRows).toHaveLength(1);
    expect(adminRows![0]).toMatchObject({ role: 'ORG_ADMIN', org_id: selectedOrgId, email: emails.existingElsewhere });
    const inviteCalls = capturedSendEmail.mock.calls.filter(([options]) => options.emailType === 'invitation');
    expect(inviteCalls).toHaveLength(2);
    expect(inviteCalls[0][0].idempotencyKey).toBe(`invitation/${adminInviteKey}`);
    expect(inviteCalls[1][0].idempotencyKey).toBe(`invitation/${adminInviteKey}`);
    expect(inviteCalls[0][0].subject).toContain(`UAT22 Selected ${suffix}`);
    expect(inviteCalls[0][0].subject).not.toContain('client-spoofed');

    const acceptedAdmin = await request(app)
      .post('/api/invitations/accept')
      .set('Authorization', `Bearer ${existingToken}`)
      .send({ token: adminRows![0].token });
    expect(acceptedAdmin.status).toBe(200);
    const { data: adminMembership } = await service
      .from('org_members')
      .select('role')
      .eq('user_id', existingId)
      .eq('org_id', selectedOrgId)
      .single();
    expect(adminMembership?.role).toBe('admin');
    const { data: existingProfile } = await service.from('profiles').select('org_id, role').eq('id', existingId).single();
    expect(existingProfile).toMatchObject({ org_id: homeOrgId, role: 'INDIVIDUAL' });

    const memberInviteKey = crypto.randomUUID();
    const memberInvite = await request(app)
      .post(`/api/admin/organizations/${selectedOrgId}/invitations`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: emails.newMember, role: 'INDIVIDUAL', idempotency_key: memberInviteKey });
    expect(memberInvite.status).toBe(201);
    const { data: memberRow } = await service.from('invitations').select('token').eq('id', memberInviteKey).single();
    const acceptedMember = await request(app)
      .post('/api/invitations/accept')
      .send({ token: memberRow!.token, password, fullName: 'UAT22 Synthetic Member' });
    expect(acceptedMember.status).toBe(200);
    const { data: newProfile } = await service.from('profiles').select('id, org_id, role').eq('email', emails.newMember).single();
    expect(newProfile).toMatchObject({ org_id: selectedOrgId, role: 'INDIVIDUAL' });
    const { data: memberMembership } = await service
      .from('org_members')
      .select('role')
      .eq('user_id', newProfile!.id)
      .eq('org_id', selectedOrgId)
      .single();
    expect(memberMembership?.role).toBe('member');
  }, 30_000);
});

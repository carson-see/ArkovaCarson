import { execFileSync } from 'node:child_process';
import { test, expect, type BrowserContextOptions } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { totp } from './helpers/totp';
import { resolveE2EFrontendOrigin, supabaseAuthStorageKey } from './helpers/supabase-storage-key';

const runLocal = process.env.UAT22_BROWSER_LOCAL === '1';
test.skip(!runLocal, 'Opt-in local UAT with synthetic Supabase fixture and captured worker request');
test.describe.configure({ mode: 'serial' });

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const email = `uat22-browser-${suffix}@example.test`;
const password = 'Uat22-browser-only-Password9!';
let orgId = '';
let homeOrgId = '';
let userId = '';
let sessionState: BrowserContextOptions['storageState'];

test.beforeAll(async () => {
  const service = createClient(process.env.E2E_SUPABASE_URL!, process.env.E2E_SUPABASE_SERVICE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const prefixSeed = Number.parseInt(suffix.slice(-6), 10).toString(36).toUpperCase().padStart(4, '0').slice(-4);
  const { data: orgs, error: orgError } = await service
    .from('organizations')
    .insert([
      { legal_name: `UAT22 Browser Home ${suffix}`, display_name: `UAT22 Browser Home ${suffix}`, org_prefix: `H${prefixSeed}` },
      { legal_name: `UAT22 Browser Selected ${suffix}`, display_name: `UAT22 Browser Selected ${suffix}`, org_prefix: `S${prefixSeed}` },
    ])
    .select('id, display_name');
  if (orgError || !orgs || orgs.length !== 2) throw orgError ?? new Error('Browser fixture org creation failed');
  homeOrgId = orgs.find((org) => org.display_name.includes('Home'))!.id;
  orgId = orgs.find((org) => org.display_name.includes('Selected'))!.id;

  const { data: created, error: createError } = await service.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (createError || !created.user) throw createError ?? new Error('Browser fixture user creation failed');
  userId = created.user.id;
  const { data: profile } = await service.from('profiles').select('id').eq('id', userId).maybeSingle();
  if (!profile) {
    const { error } = await service.from('profiles').insert({ id: userId, email, subscription_tier: 'free' });
    if (error) throw error;
  }
  const roleResult = await service.rpc('admin_change_user_role', { p_user_id: userId, p_new_role: 'ORG_ADMIN' });
  if (roleResult.error) throw roleResult.error;
  const orgResult = await service.rpc('admin_set_user_org', {
    p_user_id: userId,
    p_org_id: homeOrgId,
    p_org_role: 'admin',
  });
  if (orgResult.error) throw orgResult.error;
  const adminResult = await service.rpc('admin_set_platform_admin', { p_user_id: userId, p_is_admin: true });
  if (adminResult.error) throw adminResult.error;
  const { error: disclaimerError } = await service
    .from('profiles')
    .update({ disclaimer_accepted_at: new Date().toISOString(), full_name: 'UAT22 Browser Admin' })
    .eq('id', userId);
  if (disclaimerError) throw disclaimerError;

  const human = createClient(process.env.E2E_SUPABASE_URL!, process.env.VITE_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signedIn = await human.auth.signInWithPassword({ email, password });
  if (signedIn.error || !signedIn.data.session) throw signedIn.error ?? new Error('Browser fixture sign-in failed');
  const enrolled = await human.auth.mfa.enroll({ factorType: 'totp' });
  if (enrolled.error || !enrolled.data) throw enrolled.error ?? new Error('Browser fixture MFA enrollment failed');
  const challenged = await human.auth.mfa.challenge({ factorId: enrolled.data.id });
  if (challenged.error || !challenged.data) throw challenged.error ?? new Error('Browser fixture MFA challenge failed');
  const verified = await human.auth.mfa.verify({
    factorId: enrolled.data.id,
    challengeId: challenged.data.id,
    code: totp(enrolled.data.totp.secret),
  });
  if (verified.error) throw verified.error;
  const current = await human.auth.getSession();
  if (!current.data.session) throw new Error('Browser fixture AAL2 session missing');
  sessionState = {
    cookies: [],
    origins: [{
      origin: resolveE2EFrontendOrigin(),
      localStorage: [{
        name: supabaseAuthStorageKey(process.env.E2E_SUPABASE_URL!),
        value: JSON.stringify(current.data.session),
      }],
    }],
  };
});

test.afterAll(() => {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) throw new Error('SUPABASE_DB_URL is required for browser fixture cleanup');
  const sql = `begin; set local session_replication_role=replica;
    delete from public.org_members where user_id='${userId}' or org_id in ('${orgId}','${homeOrgId}');
    delete from public.profiles where id='${userId}';
    delete from auth.users where id='${userId}';
    delete from public.organizations where id in ('${orgId}','${homeOrgId}'); commit;`;
  execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'ignore' });
});

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 375, height: 812 }]) {
  test(`platform admin sends a selected-org role invitation at ${viewport.width}px`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ storageState: sessionState, viewport });
    const page = await context.newPage();
    const pageErrors: Error[] = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    const bodies: Array<{ email: string; role: string; idempotency_key: string }> = [];
    let detailReads = 0;
    let memberReads = 0;
    let invitationReads = 0;
    await page.route(`**/api/admin/organizations/${orgId}`, async (route) => {
      detailReads += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          organization: {
            id: orgId,
            legal_name: `UAT22 Browser Selected ${suffix}`,
            display_name: `UAT22 Browser Selected ${suffix}`,
            verification_status: 'UNVERIFIED',
          },
        }),
      });
    });
    await page.route(`**/api/admin/organizations/${orgId}/members`, async (route) => {
      memberReads += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ members: [] }) });
    });
    // Browser transport/rendering proof only: worker list/create responses are
    // captured here; the real mounted-route suite verifies authorization/DB reads.
    await page.route(`**/api/admin/organizations/${orgId}/invitations`, async (route) => {
      if (route.request().method() === 'GET') {
        invitationReads += 1;
        const invitations = bodies.map((body) => ({
          id: body.idempotency_key,
          email: body.email,
          role: body.role,
          status: 'pending',
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 86400_000).toISOString(),
          accepted_at: null,
        }));
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ invitations }) });
        return;
      }
      expect(route.request().method()).toBe('POST');
      bodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ sent: true }) });
    });

    await page.goto(`/organizations/${orgId}`);
    await expect(page.getByRole('heading', { name: `UAT22 Browser Selected ${suffix}` })).toBeVisible();
    await page.getByRole('tab', { name: 'People' }).click();
    await expect(page.getByRole('heading', { name: 'No members yet' })).toBeVisible();
    expect(detailReads).toBeGreaterThan(0);
    expect(memberReads).toBeGreaterThan(0);
    expect(invitationReads).toBeGreaterThan(0);
    await page.getByRole('button', { name: /Invite Member/i }).click();
    const dialog = page.getByRole('dialog', { name: 'Invite Team Member' });
    await dialog.getByLabel('Email address').fill(`uat22-recipient-${suffix}@example.test`);
    await dialog.getByLabel('Role').click();
    await page.getByRole('option', { name: 'Admin' }).click();
    await expect(dialog.getByLabel('Role')).toContainText('Admin');
    await expect(page.getByRole('option', { name: 'Admin' })).toBeHidden();
    await page.screenshot({
      path: testInfo.outputPath(`uat22-invite-${viewport.name}.png`),
      fullPage: true,
    });
    await dialog.getByRole('button', { name: /Send Invitation/i }).click();
    await expect(page.getByText('Invitation sent successfully.')).toBeVisible();
    await expect(page.getByText(`uat22-recipient-${suffix}@example.test`, { exact: true })).toBeVisible();
    expect(invitationReads).toBeGreaterThan(1);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ role: 'ORG_ADMIN', email: `uat22-recipient-${suffix}@example.test` });
    expect(bodies[0].idempotency_key).toMatch(/^[0-9a-f-]{36}$/i);
    expect(pageErrors).toEqual([]);
    await context.close();
  });
}

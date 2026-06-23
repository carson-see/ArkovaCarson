/**
 * Verified-Identity Entitlement Gate — E2E (PAY-01 / SCRUM-2384)
 *
 * Exercises the verified-only feature gate end-to-end through the worker:
 *   - seed a current subscription + an open `identity_verified` entitlement
 *     → GET /api/v1/identity/entitlement returns { entitled: true }
 *   - revoke (close the entitlement window) → { entitled: false }
 *   - re-grant but make the subscription period STALE (SCRUM-1791)
 *     → { entitled: false } (must never gate on a stale period)
 *
 * Auth: signs the seed individual in against local Supabase to mint a real
 * worker Bearer token (the endpoint uses verifyAuthToken). DB rows are seeded
 * via the service client (bypasses RLS, test-data only).
 *
 * Requires the worker running on E2E_WORKER_URL (default localhost:3001) and a
 * local Supabase. Cleans up all rows it creates.
 */

import { createClient } from '@supabase/supabase-js';
import { test, expect, getServiceClient, SEED_USERS } from './fixtures';

const WORKER_URL = process.env.E2E_WORKER_URL || 'http://localhost:3001';
const SUPABASE_URL = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';
const SEED_PASSWORD = process.env.E2E_SEED_PASSWORD || '';
const VERIFIED_IDENTITY_ENTITLEMENT = 'identity_verified';

const USER = SEED_USERS.individual;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

test.describe('Verified-Identity Entitlement Gate (PAY-01)', () => {
  const service = getServiceClient();
  let accessToken: string | null = null;
  let planId: string | null = null;

  test.beforeAll(async () => {
    // Mint a real worker token for the seed individual.
    const anon = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await anon.auth.signInWithPassword({
      email: USER.email,
      password: SEED_PASSWORD,
    });
    if (error || !data.session) {
      throw new Error(`beforeAll: failed to sign in seed individual: ${error?.message}`);
    }
    accessToken = data.session.access_token;

    // subscriptions.plan_id is NOT NULL — use any existing plan.
    const { data: plan } = await service.from('plans').select('id').limit(1).maybeSingle();
    planId = plan?.id ?? 'free';
  });

  test.beforeEach(async () => {
    // Clean slate for this user's verified-identity entitlement + subscription.
    await service.from('entitlements').delete()
      .eq('user_id', USER.id).eq('entitlement_type', VERIFIED_IDENTITY_ENTITLEMENT);
    await service.from('subscriptions').delete().eq('user_id', USER.id);
  });

  test.afterAll(async () => {
    await service.from('entitlements').delete()
      .eq('user_id', USER.id).eq('entitlement_type', VERIFIED_IDENTITY_ENTITLEMENT);
    await service.from('subscriptions').delete().eq('user_id', USER.id);
  });

  async function getEntitlement(request: import('@playwright/test').APIRequestContext) {
    const res = await request.get(`${WORKER_URL}/api/v1/identity/entitlement`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.ok()).toBeTruthy();
    return (await res.json()) as { entitled: boolean };
  }

  test('grants when an open entitlement and a current subscription exist', async ({ request }) => {
    await service.from('subscriptions').insert({
      user_id: USER.id,
      plan_id: planId,
      status: 'active',
      current_period_start: iso(-5 * 24 * 60 * 60 * 1000),
      current_period_end: iso(25 * 24 * 60 * 60 * 1000),
    });
    await service.from('entitlements').insert({
      user_id: USER.id,
      entitlement_type: VERIFIED_IDENTITY_ENTITLEMENT,
      source: 'subscription',
      valid_from: iso(-5 * 24 * 60 * 60 * 1000),
      valid_until: null,
    });

    const body = await getEntitlement(request);
    expect(body.entitled).toBe(true);
  });

  test('denies after the entitlement window is closed (revoked/lapsed)', async ({ request }) => {
    await service.from('subscriptions').insert({
      user_id: USER.id,
      plan_id: planId,
      status: 'active',
      current_period_start: iso(-5 * 24 * 60 * 60 * 1000),
      current_period_end: iso(25 * 24 * 60 * 60 * 1000),
    });
    // closed window: valid_until already in the past.
    await service.from('entitlements').insert({
      user_id: USER.id,
      entitlement_type: VERIFIED_IDENTITY_ENTITLEMENT,
      source: 'subscription',
      valid_from: iso(-30 * 24 * 60 * 60 * 1000),
      valid_until: iso(-1 * 24 * 60 * 60 * 1000),
    });

    const body = await getEntitlement(request);
    expect(body.entitled).toBe(false);
  });

  test('SCRUM-1791: denies on a STALE subscription period even with an open entitlement', async ({ request }) => {
    // period ended 10 days ago — must not gate on it.
    await service.from('subscriptions').insert({
      user_id: USER.id,
      plan_id: planId,
      status: 'active',
      current_period_start: iso(-40 * 24 * 60 * 60 * 1000),
      current_period_end: iso(-10 * 24 * 60 * 60 * 1000),
    });
    await service.from('entitlements').insert({
      user_id: USER.id,
      entitlement_type: VERIFIED_IDENTITY_ENTITLEMENT,
      source: 'subscription',
      valid_from: iso(-40 * 24 * 60 * 60 * 1000),
      valid_until: null,
    });

    const body = await getEntitlement(request);
    expect(body.entitled).toBe(false);
  });

  test('denies (fail-closed) with no subscription at all', async ({ request }) => {
    await service.from('entitlements').insert({
      user_id: USER.id,
      entitlement_type: VERIFIED_IDENTITY_ENTITLEMENT,
      source: 'subscription',
      valid_from: iso(-5 * 24 * 60 * 60 * 1000),
      valid_until: null,
    });

    const body = await getEntitlement(request);
    expect(body.entitled).toBe(false);
  });
});

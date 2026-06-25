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
 *
 * Live-worker-only, like `api-verify-flow.spec.ts`: every assertion drives the
 * real worker over HTTP and a real Supabase session, so the whole suite is a
 * no-op unless the live-worker env is wired (anon key + seed password — both
 * are present in the CI E2E job and during a staging soak, absent on a bare
 * local checkout). The skip is evaluated at the `test.describe` top so it short-
 * circuits BEFORE `beforeAll` runs — the bespoke `createClient(...)` (which on
 * Node < 22 needs the `ws` realtime-transport polyfill) is never constructed
 * when the env is missing, instead of throwing in a hook and red-failing CI.
 */

import { createClient } from '@supabase/supabase-js';
import { test, expect, getServiceClient, SEED_USERS } from './fixtures';
import { WS_CLIENT_OPTIONS } from './fixtures/supabase';

const WORKER_URL = process.env.E2E_WORKER_URL || 'http://localhost:3001';
const SUPABASE_URL = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';
const SEED_PASSWORD = process.env.E2E_SEED_PASSWORD || '';
const VERIFIED_IDENTITY_ENTITLEMENT = 'identity_verified';

// Live-worker env presence: the anon key (to mint a real session) and the seed
// password (to sign the seed individual in) are the two vars without which this
// suite cannot exercise anything real. When either is absent we skip the whole
// group rather than construct clients / hit a worker that isn't there.
const LIVE_WORKER_ENV = Boolean(ANON_KEY) && Boolean(SEED_PASSWORD);

const USER = SEED_USERS.individual;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

test.describe('Verified-Identity Entitlement Gate (PAY-01)', () => {
  // Skip-guard at the describe level so it runs before `beforeAll`: with no
  // live-worker env (normal local run / non-app-affecting CI), the suite is
  // reported SKIPPED and the `createClient(...)` below never executes. In CI's
  // E2E job and in a staging soak the env IS wired, so every test runs for real.
  test.skip(
    !LIVE_WORKER_ENV,
    'Live-worker E2E: requires VITE_SUPABASE_ANON_KEY + E2E_SEED_PASSWORD (set in CI E2E job / staging soak)',
  );

  // SERIAL: every test mutates the SAME seed individual's single subscription
  // row (`subscriptions` has UNIQUE(user_id)) and entitlement window. Under the
  // repo default `fullyParallel: true` (workers default to CPU/2 off-CI), the
  // four tests would run concurrently and clobber that one shared row — the
  // "grants" test's current-period upsert races the "stale"/"closed" tests'
  // upserts (last write wins), so the gate non-deterministically read the wrong
  // period and `entitled` flipped. They share mutable per-user state, so they
  // must run in order. (CI already runs workers=1, which is why this surfaced
  // only locally.)
  test.describe.configure({ mode: 'serial' });

  const service = getServiceClient();
  let accessToken: string | null = null;
  let planId: string | null = null;

  test.beforeAll(async () => {
    // Mint a real worker token for the seed individual. Pass WS_CLIENT_OPTIONS
    // (the `ws` realtime transport) like getServiceClient()/profile-session.ts —
    // without it @supabase/realtime-js throws "Node.js 20 detected without
    // native WebSocket support" at construction on the Node 20 CI runner.
    const anon = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
      ...WS_CLIENT_OPTIONS,
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
    expect(res.ok(), `entitlement GET returned ${res.status()}: ${await res.text()}`).toBeTruthy();
    return (await res.json()) as { entitled: boolean };
  }

  // `subscriptions` has a UNIQUE(user_id) constraint (`subscriptions_user_unique`),
  // and the seed always provisions a subscription for `demo-user`. A plain
  // `insert` therefore collides (23505) with whatever row already exists — the
  // `beforeEach` delete narrows the window but a swallowed insert error silently
  // leaves a stale (valid-period) row behind, which then bleeds into later tests
  // (a verified gate flips true when it must be false). Upserting on the unique
  // `user_id` makes each test's subscription period deterministic regardless of
  // prior state, and asserting the error keeps a future schema change from
  // silently no-op-ing the seed again.
  async function setSubscription(period: { startMs: number; endMs: number; status?: string }) {
    const { error } = await service
      .from('subscriptions')
      .upsert(
        {
          user_id: USER.id,
          plan_id: planId,
          status: period.status ?? 'active',
          current_period_start: iso(period.startMs),
          current_period_end: iso(period.endMs),
        },
        { onConflict: 'user_id' },
      );
    expect(error, `subscription upsert failed: ${JSON.stringify(error)}`).toBeNull();
  }

  async function setEntitlement(window: { fromMs: number; untilMs: number | null }) {
    const { error } = await service.from('entitlements').insert({
      user_id: USER.id,
      entitlement_type: VERIFIED_IDENTITY_ENTITLEMENT,
      source: 'subscription',
      valid_from: iso(window.fromMs),
      valid_until: window.untilMs === null ? null : iso(window.untilMs),
    });
    expect(error, `entitlement insert failed: ${JSON.stringify(error)}`).toBeNull();
  }

  const DAY = 24 * 60 * 60 * 1000;

  test('grants when an open entitlement and a current subscription exist', async ({ request }) => {
    await setSubscription({ startMs: -5 * DAY, endMs: 25 * DAY });
    await setEntitlement({ fromMs: -5 * DAY, untilMs: null });

    const body = await getEntitlement(request);
    expect(body.entitled).toBe(true);
  });

  test('denies after the entitlement window is closed (revoked/lapsed)', async ({ request }) => {
    await setSubscription({ startMs: -5 * DAY, endMs: 25 * DAY });
    // closed window: valid_until already in the past.
    await setEntitlement({ fromMs: -30 * DAY, untilMs: -1 * DAY });

    const body = await getEntitlement(request);
    expect(body.entitled).toBe(false);
  });

  test('SCRUM-1791: denies on a STALE subscription period even with an open entitlement', async ({ request }) => {
    // period ended 10 days ago — must not gate on it.
    await setSubscription({ startMs: -40 * DAY, endMs: -10 * DAY });
    await setEntitlement({ fromMs: -40 * DAY, untilMs: null });

    const body = await getEntitlement(request);
    expect(body.entitled).toBe(false);
  });

  test('denies (fail-closed) with no subscription at all', async ({ request }) => {
    // Explicitly ensure NO subscription row exists (don't rely on beforeEach
    // ordering): the gate must fail closed when the period source is absent.
    await service.from('subscriptions').delete().eq('user_id', USER.id);
    await setEntitlement({ fromMs: -5 * DAY, untilMs: null });

    const body = await getEntitlement(request);
    expect(body.entitled).toBe(false);
  });
});

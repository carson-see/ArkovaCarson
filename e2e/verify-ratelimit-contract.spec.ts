/**
 * Verify rate-limit contract — SCRUM-2603 (RED de-risking artifact).
 *
 * §1.10 contract: anonymous verify traffic is capped at 100 req/min/IP. This
 * spec proves the DEFECT: `GET /api/v1/verify/{publicId}` is actually 429'd at
 * ~10 req/min/IP because `adminRouter`'s limit-10 checkout limiter
 * (routes/admin.ts:37 `adminRouter.use(rateLimiters.checkout)`) is mounted at
 * `/api` (index.ts:351 `app.use('/api', adminRouter)`) AHEAD of the verify
 * router, which only lands via `app.use('/api/v1', apiV1Router)` at index.ts:458.
 * Express runs a prefix-mounted router's middleware for EVERY `/api/*` request
 * before it fails to match an inner route and calls next(), so every verify
 * request passes the admin 10/min bucket first. The verify router's own
 * anonRateLimiter (api/v1/router.ts:156-158) is correctly 100/min but never
 * becomes the binding limit.
 *
 * This spec is written RED and is expected to FAIL against the current mount
 * order (11 anonymous verify GETs from one IP → a 429 appears well before 100).
 * The FIX (an early `/api/v1/verify` bypass mount in index.ts, mirroring the
 * PAY-01 `/api/v1/identity` fix at index.ts:340) is WITHHELD this window because
 * index.ts mount order is the exact surface #1411/#1412/#1439 are soaking. Do
 * NOT edit services/worker/src/index.ts here.
 *
 * TARGET RIG: this must run against a NEW throwaway Supabase project + its own
 * tagged Cloud Run — never shared staging, prod, or a live soaking micro-rig.
 * The soaking-ref guard (assertNotSoakingRef) refuses any protected ref BEFORE
 * the run. Standing up that throwaway rig is a Carson-gated infra action; until
 * E2E_WORKER_URL + E2E_SUPABASE_PROJECT_REF point at a cleared throwaway rig the
 * suite skips (it never silently passes and never touches a protected rig).
 */

import { test, expect, getServiceClient, createTestAnchor, deleteTestAnchor, SEED_USERS } from './fixtures';
import { assertNotSoakingRef } from './helpers/soaking-ref-guard';

const WORKER_URL = process.env.E2E_WORKER_URL || 'http://localhost:3001';
const TARGET_REF = process.env.E2E_SUPABASE_PROJECT_REF ?? '';

// §1.10 anonymous contract.
const ANON_LIMIT_PER_MIN = 100;
// How many requests to fire from one IP within the window. Must exceed the
// broken 10/min cap and stay under the 100/min contract so ALL should be 2xx.
const BURST = 11;
// Single fixed source IP so every request aggregates into one per-IP bucket
// (req.ip derives from X-Forwarded-For under `app.set('trust proxy', 2)`).
const FIXED_IP = '203.0.113.77'; // TEST-NET-3, RFC 5737

// Guard the whole suite: only run when a cleared throwaway rig is configured.
// evaluateReproTargetRef throws for shared/prod/staging/soaking refs.
let refCleared = false;
let refError: string | null = null;
try {
  if (TARGET_REF) {
    assertNotSoakingRef(TARGET_REF);
    refCleared = true;
  }
} catch (e) {
  refError = e instanceof Error ? e.message : String(e);
}

test.describe('Verify rate-limit contract (SCRUM-2603, RED)', () => {
  test.skip(
    !TARGET_REF,
    'E2E_SUPABASE_PROJECT_REF unset — repro requires a Carson-provisioned throwaway rig',
  );
  test.skip(
    Boolean(TARGET_REF) && !refCleared,
    `soaking-ref guard refused the target rig: ${refError ?? 'protected ref'}`,
  );

  let testPublicId: string;
  let testAnchorId: string;
  const serviceClient = getServiceClient();

  test.beforeAll(async () => {
    // Hard stop before ANY write: never seed against a protected rig.
    assertNotSoakingRef(TARGET_REF);

    const anchor = await createTestAnchor(serviceClient, {
      userId: SEED_USERS.individual.id,
      status: 'SECURED',
      filename: 'e2e_2603_ratelimit.pdf',
      fingerprint: `e2e_2603_${Date.now()}_${'c'.repeat(44)}`,
    });
    if (!anchor?.id || !anchor?.public_id) {
      throw new Error('beforeAll: failed to seed test anchor for the rate-limit repro');
    }
    testAnchorId = anchor.id;
    testPublicId = anchor.public_id;
  });

  test.afterAll(async () => {
    if (testAnchorId) {
      await deleteTestAnchor(serviceClient, testAnchorId);
    }
  });

  test('allows >10 verify requests per minute from one IP (§1.10 anon 100/min)', async ({ request }) => {
    const url = `${WORKER_URL}/api/v1/verify/${encodeURIComponent(testPublicId)}`;
    const statuses: number[] = [];

    for (let i = 0; i < BURST; i++) {
      const res = await request.get(url, {
        headers: { 'X-Forwarded-For': FIXED_IP },
      });
      statuses.push(res.status());
    }

    const rejected = statuses.filter((s) => s === 429);

    // RED: with the admin limit-10 checkout limiter binding first, request #11
    // (and beyond) 429s even though the §1.10 contract permits 100/min. This
    // assertion FAILS on the current mount order and PASSES once the verify
    // router gets an early bypass mount (fix withheld this window).
    expect(
      rejected.length,
      `Expected 0 rejections within ${BURST} < ${ANON_LIMIT_PER_MIN}/min, got ${rejected.length}. ` +
        `Statuses: ${statuses.join(',')}. This is the SCRUM-2603 defect: admin checkout ` +
        `limiter (limit 10) mounted at /api ahead of the verify router.`,
    ).toBe(0);

    // Every response within the contract must be a success (2xx).
    for (const s of statuses) {
      expect(s, `status ${s} within a ${BURST}-request burst should be 2xx`).toBeLessThan(300);
    }
  });

  test('exposes the §1.10 rate-limit headers on verify responses', async ({ request }) => {
    const url = `${WORKER_URL}/api/v1/verify/${encodeURIComponent(testPublicId)}`;
    const res = await request.get(url, { headers: { 'X-Forwarded-For': FIXED_IP } });
    const headers = res.headers();

    // The binding limit advertised to anonymous verify callers must be the
    // §1.10 anon contract (100), NOT the admin checkout bucket (10).
    expect(headers['x-ratelimit-limit']).toBeDefined();
    expect(
      headers['x-ratelimit-limit'],
      `X-RateLimit-Limit should advertise the §1.10 anon contract (${ANON_LIMIT_PER_MIN}), ` +
        `not the admin checkout bucket (10)`,
    ).toBe(String(ANON_LIMIT_PER_MIN));
  });

  test('a real 429 (only past 100/min) carries Retry-After', async ({ request }) => {
    // Drive past the TRUE contract limit to force a legitimate 429 and assert it
    // carries Retry-After per §1.10. On the broken mount order the 429 arrives
    // far too early (~10), but whenever it arrives it must carry Retry-After.
    const url = `${WORKER_URL}/api/v1/verify/${encodeURIComponent(testPublicId)}`;
    let sawRateLimited: Awaited<ReturnType<typeof request.get>> | null = null;

    for (let i = 0; i < ANON_LIMIT_PER_MIN + 5; i++) {
      const res = await request.get(url, { headers: { 'X-Forwarded-For': FIXED_IP } });
      if (res.status() === 429) {
        sawRateLimited = res;
        break;
      }
    }

    expect(sawRateLimited, 'expected a 429 once the per-IP limit is exceeded').not.toBeNull();
    const headers = sawRateLimited!.headers();
    expect(headers['retry-after'], '429 must carry Retry-After per §1.10').toBeDefined();
  });
});

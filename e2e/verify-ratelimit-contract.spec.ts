/**
 * Verify rate-limit contract — SCRUM-2603 (RED de-risking artifact).
 *
 * §1.10 contract: anonymous verify traffic is capped at 100 req/min/IP. This
 * spec proves the DEFECT: `GET /api/v1/verify/{publicId}` is 429'd far below the
 * 100/min contract because `adminRouter`'s limit-10 checkout limiter
 * (routes/admin.ts:37 `adminRouter.use(rateLimiters.checkout)`) is mounted at
 * `/api` (index.ts:351 `app.use('/api', adminRouter)`) AHEAD of the verify
 * router, which only lands via `app.use('/api/v1', apiV1Router)` at index.ts:458.
 * Express runs a prefix-mounted router's middleware for EVERY `/api/*` request
 * before it fails to match an inner route and calls next(), so every verify
 * request traverses the admin 10/min bucket first. The verify router's own
 * anonRateLimiter (api/v1/router.ts:156-158) is correctly 100/min but never
 * becomes the binding limit.
 *
 * MAGNITUDE (corrected): the real first-429 lands at ~request #4, NOT ~#10, so
 * the effective cap is ~1/25th of the contract, not 1/10th. Every /api/* limiter
 * (`rateLimiters.api`=60, checkout=10, anon=100) shares ONE bare-IP bucket —
 * they all default to `keyGenerator = req.ip` with NO `scope` (rateLimit.ts:107),
 * so a single verify request INCREMENTS the shared per-IP counter multiple times
 * as it passes badge's api(60) → admin's checkout(10) → didWeb's api(60) → the
 * v1 anon(100). The checkout limit (10) binds first, and because the counter is
 * already advanced by the earlier limiters in the same request, it trips after
 * only ~3 verify requests (first 429 ≈ request #4). The shared-bucket multi-
 * increment is the real amplifier; the checkout cap is merely the lowest ceiling.
 *
 * HEADER SEMANTICS (why the header assertion is written the way it is): a limiter
 * that PASSES sets `X-RateLimit-Limit = its own max` and calls next()
 * (last-writer-wins), so on a 2xx verify response the LAST limiter in the chain —
 * the v1 anon(100) — is the writer, and the header reads 100 EVEN ON THE BROKEN
 * MOUNT ORDER. A `X-RateLimit-Limit === 100` assertion on a passing response is
 * therefore NOT fail-first (it is green on the defect). The honest RED signature
 * is the 429 itself: a limiter that REJECTS sets `X-RateLimit-Limit = its own max`
 * and returns (rateLimit.ts:135), so the early checkout 429 carries
 * `X-RateLimit-Limit: 10`. Test 2 below asserts no sub-contract 429 (limit < 100)
 * appears within a burst under the contract — RED today (checkout 429 @ ~#4 carries
 * 10), GREEN once verify bypasses the admin chain (the withheld fix).
 *
 * This spec is written RED and is expected to FAIL against the current mount
 * order (a burst of anonymous verify GETs from one IP → a sub-contract 429 well
 * before 100). The FIX (an early `/api/v1/verify` bypass mount in index.ts,
 * mirroring the PAY-01 `/api/v1/identity` fix at index.ts:340-345) is WITHHELD
 * this window because `services/worker/src/index.ts` mount order is a live-soak
 * surface. Do NOT edit services/worker/src/index.ts here. (See the PR description
 * for the active-soak PR references that pin index.ts this window.)
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
// broken cap (~4, checkout=10 on a shared multi-increment bucket) and stay under
// the 100/min contract so ALL should be 2xx on the fixed code.
const BURST = 11;
// The server-side rate-limit bucket is keyed purely on the per-IP source
// (req.ip derives from X-Forwarded-For under `app.set('trust proxy', 2)`), with
// NO path scope — so every request from a given IP within the 60s window shares
// ONE mutable counter across ALL three tests. Reusing one IP across tests bleeds
// counts between them (test 3 fires 100+ requests to force a 429; if test 1 then
// reused that IP its burst would 429 on correct code). Each test therefore gets
// its OWN TEST-NET-3 (RFC 5737, non-routable) IP so their buckets never collide,
// and the suite runs serial (below) so no two tests race the same bucket. This
// mirrors identity-entitlement.spec.ts, which added mode:'serial' for the same
// shared-mutable-state reason.
const IP_ALLOW_BURST = '203.0.113.77'; // test 1 — sub-contract burst all-2xx
const IP_HEADER = '203.0.113.78'; // test 2 — 429 header contract
const IP_RETRY_AFTER = '203.0.113.79'; // test 3 — drive past 100/min to a real 429

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
  // SERIAL + per-test IP: all three tests hit the SAME server-side per-IP
  // rate-limit bucket family (60s window, no path scope). Under the repo default
  // `fullyParallel: true` (playwright.config.ts) they would otherwise run
  // concurrently and, even on distinct IPs, share the 60s wall-clock window; test
  // 3 deliberately fills a bucket to 100+ to force a real 429. Running serial (and
  // giving each test its own IP) keeps the buckets isolated and deterministic so
  // one test's consumed counts can never false-fail another. Precedent:
  // identity-entitlement.spec.ts:70.
  test.describe.configure({ mode: 'serial' });

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
        headers: { 'X-Forwarded-For': IP_ALLOW_BURST },
      });
      statuses.push(res.status());
    }

    const rejected = statuses.filter((s) => s === 429);

    // RED: with the admin limit-10 checkout limiter binding first (and the shared
    // per-IP bucket already advanced by the earlier api(60) limiters), a 429
    // appears at ~request #4 even though the §1.10 contract permits 100/min. This
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

  test('never 429s a verify burst with a sub-contract limit header (checkout=10)', async ({ request }) => {
    // Header semantics (see file header): a PASSING limiter sets
    // X-RateLimit-Limit = its own max and next()s (last-writer-wins), so a 2xx
    // verify response carries the v1 anon(100) header EVEN ON THE BROKEN mount
    // order — asserting `=100` on a passing response is NOT fail-first. The
    // honest RED signature is the 429 itself: a REJECTING limiter sets
    // X-RateLimit-Limit = its own max and returns, so the early checkout 429
    // carries `10`. We fire a burst UNDER the §1.10 contract and assert that no
    // response is a 429 advertising a sub-contract limit.
    //
    // RED today: the checkout(10) limiter 429s at ~request #4 with
    // X-RateLimit-Limit:10 (< 100) → this fails.
    // GREEN after the withheld fix: verify bypasses the admin chain, so no 429
    // occurs within a sub-100 burst and every advertised limit is the anon
    // contract (100) → this passes. Assertion is consistent with the fix (verify
    // binds to anon=100), unlike a passing-response `=100` check which would go
    // RED against the very fix the PR prescribes.
    const url = `${WORKER_URL}/api/v1/verify/${encodeURIComponent(testPublicId)}`;

    type Sample = { status: number; limit: string | undefined };
    const samples: Sample[] = [];
    for (let i = 0; i < BURST; i++) {
      const res = await request.get(url, { headers: { 'X-Forwarded-For': IP_HEADER } });
      samples.push({ status: res.status(), limit: res.headers()['x-ratelimit-limit'] });
    }

    // Every response must advertise the rate-limit contract header at all (§1.10:
    // "Headers on every response").
    for (const s of samples) {
      expect(s.limit, `X-RateLimit-Limit must be present on every verify response (status ${s.status})`).toBeDefined();
    }

    // The binding limit for anonymous verify is the §1.10 anon contract (100);
    // a 429 advertising a lower ceiling (e.g. the admin checkout bucket, 10) is
    // the SCRUM-2603 defect. No sub-contract 429 may appear within a burst that
    // is itself under the contract.
    const subContract429 = samples.filter(
      (s) => s.status === 429 && Number(s.limit) < ANON_LIMIT_PER_MIN,
    );
    expect(
      subContract429.length,
      `A verify burst of ${BURST} < ${ANON_LIMIT_PER_MIN}/min must not 429 against a sub-contract limit. ` +
        `Got ${subContract429.length} such 429(s) advertising limits [${subContract429
          .map((s) => s.limit)
          .join(',')}] — the admin checkout limiter (10) binding ahead of the verify router (SCRUM-2603).`,
    ).toBe(0);
  });

  test('a real 429 (only past 100/min) carries Retry-After', async ({ request }) => {
    // Drive past the TRUE contract limit to force a legitimate 429 and assert it
    // carries Retry-After per §1.10. On the broken mount order the 429 arrives
    // far too early (~10), but whenever it arrives it must carry Retry-After.
    const url = `${WORKER_URL}/api/v1/verify/${encodeURIComponent(testPublicId)}`;
    let sawRateLimited: Awaited<ReturnType<typeof request.get>> | null = null;

    for (let i = 0; i < ANON_LIMIT_PER_MIN + 5; i++) {
      const res = await request.get(url, { headers: { 'X-Forwarded-For': IP_RETRY_AFTER } });
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

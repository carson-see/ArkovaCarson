/**
 * Verify rate-limit contract — SCRUM-2603.
 *
 * §1.10 contract: anonymous verify traffic is capped at 100 req/min per IP,
 * every response carries the rate-limit headers, and a 429 carries Retry-After.
 * This spec asserts that contract end-to-end against a real worker.
 *
 * WHAT USED TO BREAK IT. `GET /api/v1/verify/{publicId}` was 429'd far below
 * 100/min because the broad `/api` mounts ahead of `apiV1Router` ran their
 * middleware for every `/api/*` request. Two independent mechanisms, fixed in
 * two different places:
 *
 *   1. `adminRouter` (mounted at `/api`) opened with the limit-10
 *      `rateLimiters.checkout`, so verify traffic spent an admin bucket.
 *      Fixed by `routes/admin-paths.ts`: adminRouter's first middleware now
 *      `next('router')`s out for any path outside its own prefixes, so the
 *      checkout limiter never sees a `/api/v1/*` request.
 *   2. The 60/min-per-IP `apiIpShadowGuard` still bound verify, and bound it
 *      twice per request (it is mounted at `/api` AND prefix-less ahead of the
 *      did:web / proof-keys routers), leaving an effective ~30/min. Fixed by
 *      `middleware/apiIpShadowGuard.ts`: the public verify prefix skips the
 *      guard and binds instead to `apiV1Router`'s `anonRateLimiter`, the
 *      limiter that actually implements the 100/min anon tier.
 *
 * Compounding both: every unscoped limiter shared ONE bare-IP bucket, so a
 * single verify request advanced the same counter once per limiter it passed.
 * `utils/rateLimit.ts` now gives each limiter its own bucket namespace
 * (SCRUM-3418), so a limiter's cap means what it says.
 *
 * HEADER SEMANTICS (why the header assertion is written the way it is): a
 * limiter that PASSES sets `X-RateLimit-Limit = its own max` and calls next()
 * (last-writer-wins), so on a 2xx verify response the LAST limiter in the chain
 * is the writer. A `X-RateLimit-Limit === 100` assertion on a passing response
 * is therefore weak — it reads 100 even when an earlier limiter is the one
 * about to bind. The load-bearing signature is the 429 itself: a limiter that
 * REJECTS sets `X-RateLimit-Limit = its own max` and returns, so a 429 from a
 * shadowing limiter advertises that limiter's lower ceiling. Test 2 below
 * asserts no sub-contract 429 (limit < 100) appears within a burst that is
 * itself under the contract.
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
// How many requests to fire from one IP within the window. Comfortably above
// every historical sub-contract cap (checkout=10, the ~30/min shadow-guard
// ceiling) and well under the 100/min contract, so ALL must be 2xx.
const BURST = 11;
// The server-side rate-limit bucket is keyed `<limiter-scope>:<req.ip>` (req.ip
// derives from X-Forwarded-For under `app.set('trust proxy', 2)`), with NO path
// component — so every request from a given IP within the 60s window shares ONE
// mutable counter per limiter across ALL three tests. Reusing one IP across tests bleeds
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

test.describe('Verify rate-limit contract (SCRUM-2603)', () => {
  // SERIAL + per-test IP: all three tests hit the SAME server-side per-IP
  // rate-limit bucket family (60s window, no path component). Under the repo default
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

    // A burst under the contract must be entirely un-rejected. Any 429 here
    // means some limiter mounted ahead of apiV1Router is binding verify below
    // its 100/min tier again — the SCRUM-2603 regression.
    expect(
      rejected.length,
      `Expected 0 rejections within ${BURST} < ${ANON_LIMIT_PER_MIN}/min, got ${rejected.length}. ` +
        `Statuses: ${statuses.join(',')}. A limiter mounted at /api ahead of the verify ` +
        `router is binding below the §1.10 anon tier (SCRUM-2603).`,
    ).toBe(0);

    // Every response within the contract must be a success (2xx).
    for (const s of statuses) {
      expect(s, `status ${s} within a ${BURST}-request burst should be 2xx`).toBeLessThan(300);
    }
  });

  test('never 429s a verify burst with a sub-contract limit header (checkout=10)', async ({ request }) => {
    // Header semantics (see file header): a PASSING limiter sets
    // X-RateLimit-Limit = its own max and next()s (last-writer-wins), so a 2xx
    // verify response carries the v1 anon(100) header even when an earlier
    // limiter is the one about to bind — asserting `=100` on a passing response
    // proves little. The load-bearing signature is the 429: a REJECTING limiter
    // sets X-RateLimit-Limit = its own max and returns, so a shadowing limiter
    // advertises its lower ceiling (checkout would carry `10`, the IP shadow
    // guard `60`). We fire a burst UNDER the §1.10 contract and assert no
    // response is a 429 advertising a sub-contract limit.
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
          .join(',')}] — a limiter mounted ahead of the verify router is binding first (SCRUM-2603).`,
    ).toBe(0);
  });

  test('a real 429 (only past 100/min) carries Retry-After', async ({ request }) => {
    // Drive past the contract limit to force a legitimate 429 and assert it
    // carries Retry-After per §1.10. Whenever the 429 arrives it must carry the
    // header; test 1 is what pins WHERE it may arrive.
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

/**
 * Cross-Tenant Isolation E2E Tests (Tier 3) — hardened per DEG-4
 * (docs/staging/SOAK-PREMORTEM-SOC2-2026-08-11.md §4, Day-0 checklist step 7).
 *
 * The daily run of this spec is the G4 (CC6.1 cross-tenant isolation) evidence
 * for the SOC 2 Type 2 soak, so it must be structurally incapable of passing
 * hollow:
 *
 *  1. "Blocked" means an EXPLICIT blocked state only — the `Record Not Found`
 *     heading on the record path. Any navigation away (including a /login
 *     redirect from an expired accessor session) FAILS with a diagnostic
 *     message. The old helper treated any navigation away as blocked, so an
 *     expired Org B session on Day 4 made every test pass while proving
 *     nothing. Verdict logic is pure and unit-tested in
 *     tests/infra/cross-tenant-assertions.test.ts (the local RED/GREEN proof
 *     that a dead session now makes this suite RED).
 *  2. Every isolation test runs a positive-access PRECONDITION first: the
 *     accessing session must read its OWN data (authenticated,
 *     non-redirected). A precondition failure carries the distinct
 *     `precondition: <label> session not authenticated` message so it can
 *     never be mistaken for an isolation result.
 *  3. Coverage extends beyond the UI: direct PostgREST reads with an
 *     authenticated cross-tenant JWT (expect silent RLS filtering to zero
 *     rows) and the public API with a cross-tenant org API key (expect
 *     403/404). See the MCP note at the bottom of this file for the surface
 *     that remains DECLARED UNTESTED.
 *  4. Fixtures are seeded with `status: 'PENDING'` ONLY — never `SECURED`.
 *     Service-role SECURED inserts have no chain receipt and would re-create
 *     the fabricated-SECURED class Gate 0 deleted, and seven daily soak runs
 *     would inflate any Day-7 "N anchors reached SECURED" figure. Nothing in
 *     these assertions needs a SECURED row; if that ever changes, tag the
 *     fixture rows (metadata marker) and add them to the frozen-baseline
 *     exclusion list instead of silently seeding SECURED again.
 *
 * Seed-cast caveat (verified against supabase/seed.sql): sarah@arkova.ai
 * ("Org B admin", Arkova org) is seeded `is_platform_admin = true`, and the
 * `anchors_select_platform_admin` RLS policy legitimately grants her SELECT on
 * ALL anchors. She is therefore ONLY ever the victim/owner side of an
 * isolation assertion here, never the accessor — an "Org B admin cannot read
 * Org A" test with sarah as the accessor would fail BY DESIGN, and a green
 * one would mean RLS broke. The accessor roles are demo-admin (Org A admin,
 * Acme, NOT platform admin) and demo-user (individual).
 *
 * Live-stack requirements (CI E2E job wires all of these; none of the suites
 * below skip — a missing dependency fails loudly with a `precondition:`
 * message, per DEG-4's "no hollow pass" rule):
 *   - VITE_SUPABASE_ANON_KEY + E2E_SEED_PASSWORD for the PostgREST/API legs
 *   - the worker on E2E_WORKER_URL (default http://localhost:3001) for the
 *     public-API leg (same requirement as api-verify-flow.spec.ts)
 *
 * @created 2026-03-10 11:45 PM EST
 * @updated 2026-08-12 — DEG-4 hardening (fail on /login redirect,
 *   positive-access preconditions, PostgREST + public-API legs, PENDING-only
 *   fixtures)
 */

import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { test, expect, getServiceClient, createTestAnchor, deleteTestAnchor, SEED_USERS } from './fixtures';
import { WS_CLIENT_OPTIONS } from './fixtures/supabase';
import {
  evaluateRecordBlocked,
  evaluatePositiveAccess,
  RECORD_BLOCKED_HEADING,
  RECORD_DETAILS_HEADING,
  type RecordPageObservation,
} from './helpers/cross-tenant-assertions';

const SUPABASE_URL = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const WORKER_URL = process.env.E2E_WORKER_URL || 'http://localhost:3001';

/**
 * Fail loudly (never skip) when a live-stack dependency is missing. DEG-4:
 * a silently skipped isolation check reads as green evidence downstream.
 */
function requireLiveEnv(name: string, purpose: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `precondition: ${purpose} requires ${name} (wired in the CI E2E job — see .github/workflows/ci.yml). ` +
      'Refusing to skip: a skipped cross-tenant check must never read as isolation evidence.',
    );
  }
  return value;
}

/**
 * Observe where a /records/<id> navigation actually landed and which of the
 * two meaningful headings rendered. Pure verdicts are computed from this
 * observation by the unit-tested evaluators.
 */
async function observeRecordPage(page: Page, recordPath: string): Promise<RecordPageObservation> {
  try {
    await page.waitForFunction(
      ({ path, blockedHeading, detailsHeading }) => {
        if (window.location.pathname !== path) return true;
        const headings = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
          .map((el) => el.textContent?.trim());
        return headings.includes(blockedHeading) || headings.includes(detailsHeading);
      },
      { path: recordPath, blockedHeading: RECORD_BLOCKED_HEADING, detailsHeading: RECORD_DETAILS_HEADING },
      { timeout: 10_000 },
    );
  } catch {
    // Timed out with no signal — fall through; the evaluator treats the
    // indeterminate observation as a failure with a diagnostic reason.
  }

  const finalPath = new URL(page.url()).pathname;
  const notFoundHeadingVisible = await page
    .getByRole('heading', { name: RECORD_BLOCKED_HEADING })
    .isVisible()
    .catch(() => false);
  const detailsHeadingVisible = await page
    .getByRole('heading', { name: RECORD_DETAILS_HEADING })
    .isVisible()
    .catch(() => false);

  return { recordPath, finalPath, notFoundHeadingVisible, detailsHeadingVisible };
}

/**
 * Positive-access precondition (DEG-4): the accessing session must render its
 * OWN record before any isolation assertion. Fails with the distinct
 * `precondition: <label> session not authenticated` message on a redirect.
 */
async function assertOwnRecordReadable(
  page: Page,
  ownRecord: { id: string; filename: string },
  sessionLabel: string,
): Promise<void> {
  const recordPath = `/records/${ownRecord.id}`;
  await page.goto(recordPath);
  const observation = await observeRecordPage(page, recordPath);
  const verdict = evaluatePositiveAccess(observation, sessionLabel);
  if (!verdict.authenticated) {
    throw new Error(verdict.reason);
  }
  // The owner view renders the raw uploaded filename (unlike the public
  // projection) — assert it so "authenticated" also means "reading real data".
  await expect(page.getByText(ownRecord.filename)).toBeVisible();
}

/**
 * Hardened blocked-state assertion (DEG-4): navigates to the record and
 * requires the EXPLICIT blocked state. A /login redirect, a bounce to any
 * other route, a rendered record, or an indeterminate page all FAIL with the
 * evaluator's diagnostic reason.
 */
async function expectRecordBlocked(page: Page, recordId: string, protectedValues: string[]): Promise<void> {
  const recordPath = `/records/${recordId}`;
  await page.goto(recordPath);
  const observation = await observeRecordPage(page, recordPath);
  const verdict = evaluateRecordBlocked(observation);
  if (!verdict.blocked) {
    throw new Error(`expectRecordBlocked: ${verdict.reason}`);
  }
  await expect(page.getByRole('heading', { name: RECORD_BLOCKED_HEADING })).toBeVisible();
  for (const value of protectedValues) {
    await expect(page.locator('body')).not.toContainText(value);
  }
}

/**
 * List-isolation assertion for the org page. Hardened: a dead session's
 * /login redirect fails the URL assertion, and the `Records` heading must
 * render before the absence check — an empty shell whose list never loaded
 * would otherwise pass the not-contains assertion hollow.
 */
async function expectOrgRecordsListExcludes(page: Page, filename: string): Promise<void> {
  await page.goto('/organization');
  await expect(
    page,
    'precondition: org A admin session not authenticated — expected the authenticated org page ' +
    '(/organizations/:id); a redirect (e.g. to /login) is NOT list-isolation evidence',
  ).toHaveURL(/\/organizations\/[0-9a-f-]+/i, { timeout: 10_000 });
  await expect(
    page.getByRole('heading', { name: 'Records' }),
    'org page rendered but its Records section never loaded — absence of a filename on an unloaded list proves nothing',
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('body')).not.toContainText(filename);
}

// ─────────────────────────────────────────────────────────────────────────────
// UI isolation (browser sessions)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Cross-Tenant Isolation', () => {
  const serviceClient = getServiceClient();
  const createdAnchorIds: string[] = [];

  async function seedPendingAnchor(userId: string, filename: string) {
    // DEG-4: PENDING only — never seed SECURED from the service role.
    const anchor = await createTestAnchor(serviceClient, { userId, status: 'PENDING', filename });
    createdAnchorIds.push(anchor.id);
    return anchor;
  }

  test.afterAll(async () => {
    for (const id of createdAnchorIds) {
      await deleteTestAnchor(serviceClient, id);
    }
  });

  test.describe('User-to-User Isolation', () => {
    test('individual user cannot view org admin records via direct URL', async ({ individualPage }) => {
      const ts = Date.now();
      const ownAnchor = await seedPendingAnchor(SEED_USERS.individual.id, `e2e_ct_own_individual_${ts}.pdf`);
      const victimAnchor = await seedPendingAnchor(SEED_USERS.orgAdmin.id, `e2e_ct_victim_org_admin_${ts}.pdf`);

      // Precondition: the accessing session can read its OWN record.
      await assertOwnRecordReadable(individualPage, { id: ownAnchor.id, filename: ownAnchor.filename }, 'individual');

      // Isolation: the same (proven-live) session must hit the explicit blocked state.
      await expectRecordBlocked(individualPage, victimAnchor.id, [
        victimAnchor.filename,
        victimAnchor.fingerprint,
      ]);
    });

    test('org admin cannot view individual user records via direct URL', async ({ orgAdminPage }) => {
      const ts = Date.now();
      const ownAnchor = await seedPendingAnchor(SEED_USERS.orgAdmin.id, `e2e_ct_own_org_admin_${ts}.pdf`);
      const victimAnchor = await seedPendingAnchor(SEED_USERS.individual.id, `e2e_ct_victim_individual_${ts}.pdf`);

      await assertOwnRecordReadable(orgAdminPage, { id: ownAnchor.id, filename: ownAnchor.filename }, 'org A admin');

      await expectRecordBlocked(orgAdminPage, victimAnchor.id, [
        victimAnchor.filename,
        victimAnchor.fingerprint,
      ]);
    });
  });

  test.describe('Org-to-Org Isolation', () => {
    test('Org A admin cannot view Org B records via direct URL', async ({ orgAdminPage }) => {
      const ts = Date.now();
      const ownAnchor = await seedPendingAnchor(SEED_USERS.orgAdmin.id, `e2e_ct_own_orgA_${ts}.pdf`);
      // Victim: Org B admin (sarah, Arkova org). Victim-only — see seed-cast caveat in the header.
      const victimAnchor = await seedPendingAnchor(SEED_USERS.orgBAdmin.id, `e2e_ct_victim_orgB_${ts}.pdf`);

      await assertOwnRecordReadable(orgAdminPage, { id: ownAnchor.id, filename: ownAnchor.filename }, 'org A admin');

      await expectRecordBlocked(orgAdminPage, victimAnchor.id, [
        victimAnchor.filename,
        victimAnchor.fingerprint,
      ]);
    });

    test('Org B records do not appear in Org A dashboard list', async ({ orgAdminPage }) => {
      const ts = Date.now();
      const ownAnchor = await seedPendingAnchor(SEED_USERS.orgAdmin.id, `e2e_ct_own_orgA_list_${ts}.pdf`);
      const victimAnchor = await seedPendingAnchor(SEED_USERS.orgBAdmin.id, `e2e_cross_tenant_orgB_list_${ts}.pdf`);

      await assertOwnRecordReadable(orgAdminPage, { id: ownAnchor.id, filename: ownAnchor.filename }, 'org A admin');

      await expectOrgRecordsListExcludes(orgAdminPage, victimAnchor.filename);
    });

    test('Org A admin cannot see Org B records in organization registry', async ({ orgAdminPage }) => {
      const ts = Date.now();
      const ownAnchor = await seedPendingAnchor(SEED_USERS.orgAdmin.id, `e2e_ct_own_orgA_registry_${ts}.pdf`);
      const victimAnchor = await seedPendingAnchor(SEED_USERS.orgBAdmin.id, `e2e_cross_tenant_orgB_${ts}.pdf`);

      await assertOwnRecordReadable(orgAdminPage, { id: ownAnchor.id, filename: ownAnchor.filename }, 'org A admin');

      await expectOrgRecordsListExcludes(orgAdminPage, victimAnchor.filename);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Direct PostgREST access (RLS) — DEG-4 extension (a)
//
// The UI can only prove the frontend does not RENDER foreign data. This suite
// proves the database itself refuses it: an authenticated org-admin JWT
// querying another tenant's `anchors` rows through PostgREST must get silent
// RLS filtering (zero rows, no error).
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Cross-Tenant Isolation — direct PostgREST (RLS)', () => {
  const serviceClient = getServiceClient();
  const createdAnchorIds: string[] = [];
  let accessorClient: SupabaseClient;
  let ownAnchor: { id: string; filename: string };
  let victims: Array<{ id: string; label: string }>;

  test.beforeAll(async () => {
    const anonKey = requireLiveEnv('VITE_SUPABASE_ANON_KEY', 'cross-tenant PostgREST (RLS) coverage');

    // Accessor: demo-admin (Org A admin, Acme — NOT a platform admin, so RLS
    // must deny cross-tenant reads; see the seed-cast caveat in the header).
    accessorClient = createClient(SUPABASE_URL, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      ...WS_CLIENT_OPTIONS,
    });
    const { data, error } = await accessorClient.auth.signInWithPassword({
      email: SEED_USERS.orgAdmin.email,
      password: SEED_USERS.orgAdmin.password,
    });
    if (error || !data.session) {
      throw new Error(
        `precondition: org A admin session not authenticated — signInWithPassword failed: ${error?.message ?? 'no session'}`,
      );
    }

    const ts = Date.now();
    // DEG-4: PENDING only.
    const own = await createTestAnchor(serviceClient, {
      userId: SEED_USERS.orgAdmin.id,
      status: 'PENDING',
      filename: `e2e_ct_pgrst_own_${ts}.pdf`,
    });
    createdAnchorIds.push(own.id);
    ownAnchor = { id: own.id, filename: own.filename };

    const victimIndividual = await createTestAnchor(serviceClient, {
      userId: SEED_USERS.individual.id,
      status: 'PENDING',
      filename: `e2e_ct_pgrst_victim_individual_${ts}.pdf`,
    });
    createdAnchorIds.push(victimIndividual.id);
    const victimOrgB = await createTestAnchor(serviceClient, {
      userId: SEED_USERS.orgBAdmin.id,
      status: 'PENDING',
      filename: `e2e_ct_pgrst_victim_orgB_${ts}.pdf`,
    });
    createdAnchorIds.push(victimOrgB.id);

    victims = [
      { id: victimIndividual.id, label: "the individual user's" },
      { id: victimOrgB.id, label: "Org B (Arkova)'s" },
    ];
  });

  test.afterAll(async () => {
    for (const id of createdAnchorIds) {
      await deleteTestAnchor(serviceClient, id);
    }
    await accessorClient?.auth.signOut().catch(() => {});
  });

  test('RLS silently filters cross-tenant anchor reads for an authenticated org-admin JWT', async () => {
    // Positive-access precondition: the JWT reads its OWN row. Without this, a
    // revoked/expired JWT would make the zero-rows assertions below pass hollow.
    const { data: ownRows, error: ownError } = await accessorClient
      .from('anchors')
      .select('id, filename')
      .eq('id', ownAnchor.id);
    if (ownError || (ownRows ?? []).length !== 1) {
      throw new Error(
        'precondition: org A admin session not authenticated for PostgREST — could not read its OWN anchor row ' +
        `(error=${ownError?.message ?? 'none'}, rows=${(ownRows ?? []).length})`,
      );
    }
    expect(ownRows?.[0]?.filename).toBe(ownAnchor.filename);

    // Isolation: the same (proven-live) JWT gets ZERO rows for foreign anchors.
    for (const victim of victims) {
      const { data, error } = await accessorClient
        .from('anchors')
        .select('id, filename, fingerprint, user_id')
        .eq('id', victim.id);
      expect(error, `RLS must silently filter ${victim.label} anchor, not error`).toBeNull();
      expect(
        data ?? [],
        `RLS LEAK: the org A admin JWT read ${victim.label} anchor row via direct PostgREST`,
      ).toHaveLength(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Public API tenant scoping (API keys) — DEG-4 extension (b)
//
// Proves the worker's public API enforces org/key scoping: a batch job created
// under one org's API key must return 403/404 to another org's key. Keys are
// minted through the real endpoint (POST /api/v1/keys, org-admin JWT) so the
// HMAC secret never leaves the worker. Same live-worker requirement as
// api-verify-flow.spec.ts.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Cross-Tenant Isolation — public API (API keys)', () => {
  const serviceClient = getServiceClient();
  const runTag = Date.now();
  const KEY_NAMES = {
    orgA: `e2e_ct_key_orgA_${runTag}`,
    orgB: `e2e_ct_key_orgB_${runTag}`,
  } as const;
  // > SYNC_THRESHOLD (20) forces the async job path, which is the resource the
  // ownership check protects. The ids need not exist — items just verify:false.
  const JOB_ITEM_COUNT = 21;

  let api: APIRequestContext;
  let orgAKey: string;
  let orgBKey: string;
  let orgAJobId: string;
  let orgBJobId: string;

  async function mintBearerToken(email: string, password: string, label: string): Promise<string> {
    const anonKey = requireLiveEnv('VITE_SUPABASE_ANON_KEY', 'cross-tenant public-API coverage');
    const anon = createClient(SUPABASE_URL, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      ...WS_CLIENT_OPTIONS,
    });
    const { data, error } = await anon.auth.signInWithPassword({ email, password });
    if (error || !data.session) {
      throw new Error(`precondition: ${label} session not authenticated — signInWithPassword failed: ${error?.message ?? 'no session'}`);
    }
    return data.session.access_token;
  }

  async function createApiKey(bearerToken: string, name: string, label: string): Promise<string> {
    const res = await api.post(`${WORKER_URL}/api/v1/keys`, {
      headers: { Authorization: `Bearer ${bearerToken}` },
      data: { name, scopes: ['verify', 'verify:batch'] },
    });
    if (res.status() !== 201) {
      throw new Error(`precondition: could not mint ${label} API key (${res.status()}): ${await res.text()}`);
    }
    const body = (await res.json()) as { key?: string };
    if (!body.key) {
      throw new Error(`precondition: ${label} API key creation returned no raw key`);
    }
    return body.key;
  }

  async function createBatchJob(apiKey: string, label: string): Promise<string> {
    const publicIds = Array.from({ length: JOB_ITEM_COUNT }, (_, i) => `e2e-ct-${label}-item-${runTag}-${i}`);
    const res = await api.post(`${WORKER_URL}/api/v1/verify/batch`, {
      headers: { 'X-API-Key': apiKey },
      data: { public_ids: publicIds },
    });
    if (res.status() === 401) {
      throw new Error(`precondition: ${label} API key did not authenticate (401 on its own batch submit)`);
    }
    if (res.status() !== 202) {
      throw new Error(`precondition: ${label} batch job creation failed (${res.status()}): ${await res.text()}`);
    }
    const body = (await res.json()) as { job_id?: string };
    if (!body.job_id) {
      throw new Error(`precondition: ${label} batch job creation returned no job_id`);
    }
    return body.job_id;
  }

  function getJob(apiKey: string, jobId: string) {
    return api.get(`${WORKER_URL}/api/v1/jobs/${jobId}`, { headers: { 'X-API-Key': apiKey } });
  }

  test.beforeAll(async () => {
    api = await playwrightRequest.newContext();

    // Loud worker gate (matches api-verify-flow.spec.ts's live-worker premise).
    const health = await api.get(`${WORKER_URL}/health`).catch(() => null);
    if (!health || !health.ok()) {
      throw new Error(
        `precondition: cross-tenant public-API coverage requires the worker at ${WORKER_URL} ` +
        '(E2E_WORKER_URL) — it is started in the CI E2E job. Refusing to skip.',
      );
    }

    // Org A = Acme (demo-admin). Org B = Arkova (sarah). sarah's platform-admin
    // seed flag is irrelevant here: job ownership is checked per API KEY, and
    // each key is org-scoped at creation.
    const [orgAToken, orgBToken] = await Promise.all([
      mintBearerToken(SEED_USERS.orgAdmin.email, SEED_USERS.orgAdmin.password, 'org A admin'),
      mintBearerToken(SEED_USERS.orgBAdmin.email, SEED_USERS.orgBAdmin.password, 'org B admin'),
    ]);
    orgAKey = await createApiKey(orgAToken, KEY_NAMES.orgA, 'org A');
    orgBKey = await createApiKey(orgBToken, KEY_NAMES.orgB, 'org B');

    orgAJobId = await createBatchJob(orgAKey, 'orgA');
    orgBJobId = await createBatchJob(orgBKey, 'orgB');
  });

  test.afterAll(async () => {
    // api_keys deletes CASCADE to batch_verification_jobs + api_key_usage.
    await serviceClient.from('api_keys').delete().in('name', [KEY_NAMES.orgA, KEY_NAMES.orgB]);
    await api?.dispose();
  });

  test('an org API key cannot read another org\'s batch job (both directions)', async () => {
    // Positive-access preconditions: each key reads its OWN job. Without
    // these, a revoked key's 401 below could masquerade as tenant denial.
    const ownA = await getJob(orgAKey, orgAJobId);
    expect(ownA.status(), 'precondition: org A key must read its OWN job (positive access)').toBe(200);
    expect(((await ownA.json()) as { job_id: string }).job_id).toBe(orgAJobId);

    const ownB = await getJob(orgBKey, orgBJobId);
    expect(ownB.status(), 'precondition: org B key must read its OWN job (positive access)').toBe(200);
    expect(((await ownB.json()) as { job_id: string }).job_id).toBe(orgBJobId);

    // Isolation, both directions: explicit 403/404 — never 200, and never a
    // 401 (a dead key would be a precondition failure, not isolation).
    for (const [label, key, foreignJobId] of [
      ["org A key reading org B's job", orgAKey, orgBJobId],
      ["org B key reading org A's job", orgBKey, orgAJobId],
    ] as const) {
      const res = await getJob(key, foreignJobId);
      if (res.status() === 401) {
        throw new Error(`precondition: ${label} returned 401 — the key did not authenticate, so denial proves nothing`);
      }
      expect([403, 404], `${label} must be denied with an explicit 403/404, got ${res.status()}`).toContain(res.status());
      const bodyText = await res.text();
      expect(bodyText, `${label}: denial response must not leak job contents`).not.toContain('"results"');
      expect(bodyText, `${label}: denial response must not leak item ids`).not.toContain(`-item-${runTag}-`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TODO(DEG-4 / SOAK-PREMORTEM-SOC2-2026-08-11 §4): MCP/edge tenant scoping is
// DECLARED UNTESTED here — deliberately no fake test. The MCP surface
// (services/edge/src/mcp-server.ts, deployed as the edge.arkova.ai Cloudflare
// Worker, proxying the worker's v2 API with per-caller org scoping) has no
// existing e2e harness in e2e/: the CI E2E job starts Supabase, the frontend
// and the Node worker, but no wrangler dev instance of the edge worker, and no
// spec in this directory drives one. Unit coverage of the MCP tool handlers
// lives in tests/infra/mcp-server.test.ts and services/edge/src/mcp-tools.test.ts.
// Cross-tenant MCP e2e coverage requires an edge-worker test harness first;
// until then any soak evidence pack must list the MCP surface's tenant scoping
// as NOT asserted by this spec.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CPE-02 (SCRUM-2380) — RLS proof for the org CPE dashboard read path.
 *
 * The dashboard hook (src/hooks/useOrgCpeMemberSummary.ts) reads
 * `anchors (user_id, status, issued_at)` filtered by
 * org_id + credential_type='CPE' + cpe_metadata IS NOT NULL (the 0342
 * partial-index shape), under the caller's OWN JWT (SECURITY INVOKER path).
 *
 * What this suite PROVES against live RLS (consolidated `anchors_select`
 * policy from migration 0307: own rows OR caller's-org rows OR platform
 * admin):
 *   1. Cross-org isolation — an org-B admin gets ZERO org-A CPE rows, even
 *      when explicitly requesting org-A's org_id.
 *   2. Org-admin within-org read — an org-A admin sees BOTH their own and a
 *      plain member's CPE rows.
 *   3. A plain member can read their OWN rows.
 *   4. Anonymous callers get nothing.
 *
 * DOCUMENTED STANDING BEHAVIOR (not a new leak, flagged in the PR): the
 * consolidated `anchors_select` policy grants EVERY org member the org-wide
 * read (`org_id = get_user_org_id()`), so a plain member CAN select org-mates'
 * anchor rows at the RLS layer. "Member sees only own rows" on the dashboard
 * is therefore enforced at the QUERY layer (the hook pins `user_id`);
 * expressing it in RLS would require a NEW policy (= migration), which
 * Sprint 3 is explicitly designed not to ship. Test 5 pins the current policy
 * behavior so any future RLS change is caught.
 *
 * Prerequisites: local Supabase running + seeded (see tests/rls/agents.md).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import {
  createServiceClient,
  createAnonClient,
  type TypedClient,
} from '../../src/tests/rls/helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WebSocketTransport = ws as any;

const SUPABASE_URL = process.env.SUPABASE_URL as string;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY as string;
const RLS_TEST_PASSWORD = process.env.RLS_TEST_PASSWORD as string;

/** The §1.6-minimal projection the dashboard hook uses. */
const DASHBOARD_SELECT = 'user_id, status, issued_at';

const RUN_ID = Date.now().toString(36);
// Fixed sandbox org ids (valid Postgres UUID text; upsert + afterAll cleanup
// make re-runs idempotent even if a prior run crashed mid-suite).
const ORG_A = 'a1b2c3d4-0000-4000-8000-00000000c001';
const ORG_B = 'a1b2c3d4-0000-4000-8000-00000000c002';
// Per-run hex salt so fingerprints never collide across runs (hex-only).
const RUN_HEX = Date.now().toString(16).padStart(12, '0').slice(-12);

function fp(seed: number): string {
  // Deterministic 64-hex fingerprint per row, unique per run.
  return (RUN_HEX + seed.toString(16).padStart(4, '0')).repeat(4).slice(0, 64);
}

interface TestUser {
  id: string;
  email: string;
  client: TypedClient;
}

describe('SCRUM-2380 — org CPE dashboard RLS (anchors SECURITY INVOKER read)', () => {
  const service = createServiceClient();
  let orgAAdmin: TestUser;
  let orgAMember: TestUser;
  let orgBAdmin: TestUser;
  const createdUserIds: string[] = [];

  async function createUser(opts: {
    emailPrefix: string;
    orgId: string;
    role: 'ORG_ADMIN' | 'INDIVIDUAL';
  }): Promise<TestUser> {
    const email = `${opts.emailPrefix}-${RUN_ID}@rls.arkova.local`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: created, error: createErr } = await (service as any).auth.admin.createUser({
      email,
      password: RLS_TEST_PASSWORD,
      email_confirm: true,
    });
    if (createErr) throw new Error(`createUser failed: ${createErr.message}`);
    const id = created.user.id as string;
    createdUserIds.push(id);

    // Upsert the profile explicitly (robust against async handle_new_user).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: profErr } = await (service as any).from('profiles').upsert(
      {
        id,
        email,
        full_name: opts.emailPrefix,
        role: opts.role,
        org_id: opts.orgId,
        is_public_profile: false,
      },
      { onConflict: 'id' },
    );
    if (profErr) throw new Error(`profile upsert failed: ${profErr.message}`);

    const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { storageKey: `cpe02-${opts.emailPrefix}-${RUN_ID}` },
      realtime: { transport: WebSocketTransport },
    }) as unknown as TypedClient;
    const { error: signInErr } = await client.auth.signInWithPassword({
      email,
      password: RLS_TEST_PASSWORD,
    });
    if (signInErr) throw new Error(`sign-in failed for ${email}: ${signInErr.message}`);
    return { id, email, client };
  }

  async function seedCpeAnchor(opts: {
    userId: string;
    orgId: string;
    status: 'SECURED' | 'PENDING';
    seed: number;
  }): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (service as any).from('anchors').insert({
      user_id: opts.userId,
      org_id: opts.orgId,
      fingerprint: fp(opts.seed),
      filename: `cpe-rls-${opts.seed}.pdf`,
      file_size: 1024,
      status: opts.status,
      credential_type: 'CPE',
      issued_at: '2026-06-01T00:00:00.000Z',
      cpe_metadata: { credit_hours: 2, field_of_study: 'Auditing', requires_manual_review: false },
      // anchors_chain_data_consistency: SECURED rows must carry a chain_tx_id.
      ...(opts.status === 'SECURED'
        ? { chain_tx_id: fp(opts.seed + 100), chain_timestamp: '2026-06-02T00:00:00.000Z' }
        : {}),
    });
    if (error) throw new Error(`anchor seed failed: ${error.message}`);
  }

  beforeAll(async () => {
    // Sandbox orgs (never touch seeded orgs — soak/e2e fixtures share them).
    for (const [id, name] of [
      [ORG_A, `CPE02 RLS Org A ${RUN_ID}`],
      [ORG_B, `CPE02 RLS Org B ${RUN_ID}`],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (service as any).from('organizations').upsert(
        { id, legal_name: name, display_name: name },
        { onConflict: 'id' },
      );
      if (error) throw new Error(`org upsert failed: ${error.message}`);
    }

    orgAAdmin = await createUser({ emailPrefix: 'cpe02-a-admin', orgId: ORG_A, role: 'ORG_ADMIN' });
    orgAMember = await createUser({ emailPrefix: 'cpe02-a-member', orgId: ORG_A, role: 'INDIVIDUAL' });
    orgBAdmin = await createUser({ emailPrefix: 'cpe02-b-admin', orgId: ORG_B, role: 'ORG_ADMIN' });

    await seedCpeAnchor({ userId: orgAAdmin.id, orgId: ORG_A, status: 'SECURED', seed: 1 });
    await seedCpeAnchor({ userId: orgAMember.id, orgId: ORG_A, status: 'SECURED', seed: 2 });
    await seedCpeAnchor({ userId: orgAMember.id, orgId: ORG_A, status: 'PENDING', seed: 3 });
    await seedCpeAnchor({ userId: orgBAdmin.id, orgId: ORG_B, status: 'SECURED', seed: 4 });
  }, 60_000);

  afterAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = service as any;
    for (const orgId of [ORG_A, ORG_B]) {
      await svc.from('anchors').delete().eq('org_id', orgId);
    }
    for (const userId of createdUserIds) {
      // ON DELETE CASCADE from auth.users cleans profiles.
      await svc.auth.admin.deleteUser(userId);
    }
    for (const orgId of [ORG_A, ORG_B]) {
      await svc.from('organizations').delete().eq('id', orgId);
    }
    for (const u of [orgAAdmin, orgAMember, orgBAdmin]) {
      await u?.client.auth.signOut();
    }
  }, 60_000);

  function dashboardQuery(client: TypedClient, orgId: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (client as any)
      .from('anchors')
      .select(DASHBOARD_SELECT)
      .eq('org_id', orgId)
      .eq('credential_type', 'CPE')
      .not('cpe_metadata', 'is', null)
      .is('deleted_at', null)
      .order('issued_at', { ascending: false })
      .limit(1000);
  }

  it('cross-org: an org-B admin gets ZERO rows when querying org A (RLS, not the client filter)', async () => {
    const { data, error } = await dashboardQuery(orgBAdmin.client, ORG_A);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it('cross-org: an org-A admin gets ZERO rows when querying org B', async () => {
    const { data, error } = await dashboardQuery(orgAAdmin.client, ORG_B);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it('org admin sees BOTH their own and a plain member\'s CPE rows within their org', async () => {
    const { data, error } = await dashboardQuery(orgAAdmin.client, ORG_A);
    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{ user_id: string; status: string }>;
    expect(rows).toHaveLength(3);
    const byUser = new Set(rows.map((r) => r.user_id));
    expect(byUser.has(orgAAdmin.id)).toBe(true);
    expect(byUser.has(orgAMember.id)).toBe(true);
    // Secured vs pending are both visible for aggregation.
    expect(rows.filter((r) => r.status === 'SECURED')).toHaveLength(2);
    expect(rows.filter((r) => r.status === 'PENDING')).toHaveLength(1);
  });

  it('a plain member can read their OWN rows (the hook\'s member-scoped query)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (dashboardQuery(orgAMember.client, ORG_A) as any).eq(
      'user_id',
      orgAMember.id,
    );
    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{ user_id: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.user_id === orgAMember.id)).toBe(true);
  });

  it('PINS standing policy: a plain member CAN read org-mates\' rows at the RLS layer (org-wide anchors_select) — dashboard own-rows scope is query-layer', async () => {
    const { data, error } = await dashboardQuery(orgAMember.client, ORG_A);
    expect(error).toBeNull();
    const rows = (data ?? []) as Array<{ user_id: string }>;
    // Under the consolidated anchors_select policy (0307), org members read
    // org-wide. If this assertion ever fails, RLS changed — revisit the hook's
    // member scoping and the PR flag before relying on it.
    expect(rows.length).toBe(3);
    expect(rows.some((r) => r.user_id === orgAAdmin.id)).toBe(true);
  });

  it('anonymous callers get no rows', async () => {
    const anon = createAnonClient();
    const { data } = await dashboardQuery(anon, ORG_A);
    expect(data ?? []).toHaveLength(0);
  });
});

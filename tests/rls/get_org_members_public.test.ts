/**
 * SCRUM-1086 PUBLIC-ORG-03 — Member anonymization resolver tests.
 *
 * Verifies the contract of `get_org_members_public(org_id, limit, offset)` from
 * migration 0264:
 *   1. anon visitors get a paginated member list
 *   2. private-profile members are anonymized — display_name in "A. Smith" form,
 *      avatar_url null, profile_public_id null
 *   3. public-profile members get full payload + their own profile_public_id
 *   4. limit/offset are clamped (1..200, ≥0) so a hostile caller cannot pass
 *      LIMIT 1_000_000 to triple the response size
 *   5. unknown org returns `{error: 'Organization not found'}` (parity with
 *      get_public_org_profile from migration 0245)
 *
 * Prerequisites: Supabase running locally with migrations through 0264 + seed.
 * Skipped if SUPABASE_URL is not set (matches the rest of `tests/rls/`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createAnonClient,
  createServiceClient,
  ORG_IDS,
  type TypedClient,
} from '../../src/tests/rls/helpers';

const RUN = Boolean(process.env.SUPABASE_URL);
const dscribe = RUN ? describe : describe.skip;

dscribe('SCRUM-1086 — get_org_members_public', () => {
  let anonClient: TypedClient;
  let serviceClient: TypedClient;

  beforeAll(() => {
    anonClient = createAnonClient();
    serviceClient = createServiceClient();
  });

  afterAll(async () => {
    await anonClient.auth.signOut();
    await serviceClient.auth.signOut();
  });

  it('anon caller can fetch members for a public org', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (anonClient.rpc as any)('get_org_members_public', {
      p_org_id: ORG_IDS.arkova,
      p_limit: 50,
      p_offset: 0,
    });
    expect(error).toBeNull();
    expect(data).toBeTruthy();
    expect(data.org_id).toBe(ORG_IDS.arkova);
    expect(typeof data.total).toBe('number');
    expect(Array.isArray(data.members)).toBe(true);
  });

  it('clamps an over-large limit to ≤200', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (anonClient.rpc as any)('get_org_members_public', {
      p_org_id: ORG_IDS.arkova,
      p_limit: 1_000_000,
      p_offset: 0,
    });
    expect(error).toBeNull();
    expect(data.limit).toBeLessThanOrEqual(200);
  });

  it('rejects unknown org id with structured error (no schema info leak)', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (anonClient.rpc as any)('get_org_members_public', {
      p_org_id: fakeId,
      p_limit: 10,
      p_offset: 0,
    });
    expect(error).toBeNull();
    expect(data.error).toBe('Organization not found');
  });

  // profiles.id and org_members.user_id both FK to auth.users(id) ON DELETE
  // CASCADE — upserting with a fake UUID silently fails the FK check, leaving
  // the member rows un-inserted and `find()` returning undefined. Each test
  // creates a real auth.users row via the service-role admin API and threads
  // the returned id through profile + org_members upserts. Sandbox-org keeps
  // the seeded member findable regardless of Arkova-seed size.
  async function seedTestUser(opts: {
    sandboxOrgId: string;
    sandboxOrgName: string;
    testEmail: string;
    publicId: string;
    fullName: string;
    avatarUrl?: string;
    isPublicProfile: boolean;
  }): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: authUser, error: authErr } = await (serviceClient as any).auth.admin.createUser({
      email: opts.testEmail,
      email_confirm: true,
    });
    if (authErr) throw new Error(`auth.admin.createUser failed: ${authErr.message}`);
    const testUserId = authUser.user.id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (serviceClient as any).from('organizations').upsert({
      id: opts.sandboxOrgId,
      legal_name: opts.sandboxOrgName,
      display_name: opts.sandboxOrgName,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (serviceClient as any).from('profiles').upsert({
      id: testUserId,
      public_id: opts.publicId,
      full_name: opts.fullName,
      avatar_url: opts.avatarUrl ?? null,
      is_public_profile: opts.isPublicProfile,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (serviceClient as any).from('org_members').upsert({
      org_id: opts.sandboxOrgId,
      user_id: testUserId,
      role: 'member',
    });
    return testUserId;
  }

  async function cleanupTestUser(testUserId: string, sandboxOrgId: string): Promise<void> {
    // ON DELETE CASCADE from auth.users handles profiles + org_members.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (serviceClient as any).auth.admin.deleteUser(testUserId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (serviceClient as any).from('organizations').delete().eq('id', sandboxOrgId);
  }

  it('private-profile members are anonymized: display_name "X. Surname", avatar+id null', async () => {
    const sandboxOrgId = '99999999-1086-1000-0000-000000000001';
    const testUserId = await seedTestUser({
      sandboxOrgId,
      sandboxOrgName: 'RLS 1086 Private Sandbox',
      testEmail: `rls-1086-private-${Date.now()}@arkova-test.com`,
      publicId: `99999999-1086-pid-${Date.now()}`,
      fullName: 'Casey Privacy-Tester',
      isPublicProfile: false,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (anonClient.rpc as any)('get_org_members_public', {
      p_org_id: sandboxOrgId,
      p_limit: 200,
      p_offset: 0,
    });
    const seeded = (data.members as Array<Record<string, unknown>>).find(
      (m) => m.is_public_profile === false && m.role === 'member',
    );
    expect(seeded).toBeTruthy();
    expect(seeded!.display_name).toMatch(/^[A-Z]\. [A-Za-z-]+$/);
    expect(seeded!.display_name).not.toContain('Casey');
    expect(seeded!.avatar_url).toBeNull();
    expect(seeded!.profile_public_id).toBeNull();

    await cleanupTestUser(testUserId, sandboxOrgId);
  });

  it('public-profile members get full payload + their own profile_public_id', async () => {
    const sandboxOrgId = '99999999-1086-1000-0000-000000000002';
    const publicId = `99999999-1086-pub-${Date.now()}`;
    const testUserId = await seedTestUser({
      sandboxOrgId,
      sandboxOrgName: 'RLS 1086 Public Sandbox',
      testEmail: `rls-1086-public-${Date.now()}@arkova-test.com`,
      publicId,
      fullName: 'Publicly Visible',
      avatarUrl: 'https://cdn.example/avatar.png',
      isPublicProfile: true,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (anonClient.rpc as any)('get_org_members_public', {
      p_org_id: sandboxOrgId,
      p_limit: 200,
      p_offset: 0,
    });
    const seeded = (data.members as Array<Record<string, unknown>>).find(
      (m) => m.is_public_profile === true && m.profile_public_id === publicId,
    );
    expect(seeded).toBeTruthy();
    expect(seeded!.display_name).toBe('Publicly Visible');
    expect(seeded!.avatar_url).toBe('https://cdn.example/avatar.png');

    await cleanupTestUser(testUserId, sandboxOrgId);
  });
});

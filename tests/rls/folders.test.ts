/**
 * SCRUM-2940 — RLS proof for `public.folders` (migration 0365).
 *
 * Pre-mortem #1 (the top risk): a folder leaking across tenants. This suite
 * proves, against LIVE RLS (not a client-side filter), that:
 *
 *   USER-scoped folders
 *     1. the owning user reads their own folder;
 *     2. a DIFFERENT individual user reads ZERO of them (cross-user denial);
 *     3. anon reads nothing;
 *     4. a user CANNOT INSERT a USER folder owned by someone else (WITH CHECK).
 *
 *   ORG-scoped folders
 *     5. an org-A admin reads org-A folders;
 *     6. an org-B admin reads ZERO org-A folders (cross-org denial);
 *     7. a plain org-A member reads org-A folders (org-wide read parity with
 *        the anchors policy — deliberate, mirrors get_user_org_id());
 *     8. an admin CANNOT INSERT an ORG folder for an org they are not in.
 *
 *   Owner-scope join guard (pre-mortem #4, trg_anchor_folder_owner_scope)
 *     9. filing an org-A record into an org-B folder is REJECTED;
 *    10. filing an org-A record into an org-A folder SUCCEEDS;
 *    11. un-filing (folder_id → NULL) always succeeds.
 *
 * Prerequisites: local Supabase running + seeded (see tests/rls/agents.md).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { createServiceClient, createAnonClient, type TypedClient } from '../../src/tests/rls/helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WebSocketTransport = ws as any;

const SUPABASE_URL = process.env.SUPABASE_URL as string;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY as string;
const RLS_TEST_PASSWORD = process.env.RLS_TEST_PASSWORD as string;

const RUN_ID = Date.now().toString(36);
const ORG_A = 'f01de100-0000-4000-8000-00000000a001';
const ORG_B = 'f01de100-0000-4000-8000-00000000a002';
const RUN_HEX = Date.now().toString(16).padStart(12, '0').slice(-12);

function fp(seed: number): string {
  return (RUN_HEX + seed.toString(16).padStart(4, '0')).repeat(4).slice(0, 64);
}

interface TestUser {
  id: string;
  email: string;
  client: TypedClient;
}

describe('SCRUM-2940 — folders RLS (cross-tenant isolation + owner-scope join guard)', () => {
  const service = createServiceClient();
  let orgAAdmin: TestUser;
  let orgAMember: TestUser;
  let orgBAdmin: TestUser;
  let soloUser: TestUser; // individual, no org — for cross-USER denial
  const createdUserIds: string[] = [];
  const createdFolderIds: string[] = [];

  async function createUser(opts: {
    emailPrefix: string;
    orgId: string | null;
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
      auth: { storageKey: `folders-${opts.emailPrefix}-${RUN_ID}` },
      realtime: { transport: WebSocketTransport },
    }) as unknown as TypedClient;
    const { error: signInErr } = await client.auth.signInWithPassword({ email, password: RLS_TEST_PASSWORD });
    if (signInErr) throw new Error(`sign-in failed for ${email}: ${signInErr.message}`);
    return { id, email, client };
  }

  async function seedFolder(opts: {
    ownerScope: 'USER' | 'ORG';
    userId?: string;
    orgId?: string;
    createdBy: string;
    name: string;
  }): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (service as any)
      .from('folders')
      .insert({
        owner_scope: opts.ownerScope,
        user_id: opts.userId ?? null,
        org_id: opts.orgId ?? null,
        created_by: opts.createdBy,
        name: opts.name,
      })
      .select('id')
      .single();
    if (error) throw new Error(`folder seed failed: ${error.message}`);
    createdFolderIds.push(data.id);
    return data.id as string;
  }

  async function seedAnchor(opts: { userId: string; orgId: string; seed: number }): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (service as any)
      .from('anchors')
      .insert({
        user_id: opts.userId,
        org_id: opts.orgId,
        fingerprint: fp(opts.seed),
        filename: `folders-rls-${opts.seed}.pdf`,
        file_size: 1024,
        status: 'PENDING',
      })
      .select('id')
      .single();
    if (error) throw new Error(`anchor seed failed: ${error.message}`);
    return data.id as string;
  }

  let orgAFolderId: string;
  let orgBFolderId: string;
  let soloFolderId: string;
  let orgAAnchorId: string;

  beforeAll(async () => {
    for (const [id, name] of [
      [ORG_A, `Folders RLS Org A ${RUN_ID}`],
      [ORG_B, `Folders RLS Org B ${RUN_ID}`],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (service as any)
        .from('organizations')
        .upsert({ id, legal_name: name, display_name: name }, { onConflict: 'id' });
      if (error) throw new Error(`org upsert failed: ${error.message}`);
    }

    orgAAdmin = await createUser({ emailPrefix: 'fld-a-admin', orgId: ORG_A, role: 'ORG_ADMIN' });
    orgAMember = await createUser({ emailPrefix: 'fld-a-member', orgId: ORG_A, role: 'INDIVIDUAL' });
    orgBAdmin = await createUser({ emailPrefix: 'fld-b-admin', orgId: ORG_B, role: 'ORG_ADMIN' });
    soloUser = await createUser({ emailPrefix: 'fld-solo', orgId: null, role: 'INDIVIDUAL' });

    orgAFolderId = await seedFolder({ ownerScope: 'ORG', orgId: ORG_A, createdBy: orgAAdmin.id, name: 'Org A Invoices' });
    orgBFolderId = await seedFolder({ ownerScope: 'ORG', orgId: ORG_B, createdBy: orgBAdmin.id, name: 'Org B Invoices' });
    soloFolderId = await seedFolder({ ownerScope: 'USER', userId: soloUser.id, createdBy: soloUser.id, name: 'My Docs' });
    orgAAnchorId = await seedAnchor({ userId: orgAMember.id, orgId: ORG_A, seed: 1 });
  }, 60_000);

  afterAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = service as any;
    for (const orgId of [ORG_A, ORG_B]) await svc.from('anchors').delete().eq('org_id', orgId);
    for (const fid of createdFolderIds) await svc.from('folders').delete().eq('id', fid);
    for (const userId of createdUserIds) await svc.auth.admin.deleteUser(userId);
    for (const orgId of [ORG_A, ORG_B]) await svc.from('organizations').delete().eq('id', orgId);
    for (const u of [orgAAdmin, orgAMember, orgBAdmin, soloUser]) await u?.client.auth.signOut();
  }, 60_000);

  // ── USER-scoped ────────────────────────────────────────────────────────────
  it('USER folder: owner reads it', async () => {
    const { data, error } = await soloUser.client.from('folders').select('id').eq('id', soloFolderId);
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id)).toContain(soloFolderId);
  });

  it('USER folder: a DIFFERENT individual user reads ZERO (cross-user denial)', async () => {
    const { data, error } = await orgAMember.client.from('folders').select('id').eq('id', soloFolderId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it('USER folder: anon reads nothing', async () => {
    const anon = createAnonClient();
    const { data } = await anon.from('folders').select('id').eq('id', soloFolderId);
    expect(data ?? []).toHaveLength(0);
  });

  it('USER folder: a user CANNOT insert a folder owned by someone else (WITH CHECK)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (orgAMember.client as any).from('folders').insert({
      owner_scope: 'USER',
      user_id: soloUser.id, // not the caller
      created_by: orgAMember.id,
      name: `spoof-${RUN_ID}`,
    });
    expect(error).not.toBeNull();
  });

  // ── ORG-scoped ─────────────────────────────────────────────────────────────
  it('ORG folder: org-A admin reads org-A folder', async () => {
    const { data, error } = await orgAAdmin.client.from('folders').select('id').eq('id', orgAFolderId);
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id)).toContain(orgAFolderId);
  });

  it('ORG folder: org-B admin reads ZERO org-A folders (cross-org denial)', async () => {
    const { data, error } = await orgBAdmin.client.from('folders').select('id').eq('id', orgAFolderId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it('ORG folder: a plain org-A member reads org-A folders (org-wide read parity)', async () => {
    const { data, error } = await orgAMember.client.from('folders').select('id').eq('id', orgAFolderId);
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.id)).toContain(orgAFolderId);
  });

  it('ORG folder: an admin CANNOT insert an ORG folder for an org they are not in', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (orgBAdmin.client as any).from('folders').insert({
      owner_scope: 'ORG',
      org_id: ORG_A, // org B admin targeting org A
      created_by: orgBAdmin.id,
      name: `cross-org-${RUN_ID}`,
    });
    expect(error).not.toBeNull();
  });

  // ── owner-scope join guard (trigger) ────────────────────────────────────────
  it('join guard: filing an org-A record into an org-B folder is REJECTED', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (service as any)
      .from('anchors')
      .update({ folder_id: orgBFolderId })
      .eq('id', orgAAnchorId);
    expect(error).not.toBeNull();
  });

  it('join guard: filing an org-A record into an org-A folder SUCCEEDS', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (service as any)
      .from('anchors')
      .update({ folder_id: orgAFolderId })
      .eq('id', orgAAnchorId);
    expect(error).toBeNull();
  });

  it('join guard: un-filing (folder_id → NULL) always succeeds', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (service as any)
      .from('anchors')
      .update({ folder_id: null })
      .eq('id', orgAAnchorId);
    expect(error).toBeNull();
  });
});

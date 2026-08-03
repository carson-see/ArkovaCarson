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
 *   Founder-priority bug fix (migration 0393) — anchors UPDATE as the OWNING
 *   CLIENT, not service_role. `useAnchors.fetchAnchorsData` gives an
 *   ORG_ADMIN the WHOLE org's anchor list (`.eq('org_id', orgId)`), but the
 *   only anchors UPDATE policy used to be `anchors_update_own`
 *   (`user_id = auth.uid()`) — so an ORG_ADMIN moving a teammate-created
 *   record into a folder hit a zero-row RLS-filtered UPDATE that PostgREST
 *   reports as SUCCESS (`error: null`), and the app showed a false "Record
 *   moved" toast while nothing changed. Proven live (not through a client
 *   mock) at both layers:
 *    12. an org-A ORG_ADMIN, as THEMSELVES (not service_role), moves a
 *        SECURED anchor OWNED BY A TEAMMATE into an org-A folder — SUCCEEDS
 *        post-0393 (this is the actual founder-facing fix);
 *    13. a plain org-A member (not admin) attempting the same teammate-owned
 *        move is still REJECTED — the RLS widening is ORG_ADMIN-only;
 *    14. an org-A ORG_ADMIN cannot use the same UPDATE to change any OTHER
 *        column (e.g. filename) on a teammate's record — the org-admin grant
 *        is folder_id-only, enforced by trg_restrict_org_admin_folder_update;
 *    15. an org-B ORG_ADMIN still cannot touch org-A's anchor at all
 *        (cross-org denial extends to the new policy).
 *
 *   Second trigger, same defect class (migration 0397) — this suite's own
 *   revoke_anchor test (16) is what surfaced it: protect_anchor_fields
 *   (baseline, unrelated to 0393/0395) independently blocks the SAME trusted
 *   SECURITY DEFINER RPCs via its own generic status-change guard, and 0395
 *   never touched it. Confirmed live: exactly ONE row in prod's ~2.97M
 *   anchors has ever reached status = REVOKED (4 months old, actor != owner —
 *   almost certainly a service_role write, not this RPC). Fixed narrowly:
 *   only the generic catch-all trusts current_user; every other guard in the
 *   function (owner change, direct-set to SECURED/SUBMITTED/BROADCASTING,
 *   chain-data tamper, legal_hold tamper, lineage tamper) stays unconditional
 *   for every caller, including trusted RPCs. Proven:
 *    16. revoke_anchor — an org-A ORG_ADMIN CAN revoke a teammate-owned anchor;
 *    17. supersede_anchor — an org-A ORG_ADMIN CAN supersede a teammate-owned
 *        anchor (new child row created, old row flips to SUPERSEDED);
 *    18. resolve_anchor_queue — an org-A ORG_ADMIN CAN resolve a
 *        PENDING_RESOLUTION collision (kept anchor -> PENDING, rejected
 *        sibling -> REVOKED);
 *    19. a DIRECT client write (not through any RPC) still CANNOT set status
 *        to REVOKED — proves 0397 did not widen the exemption beyond trusted
 *        RPCs to client writes, which is the entire point of the guard.
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

  // SECURED variant, used by the founder-priority-bug fixtures below — most
  // of what an ORG_ADMIN actually browses in "My Records" is SECURED, and
  // 0393's fix must hold for that status (not just PENDING).
  async function seedSecuredAnchor(opts: { userId: string; orgId: string; seed: number }): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (service as any)
      .from('anchors')
      .insert({
        user_id: opts.userId,
        org_id: opts.orgId,
        fingerprint: fp(opts.seed),
        filename: `folders-rls-secured-${opts.seed}.pdf`,
        file_size: 1024,
        status: 'SECURED',
        chain_tx_id: fp(opts.seed + 1000),
        chain_timestamp: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (error) throw new Error(`secured anchor seed failed: ${error.message}`);
    return data.id as string;
  }

  let orgAFolderId: string;
  let orgBFolderId: string;
  let soloFolderId: string;
  let orgAAnchorId: string;
  let orgAMember2: TestUser;
  let orgATeammateSecuredAnchorId: string;

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
    orgAMember2 = await createUser({ emailPrefix: 'fld-a-member2', orgId: ORG_A, role: 'INDIVIDUAL' });
    orgBAdmin = await createUser({ emailPrefix: 'fld-b-admin', orgId: ORG_B, role: 'ORG_ADMIN' });
    soloUser = await createUser({ emailPrefix: 'fld-solo', orgId: null, role: 'INDIVIDUAL' });

    orgAFolderId = await seedFolder({ ownerScope: 'ORG', orgId: ORG_A, createdBy: orgAAdmin.id, name: 'Org A Invoices' });
    orgBFolderId = await seedFolder({ ownerScope: 'ORG', orgId: ORG_B, createdBy: orgBAdmin.id, name: 'Org B Invoices' });
    soloFolderId = await seedFolder({ ownerScope: 'USER', userId: soloUser.id, createdBy: soloUser.id, name: 'My Docs' });
    orgAAnchorId = await seedAnchor({ userId: orgAMember.id, orgId: ORG_A, seed: 1 });
    // Owned by orgAMember (a TEAMMATE of orgAAdmin, not orgAAdmin themselves)
    // and SECURED — the exact shape of the founder-priority bug: an
    // ORG_ADMIN's org-wide "My Records" includes records they didn't
    // personally create.
    orgATeammateSecuredAnchorId = await seedSecuredAnchor({ userId: orgAMember.id, orgId: ORG_A, seed: 2 });
  }, 60_000);

  afterAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = service as any;
    for (const orgId of [ORG_A, ORG_B]) await svc.from('anchors').delete().eq('org_id', orgId);
    for (const fid of createdFolderIds) await svc.from('folders').delete().eq('id', fid);
    for (const userId of createdUserIds) await svc.auth.admin.deleteUser(userId);
    for (const orgId of [ORG_A, ORG_B]) await svc.from('organizations').delete().eq('id', orgId);
    for (const u of [orgAAdmin, orgAMember, orgAMember2, orgBAdmin, soloUser]) await u?.client.auth.signOut();
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

  // ── founder-priority bug fix (migration 0393): anchors UPDATE as the ────────
  // ── OWNING CLIENT (not service_role) ─────────────────────────────────────
  it('anchors UPDATE (owner path): an org-A ORG_ADMIN moves a SECURED anchor OWNED BY A TEAMMATE into an org-A folder — SUCCEEDS', async () => {
    const { data, error } = await orgAAdmin.client
      .from('anchors')
      .update({ folder_id: orgAFolderId })
      .eq('id', orgATeammateSecuredAnchorId)
      .select('id, folder_id');
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]?.folder_id).toBe(orgAFolderId);

    // Positive control against a false pass: confirm the state server-side,
    // not just the client's echoed response.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: verify } = await (service as any)
      .from('anchors')
      .select('folder_id')
      .eq('id', orgATeammateSecuredAnchorId)
      .single();
    expect(verify.folder_id).toBe(orgAFolderId);

    // Reset for the tests below.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (service as any).from('anchors').update({ folder_id: null }).eq('id', orgATeammateSecuredAnchorId);
  });

  it('anchors UPDATE (owner path): a plain org-A member CANNOT move a teammate-owned record (RLS widening is ORG_ADMIN-only) — silently matches zero rows, not an error', async () => {
    const { data, error } = await orgAMember2.client
      .from('anchors')
      .update({ folder_id: orgAFolderId })
      .eq('id', orgATeammateSecuredAnchorId)
      .select('id, folder_id');
    // This is the exact PostgREST shape the founder-priority bug hinged on:
    // RLS filters to zero rows, which is NOT a Postgres error. The app-layer
    // fix (useFolders.assignRecord, src/hooks/useFolders.ts) is what turns
    // this zero-row result into a thrown error for the caller; at the RLS
    // layer itself, the honest signal is "matched nothing."
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);

    // Positive control: prove the row was left untouched, not just that the
    // client saw zero rows back.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: verify } = await (service as any)
      .from('anchors')
      .select('folder_id')
      .eq('id', orgATeammateSecuredAnchorId)
      .single();
    expect(verify.folder_id).toBeNull();
  });

  it('anchors UPDATE (owner path): an org-A ORG_ADMIN CANNOT use the folder-move grant to change any OTHER column on a teammate\'s record', async () => {
    const { error } = await orgAAdmin.client
      .from('anchors')
      .update({ filename: 'pwned.pdf' })
      .eq('id', orgATeammateSecuredAnchorId);
    expect(error).not.toBeNull();
    expect(error?.code).toBe('42501');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: verify } = await (service as any)
      .from('anchors')
      .select('filename')
      .eq('id', orgATeammateSecuredAnchorId)
      .single();
    expect(verify.filename).not.toBe('pwned.pdf');
  });

  /**
   * REGRESSION GUARD for the defect 0393 shipped and 0395 fixed.
   *
   * `public.revoke_anchor` is SECURITY DEFINER and deliberately has NO
   * `user_id = auth.uid()` check — an ORG_ADMIN revoking a TEAMMATE's credential
   * is its entire purpose. But it is called from the browser under the caller's
   * own JWT, so inside it `get_caller_role()` is still 'authenticated' and
   * `OLD.user_id <> auth.uid()`. Under 0393 the folder-only trigger therefore saw
   * status/revoked_at/revocation_reason change on a non-owned row and raised
   * 42501 — breaking admin revocation in PRODUCTION until 0395.
   *
   * 0393's adversarial review refuted five attack paths but never asked whether
   * the new guard BLOCKS AN EXISTING LEGITIMATE WRITE. This test asks exactly
   * that, and is the cheapest thing that would have caught it pre-apply.
   */
  it('revoke_anchor (SECURITY DEFINER RPC): an org-A ORG_ADMIN CAN revoke a TEAMMATE-owned anchor — the folder-only trigger must not block trusted admin RPCs', async () => {
    const { error } = await orgAAdmin.client.rpc('revoke_anchor', {
      anchor_id: orgATeammateSecuredAnchorId,
      reason: 'regression guard for 0393/0395',
    });
    expect(error).toBeNull();

    // Server-side confirmation — never trust the client's echoed response.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: verify } = await (service as any)
      .from('anchors')
      .select('status, revocation_reason')
      .eq('id', orgATeammateSecuredAnchorId)
      .single();
    expect(verify.status).toBe('REVOKED');

    // Restore for any test ordering after this one.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (service as any)
      .from('anchors')
      .update({ status: 'SECURED', revoked_at: null, revocation_reason: null })
      .eq('id', orgATeammateSecuredAnchorId);
  });

  it('supersede_anchor (SECURITY DEFINER RPC): an org-A ORG_ADMIN CAN supersede a TEAMMATE-owned anchor — same trigger-chain guard as revoke_anchor (0397)', async () => {
    const oldAnchorId = await seedSecuredAnchor({ userId: orgAMember.id, orgId: ORG_A, seed: 30 });

    const { error } = await orgAAdmin.client.rpc('supersede_anchor', {
      old_anchor_id: oldAnchorId,
      new_fingerprint: fp(31),
      reason: 'regression guard for 0397',
    });
    expect(error).toBeNull();

    // Server-side confirmation on both rows — never trust the client's
    // echoed response.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: oldRow } = await (service as any)
      .from('anchors')
      .select('status')
      .eq('id', oldAnchorId)
      .single();
    expect(oldRow.status).toBe('SUPERSEDED');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: children } = await (service as any)
      .from('anchors')
      .select('id, status, fingerprint')
      .eq('parent_anchor_id', oldAnchorId);
    expect(children ?? []).toHaveLength(1);
    expect(children[0].status).toBe('PENDING');
    expect(children[0].fingerprint).toBe(fp(31));
  });

  it('resolve_anchor_queue (SECURITY DEFINER RPC): an org-A ORG_ADMIN CAN resolve a PENDING_RESOLUTION collision — same trigger-chain guard (0397)', async () => {
    const externalFileId = `folders-rls-queue-${RUN_ID}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: seeded, error: seedErr } = await (service as any)
      .from('anchors')
      .insert([
        {
          user_id: orgAMember.id,
          org_id: ORG_A,
          fingerprint: fp(32),
          filename: 'folders-rls-queue-keep.pdf',
          file_size: 1024,
          status: 'PENDING_RESOLUTION',
          metadata: { external_file_id: externalFileId },
        },
        {
          user_id: orgAMember.id,
          org_id: ORG_A,
          fingerprint: fp(33),
          filename: 'folders-rls-queue-reject.pdf',
          file_size: 1024,
          status: 'PENDING_RESOLUTION',
          metadata: { external_file_id: externalFileId },
        },
      ])
      .select('id');
    if (seedErr) throw new Error(`queue seed failed: ${seedErr.message}`);
    const [keepId, rejectId] = (seeded as { id: string }[]).map((r) => r.id);

    const { error } = await orgAAdmin.client.rpc('resolve_anchor_queue', {
      p_external_file_id: externalFileId,
      p_selected_anchor_id: keepId,
      p_reason: 'regression guard for 0397',
    });
    expect(error).toBeNull();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: verify } = await (service as any)
      .from('anchors')
      .select('id, status')
      .in('id', [keepId, rejectId]);
    const byId = Object.fromEntries((verify as { id: string; status: string }[]).map((r) => [r.id, r.status]));
    expect(byId[keepId]).toBe('PENDING');
    expect(byId[rejectId]).toBe('REVOKED');
  });

  it('anchors UPDATE (direct client write): an org-A ORG_ADMIN CANNOT set status to REVOKED directly, bypassing revoke_anchor\'s own authorization — 0397 narrows the exemption to trusted RPCs, not client writes', async () => {
    const anchorId = await seedSecuredAnchor({ userId: orgAAdmin.id, orgId: ORG_A, seed: 34 });

    const { error } = await orgAAdmin.client.from('anchors').update({ status: 'REVOKED' }).eq('id', anchorId);
    expect(error).not.toBeNull();
    expect(error?.code).toBe('42501');
    expect(error?.message).toContain('Only the system can change anchor status');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: verify } = await (service as any).from('anchors').select('status').eq('id', anchorId).single();
    expect(verify.status).toBe('SECURED');
  });

  it('anchors UPDATE (owner path): an org-B ORG_ADMIN still cannot touch org-A\'s anchor at all (cross-org denial)', async () => {
    const { data, error } = await orgBAdmin.client
      .from('anchors')
      .update({ folder_id: orgAFolderId })
      .eq('id', orgATeammateSecuredAnchorId)
      .select('id, folder_id');
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: verify } = await (service as any)
      .from('anchors')
      .select('folder_id')
      .eq('id', orgATeammateSecuredAnchorId)
      .single();
    expect(verify.folder_id).toBeNull();
  });
});

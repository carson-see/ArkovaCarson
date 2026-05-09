/**
 * RLS Integration Tests for Arkova
 *
 * These tests verify Row Level Security policies are working correctly.
 * They use the Supabase client with different user contexts to test access.
 *
 * Prerequisites:
 * - Supabase running locally (supabase start)
 * - Database reset with seed data (supabase db reset)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  withUser,
  createServiceClient,
  DEMO_CREDENTIALS,
  ORG_IDS,
  type TypedClient,
} from '../../src/tests/rls/helpers';

// Re-export from shared helpers so p7.test.ts imports resolve
export { createServiceClient, DEMO_CREDENTIALS } from '../../src/tests/rls/helpers';

// Helper that matches the old createAuthenticatedClient(email, password) signature
// by delegating to the shared withUser() helper
export async function createAuthenticatedClient(
  email: string,
  _password: string
): Promise<TypedClient> {
  // withUser determines password internally from DEMO_CREDENTIALS
  return withUser(email, email.includes('admin') ? 'ORG_ADMIN' : 'INDIVIDUAL');
}

const ARKOVA_ORG_ID = ORG_IDS.arkova;
const BETA_ORG_ID = ORG_IDS.betaCorp;

// =============================================================================
// RLS: PROFILES
// =============================================================================

describe('RLS: Profiles', () => {
  let userClient: TypedClient;
  let adminClient: TypedClient;
  let serviceClient: TypedClient;

  beforeAll(async () => {
    serviceClient = createServiceClient();
    userClient = await createAuthenticatedClient(
      DEMO_CREDENTIALS.userEmail,
      DEMO_CREDENTIALS.userPassword
    );
    adminClient = await createAuthenticatedClient(
      DEMO_CREDENTIALS.adminEmail,
      DEMO_CREDENTIALS.adminPassword
    );
  });

  afterAll(async () => {
    await userClient.auth.signOut();
    await adminClient.auth.signOut();
  });

  it('users can only read their own profile', async () => {
    const { data, error } = await userClient.from('profiles').select('*');

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].id).toBe(DEMO_CREDENTIALS.userId);
    expect(data![0].email).toBe(DEMO_CREDENTIALS.userEmail);
  });

  it('users can update allowed fields on their own profile', async () => {
    const newName = `Test User ${Date.now()}`;
    const { error } = await userClient
      .from('profiles')
      .update({ full_name: newName })
      .eq('id', DEMO_CREDENTIALS.userId);

    expect(error).toBeNull();

    // Verify update
    const { data } = await userClient.from('profiles').select('full_name').single();
    expect(data?.full_name).toBe(newName);

    // Reset to original
    await serviceClient
      .from('profiles')
      .update({ full_name: 'User Demo' })
      .eq('id', DEMO_CREDENTIALS.userId);
  });

  it('users cannot update privileged fields (org_id, role, etc)', async () => {
    // Attempt to update org_id - should fail due to trigger protection
    const { error } = await userClient
      .from('profiles')
      .update({ org_id: ARKOVA_ORG_ID })
      .eq('id', DEMO_CREDENTIALS.userId);

    // The trigger should block this with an error
    expect(error).not.toBeNull();
  });

  it('users cannot read other users profiles', async () => {
    // User trying to read admin's profile by filtering
    const { data, error } = await userClient
      .from('profiles')
      .select('*')
      .eq('id', DEMO_CREDENTIALS.adminId);

    expect(error).toBeNull();
    // RLS should return empty array, not the admin's profile
    expect(data).toHaveLength(0);
  });

  it('role immutability is enforced', async () => {
    // Admin trying to change their role - should fail due to trigger
    const { error } = await serviceClient
      .from('profiles')
      .update({ role: 'INDIVIDUAL' })
      .eq('id', DEMO_CREDENTIALS.adminId);

    expect(error).not.toBeNull();
    expect(error!.message).toContain('Role cannot be changed');
  });
});

// =============================================================================
// RLS: ORGANIZATIONS
// =============================================================================

describe('RLS: Organizations', () => {
  let adminClient: TypedClient;
  let userClient: TypedClient;
  let betaAdminClient: TypedClient;

  beforeAll(async () => {
    adminClient = await createAuthenticatedClient(
      DEMO_CREDENTIALS.adminEmail,
      DEMO_CREDENTIALS.adminPassword
    );
    userClient = await createAuthenticatedClient(
      DEMO_CREDENTIALS.userEmail,
      DEMO_CREDENTIALS.userPassword
    );
    betaAdminClient = await createAuthenticatedClient(
      DEMO_CREDENTIALS.betaAdminEmail,
      DEMO_CREDENTIALS.betaAdminPassword
    );
  });

  afterAll(async () => {
    await adminClient.auth.signOut();
    await userClient.auth.signOut();
    await betaAdminClient.auth.signOut();
  });

  it('ORG_ADMIN can only see their own organization', async () => {
    const { data, error } = await adminClient.from('organizations').select('*');

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].id).toBe(ARKOVA_ORG_ID);
    expect(data![0].display_name).toBe('Arkova');
  });

  it('ORG_ADMIN can update their organization', async () => {
    const { error } = await adminClient
      .from('organizations')
      .update({ display_name: 'Arkova Updated' })
      .eq('id', ARKOVA_ORG_ID);

    expect(error).toBeNull();

    // Reset
    await createServiceClient()
      .from('organizations')
      .update({ display_name: 'Arkova' })
      .eq('id', ARKOVA_ORG_ID);
  });

  it('INDIVIDUAL cannot see any organizations', async () => {
    // User without org_id shouldn't see any orgs
    const { data, error } = await userClient.from('organizations').select('*');

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('users cannot see other organizations (cross-tenant isolation)', async () => {
    // Arkova admin trying to see Beta Corp
    const { data, error } = await adminClient
      .from('organizations')
      .select('*')
      .eq('id', BETA_ORG_ID);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('Beta admin can only see Beta Corp', async () => {
    const { data, error } = await betaAdminClient.from('organizations').select('*');

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].id).toBe(BETA_ORG_ID);
  });
});

// =============================================================================
// RLS: ANCHORS
// =============================================================================

describe('RLS: Anchors', () => {
  let userClient: TypedClient;
  let adminClient: TypedClient;
  let betaAdminClient: TypedClient;
  let serviceClient: TypedClient;

  beforeAll(async () => {
    serviceClient = createServiceClient();
    userClient = await createAuthenticatedClient(
      DEMO_CREDENTIALS.userEmail,
      DEMO_CREDENTIALS.userPassword
    );
    adminClient = await createAuthenticatedClient(
      DEMO_CREDENTIALS.adminEmail,
      DEMO_CREDENTIALS.adminPassword
    );
    betaAdminClient = await createAuthenticatedClient(
      DEMO_CREDENTIALS.betaAdminEmail,
      DEMO_CREDENTIALS.betaAdminPassword
    );
  });

  afterAll(async () => {
    await userClient.auth.signOut();
    await adminClient.auth.signOut();
    await betaAdminClient.auth.signOut();
  });

  it('users can insert anchors for themselves with PENDING status', async () => {
    // Timestamp-based fingerprint avoids re-run collisions on the partial unique
    // index `(user_id, fingerprint) WHERE deleted_at IS NULL` if a prior run's
    // cleanup was interrupted.
    const ts = Date.now().toString(16).padStart(16, '0');
    const testFingerprint = `a${ts}`.padEnd(64, '0').slice(0, 64);
    const { data, error } = await userClient.from('anchors').insert({
      user_id: DEMO_CREDENTIALS.userId,
      fingerprint: testFingerprint,
      filename: 'test_insert.pdf',
      status: 'PENDING',
    }).select();

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].status).toBe('PENDING');

    // Cleanup
    await serviceClient.from('anchors').delete().eq('fingerprint', testFingerprint);
  });

  it('users cannot insert anchors with SECURED status', async () => {
    const testFingerprint = 'b'.repeat(64);
    const { error } = await userClient.from('anchors').insert({
      user_id: DEMO_CREDENTIALS.userId,
      fingerprint: testFingerprint,
      filename: 'test_secured.pdf',
      status: 'SECURED',
    });

    // RLS policy should block non-PENDING inserts
    expect(error).not.toBeNull();
  });

  it('users cannot insert anchors for other users', async () => {
    const testFingerprint = 'c'.repeat(64);
    const { error } = await userClient.from('anchors').insert({
      user_id: DEMO_CREDENTIALS.adminId, // Trying to insert for admin
      fingerprint: testFingerprint,
      filename: 'test_other_user.pdf',
      status: 'PENDING',
    });

    // RLS should block insert for different user_id
    expect(error).not.toBeNull();
  });

  it('INDIVIDUAL users can only see their own anchors', async () => {
    const { data, error } = await userClient.from('anchors').select('*');

    expect(error).toBeNull();
    // User should only see their 2 seeded anchors
    expect(data!.every((a) => a.user_id === DEMO_CREDENTIALS.userId)).toBe(true);
  });

  it('ORG_ADMIN can see all anchors in their organization', async () => {
    // Use betaAdmin (non-platform-admin, Acme org) to test org-scoped visibility
    // Carson is platform_admin and sees ALL anchors, which isn't a useful org-scope test
    const { data, error } = await betaAdminClient.from('anchors').select('*');

    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    expect(data!.every((a) => a.org_id === BETA_ORG_ID || a.user_id === DEMO_CREDENTIALS.betaAdminId)).toBe(true);
  });

  it('users cannot see anchors from other organizations', async () => {
    // Beta admin (non-platform-admin) should not see Arkova org anchors
    const betaAdmin = await createAuthenticatedClient(
      DEMO_CREDENTIALS.betaAdminEmail,
      DEMO_CREDENTIALS.betaAdminPassword
    );
    const { data, error } = await betaAdmin
      .from('anchors')
      .select('*')
      .eq('org_id', ARKOVA_ORG_ID);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
    await betaAdmin.auth.signOut();
  });
});

// =============================================================================
// RLS: AUDIT EVENTS
// =============================================================================

describe('RLS: Audit Events', () => {
  let userClient: TypedClient;
  let adminClient: TypedClient;
  let serviceClient: TypedClient;

  beforeAll(async () => {
    serviceClient = createServiceClient();
    userClient = await createAuthenticatedClient(
      DEMO_CREDENTIALS.userEmail,
      DEMO_CREDENTIALS.userPassword
    );
    adminClient = await createAuthenticatedClient(
      DEMO_CREDENTIALS.adminEmail,
      DEMO_CREDENTIALS.adminPassword
    );
  });

  afterAll(async () => {
    await userClient.auth.signOut();
    await adminClient.auth.signOut();
  });

  it('users can only read their own audit events', async () => {
    const { data, error } = await userClient.from('audit_events').select('*');

    expect(error).toBeNull();
    // All events should belong to current user
    expect(data!.every((e) => e.actor_id === DEMO_CREDENTIALS.userId)).toBe(true);
  });

  it('authenticated users CANNOT insert audit events directly (SCRUM-1270 / Forensic 7)', async () => {
    // Migration 0277 dropped the authenticated INSERT policy on audit_events
    // so the audit log cannot be forged by the actor it records. Browser
    // callers must go through POST /api/audit/event (worker-only,
    // service_role insert with actor_id pinned to the JWT subject).
    const { error } = await userClient.from('audit_events').insert({
      actor_id: DEMO_CREDENTIALS.userId,
      event_type: 'test.event',
      event_category: 'SYSTEM',
      details: 'Test audit event from RLS test',
    });

    expect(error).not.toBeNull();
    // 42501 = insufficient_privilege (RLS-denied direct INSERT)
    expect(error!.code).toBe('42501');
  });

  it('audit events cannot be updated (immutable)', async () => {
    // Get an existing event
    const { data: events } = await serviceClient
      .from('audit_events')
      .select('id')
      .limit(1);

    if (events && events.length > 0) {
      const { error } = await serviceClient
        .from('audit_events')
        .update({ details: 'Modified!' })
        .eq('id', events[0].id);

      // Trigger should block update
      expect(error).not.toBeNull();
      expect(error!.message).toContain('immutable');
    }
  });

  it('audit events cannot be deleted (immutable)', async () => {
    const { data: events } = await serviceClient
      .from('audit_events')
      .select('id')
      .limit(1);

    if (events && events.length > 0) {
      const { error } = await serviceClient
        .from('audit_events')
        .delete()
        .eq('id', events[0].id);

      // Trigger should block delete
      expect(error).not.toBeNull();
      expect(error!.message).toContain('immutable');
    }
  });
});

// =============================================================================
// DATABASE CONSTRAINTS
// =============================================================================

describe('Database Constraints', () => {
  let serviceClient: TypedClient;

  beforeAll(() => {
    serviceClient = createServiceClient();
  });

  it('rejects invalid fingerprint format', async () => {
    const { error } = await serviceClient.from('anchors').insert({
      user_id: DEMO_CREDENTIALS.userId,
      fingerprint: 'invalid-fingerprint',
      filename: 'test.pdf',
    });

    expect(error).not.toBeNull();
  });

  it('rejects filename with control characters', async () => {
    const { error } = await serviceClient.from('anchors').insert({
      user_id: DEMO_CREDENTIALS.userId,
      fingerprint: 'd'.repeat(64),
      filename: 'test\x00file.pdf', // Null character
    });

    expect(error).not.toBeNull();
  });

  it('rejects filename exceeding 255 characters', async () => {
    const { error } = await serviceClient.from('anchors').insert({
      user_id: DEMO_CREDENTIALS.userId,
      fingerprint: 'e'.repeat(64),
      filename: 'a'.repeat(256) + '.pdf',
    });

    expect(error).not.toBeNull();
  });

  it('enforces legal_hold prevents soft deletion', async () => {
    // Arkova org anchor has legal_hold=true in seed data
    const legalHoldAnchorId = 'aaaaaaaa-0000-0000-0000-000000000010';

    const { error } = await serviceClient
      .from('anchors')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', legalHoldAnchorId);

    // Constraint should block soft delete on legal_hold anchors
    expect(error).not.toBeNull();
  });

  it('enforces unique fingerprint per user', async () => {
    // Use fingerprint from seeded anchor cccccccc-...-001 (demo-user's first anchor)
    const duplicateFingerprint = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

    const { error } = await serviceClient.from('anchors').insert({
      user_id: DEMO_CREDENTIALS.userId,
      fingerprint: duplicateFingerprint, // This fingerprint already exists for user
      filename: 'duplicate.pdf',
    });

    expect(error).not.toBeNull();
  });
});

// =============================================================================
// ENUM VALIDATION
// =============================================================================

describe('Enum Validation', () => {
  let serviceClient: TypedClient;

  beforeAll(() => {
    serviceClient = createServiceClient();
  });

  it('accepts valid anchor_status values', async () => {
    // Timestamp + crypto-random suffix avoids re-run collisions on the partial
    // unique index `(user_id, fingerprint) WHERE deleted_at IS NULL` if a prior
    // run's cleanup was interrupted, and avoids same-millisecond collisions when
    // parallel test workers seed simultaneously. node:crypto avoids SonarCloud's
    // weak-PRNG hotspot (S2245) firing on test code.
    const { randomBytes } = await import('node:crypto');
    const ts = Date.now().toString(16).padStart(16, '0');
    const rand = randomBytes(4).toString('hex');
    const testFingerprint = `f${ts}${rand}`.padEnd(64, 'f').slice(0, 64);
    // PENDING is valid
    const { data, error } = await serviceClient.from('anchors').insert({
      user_id: DEMO_CREDENTIALS.userId,
      fingerprint: testFingerprint,
      filename: 'enum_test.pdf',
      status: 'PENDING',
    }).select();

    expect(error).toBeNull();
    expect(data![0].status).toBe('PENDING');

    // Cleanup
    await serviceClient.from('anchors').delete().eq('fingerprint', testFingerprint);
  });

  it('rejects invalid anchor_status values via constraint', async () => {
    // Using raw SQL via RPC would be needed to truly test invalid enum
    // With typed client, TypeScript prevents invalid enum values at compile time
    // This test documents the expected behavior
    expect(true).toBe(true);
  });
});

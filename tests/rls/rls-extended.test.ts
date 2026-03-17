/**
 * Extended RLS Integration Tests (AUDIT-20)
 *
 * Tests Row Level Security policies for tables that were missing coverage:
 * - credential_templates (4 policies: select, insert, update, delete)
 * - memberships (2 policies: select own, select org)
 * - invitations (2 policies: select, insert — ORG_ADMIN only)
 * - webhook_endpoints (4 policies: CRUD — ORG_ADMIN only)
 *
 * Prerequisites:
 * - Supabase running locally (supabase start)
 * - Database reset with seed data (supabase db reset)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  withUser,
  createServiceClient,
  createAnonClient,
  DEMO_CREDENTIALS,
  ORG_IDS,
  type TypedClient,
} from '../../src/tests/rls/helpers';

const ARKOVA_ORG_ID = ORG_IDS.arkova;
const BETA_ORG_ID = ORG_IDS.betaCorp;

// =============================================================================
// RLS: CREDENTIAL TEMPLATES
// =============================================================================

describe('RLS: Credential Templates', () => {
  let adminClient: TypedClient;
  let userClient: TypedClient;
  let betaAdminClient: TypedClient;
  let serviceClient: TypedClient;

  beforeAll(async () => {
    serviceClient = createServiceClient();
    adminClient = await withUser(DEMO_CREDENTIALS.adminEmail, 'ORG_ADMIN');
    userClient = await withUser(DEMO_CREDENTIALS.userEmail, 'INDIVIDUAL');
    betaAdminClient = await withUser(DEMO_CREDENTIALS.betaAdminEmail, 'ORG_ADMIN');
  });

  afterAll(async () => {
    await adminClient.auth.signOut();
    await userClient.auth.signOut();
    await betaAdminClient.auth.signOut();
  });

  it('ORG_ADMIN can read templates for their org', async () => {
    const { data, error } = await adminClient.from('credential_templates').select('*');

    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    // All returned templates belong to admin's org
    expect(data!.every((t) => t.org_id === ARKOVA_ORG_ID)).toBe(true);
  });

  it('ORG_ADMIN cannot read templates from another org', async () => {
    const { data, error } = await adminClient
      .from('credential_templates')
      .select('*')
      .eq('org_id', BETA_ORG_ID);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('INDIVIDUAL user cannot read any templates', async () => {
    const { data, error } = await userClient.from('credential_templates').select('*');

    expect(error).toBeNull();
    // Individual user has no org, so no templates visible
    expect(data).toHaveLength(0);
  });

  it('ORG_ADMIN can insert templates for their org', async () => {
    const { data, error } = await adminClient.from('credential_templates').insert({
      org_id: ARKOVA_ORG_ID,
      name: `RLS Test Template ${Date.now()}`,
      credential_type: 'CERTIFICATE',
      default_metadata: { fields: [] },
      is_active: true,
    }).select();

    expect(error).toBeNull();
    expect(data).toHaveLength(1);

    // Cleanup
    if (data?.[0]?.id) {
      await serviceClient.from('credential_templates').delete().eq('id', data[0].id);
    }
  });

  it('ORG_ADMIN cannot insert templates for another org', async () => {
    const { error } = await adminClient.from('credential_templates').insert({
      org_id: BETA_ORG_ID,
      name: 'Cross-org template',
      credential_type: 'CERTIFICATE',
      default_metadata: { fields: [] },
      is_active: true,
    });

    expect(error).not.toBeNull();
    // RLS denies cross-org inserts with a policy violation
    expect(error!.code).toBe('42501');
  });

  it('INDIVIDUAL user cannot insert templates', async () => {
    const { error } = await userClient.from('credential_templates').insert({
      org_id: ARKOVA_ORG_ID,
      name: 'Unauthorized template',
      credential_type: 'CERTIFICATE',
      default_metadata: { fields: [] },
      is_active: true,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('anonymous users cannot read templates', async () => {
    const anonClient = createAnonClient();
    const { data, error } = await anonClient.from('credential_templates').select('*');

    // Either empty or error — anon cannot access
    if (error) {
      expect(error).toBeDefined();
    } else {
      expect(data).toHaveLength(0);
    }
  });
});

// =============================================================================
// RLS: MEMBERSHIPS
// =============================================================================

describe('RLS: Memberships', () => {
  let adminClient: TypedClient;
  let userClient: TypedClient;
  let betaAdminClient: TypedClient;

  beforeAll(async () => {
    adminClient = await withUser(DEMO_CREDENTIALS.adminEmail, 'ORG_ADMIN');
    userClient = await withUser(DEMO_CREDENTIALS.userEmail, 'INDIVIDUAL');
    betaAdminClient = await withUser(DEMO_CREDENTIALS.betaAdminEmail, 'ORG_ADMIN');
  });

  afterAll(async () => {
    await adminClient.auth.signOut();
    await userClient.auth.signOut();
    await betaAdminClient.auth.signOut();
  });

  it('ORG_ADMIN can see all memberships in their org', async () => {
    const { data, error } = await adminClient.from('memberships').select('*');

    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    // All returned memberships belong to admin's org
    expect(data!.every((m) => m.org_id === ARKOVA_ORG_ID)).toBe(true);
  });

  it('ORG_ADMIN cannot see memberships from another org', async () => {
    const { data, error } = await adminClient
      .from('memberships')
      .select('*')
      .eq('org_id', BETA_ORG_ID);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('INDIVIDUAL user sees no memberships (no org)', async () => {
    const { data, error } = await userClient.from('memberships').select('*');

    expect(error).toBeNull();
    // Individual has no org_id, so no memberships visible
    expect(data).toHaveLength(0);
  });

  it('Beta admin only sees Beta Corp memberships', async () => {
    const { data, error } = await betaAdminClient.from('memberships').select('*');

    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    expect(data!.every((m) => m.org_id === BETA_ORG_ID)).toBe(true);
  });

  it('memberships cannot be inserted by authenticated users (service role only)', async () => {
    const { error } = await adminClient.from('memberships').insert({
      user_id: DEMO_CREDENTIALS.userId,
      org_id: ARKOVA_ORG_ID,
      role: 'ORG_MEMBER',
    });

    // Should fail — only service role can insert memberships
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });
});

// =============================================================================
// RLS: INVITATIONS
// =============================================================================

describe('RLS: Invitations', () => {
  let adminClient: TypedClient;
  let userClient: TypedClient;
  let betaAdminClient: TypedClient;
  let serviceClient: TypedClient;

  beforeAll(async () => {
    serviceClient = createServiceClient();
    adminClient = await withUser(DEMO_CREDENTIALS.adminEmail, 'ORG_ADMIN');
    userClient = await withUser(DEMO_CREDENTIALS.userEmail, 'INDIVIDUAL');
    betaAdminClient = await withUser(DEMO_CREDENTIALS.betaAdminEmail, 'ORG_ADMIN');
  });

  afterAll(async () => {
    await adminClient.auth.signOut();
    await userClient.auth.signOut();
    await betaAdminClient.auth.signOut();
  });

  it('ORG_ADMIN can create invitations for their org', async () => {
    const testEmail = `rls-test-${Date.now()}@example.com`;
    const { data, error } = await adminClient.from('invitations').insert({
      org_id: ARKOVA_ORG_ID,
      email: testEmail,
      role: 'ORG_MEMBER',
      invited_by: DEMO_CREDENTIALS.adminId,
    }).select();

    expect(error).toBeNull();
    expect(data).toHaveLength(1);

    // Cleanup
    if (data?.[0]?.id) {
      await serviceClient.from('invitations').delete().eq('id', data[0].id);
    }
  });

  it('ORG_ADMIN can read invitations for their org', async () => {
    // Insert test invitation via service client
    const testEmail = `rls-read-${Date.now()}@example.com`;
    const { data: inserted } = await serviceClient.from('invitations').insert({
      org_id: ARKOVA_ORG_ID,
      email: testEmail,
      role: 'ORG_MEMBER',
      invited_by: DEMO_CREDENTIALS.adminId,
    }).select();

    const { data, error } = await adminClient.from('invitations').select('*');

    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    expect(data!.every((i) => i.org_id === ARKOVA_ORG_ID)).toBe(true);

    // Cleanup
    if (inserted?.[0]?.id) {
      await serviceClient.from('invitations').delete().eq('id', inserted[0].id);
    }
  });

  it('ORG_ADMIN cannot create invitations for another org', async () => {
    const { error } = await adminClient.from('invitations').insert({
      org_id: BETA_ORG_ID,
      email: 'cross-org@example.com',
      role: 'ORG_MEMBER',
      invited_by: DEMO_CREDENTIALS.adminId,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('INDIVIDUAL user cannot create invitations', async () => {
    const { error } = await userClient.from('invitations').insert({
      org_id: ARKOVA_ORG_ID,
      email: 'unauthorized@example.com',
      role: 'ORG_MEMBER',
      invited_by: DEMO_CREDENTIALS.userId,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('INDIVIDUAL user cannot read invitations', async () => {
    const { data, error } = await userClient.from('invitations').select('*');

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });
});

// =============================================================================
// RLS: WEBHOOK ENDPOINTS
// =============================================================================

describe('RLS: Webhook Endpoints', () => {
  let adminClient: TypedClient;
  let userClient: TypedClient;
  let betaAdminClient: TypedClient;
  let serviceClient: TypedClient;

  beforeAll(async () => {
    serviceClient = createServiceClient();
    adminClient = await withUser(DEMO_CREDENTIALS.adminEmail, 'ORG_ADMIN');
    userClient = await withUser(DEMO_CREDENTIALS.userEmail, 'INDIVIDUAL');
    betaAdminClient = await withUser(DEMO_CREDENTIALS.betaAdminEmail, 'ORG_ADMIN');
  });

  afterAll(async () => {
    await adminClient.auth.signOut();
    await userClient.auth.signOut();
    await betaAdminClient.auth.signOut();
  });

  it('ORG_ADMIN can insert webhook endpoints for their org', async () => {
    const { data, error } = await adminClient.from('webhook_endpoints').insert({
      org_id: ARKOVA_ORG_ID,
      url: `https://example.com/webhook-rls-${Date.now()}`,
      events: ['anchor.secured'],
      is_active: true,
      secret_hash: 'test-secret-for-rls',
    }).select();

    expect(error).toBeNull();
    expect(data).toHaveLength(1);

    // Cleanup
    if (data?.[0]?.id) {
      await serviceClient.from('webhook_endpoints').delete().eq('id', data[0].id);
    }
  });

  it('ORG_ADMIN can read webhook endpoints for their org', async () => {
    // Insert via service client
    const { data: inserted } = await serviceClient.from('webhook_endpoints').insert({
      org_id: ARKOVA_ORG_ID,
      url: `https://example.com/webhook-read-${Date.now()}`,
      events: ['anchor.secured'],
      is_active: true,
      secret_hash: 'test-secret',
    }).select();

    const { data, error } = await adminClient.from('webhook_endpoints').select('*');

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    // All endpoints belong to admin's org
    expect(data!.every((e) => e.org_id === ARKOVA_ORG_ID)).toBe(true);

    // Cleanup
    if (inserted?.[0]?.id) {
      await serviceClient.from('webhook_endpoints').delete().eq('id', inserted[0].id);
    }
  });

  it('ORG_ADMIN cannot read webhook endpoints from another org', async () => {
    // Insert endpoint for Beta Corp via service client
    const { data: inserted } = await serviceClient.from('webhook_endpoints').insert({
      org_id: BETA_ORG_ID,
      url: `https://example.com/webhook-cross-${Date.now()}`,
      events: ['anchor.secured'],
      is_active: true,
      secret_hash: 'test-secret',
    }).select();

    const { data, error } = await adminClient
      .from('webhook_endpoints')
      .select('*')
      .eq('org_id', BETA_ORG_ID);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);

    // Cleanup
    if (inserted?.[0]?.id) {
      await serviceClient.from('webhook_endpoints').delete().eq('id', inserted[0].id);
    }
  });

  it('INDIVIDUAL user cannot read webhook endpoints', async () => {
    const { data, error } = await userClient.from('webhook_endpoints').select('*');

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('INDIVIDUAL user cannot insert webhook endpoints', async () => {
    const { error } = await userClient.from('webhook_endpoints').insert({
      org_id: ARKOVA_ORG_ID,
      url: 'https://example.com/unauthorized',
      events: ['anchor.secured'],
      is_active: true,
      secret_hash: 'unauthorized-secret',
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });
});

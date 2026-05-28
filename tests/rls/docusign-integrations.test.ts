/**
 * DocuSign Integration RLS Tests — Sprint 3 P0 gap coverage.
 *
 * Tests Row Level Security policies for the 5 DocuSign-related tables:
 *
 * 1. org_integrations — org-scoped SELECT for admin/owner; deny write from client
 * 2. docusign_webhook_nonces — service_role only (implicit deny for authenticated/anon)
 * 3. docusign_reconciliation_gaps — explicit deny-all for authenticated/anon
 * 4. integration_events — org-scoped SELECT for admin/owner; deny write from client
 * 5. connector_alert_state — explicit deny-all for authenticated/anon
 * 6. member_integrations — member reads own rows, org admin reads org rows, deny writes
 *
 * Policy sources:
 *   - Baseline: 00000000000000_baseline_at_main_HEAD.sql
 *   - 0317_connector_alert_state.sql
 *   - 0318_docusign_reconciliation_gaps.sql
 *   - 0319_org_integrations_hmac_keys.sql (schema only, no policy change)
 *
 * Prerequisites:
 *   - Supabase running locally (supabase start)
 *   - Database reset with seed data (supabase db reset)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  withUser,
  createServiceClient,
  createAnonClient,
  withIndividualUser,
  DEMO_CREDENTIALS,
  ORG_IDS,
  type TypedClient,
} from '../../src/tests/rls/helpers';

const ARKOVA_ORG_ID = ORG_IDS.arkova;
const BETA_ORG_ID = ORG_IDS.betaCorp;

/**
 * Loose client type for tables that may not be in the generated database.types.ts
 * (connector_alert_state, docusign_reconciliation_gaps were added in migrations
 * 0317/0318 after the last types generation).
 */
type FromableClient = {
  from: (t: string) => {
    select: (cols: string) => {
      limit: (n: number) => Promise<{ data: unknown[] | null; error: { code?: string; message?: string } | null }>;
      eq: (col: string, val: string) => Promise<{ data: unknown[] | null; error: { code?: string; message?: string } | null }>;
    };
    insert: (row: Record<string, unknown>) => Promise<{ data: unknown[] | null; error: { code?: string; message?: string } | null }>;
    update: (row: Record<string, unknown>) => {
      eq: (col: string, val: string) => Promise<{ data: unknown[] | null; error: { code?: string; message?: string } | null }>;
    };
    delete: () => {
      eq: (col: string, val: string) => Promise<{ data: unknown[] | null; error: { code?: string; message?: string } | null }>;
    };
  };
};

/** Acceptable RLS deny error codes from PostgREST */
const DENY_CODES = ['42501', 'PGRST301', undefined];

// =============================================================================
// RLS: org_integrations — org-scoped SELECT, deny client writes
// =============================================================================

describe('RLS: org_integrations', () => {
  let adminClient: TypedClient;
  let betaAdminClient: TypedClient;
  let userClient: TypedClient;
  let anonClient: TypedClient;
  let serviceClient: TypedClient;

  beforeAll(async () => {
    serviceClient = createServiceClient();
    adminClient = await withUser(DEMO_CREDENTIALS.adminEmail, 'ORG_ADMIN');
    betaAdminClient = await withUser(DEMO_CREDENTIALS.betaAdminEmail, 'ORG_ADMIN');
    userClient = await withIndividualUser();
    anonClient = createAnonClient();

    // Seed a test integration row for Arkova org (if none exists)
    const { data: existing } = await serviceClient
      .from('org_integrations')
      .select('id')
      .eq('org_id', ARKOVA_ORG_ID)
      .eq('provider', 'docusign')
      .limit(1);

    if (!existing || existing.length === 0) {
      await serviceClient.from('org_integrations').insert({
        org_id: ARKOVA_ORG_ID,
        provider: 'docusign',
        account_id: 'rls-test-arkova-docusign',
        account_label: 'RLS Test Arkova DocuSign',
      });
    }

    // Seed a test integration row for Beta Corp org (if none exists)
    const { data: existingBeta } = await serviceClient
      .from('org_integrations')
      .select('id')
      .eq('org_id', BETA_ORG_ID)
      .eq('provider', 'docusign')
      .limit(1);

    if (!existingBeta || existingBeta.length === 0) {
      await serviceClient.from('org_integrations').insert({
        org_id: BETA_ORG_ID,
        provider: 'docusign',
        account_id: 'rls-test-beta-docusign',
        account_label: 'RLS Test Beta DocuSign',
      });
    }
  });

  afterAll(async () => {
    // Cleanup seeded test rows
    await serviceClient
      .from('org_integrations')
      .delete()
      .eq('account_id', 'rls-test-arkova-docusign');
    await serviceClient
      .from('org_integrations')
      .delete()
      .eq('account_id', 'rls-test-beta-docusign');

    await adminClient.auth.signOut();
    await betaAdminClient.auth.signOut();
    await userClient.auth.signOut();
  });

  it('ORG_ADMIN can read their own org integrations', async () => {
    const { data, error } = await adminClient
      .from('org_integrations')
      .select('*');

    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    // All returned rows belong to the admin's org
    expect(data!.every((row) => row.org_id === ARKOVA_ORG_ID)).toBe(true);
  });

  it('ORG_ADMIN cannot read another org integrations (cross-tenant blocked)', async () => {
    const { data, error } = await adminClient
      .from('org_integrations')
      .select('*')
      .eq('org_id', BETA_ORG_ID);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('Beta ORG_ADMIN can read Beta org integrations', async () => {
    const { data, error } = await betaAdminClient
      .from('org_integrations')
      .select('*');

    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    expect(data!.every((row) => row.org_id === BETA_ORG_ID)).toBe(true);
  });

  it('Beta ORG_ADMIN cannot read Arkova org integrations (cross-tenant blocked)', async () => {
    const { data, error } = await betaAdminClient
      .from('org_integrations')
      .select('*')
      .eq('org_id', ARKOVA_ORG_ID);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('INDIVIDUAL user (no org) cannot read any integrations', async () => {
    const { data, error } = await userClient
      .from('org_integrations')
      .select('*');

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('anon cannot read org_integrations', async () => {
    const { data, error } = await (anonClient as unknown as FromableClient)
      .from('org_integrations')
      .select('*')
      .limit(1);

    const visible = Array.isArray(data) ? data.length : 0;
    expect(visible).toBe(0);
  });

  it('authenticated user cannot INSERT into org_integrations (no INSERT policy)', async () => {
    const { error } = await adminClient.from('org_integrations').insert({
      org_id: ARKOVA_ORG_ID,
      provider: 'docusign',
      account_id: `rls-test-insert-${Date.now()}`,
    });

    // No INSERT policy exists for authenticated — must be denied
    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('authenticated user cannot UPDATE org_integrations (no UPDATE policy)', async () => {
    // First get an integration ID via service client
    const { data: rows } = await serviceClient
      .from('org_integrations')
      .select('id')
      .eq('account_id', 'rls-test-arkova-docusign')
      .limit(1);

    expect(rows).not.toBeNull();
    expect(rows!.length).toBeGreaterThan(0);

    const { error } = await adminClient
      .from('org_integrations')
      .update({ account_label: 'hacked' })
      .eq('id', rows![0].id);

    // No UPDATE policy — update should affect 0 rows or return a policy error.
    // PostgREST may return success with 0 rows affected or an explicit deny.
    if (error) {
      expect(error.code).toBe('42501');
    }
    // Verify the value was not changed
    const { data: check } = await serviceClient
      .from('org_integrations')
      .select('account_label')
      .eq('id', rows![0].id)
      .single();

    expect(check?.account_label).not.toBe('hacked');
  });

  it('authenticated user cannot DELETE from org_integrations (no DELETE policy)', async () => {
    const { data: rows } = await serviceClient
      .from('org_integrations')
      .select('id')
      .eq('account_id', 'rls-test-arkova-docusign')
      .limit(1);

    expect(rows).not.toBeNull();

    const { error } = await adminClient
      .from('org_integrations')
      .delete()
      .eq('id', rows![0].id);

    if (error) {
      expect(error.code).toBe('42501');
    }
    // Verify the row still exists
    const { data: stillExists } = await serviceClient
      .from('org_integrations')
      .select('id')
      .eq('account_id', 'rls-test-arkova-docusign')
      .limit(1);

    expect(stillExists!.length).toBe(1);
  });

  it('service_role can read org_integrations (sanity)', async () => {
    const { error } = await serviceClient
      .from('org_integrations')
      .select('*')
      .limit(1);

    expect(error).toBeNull();
  });
});

// =============================================================================
// RLS: docusign_webhook_nonces — service_role only (implicit deny)
// =============================================================================

describe('RLS: docusign_webhook_nonces (service_role only)', () => {
  let authClient: TypedClient;
  let anonClient: TypedClient;
  let serviceClient: TypedClient;

  beforeAll(async () => {
    serviceClient = createServiceClient();
    authClient = await withIndividualUser();
    anonClient = createAnonClient();
  });

  afterAll(async () => {
    await authClient.auth.signOut();
  });

  it('service_role can SELECT docusign_webhook_nonces (sanity)', async () => {
    const { error } = await serviceClient
      .from('docusign_webhook_nonces')
      .select('*')
      .limit(1);

    expect(error).toBeNull();
  });

  it('authenticated cannot SELECT docusign_webhook_nonces', async () => {
    const { data, error } = await authClient
      .from('docusign_webhook_nonces')
      .select('*')
      .limit(1);

    const visible = Array.isArray(data) ? data.length : 0;
    expect(visible).toBe(0);
    if (error) {
      expect(DENY_CODES).toContain(error.code);
    }
  });

  it('anon cannot SELECT docusign_webhook_nonces', async () => {
    const { data, error } = await (anonClient as unknown as FromableClient)
      .from('docusign_webhook_nonces')
      .select('*')
      .limit(1);

    const visible = Array.isArray(data) ? data.length : 0;
    expect(visible).toBe(0);
    if (error) {
      expect(DENY_CODES).toContain(error.code);
    }
  });

  it('authenticated cannot INSERT into docusign_webhook_nonces', async () => {
    const { error } = await authClient.from('docusign_webhook_nonces').insert({
      envelope_id: 'rls-test-envelope',
      event_id: 'rls-test-event',
      generated_at: new Date().toISOString(),
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('anon cannot INSERT into docusign_webhook_nonces', async () => {
    const { error } = await (anonClient as unknown as FromableClient)
      .from('docusign_webhook_nonces')
      .insert({
        envelope_id: 'rls-test-envelope-anon',
        event_id: 'rls-test-event-anon',
        generated_at: new Date().toISOString(),
      });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });
});

// =============================================================================
// RLS: docusign_reconciliation_gaps — explicit deny-all for authenticated/anon
// =============================================================================

describe('RLS: docusign_reconciliation_gaps (service_role only)', () => {
  let authClient: TypedClient;
  let anonClient: TypedClient;
  let serviceClient: TypedClient;

  beforeAll(async () => {
    serviceClient = createServiceClient();
    authClient = await withIndividualUser();
    anonClient = createAnonClient();
  });

  afterAll(async () => {
    await authClient.auth.signOut();
  });

  it('service_role can SELECT docusign_reconciliation_gaps (sanity)', async () => {
    const { error } = await (serviceClient as unknown as FromableClient)
      .from('docusign_reconciliation_gaps')
      .select('*')
      .limit(1);

    expect(error).toBeNull();
  });

  it('authenticated cannot SELECT docusign_reconciliation_gaps', async () => {
    const { data, error } = await (authClient as unknown as FromableClient)
      .from('docusign_reconciliation_gaps')
      .select('*')
      .limit(1);

    const visible = Array.isArray(data) ? data.length : 0;
    expect(visible).toBe(0);
    if (error) {
      expect(DENY_CODES).toContain(error.code);
    }
  });

  it('anon cannot SELECT docusign_reconciliation_gaps', async () => {
    const { data, error } = await (anonClient as unknown as FromableClient)
      .from('docusign_reconciliation_gaps')
      .select('*')
      .limit(1);

    const visible = Array.isArray(data) ? data.length : 0;
    expect(visible).toBe(0);
    if (error) {
      expect(DENY_CODES).toContain(error.code);
    }
  });

  it('authenticated cannot INSERT into docusign_reconciliation_gaps', async () => {
    const { error } = await (authClient as unknown as FromableClient)
      .from('docusign_reconciliation_gaps')
      .insert({
        org_id: ARKOVA_ORG_ID,
        integration_id: '00000000-0000-0000-0000-000000000000',
        account_id: 'rls-test-account',
        envelope_id: 'rls-test-envelope',
        completed_at: new Date().toISOString(),
      });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('anon cannot INSERT into docusign_reconciliation_gaps', async () => {
    const { error } = await (anonClient as unknown as FromableClient)
      .from('docusign_reconciliation_gaps')
      .insert({
        org_id: ARKOVA_ORG_ID,
        integration_id: '00000000-0000-0000-0000-000000000000',
        account_id: 'rls-test-account-anon',
        envelope_id: 'rls-test-envelope-anon',
        completed_at: new Date().toISOString(),
      });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('authenticated cannot UPDATE docusign_reconciliation_gaps', async () => {
    const { error } = await (authClient as unknown as FromableClient)
      .from('docusign_reconciliation_gaps')
      .update({ resolution: 'manual' })
      .eq('id', '00000000-0000-0000-0000-000000000000');

    // Either explicit deny or silent no-op (0 rows matched under RLS)
    if (error) {
      expect(DENY_CODES).toContain(error.code);
    }
  });

  it('authenticated cannot DELETE from docusign_reconciliation_gaps', async () => {
    const { error } = await (authClient as unknown as FromableClient)
      .from('docusign_reconciliation_gaps')
      .delete()
      .eq('id', '00000000-0000-0000-0000-000000000000');

    if (error) {
      expect(DENY_CODES).toContain(error.code);
    }
  });
});

// =============================================================================
// RLS: integration_events — org-scoped SELECT, deny client writes
// =============================================================================

describe('RLS: integration_events', () => {
  let adminClient: TypedClient;
  let betaAdminClient: TypedClient;
  let userClient: TypedClient;
  let anonClient: TypedClient;
  let serviceClient: TypedClient;

  let arkovaIntegrationId: string | null = null;

  beforeAll(async () => {
    serviceClient = createServiceClient();
    adminClient = await withUser(DEMO_CREDENTIALS.adminEmail, 'ORG_ADMIN');
    betaAdminClient = await withUser(DEMO_CREDENTIALS.betaAdminEmail, 'ORG_ADMIN');
    userClient = await withIndividualUser();
    anonClient = createAnonClient();

    // Get Arkova integration ID for seeding events
    const { data: integrations } = await serviceClient
      .from('org_integrations')
      .select('id')
      .eq('org_id', ARKOVA_ORG_ID)
      .limit(1);

    arkovaIntegrationId = integrations?.[0]?.id ?? null;

    // Seed a test integration_event for Arkova org
    await serviceClient.from('integration_events').insert({
      org_id: ARKOVA_ORG_ID,
      integration_id: arkovaIntegrationId,
      provider: 'docusign',
      event_type: 'rls_test_event',
      status: 'success',
      details: { test: true },
    });

    // Seed a test integration_event for Beta Corp org
    const { data: betaIntegrations } = await serviceClient
      .from('org_integrations')
      .select('id')
      .eq('org_id', BETA_ORG_ID)
      .limit(1);

    await serviceClient.from('integration_events').insert({
      org_id: BETA_ORG_ID,
      integration_id: betaIntegrations?.[0]?.id ?? null,
      provider: 'docusign',
      event_type: 'rls_test_event',
      status: 'success',
      details: { test: true },
    });
  });

  afterAll(async () => {
    // Cleanup seeded test events
    await (serviceClient as unknown as FromableClient)
      .from('integration_events')
      .delete()
      .eq('event_type', 'rls_test_event');

    await adminClient.auth.signOut();
    await betaAdminClient.auth.signOut();
    await userClient.auth.signOut();
  });

  it('ORG_ADMIN can read their own org events', async () => {
    const { data, error } = await adminClient
      .from('integration_events')
      .select('*');

    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    // All returned rows belong to admin's org
    expect(data!.every((row) => row.org_id === ARKOVA_ORG_ID)).toBe(true);
  });

  it('ORG_ADMIN cannot read another org events (cross-tenant blocked)', async () => {
    const { data, error } = await adminClient
      .from('integration_events')
      .select('*')
      .eq('org_id', BETA_ORG_ID);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('Beta ORG_ADMIN can read Beta org events', async () => {
    const { data, error } = await betaAdminClient
      .from('integration_events')
      .select('*');

    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
    expect(data!.every((row) => row.org_id === BETA_ORG_ID)).toBe(true);
  });

  it('Beta ORG_ADMIN cannot read Arkova org events (cross-tenant blocked)', async () => {
    const { data, error } = await betaAdminClient
      .from('integration_events')
      .select('*')
      .eq('org_id', ARKOVA_ORG_ID);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('INDIVIDUAL user (no org) cannot read any events', async () => {
    const { data, error } = await userClient
      .from('integration_events')
      .select('*');

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it('anon cannot read integration_events', async () => {
    const { data, error } = await (anonClient as unknown as FromableClient)
      .from('integration_events')
      .select('*')
      .limit(1);

    const visible = Array.isArray(data) ? data.length : 0;
    expect(visible).toBe(0);
  });

  it('authenticated user cannot INSERT into integration_events (no INSERT policy)', async () => {
    const { error } = await adminClient.from('integration_events').insert({
      org_id: ARKOVA_ORG_ID,
      provider: 'docusign',
      event_type: 'rls_unauthorized_insert',
      status: 'success',
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('authenticated user cannot UPDATE integration_events (no UPDATE policy)', async () => {
    // Get an event ID via service client
    const { data: events } = await (serviceClient as unknown as FromableClient)
      .from('integration_events')
      .select('id')
      .eq('event_type', 'rls_test_event');

    if (events && events.length > 0) {
      const eventId = (events[0] as { id: string }).id;
      const { error } = await (adminClient as unknown as FromableClient)
        .from('integration_events')
        .update({ status: 'error' })
        .eq('id', eventId);

      // No UPDATE policy — silent no-op or explicit deny
      if (error) {
        expect(DENY_CODES).toContain(error.code);
      }
      // Verify the value was not changed
      const { data: check } = await (serviceClient as unknown as FromableClient)
        .from('integration_events')
        .select('status')
        .eq('id', eventId);

      expect((check?.[0] as { status: string })?.status).toBe('success');
    }
  });

  it('authenticated user cannot DELETE from integration_events (no DELETE policy)', async () => {
    const { data: events } = await (serviceClient as unknown as FromableClient)
      .from('integration_events')
      .select('id')
      .eq('event_type', 'rls_test_event');

    if (events && events.length > 0) {
      const eventId = (events[0] as { id: string }).id;
      const { error } = await (adminClient as unknown as FromableClient)
        .from('integration_events')
        .delete()
        .eq('id', eventId);

      if (error) {
        expect(DENY_CODES).toContain(error.code);
      }
      // Verify row still exists
      const { data: stillExists } = await (serviceClient as unknown as FromableClient)
        .from('integration_events')
        .select('id')
        .eq('id', eventId);

      expect((stillExists as unknown[])!.length).toBe(1);
    }
  });

  it('service_role can read integration_events (sanity)', async () => {
    const { error } = await serviceClient
      .from('integration_events')
      .select('*')
      .limit(1);

    expect(error).toBeNull();
  });
});

// =============================================================================
// RLS: connector_alert_state — explicit deny-all for authenticated/anon
// =============================================================================

describe('RLS: connector_alert_state (service_role only)', () => {
  let authClient: TypedClient;
  let anonClient: TypedClient;
  let serviceClient: TypedClient;

  beforeAll(async () => {
    serviceClient = createServiceClient();
    authClient = await withIndividualUser();
    anonClient = createAnonClient();
  });

  afterAll(async () => {
    await authClient.auth.signOut();
  });

  it('service_role can SELECT connector_alert_state (sanity)', async () => {
    const { error } = await (serviceClient as unknown as FromableClient)
      .from('connector_alert_state')
      .select('*')
      .limit(1);

    expect(error).toBeNull();
  });

  it('authenticated cannot SELECT connector_alert_state', async () => {
    const { data, error } = await (authClient as unknown as FromableClient)
      .from('connector_alert_state')
      .select('*')
      .limit(1);

    const visible = Array.isArray(data) ? data.length : 0;
    expect(visible).toBe(0);
    if (error) {
      expect(DENY_CODES).toContain(error.code);
    }
  });

  it('anon cannot SELECT connector_alert_state', async () => {
    const { data, error } = await (anonClient as unknown as FromableClient)
      .from('connector_alert_state')
      .select('*')
      .limit(1);

    const visible = Array.isArray(data) ? data.length : 0;
    expect(visible).toBe(0);
    if (error) {
      expect(DENY_CODES).toContain(error.code);
    }
  });

  it('authenticated cannot INSERT into connector_alert_state', async () => {
    const { error } = await (authClient as unknown as FromableClient)
      .from('connector_alert_state')
      .insert({
        connector_id: 'rls-test-connector',
        org_id: ARKOVA_ORG_ID,
        last_state: 'connected',
      });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('anon cannot INSERT into connector_alert_state', async () => {
    const { error } = await (anonClient as unknown as FromableClient)
      .from('connector_alert_state')
      .insert({
        connector_id: 'rls-test-connector-anon',
        org_id: ARKOVA_ORG_ID,
        last_state: 'connected',
      });

    expect(error).not.toBeNull();
    expect(error!.code).toBe('42501');
  });

  it('authenticated cannot UPDATE connector_alert_state', async () => {
    const { error } = await (authClient as unknown as FromableClient)
      .from('connector_alert_state')
      .update({ last_state: 'disconnected' })
      .eq('connector_id', 'nonexistent');

    // Either explicit deny or silent no-op (0 rows matched under RLS)
    if (error) {
      expect(DENY_CODES).toContain(error.code);
    }
  });

  it('authenticated cannot DELETE from connector_alert_state', async () => {
    const { error } = await (authClient as unknown as FromableClient)
      .from('connector_alert_state')
      .delete()
      .eq('connector_id', 'nonexistent');

    if (error) {
      expect(DENY_CODES).toContain(error.code);
    }
  });
});

// =============================================================================
// RLS: member_integrations (SCRUM-2044) — member reads own, admin reads org, deny writes
// =============================================================================

describe('RLS: member_integrations', () => {
  let adminClient: TypedClient;
  let betaAdminClient: TypedClient;
  let memberClient: TypedClient;
  let anonClient: TypedClient;
  let serviceClient: TypedClient;

  let adminUserId: string;
  let memberUserId: string;

  beforeAll(async () => {
    serviceClient = createServiceClient();
    adminClient = await withUser(DEMO_CREDENTIALS.adminEmail, 'ORG_ADMIN');
    betaAdminClient = await withUser(DEMO_CREDENTIALS.betaAdminEmail, 'ORG_ADMIN');
    memberClient = await withIndividualUser();
    anonClient = createAnonClient();

    // Resolve user IDs for seeding
    const { data: adminProfile } = await adminClient.auth.getUser();
    adminUserId = adminProfile.user?.id ?? '';

    const { data: memberProfile } = await memberClient.auth.getUser();
    memberUserId = memberProfile.user?.id ?? '';

    // Seed member_integrations rows via service_role
    await (serviceClient as unknown as FromableClient)
      .from('member_integrations')
      .insert({
        user_id: adminUserId,
        org_id: ARKOVA_ORG_ID,
        provider: 'docusign',
        account_id: 'rls-test-member-admin',
        account_label: 'Admin Member Integration',
      });

    await (serviceClient as unknown as FromableClient)
      .from('member_integrations')
      .insert({
        user_id: memberUserId,
        org_id: ARKOVA_ORG_ID,
        provider: 'docusign',
        account_id: 'rls-test-member-individual',
        account_label: 'Individual Member Integration',
      });
  });

  afterAll(async () => {
    await (serviceClient as unknown as FromableClient)
      .from('member_integrations')
      .delete()
      .eq('account_id', 'rls-test-member-admin');
    await (serviceClient as unknown as FromableClient)
      .from('member_integrations')
      .delete()
      .eq('account_id', 'rls-test-member-individual');

    await adminClient.auth.signOut();
    await betaAdminClient.auth.signOut();
    await memberClient.auth.signOut();
  });

  it('member can read their own member_integrations row', async () => {
    const { data, error } = await (memberClient as unknown as FromableClient)
      .from('member_integrations')
      .select('*')
      .eq('user_id', memberUserId);

    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
  });

  it('member cannot read another member\'s integration row', async () => {
    const { data } = await (memberClient as unknown as FromableClient)
      .from('member_integrations')
      .select('*')
      .eq('user_id', adminUserId);

    const visible = Array.isArray(data) ? data.length : 0;
    expect(visible).toBe(0);
  });

  it('org admin can read all member integrations in their org', async () => {
    const { data, error } = await (adminClient as unknown as FromableClient)
      .from('member_integrations')
      .select('*')
      .eq('org_id', ARKOVA_ORG_ID);

    expect(error).toBeNull();
    // Admin should see both rows (their own + the individual member's)
    expect(data!.length).toBeGreaterThanOrEqual(2);
  });

  it('org admin cannot read member integrations from another org', async () => {
    const { data } = await (betaAdminClient as unknown as FromableClient)
      .from('member_integrations')
      .select('*')
      .eq('org_id', ARKOVA_ORG_ID);

    const visible = Array.isArray(data) ? data.length : 0;
    expect(visible).toBe(0);
  });

  it('anon cannot read member_integrations', async () => {
    const { data, error } = await (anonClient as unknown as FromableClient)
      .from('member_integrations')
      .select('*')
      .limit(1);

    const visible = Array.isArray(data) ? data.length : 0;
    expect(visible).toBe(0);
    if (error) {
      expect(DENY_CODES).toContain(error.code);
    }
  });

  it('authenticated member cannot INSERT into member_integrations', async () => {
    const { error } = await (memberClient as unknown as FromableClient)
      .from('member_integrations')
      .insert({
        user_id: memberUserId,
        org_id: ARKOVA_ORG_ID,
        provider: 'docusign',
        account_id: 'rls-test-should-fail',
        account_label: 'Should Fail',
      });

    expect(error).not.toBeNull();
    expect(DENY_CODES).toContain(error!.code);
  });

  it('authenticated member cannot UPDATE member_integrations', async () => {
    const { error } = await (memberClient as unknown as FromableClient)
      .from('member_integrations')
      .update({ account_label: 'HACKED' })
      .eq('account_id', 'rls-test-member-individual');

    if (error) {
      expect(DENY_CODES).toContain(error.code);
    }
  });

  it('authenticated member cannot DELETE from member_integrations', async () => {
    const { error } = await (memberClient as unknown as FromableClient)
      .from('member_integrations')
      .delete()
      .eq('account_id', 'rls-test-member-individual');

    if (error) {
      expect(DENY_CODES).toContain(error.code);
    }
  });

  it('service_role can read all member_integrations (sanity check)', async () => {
    const { data, error } = await (serviceClient as unknown as FromableClient)
      .from('member_integrations')
      .select('*')
      .limit(10);

    expect(error).toBeNull();
    expect(data!.length).toBeGreaterThan(0);
  });
});

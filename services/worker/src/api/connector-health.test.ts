/**
 * Tests for SCRUM-1146 — connector health dashboard.
 *
 * Acceptance Criteria:
 *   - Lists supported, demo, and gated connectors.
 *   - Each connector shows connected/degraded/disconnected state.
 *   - Each shows last event received, last dispatch, last renewal, last error.
 *   - Health state distinguishes vendor auth, subscription expiry, processing failures.
 *   - Demo connector can be used without live credentials.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const profilesMaybeSingle = vi.fn();
const integrationsList = vi.fn();
const subsList = vi.fn();
const eventsAggregate = vi.fn();
const eventsByIdList = vi.fn();
const executionsAggregate = vi.fn();
// P0-2 (2026-09-14 hardening audit): the two new live signals — an enabled
// WORKSPACE_FILE_MODIFIED rule bound to Drive (gates cursor-staleness so a
// zero-rule org's never-advancing cursor is not a false positive), and
// recent google_drive.file_changed job_queue failures/dead-letters.
const driveRulesList = vi.fn();
const driveFetchJobFailuresList = vi.fn();

vi.mock('../config.js', () => ({ config: {} }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/db.js', () => {
  const profilesChain = {
    select: () => ({ eq: () => ({ maybeSingle: () => profilesMaybeSingle() }) }),
  };
  const orgIntegrationsChain = {
    select: () => ({ eq: () => integrationsList() }),
  };
  const subscriptionsChain = {
    select: () => ({ eq: () => subsList() }),
  };
  // organization_rule_events is queried twice:
  //   1. recent events (.eq('org_id').order(...).limit(...))     → eventsAggregate
  //   2. by-id batch fetch (.eq('org_id').in('id', [...]))       → eventsByIdList
  const eventsChain = {
    select: () => ({
      eq: () => ({
        order: () => ({ limit: () => eventsAggregate() }),
        in: () => eventsByIdList(),
      }),
    }),
  };
  const executionsChain = {
    select: () => ({
      eq: () => ({
        in: () => ({
          order: () => ({ limit: () => executionsAggregate() }),
        }),
      }),
    }),
  };
  // organization_rules: .select('id').eq('org_id').eq('trigger_type').eq('enabled').limit(1)
  const rulesChain = {
    select: () => ({
      eq: () => ({
        eq: () => ({
          eq: () => ({ limit: () => driveRulesList() }),
        }),
      }),
    }),
  };
  // job_queue: .select('status').eq('type').eq("payload->>org_id").in('status', [...]).limit(50)
  const jobQueueChain = {
    select: () => ({
      eq: () => ({
        eq: () => ({
          in: () => ({ limit: () => driveFetchJobFailuresList() }),
        }),
      }),
    }),
  };
  return {
    db: {
      from: (table: string) => {
        if (table === 'profiles') return profilesChain;
        if (table === 'org_integrations') return orgIntegrationsChain;
        if (table === 'connector_subscriptions') return subscriptionsChain;
        if (table === 'organization_rule_events') return eventsChain;
        if (table === 'organization_rule_executions') return executionsChain;
        if (table === 'organization_rules') return rulesChain;
        if (table === 'job_queue') return jobQueueChain;
        throw new Error(`unexpected table: ${table}`);
      },
    },
  };
});

const { handleConnectorHealth, CONNECTOR_CATALOG, resolveConnectorKind } = await import('./connector-health.js');

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function buildRes() {
  let statusCode: number | undefined;
  let body: unknown;
  const json = vi.fn((payload: unknown) => { body = payload; });
  const status = vi.fn((code: number) => { statusCode = code; return { json }; });
  const setHeader = vi.fn();
  const res = { status, json, setHeader } as unknown as Response;
  return { res, status, json, get body() { return body; }, get statusCode() { return statusCode; } };
}

function buildReq(): Request {
  return { query: {}, headers: {}, body: {} } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  profilesMaybeSingle.mockResolvedValue({ data: { org_id: ORG_ID }, error: null });
  integrationsList.mockResolvedValue({ data: [], error: null });
  subsList.mockResolvedValue({ data: [], error: null });
  eventsAggregate.mockResolvedValue({ data: [], error: null });
  eventsByIdList.mockResolvedValue({ data: [], error: null });
  executionsAggregate.mockResolvedValue({ data: [], error: null });
  driveRulesList.mockResolvedValue({ data: [], error: null });
  driveFetchJobFailuresList.mockResolvedValue({ data: [], error: null });
});

describe('connector-health (SCRUM-1146)', () => {
  describe('CONNECTOR_CATALOG', () => {
    it('microsoft_graph entry covers both sharepoint and onedrive vendor strings', () => {
      const entry = CONNECTOR_CATALOG.find((c) => c.id === 'microsoft_graph');
      expect(entry?.vendor_event_sources).toEqual(expect.arrayContaining(['sharepoint', 'onedrive']));
    });

    it('lists supported connectors with kind classifier (live / demo / gated)', () => {
      const kinds = new Set(CONNECTOR_CATALOG.map((c) => c.kind));
      expect(kinds.has('live')).toBe(true);
      expect(kinds.has('demo')).toBe(true);
      expect(kinds.has('gated')).toBe(true);
    });
    it('always includes a demo connector', () => {
      const demo = CONNECTOR_CATALOG.find((c) => c.kind === 'demo');
      expect(demo).toBeDefined();
      expect(demo?.id).toBeTruthy();
    });
  });

  // GH #1836 (SECURITY): account_label for google_drive carries channel_token
  // — a webhook-authentication secret — inside a JSON blob. It must never
  // reach this org-facing dashboard response.
  describe('account_label sanitization (GH #1836)', () => {
    it('strips channel_token and resource_id from a Drive account_label, keeping only email', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [{
          provider: 'google_drive',
          account_label: JSON.stringify({
            email: 'admin@example.com',
            channel_token: 'super-secret-webhook-token',
            resource_id: 'drive-resource-1',
          }),
          connected_at: '2026-04-20T00:00:00Z',
          revoked_at: null,
        }],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; account_label: string | null }> };
      const drive = body.connectors.find((c) => c.id === 'google_drive');
      expect(drive?.account_label).toBe('admin@example.com');
      expect(JSON.stringify(body)).not.toContain('super-secret-webhook-token');
      expect(JSON.stringify(body)).not.toContain('resource_id');
    });

    it('returns null when a Drive account_label JSON has no email (never leaks the raw blob)', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [{
          provider: 'google_drive',
          account_label: JSON.stringify({ channel_token: 'super-secret-webhook-token', resource_id: 'r1' }),
          connected_at: '2026-04-20T00:00:00Z',
          revoked_at: null,
        }],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; account_label: string | null }> };
      const drive = body.connectors.find((c) => c.id === 'google_drive');
      expect(drive?.account_label).toBeNull();
      expect(JSON.stringify(body)).not.toContain('super-secret-webhook-token');
    });

    it('passes a plain display-string account_label through unchanged (DocuSign etc.)', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [{
          provider: 'docusign',
          account_label: 'Acme Corp',
          connected_at: '2026-04-20T00:00:00Z',
          revoked_at: null,
        }],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; account_label: string | null }> };
      const docusign = body.connectors.find((c) => c.id === 'docusign');
      expect(docusign?.account_label).toBe('Acme Corp');
    });

    it('passes null account_label through as null', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [{ provider: 'docusign', account_label: null, connected_at: '2026-04-20T00:00:00Z', revoked_at: null }],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; account_label: string | null }> };
      const docusign = body.connectors.find((c) => c.id === 'docusign');
      expect(docusign?.account_label).toBeNull();
    });
  });

  describe('handleConnectorHealth', () => {
    it('rejects callers without an organization with 403', async () => {
      profilesMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      expect(ctx.status).toHaveBeenCalledWith(403);
    });

    it('returns the catalog with default disconnected state when org has no integrations', async () => {
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; state: string; kind: string }> };
      expect(Array.isArray(body.connectors)).toBe(true);
      expect(body.connectors.length).toBe(CONNECTOR_CATALOG.length);
      const demo = body.connectors.find((c) => c.kind === 'demo');
      expect(demo?.state).toBe('connected');
      const live = body.connectors.find((c) => c.kind === 'live' && c.id === 'docusign');
      expect(live?.state).toBe('disconnected');
    });

    it('marks live connector connected when an active integration row exists', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [
          {
            provider: 'docusign',
            account_label: 'Acme',
            connected_at: '2026-04-20T00:00:00Z',
            revoked_at: null,
          },
        ],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; state: string }> };
      const docusign = body.connectors.find((c) => c.id === 'docusign');
      expect(docusign?.state).toBe('connected');
    });

    // PR #1944 review round 3: google_drive's watch health is derived from
    // org_integrations directly (subscription_expires_at / last_renewal_at /
    // last_renewal_error) — NOT from connector_subscriptions, which nothing
    // ever writes a google_drive row into (drive-oauth.ts and
    // drive-subscription-renewal.ts both only touch org_integrations). See
    // deriveDriveWatchHealth() in connector-health.ts.
    it('marks Drive degraded from org_integrations.last_renewal_error — preserves vendor-side error, expiry, and renewal timestamp', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [{
          provider: 'google_drive',
          account_label: 'Acme',
          connected_at: '2026-04-20T00:00:00Z',
          revoked_at: null,
          subscription_expires_at: '2026-04-25T00:00:00Z',
          last_renewed_at: '2026-04-23T00:00:00Z',
          last_renewal_at: '2026-04-23T00:00:00Z',
          last_renewal_error: 'invalid_grant — admin must reconnect',
        }],
        error: null,
      });
      // connector_subscriptions has NOTHING for google_drive in reality —
      // leaving the default empty mock (see beforeEach) is the honest fixture.
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as {
        connectors: Array<{
          id: string;
          state: string;
          last_renewal_at?: string | null;
          next_expires_at?: string | null;
          last_error?: string | null;
          health_reason?: string | null;
        }>;
      };
      const drive = body.connectors.find((c) => c.id === 'google_drive');
      expect(drive?.state).toBe('degraded');
      expect(drive?.last_renewal_at).toBe('2026-04-23T00:00:00Z');
      expect(drive?.next_expires_at).toBe('2026-04-25T00:00:00Z');
      expect(drive?.last_error).toContain('invalid_grant');
      expect(drive?.health_reason).toBe('subscription_expiry');
    });

    it('a healthy Drive connection (last_renewal_error null) reports connected, not degraded', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [{
          provider: 'google_drive',
          account_label: 'Acme',
          connected_at: '2026-04-20T00:00:00Z',
          revoked_at: null,
          subscription_expires_at: '2026-08-10T00:00:00Z',
          last_renewal_at: '2026-08-03T00:00:00Z',
          last_renewal_error: null,
        }],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as {
        connectors: Array<{ id: string; state: string; next_expires_at?: string | null }>;
      };
      const drive = body.connectors.find((c) => c.id === 'google_drive');
      expect(drive?.state).toBe('connected');
      expect(drive?.next_expires_at).toBe('2026-08-10T00:00:00Z');
    });

    it('a never-renewed Drive connection (subscription_expires_at null) reports next_expires_at: null, not an empty string', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [{
          provider: 'google_drive',
          account_label: 'Acme',
          connected_at: '2026-04-20T00:00:00Z',
          revoked_at: null,
          subscription_expires_at: null,
          last_renewal_at: null,
          last_renewal_error: null,
        }],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as {
        connectors: Array<{ id: string; next_expires_at?: string | null }>;
      };
      const drive = body.connectors.find((c) => c.id === 'google_drive');
      expect(drive?.next_expires_at).toBeNull();
    });

    it('a stale connector_subscriptions google_drive row (leftover/legacy) is IGNORED — org_integrations is authoritative', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [{
          provider: 'google_drive',
          account_label: 'Acme',
          connected_at: '2026-04-20T00:00:00Z',
          revoked_at: null,
          subscription_expires_at: '2026-08-10T00:00:00Z',
          last_renewal_at: '2026-08-03T00:00:00Z',
          last_renewal_error: null,
        }],
        error: null,
      });
      // Even if something HAD written a stale/misleading connector_subscriptions
      // row claiming degraded, it must not override the org_integrations-derived
      // (healthy) truth.
      subsList.mockResolvedValueOnce({
        data: [{
          provider: 'google_drive',
          status: 'degraded',
          expires_at: '2020-01-01T00:00:00Z',
          last_renewed_at: null,
          last_renewal_error: 'stale row, ignore me',
        }],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; state: string; last_error?: string | null }> };
      const drive = body.connectors.find((c) => c.id === 'google_drive');
      expect(drive?.state).toBe('connected');
      expect(drive?.last_error).toBeNull();
    });

    it('distinguishes vendor_auth (revoked integration) from subscription_expiry', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [
          {
            provider: 'docusign',
            account_label: 'Acme',
            connected_at: '2026-04-20T00:00:00Z',
            revoked_at: '2026-04-23T00:00:00Z',
          },
        ],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as {
        connectors: Array<{ id: string; state: string; health_reason: string | null }>;
      };
      const docusign = body.connectors.find((c) => c.id === 'docusign');
      expect(docusign?.state).toBe('disconnected');
      expect(docusign?.health_reason).toBe('vendor_auth_revoked');
    });

    it('distinguishes processing_failure from healthy when failed executions outpace successes', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [{ provider: 'docusign', account_label: 'Acme', connected_at: '2026-04-20T00:00:00Z', revoked_at: null }],
        error: null,
      });
      executionsAggregate.mockResolvedValueOnce({
        data: [
          { trigger_event_id: 'evt-1', completed_at: '2026-04-24T12:00:00Z', error: 'destination_unreachable' },
        ],
        error: null,
      });
      // Vendor for evt-1 is docusign — the per-vendor join.
      eventsByIdList.mockResolvedValueOnce({
        data: [{ id: 'evt-1', vendor: 'docusign' }],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as {
        connectors: Array<{ id: string; state: string; health_reason: string | null; last_error: string | null }>;
      };
      const docusign = body.connectors.find((c) => c.id === 'docusign');
      expect(docusign?.health_reason).toBe('processing_failure');
      expect(docusign?.last_error).toContain('destination_unreachable');
    });

    it('does NOT mis-attribute one connector failure to other connectors (per-vendor correlation)', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [
          { provider: 'docusign', account_label: 'Acme', connected_at: '2026-04-20T00:00:00Z', revoked_at: null },
          { provider: 'google_drive', account_label: 'Acme', connected_at: '2026-04-20T00:00:00Z', revoked_at: null },
          { provider: 'adobe_sign', account_label: 'Acme', connected_at: '2026-04-20T00:00:00Z', revoked_at: null },
        ],
        error: null,
      });
      executionsAggregate.mockResolvedValueOnce({
        data: [
          { trigger_event_id: 'evt-1', completed_at: '2026-04-24T12:00:00Z', error: 'docusign-side error' },
        ],
        error: null,
      });
      eventsByIdList.mockResolvedValueOnce({
        data: [{ id: 'evt-1', vendor: 'docusign' }],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as {
        connectors: Array<{ id: string; health_reason: string | null }>;
      };
      expect(body.connectors.find((c) => c.id === 'docusign')?.health_reason).toBe('processing_failure');
      // Drive + Adobe Sign integrations exist but did NOT fail — must stay clean.
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('none');
      expect(body.connectors.find((c) => c.id === 'adobe_sign')?.health_reason).toBe('none');
    });

    it('microsoft_graph entry surfaces last event from either sharepoint OR onedrive vendor', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [{ provider: 'microsoft_graph', account_label: 'Acme', connected_at: '2026-04-20T00:00:00Z', revoked_at: null }],
        error: null,
      });
      eventsAggregate.mockResolvedValueOnce({
        data: [
          { vendor: 'onedrive', created_at: '2026-04-24T22:30:00Z' },
          { vendor: 'sharepoint', created_at: '2026-04-24T22:00:00Z' },
        ],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as {
        connectors: Array<{ id: string; last_event_at: string | null }>;
      };
      const m365 = body.connectors.find((c) => c.id === 'microsoft_graph');
      // Most recent across the set wins.
      expect(m365?.last_event_at).toBe('2026-04-24T22:30:00Z');
    });

    it('does not expose internal org_id (CLAUDE.md §6)', async () => {
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as Record<string, unknown>;
      expect(body.org_id).toBeUndefined();
    });

    it('reports last event received per connector from organization_rule_events', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [{ provider: 'docusign', account_label: 'Acme', connected_at: '2026-04-20T00:00:00Z', revoked_at: null }],
        error: null,
      });
      eventsAggregate.mockResolvedValueOnce({
        data: [{ vendor: 'docusign', created_at: '2026-04-24T22:00:00Z' }],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as {
        connectors: Array<{ id: string; last_event_at: string | null }>;
      };
      const docusign = body.connectors.find((c) => c.id === 'docusign');
      expect(docusign?.last_event_at).toBe('2026-04-24T22:00:00Z');
    });
  });

  // P0-2 (2026-09-14 hardening audit): the dashboard previously derived
  // google_drive's state from EXACTLY three signals (revoked_at, subscription
  // degraded, lastFailedExec) — none of which observe a stuck/410 changes
  // cursor or a dead google_drive.file_changed job_queue row. Rule dispatch
  // (organization_rule_executions, already watched) and document fetch
  // (job_queue, NOT watched) are two independent enqueues with independent
  // failure modes — a rule can read "success" while the fetch job dies
  // silently. These tests cover the two new live signals that close that gap.
  describe('Drive cursor-staleness + fetch-job-failure signals (P0-2)', () => {
    const FAR_PAST = '2020-01-01T00:00:00Z';
    const RECENT = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    function driveIntegrationRow(overrides: Record<string, unknown> = {}) {
      return {
        provider: 'google_drive',
        account_label: 'Acme',
        connected_at: '2026-04-20T00:00:00Z',
        revoked_at: null,
        subscription_expires_at: '2026-12-01T00:00:00Z',
        last_renewal_at: '2026-09-01T00:00:00Z',
        last_renewal_error: null,
        last_token_advanced_at: RECENT,
        ...overrides,
      };
    }

    it('flags cursor_stale when the cursor has not advanced in hours AND the org has an enabled Drive rule AND the channel is otherwise healthy', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [driveIntegrationRow({ last_token_advanced_at: FAR_PAST })],
        error: null,
      });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1' }], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as {
        connectors: Array<{ id: string; state: string; health_reason: string | null; last_error: string | null }>;
      };
      const drive = body.connectors.find((c) => c.id === 'google_drive');
      expect(drive?.state).toBe('degraded');
      expect(drive?.health_reason).toBe('cursor_stale');
      expect(drive?.last_error).toBeTruthy();
    });

    it('does NOT flag cursor_stale for an org with zero enabled Drive rules (false-positive guard — no rule means the cursor is expected to never advance)', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [driveIntegrationRow({ last_token_advanced_at: FAR_PAST })],
        error: null,
      });
      // driveRulesList stays at the default empty-array mock (beforeEach).
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as {
        connectors: Array<{ id: string; state: string; health_reason: string | null }>;
      };
      const drive = body.connectors.find((c) => c.id === 'google_drive');
      expect(drive?.health_reason).not.toBe('cursor_stale');
    });

    it('does NOT flag cursor_stale for a recently-advanced cursor', async () => {
      integrationsList.mockResolvedValueOnce({ data: [driveIntegrationRow()], error: null });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1' }], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('none');
    });

    it('does NOT flag cursor_stale for a never-bootstrapped cursor (last_token_advanced_at null — that is P0-1 territory, out of scope here)', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [driveIntegrationRow({ last_token_advanced_at: null })],
        error: null,
      });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1' }], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).not.toBe('cursor_stale');
    });

    it('subscription_expiry still outranks cursor_stale (channel itself is broken — a stale cursor is the expected side effect, not new information)', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [driveIntegrationRow({ last_token_advanced_at: FAR_PAST, last_renewal_error: 'invalid_grant' })],
        error: null,
      });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1' }], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('subscription_expiry');
    });

    it('flags fetch_job_failures when google_drive.file_changed has failed/dead job_queue rows for this org', async () => {
      integrationsList.mockResolvedValueOnce({ data: [driveIntegrationRow()], error: null });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1' }], error: null });
      driveFetchJobFailuresList.mockResolvedValueOnce({
        data: [{ status: 'dead' }, { status: 'failed' }],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as {
        connectors: Array<{ id: string; state: string; health_reason: string | null; last_error: string | null }>;
      };
      const drive = body.connectors.find((c) => c.id === 'google_drive');
      expect(drive?.state).toBe('degraded');
      expect(drive?.health_reason).toBe('fetch_job_failures');
      expect(drive?.last_error).toContain('2');
    });

    it('a healthy Drive connector with zero fetch-job failures and an advancing cursor stays connected/none', async () => {
      integrationsList.mockResolvedValueOnce({ data: [driveIntegrationRow()], error: null });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1' }], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; state: string; health_reason: string | null }> };
      const drive = body.connectors.find((c) => c.id === 'google_drive');
      expect(drive?.state).toBe('connected');
      expect(drive?.health_reason).toBe('none');
    });

    it('fetch-job failures for google_drive never leak onto an unrelated connector (per-org scoping, not global queue depth)', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [
          driveIntegrationRow(),
          { provider: 'docusign', account_label: 'Acme', connected_at: '2026-04-20T00:00:00Z', revoked_at: null },
        ],
        error: null,
      });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1' }], error: null });
      driveFetchJobFailuresList.mockResolvedValueOnce({ data: [{ status: 'dead' }], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('fetch_job_failures');
      expect(body.connectors.find((c) => c.id === 'docusign')?.health_reason).toBe('none');
    });
  });
});

/**
 * SCRUM-1148 follow-up — the Adobe Sign connector kind is DERIVED, not asserted.
 *
 * PR #2519 downgraded `adobe_sign` from a hardcoded 'live' to 'gated' because
 * the connector had no connect flow and 503'd on 100% of prod traffic. Adding
 * the connect flow does not by itself earn 'live' back: prod still has no Adobe
 * credential. These tests pin that the claim tracks the deployment's actual
 * ability to complete a connection, in BOTH directions.
 */
describe('resolveConnectorKind — adobe_sign', () => {
  const adobeEntry = CONNECTOR_CATALOG.find((c) => c.id === 'adobe_sign');

  it('is gated in an environment with no Adobe credential — the live prod state', () => {
    expect(adobeEntry).toBeDefined();
    expect(resolveConnectorKind(adobeEntry!, {})).toBe('gated');
  });

  it('stays gated when credentials exist but the connect flow is off', () => {
    expect(
      resolveConnectorKind(adobeEntry!, {
        ADOBE_SIGN_CLIENT_ID: 'id',
        ADOBE_SIGN_CLIENT_SECRET: 'secret',
      }),
    ).toBe('gated');
  });

  it('stays gated when the flow is on but a credential is missing', () => {
    expect(
      resolveConnectorKind(adobeEntry!, {
        ENABLE_ADOBE_SIGN_OAUTH: 'true',
        ADOBE_SIGN_CLIENT_ID: 'id',
      }),
    ).toBe('gated');
  });

  it('treats a whitespace-only credential as absent', () => {
    expect(
      resolveConnectorKind(adobeEntry!, {
        ENABLE_ADOBE_SIGN_OAUTH: 'true',
        ADOBE_SIGN_CLIENT_ID: '  ',
        ADOBE_SIGN_CLIENT_SECRET: 'secret',
      }),
    ).toBe('gated');
  });

  it('is live only when the flow is enabled AND both credentials are present', () => {
    expect(
      resolveConnectorKind(adobeEntry!, {
        ENABLE_ADOBE_SIGN_OAUTH: 'true',
        ADOBE_SIGN_CLIENT_ID: 'id',
        ADOBE_SIGN_CLIENT_SECRET: 'secret',
      }),
    ).toBe('live');
  });

  it('leaves every other connector\'s catalog kind untouched', () => {
    const fullyConfigured = {
      ENABLE_ADOBE_SIGN_OAUTH: 'true',
      ADOBE_SIGN_CLIENT_ID: 'id',
      ADOBE_SIGN_CLIENT_SECRET: 'secret',
    };
    for (const entry of CONNECTOR_CATALOG.filter((c) => c.id !== 'adobe_sign')) {
      expect(resolveConnectorKind(entry, fullyConfigured)).toBe(entry.kind);
    }
  });
});

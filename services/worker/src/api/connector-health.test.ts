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
const driveRulesPages = vi.fn();
const driveFetchJobFailuresList = vi.fn();
// Round-2 fix (item 2): the gap-visibility read from audit_events.
const driveGapEventsList = vi.fn();
const driveMirrorEventsList = vi.fn();

vi.mock('../config.js', () => ({ config: {} }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/db.js', () => {
  const profilesChain = {
    select: () => ({ eq: () => ({ maybeSingle: () => profilesMaybeSingle() }) }),
  };
  const orgIntegrationsChain = {
    select: () => ({ eq: () => {
      const chain = {
        order: () => chain,
        range: (from: number, to: number) => ({ abortSignal: (signal: AbortSignal) => integrationsList(from, to, signal) }),
      };
      return chain;
    } }),
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
          eq: () => ({
            order: () => ({ range: (from: number, to: number) => ({
              abortSignal: (signal: AbortSignal) => driveRulesPages(from, to, signal),
            }) }),
          }),
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
  // Round-2 fix (item 2): audit_events, scoped by org_id + event_type
  // (both indexed — idx_audit_events_org_id, idx_audit_events_event_type)
  // and a created_at lookback window.
  // .select(...).eq('org_id').eq('event_type').gte('created_at').order(...).limit(...)
  const auditEventsChain = {
    select: () => ({
      eq: () => ({
        eq: () => ({
          gte: () => ({
            order: () => ({ limit: () => driveGapEventsList() }),
          }),
          eq: () => ({
            in: () => ({ order: () => ({ limit: () => ({ abortSignal: (signal: AbortSignal) => driveMirrorEventsList(signal) }) }) }),
          }),
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
        if (table === 'audit_events') return auditEventsChain;
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
  driveRulesPages.mockImplementation((offset: number) => offset === 0
    ? driveRulesList() : Promise.resolve({ data: [], error: null }));
  driveFetchJobFailuresList.mockResolvedValue({ data: [], error: null });
  driveGapEventsList.mockResolvedValue({ data: [], error: null });
  driveMirrorEventsList.mockResolvedValue({ data: [], error: null });
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
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
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
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('none');
    });

    it('does NOT flag cursor_stale (specifically) for a never-bootstrapped cursor — see changes_list_never_succeeded below for what IS now flagged', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [driveIntegrationRow({ last_token_advanced_at: null })],
        error: null,
      });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).not.toBe('cursor_stale');
    });
  });

  // Task 4 (orchestrator "make this failure loud" review, SCRUM-2903/3661
  // fields-mask incident follow-up): the P0-2 cursor_stale signal above was
  // BLIND to a cursor that has never once advanced — which is exactly the
  // shape of a connection whose every changes.list call has failed since it
  // connected (this incident: HTTP 400 fields-mask bug, 150 failures/day,
  // zero successes, ever). Before this fix the dashboard showed
  // 'connected'/'none' for that entire window with no signal at all — the
  // previous test block's `driveIntegrationRow()` default `connected_at`
  // ('2026-04-20') is already old enough to demonstrate this: it was
  // ASSERTED as "out of scope" there and is now covered here.
  describe('Drive changes_list_never_succeeded signal (Task 4 gap fix)', () => {
    const FAR_PAST_CONNECT = '2020-01-01T00:00:00Z';
    const RECENT_CONNECT = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    function neverAdvancedDriveRow(overrides: Record<string, unknown> = {}) {
      return {
        provider: 'google_drive',
        account_label: 'Acme',
        connected_at: FAR_PAST_CONNECT,
        revoked_at: null,
        subscription_expires_at: '2026-12-01T00:00:00Z',
        last_renewal_at: null,
        last_renewal_error: null,
        last_token_advanced_at: null,
        ...overrides,
      };
    }

    it('flags changes_list_never_succeeded when the cursor has NEVER advanced, connected_at is old, AND the org has an enabled Drive rule', async () => {
      integrationsList.mockResolvedValueOnce({ data: [neverAdvancedDriveRow()], error: null });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as {
        connectors: Array<{ id: string; state: string; health_reason: string | null; last_error: string | null }>;
      };
      const drive = body.connectors.find((c) => c.id === 'google_drive');
      expect(drive?.state).toBe('degraded');
      expect(drive?.health_reason).toBe('changes_list_never_succeeded');
      expect(drive?.last_error).toContain('never succeeded');
    });

    it('does NOT flag a freshly-connected integration (connected_at recent, cursor never advanced yet — expected, not a finding)', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [neverAdvancedDriveRow({ connected_at: RECENT_CONNECT })],
        error: null,
      });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('none');
    });

    it('does NOT flag an org with zero enabled Drive rules (same false-positive guard as cursor_stale)', async () => {
      integrationsList.mockResolvedValueOnce({ data: [neverAdvancedDriveRow()], error: null });
      // driveRulesList stays at the default empty-array mock (beforeEach).
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).not.toBe('changes_list_never_succeeded');
    });

    it('is mutually exclusive with cursor_stale — a cursor that HAS advanced at least once never reads changes_list_never_succeeded', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [neverAdvancedDriveRow({ last_token_advanced_at: '2020-06-01T00:00:00Z' })],
        error: null,
      });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('cursor_stale');
    });

    it('subscription_expiry still outranks changes_list_never_succeeded (broken channel already explains it)', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [neverAdvancedDriveRow({ last_renewal_error: 'invalid_grant' })],
        error: null,
      });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('subscription_expiry');
    });
  });

  describe('Drive cursor-staleness + fetch-job-failure signals (P0-2), continued', () => {
    const FAR_PAST = '2020-01-01T00:00:00Z';

    function driveIntegrationRow(overrides: Record<string, unknown> = {}) {
      return {
        provider: 'google_drive',
        account_label: 'Acme',
        connected_at: '2026-04-20T00:00:00Z',
        revoked_at: null,
        subscription_expires_at: '2026-12-01T00:00:00Z',
        last_renewal_at: '2026-09-01T00:00:00Z',
        last_renewal_error: null,
        last_token_advanced_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        ...overrides,
      };
    }

    it('subscription_expiry still outranks cursor_stale (channel itself is broken — a stale cursor is the expected side effect, not new information)', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [driveIntegrationRow({ last_token_advanced_at: FAR_PAST, last_renewal_error: 'invalid_grant' })],
        error: null,
      });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('subscription_expiry');
    });

    it('flags fetch_job_failures when google_drive.file_changed has failed/dead job_queue rows for this org', async () => {
      integrationsList.mockResolvedValueOnce({ data: [driveIntegrationRow()], error: null });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
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
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
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
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      driveFetchJobFailuresList.mockResolvedValueOnce({ data: [{ status: 'dead' }], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('fetch_job_failures');
      expect(body.connectors.find((c) => c.id === 'docusign')?.health_reason).toBe('none');
    });
  });

  // SCRUM-5287 (P1 security, fix-round item 5): the OAuth callback guard
  // (drive-oauth.ts) only protects NEW connections going forward — an
  // EXISTING over-scoped row (like the flagged prod org) needs its own
  // visible signal so an admin can see it and force a re-consent.
  describe('grant_exceeds_requested signal (SCRUM-5287)', () => {
    function overScopedDriveRow(overrides: Record<string, unknown> = {}) {
      return {
        provider: 'google_drive',
        account_label: 'Acme',
        connected_at: '2026-04-20T00:00:00Z',
        revoked_at: null,
        subscription_expires_at: '2026-12-01T00:00:00Z',
        last_renewal_at: '2026-09-01T00:00:00Z',
        last_renewal_error: null,
        last_token_advanced_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        // The flagged prod shape: full drive + gmail.modify + contacts, far
        // beyond DRIVE_DEFAULT_SCOPES.
        scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/contacts',
        ...overrides,
      };
    }

    it('an existing row whose stored scope exceeds DRIVE_DEFAULT_SCOPES reads degraded/grant_exceeds_requested', async () => {
      integrationsList.mockResolvedValueOnce({ data: [overScopedDriveRow()], error: null });
      // No rule needed — unlike cursor_stale/changes_list_never_succeeded,
      // an over-grant is a finding regardless of whether anything is
      // actively watching.
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as {
        connectors: Array<{ id: string; state: string; health_reason: string | null; last_error: string | null }>;
      };
      const drive = body.connectors.find((c) => c.id === 'google_drive');
      expect(drive?.state).toBe('degraded');
      expect(drive?.health_reason).toBe('grant_exceeds_requested');
      expect(drive?.last_error).toContain('gmail.modify');
    });

    it('outranks every other Drive reason, including subscription_expiry', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [overScopedDriveRow({ last_renewal_error: 'invalid_grant' })],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('grant_exceeds_requested');
    });

    it('a row whose scope is within DRIVE_DEFAULT_SCOPES (including the `email` alias) is NOT flagged', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [overScopedDriveRow({
          scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.activity.readonly https://www.googleapis.com/auth/drive.metadata.readonly email',
        })],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).not.toBe('grant_exceeds_requested');
    });

    it('a row with no stored scope (null) is NOT flagged', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [overScopedDriveRow({ scope: null })],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).not.toBe('grant_exceeds_requested');
    });
  });

  // Fix-round item 6 (scope-reality finding): the FIRST customer failure —
  // `drive.file` not actually covering an ordinary watched-folder file —
  // must be visible here, not only in job_queue.last_error.
  describe('file_access_not_granted signal (fix-round item 6)', () => {
    function healthyDriveRow(overrides: Record<string, unknown> = {}) {
      return {
        provider: 'google_drive',
        account_label: 'Acme',
        connected_at: '2026-04-20T00:00:00Z',
        revoked_at: null,
        subscription_expires_at: '2026-12-01T00:00:00Z',
        last_renewal_at: '2026-09-01T00:00:00Z',
        last_renewal_error: null,
        last_token_advanced_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        // CURRENT (post-cutover) scope — NOT the legacy set. This describe
        // block isolates `file_access_not_granted`; a legacy-scope row
        // reads `reconnect_required_scope_change` instead (see that
        // describe block below), which would make these fixtures test the
        // wrong signal.
        scope: 'https://www.googleapis.com/auth/drive.readonly email',
        ...overrides,
      };
    }

    it('a job whose last_error matches DriveFileAccessError\'s message reads degraded/file_access_not_granted', async () => {
      integrationsList.mockResolvedValueOnce({ data: [healthyDriveRow()], error: null });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      driveFetchJobFailuresList.mockResolvedValueOnce({
        data: [{ status: 'dead', last_error: 'Drive file access denied: appNotAuthorizedToFile' }],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as {
        connectors: Array<{ id: string; state: string; health_reason: string | null; last_error: string | null }>;
      };
      const drive = body.connectors.find((c) => c.id === 'google_drive');
      expect(drive?.state).toBe('degraded');
      expect(drive?.health_reason).toBe('file_access_not_granted');
      expect(drive?.last_error).toContain('grant does not cover');
    });

    it('a job whose last_error matches the export-size-limit message ALSO reads file_access_not_granted', async () => {
      integrationsList.mockResolvedValueOnce({ data: [healthyDriveRow()], error: null });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      driveFetchJobFailuresList.mockResolvedValueOnce({
        data: [{ status: 'failed', last_error: "Drive file export exceeds Google's export size limit" }],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('file_access_not_granted');
    });

    it('outranks the generic fetch_job_failures reason', async () => {
      integrationsList.mockResolvedValueOnce({ data: [healthyDriveRow()], error: null });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      driveFetchJobFailuresList.mockResolvedValueOnce({
        data: [
          { status: 'dead', last_error: 'Drive file access denied: forbidden' },
          { status: 'failed', last_error: 'some unrelated transient error' },
        ],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('file_access_not_granted');
    });

    it('a failure with an UNRELATED last_error still reads the generic fetch_job_failures, not file_access_not_granted', async () => {
      integrationsList.mockResolvedValueOnce({ data: [healthyDriveRow()], error: null });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      driveFetchJobFailuresList.mockResolvedValueOnce({
        data: [{ status: 'failed', last_error: 'ETIMEDOUT connecting to googleapis.com' }],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('fetch_job_failures');
    });

    // SonarCloud typescript:S5850 (confirmed): the pattern
    // `/^Drive file access denied|export size limit/i` binds as
    // `(^Drive file access denied)|(export size limit)` — the SECOND
    // alternative is unanchored, so it matches "export size limit"
    // anywhere in last_error, not just Google's own export-size-limit
    // message. An unrelated failure that merely mentions that phrase
    // mid-string must NOT be counted as file_access_not_granted.
    it('an UNRELATED last_error that merely contains "export size limit" mid-string does NOT read file_access_not_granted (S5850)', async () => {
      integrationsList.mockResolvedValueOnce({ data: [healthyDriveRow()], error: null });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      driveFetchJobFailuresList.mockResolvedValueOnce({
        data: [{ status: 'failed', last_error: 'Timeout while waiting; upstream said export size limit unknown' }],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('fetch_job_failures');
    });

    // Case-insensitivity is intentional (the pattern carries `/i`) and must
    // survive the anchoring fix — a lowercase-at-start message still counts.
    it('a lowercase-at-start "drive file access denied" last_error still reads file_access_not_granted (case-insensitive, S5850)', async () => {
      integrationsList.mockResolvedValueOnce({ data: [healthyDriveRow()], error: null });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      driveFetchJobFailuresList.mockResolvedValueOnce({
        data: [{ status: 'dead', last_error: 'drive file access denied: appNotAuthorizedToFile' }],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('file_access_not_granted');
    });
  });

  // SCRUM-5287 follow-up (2026-09-21 drive.readonly cutover, task 2): an
  // EXISTING row whose stored scope is the pre-cutover requested set needs
  // re-consent — distinct from both `grant_exceeds_requested` (a security
  // finding) and `file_access_not_granted` (the downstream symptom this
  // reason should outrank, since it is the actual cause).
  describe('reconnect_required_scope_change signal (SCRUM-5287 follow-up)', () => {
    function legacyGrantDriveRow(overrides: Record<string, unknown> = {}) {
      return {
        provider: 'google_drive',
        account_label: 'Acme',
        connected_at: '2026-04-20T00:00:00Z',
        revoked_at: null,
        subscription_expires_at: '2026-12-01T00:00:00Z',
        last_renewal_at: '2026-09-01T00:00:00Z',
        last_renewal_error: null,
        last_token_advanced_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.activity.readonly https://www.googleapis.com/auth/drive.metadata.readonly email',
        ...overrides,
      };
    }

    it('a row holding exactly the pre-cutover scope set reads degraded/reconnect_required_scope_change', async () => {
      integrationsList.mockResolvedValueOnce({ data: [legacyGrantDriveRow()], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as {
        connectors: Array<{ id: string; state: string; health_reason: string | null; last_error: string | null }>;
      };
      const drive = body.connectors.find((c) => c.id === 'google_drive');
      expect(drive?.state).toBe('degraded');
      expect(drive?.health_reason).toBe('reconnect_required_scope_change');
      expect(drive?.last_error).toContain('Reconnect Google Drive');
    });

    it('a row holding the CURRENT scope set (drive.readonly) is NOT flagged', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [legacyGrantDriveRow({ scope: 'https://www.googleapis.com/auth/drive.readonly email' })],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).not.toBe('reconnect_required_scope_change');
    });

    it('outranks file_access_not_granted — the legacy grant is the actual cause of that symptom', async () => {
      integrationsList.mockResolvedValueOnce({ data: [legacyGrantDriveRow()], error: null });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      driveFetchJobFailuresList.mockResolvedValueOnce({
        data: [{ status: 'dead', last_error: 'Drive file access denied: appNotAuthorizedToFile' }],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('reconnect_required_scope_change');
    });

    it('does NOT outrank grant_exceeds_requested — a genuine over-grant stays the top finding', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [legacyGrantDriveRow({
          scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/gmail.modify',
        })],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('grant_exceeds_requested');
    });

    it('a row with no stored scope (null) is NOT flagged', async () => {
      integrationsList.mockResolvedValueOnce({ data: [legacyGrantDriveRow({ scope: null })], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).not.toBe('reconnect_required_scope_change');
    });
  });

  // SCRUM-5287 follow-up (2026-09-22 fix-round, CRITICAL finding):
  // loadDriveAccessToken writes a distinctly-prefixed last_renewal_error
  // when a refresh fails under BOTH configured OAuth clients — this signal
  // must be recognized here and outrank the generic subscription_expiry
  // classification that same column would otherwise produce.
  describe('oauth_client_mismatch signal (SCRUM-5287 follow-up)', () => {
    function mismatchDriveRow(overrides: Record<string, unknown> = {}) {
      return {
        provider: 'google_drive',
        account_label: 'Acme',
        connected_at: '2026-04-20T00:00:00Z',
        revoked_at: null,
        subscription_expires_at: '2026-12-01T00:00:00Z',
        last_renewal_at: '2026-09-01T00:00:00Z',
        last_renewal_error: 'Drive OAuth client mismatch: refresh failed under both configured OAuth clients (invalid_grant) — reconnect required',
        last_token_advanced_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        scope: 'https://www.googleapis.com/auth/drive.readonly email',
        ...overrides,
      };
    }

    it('a row whose last_renewal_error carries the mismatch prefix reads degraded/oauth_client_mismatch', async () => {
      integrationsList.mockResolvedValueOnce({ data: [mismatchDriveRow()], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as {
        connectors: Array<{ id: string; state: string; health_reason: string | null; last_error: string | null }>;
      };
      const drive = body.connectors.find((c) => c.id === 'google_drive');
      expect(drive?.state).toBe('degraded');
      expect(drive?.health_reason).toBe('oauth_client_mismatch');
      expect(drive?.last_error).toContain('Drive OAuth client mismatch');
    });

    it('outranks the generic subscription_expiry classification of the same last_renewal_error column', async () => {
      // Without the prefix-recognition, this row would read
      // subscription_expiry (deriveDriveWatchHealth: any non-null
      // last_renewal_error -> status 'degraded').
      integrationsList.mockResolvedValueOnce({ data: [mismatchDriveRow()], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).not.toBe('subscription_expiry');
    });

    it('an UNRELATED last_renewal_error (no mismatch prefix) still reads subscription_expiry, not oauth_client_mismatch', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [mismatchDriveRow({ last_renewal_error: 'channels.watch failed: 503' })],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('subscription_expiry');
    });

    it('does NOT outrank grant_exceeds_requested — a genuine over-grant stays the top finding', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [mismatchDriveRow({
          scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/gmail.modify',
        })],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('grant_exceeds_requested');
    });

    it('a row with no last_renewal_error is NOT flagged', async () => {
      integrationsList.mockResolvedValueOnce({ data: [mismatchDriveRow({ last_renewal_error: null })], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).not.toBe('oauth_client_mismatch');
    });
  });

  // Round-2 fix (item 2): the re-bootstrap gap IS durably persisted to
  // audit_events (fix-round item 2), but until this fix nothing in
  // connector-health.ts ever read it back — an admin had no product-visible
  // way to learn a gap occurred. This makes that read real.
  describe('changes_gap signal (round-2 fix item 2)', () => {
    function healthyDriveRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'integration-gap-1',
        provider: 'google_drive',
        account_label: 'Acme',
        connected_at: '2026-04-20T00:00:00Z',
        revoked_at: null,
        subscription_expires_at: '2026-12-01T00:00:00Z',
        last_renewal_at: '2026-09-01T00:00:00Z',
        last_renewal_error: null,
        last_token_advanced_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        scope: null,
        ...overrides,
      };
    }

    function gapRow(overrides: Record<string, unknown> = {}) {
      return {
        target_id: 'integration-gap-1',
        created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago
        details: JSON.stringify({
          gap_start: '2026-09-20T10:00:00.000Z',
          gap_end: '2026-09-20T10:05:00.000Z',
          reason: 'pageTokenInvalid',
        }),
        ...overrides,
      };
    }

    it('a gap event within the lookback window reads degraded/changes_gap with both bounds in last_error', async () => {
      integrationsList.mockResolvedValueOnce({ data: [healthyDriveRow()], error: null });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      driveGapEventsList.mockResolvedValueOnce({ data: [gapRow()], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as {
        connectors: Array<{ id: string; state: string; health_reason: string | null; last_error: string | null }>;
      };
      const drive = body.connectors.find((c) => c.id === 'google_drive');
      expect(drive?.state).toBe('degraded');
      expect(drive?.health_reason).toBe('changes_gap');
      expect(drive?.last_error).toContain('2026-09-20T10:00:00.000Z');
      expect(drive?.last_error).toContain('2026-09-20T10:05:00.000Z');
    });

    it('no gap event at all reads connected/none (unaffected by this signal)', async () => {
      integrationsList.mockResolvedValueOnce({ data: [healthyDriveRow()], error: null });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      driveGapEventsList.mockResolvedValueOnce({ data: [], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('none');
    });

    it('a gap event OUTSIDE the lookback window is not reported', async () => {
      integrationsList.mockResolvedValueOnce({ data: [healthyDriveRow()], error: null });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      // The query itself is window-bounded (a gte('created_at', cutoff)
      // filter at the DB layer), so an out-of-window row is simply never
      // returned by the mock — this proves the CALLER treats an empty
      // result as "no gap," not that a stale row leaks through.
      driveGapEventsList.mockResolvedValueOnce({ data: [], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('none');
    });

    it('a gap event for a DIFFERENT integration does not leak onto this one', async () => {
      integrationsList.mockResolvedValueOnce({ data: [healthyDriveRow()], error: null });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      driveGapEventsList.mockResolvedValueOnce({ data: [gapRow({ target_id: 'some-other-integration' })], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('none');
    });

    it('outranks the generic fetch_job_failures reason (data loss outranks a retryable fetch error)', async () => {
      integrationsList.mockResolvedValueOnce({ data: [healthyDriveRow()], error: null });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      driveGapEventsList.mockResolvedValueOnce({ data: [gapRow()], error: null });
      driveFetchJobFailuresList.mockResolvedValueOnce({ data: [{ status: 'dead', last_error: 'some unrelated error' }], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('changes_gap');
    });

    it('is outranked by cursor_stale (an ACTIVELY broken connector right now outranks a past, already-recovered-from gap)', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [healthyDriveRow({ last_token_advanced_at: '2020-01-01T00:00:00Z' })],
        error: null,
      });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      driveGapEventsList.mockResolvedValueOnce({ data: [gapRow()], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('cursor_stale');
    });

    it('never puts a token or raw JSON blob in last_error — only the two ISO bounds', async () => {
      integrationsList.mockResolvedValueOnce({ data: [healthyDriveRow()], error: null });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      driveGapEventsList.mockResolvedValueOnce({
        data: [gapRow({ details: JSON.stringify({ gap_start: '2026-09-20T10:00:00.000Z', gap_end: '2026-09-20T10:05:00.000Z', reason: 'pageTokenInvalid', channel_token: 'super-secret-token-should-never-appear' }) })],
        error: null,
      });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; last_error: string | null }> };
      const lastError = body.connectors.find((c) => c.id === 'google_drive')?.last_error ?? '';
      expect(lastError).not.toContain('super-secret-token-should-never-appear');
      expect(lastError).not.toContain('channel_token');
    });

    it('a malformed details payload degrades gracefully (still flags changes_gap, does not throw)', async () => {
      integrationsList.mockResolvedValueOnce({ data: [healthyDriveRow()], error: null });
      driveRulesList.mockResolvedValueOnce({ data: [{ id: 'rule-1', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
      driveGapEventsList.mockResolvedValueOnce({ data: [gapRow({ details: 'not valid json{{' })], error: null });
      const ctx = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), ctx.res);
      const body = ctx.body as { connectors: Array<{ id: string; health_reason: string | null }> };
      expect(body.connectors.find((c) => c.id === 'google_drive')?.health_reason).toBe('changes_gap');
    });

    it('keeps failures isolated per enabled rule and clears only that rule on recovery', async () => {
      integrationsList
        .mockResolvedValueOnce({ data: [healthyDriveRow()], error: null })
        .mockResolvedValueOnce({ data: [], error: null })
        .mockResolvedValueOnce({ data: [healthyDriveRow()], error: null })
        .mockResolvedValueOnce({ data: [], error: null });
      const rules = [
        { id: 'rule-a', trigger_config: { drive_folders: [{ folder_id: 'a' }] } },
        { id: 'rule-b', trigger_config: { drive_folders: [{ folder_id: 'b' }] } },
      ];
      driveRulesList
        .mockResolvedValueOnce({ data: rules, error: null })
        .mockResolvedValueOnce({ data: rules, error: null });
      driveMirrorEventsList
        .mockResolvedValueOnce({ data: [{ event_type: 'drive_folder_mirror_recovered' }], error: null })
        .mockResolvedValueOnce({ data: [{ event_type: 'drive_folder_mirror_failed' }], error: null });
      const failed = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), failed.res);
      expect((failed.body as { connectors: Array<{ id: string; health_reason: string }> }).connectors
        .find(({ id }) => id === 'google_drive')?.health_reason).toBe('folder_mirror_failed');

      driveMirrorEventsList
        .mockResolvedValueOnce({ data: [{ event_type: 'drive_folder_mirror_recovered' }], error: null })
        .mockResolvedValueOnce({ data: [{ event_type: 'drive_folder_mirror_recovered' }], error: null });
      const recovered = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), recovered.res);
      expect((recovered.body as { connectors: Array<{ id: string; health_reason: string }> }).connectors
        .find(({ id }) => id === 'google_drive')?.health_reason).toBe('none');
    });

    it.each([
      null,
      {},
      [{}],
      [null],
      [{ event_type: 'unexpected_event' }],
      [{ event_type: 'drive_folder_mirror_failed' }, { event_type: 'drive_folder_mirror_recovered' }],
    ])('fails closed when an exact per-rule mirror state is malformed: %j', async (data) => {
      integrationsList.mockResolvedValueOnce({ data: [healthyDriveRow()], error: null });
      driveRulesList.mockResolvedValueOnce({
        data: [{ id: 'rule-a', trigger_config: { drive_folders: [{ folder_id: 'a' }] } }],
        error: null,
      });
      driveMirrorEventsList.mockResolvedValueOnce({ data, error: null });
      const result = buildRes();
      await handleConnectorHealth(USER_ID, buildReq(), result.res);
      expect(result.status).toHaveBeenCalledWith(503);
      expect(driveMirrorEventsList).toHaveBeenCalledWith(expect.any(AbortSignal));
    });

    it('aborts the exact per-rule sweep at its total deadline and returns unknown health', async () => {
      vi.useFakeTimers();
      try {
        integrationsList.mockResolvedValueOnce({ data: [healthyDriveRow()], error: null });
        driveRulesList.mockResolvedValueOnce({
          data: [{ id: 'rule-a', trigger_config: { drive_folders: [{ folder_id: 'a' }] } }],
          error: null,
        });
        driveMirrorEventsList.mockImplementationOnce((signal: AbortSignal) => new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ data: null, error: new Error('aborted') }), { once: true });
        }));
        const result = buildRes();
        const pending = handleConnectorHealth(USER_ID, buildReq(), result.res);
        await vi.advanceTimersByTimeAsync(3_001);
        await pending;
        expect(result.status).toHaveBeenCalledWith(503);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('Drive health across multiple accounts', () => {
  const connection = (id: string, changes: Record<string, unknown> = {}) => ({
    id, provider: 'google_drive', account_label: id,
    connected_at: '2026-09-14T16:13:26Z', revoked_at: null,
    subscription_expires_at: '2026-10-14T16:13:26Z',
    last_renewal_error: null, last_renewal_at: null,
    last_token_advanced_at: new Date().toISOString(), ...changes,
  });
  const healthy = connection('00000000-0000-4000-8000-000000000001');
  const renewalFailure = connection('00000000-0000-4000-8000-000000000002', {
    connected_at: '2026-09-13T00:00:00Z',
    subscription_expires_at: '2026-01-01T00:00:00Z',
    last_renewal_error: 'renewal failed for this account',
  });
  async function readDrive(rows: ReturnType<typeof connection>[]) {
    integrationsList.mockResolvedValueOnce({ data: rows, error: null });
    const result = buildRes();
    await handleConnectorHealth(USER_ID, buildReq(), result.res);
    const body = result.body as { connectors: Array<Record<string, unknown>> };
    return body.connectors.find((row) => row.id === 'google_drive');
  }

  it.each([false, true])('keeps an older active renewal failure visible regardless of result order (%s)', async (reverse) => {
    const rows = [healthy, renewalFailure];
    if (reverse) rows.reverse();
    expect(await readDrive(rows)).toMatchObject({
      state: 'degraded', health_reason: 'subscription_expiry',
      account_label: renewalFailure.account_label,
      next_expires_at: renewalFailure.subscription_expires_at,
      last_error: 'renewal failed for this account',
    });
  });

  it('reports a stalled active account even when the newest account has a fresh cursor', async () => {
    driveRulesList.mockResolvedValue({ data: [{ id: 'rule', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
    const stalled = connection('00000000-0000-4000-8000-000000000003', {
      connected_at: '2026-09-13T00:00:00Z', last_token_advanced_at: '2026-01-01T00:00:00Z',
    });
    expect(await readDrive([stalled, healthy])).toMatchObject({
      state: 'degraded', health_reason: 'cursor_stale', account_label: stalled.account_label,
    });
  });

  it('uses renewal before cursor and fetch failures across different active accounts', async () => {
    driveRulesList.mockResolvedValue({ data: [{ id: 'rule', trigger_config: { type: 'drive_folder', folder_id: 'watched' } }], error: null });
    driveFetchJobFailuresList.mockResolvedValue({ data: [{ status: 'failed' }], error: null });
    const stalled = connection('00000000-0000-4000-8000-000000000003', {
      last_token_advanced_at: '2026-01-01T00:00:00Z',
    });
    expect(await readDrive([renewalFailure, stalled])).toMatchObject({
      health_reason: 'subscription_expiry', account_label: renewalFailure.account_label,
    });
  });

  it('keeps fetch failures visible when all active channels and cursors are healthy', async () => {
    driveFetchJobFailuresList.mockResolvedValue({ data: [{ status: 'failed' }], error: null });
    expect(await readDrive([healthy, connection('00000000-0000-4000-8000-000000000003')])).toMatchObject({
      state: 'degraded', health_reason: 'fetch_job_failures',
    });
  });

  it('ignores an old revoked account while an active healthy account remains', async () => {
    expect(await readDrive([healthy, connection('00000000-0000-4000-8000-000000000003', {
      revoked_at: '2026-09-14T00:00:00Z', last_renewal_error: 'retired account',
    })])).toMatchObject({ state: 'connected', health_reason: 'none', account_label: healthy.account_label });
  });

  it('reports disconnected when all accounts are revoked and picks the newest explanation', async () => {
    const recent = connection('00000000-0000-4000-8000-000000000003', { revoked_at: '2026-09-14T00:00:00Z' });
    const old = connection('00000000-0000-4000-8000-000000000004', {
      connected_at: '2026-01-01T00:00:00Z', revoked_at: '2026-01-02T00:00:00Z',
    });
    expect(await readDrive([recent, old])).toMatchObject({
      state: 'disconnected', health_reason: 'vendor_auth_revoked', account_label: recent.account_label,
    });
  });

  it('breaks equal-severity ties by newest connection, then stable row ID in either order', async () => {
    const sameTime = connection('00000000-0000-4000-8000-000000000001', { ...renewalFailure, id: healthy.id, account_label: 'tie winner' });
    for (const rows of [[renewalFailure, sameTime], [sameTime, renewalFailure]]) {
      expect(await readDrive(rows)).toMatchObject({ health_reason: 'subscription_expiry', account_label: 'tie winner' });
    }
    const newer = connection('00000000-0000-4000-8000-000000000005', { last_renewal_error: 'newer failure' });
    expect(await readDrive([newer, renewalFailure])).toMatchObject({ last_error: 'newer failure' });
  });

  it('places missing or invalid timestamps behind a valid timestamp without suppressing failure', async () => {
    const missing = connection('00000000-0000-4000-8000-000000000003', { connected_at: null, last_renewal_error: 'missing timestamp failure' });
    const invalid = connection('00000000-0000-4000-8000-000000000004', { connected_at: 'invalid', last_renewal_error: 'invalid timestamp failure' });
    expect(await readDrive([renewalFailure, invalid, missing])).toMatchObject({ last_error: 'renewal failed for this account' });
    expect(await readDrive([missing, healthy])).toMatchObject({ health_reason: 'subscription_expiry', last_error: 'missing timestamp failure' });
  });

  it('reads beyond a short PostgREST page so a later failing account remains visible', async () => {
    integrationsList
      .mockResolvedValueOnce({ data: [healthy], error: null })
      .mockResolvedValueOnce({ data: [renewalFailure], error: null });
    const result = buildRes();
    await handleConnectorHealth(USER_ID, buildReq(), result.res);
    const body = result.body as { connectors: Array<Record<string, unknown>> };
    expect(body.connectors.find((row) => row.id === 'google_drive')).toMatchObject({
      health_reason: 'subscription_expiry', last_error: renewalFailure.last_renewal_error,
    });
    expect(integrationsList.mock.calls.map((call) => call[0])).toEqual([0, 1, 2]);
    expect(integrationsList.mock.calls[0][2]).toBeInstanceOf(AbortSignal);
  });

  it('refuses partial health when a later page fails', async () => {
    integrationsList
      .mockResolvedValueOnce({ data: [healthy], error: null })
      .mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'private database detail' } });
    const result = buildRes();
    await handleConnectorHealth(USER_ID, buildReq(), result.res);
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toHaveProperty('connectors');
    expect(JSON.stringify(result.body)).not.toContain('private database detail');
  });

  it('fails closed when the bounded scan cannot reach an empty page', async () => {
    let page = 0;
    integrationsList.mockImplementation(() => Promise.resolve({
      data: [connection(`00000000-0000-4000-8000-${String(++page).padStart(12, '0')}`)], error: null,
    }));
    const result = buildRes();
    await handleConnectorHealth(USER_ID, buildReq(), result.res);
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toHaveProperty('connectors');
    expect(integrationsList.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it('does not flag stale cursors for enabled rules with no actual folder binding', async () => {
    driveRulesList.mockResolvedValue({ data: [{ id: 'empty-rule', trigger_config: {} }], error: null });
    const stale = connection('00000000-0000-4000-8000-000000000007', { last_token_advanced_at: '2026-01-01T00:00:00Z' });
    expect(await readDrive([stale])).toMatchObject({ state: 'connected', health_reason: 'none' });
  });

  it('finds a real folder binding after an empty rule on a later short page', async () => {
    driveRulesPages
      .mockResolvedValueOnce({ data: [{ trigger_config: {} }], error: null })
      .mockResolvedValueOnce({ data: [{ trigger_config: { drive_folders: [{ folder_id: 'watched' }] } }], error: null });
    const stale = connection('00000000-0000-4000-8000-000000000007', { last_token_advanced_at: '2026-01-01T00:00:00Z' });
    expect(await readDrive([stale])).toMatchObject({ state: 'degraded', health_reason: 'cursor_stale' });
    expect(driveRulesPages.mock.calls.map((call) => call[0])).toEqual([0, 1, 2]);
  });

  it('refuses healthy output when the watched-folder scan fails', async () => {
    driveRulesPages.mockResolvedValueOnce({ data: null, error: { code: '57014' } });
    integrationsList.mockResolvedValueOnce({ data: [healthy], error: null });
    const result = buildRes();
    await handleConnectorHealth(USER_ID, buildReq(), result.res);
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toHaveProperty('connectors');
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

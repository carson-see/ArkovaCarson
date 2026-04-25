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
  return {
    db: {
      from: (table: string) => {
        if (table === 'profiles') return profilesChain;
        if (table === 'org_integrations') return orgIntegrationsChain;
        if (table === 'connector_subscriptions') return subscriptionsChain;
        if (table === 'organization_rule_events') return eventsChain;
        if (table === 'organization_rule_executions') return executionsChain;
        throw new Error(`unexpected table: ${table}`);
      },
    },
  };
});

const { handleConnectorHealth, CONNECTOR_CATALOG } = await import('./connector-health.js');

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

    it('marks degraded when subscription is degraded — preserves vendor-side error', async () => {
      integrationsList.mockResolvedValueOnce({
        data: [{ provider: 'google_drive', account_label: 'Acme', connected_at: '2026-04-20T00:00:00Z', revoked_at: null }],
        error: null,
      });
      subsList.mockResolvedValueOnce({
        data: [
          {
            provider: 'google_drive',
            status: 'degraded',
            expires_at: '2026-04-25T00:00:00Z',
            last_renewed_at: '2026-04-23T00:00:00Z',
            last_renewal_error: 'invalid_grant — admin must reconnect',
          },
        ],
        error: null,
      });
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
});

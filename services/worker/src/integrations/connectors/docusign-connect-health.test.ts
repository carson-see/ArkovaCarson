import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config.js', () => ({ config: {} }));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import * as Sentry from '@sentry/node';
import { logger } from '../../utils/logger.js';
import { DocusignApiError, DocusignConfigError } from '../oauth/docusign.js';
import { REDACTED_BYTES_TOKEN } from '../../utils/byte-safety.js';
import {
  DOCUSIGN_CONNECTOR_ID,
  describeConnectFailure,
  markDocusignConnectorConnected,
  markDocusignConnectorDegraded,
  reportConnectProvisionFailure,
  settleConnectProvisioning,
} from './docusign-connect-health.js';

const NOW = new Date('2026-07-23T12:00:00Z');
const ORG_ID = '11111111-1111-4111-8111-111111111111';

function alertStateDb(upsertResult: { error: unknown } = { error: null }) {
  const upserts: Array<{ values: unknown; options: unknown }> = [];
  const db = {
    from: vi.fn((table: string) => {
      if (table !== 'connector_alert_state') throw new Error(`unexpected table ${table}`);
      return {
        upsert: vi.fn((values: unknown, options?: unknown) => {
          upserts.push({ values, options });
          return Promise.resolve(upsertResult);
        }),
      };
    }),
  };
  return { db, upserts };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('describeConnectFailure', () => {
  it('surfaces the DocuSign HTTP status and bounded detail (SCRUM-3014)', () => {
    const diagnostics = describeConnectFailure(
      new DocusignApiError(
        'DocuSign Connect create failed',
        400,
        '{"errorCode":"INVALID_REQUEST_PARAMETER","message":"connect not enabled"}',
      ),
    );

    expect(diagnostics).toEqual({
      message: 'DocuSign Connect create failed',
      status: 400,
      detail: '{"errorCode":"INVALID_REQUEST_PARAMETER","message":"connect not enabled"}',
    });
  });

  it('returns a null status/detail for non-API errors', () => {
    expect(describeConnectFailure(new DocusignConfigError('WORKER_PUBLIC_URL not set'))).toEqual({
      message: 'WORKER_PUBLIC_URL not set',
      status: null,
      detail: null,
    });
    expect(describeConnectFailure('boom')).toEqual({
      message: 'boom',
      status: null,
      detail: null,
    });
  });

  it('re-applies the byte guard to the detail (§1.6A defense in depth)', () => {
    const diagnostics = describeConnectFailure(
      new DocusignApiError('DocuSign Connect create failed', 500, '{"type":"Buffer","data":[1,2,3]}'),
    );

    expect(diagnostics.detail).toBe(REDACTED_BYTES_TOKEN);
  });
});

describe('reportConnectProvisionFailure', () => {
  it('logs the real DocuSign status + detail instead of a bare message', async () => {
    const { db } = alertStateDb();

    const diagnostics = await reportConnectProvisionFailure({
      db,
      error: new DocusignApiError('DocuSign Connect create failed', 403, '{"errorCode":"USER_LACKS_PERMISSIONS"}'),
      orgId: ORG_ID,
      integrationId: 'integration-1',
      flow: 'org',
      now: NOW,
    });

    expect(diagnostics.status).toBe(403);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [context] = vi.mocked(logger.error).mock.calls[0] as unknown as [
      Record<string, unknown>,
      string,
    ];
    expect(context).toMatchObject({
      orgId: ORG_ID,
      integrationId: 'integration-1',
      flow: 'org',
      docusignStatus: 403,
      docusignDetail: '{"errorCode":"USER_LACKS_PERMISSIONS"}',
    });
  });

  it('captures the failure in Sentry with connector/stage tags', async () => {
    const { db } = alertStateDb();
    const error = new DocusignApiError('DocuSign Connect create failed', 403, '{"errorCode":"USER_LACKS_PERMISSIONS"}');

    await reportConnectProvisionFailure({
      db,
      error,
      orgId: ORG_ID,
      integrationId: 'integration-1',
      flow: 'member',
      now: NOW,
    });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [captured, options] = vi.mocked(Sentry.captureException).mock.calls[0] as [
      unknown,
      { level?: string; tags?: Record<string, string>; extra?: Record<string, unknown> },
    ];
    expect(captured).toBe(error);
    expect(options.tags).toMatchObject({
      connector_id: DOCUSIGN_CONNECTOR_ID,
      stage: 'connect_provision',
      flow: 'member',
      docusign_status: '403',
    });
    expect(options.extra).toMatchObject({ org_id: ORG_ID, integration_id: 'integration-1' });
    // Never carry credentials into Sentry.
    expect(JSON.stringify(options.extra)).not.toMatch(/access_token|refresh_token|hmac/i);
  });

  it('marks the connector degraded so the failure is visible to the org', async () => {
    const { db, upserts } = alertStateDb();

    await reportConnectProvisionFailure({
      db,
      error: new Error('DocuSign Connect create failed'),
      orgId: ORG_ID,
      flow: 'org',
      now: NOW,
    });

    expect(upserts).toHaveLength(1);
    expect(upserts[0].values).toEqual({
      connector_id: DOCUSIGN_CONNECTOR_ID,
      org_id: ORG_ID,
      last_state: 'degraded',
      last_alerted_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    });
    expect(upserts[0].options).toEqual({ onConflict: 'connector_id,org_id' });
  });

  it('never throws when the alert-state write fails (must not break the OAuth callback)', async () => {
    const { db } = alertStateDb({ error: { message: 'RLS violation' } });

    await expect(
      reportConnectProvisionFailure({
        db,
        error: new Error('DocuSign Connect create failed'),
        orgId: ORG_ID,
        flow: 'org',
        now: NOW,
      }),
    ).resolves.toMatchObject({ message: 'DocuSign Connect create failed' });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('never throws when Sentry capture throws', async () => {
    const { db } = alertStateDb();
    vi.mocked(Sentry.captureException).mockImplementationOnce(() => {
      throw new Error('sentry transport down');
    });

    await expect(
      reportConnectProvisionFailure({
        db,
        error: new Error('DocuSign Connect create failed'),
        orgId: ORG_ID,
        flow: 'org',
        now: NOW,
      }),
    ).resolves.toBeTruthy();
  });
});

describe('markDocusignConnectorDegraded / markDocusignConnectorConnected', () => {
  it('clears the sticky degraded state on a successful (re)provision', async () => {
    const { db, upserts } = alertStateDb();

    await markDocusignConnectorConnected({ db, orgId: ORG_ID, now: NOW });

    expect(upserts[0].values).toEqual({
      connector_id: DOCUSIGN_CONNECTOR_ID,
      org_id: ORG_ID,
      last_state: 'connected',
      last_alerted_at: null,
      updated_at: NOW.toISOString(),
    });
  });

  it('swallows transport errors from the alert-state write', async () => {
    const db = {
      from: vi.fn(() => ({
        upsert: vi.fn(() => Promise.reject(new Error('connection reset'))),
      })),
    };

    await expect(markDocusignConnectorDegraded({ db, orgId: ORG_ID, now: NOW })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('settleConnectProvisioning', () => {
  it('clears the sticky degraded state and records the success event', async () => {
    const { db, upserts } = alertStateDb();
    const recordEvent = vi.fn().mockResolvedValue(undefined);

    await settleConnectProvisioning({
      db,
      provisioning: Promise.resolve({ connectId: 'connect-9', action: 'created' as const }),
      orgId: ORG_ID,
      integrationId: 'integration-1',
      flow: 'org',
      recordEvent,
      now: NOW,
    });

    expect(upserts).toHaveLength(1);
    expect(upserts[0].values).toMatchObject({ last_state: 'connected', last_alerted_at: null });
    expect(recordEvent).toHaveBeenCalledWith({
      eventType: 'connect_listener_provisioned',
      status: 'success',
      details: { connect_id: 'connect-9', action: 'created' },
    });
  });

  it('marks degraded and persists status + bounded detail on the failure event', async () => {
    const { db, upserts } = alertStateDb();
    const recordEvent = vi.fn().mockResolvedValue(undefined);

    await settleConnectProvisioning({
      db,
      provisioning: Promise.reject(
        new DocusignApiError(
          'DocuSign Connect create failed',
          403,
          '{"errorCode":"CONNECT_NOT_ENABLED"}',
        ),
      ),
      orgId: ORG_ID,
      integrationId: 'integration-1',
      flow: 'member',
      recordEvent,
      now: NOW,
    });

    expect(upserts).toHaveLength(1);
    expect(upserts[0].values).toMatchObject({ last_state: 'degraded' });
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith({
      eventType: 'member_connect_listener_failed',
      status: 'error',
      details: {
        error: 'DocuSign Connect create failed',
        docusign_status: 403,
        docusign_detail: '{"errorCode":"CONNECT_NOT_ENABLED"}',
      },
    });
  });

  // The OAuth callback has already redirected by the time this settles: nothing
  // here may reject, or the worker takes an unhandled rejection.
  it('never rejects when the failure-event write itself throws', async () => {
    const { db } = alertStateDb();
    const recordEvent = vi.fn().mockRejectedValue(new Error('integration_events insert failed'));

    await expect(
      settleConnectProvisioning({
        db,
        provisioning: Promise.reject(new Error('boom')),
        orgId: ORG_ID,
        flow: 'org',
          recordEvent,
        now: NOW,
      }),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalled();
  });

  // A throw from the SUCCESS-path event write must still land on the failure
  // path — the pre-refactor `.then(...).catch(...)` chain behaved this way.
  it('falls through to the degraded path when the success-event write throws', async () => {
    const { db, upserts } = alertStateDb();
    const recordEvent = vi
      .fn()
      .mockRejectedValueOnce(new Error('success event write failed'))
      .mockResolvedValue(undefined);

    await settleConnectProvisioning({
      db,
      provisioning: Promise.resolve({ connectId: 'connect-9', action: 'updated' as const }),
      orgId: ORG_ID,
      flow: 'org',
      recordEvent,
      now: NOW,
    });

    expect(upserts.map((u) => (u.values as { last_state: string }).last_state)).toEqual([
      'connected',
      'degraded',
    ]);
    expect(recordEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ eventType: 'connect_listener_failed', status: 'error' }),
    );
  });
});

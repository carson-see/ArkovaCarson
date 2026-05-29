import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  config: {},
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@sentry/node', () => ({
  captureMessage: vi.fn(),
}));

import {
  reconcileListenerDrift,
  detectDrift,
  type ListenerDriftDeps,
  type ExpectedConnectConfig,
  type ActualConnectListener,
} from './docusign-listener-drift.js';
import type { ActiveIntegration } from './docusign-reconciliation.js';

const MOCK_INTEGRATION: ActiveIntegration = {
  id: 'int-1',
  org_id: 'org-1',
  account_id: 'acct-1',
  base_uri: 'https://demo.docusign.net',
  token_secret_name: 'projects/p/secrets/s',
};

const EXPECTED: ExpectedConnectConfig = {
  urlToPublishTo: 'https://arkova-worker.example.com/webhooks/docusign',
  requiredEnvelopeEvents: ['Completed'],
  requiredEvents: ['envelope-completed'],
  hmacEnabled: true,
  payloadFormat: 'json',
};

/** A fully in-sync actual listener (matches EXPECTED on every checked axis). */
function inSyncListener(): ActualConnectListener {
  return {
    connectId: '99001',
    name: 'Arkova Connect',
    urlToPublishTo: 'https://arkova-worker.example.com/webhooks/docusign',
    allowEnvelopePublish: 'true',
    includeHMAC: 'true',
    envelopeEvents: ['Completed'],
    events: ['envelope-completed'],
    eventData: { format: 'json', version: 'restv2.1' },
  };
}

// ─────────────────────────── detectDrift (pure) ───────────────────────────

describe('detectDrift (pure comparison)', () => {
  it('returns no reasons when a matching, fully-configured listener exists', () => {
    const reasons = detectDrift([inSyncListener()], EXPECTED);
    expect(reasons).toEqual([]);
  });

  it('flags missing listener when no listener URL matches the expected URL', () => {
    const other = { ...inSyncListener(), urlToPublishTo: 'https://evil.example.com/hook' };
    const reasons = detectDrift([other], EXPECTED);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/no.*listener|missing/i);
  });

  it('flags missing listener when the account has zero Connect configurations', () => {
    const reasons = detectDrift([], EXPECTED);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/no.*listener|missing/i);
  });

  it('flags a disabled listener (allowEnvelopePublish !== "true")', () => {
    const disabled = { ...inSyncListener(), allowEnvelopePublish: 'false' };
    const reasons = detectDrift([disabled], EXPECTED);
    expect(reasons.some((r) => /disabled|publish/i.test(r))).toBe(true);
  });

  it('flags HMAC disabled (includeHMAC !== "true")', () => {
    const noHmac = { ...inSyncListener(), includeHMAC: 'false' };
    const reasons = detectDrift([noHmac], EXPECTED);
    expect(reasons.some((r) => /hmac/i.test(r))).toBe(true);
  });

  it('flags a missing required envelope event', () => {
    const missingEvent = { ...inSyncListener(), envelopeEvents: ['Sent'] };
    const reasons = detectDrift([missingEvent], EXPECTED);
    expect(reasons.some((r) => /event/i.test(r))).toBe(true);
  });

  it('flags a missing required event (envelope-completed)', () => {
    const missingEvent = { ...inSyncListener(), events: ['recipient-completed'] };
    const reasons = detectDrift([missingEvent], EXPECTED);
    expect(reasons.some((r) => /event/i.test(r))).toBe(true);
  });

  it('flags a wrong payload format', () => {
    const wrongFormat = {
      ...inSyncListener(),
      eventData: { format: 'xml', version: 'restv2.1' },
    };
    const reasons = detectDrift([wrongFormat], EXPECTED);
    expect(reasons.some((r) => /format|payload/i.test(r))).toBe(true);
  });

  it('accumulates multiple drift reasons on a badly-misconfigured listener', () => {
    const bad: ActualConnectListener = {
      connectId: '5',
      urlToPublishTo: 'https://arkova-worker.example.com/webhooks/docusign',
      allowEnvelopePublish: 'false',
      includeHMAC: 'false',
      envelopeEvents: [],
      events: [],
      eventData: { format: 'xml' },
    };
    const reasons = detectDrift([bad], EXPECTED);
    // disabled + hmac + missing envelope event + missing event + wrong format
    expect(reasons.length).toBeGreaterThanOrEqual(4);
  });

  it('selects the listener matching the expected URL among several', () => {
    const decoy = { ...inSyncListener(), connectId: '1', urlToPublishTo: 'https://other/hook', includeHMAC: 'false' };
    const match = inSyncListener();
    const reasons = detectDrift([decoy, match], EXPECTED);
    // The matching listener is healthy, so no drift despite the unhealthy decoy.
    expect(reasons).toEqual([]);
  });

  it('treats a missing envelopeEvents array as a missing-event drift, not a crash', () => {
    const noEvents: ActualConnectListener = {
      connectId: '7',
      urlToPublishTo: 'https://arkova-worker.example.com/webhooks/docusign',
      allowEnvelopePublish: 'true',
      includeHMAC: 'true',
      events: ['envelope-completed'],
      eventData: { format: 'json' },
      // envelopeEvents omitted
    };
    const reasons = detectDrift([noEvents], EXPECTED);
    expect(reasons.some((r) => /event/i.test(r))).toBe(true);
  });

  it('ignores the trailing-slash difference on the publish URL when matching', () => {
    const trailing = { ...inSyncListener(), urlToPublishTo: 'https://arkova-worker.example.com/webhooks/docusign/' };
    const reasons = detectDrift([trailing], EXPECTED);
    expect(reasons).toEqual([]);
  });
});

// ───────────────────── reconcileListenerDrift (orchestration) ─────────────────────

function makeMockDeps(overrides: Partial<ListenerDriftDeps> = {}): ListenerDriftDeps {
  return {
    listActiveIntegrations: vi.fn().mockResolvedValue([MOCK_INTEGRATION]),
    getAccessToken: vi.fn().mockResolvedValue('access-token-123'),
    getConnectConfigurations: vi.fn().mockResolvedValue([inSyncListener()]),
    getExpectedConfig: vi.fn().mockReturnValue(EXPECTED),
    reportDrift: vi.fn(),
    ...overrides,
  };
}

describe('reconcileListenerDrift (orchestration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports in_sync when the only integration matches expected config', async () => {
    const deps = makeMockDeps();
    const result = await reconcileListenerDrift(deps);

    expect(result.ok).toBe(true);
    expect(result.integrations_checked).toBe(1);
    expect(result.in_sync).toBe(1);
    expect(result.drift_detected).toBe(0);
    expect(result.drifts).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(deps.reportDrift).not.toHaveBeenCalled();
  });

  it('detects drift and fires a Sentry report when HMAC is disabled', async () => {
    const deps = makeMockDeps({
      getConnectConfigurations: vi
        .fn()
        .mockResolvedValue([{ ...inSyncListener(), includeHMAC: 'false' }]),
    });
    const result = await reconcileListenerDrift(deps);

    expect(result.ok).toBe(true);
    expect(result.drift_detected).toBe(1);
    expect(result.in_sync).toBe(0);
    expect(result.drifts).toHaveLength(1);
    expect(result.drifts[0].integration_id).toBe('int-1');
    expect(result.drifts[0].reasons.some((r) => /hmac/i.test(r))).toBe(true);
    expect(deps.reportDrift).toHaveBeenCalledOnce();
    expect(deps.reportDrift).toHaveBeenCalledWith(
      expect.objectContaining({
        integration_id: 'int-1',
        org_id: 'org-1',
        account_id: 'acct-1',
        reasons: expect.arrayContaining([expect.stringMatching(/hmac/i)]),
      }),
    );
  });

  it('handles multiple integrations: one drifts, one in sync', async () => {
    const int2: ActiveIntegration = { ...MOCK_INTEGRATION, id: 'int-2', org_id: 'org-2' };
    const deps = makeMockDeps({
      listActiveIntegrations: vi.fn().mockResolvedValue([MOCK_INTEGRATION, int2]),
      getConnectConfigurations: vi
        .fn()
        .mockResolvedValueOnce([inSyncListener()]) // int-1 healthy
        .mockResolvedValueOnce([{ ...inSyncListener(), allowEnvelopePublish: 'false' }]), // int-2 disabled
    });
    const result = await reconcileListenerDrift(deps);

    expect(result.integrations_checked).toBe(2);
    expect(result.in_sync).toBe(1);
    expect(result.drift_detected).toBe(1);
    expect(result.drifts[0].integration_id).toBe('int-2');
    expect(deps.reportDrift).toHaveBeenCalledOnce();
  });

  it('continues to the next integration when getConnectConfigurations throws', async () => {
    const int2: ActiveIntegration = { ...MOCK_INTEGRATION, id: 'int-2', org_id: 'org-2' };
    const deps = makeMockDeps({
      listActiveIntegrations: vi.fn().mockResolvedValue([MOCK_INTEGRATION, int2]),
      getConnectConfigurations: vi
        .fn()
        .mockRejectedValueOnce(new Error('connect_api_500'))
        .mockResolvedValueOnce([inSyncListener()]),
    });
    const result = await reconcileListenerDrift(deps);

    expect(result.ok).toBe(false);
    expect(result.integrations_checked).toBe(2);
    expect(result.in_sync).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].integration_id).toBe('int-1');
    expect(result.errors[0].error).toContain('connect_api');
  });

  it('continues to the next integration when token refresh fails', async () => {
    const int2: ActiveIntegration = { ...MOCK_INTEGRATION, id: 'int-2', org_id: 'org-2' };
    const deps = makeMockDeps({
      listActiveIntegrations: vi.fn().mockResolvedValue([MOCK_INTEGRATION, int2]),
      getAccessToken: vi
        .fn()
        .mockRejectedValueOnce(new Error('token_expired'))
        .mockResolvedValueOnce('token-2'),
    });
    const result = await reconcileListenerDrift(deps);

    expect(result.ok).toBe(false);
    expect(result.integrations_checked).toBe(2);
    expect(result.in_sync).toBe(1);
    expect(result.errors[0].integration_id).toBe('int-1');
    expect(result.errors[0].error).toContain('token_refresh');
  });

  it('returns early with error when listing integrations fails', async () => {
    const deps = makeMockDeps({
      listActiveIntegrations: vi.fn().mockRejectedValue(new Error('db_down')),
    });
    const result = await reconcileListenerDrift(deps);

    expect(result.ok).toBe(false);
    expect(result.integrations_checked).toBe(0);
    expect(result.errors[0].integration_id).toBe('*');
    expect(deps.reportDrift).not.toHaveBeenCalled();
  });

  it('returns a clean result when there are no active integrations', async () => {
    const deps = makeMockDeps({
      listActiveIntegrations: vi.fn().mockResolvedValue([]),
    });
    const result = await reconcileListenerDrift(deps);

    expect(result.ok).toBe(true);
    expect(result.integrations_checked).toBe(0);
    expect(result.drift_detected).toBe(0);
    expect(result.in_sync).toBe(0);
  });

  it('does not let a reportDrift (Sentry) failure abort the run', async () => {
    const int2: ActiveIntegration = { ...MOCK_INTEGRATION, id: 'int-2', org_id: 'org-2' };
    const deps = makeMockDeps({
      listActiveIntegrations: vi.fn().mockResolvedValue([MOCK_INTEGRATION, int2]),
      getConnectConfigurations: vi
        .fn()
        .mockResolvedValue([{ ...inSyncListener(), includeHMAC: 'false' }]),
      reportDrift: vi.fn().mockImplementation(() => {
        throw new Error('sentry_down');
      }),
    });
    const result = await reconcileListenerDrift(deps);

    // Both integrations drift; Sentry throwing must not crash the loop.
    expect(result.integrations_checked).toBe(2);
    expect(result.drift_detected).toBe(2);
    expect(result.ok).toBe(true);
  });

  it('fires one drift report per drifting integration', async () => {
    const int2: ActiveIntegration = { ...MOCK_INTEGRATION, id: 'int-2', org_id: 'org-2' };
    const deps = makeMockDeps({
      listActiveIntegrations: vi.fn().mockResolvedValue([MOCK_INTEGRATION, int2]),
      getConnectConfigurations: vi
        .fn()
        .mockResolvedValue([{ ...inSyncListener(), includeHMAC: 'false' }]),
    });
    await reconcileListenerDrift(deps);

    expect(deps.reportDrift).toHaveBeenCalledTimes(2);
  });

  it('calls getAccessToken with the integration and uses the token + base_uri for the Connect fetch', async () => {
    const deps = makeMockDeps();
    await reconcileListenerDrift(deps);

    expect(deps.getAccessToken).toHaveBeenCalledWith(MOCK_INTEGRATION);
    expect(deps.getConnectConfigurations).toHaveBeenCalledWith({
      baseUri: 'https://demo.docusign.net',
      accountId: 'acct-1',
      accessToken: 'access-token-123',
    });
  });
});

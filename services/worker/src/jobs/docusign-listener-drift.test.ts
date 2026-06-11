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
  payloadVersion: 'restv2.1',
};

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

describe('detectDrift', () => {
  it('returns no reasons when a matching listener has Arkova config', () => {
    expect(detectDrift([inSyncListener()], EXPECTED)).toEqual([]);
  });

  it('flags a missing listener for the expected Arkova webhook URL', () => {
    const other = { ...inSyncListener(), urlToPublishTo: 'https://other.example.com/hook' };

    const reasons = detectDrift([other], EXPECTED);

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/no connect listener/i);
  });

  it('flags disabled HMAC, missing events, and payload version drift', () => {
    const drifted: ActualConnectListener = {
      ...inSyncListener(),
      includeHMAC: 'false',
      envelopeEvents: [],
      events: [],
      eventData: { format: 'json', version: 'legacy' },
    };

    const reasons = detectDrift([drifted], EXPECTED);

    expect(reasons.some((reason) => /hmac/i.test(reason))).toBe(true);
    expect(reasons.some((reason) => /Completed/.test(reason))).toBe(true);
    expect(reasons.some((reason) => /envelope-completed/.test(reason))).toBe(true);
    expect(reasons.some((reason) => /version/i.test(reason))).toBe(true);
  });

  it('ignores trailing slash differences when matching publish URLs', () => {
    const trailingSlash = {
      ...inSyncListener(),
      urlToPublishTo: 'https://arkova-worker.example.com/webhooks/docusign/',
    };

    expect(detectDrift([trailingSlash], EXPECTED)).toEqual([]);
  });
});

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

describe('reconcileListenerDrift', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports in_sync when the current listener matches expected config', async () => {
    const deps = makeMockDeps();

    const result = await reconcileListenerDrift(deps);

    expect(result.ok).toBe(true);
    expect(result.integrations_checked).toBe(1);
    expect(result.in_sync).toBe(1);
    expect(result.drift_detected).toBe(0);
    expect(deps.reportDrift).not.toHaveBeenCalled();
  });

  it('reports drift without failing the whole run', async () => {
    const deps = makeMockDeps({
      getConnectConfigurations: vi.fn().mockResolvedValue([
        { ...inSyncListener(), includeHMAC: 'false' },
      ]),
    });

    const result = await reconcileListenerDrift(deps);

    expect(result.ok).toBe(true);
    expect(result.drift_detected).toBe(1);
    expect(result.in_sync).toBe(0);
    expect(result.drifts[0]).toEqual({
      integration_id: 'int-1',
      reasons: expect.arrayContaining([expect.stringMatching(/hmac/i)]),
    });
    expect(deps.reportDrift).toHaveBeenCalledWith(
      expect.objectContaining({
        integration_id: 'int-1',
        org_id: 'org-1',
        account_id: 'acct-1',
      }),
    );
  });

  it('continues to the next integration when the Connect API fails', async () => {
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
    expect(result.errors[0]).toEqual({
      integration_id: 'int-1',
      error: expect.stringContaining('connect_api'),
    });
  });
});

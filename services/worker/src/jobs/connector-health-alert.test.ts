import { describe, it, expect, vi } from 'vitest';

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

// Same convention as docusign-connect-failures.test.ts: stub the Sentry
// transport so the suite is hermetic (no network, no SDK init side effects).
vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import {
  decideConnectorAlert,
  runConnectorHealthCheck,
  type ConnectorHealthSnapshot,
  type ConnectorAlertState,
} from './connector-health-alert.js';

const NOW = new Date('2026-05-27T12:00:00Z');

function snap(overrides: Partial<ConnectorHealthSnapshot> = {}): ConnectorHealthSnapshot {
  return {
    connector_id: 'docusign',
    org_id: 'org-1',
    state: 'connected',
    health_reason: 'none',
    last_error: null,
    ...overrides,
  };
}

function state(overrides: Partial<ConnectorAlertState> = {}): ConnectorAlertState {
  return {
    connector_id: 'docusign',
    org_id: 'org-1',
    last_state: 'connected',
    last_alerted_at: null,
    ...overrides,
  };
}

describe('decideConnectorAlert', () => {
  it('fires when connector degrades from connected to degraded', () => {
    const decision = decideConnectorAlert(
      snap({ state: 'degraded', health_reason: 'processing_failure', last_error: 'timeout' }),
      state({ last_state: 'connected' }),
      NOW,
    );

    expect(decision.should_fire).toBe(true);
    expect(decision.reason).toContain('degraded');
    expect(decision.severity).toBe('warning');
  });

  it('fires when connector disconnects from connected', () => {
    const decision = decideConnectorAlert(
      snap({ state: 'disconnected', health_reason: 'vendor_auth_revoked' }),
      state({ last_state: 'connected' }),
      NOW,
    );

    expect(decision.should_fire).toBe(true);
    expect(decision.severity).toBe('error');
  });

  it('does not fire when connector stays connected', () => {
    const decision = decideConnectorAlert(
      snap({ state: 'connected' }),
      state({ last_state: 'connected' }),
      NOW,
    );

    expect(decision.should_fire).toBe(false);
  });

  it('does not fire when demo connector degrades', () => {
    const decision = decideConnectorAlert(
      snap({ connector_id: 'demo', state: 'degraded' }),
      state({ connector_id: 'demo', last_state: 'connected' }),
      NOW,
    );

    expect(decision.should_fire).toBe(false);
  });

  it('re-fires after 1 hour if connector remains degraded', () => {
    const oneHourAgo = new Date(NOW.getTime() - 61 * 60 * 1000).toISOString();
    const decision = decideConnectorAlert(
      snap({ state: 'degraded', health_reason: 'subscription_expiry' }),
      state({ last_state: 'degraded', last_alerted_at: oneHourAgo }),
      NOW,
    );

    expect(decision.should_fire).toBe(true);
    expect(decision.reason).toContain('still degraded');
  });

  it('does not re-fire within 1 hour cooldown', () => {
    const thirtyMinAgo = new Date(NOW.getTime() - 30 * 60 * 1000).toISOString();
    const decision = decideConnectorAlert(
      snap({ state: 'degraded', health_reason: 'subscription_expiry' }),
      state({ last_state: 'degraded', last_alerted_at: thirtyMinAgo }),
      NOW,
    );

    expect(decision.should_fire).toBe(false);
  });

  it('fires recovery when connector goes from degraded to connected', () => {
    const decision = decideConnectorAlert(
      snap({ state: 'connected', health_reason: 'none' }),
      state({ last_state: 'degraded', last_alerted_at: '2026-05-27T11:00:00Z' }),
      NOW,
    );

    expect(decision.should_fire).toBe(true);
    expect(decision.severity).toBe('info');
    expect(decision.reason).toContain('recovered');
  });

  it('returns null state for new connectors with no prior alert state', () => {
    const decision = decideConnectorAlert(
      snap({ state: 'degraded', health_reason: 'processing_failure' }),
      null,
      NOW,
    );

    expect(decision.should_fire).toBe(true);
    expect(decision.reason).toContain('degraded');
  });
});

function mockDb(overrides: Record<string, { data?: unknown; error?: unknown }> = {}) {
  const defaults: Record<string, { data: unknown; error: unknown }> = {
    org_integrations: { data: [], error: null },
    connector_alert_state: { data: [], error: null },
  };
  const tables = { ...defaults, ...overrides };
  return {
    from(table: string) {
      const t = tables[table] ?? { data: [], error: null };
      return {
        select: () => Promise.resolve(t),
        upsert: () => Promise.resolve(t),
      };
    },
  };
}

describe('runConnectorHealthCheck', () => {
  it('throws when alert state read fails (fail-close)', async () => {
    const db = mockDb({
      org_integrations: {
        data: [{ org_id: 'org-1', provider: 'docusign', revoked_at: null }],
        error: null,
      },
      connector_alert_state: {
        data: null,
        error: { message: 'permission denied for table connector_alert_state' },
      },
    });

    await expect(runConnectorHealthCheck(db)).rejects.toThrow(/alert state/i);
  });

  it('returns ok:false when alert state upsert fails', async () => {
    const upsertError = { message: 'RLS violation' };
    const db = {
      from(table: string) {
        if (table === 'org_integrations') {
          return {
            select: () => Promise.resolve({
              data: [{ org_id: 'org-1', provider: 'docusign', revoked_at: null }],
              error: null,
            }),
          };
        }
        if (table === 'connector_alert_state') {
          return {
            select: () => Promise.resolve({ data: [], error: null }),
            upsert: () => Promise.resolve({ error: upsertError }),
          };
        }
        return { select: () => Promise.resolve({ data: [], error: null }) };
      },
    };

    const result = await runConnectorHealthCheck(db);
    expect(result.ok).toBe(false);
  });

  it('keeps a degraded connector degraded when revoked_at alone says healthy (SCRUM-3014)', async () => {
    // `degraded` is written by the DocuSign Connect-provisioning path from a
    // signal this cron cannot observe. Without stickiness the cron would flip
    // the row back to `connected` within 15 min and fire a FALSE recovery.
    const upserted: Array<Record<string, unknown>> = [];
    const db = {
      from(table: string) {
        if (table === 'org_integrations') {
          return {
            select: () => Promise.resolve({
              data: [{ org_id: 'org-1', provider: 'docusign', revoked_at: null }],
              error: null,
            }),
          };
        }
        return {
          select: () => Promise.resolve({
            data: [{
              connector_id: 'docusign',
              org_id: 'org-1',
              last_state: 'degraded',
              last_alerted_at: new Date().toISOString(),
            }],
            error: null,
          }),
          upsert: (rows: Array<Record<string, unknown>>) => {
            upserted.push(...rows);
            return Promise.resolve({ error: null });
          },
        };
      },
    };

    const result = await runConnectorHealthCheck(db);

    expect(result.ok).toBe(true);
    expect(upserted).toHaveLength(1);
    expect(upserted[0]).toMatchObject({ connector_id: 'docusign', org_id: 'org-1', last_state: 'degraded' });
    // Still inside the 1h cooldown seeded by the provisioning failure.
    expect(result.alertsFired).toBe(0);
  });

  it('returns to connected once the connector path clears the degraded state', async () => {
    const upserted: Array<Record<string, unknown>> = [];
    const db = {
      from(table: string) {
        if (table === 'org_integrations') {
          return {
            select: () => Promise.resolve({
              data: [{ org_id: 'org-1', provider: 'docusign', revoked_at: null }],
              error: null,
            }),
          };
        }
        return {
          select: () => Promise.resolve({
            data: [{
              connector_id: 'docusign',
              org_id: 'org-1',
              last_state: 'connected',
              last_alerted_at: null,
            }],
            error: null,
          }),
          upsert: (rows: Array<Record<string, unknown>>) => {
            upserted.push(...rows);
            return Promise.resolve({ error: null });
          },
        };
      },
    };

    const result = await runConnectorHealthCheck(db);

    expect(result.ok).toBe(true);
    expect(upserted[0]).toMatchObject({ last_state: 'connected' });
    expect(result.alertsFired).toBe(0);
  });
});

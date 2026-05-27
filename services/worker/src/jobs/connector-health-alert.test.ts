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

import {
  decideConnectorAlert,
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

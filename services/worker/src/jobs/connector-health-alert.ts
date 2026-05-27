/**
 * SCRUM-2041 — Connector health alerting (SOC 2 CC7.1).
 *
 * Pure decision function: compares current connector health snapshot against
 * prior alert state, decides whether to fire a Sentry event. Same pattern
 * as treasury-alert.ts (SCRUM-1013).
 *
 * Alert triggers:
 *   - State degradation: connected → degraded/disconnected
 *   - Re-fire: still degraded/disconnected after 1h cooldown
 *   - Recovery: degraded/disconnected → connected (info-level)
 *
 * Demo connectors are excluded (their state is synthetic).
 */

import * as Sentry from '@sentry/node';
import { logger } from '../utils/logger.js';

export const RE_FIRE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

const DEMO_CONNECTORS = new Set(['demo']);

export type ConnectorState = 'connected' | 'degraded' | 'disconnected';
export type HealthReason =
  | 'vendor_auth_revoked'
  | 'subscription_expiry'
  | 'processing_failure'
  | 'none';
export type AlertSeverity = 'info' | 'warning' | 'error';

export interface ConnectorHealthSnapshot {
  connector_id: string;
  org_id: string;
  state: ConnectorState;
  health_reason: HealthReason | null;
  last_error: string | null;
}

export interface ConnectorAlertState {
  connector_id: string;
  org_id: string;
  last_state: ConnectorState;
  last_alerted_at: string | null;
}

export interface ConnectorAlertDecision {
  should_fire: boolean;
  reason: string;
  severity: AlertSeverity;
  connector_id: string;
  org_id: string;
  new_state: ConnectorState;
  health_reason: HealthReason | null;
  last_error: string | null;
}

const STATE_SEVERITY: Record<ConnectorState, AlertSeverity> = {
  disconnected: 'error',
  degraded: 'warning',
  connected: 'info',
};

function isUnhealthy(state: ConnectorState): boolean {
  return state === 'degraded' || state === 'disconnected';
}

export function decideConnectorAlert(
  current: ConnectorHealthSnapshot,
  prior: ConnectorAlertState | null,
  now: Date = new Date(),
): ConnectorAlertDecision {
  const base = {
    connector_id: current.connector_id,
    org_id: current.org_id,
    new_state: current.state,
    health_reason: current.health_reason,
    last_error: current.last_error,
  };

  if (DEMO_CONNECTORS.has(current.connector_id)) {
    return { ...base, should_fire: false, reason: 'Demo connector excluded', severity: 'info' };
  }

  const previousState = prior?.last_state ?? 'connected';
  const wasUnhealthy = isUnhealthy(previousState);
  const isNowUnhealthy = isUnhealthy(current.state);

  // Recovery: was unhealthy → now connected
  if (wasUnhealthy && !isNowUnhealthy) {
    return {
      ...base,
      should_fire: true,
      reason: `Connector ${current.connector_id} recovered: ${previousState} → connected`,
      severity: 'info',
    };
  }

  // Fresh degradation: was healthy → now unhealthy
  if (!wasUnhealthy && isNowUnhealthy) {
    return {
      ...base,
      should_fire: true,
      reason: `Connector ${current.connector_id} ${current.state}: ${current.health_reason ?? 'unknown'}`,
      severity: STATE_SEVERITY[current.state],
    };
  }

  // Still unhealthy: check re-fire window
  if (isNowUnhealthy && wasUnhealthy) {
    const lastAlertAgo = prior?.last_alerted_at
      ? now.getTime() - new Date(prior.last_alerted_at).getTime()
      : Infinity;

    if (lastAlertAgo > RE_FIRE_WINDOW_MS) {
      return {
        ...base,
        should_fire: true,
        reason: `Connector ${current.connector_id} still ${current.state}: ${current.health_reason ?? 'unknown'}`,
        severity: STATE_SEVERITY[current.state],
      };
    }

    return {
      ...base,
      should_fire: false,
      reason: `Within ${Math.round(RE_FIRE_WINDOW_MS / 60000)}min cooldown`,
      severity: STATE_SEVERITY[current.state],
    };
  }

  // Healthy → healthy: no action
  return { ...base, should_fire: false, reason: 'No state change', severity: 'info' };
}

export interface ConnectorAlertDispatcher {
  captureAlert(decision: ConnectorAlertDecision): void;
}

export function createSentryConnectorAlertDispatcher(): ConnectorAlertDispatcher {
  return {
    captureAlert(decision: ConnectorAlertDecision) {
      try {
        Sentry.captureMessage(decision.reason, {
          level: decision.severity,
          tags: {
            connector_id: decision.connector_id,
            connector_state: decision.new_state,
            health_reason: decision.health_reason ?? 'none',
          },
          extra: {
            org_id: decision.org_id,
            last_error: decision.last_error ? '[redacted]' : null,
          },
        });
      } catch (err) {
        logger.error({ error: err, decision: decision.reason }, 'Failed to dispatch connector alert to Sentry');
      }
    },
  };
}

// ─── Cron entry point ───

interface ConnectorHealthCheckResult {
  ok: boolean;
  checked: number;
  alertsFired: number;
}

// Supabase client — typed interface impractical due to deeply generic SupabaseClient types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseDb = { from(table: string): any };

export async function runConnectorHealthCheck(db: SupabaseDb): Promise<ConnectorHealthCheckResult> {
  const now = new Date();
  const dispatcher = createSentryConnectorAlertDispatcher();

  const { data: integrations, error: intError } = await db
    .from('org_integrations')
    .select('org_id, provider, revoked_at');

  if (intError) {
    logger.error({ error: intError }, 'Connector health check: failed to load integrations');
    throw new Error('Failed to load integrations');
  }

  const { data: priorStates } = await db
    .from('connector_alert_state')
    .select('connector_id, org_id, last_state, last_alerted_at');

  const stateMap = new Map<string, ConnectorAlertState>();
  for (const s of (priorStates ?? []) as ConnectorAlertState[]) {
    stateMap.set(`${s.connector_id}:${s.org_id}`, s);
  }

  const snapshots: ConnectorHealthSnapshot[] = (integrations ?? []).map(
    (row: { org_id: string; provider: string; revoked_at: string | null }) => ({
      connector_id: row.provider,
      org_id: row.org_id,
      state: row.revoked_at ? 'disconnected' as const : 'connected' as const,
      health_reason: row.revoked_at ? 'vendor_auth_revoked' as const : 'none' as const,
      last_error: null,
    }),
  );

  let alertsFired = 0;
  const upserts: Array<{ connector_id: string; org_id: string; last_state: string; last_alerted_at: string | null }> = [];

  for (const snap of snapshots) {
    const key = `${snap.connector_id}:${snap.org_id}`;
    const prior = stateMap.get(key) ?? null;
    const decision = decideConnectorAlert(snap, prior, now);

    if (decision.should_fire) {
      dispatcher.captureAlert(decision);
      alertsFired++;
      upserts.push({
        connector_id: snap.connector_id,
        org_id: snap.org_id,
        last_state: snap.state,
        last_alerted_at: now.toISOString(),
      });
    } else {
      upserts.push({
        connector_id: snap.connector_id,
        org_id: snap.org_id,
        last_state: snap.state,
        last_alerted_at: prior?.last_alerted_at ?? null,
      });
    }
  }

  if (upserts.length > 0) {
    const { error: upsertError } = await db
      .from('connector_alert_state')
      .upsert(upserts.map(u => ({ ...u, updated_at: now.toISOString() })), {
        onConflict: 'connector_id,org_id',
      });
    if (upsertError) {
      logger.error({ error: upsertError }, 'Connector health check: failed to persist alert state');
    }
  }

  return { ok: true, checked: snapshots.length, alertsFired };
}

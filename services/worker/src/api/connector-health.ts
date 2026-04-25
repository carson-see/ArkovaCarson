/**
 * Connector Health Dashboard (SCRUM-1146)
 *
 * Read-side for the connector setup wizard. Returns one row per connector in
 * the catalog with:
 *   - state: connected / degraded / disconnected
 *   - kind: live / demo / gated
 *   - last_event_at: most recent rule event captured from this connector
 *   - last_renewal_at / next_expires_at: from connector_subscriptions
 *   - last_error / health_reason: distinguishes vendor_auth_revoked,
 *     subscription_expiry, processing_failure, none
 *
 * Org scoping is enforced via `.eq('org_id', orgId)` on every query. The
 * caller's `org_id` is never echoed back per CLAUDE.md §6.
 */
import type { Request, Response } from 'express';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { getCallerOrgId } from './_org-auth.js';

export type ConnectorKind = 'live' | 'demo' | 'gated';
export type ConnectorState = 'connected' | 'degraded' | 'disconnected';
export type HealthReason =
  | 'vendor_auth_revoked'
  | 'subscription_expiry'
  | 'processing_failure'
  | 'none';

export interface ConnectorCatalogEntry {
  id: string;
  label: string;
  kind: ConnectorKind;
  // The set of `vendor` strings the worker emits on `organization_rule_events`
  // for this connector. Microsoft Graph catalog entry covers BOTH SharePoint
  // and OneDrive (they share one OAuth integration but emit two distinct
  // vendor strings — see `adapters.ts:adaptMicrosoftGraph`).
  vendor_event_sources: readonly string[];
  description: string;
}

export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  {
    id: 'docusign',
    label: 'DocuSign',
    kind: 'live',
    vendor_event_sources: ['docusign'],
    description: 'Receive completed envelopes via DocuSign Connect.',
  },
  {
    id: 'adobe_sign',
    label: 'Adobe Sign',
    kind: 'live',
    vendor_event_sources: ['adobe_sign'],
    description: 'Receive completed agreements via Adobe Sign webhooks.',
  },
  {
    id: 'google_drive',
    label: 'Google Drive',
    kind: 'live',
    vendor_event_sources: ['google_drive'],
    description: 'Watch folders for added or modified files.',
  },
  {
    id: 'microsoft_graph',
    label: 'Microsoft 365 (SharePoint / OneDrive)',
    kind: 'live',
    vendor_event_sources: ['sharepoint', 'onedrive'],
    description: 'Watch SharePoint sites and OneDrive folders for changes.',
  },
  {
    id: 'demo',
    label: 'Demo events',
    kind: 'demo',
    vendor_event_sources: [],
    description: 'Inject sample events end-to-end without external accounts.',
  },
  {
    id: 'veremark',
    label: 'Veremark',
    kind: 'gated',
    vendor_event_sources: ['veremark'],
    description: 'Background-check connector — vendor agreement required.',
  },
  {
    id: 'checkr',
    label: 'Checkr',
    kind: 'gated',
    vendor_event_sources: ['checkr'],
    description: 'Background-check connector — vendor agreement required.',
  },
];

interface IntegrationRow {
  provider: string;
  account_label: string | null;
  connected_at: string | null;
  revoked_at: string | null;
}

interface SubscriptionRow {
  provider: 'google_drive' | 'microsoft_graph';
  status: string;
  expires_at: string;
  last_renewed_at: string | null;
  last_renewal_error: string | null;
}

interface RuleEventRow {
  vendor: string | null;
  created_at: string;
}

interface FailedExecutionRow {
  trigger_event_id: string;
  completed_at: string | null;
  error: string | null;
}

interface PerVendorFailure {
  vendor: string;
  error: string | null;
  completed_at: string | null;
}

interface ConnectorHealth {
  id: string;
  label: string;
  kind: ConnectorKind;
  state: ConnectorState;
  health_reason: HealthReason | null;
  account_label: string | null;
  last_event_at: string | null;
  last_renewal_at: string | null;
  next_expires_at: string | null;
  last_error: string | null;
}

async function safeFetch<T>(promise: Promise<{ data: T | null; error: unknown }>, fallback: T): Promise<T> {
  try {
    const { data, error } = await promise;
    if (error) {
      logger.warn({ error }, 'connector health: query failed — using fallback');
      return fallback;
    }
    return data ?? fallback;
  } catch (err) {
    logger.warn({ error: err }, 'connector health: query threw — using fallback');
    return fallback;
  }
}

async function loadFailuresByVendor(
  orgId: string,
  failedExecutions: FailedExecutionRow[],
): Promise<Map<string, PerVendorFailure>> {
  const out = new Map<string, PerVendorFailure>();
  if (failedExecutions.length === 0) return out;
  const triggerEventIds = [...new Set(failedExecutions.map((e) => e.trigger_event_id))];
  if (triggerEventIds.length === 0) return out;
  const events = await safeFetch<Array<{ id: string; vendor: string | null }>>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any)
      .from('organization_rule_events')
      .select('id, vendor')
      .eq('org_id', orgId)
      .in('id', triggerEventIds),
    [],
  );
  const vendorById = new Map<string, string | null>();
  for (const e of events) vendorById.set(e.id, e.vendor);
  for (const exec of failedExecutions) {
    const vendor = vendorById.get(exec.trigger_event_id);
    if (!vendor) continue;
    if (!out.has(vendor)) {
      out.set(vendor, { vendor, error: exec.error, completed_at: exec.completed_at });
    }
  }
  return out;
}

function classify(
  entry: ConnectorCatalogEntry,
  integration: IntegrationRow | undefined,
  subscription: SubscriptionRow | undefined,
  lastFailedExec: PerVendorFailure | undefined,
): { state: ConnectorState; reason: HealthReason | null; lastError: string | null } {
  // Demo connector is always connected — its lifecycle is the dispatcher itself.
  if (entry.kind === 'demo') {
    return { state: 'connected', reason: null, lastError: null };
  }
  // Gated (vendor agreement pending) connectors stay disconnected with a
  // null reason so the wizard can render a "request access" CTA.
  if (entry.kind === 'gated' && !integration) {
    return { state: 'disconnected', reason: null, lastError: null };
  }
  if (!integration) {
    return { state: 'disconnected', reason: null, lastError: null };
  }
  if (integration.revoked_at) {
    return { state: 'disconnected', reason: 'vendor_auth_revoked', lastError: null };
  }
  if (subscription?.status === 'degraded') {
    return {
      state: 'degraded',
      reason: 'subscription_expiry',
      lastError: subscription.last_renewal_error ?? null,
    };
  }
  if (lastFailedExec) {
    return {
      state: 'degraded',
      reason: 'processing_failure',
      lastError: lastFailedExec.error,
    };
  }
  return { state: 'connected', reason: 'none', lastError: null };
}

export async function handleConnectorHealth(
  userId: string,
  _req: Request,
  res: Response,
): Promise<void> {
  const orgId = await getCallerOrgId(userId);
  if (!orgId) {
    res.status(403).json({ error: { code: 'forbidden', message: 'No organization on profile' } });
    return;
  }

  const [integrations, subscriptions, recentEvents, recentExecutions] = await Promise.all([
    safeFetch<IntegrationRow[]>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any)
        .from('org_integrations')
        .select('provider, account_label, connected_at, revoked_at')
        .eq('org_id', orgId),
      [],
    ),
    safeFetch<SubscriptionRow[]>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any)
        .from('connector_subscriptions')
        .select('provider, status, expires_at, last_renewed_at, last_renewal_error')
        .eq('org_id', orgId),
      [],
    ),
    safeFetch<RuleEventRow[]>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any)
        .from('organization_rule_events')
        .select('vendor, created_at')
        .eq('org_id', orgId)
        .order('created_at', { ascending: false })
        .limit(50),
      [],
    ),
    safeFetch<FailedExecutionRow[]>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any)
        .from('organization_rule_executions')
        .select('trigger_event_id, completed_at, error')
        .eq('org_id', orgId)
        .in('status', ['FAILED', 'DLQ'])
        .order('completed_at', { ascending: false })
        .limit(50),
      [],
    ),
  ]);

  const integrationByProvider = new Map<string, IntegrationRow>();
  for (const row of integrations) integrationByProvider.set(row.provider, row);

  const subscriptionByProvider = new Map<string, SubscriptionRow>();
  for (const row of subscriptions) subscriptionByProvider.set(row.provider, row);

  const lastEventByVendor = new Map<string, string>();
  for (const ev of recentEvents) {
    if (!ev.vendor) continue;
    if (!lastEventByVendor.has(ev.vendor)) lastEventByVendor.set(ev.vendor, ev.created_at);
  }

  // Failures are correlated to a vendor by joining failed executions to
  // the originating rule event (no FK between executions.trigger_event_id
  // text and rule_events.id uuid; we resolve in JS). Without this join we
  // could mis-attribute one connector's failures to every connector.
  const failureByVendor = await loadFailuresByVendor(orgId, recentExecutions);

  const connectors: ConnectorHealth[] = CONNECTOR_CATALOG.map((entry) => {
    const integration = integrationByProvider.get(entry.id);
    const subscription = subscriptionByProvider.get(entry.id as SubscriptionRow['provider']);
    const vendorFailure = entry.vendor_event_sources
      .map((v) => failureByVendor.get(v))
      .find((f): f is PerVendorFailure => f !== undefined);
    const lastFailed = integration ? vendorFailure : undefined;
    const { state, reason, lastError } = classify(entry, integration, subscription, lastFailed);
    const last_event_at = entry.vendor_event_sources
      .map((v) => lastEventByVendor.get(v))
      .filter((v): v is string => typeof v === 'string')
      .sort()
      .at(-1) ?? null;
    return {
      id: entry.id,
      label: entry.label,
      kind: entry.kind,
      state,
      health_reason: reason,
      account_label: integration?.account_label ?? null,
      last_event_at,
      last_renewal_at: subscription?.last_renewed_at ?? null,
      next_expires_at: subscription?.expires_at ?? null,
      last_error: lastError,
    };
  });

  res.setHeader?.('Cache-Control', 'no-store, max-age=0');
  res.status(200).json({
    connectors,
    generated_at: new Date().toISOString(),
  });
}

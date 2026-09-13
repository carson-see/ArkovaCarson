/**
 * Webhook Event Catalog (WH-01 / SCRUM-2396)
 *
 * Read-only catalog of every event type an endpoint can subscribe to, with
 * per-event payload fields and the redaction rules.
 *
 * Honesty rules (§1.13 R-7 launch-claims discipline):
 *  - `live: true` is asserted ONLY for events with a real, reachable emit
 *    point in the worker (verified against services/worker/src/webhooks/
 *    agents.md producer table + the dispatch sites themselves): the five
 *    anchor.* events, compliance.document_expiring, and — since SCRUM-1798
 *    Phase 2a / SCRUM-1800 — credential.issued (credential-sources.ts) and
 *    credential.status_changed (anchor-revoke.ts, anchor-lineage.ts,
 *    check-confirmations.ts, chain-maintenance.ts; gated only on the anchor
 *    carrying a credential_type).
 *  - credential.verified is wired (verify.ts + oracle.ts) but BOTH sites sit
 *    behind ENABLE_CREDENTIAL_VERIFIED_WEBHOOK, default false and unset in
 *    prod — it stays "Not yet active" until that flag is verified on in prod
 *    (prod-state-check skill), because the badge describes deliveries, not
 *    code. The honesty rule cuts both ways: never claim an event a
 *    subscriber won't receive, and never tell a subscriber an event they ARE
 *    receiving is inactive.
 *  - `fields` lists mirror the worker's strict Zod payload schemas
 *    (payload-schemas.ts). Update BOTH when a schema changes — the catalog
 *    test drift-guards against AVAILABLE_EVENTS, and payload-schemas.test.ts
 *    locks the wire contract.
 */

import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { WEBHOOK_LABELS, WEBHOOK_EVENT_DESCRIPTIONS } from '@/lib/copy';
import { AVAILABLE_EVENTS } from './WebhookSettings';

// CTO ruling Z5 (2026-09-12): the liveness table moved to
// ./webhookEventLiveness so the subscription picker in WebhookSettings.tsx can
// read the SAME flags. It used to live here, which meant the picker's
// "not yet active" suffix was hand-maintained separately and could disagree
// with this badge — and did.
export type { WebhookCatalogEntry } from './webhookEventLiveness';
import { CATALOG_DATA, type WebhookCatalogEntry } from './webhookEventLiveness';

/**
 * Catalog entries in AVAILABLE_EVENTS order so this component and the
 * subscription picker can never disagree on the event set (test-enforced).
 */
export const WEBHOOK_EVENT_CATALOG: WebhookCatalogEntry[] = AVAILABLE_EVENTS.map((event) => ({
  id: event.id,
  live: CATALOG_DATA[event.id]?.live ?? false,
  fields: CATALOG_DATA[event.id]?.fields ?? [],
}));

export function WebhookEventCatalog() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{WEBHOOK_LABELS.CATALOG_TITLE}</CardTitle>
        <CardDescription>{WEBHOOK_LABELS.CATALOG_DESC}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {WEBHOOK_EVENT_CATALOG.map((entry) => (
            <div
              key={entry.id}
              data-testid={`catalog-event-${entry.id}`}
              className="rounded-lg border p-4 space-y-2"
            >
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-sm font-mono font-medium">{entry.id}</code>
                {entry.live ? (
                  <Badge variant="secondary" className="text-xs">
                    {WEBHOOK_LABELS.CATALOG_LIVE_BADGE}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-xs text-muted-foreground">
                    {WEBHOOK_LABELS.CATALOG_DEFERRED_BADGE}
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {WEBHOOK_EVENT_DESCRIPTIONS[entry.id]}
              </p>
              {!entry.live && (
                <p className="text-xs text-muted-foreground italic">
                  {WEBHOOK_LABELS.CATALOG_DEFERRED_NOTE}
                </p>
              )}
              <div className="text-xs text-muted-foreground">
                <span className="font-medium">{WEBHOOK_LABELS.CATALOG_PAYLOAD_FIELDS_LABEL}: </span>
                <code className="font-mono break-all">{entry.fields.join(', ')}</code>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          {WEBHOOK_LABELS.CATALOG_REDACTION_NOTE}
        </p>
      </CardContent>
    </Card>
  );
}

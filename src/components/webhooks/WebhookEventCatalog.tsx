/**
 * Webhook Event Catalog (WH-01 / SCRUM-2396)
 *
 * Read-only catalog of every event type an endpoint can subscribe to, with
 * per-event payload fields and the redaction rules.
 *
 * Honesty rules (§1.13 R-7 launch-claims discipline):
 *  - `live: true` is asserted ONLY for events with a real emit point in the
 *    worker (verified against services/worker/src/webhooks/agents.md
 *    producer table + payload-schemas.ts): all five anchor.* events.
 *  - credential.* events are contract-defined (SCRUM-1743) but have NO emit
 *    points yet — they are shown as "Not yet active" so a subscriber is
 *    never led to believe they will receive them today.
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

export interface WebhookCatalogEntry {
  id: string;
  /** True only when the worker has a real emit point for this event. */
  live: boolean;
  /** Wire payload `data` fields, mirroring payload-schemas.ts (strict). */
  fields: string[];
}

// Field lists verified 2026-07-06 against
// services/worker/src/webhooks/payload-schemas.ts (strict Zod schemas).
// `?` marks nullable/optional fields.
const CATALOG_DATA: Record<string, Omit<WebhookCatalogEntry, 'id'>> = {
  'anchor.submitted': {
    live: true,
    fields: ['public_id', 'status', 'submitted_at', 'chain_tx_id?', 'chain_block_height?', 'org_public_id?'],
  },
  'anchor.secured': {
    live: true,
    fields: ['public_id', 'status', 'chain_tx_id', 'chain_block_height', 'chain_timestamp', 'secured_at', 'org_public_id?'],
  },
  'anchor.revoked': {
    live: true,
    fields: ['public_id', 'status', 'revoked_at', 'revocation_reason?', 'chain_tx_id?', 'chain_block_height?', 'org_public_id?'],
  },
  'anchor.expired': {
    live: true,
    fields: ['public_id', 'status', 'chain_tx_id', 'chain_block_height', 'expires_at', 'expired_at', 'org_public_id?'],
  },
  'anchor.batch_secured': {
    live: true,
    fields: ['public_ids', 'anchor_count', 'chain_tx_id', 'chain_block_height', 'chain_timestamp', 'secured_at'],
  },
  'credential.issued': {
    live: false,
    fields: ['public_id', 'status', 'issued_at', 'expires_at?', 'credential_type', 'recipient_public_id?', 'org_public_id?'],
  },
  'credential.verified': {
    live: false,
    fields: ['public_id', 'status', 'verified_at', 'verifier_country?', 'credential_type', 'recipient_public_id?', 'org_public_id?'],
  },
  'credential.status_changed': {
    live: false,
    fields: ['public_id', 'previous_status', 'new_status', 'changed_at', 'reason?', 'credential_type', 'recipient_public_id?', 'org_public_id?'],
  },
};

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

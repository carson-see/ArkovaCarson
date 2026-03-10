# Webhooks
_Last updated: 2026-03-10 | Story: P7-TS-09, P7-TS-10_

## Overview

Arkova uses webhooks for two purposes:
1. **Inbound**: Receiving events from Stripe (billing lifecycle)
2. **Outbound**: Sending anchor status updates to organization customers

## Inbound Webhooks (Stripe)

### Endpoint

```
POST /webhooks/stripe
```

Handled by the worker service (`services/worker/src/stripe/handlers.ts`). Per the Constitution, all backend processing runs in the worker — no frontend framework API routes.

### Signature Verification

All Stripe webhooks must be verified using `stripe.webhooks.constructEvent()` (Constitution 1.4):

```typescript
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function handleStripeWebhook(req: Request) {
  const sig = req.headers.get('stripe-signature');
  const body = await req.text();

  const event = stripe.webhooks.constructEvent(
    body,
    sig,
    process.env.STRIPE_WEBHOOK_SECRET
  );

  // Process event...
}
```

### Event Handlers

| Event | Handler | Action |
|-------|---------|--------|
| `checkout.session.completed` | `handleCheckoutComplete` | Create subscription record |
| `customer.subscription.created` | `handleSubscriptionCreated` | Update subscription status |
| `customer.subscription.updated` | `handleSubscriptionUpdated` | Update subscription status |
| `customer.subscription.deleted` | `handleSubscriptionDeleted` | Downgrade to free |
| `invoice.paid` | `handleInvoicePaid` | Log payment success |
| `invoice.payment_failed` | `handlePaymentFailed` | Log failure, notify user |

### Idempotency

Stripe webhooks may be delivered multiple times. The `billing_events` table provides idempotency via the `stripe_event_id` column:

```typescript
// Check if event already processed
const existing = await db
  .from('billing_events')
  .select('id')
  .eq('stripe_event_id', event.id)
  .single();

if (existing.data) {
  return { status: 200, body: 'Already processed' };
}

// Process and record
await processEvent(event);
await db.from('billing_events').insert({
  stripe_event_id: event.id,
  event_type: event.type,
  processed_at: new Date().toISOString(),
});
```

### Error Handling

Return appropriate status codes:

| Status | Meaning | Stripe Action |
|--------|---------|---------------|
| 200 | Success | Mark delivered |
| 400 | Bad request | Don't retry |
| 5xx | Server error | Retry with backoff |

## Outbound Webhooks (Customer Notifications)

### Purpose

Organization customers can configure webhooks to receive anchor status updates. Configuration UI is at `/settings/webhooks` (`WebhookSettings.tsx`).

### Events

| Event | Payload |
|-------|---------|
| `anchor.created` | Anchor ID, fingerprint, filename |
| `anchor.secured` | Anchor ID, chain receipt, timestamp |
| `anchor.revoked` | Anchor ID, revocation reason |
| `anchor.verified` | Anchor ID, verification result |

### Delivery

Delivery engine: `services/worker/src/webhooks/delivery.ts`

```typescript
async function deliverWebhook(
  endpoint: WebhookEndpoint,
  event: WebhookEvent
): Promise<void> {
  const payload = JSON.stringify(event);
  const signature = createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  const response = await fetch(endpoint.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Arkova-Signature': signature,
      'X-Arkova-Event': event.type,
      'X-Arkova-Timestamp': new Date().toISOString(),
    },
    body: payload,
  });

  if (!response.ok) {
    throw new WebhookDeliveryError(response.status);
  }
}
```

### Retry Policy

Failed deliveries are retried with exponential backoff:

| Attempt | Delay |
|---------|-------|
| 1 | Immediate |
| 2 | 1 minute |
| 3 | 5 minutes |
| 4 | 30 minutes |
| 5 | 2 hours |

After 5 failures, webhook endpoint is disabled and organization is notified.

### Signature Verification (Customer Side)

Customers should verify webhook signatures:

```typescript
import { createHmac } from 'crypto';

function verifyWebhook(payload: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return signature === expected;
}
```

## Database Schema

### webhook_endpoints (migration 0018)

Organization-level webhook configuration.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `org_id` | uuid | NO | — | FK → organizations(id) |
| `url` | text | NO | — | HTTPS endpoint (enforced by CHECK) |
| `secret_hash` | text | NO | — | HMAC secret hash (write-only) |
| `events` | text[] | NO | `{anchor.secured, anchor.revoked}` | Events to receive |
| `is_active` | boolean | NO | true | Enabled state |
| `description` | text | YES | NULL | Human label |
| `created_at` | timestamptz | NO | now() | Creation timestamp |
| `updated_at` | timestamptz | NO | now() | Auto-updated via moddatetime |
| `created_by` | uuid | YES | NULL | FK → profiles(id) |

**Constraints:** `url` must match `^https://`.

**RLS:** ORG_ADMIN can full CRUD for their org's endpoints.

### webhook_delivery_logs (migration 0018)

Delivery attempts for audit and retry logic.

| Column | Type | Nullable | Default | Description |
|--------|------|----------|---------|-------------|
| `id` | uuid | NO | gen_random_uuid() | Primary key |
| `endpoint_id` | uuid | NO | — | FK → webhook_endpoints(id) |
| `event_type` | text | NO | — | Event name |
| `event_id` | uuid | NO | — | Source event ID |
| `payload` | jsonb | NO | — | Delivered payload |
| `attempt_number` | integer | NO | 1 | Retry attempt number |
| `status` | text | NO | — | pending / success / failed / retrying |
| `response_status` | integer | YES | NULL | HTTP response code |
| `response_body` | text | YES | NULL | Response body |
| `error_message` | text | YES | NULL | Error details |
| `created_at` | timestamptz | NO | now() | Created timestamp |
| `delivered_at` | timestamptz | YES | NULL | Successful delivery time |
| `next_retry_at` | timestamptz | YES | NULL | Next retry scheduled |
| `idempotency_key` | text | YES | NULL | Unique (prevents duplicates) |

**RLS:** ORG_ADMIN can read logs for their org's endpoints (via subquery on webhook_endpoints).

### billing_events (migration 0016)

Used for Stripe inbound webhook idempotency. See [08_payments_entitlements.md](./08_payments_entitlements.md) for full schema.

Key columns: `stripe_event_id` (UNIQUE), `event_type`, `payload`, `idempotency_key`.

## Current Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| Stripe inbound webhook verification | Complete | P7-TS-03 |
| Stripe mock mode for tests | Complete | P7-TS-03 |
| WebhookSettings UI | Partial | P7-TS-09 — routed at `/settings/webhooks`, secret HMAC hashing not implemented |
| Delivery engine | Partial | P7-TS-10 — `delivery.ts` has exponential backoff + HMAC signing, but `anchor.ts` never triggers dispatch |
| webhook_endpoints / webhook_delivery_logs tables | Complete | Migration 0018 |
| billing_events table | Complete | Migration 0016 |

**Known gap:** Anchor lifecycle events (SECURED, REVOKED) do not trigger outbound webhook dispatch. The delivery engine exists but is not wired to the anchor processing pipeline.

## Security

1. **HTTPS Only**: Outbound webhooks only to HTTPS URLs (CHECK constraint on `url`)
2. **Signature Verification**: All webhooks signed with HMAC-SHA256
3. **Timeout**: 30 second timeout for delivery
4. **Rate Limiting**: Max 100 deliveries per minute per organization
5. **Secret hashing**: `secret_hash` column stores hash, never raw secret
6. **RLS**: All tables have FORCE ROW LEVEL SECURITY

## Testing

### Stripe CLI

Test inbound webhooks locally:

```bash
stripe listen --forward-to localhost:3001/webhooks/stripe
stripe trigger checkout.session.completed
```

### Mock Mode

Worker tests use `services/worker/src/stripe/mock.ts` for Stripe mocking. No real Stripe or Bitcoin API calls in tests (Constitution 1.7).

## Audit Events

All webhook activity is logged:

- `webhook.configured`
- `webhook.delivery_success`
- `webhook.delivery_failed`
- `webhook.disabled`

## Related Documentation

- [08_payments_entitlements.md](./08_payments_entitlements.md) — Payment system and billing_events schema
- [10_anchoring_worker.md](./10_anchoring_worker.md) — Worker service
- [04_audit_events.md](./04_audit_events.md) — Audit logging

## Change Log

| Date | Story | Change |
|------|-------|--------|
| 2026-03-10 | Audit | Rewrote: fixed "Ralph" branding, corrected table names (webhook_endpoints, webhook_delivery_logs), removed nonexistent stripe_webhook_events, added billing_events for idempotency, documented implementation status and known gaps |

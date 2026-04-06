# Webhooks
_Last updated: 2026-03-24 | Story: P7-TS-09, P7-TS-10, DH-04, DH-12_

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
| `attestation.created` | Attestation ID, anchor ID, attester |
| `attestation.revoked` | Attestation ID, revocation reason |

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
| Delivery engine | Complete | P7-TS-10 — `delivery.ts` has exponential backoff + HMAC signing, wired to anchor lifecycle (HARDENING-4) |
| Webhook dispatch from anchor lifecycle | Complete | HARDENING-4 — `anchor.ts` calls `dispatchWebhookEvent()` after SECURED status |
| Webhook retry scheduling | Complete | HARDENING-4 — `processWebhookRetries()` runs every 2 minutes via cron in `index.ts` |
| webhook_endpoints / webhook_delivery_logs tables | Complete | Migration 0018 |
| billing_events table | Complete | Migration 0016 |

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

## Circuit Breaker (DH-04)

Outbound webhook delivery uses a circuit breaker pattern to protect against cascading failures when a customer endpoint is consistently failing:

- **Closed** (normal): Deliveries proceed. Failures tracked.
- **Open** (tripped): After consecutive failures exceed threshold, all deliveries to that endpoint are short-circuited. Endpoint marked inactive.
- **Half-open** (recovery): After cooldown period, a single probe delivery is attempted. Success resets to Closed; failure returns to Open.

This prevents the webhook retry queue from being saturated by a single failing endpoint.

## Dead Letter Queue (DH-12)

After all retry attempts are exhausted (5 attempts with exponential backoff), failed webhook deliveries are moved to a dead letter queue rather than being silently dropped:

- Dead-lettered events are retained for 30 days
- Organization admins can view dead-lettered events in `/settings/webhooks`
- Dead-lettered events can be manually retried via admin action
- Logged as `webhook.dead_lettered` audit event

## SSRF Protection

Outbound webhook URLs are validated to prevent Server-Side Request Forgery:

- Only HTTPS URLs allowed (existing CHECK constraint on `webhook_endpoints.url`)
- Private/internal IP ranges blocked (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16)
- DNS resolution validated before delivery — resolved IP checked against blocklist
- `localhost`, `*.internal`, and cloud metadata endpoints blocked

## Feature Flag

Outbound webhooks are gated by the `ENABLE_OUTBOUND_WEBHOOKS` switchboard flag (currently **disabled**). When disabled:

- Webhook endpoint configuration UI is hidden
- `dispatchWebhookEvent()` returns immediately without delivery
- Existing endpoint configurations are preserved but inactive

## Related Documentation

- [08_payments_entitlements.md](./08_payments_entitlements.md) — Payment system and billing_events schema
- [10_anchoring_worker.md](./10_anchoring_worker.md) — Worker service
- [04_audit_events.md](./04_audit_events.md) — Audit logging

## Change Log

| Date | Story | Change |
|------|-------|--------|
| 2026-03-10 | Audit | Rewrote: fixed "Ralph" branding, corrected table names (webhook_endpoints, webhook_delivery_logs), removed nonexistent stripe_webhook_events, added billing_events for idempotency, documented implementation status and known gaps |
| 2026-03-10 5:20 PM EST | HARDENING-4 | Delivery engine status → Complete. Webhook dispatch wired in anchor.ts. processWebhookRetries added to cron schedule. Removed "Known gap" about unconnected lifecycle. |
| 2026-03-24 | Doc refresh | Added circuit breaker (DH-04), dead letter queue (DH-12), SSRF protection, ENABLE_OUTBOUND_WEBHOOKS flag, attestation.created/revoked event types. |
| 2026-04-05 | COMP-08 | Added compliance event types: `compliance.certificate_expiring`, `compliance.certificate_expired`, `compliance.anchor_delayed`, `compliance.signature_revoked`, `compliance.score_degraded`, `compliance.timestamp_coverage_low`. Certificate expiry fires at 30/7/1 day thresholds. Anchor delay fires when batch >1h. Reuses existing webhook delivery infrastructure. |

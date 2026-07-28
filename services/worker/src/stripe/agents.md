# services/worker/src/stripe/

Stripe SDK integration: client initialization, webhook event handling, and test mocks.

## Files

- **client.ts** — Initializes the real Stripe SDK. Exports `stripe` (real client), `getStripeClient()` (returns mock when `USE_MOCKS=true`), and `verifyWebhookSignature()` for webhook authentication via `constructEvent()`.
- **client.test.ts** — Tests for client initialization, mock switching, and signature verification.
- **handlers.ts** — Stripe webhook event handlers. Processes `checkout.session.completed`, `customer.subscription.*`, `invoice.*`, and `identity.verification_session.*` events. Updates `subscriptions` table, logs to `billing_events` + `audit_events`. Idempotent via `billing_events` dedup. **PAY-01 (SCRUM-2384):** `identity.verification_session.verified` → `grantVerifiedIdentityEntitlement` (declined/requires_input/canceled never grant); `customer.subscription.deleted` → `revokeVerifiedIdentityEntitlement`. The grant/revoke logic lives in `../billing/entitlements.ts`. SCRUM-2971: `recordBillingAudit` now also sets `idempotency_key: eventId` on the audit-row insert — Stripe's globally-unique event id doubles as the idempotency key so the row satisfies migration `0368`'s new `billing_events.idempotency_key IS NOT NULL` constraint (found un-populated during the SCRUM-2971 insert-site audit; dedup semantics unchanged, still serialized by the claim-first `webhook_event_claims` / `stripe_event_id` flow above).
- **handlers.test.ts** — Tests for webhook handler event processing. `entitlements.js` is module-mocked here; the entitlement DB behavior is unit-tested in `../billing/entitlements.test.ts`.
- **mock.ts** — Mock Stripe client for tests. Constitution requires mocks for all Stripe API calls in tests.
- **mock.test.ts** — Tests for mock Stripe client behavior.

## Rules

- Stripe keys loaded from env vars, never hardcoded (Constitution 1.4).
- Webhook handlers MUST call `stripe.webhooks.constructEvent()` for signature verification.
- No real Stripe API calls in tests — use `mock.ts` (Constitution 1.7).
- Payment data never logged in detail.
- SCRUM-1791: `subscriptions.current_period_start/end` MUST be advanced on BOTH `customer.subscription.updated` (from `items.data[0].current_period_*`) AND `invoice.payment_succeeded` (from `lines.data[0].period`). `handleSubscriptionUpdated` alone is not sufficient — a missed/malformed `updated` event would otherwise strand the row on a stale period and fire false entitlement gates (`useEntitlements` reads `current_period_start`). Always read the period from the authoritative Stripe payload; never compute it locally. Under claim-first idempotency, missing period fields → log + apply the rest of the update, never throw-to-retry (the `billing_events` claim is already committed).

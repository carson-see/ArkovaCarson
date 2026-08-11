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
- **AUDIT-0424-10: checkout MUST NOT write KYB or identity state.** `handleCheckoutComplete` writes subscription/entitlement state only — the `subscriptions` row and `profiles.subscription_tier`. It must never write `organizations.verification_status` or `profiles.is_verified`. Those are provider-owned: `verification_status` ← `api/v1/webhooks/middesk.ts`, `is_verified` ← `handleIdentityVerified` (Stripe Identity). `verification_status` is the authoritative KYB gate read by `requireVerifiedOrg` (docusign-oauth / drive-oauth), `orgSubOrgs`, and the `useCanIssueCredential` UI hook, so writing it here self-grants the DocuSign/Drive connect entitlement to anyone who completes a checkout. The previous code guarded only `currentStatus === 'REJECTED'` and flipped everything else to `VERIFIED`; that guard was dead code, because the live CHECK constraint did not admit `'REJECTED'` at all until migration `0407`. If a paid plan should imply an entitlement, express it in `PROFILE_TIER_BY_PLAN_ID` — never by writing a verification column.
- SCRUM-1791: `subscriptions.current_period_start/end` MUST be advanced on BOTH `customer.subscription.updated` (from `items.data[0].current_period_*`) AND `invoice.payment_succeeded` (from `lines.data[0].period`). `handleSubscriptionUpdated` alone is not sufficient — a missed/malformed `updated` event would otherwise strand the row on a stale period and fire false entitlement gates (`useEntitlements` reads `current_period_start`). Always read the period from the authoritative Stripe payload; never compute it locally. Under claim-first idempotency, missing period fields → log + apply the rest of the update, never throw-to-retry (the `billing_events` claim is already committed).

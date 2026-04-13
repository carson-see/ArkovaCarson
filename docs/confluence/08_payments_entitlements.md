# Payments & Entitlements
_Last updated: 2026-03-24 | Story: P7-TS-01, P7-TS-02, P7-TS-03, PH1-PAY-01_

## Overview

Arkova uses Stripe for billing and entitlement management. Billing state is stored across four tables in the `plans`/`subscriptions`/`entitlements`/`billing_events` schema (migration 0016). Stripe integration runs exclusively in the worker service.

## Non-Custodial Model

**Critical**: Arkova is non-custodial. We do NOT:
- Store user cryptocurrency
- Accept deposits or process withdrawals
- Hold user funds

All on-chain fees are paid from a **corporate fee account** managed by Arkova.

## Terminology

Per the Constitution (Section 1.3), UI must use approved terminology:

| Forbidden | Required |
|-----------|----------|
| Wallet | Fee Account / Billing Account |
| Transaction | Network Receipt / Anchor Receipt |
| Testnet | Test Environment |
| Mainnet | Production Network |

## Subscription Tiers

Plans are defined in the `plans` table (migration 0016, seeded with defaults). Pricing is enterprise B2B and not public — specific dollar amounts are configured in Stripe Dashboard and referenced via `stripe_price_id`.

| Plan ID | Name | Records/Month | Key Features |
|---------|------|---------------|-------------|
| `free` | Free | 3 | Basic verification, 7-day proof access |
| `individual` | Individual | 10 | Proof downloads, basic support |
| `professional` | Professional | 100 | Bulk CSV upload, API access, priority support |
| `organization` | Organization | Unlimited | Custom integrations, SLA, dedicated support |

Tier enforcement is via `profiles.subscription_tier` (privileged column, migration 0028) and `entitlements` table lookups.

## Database Schema

### Billing Tables (migration 0016)

All four tables have RLS enabled with `FORCE ROW LEVEL SECURITY`. Full column details in [02_data_model.md](./02_data_model.md).

| Table | Purpose | RLS |
|-------|---------|-----|
| `plans` | Plan definitions (seeded) | Authenticated can read active plans |
| `subscriptions` | User subscription state | User reads own; one subscription per user |
| `entitlements` | Fine-grained feature access | User reads own |
| `billing_events` | Append-only billing audit trail | User reads own; immutable (triggers) |

**Key design decisions:**
- `stripe_customer_id` and `stripe_subscription_id` live on `subscriptions`, NOT on `profiles`
- `billing_events` reuses `reject_audit_modification()` from migration 0006 for append-only enforcement
- `billing_events.stripe_event_id` (UNIQUE) provides Stripe webhook idempotency

### Profile Billing Columns (migration 0028)

| Column | Type | Description |
|--------|------|-------------|
| `is_verified` | boolean | Identity verified by admin (privileged) |
| `subscription_tier` | text | free / starter / professional / enterprise (privileged) |

Both are guarded by `protect_privileged_profile_fields()` trigger — only settable via service_role.

## Stripe Integration

### Checkout Flow (NOT YET IMPLEMENTED — CRIT-3)

Planned flow:
1. User selects plan on pricing page
2. Worker creates Stripe Checkout Session
3. Stripe processes payment
4. Webhook `checkout.session.completed` fires
5. Worker creates subscription record and updates entitlements
6. User redirected to success page

**Status:** No checkout session endpoint exists. No pricing UI. This is a production blocker.

### Subscription Management

Users manage subscriptions via Stripe Customer Portal:

```typescript
const portalSession = await stripe.billingPortal.sessions.create({
  customer: customerId,
  return_url: `${APP_URL}/settings/billing`,
});
```

### Webhook Processing

Stripe webhooks are verified in the worker (`services/worker/src/stripe/handlers.ts`). See [09_webhooks.md](./09_webhooks.md) for full webhook documentation.

| Event | Action |
|-------|--------|
| `checkout.session.completed` | Create subscription record |
| `customer.subscription.updated` | Update subscription status |
| `customer.subscription.deleted` | Downgrade to free |
| `invoice.payment_failed` | Log failure, notify user |

## Entitlement Enforcement

### Enforcement Points

1. **Anchor Creation**: Check `plans.records_per_month` against monthly usage
2. **API Access**: Check `subscription_tier` includes API access (Phase 1.5)
3. **Webhook Configuration**: Check `subscription_tier` is 'organization'

### Monthly Reset

A scheduled worker job resets monthly anchor counts based on subscription period.

## Environment Variables

```bash
# Stripe Configuration (worker only — never in browser)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# NEVER expose STRIPE_SECRET_KEY to client
```

## Testing

### Mock Mode

Worker tests use `services/worker/src/stripe/mock.ts`. No real Stripe API calls in tests (Constitution 1.7).

```typescript
// Mock Stripe for tests
vi.mock('stripe', () => ({
  default: vi.fn(() => ({
    checkout: {
      sessions: { create: vi.fn() },
    },
  })),
}));
```

## Current Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| Billing schema (4 tables) | Complete | Migration 0016 |
| Profile billing columns | Complete | Migration 0028 |
| Stripe webhook verification | Complete | P7-TS-03 |
| BillingOverview.tsx | Exists | Not routed with real data |
| Checkout session creation | Not Started | CRIT-3 |
| Pricing UI | Not Started | CRIT-3 |

## Audit Events

All payment events are logged to `billing_events`:

- `payment.subscription_created`
- `payment.subscription_updated`
- `payment.subscription_cancelled`
- `payment.invoice_paid`
- `payment.invoice_failed`

## x402 Payment Protocol (PH1-PAY-01)

### Overview

Arkova supports the x402 payment protocol for pay-per-call API access using USDC on Base L2. This provides an alternative to Stripe subscription billing for programmatic API consumers.

### Architecture

- **Protocol:** x402 (HTTP 402 Payment Required)
- **Currency:** USDC on Base L2
- **Priced endpoints:** 8 endpoints currently configured for x402 billing
- **Switchboard flag:** `ENABLE_X402_PAYMENTS` (must be enabled in switchboard_flags)
- **Story:** PH1-PAY-01 (complete), PH1-PAY-02 (self-hosted facilitator — partial)

### Flow

1. Client calls a priced API endpoint without payment
2. Server responds with HTTP 402 + x402 payment details (amount, USDC address, network)
3. Client submits USDC payment on Base L2
4. Client retries request with payment proof header
5. Server verifies payment and processes request

### Anonymous GET Exception

`GET /api/v1/verify/:publicId` allows anonymous access without API key or x402 payment. This enables zero-friction developer onboarding — a developer can verify credentials without signing up. Anonymous requests are rate-limited at 100 req/min per IP (Constitution 1.10). All other x402-gated endpoints (entity lookup, compliance check, regulatory lookup, CLE, Nessie query) still require API key or x402 payment for both GET and POST requests.

### Status

| Component | Status | Notes |
|-----------|--------|-------|
| x402 middleware | Complete | PH1-PAY-01 |
| 8 priced endpoints | Complete | Verification, batch, anchoring endpoints |
| Self-hosted facilitator | Partial | PH1-PAY-02 — flag enabled, needs USDC address + facilitator deploy |

## Unified Credits System (migration 0100+)

Migrations 0100+ introduced a unified credits system that consolidates usage tracking across Stripe subscriptions and x402 payments. The `unified_credits` table provides a single ledger for:

- Subscription-granted monthly credits
- x402 purchased credits
- Per-anchor debit entries
- Quota enforcement (migration 0093 — quota enforcement fixes)

This replaces the earlier per-table usage counting approach and enables cross-payment-method credit fungibility.

## Related Documentation

- [09_webhooks.md](./09_webhooks.md) — Webhook implementation
- [10_anchoring_worker.md](./10_anchoring_worker.md) — Worker service
- [02_data_model.md](./02_data_model.md) — Full billing table schemas

## Change Log

| Date | Story | Change |
|------|-------|--------|
| 2026-03-10 | Audit | Rewrote: removed specific dollar amounts, fixed table references to match migration 0016 (plans/subscriptions/entitlements/billing_events), removed fake stripe_customer_id/stripe_subscription_id/anchor_count_this_month from profiles, documented implementation status |
| 2026-03-24 | Doc refresh | Added x402 payment protocol section (PH1-PAY-01, USDC on Base L2, 8 priced endpoints). Added unified credits system (migration 0100+). |
| 2026-04-05 | PAY-01/02/03 | Three-tier payment system: prepaid credit packs (1K/10K/100K/1M), Stripe metered billing, payment tier router (credits→Stripe→x402). Credit purchase via `/api/v1/credits/purchase`. Metered usage reporting via `/cron/report-metered-usage`. Rate limited at 10 req/min. Code review: fixed billing_events column names (payload not metadata), x402 replay prevention, production guard on dev credit grant. |
| 2026-04-13 | INT UAT | Anonymous GET exception: `GET /verify/:publicId` bypasses x402 gate for zero-friction developer onboarding (100 req/min anonymous). All other x402-gated endpoints still require auth or payment. Bypass scoped in `router.ts`, not in the x402 middleware itself. |

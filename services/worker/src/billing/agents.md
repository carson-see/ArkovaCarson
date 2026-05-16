# services/worker/src/billing/

Billing domain logic: metered usage reporting, payment validation, and Stripe reconciliation.

## Files

- **meteredBilling.ts** — Enterprise usage-based billing via Stripe metered subscriptions. Records API usage events, reports aggregated usage to Stripe for monthly invoicing.
- **meteredBilling.test.ts** — Tests for metered billing recording and reporting.
- **paymentGuard.ts** — Validates a user has a valid payment source before anchor processing. Check order: admin bypass, active Stripe subscription, x402 payment, beta unlimited override.
- **paymentGuard.test.ts** — Tests for payment guard authorization logic.
- **reconciliation.ts** — Monthly reconciliation crons: Stripe-to-anchor count reconciliation, revenue-vs-fees financial report, failed payment recovery with grace period + downgrade.
- **reconciliation.test.ts** — Tests for reconciliation workflows.

## Rules

- No PII in usage records (Constitution 1.4).
- No real Stripe API calls in tests — mock everything (Constitution 1.7).
- Payment data never logged in detail.

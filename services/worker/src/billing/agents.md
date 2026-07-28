# services/worker/src/billing/

Billing domain logic: metered usage reporting, payment validation, and Stripe reconciliation.

## Files

- **meteredBilling.ts** — Enterprise usage-based billing via Stripe metered subscriptions. Records API usage events, reports aggregated usage to Stripe for monthly invoicing. SCRUM-2971: `recordMeteredUsage` requires a caller-supplied `MeteredUsageRecord.requestId` (a request-scoped stable id, e.g. correlation id or queue job id — NOT reused across genuinely distinct usage events) and derives `idempotency_key = sha256(metered_api_usage:org_id:endpoint:requestId)` (exported as `meteredUsageIdempotencyKey`) before insert. A retry with the same `requestId` hits `billing_events`' `UNIQUE(idempotency_key)` and is treated as an idempotent no-op (23505 swallowed, not thrown) — a distinct `requestId` always inserts its own row, even in the same org/endpoint/period. See migration `0368` (`supabase/migrations/0368_scrum2971_billing_events_idempotency.sql`) for the paired DB-side `NOT VALID CHECK (idempotency_key IS NOT NULL)` enforcement on new rows.
- **meteredBilling.test.ts** — Tests for metered billing recording and reporting, incl. SCRUM-2971 idempotency (retry-collapse, distinct-requestId non-collapse, key determinism).
- **paymentGuard.ts** — Validates a user has a valid payment source before anchor processing. Check order: admin bypass, active Stripe subscription, x402 payment, beta unlimited override.
- **paymentGuard.test.ts** — Tests for payment guard authorization logic.
- **reconciliation.ts** — Monthly reconciliation crons: Stripe-to-anchor count reconciliation, revenue-vs-fees financial report, failed payment recovery with grace period + downgrade.
- **reconciliation.test.ts** — Tests for reconciliation workflows.
- **entitlements.ts** (PAY-01 / SCRUM-2384) — Verified-identity entitlement service. `grantVerifiedIdentityEntitlement` (Stripe Identity `verified` webhook → open `identity_verified` row, idempotent close-then-insert), `revokeVerifiedIdentityEntitlement` (subscription lapse → close the open window), `resolveVerifiedEntitlement` (pure gate: open entitlement window AND active subscription whose CURRENT period covers now — SCRUM-1791, never gates on a stale row), `hasActiveVerifiedEntitlement` (db-backed gate, fail-closed). Reuses the existing `entitlements` table (no schema change; RLS+FORCE already present, SELECT-only for `authenticated`, writes via service_role). Zod-validates every write target (UUIDs).
- **entitlements.test.ts** — Unit tests: verified→granted, declined/lapsed→denied/revoked, current-period (incl. stale-period) resolution, fail-closed reads.

## Rules

- No PII in usage records (Constitution 1.4).
- No real Stripe API calls in tests — mock everything (Constitution 1.7).
- Payment data never logged in detail.

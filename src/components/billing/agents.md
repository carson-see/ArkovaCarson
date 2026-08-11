# agents.md — components/billing
_Last updated: 2026-05-16_

## What This Folder Contains
Billing and subscription UI: plan overview, pricing cards, usage tracking, and upgrade prompts.

## Key Files
- `BillingOverview.tsx` — Current subscription status, usage stats, and payment method display
- `PricingCard.tsx` — Subscription plan card with features, pricing, and select action
- `UsageWidget.tsx` — Monthly record usage vs. plan limits with color-coded progress (warns at 80%/100%)
- `UpgradePrompt.tsx` — Modal shown when user hits plan record limit, directs to pricing page
- `index.ts` — Barrel exports

## Do / Don't Rules
- DO: Use approved terminology — "Fee Account" not "Wallet" per Constitution 1.3
- DO NOT: Handle Stripe SDK calls in these components — Stripe is worker-only, never browser
- DO: Point every upgrade/buy CTA at `ROUTES.PRICING`, never `ROUTES.BILLING`. `/billing` is a read-only status summary; `/pricing` (PricingPage) is the only surface that can start a purchase.
- DO NOT: leave a `<Button>` without an `onClick`. An inert control is indistinguishable from a broken one, and this folder shipped three of them.

## 2026-08-10 — the upgrade path did not reach checkout (launch blocker)

Every upgrade CTA in this folder dead-ended, so a user at their plan limit had
no reachable way to pay:

- `UsageWidget.tsx` — both CTAs (compact `:108`, full `:179`) linked to
  `ROUTES.BILLING`, whose own "Upgrade Plan" button called
  `navigate(ROUTES.BILLING)` — the page the user was already on. Now
  `ROUTES.PRICING`.
- `UpgradePrompt.tsx` — fires exactly when the user is blocked by quota, the
  highest-intent CTA in the product, and navigated to `ROUTES.BILLING` despite
  its own docblock claiming it "directs them to upgrade via the pricing page".
  Now `ROUTES.PRICING`.
- `BillingOverview.tsx` — the payment-method **"Update"** button and the
  billing-history **"View History"** button both shipped with **no `onClick` at
  all**; "View History" even rendered an `ExternalLink` icon promising a portal
  that never opened. Both are Stripe-portal actions (card changes and invoices
  live in the portal), so both now call `onManageBilling`.

Root cause was structural, not local: `PricingPage` — the only component that
calls `startCheckout` → worker `POST /api/checkout/session` — had no route and
no importers, so there was nowhere for these CTAs to point. Guarded now by
`src/tests/pages/route-reachability.test.ts`.

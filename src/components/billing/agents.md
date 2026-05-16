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

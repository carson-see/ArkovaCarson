# Lane 2 (Product & Growth) — PI-1 Sprint 0 — Revenue-Funnel Pre-Design

> **Lane:** L2 — Product & Growth. **Sprint:** PI-1 Sprint 0 (Foundation & Hardening). **Date:** 2026-06-18.
> **Persona (owner):** Senior Full-stack + Front-end + DBA. **Oversight:** Carson (CPO) + sole T2/T3 merge gate.
> **Status:** DRAFT — pre-design only. **Tier:** **T0** (design/spec; no running surface changes this sprint).
> **Feeds:** Sprint-1 objective **O2 — "revenue funnel live"** → future **S3 monetization** Jira epic(s).
> **Companion docs:** `docs/sprint-0/lane2/00-ceremonies.md` (this lane's sprint plan), and the S0-5.1 internal-visibility dashboard spec (DOUBLE_BILLING_RISK / fail-open / expiries) it hands off to.
>
> ### ⚠️ Scope guardrail — read first
> This document is **design intent**, not an implementation and not an assertion of current production billing state. **No billing, payment, webhook, credit-ledger, migration, or Stripe configuration change is made or implied here.** Every concrete change this pre-design proposes is, at *implementation* time:
> - **T2 or T3** under CLAUDE.md §1.12 (touches public API / worker behavior / billing / webhooks → **T2**; touches `supabase/migrations/` or credit-ledger integrity / data integrity → **T3**), and therefore
> - **gated to Carson** for the soak + merge, on a feature branch, never on `main`.
>
> Sprint 0 ships *this file only*. Sprint 1 picks up the filed stories (§7) and writes the code, TDD-first, behind the existing flags.

---

## 1. Purpose & method

Sprint 1's revenue-funnel objective must start **coding, not scoping**. This pre-design names the exact existing surfaces (file path + symbol), the real data model, the real Stripe object shapes already in the codebase, the UI flows, and — critically — the **gaps and hazards** Sprint 1 will hit, so they're decided now.

Three funnel pieces are in scope (from the Sprint-1 brief, objective O2):

1. **`verified_individual` tier** — priced + sellable via Stripe.
2. **Credit-pack purchase + ledger UI** — buy paid credits; see balance + history.
3. **Self-serve org signup + cheap org verification** (+ domain verification).

Everything below maps onto the **settled** fee/credit model (§2). Where the codebase already implements a piece, this doc cites it and scopes the *delta*; where there's a gap, it's flagged for Carson (§8) and filed as a Sprint-1 story (§7).

**Grounding sources read (read-only) for this pre-design:**

| Area | Path(s) |
|---|---|
| Payment guard | `services/worker/src/billing/paymentGuard.ts` |
| Reconciliation crons | `services/worker/src/billing/reconciliation.ts` |
| Metered billing (enterprise) | `services/worker/src/billing/meteredBilling.ts` |
| Stripe client (checkout + `constructEvent`) | `services/worker/src/stripe/client.ts` |
| Stripe webhook handlers | `services/worker/src/stripe/handlers.ts` |
| Credit-pack API | `services/worker/src/api/v1/credits.ts` |
| Credit-deduct idempotency (cite) | `supabase/migrations/0326_scrum1649_deduct_org_credit_idempotency.sql` |
| Credit seed / flags / quota | `supabase/migrations/0296`, `0300`, `0308`, `0327`; baseline `00000000000000_baseline_at_main_HEAD.sql` |
| Frontend billing / pricing | `src/pages/BillingPage.tsx`, `src/pages/PricingPage.tsx`, `src/components/billing/*` |
| Entitlements / credits hooks | `src/hooks/useEntitlements.ts`, `src/hooks/useCredits.ts`, `src/hooks/useBilling.ts` |
| Org signup + verification | `src/components/onboarding/OrgOnboardingForm.tsx`, `services/worker/src/api/v1/orgVerification.ts`, `src/pages/AdminOnboardingPage.tsx` |
| Tier constants | `services/worker/src/types/check-constraint-values.ts` (`SUBSCRIPTION_TIERS`) |
| Plan→tier map | `services/worker/src/stripe/handlers.ts` (`PROFILE_TIER_BY_PLAN_ID`) |
| UI copy (terminology gate) | `src/lib/copy.ts` (`BILLING_LABELS`, `BILLING_PAGE_LABELS`) |
| Double-bill hazard (handoff) | `services/worker/src/jobs/batch-anchor.ts:241` (`DOUBLE_BILLING_RISK`) |

---

## 2. The settled fee/credit model (fixed policy — design *to* it)

This is **product policy**, not up for redesign in this doc. The funnel maps onto it:

- **No per-document fee.** Revenue = **subscription** + **paid credits**. (There is no checkout that bills "per anchor.")
- **Default anchoring = nightly 3am batch drain**, ~10k docs per on-chain transaction — cheap, not instant. Worker batch window today is `02:00–03:00 UTC` (`reconciliation.ts:isWithinBatchWindow`, `isFreeTierUser`).
- Each subscription includes a **monthly credit allotment** for **instant** anchoring. Beyond the allotment, **paid credits cost $1.25 each (~$0.25 profit)**.
- **Credit-ledger integrity is launch-critical and fails CLOSED.** (See `meteredBilling.ts` — when it cannot determine `is_test`, it *aborts the whole report* rather than risk wrong billing; same posture applies to grants.)

**How the three funnel pieces sit on the model:**

| Funnel piece | Revenue lever | Anchoring path it unlocks | Ledger touchpoint |
|---|---|---|---|
| `verified_individual` tier | **Subscription** (recurring) | Higher monthly anchor quota + **monthly credit allotment** for instant | `subscriptions` + monthly-allotment grant |
| Credit-pack purchase | **Paid credits** (one-time) | Top-up of **instant** anchoring beyond the monthly allotment | append-only deduction ledger + `purchased` balance |
| Self-serve org + verification | Gateway to **org subscription** tiers | Org-scoped batch + instant via `org_credits` | `org_credits` (org-scoped) |

> **Instant Secure (the instant-anchoring UX + flag flip) is pre-designed in the companion Sprint-0 track, gated on the DOUBLE_BILLING_RISK alarm.** This doc covers only the *monetization* of instant capacity (allotment + paid credits), not the instant-anchor execution path itself (Lane-1 / chain surface — out of scope here).

---

## 3. Funnel piece 1 — `verified_individual` tier (priced + sellable)

### 3.1 What already exists
- The tier value `'verified_individual'` is a **valid `subscription_tier`** today: `services/worker/src/types/check-constraint-values.ts` (`SUBSCRIPTION_TIERS`).
- The plan→tier mapping is **already wired** in the webhook handler: `PROFILE_TIER_BY_PLAN_ID` (`handlers.ts:20`) maps `individual_verified_monthly` *and* `individual_verified_annual` → `'verified_individual'`.
- `PricingPage.tsx` **already renders** these plan IDs: `BILLING_PLAN_ORDER` includes `individual_verified_monthly` / `individual_verified_annual`, and `individual_verified_monthly` is the `recommended` card. Plan copy lives in `getPlanDescription` / `getPlanFeatures` in that file.
- Checkout is **already implemented**: `useBilling().startCheckout(planId)` → worker → `createCheckoutSession(...)` (`stripe/client.ts:69`), which puts `{ user_id, price_id, plan_id }` into Stripe session `metadata`. On success `handleCheckoutComplete` (`handlers.ts:192`) upserts `subscriptions` (conflict key `stripe_subscription_id`, per SCRUM-1220) and sets `profiles.subscription_tier`.

**So the delta for Sprint 1 is small and mostly data/QA, not net-new code.**

### 3.2 Stripe product/price design (intent)
Create (in Stripe, by Carson at impl time — **T2**) one **Product** "Verified Individual" with two recurring **Prices**:

| Plan row `plans.id` | Stripe price (intent) | `billing_period` | Notes |
|---|---|---|---|
| `individual_verified_monthly` | `price_individual_verified_monthly` | `month` | recommended card |
| `individual_verified_annual` | `price_individual_verified_annual` | `year` | annual discount (copy says "$10/mo when paid annually") |

- `plans` table (baseline schema) columns used: `id`, `stripe_price_id` (UNIQUE — `plans_stripe_price_id_key`), `price_cents`, `billing_period` (`month|year|custom`), `records_per_month` (monthly anchor quota). The webhook resolves plan **by `stripe_price_id` match** (`handlers.ts:226–254`); the `plans.id` ↔ Stripe price binding must be set in the `plans` rows (data migration, **T3** since it's `supabase/migrations/`).
- Price points are a **Carson decision** (§8). Copy currently *asserts* "$10/mo annual" and "10 anchors/month" for the verified tier — Sprint 1 must reconcile copy with the real Stripe price + `records_per_month`.

### 3.3 Checkout flow (intent — mostly exists)
1. User on `PricingPage` clicks the verified plan → `handleSelectPlan` → if no existing sub, `startCheckout(planId)`; if an existing sub, `openBillingPortal()` (plan change via Stripe portal, which handles proration).
2. Worker `createCheckoutSession({ priceId, userId, mode:'subscription', metadata })` → returns Stripe Checkout URL; browser redirects.
3. Stripe → webhook `checkout.session.completed` → `handleCheckoutComplete`: upsert `subscriptions(status='active')`, set `profiles.subscription_tier='verified_individual'`.

### 3.4 Entitlement granted
- `profiles.subscription_tier = 'verified_individual'` + `subscriptions.status='active'` with `plan_id ∈ {individual_verified_monthly, individual_verified_annual}`.
- Anchor quota read by `useEntitlements` (`src/hooks/useEntitlements.ts`): joins `subscriptions.plan_id` → `plans.records_per_month`; falls back to the Free **plan row** (a `plans` lookup, not a hard-coded `3`) when no active sub.
- **Monthly credit allotment** for instant anchoring: the verified tier must seed/refresh a credit allocation (see §4.4 — the allocation mechanism is the same ledger the credit packs top up).

### 3.5 Data-model touchpoints
`plans` (price binding), `subscriptions` (state), `profiles.subscription_tier` (gate), credit allocation table (allotment — see §4 fragmentation note).

### 3.6 UI (pricing + checkout)
- **Pricing:** `PricingPage.tsx` + `PricingCard.tsx` (already render the tier). Sprint-1 polish: ensure feature bullets match the real entitlements; ensure the verified-vs-free value prop (the **verified checkmark** — `VerifiedBadge.tsx`) is explicit.
- **Post-checkout:** `BillingPage.tsx` shows status via `/api/billing/status` (Zod-validated, SCRUM-2008 "Data unavailable" on malformed). `UsageWidget` shows quota for active subs.
- **Copy:** all strings via `src/lib/copy.ts` `BILLING_LABELS` / `BILLING_PAGE_LABELS` — **no banned terms** (no "Wallet/Transaction/Hash/Bitcoin"). The verified-individual flow is a *subscription*, so "Issue Credential" copy is **not** used here (that string is reserved for the SCRUM-1672 verified-org issuance flow only).

---

## 4. Funnel piece 2 — Credit-pack purchase + ledger UI

### 4.1 What already exists
- **Purchase endpoint:** `services/worker/src/api/v1/credits.ts` — `GET /api/v1/credits` (balance), `POST /api/v1/credits/purchase` (Zod `purchaseSchema`, packs enum), `GET /api/v1/credits/packs`. Mounted at `router.use('/credits', requireAuth, creditsRateLimiter, creditsRouter)` (`api/v1/router.ts:260`).
- **Pack catalog (today):** `CREDIT_PACKS` = `pack_1k` ($10), `pack_10k` ($80), `pack_100k` ($500), `pack_1m` ($3,000) — i.e. ~$0.003–$0.01/credit at pack scale. **NOTE:** this is the *API-credit* pricing (PAY-01 / SCRUM-442), which does **not** match the **$1.25/credit instant-anchoring** policy in §2. These are two different "credit" concepts colliding under one word — **decision needed** (§8).
- **One-time checkout path is already correct:** `createCheckoutSession({ mode:'payment', ... })` — and the `mode` plumbing bug was fixed in **SCRUM-1265 (R2-2)** (`client.ts:94–110`): a hardcoded `mode:'subscription'` previously broke credit-pack one-time purchases; now `subscription_data` is only attached for recurring sessions.
- **Idempotent deduction is solid:** `deduct_org_credit(...)` (migration **0326**) writes an **append-only idempotency ledger** `org_credit_deductions` keyed `UNIQUE (org_id, reference_id, reason)`. A retry with the same `reference_id` returns `{deducted:0, idempotent:true}`; an amount mismatch on the same key returns `idempotency_key_conflict`. `org_credit_deductions` is service_role-only, RLS + FORCE RLS, `CHECK (amount > 0)`, `CHECK (balance_after >= 0)`. `refund_org_credit(...)` deletes the idempotency row so a re-charge can occur. This is the **fail-closed** deduction primitive the funnel must reuse.

### 4.2 The gap Sprint 1 must close (credit-pack **grant** on payment)
**There is no `checkout.session.completed` branch that grants purchased credits.** `handleCheckoutComplete` (`handlers.ts:192`) only handles **subscriptions** — it reads `session.metadata.{user_id,price_id,plan_id}` and upserts `subscriptions`. The credit-pack purchase puts `metadata.{pack_id, credits, org_id}` on the session (`credits.ts:138–147`), but **nothing consumes it on webhook**. Today, real money can be taken for a pack with **no credit grant** outside dev mode (dev mode grants directly via `deduct_unified_credits` with a negative amount — `credits.ts:114–134`, explicitly "NEVER in production").

→ **Sprint-1 story (S3-CREDIT-GRANT, §7):** extend `handleCheckoutComplete` (or add a routed handler) to detect `metadata.pack_id`/`credits` on a `mode:'payment'` session and **grant** credits idempotently. The grant **must**:
- be idempotent on the Stripe event (claim-first `billing_events` UNIQUE on `stripe_event_id` already does this at the router — `claimEvent`, `handlers.ts:160`), **and**
- write to the credit ledger via a **grant** RPC that records an append-only row keyed by the Stripe `payment_intent`/`session.id` as `reference_id` (mirror the 0326 idempotency-ledger pattern so a Stripe retry never double-grants).
- **fail CLOSED:** if the grant RPC errors, **throw** so Stripe retries (the claim-first trade-off in `handlers.ts` is at-most-once for *side effects after the claim* — a grant failure must be observable and re-driveable; see §6 hazard).

### 4.3 Credit-ledger read fragmentation (must reconcile before UI)
There are **three** credit representations in the schema, and the read/write paths disagree:

| Path | Function / table | Scope | Has `purchased`? | Empty-state default |
|---|---|---|---|---|
| Frontend `useCredits` | `get_user_credits` → **`credits`** table | user | yes (`purchased`) | `error` object |
| Worker `GET /api/v1/credits` | `check_unified_credits` → **`unified_credits`** table | org **or** user | no (`carry_over` instead) | **fail-OPEN `50,0,50,true`** when no row |
| Worker deduct (0326) | `deduct_org_credit` → **`org_credits`** table | org | yes (`purchased`) | `org_not_initialized` (fail-closed) |

- `allocate_monthly_credits()` (baseline) resets `credits.balance = purchased + plan_allocation` monthly and logs `credit_transactions` rows (`ALLOCATION` / `EXPIRY`) — so **`purchased` survives the monthly reset** (paid credits don't expire; monthly allotment does). That's the correct policy shape, but it operates on `credits`, not `org_credits`/`unified_credits`.
- `check_unified_credits` returning `(50,0,50,true)` for a **missing** row is **fail-OPEN** — a launch-critical hazard for a paid-credit funnel. **Decision/flag (§8):** the funnel's authoritative balance source must be pinned to **one** table and the missing-row default must fail **closed** (return 0 / `has_credits=false`) before paid credits go live.

→ **Sprint-1 story (S3-CREDIT-LEDGER-CANON, §7):** pick the single source of truth (recommend `org_credits` for org-scoped + a user analogue, or consolidate to `unified_credits`), make balance reads and the new grant write the *same* table, and flip the empty-state to fail-closed. **T3** (data integrity + migration).

### 4.4 Monthly allotment (subscription → credits) touchpoint
The verified tier's "monthly credit allotment for instant anchoring" is granted by the same allocation machinery (`allocate_monthly_credits` style). Sprint 1 must ensure the **subscription tier's `monthly_allocation`** is set/refreshed on the *canonical* ledger table chosen in §4.3, distinct from `purchased` (paid) credits, so the "allotment expires monthly, paid credits roll over" policy holds.

### 4.5 Ledger UI (balance + history)
- **Balance widget exists:** `src/components/dashboard/CreditUsageWidget.tsx` + `useCredits` (shows `balance`, `monthly_allocation`, `purchased`, `is_low`). Reuse for the funnel's "credits remaining" surface.
- **History view (new):** an append-only **transactions list** — read `credit_transactions` (user) / a parallel org ledger — showing grants (purchases), monthly allocations, expiries, and deductions. Append-only, read-only in UI. Place on `BillingPage.tsx` (or a `Credits` tab).
- **Buy flow (new UI):** a "Buy credits" panel listing packs from `GET /api/v1/credits/packs`, calling `POST /api/v1/credits/purchase` → redirect to Stripe Checkout URL → return to a success state that **re-reads** the (now fail-closed) balance.
- **Copy:** existing labels `BILLING_LABELS`, and credit strings already present in `copy.ts` (e.g. `CREDITS_REMAINING: '{count} credits remaining'`). Keep "Anchoring Credits" / "Billing Account" phrasing; **never** "Wallet". The admin ops dashboard already uses "Available Anchoring Credits" (`VAULT_BALANCE`) — align customer copy to the same non-banned vocabulary.

### 4.6 Fail-CLOSED posture (mandatory)
- Deduction: already fail-closed (`org_not_initialized`, `insufficient_credits`, idempotency-conflict) via 0326.
- Grant: must be idempotent + throw-on-failure (§4.2).
- Balance read: must fail-closed on missing row (§4.3) before launch.
- No client-side credit mutation; all grants/deducts are service_role RPCs (0326 `GRANT EXECUTE ... TO service_role` for `refund`/deduct write paths).

---

## 5. Funnel piece 3 — Self-serve org signup + cheap org verification (+ domain)

### 5.1 What already exists
- **Org onboarding form:** `src/components/onboarding/OrgOnboardingForm.tsx` — captures legal name, display name, **domain**, org type, description, social URLs, and an optional **"Verify this organization"** path (EIN/Tax ID + business address). Free path = `org_free` tier (seats + anchors from `ORGANIZATION_TIER_METADATA`). Domain regex + EIN format (`validateEin`) validated client-side.
- **Admin onboarding wizard:** `src/pages/AdminOnboardingPage.tsx` (5-step: welcome → connect → pick rule template → enable → done), gated by `OrgRequiredGate`. This is the *post-creation* activation funnel; analytics events `onboarding_wizard_step_<n>` already fire.
- **Verification API (worker):** `services/worker/src/api/v1/orgVerification.ts`:
  - `POST /verify-ein` — stores `ein_tax_id`, sets `verification_status='PENDING'`, dedupes EIN (409 on collision), **never logs EIN** (L3 Confidential, §1.4).
  - `POST /verify-domain` — generates `code:token`, 24h expiry, emails `admin@<domain>` (Resend via `email/sender.ts`); dev mode returns `devCode` directly.
  - `POST /confirm-domain` — validates code, sets `domain_verified=true`; if EIN also present → `verification_status='VERIFIED'`.
  - `GET /verification-status` — returns status, domain, `domain_verified`, `hasEin` (never the EIN value).
  - `POST /dev-verify` — dev/test only (403 in prod).
- **Subscription→verification coupling already exists** in `handleCheckoutComplete` (`handlers.ts:309–355`): on org checkout, org `verification_status` is set `VERIFIED` **unless** it is `REJECTED` (Middesk KYB rejection must not be cleared by paying — a deliberate anti-bypass guard).

### 5.2 The "cheap verification" design (intent)
"Cheap org verification" = the **domain-ownership + self-attested EIN** path that already exists, used as the *low-cost* tier gate, with paid/KYB verification (Middesk) reserved for higher trust. Sprint-1 design intent:
- **Self-serve signup** creates an `org_free` workspace immediately (no payment, no KYB) — already the form's default branch.
- **Cheap verification = domain verification** (email-to-`admin@domain`, already built) → grants a lightweight "domain-verified" signal **without** EIN/KYB cost.
- **EIN + domain** → full `VERIFIED` (already built).
- **Paid/KYB (Middesk)** stays the high-trust path; the `REJECTED`-guard already prevents pay-to-bypass.

**Delta for Sprint 1:** wire the org-signup form's submit to actually create the org + persist the captured fields, then route into `verify-domain`; surface verification state in-app (the API exists; the *self-serve UI loop* — start domain verification, enter code, see VERIFIED — needs a page/flow). Today no `create_organization` RPC was found in the read — **confirm the org-creation write path** (likely a Supabase insert + RLS) and ensure the form is bound to it (§8 open question).

### 5.3 Domain-verification mechanism (as built — reuse)
Email-based: `crypto.randomBytes(32)` token + 6-digit code, stored `code:token` in `organizations.domain_verification_token` with `_expires_at` (24h), sent to `admin@<domain>`. Confirm compares the code, sets `domain_verified`, `domain_verification_method='email'`, `domain_verified_at`. (A DNS-TXT alternative is *not* built; email is the shipped mechanism — keep it for "cheap".)

### 5.4 RLS / tenancy considerations (DBA persona)
- `organizations` verification columns (`domain`, `domain_verified`, `domain_verification_token`, `ein_tax_id`, `verification_status`) are written **service_role-side** by the worker (`orgVerification.ts` uses `db as any` service client) — keep all token/EIN mutation server-side; **never** expose `domain_verification_token` or `ein_tax_id` to the browser (`GET /verification-status` already redacts EIN).
- `org_credits` is **org-scoped** with RLS + FORCE RLS; any org-credit grant for org tiers must be service_role only (mirrors 0326).
- Public surfaces must continue to expose only `public_id` + derived fields (CLAUDE.md common-mistakes) — never `org_id`/EIN/token. Public cross-tenant search is by design (memory: public endpoints are cross-tenant by design) — do **not** treat that as an isolation gap.
- Self-serve signup must set the creator's `profiles.org_id` and role under existing org RLS; verify no path lets a user attach to an arbitrary existing org.

### 5.5 UI
- **Signup:** `OrgOnboardingForm.tsx` (exists). Add the **post-create domain-verification loop** (start → enter code → status) — new small page/section consuming the worker endpoints; copy via `copy.ts` (e.g. `STEP_BILLING`, onboarding labels already present).
- **Status/badge:** `VerifiedBadge.tsx` / `OrgVerification.tsx` for the verified checkmark once `VERIFIED`.

---

## 6. Webhook + money-safety (cross-cutting) + S0-5.1 handoff

### 6.1 Signature verification (already correct)
`verifyWebhookSignature` (`stripe/client.ts:38`) calls `stripe.webhooks.constructEvent(payload, signature, webhookSecret)` in prod (mock only when `USE_MOCKS`). Stripe SDK pinned `apiVersion: '2026-04-22.dahlia'`. **Do not** parse the raw body without `constructEvent` (CLAUDE.md §1.4). Any new credit-grant handler is routed *after* signature verification + claim — it inherits this.

### 6.2 Idempotency (already correct, with a known trade-off)
`claimEvent` (`handlers.ts:160`) inserts into `billing_events` keyed by `stripe_event_id` UNIQUE **before** side effects → Stripe retries hit `23505` and bail. **Trade-off (documented in code):** this is *at-most-once* for side effects — a crash *after* the claim but *before* the side effect leaves the event "claimed" with no effect. For a **credit grant**, that means a missed grant is **silent** unless surfaced. → The new grant path must (a) reuse a *second* idempotency key at the ledger level (Stripe `payment_intent`/`session.id` as `reference_id`, 0326-style), and (b) be **observable** (audit row + metric) so a stuck grant is visible and re-driveable.

### 6.3 SCRUM-1791 dependency (entitlement gates fire on stale rows) — **must account for**
**Root issue:** `subscriptions.current_period_*` not rolling forward strands the row on a stale window, and `useEntitlements` reads `current_period_start` → **false over-limit gating** of paying customers.
- **Already mitigated** in two places: `handleSubscriptionUpdated` reads period from `items.data[0].current_period_*` (the 2026-03-25.dahlia field move, **SCRUM-1267 R2-4**), and `handlePaymentSucceeded` rolls the period forward from `lines.data[0].period` (**SCRUM-1791 HARDEN-1, SEV1**). `services/worker/src/stripe/agents.md` pins the rule: advance period on **both** events, never compute locally; under claim-first idempotency, missing period → log + apply rest, never throw-to-retry.
- **Funnel risk this creates:** the revenue funnel's value to the user (the quota they paid for) is only as good as `current_period_*` being fresh. If a future change touches subscription handling and regresses either write site, **paying `verified_individual` users get gated as if over-limit.** Sprint 1's funnel work **must not** regress these two write paths, and the funnel's QA must include a "renewal rolls the period forward → quota resets" E2E. Treat SCRUM-1791 as a **standing dependency/risk** of O2, surfaced on the S0-5.1 dashboard (below).

### 6.4 Reconciliation today (and the credit-pack gap)
`reconciliation.ts` reconciles **Stripe ↔ anchor counts** (RECON-1), a **revenue-vs-fees** financial report (RECON-3), and **failed-payment grace → downgrade** (RECON-5). It does **not** reconcile **credit-pack purchases ↔ credits granted** — once §4.2 ships, add a RECON job that asserts every paid `mode:'payment'` credit session has a matching idempotent grant row (catches the at-most-once gap). **Story S3-CREDIT-RECON (§7).**

### 6.5 Handoff to S0-5.1 internal-visibility dashboard
The S0-5.1 visibility spec (this lane's OWNED Sprint-0 deliverable) must **surface the money-safety signals this funnel introduces**, admin-only:
- **DOUBLE_BILLING_RISK** — already emitted at `services/worker/src/jobs/batch-anchor.ts:241` ("credit refunds failed — charged anchors must stay out of automatic retry"). The funnel adds charge/grant events → this alarm's blast radius grows. **Instant Secure stays gated on this alarm.**
- **Credit-grant failures** (§6.2) — new signal: paid-but-not-granted.
- **SCRUM-1791 staleness** (§6.3) — subs with `current_period_end` in the past while `status='active'` (the exact SEV1 shape).
- **Fail-open balance reads** (§4.3) — count of credit checks served by the `(50,0,50,true)` missing-row default.

→ **Produce/consume:** this pre-design **produces** the above 4 signal definitions; the S0-5.1 spec **consumes** them as dashboard tiles. No code either way in Sprint 0.

---

## 7. Sprint-1 entry list (stories to file so Sprint 1 codes, not scopes)

All are **design-ready** here; tier shown is the *implementation* tier (the gate that routes to Carson). File under the S3-monetization epic; link each to O2.

| Story (proposed) | Summary | Rough AC | Impl tier |
|---|---|---|---|
| **S3-VI-PRICE** | Bind `verified_individual` plans to Stripe prices | `plans` rows for `individual_verified_monthly`/`_annual` carry real `stripe_price_id`+`price_cents`+`records_per_month`; checkout resolves plan by price; copy matches entitlements; E2E: subscribe → `subscription_tier='verified_individual'` → quota applies | **T3** (migration) |
| **S3-VI-ALLOT** | Monthly credit **allotment** for verified tier | Active verified sub seeds/refreshes a `monthly_allocation` on the canonical ledger (post S3-CREDIT-LEDGER-CANON); allotment expires monthly, `purchased` survives; test covers month rollover | **T3** |
| **S3-CREDIT-GRANT** | Grant credits on paid `mode:'payment'` checkout | New/extended webhook branch reads `metadata.pack_id/credits`; idempotent grant keyed on Stripe `session.id`/`payment_intent` (0326-style ledger); **throws on grant failure**; audit row emitted; **no double-grant on Stripe retry** | **T2** |
| **S3-CREDIT-LEDGER-CANON** | One canonical credit ledger + fail-CLOSED reads | Pick single source of truth among `credits`/`org_credits`/`unified_credits`; reads + grants + deducts hit the same table; **missing-row default → fail-closed (0 / `has_credits=false`)**; migrate/reconcile existing rows | **T3** (data integrity) |
| **S3-CREDIT-UI** | Buy-credits panel + balance + append-only history | Packs listed from `/credits/packs`; purchase → Stripe redirect → success re-reads balance; history list of grants/allocations/expiries/deductions; copy via `copy.ts`, no banned terms; UAT @1280/375 | **T2** (no schema) |
| **S3-CREDIT-PRICE-POLICY** | Reconcile pack pricing with $1.25/credit policy | Resolve API-credit packs (`$0.003–0.01/credit`) vs instant-anchor credit ($1.25); define which "credit" each surface sells; Stripe one-time price(s) for the $1.25 instant-credit SKU | **T2** (+ Carson decision §8) |
| **S3-ORG-SELFSERVE** | Self-serve org creation bound to signup form | `OrgOnboardingForm` submit creates org (RLS-safe), persists captured fields, sets creator `org_id`/role; cannot attach to arbitrary existing org | **T2** |
| **S3-ORG-DOMAIN-LOOP** | In-app domain-verification UX loop | Page consumes `verify-domain`/`confirm-domain`/`verification-status`; start → enter code → `VERIFIED`; badge shows; copy via `copy.ts` | **T1/T2** (UI; T2 if it touches worker contract) |
| **S3-CREDIT-RECON** | Reconcile paid credit sessions ↔ grants | RECON cron asserts every paid credit `mode:'payment'` session has a matching idempotent grant; flags orphans for the dashboard | **T2** |
| **S3-VIS-SIGNALS** (handoff) | Wire the 4 money-safety signals into S0-5.1 dashboard | DOUBLE_BILLING_RISK, grant-failures, SCRUM-1791 staleness, fail-open balance counts surfaced admin-only | per S0-5.1 |

> **Reminder:** every row above is **deferred to Sprint 1+**. Sprint 0 ships only this file (T0).

---

## 8. Open questions / decisions for Carson

1. **`verified_individual` price points.** Monthly + annual amounts (`price_cents`) and the included `records_per_month`. Current copy *asserts* "$10/mo annual" + "10 anchors/month" — confirm or correct (copy must follow the real Stripe price, not vice-versa).
2. **Credit pricing collision.** §2 policy says **$1.25/credit** (instant anchoring). `credits.ts` `CREDIT_PACKS` sell at **~$0.003–$0.01/credit** (API/verification credits, PAY-01). Are these **two distinct products** (instant-anchor credit vs API credit), and which does the *revenue funnel* sell? This decides the Stripe SKU(s) and the UI.
3. **Canonical credit ledger.** Which table is the single source of truth — `org_credits` (org), `credits` (user), or `unified_credits`? Today reads/writes diverge across all three (§4.3). This is **launch-critical, fail-closed** — needs a decision before paid credits go live.
4. **Fail-open balance default.** OK to flip `check_unified_credits`' missing-row default from `(50,0,50,true)` to fail-closed `(0,0,0,false)`? (Recommended.)
5. **Org-creation write path.** Confirm how `OrgOnboardingForm` should persist a new org (Supabase insert under RLS vs a worker RPC). No `create_organization` RPC surfaced in the read — name the intended path.
6. **"Cheap verification" trust level.** Is domain-verified-only (no EIN/KYB) sufficient to grant the org checkmark, or is the checkmark reserved for EIN+domain / Middesk? (Form + API support both; product policy decides.)
7. **Credit-pack credit expiry.** Confirm paid credits **never expire** (only the monthly allotment does) — `allocate_monthly_credits` preserves `purchased`, consistent with this, but confirm for the chosen canonical table.

---

## 9. NOT in scope / deferred

- **No code, migration, Stripe config, webhook, or ledger change this sprint** — design only (T0).
- **Instant-anchor execution path** (the chain/anchor side of "instant") — Lane-1 / chain surface; this doc covers only *monetization* of instant capacity.
- **Instant Secure UX + flag flip** — companion Sprint-0 pre-design track, gated on DOUBLE_BILLING_RISK; not duplicated here.
- **Enterprise metered billing** (`meteredBilling.ts`, PAY-02/SCRUM-443) — already shipped for enterprise; not a Sprint-1 funnel item (cited only for the fail-closed pattern).
- **Middesk/KYB deep integration**, **DNS-TXT domain verification**, **billing portal redesign** — out of the O2 funnel scope.
- **x402 payment path** (`paymentGuard.ts` `hasX402Payment`) — adjacent payment rail; not part of this subscription+credits funnel.
- **Actual Jira/Confluence filing** of §7 stories — done at Sprint-1 entry (Confluence page per story is the source of truth per CLAUDE.md §4), not in this T0 doc.

---

_Last refreshed: 2026-06-18 by Claude (Lane 2 — Senior Full-stack/Front-end/DBA), under Carson's oversight. Pre-design only; no prod/staging/Supabase/Stripe state asserted or changed. All implementation gated to Carson at T2/T3._

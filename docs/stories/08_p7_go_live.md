# P7 Go-Live — Story Documentation
_Last updated: 2026-03-15 ~6:00 PM EST | 11/13 stories COMPLETE, 2/13 NOT STARTED (P7-TS-04/06 no individual scope)_

## Group Overview

P7 Go-Live delivers the production infrastructure for launching the credentialing MVP: billing schema and Stripe integration, real Bitcoin chain anchoring, proof package export, webhook delivery, and the anchoring worker. This is the most complex group with the deepest infrastructure requirements and the most critical production blockers.

Key deliverables:
- Billing schema (migration 0016) with plans, subscriptions, entitlements, billing events
- Stripe webhook verification + checkout session (checkout PARTIAL — CRIT-3)
- Real Bitcoin chain client — BitcoinChainClient implemented with provider abstractions (CRIT-2 CODE COMPLETE — operational items remain)
- Proof package export (PDF + JSON both complete — ~~CRIT-5~~ FIXED commit a38b485)
- Webhook endpoint management + delivery engine (fully wired to anchor lifecycle — HARDENING-4)
- Anchoring worker with job processing (hardening sprint COMPLETE — 416 tests across 18 files, all 80%+ thresholds)

> **Note:** P7-TS-04 and P7-TS-06 are not listed in CLAUDE.md Section 8. They may be skipped, renumbered, or part of another phase. This document covers the 8 stories explicitly tracked.

## Architecture Context

**Design Principle: Worker-Only Privileged Operations.** All operations that modify anchor status to SECURED, interact with payment providers, or submit to the Bitcoin network run exclusively in the Express worker (`services/worker/`). The worker uses the Supabase service_role key — never the anon key. Client code never sets `status = 'SECURED'`.

**Mock/Real Toggle Pattern:** The worker supports a `useMocks` configuration flag. When true (or in test), mock implementations are used for Stripe (`MockStripeClient`) and Bitcoin (`MockChainClient`). Real implementations are gated behind the `ENABLE_PROD_NETWORK_ANCHORING` switchboard flag.

**Worker Hardening Sprint (2026-03-10) — COMPLETE:** The worker/chain critical path started at 0% test coverage. HARDENING-1 added 27 tests for `processAnchor()` (100% coverage on `anchor.ts`). HARDENING-2 added 32 more tests covering `MockChainClient` (18 tests), `getChainClient()` factory (5 tests), and `processPendingAnchors()` job claim/completion flow (9 tests). HARDENING-3 added 55 more tests covering `delivery.ts` (30 tests, 99% stmts), `stripe/handlers.ts` (18 tests, 98% stmts), and `stripe/client.ts` (7 tests, 100%). HARDENING-4 wired webhook dispatch in `anchor.ts`, added `processWebhookRetries` to cron, created lifecycle integration test (8 tests), expanded anchor.test.ts with 10 webhook dispatch tests. Total: 132 worker tests. All 6 critical path files pass 80% coverage thresholds. Sprint complete — ready for Bitcoin chain integration.

---

## Stories

---

### P7-TS-01: Billing Schema

**Status:** COMPLETE
**Dependencies:** P1-TS-02 (anchors table for entitlement enforcement)
**Blocked by:** None

#### What This Story Delivers

A complete billing database schema with four tables: `plans` (pricing tiers), `subscriptions` (user/org subscription state), `entitlements` (feature access), and `billing_events` (append-only audit trail). Seeded with four plan tiers (Free, Individual, Professional, Organization). UI components exist but are not routed with real billing data.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Migration | `supabase/migrations/0016_billing_schema.sql` | 186 | 4 tables + RLS + indexes + triggers + seed data |
| Component | `src/components/billing/BillingOverview.tsx` | 243 | Plan info, usage bar, fee account display (3 cards) |
| Component | `src/components/billing/PricingCard.tsx` | 102 | Plan selection cards with features list |

#### Database Changes

| Object | Type | Migration | Description |
|--------|------|-----------|-------------|
| `plans` | Table | 0016 | id (TEXT PK), name, description, price_cents, interval, features (JSONB), is_active, anchor_limit, created_at, updated_at |
| `subscriptions` | Table | 0016 | id (UUID), user_id, org_id, plan_id (FK), stripe_subscription_id (UNIQUE), status, current_period_start/end, cancel_at_period_end, created_at, updated_at |
| `entitlements` | Table | 0016 | id (UUID), user_id, org_id, entitlement_type, value (JSONB), source, expires_at, created_at |
| `billing_events` | Table | 0016 | id (UUID), user_id, org_id, event_type, stripe_event_id (UNIQUE), payload (JSONB), idempotency_key, created_at |
| Append-only trigger | Trigger | 0016 | `reject_audit_modification()` on billing_events — prevents UPDATE/DELETE |
| RLS | Policies | 0016 | 11 policies across 4 tables. Users read own data. Everyone reads active plans. |
| Indexes | B-tree | 0016 | 9 indexes (stripe IDs, status, user_id, event_type, etc.) |

**Seeded Plans:**
| Plan | Price | Anchor Limit |
|------|-------|-------------|
| Free | $0/mo | 5 |
| Individual | $10/mo | 10 |
| Professional | $100/mo | 100 |
| Organization | Custom | Unlimited |

> **Note:** GTM Report March 2026 is the authoritative pricing source ($1K/$3K/custom tiers). Seed data uses lower values for development.

#### UI Components (Not Routed)

**BillingOverview.tsx** (243 lines):
- 3 cards: Current Plan, Monthly Usage, Fee Account
- Usage bar showing anchors used vs limit
- Buttons: Manage Billing, Upgrade Plan, Update Payment Method
- Correct terminology: "Fee Account" (not "Wallet")
- **Not wired to real Supabase queries or routed in App.tsx**

**PricingCard.tsx** (102 lines):
- Pre-defined `PRICING_PLANS` array: Individual ($10/mo), Professional ($100/mo, recommended), Organization (custom)
- Features list, status badges (Current Plan / Recommended), Select/Contact buttons

#### Security Considerations

- RLS on all 4 tables with FORCE ROW LEVEL SECURITY
- Append-only audit trail on billing_events (trigger prevents modification)
- Stripe subscription_id and event_id uniqueness constraints prevent duplicate processing

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| — | — | No dedicated billing tests |

#### Acceptance Criteria

- [x] 4 tables created with proper columns and constraints
- [x] RLS policies on all tables
- [x] Append-only trigger on billing_events
- [x] 9 indexes for query performance
- [x] 4 plans seeded
- [x] BillingOverview component renders 3 cards with correct terminology
- [x] PricingCard renders plan options
- [ ] UI routed in App.tsx with real billing data (deferred)

#### Known Issues

| Issue | Impact |
|-------|--------|
| BillingOverview not routed | Users cannot view billing info in the app |

---

### P7-TS-02: Stripe Checkout Session

**Status:** COMPLETE
**Dependencies:** P7-TS-01 (billing schema), P7-TS-03 (webhook verification)
**Completed:** 2026-03-14 (PR #43 — plan change/downgrade via Billing Portal)

#### What This Story Delivers

A Stripe checkout session creation endpoint in the worker that initiates payment flows. Users select a plan, the worker creates a Stripe checkout session, and the user is redirected to Stripe's hosted checkout page.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Page | `src/pages/PricingPage.tsx` | 190 | Plan selection grid, checkout trigger, billing portal |
| Page | `src/pages/CheckoutSuccessPage.tsx` | 104 | Post-checkout confirmation, billing refresh, plan display |
| Page | `src/pages/CheckoutCancelPage.tsx` | 68 | Checkout cancellation with navigation links |
| Hook | `src/hooks/useBilling.ts` | 183 | startCheckout, openBillingPortal, plan/subscription queries |
| Component | `src/components/billing/PricingCard.tsx` | 102 | Plan card with features, pricing, select button |
| Component | `src/components/billing/BillingOverview.tsx` | 243 | Current plan info, usage bar, manage billing |
| Worker | `services/worker/src/stripe/handlers.ts` | 319 | Webhook handlers: checkout, subscription updates, payment failures |
| Worker | `services/worker/src/stripe/client.ts` | 52 | Stripe SDK + webhook verification |
| Test | `src/pages/PricingPage.test.tsx` | 186 | 12 tests: plan cards, checkout, loading, errors, navigation |
| Test | `src/pages/CheckoutSuccessPage.test.tsx` | ~120 | 7 tests: confirmation, billing refresh, plan display, links |
| Test | `src/pages/CheckoutCancelPage.test.tsx` | 81 | 5 tests: cancel messaging, navigation links |
| Test | `src/hooks/useBilling.test.ts` | 267 | 14 tests: plans fetch, checkout, billing portal, error states |
| Test | `src/components/billing/BillingOverview.test.tsx` | ~100 | Component tests for plan display |
| Test | `src/components/billing/PricingCard.test.tsx` | ~100 | Component tests for plan cards |
| Test | `services/worker/src/stripe/handlers.test.ts` | ~350 | 38 tests: routing, idempotency, checkout, subscription CRUD |
| Worker | `services/worker/src/index.ts` | — | `POST /api/billing/checkout` + `POST /api/billing/portal` routes with JWT auth |
| Test | `src/pages/WebhookSettingsPage.test.tsx` | ~150 | 11 integration tests |

#### What Exists (Infrastructure + UI)

- Stripe SDK initialized in `services/worker/src/stripe/client.ts`
- `MockStripeClient.createCheckoutSession()` returns mock URL
- Webhook verification working (P7-TS-03)
- **PricingPage** with plan grid, checkout trigger via `useBilling.startCheckout()`
- **CheckoutSuccessPage** with delayed billing refresh + plan display
- **CheckoutCancelPage** with navigation back to pricing/dashboard
- **useBilling hook** with `startCheckout()`, `openBillingPortal()`, plan/subscription queries
- **BillingOverview** renders current plan, usage, manage billing button
- **PricingCard** renders plan features, pricing, selection
- **handlers.ts** processes `checkout.session.completed`, subscription updates/deletes, payment failures
- **91 frontend tests + 38 worker tests = 129 total tests** covering all checkout/billing paths

#### Completion Summary

All billing flows implemented:
- ~~`POST /api/checkout/session` worker endpoint not yet wired~~ — DONE (b1f798a)
- ~~Entitlement enforcement~~ — DONE: `useEntitlements` hook (fail-closed), `check_anchor_quota()` RPC, server-side quota in `bulk_create_anchors()` (migration 0049), `ConfirmAnchorModal` quota gate, `UpgradePrompt` component
- ~~Plan change/downgrade flows~~ — DONE (PR #43): Existing subscribers routed to Stripe Billing Portal. `handleSubscriptionUpdated` detects plan changes by resolving plan_id from subscription price items. Cancellation scheduled handling. 7 new webhook tests (44 total handler tests).

#### Acceptance Criteria (From Backlog)

- [x] Worker exposes `POST /checkout/session` endpoint (b1f798a: `POST /api/billing/checkout`)
- [x] Endpoint creates Stripe checkout session with correct plan pricing
- [x] Success/cancel URLs redirect back to app (pages exist)
- [x] PricingCard "Select" button triggers checkout flow (wired to `useBilling.startCheckout()`)
- [x] Subscription created in DB after `checkout.session.completed` webhook (handlers.ts)
- [x] Free tier users can upgrade to paid plans (via Billing Portal or Checkout)
- [x] Billing portal available for existing subscribers (`useBilling.openBillingPortal()`)
- [x] Free tier users can upgrade to paid plans (via Billing Portal or Checkout)

#### Test Coverage (2026-03-11 ~2:30 PM EST / ~5:30 AM AEDT Mar 12, updated 2026-03-14)

| File | Tests | Coverage |
|------|-------|----------|
| `PricingPage.test.tsx` | 12 | Plan display, checkout, loading, errors, navigation |
| `CheckoutSuccessPage.test.tsx` | 7 | Confirmation, refresh delay, plan display, links |
| `CheckoutCancelPage.test.tsx` | 5 | Cancel messaging, navigation links |
| `useBilling.test.ts` | 14 | Plans fetch, checkout, billing portal, errors |
| `BillingOverview.test.tsx` | varies | Component rendering |
| `PricingCard.test.tsx` | varies | Card display, selection |
| `handlers.test.ts` | 38 | Routing, idempotency, checkout, subscriptions, payments |
| `WebhookSettingsPage.test.tsx` | 11 | Integration tests |
| **Total** | **91+** | All checkout/billing paths covered |

#### Known Issues

| Issue | Impact |
|-------|--------|
| ~~CRIT-3~~ | ~~RESOLVED 2026-03-14. All flows complete: checkout, billing portal, plan change/downgrade, cancellation.~~ |

#### Change Log

| Date | Change |
|------|--------|
| 2026-03-11 ~2:30 PM EST / ~5:30 AM AEDT Mar 12 | Test suite complete: 62 new tests (38 handlers, 12 pricing, 7 success, 5 cancel). Status NOT STARTED → PARTIAL. |
| 2026-03-11 ~8:00 PM EST | Checkout + billing portal worker endpoints wired with JWT auth (b1f798a). IDOR fix. CRIT-3 narrowed to entitlements + downgrade. |
| 2026-03-14 ~3:00 PM EST | Plan change/downgrade via Billing Portal (PR #43). handleSubscriptionUpdated detects plan changes. 7 new tests. Status PARTIAL → COMPLETE. CRIT-3 RESOLVED. |

---

### P7-TS-03: Stripe Webhook Verification

**Status:** COMPLETE
**Dependencies:** P7-TS-01 (billing schema for event storage)
**Blocked by:** None

#### What This Story Delivers

Stripe webhook signature verification ensuring that incoming webhook events are authentic. The worker validates the `Stripe-Signature` header using `stripe.webhooks.constructEvent()` and dispatches events to type-specific handlers.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Client | `services/worker/src/stripe/client.ts` | 52 | Stripe SDK instance + `verifyWebhookSignature()` |
| Handlers | `services/worker/src/stripe/handlers.ts` | 156 | Event dispatcher + type-specific handlers |
| Mock | `services/worker/src/stripe/mock.ts` | 93 | MockStripeClient for tests |
| Route | `services/worker/src/index.ts` | — | `POST /webhooks/stripe` at lines 32-55 |

#### Database Changes

None (uses existing `audit_events` table for logging).

#### Webhook Route Configuration

- **Route:** `POST /webhooks/stripe`
- **Body parser:** `express.raw({ type: 'application/json' })` — raw body required for signature verification
- **Signature header:** `Stripe-Signature` (required in production, optional in mock mode)
- **Returns:** 200 on success, 400 on missing/invalid signature

#### Verification Flow

1. Extract raw body and `Stripe-Signature` header
2. Call `verifyWebhookSignature(payload, signature)`
   - Production: `stripe.webhooks.constructEvent(payload, signature, STRIPE_WEBHOOK_SECRET)`
   - Mock/test: `JSON.parse(payload)` without verification
3. Pass verified event to `handleStripeWebhook(event)`
4. Handler dispatches by `event.type`:
   - `checkout.session.completed` — updates profile (stub)
   - `customer.subscription.updated` — logs update
   - `customer.subscription.deleted` — downgrades to free (stub)
   - `invoice.payment_failed` — logs failure

#### Security Considerations

- **Signature verification mandatory in production** — `stripe.webhooks.constructEvent()` validates HMAC
- **Raw body required** — JSON parsing before verification would break signature check
- **Webhook secret from env** — `STRIPE_WEBHOOK_SECRET` loaded from environment
- **Mock mode** — skips verification in test/development (controlled by `config.useMocks`)

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| — | — | No dedicated webhook tests |

**Note:** MockStripeClient exists for test isolation. `constructEvent()` mock does JSON.parse without signature check.

#### Acceptance Criteria

- [x] `verifyWebhookSignature()` calls `stripe.webhooks.constructEvent()` in production
- [x] Raw body parsing configured for webhook route
- [x] Signature header required (returns 400 if missing in production)
- [x] Event dispatched to type-specific handlers
- [x] Mock mode skips verification for tests
- [x] Audit events logged for each webhook processed

#### Known Issues

| Issue | Impact |
|-------|--------|
| Event handlers are stubs | Subscription lifecycle not fully wired |
| Idempotency check always returns false | Duplicate event processing possible |

---

### P7-TS-05: Real Bitcoin Chain Client

**Status:** COMPLETE (OPS-ONLY items remain — no code work left)
**Dependencies:** P7-TS-01 (billing — entitlement check before anchoring)
**Completed:** 2026-03-12 (code), 2026-03-15 (reclassified to COMPLETE)
**Operational items:** AWS KMS key provisioning (follow `docs/confluence/14_kms_operations.md`), mainnet treasury funding. See `docs/confluence/15_operational_runbook.md`. Signet E2E broadcast verified (TX `b8e381df`).

#### What This Story Delivers

A real Bitcoin chain client implementing the `ChainClient` interface with OP_RETURN transaction construction, Bitcoin network submission, and AWS KMS-based signing. Replaces `MockChainClient` as the production implementation. Uses provider abstractions for signing, fee estimation, and UTXO management that support signet, testnet, and mainnet from a single `BitcoinChainClient`.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Factory | `services/worker/src/chain/client.ts` | ~236 | Async factory (`initChainClient()` / `getInitializedChainClient()`) + `SupabaseChainIndexLookup` |
| Bitcoin | `services/worker/src/chain/signet.ts` | ~300 | `BitcoinChainClient` (renamed from `SignetChainClient`, alias kept) — OP_RETURN construction, PSBT, `ARKV` prefix |
| Signing | `services/worker/src/chain/signing-provider.ts` | ~120 | `WifSigningProvider` (ECPair) + `KmsSigningProvider` (AWS KMS) |
| Fees | `services/worker/src/chain/fee-estimator.ts` | ~80 | `StaticFeeEstimator` + `MempoolFeeEstimator` |
| UTXOs | `services/worker/src/chain/utxo-provider.ts` | ~200 | `RpcUtxoProvider` + `MempoolUtxoProvider` + factory |
| Wallet | `services/worker/src/chain/wallet.ts` | ~80 | Treasury wallet utilities (keypair gen, address derivation, WIF validation) |
| Interface | `services/worker/src/chain/types.ts` | 74 | `ChainClient` + `ChainIndexLookup` + `IndexEntry` interfaces |
| Mock | `services/worker/src/chain/mock.ts` | 79 | MockChainClient with in-memory receipt storage |
| Migration | `supabase/migrations/0050_anchor_chain_index.sql` | — | `anchor_chain_index` table for O(1) fingerprint verification |

#### Architecture

```text
BitcoinChainClient
  ├── SigningProvider   (WifSigningProvider | KmsSigningProvider)
  ├── FeeEstimator      (StaticFeeEstimator | MempoolFeeEstimator)
  ├── UtxoProvider      (RpcUtxoProvider | MempoolUtxoProvider)
  └── ChainIndexLookup  (SupabaseChainIndexLookup — O(1) verification)
```

**Factory:** `initChainClient()` initializes the singleton at startup (async — KMS needs network call). `getInitializedChainClient()` returns it synchronously in hot paths like `processAnchor()`.

**Paths:**
- `config.useMocks || nodeEnv === 'test'` → `MockChainClient`
- `enableProdNetworkAnchoring + signet/testnet + WIF` → `BitcoinChainClient` with `WifSigningProvider`
- `enableProdNetworkAnchoring + mainnet + KMS key` → `BitcoinChainClient` with `KmsSigningProvider`
- All other cases → `MockChainClient` (safe fallback)

#### Current State (Updated 2026-03-12)

All code for CRIT-2 is complete. `BitcoinChainClient` implements the full `ChainClient` interface using `bitcoinjs-lib`, `ecpair`, and `tiny-secp256k1`. OP_RETURN transactions embed a 4-byte `ARKV` prefix followed by the SHA-256 fingerprint. Provider abstractions decouple signing (WIF vs KMS), fee estimation (static vs live), and UTXO sourcing (RPC vs Mempool.space). `SupabaseChainIndexLookup` provides O(1) fingerprint verification via the `anchor_chain_index` table (migration 0050). Chain index is populated via non-fatal upsert in `processAnchor()` after SECURED status is set.

#### Completion Gaps (Operational Only — No Code Remaining)

- Signet E2E connectivity test — treasury funded (500,636 sats at `mx1zmGtQTghi4GWcJaV1oPwJ5TKhGfFpjs`), awaiting UTXO confirmation for first real OP_RETURN broadcast
- AWS KMS key provisioning in AWS console (mainnet signing)
- Mainnet treasury funding

#### Acceptance Criteria (From Backlog)

- [x] `bitcoinjs-lib` installed and configured
- [x] OP_RETURN transaction builds with embedded fingerprint
- [ ] Signet submission and verification working (code complete, treasury funded 500,636 sats, awaiting UTXO confirmation for first broadcast)
- [ ] AWS KMS signs transactions (mainnet) — code complete (`KmsSigningProvider`), key provisioning pending
- [x] `getInitializedChainClient()` returns real client when `enableProdNetworkAnchoring=true`
- [x] ChainReceipt populated with real block height, timestamp, receipt ID
- [x] Health check verifies Bitcoin node connectivity
- [x] Provider abstractions for signing, fees, UTXOs
- [x] Chain index for O(1) fingerprint verification (P7-TS-13)

#### Test Coverage (Updated 2026-03-12 ~5:30 AM EST)

| Test File | Type | Tests | Coverage |
|-----------|------|-------|----------|
| `services/worker/src/chain/signet.test.ts` | Unit | 47 | OP_RETURN construction, constructor validation, healthCheck, submitFingerprint, getReceipt, verifyFingerprint, broadcast edge cases, PSBT validation via buildDummyFundingTx |
| `services/worker/src/chain/client.test.ts` | Unit | 28 | Async factory, SupabaseChainIndexLookup, signet/mainnet/mock paths, provider validation, `bitcoin.networks.bitcoin` for mainnet |
| `services/worker/src/chain/utxo-provider.test.ts` | Unit | 34 | RpcUtxoProvider + MempoolUtxoProvider + factory, confirmed-only filtering |
| `services/worker/src/chain/wallet.test.ts` | Unit | 13 | generateSignetKeypair, addressFromWif, isValidSignetWif |
| `services/worker/src/chain/signet.integration.test.ts` | Integration | 8 | Real TX construction + signing: generated keypair, known WIF, large UTXO, dust change, invalid fingerprint, different fingerprints → different txIds, scriptSig DER+pubkey, broadcast skip doc |
| `services/worker/src/chain/mock.test.ts` | Unit | 18 | 100% on `mock.ts` — interface contract, submit/verify/getReceipt/healthCheck |
| `services/worker/src/jobs/anchor.test.ts` | Unit | 46 | 100% on `anchor.ts` — processAnchor + processPendingAnchors (query shape, failure isolation, completion, webhook dispatch, chain index upsert) |

#### Known Issues

| Issue | Impact |
|-------|--------|
| CRIT-2 (code complete, operational pending) | All code implemented. Remaining: Signet E2E broadcast, AWS KMS key provisioning, mainnet treasury funding. |
| Signet E2E pending | Treasury funded (500,636 sats), awaiting UTXO confirmation. First real OP_RETURN broadcast blocked on confirmation. |
| `(db as any)` cast | `anchor_chain_index` queries use `(db as any)` until `database.types.ts` regenerated with migration 0050 |

---

### P7-TS-07: Proof Package Export

**Status:** COMPLETE
**Dependencies:** P4-TS-02 (AssetDetailView), P6-TS-05 (PDF generation)
**Blocked by:** None (~~CRIT-5~~ resolved 2026-03-10, commit a38b485)

#### What This Story Delivers

Export of verification proof packages in PDF and JSON formats. PDF export is complete via `generateAuditReport.ts`. JSON export uses Zod-validated schema and download utility in `proofPackage.ts`. Both download handlers are wired in `RecordDetailPage` and `AssetDetailView`.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Schema | `src/lib/proofPackage.ts` | 171 | Zod schema + `generateProofPackage()` + `downloadProofPackage()` |
| PDF | `src/lib/generateAuditReport.ts` | 200 | jsPDF certificate (see P6-TS-05) |
| Component | `src/components/public/ProofDownload.tsx` | 188 | PDF/JSON download buttons (JSON handler is no-op) |

#### Proof Package Schema (v1.0)

The `ProofPackageSchema` (Zod) defines:
- `version`: "1.0"
- `document`: filename, fingerprint (SHA-256), file_size, credential_type
- `verification`: public_id, status, verified (boolean), issuer_name, issued_date, expiry_date
- `network_receipt`: receipt_id, block_height, block_timestamp, confirmations, observed_time
- `proof`: merkle_proof_hash (nullable), record_uri
- `metadata`: generated_at, generator ("Arkova"), schema_version

#### Download Functions

- `generateProofPackage(anchor, proof?)` — constructs and validates proof package from anchor data
- `downloadProofPackage(proofPackage, filename)` — creates Blob, triggers browser download
- `getProofPackageFilename(basename, publicId)` — generates `arkova-proof-{basename}-{publicId}.json`
- `validateProofPackage(data)` — validates unknown data against schema

#### Implementation Notes

- `ProofDownload.tsx` has two buttons: "PDF Certificate" and "JSON Data"
- PDF button calls `onDownloadPDF` callback — **working** (calls `generateAuditReport()`)
- JSON button calls `onDownloadJSON` callback — **working** (~~CRIT-5~~ FIXED commit a38b485)
- `downloadProofPackage()` wired via `onDownloadProofJson` in RecordDetailPage + AssetDetailView

#### Security Considerations

- Proof package contains only public-safe fields (no internal IDs)
- Schema validated with Zod before download

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| `src/lib/proofPackage.test.ts` | Unit | Schema validation, generation, download, filename generation (33 tests, 100% coverage — PR-HARDENING-1) |

#### Acceptance Criteria

- [x] Proof package Zod schema defined (v1.0)
- [x] `generateProofPackage()` constructs valid package from anchor data
- [x] `downloadProofPackage()` triggers browser download
- [x] PDF export working via `generateAuditReport()`
- [x] JSON download button wired to `downloadProofPackage()` (~~CRIT-5~~ FIXED)
- [x] JSON output matches ProofPackageSchema

#### Known Issues

None. ~~CRIT-5~~ resolved 2026-03-10 (commit a38b485).

---

### P7-TS-08: Audit Report PDF

**Status:** COMPLETE
**Dependencies:** P4-TS-02 (AssetDetailView)
**Blocked by:** None

#### What This Story Delivers

Full PDF certificate generation using jsPDF. This is the same implementation documented in P6-TS-05. See that story for complete details.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Generator | `src/lib/generateAuditReport.ts` | 200 | jsPDF PDF generation with 7 sections |

#### Acceptance Criteria

- [x] All acceptance criteria from P6-TS-05 met
- [x] PDF includes all 7 sections (header, status, document, issuer, crypto proof, lifecycle, disclaimer)
- [x] Status "SECURED" displayed as "VERIFIED"
- [x] Disclaimer clearly states what is and is not asserted

See [P6-TS-05 in 07_p6_verification.md](./07_p6_verification.md#p6-ts-05-pdf-audit-report-proof-certificate) for full documentation.

---

### P7-TS-09: Webhook Settings

**Status:** COMPLETE
**Dependencies:** P7-TS-01 (billing — org context)
**Completed:** 2026-03-11 ~1:00 AM EST / 2026-03-11 ~5:00 PM AEDT

#### What This Story Delivers

Webhook endpoint management: database schema for endpoints and delivery logs, a UI component for configuring webhook URLs and events, server-side secret generation via SECURITY DEFINER RPCs, and a delivery engine with exponential backoff and HMAC-SHA256 signing.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Migration | `supabase/migrations/0018_outbound_webhooks.sql` | 130 | webhook_endpoints + webhook_delivery_logs tables |
| Migration | `supabase/migrations/0046_webhook_secret_server_generation.sql` | ~80 | SECURITY DEFINER RPCs for server-side secret generation + audit logging |
| Component | `src/components/webhooks/WebhookSettings.tsx` | 315 | Two-phase dialog: creation form → one-time secret display |
| Page | `src/pages/WebhookSettingsPage.tsx` | 107 | Supabase RPC integration for endpoint CRUD |
| Delivery | `services/worker/src/webhooks/delivery.ts` | 259 | Dispatch + delivery + retry engine |
| Test | `src/components/webhooks/WebhookSettings.test.tsx` | 417 | 23 component tests (dialog, validation, secret display, actions) |
| Test | `src/pages/WebhookSettingsPage.test.tsx` | 339 | 11 integration tests (RPC calls, data fetching, edge cases) |

#### Database Changes

| Object | Type | Migration | Description |
|--------|------|-----------|-------------|
| `webhook_endpoints` | Table | 0018 | id, org_id, url (https:// enforced), secret (raw, RLS-protected), events (TEXT[]), is_active, description, created_by, timestamps |
| `webhook_delivery_logs` | Table | 0018 | id, endpoint_id, event_type, event_id, payload (JSONB), attempt_number, status (pending/success/failed/retrying), response_status/body, error_message, next_retry_at, idempotency_key, timestamps |
| `create_webhook_endpoint` | RPC | 0046 | SECURITY DEFINER — generates 64-char hex secret via `pgcrypto gen_random_bytes(32)`, inserts endpoint, logs audit event, returns id + secret |
| `delete_webhook_endpoint` | RPC | 0046 | SECURITY DEFINER — validates org ownership, deletes endpoint, logs audit event |
| RLS | Policies | 0018 | ORG_ADMIN only on both tables (SELECT, INSERT, UPDATE, DELETE) |

#### UI Component

**WebhookSettings.tsx** (315 lines) — Two-phase dialog pattern:
- **Phase 1 — Creation form:** URL input (HTTPS validation), event checkboxes (anchor.secured, anchor.revoked, anchor.created), default events pre-selected
- **Phase 2 — Secret display:** One-time display of server-generated signing secret, copy-to-clipboard button, security warning about single display
- **Endpoint list:** URL, event badges, active/inactive status icon, enable/disable toggle, delete button
- **Callbacks:** `onAdd(url, events) → Promise<string>` (returns secret), `onDelete(id)`, `onToggle(id, isActive)`

**WebhookSettingsPage.tsx** (107 lines):
- Calls `supabase.rpc('create_webhook_endpoint', { p_url, p_events })` — server generates secret
- Calls `supabase.rpc('delete_webhook_endpoint', { p_endpoint_id })` — server validates ownership
- Toggle via direct `supabase.from('webhook_endpoints').update({ is_active })`
- Refetches endpoint list after each mutation

#### Delivery Engine

**delivery.ts** (259 lines):
- `dispatchWebhookEvent(orgId, eventType, eventId, data)` — queries matching active endpoints, dispatches to all
- `deliverToEndpoint(endpoint, payload, attempt)` — POST with HMAC-SHA256 signature headers:
  - `X-Arkova-Signature`: HMAC-SHA256(payload + timestamp, secret)
  - `X-Arkova-Timestamp`: Unix timestamp
  - `X-Arkova-Event`: Event type string
- **Retry policy:** MAX_RETRIES=5, exponential backoff (1s, 2s, 4s, 8s, 16s)
- **Idempotency:** Deduplication via `idempotency_key` in delivery logs
- **Status tracking:** pending -> success/failed -> retrying (on HTTP error) -> failed (after 5 retries)
- **Feature flag:** `ENABLE_OUTBOUND_WEBHOOKS` checked before dispatching

#### Security Considerations

- RLS: ORG_ADMIN only on both tables
- HTTPS enforced on webhook URLs (client + server validation)
- Server-side secret generation via `pgcrypto gen_random_bytes(32)` — secret never transmitted from client
- Secret shown once at creation, then write-only (never retrieved after dialog closes)
- SECURITY DEFINER RPCs with `SET search_path = public`
- HMAC-SHA256 payload signing in delivery headers
- Delivery logs are append-only with status tracking
- Audit events logged for create + delete operations
- Feature flag gates the entire webhook system

#### Test Coverage

| Test File | Type | Tests | What It Validates |
|-----------|------|-------|-------------------|
| `src/components/webhooks/WebhookSettings.test.tsx` | Unit | 23 | Two-phase dialog, URL validation, event checkboxes, secret display, clipboard copy, enable/disable/delete, empty/loading states |
| `src/pages/WebhookSettingsPage.test.tsx` | Integration | 11 | Supabase RPC calls (create/delete), data fetching, server-generated secret display, error handling, toggle, edge cases |
| `services/worker/src/webhooks/delivery.test.ts` | Unit | 30 | HMAC signing, retry backoff, idempotency, status tracking (from HARDENING-3) |
| **Total** | | **64** | |

#### Acceptance Criteria

- [x] `webhook_endpoints` table with RLS (ORG_ADMIN only)
- [x] `webhook_delivery_logs` table with status tracking
- [x] UI component for endpoint CRUD
- [x] Server-side secret generation via SECURITY DEFINER RPC (pgcrypto)
- [x] One-time secret display with copy-to-clipboard
- [x] HMAC-SHA256 signing in delivery headers
- [x] Exponential backoff retry (5 retries)
- [x] Idempotency deduplication via delivery logs
- [x] Feature flag gating
- [x] Audit events for create/delete operations
- [x] 34 dedicated webhook settings tests (23 component + 11 integration)

#### Known Issues

None.

---

### P7-TS-10: Webhook Dispatch on Anchor Secure

**Status:** COMPLETE
**Dependencies:** P7-TS-09 (webhook infrastructure), P7-TS-05 (chain client for SECURED status)
**Blocked by:** None

#### What This Story Delivers

Connecting the anchor lifecycle to webhook delivery. When an anchor transitions to SECURED status, the worker dispatches a webhook event to all matching endpoints for the anchor's organization. Completed in HARDENING-4.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Anchor Job | `services/worker/src/jobs/anchor.ts` | 136 | processAnchor() — chain → SECURED → audit → webhook dispatch |
| Delivery | `services/worker/src/webhooks/delivery.ts` | 259 | dispatchWebhookEvent() + processWebhookRetries() |
| Cron | `services/worker/src/index.ts` | 143 | processWebhookRetries scheduled every 2 minutes |
| Webhook Job | `services/worker/src/jobs/webhook.ts` | 110 | Legacy stub (superseded by delivery.ts) |

#### Anchor Processing Flow (Complete)

**anchor.ts — processAnchor(anchorId):**
1. Fetch PENDING anchor from Supabase
2. Call `chainClient.submitFingerprint()` (currently MockChainClient)
3. Update anchor status to SECURED with chain receipt data
4. Log audit event (`anchor.secured`) — non-fatal
5. Dispatch webhook via `dispatchWebhookEvent()` — non-fatal, skipped if no `org_id`

Webhook dispatch is wrapped in try/catch. If it fails, the anchor remains SECURED and a warning is logged. Individual users without an organization skip webhook dispatch entirely.

#### Webhook Payload

```typescript
{
  anchor_id: anchorId,
  public_id: anchor.public_id ?? null,
  fingerprint: anchor.fingerprint,
  status: 'SECURED',
  chain_tx_id: receipt.receiptId,
  chain_block_height: receipt.blockHeight,
  secured_at: receipt.blockTimestamp,
}
```

#### Security Considerations

- Webhook dispatch runs with service_role privileges (worker context)
- Delivery engine handles HMAC-SHA256 signing and retry logic
- Feature flag `ENABLE_OUTBOUND_WEBHOOKS` must be enabled
- Failed retries processed every 2 minutes via cron

#### Test Coverage (Updated HARDENING-4, 2026-03-10 5:20 PM EST)

| Test File | Type | Tests | What It Validates |
|-----------|------|-------|-------------------|
| `services/worker/src/jobs/anchor.test.ts` | Unit | 46 | processAnchor + processPendingAnchors + webhook dispatch — 100% coverage |
| `services/worker/src/jobs/anchor-lifecycle.test.ts` | Integration | 8 | Full lifecycle: PENDING → SECURED → audit → webhook (stateful DB mock) |
| `services/worker/src/webhooks/delivery.test.ts` | Unit | 30 | HMAC signing, backoff, feature flag, idempotency, HTTP success/error |

#### Acceptance Criteria

- [x] Delivery engine complete with HMAC signing and retry
- [x] `dispatchWebhookEvent()` function ready to call
- [x] `anchor.ts` has 100% test coverage (HARDENING-1 + 2)
- [x] `anchor.ts` calls `dispatchWebhookEvent()` after SECURED update (HARDENING-4)
- [x] Webhook fires with correct payload (public_id, fingerprint, status, receipt) (HARDENING-4)
- [x] `delivery.ts` unit tests — 30 tests, 99% coverage (HARDENING-3)
- [x] Lifecycle integration test — 8 tests (HARDENING-4)
- [x] `processWebhookRetries()` wired to cron schedule (HARDENING-4)

#### Known Issues

| Issue | Impact |
|-------|--------|
| webhook.ts is stale stub | Legacy file — references "webhook_configs" instead of "webhook_endpoints". Superseded by delivery.ts. |

---

### P7-TS-11 — Signet Treasury Wallet Setup

**Status:** COMPLETE
**Dependencies:** P7-TS-05 (SignetChainClient)
**Story:** P7-TS-11

#### What It Delivers

Reusable wallet utility module and CLI scripts for Signet treasury wallet management. Enables operators to generate keypairs, derive addresses from WIF, validate WIF strings, and check treasury balance via Bitcoin RPC.

#### Files

| File | Purpose |
|------|---------|
| `services/worker/src/chain/wallet.ts` | Reusable wallet utilities: `generateSignetKeypair()`, `addressFromWif()`, `isValidSignetWif()`, `SIGNET_NETWORK` |
| `services/worker/src/chain/wallet.test.ts` | 13 unit tests covering all wallet utilities |
| `services/worker/scripts/generate-signet-keypair.ts` | CLI: generate new Signet keypair (WIF + P2PKH address) |
| `services/worker/scripts/check-signet-balance.ts` | CLI: check treasury balance via Bitcoin RPC (`getblockchaininfo`, `listunspent`) |

#### Implementation Details

- **Keypair generation:** `ECPair.makeRandom()` with `SIGNET_NETWORK` (testnet params), P2PKH address derivation via `bitcoin.payments.p2pkh()`
- **Address derivation:** `ECPair.fromWIF()` → P2PKH. Validates WIF is parseable for Signet network.
- **Balance checker:** Connects to Signet RPC node, verifies chain info, lists UTXOs for treasury address, estimates anchoring capacity (~478 sats per OP_RETURN tx at 2 sat/vbyte)
- **Security:** WIF printed once to stdout by generator script. Never logged or committed (Constitution 1.4). Scripts load from `.env` via dotenv.

#### Test Coverage

| File | Tests | Coverage |
|------|-------|----------|
| `wallet.test.ts` | 13 | Keypair generation, WIF round-trip, mainnet rejection, invalid input, uniqueness |

#### Acceptance Criteria

- [x] `generateSignetKeypair()` returns valid WIF + P2PKH address
- [x] `addressFromWif()` derives correct address from WIF (round-trip verified)
- [x] `isValidSignetWif()` rejects mainnet WIF, empty strings, and garbage input
- [x] `generate-signet-keypair.ts` script runs via `npx tsx`
- [x] `check-signet-balance.ts` script runs via `npx tsx` and queries RPC
- [x] All 13 tests pass
- [x] WIF never logged, committed, or persisted outside `.env`

#### Usage

```bash
# Generate a new keypair
cd services/worker
npx tsx scripts/generate-signet-keypair.ts

# Check treasury balance (requires .env with BITCOIN_TREASURY_WIF + BITCOIN_RPC_URL)
npx tsx scripts/check-signet-balance.ts
```

---

### P7-TS-12 — UTXO Provider Pattern + Mempool.space Integration

**Status:** COMPLETE
**Dependencies:** P7-TS-05 (SignetChainClient), P7-TS-11 (Wallet Utilities)
**Story:** P7-TS-12

#### What It Delivers

A pluggable UTXO provider abstraction that decouples the SignetChainClient from any specific Bitcoin node or API backend. Two implementations ship: `RpcUtxoProvider` (Bitcoin Core JSON-RPC) and `MempoolUtxoProvider` (Mempool.space REST API). The Mempool provider is the default — it requires no local Bitcoin node, making development and deployment significantly simpler.

The factory also updates the chain client wiring (`client.ts`) and configuration (`config.ts`) so the provider type is selectable via environment variable `BITCOIN_UTXO_PROVIDER` (default: `mempool`).

#### Files

| File | Purpose |
|------|---------|
| `services/worker/src/chain/utxo-provider.ts` | `UtxoProvider` interface + `RpcUtxoProvider` + `MempoolUtxoProvider` + `createUtxoProvider()` factory |
| `services/worker/src/chain/utxo-provider.test.ts` | 35+ tests: RPC provider (listUnspent, broadcastTx, getBlockchainInfo, getRawTransaction, getBlockHeader, auth), Mempool provider (confirmed filtering, broadcast, chain inference, URL handling), factory |
| `services/worker/src/chain/client.ts` | Updated: uses `createUtxoProvider()` factory, validates provider-specific config |
| `services/worker/src/config.ts` | Added `bitcoinUtxoProvider` (enum: 'rpc' | 'mempool', default: 'mempool') and `mempoolApiUrl` (optional URL override) |
| `services/worker/src/chain/signet.ts` | Updated: accepts `SignetConfig` with `utxoProvider` field; backward-compatible `LegacySignetConfig` |
| `services/worker/src/chain/signet.test.ts` | Rewritten: uses mock `UtxoProvider` instead of raw fetch mocks |

#### Interface

```typescript
interface UtxoProvider {
  name: string;
  listUnspent(address: string): Promise<Utxo[]>;
  broadcastTx(txHex: string): Promise<{ txid: string }>;
  getBlockchainInfo(): Promise<{ chain: string; blocks: number }>;
  getRawTransaction(txid: string): Promise<RawTransaction>;
  getBlockHeader(blockhash: string): Promise<{ height: number }>;
}
```

#### Configuration

| Env Var | Type | Default | Description |
|---------|------|---------|-------------|
| `BITCOIN_UTXO_PROVIDER` | `'rpc' \| 'mempool'` | `mempool` | Which UTXO backend to use |
| `MEMPOOL_API_URL` | URL (optional) | `https://mempool.space/signet/api` | Override Mempool.space endpoint |
| `BITCOIN_RPC_URL` | URL (optional) | — | Required only when provider is 'rpc' |
| `BITCOIN_RPC_AUTH` | string (optional) | — | RPC Basic auth credentials |

#### Security Considerations

- RPC auth uses HTTP Basic auth header (never logged)
- Mempool.space is a public API — no auth required for reads
- All network calls mocked in tests (Constitution 1.7)
- Provider selection validated at factory level — unknown types throw

#### Test Coverage

| File | Tests | What It Validates |
|------|-------|-------------------|
| `utxo-provider.test.ts` | 35+ | RPC CRUD ops, Mempool confirmed filtering, chain inference from URL, factory validation, auth headers, error handling |
| `signet.test.ts` | 15+ | Updated to use mock UtxoProvider; selectUtxo, estimateTxVsize, buildOpReturnTransaction, client lifecycle |
| `client.test.ts` | 8 | Factory returns correct client type based on config (includes provider validation) |

#### Acceptance Criteria

- [x] `UtxoProvider` interface defined with 5 methods + `name` property
- [x] `RpcUtxoProvider` wraps Bitcoin Core JSON-RPC (listunspent, sendrawtransaction, getblockchaininfo, getrawtransaction, getblockheader)
- [x] `MempoolUtxoProvider` wraps Mempool.space REST API (confirmed UTXOs only, chain inference from URL)
- [x] `createUtxoProvider()` factory validates config and selects implementation
- [x] `config.ts` adds `bitcoinUtxoProvider` and `mempoolApiUrl` fields
- [x] `client.ts` uses factory to create provider before passing to SignetChainClient
- [x] SignetChainClient accepts both new `SignetConfig` (utxoProvider) and legacy `LegacySignetConfig` (rpcUrl)
- [x] All network calls mocked in tests — no real Bitcoin API calls
- [x] Default provider is `mempool` (no local node required)
- [x] MempoolUtxoProvider strips trailing slashes from base URL

---

### P7-TS-13 — Fingerprint Indexing for Efficient Verification Lookup

**Status:** COMPLETE (implemented as part of CRIT-2 Steps 5-8)
**Dependencies:** P7-TS-05 (BitcoinChainClient), P7-TS-12 (UTXO Provider)
**Story:** P7-TS-13

#### What It Delivers

O(1) fingerprint verification via a Supabase-backed chain index, replacing the previous O(n) UTXO scan approach.

#### Implementation

Option 1 (local index table) was chosen and implemented during CRIT-2:

| Component | File | What It Does |
|-----------|------|--------------|
| `ChainIndexLookup` interface | `chain/types.ts` | `lookupFingerprint(fingerprint): Promise<IndexEntry \| null>` |
| `SupabaseChainIndexLookup` | `chain/client.ts` | Queries `anchor_chain_index` table for O(1) lookup |
| `anchor_chain_index` table | Migration 0050 | `(fingerprint_sha256, chain_tx_id, chain_block_height, chain_block_timestamp, confirmations, anchor_id)` with unique constraint on `(fingerprint_sha256, chain_tx_id)` |
| Chain index upsert | `jobs/anchor.ts` | Non-fatal upsert in `processAnchor()` after SECURED status set |
| Factory integration | `chain/client.ts` | `initChainClient()` creates `SupabaseChainIndexLookup` and passes to `BitcoinChainClient` |

#### How It Works

1. When `processAnchor()` secures an anchor, it upserts an entry into `anchor_chain_index` with the fingerprint, tx ID, block height, and timestamp
2. `BitcoinChainClient.verifyFingerprint()` first checks the `ChainIndexLookup` — if found, returns immediately (O(1))
3. If index miss, falls back to UTXO scan (backward compatibility for pre-index anchors)
4. The upsert is non-fatal — if it fails, the anchor is still SECURED (chain index is a read optimization)

#### Acceptance Criteria

- [x] `verifyFingerprint()` completes in O(1) via `SupabaseChainIndexLookup`
- [x] Lookup works for both recently anchored and historical fingerprints (via index + fallback)
- [x] Index is populated automatically during `processAnchor()` flow (non-fatal upsert)
- [x] Fallback to UTXO scan if index miss (backward compatibility)
- [x] Tests validate indexed path (`client.test.ts` — 28 tests including `SupabaseChainIndexLookup`)
- [x] Migration 0050 creates `anchor_chain_index` table with proper constraints

#### Known Issues

- `(db as any)` cast required for `anchor_chain_index` queries until `database.types.ts` is regenerated with migration 0050 (requires `supabase link` to production project)

---

## Not Started Stories (Stubs)

### P7-TS-04 & P7-TS-06

These story IDs are not listed in CLAUDE.md Section 8. They may be:
- Skipped or renumbered in the backlog
- Merged into other stories
- Part of a different phase

Check the Technical Backlog PDF for actual story cards if they exist.

---

## Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| Worker-only SECURED status | Client code cannot be trusted to set anchor status — service_role enforces |
| Mock/real toggle via config | Same code paths in dev/test/prod, only implementation differs |
| Worker hardening before chain | 0% test coverage means any integration will build on untested foundation |
| Stripe constructEvent() mandatory | Only reliable way to verify webhook authenticity |
| Append-only billing_events | Financial audit trail must be immutable |
| Exponential backoff for webhooks | Standard reliability pattern (1s, 2s, 4s, 8s, 16s) |
| HMAC-SHA256 webhook signing | Industry standard (Stripe, GitHub use same pattern) |

## Migration Inventory

| Migration | Story | Description |
|-----------|-------|-------------|
| 0016 | P7-TS-01 | Billing schema (plans, subscriptions, entitlements, billing_events) |
| 0018 | P7-TS-09 | Outbound webhooks (webhook_endpoints, webhook_delivery_logs) |
| 0050 | P7-TS-13 / CRIT-2 | `anchor_chain_index` table for O(1) fingerprint verification (fingerprint_sha256, chain_tx_id, block_height, block_timestamp, confirmations, anchor_id) |

## Related Documentation

- [08_payments_entitlements.md](../confluence/08_payments_entitlements.md) — Billing schema and Stripe integration
- [09_webhooks.md](../confluence/09_webhooks.md) — Webhook delivery architecture
- [10_anchoring_worker.md](../confluence/10_anchoring_worker.md) — Worker job processing
- [06_on_chain_policy.md](../confluence/06_on_chain_policy.md) — Bitcoin anchoring policy
- [11_proof_packages.md](../confluence/11_proof_packages.md) — Proof package schema

## Change Log

| Date | Change |
|------|--------|
| 2026-03-10 | Initial P7 story documentation created (Session 3 of 3). |
| 2026-03-10 4:15 PM EDT | HARDENING-2 updates: worker test coverage now 59 tests (was 0). Updated P7-TS-05 and P7-TS-10 test coverage sections. Removed deleted anchorWithClaim.ts references from P7-TS-10. Updated hardening prerequisite to reflect progress. |
| 2026-03-10 5:20 PM EST | HARDENING-4: P7-TS-10 PARTIAL → COMPLETE. Webhook dispatch wired in anchor.ts, processWebhookRetries added to cron. 132 worker tests. |
| 2026-03-10 ~7:15 PM EST | PR-HARDENING-1: Fixed validators.ts (71% → 100% functions) and proofPackage.ts (0% → 100%) coverage failures. 44 new frontend tests. 385 total. |
| 2026-03-10 ~8:00 PM EST | HARDENING-5: 7 new worker test files (96 tests). All remaining worker files now covered: config, index, stripe/mock, jobs/report, jobs/webhook, utils/correlationId, utils/rateLimit. 228 worker tests. 481 total. Worker hardening sprint COMPLETE. |
| 2026-03-10 ~9:30 PM EST | CRIT bug fix sprint: CRIT-5 resolved. P7-TS-07 promoted PARTIAL → COMPLETE. JSON proof download wired via onDownloadProofJson. proofPackage.ts has 33 tests (PR-HARDENING-1). |
| 2026-03-11 ~12:30 AM EST | Documentation audit: Updated all CRIT-5 references as resolved. Updated header counts (5/10 complete, 1/10 partial). Added proofPackage.ts test coverage entry. |
| 2026-03-11 ~7:00 PM EST | Bitcoin Signet: P7-TS-05 NOT STARTED → PARTIAL. SignetChainClient (~300 lines) implemented with OP_RETURN + ARKV prefix. Factory updated (26 → 63 lines). signet.test.ts (~15 tests) + client.test.ts (5 → 8 tests). 268 worker tests total. Header: 6 complete, 2 partial, 2 not started. |
| 2026-03-11 ~11:30 PM EST | P7-TS-11 created and marked COMPLETE. wallet.ts (4 exports), wallet.test.ts (13 tests), generate-signet-keypair.ts + check-signet-balance.ts CLI scripts. Header: 7 complete, 2 partial, 1 not started (P7-TS-04/06 stubs excluded from count). |
| 2026-03-12 ~12:00 AM EST | P7-TS-12 created and marked COMPLETE. utxo-provider.ts (RpcUtxoProvider + MempoolUtxoProvider + factory). 35 tests. Integrated into SignetChainClient + getChainClient(). P7-TS-13 (fingerprint indexing) created as NOT STARTED. Header: 8/13 complete, 2/13 partial, 3/13 not started. |
| 2026-03-12 ~12:30 AM EST | Signet test fixes: Fixed 6 signet.test.ts failures (ESM require() → direct import, PSBT validation via buildDummyFundingTx()). 101 chain tests, 363 worker total. agents.md added to chain/. |
| 2026-03-12 ~3:00 AM EST | CRIT-2 code complete: Added signing-provider.ts (WifSigningProvider + KmsSigningProvider), fee-estimator.ts (StaticFeeEstimator + MempoolFeeEstimator), SupabaseChainIndexLookup in client.ts. Refactored signet.ts → BitcoinChainClient with provider abstractions. Rewrote client.ts to async factory (initChainClient/getInitializedChainClient). Migration 0050 creates anchor_chain_index table. P7-TS-13 NOT STARTED → COMPLETE. P7-TS-05 PARTIAL → CODE COMPLETE. 408 worker tests across 17 files. Header: 9/13 complete, 2/13 partial, 2/13 not started. |

# P7 Go-Live — Story Documentation
_Last updated: 2026-03-11 12:30 AM EST | 5/10 stories COMPLETE, 1/10 PARTIAL, 4/10 NOT STARTED_

## Group Overview

P7 Go-Live delivers the production infrastructure for launching the credentialing MVP: billing schema and Stripe integration, real Bitcoin chain anchoring, proof package export, webhook delivery, and the anchoring worker. This is the most complex group with the deepest infrastructure requirements and the most critical production blockers.

Key deliverables:
- Billing schema (migration 0016) with plans, subscriptions, entitlements, billing events
- Stripe webhook verification + checkout session (checkout NOT STARTED — CRIT-3)
- Real Bitcoin chain client replacing MockChainClient (NOT STARTED — CRIT-2)
- Proof package export (PDF + JSON both complete — ~~CRIT-5~~ FIXED commit a38b485)
- Webhook endpoint management + delivery engine (fully wired to anchor lifecycle — HARDENING-4)
- Anchoring worker with job processing (hardening sprint COMPLETE — 132 tests, all 80%+ thresholds)

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

**Status:** NOT STARTED
**Dependencies:** P7-TS-01 (billing schema), P7-TS-03 (webhook verification)
**Blocked by:** CRIT-3

#### What This Story Delivers

A Stripe checkout session creation endpoint in the worker that initiates payment flows. Users select a plan, the worker creates a Stripe checkout session, and the user is redirected to Stripe's hosted checkout page.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| — | — | — | No implementation exists |

#### What Exists (Infrastructure)

- Stripe SDK initialized in `services/worker/src/stripe/client.ts`
- `MockStripeClient.createCheckoutSession()` returns mock URL
- Webhook verification working (P7-TS-03)
- PricingCard.tsx has plan selection UI (not wired)
- BillingOverview.tsx has "Upgrade Plan" button (callback not implemented)

#### What's Missing

- `POST /checkout/session` endpoint in worker
- `stripe.checkout.sessions.create()` call with line items, success/cancel URLs
- Pricing UI wired to checkout endpoint
- Success page handling after Stripe redirect
- Billing portal session creation for managing existing subscriptions
- Subscription status sync after checkout completion

#### Acceptance Criteria (From Backlog)

- [ ] Worker exposes `POST /checkout/session` endpoint
- [ ] Endpoint creates Stripe checkout session with correct plan pricing
- [ ] Success/cancel URLs redirect back to app
- [ ] PricingCard "Select" button triggers checkout flow
- [ ] Subscription created in DB after `checkout.session.completed` webhook
- [ ] Free tier users can upgrade to paid plans
- [ ] Billing portal available for existing subscribers

#### Known Issues

| Issue | Impact |
|-------|--------|
| CRIT-3 | No way to collect payment. Production blocker. |

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

**Status:** NOT STARTED
**Dependencies:** P7-TS-01 (billing — entitlement check before anchoring)
**Blocked by:** CRIT-2, Worker hardening sprint (Week 1)

#### What This Story Delivers

A real Bitcoin chain client implementing the `ChainClient` interface with OP_RETURN transaction construction, Bitcoin network submission, and AWS KMS-based signing. Replaces `MockChainClient` as the production implementation.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Factory | `services/worker/src/chain/client.ts` | 26 | `getChainClient()` — always returns MockChainClient (TODO comment) |
| Interface | `services/worker/src/chain/types.ts` | 51 | `ChainClient` interface with 4 methods |
| Mock | `services/worker/src/chain/mock.ts` | 79 | MockChainClient with in-memory receipt storage |

#### ChainClient Interface

```typescript
interface ChainClient {
  submitFingerprint(request: SubmitFingerprintRequest): Promise<ChainReceipt>;
  verifyFingerprint(fingerprint: string): Promise<VerificationResult>;
  getReceipt(receiptId: string): Promise<ChainReceipt | null>;
  healthCheck(): Promise<boolean>;
}
```

**SubmitFingerprintRequest:** `fingerprint`, `timestamp`, `metadata?`
**ChainReceipt:** `receiptId`, `blockHeight`, `blockTimestamp`, `confirmations`

#### Current State

`getChainClient()` at line 13 has a TODO comment and falls through to `return new MockChainClient()` for all environments — including production. The mock uses in-memory Maps and returns fake receipt IDs like `mock_receipt_{timestamp}_{random}`.

#### What's Missing

- `bitcoinjs-lib` package installation
- OP_RETURN transaction construction (embed SHA-256 fingerprint in transaction output)
- Bitcoin RPC client (for Signet and Mainnet)
- AWS KMS integration for signing keys (treasury wallet)
- Real `ChainClient` implementation class
- Signet configuration for pre-production testing
- Mainnet configuration and treasury wallet funding
- `BITCOIN_TREASURY_WIF` and `BITCOIN_NETWORK` env var handling

#### Implementation Order (from CLAUDE.md Section 9)

1. **Week 1:** Worker hardening — test processAnchor(), job claim flow, chain interface contract
2. **Week 2:** Bitcoin Signet — install bitcoinjs-lib, implement real ChainClient, test on Signet
3. **Week 3:** AWS KMS + Mainnet — key provisioning, real anchoring, treasury funding

#### Acceptance Criteria (From Backlog)

- [ ] `bitcoinjs-lib` installed and configured
- [ ] OP_RETURN transaction builds with embedded fingerprint
- [ ] Signet submission and verification working
- [ ] AWS KMS signs transactions (mainnet)
- [ ] `getChainClient()` returns real client when `useMocks=false`
- [ ] ChainReceipt populated with real block height, timestamp, receipt ID
- [ ] Health check verifies Bitcoin node connectivity

#### Test Coverage (Updated HARDENING-2, 2026-03-10 4:15 PM EDT)

| Test File | Type | Tests | Coverage |
|-----------|------|-------|----------|
| `services/worker/src/chain/mock.test.ts` | Unit | 18 | 100% on `mock.ts` — interface contract, submit/verify/getReceipt/healthCheck |
| `services/worker/src/chain/client.test.ts` | Unit | 5 | 100% on `client.ts` — factory returns correct type, mock/test/prod paths |
| `services/worker/src/jobs/anchor.test.ts` | Unit | 36 | 100% on `anchor.ts` — processAnchor + processPendingAnchors (query shape, failure isolation, completion) |

#### Known Issues

| Issue | Impact |
|-------|--------|
| CRIT-2 | No real chain client. Production blocker. |
| Chain interface tested, real impl missing | MockChainClient + factory at 100% coverage. Real `bitcoinjs-lib` client not yet written. |

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

**Status:** PARTIAL
**Dependencies:** P7-TS-01 (billing — org context)
**Blocked by:** None (implementation mostly complete, secret hashing gap)

#### What This Story Delivers

Webhook endpoint management: database schema for endpoints and delivery logs, a UI component for configuring webhook URLs and events, and a delivery engine with exponential backoff and HMAC-SHA256 signing.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Migration | `supabase/migrations/0018_outbound_webhooks.sql` | 130 | webhook_endpoints + webhook_delivery_logs tables |
| Component | `src/components/webhooks/WebhookSettings.tsx` | 284 | Add/list/toggle/delete webhook endpoints |
| Delivery | `services/worker/src/webhooks/delivery.ts` | 259 | Dispatch + delivery + retry engine |

#### Database Changes

| Object | Type | Migration | Description |
|--------|------|-----------|-------------|
| `webhook_endpoints` | Table | 0018 | id, org_id, url (https:// enforced), secret_hash (write-only), events (TEXT[]), is_active, description, created_by, timestamps |
| `webhook_delivery_logs` | Table | 0018 | id, endpoint_id, event_type, event_id, payload (JSONB), attempt_number, status (pending/success/failed/retrying), response_status/body, error_message, next_retry_at, idempotency_key, timestamps |
| RLS | Policies | 0018 | ORG_ADMIN only on both tables (SELECT, INSERT, UPDATE, DELETE) |

#### UI Component

**WebhookSettings.tsx** (284 lines):
- **Add dialog:** URL input (HTTPS validation), secret input (16+ char requirement), event checkboxes
- **"Generate Secret" button:** Uses `crypto.getRandomValues()` for 32 bytes -> hex
- **Endpoint list:** URL, event badges, enable/disable toggle, delete button
- **Available events:** `anchor.secured`, `anchor.revoked`, `anchor.created`
- **Callbacks:** `onAdd(url, secret, events)`, `onDelete(id)`, `onToggle(id, isActive)`

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

#### Critical Gap

- **Secret HMAC hashing:** The `secret_hash` column stores the webhook secret, but the pipeline from client (raw secret) to database (HMAC-SHA256 hash) is not implemented. The backend should hash the secret with `API_KEY_HMAC_SECRET` before persisting to `secret_hash`.

#### Security Considerations

- RLS: ORG_ADMIN only on both tables
- HTTPS enforced on webhook URLs
- HMAC-SHA256 payload signing in delivery headers
- Secret minimum length 16 characters
- Delivery logs are append-only with status tracking
- Feature flag gates the entire webhook system

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| — | — | No dedicated webhook tests |

#### Acceptance Criteria

- [x] `webhook_endpoints` table with RLS (ORG_ADMIN only)
- [x] `webhook_delivery_logs` table with status tracking
- [x] UI component for endpoint CRUD
- [x] Secret generation (client-side crypto.getRandomValues)
- [x] HMAC-SHA256 signing in delivery headers
- [x] Exponential backoff retry (5 retries)
- [x] Idempotency deduplication via delivery logs
- [x] Feature flag gating
- [ ] Secret HMAC hashing before storage

#### Known Issues

| Issue | Impact |
|-------|--------|
| Secret not HMAC-hashed before storage | Raw secret in DB violates Constitution 1.4 |

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

# 10 — Deferred Hardening Stories
_Last updated: 2026-03-14 ~3:00 PM EST_

## Overview

These stories were identified during CodeRabbit review of PR #26 (CRIT-2 + CRIT-3). They are non-blocking operational improvements deferred to post-launch hardening.

| Status | Count |
|--------|-------|
| Complete | 3 |
| Partial | 0 |
| Not Started | 9 |

---

## DH-01: Feature Flag Kill-Switch Hot-Reload

**Status:** NOT STARTED
**Priority:** MEDIUM
**Source:** CodeRabbit PR #26, comment on `services/worker/src/index.ts`

### What It Delivers
Hot-reload capability for the `ENABLE_PROD_NETWORK_ANCHORING` feature flag so it can be toggled without restarting the worker process. Currently requires worker restart.

### Acceptance Criteria
- [ ] Worker polls switchboard_flags table on configurable interval (default 60s)
- [ ] Flag change takes effect within one polling interval
- [ ] No worker restart required
- [ ] Structured log emitted on flag state change

---

## DH-02: Advisory Lock for Migration 0049 Concurrency

**Status:** NOT STARTED
**Priority:** LOW
**Source:** CodeRabbit PR #26, comment on `supabase/migrations/0049_entitlement_quota_enforcement.sql`

### What It Delivers
Add `pg_advisory_xact_lock()` in `bulk_create_anchors()` to prevent race conditions where concurrent requests could both pass the initial quota check but collectively exceed the limit.

### Acceptance Criteria
- [ ] Advisory lock acquired per-user before quota check in bulk_create_anchors
- [ ] Lock released automatically at transaction end
- [ ] No deadlock risk (single lock per user)
- [ ] Test demonstrating concurrent protection

---

## DH-03: KMS Operational Documentation

**Status:** COMPLETE
**Priority:** HIGH (blocks mainnet)
**Source:** CodeRabbit PR #26, comment on `services/worker/src/chain/signing-provider.ts`
**Completed:** 2026-03-12

### What It Delivers
Operational runbook for AWS KMS key provisioning and rotation for mainnet Bitcoin signing.

### Acceptance Criteria
- [x] KMS key creation procedure documented (key policy, algorithm, region)
- [x] Key rotation procedure documented
- [x] Access control requirements specified (IAM roles/policies)
- [x] Emergency key revocation procedure
- [x] Document lives in `docs/confluence/14_kms_operations.md`

### Implementation
`docs/confluence/14_kms_operations.md` — 276 lines covering: architecture diagram, 5-step key provisioning (CLI commands), IAM policy JSON (least privilege: kms:Sign + kms:GetPublicKey only), key policy, manual rotation procedure (9 steps + checklist), 4 disaster recovery scenarios, CloudTrail monitoring with CloudWatch alarm recommendations, security notes, code reference table.

---

## DH-04: Outbound Webhook Circuit Breaker

**Status:** NOT STARTED
**Priority:** MEDIUM
**Source:** CodeRabbit PR #26, comment on webhook delivery engine

### What It Delivers
Circuit breaker pattern for outbound webhook delivery. After N consecutive failures to a single endpoint, temporarily stop attempting delivery and alert the webhook owner.

### Acceptance Criteria
- [ ] Circuit opens after 5 consecutive failures to same URL
- [ ] Circuit half-opens after 30 minutes (one test request)
- [ ] Full open after successful half-open test
- [ ] Webhook owner notified (email or in-app) when circuit opens
- [ ] Admin can manually reset circuit state

---

## DH-05: Chain Index Lookup Cache TTL

**Status:** NOT STARTED
**Priority:** LOW
**Source:** CodeRabbit PR #26, comment on `services/worker/src/chain/client.ts`

### What It Delivers
In-memory TTL cache for `SupabaseChainIndexLookup.lookup()` to reduce repeated DB queries for the same fingerprint during high-traffic verification.

### Acceptance Criteria
- [ ] LRU cache with configurable TTL (default 5 minutes)
- [ ] Cache size bounded (default 10,000 entries)
- [ ] Cache miss falls through to DB query
- [ ] Cache invalidated on new chain index entry
- [ ] Metrics: cache hit/miss ratio logged

---

## DH-06: ConfirmAnchorModal Server-Side Quota Error Handling

**Status:** NOT STARTED
**Priority:** MEDIUM
**Source:** CodeRabbit PR #26, comment on `src/components/anchor/ConfirmAnchorModal.tsx`

### What It Delivers
Graceful handling of server-side P0002 (quota_exceeded) errors from `bulk_create_anchors()` in the ConfirmAnchorModal, displaying the UpgradePrompt dialog instead of a generic error toast.

### Acceptance Criteria
- [ ] P0002 error code detected in RPC error response
- [ ] UpgradePrompt dialog shown with current usage stats
- [ ] No generic "insert failed" toast for quota errors
- [ ] Test covering server-side quota rejection path

---

## DH-07: MempoolFeeEstimator Request Timeout

**Status:** COMPLETE
**Priority:** MEDIUM
**Source:** CodeRabbit PR #26, comment on `services/worker/src/chain/fee-estimator.ts`
**Completed:** 2026-03-14 (PR #38)

### What It Delivers
Configurable request timeout for `MempoolFeeEstimator` API calls to prevent hanging requests blocking the anchor processing pipeline.

### Acceptance Criteria
- [x] `AbortController` with configurable timeout (default 5s)
- [x] Timeout falls back to static fee rate
- [x] Structured log on timeout with URL and duration
- [x] Test for timeout behavior (+23 tests in fee-estimator.test.ts)

---

## DH-08: Rate Limiting for check_anchor_quota RPC

**Status:** NOT STARTED
**Priority:** LOW
**Source:** CodeRabbit PR #26, comment on `supabase/migrations/0049_entitlement_quota_enforcement.sql`

### What It Delivers
Rate limiting on the `check_anchor_quota()` RPC to prevent abuse (e.g., polling for quota changes at high frequency).

### Acceptance Criteria
- [ ] Rate limit: 60 calls/minute per user
- [ ] HTTP 429 response on excess
- [ ] Does not affect bulk_create_anchors internal calls

---

## DH-09: UtxoProvider Retry Logic

**Status:** COMPLETE
**Priority:** MEDIUM
**Source:** CodeRabbit PR #26, comment on `services/worker/src/chain/utxo-provider.ts`
**Completed:** 2026-03-14 (PR #39)

### What It Delivers
Retry with exponential backoff for `UtxoProvider` API calls (both RPC and Mempool.space) to handle transient network failures gracefully.

### Acceptance Criteria
- [x] 3 retries with exponential backoff (1s, 2s, 4s) with jitter
- [x] Only retry on transient errors (5xx, network timeout)
- [x] Do not retry on 4xx (bad request, not found)
- [x] Structured logging for each retry attempt
- [x] Tests with mock transient failures (+17 tests in utxo-provider.test.ts)

---

## DH-10: useEntitlements Realtime Subscription

**Status:** NOT STARTED
**Priority:** LOW
**Source:** CodeRabbit PR #26, comment on `src/hooks/useEntitlements.ts`

### What It Delivers
Supabase realtime subscription on the `anchors` table so the entitlement counter updates immediately when new anchors are created (rather than requiring manual refresh).

### Acceptance Criteria
- [ ] Subscribe to INSERT events on anchors table for current user
- [ ] Increment recordsUsed on new anchor creation
- [ ] Unsubscribe on component unmount
- [ ] Does not conflict with manual refresh()
- [ ] Test for realtime update path

---

## DH-11: Worker RPC Logging Structured Format

**Status:** NOT STARTED
**Priority:** LOW
**Source:** CodeRabbit PR #26, comment on worker logging

### What It Delivers
Ensure all Bitcoin RPC and Mempool.space API interactions use structured logging with consistent fields (url, method, duration_ms, status, error).

### Acceptance Criteria
- [ ] All RPC calls log: url, method, duration_ms, status_code
- [ ] Failed calls include error message in structured field
- [ ] No sensitive data in logs (no WIF, no raw transaction hex in info level)
- [ ] Log level: info for success, warn for retry, error for final failure

---

## DH-12: Webhook Delivery Dead Letter Queue

**Status:** NOT STARTED
**Priority:** MEDIUM
**Source:** CodeRabbit PR #26, comment on webhook delivery engine

### What It Delivers
Dead letter queue for webhook deliveries that exhaust all retries, allowing admin review and manual re-delivery.

### Acceptance Criteria
- [ ] After max retries exhausted, delivery moved to dead letter table
- [ ] Dead letter entries include: payload, URL, all attempt timestamps, last error
- [ ] Admin UI or RPC to list dead letter entries
- [ ] Admin can trigger manual re-delivery from dead letter queue
- [ ] Dead letter entries auto-expire after 30 days

---

## Change Log

| Date | Story | Change |
|------|-------|--------|
| 2026-03-12 | DH-01 through DH-12 | Created from CodeRabbit PR #26 deferred items |

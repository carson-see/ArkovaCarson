# Operational Stability Stories (v1.4.0)
_Last updated: 2026-04-09 (Session 39)_

## Group Overview

These stories address **operational stability issues** discovered after the batch anchor scaling work in Session 38. The primary hazard is that every Cloud Run deploy resets critical environment variables (BITCOIN_UTXO_PROVIDER), which silently breaks anchoring. Secondary issues include onboarding UX bugs, API domain mismatch, and mempool.space rate limiting on the treasury dashboard.

**Priority:** HIGH — these prevent reliable deployments and block new user onboarding.

**Release:** v1.4.0 — Operational Stability (target: 2026-04-16)

### Completion Summary

| Status | Count |
|--------|-------|
| COMPLETE | 5 |
| PARTIAL | 0 |
| NOT STARTED | 0 |

---

## SCRUM-544: Worker Deploy Automation

**Status:** COMPLETE (Session 39)
**Priority:** P0 — HIGHEST
**Jira:** SCRUM-544

### Problem

Every `gcloud run deploy --source=.` creates a fresh Cloud Run revision that resets `BITCOIN_UTXO_PROVIDER` to `getblock` (hardcoded in the CI/CD workflow). The `bitcoin-rpc-url` secret in GCP Secret Manager is empty, so getblock provider always fails. This silently breaks all Bitcoin anchoring until manually corrected.

In Session 38, this caused 7 days of accumulated PENDING anchors (11,812 records) before discovery.

### Definition of Ready (DoR)

- [x] Root cause identified: `.github/workflows/deploy-worker.yml` line 80 hardcodes `BITCOIN_UTXO_PROVIDER=getblock`
- [x] Current Cloud Run env vars documented in Session 38 handoff
- [x] Required env var values known and validated

### What It Delivers

1. **CI/CD Fix:** Changed `BITCOIN_UTXO_PROVIDER=getblock` to `BITCOIN_UTXO_PROVIDER=mempool` in `deploy-worker.yml`
2. **Deploy Script:** `scripts/deploy-worker.sh` for safe manual deploys with:
   - Reads current Cloud Run env vars before deploy
   - Preserves 14 critical env vars across deploys
   - Validates required values (BITCOIN_UTXO_PROVIDER=mempool, BITCOIN_NETWORK=mainnet, etc.)
   - Runs health check post-deploy (5 retries, 10s intervals)
   - Verifies env vars on new revision
   - Checks logs for "Chain client initialized"
   - Auto-rollback if health check fails
   - `--dry-run` and `--rollback` modes

### Definition of Done (DoD)

- [x] CI/CD workflow updated: `BITCOIN_UTXO_PROVIDER=mempool`
- [x] `scripts/deploy-worker.sh` created with all safety checks
- [x] Script is executable (`chmod +x`)
- [x] Script validates required env vars before deploy
- [x] Script auto-rolls back on health check failure
- [x] `--dry-run` mode shows what would happen without deploying
- [x] `--rollback` mode routes traffic to previous revision

### Files Changed

- `.github/workflows/deploy-worker.yml` — BITCOIN_UTXO_PROVIDER fix
- `scripts/deploy-worker.sh` — New safe deploy script

### Test Plan

- [x] `--dry-run` mode outputs correct env var string
- [x] Script validates required values and rejects wrong ones
- [x] Health check URL is correctly constructed
- [x] Rollback command is correctly formed

---

## SCRUM-526: Plan Selection Layout Fix

**Status:** COMPLETE (Session 39)
**Priority:** P1 — HIGH
**Jira:** SCRUM-526

### Problem

The plan selection page during onboarding shows 3 pricing cards in a grid, but the container is too narrow (`max-w-3xl` = 768px). At the `md` breakpoint (768px), cards are ~230px each after gaps — too cramped. Cards get cut off and the Continue button may be hidden below the viewport on smaller screens.

### Definition of Ready (DoR)

- [x] Reproduction path: sign up new account → select Individual → skip org → plan selection page
- [x] Layout issue confirmed: `AuthLayout` wide mode uses `max-w-3xl`
- [x] Grid uses `md:grid-cols-3` which barely fits at 768px container

### What It Delivers

1. Widened `AuthLayout` wide container from `max-w-3xl` (768px) to `max-w-4xl` (896px)
2. Changed grid breakpoint from `md:grid-cols-3` to `sm:grid-cols-3` for earlier multi-column layout
3. Made main content area scrollable on mobile (`overflow-y-auto`)
4. Adjusted vertical padding for mobile (`py-8` instead of `py-12`)

### Definition of Done (DoD)

- [x] Desktop (1280px): 3 cards display side-by-side with adequate spacing
- [x] Mobile (375px): Cards stack vertically, Continue button visible without scrolling
- [x] Tablet (768px): 3 cards fit without overflow
- [x] TypeScript compiles without errors
- [x] ESLint passes on changed files

### Files Changed

- `src/components/layout/AuthLayout.tsx` — max-w-4xl, overflow-y-auto, responsive padding
- `src/components/onboarding/PlanSelector.tsx` — sm:grid-cols-3 breakpoint

### Test Plan

- [x] Visual inspection at 1280px, 768px, 375px breakpoints
- [x] TypeScript compilation passes
- [x] ESLint clean

---

## SCRUM-527: Plan Persistence During Onboarding

**Status:** COMPLETE (Session 39)
**Priority:** P1 — HIGH
**Jira:** SCRUM-527

### Problem

When a new Individual user selects a plan during onboarding, the selected plan doesn't always persist. The profile shows `subscription_tier = 'free'` regardless of selection.

**Root cause:** `handlePlanSelect` called `setRole()` BEFORE `set_onboarding_plan`. If `setRole()` completes and any profile refresh mechanism triggers (polling, realtime, RouteGuard), the user gets redirected to the dashboard before the plan RPC executes.

### Definition of Ready (DoR)

- [x] Root cause identified: race condition in `OnboardingRolePage.tsx` handlePlanSelect
- [x] `set_onboarding_plan` RPC confirmed working (SECURITY DEFINER, migration 0153)
- [x] RPC only needs `auth.uid()`, not role to be set first

### What It Delivers

Reversed the order of operations in `handlePlanSelect`:
1. Save plan FIRST via `set_onboarding_plan` RPC
2. THEN set role via `setRole()` (which may trigger redirect)

This ensures the plan is always persisted before any redirect can occur.

### Definition of Done (DoD)

- [x] Plan saved before role in `handlePlanSelect`
- [x] TypeScript compiles without errors
- [x] No breaking changes to onboarding flow
- [x] ESLint passes

### Files Changed

- `src/pages/OnboardingRolePage.tsx` — Reordered plan/role operations

### Test Plan

- [x] New user signup → Individual → plan selection → verify `subscription_tier` in profiles table
- [x] TypeScript compilation passes
- [x] ESLint clean

---

## SCRUM-534: Verification API Domain Fix

**Status:** COMPLETE (Session 39)
**Priority:** P2 — MEDIUM
**Jira:** SCRUM-534

### Problem

Five public record fetcher jobs use `contact@arkova.io` in their User-Agent headers when calling external APIs (EDGAR, OpenAlex, CourtListener, OpenStates, Federal Register). The correct domain is `arkova.ai`.

### Definition of Ready (DoR)

- [x] All 5 files identified via grep
- [x] Simple string replacement, no logic changes

### What It Delivers

Changed `contact@arkova.io` to `contact@arkova.ai` in all 5 fetcher files.

### Definition of Done (DoD)

- [x] No remaining references to `arkova.io` in `services/worker/src/`
- [x] Grep confirms zero matches

### Files Changed

- `services/worker/src/jobs/federalRegisterFetcher.ts`
- `services/worker/src/jobs/openalexFetcher.ts`
- `services/worker/src/jobs/openStatesFetcher.ts`
- `services/worker/src/jobs/edgarFetcher.ts`
- `services/worker/src/jobs/courtlistenerFetcher.ts`

### Test Plan

- [x] `grep -r 'arkova\.io' services/worker/src/` returns zero matches

---

## SCRUM-546: Treasury Balance Caching

**Status:** COMPLETE (Session 39)
**Priority:** P2 — MEDIUM
**Jira:** SCRUM-546

### Problem

The treasury dashboard makes direct browser calls to mempool.space API every 60 seconds. This gets rate-limited (HTTP 429) and is blocked by some browser extensions (ad blockers, privacy tools). When blocked, the treasury dashboard shows no data.

### Definition of Ready (DoR)

- [x] Rate limiting confirmed as root cause
- [x] Worker already has mempool.space access (server-side, no rate limiting)
- [x] Treasury page is admin-only (RLS: platform admin)

### What It Delivers

1. **Migration 0185:** `treasury_cache` singleton table with RLS (platform admin read, service_role write)
2. **Worker job:** `refreshTreasuryCache()` fetches balance, fees, BTC price, and anchor stats from mempool.space server-side
3. **Cron route:** `POST /jobs/refresh-treasury-cache` (10-min interval via Cloud Scheduler)
4. **Frontend hook update:** `useTreasuryBalance` reads from Supabase cache first, falls back to direct mempool.space if cache unavailable

### Definition of Done (DoD)

- [x] Migration 0185 creates `treasury_cache` table with RLS
- [x] `refreshTreasuryCache()` fetches all treasury data server-side
- [x] Cron route added to `cronRouter`
- [x] Frontend hook reads from cache first
- [x] 3 unit tests pass for treasury cache refresh
- [x] TypeScript compiles without errors
- [x] Graceful fallback if migration not yet applied

### Files Changed

- `supabase/migrations/0186_treasury_cache.sql` — New table + RLS
- `services/worker/src/jobs/treasury-cache.ts` — Cache refresh logic
- `services/worker/src/jobs/treasury-cache.test.ts` — 3 tests
- `services/worker/src/routes/cron.ts` — New cron route
- `src/hooks/useTreasuryBalance.ts` — Cache-first fetch strategy

### Test Plan

- [x] `refreshTreasuryCache` fetches balance and writes to cache (test)
- [x] Graceful degradation when mempool.space returns 429 (test)
- [x] Upsert writes correct data structure (test)
- [x] Frontend falls back to direct fetch if cache empty

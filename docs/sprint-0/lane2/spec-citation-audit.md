# Spec Citation Audit — Lane-2 Sprint-0 Pre-Design Docs

> **Type:** READ-ONLY citation audit. No spec was rewritten; only this file was created.
> **Auditor task:** verify every load-bearing technical citation (file path, symbol, line, table/RPC/migration) in the four Lane-2 Sprint-0 spec docs against the worktree, and flag miscitations with the correct value.
> **Worktree:** `/Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/wt-lane2-s0` · branch `lane2/s0-visibility-predesign`.
> **Date:** 2026-06-18.
> **Docs audited (under `docs/sprint-0/lane2/`):**
> 1. `S0-5.1-internal-visibility-dashboard-spec.md` (PRIORITY — heaviest citation load)
> 2. `api-key-expiry-dashboard-design.md`
> 3. `revenue-funnel-predesign.md`
> 4. `instant-secure-predesign.md`
>
> **Status legend:** `OK` (exists, says what the doc claims) · `WRONG-LINE` · `WRONG-SYMBOL` · `MISSING` · `IMPRECISE` (substantively right, citation slightly off — only flagged where it could cost an implementer time).

---

## Overall verdict

**Specs technically sound: YES.**

Across the four docs I verified ~150 distinct load-bearing citations (file paths, symbols, line numbers, table/column names, RPC names, migration numbers, and quoted prose). The grounding is unusually rigorous: nearly every line number is exact or within ±2, every quoted code/prose snippet matches verbatim, every "INCOMING / PROPOSED / not-on-main" hedge is honest, and the hard money-path nuances (the `org_credit_deductions.reference_id`-is-not-an-`anchors.id`-FK trap, the `check_unified_credits` `(50,0,50,true)` fail-open default, the `flagRegistry` env-fallback fail-open) are all real and correctly cited.

There is **exactly one citation a Sprint-1 implementer could chase to the wrong place** (`verifyCronAuth` line number), plus a small set of cosmetic imprecisions. None of the four docs misstate an architectural fact, invent a symbol, or assert a non-existent prod state. The specs are safe to hand to Sprint 1.

---

## Corrections list (only non-OK findings)

| # | Doc | Claim (as written) | Status | Correct value |
|---|---|---|---|---|
| C1 | `api-key-expiry-dashboard-design.md` §4.1 | "Auth reuses the existing `verifyCronAuth` (`cron.ts:67`)" | **WRONG-LINE** | `verifyCronAuth` is **defined at `services/worker/src/routes/cron.ts:161`** (`async function verifyCronAuth(req)`). Line 67 is an unrelated `import { fetchBrazil... } from '../jobs/intlComplianceFetcher.js'`. The function exists and behaves as described (X-Cron-Secret / platform-admin Bearer / Google OIDC); only the line number is wrong. |
| C2 | `instant-secure-predesign.md` §1 (table) + "Source map" | Batch path cited as `services/worker/src/jobs/batch-anchor.js` (`processBatchAnchors`) | **IMPRECISE** | Source file is **`batch-anchor.ts`** (no `.js` file exists on disk; `processBatchAnchors` is at `batch-anchor.ts:481`). The `.js` extension matches the repo's ESM import convention, but as a *source* citation it should be `.ts`. The sibling `revenue-funnel-predesign.md` correctly cites `batch-anchor.ts:241`. Non-misleading but inconsistent. |
| C3 | `S0-5.1-…spec.md` §2.1 (data-sources table) | `anchors.payment_source_type` typed `'stripe' \| 'x402' \| 'admin_bypass' \| 'beta_unlimited'` | **IMPRECISE** | That 4-value union is the **`PaymentSource.type`** in `services/worker/src/billing/paymentGuard.ts:22` (the values the guard writes). The generated **column** type in `database.types.ts:537` is the looser **`string \| null`**. Column exists, guard writes those values — the substantive claim holds; only the "this is the column's type" framing is loose. M1b's logic (exclude covered `payment_source_type`) is unaffected. |
| C4 | `revenue-funnel-predesign.md` §3.4 | "`useEntitlements` … falls back to Free (`3`) when no active sub" | **IMPRECISE** | `src/hooks/useEntitlements.ts` resolves the fallback by looking up the **`'free'` plan row** (`plans.find(p => p.id === 'free')`, lines 90/94) and reading its `records_per_month` — the literal `3` is **not** in the hook; it lives in the `plans` data. "Falls back to Free" is structurally correct; the hard-coded `3` is not in the cited file. |
| C5 | Cross-doc (S0-5.1 §3.3; api-key §4.3) | "Sentry `beforeSend` scrubber (`utils/sentry.ts:75-154`)" / db-health Sentry idiom phrasing | **IMPRECISE (cosmetic)** | Lines `75-154` of `utils/sentry.ts` are the **`scrubPiiFromEvent()`** function (the actual scrubber that redacts emails/JWTs/`ak_…`/UUIDs — all as the doc claims). The Sentry SDK `beforeSend` hook that *invokes* it is at line 237. So the cited range is the scrubber body, just not the `beforeSend` registration. Content claim fully correct. |

> **Trivial off-by-one(s) not worth a row, listed for completeness:** S0-5.1 §2.2 cites `aiFeatureGate.ts:110` for the `switchboard_flags` read — the `.from('switchboard_flags')` call is at line 111 (the query builder opens at 110). instant-secure "Source map" cites `ANCHOR_STATUS_* :14` — the block actually starts at `ANCHOR_STATUS_LABELS` line 17 / `ANCHOR_STATUS_DESCRIPTIONS` line 26. Neither would slow an implementer.

---

## What was checked and confirmed OK (high-signal load-bearing citations)

The prompt called out a specific high-risk set. Every one of them verified **OK**:

| Citation (as flagged in the task) | Result |
|---|---|
| `flagRegistry.ts:114-117 / 131-137` env-fallback (fail-open) | **OK** — `if (error)` env fallback at lines 113-117; `catch` env fallback at 131-137. (S0-5.1 §2.2/§7.1.) |
| `flagRegistry.getAllFlags()` returns `{value, source}` | **OK** — lines 182-188, returns `Record<string,{value:boolean;source:string}>`. |
| `flagRegistry.getFlag` returns false for unknown (fail-closed) | **OK** — lines 151-155 (`if (!state) return false`). (instant-secure §4.) |
| `isDuplicateTxError` in `chain/utxo-provider.ts` | **OK** — defined line 88; call sites 310 / 383 / 502 (all `broadcastTx`). Discriminator strings ("transaction already in mempool", "txn-already-known", "already known") all present in `DUPLICATE_TX_PATTERNS`. |
| `emitRpcFallback` at `utils/sentry.ts:375` | **OK** — exactly line 375; locked field `chain_rpc_fallback: true` at 385; emitted from `utxo-provider.ts:483` (`GetBlockHybridProvider.listUnspent`); call-site comment 472-490 incl. the "alert if it stays at 100%" intent (475-477). |
| `get_anchor_status_counts_fast` in `admin-stats.ts` | **OK** — `(db as any).rpc('get_anchor_status_counts_fast')` at line 65; `get_anchor_tx_stats` at 75. |
| `org_credit_deductions` defined in migration `0326` (cols + refund-deletes-row) | **OK** — table lines 7-16 (cols `org_id,reference_id,reason,amount,balance_after,created_at`; `UNIQUE(org_id,reference_id,reason)`); `CHECK(amount>0)`/`CHECK(balance_after>=0)` lines 12-13; refund `DELETE`s the row lines 148-152; `FORCE ROW LEVEL SECURITY` + service-role-only lines 18-29. |
| `org_credit_deductions.reference_id` is NOT a FK to `anchors.id` (FAST_TRACK uses `organization_rule_executions.id`) | **OK** — line 10 is `reference_id uuid NOT NULL` with no `REFERENCES` (only `org_id` FKs, line 9); the migration header (lines 3-6) states the FAST_TRACK retry uses `organization_rule_executions.id` as `p_reference_id`. This is the single most important DBA-trap citation and it is exactly right. |
| `switchboard_flags` read sites | **OK** — `grcFeatureGate.ts:30`, `adesFeatureGate.ts:50`, `flagRegistry.ts:107-108`, `aiFeatureGate.ts:111`; written by `PlatformControlsPage.tsx:161-162` (`.update({enabled})`) + history at 128. |
| `db-health-monitor.ts` `runDbHealthMonitor` | **OK** — `runDbHealthMonitor` line 219; `DbHealthSnapshot` line 51; `Promise.allSettled` line 222; `classifyAlert`/`extractContextTags` 155-186; green path 273-275; `alert-rules.json` ref line 127; SCRUM-1254 line 2. |
| `cron.ts:1498` (`/db-health` → `runDbHealthMonitor`) | **OK** — `cronRouter.post('/db-health', …)` line 1498; `withCronMonitoring('db-health-monitor', '*/5 * * * *', …)` line 1499; `runDbHealthMonitor()` line 1500. |
| `SystemHealthPage` `AUTO_REFRESH_MS` | **OK** — `const AUTO_REFRESH_MS = 30_000` line 42; `useSystemHealth` import line 30; unauthorized view ~95-113; `fetchHealth` + interval 66-74. |
| `isPlatformAdmin` in `src/lib/platform.ts` (frontend) + worker `utils/platformAdmin.ts` | **OK** — frontend: hardcoded `PLATFORM_ADMIN_EMAILS` whitelist (lines 9, 12-14). Worker: `isPlatformAdmin(userId)` reads `profiles.is_platform_admin`, **fails secure on null** (`=== true`, lines 22-30). The doc's "frontend whitelist drifted from worker DB flag" claim (api-key §5.3) is accurate. |
| `copy.ts` `SYSTEM_HEALTH_LABELS` | **OK** — `export const SYSTEM_HEALTH_LABELS` at `src/lib/copy.ts:2196` (exact). |
| `src/App.tsx` admin-route registration | **OK** — admin block lines 300-311; `/admin/health` (`ROUTES.ADMIN_HEALTH`) at **line 302** (matches §3.3's `App.tsx:302`); each route wraps `AuthGuard`+`RouteGuard`; `lazyWithRetry` page imports from line 30. Proposed `ROUTES.ADMIN_VISIBILITY` correctly absent (not yet built). |
| `api_keys.expires_at` | **OK** — `"expires_at" timestamp with time zone` at `00000000000000_baseline_at_main_HEAD.sql:7440` (exact); table block 7431-7457; `api_keys_select_own_org` policy at line 12505. |

### Additional OK confirmations worth recording

**S0-5.1 (priority doc):**
- §2.2 `middleware/agents.md` "Sibling-consumer audit" (lines 30-43) + "Ops note" (41-43) — **verbatim** match, including the `MAINTENANCE_MODE` fail-OPEN-on-startup-blip statement and the `ENABLE_SEMANTIC_SEARCH`/`ENABLE_AI_FRAUD` env↔DB re-sync note. This is the prose the dashboard claims to "make visible," and it exists exactly as quoted.
- §2.2 `aiFeatureGate.ts` header (SCRUM-2247/HARDEN-1-D) documents kill-switchable flags fail CLOSED + "env var is NOT a re-open path"; `failDefault()` at line 68 (line 73: "Kill-switchable: fail CLOSED. Do not consult env"). `grcFeatureGate.ts` env-fallback-on-error at line 36.
- §2.1 x402 replay test `middleware/__tests__/x402PaymentGate.test.ts` — "rejects replayed tx_hash with 409" + `error: 'payment_already_used'` + RISK-4 (lines 286/301/303).
- §3.3 `routes/admin.ts:305-307` treasury-health platform-admin-only / "no carve-out for org admins" — comment + route present (the SCRUM-1013/ARK-103 attribution is in-code; the "2026-04-21" date is the doc's, not a code claim, and the substantive policy is correct).
- §3.3/§7.1 admin endpoint gating pattern (`extractAuthUserId` → `isPlatformAdmin(userId)` → 403; `Promise.allSettled`) — matches `admin-stats.ts` (42/44/52) and `admin-health.ts` (74/76).
- Anchor-status values used in M1a/M1b sketches (`SECURED`/`SUBMITTED`/`BROADCASTING`/`REVOKED`) all exist in the `anchor_status` enum.

**api-key-expiry-dashboard-design.md:**
- §1.1 `validate_api_key` (`0299_validate_api_key_rpc.sql`) looks up `WHERE ak.key_hash = v_hash AND ak.is_active = true` (line 82) and **never references `expires_at`** (grep-confirmed absent) — the doc's central gap claim is accurate. Hardened by `0302`/`0303` (both exist).
- §1.2 `secret-rotation-reminder.ts`: `checkRotationStatus` (90d period / 7d warning, lines 3-4); `getSecretInventory()` hardcodes `lastRotatedAt: new Date()` for every secret (lines 20-38); `runSecretRotationCheck()` line 126 is **not** wired to any cron endpoint (grep of `cron.ts` confirms no `/secret-rotation`). "Dead code with a green test" — accurate.
- §2/§3.5 `proof-keys.public.json` + `src/api/proof-keys.ts` — `ProofKey` carries `created_at`/`retired_at`, `alg:'Ed25519'`, status active/retired.
- §3.1/§3.3 hardening pattern (`SET search_path`, `REVOKE … FROM PUBLIC/anon/authenticated`, `GRANT EXECUTE … service_role`, `NOTIFY pgrst`) from `0299:99-107`; `private.api_key_settings.updated_at` (`0299:34-39`).
- §4.3/§4.4 db-health Sentry idiom (`emitSentry` 188-204), stable-fingerprint precedent (`STUCK_ANCHOR_FINGERPRINT`/`captureStuckAnchorAlert`, `sentry.ts:251-287`), `infra/sentry/alert-rules.json` keyed at `db-health-monitor.ts:127`.
- §8 "0302/0303 duplicate-name pair (SCRUM-2192)" — both files share the identical `…_validate_api_key_rpc_hardening.sql` suffix.

**revenue-funnel-predesign.md:**
- §2 batch window `02:00–03:00 UTC` via `isWithinBatchWindow()` (`reconciliation.ts:445`, `hour>=2 && hour<3`) + `isFreeTierUser` (`reconciliation.ts:425`).
- §4.1 `CREDIT_PACKS` (`credits.ts:30-34`): `pack_1k`/$10, `pack_10k`/$80, `pack_100k`/$500, `pack_1m`/$3,000 (exact); endpoints + `purchaseSchema` enum; mounted `router.use('/credits', requireAuth, creditsRateLimiter, creditsRouter)` at `api/v1/router.ts:260` (exact).
- §4.2 dev-only grant via `deduct_unified_credits` negative amount, "NEVER in production" (`credits.ts:114-119`); session `metadata.{pack_id,credits,org_id}` (`credits.ts:140-147`).
- §4.3 the credit-ledger fragmentation is real: `get_user_credits`→`credits` (baseline:4142), `check_unified_credits`→`unified_credits` with **`IF NOT FOUND THEN RETURN QUERY SELECT 50, 0, 50, true`** (baseline `check_unified_credits` body — the exact fail-OPEN default the doc flags), `deduct_org_credit`→`org_credits` (0326, fail-closed `org_not_initialized`).
- §4.4 `allocate_monthly_credits()` (baseline:752) logs `credit_transactions` `ALLOCATION`/`EXPIRY` and preserves `purchased`.
- §5.1 webhook handlers (`handlers.ts`): `PROFILE_TIER_BY_PLAN_ID` line 20 (both verified-individual plans → `verified_individual`); `handleCheckoutComplete` 192; resolve-by-`stripe_price_id` 226-254; `claimEvent`/`billing_events` 160-166; subscriptions upsert `onConflict:'stripe_subscription_id'` (SCRUM-1220) 256-269; org `verification_status` VERIFIED-unless-REJECTED 309-353; `handleSubscriptionUpdated` items-period (SCRUM-1267) 369/459-468; `handlePaymentSucceeded` lines-period (SCRUM-1791) 645/673.
- §6.1 `verifyWebhookSignature` (`client.ts:38`) → `stripe.webhooks.constructEvent` (50); `apiVersion '2026-04-22.dahlia'` (26); §4.1 `mode` fix `client.ts:95-109`; `createCheckoutSession` line 69.
- §5.1 `orgVerification.ts` endpoints (verify-ein / verify-domain / confirm-domain / verification-status / dev-verify), EIN dedup-409, "never log EIN" (104), `crypto.randomBytes(32)` (167), `devCode` dev-only (192), `db as any` service client (25).
- §5.2/§8 "no `create_organization` RPC found" — grep across `supabase/migrations/`, `services/worker/src/`, `src/` returns nothing. Absence claim accurate.
- §3.1 `PricingPage` `BILLING_PLAN_ORDER` (line 27) incl. both verified plans; `recommended === 'individual_verified_monthly'` (197). `'verified_individual'` in `SUBSCRIPTION_TIERS` (`check-constraint-values.ts:96-98`).
- §4.5 copy: `CREDITS_REMAINING: '{count} credits remaining'` (copy.ts:894), `VAULT_BALANCE: 'Available Anchoring Credits'` (1378), `BILLING_LABELS` (521), `BILLING_PAGE_LABELS` (2188).
- §1 grounding migrations `0296`/`0300`/`0308`/`0327` all exist.

**instant-secure-predesign.md:**
- §1 `FAST_TRACK_ANCHOR` (DS-06, instant secure) at `rule-action-dispatcher.ts:540` (exact phrase); fail-closed contract line 12; two-step debit→submitJob with "retrying without credit compensation" line 588; debit keyed by `exec.id` line 645.
- §1 batch `processBatchAnchors` + manual force `POST /api/queue/run` → `processBatchAnchors({force:true, orgId})` at `queue-resolution.ts:307`.
- §4/§8 `config.ts`: `enableProdNetworkAnchoring` line 101, `enableOrgCreditEnforcement` line 110 (both `boolFlag(false)`) — exact.
- §2 `FileUpload.tsx`, `BulkUploadWizard.tsx`, `CSVUploadWizard.tsx`, `CreditUsageWidget.tsx`, `useCredits.ts` all exist; `SECURE_DIALOG_LABELS` at `copy.ts:643` (exact); `useCredits()` return shape `{balance,monthly_allocation,purchased,plan_name,cycle_start,cycle_end,is_low}` + `refresh` (exact).
- §5.1 `org_credit_deductions` UNIQUE / `FOR UPDATE` / idempotent-return semantics (0326) — correct.
- "Source map" `checkPaymentGuard` order **"beta → admin → stripe → x402"** — matches the **runtime body** order (`paymentGuard.ts:132/140/148/154`). NOTE: the file's *header comment* (lines 7-11) lists a different, stale order (Admin/Stripe/x402/Beta); the doc correctly followed the executable code, not the stale comment.
- Honest INCOMING/PROPOSED hedging verified: `debit_and_enqueue_anchor` / migration `0341` is **not** on this branch (correctly flagged INCOMING/Train D), and `ENABLE_INSTANT_SECURE` is correctly labeled PROPOSED (not in `DB_FLAGS`).

---

## Notes for the Sprint-1 implementer (not miscitations — design realities the docs already flag correctly)

- The "in-scope kill-switch set" in S0-5.1 §2.2 mixes **DB-backed** flags (`ENABLE_AI_FRAUD`, `ENABLE_SEMANTIC_SEARCH`, `ENABLE_AI_REPORTS`, `MAINTENANCE_MODE` — in `flagRegistry.DB_FLAGS`) with **env-backed** flags (`ENABLE_PROD_NETWORK_ANCHORING`, `ENABLE_VISUAL_FRAUD_DETECTION` — in `ENV_FLAG_GETTERS`). The doc's claim that `flagRegistry` "already tracks all of them" is **true** (the registry snapshots both kinds), but the env-vs-DB divergence detector (M2a) only has a meaningful DB row to compare against for the DB-backed ones; for an env-only flag, `getAllFlags()` reports `source:'env'` by construction. This is consistent with the spec's own M2a predicate (`db_enabled IS NOT NULL`) — just call it out so the implementer doesn't expect a `switchboard_flags` row for `ENABLE_PROD_NETWORK_ANCHORING`.
- `deduct_org_credit` `GRANT EXECUTE` is to `anon, authenticated, service_role` (0326 line 165), while `refund_org_credit` is `service_role`-only (line 168). revenue-funnel §4.6's "all grants/deducts are service_role RPCs" is true for the **table writes** (the table is service-role-only, the functions are `SECURITY DEFINER`), but the *deduct* function's EXECUTE grant is broader than service-role. Not a money-safety hole (DEFINER + table RLS), just a precision note.

---

_Audit complete. Read-only on all code and on all four spec docs — the only file created or modified by this audit is this report (`docs/sprint-0/lane2/spec-citation-audit.md`)._

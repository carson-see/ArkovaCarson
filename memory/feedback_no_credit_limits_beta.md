---
name: no-credit-limits-beta
description: No quota / credit-limit ENFORCEMENT during beta. Counting is fine; a beta tenant hitting `Quota exceeded` / ERRCODE P0002 is not. New migrations must not reintroduce the raise.
type: feedback
---

During beta, no code path may reject a tenant's work for exceeding a quota or credit limit. Track usage all you want — the enforcement branch (`RAISE EXCEPTION ... Quota exceeded`, `ERRCODE = 'P0002'`) must not exist in shipped migrations or RPCs.

**Why:** The rule was enshrined 2026-03-23 ~10:25. Migration `0093_atomic_quota_enforcement.sql` (lines 122–191) violated it **six hours later**. Free-tier orgs hit P0002 for five weeks before anyone noticed — silent, self-inflicted churn on the exact cohort beta exists to keep. `0266_restore_beta_no_quota.sql` restored the 0084 policy, and SCRUM-1261 (R1-7) locked it by pinning a `COMMENT ON FUNCTION public.check_anchor_quota()` that names this rule and its CI script. `check_anchor_quota()` is permanently `RETURN NULL`.

**How to apply:**
- Usage counters, ledger rows, and dashboards are fine. The *raise* is the violation.
- If a limit must be communicated, do it as a soft signal (a returned field, a warning, a Sentry breadcrumb) — never a failed write.
- Do not carry inert quota branches forward into a new migration file. Migration `0376` had to strip baseline's dead `quota_remaining`/`batch_size` guards precisely because copying the text re-trips this lint even when the branch could never execute. Delete inert code rather than relocating it.
- Do not remove or reword the `check_anchor_quota()` COMMENT — it is the durable in-database record of the policy.
- Connector/vendor secrets fail *closed* with 503 + `vendor_gated` when unprovisioned (`docs/reference/ENV.md`). That is a capability gate, not a quota, and is allowed.

**Enforcement:** CI lint `scripts/ci/feedback-rules/no-credit-limits-beta.ts` (R0-7 / SCRUM-1253). It scans changed `supabase/migrations/*.sql` (the `00000000000000_baseline_at_main_HEAD.sql` squash is excluded) for `RAISE EXCEPTION ... Quota exceeded`, `ERRCODE ... P0002`, and `raise exception using errcode = 'P0002'`. It matches on literal text, so commented-out or unreachable code still fails.

**Override label:** `post-beta-quota-rollout`. Using it means beta is over for quota purposes — update this file and the `check_anchor_quota()` comment in the same PR, not afterwards.

# Session 37: UAT Completion + Remaining Infrastructure Fixes

## Context
Session 36 merged PRs #338 (OAuth + Worker Critical Fixes) and #339 (9 Session 35 Bug Fixes) to main, deployed worker to Cloud Run (revision 00251-st9), and completed UAT click-through on production (app.arkova.ai). Three bugs verified PASS on production, three have infrastructure root causes requiring additional work, and two need fresh-user testing.

## Current State
- **Branch:** `main` (commit `132ce79`)
- **Frontend:** Deployed to Vercel (app.arkova.ai) — all frontend fixes live
- **Worker:** Cloud Run revision `00251-st9` serving 100% traffic, healthy (mainnet, DB ok, KMS ok)
- **Worktree:** `gifted-mccarthy` still exists at `.claude/worktrees/gifted-mccarthy` — can be removed

## UAT Results from Session 36

### PASS (verified on production)
- **S35-06** (SCRUM-529): Pencil edit icon visible next to document filename without hover
- **S35-10** (SCRUM-533): Pipeline page shows 1.41M ingested / 1.41M anchored / 78K embedded via `get_pipeline_stats()` RPC
- **S35-11** (SCRUM-534): `record_uri` returns `https://app.arkova.ai/verify/...` (confirmed via curl). Also fixed 11 additional files missed in original PR

### KNOWN ISSUES — Need Fixes
1. **S35-07/S35-09** (SCRUM-530/532): Admin Overview "Total Records" and "Records by Status" still show 0. Root cause: `get_anchor_status_counts` RPC returns null, AND the fallback `count:exact` queries on the 1.4M row `anchors` table timeout due to RLS. The pipeline page works because `get_pipeline_stats()` uses `reltuples` estimates on `public_records`. **Fix needed:** Create a `get_anchor_status_counts_fast` SECURITY DEFINER RPC using `reltuples` estimates or partial indexes (same pattern as migration 0175's `get_pipeline_stats`).

2. **S35-08** (SCRUM-531): Treasury "Fee Account Balance" shows "Unable to fetch balance". The mempool.space address API fetch fails from Cloud Run (likely rate limiting or egress blocking). The worker fallback to `/api/treasury/status` also fails. **Fix needed:** Investigate why mempool.space fetch fails from Cloud Run. May need to use the `MEMPOOL_API_URL` env var to point to a self-hosted mempool instance, or add mempool API key, or implement a caching layer.

### CANNOT VERIFY — Need Fresh User
3. **S35-01** (SCRUM-526): Plan selection layout (AuthLayout `wide` prop, max-w-3xl). Code verified correct in diff but cannot test with existing user — onboarding page returns 404 for completed users. **Test:** Create a new test account, go through onboarding, verify 3 plan cards render side-by-side at 1280px and stack at 375px.

4. **S35-02** (SCRUM-527): Plan saved during onboarding. Code verified correct — plan RPC no longer gated on `setRole()` result. **Test:** During onboarding with new account, select "Starter" plan, verify `subscription_tier` in profiles table shows "starter" not "free".

### NEEDS MANUAL CONFIG
5. **S35-03** (SCRUM-528): Branded email templates. Three HTML templates created in `supabase/templates/` (confirmation, recovery, magic_link) and configured in `config.toml` for local dev. **Production action:** Copy the HTML from each template file into the Supabase production dashboard → Authentication → Email Templates (Confirmation, Recovery, Magic Link). Then trigger a password reset to verify.

## Task Priority Order

### P0 — Fix admin overview anchor counts (S35-07/09)
Create migration 0182 with a `get_anchor_status_counts_fast()` SECURITY DEFINER function that uses `reltuples` estimates from `pg_class` for the `anchors` table, similar to how `get_pipeline_stats()` works for `public_records`. Update `admin-stats.ts` to call this new RPC instead of the broken `get_anchor_status_counts`. Apply migration to production. Redeploy worker.

### P1 — Fix treasury balance (S35-08)
Diagnose why mempool.space API fetch fails from Cloud Run:
- Check Cloud Run logs for the specific error (timeout? 429? DNS?)
- Try setting `MEMPOOL_API_URL=https://mempool.space/api` explicitly as a Cloud Run env var
- If rate-limited, consider caching the balance in Supabase with a 5-min TTL
- If egress blocked, consider proxying through the Cloudflare worker

### P2 — Configure production email templates (S35-03)
Open Supabase production dashboard → Authentication → Email Templates. Copy HTML from:
- `supabase/templates/confirmation.html` → "Confirm signup" template
- `supabase/templates/recovery.html` → "Reset password" template
- `supabase/templates/magic_link.html` → "Magic link" template
Trigger a password reset for a test account to verify branded template.

### P3 — Fresh user onboarding test (S35-01/02)
Create a new account (e.g., `uat-s37-test@gmail.com`), go through full onboarding:
1. Verify plan selection cards render properly at 1280px (3 cards side-by-side)
2. Verify plan selection cards stack at 375px mobile
3. Select "Starter" plan
4. After redirect to dashboard, verify `subscription_tier = 'starter'` in Supabase profiles table

### P4 — Cleanup
- Remove worktree: `git worktree remove .claude/worktrees/gifted-mccarthy`
- Delete merged remote branches: `git push origin --delete fix/uat-session-35 claude/gifted-mccarthy`
- Close PRs #338 and #339 on GitHub if not auto-closed
- Update HANDOFF.md with Session 36/37 state
- Update bug tracker spreadsheet with resolution status

## Key Reference
- Worker Cloud Run: `arkova-worker-270018525501.us-central1.run.app` (revision 00251-st9)
- Frontend Vercel: `app.arkova.ai`
- GCP project: `arkova1`, region: `us-central1`
- Service account key: `/Users/carson/arkova-sa-key.json`
- gcloud SDK installed at `/opt/homebrew/bin/gcloud`
- Bug tracker: https://docs.google.com/spreadsheets/d/1mOReOXL7cmBNDD77TKVKF3LsdQ3mEcmDbgs5q_pTEk4/edit
- Jira tickets: SCRUM-526 through SCRUM-534

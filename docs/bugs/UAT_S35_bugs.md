# UAT Session 35 — Bug Report
_Date: 2026-04-08_

## BUG-S35-01: Plan selection page layout broken (MEDIUM)
**Steps:** Sign up new account > Complete onboarding > Step 3 "Choose your plan"
**Expected:** Plan cards fully visible with select buttons, pricing clearly displayed
**Actual:**
- Cards cut off at bottom, select buttons not visible without scrolling
- Massive empty space at top pushes content to bottom half
- Starter price "$10/mo $0" text truncated/clipped
- Professional "$100/mo" and "$0 beta" text cramped
**Root cause:** Likely the card container has fixed height or the parent has improper flex/overflow
**Impact:** Poor first impression for new users during onboarding

## BUG-S35-02: Plan not saved during onboarding (MEDIUM)
**Steps:** Select "Starter" plan during onboarding > Complete onboarding > View dashboard
**Expected:** Dashboard shows "Starter" plan
**Actual:** Dashboard shows "Free" plan badge
**Root cause:** Plan selection may not be persisting to the database, or the default is always Free during beta
**Impact:** User confusion about their plan tier

## BUG-S35-03: Email verification template is default Supabase (LOW)
**Steps:** Sign up new account > Check email
**Expected:** Branded Arkova email with logo, styling, clear CTA
**Actual:** Plain text Supabase default: "Confirm your signup / Follow this link to confirm your user: / Confirm your mail"
**Root cause:** Supabase email templates not customized in project settings
**Impact:** Unprofessional appearance, reduces trust for new users

## BUG-S35-04: Google OAuth login fails — redirects back to login (CRITICAL) — FIXED
**Steps:** Click "Continue with Google" > Select Google account > Redirected to /auth/callback
**Expected:** OAuth flow completes, user redirected to dashboard
**Actual:** Shows "Completing sign in..." spinner, then redirects back to /login
**Root cause:** AuthCallbackPage only listened for `SIGNED_IN` event, not `INITIAL_SESSION` (which is what Supabase PKCE flow fires). Also, supabase.ts hash-stripping via `queueMicrotask` raced with session detection.
**Fix:** Updated AuthCallbackPage to handle `INITIAL_SESSION` event + added proactive `getSession()` fallback. Changed hash-stripping from `queueMicrotask` to `setTimeout(2000)`.
**Files changed:** `src/pages/AuthCallbackPage.tsx`, `src/lib/supabase.ts`

## BUG-S35-05: Worker crash loop — anchors stuck 48+ hours (CRITICAL) — FIXED
**Steps:** Upload document > Anchor created > Status stays PROCESSING / "Awaiting submission" for 48+ hours
**Expected:** Anchors submitted to Bitcoin within minutes
**Actual:** Worker revision 00243-cm6 crash-looping with "Invalid worker configuration" (bitcoinRpcUrl invalid). Even on working revision 00245-tpn, chain client failed to init because BITCOIN_UTXO_PROVIDER=getblock requires BITCOIN_RPC_URL which was removed.
**Root cause:** BITCOIN_UTXO_PROVIDER was set to 'getblock' but BITCOIN_RPC_URL was removed in Session 34. GetBlock provider requires RPC URL.
**Fix:** Updated Cloud Run env var BITCOIN_UTXO_PROVIDER=mempool. Deployed revision 00246-lrb. Worker health: ok, chain: mainnet, anchoring: ok.
**Impact:** ALL anchor processing was halted for 48+ hours. ~4 user documents stuck.

## BUG-S35-06: Document name not editable from document detail view (LOW)
**Steps:** View document detail page > Try to rename document
**Expected:** Inline edit of document filename
**Actual:** User reports inability to change document name
**Note:** Inline filename edit was added in Session 31 (pencil icon on hover). Needs verification that it works on production.

## BUG-S35-07: Admin Overview — Records by Status all showing 0 (MEDIUM)
**Steps:** Navigate to /admin/overview as platform admin
**Expected:** Records by Status shows real counts (Pending, Submitted, Secured, Revoked)
**Actual:** All status counts show 0. Also "Total Records: 0" despite 1.39M+ records existing.
**Root cause:** admin-stats RPC may be counting only user-scoped records, not platform-wide.
**Impact:** Admin can't see platform health at a glance.

## BUG-S35-08: Treasury — Unable to fetch balance (MEDIUM)
**Steps:** Navigate to /admin/treasury
**Expected:** Fee Account Balance shows BTC balance
**Actual:** "Unable to fetch balance"
**Root cause:** Mempool API call for treasury address balance may be failing or the treasury address isn't configured correctly in the new revision.
**Impact:** Admin can't verify treasury funding status.

## BUG-S35-09: Treasury — Network Transactions and Avg Records/TX show 0 (LOW)
**Steps:** Navigate to /admin/treasury
**Expected:** Shows count of Bitcoin transactions and average records per TX
**Actual:** Both show 0 despite 1.28M+ anchored records
**Root cause:** May be counting only recent transactions or the query excludes batch/pipeline TXs.

## BUG-S35-10: Pipeline page — All metrics show 0 (MEDIUM)
**Steps:** Navigate to /admin/pipeline
**Expected:** Shows ingested, anchored, pending, embedded counts
**Actual:** All show 0, "No records ingested yet"
**Root cause:** Pipeline stats may be using a different RPC that's not returning data, or ENABLE_PUBLIC_RECORD_ANCHORING is disabled (confirmed in worker logs).

## BUG-S35-11: Verification API — record_uri uses arkova.io instead of arkova.ai (LOW)
**Steps:** Call /api/v1/verify/:publicId
**Expected:** record_uri points to app.arkova.ai
**Actual:** record_uri points to app.arkova.io (old domain)
**Root cause:** Hardcoded domain in verification API response builder

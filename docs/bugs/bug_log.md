# Arkova Bug Log
_Last updated: 2026-03-10 | Active bugs: 6 | Resolved: 4_

## Active Bugs Summary

| ID | Severity | Story | Summary | Status |
|----|----------|-------|---------|--------|
| CRIT-1 | HIGH | P4-E1 | SecureDocumentDialog fakes anchor creation | OPEN |
| CRIT-2 | HIGH | P7-TS-05 | No real Bitcoin chain client | OPEN |
| CRIT-3 | HIGH | P7-TS-02 | No Stripe checkout flow | OPEN |
| CRIT-4 | MEDIUM | P2 | Onboarding routes are placeholders | OPEN |
| CRIT-5 | MEDIUM | P7-TS-07 | JSON proof download is no-op | OPEN |
| CRIT-6 | MEDIUM | P5-TS-06 | CSVUploadWizard uses simulated processing | OPEN |

## Resolved Bugs Summary

| ID | Severity | Story | Summary | Resolution |
|----|----------|-------|---------|------------|
| CRIT-7 | LOW | — | Browser tab says "Ralph" | FIXED 2026-03-10 |
| BUG-H1-01 | MEDIUM | P7-TS-05 | Silent audit event failure in processAnchor() | FIXED 2026-03-10 |
| BUG-H1-02 | HIGH | P7-TS-10 | receipt.merkleRoot type error in anchorWithClaim.ts | REMOVED 2026-03-10 |
| BUG-H1-03 | HIGH | P7-TS-10 | processAllJobs() loop exits after first batch | REMOVED 2026-03-10 |

---

## Bug Details

---

### CRIT-1: SecureDocumentDialog Fakes Anchor Creation

- **Severity:** HIGH (production blocker)
- **Found:** 2026-03-10, codebase audit
- **Story:** P4-E1-TS-01 (affects individual user path only)
- **Component:** `src/components/anchor/SecureDocumentDialog.tsx`

#### Steps to Reproduce

1. Start local Supabase: `supabase start`
2. Reset database: `supabase db reset`
3. Login as `individual@demo.arkova.io` / `Demo1234!`
4. Navigate to Dashboard
5. Click "Secure Document" (opens SecureDocumentDialog)
6. Select any PDF file, confirm the anchor
7. Observe: UI shows progress animation and success after ~1.5 seconds
8. Query `anchors` table: `SELECT * FROM anchors WHERE user_id = '33333333-0000-0000-0000-000000000001' ORDER BY created_at DESC LIMIT 1;`
9. **Result:** No new row was inserted

#### Expected Behavior

Anchor row inserted into `anchors` table via Supabase client with status `PENDING`, matching the pattern in `IssueCredentialForm.tsx`: `validateAnchorCreate()` -> `supabase.from('anchors').insert()` -> `logAuditEvent()`.

#### Actual Behavior

`SecureDocumentDialog.tsx` lines 49-69 use `setTimeout` to simulate success:

```typescript
// Simulate anchor creation process
for (let i = 0; i <= 100; i += 20) {
  await new Promise(resolve => setTimeout(resolve, 300));
  setProgress(i);
}
setStep('success');
```

No Supabase call is made. The file fingerprint is computed correctly by `FileUpload` but never persisted.

#### Root Cause

Component was built as a UI prototype before the Supabase schema existed. Never updated to use real database calls. The org admin path (`IssueCredentialForm`) was built later with real integration.

#### Fix Pattern

Follow `src/components/organization/IssueCredentialForm.tsx` (lines 89-155):

1. Import `supabase` from `@/lib/supabase`
2. Call `validateAnchorCreate()` from `@/lib/validators`
3. `supabase.from('anchors').insert({ ...validated, user_id: user.id }).select('id').single()`
4. Call `logAuditEvent()` on success
5. Remove `setTimeout` simulation and fake progress loop

#### Actions Taken

| Date | Action |
|------|--------|
| 2026-03-10 | Identified during codebase audit. Documented in CLAUDE.md Section 8. |

#### Resolution

**Status:** OPEN

#### Regression Test

- Existing: `src/components/anchor/ConfirmAnchorModal.test.tsx` (covers the shared confirm modal)
- Needed: Integration test for `SecureDocumentDialog` that verifies anchor row appears in DB after submit

---

### CRIT-2: No Real Bitcoin Chain Client

- **Severity:** HIGH (production blocker)
- **Found:** 2026-03-10, codebase audit
- **Story:** P7-TS-05
- **Component:** `services/worker/src/chain/client.ts`

#### Steps to Reproduce

1. Read `services/worker/src/chain/client.ts` line 15-23
2. Observe: `getChainClient()` returns `MockChainClient` in all code paths, including when `config.useMocks = false`
3. No `bitcoinjs-lib` dependency in `services/worker/package.json`

#### Expected Behavior

When `BITCOIN_NETWORK=mainnet` and `BITCOIN_TREASURY_WIF` is set, `getChainClient()` should return a real chain client that constructs OP_RETURN transactions, signs via AWS KMS, and submits to Bitcoin network.

#### Actual Behavior

```typescript
export function getChainClient(): ChainClient {
  if (config.useMocks || config.nodeEnv === 'test') {
    return new MockChainClient();
  }
  // TODO: Implement real chain client
  return new MockChainClient();
}
```

All paths return `MockChainClient` which uses `setTimeout(resolve, 100)` to simulate network calls, increments a fake block counter, and stores data in an in-memory Map.

#### Root Cause

Real Bitcoin integration was deferred. The interface contract exists (`ChainClient` in `types.ts`) but no implementation. Decision made to harden worker tests first (2026-03-10) before implementing real chain client.

#### Fix Pattern

1. Install `bitcoinjs-lib` in `services/worker/`
2. Create `services/worker/src/chain/real.ts` implementing `ChainClient` interface
3. Construct OP_RETURN transactions with document fingerprint
4. Sign via `BITCOIN_TREASURY_WIF` env var (later: AWS KMS)
5. Submit to Bitcoin network (Signet first, then Mainnet)
6. Update `getChainClient()` factory to return real client when not in test/mock mode
7. Gate behind `ENABLE_PROD_NETWORK_ANCHORING` switchboard flag

#### Actions Taken

| Date | Action |
|------|--------|
| 2026-03-10 | Identified during codebase audit. Decision: worker hardening sprint first (0% test coverage). |

#### Resolution

**Status:** OPEN — Blocked by worker hardening (Week 1), scheduled for Weeks 2-3.

#### Regression Test

- Needed: `ChainClient` interface contract test (mock and real both satisfy same interface)
- Needed: Integration test: PENDING -> job claimed -> chain submitted -> SECURED

---

### CRIT-3: No Stripe Checkout Flow

- **Severity:** HIGH (production blocker)
- **Found:** 2026-03-10, codebase audit
- **Story:** P7-TS-02
- **Components:** `services/worker/src/stripe/client.ts`, `services/worker/src/stripe/handlers.ts`, `src/components/billing/BillingOverview.tsx`

#### Steps to Reproduce

1. Login as any user
2. Navigate to settings — no billing/upgrade option is available
3. `BillingOverview.tsx` exists but is not routed to any page
4. No `/api/stripe/checkout` endpoint exists in worker
5. `handlers.ts` webhook handlers have database update logic commented out

#### Expected Behavior

Users can view pricing, select a plan, enter payment via Stripe Checkout, and have their subscription activated. Webhook handlers persist subscription data to profiles table.

#### Actual Behavior

- Stripe SDK is initialized in `client.ts` (line 21)
- `verifyWebhookSignature()` works (lines 34-51)
- Webhook handlers exist but database updates are commented out (lines 52-66)
- `isEventProcessed()` always returns `false` (no idempotency)
- `BillingOverview.tsx` renders but is orphaned (not routed, no data source)
- No checkout session creation endpoint

#### Root Cause

Billing was scaffolded (schema in migration 0016, SDK initialized, webhook verification) but the end-to-end checkout flow was never completed.

#### Fix Pattern

1. Create worker endpoint: `POST /api/stripe/checkout` calling `stripe.checkout.sessions.create()`
2. Define pricing plans in Stripe Dashboard
3. Add `stripe_customer_id`, `stripe_subscription_id` columns to profiles (new migration)
4. Uncomment database updates in `handlers.ts`
5. Implement `isEventProcessed()` for idempotent webhook handling
6. Route `BillingOverview` on a settings sub-page with real subscription data
7. Connect `onUpgrade()` callback to redirect to Stripe Checkout URL

#### Actions Taken

| Date | Action |
|------|--------|
| 2026-03-10 | Identified during codebase audit. |

#### Resolution

**Status:** OPEN — Scheduled for Weeks 1-2.

#### Regression Test

- Needed: Stripe webhook handler unit tests with mock Stripe events
- Needed: Checkout session creation test with mock Stripe SDK

---

### CRIT-4: Onboarding Routes Are Placeholders

- **Severity:** MEDIUM
- **Found:** 2026-03-10, codebase audit
- **Story:** P2 Identity (onboarding)
- **Component:** `src/App.tsx` (lines 95-130)

#### Steps to Reproduce

1. Create a new user account (signup)
2. Confirm email
3. Login — `useProfile` computes destination as `/onboarding/role`
4. Route guard redirects to `/onboarding/role`
5. **Result:** User sees the Dashboard page instead of role selection UI

#### Expected Behavior

- `/onboarding/role` renders `RoleSelector` component
- `/onboarding/org` renders `OrgOnboardingForm` component
- `/review-pending` renders `ManualReviewGate` component

#### Actual Behavior

All three routes in `App.tsx` render `<DashboardPage />` with TODO comments:

```typescript
<Route path={ROUTES.ONBOARDING_ROLE} element={
  <AuthGuard><RouteGuard allow={['/onboarding/role']}>
    {/* TODO: Wire OnboardingRolePage when implemented */}
    <DashboardPage />
  </RouteGuard></AuthGuard>
} />
```

#### Root Cause

Routes were scaffolded with placeholders. The actual components (`RoleSelector`, `OrgOnboardingForm`, `ManualReviewGate`) were built later but never wired into the router.

#### Fix Pattern

1. Create thin page wrappers in `src/pages/`:
   - `OnboardingRolePage.tsx` → renders `<RoleSelector onSelect={...} />`
   - `OnboardingOrgPage.tsx` → renders `<OrgOnboardingForm onSubmit={...} />`
   - `ReviewPendingPage.tsx` → renders `<ManualReviewGate />`
2. Import into `App.tsx` and replace `<DashboardPage />` on lines 102, 113, 126
3. Connect `RoleSelector.onSelect` to `useOnboarding().setRole()`
4. Connect `OrgOnboardingForm.onSubmit` to `useOnboarding().createOrg()`
5. Test: new user signup → role selection → org form (if ORG_ADMIN) → dashboard

#### Actions Taken

| Date | Action |
|------|--------|
| 2026-03-10 | Identified during codebase audit. Components confirmed to exist and be production-ready. |

#### Resolution

**Status:** OPEN — Quick fix (sub-day task).

#### Regression Test

- Existing: `e2e/onboarding.spec.ts` (9 tests), `e2e/route-guards.spec.ts` (8 tests)
- These tests will validate the fix once routes are wired

---

### CRIT-5: JSON Proof Package Download Is No-Op

- **Severity:** MEDIUM
- **Found:** 2026-03-10, codebase audit
- **Story:** P7-TS-07
- **Components:** `src/components/public/ProofDownload.tsx`, `src/lib/proofPackage.ts`

#### Steps to Reproduce

1. Login as `admin@umich-demo.arkova.io` / `Demo1234!`
2. Navigate to a SECURED anchor detail page (e.g., Maya Chen's BS Computer Science)
3. Find the proof download section
4. Click "PDF Certificate" — works, downloads PDF
5. Click "JSON Data" — nothing happens

#### Expected Behavior

Clicking "JSON Data" triggers download of a structured JSON proof package containing fingerprint, chain receipt, timestamps, and issuer information.

#### Actual Behavior

`ProofDownload.tsx` renders two buttons. The `onDownloadJSON` callback prop is either not provided by the parent component or provided as a no-op. The `downloadProofPackage()` function in `proofPackage.ts` (lines 158-170) exists and works — it creates a Blob, generates a URL, and triggers download — but no caller invokes it.

#### Root Cause

The PDF path was completed (`generateAuditReport.ts`), but the JSON path was never connected. `proofPackage.ts` has the generator and downloader functions, but the parent component never wires `onDownloadJSON` to call them.

#### Fix Pattern

In the parent component where `<ProofDownload>` is rendered:

```typescript
import { generateProofPackage, downloadProofPackage } from '@/lib/proofPackage';

const handleJsonDownload = () => {
  const pkg = generateProofPackage(anchor);
  downloadProofPackage(pkg, `arkova-proof-${anchor.public_id}.json`);
};

<ProofDownload
  proof={proof}
  onDownloadPDF={handlePdfDownload}
  onDownloadJSON={handleJsonDownload}
/>
```

#### Actions Taken

| Date | Action |
|------|--------|
| 2026-03-10 | Identified during codebase audit. Functions confirmed to exist in proofPackage.ts. |

#### Resolution

**Status:** OPEN — Scheduled for Weeks 1-2.

#### Regression Test

- Needed: Unit test verifying `generateProofPackage()` returns valid schema
- Needed: Integration test verifying JSON download triggers on button click

---

### CRIT-6: CSVUploadWizard Uses Simulated Processing

- **Severity:** MEDIUM
- **Found:** 2026-03-10, codebase audit
- **Story:** P5-TS-06
- **Components:** `src/components/upload/CSVUploadWizard.tsx`, `src/hooks/useBulkAnchors.ts`

#### Steps to Reproduce

1. Login as `admin@umich-demo.arkova.io` / `Demo1234!`
2. Navigate to Organization page
3. Open the CSV Upload Wizard
4. Upload any CSV file
5. **Result:** Wizard shows hardcoded mock columns (`filename`, `fingerprint`, `size`, `description`) regardless of file content
6. Click Validate — shows fake results (47 valid, 3 invalid) after 1.5s delay
7. Click Process — shows fake progress bar, claims `total - 2` successful
8. Query `anchors` table — no new rows inserted

#### Expected Behavior

Wizard parses actual CSV file, validates each row with `validateAnchorCreate()`, then calls `useBulkAnchors().createBulkAnchors()` to insert via `bulk_create_anchors` RPC.

#### Actual Behavior

`CSVUploadWizard.tsx` has three simulated stages:

- **handleFileUpload** (line 93): Ignores uploaded file, returns hardcoded mock columns
- **handleValidate** (line 118): Uses `setTimeout(resolve, 1500)` with hardcoded validation results
- **handleProcess** (line 137): Loops with `setTimeout(resolve, 50)` for fake progress, returns hardcoded results

The `useBulkAnchors` hook exists with real Supabase RPC integration but is never imported or called.

#### Root Cause

Wizard was built as a UI prototype with simulated data. The `useBulkAnchors` hook was built separately but the two were never connected.

#### Fix Pattern

1. Import a CSV parser (project already has `src/lib/csvParser.ts`)
2. In `handleFileUpload`: parse actual file, extract real columns
3. In `handleValidate`: call `validateAnchorCreate()` on each row
4. In `handleProcess`: call `useBulkAnchors().createBulkAnchors(validatedRecords)`
5. Use the hook's progress tracking and error handling
6. Remove all `setTimeout` simulations

#### Actions Taken

| Date | Action |
|------|--------|
| 2026-03-10 | Identified during codebase audit. Hook confirmed to have real Supabase integration. |

#### Resolution

**Status:** OPEN — Quick fix (sub-day task, hook already exists).

#### Regression Test

- Existing: `src/hooks/useBulkAnchors.test.ts`, `src/components/upload/BulkUploadWizard.test.tsx`, `src/components/upload/CsvUploader.test.tsx`
- Needed: Integration test for CSVUploadWizard end-to-end with real CSV parsing

---

---

## Resolved Bugs

---

### CRIT-7: Browser Tab Says "Ralph"

- **Severity:** LOW
- **Found:** 2026-03-10, codebase audit
- **Story:** N/A (branding)
- **Components:** `package.json`, `index.html`

#### Steps to Reproduce

1. Run `npm run dev`
2. Open browser at `localhost:5173`
3. Look at browser tab title
4. **Result:** Tab says "Ralph"

#### Expected Behavior

Browser tab says "Arkova".

#### Actual Behavior

- `package.json` line 2: `"name": "ralph"`
- `index.html` line 6: `<title>Ralph</title>`

#### Root Cause

Old codename "Ralph" was never updated to "Arkova" in these two files.

#### Actions Taken

| Date | Action |
|------|--------|
| 2026-03-10 | Identified during codebase audit. |
| 2026-03-10 | Fixed: `package.json` name → `arkova`, `index.html` title → `Arkova`. |

#### Resolution

**Status:** FIXED — 2026-03-10. Commit `3031c23`.

#### Regression Test

- None needed. Visual verification only.

---

### BUG-H1-01: Silent Audit Event Failure in processAnchor()

- **Severity:** MEDIUM
- **Found:** 2026-03-10, HARDENING-1 sprint (worker test coverage)
- **Story:** P7-TS-05 (anchor processing pipeline)
- **Component:** `services/worker/src/jobs/anchor.ts`

#### Steps to Reproduce

1. Start the worker service: `cd services/worker && npm run dev`
2. Insert a PENDING anchor into the `anchors` table
3. Trigger anchor processing (cron runs every minute, or POST `/jobs/process-anchors`)
4. Simulate an `audit_events` table failure (e.g., table full, constraint violation on the insert)
5. Observe logs: **no error or warning is logged** despite the audit insert failing
6. The anchor IS correctly updated to SECURED — the audit failure is silently swallowed

#### Expected Behavior

When the audit event insert fails after a successful anchor securing:
- A warning is logged with the error details (non-fatal — the anchor is already secured)
- The function still returns `true` (anchor was secured successfully)
- Operators can detect audit logging gaps via log monitoring

#### Actual Behavior

The original code performed a bare `await` on the Supabase insert without capturing the return value:

```typescript
// Original (broken)
await db.from('audit_events').insert({
  event_type: 'anchor.secured',
  // ...
});
// Error silently discarded — Supabase returns {data, error}, never throws
```

Supabase's PostgREST client does not throw on insert errors — it returns `{ data, error }`. Since the return value was never destructured, the error was invisible.

#### Root Cause

Supabase client API design: errors are returned, not thrown. The original code treated the insert as a fire-and-forget `await` without checking the result. This is a common pattern mistake when moving from ORMs that throw on failure to Supabase's `{data, error}` pattern.

#### Fix Pattern

Destructure the return value and log on failure:

```typescript
// Fixed
const { error: auditError } = await db.from('audit_events').insert({
  event_type: 'anchor.secured',
  // ...
});

if (auditError) {
  logger.warn({ anchorId, error: auditError }, 'Failed to log audit event for secured anchor');
}
```

#### Actions Taken

| Date | Action |
|------|--------|
| 2026-03-10 | Found during HARDENING-1 while writing unit tests for `processAnchor()`. |
| 2026-03-10 | Fixed in `anchor.ts` lines 55-67: destructured `{ error: auditError }`, added `if (auditError)` with `logger.warn`. |

#### Resolution

**Status:** FIXED — 2026-03-10. Applied in `services/worker/src/jobs/anchor.ts` lines 55-67.

#### Regression Test

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| `services/worker/src/jobs/anchor.test.ts` | Unit | "audit event failure" describe block — 2 tests |

Specific tests:
- `still returns true when audit event insert fails` — confirms anchor securing is non-fatal on audit failure
- `logs warning when audit event insert fails` — confirms `logger.warn` is called with error details

#### How to Verify (Manual)

1. Run worker tests: `cd services/worker && npx vitest run`
2. Confirm all 27 tests pass, including the "audit event failure" block
3. Read `anchor.ts` lines 55-67 — verify `{ error: auditError }` is destructured and checked

---

### BUG-H1-02: receipt.merkleRoot Type Error in anchorWithClaim.ts

- **Severity:** HIGH (compile error — dead code path)
- **Found:** 2026-03-10, HARDENING-1 sprint (worker test coverage)
- **Story:** P7-TS-10 (webhook dispatch — anchorWithClaim.ts was intended as future anchor pipeline)
- **Component:** `services/worker/src/jobs/anchorWithClaim.ts` (deleted)

#### Steps to Reproduce

1. Run `cd services/worker && npx tsc --noEmit`
2. Observe compile error: `Property 'merkleRoot' does not exist on type 'ChainReceipt'`
3. The error is on line 83 of `anchorWithClaim.ts`

#### Expected Behavior

`receipt` fields should match the `ChainReceipt` interface defined in `chain/types.ts`:
- `receiptId: string`
- `blockHeight: number`
- `blockTimestamp: string`
- `confirmations: number`

#### Actual Behavior

Line 83 referenced `receipt.merkleRoot`, which does not exist on the `ChainReceipt` interface. The file compiled only because TypeScript's `--noEmit` check was not part of CI, and the file was never imported.

Additional problems in the same file:
- References table `anchoring_jobs` — does not exist in the schema
- References table `anchor_proofs` — does not exist in the schema
- Calls RPC `claim_anchoring_job` — does not exist
- Calls RPC `complete_anchoring_job` — does not exist

#### Root Cause

`anchorWithClaim.ts` was written speculatively against a planned schema (job-claim architecture with `anchoring_jobs`, `anchor_proofs`, and atomic RPCs). That schema was never implemented. The file was never imported by `index.ts` — the worker exclusively uses `anchor.ts` via `processPendingAnchors()`. The file accumulated as dead code with no compile-time or runtime validation.

#### Fix Pattern

**Decision: Delete the file.** Fixing the type error would produce code that compiles but references four nonexistent database objects. When the job-claim architecture is actually needed, it should be built from scratch against the real schema with proper test coverage.

Also removed the 80% per-file coverage threshold for `anchorWithClaim.ts` from `services/worker/vitest.config.ts` — an unreachable threshold on a deleted file would fail CI.

#### Actions Taken

| Date | Action |
|------|--------|
| 2026-03-10 | Found during HARDENING-1 while auditing worker code for test coverage. |
| 2026-03-10 | Confirmed file is never imported (grep for `anchorWithClaim` — zero hits in source). |
| 2026-03-10 | Deleted `anchorWithClaim.ts`. Removed coverage threshold from `vitest.config.ts`. |

#### Resolution

**Status:** RESOLVED — 2026-03-10. File deleted. Coverage threshold removed.

#### Regression Test

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| `services/worker/src/jobs/anchor.test.ts` | Unit | Validates the real anchor pipeline (`processAnchor` + `processPendingAnchors`) — 27 tests, 100% coverage |

No dedicated test needed for deleted code. The real anchor pipeline in `anchor.ts` has full coverage. When job-claim architecture is rebuilt, tests should be written alongside.

#### How to Verify (Manual)

1. Confirm file does not exist: `ls services/worker/src/jobs/anchorWithClaim.ts` → "No such file"
2. Confirm no broken imports: `cd services/worker && npx vitest run` → 27 tests pass
3. Confirm coverage threshold removed: read `services/worker/vitest.config.ts` — no `anchorWithClaim` entry

---

### BUG-H1-03: processAllJobs() Loop Exits After First Batch in anchorWithClaim.ts

- **Severity:** HIGH (logic error — dead code path)
- **Found:** 2026-03-10, HARDENING-1 sprint (worker test coverage)
- **Story:** P7-TS-10 (webhook dispatch — anchorWithClaim.ts was intended as future anchor pipeline)
- **Component:** `services/worker/src/jobs/anchorWithClaim.ts` (deleted)

#### Steps to Reproduce

1. Read `processAllJobs()` in `anchorWithClaim.ts` (lines 122-153)
2. When `claimAndProcessJob()` returns `false`, the function checks for remaining pending jobs:
   ```typescript
   const { data: pendingCount } = await db
     .from('anchoring_jobs')
     .select('id', { count: 'exact', head: true })
     .eq('status', 'pending');
   ```
3. `head: true` tells Supabase to return only the count, suppressing row data — so `data` is `null`
4. The check `if (!pendingCount || pendingCount === 0)` always evaluates to `true` (null is falsy)
5. `hasMore` is set to `false`, and the loop exits immediately

#### Expected Behavior

The loop should continue claiming and processing jobs until no pending jobs remain. The count check should use Supabase's `count` return value, not the `data` return value.

#### Actual Behavior

The loop always exits after the first failed claim because `head: true` makes `data` null, causing the "no more jobs" branch to fire unconditionally. Even if 100 pending jobs existed, only one attempt would be made.

#### Root Cause

Misuse of Supabase's `head: true` query option. With `head: true`, the query returns `{ data: null, count: N }` — the count is in the `count` field, not `data`. The code checked `data` instead of destructuring `count`. This is the same file that had BUG-H1-02 — written speculatively against a nonexistent schema and never tested.

#### Fix Pattern

**Decision: Delete the file.** Same rationale as BUG-H1-02 — the entire file references nonexistent tables and RPCs. The correct Supabase pattern for count-only queries is:

```typescript
const { count } = await db
  .from('anchoring_jobs')
  .select('id', { count: 'exact', head: true })
  .eq('status', 'pending');

if (!count || count === 0) {
  hasMore = false;
}
```

But fixing this one line would still leave a file that can't run against the actual database.

#### Actions Taken

| Date | Action |
|------|--------|
| 2026-03-10 | Found during HARDENING-1 while auditing worker code for test coverage. |
| 2026-03-10 | Confirmed file references 4 nonexistent schema objects and is never imported. |
| 2026-03-10 | Deleted `anchorWithClaim.ts` (same action as BUG-H1-02). |

#### Resolution

**Status:** RESOLVED — 2026-03-10. File deleted (same action as BUG-H1-02).

#### Regression Test

Same as BUG-H1-02 — the real anchor pipeline in `anchor.ts` has 27 tests with 100% coverage. When job-claim architecture is rebuilt, the batch processing loop must be tested with the correct Supabase count pattern.

#### How to Verify (Manual)

Same as BUG-H1-02.

---

## Change Log

| Date | Change |
|------|--------|
| 2026-03-10 | Initial bug log created with CRIT-1 through CRIT-7, migrated from CLAUDE.md Section 8 summary table. Full steps to reproduce, root cause analysis, and fix patterns documented for all 7 bugs. |
| 2026-03-10 | Added HARDENING-1 bugs (BUG-H1-01, BUG-H1-02, BUG-H1-03). Moved CRIT-7 to resolved. Updated summary counts: 6 active, 4 resolved. |

# Arkova Bug Log
_Last updated: 2026-03-11 | Active bugs: 2 | Resolved: 15_

## Layman's Summary

_For each bug: what it means in plain English and why it matters._

| ID | What's Wrong (Plain English) |
|----|------------------------------|
| ~~CRIT-1~~ | ~~When a regular user tries to secure a document, the app **pretends** it worked (shows a fake progress bar) but never actually saves anything.~~ **FIXED** — real Supabase insert replacing setTimeout simulation. |
| CRIT-2 | The system that's supposed to write a permanent record to the Bitcoin network is **completely fake**. It uses a pretend version that stores data in temporary memory and disappears when the server restarts. No real proof exists on any blockchain. |
| CRIT-3 | There's **no way to pay for the service**. The payment system (Stripe) is partially set up — it can verify incoming payment notifications — but there's no "Buy" or "Upgrade" button that actually charges a credit card. |
| ~~CRIT-4~~ | ~~New users who sign up get **dumped straight onto the dashboard** instead of going through the setup wizard.~~ **FIXED** — OnboardingRolePage, OnboardingOrgPage, ReviewPendingPage wired into App.tsx. |
| ~~CRIT-5~~ | ~~The "Download JSON Proof" button **does absolutely nothing** when clicked.~~ **FIXED** — onDownloadProofJson wired in RecordDetailPage with generateProofPackage + downloadProofPackage. |
| ~~CRIT-6~~ | ~~The CSV bulk upload wizard **ignores whatever file you upload** and shows fake results.~~ **FIXED** — CSVUploadWizard connected to csvParser functions + useBulkAnchors hook. |
| CRIT-7 | _(Resolved)_ The browser tab said "Ralph" (an old project codename) instead of "Arkova". |
| BUG-H1-01 | _(Resolved)_ When the system secured a document but failed to write the audit log entry, **nobody was told about the failure**. The document was secured correctly, but the missing audit trail entry could go unnoticed indefinitely. |
| BUG-H1-02 | _(Resolved)_ A dead code file referenced database tables and fields that **don't exist**. It would have crashed if anyone ever tried to use it. Deleted because it was never imported anywhere. |
| BUG-H1-03 | _(Resolved)_ A batch processing loop in the same dead code file **always quit after one try** because it misread the database response. Even if 100 jobs were waiting, only one would ever be attempted. Deleted along with BUG-H1-02. |
| ~~BUG-PRH1-01~~ | ~~The validation library's test coverage was below threshold (71% vs 80% for functions).~~ **FIXED** — added 10 tests, now at 100%. |
| ~~BUG-PRH1-02~~ | ~~The proof package generator had zero test coverage.~~ **FIXED** — created 33-test suite, now at 100%. |
| ~~BUG-SQ-01~~ | ~~Two email-checking regexes could freeze the app if fed a very long, weird email address (a "ReDoS" attack).~~ **FIXED** — replaced with non-backtracking regexes. |
| ~~BUG-SQ-02~~ | ~~The worker server told the world it was running Express (via `x-powered-by` header), making it easier for attackers to find known vulnerabilities.~~ **FIXED** — disabled header. |

## Active Bugs Summary

| ID | Severity | Story | Summary | Status |
|----|----------|-------|---------|--------|
| CRIT-2 | HIGH | P7-TS-05 | No real Bitcoin chain client | OPEN |
| CRIT-3 | HIGH | P7-TS-02 | No Stripe checkout flow | OPEN |

## Resolved Bugs Summary

| ID | Severity | Story | Summary | Resolution |
|----|----------|-------|---------|------------|
| CRIT-1 | HIGH | P4-E1 | SecureDocumentDialog fakes anchor creation | FIXED 2026-03-10 (commit a38b485) |
| CRIT-4 | MEDIUM | P2 | Onboarding routes are placeholders | FIXED 2026-03-10 (commit a38b485) |
| CRIT-5 | MEDIUM | P7-TS-07 | JSON proof download is no-op | FIXED 2026-03-10 (commit a38b485) |
| CRIT-6 | MEDIUM | P5-TS-06 | CSVUploadWizard uses simulated processing | FIXED 2026-03-10 (commit a38b485) |
| CRIT-7 | LOW | — | Browser tab says "Ralph" | FIXED 2026-03-10 |
| BUG-H1-01 | MEDIUM | P7-TS-05 | Silent audit event failure in processAnchor() | FIXED 2026-03-10 |
| BUG-H1-02 | HIGH | P7-TS-10 | receipt.merkleRoot type error in anchorWithClaim.ts | REMOVED 2026-03-10 |
| BUG-H1-03 | HIGH | P7-TS-10 | processAllJobs() loop exits after first batch | REMOVED 2026-03-10 |
| BUG-PRH1-01 | LOW | — | validators.ts functions coverage below 80% threshold | FIXED 2026-03-10 |
| BUG-PRH1-02 | MEDIUM | P7-TS-07 | proofPackage.ts has 0% coverage against 80% threshold | FIXED 2026-03-10 |
| BUG-SQ-01 | MEDIUM | — | ReDoS-vulnerable email regex in InviteMemberModal + csvParser | FIXED 2026-03-11 |
| BUG-SQ-02 | LOW | — | Express x-powered-by header information disclosure in worker | FIXED 2026-03-11 |

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
| 2026-03-10 | FIXED — Rewrote SecureDocumentDialog.tsx: replaced setTimeout simulation with real Supabase insert following IssueCredentialForm pattern (validateAnchorCreate → supabase.from('anchors').insert() → logAuditEvent). Commit a38b485. |

#### Resolution

**Status:** FIXED (commit a38b485, 2026-03-10)

#### Regression Test

- Existing: `src/components/anchor/ConfirmAnchorModal.test.tsx` (covers the shared confirm modal)

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
| 2026-03-10 | FIXED — Created OnboardingRolePage.tsx (useOnboarding.setRole → refreshProfile), OnboardingOrgPage.tsx (useOnboarding.createOrg → refreshProfile), ReviewPendingPage.tsx (ManualReviewGate + signOut). Wired into App.tsx replacing DashboardPage placeholders. Commit a38b485. |

#### Resolution

**Status:** FIXED (commit a38b485, 2026-03-10)

#### Regression Test

- Existing: `e2e/onboarding.spec.ts` (9 tests), `e2e/route-guards.spec.ts` (8 tests)

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
| 2026-03-10 | FIXED — Added onDownloadProofJson prop to AssetDetailView. Wired in RecordDetailPage with dynamic import of proofPackage.ts (generateProofPackage + downloadProofPackage + getProofPackageFilename). Two download buttons: PDF (outline) + JSON (primary). Commit a38b485. |

#### Resolution

**Status:** FIXED (commit a38b485, 2026-03-10)

#### Regression Test

- Existing: `src/lib/proofPackage.test.ts` (33 tests, 100% coverage)
- Updated: `src/components/anchor/AssetDetailView.test.tsx` — test verifies both PDF and JSON buttons render

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
| 2026-03-10 | FIXED — Rewrote CSVUploadWizard.tsx: replaced all mock handlers with real csvParser functions (parseCsvFile, autoDetectMapping, validateCsvRows, extractAnchorRecords) and useBulkAnchors hook. All 6 column mappings (fingerprint, filename, fileSize, email, credentialType, metadata) supported. Commit a38b485. |

#### Resolution

**Status:** FIXED (commit a38b485, 2026-03-10)

#### Regression Test

- Existing: `src/hooks/useBulkAnchors.test.ts`, `src/components/upload/BulkUploadWizard.test.tsx`, `src/components/upload/CsvUploader.test.tsx`

---

### BUG-PRH1-01: validators.ts Functions Coverage Below 80% Threshold

- **Severity:** LOW [PR-Hardening1-Bug]
- **Found:** 2026-03-10 6:45 PM EST, PR-HARDENING-1 audit (test suite run on main)
- **Story:** — (cross-cutting: coverage infrastructure)
- **Component:** `src/lib/validators.ts`, `vitest.config.ts`

#### Steps to Reproduce

1. Run `npm run test:coverage` from repo root
2. Observe coverage table: `validators.ts` shows functions at 71.42%
3. Observe error: `ERROR: Coverage for functions (71.42%) does not meet "src/lib/validators.ts" threshold (80%)`
4. CI fails on coverage threshold check

#### Expected Behavior

All per-file coverage thresholds pass. `validators.ts` functions coverage >= 80%.

#### Actual Behavior

Functions coverage is 71.42%. The file has 7 callable units (4 exported functions + 3 inline Zod callbacks). The 32 existing tests in `validators.test.ts` cover the 4 exported functions and the main schema paths, but 2 inline callbacks are untouched:

- `AnchorCreateSchema.metadata` custom validator (line 119-121): validates `typeof val === 'object' && !Array.isArray(val)` — no test passes an array to trigger the rejection path
- `AnchorUpdateSchema.credential_type` errorMap (line 177-179): generates custom error message — no test passes an invalid credential_type string through the update schema

#### Root Cause

Per-file threshold was added in commit `3031c23` at 80% for all metrics. The existing test file covers statements (98.34%), branches (100%), and lines (98.34%) — all well above 80%. Only functions falls short because V8 counts inline arrow functions (Zod `.custom()` callbacks, `.errorMap()` callbacks) as separate functions, and the error paths that invoke them are not exercised.

#### Fix Pattern

Add 2 tests to `src/lib/validators.test.ts`:

```typescript
it('rejects array as metadata', () => {
  const data = { ...validAnchor, metadata: [1, 2, 3] };
  expect(() => AnchorCreateSchema.parse(data)).toThrow('Metadata must be a JSON object');
});

it('rejects invalid credential_type in update schema', () => {
  const data = { credential_type: 'INVALID_TYPE' };
  expect(() => AnchorUpdateSchema.parse(data)).toThrow('Credential type must be one of');
});
```

#### Actions Taken

| Date | Action |
|------|--------|
| 2026-03-10 6:45 PM EST | Found during PR-HARDENING-1 test suite audit on main. Classified as non-worker, non-processAnchor code per decision tree. Logged, not fixed. |
| 2026-03-10 7:15 PM EST | Added 10 tests to `validators.test.ts`: metadata array/object, credential_type (both schemas), retention_until, deleted_at. Functions → 100%. |

#### Resolution

**Status:** FIXED (2026-03-10 7:15 PM EST) — Added 10 test cases to `src/lib/validators.test.ts`. validators.ts now at 100% functions, 100% statements, 94.73% branches coverage.

#### Regression Test

- `src/lib/validators.test.ts` → "rejects array as metadata", "rejects invalid credential_type" (AnchorCreateSchema + AnchorUpdateSchema), plus retention_until and deleted_at tests.

---

### BUG-PRH1-02: proofPackage.ts Has 0% Test Coverage Against 80% Threshold

- **Severity:** MEDIUM [PR-Hardening1-Bug]
- **Found:** 2026-03-10 6:45 PM EST, PR-HARDENING-1 audit (test suite run on main)
- **Story:** P7-TS-07 (Proof export — JSON path)
- **Component:** `src/lib/proofPackage.ts`, `vitest.config.ts`

#### Steps to Reproduce

1. Run `npm run test:coverage` from repo root
2. Observe coverage table: `proofPackage.ts` shows 0% across all metrics
3. Observe errors:
   - `ERROR: Coverage for lines (0%) does not meet "src/lib/proofPackage.ts" threshold (80%)`
   - `ERROR: Coverage for functions (0%) does not meet "src/lib/proofPackage.ts" threshold (80%)`
   - `ERROR: Coverage for statements (0%) does not meet "src/lib/proofPackage.ts" threshold (80%)`
   - `ERROR: Coverage for branches (0%) does not meet "src/lib/proofPackage.ts" threshold (80%)`
4. CI fails on all 4 coverage threshold checks

#### Expected Behavior

`proofPackage.ts` has >= 80% coverage. A test file `src/lib/proofPackage.test.ts` validates the schema, generator, validator, and download functions.

#### Actual Behavior

No test file exists. The file (170 lines) exports:

- `ProofPackageSchema` — Zod schema for proof package validation
- `generateProofPackage(anchor)` — builds proof package object from anchor data
- `validateProofPackage(data)` — validates arbitrary data against schema
- `downloadProofPackage(pkg, filename)` — creates Blob + triggers browser download

None of these are imported by any test.

#### Root Cause

Coverage threshold was added in commit `3031c23` alongside thresholds for `fileHasher.ts` and `validators.ts`. Those two had existing tests. `proofPackage.ts` did not, and no test file was created at the same time. This is also related to CRIT-5 (JSON proof download no-op) — the functions exist but are never wired to any UI component, so no integration test catches the gap either.

#### Fix Pattern

Create `src/lib/proofPackage.test.ts` with tests for:

1. `ProofPackageSchema` validation: valid package passes, missing fields rejected, invalid fingerprint format rejected
2. `generateProofPackage()`: returns valid schema for SECURED anchor, handles null optional fields, includes correct terminology (no banned terms)
3. `validateProofPackage()`: returns parsed data for valid input, throws for invalid
4. `downloadProofPackage()`: creates Blob with correct MIME type, triggers download (mock URL.createObjectURL)

#### Actions Taken

| Date | Action |
|------|--------|
| 2026-03-10 6:45 PM EST | Found during PR-HARDENING-1 test suite audit on main. Classified as non-worker, non-processAnchor code per decision tree. Logged, not fixed. |
| 2026-03-10 7:15 PM EST | Created `src/lib/proofPackage.test.ts` — 33 tests across 5 describe blocks. All metrics → 100%. |

#### Resolution

**Status:** FIXED (2026-03-10 7:15 PM EST) — Created `src/lib/proofPackage.test.ts` with 33 tests covering ProofPackageSchema validation, generateProofPackage() for all anchor states, validateProofPackage(), getProofPackageFilename(), and downloadProofPackage() with DOM mocks.

#### Regression Test

- `src/lib/proofPackage.test.ts` — 33 tests across 5 describe blocks. CI enforces 80% threshold.

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

### BUG-SQ-01: ReDoS-Vulnerable Email Regex

- **Severity:** MEDIUM (security — denial of service)
- **Found:** 2026-03-11, SonarQube Cloud scan
- **Story:** — (cross-cutting: input validation)
- **Components:** `src/components/organization/InviteMemberModal.tsx:66`, `src/lib/csvParser.ts:22`

#### Steps to Reproduce

1. Call `validateEmail()` or `isValidEmail()` with a crafted input like `a@${'b.'.repeat(50)}c`
2. The regex engine backtracks exponentially trying to match `[^\s@]+\.[^\s@]+` against the repeated dots
3. CPU spikes; in extreme cases the browser tab or Node process hangs

#### Expected Behavior

Email validation completes in constant time regardless of input length.

#### Actual Behavior

The regex `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` has two adjacent `[^\s@]+` groups separated by `\.` in the domain part. Since both groups match the same character set (anything except whitespace and @), the engine can split input between them in exponentially many ways, causing catastrophic backtracking on adversarial input.

#### Root Cause

The original regex used overlapping character classes (`[^\s@]+` appears twice) which creates ambiguity for the regex engine's backtracking NFA.

#### Actions Taken

| Date | Action |
|------|--------|
| 2026-03-11 | Found via SonarQube Cloud scan (security hotspot). |
| 2026-03-11 | Replaced both regexes with non-backtracking pattern: `/^[^\s@]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/`. Domain groups use `[a-zA-Z0-9-]` which cannot overlap. |

#### Resolution

**Status:** FIXED (2026-03-11)

#### Regression Test

- `src/lib/csvParser.test.ts` — 26 tests pass (email validation covered)
- `src/components/organization/InviteMemberModal.test.tsx` — 8 tests pass

---

### BUG-SQ-02: Express x-powered-by Header Information Disclosure

- **Severity:** LOW (security — information disclosure)
- **Found:** 2026-03-11, SonarQube Cloud scan
- **Story:** — (cross-cutting: worker security)
- **Component:** `services/worker/src/index.ts:20`

#### Steps to Reproduce

1. Start the worker: `cd services/worker && npm run dev`
2. `curl -I http://localhost:3001/health`
3. Observe response header: `X-Powered-By: Express`
4. Attackers can use this to identify the framework and target known Express vulnerabilities

#### Expected Behavior

No `X-Powered-By` header in responses.

#### Actual Behavior

Express sends `X-Powered-By: Express` by default on every response.

#### Root Cause

Express enables the `x-powered-by` header by default. It must be explicitly disabled.

#### Actions Taken

| Date | Action |
|------|--------|
| 2026-03-11 | Found via SonarQube Cloud scan (vulnerability). |
| 2026-03-11 | Added `app.disable('x-powered-by')` after Express app creation. |

#### Resolution

**Status:** FIXED (2026-03-11)

#### Regression Test

- `services/worker/src/index.test.ts` — 17 tests pass

---

---

## Change Log

| Date | Change |
|------|--------|
| 2026-03-11 | SonarQube scan: fixed BUG-SQ-01 (ReDoS email regex) and BUG-SQ-02 (Express x-powered-by disclosure). Added to resolved bugs. Active: 2, Resolved: 15. |
| 2026-03-10 | Initial bug log created with CRIT-1 through CRIT-7, migrated from CLAUDE.md Section 8 summary table. Full steps to reproduce, root cause analysis, and fix patterns documented for all 7 bugs. |
| 2026-03-10 | Added HARDENING-1 bugs (BUG-H1-01, BUG-H1-02, BUG-H1-03). Moved CRIT-7 to resolved. Updated summary counts: 6 active, 4 resolved. |
| 2026-03-10 4:15 PM EDT | HARDENING-2 complete. No new bugs found. Added layman's summary table for all 10 bugs. Chain client (mock.ts, client.ts) and anchor job claim flow confirmed clean — 59 worker tests, 100% coverage on anchor.ts, mock.ts, client.ts. |
| 2026-03-10 6:45 PM EST | PR-HARDENING-1 audit complete. 2 new bugs found (BUG-PRH1-01, BUG-PRH1-02) — both frontend coverage threshold failures, labeled PR-Hardening1-Bug. 0 open PRs, 0 unaddressed comments. 341/341 tests pass. Updated active count: 8 active, 4 resolved. |
| 2026-03-10 7:15 PM EST | Fixed BUG-PRH1-01 (10 new tests in validators.test.ts) and BUG-PRH1-02 (33 new tests in proofPackage.test.ts). Both at 100% coverage. Total: 385 tests (253 frontend + 132 worker). Updated counts: 6 active, 6 resolved. |
| 2026-03-10 8:00 PM EST | HARDENING-5 complete. 7 new worker test files (96 tests). No new bugs found. Final: 481 tests (253 frontend + 228 worker). All thresholds pass. Worker hardening sprint COMPLETE. |
| 2026-03-10 10:30 PM EST | CRIT-1, CRIT-4, CRIT-5, CRIT-6 all FIXED. SecureDocumentDialog real Supabase insert, onboarding routes wired, JSON proof download connected, CSVUploadWizard uses real csvParser + useBulkAnchors. Moved PRH1 bugs from active to resolved table. Active: 2, Resolved: 12. |
| 2026-03-11 ~12:30 AM EST | E2E testing + stress testing sprint complete (116 new tests). No new bugs found. Documentation audit: updated stale CRIT-1/4/5/6 references across 9 story docs + 3 confluence docs. |

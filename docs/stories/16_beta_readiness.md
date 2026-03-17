# Beta Readiness Stories
_Last updated: 2026-03-17 (Initial creation — beta workflow audit)_

## Group Overview

These stories address **gaps discovered during beta-readiness workflow testing** on 2026-03-17. Each gap represents a workflow that cannot be completed end-to-end by a real user. Stories are ordered by priority: the admin single-document workflow (WF1) is the core demo path and must work first.

**Priority:** CRITICAL — these must be resolved before any external beta tester touches the product.

**Discovery method:** Each of the 7 core user workflows was traced through the codebase to verify that every step has working implementation (not stubs, not gated, not missing). Gaps were logged where a user would hit a dead end.

### Workflow Map

| Workflow | Description | Gaps Found |
|----------|-------------|------------|
| WF1 | Admin: upload → AI extract → anchor → mempool track → status update → revoke → template → credits → auto-user | 5 gaps |
| WF2 | Admin: batch CSV/XLSX → per-row AI extract → individual anchors | 2 gaps |
| WF3 | Individual: OAuth/email login → 2FA → upload → AI extract → template select → LinkedIn badge → my records | 3 gaps |
| WF4 | Public: search by person/fingerprint → mempool link → template → immutable description | 3 gaps |
| WF5 | Admin: fraud detection → flagged docs with reasons | 0 gaps (fully implemented) |
| WF6 | Verification API: programmatic access → payment | 0 gaps (fully implemented) |
| WF7 | Payments: Stripe checkout → subscription → credits | 0 gaps (fully implemented) |

### Completion Summary

| Status | Count |
|--------|-------|
| COMPLETE | 0 |
| PARTIAL | 0 |
| NOT STARTED | 13 |

### Gated Features (activation only, no new code)

| ID | Feature | Fix |
|----|---------|-----|
| BETA-ACT-01 | AI extraction disabled | Set `ENABLE_AI_EXTRACTION=true` + configure `GEMINI_API_KEY` |
| BETA-ACT-02 | Bitcoin anchoring uses mocks | Set `ENABLE_PROD_NETWORK_ANCHORING=true` + fund testnet4 wallet |

---

## BETA-01: Mempool Live Transaction Tracking

**Status:** NOT STARTED
**Priority:** P0 — CRITICAL (blocks WF1, WF4)
**Depends on:** P7-TS-12 (UTXO Provider — COMPLETE), P7-TS-05 (Chain Client — COMPLETE)
**Workflows:** WF1 (admin), WF4 (public verification)

### Problem

After a document is anchored to Bitcoin testnet4, the user has no way to track the transaction in the mempool or know when it confirms. The `network_receipt_id` (txid) is stored in the database but there is no mechanism to:
1. Poll mempool.space for transaction status (unconfirmed → confirmed)
2. Update anchor status from PENDING → SECURED when the tx confirms
3. Push that status change to the frontend in real-time

Currently, anchor status updates rely on the worker's `processAnchor` job setting status to SECURED at broadcast time, but this doesn't account for actual blockchain confirmation.

### What It Delivers

- Worker cron job that polls mempool.space REST API for unconfirmed transactions
- Updates anchor status + `block_height` + `block_timestamp` when tx confirms
- Supabase realtime channel subscription in `useAnchor` hook for live UI updates
- Optional: link to `mempool.space/tx/{txid}` in anchor detail views

### Acceptance Criteria

- [ ] Worker job `check-confirmations.ts` runs on cron (every 2 minutes)
- [ ] Queries anchors with `status = 'PENDING'` and non-null `network_receipt_id`
- [ ] For each, calls `GET https://mempool.space/testnet4/api/tx/{txid}` to check confirmation status
- [ ] When `status.confirmed === true`: updates anchor to `SECURED`, sets `block_height`, `block_timestamp`, logs audit event
- [ ] Frontend `useAnchor` hook subscribes to Supabase realtime channel for anchor row changes
- [ ] UI updates automatically when anchor transitions PENDING → SECURED (no page refresh)
- [ ] Anchor detail view shows clickable link to `mempool.space/testnet4/tx/{txid}`
- [ ] Public verification page shows same mempool link
- [ ] Rate limiting: max 10 mempool API calls per cron run (batch, not flood)
- [ ] Graceful handling of mempool.space downtime (log warning, retry next cycle)
- [ ] Tests: worker job tests with mocked mempool responses (confirmed, unconfirmed, not found, API error)
- [ ] Tests: useAnchor realtime subscription tests

### Technical Notes

- mempool.space REST API: `GET /api/tx/{txid}` returns `{ status: { confirmed: boolean, block_height: number, block_time: number } }`
- For testnet4: base URL is `https://mempool.space/testnet4`
- Supabase realtime: `supabase.channel('anchor-{id}').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'anchors', filter: 'id=eq.{id}' }, callback)`
- Must respect Constitution 1.4: no secrets logged, no PII in mempool calls

---

## BETA-02: Revocation Bitcoin Transaction

**Status:** NOT STARTED
**Priority:** P0 — CRITICAL (blocks WF1)
**Depends on:** P5-TS-02 (RevokeDialog — COMPLETE), P7-TS-05 (Chain Client — COMPLETE)
**Workflows:** WF1 (admin)

### Problem

When an admin revokes a credential, the `revoke_anchor` RPC updates the database status to REVOKED and logs an audit event, but **does not create a new Bitcoin transaction**. The user expects revocation to be anchored on-chain as an immutable record, just like the original anchor.

### What It Delivers

- Worker endpoint or job triggered on revocation that creates a new OP_RETURN transaction encoding the revocation event
- Links the revocation tx back to the original anchor record
- Updates the anchor with `revocation_tx_id` and `revocation_block_height`

### Acceptance Criteria

- [ ] When `revoke_anchor` RPC is called, a webhook or database trigger enqueues a revocation anchoring job
- [ ] Worker job `process-revocation.ts` constructs an OP_RETURN tx with payload: `ARKV:REVOKE:{original_txid}:{fingerprint}`
- [ ] Transaction is broadcast to testnet4 via the existing chain client
- [ ] Anchor record updated with `revocation_tx_id`, `revocation_block_height` (new columns, migration required)
- [ ] Audit event logged: `anchor.revocation_anchored`
- [ ] Revocation tx visible in anchor detail view with its own mempool link
- [ ] Credit deduction for revocation anchoring (1 credit, same as original anchor)
- [ ] Tests: revocation job tests, migration tests, integration tests
- [ ] Migration: add `revocation_tx_id` and `revocation_block_height` columns to `anchors` table

### Technical Notes

- Reuses existing `BitcoinChainClient` for tx construction and broadcast
- OP_RETURN payload format matches existing `ARKV` prefix convention
- Must deduct credits via existing credit system
- Webhook delivery should fire for `anchor.revoked_on_chain` event

---

## BETA-03: Email Infrastructure

**Status:** NOT STARTED
**Priority:** P0 — CRITICAL (blocks WF1 auto-user creation)
**Depends on:** None
**Workflows:** WF1 (admin), WF3 (individual activation)

### Problem

There is zero email sending infrastructure in the codebase. Supabase handles auth emails (confirmation, password reset) via its built-in templates, but there are no transactional emails for:
- Inviting new users when an admin uploads a credential for someone who doesn't have an account
- Notifying credential recipients that a credential has been issued to them
- Credential status change notifications (revoked, expired)

### What It Delivers

- Email service integration (Resend recommended — simple API, good DX, free tier sufficient for beta)
- Email templates for: invitation, credential issued, credential revoked
- Worker endpoint to trigger email sends
- Audit logging for all sent emails

### Acceptance Criteria

- [ ] Resend SDK integrated in `services/worker/` (or equivalent email provider)
- [ ] `RESEND_API_KEY` env var added to worker config
- [ ] `FROM_EMAIL` env var (e.g., `notifications@arkova.ai`)
- [ ] Email template: "You've been invited to Arkova" — contains activation link, org name, inviter name
- [ ] Email template: "A credential has been issued to you" — contains credential type, issuer org, view link
- [ ] Email template: "Your credential has been revoked" — contains credential type, reason, issuer org
- [ ] Worker `sendEmail()` utility function with retry (1 retry on failure)
- [ ] Audit event logged for each email sent: `email.sent` with `{ recipient, template, status }`
- [ ] Email sending gated by `ENABLE_EMAIL_NOTIFICATIONS` feature flag (default: `false` for dev)
- [ ] Tests: email service tests with mocked Resend client
- [ ] No PII in logs (recipient email hashed in audit events per Constitution 1.4)

### Technical Notes

- Resend npm package: `resend`
- Resend supports React email templates (optional, can start with HTML strings)
- DNS: add Resend SPF/DKIM records to arkova.ai domain
- Supabase auth emails remain separate (handled by Supabase)

---

## BETA-04: Auto-Create User on Admin Upload

**Status:** NOT STARTED
**Priority:** P1 — HIGH (blocks WF1 end-to-end)
**Depends on:** BETA-03 (Email Infrastructure)
**Workflows:** WF1 (admin)

### Problem

When an admin uploads a credential for a recipient who doesn't have an Arkova account, the system cannot create the anchor because `bulk_create_anchors` and `SecureDocumentDialog` both require an authenticated user context. There is no mechanism to:
1. Detect that the recipient doesn't exist
2. Create a pending user profile
3. Associate the credential with that pending profile
4. Send an activation email to the recipient

### What It Delivers

- Admin can specify a recipient email during credential issuance
- If the recipient doesn't exist, a pending profile is created
- Credential is anchored and associated with the pending profile
- Activation email is sent to the recipient
- When recipient activates, they see their credentials in "My Credentials"

### Acceptance Criteria

- [ ] `SecureDocumentDialog` adds optional "Recipient Email" field (visible to ORG_ADMIN only)
- [ ] If recipient email provided and no matching profile exists: call `create_pending_recipient` RPC
- [ ] `create_pending_recipient` RPC: inserts into `profiles` with `status = 'PENDING_ACTIVATION'`, generates `activation_token`
- [ ] Migration: add `status` column to `profiles` (default: `'ACTIVE'`), add `activation_token` column (nullable, unique)
- [ ] Anchor created with `recipient_id` pointing to the pending profile
- [ ] Activation email sent via BETA-03 email infrastructure
- [ ] Activation link: `https://app.arkova.io/activate?token={activation_token}`
- [ ] Activation page: user sets password, profile status → `'ACTIVE'`, token cleared
- [ ] Activated user sees credentials in "My Credentials" (existing `get_my_credentials` RPC)
- [ ] BulkUploadWizard: add optional "Recipient Email" column mapping for CSV
- [ ] Tests: RPC tests, activation flow tests, E2E test for full admin→recipient flow
- [ ] RLS: pending profiles visible only to creating org's admins + the recipient after activation

### Technical Notes

- `activation_token`: `crypto.randomBytes(32).toString('hex')`, expires after 7 days
- Must not create Supabase auth user until activation (avoid orphan auth records)
- Pending profile has minimal data: email + org_id + activation_token + created_at

---

## BETA-05: XLSX Batch Upload Support

**Status:** NOT STARTED
**Priority:** P1 — HIGH (blocks WF2)
**Depends on:** P5-TS-06 (BulkUploadWizard — COMPLETE)
**Workflows:** WF2 (admin batch)

### Problem

The BulkUploadWizard only accepts CSV files. The user expects to upload `.xlsx` or `.xls` spreadsheet files, which are the most common format for institutional records (registrar exports, HR systems, etc.).

### What It Delivers

- XLSX/XLS file parsing in the upload wizard
- Same column detection and mapping as CSV
- Transparent to the rest of the pipeline (parsed rows feed into existing batch anchor flow)

### Acceptance Criteria

- [ ] Install `xlsx` (SheetJS) library: `npm install xlsx`
- [ ] `CsvUploader.tsx` accepts `.xlsx`, `.xls`, `.csv` file types
- [ ] XLSX files parsed via SheetJS: first sheet extracted, headers from row 1, data from row 2+
- [ ] Parsed rows converted to same format as CSV parser output
- [ ] Column auto-detection works identically for XLSX and CSV
- [ ] File size limit: 10MB (same as CSV)
- [ ] Row limit: 10,000 (same as CSV)
- [ ] Error handling: corrupt XLSX, password-protected files, empty sheets
- [ ] Component renamed or alias: `FileUploader` (accepts CSV + XLSX) — or keep `CsvUploader` with broader accept
- [ ] Tests: XLSX parsing tests with sample .xlsx fixtures
- [ ] UI copy updated: "Upload CSV" → "Upload Spreadsheet (CSV or Excel)"

### Technical Notes

- SheetJS (`xlsx`) is a pure JS library, no native dependencies
- `XLSX.read(buffer, { type: 'array' })` → `XLSX.utils.sheet_to_json(worksheet, { header: 1 })`
- Constitution 1.6: file is parsed client-side only, never uploaded to server

---

## BETA-06: Per-Row AI Extraction for Batch Uploads

**Status:** NOT STARTED
**Priority:** P1 — HIGH (blocks WF2)
**Depends on:** BETA-05 (XLSX Support), P8-S4 (AI Extraction — COMPLETE)
**Workflows:** WF2 (admin batch)

### Problem

The batch upload flow takes CSV/XLSX rows as-is: it expects `fingerprint` and `filename` columns already present. There is no AI extraction step per row. The user expects to upload a spreadsheet of raw credential data (names, dates, institutions, etc.) and have AI infer the metadata fields for each row, creating properly structured anchors.

### What It Delivers

- After spreadsheet parsing, each row is sent through the AI extraction pipeline
- AI infers `credential_type`, `issuer_name`, `recipient_identifier`, dates, etc. from row data
- User reviews AI suggestions per row (or bulk-accepts)
- Fingerprint is generated from the structured metadata (not from a file)

### Acceptance Criteria

- [ ] After column mapping, wizard shows "AI Extraction" step
- [ ] Each row's mapped data sent to `/api/v1/ai/extract` (batched, not one-at-a-time)
- [ ] Worker batch extraction endpoint: `POST /api/v1/ai/extract-batch` — accepts array of row data, returns array of extraction results
- [ ] Extraction results shown in review table: each row shows inferred fields + confidence scores
- [ ] User can accept/reject/edit per row (reuse `AIFieldSuggestions` pattern)
- [ ] "Accept All" button for bulk acceptance
- [ ] Fingerprint generated from accepted metadata (SHA-256 of canonical JSON)
- [ ] Credit check before batch extraction (1 credit per row)
- [ ] Progress indicator during batch extraction
- [ ] Error handling: partial failures (some rows extract, some don't)
- [ ] Tests: batch extraction endpoint tests, wizard step tests

### Technical Notes

- Batch extraction should chunk rows (max 10 per API call) to avoid timeout
- Reuses existing Gemini extraction prompt with row data as input
- Constitution 1.6 still applies: metadata flows to server, not raw documents
- Credit cost: 1 AI credit per row extracted

---

## BETA-07: Two-Factor Authentication (2FA/MFA)

**Status:** NOT STARTED
**Priority:** P1 — HIGH (blocks WF3)
**Depends on:** P2-TS-04 (AuthGuard — COMPLETE)
**Workflows:** WF3 (individual user)

### Problem

There is no 2FA/MFA implementation. Users cannot add an extra layer of security to their accounts. For a credential verification platform, this is a trust signal that beta testers and institutional customers will expect.

### What It Delivers

- TOTP-based 2FA enrollment (authenticator app: Google Authenticator, Authy, etc.)
- QR code for initial setup
- Backup codes for recovery
- MFA challenge on login when 2FA is enabled
- Settings page to enable/disable 2FA

### Acceptance Criteria

- [ ] Supabase MFA enrollment: call `supabase.auth.mfa.enroll({ factorType: 'totp' })` to get QR code URI
- [ ] Settings page section: "Two-Factor Authentication" with Enable/Disable toggle
- [ ] Enable flow: show QR code → user scans → user enters 6-digit code to verify → save factor
- [ ] On login, if MFA enabled: show 6-digit code input after password step
- [ ] `supabase.auth.mfa.challenge()` + `supabase.auth.mfa.verify()` for login challenge
- [ ] Backup codes: generate 10 recovery codes on enrollment, display once, hash and store
- [ ] Recovery code login: alternative to TOTP code
- [ ] Disable 2FA: requires current TOTP code or recovery code to disable
- [ ] Tests: enrollment flow tests, challenge/verify tests, recovery code tests
- [ ] UI follows Nordic Vault design: mono font for codes, glass-card for QR display

### Technical Notes

- Supabase Auth has built-in MFA support (TOTP factor type)
- `supabase.auth.mfa.enroll()` returns `{ id, type, totp: { qr_code, secret, uri } }`
- `supabase.auth.mfa.challenge({ factorId })` → `{ id }` (challenge ID)
- `supabase.auth.mfa.verify({ factorId, challengeId, code })` → session
- No migration needed — MFA state is in Supabase `auth.mfa_factors` table (managed by Supabase)

---

## BETA-08: Template Selection Before Anchoring (Individual Users)

**Status:** NOT STARTED
**Priority:** P2 — MEDIUM (blocks WF3 template selection)
**Depends on:** P5-TS-07 (Credential Templates — COMPLETE), UF-01 (CredentialRenderer — COMPLETE)
**Workflows:** WF3 (individual user)

### Problem

Individual users cannot select a display template before anchoring their document. Templates exist as an org-admin feature (`CredentialTemplatesManager`), but the `SecureDocumentDialog` for individual users doesn't offer template selection. The user expects to choose how their credential will be displayed (diploma layout, certificate layout, etc.) before it's anchored.

### What It Delivers

- Template selection step in SecureDocumentDialog for individual users
- System-provided default templates (not org-specific) for common credential types
- Preview of how the credential will render with selected template

### Acceptance Criteria

- [ ] Migration: seed `credential_templates` with system-level templates (org_id = NULL): Diploma, Certificate, License, Transcript, Professional, General
- [ ] `SecureDocumentDialog` adds "Choose Template" step between AI extraction and confirmation
- [ ] Template selector shows cards with template name + preview thumbnail
- [ ] Preview renders `CredentialRenderer` with extracted metadata + selected template
- [ ] Selected template's `credential_type` is set on the anchor
- [ ] "Skip" option defaults to inferred credential_type from AI extraction
- [ ] Individual users see system templates; org users see org templates + system templates
- [ ] Tests: template selector component tests, integration with SecureDocumentDialog

### Technical Notes

- System templates have `org_id = NULL` and `is_system = true` (new column)
- Migration adds `is_system BOOLEAN DEFAULT false` to `credential_templates`
- RLS: system templates readable by all authenticated users
- Existing `CredentialRenderer` handles rendering — no changes needed there

---

## BETA-09: LinkedIn Verification Badge

**Status:** NOT STARTED
**Priority:** P2 — MEDIUM (blocks WF3 LinkedIn integration)
**Depends on:** UF-08 (Share Flow — COMPLETE)
**Workflows:** WF3 (individual user)

### Problem

Users cannot share their verified credentials on LinkedIn. There is no LinkedIn OAuth integration, no share link generation, and no badge/widget that can be embedded in a LinkedIn profile. This is a key differentiator for individual users.

### What It Delivers

- "Share on LinkedIn" button on credential detail views
- Pre-formatted LinkedIn share post with verification link
- Embeddable verification badge URL for LinkedIn "Featured" section
- Optional: LinkedIn OAuth for profile enrichment (Phase 2)

### Acceptance Criteria

- [ ] "Share on LinkedIn" button on `RecordDetailView` and `AssetDetailView`
- [ ] Button opens LinkedIn share URL: `https://www.linkedin.com/sharing/share-offsite/?url={verifyUrl}`
- [ ] Share text pre-populated: "My {credential_type} has been independently verified on Arkova. Verify it here: {url}"
- [ ] "Get Badge" button generates an embeddable HTML snippet for LinkedIn "Featured" section
- [ ] Badge snippet: `<a href="{verifyUrl}"><img src="{badgeImageUrl}" alt="Verified by Arkova" /></a>`
- [ ] Badge image: SVG hosted at `/badges/verified-{status}.svg` (SECURED=green, REVOKED=red)
- [ ] Badge endpoint: `/api/v1/badge/{publicId}.svg` returns dynamic SVG with credential info
- [ ] Tests: share URL generation, badge SVG rendering, badge endpoint tests
- [ ] Copy in `src/lib/copy.ts` for all LinkedIn-related strings

### Technical Notes

- LinkedIn share URL is a simple redirect — no OAuth needed for sharing
- Badge SVG can be a simple shields.io-style badge or custom Arkova-branded
- LinkedIn "Featured" section supports external links with preview images
- Full LinkedIn OAuth (for auto-posting) deferred to post-beta

---

## BETA-10: Public Search by Person

**Status:** NOT STARTED
**Priority:** P2 — MEDIUM (blocks WF4)
**Depends on:** UF-02 (Public Search — COMPLETE)
**Workflows:** WF4 (public verification)

### Problem

The public SearchPage only supports fingerprint lookup (64-char hex). Users expect to search for a person by name or identifier and see all their public credentials. The existing `search_public_credentials` RPC supports text search, but the UI only exposes fingerprint search.

### What It Delivers

- Dual search mode on public page: "Search by Fingerprint" and "Search by Person"
- Person search queries public profiles + their associated public credentials
- Results show person's name, credential count, and list of verified credentials

### Acceptance Criteria

- [ ] SearchPage adds toggle/tabs: "Verify Fingerprint" | "Find Person"
- [ ] "Find Person" input: text field for name or recipient identifier
- [ ] Calls `search_public_credentials` RPC with text query (already exists)
- [ ] Results grouped by person: name, public profile link, credential cards
- [ ] Each credential card: type, issuer, status badge, "Verify" link
- [ ] Empty state: "No matching records found"
- [ ] Privacy: only `is_public_profile = true` profiles + SECURED/REVOKED anchors shown
- [ ] Tests: person search UI tests, RPC integration tests
- [ ] Mobile responsive: cards stack vertically

### Technical Notes

- `search_public_credentials(query_text)` RPC already exists (P8-S12)
- May need `search_public_profiles(query_text)` RPC for direct person search
- RLS ensures only public profiles are returned
- Debounce search input (300ms) to avoid excessive RPC calls

---

## BETA-11: Mempool Explorer Link in Verification Results

**Status:** NOT STARTED
**Priority:** P2 — MEDIUM (blocks WF4)
**Depends on:** BETA-01 (Mempool Tracking)
**Workflows:** WF4 (public verification)

### Problem

The verification API and public verification page return `network_receipt_id` (txid) but don't construct a clickable link to a block explorer. Users expect to click through to see the actual Bitcoin transaction.

### What It Delivers

- Clickable mempool.space link wherever txid is displayed
- API response includes `explorer_url` field

### Acceptance Criteria

- [ ] Helper function: `getExplorerUrl(txid: string, network: string)` → `https://mempool.space/{network}/tx/{txid}`
- [ ] Network mapping: `testnet4` → `/testnet4/`, `signet` → `/signet/`, `mainnet` → `` (empty)
- [ ] PublicVerification.tsx: txid displayed as clickable link (opens in new tab)
- [ ] AssetDetailView.tsx: same treatment for txid
- [ ] RecordDetailView.tsx: same treatment
- [ ] Verification API response: add `explorer_url` field (additive, non-breaking per Constitution 1.8)
- [ ] Revocation txid (from BETA-02) also gets explorer link
- [ ] Tests: helper function tests for all network types
- [ ] Copy: "View on Network" (not "View on Mempool" per terminology rules)

### Technical Notes

- This is mostly a UI/display change — small effort
- `explorer_url` is a nullable additive field in API response (allowed without versioning per Constitution 1.8)
- Must use approved terminology: "Network Receipt" not "Transaction"

---

## BETA-12: Immutable Description Field on Anchors

**Status:** NOT STARTED
**Priority:** P2 — MEDIUM (blocks WF4)
**Depends on:** P4-TS-05 (metadata JSONB — COMPLETE)
**Workflows:** WF4 (public verification)

### Problem

The user expects to see a brief, immutable description on each anchor that explains what the credential represents. Currently, `metadata` is a JSONB blob with structured fields, but there's no dedicated `description` field that is:
1. Set at anchor creation time
2. Immutable after anchoring (like metadata)
3. Displayed prominently on public verification

### What It Delivers

- `description` field on anchors table
- AI-generated description during extraction (editable before anchor)
- Immutable after SECURED status
- Displayed on public verification page

### Acceptance Criteria

- [ ] Migration: add `description TEXT` column to `anchors` table
- [ ] `description` included in `prevent_metadata_edit_after_secured()` trigger protection
- [ ] AI extraction prompt updated to generate a 1-2 sentence description
- [ ] `SecureDocumentDialog` shows editable description field (pre-filled by AI)
- [ ] Description visible on: PublicVerification, AssetDetailView, RecordDetailView, API response
- [ ] API: `description` added to `VerificationResult` (additive, nullable — per Constitution 1.8)
- [ ] Max length: 500 characters (Zod validation)
- [ ] BulkUploadWizard: optional "Description" column mapping
- [ ] Tests: immutability trigger tests, API response tests, UI display tests

### Technical Notes

- Reuse `prevent_metadata_edit_after_secured` trigger by extending it to cover `description`
- Or create a new trigger specifically for description immutability
- AI prompt addition: "Generate a brief, factual description (1-2 sentences) of what this credential represents."

---

## BETA-13: Realtime Anchor Status Subscriptions

**Status:** NOT STARTED
**Priority:** P3 — NICE TO HAVE (improves WF1 UX, not strictly blocking)
**Depends on:** BETA-01 (Mempool Tracking)
**Workflows:** WF1 (admin), WF3 (individual)

### Problem

Anchor status changes (PENDING → SECURED, SECURED → REVOKED) are only reflected in the UI via polling or manual refresh. Supabase supports realtime channel subscriptions, but `useAnchor` and dashboard hooks don't use them. Users expect instant visual feedback when their anchor confirms on the blockchain.

### What It Delivers

- Supabase realtime subscriptions in anchor-related hooks
- Instant UI updates when anchor status changes
- Dashboard stats update in real-time

### Acceptance Criteria

- [ ] `useAnchor` hook subscribes to Supabase realtime channel for the specific anchor row
- [ ] `useAnchors` (list) hook subscribes to realtime channel for user's anchors
- [ ] Dashboard stat queries (anchor counts by status) subscribe to realtime updates
- [ ] Subscription cleanup on component unmount (no memory leaks)
- [ ] Toast notification when anchor status changes: "Your credential has been secured on the network!"
- [ ] Visual transition: pulsing badge → solid badge on status change
- [ ] Tests: realtime subscription mock tests, cleanup tests
- [ ] Graceful degradation: if realtime fails, fall back to polling

### Technical Notes

- Supabase realtime requires the table to have `REPLICA IDENTITY FULL` or a primary key
- `anchors` table already has a primary key — realtime should work out of the box
- Channel naming: `anchor-changes-{user_id}` to scope per user
- Existing `DH-10` (useEntitlements realtime) is a pattern to follow

---

## Priority Matrix

### Sprint 1 — Core Demo Path (WF1 + WF2 basics)
_Must work for any demo or beta test_

| Priority | Story | Effort | Workflows |
|----------|-------|--------|-----------|
| P0 | BETA-01: Mempool Live Tracking | Medium (3-4h) | WF1, WF4 |
| P0 | BETA-02: Revocation Bitcoin Tx | Medium (2-3h) | WF1 |
| P0 | BETA-03: Email Infrastructure | Medium (3-4h) | WF1, WF3 |
| P1 | BETA-04: Auto-Create User on Upload | Medium (3-4h) | WF1 |
| P1 | BETA-05: XLSX Batch Upload | Small (1-2h) | WF2 |
| — | BETA-ACT-01: Enable AI Extraction | Config (15min) | WF1, WF2, WF3 |
| — | BETA-ACT-02: Enable Bitcoin Anchoring | Config (15min) | WF1, WF2 |

### Sprint 2 — Individual User + Public (WF3 + WF4)

| Priority | Story | Effort | Workflows |
|----------|-------|--------|-----------|
| P1 | BETA-06: Per-Row AI Extraction | Medium (3-4h) | WF2 |
| P1 | BETA-07: Two-Factor Auth (2FA) | Medium (3-4h) | WF3 |
| P2 | BETA-08: Template Selection Pre-Anchor | Small (2-3h) | WF3 |
| P2 | BETA-09: LinkedIn Verification Badge | Small (2-3h) | WF3 |
| P2 | BETA-10: Public Search by Person | Small (2-3h) | WF4 |

### Sprint 3 — Polish + Public Display (WF4 completion)

| Priority | Story | Effort | Workflows |
|----------|-------|--------|-----------|
| P2 | BETA-11: Mempool Explorer Link | Tiny (30min) | WF4 |
| P2 | BETA-12: Immutable Description | Small (2-3h) | WF4 |
| P3 | BETA-13: Realtime Subscriptions | Small (2-3h) | WF1, WF3 |

---

## Change Log

| Date | Change |
|------|--------|
| 2026-03-17 | Initial creation from beta-readiness workflow audit. 13 stories + 2 activation items. |

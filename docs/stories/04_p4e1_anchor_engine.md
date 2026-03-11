# P4-E1 Anchor Engine — Story Documentation
_Last updated: 2026-03-10 | 3/3 stories COMPLETE_

## Group Overview

P4-E1 Anchor Engine delivers the core document anchoring workflow: file upload with client-side fingerprinting, validated insert into Supabase, and a detail view with QR code, lifecycle timeline, and re-verification. This is the primary user-facing flow for creating and inspecting anchored records.

Key deliverables:
- `ConfirmAnchorModal` — validate → insert → audit log (the correct anchor creation pattern)
- `AssetDetailView` — certificate-style record display with QR code, lifecycle timeline, re-verify, and PDF export
- `RecordDetailPage` at `/records/:id` — fetches single anchor via `useAnchor()` real Supabase query

All P4-E1 work builds on P1 (schema + RLS + validators) and P2 (auth + routing). The file never leaves the browser — only the SHA-256 fingerprint is stored.

## Architecture Context

**Design Principle: Client-Side Only Fingerprinting.** The `generateFingerprint()` function uses the Web Crypto API (`crypto.subtle.digest('SHA-256', ...)`) to compute file hashes entirely in the browser. No file content is ever uploaded to any server. This is the foundational privacy guarantee of the system.

**Anchor Creation Flow:**
```
FileUpload (drag-drop → generateFingerprint)
    ↓
ConfirmAnchorModal (validateAnchorCreate → supabase.insert → logAuditEvent)
    ↓
RLS enforces: user_id = auth.uid(), status = PENDING
    ↓
onSuccess(anchorId) → navigate to /records/:id
    ↓
RecordDetailPage (useAnchor → AssetDetailView)
```

**Two Creation Paths:**
1. `IssueCredentialForm` (org admin) — works correctly, follows this pattern
2. `SecureDocumentDialog` (individual) — ~~CRIT-1~~ FIXED (commit a38b485), now uses real Supabase insert

---

## Stories

---

### P4-TS-01: ConfirmAnchorModal (Upload, Fingerprint, Validate, Insert)

**Status:** COMPLETE
**Dependencies:** P1-TS-04 (RLS insert policy), P1-TS-05 (validators), P1-TS-06 (wiring pattern)
**Blocked by:** None (~~CRIT-1~~ resolved 2026-03-10, commit a38b485)

#### What This Story Delivers

A confirmation dialog that takes a selected file and its pre-computed fingerprint, validates the data with `validateAnchorCreate()`, inserts into the `anchors` table via Supabase, and logs an audit event. This is the reference implementation for anchor creation — all new anchor creation paths should follow this pattern.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Component | `src/components/anchor/ConfirmAnchorModal.tsx` | 215 | Modal: display file info → validate → insert → audit log |
| Test | `src/components/anchor/ConfirmAnchorModal.test.tsx` | 115 | Render tests + null guards |
| Support | `src/components/anchor/FileUpload.tsx` | 197 | Drag-drop file selection + fingerprint generation |
| Support | `src/lib/fileHasher.ts` | 56 | `generateFingerprint()`, `verifyFingerprint()`, `formatFingerprint()` |
| Test | `src/lib/fileHasher.test.ts` | 96 | SHA-256 computation + verification + formatting |

#### Database Changes

None (uses existing `anchors` table and RLS from P1).

#### Component Flow

1. Receives `file: File` and `fingerprint: string` as props (pre-computed by `FileUpload`)
2. Displays file metadata: name, size, MIME type, formatted fingerprint
3. Shows "PENDING" status notice — anchor will be pending until worker processes it
4. On confirm: calls `validateAnchorCreate()` with fingerprint, filename, file_size, file_mime
5. On validation pass: `supabase.from('anchors').insert({ user_id, org_id, fingerprint, filename, ... })`
6. On insert success: `logAuditEvent('ANCHOR_CREATED', ...)` + calls `onSuccess(anchorId)`
7. On any error: displays error message, calls `onError(message)` if provided

#### Security Considerations

- **Validation before insert:** `validateAnchorCreate()` runs Zod schema check — invalid data never reaches DB
- **RLS enforcement:** Insert policy requires `user_id = auth.uid()` and `status = PENDING`
- **No file upload:** Only the fingerprint (64-char hex string) is sent to Supabase
- **Audit trail:** Every anchor creation logged with event_type `ANCHOR_CREATED`

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| `src/components/anchor/ConfirmAnchorModal.test.tsx` | Unit | File/fingerprint display, pending status notice, cancel handler, null guards |
| `src/lib/fileHasher.test.ts` | Unit | SHA-256 computation, fingerprint verification, format display |

**Untested areas:** Full integration flow (validate → insert → audit → DB row). Component test mocks Supabase.

#### Acceptance Criteria

- [x] Modal displays file name, size, MIME type, and formatted fingerprint
- [x] `validateAnchorCreate()` called before Supabase insert
- [x] Insert includes `user_id`, `org_id`, `fingerprint`, `filename`, `file_size`, `file_mime`
- [x] Audit event logged on success with `ANCHOR_CREATED` type
- [x] Loading state shown during insert
- [x] Error handling for validation failures and DB errors
- [x] `onSuccess(anchorId)` callback with new anchor ID

#### Known Issues

| Bug | Impact |
|-----|--------|
| ~~[CRIT-1](../bugs/bug_log.md#crit-1-securedocumentdialog-fakes-anchor-creation)~~ | RESOLVED 2026-03-10 (commit a38b485). SecureDocumentDialog rewritten with real Supabase insert. |

#### How to Verify (Manual)

1. Start local Supabase: `supabase start && supabase db reset`
2. Login as `admin_demo@arkova.local` / `demo_password_123`
3. Navigate to Organization page → click "Issue Credential"
4. Select a PDF file — observe fingerprint generation
5. Click "Issue" — observe loading state, then success
6. Query DB: `SELECT * FROM anchors ORDER BY created_at DESC LIMIT 1;`
7. Verify: row exists with status=PENDING, fingerprint is 64-char lowercase hex
8. Query: `SELECT * FROM audit_events WHERE event_type = 'ANCHOR_CREATED' ORDER BY created_at DESC LIMIT 1;`

---

### P4-TS-02: AssetDetailView (Record Display, QR Code, Lifecycle Timeline)

**Status:** COMPLETE
**Dependencies:** P4-TS-01 (anchor creation), P3-TS-01 (dashboard navigation to records)
**Blocked by:** None

#### What This Story Delivers

A certificate-style detail view for a single anchor record. Displays all record metadata, a lifecycle timeline showing status progression, a QR code for SECURED anchors linking to the public verification page, a re-verify section for fingerprint comparison, and PDF proof export.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Component | `src/components/anchor/AssetDetailView.tsx` | 403 | Full record detail: metadata, status, QR, timeline, re-verify, export |
| Component | `src/components/anchor/AnchorLifecycleTimeline.tsx` | 204 | Vertical timeline with status progression |
| Test | `src/components/anchor/AssetDetailView.test.tsx` | 118 | Status badges, QR code visibility, download button, back navigation |
| Support | `src/lib/generateAuditReport.ts` | 201 | PDF certificate generation (jsPDF) |

#### Database Changes

None (reads anchor data passed via props).

#### Component Sections

1. **Header:** Status badge (PENDING/SECURED/REVOKED/EXPIRED with color-coded icons)
2. **Document Info:** Filename, file size, MIME type, credential type (if set)
3. **Fingerprint Display:** Monospace formatted hash with copy-to-clipboard
4. **Dates:** Created date, secured date (if applicable), with localized formatting
5. **Lifecycle Timeline:** `AnchorLifecycleTimeline` — chronological dots (Created → Issued → Secured → Revoked/Expired)
6. **QR Code:** Only for SECURED anchors with `publicId` — links to `/verify/{publicId}`
7. **Re-Verify Section:** `FileUpload` component for drag-drop comparison against stored fingerprint
8. **Download Section:** PDF proof export via `generateAuditReport()` (lazy-imported)

#### Lifecycle Timeline Details

`AnchorLifecycleTimeline` renders a vertical timeline with events built from anchor data:
- **Created** (always present) — FileCheck icon, green when completed
- **Issued** (optional) — Clock icon, shown when `issuedAt` exists
- **Secured** (conditional) — Shield icon, green when status = SECURED
- **Revoked/Expired** (terminal) — XCircle/AlertTriangle, shown for terminal states
- **Expires On** (upcoming) — shown when `expiresAt` is in the future

Status styles: completed (green), current (primary), upcoming (gray), terminal (gray)

#### Security Considerations

- No internal IDs exposed in QR code — only `publicId`
- QR code only generated for SECURED anchors (PENDING anchors have no public verification)
- Re-verify comparison runs entirely client-side (file never uploaded)
- PDF export includes only metadata and chain receipt data — no file content

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| `src/components/anchor/AssetDetailView.test.tsx` | Unit | Filename/fingerprint display, PENDING/SECURED/REVOKED badges, QR code visibility (only with publicId), download button (SECURED only), back button |

**Untested areas:** Lifecycle timeline rendering, re-verify flow, PDF generation output.

#### Acceptance Criteria

- [x] Displays all record metadata: filename, fingerprint, status, dates, credential type
- [x] Status badge with correct color and icon per status
- [x] Lifecycle timeline shows chronological status progression
- [x] QR code generated for SECURED anchors with `publicId`
- [x] QR links to `{origin}/verify/{publicId}`
- [x] Re-verify section accepts file upload and compares fingerprints
- [x] PDF export available for SECURED anchors
- [x] Back button navigates to previous page

#### Known Issues

None.

#### How to Verify (Manual)

1. Start local Supabase: `supabase start && supabase db reset`
2. Login as any seed user with anchors
3. Navigate to Dashboard → click a record → verify `/records/:id` loads
4. Verify: filename, fingerprint, status badge, dates all displayed
5. For SECURED records: verify QR code is visible, PDF download button works
6. For PENDING records: verify QR code is absent, download button is absent
7. Re-verify: drag the same file — expect "Match" result; drag different file — expect "Mismatch"

---

### P4-TS-03: RecordDetailPage (/records/:id)

**Status:** COMPLETE
**Dependencies:** P4-TS-02 (AssetDetailView), P2-TS-03 (routing)
**Blocked by:** None

#### What This Story Delivers

A page component at `/records/:id` that extracts the URL parameter, fetches the anchor from Supabase via `useAnchor(id)`, and renders `AssetDetailView`. Handles loading, error/not-found, and success states. Provides PDF download callback with lazy-imported `generateAuditReport()`.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Page | `src/pages/RecordDetailPage.tsx` | 128 | Route handler: param extraction → fetch → render |
| Hook | `src/hooks/useAnchor.ts` | 73 | Single anchor fetch from Supabase |
| Component | `src/components/anchor/AssetDetailView.tsx` | 403 | Detail rendering (from P4-TS-02) |

#### Database Changes

None (queries existing `anchors` table).

#### Hook Details

`useAnchor(id)` returns `{ anchor, loading, error, refreshAnchor }`:
- Query: `supabase.from('anchors').select('*').eq('id', id).is('deleted_at', null).single()`
- RLS enforced — user can only fetch their own anchors (or org anchors if ORG_ADMIN)
- Handles PGRST116 (not found) with user-friendly message
- Returns null anchor on error (page shows "Record Not Found")

#### Data Mapping

The page maps Supabase row fields to the `AnchorRecord` interface:
- `public_id` → `publicId`
- `chain_timestamp` → `securedAt`
- `issued_at`, `revoked_at`, `revocation_reason`, `expires_at` → lifecycle fields
- `credential_type` → credential type label
- `chain_tx_id`, `chain_block_height` → chain receipt data for PDF

#### Security Considerations

- **RLS scoped:** `useAnchor()` relies on Supabase RLS — no client-side auth check needed
- **Generic error:** "Record Not Found or permission denied" — does not reveal whether record exists for other users
- **Auth guard:** Page wrapped in `AppShell` which requires authentication

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| — | — | No dedicated unit test for RecordDetailPage |

**Untested areas:** Page rendering, loading/error states, data mapping. Expected to be covered by E2E tests.

#### Acceptance Criteria

- [x] Route `/records/:id` extracts ID from URL params
- [x] `useAnchor(id)` fetches single anchor from Supabase
- [x] Loading state shows spinner
- [x] Not-found state shows alert card with back button
- [x] Success state renders `AssetDetailView` with mapped anchor data
- [x] PDF download callback lazy-imports `generateAuditReport()`
- [x] Back button navigates to dashboard

#### Known Issues

None.

#### How to Verify (Manual)

1. Start local Supabase: `supabase start && supabase db reset`
2. Login as any seed user with anchors
3. Navigate to Dashboard → click any record row
4. Verify URL is `/records/<uuid>`
5. Verify `AssetDetailView` renders with correct data
6. Navigate to `/records/00000000-0000-0000-0000-000000000000` (invalid ID)
7. Verify "Record Not Found" alert is shown

---

## Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| Client-side SHA-256 via Web Crypto API | Privacy guarantee — file never leaves device |
| Separate `useAnchor` (single) and `useAnchors` (list) hooks | Single-record fetch is a distinct query pattern (`.single()`) |
| QR code only for SECURED anchors | PENDING anchors have no verified chain data — QR would be misleading |
| Lazy-import `generateAuditReport` | jsPDF is ~200KB — don't bundle until user clicks download |
| Re-verify runs in browser only | Consistent with client-side processing boundary |
| Generic "Not Found" error | Prevents enumeration attacks — no "exists but forbidden" distinction |

## File Dependency Graph

```
FileUpload.tsx
  └─ fileHasher.ts (generateFingerprint)
      └─ Web Crypto API (crypto.subtle.digest)

ConfirmAnchorModal.tsx
  ├─ validators.ts (validateAnchorCreate)
  ├─ auditLog.ts (logAuditEvent)
  └─ supabase.ts (insert into anchors)

RecordDetailPage.tsx
  ├─ useAnchor.ts (single anchor query)
  └─ AssetDetailView.tsx
      ├─ AnchorLifecycleTimeline.tsx
      ├─ FileUpload.tsx (re-verify)
      ├─ generateAuditReport.ts (PDF export)
      └─ qrcode.react (QR code)
```

## Related Documentation

- [02_data_model.md](../confluence/02_data_model.md) — Anchors table schema
- [03_security_rls.md](../confluence/03_security_rls.md) — Anchor RLS policies
- [01_p1_bedrock.md](./01_p1_bedrock.md) — Validators and RLS foundation
- [bug_log.md](../bugs/bug_log.md) — CRIT-1 (SecureDocumentDialog)

## Change Log

| Date | Change |
|------|--------|
| 2026-03-10 | Initial P4-E1 story documentation created (Session 2 of 3). |
| 2026-03-11 ~12:30 AM EST | Documentation audit: Updated CRIT-1 references as resolved (commit a38b485). |

# P6 Verification — Story Documentation
_Last updated: 2026-03-15 ~6:00 PM EST | 6/6 stories COMPLETE_

## Group Overview

P6 Verification delivers the public-facing verification system: a 5-section public verification page (accessible without authentication), QR code generation for SECURED anchors, an embeddable verification widget (built but not wired), credential lifecycle tracking with visual timelines, PDF audit certificate generation, and verification event analytics.

Key deliverables:
- `PublicVerification` — 5-section public page fetching via `get_public_anchor` RPC (SECURITY DEFINER)
- `QRCodeSVG` in AssetDetailView — links to `/verify/{publicId}` for SECURED anchors
- `VerificationWidget` — self-contained embed-ready component (COMPLETE: routed at `/embed/verify/:publicId` via `EmbedVerifyPage`)
- `AnchorLifecycleTimeline` + `useCredentialLifecycle` — visual timeline for credential lifecycle (integrated on both detail and public pages)
- `generateAuditReport` — jsPDF certificate with 7-section layout, downloads as PDF
- `verification_events` table + `log_verification_event` RPC — fire-and-forget analytics

All P6 public-facing pages are accessible without authentication. Private-facing lifecycle/detail views require login.

## Architecture Context

**Design Principle: Privacy by Default.** The public verification page only exposes `public_id`-derived fields. Internal IDs (`user_id`, `org_id`, `anchors.id`) are never exposed. Recipient identifiers are SHA-256 hashed before display (migration 0044). Jurisdiction is omitted from the response when null (not returned as `null`).

**Verification Event Logging:** Every public verification page load triggers a fire-and-forget `log_verification_event()` RPC call. The RPC is SECURITY DEFINER so unauthenticated users can write to `verification_events`. No raw IP addresses are stored — only hashed. This enables analytics without compromising privacy.

**Phase 1.5 Frozen Schema:** Migration 0044 (`get_public_anchor`) returns a response matching the frozen P4.5 API contract. Any field changes require a new API version. The `record_uri` uses HTTPS per ADR-001.

---

## Stories

---

### P6-TS-01: get_public_anchor RPC + PublicVerification Page

**Status:** COMPLETE
**Dependencies:** P1-TS-02 (anchors table), P5-TS-05 (public_id on INSERT)
**Blocked by:** None

#### What This Story Delivers

A public-facing verification page at `/verify/:publicId` that fetches anchor data via the `get_public_anchor` SECURITY DEFINER RPC and displays it in 5 sections: Status Banner, Document Info, Issuer Info, Cryptographic Proof, and Lifecycle. Accessible without authentication.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Component | `src/components/verification/PublicVerification.tsx` | 402 | 5-section public verification display |
| Migration | `supabase/migrations/0044_restore_get_public_anchor_phase15.sql` | 125 | Frozen-schema RPC returning JSONB |
| Utility | `src/lib/logVerificationEvent.ts` | 47 | Fire-and-forget event logging on page load |

#### Database Changes

| Object | Type | Migration | Description |
|--------|------|-----------|-------------|
| `get_public_anchor(p_public_id)` | Function | 0044 | SECURITY DEFINER. Returns JSONB matching Phase 1.5 frozen schema. Filters to SECURED/REVOKED/EXPIRED only. SHA-256 hashes recipient identifier. Omits jurisdiction when null. |

#### RPC Response Schema (Phase 1.5 Frozen)

```
verified, status (ACTIVE/REVOKED/EXPIRED), issuer_name, recipient_identifier (hashed),
credential_type, issued_date, expiry_date, anchor_timestamp, bitcoin_block,
network_receipt_id, merkle_proof_hash, record_uri, public_id, fingerprint,
filename, file_size, jurisdiction (omitted when null)
```

#### Component Sections

| Section | Contents |
|---------|----------|
| Status Banner | SECURED → green check "Verified", REVOKED → gray ban, ERROR → red X |
| Document Info | Filename, file size (formatted), credential type |
| Issuer Info | Organization name, issued date |
| Cryptographic Proof | SHA-256 fingerprint (monospace, copy button), network receipt (copy button) |
| Lifecycle | Created, secured, expires, revoked timestamps |

#### Security Considerations

- **No authentication required** — public page by design
- **No internal IDs exposed** — only `public_id` and derived fields
- **Recipient hashing** — SHA-256 in the RPC, never raw PII
- **Race condition guard** — two SELECT queries with null-check between
- **Grants:** `anon` and `authenticated` can execute `get_public_anchor`

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| `e2e/public-verification.spec.ts` | E2E | Verified status display, invalid public_id error, no sensitive data, no auth required, file size display |

**Untested areas:** Component rendering (unit), copy-to-clipboard, error states.

#### Acceptance Criteria

- [x] `get_public_anchor` RPC with SECURITY DEFINER and SET search_path
- [x] Response matches Phase 1.5 frozen schema
- [x] Recipient identifier SHA-256 hashed (never raw PII)
- [x] Jurisdiction omitted when null (not returned as null)
- [x] 5-section display (status, document, issuer, proof, lifecycle)
- [x] Copy-to-clipboard for fingerprint and network receipt
- [x] Status-specific styling (green/gray/red)
- [x] Fire-and-forget verification event logged on load
- [x] Routed at `/verify/:publicId`
- [x] No authentication required

#### Known Issues

None.

#### How to Verify (Manual)

1. Start local Supabase: `supabase start && supabase db reset`
2. Get a SECURED anchor's public_id from seed data
3. Navigate to `/verify/{publicId}` without logging in
4. Verify all 5 sections display correctly
5. Click copy button on fingerprint — verify clipboard content
6. Check `verification_events` table for a new row

---

### P6-TS-02: QR Code in AssetDetailView

**Status:** COMPLETE
**Dependencies:** P4-TS-02 (AssetDetailView), P5-TS-05 (public_id on INSERT)
**Blocked by:** None

#### What This Story Delivers

A QR code displayed in the authenticated AssetDetailView for SECURED anchors that have a `publicId`. The QR code encodes the full verification URL (`/verify/{publicId}`), enabling mobile scanning for quick credential verification.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Component | `src/components/anchor/AssetDetailView.tsx` | 403 | Certificate-style detail view with QR code section |

#### Component Details

The QR code section renders conditionally:
- Only for anchors with `status === 'SECURED'` AND `publicId` present
- Uses `QRCodeSVG` from `qrcode.react` library
- QR value: `${window.location.origin}/verify/${anchor.publicId}`
- Displayed below the cryptographic proof section

AssetDetailView also includes:
- Certificate-style card header with status badge
- Document metadata (filename, size, MIME, credential type)
- SHA-256 fingerprint with copy button
- Re-verification workflow (upload file, compute fingerprint, compare)
- AnchorLifecycleTimeline integration
- Download proof package button

#### Security Considerations

- QR code only shown for SECURED anchors (not PENDING or REVOKED)
- URL uses `window.location.origin` — adapts to deployment environment
- No internal IDs encoded in QR — only public verification URL

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| — | — | No dedicated test for QR code rendering |

**Untested areas:** QR code generation, conditional display logic, URL correctness.

#### Acceptance Criteria

- [x] QR code displayed for SECURED anchors with publicId
- [x] QR encodes full verification URL
- [x] Hidden for PENDING, REVOKED, and anchors without publicId
- [x] Uses `QRCodeSVG` (SVG-based, no canvas)

#### Known Issues

None.

#### How to Verify (Manual)

1. Login as org admin with SECURED records
2. Navigate to a SECURED record's detail page
3. Verify QR code is visible below proof section
4. Scan QR code with mobile device — verify it opens verification page
5. Navigate to a PENDING record — verify no QR code shown

---

### P6-TS-03: Embeddable VerificationWidget

**Status:** COMPLETE
**Dependencies:** P6-TS-01 (get_public_anchor RPC)
**Blocked by:** None
**Completed:** 2026-03-15 (PR #57)

#### What This Story Delivers

A self-contained, embed-ready verification widget designed for third-party website embedding. Supports compact (1-line summary) and full (4-section) render modes. Routed at `/embed/verify/:publicId` via `EmbedVerifyPage`. Logs verification events with `method='embed'`.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Component | `src/components/embed/VerificationWidget.tsx` | 206 | Embeddable widget with compact/full modes |
| Page | `src/pages/EmbedVerifyPage.tsx` | ~20 | Thin wrapper for iframe embedding |
| Barrel | `src/components/embed/index.ts` | 1 | Re-export |
| Route | `src/lib/routes.ts` | — | `EMBED_VERIFY: '/embed/verify/:publicId'` |
| Test | `src/components/embed/VerificationWidget.test.tsx` | ~120 | 10 tests |
| Test | `src/pages/EmbedVerifyPage.test.tsx` | ~30 | 2 tests |

#### Component Details

| Mode | Display |
|------|---------|
| Compact | 1-line: status icon + filename + Arkova logo |
| Full | Status banner, document details, issuer info, footer with link to full page |

Props: `publicId` (required), `compact` (optional boolean).

The widget:
- Fetches via `get_public_anchor` RPC (same as PublicVerification)
- Uses inline brand color `#82b8d0` (Steel Blue) and system fonts
- Logs verification events with `method: 'embed'` (verified, revoked, not_found)
- Footer links to `/verify/{publicId}` for full details

#### Security Considerations

- Widget uses same RPC as public page — no additional attack surface
- Cross-origin iframe embedding needs CORS/CSP review for production
- No authentication required (public data only)

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| `src/components/embed/VerificationWidget.test.tsx` | Unit | Loading state, full mode (4 sections), compact mode, error states, revoked status, verification event logging (method='embed'), empty publicId guard. 10 tests. |
| `src/pages/EmbedVerifyPage.test.tsx` | Unit | Renders widget with publicId, shows missing ID message. 2 tests. |

#### Acceptance Criteria

- [x] Component with compact and full render modes
- [x] Fetches via `get_public_anchor` RPC
- [x] Brand-consistent styling
- [ ] Routed or bundled as standalone embed
- [ ] Barrel export in `src/components/embed/index.ts`
- [ ] Verification event logged with `method: 'embed'`

#### Known Issues

| Issue | Impact |
|-------|--------|
| Never imported or routed | Widget is dead code — not reachable by users |

---

### P6-TS-04: Credential Lifecycle on Public Page

**Status:** COMPLETE
**Dependencies:** P4-TS-02 (AssetDetailView)
**Blocked by:** None

#### What This Story Delivers

A credential lifecycle hook and visual timeline component. The hook computes lifecycle state (events, progress, expiry warnings) and the component renders a vertical timeline with status-aware styling. Integrated on both the authenticated AssetDetailView and the public PublicVerification page.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Hook | `src/hooks/useCredentialLifecycle.ts` | 171 | Compute lifecycle events, progress, expiry warnings |
| Component | `src/components/anchor/AnchorLifecycleTimeline.tsx` | 203 | Vertical timeline with status-aware dots and lines |
| Integration | `src/components/verification/PublicVerification.tsx` | ~400 | Section 5 uses AnchorLifecycleTimeline via mapToLifecycleData() |

#### Hook Details (`useCredentialLifecycle`)

Returns:
- `events` — array of `LifecycleEvent` objects (type, timestamp, label, completed, current, terminal)
- `currentStatus` — current lifecycle status
- `isActive`, `isTerminal` — boolean state flags
- `isExpiringSoon` — true if < 30 days to expiry
- `daysUntilExpiry` — number or null
- `progressPercent` — PENDING=25%, SECURED=75%, terminal=100%

Event sequence: CREATED (always) → ISSUED (optional) → SECURED → REVOKED or EXPIRED (terminal).

#### Component Details (`AnchorLifecycleTimeline`)

- Vertical timeline with status-aware dot styles:
  - Completed: green dot
  - Current: primary dot with ring animation
  - Upcoming: muted dot
  - Terminal: gray dot
- Each event shows icon (Lucide), timestamp, and optional detail (revocation reason)
- Connecting lines between events (except last)
- Labels from `LIFECYCLE_LABELS` in `copy.ts`

#### Public Page Integration

`PublicVerification.tsx` Section 5 replaced flat `InfoRow` entries with `AnchorLifecycleTimeline`. A `mapToLifecycleData()` helper maps `PublicAnchorData` fields (snake_case from RPC) to `AnchorLifecycleData` props (camelCase). Timeline only renders when `created_at` is present. No authentication required — timeline uses only public data fields.

#### Security Considerations

- Timeline only shows timestamps and status labels — no sensitive data
- Revocation reason displayed when present (already visible on public page)
- No internal IDs exposed through timeline

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| — | — | No dedicated tests for hook or component |

**Untested areas:** Event computation, expiry warnings, progress calculation, timeline rendering.

#### Acceptance Criteria

- [x] `useCredentialLifecycle` hook with events, progress, expiry
- [x] `AnchorLifecycleTimeline` with status-aware visual timeline
- [x] Integrated in AssetDetailView (authenticated detail page)
- [x] Integrated in PublicVerification (public verification page)

#### Known Issues

None.

---

### P6-TS-05: PDF Audit Report (jsPDF)

**Status:** COMPLETE
**Dependencies:** P4-TS-02 (anchor data model)
**Blocked by:** None

#### What This Story Delivers

A client-side PDF certificate generator using jsPDF. Produces a downloadable "Arkova Verification Certificate" with 7 sections. Called from RecordDetailPage for SECURED anchors.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Utility | `src/lib/generateAuditReport.ts` | 201 | jsPDF certificate with 7-section layout |

#### PDF Sections

| # | Section | Contents |
|---|---------|----------|
| 1 | Header | "Arkova Verification Certificate", generation date, verification ID |
| 2 | Status | "VERIFIED" (if SECURED) or status enum value |
| 3 | Document Information | Filename, file size (formatted), credential type |
| 4 | Issuer | Organization name, issued date (optional section) |
| 5 | Cryptographic Proof | SHA-256 fingerprint (monospace courier), network receipt, block height, observed time |
| 6 | Lifecycle | Created, secured, expires, revoked, revocation reason |
| 7 | Footer | Disclaimer: what is asserted (fingerprint observation) and what is NOT asserted (accuracy, identity, validity) |

#### Implementation Details

- **Font:** Helvetica for labels, Courier for fingerprint/receipt values
- **Download filename:** `arkova-certificate-{sanitized-filename}.pdf` (alphanumeric + dots/hyphens only)
- **Client-side only** — no server-side processing (Constitution 1.6 compliant)
- **Helpers:** `formatDate()` (UTC), `formatFileSize()` (B/KB/MB), `addSection()`, `addField()`

#### Security Considerations

- Runs entirely in browser — no document upload to server
- Sanitizes filename to prevent path traversal in download name
- Footer disclaimer explicitly states limitations of the certificate

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| — | — | No dedicated test for PDF generation |

**Untested areas:** PDF content correctness, section layout, font rendering, download trigger.

#### Acceptance Criteria

- [x] jsPDF-based certificate generation
- [x] 7-section layout (header, status, document, issuer, proof, lifecycle, footer)
- [x] Fingerprint in monospace font
- [x] Footer disclaimer stating assertions and non-assertions
- [x] Client-side only (no server processing)
- [x] Sanitized download filename
- [x] Called from RecordDetailPage

#### Known Issues

None.

#### How to Verify (Manual)

1. Login and navigate to a SECURED record detail page
2. Click "Download Certificate" button
3. Verify PDF downloads with correct filename
4. Open PDF — verify all 7 sections present
5. Verify fingerprint displays in monospace font
6. Verify footer disclaimer text

---

### P6-TS-06: verification_events Table + RPC

**Status:** COMPLETE
**Dependencies:** P1-TS-02 (anchors table), P6-TS-01 (get_public_anchor)
**Blocked by:** None

#### What This Story Delivers

A `verification_events` analytics table for tracking public verification lookups, plus a SECURITY DEFINER RPC that allows unauthenticated clients to log events. Wired into PublicVerification.tsx as fire-and-forget on every page load.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Migration | `supabase/migrations/0042_verification_events.sql` | 118 | Table + constraints + indexes + RLS |
| Migration | `supabase/migrations/0045_log_verification_event_rpc.sql` | 86 | SECURITY DEFINER logging RPC |
| Utility | `src/lib/logVerificationEvent.ts` | 47 | Client-side fire-and-forget helper |

#### Database Changes

| Object | Type | Migration | Description |
|--------|------|-----------|-------------|
| `verification_events` | Table | 0042 | Columns: id, anchor_id (FK), public_id, method (web/api/embed/qr), result (verified/revoked/not_found/error), fingerprint_provided, ip_hash, user_agent, referrer, country_code, org_id (FK), created_at |
| Indexes | — | 0042 | On public_id, org_id, created_at, method |
| RLS | Policies | 0042 | ORG_ADMIN can SELECT for their org. Service-role INSERT only. |
| `log_verification_event()` | Function | 0045 | SECURITY DEFINER. Looks up anchor_id + org_id from public_id. Inserts event. Errors silently ignored. |

#### Client Helper (`logVerificationEvent`)

```
Types: VerificationMethod = 'web' | 'api' | 'embed' | 'qr'
       VerificationResult = 'verified' | 'revoked' | 'not_found' | 'error'

Params: { publicId, method, result, fingerprintProvided? }

Behavior: Calls RPC, catches all errors (fire-and-forget), collects userAgent + referrer
```

#### Privacy Design

| Data | Treatment |
|------|-----------|
| IP address | SHA-256 hashed in RPC, never raw |
| User agent | Stored as-is (non-identifying) |
| Referrer | Stored as-is |
| User email/ID | NOT collected |
| Country code | Optional metadata field |

#### Security Considerations

- **SECURITY DEFINER with SET search_path = public** — required for unauthenticated access
- **Grants:** `anon` and `authenticated` can execute
- **Fire-and-forget:** Never blocks the verification UI, even on error
- **No PII:** Only public_id, metadata, and hashed IP
- **Append-only pattern:** No UPDATE/DELETE policies for client code

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| — | — | No dedicated unit tests |

**Untested areas:** RPC execution, event insertion, error silence, metadata collection.

#### Acceptance Criteria

- [x] `verification_events` table with all columns and constraints
- [x] FORCE ROW LEVEL SECURITY enabled
- [x] Indexes on public_id, org_id, created_at, method
- [x] ORG_ADMIN can SELECT events for their org
- [x] SECURITY DEFINER RPC with SET search_path = public
- [x] Grants for anon and authenticated
- [x] Client helper with fire-and-forget pattern
- [x] Wired into PublicVerification.tsx on every load
- [x] No raw IP addresses stored

#### Known Issues

None.

#### How to Verify (Manual)

1. Navigate to `/verify/{publicId}` without logging in
2. Query: `SELECT * FROM verification_events ORDER BY created_at DESC LIMIT 1;`
3. Verify new row with method='web', correct public_id, and populated user_agent
4. Verify ip_hash is a SHA-256 hash (not raw IP)

---

## Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| SECURITY DEFINER for public RPCs | Unauthenticated users need read access to anchor data and write access to verification events |
| SHA-256 hashing of recipient identifier | Privacy by default — PII never exposed on public page |
| Fire-and-forget event logging | Verification page load must never be blocked by analytics |
| Separate widget component (not inline) | Embed use case requires minimal dependencies and self-contained styling |
| jsPDF for certificates (not server-side) | Client-side processing boundary (Constitution 1.6) |
| Phase 1.5 frozen schema in RPC | API versioning starts at the database level — RPC returns the exact contract |

## Migration Inventory

| Migration | Story | Description |
|-----------|-------|-------------|
| 0042 | P6-TS-06 | `verification_events` table + RLS + indexes |
| 0044 | P6-TS-01 | `get_public_anchor` RPC rebuild (Phase 1.5 frozen schema) |
| 0045 | P6-TS-06 | `log_verification_event` SECURITY DEFINER RPC |

## Related Documentation

- [02_data_model.md](../confluence/02_data_model.md) — Anchors + verification_events schema
- [03_security_rls.md](../confluence/03_security_rls.md) — RLS policies for verification tables
- [12_verification_api.md](../confluence/12_verification_api.md) — Phase 1.5 frozen response schema
- [04_p4e1_anchor_engine.md](./04_p4e1_anchor_engine.md) — Anchor creation and detail views
- [06_p5_org_admin.md](./06_p5_org_admin.md) — public_id generation (P5-TS-05)
- [bug_log.md](../bugs/bug_log.md) — Related bugs

## Change Log

| Date | Change |
|------|--------|
| 2026-03-10 | Initial P6 story documentation created (Session 3 of 3). |
| 2026-03-11 | P6-TS-04 promoted PARTIAL → COMPLETE. AnchorLifecycleTimeline wired into PublicVerification.tsx Section 5 via mapToLifecycleData(). P6 now 5/6 complete, 1/6 partial. |

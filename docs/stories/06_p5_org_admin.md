# P5 Org Admin — Story Documentation
_Last updated: 2026-03-10 | 6/6 stories COMPLETE_

## Group Overview

P5 Org Admin delivers the organization-level management layer: a filterable, searchable records registry with CSV export; credential revocation with persisted reasons; a real member list from Supabase; auto-generated public IDs on insert; bulk CSV import with credential_type and metadata support; and a full credential templates CRUD system.

Key deliverables:
- `OrgRegistryTable` — server-side paginated table with status/search/date filters, bulk select, CSV export
- `RevokeDialog` — revocation with reason field persisted via `revoke_anchor()` RPC
- `MembersTable` + `useOrgMembers` — real Supabase query for org member list
- `public_id` auto-generation on INSERT (migration 0037, replaces status-transition generation)
- `BulkUploadWizard` — 4-step CSV import with credential_type and metadata columns
- `CredentialTemplatesManager` — CRUD for reusable credential templates (migration 0040)

All P5 work requires ORG_ADMIN role. RLS policies restrict access to the user's own organization.

## Architecture Context

**Design Principle: Org-Scoped Everything.** Every query in P5 filters by `org_id = get_user_org_id()`. RLS enforces this at the database level. An ORG_ADMIN cannot see or modify another organization's records, members, or templates.

**Public ID Strategy (migration 0037):** Originally, `public_id` was generated when status transitioned to SECURED (UPDATE trigger). Migration 0037 changes this to INSERT-time generation — PENDING anchors now get shareable URLs immediately, enabling verification workflows before chain confirmation.

---

## Stories

---

### P5-TS-01: OrgRegistryTable (Filter, Search, Export)

**Status:** COMPLETE
**Dependencies:** P1-TS-04 (RLS on anchors), P2-TS-06 (useOrganization)
**Blocked by:** None

#### What This Story Delivers

A server-side paginated table for org admins to manage all organization records. Supports status filtering, full-text search across filename and fingerprint, date range filtering, page-level bulk selection, and CSV export of all org records.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Component | `src/components/organization/OrgRegistryTable.tsx` | 474 | Full registry table with filters, pagination, bulk actions |
| Hook | `src/hooks/useExportAnchors.ts` | 71 | Fetch all org anchors + generate CSV download |

#### Database Changes

None (queries existing `anchors` table with org_id filter).

#### Query Architecture

The table builds a dynamic Supabase query:
```
supabase.from('anchors')
  .select('*', { count: 'exact' })
  .eq('org_id', orgId)
  .is('deleted_at', null)
  [+ optional .eq('status', statusFilter)]
  [+ optional .or('filename.ilike.%q%,fingerprint.ilike.%q%')]
  [+ optional .gte('created_at', fromDate)]
  [+ optional .lte('created_at', toDate)]
  .order('created_at', { ascending: false })
  .range((page - 1) * 10, page * 10 - 1)
```

Pagination uses `count: 'exact'` for total record count and `.range()` for page slicing (10 records per page).

#### Feature Details

| Feature | Implementation |
|---------|---------------|
| Status filter | Dropdown: ALL, PENDING, SECURED, REVOKED — adds `.eq('status', ...)` |
| Search | Text input — adds `.or('filename.ilike.%q%,fingerprint.ilike.%q%')` |
| Date range | From/To date inputs with UTC conversion |
| Bulk select | Page-level checkbox + per-row checkboxes via `Set<string>` |
| Bulk revoke | Conditional button showing revocable count (excludes already-REVOKED) |
| CSV export | `useExportAnchors()` hook — fetches all records, generates CSV, triggers download |
| Per-row actions | Dropdown: View Details, Download Proof (SECURED), Revoke (non-REVOKED) |

#### Security Considerations

- All queries filter by `org_id` — RLS double-enforces this at DB level
- Bulk revoke only available for non-REVOKED anchors
- CSV export fetches all org records (no pagination limit) — relies on RLS scoping

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| `src/hooks/useExportAnchors.test.ts` | Unit | Fetch all records, CSV generation, download trigger, error handling |

**Untested areas:** Table rendering, filter combinations, pagination, bulk selection UI.

#### Acceptance Criteria

- [x] Server-side paginated table (10 rows per page)
- [x] Status filter (ALL/PENDING/SECURED/REVOKED)
- [x] Full-text search on filename and fingerprint
- [x] Date range filter with clear button
- [x] Page-level bulk selection
- [x] Bulk revoke action (non-REVOKED only)
- [x] CSV export of all org records
- [x] Per-row dropdown actions (View, Download, Revoke)
- [x] Status badges with correct colors
- [x] Formatted fingerprint display

#### Known Issues

None.

#### How to Verify (Manual)

1. Login as `admin_demo@arkova.local` / `demo_password_123`
2. Navigate to Organization page
3. Verify table loads with seed data records
4. Filter by status "SECURED" — verify only SECURED records shown
5. Search for a filename — verify results filter
6. Select bulk checkbox — verify count updates
7. Click "Export CSV" — verify file downloads

---

### P5-TS-02: RevokeDialog (Reason + DB Persist)

**Status:** COMPLETE
**Dependencies:** P1-TS-04 (RLS on anchors), P4-TS-01 (anchor creation)
**Blocked by:** None

#### What This Story Delivers

A confirmation dialog for revoking credentials with a mandatory reason field. The reason is persisted to the `revocation_reason` column via the `revoke_anchor()` RPC function (migration 0036). The dialog requires typing "revoke" as a safety confirmation.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Component | `src/components/organization/RevokeDialog.tsx` | 141 | AlertDialog with reason textarea + confirmation input |
| Migration | `supabase/migrations/0036_revoke_anchor_reason.sql` | — | Add `reason` parameter to `revoke_anchor()` RPC |

#### Database Changes

| Object | Type | Migration | Description |
|--------|------|-----------|-------------|
| `revoke_anchor()` | Function (updated) | 0036 | Accepts `reason text` parameter, truncates to 2000 chars, stores in `revocation_reason` |
| `revocation_reason` | Column (implicit) | Pre-existing | Text column on anchors for storing revocation reason |

#### Component Flow

1. User clicks "Revoke" on a record → dialog opens
2. User enters revocation reason (textarea, required)
3. User types "revoke" in confirmation input (case-insensitive)
4. Submit button enabled only when confirmation matches
5. On submit: `onConfirm(reason)` callback fires → calls `revoke_anchor(anchor_id, reason)` RPC
6. Loading state disables all inputs during async operation
7. Audit event logged with reason in details JSONB

#### Security Considerations

- **RPC function:** `revoke_anchor()` validates ownership at DB level (RLS + function logic)
- **Reason truncated:** Server-side truncation to 2000 chars prevents payload stuffing
- **Audit trail:** Revocation event includes reason, anchor ID, actor info
- **Confirmation gate:** Prevents accidental revocation — must type "revoke"

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| — | — | No dedicated test for RevokeDialog |

**Untested areas:** Dialog rendering, confirmation validation, reason persistence, audit logging.

#### Acceptance Criteria

- [x] AlertDialog with warning icon and destructive styling
- [x] Reason textarea (required, placeholder from `copy.ts`)
- [x] Confirmation input requiring "revoke" (case-insensitive)
- [x] Submit button disabled until confirmation matches
- [x] Loading state during async operation
- [x] Reason persisted via `revoke_anchor()` RPC
- [x] Audit event logged with reason

#### Known Issues

None.

#### How to Verify (Manual)

1. Login as org admin with SECURED records
2. Click "Revoke" on a record → dialog opens
3. Enter reason, type "revoke" → submit
4. Query DB: `SELECT revocation_reason, status FROM anchors WHERE id = '...';` — expect REVOKED + reason text

---

### P5-TS-03: MembersTable (Real Supabase Query)

**Status:** COMPLETE
**Dependencies:** P1-TS-04 (RLS on profiles), P2-TS-06 (useOrganization)
**Blocked by:** None

#### What This Story Delivers

A member list showing all profiles in the current organization, fetched via `useOrgMembers()` real Supabase query. Displays avatar (with fallback initials), role badge, status, join date, and per-row actions (remove member).

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Component | `src/components/organization/MembersTable.tsx` | 282 | Member table with avatars, roles, actions |
| Hook | `src/hooks/useOrgMembers.ts` | 72 | Fetch profiles where `org_id` matches |

#### Database Changes

None (queries existing `profiles` table).

#### Hook Details

`useOrgMembers(orgId)` returns `{ members, loading, error, refreshMembers }`:
- Query: `supabase.from('profiles').select('id, email, full_name, avatar_url, role, created_at').eq('org_id', orgId)`
- Maps to `Member` interface: `id`, `email`, `fullName`, `avatarUrl`, `role`, `joinedAt`, `status`
- Status hardcoded as `'active'` (no member status tracking yet)

#### Component Features

| Feature | Implementation |
|---------|---------------|
| Avatar | Image or fallback initials (computed from name/email) |
| Role badge | ORG_ADMIN (default style), INDIVIDUAL (secondary) |
| "You" label | Shown next to current user's name |
| Remove action | Confirmation dialog with async callback |
| Empty state | "No members" message |
| Loading state | 3 skeleton rows |

#### Security Considerations

- `useOrgMembers()` filters by `org_id` — RLS ensures users only see their org's members
- Remove member action requires confirmation dialog
- No cross-org member visibility

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| — | — | No dedicated test for MembersTable or useOrgMembers |

**Untested areas:** Member list rendering, avatar fallback, remove member flow.

#### Acceptance Criteria

- [x] Table with columns: Member, Role, Status, Joined, Actions
- [x] Avatar with fallback initials
- [x] Role badge (ORG_ADMIN/INDIVIDUAL)
- [x] "You" label for current user
- [x] Remove member action with confirmation
- [x] Empty state display
- [x] Loading skeleton (3 rows)
- [x] Real Supabase query (not mock data)

#### Known Issues

None.

#### How to Verify (Manual)

1. Login as `admin_demo@arkova.local`
2. Navigate to Organization page → Members section
3. Verify member list shows seed org members
4. Verify current user has "You" label
5. Verify role badges display correctly

---

### P5-TS-05: public_id Auto-Generation on INSERT

**Status:** COMPLETE
**Dependencies:** P1-TS-02 (anchors table)
**Blocked by:** None

#### What This Story Delivers

Changes `public_id` generation from a status-transition trigger (fire on SECURED) to an INSERT trigger (fire on every new anchor). This means PENDING anchors immediately get a shareable URL, enabling verification workflows before chain confirmation.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Migration | `supabase/migrations/0037_public_id_on_insert.sql` | 99 | Replace UPDATE trigger with INSERT trigger + backfill |

#### Database Changes

| Object | Type | Migration | Description |
|--------|------|-----------|-------------|
| `auto_generate_public_id()` | Function | 0037 | BEFORE INSERT trigger: generates unique `public_id` via `generate_public_id()` with collision retry |
| `generate_public_id_on_insert` | Trigger | 0037 | Replaces `generate_public_id_on_secured` (UPDATE trigger) |
| Backfill | DML | 0037 | Fills NULL `public_id` for all existing anchors |

#### Previous vs. New Behavior

| Aspect | Before (0020) | After (0037) |
|--------|---------------|--------------|
| Trigger | BEFORE UPDATE (status = SECURED) | BEFORE INSERT (unconditional) |
| PENDING anchors | No `public_id` | `public_id` generated immediately |
| Verification URLs | Only after chain confirmation | Available immediately on creation |
| Collision handling | None | Retry loop until unique |

#### Security Considerations

- `public_id` is a non-guessable random identifier — safe for public URLs
- Collision detection retries prevent duplicate `public_id` values
- Backfill ensures all existing anchors have a `public_id`

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| — | — | No dedicated test for public_id generation |

**Untested areas:** Trigger fires on INSERT, collision retry logic, backfill completeness.

#### Acceptance Criteria

- [x] INSERT trigger generates `public_id` for every new anchor
- [x] Old UPDATE trigger removed
- [x] Collision detection with retry
- [x] Existing anchors backfilled with `public_id`
- [x] Rollback SQL restores previous behavior

#### Known Issues

None.

#### How to Verify (Manual)

1. Start local Supabase: `supabase start && supabase db reset`
2. Insert a new anchor (PENDING status)
3. Query: `SELECT public_id FROM anchors ORDER BY created_at DESC LIMIT 1;` — expect non-NULL value
4. Verify all seed anchors have `public_id`: `SELECT count(*) FROM anchors WHERE public_id IS NULL;` — expect 0

---

### P5-TS-06: BulkUploadWizard (CSV with credential_type + metadata)

**Status:** COMPLETE
**Dependencies:** P4-TS-04 (credential_type), P4-TS-05 (metadata)
**Blocked by:** None (~~CRIT-6~~ resolved 2026-03-10, commit a38b485)

#### What This Story Delivers

A 4-step wizard for bulk importing credentials via CSV. Supports `credential_type` and `metadata` as optional columns. Validates rows against the same Zod schemas used for single anchor creation. Processes in batches of 50 with progress tracking and cancellation support.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Component | `src/components/upload/BulkUploadWizard.tsx` | 516 | 4-step wizard: Upload → Review → Processing → Complete |
| Component | `src/components/upload/CsvUploader.tsx` | 199 | File upload + CSV parsing + column detection |
| Hook | `src/hooks/useBulkAnchors.ts` | 146 | Batch processing with progress tracking |
| Utility | `src/lib/csvParser.ts` | 408 | CSV parsing, column mapping, row validation |
| Test | `src/components/upload/CsvUploader.test.tsx` | — | File validation, column detection, error cases |
| Test | `src/hooks/useBulkAnchors.test.ts` | — | Batch processing, dedup, progress, errors |

#### Wizard Steps

| Step | Name | What Happens |
|------|------|-------------|
| 1 | Upload | Drag-drop or file picker. Async CSV parse + validate. Max 10MB, max 10,000 rows. |
| 2 | Review | Column mapping UI + validation summary (valid/invalid counts). Error table (first 5). |
| 3 | Processing | Progress bar + "Do not close" message. Batched by 50 records. Cancellable. |
| 4 | Complete | Summary badges (Created/Skipped/Failed). "Upload Another" button. |

#### CSV Column Support

| Column | Required | Detection Names |
|--------|----------|----------------|
| fingerprint | Yes | fingerprint, sha256, hash |
| filename | Yes | filename, name, file |
| file_size | No | file_size, size |
| email | No | email |
| credential_type | No | credential_type, type |
| metadata | No | metadata |

#### Security Considerations

- CSV parsing runs entirely client-side (no server upload)
- Row validation uses same Zod schemas as single anchor creation
- Batch insert goes through RLS (user_id = auth.uid())
- Invalid rows are separated and shown to user — never inserted

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| `src/components/upload/CsvUploader.test.tsx` | Unit | Valid CSV, invalid email, non-CSV rejection, empty CSV, missing columns, row limits |
| `src/hooks/useBulkAnchors.test.ts` | Unit | Successful creation, idempotent dedup, mixed results, RPC errors, progress tracking |

#### Acceptance Criteria

- [x] 4-step wizard flow (Upload → Review → Processing → Complete)
- [x] CSV column auto-detection for standard names
- [x] `credential_type` optional column with enum validation
- [x] `metadata` optional column with JSON validation
- [x] Row-by-row validation with error reporting
- [x] Batch processing (50 records per batch)
- [x] Progress bar with percentage
- [x] Cancel support during processing
- [x] Summary with Created/Skipped/Failed counts
- [x] Max 10,000 rows, max 10MB file size

#### Known Issues

| Bug | Impact |
|-----|--------|
| ~~[CRIT-6](../bugs/bug_log.md#crit-6-csvuploadwizard-uses-simulated-processing)~~ | RESOLVED 2026-03-10 (commit a38b485). CSVUploadWizard rewritten with real csvParser + useBulkAnchors hook. Both wizard components now use real processing. |

#### How to Verify (Manual)

1. Login as org admin
2. Navigate to Organization → Bulk Upload
3. Upload a CSV with columns: `fingerprint,filename,credential_type`
4. Verify column mapping auto-detected
5. Verify valid/invalid row counts shown
6. Click "Process" — observe progress bar
7. Verify summary shows Created count

---

### P5-TS-07: credential_templates CRUD + Manager UI

**Status:** COMPLETE
**Dependencies:** P4-TS-04 (credential_type enum), P2-TS-06 (useOrganization)
**Blocked by:** None

#### What This Story Delivers

A full CRUD system for reusable credential templates. Org admins can create, edit, toggle active/inactive, and delete templates. Each template defines a name, credential type, description, and default metadata. Backed by migration 0040 with RLS and audit logging.

#### Implementation Files

| Layer | File | Lines | Purpose |
|-------|------|-------|---------|
| Migration | `supabase/migrations/0040_credential_templates.sql` | 90 | Table + constraints + indexes + RLS + moddatetime |
| Component | `src/components/credentials/CredentialTemplatesManager.tsx` | 438 | CRUD UI with create/edit dialog, table, toggle, delete |
| Hook | `src/hooks/useCredentialTemplates.ts` | 209 | CRUD operations + audit logging |

#### Database Changes

| Object | Type | Migration | Description |
|--------|------|-----------|-------------|
| `credential_templates` | Table | 0040 | Columns: id, org_id (FK), name (1-255), description (0-2000), credential_type (enum), default_metadata (JSONB), is_active (boolean), created_by (FK), created_at, updated_at |
| `(org_id, name) UNIQUE` | Constraint | 0040 | Template names unique per organization |
| `default_metadata CHECK` | Constraint | 0040 | Must be JSON object or NULL |
| `idx_credential_templates_org_id` | Index | 0040 | Filter by organization |
| `idx_credential_templates_credential_type` | Index | 0040 | Filter by type |
| RLS policies | Policies | 0040 | SELECT: same org. INSERT: ORG_ADMIN + created_by = auth.uid(). UPDATE/DELETE: ORG_ADMIN in org. |
| `moddatetime` trigger | Trigger | 0040 | Auto-updates `updated_at` on modification |

#### CRUD Operations

| Operation | Method | Audit Event | Details |
|-----------|--------|-------------|---------|
| Create | `supabase.from('credential_templates').insert(...)` | TEMPLATE_CREATED | Template name + type |
| Read | `supabase.from('credential_templates').select('*').eq('org_id', orgId).order('created_at', { ascending: false })` | — | — |
| Update | `supabase.from('credential_templates').update(...)` | TEMPLATE_UPDATED | Changed field names |
| Delete | `supabase.from('credential_templates').delete()` | TEMPLATE_DELETED | Template ID |
| Toggle | Update `is_active` field | TEMPLATE_UPDATED | is_active field |

#### Component Features

| Feature | Implementation |
|---------|---------------|
| Create dialog | Name (required), credential type (select), description (optional), default metadata (JSON textarea with validation) |
| Edit dialog | Pre-populated form, same fields as create |
| Templates table | Name, Type, Active (toggle switch), Created, Actions (edit/delete) |
| Empty state | "No templates yet" with creation prompt |
| JSON validation | Metadata textarea validates as JSON object on submit |

#### Route

`/settings/credential-templates` — accessible to ORG_ADMIN users via Settings navigation.

#### Security Considerations

- **RLS:** Only same-org users can SELECT. Only ORG_ADMIN can INSERT/UPDATE/DELETE.
- **created_by tracking:** `created_by = auth.uid()` on INSERT enforces creator attribution
- **Audit trail:** All CRUD operations logged with event category ORG
- **Metadata validation:** Both client-side (JSON parse check) and DB-level (CHECK constraint)

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| — | — | No dedicated test for CredentialTemplatesManager or useCredentialTemplates |

**Untested areas:** CRUD operations, dialog rendering, JSON validation, audit logging.

#### Acceptance Criteria

- [x] `credential_templates` table with all columns and constraints (migration 0040)
- [x] RLS: ORG_ADMIN only for write operations
- [x] CRUD hook with audit logging
- [x] Create/Edit dialog with name, type, description, metadata
- [x] Templates table with toggle switch for is_active
- [x] Delete with confirmation
- [x] JSON metadata validation (client + DB)
- [x] Unique template names per organization
- [x] Routed at `/settings/credential-templates`

#### Known Issues

None.

#### How to Verify (Manual)

1. Login as `admin_demo@arkova.local`
2. Navigate to Settings → Credential Templates
3. Click "Create Template" — fill in name, select type, add description
4. Verify template appears in table
5. Toggle active/inactive — verify switch updates
6. Click edit — modify description — save
7. Click delete — confirm — verify template removed
8. Query: `SELECT * FROM credential_templates;` — verify DB state matches UI

---

## Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| Server-side pagination (not client) | Org registries can have thousands of records — client-side would be slow |
| `revoke_anchor()` RPC (not direct update) | Encapsulates status transition + audit logging + reason storage in one atomic operation |
| public_id on INSERT (not SECURED) | PENDING anchors need shareable URLs immediately for verification workflows |
| Batch size 50 for CSV import | Balances throughput vs. single-request payload size |
| Credential templates separate from anchors | Templates are reusable definitions; anchors are instances. Separate tables = clean normalization. |
| moddatetime extension for updated_at | Simpler than custom trigger for timestamp auto-update |

## Migration Inventory

| Migration | Story | Description |
|-----------|-------|-------------|
| 0036 | P5-TS-02 | `revoke_anchor()` RPC updated with reason parameter |
| 0037 | P5-TS-05 | `public_id` generation moved from UPDATE to INSERT trigger |
| 0040 | P5-TS-07 | `credential_templates` table + RLS + indexes |

## Related Documentation

- [02_data_model.md](../confluence/02_data_model.md) — Anchors + credential_templates schema
- [03_security_rls.md](../confluence/03_security_rls.md) — RLS policies for org-scoped tables
- [04_audit_events.md](../confluence/04_audit_events.md) — Template lifecycle audit events
- [05_p4e2_credential_metadata.md](./05_p4e2_credential_metadata.md) — Credential type + metadata foundation
- [bug_log.md](../bugs/bug_log.md) — ~~CRIT-6~~ (CSVUploadWizard — RESOLVED)

## Change Log

| Date | Change |
|------|--------|
| 2026-03-10 | Initial P5 story documentation created (Session 2 of 3). |
| 2026-03-11 ~12:30 AM EST | Documentation audit: Updated CRIT-6 reference as resolved (commit a38b485). |

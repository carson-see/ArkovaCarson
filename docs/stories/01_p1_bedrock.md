# P1 Bedrock — Story Documentation
_Last updated: 2026-03-10 | 6/6 stories COMPLETE_

## Group Overview

P1 Bedrock establishes the foundational database schema, validation layer, and security infrastructure that every other story depends on. This includes:

- Core enums (`user_role`, `anchor_status`)
- Core tables (`organizations`, `profiles`, `anchors`)
- Append-only audit trail (`audit_events`)
- Row-Level Security (RLS) on all tables with FORCE ROW LEVEL SECURITY
- Zod validation schemas mirroring database constraints
- Validation-on-insert wiring in the anchor creation flow

All P1 work lives in migrations 0001-0011 and `src/lib/validators.ts`. No UI components are introduced in P1 except `ConfirmAnchorModal` which wires validation to the insert path.

## Architecture Context

**Design Principle: Schema-First.** Every constraint is defined in the database first (CHECK, TRIGGER, RLS), then mirrored in Zod validators for client-side pre-validation. This dual enforcement means invalid data is rejected at both the application layer (Zod) and database layer (constraints + RLS), preventing any bypass.

**Key Security Properties:**
- RLS is FORCED on all tables (even service_role must use `SET LOCAL role` to bypass)
- Roles are immutable once set (trigger-enforced)
- Audit events are append-only (UPDATE/DELETE rejected by trigger)
- Anchor status `SECURED` can only be set by service_role (worker)
- No document content is ever stored — only fingerprints (SHA-256 hex)

---

## Stories

---

### P1-TS-01: Core Enums

**Status:** COMPLETE
**Dependencies:** None (first migration)
**Blocked by:** None

#### What This Story Delivers

Defines the two foundational enum types used throughout the system: `user_role` (INDIVIDUAL, ORG_ADMIN) determines what a user can access, and `anchor_status` (PENDING, SECURED, REVOKED) tracks the lifecycle of every anchored document. These enums are referenced by foreign key-like constraints in profiles and anchors tables.

#### Implementation Files

| Layer | File | Purpose |
|-------|------|---------|
| Migration | `supabase/migrations/0001_enums.sql` | CREATE TYPE for user_role and anchor_status |

#### Database Changes

| Object | Type | Migration | Description |
|--------|------|-----------|-------------|
| `user_role` | ENUM | 0001 | Values: INDIVIDUAL, ORG_ADMIN. Later extended with ORG_MEMBER in 0022. |
| `anchor_status` | ENUM | 0001 | Values: PENDING, SECURED, REVOKED |

#### Security Considerations

No security-sensitive changes. Enums are type definitions only.

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| `src/lib/validators.test.ts` | Unit | Validates enum values are accepted by Zod schemas |

**Untested areas:** No direct enum migration test (validated indirectly via table insert tests).

#### Acceptance Criteria

- [x] `user_role` enum created with INDIVIDUAL and ORG_ADMIN values
- [x] `anchor_status` enum created with PENDING, SECURED, and REVOKED values
- [x] Enums available for use in subsequent migrations

#### Known Issues

None.

#### How to Verify (Manual)

1. Start local Supabase: `supabase start`
2. Reset database: `supabase db reset`
3. Connect to DB: `psql postgresql://postgres:postgres@localhost:54322/postgres`
4. Run: `SELECT unnest(enum_range(NULL::user_role));` — expect INDIVIDUAL, ORG_ADMIN
5. Run: `SELECT unnest(enum_range(NULL::anchor_status));` — expect PENDING, SECURED, REVOKED

---

### P1-TS-02: Core Tables (Organizations, Profiles, Anchors)

**Status:** COMPLETE
**Dependencies:** P1-TS-01 (enums)
**Blocked by:** None

#### What This Story Delivers

Creates the three core tables that hold all application data: organizations (company accounts), profiles (user accounts linked to Supabase auth), and anchors (document fingerprint records). Each table has comprehensive constraints, indexes, and triggers for data integrity.

#### Implementation Files

| Layer | File | Purpose |
|-------|------|---------|
| Migration | `supabase/migrations/0002_organizations.sql` | Organizations table + updated_at trigger |
| Migration | `supabase/migrations/0003_profiles.sql` | Profiles table + email normalization trigger |
| Migration | `supabase/migrations/0004_anchors.sql` | Anchors table + unique fingerprint index |

#### Database Changes

| Object | Type | Migration | Description |
|--------|------|-----------|-------------|
| `trigger_set_updated_at()` | Function | 0002 | Reusable trigger function for updated_at timestamps |
| `organizations` | Table | 0002 | Columns: id, legal_name, display_name, domain, verification_status, created_at, updated_at. Constraints: domain format regex, status enum check. |
| `profiles` | Table | 0003 | Columns: id (FK auth.users CASCADE), email (unique, lowercased), full_name, avatar_url, role (user_role), role_set_at, org_id (FK organizations), requires_manual_review, manual_review_reason, created_at, updated_at. Constraints: email regex, role/org consistency (ORG_ADMIN requires org_id). |
| `enforce_profiles_lowercase_email` | Trigger | 0003 | Lowercases email on INSERT/UPDATE |
| `anchors` | Table | 0004 | Columns: id, user_id (FK profiles CASCADE), org_id (FK organizations SET NULL), fingerprint (char(64) SHA-256), filename, file_size, file_mime, status (anchor_status), chain_tx_id, chain_block_height, chain_timestamp, legal_hold, retention_until, deleted_at, created_at, updated_at. Constraints: fingerprint SHA-256 regex, filename length/control-char checks, chain data consistency (SECURED requires tx_id). |
| `(user_id, fingerprint) UNIQUE WHERE deleted_at IS NULL` | Index | 0004 | Prevents duplicate anchors per user |

#### Security Considerations

- Profiles FK to `auth.users` with CASCADE — deleting a Supabase user cascades to profile
- Anchors FK to profiles with CASCADE — profile deletion cascades to anchors
- Org_id on anchors uses SET NULL — org deletion orphans anchors (soft removal)
- Email uniqueness enforced at DB level + lowercased by trigger
- No RLS yet (added in P1-TS-04)

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| `src/lib/validators.test.ts` | Unit | Constraint values match Zod schemas (fingerprint format, filename rules) |

**Untested areas:** No direct migration constraint tests (e.g., inserting invalid fingerprint at DB level). Validated indirectly by RLS tests and application-level validators.

#### Acceptance Criteria

- [x] Organizations table with legal_name, display_name, domain, verification_status
- [x] Profiles table linked to auth.users with role, org_id, manual review fields
- [x] Anchors table with fingerprint (SHA-256), lifecycle status, chain data fields
- [x] Updated_at triggers on all three tables
- [x] Email lowercasing trigger on profiles
- [x] Unique fingerprint constraint per user (deduplication)

#### Known Issues

None.

#### How to Verify (Manual)

1. Start local Supabase: `supabase start && supabase db reset`
2. Connect to DB: `psql postgresql://postgres:postgres@localhost:54322/postgres`
3. Run: `\d organizations` — verify columns match spec
4. Run: `\d profiles` — verify FK to auth.users, role column
5. Run: `\d anchors` — verify fingerprint char(64), status column
6. Run: `\di` — verify indexes exist (email unique, fingerprint, user_id+fingerprint unique partial)

---

### P1-TS-03: Audit Events (Append-Only)

**Status:** COMPLETE
**Dependencies:** P1-TS-02 (profiles, organizations tables for FKs)
**Blocked by:** None

#### What This Story Delivers

Creates an immutable, append-only audit log table. Once an event is written, it cannot be modified or deleted — even by service_role. This provides a tamper-evident record of all security-relevant actions in the system (auth events, anchor creation, profile changes, admin actions).

#### Implementation Files

| Layer | File | Purpose |
|-------|------|---------|
| Migration | `supabase/migrations/0006_audit_events.sql` | Audit events table + reject_audit_modification() trigger |
| Client lib | `src/lib/auditLog.ts` | Client-side helper for logging audit events |

#### Database Changes

| Object | Type | Migration | Description |
|--------|------|-----------|-------------|
| `audit_events` | Table | 0006 | Columns: id, event_type (1-100 chars), event_category (AUTH/ANCHOR/PROFILE/ORG/ADMIN/SYSTEM), actor_id (FK profiles), actor_email, actor_ip, actor_user_agent, target_type, target_id, org_id (FK organizations), details (max 10000 chars), created_at (immutable). |
| `reject_audit_modification()` | Function | 0006 | Raises exception on any UPDATE or DELETE attempt |
| `reject_audit_update` | Trigger | 0006 | BEFORE UPDATE — calls reject_audit_modification() |
| `reject_audit_delete` | Trigger | 0006 | BEFORE DELETE — calls reject_audit_modification() |

#### Security Considerations

- **Append-only enforcement:** Database triggers prevent UPDATE and DELETE on audit_events. There is no way to modify or remove audit records through SQL, even with service_role.
- **Event categories are checked:** CHECK constraint validates event_category against allowed values.
- **Actor tracking:** actor_id FK to profiles allows tracing who performed each action. actor_email, actor_ip, actor_user_agent provide additional context.

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| `src/lib/validators.test.ts` | Unit | AuditEventCreateSchema validates event_type, event_category, details length |

**Untested areas:** No direct test verifying the UPDATE/DELETE rejection triggers fire correctly. Should be tested in RLS integration tests.

#### Acceptance Criteria

- [x] audit_events table created with all required columns
- [x] event_category CHECK constraint (AUTH, ANCHOR, PROFILE, ORG, ADMIN, SYSTEM)
- [x] UPDATE trigger rejects all modifications
- [x] DELETE trigger rejects all deletions
- [x] created_at is immutable (set once on INSERT)
- [x] Zod schema mirrors DB constraints

#### Known Issues

None.

#### How to Verify (Manual)

1. Start local Supabase: `supabase start && supabase db reset`
2. Login as any seed user
3. Insert an audit event via the app (e.g., update your profile name in Settings)
4. Connect to DB: `psql postgresql://postgres:postgres@localhost:54322/postgres`
5. Run: `SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 5;` — verify event exists
6. Run: `UPDATE audit_events SET details = 'tampered' WHERE id = '<any_id>';` — expect ERROR: Audit events cannot be modified
7. Run: `DELETE FROM audit_events WHERE id = '<any_id>';` — expect ERROR: Audit events cannot be modified

---

### P1-TS-04: RLS Policies (All Tables)

**Status:** COMPLETE
**Dependencies:** P1-TS-02 (all tables), P1-TS-03 (audit_events)
**Blocked by:** None

#### What This Story Delivers

Enables Row-Level Security on all four tables with FORCE ROW LEVEL SECURITY, grants appropriate permissions to `authenticated` and `service_role`, and creates fine-grained access policies. This is the core security layer — without RLS, any authenticated user could read/write any row.

Key security properties:
- Users see only their own data (profiles, anchors, audit events)
- ORG_ADMIN users see org-wide anchors
- Privileged fields (role, org_id, manual_review) are protected from client modification
- Anchor status transitions are gated (only service_role can set SECURED)
- Audit events are INSERT+SELECT only (no UPDATE/DELETE)

#### Implementation Files

| Layer | File | Purpose |
|-------|------|---------|
| Migration | `supabase/migrations/0007_enable_rls.sql` | ENABLE RLS + FORCE + permission grants |
| Migration | `supabase/migrations/0008_rls_profiles.sql` | Profile policies + protect_privileged_profile_fields() |
| Migration | `supabase/migrations/0009_rls_organizations.sql` | Org policies + get_user_org_id() + is_org_admin() helpers |
| Migration | `supabase/migrations/0010_rls_anchors.sql` | Anchor policies + protect_anchor_status_transition() |
| Migration | `supabase/migrations/0011_rls_audit_events.sql` | Audit event policies |
| Migration | `supabase/migrations/0005_role_immutability.sql` | check_role_immutability() trigger |

#### Database Changes

| Object | Type | Migration | Description |
|--------|------|-----------|-------------|
| RLS enabled | Config | 0007 | `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` on organizations, profiles, anchors, audit_events |
| Permission grants | Config | 0007 | authenticated: SELECT/INSERT/UPDATE/DELETE on tables (audit_events: SELECT/INSERT only). service_role: ALL. |
| `users_select_own` | RLS Policy | 0008 | profiles SELECT: auth.uid() = id |
| `profiles_update_own` | RLS Policy | 0008 | profiles UPDATE: auth.uid() = id |
| `protect_privileged_profile_fields()` | Trigger | 0008 | Blocks client modification of org_id, requires_manual_review, manual_review_* fields |
| `check_role_immutability()` | Trigger | 0005 | Once role is set (not NULL), it cannot be changed. Sets role_set_at on first assignment. |
| `get_user_org_id()` | Function | 0009 | Returns current user's org_id from profiles |
| `is_org_admin()` | Function | 0009 | Returns true if current user's role is ORG_ADMIN |
| `organizations_select_own` | RLS Policy | 0009 | organizations SELECT: id = get_user_org_id() |
| `organizations_update_admin` | RLS Policy | 0009 | organizations UPDATE: id = get_user_org_id() AND is_org_admin() |
| `anchors_select_own` | RLS Policy | 0010 | anchors SELECT: user_id = auth.uid() (own anchors) |
| `anchors_select_org` | RLS Policy | 0010 | anchors SELECT: org_id = get_user_org_id() AND is_org_admin() (org anchors) |
| `anchors_insert_own` | RLS Policy | 0010 | anchors INSERT: user_id = auth.uid() AND status = PENDING |
| `anchors_update_own` | RLS Policy | 0010 | anchors UPDATE: user_id = auth.uid() (see trigger for field protection) |
| `protect_anchor_status_transition()` | Trigger | 0010 | Blocks client from: changing user_id, setting SECURED, modifying chain_*, modifying legal_hold |
| `audit_events_select_own` | RLS Policy | 0011 | audit_events SELECT: actor_id = auth.uid() |
| `audit_events_insert_own` | RLS Policy | 0011 | audit_events INSERT: actor_id IS NULL OR actor_id = auth.uid() |

#### Security Considerations

- **FORCE ROW LEVEL SECURITY** means even the table owner must pass RLS checks. Only `service_role` (with `SET LOCAL role`) bypasses.
- **Role immutability** is enforced by trigger — not just RLS. Even service_role cannot change a role once set.
- **Status gating** prevents privilege escalation: a client cannot mark their own anchor as SECURED. Only the worker (service_role) can do this after chain confirmation.
- **No DELETE policy on anchors** — soft delete only (set deleted_at). Legal hold prevents even soft deletion.

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| `tests/rls/helpers.ts` | Helper | `withUser()` / `withAuth()` for RLS testing |
| `e2e/route-guards.spec.ts` | E2E | Route-level access control (auth required, role-based routing) |

**Untested areas:** Direct RLS policy tests (e.g., user A cannot read user B's anchors) are not yet written as dedicated test files. The helpers exist but comprehensive RLS test suites are needed.

#### Acceptance Criteria

- [x] RLS enabled and forced on all 4 tables
- [x] authenticated role can only SELECT own profile, org, anchors, audit events
- [x] INSERT policies enforce user_id = auth.uid() and status = PENDING
- [x] Privileged profile fields protected from client modification
- [x] Role immutability enforced by trigger
- [x] Anchor status transition gated (SECURED = service_role only)
- [x] Audit events: INSERT + SELECT only (no UPDATE/DELETE)
- [x] service_role has full access

#### Known Issues

None.

#### How to Verify (Manual)

1. Start local Supabase: `supabase start && supabase db reset`
2. Login as `individual@demo.arkova.io` / `Demo1234!`
3. In Supabase Studio (localhost:54323), verify anchors query returns only that user's anchors
4. Try to UPDATE another user's anchor via SQL: should fail with RLS violation
5. Try to INSERT anchor with status = 'SECURED': should fail
6. Try to UPDATE profile.role via Supabase client: should fail (trigger blocks)

---

### P1-TS-05: Zod Validators

**Status:** COMPLETE
**Dependencies:** P1-TS-01 (enums for allowed values), P1-TS-02 (table constraints to mirror)
**Blocked by:** None

#### What This Story Delivers

A comprehensive Zod validation library (`src/lib/validators.ts`) that mirrors every database constraint at the application layer. This provides instant client-side feedback (before the network round-trip) and serves as the single source of truth for validation rules that both the frontend and API layer use.

Schemas defined:
- **AnchorCreateSchema** — fingerprint (SHA-256), filename, file_size, credential_type, metadata
- **AnchorUpdateSchema** — editable anchor fields
- **ProfileUpdateSchema** — full_name, avatar_url
- **AuditEventCreateSchema** — event_type, event_category, target info
- **OrganizationUpdateSchema** — display_name, domain

#### Implementation Files

| Layer | File | Purpose |
|-------|------|---------|
| Client lib | `src/lib/validators.ts` (363 lines) | 5 Zod schemas + 4 helper functions |
| Unit test | `src/lib/validators.test.ts` (279 lines) | 50+ test cases across all schemas |

#### Database Changes

None (validators mirror existing DB constraints).

#### Security Considerations

- **Fingerprint normalization:** `normalizeFingerprint()` lowercases SHA-256 hex to prevent case-sensitive duplicates.
- **Control character rejection:** Filenames are checked for ASCII 0-31 and 127 to prevent injection.
- **Credential types:** Whitelist-only enum prevents arbitrary values.
- **Details length cap:** 10,000 chars matches DB CHECK constraint, prevents payload stuffing.

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| `src/lib/validators.test.ts` | Unit | AnchorCreateSchema: valid/invalid fingerprints, filenames, sizes, credential types |
| `src/lib/validators.test.ts` | Unit | AnchorUpdateSchema: partial updates, filename validation |
| `src/lib/validators.test.ts` | Unit | ProfileUpdateSchema: full_name, avatar_url, null handling |
| `src/lib/validators.test.ts` | Unit | AuditEventCreateSchema: valid categories, invalid categories |
| `src/lib/validators.test.ts` | Unit | OrganizationUpdateSchema: display_name, domain TLD validation |
| `src/lib/validators.test.ts` | Unit | Helpers: validateAnchorCreate, validateProfileUpdate, normalizeFingerprint, isValidFilename |

**Untested areas:** None — comprehensive coverage of all schemas and helpers.

#### Acceptance Criteria

- [x] AnchorCreateSchema validates fingerprint as 64-char hex
- [x] Filename validation rejects control characters and enforces 1-255 char length
- [x] Credential type validated against whitelist
- [x] All schemas match corresponding DB constraints
- [x] Helper functions exported for use in components
- [x] 50+ unit tests passing

#### Known Issues

None.

#### How to Verify (Manual)

1. Run: `npm test -- --run validators`
2. All 50+ tests should pass
3. In code: `import { validateAnchorCreate } from '@/lib/validators'`
4. Call with invalid fingerprint (e.g., "abc"): expect ZodError thrown
5. Call with valid data: expect parsed object with normalized fingerprint

---

### P1-TS-06: Validation-on-Insert Wiring

**Status:** COMPLETE
**Dependencies:** P1-TS-04 (RLS for insert policy), P1-TS-05 (validators)
**Blocked by:** None (~~CRIT-1~~ resolved 2026-03-10, commit a38b485)

#### What This Story Delivers

Wires the Zod validators into the actual anchor creation flow. When a user confirms an anchor in `ConfirmAnchorModal`, the component calls `validateAnchorCreate()` before inserting into Supabase, then logs an audit event on success. This ensures every anchor in the database has been validated at both the application and database layers.

This is the **correct pattern** for anchor creation. The org admin path (`IssueCredentialForm`) also follows this pattern. The individual user path (`SecureDocumentDialog`) now also follows this pattern (~~CRIT-1~~ FIXED commit a38b485).

#### Implementation Files

| Layer | File | Purpose |
|-------|------|---------|
| Component | `src/components/anchor/ConfirmAnchorModal.tsx` (216 lines) | Modal: validate → insert → audit log |
| Component test | `src/components/anchor/ConfirmAnchorModal.test.tsx` (115 lines) | Render tests + guard validation |
| Reference | `src/components/organization/IssueCredentialForm.tsx` | Org admin path (same pattern, fully working) |

#### Database Changes

None (uses existing tables and RLS policies from P1-TS-02 and P1-TS-04).

#### Security Considerations

- **Validation before insert:** `validateAnchorCreate()` runs before `supabase.from('anchors').insert()`. Invalid data never reaches the database.
- **RLS enforcement:** Insert policy requires `user_id = auth.uid()` and `status = PENDING`. The component sets these correctly.
- **Audit trail:** Every successful anchor creation is logged with event_type `ANCHOR_CREATED`.

#### Test Coverage

| Test File | Type | What It Validates |
|-----------|------|-------------------|
| `src/components/anchor/ConfirmAnchorModal.test.tsx` | Unit | File/fingerprint display, pending status notice, cancel handler, null guards |

**Untested areas:** No integration test verifying the full flow (validate → insert → audit log → DB row exists). The component test mocks Supabase.

#### Acceptance Criteria

- [x] ConfirmAnchorModal calls validateAnchorCreate() before insert
- [x] Supabase insert uses validated data only
- [x] Audit event logged on successful anchor creation
- [x] Error handling for validation failures (ZodError) and DB errors
- [x] Loading state shown during insert
- [x] Success callback with anchor ID

#### Known Issues

| Bug | Impact |
|-----|--------|
| ~~[CRIT-1](../bugs/bug_log.md#crit-1-securedocumentdialog-fakes-anchor-creation)~~ | RESOLVED 2026-03-10 (commit a38b485). SecureDocumentDialog rewritten to use real Supabase insert following the ConfirmAnchorModal/IssueCredentialForm pattern. |

#### How to Verify (Manual)

1. Start local Supabase: `supabase start && supabase db reset`
2. Login as `admin@umich-demo.arkova.io` / `Demo1234!`
3. Navigate to Organization page
4. Click "Issue Credential" to open IssueCredentialForm
5. Fill in credential details, select a PDF file
6. Click "Issue" — observe loading state, then success
7. Query DB: `SELECT * FROM anchors WHERE org_id = (SELECT id FROM organizations WHERE legal_name = 'University of Michigan') ORDER BY created_at DESC LIMIT 1;`
8. Verify: new row exists with status = PENDING, fingerprint is 64-char lowercase hex
9. Query: `SELECT * FROM audit_events WHERE event_type = 'ANCHOR_CREATED' ORDER BY created_at DESC LIMIT 1;`
10. Verify: audit event exists with matching target_id

---

## Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| Schema-first (DB constraints + Zod mirrors) | Dual enforcement prevents bypass at either layer |
| Append-only audit (trigger-enforced) | Tamper-evident — no one can alter history |
| Role immutability (trigger-enforced) | Prevents privilege escalation even by service_role |
| FORCE ROW LEVEL SECURITY | Table owners must also pass RLS checks |
| Soft delete only (deleted_at) | Legal hold enforcement + audit trail preservation |
| No document content stored | Privacy-by-design — only fingerprints (SHA-256) |
| Status gating (SECURED = service_role only) | Prevents client-side attestation fraud |

## Migration Inventory

| Migration | Story | Description |
|-----------|-------|-------------|
| 0001 | P1-TS-01 | user_role + anchor_status enums |
| 0002 | P1-TS-02 | organizations table + trigger_set_updated_at() |
| 0003 | P1-TS-02 | profiles table + email normalization trigger |
| 0004 | P1-TS-02 | anchors table + unique fingerprint index |
| 0005 | P1-TS-04 | check_role_immutability() trigger |
| 0006 | P1-TS-03 | audit_events table + reject_audit_modification() |
| 0007 | P1-TS-04 | ENABLE RLS + FORCE + permission grants |
| 0008 | P1-TS-04 | profiles RLS + protect_privileged_profile_fields() |
| 0009 | P1-TS-04 | organizations RLS + get_user_org_id() + is_org_admin() |
| 0010 | P1-TS-04 | anchors RLS + protect_anchor_status_transition() |
| 0011 | P1-TS-04 | audit_events RLS policies |

## Related Documentation

- [02_data_model.md](../confluence/02_data_model.md) — Full schema reference
- [03_security_rls.md](../confluence/03_security_rls.md) — RLS policy details
- [04_audit_events.md](../confluence/04_audit_events.md) — Audit event types and categories
- [bug_log.md](../bugs/bug_log.md) — ~~CRIT-1~~ (SecureDocumentDialog — RESOLVED)

## Change Log

| Date | Change |
|------|--------|
| 2026-03-10 | Initial P1 story documentation created (Session 1 of 3). |
| 2026-03-11 ~12:30 AM EST | Documentation audit: Updated CRIT-1 references as resolved (commit a38b485). |

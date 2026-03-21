# Completed Story Archive
_Extracted from CLAUDE.md Section 5 — 2026-03-20_

This file contains detailed completion notes for all 100% complete story groups.
For current incomplete work, see CLAUDE.md Section 5.

---

## P1 Bedrock — 6/6 COMPLETE

All foundational work done: schema (enums, tables, RLS), validators (Zod), audit trail (append-only + triggers), validation-on-insert wired in ConfirmAnchorModal.

## P2 Identity — 5/5 COMPLETE

- P2-TS-03: BrowserRouter + Routes in App.tsx with named routes
- P2-TS-04: AuthGuard + RouteGuard wired into router
- P2-TS-05: useProfile hook with DB persistence
- P2-TS-06: useOrganization hook, OrgSettingsPage wired
- P2-TS-0X: LoginForm, SignUpForm, ProfilePage, SettingsPage all routed

## P3 Vault — 3/3 COMPLETE

- P3-TS-01: DashboardPage + VaultDashboard use `useAnchors()` -- real Supabase queries, no mock data
- P3-TS-02: `is_public_profile` migration + RLS + toggle persisted to DB via `updateProfile()`
- P3-TS-03: Sidebar uses `<Link>` with active route highlighting

## P4-E1 Anchor Engine — 3/3 COMPLETE

- P4-TS-01: ConfirmAnchorModal -- upload, fingerprint, validateAnchorCreate(), insert, audit log
- P4-TS-02: AssetDetailView -- record fields, QR code, lifecycle timeline
- P4-TS-03: RecordDetailPage at `/records/:id` with `useAnchor()` real query

## P4-E2 Credential Metadata — 3/3 COMPLETE

> **Note:** The Technical Backlog PDF says these are "NOT STARTED". It is wrong. All three are implemented.

- P4-TS-04: `credential_type` enum + column (migration 0029)
- P4-TS-05: `metadata` JSONB + editability trigger (migration 0030)
- P4-TS-06: `parent_anchor_id` + `version_number` lineage (migrations 0031-0032)

## P5 Org Admin — 6/6 COMPLETE

- P5-TS-01: OrgRegistryTable -- status filter, search, date range, bulk select, CSV export
- P5-TS-02: RevokeDialog -- reason field, persisted to DB (migration 0036)
- P5-TS-03: MembersTable wired to `useOrgMembers()` real Supabase query
- P5-TS-05: `public_id` auto-generated on INSERT (migration 0037)
- P5-TS-06: BulkUploadWizard supports `credential_type` + `metadata` columns in CSV
- P5-TS-07: `credential_templates` migration (0040), CRUD hook, CredentialTemplatesManager, routed at `/settings/credential-templates`

## P6 Verification — 6/6 COMPLETE

- P6-TS-01: `get_public_anchor` RPC rebuilt (migration 0044). PublicVerification.tsx renders 5 sections.
- P6-TS-02: QRCodeSVG in AssetDetailView for SECURED anchors.
- P6-TS-03: `VerificationWidget.tsx` routed at `/embed/verify/:publicId`. 10 tests (PR #57).
- P6-TS-04: `AnchorLifecycleTimeline` wired into PublicVerification.tsx Section 5.
- P6-TS-05: `generateAuditReport.ts` (jsPDF, 201 lines).
- P6-TS-06: `verification_events` table (migration 0042), SECURITY DEFINER RPC (migration 0045).

## P7 Go-Live — 11/13 COMPLETE (2 NOT STARTED: P7-TS-04/06 no individual scope)

- P7-TS-01: Billing schema (migration 0016). BillingOverview.tsx wired.
- P7-TS-02: Full Stripe integration. 74 tests.
- P7-TS-03: Stripe webhook signature verification.
- P7-TS-05: BitcoinChainClient with provider abstractions. 604 worker tests. OPS-ONLY remaining.
- P7-TS-07: PDF + JSON proof package downloads.
- P7-TS-08: `generateAuditReport.ts` -- full PDF certificate.
- P7-TS-09: WebhookSettings.tsx. 34 tests.
- P7-TS-10: Delivery engine with exponential backoff + HMAC signing.
- P7-TS-11: Signet treasury wallet utilities. 13 tests.
- P7-TS-12: UTXO provider pattern. 35 tests.
- P7-TS-13: `SupabaseChainIndexLookup` for O(1) fingerprint verification.

## P4.5 Verification API — 13/13 COMPLETE

All 13 stories complete. Migration 0057 (api_keys) + 0058 (batch_verification_jobs).

- P4.5-TS-12: Feature gate middleware. 10 tests.
- P4.5-TS-03: API key auth middleware. 16 tests.
- P4.5-TS-01: `GET /api/v1/verify/:publicId`. 12 tests.
- P4.5-TS-07: Key CRUD endpoints. 13 tests.
- P4.5-TS-05: Usage tracking + free tier quota. 11 tests.
- P4.5-TS-02: `POST /api/v1/verify/batch`. 11 tests.
- P4.5-TS-06: `GET /api/v1/jobs/:jobId`. 4 tests.
- P4.5-TS-08: `GET /api/v1/usage`. 4 tests.
- P4.5-TS-04: OpenAPI 3.0 spec. 9 tests.
- P4.5-TS-09: API Key Management UI. 16 tests.
- P4.5-TS-10: `ApiUsageDashboard` widget. 6 tests.
- P4.5-TS-11: `ApiKeyScopeDisplay` component. 4 tests.
- P4.5-TS-13: Rate limit load tests. 12 tests.

## DH Deferred Hardening — 12/12 COMPLETE

DH-01 through DH-12 all complete. See `docs/stories/10_deferred_hardening.md`.

## P8 AI Intelligence — 19/19 COMPLETE

All 19 stories complete across Phase I (6), Phase 1.5 (5), Phase II (4), and 4 infrastructure stories.
See `docs/stories/12_p8_ai_intelligence.md` for full details.

## UAT Bug Fix Sprints — 17/17 COMPLETE

See `docs/stories/14_uat_sprints.md`.

## UF User Flow Gaps — 10/10 COMPLETE

10 stories completed across Sprints A, B, and C. See `docs/stories/14_user_flow_gaps.md`.

## MVP Launch Gaps — 22/27 COMPLETE (2 REMOVED, 3 NOT STARTED — see incomplete in CLAUDE.md)

22 of 25 active stories complete (MVP-19 and MVP-22 removed/superseded). MVP-12, MVP-13, MVP-30 not started (post-launch). See `docs/stories/11_mvp_launch_gaps.md`.

## Beta Readiness — 13/13 COMPLETE

All 13 stories completed across Beta Sprints 1-3 (PRs #98, #100, #101, merged 2026-03-18).
See `docs/stories/16_beta_readiness.md`.

## Critical Blockers (all resolved)

| ID | Resolution |
|----|------------|
| CRIT-1 | RESOLVED 2026-03-10. Real Supabase insert. Commit a38b485. |
| CRIT-2 | CODE COMPLETE. OPS-ONLY remaining (AWS KMS provisioning, mainnet funding). |
| CRIT-3 | RESOLVED 2026-03-14 (PR #43). Billing Portal. |
| CRIT-4 | RESOLVED 2026-03-10. Onboarding routes wired. Commit a38b485. |
| CRIT-5 | RESOLVED 2026-03-10. Proof download wired. Commit a38b485. |
| CRIT-6 | RESOLVED 2026-03-10. CSVUploadWizard wired. Commit a38b485. |
| CRIT-7 | RESOLVED 2026-03-10. Ralph -> Arkova branding. |

## Sprint Archive

See `docs/reference/SPRINT_ARCHIVE.md` or MEMORY.md completed sprints for full sprint history.

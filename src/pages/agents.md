# agents.md — pages
_Last updated: 2026-08-17_

## 2026-08-17 — RecordDetailPage honest rename (founder-reported)

`handleRenameFile` checked only `updateError`, but PostgREST returns HTTP 204 with `error: null` for an UPDATE whose RLS USING clause matches zero rows — so a non-owner rename fired `toast.success('Document renamed')` while the row was unchanged (silent false success), and an ORG_ADMIN renaming a teammate's record (blocked with 42501 by migration 0393's `restrict_org_admin_folder_update` trigger, which narrows the org-admin update policy to folder_id only) got a generic "Failed to rename document". Now: `.select('id')` + row-count check (mirrors `useFolders.assignRecord`), toast copy centralized in `RECORD_DETAIL_LABELS` (`TOAST_RENAMED` / `ERR_RENAME` / `ERR_RENAME_FORBIDDEN`, permission distinct from generic), `void refreshAnchor()` on success, and the page passes `canRename={user.id === anchor.user_id}` so `AssetDetailView` shows the rename pencil to the owner only (see `src/components/anchor/agents.md`). Deliberately NOT done: widening RLS so org admins can rename — that is a product decision not yet made; this PR only makes the existing permissions honest. Tests: `RecordDetailPage.honest-rename.test.tsx` (6 cases, TDD red-first — the red run reproduced the false success verbatim; renamed from `RecordDetailPage.test.tsx` during soak-prep rebase to avoid colliding with PR #2241's file of the same name — that PR lands first per the cluster's landing order).
## 2026-08-17 — DocumentsPage: "My Records" tab is a link-out, not a duplicate list

Founder-reported: `/documents` rendered a "My Records" TAB (its own folder-less copy of the records list) while the real records+folders surface (SCRUM-2940) is `ROUTES.RECORDS` (`MyRecordsPage`) — users landing on `/documents` concluded folders didn't exist. Chosen resolution: **link/redirect through**, not tab removal — the trigger stays visible (with its record-count badge) so the entry point survives, but clicking it navigates to `ROUTES.RECORDS`, and legacy `?tab=records` deep links redirect there with remaining query params preserved (`MyRecordsPage` consumes the same `?action=upload&credential_type&jurisdiction` contract, so those deep links keep working). The tab's `RecordsList` sub-component was a strict functional subset of MyRecordsPage (same list/search/status-filter/revoke; zero folder affordances; its "Download Proof" menu item was an inert no-op with no onClick) and is deleted along with the revoke plumbing only it used. Records still appear in the "All" tab. Tests: `DocumentsPage.test.tsx` (new, 5 cases, TDD red-first).
_Last updated: 2026-08-18_

## 2026-08-18 — `OrgProfilePage.tsx` — Pending Invitations visibility on the People tab

Wired `useOrgInvitations` (`src/hooks/agents.md`) + `PendingInvitationsList` (`src/components/organization/agents.md`) into the People tab, admin-only, below `MembersTable`. `handleInvite` and the new `handleResendInvitation` both call the existing `useInviteMember().inviteMember()` — resend is a fresh `invite_member` RPC + `/api/send-invitation-email` call (new row, new token, new 7-day clock), not a re-send of the old token, then `refreshInvitations()` invalidates the query. No new worker route, no migration. Context: founder-reported "I still cannot invite members" investigation found the accept-path backend correct (see the components/organization note); this closes the actual demonstrated gap — the admin had no way to see whether an invite was pending, expired, or ever sent.
## 2026-08-18 — `PrivacyPage.tsx` Section 3 rewritten (counsel-ordered, Tranche 0)

`PRIVACY_S3_BODY` ("Your files never leave your browser") was accurate for
browser uploads but false for connector-fetched documents (DocuSign / Google
Drive), which are fingerprinted server-side under the §1.6A carve-out, not in
the browser. Counsel's exact approved replacement — sent to Solomon Karanja
Meru, MNA Legal — is now in `copy.ts` (see that folder's `agents.md` for the
full addendum quote and Google Doc reference). No JSX change was needed;
`PrivacyPage.tsx` already renders `PRIVACY_S3_BODY` as a single `<p>`, so the
fix is entirely in the copy value.

New file `PrivacyPage.test.tsx` pins the wording verbatim (word-for-word
`.toBe()`, not a substring match) — the sibling
`PrivacyPage.copy-centralization.test.tsx` explicitly disclaims pinning
wording (that's this file's job now, plus legal counsel's), it only checks
every rendered string traces back to `copy.ts`. Both suites pass together:
the centralization test's residue check is agnostic to what the copy value
*says*, only that `PrivacyPage.tsx` doesn't say anything `copy.ts` doesn't
also say.

## 2026-08-10 — `ActivateAccountPage.tsx` rebuilt; the recovery-phrase ruling

The page could never activate anyone: it called an `activate_user(p_token, p_claim_key)` overload that does not exist in prod (PGRST202 — PostgREST binds overloads by argument NAME), and it never collected a password at all. Full root-cause writeup in `services/worker/src/api/agents.md`. Now: preview the link via `GET /api/activation/:token`, collect a password, `POST /api/activation/complete`. The password write needs service_role, which must never reach the browser (§1.4), so it is worker-side; the SQL function is retired in migration `0402`.

**Recovery-phrase ruling — abandoned scaffolding, removed from the activation path, NOT deleted.** Evidence it was never a live feature:

- Its storage was `activation_tokens.claim_key`, defined only in `docs/migrations-archive/0175_activate_user_function.sql` — archived, never deployed. There is no `activation_tokens` table and no `claim_key` column anywhere in the live schema, so the derived hash had nowhere to go.
- Nothing in the repo ever *verified* a claim key. There is no recovery flow, no "sign in with your phrase" path, no consumer of any kind — `deriveClaimKeyHash` had exactly two callers: this page and an orphaned second modal.
- `src/components/onboarding/RecoveryPhraseModal.tsx` is imported by nothing (the page used the `auth/` one), i.e. the feature was already half-abandoned.

So it protected nothing, and keeping it on the critical path was itself defect (A). Worse, the copy told recipients the 12 words were "your backup access key" — a claim no code path could honour, which is exactly what §1.5 / §1.13 R-7 forbid. That claim is gone rather than restated.

**Deliberately NOT done:** adding a `claim_key_hash` column to store it. That would resurrect a dead archived migration and ship schema with no reader — the pattern already flagged as a problem elsewhere in this codebase. `src/lib/recoveryPhrase.ts` and both modals are left in place, unmodified, so a future *real* recovery feature (with storage, verification, and its own product decision) can pick them up. **If the recovery phrase is in fact a live product requirement, this is the decision to revisit — it is a deliberate, documented removal, not an oversight.**

Note the local is named `activationToken`, not `token`: `npm run lint:copy` bans the bare word in shipped files and exempts only the `searchParams.get('token')` line itself. Same convention as `AcceptInvitePage`'s `inviteToken`.

## SCRUM-2940 — Folders UI (founder escalation, PR #1657 follow-up)

PR #1657 merged the folders DATA LAYER (`useFolders`, `folders` table,
`anchors.folder_id`) with **zero** UI — `useFolders` had no importers outside
its own file, so there was no way to create a folder or file a record into
one. `MyRecordsPage.tsx` is now the consumer: a `FolderSidebar`
(`@/components/folders`) filters the record list by `'ALL' | 'UNFILED' |
<folder id>`; create/rename/delete flow through `FolderFormDialog` /
`DeleteFolderDialog`; each record's action menu gained "Move to folder"
(`MoveToFolderDialog`) and, when already filed, a direct "Remove from folder"
item. Filtering reads `Record.folderId`, added to `useAnchors`'s select (see
`src/hooks/agents.md`). `DashboardPage.tsx`'s `RecordsList`-based view is
**not** wired to folders in this pass — only the dedicated My Records page is
in scope for SCRUM-2940 v1. Full component-level notes live in
`src/components/folders/agents.md`.

**2026-08-03 follow-up (founder escalation — "finish the folders"):** this page
was fully built but had no sidebar link — `Sidebar.tsx` never linked
`ROUTES.RECORDS`, so the only way in was typing `/records` into the URL bar.
Fixed in `src/components/layout/Sidebar.tsx` (see that folder's `agents.md`
for the fix shape); `MyRecordsPage.tsx` itself is unchanged by that fix.

## L2-A5 — AdminOrganizationsPage credit adjust (founder admin-controls, founder rule A2)

`AdminOrganizationsPage.tsx` adds a `Credits` column (mobile card + desktop table, next to the existing SCRUM-2225 free-tier cap control) showing `credit_balance` from the enriched `GET /api/admin/organizations` response, plus a per-org "Adjust credits" button opening a two-step dialog: **input step** (Add/Remove toggle, whole-number amount, mandatory reason `Textarea`, current balance shown) → **confirm step** (plain-language summary + old→new balance preview) → `POST /api/admin/organizations/:id/credits/adjust`. A fresh `crypto.randomUUID()` idempotency key is minted when the admin clicks Review (not on dialog open), so re-opening the dialog for a different adjustment never reuses a stale key, and repeated clicks on Confirm within one review screen are safe retries, not double-charges. Errors from the RPC (`insufficient_balance`, etc.) surface as a toast and leave the dialog open so the admin can correct the amount — success closes the dialog and refetches the list. All copy in `src/lib/copy.ts` `ADMIN_CREDIT_ADJUST_LABELS` (see `src/lib/agents.md`). Backend: `services/worker/src/api/admin-actions.ts` `handleAdjustOrgCredit` (see that folder's `agents.md`).

Test file `AdminOrganizationsPage.test.tsx` covers 7 cases: balance render, full review→confirm→API-payload-shape flow for both Add and Remove (asserts the exact signed `amount` + idempotency-key UUID shape sent), the Review button being inert until both amount and reason are filled, the insufficient-balance error path leaving the dialog open, the no-match-search empty state with a working Clear filters action, and the Access Restricted guard for non-platform-admin profiles (no list fetch fires). `src/test/setup.ts`'s global `crypto` mock gained a `randomUUID()` implementation (jsdom doesn't provide one) — needed by this flow and available to any future client-side idempotency-key code.

Structure (SonarCloud S3776 follow-up, 2026-08-01): the page is decomposed into two same-file, non-exported presentational components — `OrganizationsListBody` (loading skeletons / empty state / mobile cards + desktop table) and `CreditsAdjustDialog` (the two-step input→confirm dialog) — plus module-level pure helpers. All state, handlers, and the submit flow stay in `AdminOrganizationsPage`; the extracted components take `Readonly<>` props only. Row click-through navigates via `orgProfilePath()` from `src/lib/routes.ts`, not a hardcoded URL.

## PR #1561 — WebMCP search URL consumption

`SearchPage.tsx` consumes a bounded `q` query parameter from same-origin
`/search?q=...` navigation, pre-fills the search input, and executes the existing
read-only public search path once. Keep the URL bound aligned with
`src/webmcp.ts` (`200` decoded characters before trimming). The consumed-query
ref is required because the app mounts under React Strict Mode; without it the
URL-triggered RPCs run twice in development. Blank or overlong URL values are
ignored, and the input itself carries the same maximum length.

## SCRUM-1980 — Search spinner persists below results (loading-state reset)

`SearchPage.tsx` runs the issuer (`usePublicSearch`) and credential (`search_public_credentials` RPC) legs together via `Promise.all`; they resolve at different times. The bottom "searching" spinner (`showSearchLoading`) is a "nothing to show yet" indicator and must clear the moment we have anything to render. The pre-fix guard (`!hasDisplayableResults`, added in `6af45e5c`) covered only the results sub-case and left the spinner lingering **below the error card** when the faster leg errored while the slower leg was still in flight (UAT 2026-05-22). Fix: also gate on `!displayError`. The spinner container now carries `role="status"` + `aria-live="polite"` + `aria-label={SEARCH_LABELS.LOADING}` + `data-testid="search-loading-spinner"` so the reset is assertable (matches the `AuditMyOrganizationButton` house style). Do NOT touch the semantic-search lane (`useSemanticSearch.ts` / `SemanticSearch.tsx`) — different surface, owned by PR #964.

**Review fix B2 (cross-mode stale error):** `displayError = error || fpError || personError`, and BOTH the spinner gate (`showSearchLoading … && !displayError`) and the issuer-results block are gated on `!displayError`. Each search path only cleared *its own* error channel (issuer/person path didn't clear `fpError`; the fingerprint path didn't clear the hook's `error` or `personError`), so a leftover error from a *different* mode (a) suppressed the in-flight spinner of the new search and (b) hid successful results behind the stale error card. Fix: `resetSearchState()` (calls the hook's `clearResults()` for `error`+`issuerResults`, plus clears `fpError`/`fpResult`/`personError`/`personResults`) runs at the start of every submit — `handleSearch` and the drag-to-verify `handleFileDrop` — so `displayError` only ever reflects the search currently in flight. When adding a new search mode here, clear its channel in `resetSearchState` too.

## SCRUM-1755 — Secure Document vs Issue Credential split

`DashboardPage.tsx` + `OrgProfilePage.tsx` — split "Secure Document" (universal) from "Issue Credential" (verified-org admin only). Dashboard empty-state CTA always opens `SecureDocumentDialog` (pre-1755 it opened `IssueCredentialForm` for ORG_ADMIN under a "Secure Document" label — the bug). Issue Credential header button is gated on `useCanIssueCredential()` AND `ENABLE_ISSUE_CREDENTIAL_SPLIT`. `OrgProfilePage` swaps the dual Bulk Upload + Issue Credential buttons for a single primary "Secure Document" button (auto-detects bulk inside the dialog) plus a gated outline "Issue Credential" button. The legacy bulk-only dialog wrapper was removed; `SecureDocumentDialog` handles every input shape.

## SCRUM-3010 STEP 1 — Org registry cross-member privacy gate (frontend)

_Restored 2026-07-28 — lost off `main` by the union-merge-driver incident (see `docs/incidents/2026-07-28-agents-md-union-drop-remediation.md`)._

`OrgProfilePage.tsx` — the Home-tab org records table (`OrgRegistryTable`) previously rendered UNCONDITIONALLY, so any org member (not just owner/admin/platform admin) could VIEW and CSV-EXPORT the entire org's records (every coworker's filenames, fingerprints, credential_type, label, metadata) — a live cross-member privacy leak (§1.6 flavor). Fix (STEP 1, frontend-only, T1): pass `isAdmin={isAdmin}` and `currentUserId={user?.id}` into `OrgRegistryTable`. Admins keep the org-wide registry; a non-admin member is scoped to their OWN rows only (by `user_id`, mirroring `useAnchors`), and the CSV export is gated the same way. Non-admin members still see their personal records on `/dashboard` (already correct). The org-wide `recordsCount` stat is an aggregate integer (no per-record metadata) and is intentionally left visible. STEP 2 (RLS tightening so this is enforced server-side, not just in the browser query) is a separate T3 story, deferred post-soak.

## 2026-07-21 SCRUM-2938 S2 — terminology scrub remainder

_Restored 2026-07-28 — lost off `main` by the union-merge-driver incident (see `docs/incidents/2026-07-28-agents-md-union-drop-remediation.md`)._

Page-level scrub: SearchPage title/placeholder, Documents TypeBadge ("Issued"), Attestations type descs, HowItWorks JSON-LD HowTo name, Developers/About/Terms/Contact/NotFound/Privacy stats + footer links ("Search Records", "Records Secured", "Document Types"), VerifyMyRecordPage "Document Type", Developers pricing row "AI assistant query" (Nessie codename removed from user copy; endpoint path kept). Internal identifiers (keys, enum values, `credential_type`, API params) are unchanged per §1.3 "internal code may use technical names". Contract test: `src/lib/copy-scrum-2938-terminology-s2.test.ts` (walks every copy.ts string value; SCRUM-1672 `ISSUE_CREDENTIAL_LABELS` carve-out locked byte-identical).

## What This Folder Contains

Top-level page components rendered by react-router-dom routes. Each page composes layout (AppShell) with domain-specific hooks and components.

## Recent Changes
- 2026-07-28 QUEUE-01 / SCRUM-2894 (L2-A1, founder P0): created `SecureQueuePage.tsx` at `ROUTES.SECURE_QUEUE` (`/queue`) — the `consumer_secure_queue` surface from `queueContract.ts`'s `QUEUE_SURFACES` (distinct from `AnchorQueuePage` = `org_duplicate_review` and `ReviewQueuePage` = `org_approvals`; never reuse the "Review queue" title). Lists the signed-in user's own PENDING documents with per-item Remove (soft-delete via `useSecureQueue`). ORG_ADMIN additionally sees an "Organization Queue" tab listing every org member's PENDING items (read via the existing `anchors_select_org` RLS policy — not role-gated at the RLS layer, so this UI-side `profile.role === 'ORG_ADMIN'` gate mirrors the existing `useAnchors.ts` convention, not a new RLS decision); Remove is disabled for non-own org rows because there is no admin UPDATE/DELETE policy on `anchors` yet (SCRUM-3010 territory, not touched here). Reachable from the Sidebar Account section (rule A2). Buy-credits redirect (from `SecureDocumentDialog`'s "Secure Instantly" path) lands on the existing `ROUTES.BILLING` page — no new checkout invented.
- 2026-07-28 SCRUM-3012: created `AcceptInvitePage.tsx` (route `/accept-invite?token=...`, registered in `App.tsx` + `ROUTES.ACCEPT_INVITE`) — the previously-nonexistent consumer of the org-invite email link. Loads a public preview (org name/role/validity) via `useAcceptInvite`, then either shows a direct "Join" action (signed-in caller's email matches the invitation — no password needed) or a create-account form (email pre-filled/disabled from the preview, password 8+ chars, optional full name) for a new visitor. Success branches on `verificationRequired`: a brand-new account shows the existing `EmailConfirmation` component (prod still requires email confirmation post-invite — the invite token proved mailbox control once, login keeps its own gate); an existing-account join goes straight to "you're in" + a dashboard link. `account_exists` surfaces a sign-in link instead of retrying account creation. All copy in `copy.ts` `ACCEPT_INVITE_LABELS` (append-only block).
- 2026-07-17 SCRUM-2910 (BUG-2026-07-17-010, P0): `PipelineAdminPage.tsx` record-detail metadata panel filter also hides any `fraud*` key via `isFraudMetadataKey` from `@/lib/fraudDetection` (cross-review nit on PR #1569 — the ad-hoc denylist lacked fraud coverage).
- 2026-07-22 SCRUM-2914 (Founder UI findings): `DashboardPage.tsx` no longer renders `AuditMyOrganizationButton` or the ORG_ADMIN-gated `ComplianceScoreCard` (widget grid dropped its 3-col ORG_ADMIN variant, now always 2-col Usage + Credit). `ComplianceScoreCard.tsx` deleted (dashboard was its only importer); `AuditMyOrganizationButton.tsx` kept, still used by `ComplianceScorecardPage.tsx`.
- 2026-06-29 PROOF-04 (SCRUM-2337, Lane 1 S2): `RecordDetailPage.tsx` — the `onDownloadProof` (PDF certificate) handler now fetches the `anchor_proofs` row for SECURED records (RLS-scoped) and passes the full `ProofInput` (merkle root/proof_path/index, block hash/header/height, op_return payload, schema version, observed time) into `generateAuditReport` so the certificate embeds the machine-readable proof packet (PROOF-04). Non-SECURED records still get the legacy certificate with no packet; fetch failures surface a generic `toast.error` (no raw error leak). No change to `onDownloadProofJson`. Download affordance remains gated on `status === 'SECURED'` in `AssetDetailView` (equivalent to the new `isProofDownloadable`).
- 2026-06-29 PROOF-04 rework (Carson P1 review on #1352): `RecordDetailPage.onDownloadProof` now **validates + preserves** the `anchor_proofs.proof_path` entries as `{ hash, position }` (module-level `isMerkleEntry` guard) instead of filtering to strings — the old `string[]` narrowing yielded `[]` for real object rows, embedding an empty/invalid `merkle_proof` so the offline verifier couldn't recompute the root. The `ProofInput` it passes now carries `block_timestamp` (renamed from `observed_time`). Matches the canonical `proof_bundle` shape in `src/lib/generateAuditReport.ts` (PROOF-05 / PROOF-07 parity).
- 2026-06-25 iter-5 webhook-toggle (BUG class): `WebhookSettingsPage.tsx` — `handleToggle` fired the `webhook_endpoints` `is_active` update fire-and-forget (never read `error`) then unconditionally `fetchEndpoints()`. On an RLS/permission denial the DB row was unchanged, the refetch snapped the row back, and **nothing was surfaced** — the user believed the enable/disable took. Now optimistically flips the row in local state (responsive), checks the update `error`, and on failure shows `toast.error(WEBHOOK_LABELS.TOGGLE_ERROR)` (sonner) — generic copy only, the raw RLS/Postgres message is never leaked — then refetches to visibly revert to the true value. Success refetches to confirm. `WebhookSettingsPage.test.tsx` gained 3 toggle cases (denied → error toast + visible revert + no message leak; success → state persists, no error; optimistic flip before the server responds). Toast asserted via `vi.mock('sonner')`.
- 2026-06-24 BUG-C (BUG-2026-06-24-009 class): `CheckoutSuccessPage.tsx` — the post-payment "Your Plan" card rendered `{plan.records_per_month} records per month` behind a naive `> 0` guard, so an unlimited-plan buyer (organization plan, sentinel `999999`, seed.sql:220) saw "999999 records per month" on the checkout-success screen. Now routes through `isUnlimitedRecordsLimit()` (from `@/hooks/useEntitlements`, the same normalization `PricingPage`/`useEntitlements` use): unlimited → `BILLING_LABELS.RECORDS_UNLIMITED` ("Unlimited records"); finite `> 0` (incl. the 999998 boundary) → the existing count line; `0` → nothing. `CheckoutSuccessPage.test.tsx` gained a 999999 (unlimited, sentinel must not leak) case and a 999998 finite-boundary case.
- 2026-06-24 BUG-2026-06-24-009 / -010: `PricingPage.tsx` — the Pricing-page `BillingOverview` built `usage` with a hardcoded `recordsUsed: 0` (`// Would come from profile.anchor_count_this_month`), so a user over quota saw "0 records used" + an empty meter + no upgrade warning on this secondary surface (the dedicated `BillingPage` was already correct). Now sources `recordsUsed` / `recordsLimit` / `percentUsed` from `useEntitlements()` (already app-wide). The unlimited "organization" plan (`records_per_month = 999999`) maps to `recordsIncluded: 'unlimited'` via `isUnlimitedRecordsLimit()`, and the meter uses the hook's already-normalized (null = unlimited) `recordsLimit`, so no frozen "/ 999999" meter renders (-010). `PricingPage` is currently an unrouted/standalone component (not in `App.tsx`/`routes.ts`); its display states are covered deterministically in `PricingPage.test.tsx` (over-quota "8 / 10" present, "0 / 10" absent, reached-limit copy, no "/ 999999"). Note: `PricingPage.test.tsx` mocks `@/hooks/useEntitlements` via a `vi.importActual` spread so the real pure `isUnlimitedRecordsLimit` helper stays callable while only the hook is stubbed.
- 2026-06-01 Platform-admin org roster fix: `OrgProfilePage.tsx` — a platform admin viewing an org they don't belong to saw "0 members" / "No user found" because the browser's RLS-scoped queries (`useOrgMembers`, the profiles email search in `AddExistingMemberModal`) have no platform-admin bypass. Added `isForeignOrgAdmin = isPlatformAdmin(email) && !roleLoading && !userRole`; when true the page sources the roster from `useAdminOrgMembers` (service_role worker endpoint) and passes `useAdminEndpoints` to `AddExistingMemberModal` so search/add use the gated admin endpoints. **Real org members (any `userRole`) keep the existing client-side path untouched.** The worker re-verifies platform-admin via the `is_platform_admin` DB flag, so the client-side email check is only an endpoint-routing decision, not the authority.
- 2026-05-30 SCRUM-2003 (review fixes): wired the remaining raw-enum status leak sites through `getStatusLabel` from `@/lib/statusDisplay` — `PublicPortfolioPage.tsx` (`att.status` + `anc.status`, both **public/unauth**), `PublicAttestationVerifyPage.tsx` attestor-credential `credential.status`, and `AttestationsPage.tsx` table `att.status`. Existing `STATUS_BADGE`/`STATUS_ICON`/`STATUS_COLORS` maps and icon conditionals stay keyed by the **raw** enum; only the visible Badge *text* is wrapped. NOT wired: `PublicAttestationVerifyPage.tsx` `linked_credential.verification_status` — that is org-identity verification status (`VERIFIED`/`UNVERIFIED`), a different enum domain than `anchor_status`/`attestation_status`, so it is intentionally left raw (forcing it through the anchor/attestation map would mislabel it).
- 2026-05-30 SCRUM-2006: `PipelineAdminPage.tsx` records browser gained a **go-to-page** jump (numeric `Input` + Go button, Enter-to-submit) and a **page-size selector** (`PAGE_SIZE_OPTIONS = [25, 50, 100]`) beside the existing prev/next. `PAGE_SIZE` const became `pageSize` state; `fetchRecords(page, filters, size)` takes the size; the fetch effect deps include `pageSize`. Go-to-page validates with `^\d+$` (rejects empty/`abc`/`1.5`/`-2`) then clamps into `[1, totalPages]`; page-size change is allowlist-guarded and resets to page 1. New strings are local `PAGINATION_LABELS` constants (copy.ts is owned by other in-flight PRs; `lint:copy` still scans `src/pages/**`). **Testing gotcha:** Radix `Select` can't be driven in jsdom (pointer-capture/portals), so `PipelineAdminPage.test.tsx` mocks `@/components/ui/select` as a native `<select>`. The mock renders each option's **value** as visible text (not the human label) on purpose — rendering labels leaked filter strings like "Secured / Confirmed" into the DOM and tripped the record-row status assertions. Drive selects via `fireEvent.change`, assert RPC args via the `lastRecordsPageCall()` helper.
- 2026-05-30 SCRUM-2008: `BillingPage.tsx` now Zod-validates the `/api/billing/status` 200 body (`billingStatusSchema`, mirrors the `BillingInfo` contract) before treating it as real data. A malformed/empty/error-envelope 200 throws into the existing catch → explicit "Unable to load billing data" card + Retry, never a silent placeholder/"Beta"/empty plan display. Builds on SCRUM-1983's AbortController timeout + error/retry (don't undo it). Pattern: any page that renders trust-bearing data from a fetch should validate the success body against a shape contract, not blind-cast `as T` — a 200 is not proof the payload is confirmed.
- 2026-05-16 SCRUM-1126: `VersionConflictsPage.tsx` — org-admin version conflict review UI. Groups pending versions by `external_file_id`, displays fingerprint previews + age, approve action creates PENDING anchor via worker API. Uses `useVersionResolution` hook + `OrgRequiredGate`. Responsive at 1280px + 375px.
- 2026-05-29 SCRUM-1958 (subtask-4): `DashboardPage.tsx` now mounts `SemanticSearchPanel` (from `@/components/search`) above the My Records card, shown only when the user has records. The panel self-gates on `ENABLE_SEMANTIC_SEARCH` (renders nothing when off), so no extra page-level flag check is needed. AI "smart search" over the user's secured documents; results, empty, and error copy all live in `SEMANTIC_SEARCH_LABELS` (`src/lib/copy.ts`). E2E coverage in `e2e/semantic-search.spec.ts`.
- 2026-05-19 SCRUM-1599: removed `BadgePage.tsx` from the SPA route table. Badge SVGs are served by the worker at `/api/badge/:publicId` so status cannot be spoofed from frontend query parameters.
- 2026-05-19 SCRUM-1247 closeout: `PrivacyPage.tsx` and `TermsPage.tsx` render their policy-update notices from `LEGAL_PAGE_LABELS` in `src/lib/copy.ts`; keep legal/public page copy centralized and covered by `e2e/legal-pages.spec.ts`.
- 2026-05-03 SCRUM-897: `PublicAttestationVerifyPage.tsx` fetches `/api/v1/attestations/{publicId}?include=credentials` so public attestation verification can show evidence metadata and the bounded attestor credential chain. Evidence cards must use `public_id`, `fingerprint`, `mime`, and `size`; never render internal evidence UUIDs.
- 2026-04-24 SCRUM-1102: `RulesPage.tsx` adds org-admin "Run now" and execution history actions for each rule. New user-visible strings live in `RULES_PAGE_COPY` (`src/lib/copy.ts`). Pattern: rule actions that enqueue work should show a queued toast with a history action rather than blocking for worker completion.
- 2026-04-24 CONNECTORS-V2 ([SCRUM-1100](https://arkova.atlassian.net/browse/SCRUM-1100)): `RuleBuilderPage.tsx` — workspace file rules can now collect multiple Google Drive folder bindings into `trigger_config.drive_folders[]`. UI strings remain centralized in `src/lib/copy.ts`; frontend validation lives in `src/lib/ruleSchemas.ts` and the worker schema/evaluator remain authoritative.
- 2026-04-23 CIBA-HARDEN-04 ([SCRUM-1117](https://arkova.atlassian.net/browse/SCRUM-1117)): `RuleBuilderPage.tsx` — extracted every user-visible string into `src/lib/copy.ts` (`RULE_TRIGGER_COPY`, `RULE_ACTION_COPY`, `RULE_WIZARD_LABELS`); added HMAC-handle field for the `FORWARD_TO_URL` action (worker schema requires `hmac_secret_handle: sm:...`); wired `nextStep()` + `handleSave()` to the new `src/lib/ruleSchemas.ts` frontend shadow so invalid cron / missing HMAC handle / empty NOTIFY channels fail client-side instead of POST-then-400. Pattern: any wizard POSTing to a Zod-validated worker endpoint should shadow the schema in `src/lib/` and pre-validate before advance.
- 2026-04-21 Top-10 UAT sprint: `ComplianceScorecardPage.tsx` + `ApiKeySettingsPage.tsx` — both pages are org-scoped at the worker API layer but were rendering raw HTTP-403 / engineering-copy errors for individual-tier users (no `org_id`). Now detect `!profile.org_id` and short-circuit to the new shared `<OrgRequiredCard>` component (`src/components/shared/OrgRequiredCard.tsx`). For the API Keys page, the `useApiKeys` + `useApiUsage` hooks also now honor an `{ enabled }` option so individuals never fire the 403-bound worker calls at all. Pattern: any org-scoped page should mirror this.
- 2026-03-11 SonarQube sprint: `MyRecordsPage.tsx`, `OrganizationPage.tsx`, `SettingsPage.tsx` — S3358 (nested ternary → if/else), S6582 (optional chaining). No behavioral changes.
- 2026-03-07 Code-review fixes: `DashboardPage.tsx` — surfaced `revokeError` from `useRevokeAnchor` with dismissible Alert; used `recordDetailPath()` instead of hardcoded path; corrected docstring.
- 2026-03-07 P3-TS-01: `DashboardPage.tsx` — replaced `useState<Record[]>([])` mock with `useAnchors()` hook for real Supabase data. Wired `handleRevokeRecord` to `useRevokeAnchor`. Removed `Math.random()` fingerprints and `console.log` stubs.
- 2026-03-07 P4-TS-03: Created `RecordDetailPage.tsx` — extracts `:id` from URL params, uses `useAnchor` hook, renders `AssetDetailView` with real Supabase data. Wired into App.tsx route.

## Do / Don't Rules
- DO: Use hooks from `@/hooks/` for all data fetching — never `useState` for DB-backed data
- DO: Pass `loading` state from hooks to child components (RecordsList, StatCard)
- DON'T: Create mock records with `Math.random()` or `Date.now()` IDs
- DON'T: Use `console.log` as a placeholder for actions — use no-op functions or wire to real hooks

## MVP Launch Gap Context
- **MVP-03 (Legal Pages):** New `PrivacyPage.tsx`, `TermsPage.tsx`, `ContactPage.tsx` — public routes, no auth required. Add to `routes.ts` and `App.tsx`.
- **MVP-05 (Error Boundary + 404):** New `NotFoundPage.tsx` at catch-all `*` route. ErrorBoundary wraps App in `App.tsx`.
- **MVP-08 (Onboarding Stepper):** Visual progress indicator integrated into existing onboarding pages.
- **MVP-11 (Stripe Plan Change):** Settings page needs plan management UI (upgrade/downgrade/cancel).

## Dependencies
- `@/hooks/useAnchors` — anchor data for dashboard and vault
- `@/hooks/useAnchor` — single anchor data for record detail page
- `@/hooks/useAuth`, `@/hooks/useProfile` — auth and profile state
- `@/components/layout/AppShell` — page shell with sidebar
- `@/lib/routes` — named route constants

## SEO surface for /issuer/:orgId (SCRUM-1090, 2026-04-24)

The public org page renders two side-effect components for AI search engines and social unfurls:
- `<OrganizationSchema>` from `src/components/seo/OrganizationSchema.tsx` — schema.org Organization JSON-LD
- `<OrgPageMeta>` from `src/components/seo/OrgPageMeta.tsx` — Open Graph + Twitter Card meta tags

Both take `pageUrl` as a prop. Use `getAppBaseUrl()` from `@/lib/routes` to build it; do not hand-roll `window.location.origin` checks (kept SSR-safe + preview-deploy-safe).

## Anchor queue API surface (SCRUM-1121, 2026-04-24)

`src/pages/AnchorQueuePage.tsx` posts `selected_public_id` (not the internal anchors.id) to `/api/queue/resolve`. The pending list is keyed by `public_id` end-to-end. Never re-introduce `anchors.id` here — see CLAUDE.md §6 ("Exposing user_id / org_id / anchors.id publicly").
- 2026-06-29 PROOF-04 second-pass (Carson P1 #1352): `RecordDetailPage.onDownloadProof` no longer hand-rolls the `anchor_proofs` fetch — it calls `sourceProofInput(supabase, anchor)` from `@/lib/sourceProofInput`, which sources `leaf_count` (RLS-scoped batch-row count, the field that arms the CVE-2012-2459 guard; the old inline path left it `null`). When the returned `complete` is false (a batch member whose leaf_count couldn't be sourced), the handler warns via `toast.warning` and passes `proofComplete:false` so the certificate does not present an incomplete packet as a complete offline proof. The inline `isMerkleEntry` guard moved into `sourceProofInput.ts`.

- 2026-07-06 CPE-02 (SCRUM-2380, Lane 3 S3): `ComplianceDashboardPage.tsx` mounts `OrgCpeMemberDashboard` (per-member secured/pending CPE tiles, live `useOrgCpeMemberSummary` hook, no migration) below the export panel. The page test stubs the hook (React-Query backed; the card has its own suites).
## 2026-07-22 Platform-admin role-source cutover (SCRUM-2939 / PI05-ADMIN)

_Restored 2026-07-28 — same union-merge-driver incident as the SCRUM-3010 section above._

Every admin page now derives platform-admin status from `isPlatformAdmin(profile)` (`profiles.is_platform_admin` DB flag) instead of the removed `isPlatformAdmin(user?.email)` whitelist. `ComplianceDashboardPage` stays org-accessible (`role === 'ORG_ADMIN' || isPlatformAdmin(profile)`) — it is NOT a platform-only surface and is deliberately NOT wrapped by `PlatformAdminRoute`. Page tests grant admin by setting `is_platform_admin: true` on the mocked profile and deny by overriding `useProfile` (NOT `user.email`).

## UX-03 copy compliance (2026-07-06)

`PipelineAdminPage.tsx` job-trigger footer reworded "worker service" → "background service" (UX-03 / SCRUM-1029 banned engineering copy). Decision on the (a) reword vs (b) treasury-style scan-exclusion choice: **reword.** The `EXCLUDE_PATTERNS` ops-dashboard exclusion (precedent: `src/components/admin/treasury/**`) was considered and rejected — the rest of this ~1,700-line admin page's copy is compliant and should stay under lint:copy scan; do NOT add this page to `EXCLUDE_PATTERNS`. Surfaced by the SCRUM-2666 cross-line lint:copy fix (PR #1440); this reword also clears that PR's grandfathered baseline entry for `PipelineAdminPage.tsx:1196` (it goes stale once #1440 lands — its owner removes it).

## 2026-07-28 L3-A6 — MyCredentialsPage "From Public Registry" entry point

`MyCredentialsPage.tsx` gains a second header button (`data-testid="add-from-registry-button"`) next to the existing "Add Source" button, opening `CtdlRegistryImportDialog` (`src/components/credentials/`). Two-step flow: look up a public Credential Registry record by CTID (`GET /api/v1/credentials/ctdl/import`), then add it (`POST /api/v1/credentials/ctdl/registry-anchor`, new route). Part of the L3-A6 CE Noncredit Data Taxonomy 3.0 anchoring POC — see `docs/partners/ce-noncredit-anchoring-poc.md` for the research + honest-limits writeup and `services/worker/src/ctdl/agents.md` for the parser fix this UI exercises.

## 2026-08-02 AuditorBatchPage surfaces the server `message`, not the `error` code (PR #1865)

`setError(err.error || …)` rendered the API's machine token verbatim, so the
audit-sampling endpoint's new 422 refusals would have shown the auditor
`population_too_large` and nothing else. It now reads `err.message` first — the
server sends the sentence explaining what to do instead (which percentage fits,
or to switch to record IDs), and the numbers in it are org-specific, so a static
`copy.ts` string could not carry them. `err.error` and `HTTP <status>` remain as
fallbacks, so responses without a `message` are unaffected.

Note the vocabulary contract this creates: strings from
`services/worker/src/api/v1/auditBatchVerify.ts` now reach the UI verbatim and
are NOT scanned by `lint:copy` (which covers only `src/components`, `src/pages`,
`src/lib`, `src/hooks`, `packages/embed/src`). They deliberately say "records",
matching `AUDITOR_BATCH_LABELS`, not "credentials". Keep any new server-authored
message on this path §1.3-clean by hand.
## 2026-08-01 SCRUM-2907 — AuthCallbackPage is the email-confirmation landing route

`AuthCallbackPage.tsx` is no longer OAuth-only: `useAuth.signUp` now sets
`emailRedirectTo: ${origin}/auth/callback`, so the emailed signup-confirmation
link lands here too. Two rules for anyone editing it:

- **A dead link never produces a session.** Supabase reports expired / already-used
  / tampered links by putting `error` + `error_code` in the URL fragment and
  creating no session. Before this change the page's only signal was "no session",
  so an expired link was indistinguishable from "not signed in yet" and the user
  was bounced to a bare `/login` with no explanation.
- **Do NOT read that error in the component.** `detectSessionInUrl: true` consumes
  the fragment inside `createClient`, so by the time this component mounts it is
  already empty — a component-level read silently loses the error. This was caught
  in local UAT, not by unit tests (which mock the client and therefore never
  reproduce the race). The error is captured by `authLinkErrorFromUrl` in
  `src/lib/supabase.ts`, evaluated at module scope BEFORE `createClient` runs;
  the component reads that constant and only falls back to the live fragment.

Prod REQUIRES email confirmation — verified live against `vzwyaatejekddvltxyye`
on 2026-08-01 (signup returns HTTP 200 with `confirmation_sent_at` set and NO
session). `supabase/config.toml` and the signup E2E spec previously encoded the
opposite; both are corrected.

## 2026-08-10 — PricingPage was built, tested, and unreachable (launch blocker)

`PricingPage.tsx` is the ONLY surface that can take money: it calls
`startCheckout` → worker `POST /api/checkout/session` → Stripe. It had **no
`ROUTES` key, no `<Route>` in `App.tsx`, and zero importers** — `/pricing`
appeared nowhere in `src/` or `e2e/`. The note in the 2026-06-24 entry below
("currently an unrouted/standalone component") recorded this as a fact without
treating it as the revenue outage it was. Meanwhile `BillingPage.tsx`'s
`handleUpgrade` was `navigate(ROUTES.BILLING)` — the page the user was already
on — and `handleManageBilling` was the same no-op carrying a
`// Opens Stripe customer portal when available` comment. A customer who hit
their plan limit could not give us money.

Fixed: `ROUTES.PRICING = '/pricing'`, routed in `App.tsx` behind
`AuthGuard` + `RouteGuard allow={MAIN_APP_DESTINATIONS}` — the same guard as
`ROUTES.BILLING`. **Auth is required deliberately**: `useBilling` gates on
`user`, `startCheckout` returns null without one, `workerFetch` throws without a
session, and the worker 401s. A public `/pricing` would render an empty
`AppShell` with a Select Plan button that silently no-ops — a second dead end.
Public plan marketing belongs on the marketing site.

`BillingPage` now navigates to `ROUTES.PRICING` and calls
`useBilling().openBillingPortal()`, redirecting to the returned Stripe URL.
`CheckoutCancelPage`'s "Back to Plans" pointed at `/billing`; it now returns to
`/pricing` so an abandoned purchase can actually be retried.

**Silent-failure rule (same bug class):** `startCheckout` / `openBillingPortal`
swallow every failure and resolve `null` — including the worker's 400 when a
plan has no `stripe_price_id` configured for the environment. Any call site MUST
surface an error on the null branch (`BILLING_LABELS.CHECKOUT_UNAVAILABLE` /
`PORTAL_UNAVAILABLE`); a silent return is indistinguishable from the dead
buttons this release removed.

Two unit tests had pinned the broken behaviour as correct and were rewritten:
`e2e/billing.spec.ts` asserted `toHaveURL(/\/billing$/)` after clicking Upgrade,
and `CheckoutCancelPage.test.tsx` asserted the back link's href was `/billing`.
`PricingPage.test.tsx` passed throughout because it renders the component
directly — it cannot see reachability, and now says so in a comment.
Reachability is guarded structurally by `src/tests/pages/route-reachability.test.ts`.
## 2026-08-10 — ComplianceDashboardPage no longer mounts the Nessie panel

`ComplianceDashboardPage.tsx` rendered `<NessieIntelligencePanel />`
unconditionally. `/organization/compliance` is guarded by `AuthGuard` +
`RouteGuard` only (NOT `PlatformAdminRoute`, `App.tsx`), so any authenticated
customer reached it by URL and saw a query box for a backend that is switched
off, plus a confidence readout SCRUM-2914 had ordered removed. Import + render
are gone and the component is deleted.

Two things to carry forward when editing this page:

- **A page test that stubs a child cannot see the child.** This suite carried
  `vi.mock('@/components/search/NessieIntelligencePanel', ...)`, so it stayed
  green whether or not the page mounted the panel — the stub is why nobody
  noticed. Stub a child to cut a dependency (a QueryClientProvider, a network
  hook), never to silence a surface you have not decided is supposed to be there.
- **"The backend flag is off" is not a reachability argument.** Reachability is
  the JSX mount plus the route's guards. `src/lib/nessie-surfaces-offline.test.ts`
  now enforces the mount half.

## 2026-08-10 — PrivacyPage body copy moved to copy.ts (§1.3)

Every user-visible string inside `PrivacyPage`'s `<main>` — page title/meta,
heading, effective date, all seven section bodies, the mailto addresses —
now comes from `LEGAL_PAGE_LABELS.PRIVACY_*` / `PRIVACY_CONTACT_EMAIL` /
`SUPPORT_CONTACT_EMAIL` in `src/lib/copy.ts`. Rendered text is byte-identical
to the inline version it replaces (verified by render-dump diff).

Why: `src/lib/copy-internal-scaffolding.test.ts` (the guard that catches
internal drafting notes before they ship) only scans `copy.ts` — inline JSX
prose on a public legal page is exactly the surface it cannot see, and exactly
where the /privacy counsel-note leak lived. `PrivacyPage.copy-centralization.test.tsx`
enforces the coverage: it strips every copy.ts value from the rendered `<main>`
text and fails on any word left over, so new inline prose cannot land silently.
The page's header/footer nav chrome is shared navigation and out of that test's
scope (it scans `<main>` only).

When editing this page: add strings to `LEGAL_PAGE_LABELS` first, then render
the key. The S5 transfer-basis paragraph must keep naming NO EU→US transfer
mechanism (SCRUM-2283, §1.13 R-7) — the rule is restated at the key itself.

Deferred scope, on the record: `TermsPage` / `AboutPage` / `ContactPage` /
`DevelopersPage` (all public routes in `App.tsx`) carry the same §1.3 +
scaffolding-guard-reach exposure — their prose is inline JSX the guard cannot
see. `TermsPage` is structurally identical to pre-migration `PrivacyPage` and
is the cheapest next target; migrating it is also the moment to extract
`renderPrivacyMain` / `residueAfterRemovingCopy` from the copy-centralization
test into a shared helper (rule of three not yet met — this is the first).

## 2026-08-11 — WebhookSettingsPage tests: never gate on the endpoint URL text

`WebhookSettingsPage` composes two components that render the SAME string:
`WebhookSettings` prints `endpoint.url` in the endpoint row (only after the
async `webhook_endpoints` fetch resolves), and `WebhookDeliveryLog` prints
`delivery.endpoint_url` in the history table — synchronously, straight from the
mocked hook, on the very first commit.

So `await waitFor(() => expect(screen.getByText('https://example.com/webhooks'))
.toBeInTheDocument())` is **not** a gate on "endpoints have loaded". It resolves
against the delivery-log cell immediately, and once the fetch does land it
matches *both* nodes and starts throwing "found multiple elements". Any
synchronous `getBy*` placed after it races the fetch. That is exactly how
`wires the test-ping action to sendWebhookTestPing (WH-02)` failed in CI
(PR #2140; PR #2143 run 93815479911) with `Unable to find an accessible element
with the role "button" and name /Send test event/` — while passing 12/12 locally
and on `main`, because the race only opens under CI load. The delete test had
already hit the same trap in 2026-07-26 and fixed it in isolation; the fix is now
folder-wide.

Rules for this page's tests:

- To wait for the endpoint row, call the local `findEndpointRow()` helper. It
  keys off the delete button's aria-label (`Delete endpoint: <url>`), which is
  unique to the endpoint row and carries the URL.
- Anything that mounts with the endpoint row — the test-ping button, the
  toggle, the delete button — must be reached with `findBy*`, never a `getBy*`
  sitting after some other `waitFor`.
- Generally: a `waitFor` gate only proves the element *it queried* is present.
  If the next query targets a different element that can arrive in a later React
  commit, make that query `findBy*` too. Sibling assertions inside one
  synchronous subtree (a dialog's title + its buttons) are fine as `getBy*`.

`WebhookSettings.test.tsx` and `WebhookDeliveryLog.test.tsx` needed no changes —
but *not* because they are async-free. Both hold a deferred promise open in
their double-click-guard tests (`onTestPing` / `onReplay`) and assert the
re-enabled button after resolving it, and those resolutions do land in a later
commit. They are safe because each has exactly one async transition in flight at
a time, gated by its own `waitFor` at the point it matters. Run the same "can
this element arrive in a later commit?" check there anyway; today the answer is
just always handled.

## 2026-08-11 — ComplianceDashboardPage: an async gate that resolved on the wrong component

`ComplianceDashboardPage.test.tsx`'s empty-state case flaked in CI (run
31514378348) with `Unable to find an element with the text: CPE summaries
appear after secured CPE records are available for the selected period.` The
line above it already awaited `findByText('No CPE records in this period')`,
so by the #2148 rule at the end of this file it looked correctly gated.

It was not. **Two components on this page render that identical string** — the
org CPE card here, and `OrgCpeMemberDashboard` via
`ORG_CPE_MEMBER_LABELS.EMPTY` in `copy.ts`. The member card runs off a hook
this suite stubs, so it paints synchronously at first paint. The unscoped
`findByText` therefore satisfied its very first check against the *member*
card while the card under test was still a loading skeleton, and the sibling
paragraph existed only because RTL's `asyncAct` happened to flush the pending
commit on its way out. Probe at the moment the gate resolved:

```
[PROBE:after-render] {"emptyMatches":1,"orgCardLoading":true,"desc":0}
[PROBE:after-findBy]  {"emptyMatches":2,"orgCardLoading":false,"desc":1}
```

The same defect sat undetected in the summary case:
`data-testid="org-cpe-dashboard"` is on the `<Card>` **shell** — only
`CardContent` is behind the fetch — so `findByTestId` also resolves at first
paint. Eight aggregate assertions after it were equally unsynchronized.

Two things to carry forward when editing this page's tests:

- **The #2148 rule is necessary, not sufficient.** "Use `findBy*` for anything
  that can arrive in a later commit" assumes the gate matches the element you
  meant. Before trusting a gate, grep the string: if a sibling component on the
  same page renders it too, scope the query with `within(panel)`. Shared copy
  constants make this collision easy to create and invisible to review.
- **A testid on a card shell is not a fetch gate.** `findByTestId` on a
  wrapper whose *content* is conditional resolves before the fetch. Gate on a
  post-fetch node inside the panel, or on the loading skeleton clearing —
  `findSettledCpePanel()` in that suite does the latter, and the "Nessie stays
  OFF" negative assertions now use it so their non-vacuity comment holds.

Reproduce this class locally by settling the mocked query one macrotask later
(`setTimeout(..., 0)` instead of `Promise.resolve`) rather than by adding CPU
load — the variable is event-loop ordering, not CPU. Under that injection the
pre-fix suite failed 2/7 with the verbatim CI error; CPU contention alone
(24 busy cores, 8 concurrent vitest processes) never reproduced it.

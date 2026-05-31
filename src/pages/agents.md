# agents.md — pages
_Last updated: 2026-05-30_

## SCRUM-1980 — Search spinner persists below results (loading-state reset)

`SearchPage.tsx` runs the issuer (`usePublicSearch`) and credential (`search_public_credentials` RPC) legs together via `Promise.all`; they resolve at different times. The bottom "searching" spinner (`showSearchLoading`) is a "nothing to show yet" indicator and must clear the moment we have anything to render. The pre-fix guard (`!hasDisplayableResults`, added in `6af45e5c`) covered only the results sub-case and left the spinner lingering **below the error card** when the faster leg errored while the slower leg was still in flight (UAT 2026-05-22). Fix: also gate on `!displayError`. The spinner container now carries `role="status"` + `aria-live="polite"` + `aria-label={SEARCH_LABELS.LOADING}` + `data-testid="search-loading-spinner"` so the reset is assertable (matches the `AuditMyOrganizationButton` house style). Do NOT touch the semantic-search lane (`useSemanticSearch.ts` / `SemanticSearch.tsx`) — different surface, owned by PR #964.

**Review fix B2 (cross-mode stale error):** `displayError = error || fpError || personError`, and BOTH the spinner gate (`showSearchLoading … && !displayError`) and the issuer-results block are gated on `!displayError`. Each search path only cleared *its own* error channel (issuer/person path didn't clear `fpError`; the fingerprint path didn't clear the hook's `error` or `personError`), so a leftover error from a *different* mode (a) suppressed the in-flight spinner of the new search and (b) hid successful results behind the stale error card. Fix: `resetSearchState()` (calls the hook's `clearResults()` for `error`+`issuerResults`, plus clears `fpError`/`fpResult`/`personError`/`personResults`) runs at the start of every submit — `handleSearch` and the drag-to-verify `handleFileDrop` — so `displayError` only ever reflects the search currently in flight. When adding a new search mode here, clear its channel in `resetSearchState` too.

## SCRUM-1755 — Secure Document vs Issue Credential split

`DashboardPage.tsx` + `OrgProfilePage.tsx` — split "Secure Document" (universal) from "Issue Credential" (verified-org admin only). Dashboard empty-state CTA always opens `SecureDocumentDialog` (pre-1755 it opened `IssueCredentialForm` for ORG_ADMIN under a "Secure Document" label — the bug). Issue Credential header button is gated on `useCanIssueCredential()` AND `ENABLE_ISSUE_CREDENTIAL_SPLIT`. `OrgProfilePage` swaps the dual Bulk Upload + Issue Credential buttons for a single primary "Secure Document" button (auto-detects bulk inside the dialog) plus a gated outline "Issue Credential" button. The legacy bulk-only dialog wrapper was removed; `SecureDocumentDialog` handles every input shape.

## What This Folder Contains

Top-level page components rendered by react-router-dom routes. Each page composes layout (AppShell) with domain-specific hooks and components.

## Recent Changes
- 2026-05-30 SCRUM-2003 (review fixes): wired the remaining raw-enum status leak sites through `getStatusLabel` from `@/lib/statusDisplay` — `PublicPortfolioPage.tsx` (`att.status` + `anc.status`, both **public/unauth**), `PublicAttestationVerifyPage.tsx` attestor-credential `credential.status`, and `AttestationsPage.tsx` table `att.status`. Existing `STATUS_BADGE`/`STATUS_ICON`/`STATUS_COLORS` maps and icon conditionals stay keyed by the **raw** enum; only the visible Badge *text* is wrapped. NOT wired: `PublicAttestationVerifyPage.tsx` `linked_credential.verification_status` — that is org-identity verification status (`VERIFIED`/`UNVERIFIED`), a different enum domain than `anchor_status`/`attestation_status`, so it is intentionally left raw (forcing it through the anchor/attestation map would mislabel it).
- 2026-05-30 SCRUM-2008: `BillingPage.tsx` now Zod-validates the `/api/billing/status` 200 body (`billingStatusSchema`, mirrors the `BillingInfo` contract) before treating it as real data. A malformed/empty/error-envelope 200 throws into the existing catch → explicit "Unable to load billing data" card + Retry, never a silent placeholder/"Beta"/empty plan display. Builds on SCRUM-1983's AbortController timeout + error/retry (don't undo it). Pattern: any page that renders trust-bearing data from a fetch should validate the success body against a shape contract, not blind-cast `as T` — a 200 is not proof the payload is confirmed.
- 2026-05-16 SCRUM-1126: `VersionConflictsPage.tsx` — org-admin version conflict review UI. Groups pending versions by `external_file_id`, displays fingerprint previews + age, approve action creates PENDING anchor via worker API. Uses `useVersionResolution` hook + `OrgRequiredGate`. Responsive at 1280px + 375px.
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

# agents.md — hooks

## 2026-09-19 — UAT-12 capability and tag suggestions

`useSecuringCapability` validates the worker response with Zod and fails closed on
malformed or unavailable data. `usePrivateTagSuggestions` relies on RLS for the
tenant boundary, then partitions user tags from organization tags and filters the
latter to the exact selected org. Its React Query key includes both user and org,
preventing a prior scope's response from becoming the next scope's suggestions.

## UAT-22 platform invitation list (2026-09-14)

`useOrgInvitations(orgId, platformAdmin)` uses the authenticated admin worker list for platform administrators and the existing tenant RLS query otherwise. Cache keys include actor mode, preventing reuse of privileged foreign-org results in tenant mode. Expiry and revoked-status display semantics remain shared.

_Last updated: 2026-09-11_

## 2026-09-11 — UAT-22 selected-org platform invitations

`useInviteMember({ platformAdmin: true })` sends through the platform-admin worker route for the
selected org. The ordinary ORG_ADMIN path remains the tenant-scoped `invite_member` RPC. The
platform path creates one UUID per `(orgId,email,role)` intent, retains it through network or
delivery failures, and clears it only after confirmed `{sent:true}`; changing any intent field
creates a new UUID. Only an explicit post-insert delivery response says the invitation was created.
Permission, missing-org, existing-member, and unknown failures use distinct curated copy.
`useOrganization(orgId, true)` also loads foreign selected-org metadata from the platform-admin
worker because the ordinary browser query is intentionally restricted to membership org IDs.

## PR #2637 refresh without remounting MFA setup (2026-09-05)

`useMfaAssurance` accepts a separate refresh trigger from its stable session/AAL
cache identity. Token rotation runs an immediate background recheck, retaining
the last known state while it resolves; it does not unmount an in-progress QR.
New sign-in and AAL-change identities still report loading until checked. Existing
known-factor fail-closed behavior and 60s/visibility polling remain active.

## 2026-09-04 — release review: preserve an established MFA challenge on failed rechecks

`useMfaAssurance` now preserves the current session's known-factor state when a
background assurance lookup errors, rejects, or times out. Previously these paths
replaced `challenge_required` with `satisfied` and cleared `hasVerifiedFactor`,
allowing AuthGuard to render protected content without verification. Three
red-first regressions cover the failures and the next route's cache read.
This supersedes the unconditional recheck fail-open statement below: initial
unknown-factor availability behavior remains, but a known factor is never erased
by an unavailable lookup. Successful rechecks can still detect factor removal.
Runtime change: the previous PR #2637 soak does not cover this correction.

## 2026-09-03 SCRUM-3167 — `useMfaAssurance.ts` restored + live re-evaluation; `useMfaEnrollmentRequirement.ts` rewritten role+date; useHipaaMfaGate (deleted) deleted

Three hooks, one enforcement gate consumed by `AuthGuard.tsx` (see `src/components/auth/agents.md`'s dated entry for the full decision table and fail-open contract — this entry covers only the hook layer).

- **`useMfaAssurance(userId, sessionKey?)` — restored verbatim from PR #1973 (`3572fcd6e`, reverted `6d10032b4`)**, then extended with a LIVE RE-EVALUATION trigger (CTO ruling A4-11): the same fail-open `getAuthenticatorAssuranceLevel()` check now also re-runs on `visibilitychange` (tab returns to foreground) and every 60s while mounted, via a shared `check()` callback and a `userIdRef`-based stale-response guard, now shared through `useVisibilityPolling` (R7, PR #2637 review round 2 — this used to be a bespoke `useForegroundInterval` hook, deleted). Fail-open contract for `getAuthenticatorAssuranceLevel()` itself is UNCHANGED: every ambiguous/error/timeout outcome resolves to `'satisfied'`, never `'challenge_required'` — this hook can only ever ADD friction for an already-enrolled user. **R17-R21 (round 2) re-scopes `markBypassed()` to the ENROLLMENT path only** — `MfaChallenge` no longer calls it at all (it fails CLOSED on every error now, see `src/components/auth/agents.md`); the sole remaining caller is `AuthGuard`'s enrollment-branch `handleCapabilityUnavailable`. **R11 (round 2, efficiency, not security) adds an optional second `sessionKey` argument** (the caller's session `access_token`/`expires_at`) and a module-scope cache keyed by `(userId, sessionKey)`, so a route change that remounts `AuthGuard` renders synchronously from the last known result instead of re-awaiting the check. Caching is INERT whenever `sessionKey` is omitted/null — every pre-existing call site (all of `useMfaAssurance.test.ts`) keeps its exact prior behavior, in particular the EVERY-LOGIN ENFORCEMENT guarantee that two independent logins by the same user never share a cache entry. `markVerified`/`markBypassed` write through to the cache; `clearMfaAssuranceCache()` is called by `useAuth.ts`'s `signOut()`.
- **`useMfaEnrollmentRequirement()` — REWRITTEN, no longer takes a `userId` argument.** CTO ruling A4-3 drops org-level enforcement (`organizations.hipaa_mfa_required`) from phase 1 entirely — that column is writable by any org owner/admin via PostgREST with zero audit trail, so this hook issues **NO** `organizations` query at all now. Role comes from `useProfile()` (React Query, 60s staleTime) instead of a standalone Supabase query, so cached navigation never flashes a spinner (A4-6) — **this hook MUST be called from inside `<ProfileProvider>`**; every `AuthGuard` render already is (`App.tsx`: `QueryClientProvider` > `BrowserRouter` > `ProfileProvider` wraps every route). Returns `{ loading, mfaRequired, mfaGraceActive, enforceFromIso }`, derived from `src/lib/mfaPolicy.ts`'s `isMfaRequiredRole` × `isMfaEnforcementActive()`. Fails open to both-false on a profile query error or a null profile/role. Also carries the A4-11 live re-evaluation trigger via the shared `useVisibilityPolling` (R7, round 2 — same consolidation as `useMfaAssurance` above), gated `enabled: Boolean(profile)` (R12, matching its sibling's `Boolean(userId)` — it used to poll even before the profile had loaded). **R13 (round 2):** `onboardingIncomplete` is read directly from `useProfile().destination === '/onboarding/org'` (plus the `!is_platform_admin` carve-out) instead of re-deriving role/org_id inline.
- **useHipaaMfaGate (deleted) DELETED** (zero non-test importers, confirmed by repo-wide grep before deletion). Superseded by `useMfaEnrollmentRequirement.ts` above.

**Phase-2 items, tracked not built here:**
- Org-level enforcement needs an audited service-role RPC + a `REVOKE`-the-column migration (T3) before `organizations.hipaa_mfa_required` can safely gate anything again — this is what eventually delivers the still-open SCRUM-564 HIPAA REG-05 story. Do not read that column from either hook until that lands.
- **SCRUM-3593** (aal2-aware RLS on platform-admin surfaces) is the phase-2 control that closes the accepted A4-7 fail-open bypass (see `src/components/auth/agents.md`) server-side — planned only after this gate has soaked in prod past the 2026-09-21 enforcement date.

## 2026-08-30 — `useComplianceScore.ts` `useJurisdictionRules` error surfacing (SCRUM-3670)

`useJurisdictionRules()` swallowed fetch failures (bare `catch {}`, no else on `!res.ok`),
so an HTTP 500 from the public `/api/v1/compliance/rules` endpoint was indistinguishable
from an empty rule set — the compliance-score pickers rendered silently empty. Now mirrors
the sibling `useComplianceScore()` shape: `useCallback` fetch that sets `error` on non-ok
(`Failed to fetch compliance rules (HTTP <status>)`) and on throw (`err.message` /
`'Network error'`), returned as `{ rules, jurisdictions, industries, loading, error, refetch }`.
The effect uses the sibling's `async function run()` wrapper (avoids
`react-hooks/set-state-in-effect`). Consumers render generic copy, never the raw `error`
string. Sole consumer: `ComplianceDashboardPage` (see `src/pages/agents.md`). Tests:
`useComplianceScore.test.tsx` (4 cases, red-first — pins the HTTP-status message, the
network-failure message, and `refetch()` recovery).

## 2026-08-12 — `useApiKeys.ts`: revoke/delete actually reachable now (FD-P7)

`revokeKey(keyId)` / `deleteKey(keyId)` were dead paths: the worker stripped `id` from every key
response, so `ApiKeyMasked.id` was a type the server never satisfied and the PATCH/DELETE calls
addressed `/api/v1/keys/undefined`. The worker now returns `id` (plus nullable `revoked_at` /
`revocation_reason`, added to `ApiKeyMasked` as optional — a pre-fix worker omits them). No hook
logic changed; do not "fix" the id-based addressing to key_prefix — the prefix is not unique.
_Last updated: 2026-08-15_

## 2026-08-15 — `useAnchor.ts` settled-state semantics (BUG-2026-08-13-017)

`useAnchor`'s `!user || !id` reset branch used to `setLoading(false)` while auth was still resolving, committing one frame of `(loading=false, anchor=null, error=null)` between auth settling and the fetch effect re-running. RecordDetailPage renders exactly that tuple as "Record Not Found" — a live-measured ~25ms flash for records the user OWNS, and the state that let `e2e/cross-tenant.spec.ts`'s `evaluateRecordBlocked()` be satisfied by a loading state (hollow-pass class PR #2213 closed). The reset branch now does `setLoading(authLoading)`: a null `user` is terminal only once auth has settled. Invariant, pinned by `useAnchor.test.ts` (frame-recording test) and `RecordDetailPage.test.tsx` (MutationObserver over DOM commits): consumers must never observe settled-empty unless auth resolved + query completed + confirmed absent/denied. If you write a new manual-loading hook that both depends on `useAuth` and feeds a terminal not-found UI, apply the same rule — the React-Query hooks (`useAnchors`, `useProfile`, …) don't need it because v5's optimistic render result reports `isLoading=true` on the very render `enabled` flips true.
_Last updated: 2026-08-18_

## 2026-08-18 — `useOrgInvitations.ts` (invite-accept investigation, admin visibility)

New hook: reads an org's non-accepted invitations (`invitations` table, RLS-scoped by the pre-existing "Org admins can view invitations" policy — no migration) for `PendingInvitationsList` (`src/components/organization/agents.md`). Never selects `invitations.token` (pinned by a dedicated test — the single-use accept credential must never reach the browser, §1.4). Recomputes `pending` → `expired` client-side from `expires_at` exactly like the worker's `GET /api/invitations/:token` preview (`services/worker/src/api/invitations.ts`'s `isExpired()`) — the `status` column is never flipped to `'expired'` at rest, confirmed live against prod (3 real invitations still read `status='pending'` days past their `expires_at`). Built while investigating the founder's "I still cannot invite members" report: the accept-path backend was found correct end to end (new router-level integration test, `services/worker/src/routes/anchor-invitation-accept.test.ts`); the real, demonstrated gap was that the inviting admin had zero visibility into invitation status. See `src/components/organization/agents.md` for the full investigation note.

## 2026-08-10 — `useActivateAccount.ts` (recipient activation launch blocker)

New hook driving `/activate` against `GET /api/activation/:token` and `POST /api/activation/complete`. Shaped exactly like `useAcceptInvite` (SCRUM-3012), including the `code`-carrying error class so the page can branch on `expired` / `not_found` / `already_used` while only ever rendering the worker's own curated message.

Talks to the WORKER, not Supabase, and this is load-bearing rather than stylistic: activation must write the `auth.users` password via the admin API, which needs service_role — barred from the browser by §1.4. The previous implementation called `supabase.rpc('activate_user', …)` directly, which could not bind (no such overload in prod) and could not have set a password even if it had. See `services/worker/src/api/agents.md`.

Unlike `workerFetch`, no session is ever attached — the recipient has no account to sign into yet, which is the entire point of activation.

## What This Folder Contains

React hooks for data fetching and mutations against Supabase. Each hook encapsulates a single concern (auth, profile, anchors, revocation, export, etc.).

## Recent Changes

- 2026-08-03 Lane 2 bug blitz — founder-priority bug ("why can't I sort my
  records into envelopes"), fixed alongside migration `0393`
  (`supabase/migrations/agents.md`): `useFolders.ts` `assignMutation` now
  does `.select('id')` after the `anchors.update({ folder_id })` and throws
  when zero rows come back, mirroring `useSecureQueue.removeItem`'s
  established pattern (§ below, 2026-07-28 entry). Root cause was NOT the
  `trg_prevent_metadata_edit`/SECURED-lock hypothesis (verified live: an
  owner moving their own SECURED anchor into a folder already worked) — it
  was that `useAnchors.fetchAnchorsData` gives an ORG_ADMIN the WHOLE org's
  anchor list, but the only anchors UPDATE policy was `anchors_update_own`
  (`user_id = auth.uid()`). An ORG_ADMIN moving a teammate-created record
  (the common case for "My Records" as an org admin) hit a zero-row
  RLS-filtered UPDATE, which PostgREST reports as `error: null` — the
  pre-fix hook resolved successfully and `MyRecordsPage` toasted a false
  "Record moved". Migration `0393` widens RLS for the ORG_ADMIN-on-org-record
  case (folder_id-only, trigger-enforced); this hook's zero-row check is the
  honest-failure backstop for every path RLS still denies (e.g. a plain org
  member moving a teammate's record — deliberately unaffected by `0393`).
  Tests: `useFolders.test.ts` (new file, 4 cases) +
  `tests/rls/folders.test.ts` (4 new live-RLS cases, `tests/rls/agents.md`).
- 2026-07-28 R19 (advances SCRUM-2481): `useBulkAnchors.ts` `createBulkAnchors(records, options?)` gained a second `{ attested?: boolean }` param. Any batch containing a record whose `fingerprintProvided === false` (row-mode CSV import, no fingerprint column mapped — `src/lib/csvParser.ts`) requires `options.attested === true` or the hook rejects BEFORE calling the `bulk_create_anchors` RPC (sets `error`, returns `null`, never a partial submission). The RPC payload now carries `fingerprintProvided: r.fingerprintProvided ?? false` per row (fails closed to "record-derived, attestation required" when the flag is missing — never silently assumed `document_bytes`); the SQL function computes `fingerprint_source` server-side from this boolean (migration `0376`). Caller: `BulkUploadWizard.tsx`.
- 2026-07-27 SCRUM-2940 (Folders UI): `useAnchors.ts` — the `AnchorPartial`
  select/Pick gained `folder_id`, mapped to `Record.folderId` (`null` =
  Unfiled, distinct from `undefined`/not-fetched). This is the minimal select
  extension called for by the Folders UI work — `useFolders.ts` itself
  (create/rename/delete/assignRecord) was already complete from PR #1657 and
  was NOT restructured. Realtime INSERT/UPDATE payloads already carry
  `folder_id` for free (they map the full `AnchorRow`), so no realtime-path
  change was needed.
_The following three entries were lost off `main` by the 2026-07-28 union-merge-driver incident and restored the same day — see `docs/incidents/2026-07-28-agents-md-union-drop-remediation.md`._

- 2026-07-06 WH-02/03 (SCRUM-2397/2398, Lane 2 S3): created `useWebhookDeliveries.ts` — `useWebhookDeliveries()` reads `webhook_delivery_logs` DIRECTLY via Supabase with a **metadata-only select** (never `payload`/`response_body`; §1.6); org scoping + org-admin gating are enforced by RLS policy `webhook_delivery_logs_read_org`, not client filters. `replay()` POSTs to the worker's JWT-authed `/api/v1/webhooks/self-service/deliveries/:id/replay` (worker re-verifies ORG_ADMIN; every replay inserts a NEW delivery-log row, original preserved for audit). `useWebhookDlq()` lists the dead-letter queue through the worker (the `webhook_dead_letter_queue` table is service_role-only RLS — the browser cannot read it directly) + `dismiss()`. `sendWebhookTestPing()` fires the WH-02 signed test ping. All user-facing error strings come from `WEBHOOK_LABELS` — raw worker/Postgres errors are never surfaced (§1.4).
- 2026-07-06 OPS-03 (SCRUM-2401, Lane 2 S3): created `useOpsSloStats.ts` — fetches `GET /api/admin/ops-slo-stats` (worker, platform-admin gated server-side) and exposes `{ stats, loading, error, refetch }`. Mirrors `useSystemHealth`'s contract EXACTLY: `loading` starts true but the hook does NOT self-fetch on mount — the consuming page (`OpsSloDashboardPage`) drives the first fetch + polling via `useVisibilityPolling` (which already fires once on mount; a second mount-fetch here would double-fetch). Five typed surfaces (`anchorSecuredRate`, `connectorQueue`, `creditConservation`, `webhookDelivery`, `apiErrors`), each with independent `available`/`breach` flags so one failed read never blanks the rest.
- 2026-07-28 QUEUE-01 / SCRUM-2894 (L2-A1, founder P0): created `useSecuringCapability.ts` — client snapshot of `queueContract.ts`'s `SecuringCapability`. `canSecureInstantly` is **hardcoded false** this sprint per CTO ruling R5 (Instant-Secure ships dark, flag off) — the trusted server field doesn't exist on `GET /api/billing/status` yet (that's a follow-up). `creditBalance` sources from `useCredits()` (user-scoped `credits`, R4-canonical for individual money ops — NOT `org_credits`). Also created `useSecureQueue.ts` — the `consumer_secure_queue` list (status='PENDING', `deleted_at IS NULL`), scope `'own'` or `'org'`. `removeItem` soft-deletes via `validateAnchorUpdate({deleted_at})` against the EXISTING `anchors_update_own` RLS policy (owner-only) — no RLS change shipped. Finding: there is no org-admin UPDATE/DELETE policy on `anchors`, so an admin cannot remove another member's queued item today; the hook detects the resulting zero-row update and throws rather than pretending it worked (widening RLS is SCRUM-3010 scope, out of bounds here).
- 2026-07-28 SCRUM-3012: created `useAcceptInvite.ts` — drives `/accept-invite`: `loadPreview(token)` (public `GET /api/invitations/:token`, no auth) and `acceptInvitation({token,password?,fullName?})` (`POST /api/invitations/accept`, sends the bearer token when a session exists — join path — and omits it otherwise — new-account path, distinguished worker-side). Errors surface as `InviteAcceptError` carrying the worker's machine-readable `code` so the page can branch (expired/already_used/account_exists/email_mismatch). Also fixed `useInviteMember.ts`: the `invite_member` RPC's return value (the invitation id) was being discarded; it is now captured and forwarded to `/api/send-invitation-email` as `invitationId` so the worker can look up the invitation's real `token` and stop building a tokenless link (root cause of SCRUM-3012 — see `services/worker/src/routes/agents.md`).
- 2026-07-21 SCRUM-2901 (PI-0.5, PR #1600): `useTreasuryBalance.ts` — the 8s `AbortSignal.timeout` on the worker legs rejects with a DOMException named **`TimeoutError`** (NOT `AbortError`), whose raw browser text ("signal timed out") previously flowed verbatim into the admin error banner. Added `isTimeoutError()` and mapped status-leg / health-leg / outer-catch timeouts to `TREASURY_LABELS.WORKER_STATUS_TIMED_OUT` / `WORKER_HEALTH_TIMED_OUT` friendly copy; degraded rendering (keep-last-balance + stale flag, or unavailable state) is unchanged. Server side pairs with `services/worker/src/api/treasury.ts` `STATUS_LEG_BUDGET_MS = 6_500` (per-leg bound under this hook's `WORKER_TIMEOUT_MS = 8_000` — keep the inequality if either changes).
- 2026-07-08 FE-PROOF-GATE review fix (SCRUM-2501): `useProofAvailability.test.ts` now table-drives the status-to-state cases so 404 no-proof, 404 record-missing, and 429 transient remain pinned together. The classifier treats unknown 404 bodies as `retry`, not the honest direct-anchored empty state.
- 2026-07-06 FE-PROOF-GATE (SCRUM-2501, Lane 2 S3): created `useProofAvailability.ts` — anonymous fetch of `GET /api/v1/verify/:publicId/proof` (public endpoint, plain `fetch` against `WORKER_URL`, no session — same pattern as `ProvenanceTimeline`), delegating state classification to the pure `src/lib/proofAvailability.ts`. Takes `(publicId, enabled)`; callers must pass `enabled` only when the record's normalized status is SECURED (the contract's belt-and-braces status gate lives in `VerifierProofDownload`, not here). Returns `{ state, proofBundle, loading, retry }`; `loading` initializes from the mount-time fetch condition so the state-2 empty copy never flashes on first paint; `retry()` re-runs the fetch for the 5xx affordance; no automatic retry on 429 (no retry storms against the rate-limited endpoint); aborts the in-flight fetch on unmount/publicId change. Tests: `useProofAvailability.test.ts` (12).
- 2026-06-24 BUG-2026-06-24-010: `useEntitlements.ts` — no plan seeds a NULL `records_per_month`; the "organization" plan (seed.sql:220) encodes unlimited as the sentinel `999999`. Treating it as a finite cap rendered a frozen "N / 999999" meter pinned near 0% instead of "Unlimited records". Added exported `UNLIMITED_RECORDS_SENTINEL = 999999` + pure `isUnlimitedRecordsLimit(limit)` (`limit === null || limit >= 999999`); the hook now derives `isUnlimited` from it and **normalizes the returned `recordsLimit` to `null`** for unlimited plans. Every `recordsLimit === null` consumer (`UsageWidget`, `UpgradePrompt`, `ConfirmAnchorModal`→`UpgradePrompt`, `BillingPage`, `PricingPage`) gets the unlimited path for free — no per-consumer sentinel checks. Finite-branch math uses the always-numeric `rawRecordsLimit` so TS doesn't have to narrow the now-nullable `recordsLimit`. The `999999`/`>=999999`→unlimited and `999998`→finite boundary is asserted in `useEntitlements.test.ts`. Pattern: when a DB column uses a magic "unlimited" sentinel, normalize it to `null` at the hook boundary, not at every render site.
- 2026-06-01 Platform-admin org roster: created `useAdminOrgMembers.ts` — same `Member[]`/`loading`/`error`/`refreshMembers` shape as `useOrgMembers`, but fetches `GET /api/admin/organizations/:id/members` via `workerFetch` (service_role, RLS-bypass). Gated by an `enabled` arg so it only fires for platform admins viewing an org they are NOT a member of (whose RLS-scoped `useOrgMembers` returns 0 rows); non-admins never hit the 403-bound endpoint. `OrgProfilePage` picks `useAdminOrgMembers` vs `useOrgMembers` based on `isPlatformAdmin(email) && !userRole`.
- 2026-05-30 SCRUM-2149: `src/hooks/**` is now in scope for `npm run lint:copy` (banned §1.3 terms in user-visible strings). `useCanIssueCredential.ts` — reworded an internal guard error ("Issue Credential gate query" → "credential issuance gate query") so the §1.3-restricted phrase doesn't trip the now-expanded linter; no behavior change. Internal/dev-facing strings still must avoid banned UI terms once a file is scanned.
- 2026-05-30 SCRUM-1979: `useInviteMember.ts` — the outer `inviteMember` wrapper had a bare `catch {}` (no binding) that discarded the specific actionable message and always toasted the generic `TOAST.MEMBER_INVITE_FAILED`. Fix: curated messages (the 4 RPC-branch strings, the email-send-failed string, and Zod validation messages) are now thrown as a typed `ActionableInviteError` and surfaced verbatim via toast; anything else (incl. raw `rpcError.message`) maps to the generic fallback. The unknown RPC branch no longer rethrows raw DB text (§1.4 — no DB internals / constraint names / PG DETAIL / org-or-user identifiers to the UI). Pattern note: prefer a typed user-safe-error marker over surfacing arbitrary thrown `.message` to the UI.
- 2026-05-29 SCRUM-1958 (subtask-4): `useSemanticSearch.ts` now routes all user-visible error copy through `SEMANTIC_SEARCH_LABELS` (copy.ts) — auth, 402 (out of credits), 503 (service unavailable / AI down), generic, and network. Raw worker error bodies are no longer surfaced to users (was a §1.3 leak risk); any non-OK status that isn't 402/503 maps to friendly generic copy. Calls `GET /api/v1/ai/search` on the worker with the Supabase session token (unchanged contract).
- 2026-05-15 SCRUM-1651 ORG-HIER-01 verification: Expanded `useActiveOrg.test.ts` from 10 to 56 tests with full cross-tenant negative test matrix (SCRUM-1651 ORG-12). Matrix covers URL-based attacks, session-poisoning attacks, profile-drift attacks, combined attacks, parent/sub-org isolation for dual-membership users, and the operation-scoped invariant proving resolved orgId is always in membershipOrgIds or null. All 56 tests green.
- 2026-05-26 SCRUM-2013: useHipaaMfaGate (deleted) removed phantom credential types MEDICAL_LICENSE and IMMUNIZATION that never existed in the canonical enum. Tests updated.
- 2026-05-15 Tech-debt (CodeRabbit #689): `useActiveOrg.ts` — extracted `membershipOrgIds` into a value-stable `useMemo` keyed on sorted org ID string. Prevents unnecessary `resolveActiveOrg` recalculation on background React Query refetches when org IDs haven't changed.
- 2026-05-05 SCRUM-1755: Created `useCanIssueCredential.ts` (+ 15 resolver tests) — gate hook for the Issue Credential UI surface. Pure `resolveIssueGate()` carries the logic; React wrapper pulls `organizations.verification_status` / `suspended` / `parent_org_id` / `parent_approval_status` and the parent-org row when present. Returns a discriminated `IssueGate` so UI surfaces can render the right gate-blocked banner copy. Replaces the prior implicit "ORG_ADMIN ⇒ may issue" assumption.
- 2026-04-26 SCRUM-1260 R1-6 /simplify carry-over: Extracted `useVisibilityPolling.ts` — page-visibility-aware polling with `(cb, intervalMs)` contract. Replaces three near-identical inline copies in `AnchorQueuePage`, `useTreasuryBalance`, `PipelineAdminPage`. `useTreasuryBalance.ts` also gained `Promise.all` parallelization for the worker + mempool legs (16s → ~8s worst case) plus equality guards on `setBalance` / `setFeeRates` / `setReceipts` so identical poll payloads don't churn the consumer tree.
- 2026-04-24 API-V2-02: `useApiKeys.ts` now defaults new keys to `read:search`, matching the v2 scope vocabulary and migration `0253_api_key_scope_defaults.sql`.
- 2026-03-16 UF-01: Created `useCredentialTemplate.ts` — fetches template by credential_type + org_id. Two modes: authenticated (direct Supabase query) and public (RPC via `get_public_template`). Exports `parseTemplateFields()` and `TemplateDisplayData`/`TemplateField` types.
- 2026-03-11 SonarQube sprint: `useAuth.ts` — S6582 (optional chaining), S7772 (node: prefix). `useCredentialTemplates.ts` — S6582 (optional chaining). No behavioral changes.
- 2026-03-07 Code-review fix: `useProfile.ts` — separated `updating` state from `loading` state in `updateProfile()`. Prevents RouteGuard full-page spinner flash when toggling profile fields.
- 2026-03-07 P3-TS-02: Updated `useProfile.ts` — expanded `updateProfile` type to include `is_public_profile` for privacy toggle persistence.
- 2026-03-07 P3-TS-01: Created `useAnchors.ts` — fetches anchors from Supabase, maps DB rows to `Record` UI interface. RLS handles tenant scoping automatically.
- 2026-03-07 P4-TS-03: Created `useAnchor.ts` — fetches a single anchor by ID. Used by RecordDetailPage for /records/:id route.

## Sprint 3 (Lane 3) additions

_Restored 2026-07-28 — same union-merge-driver incident as the Recent Changes entries above._

- `useOrgCpeMemberSummary.ts` — CPE-02 (SCRUM-2380): live Supabase read for the org CPE dashboard MVP (NO new table/migration). anchors read = 0342 partial-index shape (`org_id` + `cpe_metadata IS NOT NULL`, `issued_at DESC`, cap 1000) with a section-1.6-minimal projection (`user_id, status, issued_at` — never the `cpe_metadata` blob). profiles read (org-scoped policy) supplies name/email. Org admin -> org-wide; plain member -> query pinned to own `user_id` (RLS alone cannot express own-rows-only for org members — see tests/rls/cpe-org-dashboard.test.ts). Pure `fetchOrgCpeMemberSummary()` exported for tests; React-Query hook wraps it. Status taxonomy (round-1 review): secured = SECURED only; in-progress (pendingCount) = PENDING/SUBMITTED/BROADCASTING/PENDING_RESOLUTION; terminal (terminalCount + totals.terminal) = REVOKED/EXPIRED/SUPERSEDED — counted distinctly, never silently omitted; consistent with the SECURED-only export gate and docs/reference/FE_PROOF_GATE_CONTRACT.md. displayName falls back to '' (component renders UNKNOWN_MEMBER copy) — NEVER a userId fragment.

## Do / Don't Rules
- DO: Follow the `useProfile` pattern (useCallback for fetch, useEffect to trigger, return loading/error/data/refresh)
- DO: Separate `loading` (initial fetch) from `updating` (mutations) so RouteGuard only shows spinner during initial load, not during inline updates
- DO: Use `Database['public']['Tables'][table]['Row']` types from generated `database.types.ts`
- DON'T: Call real Stripe or Bitcoin APIs in hooks — use `IPaymentProvider` / `IAnchorPublisher` interfaces
- DON'T: Use `useState` arrays to mock data that should come from Supabase (Constitution: schema-first)

## MVP Launch Gap Context
- **MVP-02 (Toast Notifications):** Hooks (`useAnchors`, `useProfile`, `useOrganization`, etc.) need toast calls on success/error. Will use Sonner (`toast.success()`, `toast.error()`). Global `<Toaster />` goes in App.tsx.
- **MVP-09 (Records Pagination + Search):** `useAnchors.ts` needs pagination params (page, pageSize, search, status filter, sort) passed to Supabase `.range()` query.
- **MVP-12 (Dark Mode):** New `useTheme.ts` hook — localStorage persistence + system preference detection.

## Dependencies
- `@/lib/supabase` — the typed Supabase client
- `@/types/database.types` — auto-generated from `supabase gen types`
- `useAuth` — most hooks depend on the authenticated user

## 2026-09-12 SCRUM-5024 — `useReferrals.ts` (new) + `useOnboarding.ts` attribution

`useReferrals(orgId)` reads the org's ACTIVE `referral_codes` row and
`get_org_referrals` directly from Supabase. Two rules it exists to keep:

- **No auto-mint.** `mint()` is called only from the button in `ReferralPanel`.
  Minting as a side effect of opening a settings page creates durable, shareable
  partner codes for organizations that never asked for one.
- **No `?? []`.** A failed read sets `error` and leaves `referred` empty *with*
  that error set, so the panel can distinguish "you referred nobody" from "we
  could not find out". Reporting an empty list as an answer is the hollow-200
  failure mode this repo has shipped before.

`useOnboarding.ts` gained `applyCapturedReferral(orgId)`, called after ALL THREE
org-creating branches (`update_profile_onboarding` success; the RPC-rejected
direct insert; the `already_set`-with-no-org fallback). The ordinary branch is
an `else if` so the fallback cannot attribute the same organization twice.

- It is never threaded INTO `update_profile_onboarding`: an optional org-creating
  parameter would make the referral vanish down whichever fallback the caller
  happened to take.
- It NEVER changes the signup result. A mistyped code must not fail an
  organization that already exists. Every non-applied outcome is logged at error
  level with its reason and returned as a typed `ReferralAttributionOutcome` the
  caller can count — nothing is swallowed.
- `rpc_failed` leaves the parked code in place (the database never ruled, so a
  retry is still live); every database verdict clears it (retrying a refused
  code cannot start succeeding).
- **Deliberate non-attribution:** `joinOrgByDomain` and invitation-accept create
  no organization, so nothing is attributed. A partner refers organizations, not
  seats.

## 2026-09-05 — SCRUM-4035 pending OAuth profile access

`useProfile` suppresses product-data queries while the session carries `arkova_email_pending`, including its loading indicator, so confirmation remains reachable. A confirmed token re-enables the existing profile query and onboarding destination calculation; covered by hook and real-app browser positive controls.

## 2026-09-11 — UAT-04 profile authority

`useProfile` does not fetch or return cached profile data until mailbox proof and
a same-user `authenticated`/AAL2 token are present. An assurance upgrade resumes
the query; account switches and AAL downgrades mask cached data immediately.

## 2026-09-19 — UAT-12 submission authority

`useSecuringCapability` and `useAnchorSubmissionStatus` parse worker payloads
strictly and fail closed. Status reads use the selected exact organization or an
explicit personal scope, poll only active instant intents, and refresh on focus.
`usePrivateTagSuggestions` partitions RLS-scoped user tags from exact-org tags;
its query key includes both user and selected organization to prevent stale scope
reuse. Private tag parsing enforces ten tags per scope and 64 characters per tag.

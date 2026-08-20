# agents.md — services/worker/src/api/

## 2026-08-12 — `partner-provisioning-router.ts`: the HTTP surface is STRICTER than the state machine (SCRUM-2990)

The state machine (`partner-provisioning.ts`, PR #1606) had no HTTP surface for three weeks: `/api/partner-provisioning` was a gated, **routeless** prefix. This adds the router. Two things about it are non-obvious and must not be "simplified" away:

- **The router deliberately denies what the machine allows.** `assertApprovalAuthority` admits `owner` / `org_admin` of the sponsor org as reviewers. Over HTTP they are **not** admitted — approve, reject, cancel and provision are **platform-admin only** (`platform_admin_required`, 403). The sponsor org is an interested party in its own partner's onboarding, and provisioning is the step that confers a counterparty standing in the platform. The machine still runs afterwards as an independent second gate; both must pass. If you ever find yourself relaxing the router to "match the machine", you are removing a control, not fixing an inconsistency.
- **`provisionPartnerAccount` has no self-review check and the router supplies one.** `approvePartnerRequest` / `rejectPartnerRequest` both call `assertNotSelfReview`; `provisionPartnerAccount` does **not**. So at the machine level the requester can provision their own approved request. The router bars it (`separation_of_duties`, 403). This is a genuine gap in the machine, closed at the HTTP layer rather than by editing the machine mid-window; a later PR should push it down.

**Actor construction is the trust boundary.** `ProvisioningActor` is built ONLY from the authenticated `userId` plus `_org-auth.ts` / `platformAdmin.ts` lookups. Nothing role- or org-bearing is read from the request body — the Zod schemas are non-strict, so a body carrying `role: 'platform_admin'` is silently **stripped**, not honoured and not 400'd. Two tests pin this (a spoofed body still 403s; a static scan forbids `req.body.role` / `req.body.org_id` in the source). For a platform admin the actor's `orgId` is **not load-bearing** — both machine gates short-circuit on `platform_admin` before reading it — it is supplied only to satisfy the machine's UUID shape validator, falling back to the sponsor org when the admin's profile has no org.

**Every transition persists under compare-and-swap**, never read-modify-write: the UPDATE carries `.eq('status', <status read before the transition>)`, so a racing reviewer matches zero rows and gets 409 `concurrent_transition` instead of silently overwriting the winner. Audit is emitted only **after** the swap wins, so a lost race writes no audit row. Verified against Postgres 17 on an isolated throwaway cluster (stale-status UPDATE → `UPDATE 0`).

**No credential material.** This surface issues no API key, creates no org, grants no entitlement or credit. `partner_org_id` is supplied by the operator and merely bound to the record. A static guard test fails the build if the router grows an import of `apiKeyAuth` / secret-manager / `createHmac` / `randomBytes`, and a response test asserts no `api_key` / `token` / `secret` substring ever appears in a provision response.

## 2026-08-10 — `activation.ts`: recipient account activation was 100% broken in production (launch blocker)

A recipient issued a credential could not claim it and could not log in. Two independent, unconditional defects, both confirmed against live prod:

- **Wrong signature at the call site.** `src/pages/ActivateAccountPage.tsx:44` called `supabase.rpc('activate_user', { p_token, p_claim_key })`. Prod has exactly ONE overload, `activate_user(p_token text, p_password text)`, and **PostgREST binds overloads by argument NAME** — so `p_claim_key` could never resolve and every attempt returned PGRST202. The `p_claim_key` variant exists only in `docs/migrations-archive/0175_activate_user_function.sql`: archived, never deployed. Confirmed genuinely absent rather than renamed — the live schema has no `activation_tokens` table and no `claim_key` column at all.
- **The password was silently discarded.** The deployed body accepts `p_password` and never references it again (baseline:498-553); it only flipped `status` to `'ACTIVE'` and NULLed the token. So fixing the call site ALONE would have been strictly worse: a green "Account Activated!" screen followed by a login that can never succeed, instead of a loud PGRST202.

**Why a worker endpoint and not a fixed RPC.** Setting a password means writing GoTrue-owned state (password hash, `auth.identities`, confirmation flags) via `auth.admin.updateUserById`, which needs the service_role key — barred from the browser by §1.4. A SECURITY DEFINER function hand-writing `auth.users` is the same antipattern migration 0401 rejects for `create_pending_recipient`. So `activate_user` is retired in `0402` (raises + browser grants revoked) and `completeActivation` is the one working path, mirroring `invitations.ts` (SCRUM-3012), which already solves the identical "unauthenticated holder of an emailed token needs an account provisioned" problem.

**`email_confirm: true` — flagged for human confirmation.** `createPendingRecipient` (PR #2047) mints the auth user with `email_confirm: false`, and prod runs `mailer_autoconfirm=false`. Activation therefore confirms the address: the single-use token was delivered to that mailbox and nowhere else, so clicking it is the same proof of mailbox control a confirmation link provides. **Without this the recipient sets a password and still cannot sign in — the blocker would not actually be fixed.** Note this diverges from the founder ruling recorded in `invitations.ts`, which keeps a brand-new invited account unconfirmed and emails a separate signup link; that path creates an account for a self-supplied address, whereas here the address was chosen by the issuing org and already proven. Worth an explicit founder confirmation.

**Token handling.** Format-validated (`^[0-9a-f]{64}$`) before any query so malformed input never reaches Postgres; `timingSafeEqual` comparison on top of the indexed lookup; expiry enforced from `activation_token_expires_at`; single-use via a **compare-and-swap UPDATE taken BEFORE the password write** — order matters, because claiming after would let anyone re-submitting an already-consumed link overwrite the account password. A failed password write best-effort-rolls-back the claim, so a GoTrue outage cannot strand a recipient ACTIVE with no password and no token. Token and password never reach logs, errors, or responses (pinned by tests).

**Known follow-up (not fixed here):** `profiles.activation_token` stores the RAW token, unlike API keys which are HMAC'd per §1.4. Hashed-at-rest storage would be the stronger design, but the writer is `recipients.ts` on PR #2047's branch — changing the storage format across two in-flight PRs is a cross-PR coupling risk. Prod currently holds zero `PENDING_ACTIVATION` profiles and zero activation tokens (per 0401's header), so this can be changed later with no live tokens to migrate.

_Last updated: 2026-08-03 (PR #1944 review round 3: connector-health.ts Drive watch-health reporting fix)_
_Last updated: 2026-08-10 (recipients.ts: auth-user-first provisioning, FK hotfix)_

## 2026-08-10 — `recipients.ts`: recipient provisioning could never have worked (FK to `auth.users`)

`createPendingRecipient` minted `const profileId = crypto.randomUUID()` and inserted it as `profiles.id`. But `profiles.id` is `FOREIGN KEY -> auth.users(id) ON DELETE CASCADE` (`profiles_id_fkey`, baseline:12085, `convalidated: true`, never dropped across 0290-0400), so a random UUID with no matching `auth.users` row **always** violated the FK. Not flaky, not conditional, not flag-gated: this endpoint 500'd for every genuinely new recipient since BETA-04 shipped.

Prod proves it never once succeeded: **zero** `PENDING_ACTIVATION` profiles, **zero** profiles carrying an `activation_token`, and `auth.users` count == `profiles` count (30/30).

It failed LOUDLY, not silently — `routes/anchor.ts:111-123` catches and returns HTTP 500, and `src/hooks/useBulkAnchors.ts:220-226` renders a partial-failure toast. So bulk issuance created the anchors and then failed provisioning for every new recipient, which is the user-visible symptom.

- **Fix — port the `invitations.ts:473-514` pattern.** Create the auth user FIRST via `db.auth.admin.createUser({ email, email_confirm: false, user_metadata })` (§1.4: `supabase.auth.admin` never reaches the browser), key the profile row with `newUser.id`, and roll back with `db.auth.admin.deleteUser(profileId)` if anything after creation throws. A failed rollback is logged loudly as an orphaned auth user needing manual cleanup — an orphan blocks any future re-invite of that address.
- **`email_confirm: false` is deliberate.** The activation link the recipient is about to receive is what proves mailbox control; pre-confirming the address before they click would weaken that. Same choice `invitations.ts` makes.
- **23505 is handled differently here than in `invitations.ts` — do not "simplify" it.** The `create_profile_for_new_user` trigger on `auth.users` may already have inserted a bare profile row. In `invitations.ts` that row is equivalent to the one being inserted, so a 23505 is treated as success. Here it is NOT: the trigger's row carries no `org_id`, no `PENDING_ACTIVATION` status and no `activation_token`, so swallowing the 23505 would leave a recipient who can never be activated. The activation fields are applied by UPDATE instead.
- **Why CI never caught it:** `recipients.test.ts` mocked the whole `db` object, so the FK boundary was never exercised and all 7 tests passed against code that could not work. The new `describe('auth-user provisioning (FK profiles.id -> auth.users.id)')` block pins the part of the constraint that CAN be asserted without a live database — the ORDER of operations (auth user created before the profile insert), that the profile is keyed by the auth user's id rather than a standalone UUID, and the rollback/no-rollback semantics. These are ordering/contract assertions, **not** proof against a real schema; no live-DB verification was run.

**Two related defects found in passing, NOT fixed here** (both pre-existing and independent of this change):

1. **`activate_user` never establishes a credential.** The deployed function (`activate_user(p_token text, p_password text)`, baseline:498) only flips `profiles.status` to `ACTIVE` and clears the token — it never creates an `auth.users` row and never sets a password on one. With this fix the auth user now exists, but activation still does not give the recipient a way to sign in. Establishing the password needs a worker-side `auth.admin.updateUserById` step (the browser cannot hold service_role).
2. **`ActivateAccountPage.tsx` calls a signature that is not deployed.** It invokes `.rpc('activate_user', { p_token, p_claim_key })`, but the live signature takes `(p_token, p_password)` — confirmed via the introspected `database.types.ts` (`Args: { p_password: string; p_token: string }`). The `p_claim_key` variant only exists in `docs/migrations-archive/0175`. PostgREST resolves overloads by argument name, so this call cannot bind (PGRST202).

The SQL twin `create_pending_recipient` had the identical FK bug **plus** an invalid `'MEMBER'` role literal (the `user_role` enum has only `INDIVIDUAL`/`ORG_ADMIN`/`ORG_MEMBER`, so it raised 22P02 before ever reaching the FK). It has zero runtime callers and is retired by migration `0401` — see `supabase/migrations/agents.md`.

## 2026-08-10 — `version-resolution.ts` enforces the org field policy (DPA clause 4.6)

`handleResolveVersion` creates an anchor on `decision: 'approve'`, which puts it under the rule that
every anchor-creating request handler enforces `enforceOrgFieldPolicy` (migration `0405`), pinned by
`scripts/ci/check-anchor-field-policy-coverage.ts`.

This route is the weakest case for the guard and is still covered on purpose: `ResolveVersionInput`
is `.strict()` with only `decision` and `notes`, and the anchor's metadata comes from the stored
`external_document_versions` row rather than from the request — so nothing the caller sends here is
persisted. It is guarded anyway because the control is about what the counterparty TRANSMITS (a
prohibited field in `notes` has already been sent to us whether or not we store it), because
`.strict()` is a property of a schema someone may relax, and because a uniform rule is what lets the
CI detector run with no per-file exemption list.


## 2026-08-03 — `compliance-inbox-summary.ts`: `secured_automatically` was silently stuck at zero for every org

Found in passing while wiring the founder-directive INSTANT_SECURE rule action (`services/worker/src/jobs/agents.md`). `loadCounts()`'s `secured_automatically` bucket queried `organization_rule_executions` for `output_payload->>routed_to = RULE_ROUTED_TO.AUTO_ANCHOR` (`'auto_anchor'`) — but **no dispatcher code path has emitted that value since SCRUM-1649 DS-AUTO-02 shipped**. `rule-action-dispatcher.ts` routes every successful automatic-anchor outcome (AUTO_ANCHOR's free-queue path, and FAST_TRACK_ANCHOR/INSTANT_SECURE's credit-funded path) through `RULE_ROUTED_TO.ANCHOR_QUEUE` (`'anchor_queue'`) or `RULE_ROUTED_TO.ANCHOR_PIPELINE` (`'anchor_pipeline'`) — `RULE_ROUTED_TO.AUTO_ANCHOR` is a stale constant nothing writes. So this dashboard counter was pinned at zero on every org **regardless of how many documents rules had actually secured** — the exact "doesn't look like anything is working" symptom the founder directive responds to, on the one surface built to prove otherwise. Fixed to `.in(ROUTED_TO_FIELD, [RULE_ROUTED_TO.ANCHOR_QUEUE, RULE_ROUTED_TO.ANCHOR_PIPELINE])`. No existing test asserted the query shape for this bucket (unlike `needs_review`, which does pin `review_queue`) — added `compliance-inbox-summary.test.ts`'s `'secured_automatically counts SUCCEEDED executions routed to the anchor pipeline...'` case, TDD red→green.

## 2026-08-03 — PR #1944 review round 3: `connector-health.ts` reported Drive as always-healthy regardless of actual renewal failures

`classify()` derived `state`/`health_reason`/`next_expires_at`/`last_renewal_at` from a `connector_subscriptions` row — real, and the correct source for `microsoft_graph` (`microsoft-graph.ts` writes it) — but nothing in `services/worker/src` has EVER written a `google_drive` row into that table: `drive-oauth.ts` and `drive-subscription-renewal.ts` (GH #1835) both only ever touch `org_integrations`. So for Drive, `subscription` was always `undefined`, `classify()` always fell through to `{state:'connected', reason:'none'}`, and the expiry/renewal fields were always `null` — no matter how badly renewal was failing or how high `watch_renewal_failure_count` climbed. Exactly the surface this dashboard's own header comment says should stop lying, still lying for the one connector the PR was fixing.

Fix: new `deriveDriveWatchHealth(integration)` synthesizes a `SubscriptionRow`-shaped view directly from the `org_integrations` columns `drive-oauth.ts` and `drive-subscription-renewal.ts` actually maintain — `subscription_expires_at`, `last_renewal_error`, `last_renewal_at`. `status: 'degraded'` whenever `last_renewal_error` is non-null (cleared to null on every successful renewal, set on every failure including the original OAuth-callback bootstrap failure path) — a real, current-as-of-last-attempt signal. Used ONLY for `entry.id === 'google_drive'`; `microsoft_graph` is untouched and keeps reading `connector_subscriptions`. `SubscriptionRow.expires_at` widened to `string | null` (was `string`) so a never-bootstrapped connection round-trips to `next_expires_at: null`, not `''` (`?? null` only catches null/undefined). Tests: `connector-health.test.ts` — degraded-from-org_integrations, healthy-when-no-error, null-not-empty-string, and a stale/leftover `connector_subscriptions` row being correctly ignored for Drive.

## 2026-08-03 — GH #1836 (SECURITY): `connector-health.ts` no longer echoes a connector's `channel_token` secret to the org dashboard

`GET /api/connectors/health` (`handleConnectorHealth`) returned `integration?.account_label` verbatim. For every provider except `google_drive` that column is a plain display string (e.g. `"Acme Corp"`), but for Drive it is a JSON blob `{ email, channel_token, resource_id }` — `channel_token` is the webhook-authentication secret minted at `changes.watch` registration time (see `api/v1/integrations/agents.md` and `integrations/connectors/agents.md`'s GH #1835/#1836 entries). The dashboard is org-scoped (`.eq('org_id', orgId)`), so this wasn't cross-tenant, but a secret has no legitimate reason to reach ANY frontend response — same rule the connect flow itself follows.

New `sanitizeAccountLabel(raw)`: if the label parses as JSON with a `channel_token` key, return only `email` (or `null` if no email); otherwise pass the raw string through unchanged (DocuSign/Adobe/etc. labels are never valid JSON with that key, so they're untouched). Applied at the one call site building the `ConnectorHealth` response. Tests: `connector-health.test.ts` `describe('account_label sanitization (GH #1836)')`. **PR #1944 review round 3**: `sanitizeAccountLabel` now delegates to the canonical `parseDriveAccountLabel()` (`integrations/connectors/drive-account-label.ts`) instead of its own inline `JSON.parse` — see that file's doc comment for the 3 other sites it replaced (4 total, counting this one).

## 2026-08-01 — BUG-2026-08-01-F9 GAP 1: `POST /api/queue/run` now reports a definitive broadcast rejection as 409, not 200 `{ok:true}` (`queue-resolution.ts`)

`handleRunOrgAnchorQueue` is the manual admin trigger for a single org's queue (`processBatchAnchors({ force: true, orgId })`). PR #1828 fixed the SAME "success indistinguishable from idleness" defect (BUG-2026-08-01-F9) for the scheduled path (`org-queue-scheduler.ts`) but deliberately left this synchronous human-admin path for a follow-up — until this fix, ANY non-throwing `processBatchAnchors` result (including a fully-unwound, definitive broadcast rejection carrying `result.rejectedReason`) unconditionally recorded `status: 'succeeded'` and responded `res.json({ ok: true, ...result })`.

- **Response shape decision — `409 { ok: false, error: { code: 'broadcast_rejected', message } }`, not `200 { ok: false }` and not a bare 5xx.** Read `AnchorQueuePage.tsx` (`runQueue()`) before deciding: the frontend keys success/failure ENTIRELY on `res.ok` (HTTP status) and never inspects an `ok` field in the JSON body — so a `200 { ok: false }` would be silently read as a successful, uneventful "0 anchors submitted" run, actively hiding the rejection from the operator. A bare 500 would misrepresent a legitimate, EXPECTED, self-healing outcome (the node examined and refused the signed tx due to contention; the next drain typically clears it) as a server fault, risking spurious on-call paging. 409 (Conflict) is the closest HTTP semantic match: the request could not complete because of a conflict over a shared, contended resource (the treasury's spendable inputs), and retrying later is expected to succeed. This also keeps the endpoint's response family consistent — the existing 400/403/500 paths on this same handler already respond non-2xx + `{ error: { code, message } }`, never a 2xx-with-a-flag shape.
- **§1.3 applies to this backend response text.** `AnchorQueuePage.tsx` renders `body.error.message` verbatim via `setError(err.message)` with no server→client copy mapping layer, so the message assembled in `queue-resolution.ts` IS user-facing UI copy and must avoid the banned terminology list (Wallet/Gas/Hash/Block/Transaction/Crypto/Blockchain/Bitcoin/Testnet/Mainnet/UTXO/Broadcast) even though it originates in worker code, not JSX. The chosen copy: *"This run could not complete because of a temporary conflict over shared network capacity. This is expected to clear on its own — try running again shortly."* Tested via a regex assertion in `queue-resolution.test.ts` so a future edit can't silently reintroduce a banned term here.
- **`recordOrgQueueRunResult` and `recordManualRunAudit` both record `status: 'failed'`** (with `error: result.rejectedReason` on the run-history row) when `result.rejectedReason` is set — mirroring the scheduler fix exactly, reusing the SAME field the batch-anchor.ts fix (PR #1828) added, no new field/enum value. The `queue_run_completed` admin notification is skipped on this path (it did not fire before either for a `processed: 0` outcome, since that branch was already conditioned on real work — but the skip is now explicit, not incidental).
- A genuinely empty run (no `rejectedReason`) is completely unaffected — still `200 { ok: true, ...result }`, `status: 'succeeded'`.
- Tests: `queue-resolution.test.ts` `describe('handleRunOrgAnchorQueue')` — new tests for the 409/`ok:false`/banned-terminology-absent response, the `status:'failed'` run-history + audit rows, the skipped notification, and a companion test pinning the unchanged 200 happy path.

## 2026-07-28 — supersede_anchor / resolve_anchor_queue_by_public_id: the SCRUM-2213 trap, again (endpoint-reachability audit)

`POST /api/anchor/:id/supersede` and `POST /api/queue/resolve` were both always-403 for every caller, including legitimate org admins — the SAME bug class as the 2026-05-30 entry below, just not yet fixed for these two RPCs.

- **`anchor-lineage.ts` (`handleSupersedeAnchor`):** `admin.ts` already resolved `userId` via `extractAuthUserId()` and gated on it (401 if missing) — but then called `handleSupersedeAnchor(req, res)`, discarding the identity. The RPC resolved the caller via `auth.uid()` (NULL under service_role) → 'Profile not found' → 403 always. Fix: `handleSupersedeAnchor` now takes a required `callerUserId` third param (401 if missing — a structural belt-and-suspenders, since `admin.ts` already gates), and `admin.ts` now passes `userId` through.
- **`queue-resolution.ts` (`handleResolveQueue`):** `actorUserId` WAS already threaded through by the route, but the handler only used it for the post-success notification lookup — never passed into the RPC call. Same `auth.uid()` failure, same 403-always outcome.
- **Fix pattern (SCRUM-2213 option B — "pass an explicit `p_user_id` into the RPC"):** migration `0367_worker_rpc_caller_identity_supersede_queue_resolve.sql` (FILE-ONLY / pre-soak) adds a NEW 4-arg overload of `supersede_anchor()` and `resolve_anchor_queue_by_public_id()`, each taking a REQUIRED `p_caller_user_id uuid` param (no default — so PostgREST can never resolve a 3-key call to this overload; no signature ambiguity) instead of reading `auth.uid()`. Every existing authorization check (profile exists, role = ORG_ADMIN, caller's org matches target) is preserved verbatim in the new overload — only WHO the RPC thinks is calling changed, not what it lets them do. The original 3-arg `auth.uid()`-based overloads are untouched.
- **Security-critical detail:** the new 4-arg overloads are `REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO service_role` — NOT the broad anon/authenticated/service_role grant the 3-arg versions carry. If `authenticated` could call the identity-carrying overload directly via PostgREST, any authenticated caller could pass an arbitrary `p_caller_user_id` and impersonate another user/org-admin. Only the worker (service_role, and only after independently verifying the caller's JWT via `extractAuthUserId`) can reach this path. Never widen this grant.
- Worker call sites now build the RPC args with `p_caller_user_id` set from the JWT-verified id — never from `req.body`/`req.params`.
_Last updated: 2026-07-28 (L2-A5 admin org-credit adjust)_

## 2026-07-28 — Lane 2: platform-admin org credit add/remove (L2-A5, founder admin-controls)

`admin-actions.ts` adds `handleAdjustOrgCredit` → `POST /api/admin/organizations/:id/credits/adjust` (wired in `routes/admin.ts`), body `{ amount: signed integer, reason: string, idempotency_key: uuid }`. Same `isPlatformAdmin(userId)` gate as every other handler in this file, then dispatches to the new `admin_adjust_org_credit` RPC (migration `0375`). `amount` is signed — positive = GRANT, negative = REVOKE; `reason` and `idempotency_key` are both mandatory (400 if missing/malformed — `idempotency_key` is checked against a UUID-shape regex client-side so a bad key 400s instead of surfacing a raw Postgres cast error). RPC error codes map to HTTP status: `insufficient_balance` / `idempotency_key_conflict` → 409, `org_not_initialized` → 404, anything else / transport error → 500/400. The RPC itself reuses the existing `org_credit_deductions` idempotency ledger (0326/0341) via its `GRANT`/`REVOKE` `entry_type` values — **no new table** — and writes an `audit_events` row (actor + reason) in the same transaction; see `supabase/migrations/agents.md` for the full RPC writeup. `admin-lists.ts`'s `handleAdminOrganizations` now also selects `org_credits.balance` and returns it as `credit_balance` per org, so the admin organizations list can render/edit it (`AdminOrganizationsPage.tsx`, see `src/pages/agents.md`). Tests in `admin-actions.test.ts` cover the gate, validation, RPC dispatch shape (positive/negative amount passthrough), idempotent-replay passthrough, and the error-code → status mapping.
_Last updated: 2026-07-28 (SCRUM-3012 invitation accept)_

## 2026-07-28 — Org-invite flow, end to end (SCRUM-3012)

Root cause: `routes/anchor.ts`'s `/send-invitation-email` built the emailed link as
`/login?invite=true&org=...`, dropping `invitations.token` entirely — nothing in
the app ever consumed a token because the link never carried one, so "accept"
could not exist. Prod evidence: 1 invitation row ever, 0 accepted, 0 emails.

`invitations.ts` (new) is the missing accept step, DI-style (`{ db, logger }`
deps, mirrors `account-delete.ts` — makes the many differently-shaped
`db.from()` chains mockable without `vi.mock` hoisting gymnastics):

- `getInvitationPreview(deps, token)` — public preview (org name, email, role,
  `expired`/`alreadyUsed` booleans) for the `/accept-invite` page. No auth —
  the token itself is the proof of access.
- **Token shape is validated before the query** (shared `loadInvitationByToken`,
  so both preview and accept get it). `invitations.token` is a `uuid` column, so
  `.eq('token', <non-uuid>)` makes Postgres raise 22P02 → supabase-js `error` →
  `internal_error` → HTTP 500 + an error-level log, for input as ordinary as a
  link mangled by an email client. A malformed token is not a known invitation:
  it returns `not_found` (404) without touching the DB.
- `acceptInvitation(deps, { token, password?, fullName?, callerId })` —
  validates token + `expires_at`, then branches:
  - **`callerId` present** (authenticated) — the caller's `profiles.email`
    MUST match the invitation's email (else `email_mismatch`, 403); on match,
    only `org_members` is inserted. No account creation risk on this path.
  - **`callerId` null, existing account** (a `profiles` row already has that
    email) — `account_exists` (409); the frontend sends them to sign in
    instead of silently trying (and failing) to create a duplicate. The one
    exception is `reclaimUnconfirmedSquatter`, which deletes the occupying auth
    user so the real recipient can provision. It is deliberately hard to
    trigger — ALL THREE of `email_confirmed_at IS NULL`, created at/after the
    invitation, **and zero `org_members` rows** must hold. The membership check
    is load-bearing: two orgs can each hold a pending invite for one address
    (the unique constraint is per-org) and multi-org membership is supported, so
    a genuine invitee who accepted org B's invite and then clicked org A's older
    link matched the first two conditions and had his org B membership deleted
    with no way to replay the already-'accepted' invitation B. Never relax this
    to a two-condition check. Deletion relies on the
    `ON DELETE CASCADE` from `auth.users` — do NOT re-add a blanket
    `org_members.delete().eq('user_id', …)`.
  - **`callerId` null, no existing account** — creates the auth user
    WORKER-SIDE via `db.auth.admin.createUser({ email, password,
    email_confirm: false })` (Constitution §1.4: `supabase.auth.admin` never
    reaches the browser), inserts `profiles` (tolerates a `23505` race against
    a possible DB trigger — not a failure), then provisions membership.
  - Idempotent replay: an already-`accepted` invitation only succeeds again
    when the caller can prove membership (`org_members` row) — otherwise
    `already_used` (410, not a silent no-op for a stranger).
  - **Rollback on partial failure (new-account path only):** if anything
    after `createUser` throws, `db.auth.admin.deleteUser(newUserId)` runs
    best-effort so a partial failure never leaves a dangling, re-invite-
    blocking auth user. The existing-user join path never creates an account,
    so it never needs this.
  - **Email verification interplay:** prod runs `mailer_autoconfirm=false`, so
    a brand-new account still needs a confirmed email before sign-in works —
    the invite token proved mailbox control ONCE, but login keeps its normal
    gate. The worker mints a Supabase signup-confirmation link via
    `db.auth.admin.generateLink({ type: 'signup', ... })` and sends it through
    the same audited `sendEmail`/Resend pipeline as every other outbound
    email (own template `buildAccountVerificationEmail`, own `emailType:
    'account_verification'`) rather than relying on Supabase's separate
    built-in mailer. A failed verification-email send does NOT undo the
    already-provisioned account/membership — surfaced via
    `verificationEmailSent: false` instead.

`InvitationError` carries a stable `code` (`not_found` / `expired` /
`already_used` / `email_mismatch` / `account_exists` / `invalid_input` /
`internal_error`) the route layer (`routes/anchor.ts`) maps 1:1 to an HTTP
status — never a raw DB/RPC message reaches the client.

**Known follow-up, deliberately not fixed here:** two competing SQL overloads
of `invite_member()` exist in the baseline (`(invitee_email, invitee_role,
target_org_id)` — SEC-RECON-8-guarded, blocks inviting as `ORG_ADMIN`, the one
the frontend actually calls; and an older `(inviter_user_id, invitee_email,
invitee_role, target_org_id)` shape whose `status='PENDING'` insert would
violate the `invitations_status_check` CHECK constraint if ever called). Not
addressed in SCRUM-3012 — flagged in the PR body as a dedup follow-up.

## 2026-07-21 — Lane 2 PI-0.5: partner-provisioning skeleton is flag-gated + statically guarded (SCRUM-2990)

`partner-provisioning.ts` (pure request→approve→provision state machine, see PR #1606) is now protected by two invariants enforced in `partner-provisioning.guard.test.ts`:

- **No live provisioning / no secret handling in the skeleton.** The module's static import list must be EXACTLY `zod` + `node:crypto` (`randomUUID` only) + the type-only `./audit-event.js` — no DB client, no RPC, no fetch, no Stripe, no Secret Manager, no API-key/HMAC/proof-key modules. Its only outputs are its own record + audit event body; the API layer persists them. If you wire the provision step to real org/user/key creation, that code goes in a SEPARATE adapter module (behind the gate) — this guard is meant to go red if the skeleton itself grows side effects.
- **Flag wiring.** The reserved surface prefix `/api/partner-provisioning` must stay mounted behind `partnerProvisioningGate()` in `index.ts` (ENABLE_PARTNER_PROVISIONING, fail-closed → 404), and the flag must stay registered in `flagRegistry.ts` `DB_FLAGS`. Mount any future partner-provisioning router UNDER that prefix.

## 2026-07-06 — Lane 2 s3: OPS-03 SLO dashboard stats endpoint (SCRUM-2401)

`admin-ops-slo.ts` adds `GET /api/admin/ops-slo-stats` (`handleOpsSloStats`, platform-admin gated via the shared `isPlatformAdmin` DB-flag helper — DB never touched before the gate). Read-only rollup of FIVE SLO surfaces computed **live on every request** (deliberately NO new table/migration — the story is scoped non-migration T2): **anchorSecuredRate** (existing `get_anchor_status_counts_fast` RPC / mig 0324 cache; -1 sentinels map to `available:false`, never a fake zero), **connectorQueue** (`connector_artifact` status scan, bounded 20k; depth = pending|queued|processing|materialized, mirrors the drain's WORK_STATUSES; untyped `(db as any)` cast — 0343 not yet in generated types), **creditConservation** (the SAME `org_credit_ledger_divergence` RPC `credit-conservation-reconciler.ts` calls — the reconciler persists nothing, so the dashboard re-runs the identical live read; response carries org_id + counts ONLY, never raw balance/divergence — §1.4 PII rule matches the reconciler's bucket-only Sentry alert), **webhookDelivery** (`webhook_delivery_logs` 24h window, success-rate), **apiErrors** (`verification_events` 24h window, `result='error'` rate — the only durable per-request API outcome log; rate-limit/query stats are in-memory). Every surface is independently fail-OPEN: a read failure → `available:false, breach:false` (unknown ≠ breach) and never blanks the other four. `overallBreach` = OR of surface breaches. Breach thresholds are module constants (90% secured, 90% delivery, 5% API error, depth>500). Consumed by `src/pages/OpsSloDashboardPage.tsx` via `useOpsSloStats`.

## 2026-06-29 — Lane 2 s2: manual org queue run guard owner-inclusive + sub-org-aware (QUEUE-05 / SCRUM-2351)

`handleRunOrgAnchorQueue` (`queue-resolution.ts`) no longer carries a local `isOrgAdmin` doing a direct `org_members` probe — it now authorizes through the **canonical `_org-auth` resolver** (`isCallerOrgAdminResult`, owner-inclusive: owner/admin via `org_members` OR `ORG_ADMIN`/platform-admin via profile; fail-closed, 500 on operational error vs 403 true-negative). The endpoint accepts an optional `org_id` (`RunOrgQueueInput`, `.strict()` — unknown key → 400) so a caller can target a **specific** queue: their OWN org, or an **APPROVED sub-org** (`organizations.parent_org_id` = caller's org AND `parent_approval_status='APPROVED'`) whose parent the caller administers. The batch run is scoped to the resolved target org (never the parent), so a parent admin can't reach an unrelated org and a sub-org member/cross-org caller is 403. A `QUEUE_RUN_MANUAL` audit event (event_category `ANCHOR`, `relationship: self|sub_org`) is written on BOTH success and failure (non-fatal — the run is the source of truth). Route-level 401 stays in `routes/admin.ts` (`extractAuthUserId`).

## 2026-06-16 — version-resolution.ts fully typed (untypedDb removed)

The worker `database.types.ts` resync to head 0339 added `external_document_versions`
and `version_reviews`, so the `const untypedDb = db as unknown as SupabaseClient<any>`
escape hatch (and its `@supabase/supabase-js` `SupabaseClient` import) is gone — all six
`external_document_versions` / `version_reviews` reads/writes now run on the typed `db`
client. No runtime change (casts are type-erased); the win is compile-time column/shape
checking. Per the DON'T rule in `services/worker/agents.md`: don't reintroduce
`(db as any)` for a table that's in `database.types.ts` — run `gen:types` instead.

## 2026-06-01 Platform-admin org roster + add member (RLS-bypass via service_role)

- `admin-org-members.ts` adds three platform-admin-gated endpoints behind the org profile UI: `GET /api/admin/organizations/:id/members` (roster), `GET /api/admin/users/search?email=` (find a user for the add flow), `POST /api/admin/organizations/:id/members` (add member). The browser-side org views query Supabase directly under RLS, and `org_members` / `profiles` SELECT policies have **no platform-admin bypass** — a platform admin viewing an org they are not a member of saw "0 members" and "No user found". These use the service_role `db` client (bypasses RLS) and gate EVERY endpoint with `isPlatformAdmin(userId)` first (DB is never touched before the gate — asserted in tests).
- The roster intentionally reads **`org_members` first, then `profiles` by member user IDs**. This is the membership source of truth: `profiles.org_id` is only the user's primary/current org and will miss valid multi-org membership rows. Service-role access is still strictly platform-admin gated before either query.
- Add-member writes go **directly** through service_role (insert `org_members` + backfill `profiles.org_id` when null + `audit_events` MEMBER_ADDED row). We deliberately do **NOT** call the `add_org_member` RPC: it resolves the caller via `auth.uid()`, which is NULL under the worker's service_role client (same SCRUM-2213 trap below) → it would raise on every call. `org_members.role` is the `org_member_role` enum (owner/admin/member); map the UI's INDIVIDUAL/ORG_ADMIN → member/admin (owner is never assignable here).

## 2026-05-30 RPCs that read `auth.uid()` fail when called from the worker (SCRUM-2213)

- `handleListPendingResolution` (`queue-resolution.ts`) called RPC `list_pending_resolution_anchors_v2`, which resolves the caller via `SELECT … FROM profiles WHERE id = auth.uid()` and raises `'Profile not found'` otherwise. But the worker invokes RPCs through the **service-role** `db` client, where `auth.uid()` is **NULL** → the RPC raised on every call → `/api/queue/pending` returned **500** every time (Review Queue page hung on "Loading…"). A perfect index (`idx_anchors_org_status_created`) existed, so it was never a timeout — purely an auth-context mismatch.
- **Rule:** never call an `auth.uid()`-dependent RPC from the worker's service-role client. Resolve the caller's org from the authenticated userId (passed by the route via `extractAuthUserId`) and query org-scoped directly, or pass an explicit `p_user_id` into the RPC. Fix: the handler now takes `callerUserId`, resolves `profiles.org_id`, queries `anchors` org-scoped (`.eq('org_id', …).eq('status','PENDING_RESOLUTION')`), and computes `sibling_count` in TS — no `auth.uid()` dependency and no exact-count scan (the R0-8 planner-safe rule).

## 2026-05-29 Phantom-column filters silently zero out counts (SCRUM-1984)

- `admin-stats.ts` filtered `.is('deleted_at', null)` on `organizations`, which has **no** `deleted_at` column. PostgREST does not throw on a filter against a missing column — it resolves with `{ count: null, error: <column missing> }`. Under `Promise.allSettled` the promise is *fulfilled* (carrying the error), so `val(i)?.count ?? 0` collapsed to `0` and Total Orgs always showed 0 despite real orgs existing.
- Before filtering soft-deletes, confirm the table actually has `deleted_at`. `organizations` soft-deletes via `suspended`, not `deleted_at` (CLAUDE.md §1.2). `profiles` and `anchors` do have `deleted_at`.

## 2026-05-22 Anchor Write Scope Compatibility

- `apiScopes.ts` treats `anchor:write` and `write:anchors` as equivalent write-capable anchor scopes. Keep this central in `scopeSatisfies()` instead of duplicating route-specific aliases.

## 2026-05-29 Version Resolution Context

- `version-resolution.ts` exports `requireVersionOrgAdminContext`, but `index.ts` owns mounting it before `versionResolutionRouter`; keep the router itself free of implicit org-context middleware so app-level route order stays testable.

## What This Folder Contains

Express route handlers for the worker's HTTP API. Covers admin endpoints, anchor operations, proof packets, audit events, compliance, rules CRUD, treasury, and the v1/v2 versioned sub-APIs.

| File | Purpose |
|------|---------|
| `_org-auth.ts` | Shared org-auth helpers for service_role handlers (single source of truth for org_id scoping). `getCallerProfile`/`getCallerOrgId`, `isCallerOrgAdmin` (org_members owner/admin OR profile ORG_ADMIN/platform-admin), and `isUserMemberOfOrg(target, org)` (SCRUM-1863 — the cross-org gate for admin-acts-on-member flows; true if an `org_members` row OR `profiles.org_id` matches; fails closed). Each lookup also has a `*Result` variant (`getCallerOrgIdResult` / `isCallerOrgAdminResult` / `isUserMemberOfOrgResult`) returning `{ value, error }`: the boolean/string forms FAIL CLOSED (DB error → falsy), while `*Result` surfaces an operational `error` so a handler can return **500** instead of masking a fault as **403** (PR #1045 review, mirrors #1029). `isCallerOrgAdmin` now explicitly captures + logs the `org_members` lookup error it previously swallowed. Tested in `_org-auth.test.ts`. |
| `badge.ts` | Public `/api/badge/:publicId` SVG endpoint; resolves status from `get_public_anchor` and fails closed for unknown states |
| `anchor-lineage.ts` | Anchor parent/child lineage traversal endpoint |
| `anchor-revoke.ts` | Anchor revocation endpoint |
| `verify-anchor.ts` | Public anchor verification endpoint |
| `proof-packet.ts` | Proof package generation (Bitcoin TX + metadata + timestamps) |
| `proof-keys.ts` | Proof signing key management |
| `did-web.ts` | did:web identity docs — `GET /.well-known/did.json` (Arkova) + `GET /orgs/:id/.well-known/did.json` (issuing orgs). Public, no auth. Reuses the active proof key (PEM→Ed25519 JWK); org sub-DIDs are controlled by the Arkova DID. Strict org-public-id charset guard before lookup (SCRUM-1922) |
| `audit-event.ts` | Audit event creation and query |
| `admin-stats.ts` / `admin-lists.ts` / `admin-pipeline-stats.ts` | Admin dashboard data endpoints |
| `admin-org-members.ts` | Platform-admin org roster + user-search + add-member (service_role, RLS-bypass; backs the org profile UI when an admin views a non-member org) |
| `admin-actions.ts` / `admin-health.ts` | Admin action + health check endpoints |
| `rules-crud.ts` / `rules-draft.ts` | Rules engine CRUD and draft management |
| `queue-resolution.ts` | Review queue resolution endpoint |
| `rules-templates.ts` | Public rules templates discovery endpoint (SCRUM-1973). Re-exports `RULE_TEMPLATES` / `RuleTemplate` from `rule-templates-data.ts` |
| `rule-templates-data.ts` | Pure, dependency-free rule-template definitions (single source of truth). Split out of `rules-templates.ts` so non-HTTP consumers (e.g. the SCRUM-3027 DocuSign Completion auto-seed) share the canonical template shape without importing express |
| `version-resolution.ts` | Version conflict resolution API — list/resolve for org admins (SCRUM-1971) |
| `recipients.ts` | Credential recipient management |
| `treasury.ts` | Treasury balance and fee account endpoints |
| `apiScopes.ts` | API key scope definitions and validation |
| `account-delete.ts` / `account-export.ts` | GDPR account deletion and data export |
| `collision-context.ts` | Fingerprint collision context endpoint |
| `compliance-inbox-summary.ts` | Compliance inbox summary aggregation |
| `connector-health.ts` | Integration connector health status |
| `demo-event-injector.ts` | Demo/test event injection (non-production) |
| `notifications.ts` | Notification delivery endpoint |
| `rpc-error-status.ts` | RPC error → HTTP status code mapping |
| `v1/` / `v2/` | Versioned API sub-routers |

## Do / Don't Rules

- **DO** scope every cross-tenant write by `org_id` using `_org-auth.ts` helpers
- **DO NOT** expose `user_id`, `org_id`, or `anchors.id` publicly — use `public_id` only
- **DO NOT** set `anchor.status = 'SECURED'` from client code — worker-only via service_role

## `treasury.ts` — health endpoint price validation (BUG-2026-08-11)

`handleTreasuryHealth` gated on `btc_price_usd == null`, so a `-1` row (what mempool.space's
non-mainnet explorers return from `/v1/prices` with HTTP 200) produced a NEGATIVE `balance_usd`
reported as a genuine reading, with `below_threshold` true. The gate is now "usable price":
non-null, finite, and > 0. `jobs/treasury-cache.ts` no longer writes such a row, and
`jobs/treasury-alert.ts` applies the same guard — this endpoint additionally refuses to trust a
row it merely reads, so a stale row or a future writer cannot poison it.

Unchanged and still correct: the wallet leg's `createUtxoProvider({ network: config.bitcoinNetwork })`
was always per-network.

**Known gap, not fixed here:** the fee leg calls `createFeeEstimator()` without a network, and
`chain/fee-estimator.ts`'s `DEFAULT_MEMPOOL_URL` is the mainnet base — so a non-mainnet deployment
reports MAINNET fee rates. Same defect class, but the fix lands in `services/worker/src/chain/`,
which the path detector rates T3. Tracked separately rather than folded into a T2 PR.

## 2026-08-11 — that gap is now CLOSED (BUG-2026-08-11)

The "Known gap" recorded directly above is fixed. `createFeeEstimator` now takes `network?`, and
this endpoint passes `network: config.bitcoinNetwork`, so both legs of the treasury status response
are per-network again.

The paragraph above is left intact rather than edited: `agents.md` is **append-only**
(`scripts/ci/check-agents-md-append-only.ts`), and rewriting it in place is what failed that gate on
the PR carrying this fix. Correcting the record means appending the correction, not erasing the
thing that was true at the time.

Rule for this folder: **any `create*` factory that builds a mempool.space URL must be handed
`config.bitcoinNetwork` explicitly.** The two defects here — the wallet leg's balance bug and the
fee leg's rate bug — were both "call site omitted the network, factory defaulted to something".

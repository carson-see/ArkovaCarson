# UAT-03: separate Arkova confirmation after OAuth

Story: [SCRUM-4035](https://arkova.atlassian.net/browse/SCRUM-4035).
Specification/test plan/pre-mortem: [Confluence 137297921](https://arkova.atlassian.net/wiki/spaces/A/pages/137297921).
Source: [founder UAT document](https://docs.google.com/document/d/1RTXrw_9eKR4JHkGGCqzA_EBO_ZUFTHUlwVf5VsnS7Sk/edit).

Status: candidate implementation; activation and release evidence are outstanding. Google confirming
its own email claim does not satisfy the separate Arkova confirmation required by this story.

## Behavior and authority

New OAuth accounts created at/after a server activation timestamp receive a sticky private enrollment.
The Auth access-token hook assigns `arkova_email_pending` until the account consumes an Arkova-issued
mailbox challenge. Existing accounts are grandfathered. An unconfirmed email signup converted by Google
enrolls on the trusted provider transition; previously confirmed email accounts retain compatibility.
Mutable user metadata, later password/OTP/MFA authentication, and provider unlinking cannot clear an
existing pending record. Auth-user enrollment runs before the existing automatic domain join trigger.

The app callback and protected-route guard send pending sessions to `/signup`. The user sees sending,
sent, failure, and resend cooldown states. Links expire after 15 minutes; resend claims serialize a
90-second window. A link requires an explicit confirm action before it can switch a browser account.
The existing onboarding flow resumes only after the refreshed JWT is no longer pending.

Worker normal authentication rejects the pending token terminally across HS256, JWKS and getUser
fallback. A separate identity verifier exists only for `GET /api/auth/email-confirmation` and its
`POST /send` child. The anonymous `POST /complete` endpoint derives identity from the issued challenge
and actual Supabase `verifyOtp(type: 'magiclink')` result. No new SDK registration or MCP tools are
introduced. API/SDK key minting and integration setup remain behind the existing worker verifier;
hosted MCP and the other edge JWT helper enforce the same pending role denial. Existing service keys
and signed inbound webhooks keep their service authorization semantics.

The pending role is not granted to PostgREST/authenticator or Storage roles. The Data API cannot SET
ROLE, including to call PUBLIC-executable SECURITY DEFINER functions. Private Storage ACLs deny the
role. Realtime uses a superuser connection in production: role membership alone does not deny it.
Independent role tests show private messages denied by ACL and CDC INSERT/UPDATE omit protected row
values; wildcard DELETE can expose table/event metadata without row values. The production publication
currently has zero tables. Public buckets and public Broadcast/Presence remain public. Hosted HTTP and
WebSocket positive/negative controls still belong to the release gate.

## Mailbox proof and failure boundaries

Only the service role can call `manage_oauth_email_confirmation`. Its row lock serializes claims and
completion with current `auth.users.email`; expiry is reevaluated after lock waits. Raw Supabase token
hashes appear only in email and transient request memory; the database stores SHA-256 digests. The
fragment is stripped before Supabase and telemetry initialize, with error/URL/navigation redaction tests.
No send response exposes the bearer link. A skipped dev email is a delivery failure, not “sent”.

Auth verification and refresh use fresh Supabase clients. Calling either on the shared service-role
client would replace its next PostgREST Authorization with the user's token even with persistence off.
An upstream proof consumed before a failed SQL completion requires a fresh email; generic OTP AMR does
not repair it. A completed SQL record with a lost refresh response recovers through an existing session
refresh or a fresh sign-in. Replayed links never yield another session. Domain association is deferred
until proof and is idempotent. Its pre-existing domain-selection behavior is preserved: this change does
not implement UAT-17's separate verified-domain requirement. The copied function body was compared
read-only with production and matched exactly after removing the new pending guard.

## Test plan and pre-mortem closure

- Real PostgreSQL: cohort boundary; unconfirmed email -> Google; confirmed email compatibility; sticky
  enrollment; restricted RPC/role grants; full baseline auth-trigger ordering; no membership before
  proof and exactly one after; cooldown; expiry; email change; replay.
- Real GoTrue + candidate SQL/hook: valid pending login/getUser/refresh; stored user role differs from
  signed token; direct ordinary magiclink stays pending; issued proof then atomic completion; replay
  denied; final refresh becomes authenticated. Owned native ports 55003/55503 only.
- Worker: HS256 and ES256 verification, terminal fallback denial, forged proof, caller identity/email
  override, provider mismatch, no token disclosure, cooldown, provider failure, expiry/replay, consumed
  proof + failed DB, completed DB + lost refresh. Edge signed negative/positive controls.
- UI: all callback events, protected content never mounted, capture/redaction, automatic delivery,
  failed delivery, cooldown, explicit account switch, sign-out failure, refresh still pending, safe
  malformed/offline transport recovery. Existing auth/email/URL suites and builds remain required.

Pre-mortem risks addressed: browser-only bypass, getUser role mismatch, PUBLIC RPC grants, early org
association, identity/provider transition gap, service-client session contamination, token telemetry,
email-change TOCTOU, token replay, split-system failure, and stale ordinary JWTs during rollout.
Local fixtures are not hosted Google consent, actual email receipt, or production release proof.

## Deployment and rollback gates

1. Reconcile PR #2589's ES256 edge implementation and PR #2637's MFA guard with this pending-role
   policy at the final merged commit. Regenerate public types from the committed full local ledger and
   pass CI. Reserve migration 0436 against main, open PRs, all worktrees and production ledger.
2. On an owned isolated T3 environment, apply migration with `enabled_at = NULL`, deploy compatible
   worker/edge/app code, and verify positive and negative product paths, cross-device email completion,
   real email receipt, expiry, resend, account switching and rollback at the exact candidate commit.
3. Read the existing hosted custom access-token-hook configuration and compose any existing behavior.
   Production `/config/auth` returned 403 during this work; its current hook is UNKNOWN. Never replace
   an unknown hook. Provider/domain configuration belongs to UAT-02 and may change JWT issuer handling.
4. Install and verify the hook while enrollment remains disabled. Then set `enabled_at` to current
   server `clock_timestamp()`. Do not backdate: accounts that received pre-hook ordinary JWTs are
   deliberately grandfathered. Confirm hook propagation before activation.
5. Operational rollback disables NEW enrollment by setting the timestamp NULL. Retain the hook,
   pending role, worker and edge role denials, and confirmation endpoints until pending users have an
   explicit recovery policy. Old worker code accepts pending tokens through getUser; reverting to it
   is not a safe rollback. Do not drop pending state to make deployment easier.
6. Keep SCRUM-4035 In Progress until hosted release evidence proves the user flow and enforcement.

The `.env.example` removal of `VITE_BETA_INVITE_CODE` is the assigned SCRUM-4031 documentation cleanup.
The actual beta form removal belongs to PR #2653; this branch does not claim that UI change.

## Browser integration evidence

Seven cases run against the actual App/PublicOnly/AuthGuard/signup components with external Auth/worker boundaries mocked. Pending users reach signup before any profile query; a confirmed token resumes profile loading and existing onboarding. Normal authenticated signup/login routes preserve their destination. Recovery clears local auth before navigating to the actual login form. Desktop 1280px and mobile 375px captures show all actions with no horizontal overflow. Run `node_modules/.bin/playwright test --config playwright.uat03.config.ts`; CI invokes this dedicated fixture before hosted-stack setup and uploads screenshots. These UI mocks complement, but do not replace, the real local GoTrue/SQL and required hosted release evidence.

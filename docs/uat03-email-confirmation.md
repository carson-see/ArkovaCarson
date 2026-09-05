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
   The initial 403 was resolved by the release-review User-Agent: root read production and owned
   preview Auth configuration successfully on 2026-09-05. Both custom access-token hooks are disabled
   with URI NULL; no existing hook behavior needs composition at that read. Recheck before installation.
   Provider/domain configuration belongs to UAT-02 and may change JWT issuer handling.
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

## Guarded hosted driver

`python3 scripts/staging/uat03_mailbox_driver.py --manifest <owned-manifest.json>` defaults to a no-network dry run. The manifest contains only `kind` (`preview` or `standalone`), `projectRef`, `workerUrl`, `appUrl`, exact `head`, and the reviewed `hookUri`; preview additionally requires the independently identified `branchId`. Only PR2655's exact preview or the planned named standalone project can pass identity checks. Production/shared references and arbitrary worker URLs are rejected. Execution also compares committed driver bytes, hosted project identity, enabled reviewed hook configuration and `/health` head before creating fixture users.

`--execute --evidence-out <artifact.json>` runs actual GoTrue and worker requests with real mailbox receipt. Default `--mailbox-mode stdin` prints only the unique recipient, app origin and issue time, then accepts one JSON line (`recipient`, `appOrigin`, `receivedAtMs`, `messageId`, `token`) from the operator Gmail adapter. The adapter must retrieve that exact newly received test email and verify its link origin; the runner validates those metadata bindings and disables PTY echo before input. Optional `--mailbox-mode imap` reads the mailbox directly. Required environment: `STAGING_SUPABASE_SERVICE_ROLE_KEY`, `STAGING_SUPABASE_ANON_KEY`, `SUPABASE_ACCESS_TOKEN`, `UAT03_TEST_MAILBOX` (owned mailbox supporting plus aliases, currently Carson’s `carson@arkova.ai` via Gmail). Only IMAP mode additionally requires `UAT03_IMAP_HOST`, `UAT03_IMAP_USER`, `UAT03_IMAP_PASSWORD`. Cloud Run IAM comes from captured `gcloud auth print-identity-token`; optional `STAGING_GCP_IDENTITY` is limited to short runs. Credentials, mailbox links and provider response bodies are never written to evidence.

The runner checks pending/ordinary Auth and Data API behavior, key-mint denial versus ordinary request validation, real resend timing, superseded proof, concurrent completion, replay, old pending-session denial and refreshed access, changed email, and actual 15-minute expiry. `--duration-minutes 2880` repeats pending/ordinary authorization controls after that sequence. Fixtures are OAuth-shaped admin-created test identities, so this is not a Google consent roundtrip. Cleanup deletes only the Auth IDs created in this run. Evidence always leaves `hostedReleaseComplete` false: hosted browser account switching, Storage/Realtime/MCP protocol controls, rollback, full CI and independent release approval remain explicit gates. The driver never provisions infrastructure, installs hooks or changes enrollment policy. It has not been executed against hosted services.

## Hosted role-creation compatibility

Hosted PostgreSQL17 creates an administration-only membership for its non-superuser `postgres` migration principal: grantor `supabase_admin`, ADMIN true, SET false, INHERIT false. A rollback-only preview probe confirmed that difference from the native superuser fixture. The guard permits only that grant to the current CREATEROLE/BYPASSRLS migration principal from a superuser grantor; runtime members, parent roles and elevated pending-role attributes remain rejected. Missing membership-option columns on PostgreSQL15 do not satisfy the exception. Sixteen SQL cases now include superuser and hosted-style non-superuser creation plus authenticator/authenticated and parent-role rejection. See PostgreSQL's [role attribute documentation](https://www.postgresql.org/docs/17/role-attributes.html).

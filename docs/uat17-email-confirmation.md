# UAT-17 email confirmation release plan (SCRUM-5145)

## Scope and current evidence

The email/password signup UI previously called `auth.signUp` a second time when the user selected resend, provided no cooldown, reported no outcome, and claimed a 24-hour lifetime. Production read-only configuration observed on 2026-09-14 has Arkova SMTP and an Arkova-branded confirmation template, `mailer_otp_exp=3600`, `smtp_max_frequency=1`, and the separate aggregate quota `rate_limit_email_sent=30`.

This change uses the supported `auth.resend({ type: 'signup' })` endpoint, keeps `/auth/callback`, shows a 90-second countdown, reports success only after Auth accepts the request, and aligns local Auth with a 900-second link lifetime and 90-second minimum interval. Existing callback tests cover healthy, expired, tampered, and consumed-link-with-session paths. A real SQL regression covers domain membership only after mailbox verification; existing MFA tests keep mailbox confirmation ahead of MFA.

Google's OAuth consent screen currently identifies the Supabase project host. That is tracked separately from the Arkova confirmation email template and remains a release dependency for the Google path. Organization invitations remain owned by the active invitation delivery work and are not changed here.

## Hosted configuration operation

Do not deploy the frontend copy before the hosted Auth settings match. On the exact approved staging project, capture the existing Auth configuration through `GET /v1/projects/{ref}/config/auth`, retaining only a protected rollback record. Confirm the target is not production, then apply this exact Management API delta:

```json
{
  "mailer_otp_exp": 900,
  "smtp_max_frequency": 90
}
```

Read the configuration back and require all three values before UAT:

```json
{
  "mailer_otp_exp": 900,
  "smtp_max_frequency": 90,
  "rate_limit_email_sent": 30
}
```

`rate_limit_email_sent` is the aggregate hourly email quota and must remain 30. `smtp_max_frequency` is the per-user minimum interval in seconds. If any validation fails, restore `mailer_otp_exp` and `smtp_max_frequency` from the captured pre-change record and verify the readback. The observed production baseline is `3600` and `1`, but rollback must use the target environment's captured values rather than assume those values.

## Staging UAT and soak

Use the owned isolated `arkova-soak-uat17-0914` project and unique Resend delivered-test recipients under the single verified `resend.dev` fixture organization. Record timestamps and status/booleans only; keep tokens, message bodies, addresses, and credentials out of artifacts. The executable driver is `scripts/staging/uat17_email_confirmation_driver.py`; it is a dry run unless passed `--apply`, rejects production and shared project references, and requires the exact candidate SHA in its manifest.

1. Confirm the target app SHA, project ref, Arkova sender name/address, Arkova subject/template, and the three configuration values above.
2. Create an email/password account. Require no session before verification, one branded confirmation message, no vendor-facing copy, and a callback URL on the target app origin.
3. Attempt resend before 90 seconds. Require the UI countdown and server refusal; no success message may appear.
4. At 90 seconds, resend once. Require Auth success, a fresh branded message, and a reset 90-second countdown.
5. Before user creation, read the deployed `auth.users` trigger catalog and require enabled `on_auth_user_created` plus `zz_auth_user_auto_associate_org` entries wired to the expected functions. The driver uses the Management query API and can fall back to `psql` through a validated `UAT17_DATABASE_URL` if that endpoint is unavailable. Open a fresh confirmation link before 15 minutes. Require `/auth/callback` to establish the expected-user session, prove that membership was absent before confirmation, auto-associate exactly the fixture organization once after mailbox verification, and route the confirmed account into mandatory MFA. This hosted step proves deployed trigger wiring; the local SQL test recreates those triggers transactionally because the squashed local baseline omits Auth-schema triggers.
6. Revisit the consumed link in the same browser. Require the existing session to continue without a false expired-link screen.
7. With a second disposable account, retain the unconsumed link for 905 seconds from signup and require Auth to return `otp_expired`; require that account to remain unconfirmed and without organization membership. The browser pass must also show the expired-link explanation and route to request a new link.
8. Repeat the success path once at 1280px and once at 375px. Check that the email address wraps, the countdown/button remain visible, status and error announcements are accessible, and no console or network errors appear.
9. Verify Auth soft deletion, removed memberships and deactivated profiles for both synthetic users; preserve immutable audit history. Run the full two-account, 905-second scenario periodically for at least 24 hours, with 60 seconds between cycles. Three emails per cycle stays below 12 emails per hour and preserves the separate hourly limit of 30. Stop on cleanup failure, source/deployment/project drift, duplicate membership, early expiry, resend acceptance before 90 seconds, wrong callback origin/account, MFA bypass, vendor-facing email copy, or a misleading success/error state.

The tracked `scripts/staging/uat17_email_soak_supervisor.py` enforces that window and cadence with a PID/file lock. Its manifest adds `frontendContentSha256` for the immutable preview root response plus the exact `workerRevision`, `workerImageDigest`, worker URL, region, and GCP project for the isolated `arkova-worker-uat17-0914-staging` service. Before every cycle it requires the committed source SHA, a clean tracked worktree, the same frontend content, the ready Cloud Run revision at 100% traffic, its controller-observed image digest and source-head label, `/health.git_sha`, and the exact owned Supabase project identity. It records initial and final `/health.uptime`, fails on any decrease or restart, and can pass only after both 24 wall-clock hours and 86,400 seconds of observed worker uptime. An absolute executable credential helper must return the Auth/Resend credentials, a fresh GCP access token, and a fresh worker identity token as a JSON object on stdout. The supervisor refreshes it for every cycle, keeps the values in memory, and ignores unrecognized fields; the worker health request supplies the identity token through `X-Serverless-Authorization`. It writes an initial summary before the first 905-second probe, then each cycle writes the driver's redacted JSON and updates the summary. Any failed check, unexpected error, or drift stops the soak with a sanitized failure code.

Create the ignored run directory, then launch the committed supervisor through the repository's double-fork helper so it survives the operator shell:

```bash
mkdir -p artifacts/uat17-email/uat17-20260914
python3 scripts/staging/soak-harness/detach.py \
  artifacts/uat17-email/uat17-20260914/supervisor.log \
  python3 scripts/staging/uat17_email_soak_supervisor.py \
  --manifest /absolute/protected/path/uat17-manifest.json \
  --run-id uat17-20260914 \
  --credentials-helper /absolute/protected/path/refresh-uat17-credentials \
  --duration-hours 24 --interval-seconds 60 --browser-first-cycle --apply
```

The initial cycle can require the real hosted browser helper. Later cycles repeat the SMTP, resend, expiry, trigger, membership, MFA API gate, consumed-link, and cleanup checks without storing confirmation links or fixture addresses.

Production remains unchanged until review, staging evidence, and a separately approved configuration operation are complete.

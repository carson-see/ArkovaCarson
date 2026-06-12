# OAuth State HMAC Secret Rotation (D3)

**Status:** code remediation COMPLETE — Drive (SCRUM-1236), GRC (SCRUM-1238), and DocuSign org + member (this PR / 2026-04-24 finding H1) all fail closed. `INTEGRATION_STATE_HMAC_SECRET` is now MANDATORY in production when `ENABLE_DRIVE_OAUTH` or `ENABLE_DOCUSIGN_OAUTH` is true — provision it via the steps below.
**Discovered:** 2026-04-24 forensic security audit (finding H1)
**Affects:** Drive OAuth, DocuSign OAuth (org + member), GRC OAuth (any integration that signs `state` in the OAuth flow)

## Background — the vulnerability (now remediated in code)

`getStateSecret()` in the OAuth routers **previously fell back to `config.supabaseJwtSecret`** (and ultimately `config.supabaseServiceKey`) when `INTEGRATION_STATE_HMAC_SECRET` was unset — i.e. it failed OPEN.

- `supabaseJwtSecret` is the secret Supabase Auth uses to sign every user JWT.
- Reusing it as the OAuth state HMAC secret meant:
  1. If `supabaseJwtSecret` ever leaks, every OAuth state token is forgeable.
  2. Rotation is impossible — rotating the JWT secret invalidates every active user session.
  3. Two trust boundaries (user-auth and OAuth-CSRF) collapse into one.

The code now **fails closed**: `resolveStateSecret()` in `drive-oauth.ts`, `docusign-oauth.ts`, and `docusign-member-oauth.ts` requires the dedicated `INTEGRATION_STATE_HMAC_SECRET` (no JWT/service-role fallback) and throws when it is unset; `config.ts` additionally rejects boot in production when an OAuth flow is enabled without it. The operational task that remains is **provisioning** the secret.

## What rotating fixes

- Forces the OAuth state path to use a dedicated secret with its own rotation cadence.
- Removes the JWT-secret-reuse blast radius.
- Closes the H1 audit finding.

## UX cost

**Per connected org per integration: one re-OAuth click.** Nothing destructive. Existing tokens stay valid (this rotation only affects state validation on new connects).

## Step-by-step (Carson does this)

### 1. Generate a new secret

```bash
# 256-bit random, base64-url encoded — what crypto.createHmac('sha256') wants
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Copy the output. Don't lose it (it gets pasted into Secret Manager next).

### 2. Add to GCP Secret Manager

```bash
# Replace <NEW_SECRET> with what you just generated
echo -n "<NEW_SECRET>" | gcloud secrets create INTEGRATION_STATE_HMAC_SECRET \
  --project=arkova1 \
  --replication-policy=automatic \
  --data-file=-
```

Or if it already exists (it shouldn't, but just in case):
```bash
echo -n "<NEW_SECRET>" | gcloud secrets versions add INTEGRATION_STATE_HMAC_SECRET \
  --project=arkova1 \
  --data-file=-
```

### 3. Grant the worker's service account access

```bash
gcloud secrets add-iam-policy-binding INTEGRATION_STATE_HMAC_SECRET \
  --project=arkova1 \
  --member="serviceAccount:270018525501-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### 4. Update Cloud Run worker to read the new secret

```bash
gcloud run services update arkova-worker \
  --region=us-central1 \
  --project=arkova1 \
  --update-secrets=INTEGRATION_STATE_HMAC_SECRET=INTEGRATION_STATE_HMAC_SECRET:latest
```

This adds the secret as an env var. The worker reads it via `resolveStateSecret()` in `drive-oauth.ts`, `docusign-oauth.ts`, and `docusign-member-oauth.ts`. There is **no fallback** — if `ENABLE_DRIVE_OAUTH` or `ENABLE_DOCUSIGN_OAUTH` is true in production and this secret is absent, config validation fails the worker at boot (fail-closed).

### 5. Verify the worker picked it up

```bash
gcloud run services describe arkova-worker \
  --region=us-central1 \
  --project=arkova1 \
  --format='value(spec.template.spec.containers[0].env[].name)' | grep INTEGRATION_STATE
```

Should print `INTEGRATION_STATE_HMAC_SECRET`.

Then check the deployed revision is using it:
```bash
curl -s https://arkova-worker-270018525501.us-central1.run.app/health
```
Status should be `healthy`. (The health check doesn't probe this secret directly, but if the new revision can't load env vars it crashes on startup.)

### 6. Test an OAuth flow end-to-end

(Once D2 kill-switch PR #527 is merged AND `ENABLE_DRIVE_OAUTH=true` is set):
1. Connect Drive from an org admin account
2. Confirm callback succeeds and integration shows "connected"
3. Disconnect
4. Reconnect
5. Confirm both flows complete without `invalid_state` errors

### 7. Audit the rotation

In Supabase, run:
```sql
SELECT count(*) FROM org_integrations WHERE revoked_at IS NULL;
```

That's the count of orgs that will need to re-OAuth ONCE if their state token is mid-flight when this rotates. Practically zero — state tokens have a 10-min TTL and most flows complete in seconds.

## Rollback

> ⚠️ **Do NOT roll back by removing the secret.** Since the code now fails closed,
> `--remove-secrets=INTEGRATION_STATE_HMAC_SECRET` will break the worker at boot
> in production whenever `ENABLE_DRIVE_OAUTH` or `ENABLE_DOCUSIGN_OAUTH` is true
> (and fails every OAuth `start`/`callback` even when those flags are off). There
> is no `supabaseJwtSecret` fallback anymore.

If a *new* secret value breaks something (e.g. a bad rotation), roll forward to a
known-good secret version instead:
```bash
# Re-point the worker at the previous good version (replace N)
gcloud run services update arkova-worker \
  --region=us-central1 \
  --project=arkova1 \
  --update-secrets=INTEGRATION_STATE_HMAC_SECRET=INTEGRATION_STATE_HMAC_SECRET:N
```

If you must take the OAuth flows offline entirely, set `ENABLE_DRIVE_OAUTH=false`
and `ENABLE_DOCUSIGN_OAUTH=false` (the `/google_drive` and `/docusign` routes
then return 503 via the kill switch) — do not remove the HMAC secret. To revert
the *code* behavior, roll the Cloud Run worker back to the prior revision.

## Follow-up code change — DONE

The follow-up PR work is complete:
1. ✅ Removed the `?? config.supabaseJwtSecret` fallback in the OAuth state path — Drive (SCRUM-1236), DocuSign org + member (this PR). Member OAuth previously hardcoded `stateSecret: config.supabaseJwtSecret` in its eager export; that is gone.
2. ✅ Throws at startup if `INTEGRATION_STATE_HMAC_SECRET` is unset in `production` mode when an OAuth flow is enabled (`config.ts` cross-field guard) — and `resolveStateSecret()` fails closed at router construction.
3. ✅ `docs/reference/ENV.md` documents the env var as required.

This work is part of the Integration Hardening epic.

## Why we couldn't fully automate this

- I (Claude) don't have permission to create GCP secrets or update Cloud Run env in this session.
- The actual secret value should never pass through Claude / chat / git.
- This runbook is the safe handoff.

# OAuth State HMAC Secret Rotation (D3)

**Status:** action required by Carson
**Discovered:** 2026-04-24 forensic security audit (finding H1)
**Affects:** Drive OAuth, DocuSign OAuth, GRC OAuth (any integration that signs `state` in the OAuth flow)

## What's wrong today

`getStateSecret()` in `services/worker/src/api/v1/integrations/drive-oauth.ts:73` and `docusign-oauth.ts:74` **falls back to `config.supabaseJwtSecret`** when `INTEGRATION_STATE_HMAC_SECRET` is unset.

- `supabaseJwtSecret` is the secret Supabase Auth uses to sign every user JWT.
- Reusing it as the OAuth state HMAC secret means:
  1. If `supabaseJwtSecret` ever leaks, every OAuth state token is forgeable.
  2. Rotation is impossible — rotating the JWT secret invalidates every active user session.
  3. Two trust boundaries (user-auth and OAuth-CSRF) collapse into one.

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

This adds the secret as an env var. The worker code already reads it in `drive-oauth.ts:73` and `docusign-oauth.ts:74` — the fallback to `supabaseJwtSecret` is only used when the env var is absent.

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

If this breaks something:
```bash
gcloud run services update arkova-worker \
  --region=us-central1 \
  --project=arkova1 \
  --remove-secrets=INTEGRATION_STATE_HMAC_SECRET
```

The code falls back to `supabaseJwtSecret` (current behavior). Re-investigate before re-attempting.

## Follow-up code change (separate PR)

After this rotation completes, file a follow-up PR that:
1. Removes the `?? config.supabaseJwtSecret` fallback in `getStateSecret()` for Drive and DocuSign.
2. Throws at startup if `INTEGRATION_STATE_HMAC_SECRET` is unset in `production` mode.
3. Adds the env var to `docs/reference/ENV.md` as required.

This PR exists as part of the Integration Hardening epic.

## Why we couldn't fully automate this

- I (Claude) don't have permission to create GCP secrets or update Cloud Run env in this session.
- The actual secret value should never pass through Claude / chat / git.
- This runbook is the safe handoff.

# SEC-HARDEN-01 — Rotate Google API key + split Stitch vs general-GCP scopes

**Jira:** [SCRUM-1054](https://arkova.atlassian.net/browse/SCRUM-1054)
**Parent epic:** [SCRUM-1041 SEC-HARDEN](https://arkova.atlassian.net/browse/SCRUM-1041)
**Severity:** High. Key `AQ.Ab8RN6I1LY9…` was posted in chat (2026-04-23) and has been treated as compromised ever since.
**Executor:** Carson (human — requires GCP console access).
**Status:** Runbook documented, rotation pending.

---

## Why a runbook (not an automated fix)

Per `memory/feedback_worker_hands_off.md`, Cloud Run + API key management is human-only. This doc describes the exact clicks the rotation requires so the work is reproducible and auditable.

---

## Current state (2026-04-23)

One overscoped key. Usage grep:

```bash
# Scan repo for residual hardcoded references (the old key was never checked in,
# but re-grep to confirm before rotation).
rg -l 'AQ\.Ab8RN6I1LY9' || echo "clean"

# Find every env var that references a Google API key.
rg -n 'GOOGLE_API_KEY|GEMINI_API_KEY|STITCH_API_KEY' --type ts --type yml
```

Expected: `GEMINI_API_KEY` referenced in `services/worker/src/ai/gemini.ts`, `services/worker/src/ai/embeddings.ts`; Cloud Build + Cloud Run deploy workflows consume it via `--set-secrets`.

---

## Target state

Two scoped keys in GCP Secret Manager:

| Secret Manager path | Purpose | API restrictions |
|---|---|---|
| `projects/arkova1/secrets/google-api-key-stitch` | Stitch (UI / design tooling) | Stitch APIs only |
| `projects/arkova1/secrets/google-api-key-general` | Gemini AI + any other general-GCP API-key access | Generative Language API, Vertex AI API, others as needed — explicitly NOT Stitch |

**Stretch goal (out of scope for this story):** move `GEMINI_API_KEY` callers to Vertex AI service-account auth via GEMB2-02/03. After that, the `google-api-key-general` key rotates to read-only fallback only.

---

## Rotation procedure (human-executed)

### 0. Preconditions

- `gcloud auth application-default login` with an Owner role on project `arkova1`.
- Confirm the project ID: `gcloud config get-value project` → `arkova1` (see `reference_gcp_project.md`).
- Snapshot the current deployed worker revision so you can roll back cleanly: `gcloud run services describe arkova-worker --region us-central1 --format=value\(status.url,status.latestReadyRevisionName\)`.

### 1. Create the two new scoped keys (GCP Console)

APIs & Services → Credentials → **Create Credentials → API Key** ×2.

- Key 1 name: `arkova-stitch-key-2026-04`. API restrictions → select Stitch API only. HTTP referrer restrictions: `https://arkova.ai/*`, `https://arkova-26.vercel.app/*`.
- Key 2 name: `arkova-general-key-2026-04`. API restrictions → Generative Language API, Vertex AI API. Application restriction: None (Cloud Run SA ingress only).

### 2. Store both in Secret Manager

Use the GCP console (**Secret Manager → Create Secret**) and paste the fresh key value there, or feed via stdin from `read -s` so the value never appears in shell history / docs:

```bash
# Paste new stitch key when prompted (stdin, never inline):
read -s STITCH_KEY_FROM_CONSOLE
printf '%s' "$STITCH_KEY_FROM_CONSOLE" | \
  gcloud secrets create google-api-key-stitch \
  --replication-policy=automatic --data-file=-
unset STITCH_KEY_FROM_CONSOLE

read -s GENERAL_KEY_FROM_CONSOLE
printf '%s' "$GENERAL_KEY_FROM_CONSOLE" | \
  gcloud secrets create google-api-key-general \
  --replication-policy=automatic --data-file=-
unset GENERAL_KEY_FROM_CONSOLE

gcloud secrets add-iam-policy-binding google-api-key-stitch \
  --member=serviceAccount:270018525501-compute@developer.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor

gcloud secrets add-iam-policy-binding google-api-key-general \
  --member=serviceAccount:270018525501-compute@developer.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor
```

### 3. Wire Cloud Run to the new general-key secret

Update `.github/workflows/deploy-worker.yml` (or the equivalent deploy command) to add:

```yaml
--set-secrets=GEMINI_API_KEY=google-api-key-general:latest
```

Remove any existing `--set-env-vars=GEMINI_API_KEY=...` line.

Trigger a deploy via a no-op commit to main, or run:

```bash
gcloud run services update arkova-worker --region us-central1 \
  --set-secrets=GEMINI_API_KEY=google-api-key-general:latest
```

Verify: `gcloud run services describe arkova-worker --region us-central1 --format='yaml(spec.template.spec.containers[0].env)'` — look for the secret reference, not a plain value.

### 4. Stitch consumers

Stitch usage is currently limited to design / internal tooling. Update the consumer to read from `google-api-key-stitch` (path TBD — check with the design tooling owner before the rotation; do NOT assume).

### 5. Revoke the old key

APIs & Services → Credentials → select the prior over-scoped key (prefix `AQ.Ab8RN` per ops memory) → **Delete**. Confirm the prompt. Once deleted the key cannot be recovered.

### 6. Verify the rotation took

- Hit a Gemini endpoint from the worker:

  ```bash
  curl -sS https://arkova-worker-270018525501.us-central1.run.app/health
  ```

  then trigger any job that calls Gemini (e.g. `/jobs/test-gemini-extract`) and confirm 200.
- Hit a Gemini endpoint with the OLD key to confirm it's gone:

  Use the placeholder token from your shell history (`history | grep x-goog-api-key`) — not pasted in this runbook — and curl the models list endpoint. Expect HTTP 403 within 5 minutes of the delete.

### 7. Update ENV.md

Add entries pointing consumers at the two new Secret Manager paths.

### 8. Log rotation date

Append to `docs/runbooks/key-rotations.md` (create if absent) with date, operator, reason, and post-rotation verification notes.

---

## Rollback

If the new Gemini key doesn't work:

- Cloud Run: `gcloud run services update-traffic arkova-worker --to-revisions=<previous-revision>=100` (use the revision captured in step 0).
- Do NOT roll back by un-deleting the old key — Google Cloud does not support key un-deletion. You must issue a new key and repeat steps 1–3.

---

## Acceptance (Jira)

- [ ] Old key no longer appears in any config / env / secret. Verify with the pre-rotation grep run post-rotation — should still return "clean".
- [ ] Two new scoped keys in Secret Manager (paths above).
- [ ] GCP API restrictions verified on both keys.
- [ ] Rotation date logged in `docs/runbooks/key-rotations.md`.
- [ ] Confluence "SEC-HARDEN-01" page updated with completion notes.

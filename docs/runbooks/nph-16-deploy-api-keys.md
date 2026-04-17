# NPH-16 — Deploy Missing API Keys to Cloud Run

> **Story:** SCRUM-728 — Deploy OpenStates, SAM.gov, and CourtListener keys.
> **Priority:** P0 — three public-record fetchers produce 0 rows in prod until this is done.
> **Risk:** Low. Only adds environment variables; no code change, no migration, no traffic impact.
> **Rollback:** `gcloud run services update … --remove-env-vars=OPENSTATES_API_KEY,SAM_GOV_API_KEY,COURTLISTENER_API_TOKEN`.

---

## 1. Why this is blocking

Three fetchers are deployed to `arkova-worker-270018525501.us-central1.run.app` but they silently no-op because their API keys are not set in Cloud Run env vars.

| Fetcher | Endpoint | Status today |
|---------|----------|--------------|
| OpenStates — state bills | `POST /jobs/fetch-state-bills`, `POST /jobs/fetch-all-state-bills` | `{inserted:0, skipped:0, errors:0}` on every call |
| SAM.gov — federal contractors | `POST /jobs/fetch-sam-entities`, `POST /jobs/fetch-sam-exclusions` | `{inserted:0, skipped:0, errors:0}` on every call |
| CourtListener — court opinions | `POST /jobs/fetch-courtlistener` | 24,714 rows from prior runs; recent runs fail silently locally (`{errors:1}`), prod status untested |

Evidence source: 2026-04-14 pipeline audit in CLAUDE.md.

---

## 2. Prerequisites

- [ ] Register for **OpenStates API key** (free) — https://openstates.org/api/register/
- [ ] Register for **SAM.gov API key** (free) — https://api.sam.gov/prod/registrations/v1/ (requires SAM.gov login)
- [ ] Obtain a current **CourtListener API token** — https://www.courtlistener.com/profile/api/. Previous token may be expired; generate a new one if the existing one fails verification in §3.
- [ ] `gcloud` CLI installed + authenticated against project `arkova1`
- [ ] IAM role `roles/run.admin` on the Cloud Run service (or `roles/owner`)
- [ ] Terminal access to this repo (to run `scripts/ops/verify-public-record-keys.ts`)

---

## 3. Verify keys locally (before production deploy)

Run the verification script. It makes one read-only request per provider and confirms the key is accepted without writing to any DB.

```bash
cd /Users/carson/Desktop/arkova-mvpcopy-main/services/worker
OPENSTATES_API_KEY=... \
SAM_GOV_API_KEY=... \
COURTLISTENER_API_TOKEN=... \
  npx tsx scripts/ops/verify-public-record-keys.ts
```

Expected output (one line per provider):

```
[openstates] ✅ key accepted (HTTP 200) — fetched N results
[sam.gov] ✅ key accepted (HTTP 200)
[courtlistener] ✅ token accepted (HTTP 200) — fetched N opinions
```

If any provider reports a non-2xx response:

- **401 / 403** — key or token is invalid / expired. Regenerate and retry.
- **429** — rate-limited. Wait and retry; not fatal for validation.
- **Network error** — retry from a different network or increase the timeout. Do NOT deploy until all three show ✅.

---

## 4. Deploy the env vars to Cloud Run

**Do this only after §3 shows all three providers ✅.** Copy-paste the command below in a terminal where the keys are shell variables (never persist them to shell history).

```bash
gcloud run services update arkova-worker \
  --project=arkova1 \
  --region=us-central1 \
  --update-env-vars=\
"OPENSTATES_API_KEY=$OPENSTATES_API_KEY,\
SAM_GOV_API_KEY=$SAM_GOV_API_KEY,\
COURTLISTENER_API_TOKEN=$COURTLISTENER_API_TOKEN"
```

The service will roll out a new revision. Wait for `gcloud run services describe` to show the new revision as `traffic: 100%` before continuing.

Prefer Google Secret Manager if keys must survive re-creation of the Cloud Run service — see §7.

---

## 5. Smoke-test each fetcher in production

```bash
WORKER=https://arkova-worker-270018525501.us-central1.run.app
CRON_SECRET=...  # shared-secret used to authenticate cron endpoints

# OpenStates
curl -s -X POST "$WORKER/jobs/fetch-state-bills" \
  -H "Authorization: Bearer $CRON_SECRET"
# expected: {"inserted": >0, "skipped": any, "errors": 0}

# SAM.gov (entities)
curl -s -X POST "$WORKER/jobs/fetch-sam-entities" \
  -H "Authorization: Bearer $CRON_SECRET"
# expected: {"inserted": >0, ...}

# SAM.gov (exclusions)
curl -s -X POST "$WORKER/jobs/fetch-sam-exclusions" \
  -H "Authorization: Bearer $CRON_SECRET"

# CourtListener
curl -s -X POST "$WORKER/jobs/fetch-courtlistener" \
  -H "Authorization: Bearer $CRON_SECRET"
# expected: {"inserted": >=0, "errors": 0}
```

If any response still has `inserted:0, errors:0` **and** the count is supposed to be non-trivial, that provider's new key isn't being read — investigate Cloud Run env var visibility (§7) or re-verify the key with §3.

---

## 6. Add to Cloud Scheduler (if not already)

Check existing schedule:

```bash
gcloud scheduler jobs list --project=arkova1 --location=us-central1 \
  --filter="name~fetch-(state-bills|sam-entities|sam-exclusions|courtlistener)" \
  --format="table(name.basename(),schedule,state)"
```

If any of the four jobs are missing, add them. Cadence mirrors existing pipeline cron (every 6 hours staggered to avoid rate limits):

```bash
SA=270018525501-compute@developer.gserviceaccount.com
AUD=$WORKER

for PAIR in \
  "fetch-state-bills:0 1,7,13,19 * * *" \
  "fetch-sam-entities:15 2,8,14,20 * * *" \
  "fetch-sam-exclusions:30 3,9,15,21 * * *" \
  "fetch-courtlistener:45 4,10,16,22 * * *"
do
  NAME="${PAIR%%:*}"
  CRON="${PAIR#*:}"
  gcloud scheduler jobs create http "$NAME" \
    --project=arkova1 --location=us-central1 \
    --schedule="$CRON" \
    --time-zone=UTC \
    --uri="$WORKER/jobs/$NAME" \
    --http-method=POST \
    --oidc-service-account-email="$SA" \
    --oidc-token-audience="$AUD" \
    --attempt-deadline=600s
done
```

---

## 7. Rotate to Google Secret Manager (recommended follow-up, out of scope for this ticket)

Cloud Run `--update-env-vars` writes keys as plaintext on the revision config. For production hygiene, migrate to Secret Manager references so rotation is one-command and the keys never appear in `gcloud run services describe`.

```bash
printf '%s' "$OPENSTATES_API_KEY" | gcloud secrets create openstates-api-key --data-file=-
printf '%s' "$SAM_GOV_API_KEY" | gcloud secrets create sam-gov-api-key --data-file=-
printf '%s' "$COURTLISTENER_API_TOKEN" | gcloud secrets create courtlistener-api-token --data-file=-

gcloud run services update arkova-worker \
  --project=arkova1 --region=us-central1 \
  --update-secrets=\
"OPENSTATES_API_KEY=openstates-api-key:latest,\
SAM_GOV_API_KEY=sam-gov-api-key:latest,\
COURTLISTENER_API_TOKEN=courtlistener-api-token:latest"
```

Grant the Cloud Run service account `roles/secretmanager.secretAccessor` on each secret if not already inherited.

---

## 8. Post-deploy verification (Definition of Done)

- [ ] `§3` script passes locally with the same keys deployed in `§4`
- [ ] `§5` smoke test shows each fetcher reports `inserted > 0` OR a legitimate `skipped > 0` with `errors == 0`
- [ ] `§6` lists four Cloud Scheduler entries with state `ENABLED`
- [ ] Wait 24 hours; re-run `§5` checks; confirm cadence is hitting the endpoints via `gcloud scheduler jobs describe … --format='value(lastAttemptTime, state)'`
- [ ] Update `CLAUDE.md` pipeline-audit line to mark the three fetchers as active (next time CLAUDE.md is touched; not a hard blocker for this story)
- [ ] Consider §7 rotation as a follow-up ticket (not gating this story)

---

## 9. Related

- `services/worker/src/jobs/` — fetcher implementations (existing, unchanged).
- `scripts/ops/verify-public-record-keys.ts` — new verification script (this story).
- `docs/compliance/vendor-register.md` — add OpenStates / SAM.gov / CourtListener as third-party data sources if not already listed.

---

## 10. Claude-Code constraint

The `feedback_worker_hands_off` memory says Claude must not directly execute `gcloud run services update` on the running worker. This runbook is intentionally operator-driven — a human runs §3, §4, §5. Claude's role in this story is limited to:

- shipping the verification script
- documenting the runbook
- marking the Jira ticket **Ready-to-Deploy** (QA), not Done

When the operator completes §4 + §5 successfully, they should move SCRUM-728 to Done and paste the `§5` outputs into a Jira comment.

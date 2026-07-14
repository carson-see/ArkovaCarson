# SEC-HARDEN-02 — IAM blast-radius reduction (arkova1)

**Status:** ready to execute · **Owner:** Carson (or delegate) · **Created:** 2026-07-14
**Why this is a runbook, not automation:** modifying IAM roles, deleting service-account
keys, and enabling org policies are access-control changes the agent is barred from
performing directly. Every command below is ready to run as-is.

Source: live audit of project `arkova1` on 2026-07-14 (IAM + Service Accounts + audit logs).

---

## Findings (verified)

| # | Identity | Problem |
|---|----------|---------|
| P0-a | `arkova-cli@arkova1.iam.gserviceaccount.com` | 2 downloadable JSON keys (`cea7e00…`, Mar 26; `00548b6…`, Apr 15) **+** Cloud KMS Admin + Secret Manager Admin + Cloud Run Admin → a home-laptop key that can read `BITCOIN_TREASURY_WIF` + Stripe keys. |
| P0-b | `scripts/staging/pr927-soak.sh` (git history) | `CRON_SECRET="arkova-cron-2026-prod"` hardcoded since 2026-05-27. **If this equals the live prod `X-Cron-Secret`, prod `/jobs/*` are exposed to anyone with repo read.** |
| P1-a | `270018525501-compute@developer.gserviceaccount.com` (Compute default SA) | Holds **Owner** (13,210/13,323 excess perms) **+** a downloadable key (`fd2b466…`, Mar 25). Actively drives CI deploys, so Owner must be replaced with narrow roles, not just removed. |
| P1-b | Org policy | `iam.disableServiceAccountKeyCreation` not enforced (only `…KeyUpload` is), so keys can regress. |

**Sequence matters** — do them in this order or you break access.

---

## P0-b FIRST (2 minutes) — verify/rotate the prod cron secret

```bash
# Is the hardcoded value the live prod secret? (agent cannot read secret values)
gcloud secrets versions access latest --secret="cron-secret" --project=arkova1 | head -c 40; echo
# If it prints "arkova-cron-2026-prod" -> it is LIVE and exposed. Rotate now:
NEW=$(openssl rand -hex 24)
printf '%s' "$NEW" | gcloud secrets versions add cron-secret --data-file=- --project=arkova1
# Redeploy worker (or let next revision pick it up), then discard $NEW from your shell history.
```

## P0-a — kill the exportable treasury-capable key (do NOT delete keys first)

```bash
# 1. Confirm what actually uses arkova-cli before touching it:
gcloud logging read \
  'protoPayload.authenticationInfo.principalEmail="arkova-cli@arkova1.iam.gserviceaccount.com"' \
  --project=arkova1 --freshness=90d --limit=50 \
  --format='table(timestamp, protoPayload.methodName, protoPayload.requestMetadata.callerIp)'

# 2. Stand up Workload Identity Federation for that workflow, mirroring the
#    already-correct github-actions-deploy (pool: github-actions-pool). Keyless.
#    (Wire the CLI/host to impersonate arkova-cli via WIF — no downloaded key.)

# 3. ONLY after WIF is confirmed working, delete BOTH downloadable keys:
gcloud iam service-accounts keys delete cea7e000601606f3d587064099266044390c50b2 \
  --iam-account=arkova-cli@arkova1.iam.gserviceaccount.com
gcloud iam service-accounts keys delete 00548b68a6195b5422eb6031a537f9bc07cbaace \
  --iam-account=arkova-cli@arkova1.iam.gserviceaccount.com

# 4. Right-size the roles — KMS Admin + Secret Manager Admin on one identity is
#    excessive. Split or downscope (e.g. Secret Manager Secret Accessor, not Admin).
```

## P1-a — strip Owner from the Compute default SA (refine → verify → remove)

```bash
# It already holds the 6 roles it actually uses (Artifact Registry Writer,
# BigQuery Job User, Logs Writer, Secret Manager Secret Accessor,
# Storage Object Viewer). Confirm CI still deploys green on those, THEN:
gcloud projects remove-iam-policy-binding arkova1 \
  --member="serviceAccount:270018525501-compute@developer.gserviceaccount.com" \
  --role="roles/owner"
# Also delete its downloadable key fd2b466… once nothing local uses it.
```

## P1-b — lock the door so keys can't regress

```bash
gcloud resource-manager org-policies enable-enforce \
  iam.disableServiceAccountKeyCreation --project=arkova1
```

---

## SLA (from the pre-mortem — do not leave "additive alongside Owner" open-ended)

- P0-a WIF + key deletion: **within 5 business days** of this runbook.
- P1-a Owner removal: **verify → remove in the same window**; the "narrow role added
  alongside Owner" window must not drift past 5 business days (that drift is the
  #1 pre-mortem exploit scenario).

_Related: [[project_bitcoin_signing_paths]], [[project_isolated_rig_deploy_env]]._

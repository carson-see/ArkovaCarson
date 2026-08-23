# Operator actions — 2026-08-22

Executed by the operator session of 2026-08-22 (Claude, on the operator machine, per the
standing directive to execute announced-but-punted operational work instead of re-describing
it). Every action below was verified after execution; evidence and reversal path are recorded
per item. Nothing prod-mutating was performed. The two live soak rigs
(`arkova-worker-ferpa2314-staging`, closes 2026-08-23T19:24:30Z; `arkova-worker-wave2-2026-08-staging`
rev `00006-gik` tag `train-6`, closes 2026-08-23T20:33:58Z) were not touched.

## 1. Orphan-tag backlog fully cleared on `arkova-worker-staging` (BUG-2026-08-22-001)

- **What:** removed the four `train-c-*` traffic tags (`train-c-code` -> `00279-pez`,
  `train-c-code-clean` -> `00280-bug`, `train-c-ce` -> `00283-puq`,
  `train-c-1154-cfaee18e` -> `00285-yiv`) by running PR #2337's fixed
  `scripts/staging/cleanup-orphan-tags.sh --apply` from a checkout of that PR head
  (`3f3afc00d`). The 42 `pr-*` tags had already been cleared by an earlier `--apply` run the
  same day; the old selector (`^pr-[0-9]+$`) could not see `train-c-*`, which is exactly the
  under-coverage #2337 fixes — including the two still-WARM contaminating revisions
  (`00283-puq`, `00285-yiv`, both `minScale=1`) that were running the GDPR retention cron
  against the live shared rig.
- **When:** 2026-08-22 ~18:45Z, after the migration-T3 soak window on this service closed
  (2026-08-22T14:00:22Z). No live soak was disturbed.
- **Evidence:** dry-run selected exactly the 4 tags and explicitly kept `train-migration-t3`
  (serving). Post-apply `gcloud run services describe arkova-worker-staging` traffic block:
  `arkova-worker-staging-00300-few` at 100% + tag `train-migration-t3` — nothing else
  referenced. The two warm revisions are no longer referenced, so their instances spin down and
  the cross-database cron writes stop.
  <!-- staging-gcloud-ok: historical operator transcript — this is the documented REVERSAL command for the tag cleanup above, not a deploy path; restoring a tag goes through the operator, and scripts/staging/deploy.sh does not manage bare tag restoration. -->
- **Reversal:** `gcloud run services update-traffic arkova-worker-staging
  --update-tags <tag>=<revision> --project=arkova1 --region=us-central1` restores any tag
  (revisions still exist; only tags were removed).

## 2. Daily orphan-tag janitor scheduled (launchd)

- **What:** `ai.arkova.janitor.orphan-tags` LaunchAgent, 07:30 local daily, runs
  `cleanup-orphan-tags.sh --apply` from the main checkout, logging to
  `~/arkova-soak-evidence/orphan-tag-janitor.log`. Cloud Scheduler was the script's intended
  target but needs an HTTP endpoint that does not exist; launchd matches the existing
  `ai.arkova.*` operator-machine job pattern.
- **Evidence:** `launchctl list` shows the label loaded with status 0; plist at
  `~/Library/LaunchAgents/ai.arkova.janitor.orphan-tags.plist`.
- **Note:** the job runs whatever is on `main`, so every-tag coverage engages when PR #2337
  merges (until then the checked-in script covers `pr-*` only).
- **Reversal:** `launchctl bootout gui/$(id -u)/ai.arkova.janitor.orphan-tags` and delete the
  plist.

## 3. Dead service account `arkova-staging-deployer@arkova1` DISABLED (not deleted)

- **What:** `gcloud iam service-accounts disable arkova-staging-deployer@arkova1.iam.gserviceaccount.com`.
  Flagged in `docs/security/gcp-key-remediation-2026-08-21.md` as zero-activity-30d.
- **Verification before acting:** Policy Intelligence `serviceAccountLastAuthentication`
  (observation window 2026-05-16 -> 2026-08-14) reports **no authentication**; `gcloud logging
  read` on `principalEmail` over 30d returns nothing; `--managed-by=user` key listing is
  **empty** (the four listed keys are Google system-managed rotation artifacts, present on
  every SA — not downloadable user keys).
- **Verification after acting:** `describe` returns `disabled: true`.
- **Reversal:** `gcloud iam service-accounts enable arkova-staging-deployer@arkova1.iam.gserviceaccount.com`.

## 4. 100 dead per-PR staging secrets deleted from Secret Manager

- **What:** deleted every `*pr<N>*` staging secret whose owning PR closed/merged more than 30
  days ago. Candidate set: 101 secrets across 39 PRs (#712–#1471; latest close 2026-07-13,
  all > 30 days before 2026-08-22). Exclusion set built FIRST from the env `secretKeyRef`s and
  volume secrets of **all 7 Cloud Run services** in `arkova1` (current templates plus the last
  15 revisions of every staging service): 57 referenced secrets, exactly one of them
  pr-numbered — `docusign-connect-hmac-secret-pr712-staging` — which was **excluded and
  survives**.
- **Evidence:** post-sweep, 0 of the 100 remain; total secrets 326 -> 226; the excluded secret
  verified intact. Per-soak / per-rig secrets (non-PR-numbered) were deliberately NOT touched —
  their disposition follows their rigs', not a PR close date.
- **Reversal:** none — Secret Manager deletion is permanent. That is why the sweep was capped at
  the provably-dead set (closed-PR staging artifacts, none referenced by any service) and the
  full list is recorded below.

<details>
<summary>All 100 deleted secrets</summary>

- `adobe-sign-client-secret-pr712-staging`
- `checkr-webhook-secret-pr712-staging`
- `staging-ai-jwts-s3-ai-pr1413`
- `staging-ops-slo-admin-jwt-pr1441`
- `staging-ops-slo-admin-refresh-pr1441`
- `staging-ops-slo-non-admin-jwt-pr1441`
- `staging-ops-slo-non-admin-refresh-pr1441`
- `staging-org-admin-key-s3-webhooks-pr1471`
- `staging-webhook-org-admin-jwt-pr1443wh`
- `staging-webhook-org-admin-refresh-pr1443wh`
- `supabase-anon-key-pr856-isolated-staging`
- `supabase-anon-key-scrum-1707-pr727-staging`
- `supabase-db-password-pr1443wh`
- `supabase-db-password-pr1459-integrity-staging`
- `supabase-db-password-pr810-isolated-staging`
- `supabase-db-password-pr840-isolated-staging`
- `supabase-db-password-pr856-isolated-staging`
- `supabase-db-password-s3-webhooks-pr1443`
- `supabase-db-password-s3-webhooks-pr1471`
- `supabase-db-password-scrum-1707-pr727-staging`
- `supabase-db-url-pr856-isolated-staging`
- `supabase-jwt-secret-pr1269-staging`
- `supabase-jwt-secret-pr715-719`
- `supabase-project-ref-pr856-isolated-staging`
- `supabase-service-role-key-pr-1052`
- `supabase-service-role-key-pr-1055`
- `supabase-service-role-key-pr-1056`
- `supabase-service-role-key-pr-1098`
- `supabase-service-role-key-pr-1104`
- `supabase-service-role-key-pr-1108`
- `supabase-service-role-key-pr-1110`
- `supabase-service-role-key-pr-1119`
- `supabase-service-role-key-pr-1123`
- `supabase-service-role-key-pr-967`
- `supabase-service-role-key-pr1146-staging`
- `supabase-service-role-key-pr1175-staging`
- `supabase-service-role-key-pr1200-staging`
- `supabase-service-role-key-pr1257-staging`
- `supabase-service-role-key-pr1259-0343-staging`
- `supabase-service-role-key-pr1259-staging`
- `supabase-service-role-key-pr1260-staging`
- `supabase-service-role-key-pr1261-staging`
- `supabase-service-role-key-pr1269-staging`
- `supabase-service-role-key-pr1282-staging`
- `supabase-service-role-key-pr1286-staging`
- `supabase-service-role-key-pr1408-chain-res-staging`
- `supabase-service-role-key-pr1443wh-staging`
- `supabase-service-role-key-pr1459-integrity-staging`
- `supabase-service-role-key-pr712-staging`
- `supabase-service-role-key-pr715-719`
- `supabase-service-role-key-pr810-isolated-staging`
- `supabase-service-role-key-pr840-isolated-staging`
- `supabase-service-role-key-pr856-isolated-staging`
- `supabase-service-role-key-pr862-isolated-staging`
- `supabase-service-role-key-pr877-isolated-staging`
- `supabase-service-role-key-pr885-isolated-staging`
- `supabase-service-role-key-pr886-isolated-staging`
- `supabase-service-role-key-pr945-isolated-staging`
- `supabase-service-role-key-pr946-isolated-staging`
- `supabase-service-role-key-pr954-isolated-staging`
- `supabase-service-role-key-s3-webhooks-pr1471-staging`
- `supabase-service-role-key-scrum-1707-pr727-staging`
- `supabase-url-pr-1052`
- `supabase-url-pr-1055`
- `supabase-url-pr-1056`
- `supabase-url-pr-1098`
- `supabase-url-pr-1104`
- `supabase-url-pr-1108`
- `supabase-url-pr-1110`
- `supabase-url-pr-1119`
- `supabase-url-pr-1123`
- `supabase-url-pr-967`
- `supabase-url-pr1146-staging`
- `supabase-url-pr1175-staging`
- `supabase-url-pr1200-staging`
- `supabase-url-pr1257-staging`
- `supabase-url-pr1259-0343-staging`
- `supabase-url-pr1259-staging`
- `supabase-url-pr1260-staging`
- `supabase-url-pr1261-staging`
- `supabase-url-pr1269-staging`
- `supabase-url-pr1282-staging`
- `supabase-url-pr1286-staging`
- `supabase-url-pr1408-chain-res-staging`
- `supabase-url-pr1443wh-staging`
- `supabase-url-pr1459-integrity-staging`
- `supabase-url-pr712-staging`
- `supabase-url-pr715-719`
- `supabase-url-pr810-isolated-staging`
- `supabase-url-pr840-isolated-staging`
- `supabase-url-pr856-isolated-staging`
- `supabase-url-pr862-isolated-staging`
- `supabase-url-pr877-isolated-staging`
- `supabase-url-pr885-isolated-staging`
- `supabase-url-pr886-isolated-staging`
- `supabase-url-pr945-isolated-staging`
- `supabase-url-pr946-isolated-staging`
- `supabase-url-pr954-isolated-staging`
- `supabase-url-s3-webhooks-pr1471-staging`
- `supabase-url-scrum-1707-pr727-staging`

</details>

## 5. Documentation claims corrected in the same commit

- `docs/security/sekura-known-issues-2026-08-03.md` KI-01: the "A scoped replacement SA is
  built" claim was false (no such SA exists; SCRUM-3023 open) — corrected under the R-7
  claims-review gate.
- `docs/security/gcp-key-remediation-2026-08-21.md`: items 3 and 4 above recorded against its
  findings list.
- `docs/staging/findings/FD-CI-2-pull-request-workflow-dispatch-stalled.md`: `pull_request`
  dispatch verified recovered (see that file's dated note).

## Verified but requiring no action

- **FD-PROD-1 (migration 0386):** already RESOLVED 2026-08-22 (applied in prod, ledger head
  0409, guard verified in the live function body) — see the finding.
- **PR #2332's follow-up** ("#2269's scan needs a re-run"): `scan` is SUCCESS on #2269's
  current head; no re-run needed.
- **`t1-2290` orphan tag on `arkova-worker-wave2-2026-08-staging`:** already gone; the
  service carries only `pr-2290` (left for the janitor post-soak — no mutation of a live soak
  service's traffic block) and the soak tag `train-6`.
- **CLAUDE.md stale staging ref (PR #2285 follow-up):** already fixed on `main` — §1.11 now
  points at `docs/reference/STAGING_RIG.md` instead of hardcoding a ref.

## Deliberately NOT done, with reasons

- **`sekura-deploy@` / `sekura-appliance@` SAs:** whether the vendor engagement is over is a
  business call — left enabled, per the remediation doc.
- **`bitcoin-treasury-wif` rotation:** live mainnet signing key; needs a planned change
  window. Carson's call (unchanged from the remediation doc).
- **Prod anon-EXECUTABLE functions (`bulk_create_anchors`, `resolve_anchor_queue`):**
  prod-mutating REVOKE; out of scope for this sweep, tracked in FD-PROD-1's residual note.
- **Per-soak (non-PR) secrets and torn-down-rig leftovers:** need per-rig disposition, not a
  PR-close heuristic.

_Last refreshed: 2026-08-22 by Claude (operator session) — claims verified against gcloud/MCP/CI output._

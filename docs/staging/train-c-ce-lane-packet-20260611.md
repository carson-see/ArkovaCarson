# Train C CE Lane Packet - 2026-06-11

Status: Train C CE tag environment created; targeted CTDL smoke passed; 48-hour T3 health/read soak and bounded CTDL-route soak started.

This packet is for the cumulative Credential Engine / CTDL stack only. It does not cover DocuSign, Google Drive, CPE/CLE UI, CSI/Accredible, or Udemy native work.

## Lane Identity

- Train: `train-c`
- Lane: `train-c-ce`
- Owning PR for lease/audit: #1148
- Stacked PRs covered by this lane: #1146 + #1148
- Effective tier: T3, because #1146 is privacy/security-sensitive CTDL output and #1148 rides on that stack.
- Evidence root: `/Volumes/Extreme/Arkova/release-evidence/train-c/ce`
- Screen session prefix: `train-c-ce-soak-<timestamp>`

## Frozen Code

| Item | Value |
| --- | --- |
| `origin/main` at packet creation | `3f906c991988f9b2ed6e71e1a70b64020cebd2fb` |
| #1146 head | `022d33d622402010f7c77f68a1eff920c94478b0` |
| #1148 head | `a0aad950ee522fba3294bea945c8d413017a63d4` |
| #1148 base branch | `codex/sprint-ce-ctdl-safety-20260611` |
| #1148 merge-base with `origin/main` | `3f906c991988f9b2ed6e71e1a70b64020cebd2fb` |

If #1146 or #1148 head moves, this packet is stale and must be regenerated before evidence starts.

## Environment Target

| Field | Value |
| --- | --- |
| Cloud Run service | `arkova-worker-staging` |
| Cloud Run tag | `train-c-ce` |
| Tag URL | `https://train-c-ce---arkova-worker-staging-kvojbeutfa-uc.a.run.app` |
| Worker revision | `arkova-worker-staging-00278-fat` |
| Staging deploy log id | `178` |
| Image | `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker:train-c-ce-a0aad950` |
| Image digest | `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@sha256:9aaefe05f89a893245a3284afa7d3ce5f0748dbfbf020300b51094e29e06a6c3` |
| Main staging traffic | Must remain unchanged; deploy command must use `--no-traffic` through `scripts/staging/deploy.sh`. |
| Supabase | Existing staging project for non-mutating smoke only unless DB Admin approves an isolated clean mirror. |
| Scheduler | Not used for CE lane. |
| Secrets | Runtime access only; no secret values in logs, docs, PRs, Jira, Confluence, screenshots, or evidence. |

## Start And Publishing Gates

- [x] #1146 and #1148 heads still match the frozen SHAs above.
- [x] Train C tag URL deployed with `--lane train-c-ce` and `--no-traffic`.
- [x] `staging_deploy_log` row captured.
- [x] Image digest captured from Artifact Registry or deploy output.
- [x] Health/read smoke passes against the `train-c-ce` tag URL.
- [x] Read-only staging candidate discovery found publishable public IDs for targeted smoke selection.
- [x] CE/CTDL targeted smoke captures only redacted logs.
- [x] Release owner approved the soak start and expected bounded `audit_events` writes for targeted smoke.
- [ ] Jeanne-aligned CTDL decisions are recorded before any Registry publishing:
  no learner PII, no fake CTIDs, corrected expiration semantics, credit `ConditionProfile` / `ValueProfile` mapping, and CTDL template/class layer separated from issued OB3/W3C VC credentials.

## Commands

Build/push candidate image from the #1148 worktree:

```bash
cd /Volumes/Extreme/Arkova/worktrees/sprint-ctdl-credit-mapping-20260611
export BUILD_SHA="a0aad950ee522fba3294bea945c8d413017a63d4"
export IMAGE_REF="us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker:train-c-ce-a0aad950"
gcloud auth configure-docker us-central1-docker.pkg.dev --quiet
docker build --build-arg BUILD_SHA="$BUILD_SHA" --tag "$IMAGE_REF" services/worker
docker push "$IMAGE_REF"
```

Acquire the staging lease and deploy the named Train C tag from the release-tooling worktree:

```bash
cd /Volumes/Extreme/Arkova/worktrees/train-c-soak-prep-20260611
export STAGING_SUPABASE_URL="$(gcloud secrets versions access latest --secret=supabase-url-staging --project=arkova1)"
export STAGING_SUPABASE_SERVICE_ROLE_KEY="$(gcloud secrets versions access latest --secret=supabase-service-role-key-staging --project=arkova1)"
./scripts/staging/claim.sh acquire 1148 "Train C CE lane environment"
./scripts/staging/deploy.sh --pr 1148 --lane train-c-ce --image "$IMAGE_REF" --build-sha "$BUILD_SHA"
```

Do not start long soak until the start gates above are complete.

## Live Attempt Log

- 2026-06-11 13:27 EDT: Packet created before live environment attempt.
- 2026-06-11 13:31 EDT: Staging lease acquired for PR #1148 with reason `Train C CE lane environment`.
- 2026-06-11 13:32 EDT: First deploy attempt failed before serving because the locally built image was an OCI index that Cloud Run rejected for missing `linux/amd64` support.
- 2026-06-11 13:40 EDT: Rebuilt #1148 image explicitly with `--platform linux/amd64` and pushed digest `sha256:9aaefe05f89a893245a3284afa7d3ce5f0748dbfbf020300b51094e29e06a6c3`.
- 2026-06-11 13:41 EDT: Created Cloud Run tag URL `https://train-c-ce---arkova-worker-staging-kvojbeutfa-uc.a.run.app` on revision `arkova-worker-staging-00278-fat`, serving 0 percent main traffic. `STAGING_DEPLOY_LOG_ID=178`.
- 2026-06-11 13:42 EDT: Authenticated `/health` smoke returned HTTP 200 with `git_sha=a0aad950ee522fba3294bea945c8d413017a63d4` and `database/anchoring/kms=ok`.
- 2026-06-11 13:42 EDT: Minimal fake-ID probes returned expected 404s: `/api/v1/verify/ARK-TRAIN-C-FAKE` -> `Record not found`; `/api/v1/credentials/ARK-TRAIN-C-FAKE/ctdl` -> `not_found`. The CTDL route writes an `audit_events` row for every outcome by design, so additional live CTDL probes are gated below.
- 2026-06-11 14:02 EDT: Read-only Supabase REST discovery selected only `public_id`, `status`, `credential_type`, `sub_type`, and `created_at`. It found 36,449 non-deleted publishable rows with statuses in `SECURED`, `REVOKED`, `EXPIRED`, or `SUPERSEDED`; recent filtered samples were `SECURED` / `OTHER`. Latest unfiltered rows sampled separately were `PENDING`, so targeted smoke must use the filtered publishable set.
- 2026-06-11 14:02 EDT: Bounded authenticated tag probes returned `/health` HTTP 200; `/api/v1/docs/spec.json` and `/api/v1/docs` returned HTTP 401, confirming those docs endpoints are not a useful unauthenticated route-presence smoke on the tag.
- 2026-06-12 10:00 EDT: Targeted CTDL smoke used two publishable CPE public IDs and one publishable generic public ID against the `train-c-ce` tag. All three returned HTTP 200 with `application/ld+json`; each request wrote exactly one expected `ctdl.requested` audit row (`0 -> 1` for each target); summarized evidence found no learner/student/email/SSN/DOB guard terms.
- 2026-06-12 10:01 EDT: Sampled the first 200 publishable CPE/CLE staging rows for credit-hour metadata. No sampled rows had `credit_hours`, `creditHours`, ethics hours, or other credit-like metadata, so live staging data still does not prove `ceterms:requires -> ceterms:ConditionProfile -> ceterms:creditValue -> ceterms:ValueProfile` output.
- 2026-06-12 10:02 EDT: Started 48-hour T3 health/read soak in screen `train-c-ce-t3-read-soak-20260612T140237Z`. Mode is `reads` with `STAGING_READ_PATHS=/health` against `https://train-c-ce---arkova-worker-staging-kvojbeutfa-uc.a.run.app`. Evidence target: `/Volumes/Extreme/Arkova/release-evidence/train-c/ce/soak-train-c-ce-t3-read-20260612T140237Z.json`. Expected end: `2026-06-14T14:02:37Z`.
- 2026-06-12 10:03 EDT: First soak telemetry: 50 OK, 0 fail, statuses `200=50`, p50 101ms, p95 261ms, p99 843ms.
- 2026-06-12 11:35 EDT: Started a second bounded CTDL-route soak in screen `train-c-ce-t3-ctdl-soak-20260612T153435Z`, using the same three public IDs from targeted smoke every 300 seconds. Evidence: `/Volumes/Extreme/Arkova/release-evidence/train-c/ce/soak-train-c-ce-t3-ctdl-20260612T153435Z.jsonl` and summary `/Volumes/Extreme/Arkova/release-evidence/train-c/ce/soak-train-c-ce-t3-ctdl-20260612T153435Z.summary.json`. Expected end: `2026-06-14T15:35:45Z`. First cycle: 3 OK, 0 fail, statuses `200=3`, no PII guard terms, credit value still absent because sampled staging CPE/CLE rows lack credit-hour metadata.

## Remaining During Soak / Before Merge-Grade Readiness

- Let the 48-hour T3 health/read soak and bounded CTDL-route soak complete and capture final JSON/JSONL evidence.
- Confirm Jeanne-aligned CTDL decisions are reflected in acceptance criteria before any public Registry publishing.
- Add or identify staging CPE/CLE records with real credit-hour metadata, then rerun targeted CTDL smoke to prove `ConditionProfile` / `ValueProfile` output.
- Keep CTDL-route traffic bounded unless release owner explicitly approves higher-volume CTDL route traffic, because CTDL requests write `audit_events` rows by design.

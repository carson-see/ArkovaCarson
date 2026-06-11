# Train C CE Lane Packet - 2026-06-11

Status: lane packet created; live environment attempt pending.

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
| Expected tag URL | `https://train-c-ce---arkova-worker-staging-270018525501.us-central1.run.app` |
| Main staging traffic | Must remain unchanged; deploy command must use `--no-traffic` through `scripts/staging/deploy.sh`. |
| Supabase | Existing staging project for non-mutating smoke only unless DB Admin approves an isolated clean mirror. |
| Scheduler | Not used for CE lane. |
| Secrets | Runtime access only; no secret values in logs, docs, PRs, Jira, Confluence, screenshots, or evidence. |

## Start Gates

- [ ] #1146 and #1148 heads still match the frozen SHAs above.
- [ ] Train C tag URL deployed with `--lane train-c-ce` and `--no-traffic`.
- [ ] `staging_deploy_log` row captured.
- [ ] Image digest captured from Artifact Registry or deploy output.
- [ ] Health/read smoke passes against the `train-c-ce` tag URL.
- [ ] CE/CTDL targeted smoke captures only redacted logs.
- [ ] Jeanne-aligned CTDL decisions are recorded before any Registry publishing:
  no learner PII, no fake CTIDs, corrected expiration semantics, credit `ConditionProfile` / `ValueProfile` mapping, and CTDL template/class layer separated from issued OB3/W3C VC credentials.
- [ ] Release owner approves the soak start.

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

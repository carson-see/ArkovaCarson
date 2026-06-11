# Train C Soak Readiness - 2026-06-11

Status: prep artifact only. This file does not approve a release candidate, start a soak, mutate staging, apply Scheduler jobs, touch Supabase, or replace a final `docs/staging/rc-manifests/rc-*.json` manifest.

Current base: `origin/main` at `3f906c991988f9b2ed6e71e1a70b64020cebd2fb` after PR #1055 merged.

## Protected Lanes

Train A and Train B are already using isolated named soak lanes. Do not mutate their PR heads, services, Scheduler jobs, Supabase projects, release evidence, Mergify state, or branch protection while preparing Train C.

Latest dashboard sample after the train-lane parser fix:

| Lane | Mode | OK | Fail | Status | Final JSON |
| --- | --- | ---: | ---: | --- | --- |
| train-a | cron | 165 | 0 | `200=165` | missing |
| train-b | cron | 165 | 0 | `200=165` | missing |

The 2026-06-11 08:15 EDT Train A/B attempts are superseded because the later 10:12 EDT logs explicitly mark them as discarded after platform no-available-instance 500s.

## Train C Candidate Set

| Order | PR / scope | Current head | Base | Effective tier | Soak grouping |
| ---: | --- | --- | --- | --- | --- |
| 1 | #1146 CTDL privacy, public identifier, verify link | `022d33d6` | `main` | T3 | CE candidate root |
| 2 | #1148 CTDL credit mapping | `a0aad950` | `codex/sprint-ce-ctdl-safety-20260611` | T2 alone, T3 when stacked with #1146 | Same CE candidate as #1146 |
| 3 | #1147 DocuSign listener drift reconciliation and scheduler binding | `b0bdae92` | `main` | T2 | Independent Train C connector lane |
| 4 | #1149 professional education export UI | `67af9c29` | `main` | T1 if UI-only, T2 if backend/API behavior is in scope | UI lane |
| 5 | #1150 org CPE dashboard | `5beb1295` | `main` | T1 if UI-only, T2 if backend/API behavior is in scope | UI lane |
| 6 | #1151 worker deploy Trivy CVE gate | `5070a3a8` | `main` | T0/T1 tooling if CI-only, T2 only if deploy behavior is materially changed | Release tooling lane, not product Train C unless owner approves |
| 7 | Google Drive page-token / queue materialization | not frozen | TBD | T2 | Needs PR and isolated flag/queue evidence |
| 8 | CSI / Accredible stack | #1039 -> #1040 -> #1041 after #1038 | mixed | T2 code, effective T3 when tied to #1038 migration foundation | Do not mix into Train C unless migration foundation is explicitly included |
| 9 | Udemy native adapter | not scoped | TBD | TBD | Defer unless Udemy Business/xAPI requirements and sandbox exist |

## Merge Order

Do not merge by numeric tier alone. Merge by dependency and evidence order:

1. Finish and approve Train C release tooling/docs changes, including the train-aware dashboard.
2. For CE, merge #1146 before #1148 because #1148 is stacked on the #1146 branch.
3. #1147 can merge independently after its T2 evidence and Scheduler/runbook gates are real.
4. #1149 and #1150 can merge independently after T1/T2 evidence, UI UAT, and green checks.
5. Drive follows only after a concrete PR proves page token bootstrap, feature flags, queue materialization, folder matching, review/digest, and smoke evidence.
6. CSI / Accredible follows its own dependency chain: Train A foundation #1038 first, then #1039, #1040, #1041.
7. Udemy native work is excluded until scoped separately. URL/generic capture can remain documentation or existing credential-source scope.

## Parallel Soak Rules

T0 does not soak. T1, T2, and T3 may run at the same time only when all of these are true:

- Every lane has its own Cloud Run tag or service URL.
- Any mutable DB/schema/queue/Scheduler/secret state is either read-only, exclusive, or isolated.
- The evidence names the exact PR head SHA, base SHA, service/tag URL, image digest, deploy log, preflight result, start/end, and rollback plan.
- Stacked PRs soak as the cumulative candidate, not as unrelated PRs.
- Runtime, schema, migration, worker image, deploy, Scheduler, or tested-code drift restarts or re-scopes the evidence unless there is an approved T0-only base-drift note.

## Start Gates

### T0

Use only for docs/tests/CI/tooling-only changes. Required before merge:

- CI green.
- PR body states T0 and why no staging evidence is required.
- If merging during A/B soak, add a base-drift impact note proving no runtime/schema/deploy/worker-image change.

### T1

Use for low-risk UI/config/code-only changes with no API/auth/billing/anchoring/queue/worker/security surface.

Required before soak start:

- Exact head SHA frozen.
- Staging/preview URL or explicit N/A explanation.
- 1280px and 375px UAT screenshots for UI changes.
- 2 hour smoke plan and rollback note.

### T2

Use for public API, worker behavior, webhooks, queues, Drive, DocuSign, and connector runtime.

Required before soak start:

- Clean preflight for the exact environment.
- Train C Cloud Run service/tag URL.
- Deploy log id, revision, image digest.
- Targeted smoke that exercises the changed behavior, not just generic worker health.
- Rollback rehearsal or explicit rollback procedure.
- 12 hour evidence window.

### T3

Use for migrations, data integrity, security/privacy-sensitive CTDL output, cron-on-anchors, and anchor lifecycle.

Required before soak start:

- Isolated Supabase or proven clean mirror.
- Trigger coverage appropriate to the changed path.
- Rollback/reapply proof for migration-bearing work.
- Per-org isolation check when org-scoped data is touched.
- 48 hour evidence window.

## Train C Work Needed Before Soaking

1. Mark #1146, #1147, #1148, #1149, #1150 as draft/progress only until their PR bodies carry truthful evidence.
2. Resolve #1146 CTDL contract decisions with Jeanne's comments: no learner PII, no fake CTIDs, correct expiration semantics, CTDL template/class layer vs issued credential layer.
3. Keep #1148 stacked on #1146 and rerun CE tests after any #1146 movement.
4. For #1147, do not apply live Scheduler jobs yet. First define the isolated Train C Scheduler/service target and smoke path.
5. For #1149/#1150, confirm whether the whole PR is UI-only. If yes, use T1 plus UAT; if not, escalate to T2.
6. Create the Drive PR/evidence checklist before implementation: page token, flags, queue materialization, folder matching, review/digest, smoke.
7. Decide whether #1151 is product Train C scope or separate release-tooling hardening.
8. After heads and scope are frozen, create the final `docs/staging/rc-manifests/rc-2026-06-11-train-c.json` only when the environment, approval, soak window, and rollback proof are real.

## First Soak Packet Checklist

Before any Train C lane starts, create a lane packet in the PR body or final RC manifest with:

- Exact PR head SHA and base SHA.
- Risk tier and why the tier is not lower.
- Frozen merge grouping, especially whether the lane is standalone or stacked.
- Isolated environment name, service/tag URL, Cloud Run revision, deploy log, image digest, and clean preflight output.
- Mutable-state declaration: database, queue, Scheduler, secrets, and feature flags are read-only, exclusive, isolated, or N/A.
- Targeted smoke command/result for the changed behavior.
- Rollback command/procedure and stop conditions.
- Evidence root and final JSON/log file names.
- Human approval to start the lane.

Per-lane additions:

| Lane | Extra evidence before start |
| --- | --- |
| CE #1146/#1148 | Jeanne-aligned CTDL contract decision, no learner PII proof, fake-CTID rejection, expiration semantics, credit ConditionProfile/ValueProfile mapping, and CE Secret Manager/Graph Search smoke with redacted logs. |
| DocuSign #1147 | Isolated Scheduler target, listener-drift smoke path, alert interpretation runbook, and explicit statement that no production Scheduler job was applied. |
| CPE/CLE #1149/#1150 | 1280px and 375px UAT screenshots, role coverage, and a tier decision confirming whether the PR is UI-only or touches backend/API behavior. |
| Google Drive | Feature flag state, page-token bootstrap proof, folder matching, queue materialization, review/digest output, and file-change-to-queue smoke. |
| CSI/Accredible | Migration foundation status, importer source order, sandbox account evidence, conflict/rebase status for #1039, and an explicit decision not to include Udemy native adapter unless separately scoped. |

## Commands

Read-only dashboard:

```bash
npm run staging:soak-lanes -- --evidence-root /Volumes/Extreme/Arkova/release-evidence
```

Train C T2/T3 soak command template:

```bash
export STAGING_API_BASE="https://<train-c-tag-or-service>.run.app"
export STAGING_CRON_SECRET="$(gcloud secrets versions access latest --secret=cron-secret --project=arkova1)"
npm run staging:load -- --mode mixed --duration <720-or-2880> \
  --evidence-out /Volumes/Extreme/Arkova/release-evidence/train-c/soak-train-c-<lane>-$(date -u +%Y%m%dT%H%M%SZ).json
```

Do not run the template until the Start Gates above are satisfied and the release owner approves the Train C environment.

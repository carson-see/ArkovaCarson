# Production candidate handoff — manual commands, stop before promotion

Prepared 2026-09-27 from the read-only production-candidate feasibility audit and the current `deploy-worker.yml`. This is a command draft for a separately started, authorized release session. **Do not run it in this session.** It creates a real production Cloud Run revision when run. It deliberately contains no promotion command, no traffic update, no Scheduler mutation, no secret value, and no soak acceptance claim.

## Execution gate: external review and named acceptance

This runbook is not executable until the release owner records an immutable external-review packet and reviewer scope, dispositions for every material finding, the exact fixes made, affected verification reruns, the completed final external review, and a tech-lead verified disposition tying each corrected finding to the frozen candidate. Any unresolved material finding is a stop. Internal review, green component tests, or an earlier candidate review cannot substitute for this receipt.

The future operator must also use the [named acceptance matrix](named-acceptance-matrix.md) and the decision register in the [release and soak plan](release-soak-plan.md). Those files own the case IDs, actors, prerequisites, visible results, negative and recovery cases, evidence filenames, owners, and open decisions; this command runbook does not duplicate them. Missing required rows, owners, prerequisites, or decisions are blocking rather than implicitly waived.

The order remains: close the final external-review findings with targeted verification and freeze the source candidate; qualify the exact combined T3 candidate in isolated staging; evaluate every acceptance row applicable to this release stage and record every other conditional or separately reported row honestly as open/not-applicable without treating it as an unrelated-release blocker; then perform a separately authorized zero-traffic production observation with this runbook. Staging evidence, zero-traffic production observation, and the later production soak are distinct gates and cannot substitute for one another. This session performs none of them and starts no soak.

The operator must freeze every angle-bracket value before beginning. A placeholder, failed comparison, concurrent deploy, missing migration, or missing rollback image is a stop condition.

## 1. Freeze identities and take the deployment lease

```bash
set -euo pipefail

export PROJECT_ID='arkova1'
export REGION='us-central1'
export SERVICE='arkova-worker'
export REGISTRY='us-central1-docker.pkg.dev'
export REPOSITORY='arkova-worker-images'

# Resolve these from the approved release manifest. Never use latest.
export CANDIDATE_GIT_SHA='<pending final integrated candidate commit>'
export CANDIDATE_IMAGE_TAG="${REGISTRY}/${PROJECT_ID}/${REPOSITORY}/${SERVICE}:${CANDIDATE_GIT_SHA}"
export EXPECTED_IMAGE_DIGEST='<sha256:... from the signed build/provenance receipt>'
export FIXED_A_GIT_SHA='<40-character externally re-reviewed fixed-A commit; PR #3154 current head is not yet admitted>'
export FIXED_A_ROLLBACK_IMAGE='<registry image@sha256 for that exact fixed compatibility-A commit>'
export FIXED_A_COMPAT_REVISION='<verified fixed compatibility-A Cloud Run revision>'
export RELEASE_ID='<unique lower-case release id, for example rc-20260930-01>'
export CANDIDATE_TAG="${RELEASE_ID}"
export REVISION_SUFFIX="${RELEASE_ID}"
export EVIDENCE_DIR="<absolute empty operator evidence directory>"
mkdir -p "${EVIDENCE_DIR}"
test -z "$(find "${EVIDENCE_DIR}" -mindepth 1 -maxdepth 1 -print -quit)"
```

Before any mutation, the release owner records a single named operator, an independent verifier, the approved migration order, all included PR heads, and a deployment stand-down acknowledged by every session that could merge, dispatch `deploy-worker.yml`, or update `arkova-worker`. GitHub's `deploy-worker` concurrency group serializes workflow jobs; it does not lock out this manual command. If a deploy workflow is queued/running, main changes, or another operator cannot acknowledge the hold, stop.

Before the authenticated `git fetch` or `gh run list` below, work from a clean reviewed checkout, read its current `CLAUDE.md` and required bootstrap files, and run `scripts/agent/ack-claude-bootstrap.sh`. Record the acknowledgement output. Do not proceed with stale repository rules or an unacknowledged authenticated CLI session.

Record these read-only checks in the evidence directory:

```bash
git fetch origin main --quiet
git rev-parse origin/main | tee "${EVIDENCE_DIR}/origin-main-before.txt"
git cat-file -e "${CANDIDATE_GIT_SHA}^{commit}"
git show -s --format=fuller "${CANDIDATE_GIT_SHA}" > "${EVIDENCE_DIR}/candidate-commit.txt"

gh run list --workflow deploy-worker.yml --limit 20 \
  --json databaseId,status,conclusion,headSha,event,url \
  > "${EVIDENCE_DIR}/deploy-worker-runs-before.json"

gcloud run services describe "${SERVICE}" --project "${PROJECT_ID}" --region "${REGION}" --format=json \
  > "${EVIDENCE_DIR}/service-before.json"
jq -e '.status.traffic and .status.url and .spec.template.spec.serviceAccountName' \
  "${EVIDENCE_DIR}/service-before.json" >/dev/null
jq '[.status.traffic[]? | select((.percent // 0)>0) | {revisionName,percent,tag,latestRevision,url}]' \
  "${EVIDENCE_DIR}/service-before.json" > "${EVIDENCE_DIR}/serving-traffic-before.json"
jq -e 'length>0 and (map(.percent)|add)==100 and all(.[]; (.revisionName|type)=="string" and (.revisionName|length)>0)' \
  "${EVIDENCE_DIR}/serving-traffic-before.json" >/dev/null

# Capture every actually serving revision; latestReadyRevisionName may instead
# identify a newer zero-traffic revision and is not a stable-serving identity.
jq -r '.[].revisionName' "${EVIDENCE_DIR}/serving-traffic-before.json" | while read -r revision; do
  gcloud run revisions describe "${revision}" --project "${PROJECT_ID}" --region "${REGION}" --format=json \
    > "${EVIDENCE_DIR}/serving-${revision}.json"
done

# `gcloud run deploy` inherits this current SERVICE TEMPLATE, which can differ
# from every serving revision. Freeze and independently review it before deploy.
jq '.spec.template' "${EVIDENCE_DIR}/service-before.json" > "${EVIDENCE_DIR}/service-template-before.json"
```

### Migration handoff — apply only in the authorized release session

Follow the repository [migration procedure](../../../.claude/skills/migration-procedure/SKILL.md), especially steps 4–6 and Prod apply, and `CLAUDE.md` §0 rule 10. The release owner must freeze the exact SQL checksums and approve this candidate order: **0488 → 0489 → 0491 → 0492 → 0493 → 0494 → 0495 → 0496**. 0495 adds both the restrictive outbox MFA policy and the bounded Drive-health RPC;0496 repairs the terminal materialization return state and requires native failure-path verification before admission. Published migration bytes are not rewritten. Record the exact filename/checksum for each prefix from the frozen candidate. Do not run a blanket database push that includes another owner's 0490.

The operator records the target project and current numeric ledger, checks each prerequisite, and skips an already-applied migration only after confirming its recorded identity matches the reviewed SQL. Qualify the same sequence on isolated staging first. For production, the authorized RTE applies each exact reviewed file through MCP under the procedure, immediately performs the prescribed timestamp-to-numeric ledger reconciliation when needed, and reads the numeric ledger back before advancing. Retain the apply response and ledger before/after, verify the effective functions/policies and schema-cache reload, and stop on any failed apply, identity mismatch, unexpected prefix or lock timeout. Never fake ledger rows, run migration repair, reset shared data, or bypass the pre-main apply hook. If any prefix is not on main, obtain the explicit reviewed prefix exemption required by §0 rule 10 **before** its application. That exception does not waive staging or migration acceptance. All required migrations must finish before the candidate receives a request.

Published-533db3578 exact-head CI receipt: run 36354232972, job 108718629117, successfully read production on September 27 and found migrations 0488, 0489, 0491, 0492, 0493, and 0494 absent. The migration-drift failure is an open release-state gate, not permission to apply them here. Before a future production apply, the operator must also satisfy the separate `CLAUDE.md` §0 rule10 apply-order hook: each prefix must already be on main or have the explicitly reviewed prefix exemption required by that hook. These prefixes are not on the current main. Resolve that sequencing prerequisite with the release owner before executing an apply; do not bypass the hook, fabricate ledger rows, or silently add a CI `exempt_regex`. A reviewed operational exception is not migration acceptance. Staging qualification precedes production; preserve exact SQL checksums, reconcile real applied numeric ledger rows in the authorized apply session, and retain the red gate until its condition is genuinely satisfied. Detailed receipt: `pr3152-migration-drift-diagnostic-20260927.md`.


### Mandatory AR20-13 compatibility floor before the first owned-row-producing request

Retain all candidate-required migrations **0488/0489/0491–0496** in the ordered handoff above. Migration 0490 belongs to another owner and requires its separate evidence/ledger decision. The final source identity must come from the release manifest after the final-review corrections and targeted verification; historical runtime `ce545a2f` is not the final candidate. `final-review-dispositions.md` owns the final correction receipt; `round3-review-dispositions.md` is historical focused qualification.

The original Build A `fc9c8a6543ed3482239e5b6ae9d5c9ce1d141c23` and historical fixed-A heads `46f3ac519`, `1045918009`, `3f7238d5` and `0ff11a14e4e85ab8c7931b6df3cfe5cca761ca2d` are below the required rollback floor. The final broad review evaluated later checkpoint `041f89157105a57c6602b9d064efbd41eff89b52`; its verified test and required-schema source correction is published as final source `b79479fea89616b1f20705f478c5ec03c0ecb824`. Select only the resulting immutable image after the remaining artifact gates pass, never a historical source receipt or mutable tag.

The required fallback behavior is explicit: register, all PATCH updates and key mint return maintenance 503 before database/key-generation work; authenticated emergency DELETE uses the human/API-key revoke-with-outbox RPC; reads, owned-row draining and legacy unowned retries remain available. Pin ComputeID false. Logical revocation remains transactional: audit/outbox failure rolls it back and leaves the key active, so report failure and retry/escalate. Physical service deletion is separately blocked while outbox foreign keys remain; eligible terminal cleanup must precede it. Do not remove that retention boundary to make an operator cleanup succeed.

Source tests are not image qualification. Immutable image provenance, exact configuration, maintenance-window authorization, complete old-worker/job quiescence and the rollback/drainer rehearsal are all still required. Historical database evidence was a 189-migration bootstrap through 0493 followed by additive 0494 and 0495 native checks on the owned disposable schema; no fresh full-lineage replay including both corrections is claimed.

Before this runbook may execute, `FIXED_A_GIT_SHA` and `FIXED_A_ROLLBACK_IMAGE` must exist and be independently qualified after the emergency-revocation finding is dispositioned. The new exact-head verdict must state which maintenance mutations are intentionally blocked and prove every blocked route fails before DB/RPC/key generation; both reads remain usable; ComputeID admission/webhook return `vendor_gated` and recheck reports `flag_off`; a B-format owned row is materialized, claimed and completed by the real scheduled retry entry point; legacy unowned retry rows remain on the legacy sweep; and exact image provenance binds those results to the digest. Because fixed A intentionally pauses agent mutations, the release owner must approve and communicate the bounded maintenance window before routing ordinary traffic to it. Until that artifact and window exist, **AR20-13 rollout and rollback rehearsal are blocked**.

Then the fixed compatibility-A worker must be deployed to **every active worker/job execution path** and every incompatible pre-A path must be quiesced before the first request capable of producing an owned outbox row. That includes fixed-A emergency `DELETE`, not only Build B traffic. Every revision with traffic, every tag that operators or jobs can address, and every warm zero-traffic revision capable of running process-local jobs must either run fixed A-or-later or be explicitly quiesced. `--no-traffic` does not quiesce a revision: minimum instances, a tag request, or process-local timers can keep it alive.

The release owner must provide a verified, bounded quiescence procedure for obsolete pre-A revisions and prove `FIXED_A_COMPAT_REVISION` can drain Build-B-owned rows. That drain proof may come from prior isolated qualification of the exact A/B artifacts; it does not require sending a production B request before pre-A revisions are quiesced. If current Cloud Run controls cannot prove all pre-A background-capable revisions stopped, **this runbook is blocked**; do not deploy or warm Build B. Do not infer quiescence from traffic percentages or delete historical evidence. A safe future execution normally moves ordinary traffic to the verified fixed-A revision through the separately authorized release path, removes obsolete tags/direct callers, reduces obsolete revision-level minimum instances where supported, waits for old instances to stop, and confirms by revision-scoped logs/metrics that no pre-A retry loop remains. These are real production changes and are prerequisites owned by the future operator, not commands authorized here.

Save the proof as `ar20-13-compatibility-floor.json`: migration ledger identity, fixed-A image/revision digest, complete traffic/tag/revision inventory, each pre-A disposition, last observed job/retry activity, and a successful fixed-A drain of a B-format owned row. An unresolved path is a fail, not a footnote. After that separately authorized fixed-A rollout/quiescence completes, recapture the authoritative template and traffic map immediately before the B candidate deploy:

```bash
gcloud run services describe "${SERVICE}" --project "${PROJECT_ID}" --region "${REGION}" --format=json \
  > "${EVIDENCE_DIR}/service-pre-candidate.json"
jq '.spec.template' "${EVIDENCE_DIR}/service-pre-candidate.json" \
  > "${EVIDENCE_DIR}/service-template-pre-candidate.json"
jq '[.status.traffic[]? | select((.percent // 0)>0) | {revisionName,percent,tag,latestRevision,url}]' \
  "${EVIDENCE_DIR}/service-pre-candidate.json" > "${EVIDENCE_DIR}/serving-traffic-pre-candidate.json"
jq -e 'length>0 and (map(.percent)|add)==100' "${EVIDENCE_DIR}/serving-traffic-pre-candidate.json" >/dev/null
```

## 2. Build and resolve immutable image provenance

PR #3154's [final external review](https://github.com/carson-see/ArkovaCarson/pull/3154#issuecomment-5860783149) evaluated `041f89157105a57c6602b9d064efbd41eff89b52`, confirmed the round-3 runtime corrections, and found five clean-environment test-file failures. Their test and required-schema source correction is verified and published as `b79479fea89616b1f20705f478c5ec03c0ecb824`. Read that exact source/tree from the refreshed PR body into `FIXED_A_GIT_SHA`, and build the immutable artifact below. The shared database must include0496. No image existence or rehearsal is inferred from source tests; no additional broad review round is required.

Use a clean Linux/amd64 builder. `PROVENANCE_DIR` must be an absolute, previously nonexistent path outside the checkout. Resolve `TRIVY_IMAGE` to a reviewed `aquasec/trivy` **digest** matching the repository-pinned `aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25`; an unresolved placeholder blocks execution.

```bash
export FIXED_A_TREE='<externally re-reviewed fixed-A git tree>'
export FIXED_A_TAG="${REGISTRY}/${PROJECT_ID}/${REPOSITORY}/arkova-worker-fixed-a:fixed-a-${FIXED_A_GIT_SHA}"
export TRIVY_IMAGE='<reviewed aquasec/trivy image@sha256 digest matching the pinned action>'
export PROVENANCE_DIR='<absolute external nonexistent fixed-A provenance directory>'

case "${PROVENANCE_DIR}" in /*) ;; *) echo 'Provenance directory must be absolute' >&2; exit 1;; esac
test ! -e "${PROVENANCE_DIR}"
mkdir -p "${PROVENANCE_DIR}"
export PROVENANCE_DIR="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "${PROVENANCE_DIR}")"
export SOURCE_ROOT="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$(git rev-parse --show-toplevel)")"
case "${PROVENANCE_DIR}" in "${SOURCE_ROOT}"|"${SOURCE_ROOT}"/*) echo 'Evidence directory must be outside checkout' >&2; exit 1;; esac
test "$(git rev-parse HEAD)" = "${FIXED_A_GIT_SHA}"
test "$(git rev-parse HEAD^{tree})" = "${FIXED_A_TREE}"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
sha256sum services/worker/Dockerfile services/worker/package-lock.json \
  services/worker/package.json services/worker/.npmrc \
  services/worker/tsconfig.json services/worker/tsconfig.build.json \
  services/worker/proof-keys.public.json > "${PROVENANCE_DIR}/fixed-a-inputs.sha256"
docker version > "${PROVENANCE_DIR}/docker-version.txt"
docker buildx version > "${PROVENANCE_DIR}/buildx-version.txt"
docker buildx build --platform linux/amd64 --load \
  --build-arg "BUILD_SHA=${FIXED_A_GIT_SHA}" \
  --tag "${FIXED_A_TAG}" services/worker
docker image inspect "${FIXED_A_TAG}" > "${PROVENANCE_DIR}/fixed-a-local-image.json"
jq -e '.[0].Os=="linux" and .[0].Architecture=="amd64"' "${PROVENANCE_DIR}/fixed-a-local-image.json" >/dev/null
jq -e --arg expected "BUILD_SHA=${FIXED_A_GIT_SHA}" '.[0].Config.Env|index($expected)!=null' "${PROVENANCE_DIR}/fixed-a-local-image.json" >/dev/null

docker pull "${TRIVY_IMAGE}"
docker image inspect "${TRIVY_IMAGE}" > "${PROVENANCE_DIR}/trivy-image.json"
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock "${TRIVY_IMAGE}" image \
  --vuln-type os --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 \
  "${FIXED_A_TAG}" | tee "${PROVENANCE_DIR}/fixed-a-trivy-os.txt"
```

A future authorized publication step may push the commit-specific tag only after the scan and re-review. The tag is mutable and is never the authority. Immediately resolve its registry digest, then use only `repo/image@sha256:<digest>`. This block is authorization-dependent and must not run in the present session:

```bash
docker push "${FIXED_A_TAG}"
gcloud artifacts docker images describe "${FIXED_A_TAG}" --project "${PROJECT_ID}" --format=json \
  > "${PROVENANCE_DIR}/fixed-a-registry-image.json"
export FIXED_A_DIGEST="$(jq -r '.image_summary.digest // .imageSummary.digest // empty' \
  "${PROVENANCE_DIR}/fixed-a-registry-image.json")"
case "${FIXED_A_DIGEST}" in sha256:*) ;; *) echo 'Missing registry digest' >&2; exit 1;; esac
export FIXED_A_ROLLBACK_IMAGE="${REGISTRY}/${PROJECT_ID}/${REPOSITORY}/arkova-worker-fixed-a@${FIXED_A_DIGEST}"

docker pull "${FIXED_A_ROLLBACK_IMAGE}"
docker image inspect "${FIXED_A_ROLLBACK_IMAGE}" > "${PROVENANCE_DIR}/fixed-a-pulled-image.json"
jq -e '.[0].Os=="linux" and .[0].Architecture=="amd64"' "${PROVENANCE_DIR}/fixed-a-pulled-image.json" >/dev/null
jq -e --arg expected "BUILD_SHA=${FIXED_A_GIT_SHA}" '.[0].Config.Env|index($expected)!=null' \
  "${PROVENANCE_DIR}/fixed-a-pulled-image.json" >/dev/null
```

An independent verifier performs the digest pull/inspect on a separate clean builder and binds source/tree, inputs, builder, scanner, digest and review verdict in the provenance receipt. Starting the container merely to inspect identity can register timers and is prohibited.

```bash
gcloud artifacts docker images describe "${CANDIDATE_IMAGE_TAG}" \
  --project "${PROJECT_ID}" --format=json \
  > "${EVIDENCE_DIR}/candidate-image.json"
export ACTUAL_IMAGE_DIGEST="$(jq -r '.image_summary.digest // .imageSummary.digest // empty' "${EVIDENCE_DIR}/candidate-image.json")"
test "${ACTUAL_IMAGE_DIGEST}" = "${EXPECTED_IMAGE_DIGEST}"
export CANDIDATE_IMAGE="${REGISTRY}/${PROJECT_ID}/${REPOSITORY}/${SERVICE}@${ACTUAL_IMAGE_DIGEST}"

# Only the independently qualified fixed A is the rollback floor after B creates owned rows.
test "${FIXED_A_GIT_SHA}" != 'fc9c8a6543ed3482239e5b6ae9d5c9ce1d141c23'
case "${FIXED_A_ROLLBACK_IMAGE}" in *@sha256:*) ;; *) echo 'Rollback image is not digest-pinned' >&2; exit 1;; esac
gcloud artifacts docker images describe "${FIXED_A_ROLLBACK_IMAGE}" \
  --project "${PROJECT_ID}" --format=json \
  > "${EVIDENCE_DIR}/build-a-rollback-image.json"
```

The build receipt must bind the image digest to `CANDIDATE_GIT_SHA`, the reviewed source tree, Dockerfile, lockfile, vulnerability scan decision, and client/package identities. Artifact Registry existence alone is not provenance.

## 3. Deploy one tagged production candidate with no ordinary traffic

This command uses the frozen current service template as the configuration source. Unspecified service account, CPU, memory, scaling, concurrency, timeout, networking, secret references, and ordinary environment variables inherit from that template—not necessarily from the revisions currently receiving traffic. The independent verifier must approve `service-template-pre-candidate.json` before execution and confirm the service has not changed since capture.

The baseline candidate keeps **`ENABLE_COMPUTEID_INTEGRATION=false`**, matching the deployment workflow. It verifies the gated responses but cannot satisfy positive ComputeID acceptance. Bind the durable recipient pepper using metadata only:

```bash
export RECIPIENT_PEPPER_REF='recipient-identifier-pepper:1'
secret="${RECIPIENT_PEPPER_REF%%:*}"; version="${RECIPIENT_PEPPER_REF##*:}"
gcloud secrets describe "${secret}" --project "${PROJECT_ID}" --format=json \
  > "${EVIDENCE_DIR}/secret-${secret}-metadata.json"
test "$(gcloud secrets versions describe "${version}" --secret "${secret}" \
  --project "${PROJECT_ID}" --format='value(state)')" = ENABLED
```

Read-only metadata verification on 2026-09-27 confirmed production `recipient-identifier-pepper:1` is ENABLED. Repeat immediately before execution; this does not prove candidate IAM access. It is the stable production reference and must not be rotated. An isolated rig instead uses its dedicated `recipient-identifier-pepper-<rig>-staging:1` resource. Never read, copy or compare a pepper value to the public database setting.

Binding the pepper does not authorize bulk recipient provisioning. `ENABLE_BULK_RECIPIENT_PROVISIONING=false` gates only `linkBulkRecipient` in the bulk/self-service recipient path. It does **not** disable the pre-existing single-credential recipient path (`api/recipients.ts`), admin invitations/provisioning, or every recipient email. Those independent entrypoints need explicit admission and observation or a separately reviewed blocking control. Bulk-recipient qualification requires a distinct exact revision with literal `true`, reviewed workflow/rollback evidence and configuration readback.

**ComputeID remains required acceptance, not waived work.** A separately authorized flag-on qualification must use the same frozen image with its own exact revision/configuration receipt, dedicated enabled API-key, webhook-secret and CA-certificate references, approved partner account and named positive/negative/recovery cases. It must also prove rollback to the reviewed flag-off baseline. Keep the deployment lease throughout that qualification: the normal workflow still pins false, so no later ordinary deployment may be presented as preserving flag-on behavior. Sustained activation requires a separately reviewed change to the authoritative deployment configuration and its assertions, approved before activation is considered durable. ComputeID readiness stays OPEN until the activation decision is approved, the configuration is verified, and the actual client/agent checks are complete. Do not manually enable it in the baseline command below or call a flag-off health pass partner acceptance.

`DISABLE_IN_PROCESS_ANCHOR_CRON=true` disables only the repository's named anchor-job subset. Webhook retries, credits, cleanup, chain maintenance, Drive timers, and other process-local schedules can still run after the revision is warm. This runbook selects the **monitored shared-background mode**; it does not claim tenant or background isolation.

```bash
gcloud run deploy "${SERVICE}" \
  --project "${PROJECT_ID}" \
  --region "${REGION}" \
  --platform managed \
  --image "${CANDIDATE_IMAGE}" \
  --revision-suffix "${REVISION_SUFFIX}" \
  --tag "${CANDIDATE_TAG}" \
  --no-traffic \
  --update-env-vars 'DISABLE_IN_PROCESS_ANCHOR_CRON=true,ENABLE_COMPUTEID_INTEGRATION=false,ENABLE_BULK_RECIPIENT_PROVISIONING=false' \
  --update-secrets "RECIPIENT_IDENTIFIER_PEPPER=${RECIPIENT_PEPPER_REF}" \
  --quiet
```

The approved configuration delta is therefore exact and reviewable: the existing partial anchor-timer flag becomes true, ComputeID and bulk recipient provisioning are explicitly false, and the recipient-pepper reference is pinned at its approved version. Do not add `--set-env-vars`, `--set-secrets`, a different service account, or resource/scaling flags here. Those replace or alter inherited state and require a separately reviewed manifest. Do not run the normal `deploy-worker.yml`: its final step promotes latest to full traffic.

## 4. Read back and compare before the first request

```bash
gcloud run services describe "${SERVICE}" --project "${PROJECT_ID}" --region "${REGION}" --format=json \
  > "${EVIDENCE_DIR}/service-after-candidate.json"
export CANDIDATE_REVISION="$(jq -r --arg suffix "${REVISION_SUFFIX}" \
  '.status.latestCreatedRevisionName | select(endswith($suffix))' "${EVIDENCE_DIR}/service-after-candidate.json")"
export EXPECTED_CANDIDATE_REVISION="${SERVICE}-${REVISION_SUFFIX}"
test "${CANDIDATE_REVISION}" = "${EXPECTED_CANDIDATE_REVISION}"
gcloud run revisions describe "${CANDIDATE_REVISION}" --project "${PROJECT_ID}" --region "${REGION}" --format=json \
  > "${EVIDENCE_DIR}/candidate-revision.json"

export CANDIDATE_URL="$(jq -r --arg tag "${CANDIDATE_TAG}" \
  --arg rev "${CANDIDATE_REVISION}" \
  '[.status.traffic[]? | select(.tag==$tag and .revisionName==$rev)] | if length==1 then .[0].url else empty end' \
  "${EVIDENCE_DIR}/service-after-candidate.json")"
test -n "${CANDIDATE_URL}" && test "${CANDIDATE_URL}" != null

# The tag must occur once and target exactly this revision; no other tag row may
# reuse the candidate tag or ambiguously identify another revision.
jq -e --arg tag "${CANDIDATE_TAG}" --arg rev "${CANDIDATE_REVISION}" \
  '[.status.traffic[]? | select(.tag==$tag)] | length==1 and .[0].revisionName==$rev and (. [0].url|type)=="string" and (.[0].url|length)>0' \
  "${EVIDENCE_DIR}/service-after-candidate.json" >/dev/null

# Candidate must hold zero ordinary service traffic. A tag URL is addressable
# and is not an authentication or tenant boundary.
jq -e --arg rev "${CANDIDATE_REVISION}" \
  '[.status.traffic[]? | select(.revisionName==$rev and ((.percent // 0) > 0))] | length == 0' \
  "${EVIDENCE_DIR}/service-after-candidate.json" >/dev/null

# The complete positive-percent ordinary allocation must be unchanged.
jq '[.status.traffic[]? | select((.percent // 0)>0) | {revisionName,percent,tag,latestRevision,url}] | sort_by(.revisionName,.tag)' \
  "${EVIDENCE_DIR}/service-after-candidate.json" > "${EVIDENCE_DIR}/serving-traffic-after-candidate.json"
jq -S . "${EVIDENCE_DIR}/serving-traffic-pre-candidate.json" > "${EVIDENCE_DIR}/serving-before.sorted.json"
jq -S . "${EVIDENCE_DIR}/serving-traffic-after-candidate.json" > "${EVIDENCE_DIR}/serving-after.sorted.json"
cmp --silent "${EVIDENCE_DIR}/serving-before.sorted.json" "${EVIDENCE_DIR}/serving-after.sorted.json"

# Exact image, runtime identity, and partial-timer mode.
jq -e --arg image "${CANDIDATE_IMAGE}" '.spec.containers[0].image==$image' \
  "${EVIDENCE_DIR}/candidate-revision.json" >/dev/null
jq -e --arg digest "${EXPECTED_IMAGE_DIGEST}" '.status.imageDigest==$digest' \
  "${EVIDENCE_DIR}/candidate-revision.json" >/dev/null
jq -e '[.status.conditions[]? | select(.type=="Ready" and .status=="True")] | length==1' \
  "${EVIDENCE_DIR}/candidate-revision.json" >/dev/null
jq -e --arg sa "$(jq -r '.spec.template.spec.serviceAccountName' "${EVIDENCE_DIR}/service-pre-candidate.json")" \
  '.spec.serviceAccountName==$sa' "${EVIDENCE_DIR}/candidate-revision.json" >/dev/null
jq -e '[.spec.containers[0].env[]? | select(.name=="DISABLE_IN_PROCESS_ANCHOR_CRON" and .value=="true")] | length==1' \
  "${EVIDENCE_DIR}/candidate-revision.json" >/dev/null
jq -e '[.spec.containers[0].env[]? | select(.name=="ENABLE_COMPUTEID_INTEGRATION" and .value=="false")] | length==1' \
  "${EVIDENCE_DIR}/candidate-revision.json" >/dev/null
jq -e '[.spec.containers[0].env[]? | select(.name=="ENABLE_BULK_RECIPIENT_PROVISIONING" and .value=="false")] | length==1' \
  "${EVIDENCE_DIR}/candidate-revision.json" >/dev/null
```

The independent verifier must compare the frozen **pre-candidate service template** versus candidate CPU, memory, concurrency, request timeout, service account, VPC/network settings, min/max scaling, secret names/versions, and all non-secret environment settings. Separately compare every serving revision so inherited template drift is visible rather than normalized. The only approved configuration deltas are the three explicit flags and one secret reference above; image, revision name, and tag are identity deltas. Compare references and metadata only—never read or print secret payloads. Any other delta stops the run.

Capture logs/metrics baseline for the retained stable revision and confirm the candidate has not received ordinary traffic. A standalone healthy production service is not evidence that this candidate works.

## 5. Allowed candidate requests before promotion

Direct API, TypeScript SDK, Python SDK, private CLI, and stdio MCP can point at `CANDIDATE_URL`. Use only the approved internal tenant/account and synthetic or explicitly approved records. Record the exact client artifact version and base URL. The tag URL is public-routing metadata, so normal Arkova authentication still applies.

The web UI is not covered by this path: its Vercel rewrite/CSP normally targets the stable worker. Hosted MCP is also not covered: `edge.arkova.ai` has no per-request candidate selector, and the isolated edge configuration must not receive production secrets. Do not count direct API or stdio MCP evidence as UI or hosted-MCP acceptance.

Cloud Scheduler continues to call the ordinary service URL and does not exercise a no-traffic tag. Do not pause, retarget, create, or delete Scheduler jobs under this handoff. If a scheduled route is required for candidate acceptance, the release manifest must name the exact existing route, why it is safe, its expected bounded effects, and its operator-authorized caller identity. Then invoke only that allowlisted route directly against `CANDIDATE_URL`:

```bash
export APPROVED_JOB_PATH='<exact existing /jobs/... path from the frozen manifest>'
export APPROVED_JOB_CALLER_SA='<existing authorized scheduler/test caller service account>'
export OIDC_AUDIENCE='<verified current CRON_OIDC_AUDIENCE/base service audience>'
case "${APPROVED_JOB_PATH}" in /jobs/*) ;; *) echo 'Not an existing job path' >&2; exit 1;; esac

# Mint an identity token through the approved identity path. Do not print it.
OIDC_TOKEN="$(gcloud auth print-identity-token \
  --impersonate-service-account="${APPROVED_JOB_CALLER_SA}" \
  --audiences="${OIDC_AUDIENCE}")"
curl --fail-with-body --silent --show-error --max-time 900 \
  -X POST -H "Authorization: Bearer ${OIDC_TOKEN}" \
  "${CANDIDATE_URL}${APPROVED_JOB_PATH}" \
  > "${EVIDENCE_DIR}/manual-job-response.json"
unset OIDC_TOKEN
```

An operator must replace the simple `/jobs/*` shape check with the frozen allowlist comparison before execution; the shell above is a template, not authority to call every job. Never invoke treasury-spending, backfill, billing, notification, or migration routes unless that exact route and effect is separately approved. Every call records start/end, response classification, affected synthetic identifiers, queue/accounting deltas, and logs for the candidate revision. No secret, token, customer data, or raw source document enters the evidence bundle.

## 6. Stop point and rollback floor

**Stop here.** This handoff does not authorize `gcloud run services update-traffic`, Vercel promotion, hosted-edge deployment, Scheduler changes, package publication, or a soak. A separate user-started session owns those decisions and returns the required evidence.

If the candidate must be abandoned while still at zero ordinary traffic, stop direct calls, preserve evidence, and remove the tag only after the release owner confirms no investigation needs the URL. Ordinary traffic remains on the captured **fixed-A-compatible** allocation established by the prerequisite rollout. Do not route back to a pre-A revision, delete the candidate revision, or erase logs.

Once fixed-A emergency DELETE or Build B has created an owned outbox row, rollback may use the exact qualified `FIXED_A_ROLLBACK_IMAGE` or a later image that preserves its owned-row exclusion/drainer and the retained 0488/0489/0491–0496 authorization, audit, lock-order, physical-delete, restrictive-MFA and Drive-health database boundary. Original A and every pre-A worker are below the rollback floor. Fixed A must run with `ENABLE_COMPUTEID_INTEGRATION=false`; its immutable source guard returns 503 for register, all PATCH updates and key mint, while authenticated emergency DELETE uses the transactional revoke-with-outbox RPC; reads and both retry paths remain available. Before any later promotion, rehearse the digest-pinned fixed-A deploy with that reviewed configuration, prove the scheduled drainer completes the owned-row format produced by fixed-A DELETE and Build B, and retain the Build B image for roll-forward. Rollback retains all candidate-required migrations 0488/0489/0491/0492/0493/0494/0495/0496 and must not drop or reclassify pending owned rows; terminal-row cleanup follows the reviewed migration contract. If the fixed-A digest, maintenance-window authorization, or rehearsal receipt is missing, rollback readiness is **OPEN** and promotion is prohibited. A failed revocation audit write rolls back the revocation and leaves its key active; the operator must record failure, retry through the authorized path, and escalate rather than claim success. Migration 0491 uses bounded lock and statement timeouts around hot-table work, so the operator must inspect blockers/table size and schedule a maintenance window instead of bypassing a timeout.

## 7. Evidence returned to the release owner

Return: candidate commit/tree and included PR heads; immutable image digest plus provenance; main baseline; migration checksums and ledger before/after; stable and candidate revision JSON; traffic/tag URL metadata; runtime service account/resource/network/secret-reference comparison; exact background mode and observed timers; client/package identities and candidate origins; each allowlisted manual job invocation; baseline-versus-candidate errors, latency, queues and accounting; aborts; rollback-floor image and rehearsal result; and explicit pass/fail/open acceptance. Redact tokens, secret values, customer data and source documents.

The release owner then decides whether to proceed to the separately planned production soak and promotion workflow. Time elapsed, a health response, or this runbook's completion is not acceptance.


## Historical fallback correction checkpoint

Fixed-A correction `0ff11a14e4e85ab8c7931b6df3cfe5cca761ca2d` (tree `6deee788a4a0ea73338146e435350345c00317fd`) was an intermediate correction after `10459180091b9cb4d88313b5e7108ccc297d57f2`; it is historical and must not be selected as the rollback artifact. The final broad review evaluated later checkpoint `041f89157105a57c6602b9d064efbd41eff89b52`; the resulting test and required-schema source correction is published as `b79479fea89616b1f20705f478c5ec03c0ecb824`, the exact source for the pending rollback image. Authenticated emergency DELETE uses the human/API-key transactional outbox revoke RPC; register, all PATCH updates and key mint remain held at 503. Malformed claims are safely reported and skipped so later valid claims complete.

Historical evidence: 115 focused lifecycle/delivery tests passed; subsequent affected webhook suites passed 98 tests, with the final prompt-drain suite passing 8 tests. These runs overlap and must not be summed or treated as final exact-head qualification. Worker lint, typecheck and build passed at that intermediate checkpoint. No new SQL migration or TLA state-machine change was introduced; the existing transaction model does not prove deployed behavior. An immutable image, configuration checks, quiescence and rehearsal remain required. Emergency DELETE can produce an owned row: stop incompatible old worker/job paths before its first use, not merely before Build B traffic. PR #3154 remains draft and protected by `do-not-merge`; it must never merge into the forward candidate or main.

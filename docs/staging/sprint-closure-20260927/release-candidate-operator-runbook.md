# Production candidate handoff — manual commands, stop before promotion

Prepared 2026-09-27 from the read-only production-candidate feasibility audit and the current `deploy-worker.yml`. This is a command draft for a separately started, authorized release session. **Do not run it in this session.** It creates a real production Cloud Run revision when run. It deliberately contains no promotion command, no traffic update, no Scheduler mutation, no secret value, and no soak acceptance claim.

## Execution gate: external review and named acceptance

This runbook is not executable until the release owner records an immutable external-review packet and reviewer scope, dispositions for every material finding, the exact fixes made, affected verification reruns, a final external re-review verdict, and a receipt tying that verdict to the frozen candidate. Any unresolved material finding is a stop. Internal review, green component tests, or an earlier candidate review cannot substitute for this receipt.

The future operator must also use the [named acceptance matrix](named-acceptance-matrix.md) and the decision register in the [release and soak plan](release-soak-plan.md). Those files own the case IDs, actors, prerequisites, visible results, negative and recovery cases, evidence filenames, owners, and open decisions; this command runbook does not duplicate them. Missing required rows, owners, prerequisites, or decisions are blocking rather than implicitly waived.

The order remains: freeze and externally re-review the source candidate; qualify the exact combined T3 candidate in isolated staging; evaluate every acceptance row applicable to this release stage and record every other conditional or separately reported row honestly as open/not-applicable without treating it as an unrelated-release blocker; then perform a separately authorized zero-traffic production observation with this runbook. Staging evidence, zero-traffic production observation, and the later production soak are distinct gates and cannot substitute for one another. This session performs none of them and starts no soak.

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
export FIXED_A_GIT_SHA='10459180091b9cb4d88313b5e7108ccc297d57f2'
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

The operator also records the production migration ledger and proves every candidate-required migration is applied in the approved order. This runbook does not guess or apply that list. Migration work follows the repository's numeric-ledger and schema-cache rules and must finish before the candidate receives a request.

Latest exact-head CI receipt: run 36350052692, job 108706868259, successfully read production on September 27 and found migrations 0488, 0489, 0491, 0492, 0493, and 0494 absent. The migration-drift failure is an open release-state gate, not permission to apply them here. Before a future production apply, the operator must also satisfy the separate `CLAUDE.md` §0 rule10 apply-order hook: each prefix must already be on main or have the explicitly reviewed prefix exemption required by that hook. These prefixes are not on the current main. Resolve that sequencing prerequisite with the release owner before executing an apply; do not bypass the hook, fabricate ledger rows, or silently add a CI `exempt_regex`. A reviewed operational exception is not migration acceptance. Staging qualification precedes production; preserve exact SQL checksums, reconcile real applied numeric ledger rows in the authorized apply session, and retain the red gate until its condition is genuinely satisfied. Detailed receipt: `pr3152-migration-drift-diagnostic-20260927.md`.


### Mandatory AR20-13 A/B floor before Build B receives any request

Migrations `0491`, `0492`, `0493`, and forward-only `0494` must be retained and applied in reviewed order. Migration `0490` belongs to another PR/session and must not be swept in by an unreviewed include-all or default database push; its owner evidence and the exact ledger plan are separate prerequisites. The current published runtime source checkpoint is `ce545a2f6315f81e087640d0520d6a6f05e98c95` (tree `8288c37ff07336d0e63d46074f6f7d11d18b54d8`, based on main `d3ebb81f000a81a9cc835118961e06c701fe4da2`). Its database evidence is exact but layered: the historical zero-row platform-schema bootstrap applied 189 migrations through 0493, then the 0494 migration and its native concurrency/delete harness passed against that full schema. This is not a claim that a fresh 190-migration bootstrap replay ran. This is local qualification, not a production-ledger or deployed-runtime claim. The original Build A commit `fc9c8a6543ed3482239e5b6ae9d5c9ce1d141c23` is **not** an acceptable compatibility or rollback image: it can drain owned rows, but its ComputeID admission calls the legacy owner-attributed RPC without the caller ceiling; generic register and key mint are direct writes after route-only authority checks; and non-status PATCH also writes after a route-only caller check. With 0492 and 0493 applied, status PATCH uses the corrected atomic RPC, revoke still uses its atomic RPC, and provider transitions use the corrected 0492 function. Turning `ENABLE_COMPUTEID_INTEGRATION=false` closes admission/provider surfaces but still leaves register, key mint, and non-status PATCH unqualified. The fixed-A design below blocks all generic lifecycle mutations anyway: that single auditable read-only maintenance boundary is deliberate and does not claim the old revoke RPC itself is defective.

The published fixed compatibility-A commit `46f3ac519741c1c0cf71be84308bd9c9009800f8` is now historical because it predates the reviewed default-off bulk-recipient gate. The seven-path successor is published as review-only draft PR #3154 at `10459180091b9cb4d88313b5e7108ccc297d57f2`. Its pre-commit diff `deb8ee72313a87db170fe920c18a4d6db89382e83ea7671c752e6a4b6bdc6ccb` passed independent source review; its immutable image is still missing, so `FIXED_A_ROLLBACK_IMAGE` remains unresolved before execution. Historical `3f7238d5a4b115ba2eca69d277afa2beb2c9534d` is superseded and must not be selected as the current floor. It adds original A's 0491 drainer/legacy-retry exclusion to a fail-closed mutation guard that always returns `503 {error:{code:'compatibility_floor_read_only'}}` before DB/key generation for exactly `POST /api/v1/agents`, `PATCH /api/v1/agents/:agentId`, `DELETE /api/v1/agents/:agentId`, and `POST /api/v1/agents/:agentId/key`. It keeps `GET /api/v1/agents` and `GET /api/v1/agents/:agentId`, the owned-row drainer, and legacy retry processing available. Its deployment configuration must also pin existing `ENABLE_COMPUTEID_INTEGRATION=false`, which gates admission, provider webhook intake, and passport recheck. This is a dedicated immutable maintenance/rollback build, not a new runtime flag and not a claim that original A is safe.

Independent source review passed for the successor fixed-A diff (`docs/staging/sprint-closure-20260927/fixed-a-review.md`): 121 focused tests, worker typecheck and focused lint passed. Its source commit is fixed; its immutable image identity and every runtime gate below remain open. The earlier 373-test and clean-build receipt belongs to historical `46f3ac519`, so it is supporting lineage rather than qualification of the successor artifact. Root and an independent reviewer confirmed the three-path correction, maintenance guard, and Build-B-row drain behavior. The retry witness uses mocked database and receiver boundaries: it executes the real `processWebhookRetries()` materialize/claim/complete path and is linked by a separate mounted-route test, but it is not a SQL end-to-end test or an actual Scheduler execution. A clean local `tsc -p tsconfig.build.json` emitted 2,789 files; the sorted per-file SHA-256 manifest is `fixed-a-compat-build/dist-files-46f3ac519.sha256` with manifest SHA-256 `eb24cbca154a335e29bbc4e8993d07afd77838248ed24c2ad5ba7875c5d4bdad`. No container image, registry digest, Cloud Run revision, maintenance-window approval, or rollback rehearsal exists yet, so the deployable artifact and rehearsal gates remain **OPEN**.

The current runtime source checkpoint is published on draft PR #3152 at `ce545a2f6315f81e087640d0520d6a6f05e98c95` (tree `8288c37ff07336d0e63d46074f6f7d11d18b54d8`, main base `d3ebb81f000a81a9cc835118961e06c701fe4da2`). Earlier `0d006b61e` build/test totals remain historical lineage only. Current local qualification and review receipts are in `final-local-qualification.md` and `review-dispositions.md`. The database boundary is the 189-migration replay through 0493 plus the separately passing 0494 migration/native harness on that full schema; no fresh 190-migration replay is claimed. These source/build checks do not replace immutable image provenance, hosted migration-ledger verification, fixed-A deployment/quiescence, or the single combined T3 staging and production qualification.

Before this runbook may execute, `FIXED_A_GIT_SHA` and `FIXED_A_ROLLBACK_IMAGE` must exist and be independently qualified: all four generic mutations fail before DB/RPC/key generation; both reads remain usable; ComputeID admission/webhook return `vendor_gated` and recheck reports `flag_off`; a B-format owned row is materialized, claimed and completed by the real scheduled retry entry point; legacy unowned retry rows remain on the legacy sweep; and exact image provenance binds those results to the digest. Because fixed A intentionally pauses agent mutations, the release owner must approve and communicate the bounded maintenance window before routing ordinary traffic to it. Until that artifact and window exist, **AR20-13 rollout and rollback rehearsal are blocked**.

Then the fixed compatibility-A worker must be deployed to **every active worker/job execution path** before any Build B producer request. Every revision with traffic, every tag that operators or jobs can address, and every warm zero-traffic revision capable of running process-local jobs must either run fixed A-or-later or be explicitly quiesced. `--no-traffic` does not quiesce a revision: minimum instances, a tag request, or process-local timers can keep it alive.

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

## 2. Resolve the immutable image and provenance

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

Health-only inheritance is insufficient for this release. The reviewed candidate delta must bind the existing durable recipient pepper and deliberately activate the ComputeID paths under test. Freeze the exact secret **references** and versions without reading their values:

```bash
export RECIPIENT_PEPPER_REF='recipient-identifier-pepper:1'
export COMPUTEID_API_KEY_REF='<existing dedicated Secret Manager name>:<approved pinned version>'

# Metadata-only preflight. Stop if either resource/version is absent or disabled.
for ref in "${RECIPIENT_PEPPER_REF}" "${COMPUTEID_API_KEY_REF}"; do
  secret="${ref%%:*}"; version="${ref##*:}"
  gcloud secrets describe "${secret}" --project "${PROJECT_ID}" --format=json \
    > "${EVIDENCE_DIR}/secret-${secret}-metadata.json"
  test "$(gcloud secrets versions describe "${version}" --secret "${secret}" \
    --project "${PROJECT_ID}" --format='value(state)')" = 'ENABLED'
done
```

For this production candidate, `recipient-identifier-pepper:1` is the existing stable production reference; it is not a rig secret and must not be rotated. An isolated rig instead uses its dedicated `recipient-identifier-pepper-<rig>-staging:1` resource. Binding either pepper does not authorize bulk recipient provisioning. The production candidate explicitly keeps `ENABLE_BULK_RECIPIENT_PROVISIONING=false`. A separately approved recipient qualification would require a distinct exact revision with literal `true`, complete workflow/rollback evidence, and captured configuration readback.

The ComputeID webhook secret and CA certificate references must already exist in the frozen service template and remain unchanged. If `COMPUTEID_API_KEY_REF` is unresolved, no dedicated enabled version exists, or partner authorization is absent, the ComputeID production-candidate gate is blocked. Do not turn the flag on merely to obtain a green boot or substitute a secret from another environment.

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
  --update-env-vars 'DISABLE_IN_PROCESS_ANCHOR_CRON=true,ENABLE_COMPUTEID_INTEGRATION=true,ENABLE_BULK_RECIPIENT_PROVISIONING=false' \
  --update-secrets "RECIPIENT_IDENTIFIER_PEPPER=${RECIPIENT_PEPPER_REF},COMPUTEID_API_KEY=${COMPUTEID_API_KEY_REF}" \
  --quiet
```

The approved configuration delta is therefore exact and reviewable: the existing partial anchor-timer flag becomes true, ComputeID becomes true, bulk recipient provisioning is explicitly false, and the two named secret references are bound at their approved versions. Do not add `--set-env-vars`, `--set-secrets`, a different service account, or resource/scaling flags here. Those replace or alter inherited state and require a separately reviewed manifest. Do not run the normal `deploy-worker.yml`: its final step promotes latest to full traffic.

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
jq -e '[.spec.containers[0].env[]? | select(.name=="ENABLE_COMPUTEID_INTEGRATION" and .value=="true")] | length==1' \
  "${EVIDENCE_DIR}/candidate-revision.json" >/dev/null
jq -e '[.spec.containers[0].env[]? | select(.name=="ENABLE_BULK_RECIPIENT_PROVISIONING" and .value=="false")] | length==1' \
  "${EVIDENCE_DIR}/candidate-revision.json" >/dev/null
```

The independent verifier must compare the frozen **pre-candidate service template** versus candidate CPU, memory, concurrency, request timeout, service account, VPC/network settings, min/max scaling, secret names/versions, and all non-secret environment settings. Separately compare every serving revision so inherited template drift is visible rather than normalized. The only approved configuration deltas are the three explicit flags and two secret references above; image, revision name, and tag are identity deltas. Compare references and metadata only—never read or print secret payloads. Any other delta stops the run.

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

Once AR20-13 Build B has created owned outbox rows, rollback may use the exact qualified `FIXED_A_ROLLBACK_IMAGE` or a later image that preserves its owned-row exclusion/drainer and the retained 0492/0493/0494 authorization, audit, lock-order, and physical-delete database boundary. Original A and every pre-A worker are below the rollback floor. Fixed A must run with `ENABLE_COMPUTEID_INTEGRATION=false`; its immutable source guard returns 503 for all four generic mutation routes while reads and both retry paths remain available. Before any later promotion, rehearse the digest-pinned fixed-A deploy with that reviewed configuration, prove the scheduled drainer completes a B-format owned row, and retain the Build B image for roll-forward. Database rollback retains 0491/0492/0493/0494 and must not drop or reclassify pending owned rows; terminal-row cleanup follows the reviewed migration contract. If the fixed-A digest, maintenance-window authorization, or rehearsal receipt is missing, rollback readiness is **OPEN** and promotion is prohibited. A failed revocation audit write rolls back the revocation and leaves its key active; the operator must record failure, retry through the authorized path, and escalate rather than claim success. Migration 0491 uses bounded lock and statement timeouts around hot-table work, so the operator must inspect blockers/table size and schedule a maintenance window instead of bypassing a timeout.

## 7. Evidence returned to the release owner

Return: candidate commit/tree and included PR heads; immutable image digest plus provenance; main baseline; migration checksums and ledger before/after; stable and candidate revision JSON; traffic/tag URL metadata; runtime service account/resource/network/secret-reference comparison; exact background mode and observed timers; client/package identities and candidate origins; each allowlisted manual job invocation; baseline-versus-candidate errors, latency, queues and accounting; aborts; rollback-floor image and rehearsal result; and explicit pass/fail/open acceptance. Redact tokens, secret values, customer data and source documents.

The release owner then decides whether to proceed to the separately planned production soak and promotion workflow. Time elapsed, a health response, or this runbook's completion is not acceptance.

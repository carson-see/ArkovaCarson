# Prod Enablement Checklist — 2026-08 Launch

> **Story:** SCRUM-2980 companion (RTE lane). Founder directive D8 (ratified sprint plan, 2026-07-28, second batch): *"Sprint success = the 72h soak actually starting, with the workflows we began now closed out, their bugs/gaps fixed, features ENABLED in prod (flag flips), failures checked and everything verified. Flag flips remain founder-executed but I must surface the exact list, with rationale and rollback, rather than leaving them vague."* This document is that list.
> **Companion:** [72h-soak-runbook-2026-08.md](./72h-soak-runbook-2026-08.md) (soak #1) — this checklist is executed **after** that soak matures and its per-flag evidence is captured, not before, and not as a precondition for starting the soak clock.
> **Obeys:** `CLAUDE.md` §1.9 (feature flags), §1.13 (config-drift / R-5 asserted-state manifest), §1.11A (staging integrity — no flip without soak evidence for money/anchoring/webhook-adjacent flags).
> **Verification method:** every "current verified value" row below was checked live in this session (2026-07-28) via `gcloud run services describe arkova-worker --region=us-central1 --project=arkova1` (Cloud Run revision `arkova-worker-01141-pon`, image `...arkova-worker:7b4e43d216453326500fe4dde84c49c9df5063bd`) and Supabase MCP `execute_sql` against prod project `vzwyaatejekddvltxyye`. Nothing here is inferred from code defaults, docs, or memory alone (`memory/feedback_assert_prod_state_directly.md`) — where code was read, it is cited to explain *why* the live value is what it is, not as a substitute for checking it.
> **gcloud note:** the local `gcloud` CLI crashes under the system Python 3.9 (`CommandLoadFailure` on `gcloud.run.services`). Workaround used this session: `CLOUDSDK_PYTHON=/opt/homebrew/opt/python@3.14/bin/python3.14 gcloud ...`. Anyone re-running these verification commands on this machine needs the same override (or `gcloud components reinstall` — not attempted here, out of scope).

---

## 1. Quick-reference table

| Flag / config | Current (verified live 2026-07-28) | Target for 2026-08 launch | Mechanism | Executor |
|---|---|---|---|---|
| `ENABLE_OUTBOUND_WEBHOOKS` | `false` (DB, dark since 2026-03-13) | `true` | DB (`switchboard_flags`, `get_flag()` RPC, 30s in-process cache) | **Founder** |
| `ENABLE_ORG_CREDIT_ENFORCEMENT` | `false` (env var unset; DB mirror row also `false` but does not gate) | **stays `false`** — not part of this launch | Env var (`deploy-worker.yml`) | **Founder** (deferred, G3-gated) |
| `ENABLE_CONNECTOR_ARTIFACT_DRAIN` | `false` (env var unset) | `true`, IF the drain consumer (QUEUE-06/08) is verified working this sprint — else stays `false` | Env var (`deploy-worker.yml`) | **RTE**, contingent on sprint outcome |
| `ENABLE_CONNECTOR_ARTIFACT_ENQUEUE` | `false` (env var unset) | `true`, **after** DRAIN is confirmed consuming (see §2.3 ordering) | Env var (`deploy-worker.yml`) | **RTE**, same contingency as DRAIN |
| `ENABLE_QUEUE_DIGEST` | `false` (env var unset) | stays `false` for this launch — recipient config + timezone decision (EST-fixed vs local) still open | Env var (`deploy-worker.yml`) | **Founder** (decision needed first), then RTE executes |
| `ENABLE_INSTANT_SECURE` | **does not exist as a flag** — verified: no such key in `services/worker/src` at HEAD `391cc7a0`, not in `flagRegistry.ts`, not in `config.ts` | N/A this launch — ships dark as a *product surface* gated by `ENABLE_ORG_CREDIT_ENFORCEMENT` + queue/checkout flags per design (see §2.5), not a standalone `ENABLE_INSTANT_SECURE` key | — | — |
| `GEMINI_LITE_MODEL` | `gemini-2.5-flash` (pinned, already fixed via #1573) | no change — already correct | Env var (`deploy-worker.yml`) | done, no action |
| `GEMINI_DISTILLATION_MODEL` | **unset** — falls back to `gemini-3-flash-preview` (sunset preview SKU, same 404-risk class as the lite-model bug #1573 already fixed) | pin to a live, non-preview model (`gemini-2.5-flash` unless L3-B4 lands a different value) | Env var (`deploy-worker.yml`) | **RTE** |
| `process-anchors` Cloud Scheduler job | **`ENABLED`**, last ran 2026-07-28T15:30:01Z, no error status | no change needed — already running | Cloud Scheduler | done, no action (see §2.7 correction) |
| `anchor-public-records` Cloud Scheduler job | **`ENABLED`**, last ran 2026-07-28T15:40:01Z, no error status | no change needed — already running | Cloud Scheduler | done, no action (see §2.7 correction) |
| `MEMPOOL_API_URL` | **unset** (verified absent from live env) | **stays unset, permanently** | Env var (absence is the correct state) | N/A — negative check only |

---

## 2. Per-flag detail

### 2.1 `ENABLE_OUTBOUND_WEBHOOKS`

- **Current verified value:** `false`. Query: `select flag_key, enabled, description, updated_at from switchboard_flags where flag_key='ENABLE_OUTBOUND_WEBHOOKS'` against `vzwyaatejekddvltxyye` → `enabled=false`, `updated_at=2026-03-13 20:13:34 UTC`. Description: "Gates outbound webhook delivery." Dark for over four months.
- **Target:** `true`.
- **Mechanism:** DB-backed (`services/worker/src/middleware/flagRegistry.ts` `DB_FLAGS`), read via `db.rpc('get_flag', {p_flag_key:'ENABLE_OUTBOUND_WEBHOOKS'})` in `services/worker/src/webhooks/delivery.ts` (`isOutboundWebhooksEnabled()`). **A single SQL `UPDATE` flips it — no redeploy required.** The read path caches the resolved value in-process for 30s (`FLAG_CACHE_TTL_MS`, WH-4) and fails closed on any RPC error (returns `false`, not cached, so the next call re-reads). Per the code's own comment: *"when Carson flips the flag ON post-soak the worker begins delivering within one TTL"* — i.e. effective within 30 seconds of the flip, across all live instances, with no deploy.
- **Blast radius:** every org with a registered webhook endpoint starts receiving live deliveries the moment the flag flips — this is customer-facing the instant it's ON, not staged behind a deploy. High blast radius for a config change with this little mechanical friction; the risk is entirely in *when* to flip, not *how*.
- **Verification step (before flip):** confirm this soak's B2 (`delivery_log` hardening) and B3 (webhook enablement runbook + Developer tab) evidence is in the 72h soak's captured pillars (§5 of the soak runbook — DocuSign webhook liveness triad + concurrent delivery evidence). Confirm `docs/release/*webhook*runbook*` (B3 deliverable) exists and was followed once dry, if it lands this sprint.
- **Verification step (after flip):** `select flag_key, enabled, updated_at from switchboard_flags where flag_key='ENABLE_OUTBOUND_WEBHOOKS'` shows `enabled=true`; trigger one real low-risk webhook-eligible event in prod and confirm a `delivery_log` row appears with a 2xx from the receiving endpoint within the expected window.
- **Rollback:** `UPDATE switchboard_flags SET enabled=false WHERE flag_key='ENABLE_OUTBOUND_WEBHOOKS'` — takes effect within 30s (same TTL as the forward flip), fail-closed semantics mean an RPC error during rollback also defaults to OFF, not ON. No redeploy either direction.
- **CI drift housekeeping:** `scripts/ci/config-drift/expected-prod-config.json` already anticipates this exact flip — its `_pendingLaunchFlagsNote` says verbatim: *"ACTIVATION (Carson, post-12h-T2-soak + prod flip): move `ENABLE_OUTBOUND_WEBHOOKS` into `flags: true` + `launchRequiredFlags`, add it to `prod-config-snapshot.json` `flags: true`, and add `ENABLE_OUTBOUND_WEBHOOKS=true` to `deploy-worker.yml` `--set-env-vars` so it fails SAFE."* Do this in the **same PR** as the flip (or immediately after) — until then the config-drift gate treats the flag as intentionally pending, not asserted, so a flip without this update leaves the asserted-state manifest stale (§1.13 R-5 obligation).
- **Executor:** **Founder** (customer-facing, immediate blast radius, no deploy gate to slow down a mistake).

### 2.2 `ENABLE_ORG_CREDIT_ENFORCEMENT`

- **Current verified value:** `false`, confirmed two independent ways:
  1. **The real gate is an env var**, not the switchboard row. `services/worker/src/middleware/flagRegistry.ts` lists it under `ENV_FLAG_GETTERS` (`() => config.enableOrgCreditEnforcement`), and `config.ts` sets `enableOrgCreditEnforcement: boolFlag(false)` — default OFF unless `ENABLE_ORG_CREDIT_ENFORCEMENT` is set in the deploy env. It is **absent** from both `deploy-worker.yml`'s `--set-env-vars` line and the live Cloud Run revision's env dump.
  2. The `switchboard_flags` row (`enabled=false`) is explicitly **not** the gate — its own `description` states: *"AUDIT MIRROR ONLY — this row does NOT gate enforcement and the worker never reads it. The runtime gate is the ENABLE_ORG_CREDIT_ENFORCEMENT env var in deploy-worker.yml... Launch-gated org credit-ledger enforcement (G4); keep false, and keep the env var unset, until HakiChain balance is funded (G3)."*
- **Target for this launch: stays `false`.** This is a deliberate hold, not an oversight. Per R10 (ratified sprint plan): *"ENABLE_ORG_CREDIT_ENFORCEMENT flip stays founder-gated post-soak."* Per the switchboard row's own note, it is gated on HakiChain balance funding (G3), which is out of scope for this sprint's launch. `scripts/ci/config-drift/expected-prod-config.json` pins it `false` in both `flags` and `prod-config-snapshot.json`, and explicitly documents: *"Do not flip before HakiChain funding (G3, founder-owned)."*
- **Why it's in this checklist at all:** the 72h soak (R17) deliberately runs this flag `ON` in the rig to exercise this wave's credit/queue work (A3 fail-closed, A5 admin adjust, R4 `org_credits` canon) — so the soak evidence for this surface will exist, but flipping prod is explicitly **not** the next step after a green soak. Don't let a green rig result create pressure to flip this before G3.
- **Blast radius if flipped prematurely:** every org's anchor submission starts enforcing credit balance server-side; any org with a zero/negative balance under the old unenforced path would suddenly get blocked. This is why it's funding-gated, not soak-gated.
- **Verification step:** none needed for this launch — confirm it stays absent from `deploy-worker.yml` and the live env at each subsequent deploy (the config-drift CI gate already fails closed on an unacknowledged env-flag-on with no DB guard, per `expected-prod-config.json`'s `_orgCreditEnforcementNote`).
- **Rollback:** N/A (not flipping).
- **Executor:** **Founder**, deferred — not an action item for the 2026-08 launch.

### 2.3 `ENABLE_CONNECTOR_ARTIFACT_DRAIN` and `ENABLE_CONNECTOR_ARTIFACT_ENQUEUE`

- **Current verified value:** both `false` (env vars, absent from `deploy-worker.yml` and the live Cloud Run env). `config.ts` comments make the dependency explicit:
  - `enableConnectorArtifactEnqueue` (line ~287): *"Default false: the row's drain consumer (QUEUE-06/SCRUM-2352, QUEUE-08/SCRUM-2354) is unbuilt, so enqueuing now would pile up `pending` rows that nothing anchors. Cloud Run prod env sets this to true explicitly once the drain ships."*
  - `enableConnectorArtifactDrain` (line ~295): *"the drain charges credits at SECURING and anchors to Bitcoin, so it stays gated until launch-approved per org. Cloud Run prod env sets this true explicitly once the consumer is signed off."*
- **Target:** contingent, not unconditional. R3 (ratified sprint plan) says the Drive connector work is being FINISHED this sprint (*"consumer QUEUE-06 already on main via #1366; SCRUM-2492 hardening already on main — Jira stale. One wiring PR (L3-B1)"*) — but `memory/project_connector_pipeline_consumer_gap.md` flags the same surface as still having an unbuilt QUEUE-06/08 consumer as of an earlier session. **Verify the actual current state of the consumer (not memory, not the sprint plan's stated intent) before flipping either flag** — re-check whether #1366 and the L3-B1 wiring PR are both actually merged to `main` at flip time.
- **Order matters:** enable `ENABLE_CONNECTOR_ARTIFACT_DRAIN` first (harmless — nothing is queued yet, so the drain cron simply no-ops with `skipped:true` on every run), verify the `/jobs/drain-connector-artifacts` route runs clean for one cron cycle, **then** enable `ENABLE_CONNECTOR_ARTIFACT_ENQUEUE`. Reversing the order (enqueue before drain is confirmed working) risks piling up `pending` `connector_artifact` rows that nothing consumes — exactly the failure mode `config.ts`'s own comment warns about.
- **Blast radius:** DRAIN charges credits at SECURING and anchors to Bitcoin per-org — real money and real chain writes the moment both flags are on and artifacts start flowing. Also note the DS-05 cross-field guard: `enableDocusignQueueReconciliation` requires `enableConnectorArtifactEnqueue=true` or the worker fails closed at boot (`config.ts` `superRefine`) — if DocuSign queue reconciliation is also being turned on this launch, sequence it after ENQUEUE, not before.
- **Verification step:** after DRAIN-only: confirm one full cron cycle logs `skipped:true` with no errors. After DRAIN+ENQUEUE: enqueue one real connector-fetched document (e.g. via a test DocuSign/Drive connection), confirm a `connector_artifact` row appears `pending`, then confirm it transitions to `SECURED`/anchored within one drain cycle, with a credit deduction matching the org's plan.
- **Rollback:** flip `ENABLE_CONNECTOR_ARTIFACT_ENQUEUE=false` first (stops new rows), let the drain finish existing `pending` rows or leave them queued (they are safe to sit — the drain no-ops cleanly when off), then flip `ENABLE_CONNECTOR_ARTIFACT_DRAIN=false`. Both require a `deploy-worker.yml` env change + redeploy (not a DB flip) — budget for a deploy cycle on rollback, this is not instant like §2.1.
- **Executor:** **RTE**, contingent on the consumer being genuinely verified merged and working — this is a config/env change (not customer communication or irreversible-in-a-click), and CLAUDE.md's "don't over-gate executable work" guidance treats this class of infra flip as RTE-owned once soak-evidenced. If the consumer is NOT actually done at flip time, do not flip — leave both `false` and note it as still-blocked in the go/no-go (§4).

### 2.4 `ENABLE_QUEUE_DIGEST`

- **Current verified value:** `false` (env var, absent from `deploy-worker.yml` and live env). `config.ts` comment: *"`runDailyQueueDigest` no-ops (never enumerates admins, never sends mail). Flip to true only after the soak + a deliberate prod rollout."*
- **Target for this launch: stays `false`.** Blocking open question per the ratified sprint plan (Sprint B, L2-B1): *"digest recipients + 6pm EST scheduler note (America/New_York, ask founder EST-fixed vs local)"* — the recipient list and the exact schedule (fixed-EST vs each-org's-local-time) are still open founder decisions, not yet resolved as of this checklist's authoring. Flipping the flag without that decision made would ship a digest with an undecided cadence.
- **Blast radius (once decided and flipped):** low-risk relative to the others — it's an outbound email digest to org admins, not a money or chain-write path. The risk is entirely in the timezone/recipient-list decision being wrong, not the mechanism.
- **Verification step:** once the founder decision lands, confirm the L2-B1 PR's soak evidence covers at least one real digest send in the rig (or a T1-tier smoke test, since this isn't a T2/T3-class surface) before flipping prod.
- **Rollback:** flip back to `false` in `deploy-worker.yml` + redeploy — the digest job simply stops running.
- **Executor:** **Founder** decides recipients/timezone first; **RTE** executes the flag flip once that decision is recorded (e.g. in HANDOFF.md or the L2-B1 PR body).

### 2.5 `ENABLE_INSTANT_SECURE`

- **Current verified value:** this flag **does not exist in the codebase** as of HEAD `391cc7a0` (2026-07-28). Verified via a repo-wide search for `instantSecure`/`InstantSecure`/`instant_secure`/`INSTANT_SECURE` in `services/worker/src` and `src/` — no matches outside planning docs (`docs/sprint-0/lane2/*`).
- **What "ships dark" means here, precisely:** per R5 (ratified sprint plan) and the config-drift manifest's own note (`expected-prod-config.json` `_flagSpofNote`): *"instant-secure stays HIDDEN until QUEUE-08+ledger pass T3 (launch-gating, PRD §11) — it is a product surface, not a single env flag, so it is asserted via the queue/checkout flags rather than a fabricated `ENABLE_INSTANT_SECURE` key."* Lane-2's pre-design (`docs/sprint-0/lane2/README.md`) is explicit that Instant Secure's real gate at GA is `ENABLE_ORG_CREDIT_ENFORCEMENT` being ON (so instant anchoring isn't free) plus a `DOUBLE_BILLING_RISK` alarm — i.e. it rides on top of §2.2's flag, not a standalone one.
- **Target for this launch:** land the L2-A2 build (code-complete per R5), verify it is genuinely unreachable from any UI surface with the feature incomplete (no orphaned partial UI), and leave it there. **No prod flag flip of any kind is part of this launch** — the flip is explicitly a **post-soak founder decision**, and per §2.2 it cannot meaningfully activate before `ENABLE_ORG_CREDIT_ENFORCEMENT` is flipped anyway (G3-gated, out of scope here).
- **Verification step:** confirm via `grep -rn "instant" src/ services/worker/src/ --include=*.ts` (adjust for however the sprint names it) that no reachable route/component exposes the feature to end users while it's meant to be dark — this is the same "ship the UI, not just the hook" / orphaned-feature pattern already found elsewhere in this sprint's bulk-upload audit (`memory/feedback_ship_the_ui_not_just_the_hook.md`), just inverted: here the risk is an ACCIDENTAL UI surface for something that's supposed to stay hidden.
- **Rollback:** N/A — nothing is enabled.
- **Executor:** N/A for this launch (no prod action); **RTE** verifies the dark-ship claim is actually true before declaring this item closed.

### 2.6 Gemini model pins

- **`GEMINI_LITE_MODEL`:** verified live in prod env = `gemini-2.5-flash`. This is already the fix from PR #1573 (`SCRUM-2909`, referenced in HANDOFF.md). No action needed — confirmed correct, not re-flipping anything.
- **`GEMINI_DISTILLATION_MODEL`:** verified **absent** from both `deploy-worker.yml`'s `--set-env-vars` list and the live Cloud Run revision's env. Per `services/worker/src/ai/gemini-config.ts`:
  ```
  const DEFAULT_DISTILLATION_MODEL = 'gemini-3-flash-preview';
  export const GEMINI_DISTILLATION_MODEL = process.env.GEMINI_DISTILLATION_MODEL ?? DEFAULT_DISTILLATION_MODEL;
  ```
  Prod is therefore silently running on `gemini-3-flash-preview` — a sunset preview SKU, the **same failure class** as the `GEMINI_LITE_MODEL` bug already fixed (`memory/project_gemini_lite_model_404.md`: *"DEFAULT_LITE/DISTILLATION models are sunset preview SKUs → /ai/tags 100% 404; prod-latent; fix=pin GEMINI_LITE_MODEL"* — that memory note names both vars; only the lite one was actually pinned by #1573). This is a **live, currently-unverified-but-plausible prod bug**, not a hypothetical.
- **Target:** pin `GEMINI_DISTILLATION_MODEL` to a live, non-preview model — `gemini-2.5-flash` unless the sprint's L3-B4 item ("Gemini defaults fix — gemini-config.ts + GEMINI_DISTILLATION_MODEL env") lands a different, deliberately-chosen value first. If L3-B4 doesn't land this sprint, pin it anyway rather than shipping launch with a known-shaped 404 risk live.
- **Blast radius:** whatever prod path calls the distillation model (check current callers of `GEMINI_DISTILLATION_MODEL`/`getGeminiConfig()` in `services/worker/src/ai/gemini-config.ts` before flipping — do not assume it's inert just because no incident has been reported) either recovers from silent failures or, if it's actually 404ing today, starts working for the first time. Low risk to add the pin; the open question is whether it's *already broken and unnoticed*, which argues for treating this with real urgency rather than routine polish.
- **Verification step (before pin):** make one live test call using the current unpinned default (`gemini-3-flash-preview`) against whatever endpoint `GEMINI_DISTILLATION_MODEL` feeds, to confirm whether this is theoretical or already actively failing in prod. **This is the single highest-value verification step in this entire checklist** — it was not completed in this session due to scope (config verification, not live model-call testing) and should be the first thing the executor does.
- **Verification step (after pin):** same call succeeds with the new pinned model; add to the deploy smoke-test checklist if one exists.
- **Rollback:** revert the env var value in `deploy-worker.yml` + redeploy.
- **Executor:** **RTE** (config/env pin, not a customer-facing behavior flip — it's a bug fix).

### 2.7 Paused feeder Cloud Scheduler jobs — CORRECTION to the task's premise

The task brief for this checklist listed `process-anchors` and `anchor-public-records` as "paused feeder Cloud Scheduler jobs... for the 259k backlog drain," per `memory/project_pending_anchoring_backlog.md` (*"public records unlinked; feeder crons PAUSED; scheduler drift = PI-0.5 P1 (SCRUM-2900)"*).

**Live verification in this session found both jobs currently `ENABLED` and executing successfully:**

```
process-anchors            ENABLED  lastAttemptTime=2026-07-28T15:30:01Z  (no error status)
anchor-public-records      ENABLED  lastAttemptTime=2026-07-28T15:40:01Z  (no error status)
```

Both ran within the hour of this check, on their declared schedules (`*/30 * * * *` and `*/10 * * * *` respectively), with no error status recorded. All of prod's other core Scheduler jobs (`batch-anchors`, `check-confirmations`, `recover-broadcasts`, `populate-confirmation-proofs`, `daily-anchor-flush`) are also `ENABLED`.

**This directly contradicts the stale memory note.** Either the jobs were re-enabled since that memory was written, or the memory's "paused" claim referred to something more specific (e.g. a particular ingestion source within `anchor-public-records`, or the DB-backed `ENABLE_PUBLIC_RECORDS_INGESTION`/`ENABLE_PUBLIC_RECORD_ANCHORING` flags rather than the Scheduler jobs themselves — both of those verified `enabled=true` live in `switchboard_flags` this session too). **No action item follows from this row** — do not "fix" something that live verification shows is already running. What *would* need investigation, if the 259k backlog is still real, is why a running feeder isn't draining it — but that is a separate, deeper investigation (log volumes, error rates inside successful-looking runs, ingestion source coverage) outside this checklist's scope. Flag this discrepancy to whoever owns SCRUM-2900 rather than assuming either the old memory or this fresh check is the complete picture.

### 2.8 `MEMPOOL_API_URL` — negative check, not a flag flip

- **Current verified value:** absent from prod's live Cloud Run env (confirmed via the same `gcloud run services describe` dump used for every other row in this checklist).
- **Target:** stays absent, permanently. This is not something to "enable" — it's a var that must never be set. Per the founder's explicit trap callout and `memory/project_mempool_api_url_contract_bug.md`: setting it anywhere (rig or prod) causes inconsistent `/api` path handling that silently freezes anchor confirmation polling at `SUBMITTED`, with no error.
- **Verification step:** re-check its absence after every prod deploy that touches `deploy-worker.yml`'s env-var block, as a standing regression guard, not a one-time check.
- **Rollback:** N/A.
- **Executor:** N/A (nothing to execute) — but worth a standing CI or deploy-checklist line item so it isn't reintroduced by accident in a future PR.

---

## 3. CI / asserted-state manifest housekeeping (§1.13 R-5 obligation)

Any flag flip in this checklist that changes prod's *effective* state must be
mirrored into `scripts/ci/config-drift/expected-prod-config.json` and
`scripts/ci/config-drift/prod-config-snapshot.json` in the same PR (or
immediately after) — the config-drift CI gate fails closed on divergence
between asserted and running config, and a flip that isn't reflected there
will either false-fail the gate or, worse, leave the asserted manifest
silently wrong. `ENABLE_OUTBOUND_WEBHOOKS` already has its exact activation
procedure pre-written in that file's `_pendingLaunchFlagsNote` (quoted in
§2.1) — follow it verbatim. `ENABLE_CONNECTOR_ARTIFACT_DRAIN`/`ENQUEUE` and
`ENABLE_QUEUE_DIGEST` are not currently represented in either JSON at all
(neither `flags` nor `pendingLaunchFlags`) — adding them to `flags:false`
(current) and moving to `flags:true` at flip time is new work, not a
copy-paste of an existing note.

---

## 4. Open blockers to this checklist's completion (as of 2026-07-28)

1. **`GEMINI_DISTILLATION_MODEL` live-call verification not yet done** (§2.6) — highest-priority open item; determines whether this is an urgent live bug or routine hardening.
2. **`ENABLE_CONNECTOR_ARTIFACT_DRAIN`/`ENQUEUE` consumer state needs a fresh check at flip time**, not assumed from the ratified sprint plan's stated intent (R3) or from the older `memory/project_connector_pipeline_consumer_gap.md` note — both could be stale in either direction.
3. **`ENABLE_QUEUE_DIGEST` recipient list + timezone decision (EST-fixed vs local) is an open founder question**, unresolved as of this writing — blocks the flip regardless of code readiness.
4. **259k pending-anchoring backlog status is unclear** given the §2.7 correction — the feeder crons are running, contradicting the "paused" memory note, but whether the backlog is actually draining was not verified in this session. Route to SCRUM-2900's owner.
5. **`ENABLE_INSTANT_SECURE` dark-ship verification** (§2.5) — confirm no accidental UI surface once L2-A2 lands, before declaring this item closed.

None of items 1-5 block **starting** the 72h soak clock (soak runbook §1) — they are prod-enablement (D8) items, executed after the soak matures. They do block declaring this checklist itself complete.

---

_Last refreshed: 2026-07-28 by RTE/Release Manager agent (SCRUM-2980 companion, founder directive D8) — every "current verified value" in §1/§2 was checked live against prod (`vzwyaatejekddvltxyye`, Cloud Run revision `arkova-worker-01141-pon`) in this session via Supabase MCP `execute_sql` and `gcloud run services describe`; none inferred from code or memory alone. Repo state: commit `391cc7a01acf54538ad8d83c8c86ee5c11a80d86`. No flag was flipped, no deploy was made, no prod state was changed as part of authoring this document._

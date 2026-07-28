# SCRUM-2916 — Proof-cron dead-man + kill-switch design, and unfreeze-preconditions runbook

> **INTERNAL ENGINEERING NOTE — system of record will be the Confluence page for SCRUM-2916; this file is the draft for that page.**
>
> Design-only deliverable. The prod proof cron **stays frozen**. Nothing in this doc mutates prod, staging, Scheduler state, or flags, and nothing here starts a soak (founder directive 2026-07-20: no soak/activation without explicit go-ahead).

Scope: the confirmation-proof backfill cron — Cloud Scheduler job `populate-confirmation-proofs` → `POST /jobs/populate-confirmation-proofs` (`services/worker/src/routes/cron.ts:332`) → `runConfirmationProofBackfill()` (`jobs/confirmation-proof-backfill.ts`) → `populateConfirmationProofsForSecuredAnchors()` (`jobs/confirmation-proof-populate.ts`).

---

## 1. Problem + observed failure modes

The proof cron writes layer-2 confirmation evidence (`block_header` + `block_hash`) onto `anchor_proofs` rows for SECURED anchors. It is currently frozen by fiat, and the freeze mechanism itself is the problem: **every stop lever we have is silent**. Four observed failure modes, all of which this design must make detectable:

| # | Failure mode | Observed instance |
|---|---|---|
| F1 | **Silently-paused Scheduler, no actor attribution.** A `gcloud scheduler jobs pause` leaves no trace in the repo, HANDOFF, or Jira; the job just stops firing. | Root cause of the 10-week public-records freeze: prod feeder jobs paused 2026-05-03/05 under the `carson@arkova.ai` identity by an unrecorded session (HANDOFF 2026-07-17, BUG-2026-07-17-005). Mitigation for the *scheduler-state* dead-man is SCRUM-2900; this design must survive it not existing yet. |
| F2 | **Wrong-URI Scheduler → guaranteed 404 for months.** `cronRouter` is mounted at `/jobs` only (`index.ts:361`); a Scheduler job pointed at `/cron/...` 404s forever while Scheduler dutifully reports "ran". | `db-health-monitor` job pointed at nonexistent `/cron/db-health` — the long-standing "code 5"; fixed to `/jobs/db-health` → 200 on 2026-07-17 17:42Z (BUG-011). |
| F3 | **node-cron dormancy.** The in-process `*/15` backup (`routes/scheduled.ts:307`) never fires on throttled Cloud Run — CPU is throttled between requests (see comment at `cron.ts:321-331`). Anyone reading `scheduled.ts` and concluding "the backup covers us" is wrong in prod. | Proven by the real-network soak (comment at `cron.ts:323`); same gotcha as the general Cloud Run in-process cron finding. |
| F4 | **Hollow-success 200s.** `runConfirmationProofBackfill` returns HTTP 200 with `{skipped:true}` when `useMocks` or `!enableProdNetworkAnchoring`, and 200 with `scanned>0, anchorsUpdated:0` when every fetch comes back pending/stale. Scheduler and `/health` both read green while **zero rows of work** happen. | This is the same shallow-liveness trap SCRUM-2901 documented for `/health` ("anchoring:ok while the backlog GROWS"). Note also: `ENABLE_CONFIRMATION_PROOF_BACKFILL` gates only the in-process backup — **the HTTP route has no flag gate at all today**, so there is currently no auditable software stop lever. |

Design goal: a frozen or broken proof cron must be **visible within one monitor cycle**, and freezing/unfreezing must be a **one-row audited UPDATE**, not an untracked infra mutation.

## 2. Dead-man design — prove ALIVE **and** EFFECTIVE

### 2.1 Signals (all LIMIT-1 timestamp probes; no counts, per R0-8 / SCRUM-1254)

1. **Run heartbeat (liveness).** The cron route, on every invocation (including no-ops), upserts one `pipeline_dashboard_cache` row `cache_key='proof_cron_heartbeat'` with `{last_run_at, outcome: 'ran'|'frozen_flag'|'skipped_mocks', scanned, anchors_updated, tx_confirmed, tx_pending, tx_stale}` — aggregate counters only, no ids (§1.4). Existing table, no migration. Stale heartbeat ⇒ the cron is not firing at all — catches **F1, F2, F3** in one signal (paused job, 404'd job, and dormant node-cron all fail to stamp it).
2. **Effectiveness watermark.** `max(updated_at)` of `anchor_proofs` rows `WHERE block_header IS NOT NULL` — index-backed `ORDER BY updated_at DESC LIMIT 1` probe (needs a small partial index `(updated_at DESC) WHERE block_header IS NOT NULL`; ships in the dead-man PR). Watermark stale while work is available ⇒ the cron fires but accomplishes nothing — catches **F4**.
3. **Eligible-backlog existence.** `LIMIT 1` existence probe of the exact scan predicate (`merkle_root IS NOT NULL AND block_header IS NULL AND anchors.status='SECURED' AND chain_tx_id IS NOT NULL`). No backlog ⇒ a stale watermark is *healthy* (nothing to do) — prevents false pages once the back-catalogue drains.

### 2.2 Arming: the kill-switch flag is the intent signal

The dead-man reads `ENABLE_PROOF_CRON` (§3) first:

- **Flag false/missing/unreadable → dead-man is DISARMED but not silent**: info-level log + response field `proof_cron: {armed:false, reason:'flag_off', backlog_present, heartbeat_age_hours}`. The freeze stays visible on every cycle without paging anyone.
- **Flag true → armed.** Fire (error-level, Sentry) when **either**: heartbeat age > 90 min (3 missed 15-min cycles — liveness death), **or** backlog present **and** watermark age > 2 h (8 cycles — effectiveness death, includes the repeated-hollow-200 case).

This coupling is the core trick: **flag ON + paused/404'd Scheduler = exactly the divergence that fires.** An operator who pauses the Scheduler without flipping the flag OFF gets paged within one monitor cycle — untracked pauses stop being silent even before SCRUM-2900's attribution dead-man lands.

### 2.3 Where it runs: piggyback the existing `*/30` pipeline-throughput monitor (recommended)

Add `runProofCronDeadman()` as its own module (`jobs/proof-cron-deadman.ts`), invoked from the **same** `POST /jobs/pipeline-throughput-monitor` handler after `runPipelineThroughputMonitor`, each in its own try/catch so neither can 500 the other; results merged into the response body under `proof_cron:`.

- **For:** reuses the ONE Scheduler trigger that is already prod-verified live (created 2026-07-20, first fire was a true positive). Every additional Scheduler job is another thing that can be silently paused — F1 is the root failure mode, so minimizing pause-able surface is itself a defense. Zero Scheduler mutations needed during the frozen slice. `*/30` cadence is right for 90-min/2-h thresholds.
- **Against own-job alternative:** an independent `proof-cron-deadman` Scheduler job recreates F1/F2 for the monitor itself (a second URI to get wrong, a second job to pause) and needs a gated RTE ops step to exist at all. Rejected.
- SCRUM-2901's scope note ("feeder death is SCRUM-2900, not this monitor") is respected: this is a *separate probe function* sharing a trigger, not a widening of the throughput monitor's decision logic.

### 2.4 Sentry event shape, dedup, monitor-the-monitor

- **Event:** `captureProofCronDeadmanAlert(reason, context)` in `utils/sentry.ts`, mirroring `capturePipelineThroughputAlert` — **stable fingerprint** (`['proof-cron-deadman']`) so `*/30` re-fires collapse into ONE Sentry issue (built-in dedup/cooldown; no bespoke cooldown state needed). Context: `{heartbeat_age_hours, watermark_age_hours, backlog_present, last_outcome, flag_state, thresholds}` — aggregate ages and booleans only; never anchor ids, org ids, fingerprints, emails, or keys (§1.4).
- **Monitor-the-monitor:** (i) the host route already 500s on broken core probes → Scheduler retries; (ii) wrap the handler with the existing `withCronMonitoring` Sentry Crons check-in so a *missed* `*/30` run alerts from Sentry's side, independent of GCP — covers "the throughput monitor's own Scheduler job got paused"; (iii) SCRUM-2900's scheduler-state dead-man (unexpected PAUSED + actor attribution) is the third, infra-level layer once it lands. Probe failures inside `runProofCronDeadman` degrade loudly (warn log + `probe_failed` field) rather than masking as healthy.

## 3. Kill-switch design — `ENABLE_PROOF_CRON` (fail-CLOSED)

- **One `switchboard_flags` row**, key `ENABLE_PROOF_CRON`, checked at the **top of the `/jobs/populate-confirmation-proofs` handler** via the `get_flag` RPC (same pattern as `middleware/featureGate.ts`, but **no TTL cache** — at 15-min cadence one RPC per run is nothing and freshness beats staleness).
- **Fail-closed semantics:** flag `false`, row **missing**, or RPC **unreadable** ⇒ the cron **no-ops loudly** — HTTP **200** (never 500: a 500 would make Scheduler retry a deliberate freeze and pollute error budgets) with a **distinct body** `{status:'frozen', flag:'ENABLE_PROOF_CRON', reason:'flag_off'|'flag_missing'|'flag_unreadable', ranAt}`, distinguishable from both a real run and the mock-skip shape. Every no-op emits a warn-level structured log line + a Sentry **breadcrumb** (not an event — breadcrumbs make the freeze visible on any later event without creating alert noise), and still stamps the heartbeat with `outcome:'frozen_flag'`. A frozen cron is therefore **visible on every single tick**: request logs, heartbeat row, dead-man response field.
- **Audit trail:** freezing becomes `UPDATE switchboard_flags SET enabled=false WHERE flag_key='ENABLE_PROOF_CRON'` — a row with `updated_at` (+ audit-event write per the Switchboard doc matrix), logged in HANDOFF like the 2026-07-17 flag ops. Contrast: a Scheduler pause has no in-repo trace (F1).
- **Interplay with the Scheduler pause:** both remain valid stop levers. The **flag is the auditable, intent-carrying one and the default**; the Scheduler pause stays as the infra-level emergency stop (e.g. worker is down and can't even serve the no-op). Policy: any Scheduler pause MUST be accompanied by flag OFF + a HANDOFF line; the dead-man's arming rule (§2.2) pages on the divergent state (flag ON, job paused), enforcing this mechanically.
- **Relationship to existing gates:** `ENABLE_PROD_NETWORK_ANCHORING` / `useMocks` skip inside `runConfirmationProofBackfill` is unchanged (environment capability), and env var `ENABLE_CONFIRMATION_PROOF_BACKFILL` keeps gating only the in-process dev backup. `ENABLE_PROOF_CRON` is the *operational* gate on the prod HTTP path — the one that today does not exist.

## 4. Unfreeze runbook — ordered preconditions (ALL must pass, in order)

| # | Precondition | Verification (command/query + expected) |
|---|---|---|
| a | **SCRUM-2917 materializer merged; 0359 + 0360 applied to prod and ledger-reconciled.** 0359 (`materialize_run_id` rollback marker — currently FILE-ONLY, applied nowhere) and its companion 0360 (materializer SECURED-guard predicate) land via their own T3 process first. | `gh pr view <materializer-PR> --json state` → MERGED. Supabase MCP `list_migrations` on prod (`vzwyaatejekddvltxyye`) shows numeric head ≥ `0360`; `SELECT version, name FROM supabase_migrations.schema_migrations WHERE version IN ('0359','0360');` → 2 rows, numeric versions (§0 rule 10 reconcile done). |
| b | **Isolated-rig T3 soak of the populate path** (§1.12: 48 h, multiple trigger cycles, clean preflight) **including a backup-restore drill**; rig is RTE-provisioned per the isolated-soak standup procedure. | RC-manifest / evidence block naming: rig project ref, Cloud Run service+tag URL, image digest, PR head SHA, deploy log id, soak start/end, `staging-honesty-preflight` output `environment_type=clean_mirror`, restore-drill artifact. Soak load must exercise `populate-confirmation-proofs` itself (targeted, not generic — soak-evidence standard). |
| c | **0360 predicate verified on the rig, incl. the bare-label forge rejection test**: a forged bare-label row (label present, no qualifying proof material) is REJECTED by the predicate; legitimate materializer skeleton rows pass. | Rig SQL test transcript in the soak evidence: forge INSERT/UPDATE attempt → rejected (constraint/trigger error or 0-row effect); positive-path row → accepted. |
| d | **Kill-switch flag row present in prod + dead-man live.** | `SELECT flag_key, enabled, updated_at FROM switchboard_flags WHERE flag_key='ENABLE_PROOF_CRON';` → 1 row, `enabled=false` (still frozen at this step). Authed `POST /jobs/pipeline-throughput-monitor` → 200 with `proof_cron:{armed:false, reason:'flag_off', ...}`; Sentry shows the cron check-in monitor. |
| e | **Explicit founder/CTO go-ahead** (founder directive 2026-07-20: no soak start or activation without it). | Written go (message/HANDOFF line) linked in the HANDOFF entry for the unfreeze; no go, no flip. |
| f | **Scheduler URI + OIDC audience verified against the live route** (the db-health-monitor F2 lesson). | `gcloud scheduler jobs describe populate-confirmation-proofs --location=us-central1` → `httpTarget.uri` ends `/jobs/populate-confirmation-proofs` (NOT `/cron/...`), `oidcToken.audience` == prod worker URL == `CRON_OIDC_AUDIENCE`; then one authed manual POST → 200 whose body is the real-run shape (not `frozen`, not `skipped`). |
| g | **First run bounded + watched, rollback lever named.** Set `CONFIRMATION_PROOF_MAX_ROWS_PER_RUN=100` (default is 2000) for the first window; flip `ENABLE_PROOF_CRON=true`; watch ≥2 cron cycles (~30 min): request logs 200 real-run, heartbeat `outcome:'ran'`, `anchors_updated>0`, watermark advancing, dead-man healthy, Sentry quiet. **Rollback lever = the flag**: one `UPDATE … SET enabled=false` re-freezes within one tick (plus 0359's `materialize_run_id` surgical DELETE for materializer rows if ever needed). Then raise max_rows stepwise with the same watch. |

**What is NOT asserted (§1.5):** this runbook asserts the cron fires and writes headers; it does **not** assert a backlog drain-rate SLO, does **not** assert cryptographic validity of populated proofs against consensus (owned by the 0357 integrity trigger + verify path), does **not** monitor feeder-cron liveness or Scheduler pause attribution (SCRUM-2900), and does **not** assert the ~2.97M back-catalogue will be covered — back-catalogue coverage is the SCRUM-2917 materializer + PROOF-BACKCATALOG scope, of which this cron is only the header-population leg.

## 5. Tier / rollout note

- **Dead-man + kill-switch code is T2** (worker behavior: `services/worker/src/jobs/` + `routes/cron.ts`): 12 h soak + rollback rehearsal when it ships. Keeping the heartbeat in `pipeline_dashboard_cache` avoids a migration; the watermark partial index IS a migration → that PR (or the 0360 train it rides) is **T3** by the path detector — plan it into the SCRUM-2917 migration train rather than as a standalone T3.
- The prod **flag-row insert and any flip are runtime ops** (RTE-owned, HANDOFF-logged, founder-gated per (e)) — not CI-gated code, but never untracked.
- **Nothing in this document starts a soak.** The proof cron remains frozen until §4(a)–(g) pass in order.

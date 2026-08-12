# manifest-DAY-0 — 7-Day Full-Functionality Soak (SOC 2 Type 2 standard)

Evidence pack root: `docs/staging/evidence/` + `docs/staging/fullsoak-2026-08/` (runbook §12 layout).
Governing documents: `docs/staging/SOAK-PREMORTEM-SOC2-2026-08-11.md` (§6.3 ordering, §7 Day-0 checklist),
`docs/staging/FULL-SOAK-2026-08-RUNBOOK.md` (§2.5 preflight/DEG-6, §12 evidence pack layout).

**All timestamps UTC.** Every value below carries the command that produced it and the moment it was read.
This document was assembled **READ-ONLY**: no infrastructure, database, flag, scheduler, variable, alert
policy or Cloud Run object was mutated in its production.

---

## 0. Identity block (runbook §12 — every artifact must name these)

| Field | Value |
|---|---|
| Rig Supabase project ref | `gnkuaywlpmsaezwvlvhk` (isolated, `arkova-fullsoak-2026-08`, us-east-2) |
| Prod Supabase project ref | `vzwyaatejekddvltxyye` |
| Cloud Run service (rig) | `arkova-worker-fullsoak-2026-08-staging` (project `arkova1`, region `us-central1`) |
| **Rig revision under soak** | **`arkova-worker-fullsoak-2026-08-staging-00013-mrw`** (100% traffic) — `Ready` 15:10:05.965578Z. The 13:44–13:52Z capture window below reads `…-00012-f45` throughout; that revision was superseded at 15:09:40Z by **one authorised pre-clock freeze-break deploy on the same image digest** (`BITCOIN_UTXO_PROVIDER` `mempool`→`getblock` + VPC connector). Full record: **§9.4**. Every `00012-f45` reading below stands as taken; none of it was retro-edited |
| Rig image digest | `sha256:8ace89d483484c40ea2022f7f21361effbfd6e0ab4d61ac4707f54e2ed1c1e18` |
| Cloud Run service (prod) | `arkova-worker` — revision `arkova-worker-01310-god` |
| Prod image digest | `sha256:8ace89d483484c40ea2022f7f21361effbfd6e0ab4d61ac4707f54e2ed1c1e18` (**identical**) |
| `git_sha` (both) | `f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58` |
| Rig URL | `https://arkova-worker-fullsoak-2026-08-staging-270018525501.us-central1.run.app` |
| Repo branch / HEAD at capture | `soak/day0-fullsoak-2026-08-docs` / `c306eb9e34f37dd5ca5100da904f17ce3ef1cb4f` |
| `origin/main` at capture | `49358d607b47217cfe81caf44d17b5e4a595cc88` |
| Manifest capture window | 2026-08-12T13:44:32Z – 2026-08-12T13:52:22Z (§0–§8, §10, §12–§13) |
| Close-out window | 2026-08-12T15:5xZ – 16:0xZ (§9 filled, §11 renumbered) — CTO close-out session |
| **Soak clock start** | **`2026-08-12T15:51:30Z`** → Day-7 close **`2026-08-19T15:51:30Z`** (§9.1) |

```bash
# branch / HEAD
git branch --show-current; git rev-parse HEAD; git rev-parse origin/main   # 13:50:56Z
```

Per CLAUDE.md §1.11A, evidence may not be copied across heads, services, or projects. Every reading in this
manifest was taken against the objects named above, in the window named above.

---

## 1. Premortem §6.3 ordering — state at manifest close

§6.3 fixes the order because getting it wrong in either direction invalidates the window: a deploy after the
gate flip strands ungated hours, and a flip after the clock start means the opening hours ran under the bypass.

| §6.3 step | Action | State | Timestamp (UTC) | Evidence |
|---|---|---|---|---|
| 1 | Seed every flag — DB rows + env vars on the revision | **DONE** | rows 13:30:11.677339Z; env on revision created 13:31:04.111Z | §5.1, §5.2 |
| 2 | Apply BL-1 (rebuild on prod's exact digest) + BL-2 (fee-path) config | **DONE** | digest parity confirmed; `FORCE_DYNAMIC_FEE_ESTIMATION=true` on spec | §2, §5.2 |
| 3 | Deploy the FINAL rig revision — **nothing may deploy after it** | **DONE** — re-executed once, authorised | `00012-f45` created 13:31:04.111Z, Ready 13:32:27.775Z; **superseded by `00013-mrw`**, deploy 15:09:40Z, Ready **15:10:05.965578Z** | §2.3, **§9.4** |
| 4 | Capture boot-time truth from THAT revision's logs | **DONE** (both) | `00012-f45` 13:32:25.284611Z–13:32:39.921802Z; `00013-mrw` 15:10:02.319838Z–15:10:25.881394Z | §5.3, BL-2 §4.2 |
| 5 | Prove one anchor SECURED end-to-end on that revision (BL-2 PASS) | **DONE — PASS** | 12/12 SECURED, 12/12 80-byte headers, 6 txids × 2 explorers, verified through 15:47:33Z | §9.2, BL-2 §4.10 |
| 6 | Re-run the Day-0 gate; every criterion PASS | **DONE — BL-1…BL-7 all PASS** | BL-2 closed 15:47:33Z; probes 15 PASS / 1 FAIL / 4 PARTIAL / 5 NOT-RUN | §9.2, §9.3, §11 |
| 7 | `gh variable set SOAK_GATE_DISABLED --body false` — LAST act before the clock | **DONE** | variable `updatedAt` `2026-08-12T15:51:29Z` | §3.2, §9.1 |
| 8 | `gh variable get SOAK_GATE_DISABLED` — capture echo + timestamp | **DONE** | echo `false` captured **`15:51:30Z`** | §9.1 |
| 9 | Record clock start = LATER of (revision start, step 8 timestamp) | **DONE** | max(`15:10:05.965578Z`, `15:51:30Z`) = **`2026-08-12T15:51:30Z`**; Day-7 close `2026-08-19T15:51:30Z` | §9.1 |

**Step 3 is closed and must stay closed.** `DEPLOY_WORKER_PAUSED=true` (§3.1) is the enforcement, and the
restart/boot-line alarm (§4.3) is the detector for any violation of it. It was re-opened exactly once, before
the clock, under explicit CTO authorisation and on an unchanged image digest — **§9.4 is the full record, and
that is the last deploy of the window.** From `clock_start` forward, a revision change invalidates the window.

**Steps 7–9 were executed by the CTO close-out session**, after step 5 closed, in the order §6.3 requires.
The 13:5xZ capture recorded them PENDING; §9.1 carries the closed values with both legs and their commands.

---

## 2. BL-1 — rig/prod parity block

BL-1 is the premortem's first blocker: "the rig runs a build 140 commits behind production". Four parity
dimensions are asserted by BL-1 criterion 4 — `git_sha`, image digest, migration ledger head, and (daily
re-check) that none of them drift. All four are measured below.

### 2.1 `/health` — rig (OIDC) and prod

```bash
RIG=https://arkova-worker-fullsoak-2026-08-staging-kvojbeutfa-uc.a.run.app
curl -sS -H "Authorization: Bearer $(gcloud auth print-identity-token --audiences=$RIG)" "$RIG/health"
curl -sS https://arkova-worker-kvojbeutfa-uc.a.run.app/health
```

| Field | RIG @ 2026-08-12T13:45:01Z | PROD @ 2026-08-12T13:45:02Z | Parity |
|---|---|---|---|
| HTTP | `200` | `200` | ✅ |
| `status` | `healthy` | `healthy` | ✅ |
| `version` | `0.1.0` | `0.1.0` | ✅ |
| `git_sha` | `f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58` | `f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58` | ✅ **exact** |
| `network` | `signet` | `mainnet` | **by design** (DEG-2) |
| `uptime` (s) | `767` ⇒ process start ≈ **13:32:14Z** | `1744` ⇒ process start ≈ **13:16:02Z** | n/a |
| `checks.database` | `ok` | `ok` | ✅ |
| `checks.anchoring` | `ok` | `ok` | ✅ |
| `checks.kms` | `ok` | `ok` | **see DEG-8** |

Rig verbatim:
```json
{"status":"healthy","version":"0.1.0","git_sha":"f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58","uptime":767,"network":"signet","checks":{"database":"ok","anchoring":"ok","kms":"ok"}}
```
Prod verbatim:
```json
{"status":"healthy","version":"0.1.0","git_sha":"f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58","uptime":1744,"network":"mainnet","checks":{"database":"ok","anchoring":"ok","kms":"ok"}}
```

**§1.5 caveat — what `/health` measures.** Per DEG-3, `/health` asserts database reachability and little else;
`checks.anchoring` and `checks.kms` are **not** end-to-end assertions and per DEG-8 the `kms` field does not
measure the same thing on rig (WIF signer) as on prod. `HEALTH_DETAIL_TOKEN` is bound on the rig revision
(§5.2), so a richer detail surface exists for later phases. **Not asserted:** that `/health` being `healthy`
implies anchoring works — §6 and the BL-2 evidence file carry that burden.

### 2.2 Serving revision and image digest

```bash
gcloud run services describe arkova-worker-fullsoak-2026-08-staging --region=us-central1 \
  --format='yaml(status.traffic,status.latestReadyRevisionName,status.latestCreatedRevisionName)'   # 13:45:10Z
gcloud run revisions describe arkova-worker-fullsoak-2026-08-staging-00012-f45 --region=us-central1 \
  --format='yaml(metadata.name,metadata.creationTimestamp,spec.containers[0].image,status.imageDigest,status.conditions)'   # 13:45:10Z
gcloud run services describe arkova-worker --region=us-central1 \
  --format='yaml(status.traffic,status.latestReadyRevisionName)'                                    # 13:45:11Z
gcloud run revisions describe arkova-worker-01310-god --region=us-central1 \
  --format='yaml(metadata.name,metadata.creationTimestamp,spec.containers[0].image,status.imageDigest)'  # 13:45:11Z
```

| | RIG | PROD |
|---|---|---|
| latestCreatedRevision | `…-00012-f45` | — |
| latestReadyRevision | `…-00012-f45` | `arkova-worker-01310-god` |
| traffic | `100%` → `…-00012-f45` | `100%` → `arkova-worker-01310-god` (tag `canary`, `latestRevision: true`) |
| creationTimestamp | `2026-08-12T13:31:04.111201Z` | `2026-08-12T13:15:06.902794Z` |
| image digest | `sha256:8ace89d483484c40ea2022f7f21361effbfd6e0ab4d61ac4707f54e2ed1c1e18` | `sha256:8ace89d483484c40ea2022f7f21361effbfd6e0ab4d61ac4707f54e2ed1c1e18` |

**Expected `00012-f45 @ sha256:8ace89d4…c1c1e18` — CONFIRMED, exact match, both fields.**

Prod image tags on that digest:
```bash
gcloud artifacts docker tags list us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker \
  --format='csv[no-heading](tag,version)' | grep 8ace89d48348...   # 13:45:40Z
```
```
f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58,sha256:8ace89d483484c40ea2022f7f21361effbfd6e0ab4d61ac4707f54e2ed1c1e18
latest,sha256:8ace89d483484c40ea2022f7f21361effbfd6e0ab4d61ac4707f54e2ed1c1e18
```
The image tag equals the `git_sha` both services report from `/health` — the three independent artifacts
(health payload, registry tag, revision digest) agree. **BL-1's build-divergence blocker is closed.**

### 2.3 Rig revision timeline (the revision-start leg of clock start)

From `status.conditions` on `…-00012-f45`, read 13:45:10Z:

| Condition | Timestamp | Message |
|---|---|---|
| `ContainerReady` | `13:31:51.382746Z` | Container image import completed |
| `ResourcesAvailable` | `13:32:14.430310Z` | Provisioning imported containers completed in 23.67s |
| `ContainerHealthy` | `13:32:25.341934Z` | Containers became healthy in 11.53s |
| `MinInstancesProvisioned` | `13:32:27.710896Z` | Min instances provisioned successfully in 36.96s |
| **`Ready`** | **`13:32:27.775544Z`** | **Deploying revision succeeded in 37.02s** |

Cross-check from the log stream (independent artifact): `Starting new instance` at `13:32:13.435601Z`;
`Worker service started` at `13:32:25.485965Z`. Cross-check from `/health`: `uptime=767` at 13:45:01Z ⇒
process start ≈ `13:32:14Z`.

> **Revision-start leg of clock start = `2026-08-12T13:32:27.775544Z`** (`Ready` transition — the conservative
> choice, latest of the candidates). Recorded here so §9.1 has one fixed input already measured.
>
> **SUPERSEDED at 15:09:40Z.** The authorised freeze-break deploy (§9.4) replaced this revision with
> `…-00013-mrw`, whose `Ready` transition `2026-08-12T15:10:05.965578Z` is the leg §9.1 actually uses. The
> reading above stands as taken and is left unedited; it is simply no longer the serving revision.

### 2.4 Migration ledger heads

```sql
-- Supabase MCP execute_sql, read-only, per project. 13:46:0xZ
SET statement_timeout='8s';
SELECT max(version) AS ledger_head, count(*) AS ledger_rows,
       count(*) FILTER (WHERE version !~ '^[0-9]{4}$') AS non_numeric_rows
FROM supabase_migrations.schema_migrations;
```

| | RIG `gnkuaywlpmsaezwvlvhk` | PROD `vzwyaatejekddvltxyye` | Parity |
|---|---|---|---|
| `ledger_head` | `0409` | `0409` | ✅ |
| `ledger_rows` | `111` | `111` | ✅ |
| `non_numeric_rows` | `1` | `1` | ✅ |

Head-of-ledger detail (`version >= '0400'` OR non-numeric), same call:

| version | RIG name | PROD name |
|---|---|---|
| `00000000000000` | `baseline_at_main_HEAD` | `baseline_at_main_HEAD` |
| 0400 | `0400_org_rule_action_type_instant_secure` | same |
| 0401 | `0401_fix_create_pending_recipient_rpc_fk_and_role` | same |
| 0402 | `0402_retire_activate_user_rpc` | same |
| **0403** | `0403_fix_anonymize_user_data_verification_events_columns` | `fix_anonymize_user_data_verification_events_columns` |
| 0404 | `0404_dpa_redact_raw_querying_ip_and_correct_ip_hash_comment` | same |
| 0405 | `0405_org_field_policies_dpa_clause_4_6` | same |
| 0406 | `0406_proof_coverage_window_and_reconstruction_classes` | same |
| 0407 | `0407_widen_org_verification_status_for_kyb_rejection` | same |
| 0408 | `supplementary_proof_anchor` | same |
| 0409 | `lock_wait_observability_rpc` | same |

**One cosmetic divergence, recorded not hidden:** at `0403` the rig's ledger `name` carries the `0403_` numeric
prefix and prod's does not. **Measured:** `version` — the field the drift gate and every parity check read —
is identical (`0403`) on both, and row counts match exactly. **Asserted:** this is a `name`-column labelling
artifact of how the row was written (MCP apply vs. CLI push), not a schema difference. **Not asserted:** that
the two databases are byte-identical in schema — no schema diff was run for this manifest; parity here is
ledger-level.

**BL-1 verdict: all four parity dimensions PASS** (`git_sha` ✅, image digest ✅, ledger head ✅, ledger row
count ✅). Per premortem R13, any daily re-check that shows a mismatch in these is an evidence-invalidating
event and must be logged the day it occurs.

---

## 3. Freeze state (BL-6, BL-4)

### 3.1 `DEPLOY_WORKER_PAUSED` — the change freeze

```bash
gh variable get DEPLOY_WORKER_PAUSED   # 13:45:24Z  ->  true
gh variable list                       # 13:45:24Z
```
```
DEPLOY_WORKER_PAUSED	true	2026-08-12T13:23:42Z
SOAK_GATE_DISABLED	true	2026-08-02T07:35:57Z
```

**Value: `true`. Last updated `2026-08-12T13:23:42Z`.**

Stated plainly, because the history matters and the variable's `updatedAt` alone would mislead: the freeze was
**first engaged at 12:49:52Z**, then **deliberately set back to `false` at 13:08:54Z** and held false until
**13:23:42Z** — a 14 m 48 s window opened on purpose to let the two already-queued pre-freeze deploys
(**#2208** and **#2209**) drain rather than be stranded. At `13:23:42Z` it was re-set to `true` and has held
`true` since. The `updatedAt` timestamp on the variable today is therefore the **re-engagement**, not the
original engagement.

**Why this is not a freeze violation:** the final rig revision `…-00012-f45` was created at `13:31:04Z`,
**7 m 22 s after** the freeze was re-engaged and after both drain deploys had landed. Prod revision
`arkova-worker-01310-god` was created at `13:15:06Z`, inside the drain window, which is exactly what the window
was opened for. Nothing deployed after `13:23:42Z` except the intended final rig revision.

Per `memory/feedback_deploy_worker_paused_is_actions_var.md`: this variable is an Actions variable, not a YAML
setting, and it gates `deferred_consolidated_soak` — so it changes **merge semantics**, not just deploy timing.
It must stay `true` for the full window.

### 3.2 `SOAK_GATE_DISABLED` — BL-4

```bash
gh variable get SOAK_GATE_DISABLED   # 13:45:24Z  ->  true
```

**Value: `true`. Last updated `2026-08-02T07:35:57Z` — untouched today.**

Per CLAUDE.md §1.11: while this is `true`, `scripts/ci/check-staging-evidence.ts` short-circuits to a pass, so
a green Staging Soak Evidence Gate means "the bypass is engaged", **not** "evidence is present". No hour of the
soak window may run under this state.

> **The flip to `false` is §6.3 step 7 — the LAST Day-0 act — and belongs to the main session, not to this
> manifest. It is recorded here as PENDING.** See §9.1 for the placeholder that must be filled at the flip.

---

## 4. Monitoring inventory (BL-5) and fire-test evidence

BL-5 is "nothing monitors the rig". Premortem §7 step 5 PASS criterion: *three alarms enabled and each
observed to fire once*. Premortem R8, as inverted by live evidence, additionally requires at least one
deliberately-triggered alert to fire **and be received** during the period, proving the channel works.

### 4.1 Uptime checks

```bash
TOK=$(gcloud auth print-access-token)
curl -sS -H "Authorization: Bearer $TOK" \
  "https://monitoring.googleapis.com/v3/projects/arkova1/uptimeCheckConfigs"   # 13:46:21Z
```

5 configs exist in `arkova1`; **4 are SOAK-scoped**:

| # | displayName | Target | Path | Matcher | Period/Timeout |
|---|---|---|---|---|---|
| 1 | `SOAK — fullsoak rig /health (body: status healthy)` | `cloud_run_revision` / `arkova-worker-fullsoak-2026-08-staging` | `/health` | `CONTAINS_STRING "status":"healthy"` | 60s / 10s |
| 2 | `SOAK — app.arkova.ai frontend` | `uptime_url` / `app.arkova.ai` | `/` | `CONTAINS_STRING Arkova` | 60s / 10s |
| 3 | `SOAK — edge.arkova.ai /health` | `uptime_url` / `edge.arkova.ai` | `/health` | `CONTAINS_STRING "status":"ok"` | 60s / 10s |
| 4 | `SOAK — search.arkova.ai frontend` | `uptime_url` / `search.arkova.ai` | `/` | `CONTAINS_STRING Arkova` | 60s / 10s |
| — | `Prod worker /health — body asserts healthy` | `uptime_url` / `arkova-worker-…run.app` | `/health` | `CONTAINS_STRING "status":"healthy"` | 60s / 10s |

Check #1 uses `serviceAgentAuthentication: OIDC_TOKEN` and `acceptedResponseStatusCodes: STATUS_CLASS_2XX` —
it authenticates to the private rig rather than probing an open port, so a 403 would register as a failure,
not a pass. Verified restored to the correct matcher at 13:46:47Z (full-config read).

### 4.2 Alert policies

```bash
curl -sS -H "Authorization: Bearer $TOK" \
  "https://monitoring.googleapis.com/v3/projects/arkova1/alertPolicies"   # 13:46:30Z
```

7 policies exist in `arkova1`, all `enabled: true`; **3 are SOAK-scoped**:

| # | displayName | Condition | Created | Last mutated |
|---|---|---|---|---|
| S1 | `PAGE — SOAK rig /health not healthy (body assertion)` | uptime `check_passed` pass-fraction `< 0.4` for `180s`, aligned `60s`, `ALIGN_FRACTION_TRUE` | `13:06:35.531477335Z` | (never) |
| S2 | `PAGE — SOAK rig 5xx burst` | `run.googleapis.com/request_count`, `response_code_class="5xx"`, `> 5` over `300s` | `13:06:37.010780519Z` | `13:44:52.850977241Z` |
| S3 | `PAGE — SOAK rig restart/revision change (boot line)` | `conditionMatchedLog` on `jsonPayload.msg="Using BitcoinChainClient (signet)"` | `13:06:38.360277963Z` | (never) |

Non-SOAK, carried for completeness: `PAGE — Worker PostgREST schema-cache failure (PGRST002)`, `PAGE — Prod
worker /health not healthy (body assertion)`, `PAGE — Postgres lock wait > 60s on a public relation`,
`PAGE — arkova-worker 5xx burst`.

**Notification channels** (read 13:46:47Z) — both `enabled: true`, both wired to all three SOAK policies:

| Channel | Type | Target |
|---|---|---|
| `…/notificationChannels/17147566240859145353` | `email` | `carson@arkova.io` |
| `…/notificationChannels/2310628978387136093` | `pubsub` | `projects/arkova1/topics/alert-delivery-proof` |

The Pub/Sub channel exists precisely so alert *delivery* is machine-verifiable rather than asserted. Topic and
subscription `alert-delivery-proof-sub` both confirmed present at 13:49:08Z.

### 4.3 Fire tests — all three SOAK alarms observed to fire

Two independent evidence streams are used for each: the GCP **violation event log** (incident opened/resolved,
with policy attribution) and the **Pub/Sub delivery metric** (proof the notification actually left the system).

```bash
gcloud logging read 'logName=~"monitoring.googleapis.com" AND timestamp>="2026-08-12T13:00:00Z"' \
  --project=arkova1 --format=json --limit=25        # 13:52:22Z
curl -sS -G -H "Authorization: Bearer $TOK" \
  --data-urlencode 'filter=metric.type="pubsub.googleapis.com/topic/send_message_operation_count" AND resource.labels.topic_id="alert-delivery-proof"' \
  --data-urlencode 'interval.startTime=2026-08-12T12:00:00Z' --data-urlencode "interval.endTime=<now>" \
  --data-urlencode 'aggregation.alignmentPeriod=60s' --data-urlencode 'aggregation.perSeriesAligner=ALIGN_SUM' \
  "https://monitoring.googleapis.com/v3/projects/arkova1/timeSeries"   # 13:50:13Z
```

| Event (UTC) | Type | Policy | violation_id |
|---|---|---|---|
| `13:14:53Z` | `ViolationOpenEventv1` | S1 rig /health body assertion | `0.obcmt2243z3n` |
| `13:23:11Z` | `ViolationAutoResolveEventv1` | S1 rig /health body assertion | `0.obcmt2243z3n` |
| `13:32:58Z` (×2) | `ViolationOpenEventv1` | S3 rig restart/boot line | `0.obcn7x98wuti` |
| `13:51:11Z` | `ViolationOpenEventv1` | S2 rig 5xx burst | `0.obcnmwefxukw` |

Pub/Sub deliveries on `alert-delivery-proof`: **`13:16:13Z`, `13:24:13Z`, `13:34:52Z`** (three, each ~1–2 min
after the corresponding violation event).

**S1 — rig `/health` body assertion. FIRED, with incident + delivery proof.**
Method: the content matcher was temporarily replaced with a bogus string at **13:07:34Z** and restored at
**13:19:17Z**. The uptime pass-fraction, read independently from the metric at 13:50:13Z (`ALIGN_FRACTION_TRUE`,
300s), traces the whole test:

| Window end | Pass fraction |
|---|---|
| `13:10:13Z` | `0.771` |
| `13:15:13Z` | `0.017` |
| `13:20:13Z` | `0.000` |
| `13:25:13Z` | `0.756` |
| `13:30:13Z` – `13:50:13Z` | `1.000` (every window) |

Incident opened `13:14:53Z`, auto-resolved `13:23:11Z`, notifications delivered `13:16:13Z` (open) and
`13:24:13Z` (close). Matcher verified restored to `"status":"healthy"` at 13:46:47Z. **This single test also
satisfies premortem R8's inverted requirement**: a deliberately-triggered alert both fired and was received.

**S3 — rig restart / revision change (boot line). FIRED on the real 13:31Z deploy.**
Not a synthetic test: the log-match condition fired on the genuine boot line emitted by the final revision.
Boot line `Using BitcoinChainClient (signet)` at `13:32:39.921770Z` (§5.3) → incident opened `13:32:58Z` →
notification delivered `13:34:52Z`. Detection latency ≈ **19 s** from boot line to incident. This is the
detector premortem R2 needed and did not previously have; from clock start, any unplanned restart is caught.

**S2 — rig 5xx burst. FIRED, but late, and with a misleading incident text. Read this carefully.**
Method: at **~13:41Z** the policy filter was temporarily swapped from `5xx` to `4xx`, eight 404s were driven at
the rig, and the filter was restored to `5xx` at **13:44:52Z** (mutation record confirms). The eight requests
are individually in the request log:

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="arkova-worker-fullsoak-2026-08-staging" AND httpRequest.status>=400 AND timestamp>="2026-08-12T13:30:00Z"' \
  --project=arkova1 --format='value(timestamp,httpRequest.status,httpRequest.requestMethod,httpRequest.requestUrl)' --order=asc   # 13:51:56Z
```
```
13:41:39.276220Z  404  GET  /definitely-not-a-route-1
13:41:39.447702Z  404  GET  /definitely-not-a-route-2
…
13:41:40.368586Z  404  GET  /definitely-not-a-route-8
```

The incident opened at **`13:51:11Z`** — roughly **10 minutes after** the test traffic and **6 minutes after**
the filter had been restored — carrying this text:

> `Request Count for … {response_code_class=5xx} is above the threshold of 5.000 with a value of 8.000.`

**Measured:** the policy evaluated its condition against the 8 requests collected while the filter was `4xx`,
and rendered the message using the *restored* `5xx` label. **Measured:** the rig's actual 5xx count is **zero**
in every 300 s window from `13:31:58Z` through `13:41:58Z` (direct timeseries read, 13:51:56Z), and the only
non-2xx responses on the rig in the whole window are the 8 synthetic 404s plus two `401`s on
`POST /api/v1/keys` (`13:46:49Z`) and one `402` on `GET /api/v1/ai/search` (`13:49:42Z`) — all Day-0 probe
traffic, all correct responses. **Asserted:** the alarm's plumbing (condition → incident → channel) works.
**NOT asserted:** that the rig served any 5xx. It did not.

> ⚠️ **Open item at manifest close (§11 F-3):** incident `0.obcnmwefxukw` on S2 was **still open at 13:52:22Z**,
> and incident `0.obcn7x98wuti` on S3 (log-match, no auto-close observed) was also still open. Both are known
> false-positives-by-construction from Day-0 activity. They must be allowed to auto-resolve — the underlying
> 5xx metric is 0, so S2 will clear — and this manifest is the record that neither represents a rig fault. If
> the clock starts while either is open, Day 1 opens with two known-benign incidents and the Day-1 artifact
> must say so rather than re-discovering them as findings.

**BL-5 / §7 step 5 verdict: PASS.** Three SOAK alarms exist, all enabled, and all three have now been observed
to fire, two of them with end-to-end delivery proof and the third with an attributed incident record.

---

## 5. Flag state (BL-3, Gate 0)

Per premortem §6.3 step 4, `flagRegistry` is a **boot-time snapshot with no TTL**, so the env-path flag state
governing the entire seven days was fixed at the moment revision `…-00012-f45` started and can only be read
from that revision's logs and behaviour. DB-path flags resolve live (60 s TTL) and are read below.

### 5.1 `switchboard_flags` — full table dump and hash

```sql
-- Supabase MCP execute_sql, rig gnkuaywlpmsaezwvlvhk, read-only.  13:47:0xZ
SET statement_timeout='8s';
SELECT flag_key, enabled, description, created_at, updated_at
FROM public.switchboard_flags ORDER BY flag_key;
```

| # | flag_key | enabled | updated_at |
|---|---|---|---|
| 1 | `ENABLE_AI_EXTRACTION` | `true` | 2026-08-11 16:09:54.634397+00 |
| 2 | `ENABLE_AI_FRAUD` | `true` | **2026-08-12 13:30:11.677339+00** |
| 3 | `ENABLE_AI_REPORTS` | `true` | 2026-08-11 16:09:54.634397+00 |
| 4 | `ENABLE_ATTESTATION_ANCHORING` | `true` | 2026-08-11 16:09:54.634397+00 |
| 5 | `ENABLE_BATCH_ANCHORING` | `true` | 2026-08-11 16:09:54.634397+00 |
| 6 | `ENABLE_COMPLIANCE_ENGINE` | `false` | 2026-08-11 16:09:54.634397+00 |
| 7 | `ENABLE_EXPIRY_ALERTS` | `true` | **2026-08-12 13:30:11.677339+00** |
| 8 | `ENABLE_FRAUD_DETECTION` | `true` | **2026-08-12 13:30:11.677339+00** |
| 9 | `ENABLE_GRC_INTEGRATIONS` | `true` | 2026-08-11 16:24:10.066398+00 |
| 10 | `ENABLE_ISSUE_CREDENTIAL_SPLIT` | `true` | 2026-08-11 16:09:54.634397+00 |
| 11 | `ENABLE_MCP_SERVER` | `true` | 2026-08-11 16:09:54.634397+00 |
| 12 | `ENABLE_NEW_CHECKOUTS` | `true` | 2026-08-11 16:09:54.634397+00 |
| 13 | `ENABLE_ORG_CREDIT_ENFORCEMENT` | `true` | **2026-08-12 13:30:11.677339+00** |
| 14 | `ENABLE_OUTBOUND_WEBHOOKS` | `true` | 2026-08-11 16:24:10.066398+00 |
| 15 | `ENABLE_PARTNER_PROVISIONING` | `true` | **2026-08-12 13:30:11.677339+00** (row created today) |
| 16 | `ENABLE_PROD_NETWORK_ANCHORING` | `true` | 2026-08-11 16:24:10.066398+00 |
| 17 | `ENABLE_PUBLIC_RECORD_ANCHORING` | `true` | 2026-08-11 16:09:54.634397+00 |
| 18 | `ENABLE_PUBLIC_RECORD_EMBEDDINGS` | `true` | 2026-08-11 16:09:54.634397+00 |
| 19 | `ENABLE_PUBLIC_RECORDS_INGESTION` | `true` | 2026-08-11 16:09:54.634397+00 |
| 20 | `ENABLE_REPORTS` | `true` | 2026-08-11 16:09:54.634397+00 |
| 21 | `ENABLE_SEMANTIC_SEARCH` | `true` | **2026-08-12 13:30:11.677339+00** |
| 22 | `ENABLE_VERIFICATION_API` | `true` | 2026-08-11 16:09:54.634397+00 |
| 23 | `ENABLE_X402_PAYMENTS` | `true` | 2026-08-11 16:24:10.066398+00 |
| 24 | `ENABLE_ZK_PROOFS` | `true` | 2026-08-11 16:09:54.634397+00 |
| 25 | `MAINTENANCE_MODE` | `false` | 2026-08-11 16:09:54.634397+00 |

**Totals: 25 rows, 23 enabled, 2 disabled** (`ENABLE_COMPLIANCE_ENGINE`, `MAINTENANCE_MODE`).

Hash of the ordered `flag_key=enabled` projection — computed in-database so it is reproducible by anyone with
read access, no local file to trust:

```sql
SELECT count(*) AS rows,
       count(*) FILTER (WHERE enabled) AS enabled_true,
       encode(sha256(convert_to(
         string_agg(flag_key||'='||enabled::text, E'\n' ORDER BY flag_key), 'UTF8')),'hex') AS flags_sha256
FROM public.switchboard_flags;
```

| Project | rows | enabled_true | `flags_sha256` | read at |
|---|---|---|---|---|
| **RIG** `gnkuaywlpmsaezwvlvhk` | 25 | 23 | **`c205ee426a3411f73a975d2d314565ec6eeceb10a0c95d27ddd5cfb005a2865d`** | 13:47:12Z |
| PROD `vzwyaatejekddvltxyye` | 24 | 17 | `7ac4bdd699d690f760947d5ce9c917b49bde45a6a5a6d459974cda0590d356a6` | 13:47:12Z |

**Rig flag state deliberately diverges from prod, and this is the point of Gate 0.** The rig provision record
(2026-08-11) recorded exact prod flag parity; Gate 0 then turned flags **on** so the soak is not hollow. The
complete divergence, so no one later reads it as drift:

| flag_key | RIG | PROD | Why |
|---|---|---|---|
| `ENABLE_AI_FRAUD` | `true` | `false` | Gate 0 seed — exercise the surface (mirror-aligned with rig env, §5.2) |
| `ENABLE_EXPIRY_ALERTS` | `true` | `false` | Gate 0 seed |
| `ENABLE_FRAUD_DETECTION` | `true` | `false` | Gate 0 seed |
| `ENABLE_ORG_CREDIT_ENFORCEMENT` | `true` | `false` | Gate 0 seed — **audit mirror only**, worker reads the env var (migration 0363) |
| `ENABLE_SEMANTIC_SEARCH` | `true` | `false` | Gate 0 seed — claims-register row 1 depends on this probe |
| `ENABLE_PARTNER_PROVISIONING` | `true` (row present) | **row absent** | Gate 0 seed — gate fails **closed** without a row, so the row had to be created |

5 value flips + 1 new row = the 24→25 row and 17→23 enabled deltas. Rationales per flag are in
`flag-decision-matrix.csv` (66 flags) and `flag-seed-plan.md`.

**§1.5 caveat.** **Measured:** the rows above, at the timestamps above. **Asserted:** that a `true` row makes a
capability work — it does not. Resolution is path-dependent (runbook §1.2): some flags resolve DB-first with a
60 s TTL, some resolve only from the boot-time env registry, and `ENABLE_ORG_CREDIT_ENFORCEMENT`'s row is
explicitly an audit mirror the worker never reads. **NOT asserted:** that any gated job actually does work —
that is the §13 behavioural probe suite (§9.3, PENDING). A flag set `true` with a zero row-count delta is a
FAIL, not a pass.

### 5.2 Env-path flags on revision `…-00012-f45`

```bash
gcloud run revisions describe arkova-worker-fullsoak-2026-08-staging-00012-f45 \
  --region=us-central1 --format='json(spec.containers[0].env)'   # 13:46:50Z
```

44 env entries on the revision; 13 are Secret Manager references (names recorded, **no values read or
printed**). The **8 flags set by the Gate 0 final deploy**, exactly as `flag-seed-plan.md` §(a) specified:

| # | Name | Value on `…-00012-f45` | Planned | Match |
|---|---|---|---|---|
| 1 | `ENABLE_AI_FRAUD` | `true` | `true` | ✅ |
| 2 | `FORCE_DYNAMIC_FEE_ESTIMATION` | `true` | `true` | ✅ (the BL-2 fee-path fix) |
| 3 | `ENABLE_RULES_ENGINE` | `true` | `true` | ✅ |
| 4 | `ENABLE_RULE_ACTION_DISPATCHER` | `true` | `true` | ✅ |
| 5 | `ENABLE_QUEUE_REMINDERS` | `true` | `true` | ✅ |
| 6 | `ENABLE_WEBHOOK_HMAC` | `true` | `true` | ✅ |
| 7 | `ENABLE_ALLOCATION_ROLLOVER` | `false` | `false` | ✅ (pinned off — unset would let a stray forced run mutate the credit ledger) |
| 8 | `ENABLE_CE_KEY_EXPIRY_ALERTS` | `false` | `false` | ✅ (pinned off — `CE_API_KEY_EXPIRES_AT` unbound ⇒ fail-loud noise) |

**8 of 8 present with the planned values.** The seed plan's boot-crash traps were correctly left **unset**:
`ENABLE_TREASURY_ALERTS` is absent from the revision (the job is default-ON regardless), so the Zod
`superRefine` deploy-failure path was not tripped.

Supporting anchoring/runtime env on the same revision (relevant to §6):
`NODE_ENV=production`, `LOG_LEVEL=info`, `USE_MOCKS=false`, `ENABLE_PROD_NETWORK_ANCHORING=true`,
`BITCOIN_NETWORK=signet`, `BITCOIN_UTXO_PROVIDER=mempool`, `BITCOIN_FEE_STRATEGY=mempool`,
`BATCH_ANCHOR_MAX_SIZE=10000`, `KMS_PROVIDER=gcp`, `ENABLE_VERIFICATION_API=true`,
`ENABLE_AI_EXTRACTION=true`, `ENABLE_AI_REPORTS=true`, `ENABLE_ORG_CREDIT_ENFORCEMENT=true`,
`ENABLE_DRIVE_WEBHOOK=true`, `ENABLE_DRIVE_CHANGES_RUNNER=true`, `ENABLE_CONNECTOR_ARTIFACT_ENQUEUE=true`,
`ENABLE_CONNECTOR_ARTIFACT_DRAIN=true`, `ENABLE_DOCUSIGN_WEBHOOK=true`,
`BUILD_SHA=f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58`,
`CRON_OIDC_AUDIENCE`/`WORKER_PUBLIC_URL` = the rig `…-270018525501.us-central1.run.app` URL.

`HEALTH_DETAIL_TOKEN` is bound (secret `health-detail-token-fullsoak-2026-08-staging`) — the DEG-3 mitigation
is in place on the serving revision.

`MEMPOOL_API_URL` is **absent**, as required — per the provision record and
`memory/feedback…mempool_api_url_contract_bug`, setting it froze a prior soak's confirmations.

`BUILD_SHA` on the revision equals the `git_sha` from `/health` and the registry tag — a fourth independent
confirmation of BL-1 parity.

### 5.3 Boot-time truth from `…-00012-f45` logs (§6.3 step 4)

```bash
gcloud logging read 'resource.type="cloud_run_revision"
  AND resource.labels.service_name="arkova-worker-fullsoak-2026-08-staging"
  AND resource.labels.revision_name="arkova-worker-fullsoak-2026-08-staging-00012-f45"
  AND timestamp>="2026-08-12T13:31:00Z" AND timestamp<="2026-08-12T13:36:00Z"' \
  --project=arkova1 --format='value(timestamp,jsonPayload.msg,textPayload)' --order=asc   # 13:48:38Z
```

| Timestamp | Boot line |
|---|---|
| `13:32:13.435601Z` | `Starting new instance. Reason: MANUAL_OR_CUSTOMER_MIN_INSTANCE` |
| `13:32:25.279433Z` | `[Sentry] No DSN configured — skipping initialization` |
| `13:32:25.284611Z` | `Creating mempool fee estimator` |
| `13:32:25.485965Z` | `Worker service started` |
| `13:32:25.485985Z` | `Upstash Redis not configured — using in-memory rate limiting` |
| **`13:32:32.351312Z`** | **`Feature flag registry initialized`** ← the registry snapshot that governs all 7 days |
| `13:32:39.921733Z` | `Creating Mempool.space UTXO provider` |
| `13:32:39.921753Z` | `Creating WIF signing provider` |
| `13:32:39.921762Z` | `Creating mempool fee estimator` |
| **`13:32:39.921770Z`** | **`Using BitcoinChainClient (signet)`** ← BL-1/BL-2 sub-criterion; also the S3 alarm trigger |
| `13:32:39.921778Z` | `Bitcoin chain client initialized` |
| `13:32:39.921802Z` | `Scheduled jobs configured (including chain maintenance)` |

**Mock-fallback detector — zero hits over the entire life of the revision:**

```bash
gcloud logging read '… revision_name="…-00012-f45" AND (jsonPayload.msg=~"(?i)mock" OR textPayload=~"(?i)mock")' \
  --project=arkova1 --limit=50   # 13:49:01Z
# MOCK_LINE_COUNT=0
```

**`Using BitcoinChainClient (signet)` present; zero mock lines. §7 step 12 PASS.**
Structured field detail (`feeEstimator: "Mempool.space"`, `signer: "WIF (ECPair)"`, `mocks: false`,
`strategy: "mempool"`) is captured verbatim in `day0-bl2-secured-e2e-evidence.md` §0.3–§0.4.

Two operational notes observed in the same log stream, recorded rather than omitted:
- `NODE-CRON WARN missed execution` at `13:34:02Z` and `13:35:03Z` — the known in-process node-cron behaviour
  on throttled Cloud Run. It is why every job on this rig is driven by **Cloud Scheduler** (§8), not by
  in-process cron. Not a fault; it is the reason for the topology.
- `Run skipped — another instance holds the run lease` at `13:34:06Z` — the run-lease guard working as intended
  with `min-instances` > 1 concurrency.

---

## 6. Chain state

### 6.1 Anchors by status

```sql
-- rig gnkuaywlpmsaezwvlvhk, read-only.  13:51:13Z
SELECT (SELECT count(*) FROM public.anchors) AS anchors_total,
       (SELECT count(*) FROM public.anchors WHERE status='SECURED')   AS secured,
       (SELECT count(*) FROM public.anchors WHERE status='SUBMITTED') AS submitted,
       (SELECT count(*) FROM public.anchors WHERE status='PENDING')   AS pending,
       (SELECT count(*) FROM public.anchors WHERE chain_block_height > 400000) AS mock_height_detector, …
```

| Metric | Value @ 13:51:13Z |
|---|---|
| `anchors_total` | `5` |
| `SECURED` | **`0`** |
| `SUBMITTED` | `5` |
| `PENDING` | `0` |
| `chain_block_height > 400000` (**mock detector**) | `0` ✅ |
| `anchor_proofs` rows | `5` |
| `anchor_proofs` with `block_header IS NOT NULL` | **`0`** |
| `organizations` | `2` |
| active `api_keys` | `6` |
| `credential_embeddings` | `0` (semantic-search probe baseline) |
| `connector_artifact` | `0` (connector-drain probe baseline) |

Per-anchor detail (read 13:47:5xZ):

| public_id | status | chain_tx_id | `chain_block_height` | created_at |
|---|---|---|---|---|
| `ARK-2026-9E74FF50` | SUBMITTED | `81baf563…962dd2bd` | 317262 | 2026-08-11 16:27:48Z |
| `ARK-2026-DD555097` | SUBMITTED | `3a3eec24…303339a9` | 317294 | 2026-08-11 17:54:31Z |
| `ARK-2026-BA3660AE` | SUBMITTED | `3a3eec24…303339a9` | 317294 | 2026-08-11 17:54:32Z |
| `ARK-2026-96538D45` | SUBMITTED | `3a3eec24…303339a9` | 317294 | 2026-08-11 17:54:33Z |
| `ARK-2026-F6C93E15` | SUBMITTED | `3a3eec24…303339a9` | 317294 | 2026-08-11 17:55:23Z |

**Do not read `chain_block_height` as a confirmation height.** Per `day0-bl2-secured-e2e-evidence.md` §1.1 it
holds the **broadcast-time tip**; both transactions in fact confirmed at height **317376** (§6.2). The mock
detector (`> 400000`) is the anchoring control that replaced the deleted `chain_tx_id ~ '^[0-9a-f]{64}$'` check
— which mock output passed trivially — and it reads clean.

### 6.2 The two pre-clock txids and the CPFP child

```bash
curl -sS https://mempool.space/signet/api/tx/<txid>              # 13:48:02Z – 13:48:19Z
curl -sS https://mempool.space/signet/api/blocks/tip/height      # 13:48:02Z -> 317379
```

| Role | txid | Confirmed | Block | Fee (sat) | vsize (vB) | Fee rate |
|---|---|---|---|---|---|---|
| Parent A (1 anchor) | `81baf563289b377d2612305ac72be811acb60e5420b91dbdcb5b85be962dd2bd` | `true` | **317376** | 157 | 156.25 | 1.005 sat/vB |
| Parent B (4 anchors) | `3a3eec2401294d77d62ad2fd8da40997ebe1f79e85352df96c1b5066303339a9` | `true` | **317376** | 471 | 156.25 | 3.014 sat/vB |
| **CPFP child** | `8d94078fd55fcd0e0bee1c6ad5a4d2a8aaf9ed61105f5f74a0020c1abc4b22be` | `true` | **317376** | 2500 | 109.25 | ~22.9 sat/vB |

All three share block hash `000000069c134dd3ac880237677b02a9ea17c2fb5fc7186d2da54ffd8dd11f0f`, block_time
`1786540593` = **2026-08-12T13:16:33Z**. Signet tip at 13:48:02Z = **317379** ⇒ **4 confirmations**.

The CPFP child's single input is `3a3eec24…:vout 1` — it spends Parent B's change output, which is what makes
it a child and what lifted both stuck parents into 317376. Confirmed on the brief's stated block, **317376**.

OP_RETURN payloads (both carry the `41524b56` = `ARKV` prefix, `OP_PUSHBYTES_36`):

| txid | OP_RETURN payload after `41524b56` |
|---|---|
| `81baf563…` | `a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2` |
| `3a3eec24…` | `71313f14619581840f603814e52bef0f46a2ab9786854b7dc86c20332e662ab3` |

> **§1.5 flag on `81baf563…`.** Its payload is the 8-byte motif `a1b2c3d4e5f6a7b8` repeated four times — a
> hand-constructed test vector, not a computed Merkle root. **Measured:** the transaction is real, confirmed,
> and carries a real `ARKV`-prefixed OP_RETURN. **NOT asserted:** that its payload is a Merkle root over real
> document fingerprints. `3a3eec24…`'s payload is unpatterned and consistent with a computed root. Neither
> transaction may be cited as end-to-end anchoring proof in any case — both were broadcast under the **Static**
> fee estimator on **earlier revisions**, so they are pre-clock recovery evidence, not BL-2 PASS evidence.

### 6.3 Why 5 SUBMITTED and 0 SECURED is the honest reading

`getMinConfirmations()` returns **1** on signet (`check-confirmations.ts:494`), and both parents have 4
confirmations — so the promotion is *due*, not blocked by confirmation depth. Following DEG-1 (§8), the
`check-confirmations` job now runs at prod-parity cadence `*/30`, and the last pass observed in the log was
`Starting confirmation check for SUBMITTED anchors` at **`13:34:01.518186Z`** — before the block was seen as
deep enough by the job's own view. The next scheduled pass is the promotion opportunity. `anchor_proofs`
`block_header` stays NULL until `populate-confirmation-proofs` (`0-59/5`) backfills it, which is gated on
promotion.

**This is the BL-2 gap, stated without softening: §6.3 step 5 — "Prove one anchor SECURED end-to-end on that
revision" — is NOT satisfied at manifest close.** See §9.2 and §11 F-1.

### 6.4 Treasury

```bash
curl -sS https://mempool.space/signet/api/address/tb1qrjarsqj0ewqh3u9fdcu7yfyl0sx78k4savtmv7   # 13:48:02Z
```
```json
{"address":"tb1qrjarsqj0ewqh3u9fdcu7yfyl0sx78k4savtmv7",
 "chain_stats":{"funded_txo_count":59,"funded_txo_sum":44423262,"spent_txo_count":58,"spent_txo_sum":43677485,"tx_count":59},
 "mempool_stats":{"funded_txo_count":0,"funded_txo_sum":0,"spent_txo_count":0,"spent_txo_sum":0,"tx_count":0}}
```

| Metric | Value |
|---|---|
| **Confirmed balance** | **745,777 sats** (`44423262 − 43677485`) |
| Unconfirmed (mempool) | `0` sats, `0` txs — **nothing stuck** |
| Lifetime txs | 59 |
| Balance at provision (2026-08-11T16:30Z) | 749,062 sats |
| Net drawdown since provision | **3,285 sats** |

Of that drawdown, 3,128 sats are directly attributable to the three transactions in §6.2 (157 + 471 + 2,500).
The residual 157 sats is **not** attributed here — no reading in this manifest accounts for it, and it is left
as an unexplained remainder rather than guessed at.

The address matches the `Bitcoin chain client initialized` boot line's `address` field (§5.3) — the running
signer and the funded address are the same key. Per DEG-7 the backing secret is
`treasury-wif-legacy-soak-2026-08-staging`, an orphaned secret named for a deleted service; it is **protected
from teardown** by the runbook §2.1 line added at §7 step 9. At current burn (~3.3k sats/day incl. a 2.5k CPFP)
the balance is not a constraint for a 7-day window.

---

## 7. Preflight — `staging-honesty-preflight.ts` (DEG-6)

Re-run live for this manifest, against the exact rig ref the worker uses:

```bash
export SUPABASE_ACCESS_TOKEN=$(gcloud secrets versions access latest --secret=supabase_access --project=arkova1)
export SUPABASE_SERVICE_ROLE_KEY=$(gcloud secrets versions access latest \
  --secret=supabase-service-role-key-fullsoak-2026-08-staging --project=arkova1)
export SUPABASE_URL=$(gcloud secrets versions access latest \
  --secret=supabase-url-fullsoak-2026-08-staging --project=arkova1)
npx tsx scripts/ci/staging-honesty-preflight.ts --project-ref gnkuaywlpmsaezwvlvhk
```

**Fresh result, `timestamp: 2026-08-12T13:50:06.151Z`, exit code `0`:**

```json
{
  "environment_type": "clean_mirror",
  "staging_project_ref": "gnkuaywlpmsaezwvlvhk",
  "timestamp": "2026-08-12T13:50:06.151Z",
  "checks": [
    { "name": "staging_only_rows", "passed": true,  "details": "No PR-only or staging-only migration rows found." },
    { "name": "duplicate_names",   "passed": true,  "details": "No duplicate migration names." },
    { "name": "duplicate_versions","passed": true,  "details": "No duplicate migration versions." },
    { "name": "known_artifacts",   "passed": true,  "details": "No known artifact rows." },
    { "name": "submitted_anchors", "passed": true,  "details": "5 SUBMITTED anchor(s) found." },
    { "name": "prod_divergence",   "passed": true,  "details": "Rig ledger reconciles with repo migration files + canonical baseline." }
  ],
  "artifact_rows": [],
  "missing_from_staging": []
}
```

> **`environment_type = clean_mirror`, 6/6 checks passed, exit 0.**
> **This is the Day-0 capture that runbook §2.5 requires to be taken once and hashed into this manifest.**
> Its sha256 is recorded in §10.

This **re-confirms** the main session's 13:36Z `clean_mirror` result on an independent run 14 minutes later,
against the same ref, with the same verdict. Both readings agree.

Two things recorded honestly rather than smoothed over:

1. **Check count is 6, not the 7 named in the provision record.** The script as it exists on this head emits
   six checks. **Measured:** 6 checks, all passed, exit 0, `clean_mirror`. **NOT asserted:** that the older
   "7/7" and today's "6/6" enumerate the same check set. The classifier verdict — the thing the gate consumes —
   is identical.
2. **The known `duplicate_names` false positive did not fire.** Runbook §2.5 pre-declares that
   `validate_api_key_rpc_hardening` (shipped at both `0302_` and `0303_`) can trip this check on a faithful
   replay. It passed cleanly here. Nothing was "fixed" to achieve that.

### DEG-6 — pre-declared, per runbook §2.5

Check 5 (`submitted_anchors`) requires `submitted_anchors > 0`, and the classifier returns `clean_mirror` only
when **no** check fails. **The moment the soak works** — a SUBMITTED anchor confirms to SECURED and no
SUBMITTED rows remain — Check 5 will fail and the environment will reclassify away from `clean_mirror`.

**That failure is expected healthy behaviour and is not contamination.** The rule for this window, decided now
and before it is needed:

- `environment_type = clean_mirror` is captured **once, at Day 0** — the JSON above — and hashed into this
  manifest (§10). It is not re-captured to "stay green".
- When Check 5 first fails post-clock, it is recorded on the day it occurs, with the DEG-6 framing, as evidence
  the anchoring pipeline is working.
- **Under no circumstance may a SUBMITTED row be hand-inserted to re-green the preflight.** That is exactly the
  fabricated-anchor class Gate 0 removed.
- If a Day-7 re-certification is wanted, fix the check itself
  (`submitted_anchors > 0 OR secured_anchors_created_after_clock_start > 0`) in a **post-window PR** — never
  the environment.

**Observed state at manifest close: 5 SUBMITTED, 0 SECURED ⇒ DEG-6 has not yet triggered, and `clean_mirror`
is captured cleanly ahead of it.** This is the correct order: the Day-0 capture is banked *before* the
condition that will invalidate it.

---

## 8. Cron topology — full fullsoak scheduler census (post-DEG-1)

```bash
gcloud scheduler jobs list --location=us-central1 --project=arkova1 \
  --format='csv[no-heading](name,schedule,state)' | grep -i fullsoak | sort   # 13:48:41Z
```

**26 jobs, prefix `arkova-worker-fullsoak-2026-08-staging-`, ALL `ENABLED`.** Auth is Cloud Run OIDC
(audience = rig URL, SA `270018525501-compute@developer.gserviceaccount.com`) — no shared-secret header.

| # | Job (suffix) | Schedule | State | DEG-1 |
|---|---|---|---|---|
| 1 | `anchor-attestations` | `1-59/10 * * * *` | ENABLED | |
| 2 | `anchor-expiry-sweep` | `0 3 * * *` | ENABLED | **new** |
| 3 | `anchor-public-records` | `*/10 * * * *` | ENABLED | **new** |
| 4 | `batch-anchors` | `*/30 * * * *` | ENABLED | **re-pointed** (was `0-59/5`) |
| 5 | `batch-anchors-forced-flush` | `0 3 * * *` | ENABLED | **re-pointed** (was `0 */8`) |
| 6 | `check-confirmations` | `*/30 * * * *` | ENABLED | **re-pointed** (was `1-59/5`) |
| 7 | `check-stuck-anchors` | `0 * * * *` | ENABLED | |
| 8 | `consolidate-utxos` | `0 5 * * *` | ENABLED | |
| 9 | `db-health-monitor` | `2-59/5 * * * *` | ENABLED | |
| 10 | `detect-reorgs` | `3-59/10 * * * *` | ENABLED | |
| 11 | `drain-connector-artifacts` | `3-59/5 * * * *` | ENABLED | |
| 12 | `grace-expiry-sweep` | `4-59/15 * * * *` | ENABLED | |
| 13 | `monitor-fees` | `*/30 * * * *` | ENABLED | |
| 14 | `monitor-stuck-txs` | `9-59/15 * * * *` | ENABLED | |
| 15 | `nonce-sweep` | `0 4 * * *` | ENABLED | |
| 16 | `org-queue-scheduler` | `4-59/5 * * * *` | ENABLED | see DEG-5 |
| 17 | `populate-confirmation-proofs` | `0-59/5 * * * *` | ENABLED | |
| 18 | `process-anchors` | `*/30 * * * *` | ENABLED | **re-pointed** (was `5-59/10`) |
| 19 | `process-revocations` | `1-59/5 * * * *` | ENABLED | |
| 20 | `rebroadcast-txs` | `14-59/15 * * * *` | ENABLED | |
| 21 | `recover-broadcasts` | `7-59/10 * * * *` | ENABLED | |
| 22 | `refresh-stats` | `2-59/5 * * * *` | ENABLED | |
| 23 | `refresh-treasury-cache` | `9-59/10 * * * *` | ENABLED | |
| 24 | `rule-action-dispatcher` | `3-59/5 * * * *` | ENABLED | |
| 25 | `rules-engine` | `4-59/5 * * * *` | ENABLED | |
| 26 | `webhook-retries` | `2-59/10 * * * *` | ENABLED | |

**Count: 26 (was 24 at provision).** DEG-1 remediation, executed 13:26:22Z–13:26:43Z per
`deg1-cron-parity-evidence.md`: four cadences re-pointed to prod parity, two new jobs created
(`anchor-expiry-sweep`, `anchor-public-records`) by cloning the `batch-anchors` httpTarget and changing only
the URI path.

All five Bitcoin safety loops are bound and enabled: `detect-reorgs`, `monitor-stuck-txs`, `rebroadcast-txs`,
`consolidate-utxos`, `monitor-fees` — plus `check-stuck-anchors` and `nonce-sweep`.

**§1.5 caveat on coverage.** **Measured:** 26 jobs exist and are ENABLED; the DEG-1 evidence file records
that each new binding was proved against a real handler rather than a 404. **NOT asserted:** that 26 jobs
cover the code's cron surface. The premortem measured **110 cron routes** in `origin/main` (108 POST, 2 GET),
so this rig binds roughly **21–24%** of them. The unbound remainder is the BL-7 coverage-scope question and
must be carried into the coverage table as *declared untested*, never as passing. Naming trap worth repeating
from DEG-5: an **unprefixed** `org-queue-scheduler` job also exists and targets **prod** — always use the
`arkova-worker-fullsoak-2026-08-staging-` prefix.

### DEG-5 status

`deg5-org-queue-triage.md` root-caused the `org-queue-scheduler` INTERNAL 500s: Zod 4's strict RFC-9562
`z.string().uuid()` rejected seed-fixture UUIDs whose version/variant nibbles are `0`. The fix was applied
**pre-clock, data-only, image untouched** (BL-1 digest parity preserved) — 7 entities re-keyed to RFC-4122
compliant UUIDs in a single atomic transaction at ~13:29Z, per `day0-uuid-surgery-evidence.md`. The worker
validator defect itself is filed separately as a non-gating T2 bug (57 call sites). Job is ENABLED and was
returning 200 on every attempt through 12:54:08Z pre-surgery.

---

## 9. Clock start, BL-2 close-out, probes, and the freeze break — FILLED 2026-08-12T15:5x–16:0xZ

> **Status of this section.** It was written PENDING in the 13:44–13:52Z capture window. It is closed here by
> the CTO close-out session against live `gh` / `gcloud` / Supabase MCP reads. Everything above §9 is the
> original 13:5xZ capture and is **not** retro-edited, except §0 and §1 where a stale revision name would
> otherwise mislead; both carry an explicit pointer to §9.4.

### 9.1 `clock_start` — **CLOSED**

Per §6.3 steps 7–9 and BL-4, clock start = **LATER of** (rig revision start, `SOAK_GATE_DISABLED=false` echo).

| Input | Value | Source |
|---|---|---|
| (a) Rig revision start | **`2026-08-12T15:10:05.965578Z`** | `00013-mrw` `Ready`=True `lastTransitionTime`, `gcloud run revisions describe` — `day0-bl2-secured-e2e-evidence.md` §4.1 / §4.12. **Supersedes** the `00012-f45` leg (`13:32:27.775544Z`, §2.3) — see §9.4 |
| (b) `SOAK_GATE_DISABLED=false` echo | **`2026-08-12T15:51:30Z`** | `gh variable set SOAK_GATE_DISABLED --body false` then `gh variable get`; variable `updatedAt` reads `2026-08-12T15:51:29Z`, the echo was captured at `15:51:30Z` and the **later, conservative** value is the one used |
| **`clock_start` = max(a, b)** | **`2026-08-12T15:51:30Z`** | (b) governs — the revision was already Ready 41 m 24 s earlier |
| **Day-7 close** = `clock_start` + 7×24 h | **`2026-08-19T15:51:30Z`** | arithmetic on the above |

```bash
gh variable set SOAK_GATE_DISABLED --body false     # §6.3 step 7 — LAST act before the clock
gh variable get SOAK_GATE_DISABLED                  # §6.3 step 8 — echo captured 15:51:30Z -> false
gh variable list                                    # DEPLOY_WORKER_PAUSED true 2026-08-12T13:23:42Z
                                                    # SOAK_GATE_DISABLED  false 2026-08-12T15:51:29Z
```

**Why (b) and not (a).** Both legs are required precisely because either one alone can hide a hole: a revision
that started before the gate flipped strands ungated hours inside the window, and a flip that precedes the
final deploy means the opening hours ran on a build that no longer serves. Here (b) is later, so the window
opens with the final revision already serving and the bypass already off — no ungated and no pre-deploy hours
exist inside it.

**Both variables must hold their stated values for all seven days.** `DEPLOY_WORKER_PAUSED=true` (§3.1) and
`SOAK_GATE_DISABLED=false` are asserted daily by `scripts/staging/fullsoak-daily-check.sh` A8/A9; a change to
either is an evidence-invalidating event under premortem R13, not a configuration tweak.

### 9.2 BL-2 — **CLOSED, PASS on `00013-mrw`**

Source of record: `docs/staging/fullsoak-2026-08/day0-bl2-secured-e2e-evidence.md` §4.10 (verdict), §4.5–§4.9
(evidence), §5 (rig-integrity attestation). Reproduced here in summary only — that file is authoritative.

| # | BL-2 sub-criterion | Verdict | Evidence (BL-2 file §) |
|---|---|---|---|
| 1 | An anchor created after the final revision began serving reaches `SECURED` | **PASS** | **12 of 12** anchors SECURED, 0 not-SECURED, at 15:46:02Z. Promotion by the worker's own `check-confirmations` pass at 15:38:13.247Z (`txChecked:4, anchorsConfirmed:7`) plus the earlier five. §4.6, §4.8 |
| 2 | `chain_tx_id` resolves `confirmed:true` **with a block height** on **two independent** signet explorers | **PASS** | **6 txids × 2 explorers = 12 responses**, mempool.space and blockstream.info byte-identical, heights 317376 / 317382 / 317384, swept 15:47:33Z. §4.4, §4.9 |
| 3 | matching `anchor_proofs` row with `block_header` = **80 raw bytes** | **PASS** | **12 of 12** proof rows `octet_length(block_header)=80` (80 not 160 ⇒ raw `bytea`, not hex text); 0 NULL, 0 wrong length; all 3 distinct headers byte-identical to our own node's `getblockheader … false`, each `dSHA256` == the recorded `block_hash`. §4.5, §4.7, §4.8 |
| 4 | Fee path is the dynamic estimator, **read from the boot log** | **PASS** | `00013-mrw` boot 15:10:25.881377Z: `feeEstimator:"Mempool.space"`, `utxoProvider:"GetBlock Hybrid (RPC broadcast + Mempool UTXO)"`, `mocks:false`, `signer:"WIF (ECPair)"`. §4.2 |

**Overall BL-2 on `arkova-worker-fullsoak-2026-08-staging-00013-mrw`: PASS — all four sub-criteria.**

Supporting controls, all clean at close (BL-2 file §4.10): mock detector `chain_block_height > 400000` = **0**;
`anchors.chain_block_hash` vs `anchor_proofs.block_hash` = **0 disagreements** across 12 rows; anchors with no
proof row = **0**; proofs `pending`/`stale` after the provider change = **0/0**; on-chain OP_RETURN root ==
`anchor_proofs.merkle_root` on all four Phase-2 txs; fee rate ≥ `fastestFee` on every Phase-2 broadcast.

**This supersedes §6.1 and §6.3 of this manifest**, which recorded `0 SECURED / 5 SUBMITTED / 0 headers` at
13:51Z. Those readings were true at their timestamp; the 15:46:02Z state is `12 SECURED / 0 non-SECURED /
12 headers`. §11 F-1 (the BL-2 ordering blocker) is closed by this.

**§1.5 boundary.** **Measured:** the counts, octet lengths, explorer responses and node-side header bytes
above. **Asserted:** that a 12/12 result on a controlled Day-0 cohort predicts the same over seven days — it
does not; that is what the window is for. **NOT asserted:** that any of this is mainnet evidence. The rig is
signet throughout (DEG-2), and prod's mainnet path is unchanged and untested by this exercise.

### 9.3 Behavioural flag probes — **CLOSED**

Source of record: `docs/staging/fullsoak-2026-08/day0-behavioral-probes.md` (28 probe rows, executed
13:45–14:13Z on `00012-f45`, plus its §3 fixture ledger). Every verdict there is a **named row-count delta**,
never an HTTP 200 — the premortem BL-3 criterion.

| Outcome | Count | Probes |
|---|---|---|
| **PASS** (named delta observed) | **15** | AI extraction, semantic search/embeddings, AI fraud/integrity, AI reports, verification API, webhook HMAC (forged leg delta = 0 **is** the assertion), DocuSign webhook, connector-artifact drain, org credit enforcement, rules engine, rule-action dispatcher, queue reminders, outbound webhooks, Drive webhook, attestation anchoring, org-queue-scheduler (DEG-5 fix proof), forced-dynamic-fee boot truth, mock detector |
| **FAIL** (real defect found) | **1** | `ENABLE_EXPIRY_ALERTS` → `POST /jobs/check-credential-expiry` returns **HTTP 500**: the handler selects `anchors.not_after` and `anchors.document_title`, neither of which exists. Flag resolution proved ON twice over, so this is a code/schema mismatch, not a gating artifact → **FD-2**, prod-exposed |
| **PARTIAL** (leg declared untestable, in writing) | **4** | connector-artifact enqueue (vendor-fetch leg needs a real DocuSign tenant), treasury alerts (below-threshold path needs a cache fixture — deliberately not fabricated), Drive changes-runner (needs real Google OAuth + page token), partner provisioning (**routeless at this SHA by design** — flag-on and flag-off are indistinguishable, both 404) |
| **NOT RUN** (each with a written rationale) | **5** | `ENABLE_FRAUD_DETECTION` (no worker consumer — UI-only), forced batch flush (reserved to the main session), `ENABLE_PUBLIC_RECORD_*` (would convert an unbounded external fetch into PENDING anchors and contaminate the Day-0 cohort), confirmation-proof backfill (covered by BL-2 §9.2), `ENABLE_ALLOCATION_ROLLOVER` / `ENABLE_CE_KEY_EXPIRY_ALERTS` (pinned OFF by design, §5.2) |

**Tally: 15 PASS · 1 FAIL · 4 PARTIAL · 5 NOT RUN.** The FAIL is a real find and is carried as FD-2; the four
PARTIALs and five NOT-RUNs are **declared untested**, which under BL-7 is a valid state and a hollow-soak
finding is not. Fixtures created for the probes are itemised row-by-row in that file's §3 (per §1.11A) — every
anchor and attestation was created through the real product API, never by SQL.

**§1.5 boundary.** **Measured:** the before/after counts in that file, read live from `gnkuaywlpmsaezwvlvhk`
between 13:45 and 14:14Z. **NOT asserted:** that 15 PASS means the gated surface is production-ready, or that
the 9 PARTIAL/NOT-RUN rows are covered by anything. They are not, and they must appear in the Day-7 coverage
table as declared-untested, never folded into a pass rate.

### 9.4 The authorised freeze break — `00012-f45` → `00013-mrw`

One deploy occurred after `DEPLOY_WORKER_PAUSED=true` was re-engaged at 13:23:42Z. It is recorded here in full
rather than smoothed away, because an unexplained revision change on a frozen rig is exactly the event the S3
boot-line alarm exists to surface.

| Field | Value |
|---|---|
| Authorisation | CTO, explicit, **pre-clock** — taken to close BL-2 sub-criteria 1 and 3 together (see §9.2) |
| Superseded revision | `arkova-worker-fullsoak-2026-08-staging-00012-f45` (Ready 13:32:27.775544Z) |
| **New revision** | `arkova-worker-fullsoak-2026-08-staging-00013-mrw` |
| Deploy issued / revision created | **`2026-08-12T15:09:40Z`** (operator action) / `15:09:42.414804Z` (Cloud Run `creationTimestamp`) |
| `Ready` = True | **`2026-08-12T15:10:05.965578Z`** ← the clock-start revision leg, §9.1(a) |
| Traffic | 100% → `00013-mrw`, `latestRevision: true` |
| **Image digest** | `sha256:8ace89d483484c40ea2022f7f21361effbfd6e0ab4d61ac4707f54e2ed1c1e18` — **UNCHANGED**, byte-identical to `00012-f45` and to prod `arkova-worker-01310-god` |
| What changed | `BITCOIN_UTXO_PROVIDER` `mempool` → **`getblock`**; VPC connector **`fullsoak-btc-rpc`** attached with egress `private-ranges-only` |
| What deliberately did **not** change | the image (no new code), `USE_MOCKS=false`, `ENABLE_PROD_NETWORK_ANCHORING=true`, `BITCOIN_NETWORK=signet`, `BITCOIN_FEE_STRATEGY=mempool`, `FORCE_DYNAMIC_FEE_ESTIMATION=true`, and `MEMPOOL_API_URL` **still unset** (per `memory/feedback_mempool_api_url_contract_bug`) |
| Backing RPC node | GCE VM `arkova-s33-rig-b1-bitcoin-core-signet` (`us-central1-a`), bitcoind in container `arkova-rig-b1-bitcoin-core`, reached at `http://10.33.10.10:38332` over the connector |
| Evidence | `day0-bl2-secured-e2e-evidence.md` §3 (node recovery), §4.1 (the break), §4.2 (boot truth), §4.3 (why it is a parity **upgrade**) |

**BL-1 parity survives the break.** It is a configuration change on prod's exact image digest — no untested
code entered the rig, and the `git_sha`/digest/ledger parity table in §2 is unaffected. The regeneration diff
proving the baselines moved *only* where expected (env + connector; scheduler census, both flag hashes and the
monitoring census byte-identical) is at
`docs/staging/evidence/fullsoak-2026-08/day0-snapshots/superseded-by-00013/REGENERATION-DIFF.md`, with the
`00012`-era baselines preserved beside it rather than overwritten.

**It is a parity upgrade, not merely a repair.** `GetBlockHybridProvider` is RPC for broadcast and inclusion
proofs, mempool.space for UTXO listing and fee estimation — which *is* production's architecture. The rig moved
from an architecture that exists nowhere in prod onto prod's exact chain topology, putting two previously
un-soaked production code paths (RPC broadcast, RPC `gettxoutproof`) under the window. See FD-3.

**Freeze accounting for the day, complete:** engaged 12:49:52Z → deliberately `false` 13:08:54Z → `true`
13:23:42Z (the documented 14 m 48 s drain window for the already-queued #2208 / #2209) → **one authorised
freeze-break deploy at 15:09:40Z** → nothing since. `DEPLOY_WORKER_PAUSED` has read `true` continuously since
13:23:42Z; the freeze break was executed **under** the freeze with explicit authorisation, not by lifting it.
**From `clock_start` (15:51:30Z) forward there are zero authorised deploys** — any revision change is a
window-invalidating event.

---

## 10. Artifact hashes (runbook §12 — sha256 of every Day-0 artifact)

```bash
shasum -a 256 docs/staging/fullsoak-2026-08/*.md docs/staging/fullsoak-2026-08/*.csv \
              docs/staging/fullsoak-2026-08/*.json docs/staging/evidence/gate0/*      # 13:50:56Z
```

| sha256 | Artifact |
|---|---|
| `f8bf3d7400c905438168a028dc81b90998b431e269fc2806c13566e473646607` | `fullsoak-2026-08/day0-bl2-secured-e2e-evidence.md` ⚠️ in-progress |
| `92b338b79280031b9aa2d61411d8b36bec4dfe4035b8d74f918180c79fd79b9b` | `fullsoak-2026-08/day0-uuid-surgery-evidence.md` |
| `0d25d0ae9b743cab1e72578bc26bb4f521739c9b2d70ea914a1ce4f71a471090` | `fullsoak-2026-08/deg1-cron-parity-evidence.md` |
| `99fa774c2a4378dc4ef0ae06867d4a0267c843c4347a1e23e7110207ef159438` | `fullsoak-2026-08/deg5-org-queue-triage.md` |
| `a3bc1a92087063c57fc4ed53f204e73f6dfbebbb89d82fae0107acbd789be76b` | `fullsoak-2026-08/flag-seed-plan.md` |
| `b04a33d5c4f5477df540c5577e8c4ba1267778970f4f6bfa1204a80a139d1c3a` | `fullsoak-2026-08/claims-register.csv` (13 claims) |
| `11c13fe907a96052d9ebc4de49f8056d8a6635c25f279e762468f9d2feeb3788` | `fullsoak-2026-08/flag-decision-matrix.csv` (66 flags) |
| `213127b587238acce94cf29d6a9f8f249f78ae9cf925e7ad038ebf598f10e7c5` | `fullsoak-2026-08/isolated-rig-provision-fullsoak-2026-08.json` |
| `0e5a09547dc4ff9fa8eb126176914b688c42ff826a835d7aab5da720a7bf315b` | `evidence/gate0/README.md` |
| `6c7543beefbe58dad51c7bd4e307512a966c1d82415a67fb8113b8464cf26a65` | `evidence/gate0/anchor-baseline-frozen.csv` |
| `6b92b4eb7193ab884aea5e69f3c19f0c5da83e7ae4a75a26277907dc6ee51c27` | `evidence/gate0/flag-runtime-snapshot-BEFORE-20260811T162504Z.json` |

In-manifest state hashes (reproducible from the databases themselves, not from a file):

| Hash | Meaning |
|---|---|
| `c205ee426a3411f73a975d2d314565ec6eeceb10a0c95d27ddd5cfb005a2865d` | **Rig `switchboard_flags` state** at 13:47:12Z (`flag_key=enabled`, ordered, sha256) |
| `7ac4bdd699d690f760947d5ce9c917b49bde45a6a5a6d459974cda0590d356a6` | Prod `switchboard_flags` state at 13:47:12Z, same projection |
| `sha256:8ace89d483484c40ea2022f7f21361effbfd6e0ab4d61ac4707f54e2ed1c1e18` | Container image, rig **and** prod |

**Preflight `clean_mirror` capture (runbook §2.5 requires this hashed into `manifest-DAY-0`):** the verbatim
JSON is inlined in §7 above; its `timestamp` field `2026-08-12T13:50:06.151Z` and `environment_type`
`clean_mirror` are the fields the DEG-6 rule pins. Re-derive with the §7 command against ref
`gnkuaywlpmsaezwvlvhk`.

**Artifacts declared missing / not yet written at manifest close:** behavioural-probe summary (§9.3);
BL-2 Phase-1 and Phase-2 bodies (§9.2); `evidence/claims/` per-probe outputs; `evidence/CC6.8/
api-key-designation.csv`. Hashes for these are added when they land — they are not counted as present.

### 10.1 Close-out re-hash — 2026-08-12, at the clock start

The two ⚠️ in-progress rows above are superseded here. Re-run
`shasum -a 256 docs/staging/fullsoak-2026-08/* scripts/staging/fullsoak-daily-check.sh docs/staging/evidence/fullsoak-2026-08/2026-08-12/*`
to reproduce. **The manifest cannot hash itself** — its integrity is the git commit that carries it.

| sha256 | Artifact | Note |
|---|---|---|
| `16e7245ed55e9484790f8f09c73f5da177a8ad98aa94b2bf9633cb53c9f8fe15` | `fullsoak-2026-08/day0-bl2-secured-e2e-evidence.md` | **final** — supersedes the `f8bf3d74…` in-progress hash above |
| `c66fa249f9a6ed0ab7bf825c5e3739fc69dab319bc33ccc6abc569c0e252edcd` | `fullsoak-2026-08/day0-behavioral-probes.md` | the §9.3 artifact, now present. **One wording-only edit after first hash** (`d4350795…`): probe 6's method note read `…with fixture key, \`X-DocuSign-Signature-1\``, which gitleaks' `generic-api-key` rule matched as a secret adjacent to the word "key". The matched string is a **header name**, not a secret — no credential is present in that file or anywhere in this pack. Reworded to `…under the fixture HMAC secret; header \`X-DocuSign-Signature-1\`` rather than allowlisting the path in `.gitleaks.toml`, on the principle that a scanner should not be weakened to accommodate prose. No evidence claim changed. |
| `92b338b79280031b9aa2d61411d8b36bec4dfe4035b8d74f918180c79fd79b9b` | `fullsoak-2026-08/day0-uuid-surgery-evidence.md` | unchanged |
| `0d25d0ae9b743cab1e72578bc26bb4f521739c9b2d70ea914a1ce4f71a471090` | `fullsoak-2026-08/deg1-cron-parity-evidence.md` | unchanged |
| `99fa774c2a4378dc4ef0ae06867d4a0267c843c4347a1e23e7110207ef159438` | `fullsoak-2026-08/deg5-org-queue-triage.md` | unchanged |
| `a3bc1a92087063c57fc4ed53f204e73f6dfbebbb89d82fae0107acbd789be76b` | `fullsoak-2026-08/flag-seed-plan.md` | unchanged (its four route errors are FD-16, corrected in this manifest, not in that file) |
| `b04a33d5c4f5477df540c5577e8c4ba1267778970f4f6bfa1204a80a139d1c3a` | `fullsoak-2026-08/claims-register.csv` | unchanged |
| `11c13fe907a96052d9ebc4de49f8056d8a6635c25f279e762468f9d2feeb3788` | `fullsoak-2026-08/flag-decision-matrix.csv` | unchanged |
| `213127b587238acce94cf29d6a9f8f249f78ae9cf925e7ad038ebf598f10e7c5` | `fullsoak-2026-08/isolated-rig-provision-fullsoak-2026-08.json` | unchanged |
| `04c11f3bc3cb46f408bdb89bf0c3ff5ac8952d2a5bba95eaf2872a351763f7e2` | `scripts/staging/fullsoak-daily-check.sh` | the daily instrument (28 assertions), pinned to `00013-mrw` |

Day-0 daily-check run under `docs/staging/evidence/fullsoak-2026-08/2026-08-12/`:

| sha256 | Artifact |
|---|---|
| `dcdad9aa8102b6ceb1be6a5a770caf382c2623c3a1eec8390220d59b6981812c` | `daily-check.md` |
| `34e22408a4b6ddbbab03b4be31e6341e915026fde2fa01d6b022e0bc779ce1b5` | `rig-health.json` |
| `10c74adc3c6bfd08c4339c7badf2faa0586552fd6abcfabe25cdc2cceb47b537` | `prod-health.json` |
| `93866853da5d2f27d908789769b32f8ac87fd05962f7286784e5da323a36774e` | `detailed-health.json` |
| `712614fab661b82b12fbcf3fa1db9252bacfb8ad4222d6c2b91357c7a4f372f2` | `rpc-node.json` |
| `b2a66269bb4e038d12f5c1daca50151cad8e91a581815c1c6d1cc9890804cf13` | `rig-env-dump.txt` |
| `8f55e30dcc7f92473d428ea0ce3d248c9cfc49d8c7f8833a4fc77b34267c4a67` | `rig-health-samples.txt` |
| `49e8c3651d601e79cd4057151153a0b0721d7b8e109e7fd38771dc7a1a7fe621` | `scheduler-census.txt` |
| `e5f1e4a02c6f9105c53c181640d04376613a84cdb07c742318372cabec0820b8` | `monitoring-census.txt` |
| `74c4fc67dfc7260f6dc613f7afece47bb064dbde2891260c227b9dbf978e8ec6` | `uptime.json` |
| `22f5945c213e3784700a9b6d5a108b0873e6598e52346f59712ae3be35a58059` | `switchboard-flags-full.tsv` |
| `05018e26af0d7a11f9067ba9d90dd01581b7e58435cdc3e14f64f809df14a8c6` | `switchboard-flags-material.txt` |

The frozen Day-0 baselines the daily check compares against live under
`docs/staging/evidence/fullsoak-2026-08/day0-snapshots/` with their own `hashes.txt`; the `00012`-era set they
replaced is preserved (not deleted) under `day0-snapshots/superseded-by-00013/`, alongside
`REGENERATION-DIFF.md` — the artifact that proves the freeze-break changed only what §9.4 says it changed.

**Still not written, and still counted as absent:** `evidence/claims/` per-probe outputs and
`evidence/CC6.8/api-key-designation.csv` (FD-12).

---

## 11. Findings — one canonical Day-0 register (`FD-n`)

> **Renumbered at close-out, deliberately.** Three documents were written in parallel on Day 0 and each opened
> its own `F-D0-1`, so the same label meant three different things (a lease self-heal, an expiry-checker 500,
> and a `populate-confirmation-proofs` gap). **`FD-n` below is the single canonical numbering for this soak.**
> The source documents are **not** rewritten — the "Source label" column maps each canonical id back to the
> label its evidence file uses, so an auditor reading either document can cross-walk without ambiguity.
> Cite `FD-n` from here on; treat a bare `F-D0-n` as ambiguous and resolve it through this table.

| ID | Finding | Severity / state | Source label | Evidence |
|---|---|---|---|---|
| **FD-1** | **`check-confirmations` run-lease TTL self-heal works.** A lease holder killed by a deploy blocked the job for 35 m 26 s and was recovered by the TTL with **zero** manual intervention; a second holder killed by the 15:10 traffic cut recovered the same way 35 m 11 s after its last heartbeat. The lease row was never edited by hand in any phase. | **Closed — informational (positive)** | BL-2 `F-D0-1` | BL-2 §1.5, §4.11 |
| **FD-2** | **`check-credential-expiry` 500s on every run — prod-exposed.** The handler selects `anchors.not_after` and `anchors.document_title`; **neither column exists** (schema has `expires_at`, and there is no title column). Flag resolution is proved ON twice over (boot log `{source:'db',value:true}` + the handler did not take its `skipped` branch), so this is a code/schema mismatch, not a gating artifact. Rig schema == prod ledger head, so **this job 500s in prod too whenever `ENABLE_EXPIRY_ALERTS` is on.** Compounding: its delivery event `compliance.document_expiring` is not a registrable `webhook_endpoints` event type, so even a fixed query has no subscriber path — the feature is dead end-to-end at this SHA. | **Open — defect, prod-exposed** | probes `F-D0-1` | probes §1 row 14, §2.1 |
| **FD-3** | **Rig↔prod UTXO-provider divergence — CLOSED via the authorised provider flip, as a parity *upgrade*.** `MempoolUtxoProvider` implements no `getTxOutProof`, so `fetchConfirmationProof` always returned `pending` and `block_header` could never be written on `00012-f45`. `BITCOIN_UTXO_PROVIDER=getblock` on `00013-mrw` both unblocked BL-2 sub-criterion 3 and moved the rig onto **prod's exact hybrid chain architecture** (RPC broadcast + RPC inclusion proofs + mempool.space UTXO/fees), putting two previously un-soaked production code paths under the window. | **Closed — with an upgrade** | BL-2 `F-D0-3` | BL-2 §1.7, §4.3, §4.5; §9.4 |
| **FD-4** | **A hung `check-confirmations` run deadlocks SUBMITTED→SECURED promotion fleet-wide — OPEN, prod-exposed.** A run started at 14:16:00.220Z never completed; `startRunLeaseHeartbeat` renews the lease every 700 s forever, so the TTL never expires and `releaseRunLease` (in `finally`) is never reached. `withRunLease`'s per-process `inFlight` guard short-circuits **before** the lease check, so the holding instance also self-blocks. Net: promotion permanently disabled, **no self-heal, no alarm, HTTP 200 on every call** — 31 forced invocations over 29 minutes all returned `{"checked":0,"confirmed":0}` with zero warn/error logs. The rig only recovered because a deploy killed the holder; that is a restart, not a fix. **Prod runs `minScale=2` and is exposed identically.** | **OPEN — blocking for production** | BL-2 `F-D0-5` | BL-2 §2.6a, §4.11 |
| **FD-5** | **PENDING anchors cannot sit on this rig while an org is org-queue-due.** The scheduled `org-queue-scheduler` (`4-59/5`) claimed both orgs and force-flushed the first 4 API anchors within ~107 s of creation. Any test that needs a PENDING cohort to persist must run in the window between org-due passes, or before the `0 3 * * *` daily forced flush. Rig-topology note that changes how the runbook's forced-flush observation must be scheduled — not a defect. | Informational — affects runbook timing | probes `F-D0-2` | probes §2.2 |
| **FD-6** | **Lease-blocked runs are indistinguishable from empty runs.** `POST /jobs/check-confirmations` returns `{"checked":0,"confirmed":0}` for **both** "nothing to do" and "another instance holds the lease". Only the log line separates them, so a Cloud Scheduler job silently no-opping for 35+ minutes looks identical to a healthy one. Demonstrated twice (14:00Z era and 15:38:12–15:45:02Z). This is what made FD-4 invisible. | Open — low, but it is FD-4's blindfold | BL-2 `F-D0-2` | BL-2 §1.5, §2.6a, §4.11 |
| **FD-7** | **The chosen fee rate is derivable but never quoted.** The estimator's sat/vB is logged only at `debug` (`chain/fee-estimator.ts:240`, `chain/signet.ts:736`); the rig emits `info` and above, and the `info` line carries `fee: 628` with no rate. Every "the estimator chose N sat/vB" claim must therefore be *derived* from `fee` ÷ vsize, never quoted. Promoting one line to `info` would make the fee path directly auditable. | Open — low, claims hygiene | BL-2 `F-D0-4` | BL-2 §2.4, §4.11 |
| **FD-8** | **The S2 5xx fire-test incident opened ~10 min late and carries misleading text.** The policy filter was temporarily swapped to `4xx`, 8 synthetic 404s were driven, and the filter was restored at 13:44:52Z; the incident opened at 13:51:11Z reading `{response_code_class=5xx} … value of 8.000`. **Measured:** the rig's actual 5xx count is **0** in every 300 s window through the whole period. **Asserted:** the alarm plumbing (condition → incident → channel) works. **NOT asserted:** that the rig served any 5xx — it did not. Both this incident (`0.obcnmwefxukw`) and the S3 boot-line incident (`0.obcn7x98wuti`, opened on the intended deploy) were still open at 13:52:22Z and must be allowed to auto-resolve; the Day-1 artifact must recognise them rather than re-discover them as new findings. | Low — must not be misread | manifest `F-3` | §4.3 |
| **FD-9** | **Ledger `name`-column cosmetic divergence at `0403`** — rig `0403_fix_anonymize…`, prod `fix_anonymize…`. `version` (`0403`) and row counts are identical, and every parity gate reads `version`. | Informational | manifest `F-4` | §2.4 |
| **FD-10** | **Preflight emits 6 checks; the provision record claims 7/7.** The classifier verdict the gate consumes (`clean_mirror`, exit 0) is unchanged. No claim is made that the two enumerations match. | Informational | manifest `F-5` | §7 |
| **FD-11** | **`81baf563…` carries a patterned, fixture-derived OP_RETURN payload** (`a1b2c3d4e5f6a7b8` ×4), not a computed Merkle root. A real confirmed transaction, but **not** end-to-end anchoring proof and never to be cited as such. (The four Phase-2 transactions' roots were independently matched against `anchor_proofs.merkle_root` — BL-2 §2.5.) | Informational — claims hygiene | manifest `F-6` | §6.2 |
| **FD-12** | **Active API keys = 6**, where the premortem's §9 correction recorded 4. Not a defect; the CC6.8 designation table (runbook §11) must enumerate all of them with owner, purpose, scope justification, expiry and rotation plan. Three more were minted through the real `POST /api/v1/keys` flow during the probes (probes §3) — the Day-7 table must reconcile against the live count, not this number. | Open — `evidence/CC6.8/` not yet written | manifest `F-7` | §6.1, probes §3 |
| **FD-13** | **Cron coverage is ~21–24%** — 26 bound scheduler jobs against 110 cron routes on `origin/main`. This is the BL-7 founder scope decision, not a rig defect; the unbound remainder must appear in the Day-7 coverage table as **declared untested**, never as passing. | Scope decision — BL-7 | manifest `F-8` | §8 |
| **FD-14** | **AI-credit gating is inconsistent.** With `ai_credits` empty, `/ai/embed` and `/ai/search` fail **closed** (402) but `/ai/extract` proceeded and returned `creditsRemaining: null` — extraction is effectively **un-gated** when no allocation row exists. Fail-open on a metered surface. | Open — needs a ticket | probes `F-D0-4` | probes §2.4 |
| **FD-15** | **Worker validators apply strict Zod `uuid()` to DB-sourced ids.** Zod 4 enforces RFC 9562 version/variant nibbles, so `claimDueOrganizations` rejected the seed fixtures' hand-crafted UUIDs and `org-queue-scheduler` returned INTERNAL 500 once per claim cycle — **one bad row DoSes an entire job pass**. 57 call sites share the pattern. The rig side was fixed pre-clock, **data-only, image untouched** (7 entities re-keyed in one transaction, digest parity preserved); the seed-side repo fix is PR **#2215** (T1, draft, held for the window). **The validator-side defect is untouched and open.** | Open — validator side | deg5 triage; probes §2 (via #21) | `deg5-org-queue-triage.md`, `day0-uuid-surgery-evidence.md` |
| **FD-16** | **`flag-seed-plan.md`'s probe recipes carry four route/table errors** found by executing them: verify is `/api/v1/verify/:publicId` (not a fingerprint) and writes `audit_events(VERIFICATION_QUERIED)` (not `verification_events`); the DocuSign webhook is `/webhooks/docusign` (not `/api/v1/...`); Drive channel state lives in `org_integrations.subscription_id`/`account_label` (there is no `drive_watch_state` table); AI search logs `event_type='embedding'` (there is no `'search'` type). A future session running the plan verbatim would mis-read all four as failures. | Informational — doc correction | probes `F-D0-3` | probes §2.3 |

### Closed on Day 0, before the clock

| Was | Now |
|---|---|
| manifest `F-1` — *BL-2 is not closed; 0 SECURED, all headers NULL* | **CLOSED.** 12/12 SECURED, 12/12 80-byte headers, verified through 15:47:33Z. §9.2 / BL-2 §4.10 |
| manifest `F-2` — *`SOAK_GATE_DISABLED` is still `true`* | **CLOSED.** Set `false` at 15:51:29Z, echo captured 15:51:30Z = the clock start. §9.1. It must now **stay** `false` for the whole window; A9 of the daily check asserts it |

### Findings that are prod-exposed, stated plainly

**FD-2** and **FD-4** are defects in code that is running in production on the identical image digest. FD-4 is
the serious one: it silently disables anchor promotion with a 200 response and no alarm, and prod runs
`minScale=2`. A remediation session for FD-4 is already underway (founder-started background task
`task_ce0c8fb8`). Neither is a rig artifact, and neither may be described as "found on staging" in a way that
implies prod is unaffected.

### Parity checks that PASSED with no mismatch

`git_sha` (rig ≡ prod ≡ registry tag ≡ `BUILD_SHA`), image digest (rig ≡ prod, exact), migration ledger head
and row count (`0409` / 111 / 1 non-numeric on both), mock-line count on the final revision (**0**),
mock-height anchor detector (**0**), `MEMPOOL_API_URL` absent, treasury address ≡ boot-line signer address,
unconfirmed treasury balance (**0 sats, nothing stuck**), all 8 planned env flags present with planned values,
all 26 scheduler jobs ENABLED, all 4 SOAK uptime checks and 3 SOAK alert policies present and enabled with
correct (restored) filters and matchers.

---

## 12. Measured / asserted / NOT asserted (CLAUDE.md §1.5)

**Measured** — read live from the named system in the 13:44:32Z–13:52:22Z window, each with its command:
rig and prod `/health` payloads; Cloud Run serving revisions, creation timestamps, readiness conditions and
image digests; Artifact Registry tags; migration ledger heads, row counts and head-of-ledger names on both
projects; `DEPLOY_WORKER_PAUSED` and `SOAK_GATE_DISABLED`; 5 uptime-check configs and 7 alert policies with
creation/mutation records; 2 notification channels; violation-event log with policy attribution; Pub/Sub
delivery counts; uptime pass-fraction series; Cloud Run 4xx/5xx series and individual non-2xx request logs;
25 `switchboard_flags` rows and their sha256 on rig and prod; 44 env entries on `…-00012-f45`; boot log of
that revision including the flag-registry and chain-client lines; mock-line count; anchor status counts and
per-anchor rows; `anchor_proofs` header presence; three signet transactions and the tip height; treasury
address stats; a fresh preflight run; 26 scheduler jobs with schedules and states.

**Asserted** — believed on good evidence, but not directly proven by a reading in this manifest:
that the 13:34:52Z Pub/Sub delivery corresponds to the S3 boot-line incident (attribution is by policy name in
the violation-event log plus 19 s temporal correlation, not by reading the message body — the subscription was
not consumed, since acking is a mutation); that the 5xx-policy fire test used a temporary 4xx filter swap at
~13:41Z (inferred from the 8 synthetic 404s, the 13:44:52.850977241Z mutation record, and the incident's
threshold-8 text — the intermediate policy revision itself is not retained by the API); that the freeze
timeline 12:49:52Z → false 13:08:54Z → true 13:23:42Z is complete (only the final `13:23:42Z` mutation is
visible in `gh variable list`; the earlier transitions come from the main session's record and are consistent
with the prod revision created at 13:15:06Z inside that window); that the `0403` ledger `name` difference is a
write-path artifact rather than a schema difference.

> **§12 was written at 13:52:22Z and is preserved as written.** Two of its NOT-asserted items were closed
> later the same day and are struck through below with a pointer; the rest stand unchanged. Nothing here was
> silently rewritten to match the outcome.

**NOT asserted:**
- ~~**Not asserted** that any anchor has been secured end-to-end on the soak revision — 0 SECURED (F-1).~~
  **CLOSED at 15:46:02Z** — 12/12 SECURED with 12/12 80-byte headers on `00013-mrw` (§9.2, FD-3). Still NOT
  asserted: that any of it is mainnet evidence. The rig is signet throughout.
- **Not asserted** that `/health: healthy` implies anchoring, KMS or any downstream capability works (DEG-3,
  DEG-8). It measures database reachability and shallow checks.
- **Not asserted** that a `true` flag row makes a capability function. Resolution is path-dependent; some rows
  (`ENABLE_ORG_CREDIT_ENFORCEMENT`) are audit mirrors the worker never reads. Behavioural probes decide (§9.3).
- **Not asserted** that rig and prod schemas are byte-identical — parity here is ledger-level (version + count).
- **Not asserted** that the rig exercises production's cron surface — ~21–24% of routes are bound (F-8).
- **Not asserted** that either pre-clock transaction is BL-2 evidence — both predate the final revision and
  used the Static fee estimator; `81baf563…` additionally carries a fixture payload (F-6).
- ~~**Not asserted** that the Staging Soak Evidence Gate is meaningful while `SOAK_GATE_DISABLED=true` (F-2).~~
  **The variable is `false` from 15:51:29Z.** Now asserted instead: a green gate from the clock start onward
  reflects the evidence block, not the bypass — and that only holds while the variable stays `false` (A9).
- **Not asserted** that the two open incidents (FD-8) indicate any rig fault. They do not.
- ~~**Not asserted** that the soak clock has started. It has not. §9.1 is empty by design.~~
  **The clock started at `2026-08-12T15:51:30Z`** (§9.1). Still NOT asserted: that any hour after that has
  been observed — the window runs to `2026-08-19T15:51:30Z` and only the daily artifacts under
  `docs/staging/evidence/fullsoak-2026-08/<date>/` can speak for elapsed days.

---

## 13. Provenance

Assembled 2026-08-12, capture window 13:44:32Z–13:52:22Z, by the Day-0 manifest agent, **read-only against all
infrastructure**: no Cloud Run, Cloud Scheduler, Monitoring, Secret Manager, GitHub variable, or database
object was created, updated or deleted in producing this document. All SQL was `SELECT` under
`SET statement_timeout='8s'`. Secret **names** are recorded; no secret **value** was printed, logged, or
written to any file. The only write performed was this file.

CLAUDE.md acknowledged `d48a011806d9730d08e67201d9c0ef02571b67a8edc127934f4eb99d3aff6fd3` at
`2026-08-12T13:44:32Z` (`scripts/agent/ack-claude-bootstrap.sh`).

**Close-out addendum (§9 filled, §11 renumbered, §10.1 added), 2026-08-12 by the CTO close-out session.**
Also read-only against all infrastructure: `gh variable list`, `gcloud run services describe`, and
`shasum` over files already in the working tree. The one state change in the whole close-out is the
`gh variable set SOAK_GATE_DISABLED --body false` recorded in §9.1 — which is §6.3 step 7, the act that starts
the clock, and is the reason this document exists. No Cloud Run, Scheduler, Monitoring, Secret Manager or
database object was created, updated or deleted; no SQL was run. `00012-f45`-era readings above are preserved
exactly as captured — where a later fact supersedes one, the supersession is stated in place (§0, §1, §2.3,
§9, §11, §12) rather than by editing the original reading.

CLAUDE.md re-acknowledged `d48a011806d9730d08e67201d9c0ef02571b67a8edc127934f4eb99d3aff6fd3` at
`2026-08-12T15:53:35Z`.

_Every claim above links to the command that produced it and the UTC moment it was read. Items that could not
be verified are marked PENDING or listed in §11 — never asserted._

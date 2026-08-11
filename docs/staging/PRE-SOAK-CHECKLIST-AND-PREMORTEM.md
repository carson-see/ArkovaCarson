# Pre-Soak Deploy Checklist & Pre-Mortem — 7-Day Full-Functionality Soak

> **Verdict as of 2026-08-11 17:00 UTC: NO-GO.**
> **Owner:** RTE. **Companion document:** [`FULL-SOAK-2026-08-RUNBOOK.md`](./FULL-SOAK-2026-08-RUNBOOK.md) —
> that runbook defines *how the 7 days are run*. This document is the **Day-0 gate that decides whether they start**.
> It does not restate the runbook; where the runbook is still accurate it cites it and moves on.
>
> Every fact below was queried live on 2026-08-11 between 16:40 and 17:00 UTC. Where this document contradicts the
> runbook, the runbook is the older reading and this document supersedes it — each such correction is called out
> explicitly in §1.2 rather than silently overwritten.
>
> **Rule for every line in this document:** it carries the command or query that checks it, and a pass criterion that
> a second person could evaluate without asking the author what was meant. A line that cannot be checked is not a
> checklist item; it is an opinion, and it has been removed.

---

## 0. Verdict and the shortest path to GO

**NO-GO.** Six blockers are open. Four are cheap, one is owned by another engineer, one is a decision only the
founder can make.

| # | Blocker | Owner | Est. | Why it blocks |
|---|---|---|---|---|
| **B1** | Production is **degraded right now** — `/health` 503, `checks.database=error` | Engineer already assigned | unknown | Cannot baseline a soak against a broken production; and the rig does **not** reproduce the fault (§2.1) |
| **B2** | Rig holds **8 fabricated SECURED anchors** with non-hex txids | RTE | 30 min | Anchoring evidence is poisoned at the baseline (§2.2) |
| **B3** | **18 of 20 soak-critical flags are dark on the rig** — it mirrors prod instead of the soak decision | RTE | 2 h | The connector suite, rules engine and webhook HMAC would be silently skipped (§4) |
| **B4** | `SOAK_GATE_DISABLED=true` — the evidence gate passes vacuously | RTE | 2 min | No evidence produced during the soak is citable (§7.1) |
| **B5** | `DEPLOY_WORKER_PAUSED=false` with **20 open PRs** | Founder approval | 5 min | A merge mid-soak deploys to prod and invalidates head-pinned evidence (§7.2) |
| **B6** | **~25,000 false alerts / 13 days** across 4 duplicate monitors | RTE | 3 h + 24 h quiet | A real failure during the soak is statistically invisible (§7.3) |

**Shortest path to GO — roughly 3 working days, and the long pole is not engineering effort:**

```
Day -3   B1 fix lands (not ours) ──► then 24h stability soak-in on prod  ─┐
Day -3   B2 + B3 + B4 executed in parallel (≈3h total, all RTE)          ─┼─► Day 0 gate re-run
Day -3   B6 monitor cleanup, then 24h quiet baseline                     ─┘
Day -2   B5 founder decision on change freeze
Day -1   Day-0 checklist executed end to end; all PASS
Day  0   Clock starts
```

The binding constraint is that **B1 and B6 each require a 24-hour observation window after the fix**, and those two
windows can run concurrently. Nothing is gained by starting sooner: a soak begun on a degraded prod inside an alert
storm produces evidence an auditor will discard, which costs the full 7 days rather than saving 3.

---

## 1. Verified state, 2026-08-11

### 1.1 Live readings

| Subject | Reading | How verified |
|---|---|---|
| Prod `/health` | **`degraded`, HTTP 503**, `database=error`, `anchoring=ok`, `kms=ok`, uptime 15,892s, `git_sha 2de4e4e34`, mainnet | `curl -s -w '%{http_code}' .../health` |
| Prod `GET /api/v1/verify/{id}` | **HTTP 503** `service_unavailable` — "Verification API is not currently enabled" | `curl` |
| Prod `/jobs/*` unauthenticated | HTTP 401 `Authentication required` — correct, auth is **not** wide open | `curl -X POST .../jobs/batch-anchors` |
| Prod ledger head | **0405** | SQL on `supabase_migrations.schema_migrations` |
| Prod flags | 24 rows, **17 enabled** | SQL on `switchboard_flags` |
| Prod active API keys / orgs | **18** / **10** | SQL |
| Prod Scheduler | 59 prod-targeted: 46 healthy, 7 PAUSED, **4 failing code 13 (INTERNAL)**, **2 failing code 4 (DEADLINE)** | `gcloud scheduler jobs list` |
| Prod failing jobs | `fetch-acra-sg`, `openalex-bulk`, `org-queue-scheduler`, `refresh-stats`, `connector-health-check`, `drain-connector-artifacts` | `gcloud`, filtered on `status.code` |
| **Rig `/health`** | **`healthy`, HTTP 200**, signet, db/anchoring/kms all `ok`, `git_sha 2de4e4e34`, uptime 1,561s | `curl` with `gcloud auth print-identity-token --audiences=<url>` |
| Rig ledger head | **0405 (107 rows) — parity with prod** | SQL |
| Rig flags | 24 rows, 17 enabled — **an exact mirror of prod** | SQL |
| Rig anchors | 12: 8 SECURED, 3 PENDING, 1 SUBMITTED | SQL |
| **Rig SECURED txids** | **all 8 fabricated** — 6 fail `^[0-9a-f]{64}$`, one is the literal string `arkova_org_tx_001` | SQL with regex assertion |
| Rig orgs | 2 — `Acme Corp` (1 member, 1 signed in), `Arkova` (2 members, 1 signed in) | SQL join `org_members` × `auth.users` |
| Rig API keys | 3 | SQL |
| Rig env | `BITCOIN_NETWORK=signet`, `USE_MOCKS=false`, `MEMPOOL_API_URL` **unset**, `ENABLE_PROD_NETWORK_ANCHORING=true` | `gcloud run services describe` |
| Rig Scheduler | **24 jobs, all ENABLED, zero failures** | `gcloud` |
| Cron routes in code | **105** (`services/worker/src/routes/cron.ts`) | `grep -oE "router\.(get\|post)\(" ` |
| Cloud Run services | 4 — zombies confirmed **absent** | `gcloud run services list` |
| `SOAK_GATE_DISABLED` | **`true`** | `gh variable list` |
| `DEPLOY_WORKER_PAUSED` | **`false`** | `gh variable list` |
| Open PRs | **20** | `gh pr list` |

### 1.2 Corrections to the runbook — what changed since it was written

The rig has advanced materially. Three of the runbook's Gate 0 concerns are now closed, and one of its assumptions
is now wrong in a way that matters.

| Runbook said | Now true | Effect |
|---|---|---|
| Rig ledger **0400**, 5 behind prod (§0, §1.4 step 0.1) | **0405 — parity** | Gate 0 step 0.1 **CLOSED** |
| Rig has **1** `switchboard_flags` row, "19 of 20 dark" (§1.3) | **24 rows, 17 on** | Partly closed — but seeded to the **wrong target**, see §4 |
| Rig has **0 anchors, 0 orgs** (§0) | 12 anchors, 2 orgs, 3 keys | Preflight Check 5 now satisfiable — **but by fabricated rows** (§2.2) |
| Zombie teardown needs verifying (§2.1) | Verified absent | **CLOSED** |
| Rig Scheduler bindings pending (§2.2) | 24 bound, all ENABLED, zero failures | Partly closed — **24 of 105 routes**, see §5 |
| "Prod worker health `healthy`" (§0 table) | **`degraded`, 503** | **The runbook's own baseline is stale.** B1 |

**The correction that matters most:** the runbook treats the rig as a faithful mirror of prod and treats that as the
goal. It is now a faithful mirror of prod, and that is the **problem**. Prod has seven advertised capabilities
switched off. Mirroring prod means the soak inherits prod's blind spots and reports green across them. The rig must
be seeded to the **soak decision state** from runbook §1.4 step 0.4, which is deliberately *not* prod's state.

---

## 2. BLOCKERS — all must read PASS before Day 0

### B1 — Production is degraded (P0, owned elsewhere)

A separate engineer owns the fix. **This checklist does not duplicate the diagnosis; it defines the gate.** The root
signal is `PGRST002 Could not query the database for the schema cache` — the database is healthy and
`ENABLE_VERIFICATION_API=true`, but the worker cannot read the schema cache, so the feature gate fails closed and the
public verification API returns 503.

```bash
# B1.a — prod health must be healthy, not degraded
curl -s -m 20 -w '\nhttp=%{http_code}\n' https://arkova-worker-270018525501.us-central1.run.app/health

# B1.b — the public verification API must actually serve
curl -s -m 20 -w '\nhttp=%{http_code}\n' \
  https://arkova-worker-270018525501.us-central1.run.app/api/v1/verify/<known-public-id>

# B1.c — no PGRST002 in the trailing 24h
gcloud logging read \
  'resource.labels.service_name="arkova-worker" AND textPayload:"PGRST002"' \
  --project=arkova1 --freshness=24h --limit=5
```

| Check | PASS criterion |
|---|---|
| B1.a | `status=healthy`, `checks.database=ok`, **http=200** |
| B1.b | **http=200** with a verification body — *not* 503, and *not* a 404 for an unknown id |
| B1.c | **Zero** `PGRST002` occurrences in 24h |
| B1.d | **Stability soak-in: B1.a returns healthy continuously for 24 h**, sampled ≥ every 15 min, before Day 0 |

**B1.d is the item most likely to be skipped and must not be.** A worker that recovers on restart and degrades again
four hours later is not fixed; it is intermittent, and an intermittent database fault during a 7-day soak corrupts
every surface simultaneously while looking like isolated flakiness. Sample it:

```bash
# run for 24h; any non-healthy sample resets the clock
while :; do
  printf '%s ' "$(date -u +%FT%TZ)"
  curl -s -m 10 https://arkova-worker-270018525501.us-central1.run.app/health \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["status"], d["checks"]["database"])'
  sleep 900
done | tee docs/staging/evidence/gate0/b1-stability-24h.log
```

> **The rig cannot substitute for this.** The rig runs the **identical image** (`git_sha 2de4e4e34`) and is
> `healthy` while prod is `degraded`. The fault is therefore environmental to prod — its PostgREST, its schema cache,
> its connection state — and **the soak will never encounter it**. Whatever B1 turns out to be, it is a class of
> failure this soak is structurally blind to. Record that as an explicit residual risk at Day 7 (§10, P1).

---

### B2 — The rig's anchoring baseline is fabricated

All 8 SECURED anchors on the rig carry made-up transaction ids. Six are not even valid hexadecimal:

```
ghi789abc123ghi789...  pqr678abc123pqr678...  stu901abc123stu901...
vwx234abc123vwx234...  jkl012abc123jkl012...  mno345abc123mno345...   (len 62, non-hex)
arkova_org_tx_001                                                      (len 17)
def456abc123def456...  abc123def456abc123...                           (len 64, hex-shaped, still synthetic)
```

This is the hollow-soak trap in its purest form, and it is **already present in the baseline**: the fixture seed that
makes `staging-honesty-preflight.ts` Check 5 pass (`submitted_anchors >= 1`) is the same fixture that fabricates the
anchoring evidence. Any Day-7 statement of the form "N anchors reached SECURED" silently includes these 8.

```sql
-- B2.a — enumerate and watermark every pre-soak anchor
select id, status, chain_tx_id, created_at,
       (chain_tx_id ~ '^[0-9a-f]{64}$') as valid_txid_format
from anchors order by created_at;
```

```bash
# B2.b — freeze the baseline so every soak assertion can exclude it
psql "$RIG_DB_URL" -c "\copy (select id, status, chain_tx_id, created_at from anchors) \
  to 'docs/staging/evidence/gate0/anchor-baseline-frozen.csv' csv header"
```

| Check | PASS criterion |
|---|---|
| B2.a | Every pre-existing anchor id is enumerated and recorded |
| B2.b | `anchor-baseline-frozen.csv` committed **before** the clock starts |
| B2.c | Every soak anchoring assertion filters `created_at > <clock_start>` **and** asserts `chain_tx_id ~ '^[0-9a-f]{64}$'` |
| B2.d | Every SECURED anchor claimed as soak evidence is **independently confirmed on a signet explorer** — the DB is not the witness for its own claim |

**Decision required:** either delete the 8 fabricated rows and re-satisfy preflight with a *real* signet anchor, or
keep them and exclude them by frozen id list. Deleting is cleaner and is the recommendation — a baseline that must be
remembered will eventually be forgotten. Whichever is chosen, record it in the Gate 0 artifacts.

---

### B3 — Soak-critical flags are dark on the rig

See §4. Blocking because 18 of the 20 flags the soak depends on resolve to false or have no row at all.

---

### B4 — The evidence gate is bypassed

```bash
gh variable get SOAK_GATE_DISABLED     # currently: true
gh variable set SOAK_GATE_DISABLED --body false
gh variable get SOAK_GATE_DISABLED     # must echo: false
```

| Check | PASS criterion |
|---|---|
| B4.a | `SOAK_GATE_DISABLED=false` before the clock starts |
| B4.b | Re-verified `false` at Day 7 close — a flip mid-period voids the period |

While `true`, `scripts/ci/check-staging-evidence.ts` short-circuits to a pass **without reading the PR body**. A green
"Staging Soak Evidence Gate" collected during the bypass is not evidence of anything and must never be shown to an
auditor. Per `memory/feedback_soaks_are_off_read_the_check.md`, read the variable — never infer the gate's state from
a green check.

---

### B5 — Change freeze (founder decision)

```bash
gh variable get DEPLOY_WORKER_PAUSED   # currently: false
gh pr list --state open --json number,title,labels --jq 'length'   # currently: 20
```

| Check | PASS criterion |
|---|---|
| B5.a | `DEPLOY_WORKER_PAUSED=true` for the soak window, **or** a written RTE-sign-off-per-merge protocol with evidence re-pinning |
| B5.b | The 20 open PRs triaged: which may merge during the freeze (docs-only, T0) and which may not |

`DEPLOY_WORKER_PAUSED=false` means any merge to `main` deploys to prod during the soak. Per CLAUDE.md §1.11A, a
runtime or migration commit after a soak begins **invalidates exact-head evidence**. With 20 PRs open and Mergify
auto-merging on green, this is not a hypothetical.

---

### B6 — Alert fatigue

| Check | Command | PASS criterion |
|---|---|---|
| B6.a | `gcloud alpha monitoring policies list --project=arkova1` | Exactly **one** cron-failure monitor remains; the 3 duplicates deleted |
| B6.b | same | The 2-minute dead-tuple alert on the 16-row table is fixed or deleted |
| B6.c | Count alert notifications over 24 h after B6.a/B6.b | **< 5 alerts in 24 h** before the clock starts |

B6.c is the gate, not B6.a. Deleting monitors reduces the count mechanically; what must be established is a **quiet
baseline**, so that any alert during the soak is signal by construction. Without it, the soak's own alerts arrive as
items 25,001 through 25,400 in a stream nobody reads.

---

## 3. Environment

| # | Item | Command | PASS criterion |
|---|---|---|---|
| E1 | Rig ledger = prod ledger | `select max(version) from supabase_migrations.schema_migrations` on both refs | Both **0405** ✅ *verified* |
| E2 | Rig on prod's image | `gcloud run services describe … --format='value(spec.template.spec.containers[0].image)'` | Digest identical to prod's ✅ *`2de4e4e34` on both* |
| E3 | `BITCOIN_NETWORK=signet` | `gcloud run services describe` env dump | `signet`, never `mainnet` ✅ *verified* |
| E4 | `USE_MOCKS=false` | env dump | `false` ✅ *verified* |
| E5 | `MEMPOOL_API_URL` unset | env dump, grep `MEMPOOL` | **No output** ✅ *verified* |
| E6 | `CRON_SECRET` sourced from `cron-secret`, not `cron-secret-staging` | `gcloud run services describe … --format='value(spec.template.spec.containers[0].env)'` \| grep -i cron | Resolves to `cron-secret`; a `-staging` suffix yields 401 on every cron call and silently degrades coverage to zero |
| E7 | Zombie services absent | `gcloud run services list --region=us-central1` | Exactly `arkova-worker`, `arkova-worker-staging`, `arkova-worker-fullsoak-2026-08-staging`, `chaindump-mcp` ✅ *verified* |
| E8 | Preflight clean | `npx tsx scripts/ci/staging-honesty-preflight.ts --project-ref gnkuaywlpmsaezwvlvhk` | `environment_type=clean_mirror`, exit 0. Known false positive on `duplicate_names` for `validate_api_key_rpc_hardening` (`0302_`/`0303_` legitimately share a name) — record as a known exception, do **not** mutate the rig to hide it |
| E9 | Rig health via ID token | `curl -H "Authorization: Bearer $(gcloud auth print-identity-token --audiences=$RIG_URL)" $RIG_URL/health` | `status=healthy`, http=200 ✅ *verified*. The rig 403s unauthenticated probes — a 403 is **not** a health failure |
| E10 | Soak clock defined as worker uptime | `gcloud run services describe … --format='value(status.conditions)'` + `/health` `uptime` | Clock = Cloud Run revision uptime, not a probe loop. Rig uptime is currently **1,561 s** — it restarted recently, so the clock has **not** started |

---

## 4. Flags — the step that decides whether the soak is real

**Blocking (B3).** The rig currently mirrors prod exactly: 24 rows, 17 enabled. Runbook §1.4 step 0.4 requires the
rig to be seeded to the **soak decision state**, whose whole purpose is to differ from prod — the point of the soak is
to learn whether the capabilities we advertise but keep switched off actually work.

### 4.1 Present as a row, but OFF — must be ON for the soak (6)

`ENABLE_SEMANTIC_SEARCH` · `ENABLE_AI_FRAUD` · `ENABLE_FRAUD_DETECTION` · `ENABLE_COMPLIANCE_ENGINE` ·
`ENABLE_EXPIRY_ALERTS` · `ENABLE_ORG_CREDIT_ENFORCEMENT`

Each of these is advertised publicly or asserted to the SOC 2 auditor (runbook §3). Leaving them off means the soak
cannot tell us whether the claim is true.

### 4.2 No row at all — resolve fail-CLOSED via `get_flag`, so silently dark (14)

`ENABLE_RULES_ENGINE` · `ENABLE_RULE_ACTION_DISPATCHER` · `ENABLE_QUEUE_REMINDERS` · `ENABLE_DOCUSIGN_OAUTH` ·
`ENABLE_DOCUSIGN_WEBHOOK` · `ENABLE_DRIVE_OAUTH` · `ENABLE_DRIVE_WEBHOOK` · `ENABLE_DRIVE_CHANGES_RUNNER` ·
`ENABLE_CONNECTOR_ARTIFACT_ENQUEUE` · `ENABLE_CONNECTOR_ARTIFACT_DRAIN` · `ENABLE_WEBHOOK_HMAC` ·
`ENABLE_TREASURY_ALERTS` · `ENABLE_PARTNER_PROVISIONING` · `ENABLE_ADES_SIGNATURES`

**This is where the two failure modes collide, and it is the single most instructive finding in this document.**
Three of these — `rules-engine`, `rule-action-dispatcher`, `drain-connector-artifacts` — **already have Cloud
Scheduler jobs bound and firing on the rig**. They will return **HTTP 200 while doing nothing at all**, because the
flag they gate on has no row and `get_flag` fails closed. Scheduler reports success. The job appears healthy. Zero
work occurs. That is exactly the "a job that 200s while doing nothing" trap, and it is live on the rig **today**.

> `ENABLE_ADES_SIGNATURES` is the opposite hazard: with no row it resolves via `flagRegistry` **env fallback**, which
> is **fail-OPEN**. Its runtime value must be measured, never assumed. The runbook (§1.2) already corrects the prior
> belief that it was fail-closed.

### 4.3 Must stay OFF

| Flag | Rig state | Why |
|---|---|---|
| `USE_MOCKS` | `false` ✅ | Most damaging of all — every anchor would be fabricated |
| `MAINTENANCE_MODE` | `false` ✅ | Otherwise the soak tests a maintenance page |
| `ENABLE_NESSIE_RAG_RECOMMENDATIONS` | no row ✅ | Founder directive, 2026-08-01 |
| `DEMO_INJECTOR`, `SYNTHETIC_DATA` | no row ✅ | Would fabricate soak data |
| `ENABLE_AI_FALLBACK`, `ENABLE_VERTEX_AI` | no row ✅ | Not the primary path |
| Replicate / QA-only AI providers | blocked | Hard-blocked in prod; keep blocked |
| Stripe **live**-mode capture | — | Test mode only (§6) |

### 4.4 Verification — resolve through the runtime, never by reading the table

A `select` on `switchboard_flags` is **not** a resolution: it cannot show env fallback and it cannot show fail-closed
behaviour on a missing row. Both paths must be exercised.

```sql
-- DB path, exactly as the SQL runtime resolves it (proves fail-closed on a missing row)
select f.k as flag, public.get_flag(f.k, false) as effective
from (values ('ENABLE_SEMANTIC_SEARCH'),('ENABLE_RULES_ENGINE'),('ENABLE_ADES_SIGNATURES'),
             ('ENABLE_DOCUSIGN_OAUTH'),('ENABLE_WEBHOOK_HMAC'),('ENABLE_PARTNER_PROVISIONING')) as f(k);
```

```bash
# Registry path — exercise the gated endpoint and observe BEHAVIOUR, not the flag value
curl -sS -H "Authorization: Bearer $RIG_TOKEN" "$RIG_URL/jobs/rules-engine" -X POST \
  -o docs/staging/evidence/gate0/rules-engine-probe.json -w '\nhttp=%{http_code}\n'
# then assert the observable side effect, NOT the 200:
#   select count(*) from rule_executions where created_at > now() - interval '5 minutes';
```

| Check | PASS criterion |
|---|---|
| F1 | `flag-decision-matrix.csv` complete for all ~63 flags, every OFF carrying a written rationale |
| F2 | The 6 flags in §4.1 read `true` **via `get_flag`** |
| F3 | The 14 flags in §4.2 have rows and read `true` **via `get_flag`** |
| F4 | §4.3 flags confirmed OFF on the **running revision**, not in a manifest |
| F5 | For each of `rules-engine`, `rule-action-dispatcher`, `drain-connector-artifacts`: a forced run produces a **row count delta**, not a 200 |
| F6 | The known blind spots (§8.3) are declared **untested** in writing, not silently skipped |

> `scripts/audit_feature_flags.py` may be used for cross-reference **only**. Confirm whether it resolves through the
> runtime or reads a manifest; if it reads a manifest it is a cross-check, never the evidence. Likewise
> `scripts/ci/check-config-drift.ts` compares against **committed snapshots** and does not read running prod — per
> CLAUDE.md §1.13 it must not be cited as Gate 0 evidence.

---

## 5. Cron and Bitcoin — the founder's explicit ask

> *"Make sure all cron jobs are tested and btc is being soaked."*

### 5.1 The binding gap: 24 of 105

**105 cron routes exist in code. 24 are bound on the rig. That is 23% coverage.** In prod, 59 are bound against the
same 105 — so 46 routes have never had a scheduled execution anywhere, in any environment.

```bash
# C1 — derive the code-side route list (evidence, not memory)
grep -oE "(router|cronRouter)\.(get|post)\(\s*['\"\`]/[a-zA-Z0-9_-]+" \
  services/worker/src/routes/cron.ts | sed -E "s/.*['\"\`]\///" | sort -u \
  > docs/staging/evidence/cron-routes-in-code.txt      # currently: 105

# C2 — what Scheduler actually binds on the rig
gcloud scheduler jobs list --project=arkova1 --location=us-central1 \
  --format='value(httpTarget.uri)' | grep fullsoak | sed 's|.*/jobs/||' | sort -u \
  > docs/staging/evidence/cron-routes-bound.txt         # currently: 24

diff docs/staging/evidence/cron-routes-in-code.txt docs/staging/evidence/cron-routes-bound.txt
```

### 5.2 Good news — every Bitcoin safety loop is bound on the rig

All five loops that have **no Cloud Scheduler job in production** are bound and ENABLED on the rig, plus the proof
job. Verified 2026-08-11:

`detect-reorgs` ✅ · `monitor-stuck-txs` ✅ · `rebroadcast-txs` ✅ · `consolidate-utxos` ✅ · `monitor-fees` ✅ ·
`populate-confirmation-proofs` ✅

The soak will therefore produce the **first operating-effectiveness evidence these controls have ever had**. That is
a genuine and significant win, and it is worth stating plainly to the auditor — with the equally plain caveat that
**proving them on the rig does not schedule them in prod**. Prod scheduling is follow-on work; until it lands, the
control remains dormant where it counts.

### 5.3 Binding is not execution — the three-part assertion

**A Scheduler job pointed at a route the revision does not serve returns 404 silently, forever — no log, no Sentry,
and Scheduler still reports the job as succeeded.** So each job needs three separate assertions:

```bash
# For every bound job:
gcloud scheduler jobs run "$JOB" --project=arkova1 --location=us-central1
# 1. bound?          — appears in cron-routes-bound.txt
# 2. returns 2xx?    — and specifically NOT 404
# 3. did work?       — an observable state change: row written, counter moved, last_run_at advanced
```

| # | Check | PASS criterion |
|---|---|---|
| C1 | Route inventory captured | 105 routes enumerated from code |
| C2 | Coverage decision recorded | Either all 105 bound, **or** a written, founder-visible list of which are deliberately out of scope and why. Silence is not acceptable |
| C3 | No job returns 404 | Zero 404s across all bound jobs |
| C4 | **Every job asserts an observable side effect** | A named DB delta per job — never a 200 |
| C5 | 5 BTC safety loops forced daily | 7/7 days, non-404, observable effect each time |
| C6 | Prod's 6 failing jobs proven on the rig | `org-queue-scheduler`, `drain-connector-artifacts`, `refresh-stats`, `connector-health-check`, `fetch-acra-sg`, `openalex-bulk` all succeed on the rig — **and the divergence from prod is explained, not ignored** |

C6 matters: `org-queue-scheduler` failing with code 13 in prod matches the known open finding F-1 (org-queue 5xx). If
it passes on the rig, the rig is not reproducing a live production defect, and that is a limitation of the soak to
record — not a pass.

### 5.4 Bitcoin — what "btc is being soaked" must mean

| # | Check | PASS criterion |
|---|---|---|
| BTC1 | Network is signet | `BITCOIN_NETWORK=signet` on the running revision ✅ *verified* |
| BTC2 | Mocks off | `USE_MOCKS=false` ✅ *verified* — otherwise the chain client is faked and everything "confirms" instantly |
| BTC3 | `MEMPOOL_API_URL` unset | ✅ *verified* — if set, inconsistent `/api` suffix handling silently kills confirmation detection and anchors sit SUBMITTED forever with no error |
| BTC4 | Signet treasuries funded | Both funded (68,744 and 749,062 sats). Balance check must **not** be trusted from the app: `treasury-cache.ts:45` hardcodes the mainnet explorer, so any non-mainnet deploy reads **balance 0** and fires a false treasury alert every run. Verify against a signet explorer directly and expect that false alert |
| BTC5 | Real broadcast proven | A soak-window anchor confirmed on an **independent signet explorer** — DB status is not the witness |
| BTC6 | Full lifecycle asserted per stage | signed → tx hex present; broadcast → txid from GetBlock; confirmed → `status='SECURED'` **and** confirmations ≥ 1; proof → `anchor_proofs` row whose `block_header` is **80 raw bytes** (`bytea`, `\x` hex) |
| BTC7 | Day-1 cohort verifies offline at Day 7 | 100% of the cohort verifiable **from its proof bundle alone**, with no call to our API |
| BTC8 | SECURED count rises daily | Monotonic increase, **excluding the B2 frozen baseline** |
| BTC9 | Mainnet untouched | Zero mainnet broadcasts from the rig for the whole window. The mainnet re-anchor backfill (PR #2140, ~149 txs / ~69,881 sats) is **separate work and must not run during the soak window** |

---

## 6. API keys, scopes, and provisioning

> *"provisioning arkova api keys etc."*

Three scoped keys exist in Secret Manager (`arkova-fullsoak-2026-08-apikey-*`) and 3 rows exist in the rig's
`api_keys`, all on `Acme Corp`. Prod holds **18 active keys across 10 orgs**.

| # | Check | Command / query | PASS criterion |
|---|---|---|---|
| K1 | Keys exist and are scoped | `gcloud secrets list --project=arkova1 --filter='name:arkova-fullsoak-2026-08-apikey'` | 3 secrets present ✅ |
| K2 | Raw keys never persisted | `select key_prefix, left(key_hash,8) from api_keys` | Only HMAC-SHA256 hashes stored; no raw key column populated |
| K3 | Unauthenticated rejected | `curl -s -o /dev/null -w '%{http_code}' $RIG_URL/api/v1/anchors` | **401** ✅ *verified* |
| K4 | Wrong scope rejected | `curl -H "X-API-Key: $READONLY_KEY" -X POST $RIG_URL/api/v1/anchors` | **403** ✅ *verified* |
| K5 | Correct scope succeeds | `curl -H "X-API-Key: $WRITE_KEY" -X POST $RIG_URL/api/v1/anchors -d @fixture.json` | **201** ✅ *verified* |
| K6 | **Revoked key refused — daily** | revoke a key, then call with it | **401/403 every day for 7 days.** Revocation tested once is a point-in-time control; CC6.8 needs it over the period |
| K7 | Rate-limit tiers enforced | drive past the tier ceiling | 429 **with `Retry-After`** and limit headers on every response (CLAUDE.md §1.10) |
| K8 | **Key designation register** | runbook §11 SQL | `docs/staging/evidence/CC6.8/api-key-designation.csv` — owner, purpose, least-privilege justification, expiry, rotation plan per key. **Never include `key_hash`.** Any key with no expiry, no identified owner, or no recent use is a **finding**, not a blank cell |
| K9 | **Both orgs provisioned and authenticatable** | `select o.display_name, count(m.user_id), count(u.last_sign_in_at) from organizations o left join org_members m on m.org_id=o.id left join auth.users u on u.id=m.user_id group by 1` | Both orgs have ≥1 member who has **actually signed in** ✅ *verified: Acme Corp 1/1, Arkova 1/2* |
| K10 | Org B holds its own key | `select org_id, count(*) from api_keys group by 1` | ⚠️ **Currently all 3 keys belong to Acme Corp; `Arkova` has none.** Provision at least one key for the second org — cross-tenant API isolation cannot be tested from a single org's credentials |

**K10 is an open gap.** Cross-tenant isolation at the API layer (as distinct from the UI layer) requires Org B to
hold a real key and be observed failing to reach Org A's data. With keys on one org only, that assertion cannot be
made at all.

---

## 7. Evidence integrity

### 7.1 The gate must be live — see B4

### 7.2 Change freeze — see B5

### 7.3 Alert baseline — see B6

### 7.4 Artifact rules

Derived from a real error during runbook preparation: a stale `curl -o` output file made two dead services read as
`healthy`. `curl` does not truncate its output file on failure.

| # | Rule | PASS criterion |
|---|---|---|
| V1 | Fresh output file per probe | No path reused across iterations |
| V2 | Transport status recorded separately from body | `http=000` is not a pass; a body with no status code is not evidence |
| V3 | Timestamped at capture | `date -u +%FT%TZ` from the capturing host, stored with the artifact |
| V4 | Append-only layout | `docs/staging/evidence/<surface>/<UTC-date>/` |
| V5 | Provenance on every artifact | Rig ref `gnkuaywlpmsaezwvlvhk`, Cloud Run service + revision, image digest, PR head SHA. Per CLAUDE.md §1.11A evidence may **not** be copied across heads, services, or projects |
| V6 | Daily hash manifest | `sha256sum` every artifact into `manifest-DAY-N.txt`, committed daily. This is what converts a pile of files into tamper-evident period evidence |
| V7 | **Sampled over the period, not at a point** | Every "continuous" control has ≥ 1 artifact per day for 7 days. A single run cannot evidence a Type 2 control |

---

## 8. Coverage — stated as a number

### 8.1 The denominator is 596, not 439

The feature inventory enumerated **439 features (294 LIVE)**. It also enumerated its own blind spot: a
`MISSED_BY_INVENTORY` list of **157 further items, 106 of them LIVE** — including surfaces large enough to change the
plan:

- **258 anon-executable Postgres functions** callable at `POST /rest/v1/rpc/<fn>`
- **76 database triggers** enforcing integrity, immutability and privilege controls
- **pg_cron jobs running in prod that no repo migration creates**
- **Supabase Storage buckets + storage RLS policies that exist only in prod**
- **The entire `services/edge` Cloudflare Worker** — 6 route families on `edge.arkova.ai`, a separate deployment target

**Corrected totals: 596 features, of which 400 are LIVE.**

### 8.2 Planned coverage: 278 of 400 LIVE features — 69.5%

| Class | Count | Status |
|---|---|---|
| LIVE features in the original inventory | 294 | Covered by runbook §4 surface groups S1–S23 |
| — blocked by rig-dark flags (§4) | **−13** | Connectors ×9, webhooks ×1, anchoring ×1, billing-adjacent ×1, compliance ×1 |
| — blocked by unbound cron routes (§5) | **−3** | `reconcile-credit-conservation`, `monthly-allocation-rollover`, `credit-expiry` |
| **Exercisable under the current plan** | **278** | |
| **LIVE features with no test plan at all** | **+106** | The `MISSED_BY_INVENTORY` surfaces above |
| **Denominator (true LIVE)** | **400** | |
| **Coverage** | **278 / 400 = 69.5%** | |

**Against the founder's bar — "EVERY piece of code we've built since inception" — the soak as currently planned
covers 69.5% of live functionality.** The 16 blocked features are recoverable inside Day 0 (§4, §5). The 106 with no
plan are not: they need scope decisions before the clock starts.

The single largest omission is the **edge Cloudflare Worker** — a separate deployment target that the rig does not
include at all. `edge.arkova.ai` is where the MCP surface actually lives. Runbook §3.1 already establishes that the
edge MCP `search_credentials` tool is **ungated and falls back to a literal `ILIKE %query%`** while six surfaces
advertise semantic similarity. That defect lives on the surface the soak currently does not touch.

### 8.3 Declared untested — write it down, do not skip it silently

These cannot be soaked as things stand. Each must appear in the Day-7 report as **untested**, with the reason:

| Capability | Why it cannot be soaked |
|---|---|
| `SEMANTIC_SEARCH` | `credential_embeddings` has **0 rows**. This needs a backfill, not a flag flip. Turning the flag on does not make the advertised claim true |
| `AI_FRAUD` | `computeIntegrityScore` has **no caller** |
| `FRAUD_DETECTION` | Results are filtered out of all 6 display surfaces |
| `VISUAL_FRAUD_DETECTION` | Returns **410 unconditionally** |
| `ADES_SIGNATURES` | Defaults to `aws_kms`; **no AWS account exists** (`memory/feedback_no_aws.md`) |
| `PARTNER_PROVISIONING` | No row, fail-closed — **this is the HakiChain onboarding path** |
| `COMPLIANCE_ENGINE` | Gates nothing |

Four of these are **advertised publicly or asserted to the SOC 2 auditor**. Per runbook §3.5, no claim may end the
soak in the state "not demonstrated and not retracted" — the outcome is either a demonstration or a retraction.

---

## 9. Rollback triggers — thresholds decided in advance

Fixed now so that the decision to abort is not made under pressure by whoever happens to be awake.

| # | Trigger | Threshold | Action |
|---|---|---|---|
| R1 | Rig worker unhealthy | `/health` ≠ `healthy` for **> 30 min** continuous | Pause clock, diagnose. > 2 h ⇒ restart the day |
| R2 | Worker revision restarts | Any restart | Clock = uptime, so it **resets**. > 1 restart in 24 h ⇒ restart the day |
| R3 | Anchors stuck | Any anchor SUBMITTED **> 6 h** without confirmation | Check `MEMPOOL_API_URL` (BTC3) and treasury balance immediately |
| R4 | SECURED count flat | No increase in **24 h** (excluding frozen baseline) | Anchoring pipeline is dead — abort and diagnose |
| R5 | Cross-tenant leak | **Any**, ever | **Immediate hard stop.** Automatic NO-GO |
| R6 | Credit charged, none delivered | **Any** | **Immediate hard stop.** Automatic NO-GO |
| R7 | Prod deploy during freeze | Any runtime/migration commit reaching prod | Re-pin all evidence to the new head, or restart the soak |
| R8 | Alert volume | **> 10 false positives** over the 7 days | Monitoring is not audit-ready; G6 fails |
| R9 | Ledger drift | Rig head ≠ prod head at any daily check | Investigate before continuing; evidence pinned to a divergent schema is void |
| R10 | Preflight regression | `staging-honesty-preflight.ts` ≠ `clean_mirror` at any daily run | Evidence from that point is invalid |
| R11 | Evidence gate flipped | `SOAK_GATE_DISABLED` becomes `true` mid-period | Period is void from the flip |
| R12 | Search latency | p95 **> 2 s** sustained over 24 h | Availability finding; G12 fails (today it is 6.5 s) |

---

## 10. Pre-mortem

*It is Day 7. The soak completed. We declared success and shipped. A customer hit a visible failure. What happened?*

The runbook's §8 pre-mortem (P1–P15) remains valid and is not repeated here. What follows are the causes that
**today's evidence makes concrete** — each one is a thing already true on 2026-08-11, not a hypothetical.

### PM1 — We soaked a healthy rig while prod's actual fault was never reproduced ⚠️ *highest probability*

**The evidence:** the rig is `healthy` and prod is `degraded` **on the identical image** (`git_sha 2de4e4e34`). The
fault is environmental to prod — PostgREST schema cache, connection state, its own infrastructure. The soak runs
against a different database, a different PostgREST, a different network. **It is structurally incapable of
encountering B1.**

The failure story is short: B1 gets fixed, prod goes green, the soak runs 7 clean days, we ship — and the same
schema-cache fault recurs in prod under production load the soak never applied. Every customer-facing verification
returns 503, exactly as it does right now.

- **Control:** B1.d — 24 h continuous stability on **prod** before Day 0, sampled ≤ 15 min. Plus a written residual-risk
  note at Day 7 stating plainly that prod-environmental faults are outside this soak's reach.
- **Detection mid-soak:** monitor **prod** `/health` throughout the soak window, not only the rig. Any prod
  degradation during the 7 days is a material finding about production even though the soak is green.

### PM2 — A job returned 200 for seven days and did nothing ⚠️ *already true today*

**The evidence:** `rules-engine`, `rule-action-dispatcher` and `drain-connector-artifacts` have Scheduler jobs bound
and ENABLED on the rig **right now**, while the flags gating them have **no `switchboard_flags` row** and therefore
resolve fail-closed through `get_flag`. They will return 200. Scheduler will report success. Nothing will happen.

This is not a risk to guard against. It is the current configuration, and without §4 it ships as a green result.

- **Control:** F3 (seed the 14 missing rows) + F5 and C4 (**every** job asserts a row-count delta, never a status code).
- **Detection mid-soak:** daily per-job side-effect query. A job whose delta is zero two days running is failing,
  regardless of its HTTP status.

### PM3 — "N anchors SECURED" included 8 fabricated ones ⚠️ *already true today*

**The evidence:** 8 SECURED anchors on the rig carry non-hex, made-up txids (`arkova_org_tx_001` among them). Any
aggregate query over `anchors` inherits them silently.

- **Control:** B2 — freeze and exclude the baseline, assert `chain_tx_id ~ '^[0-9a-f]{64}$'`, and confirm every
  claimed anchor on an **independent signet explorer**.
- **Detection mid-soak:** run the regex assertion daily. Any SECURED anchor inside the soak window failing it is a
  hard stop, because it means the fixture path is still writing.

### PM4 — The real failure was alert #25,001

**The evidence:** ~25,000 false cron-failure events in 13 days across 4 duplicate monitors, plus a dead-tuple alert
every 2 minutes on a 16-row table.

- **Control:** B6 — delete the duplicates, fix the dead-tuple alert, then establish a **24 h quiet baseline** so that
  any alert during the soak is signal by construction.
- **Detection mid-soak:** daily alert triage with the count recorded. Rising counts mean the baseline did not hold.

### PM5 — Cross-tenant isolation "passed" without Org B ever authenticating

**The evidence:** both rig orgs do have signed-in members (Acme 1/1, Arkova 1/2) — so this is **recoverable**, unlike
the security vendor's package where Org B never authenticated at all. But **all 3 API keys belong to Acme Corp**
(K10), so API-layer isolation cannot currently be tested in either direction.

- **Control:** K10 — provision a key for Org B. §6 of the runbook: **prove positive access first**. An isolation test
  that cannot first show Org B reading its *own* data is void, because an anonymous 401 is indistinguishable from
  correct isolation.
- **Detection mid-soak:** every daily cross-tenant run asserts Org B's positive read immediately before the negative
  assertion. The vendor's package must never be cited as evidence here.

### PM6 — We shipped a feature we advertise and never tested

**The evidence:** §8.3 — seven capabilities cannot be soaked at all, four of them advertised publicly or to the SOC 2
auditor. `SEMANTIC_SEARCH` is priced at `$0.010` on the public `/developers` route while `credential_embeddings` has
**0 rows** and the edge MCP tool falls back to `ILIKE %query%`.

- **Control:** the runbook §3 claims register — no claim ends in "not demonstrated and not retracted."
- **Detection mid-soak:** the register is reviewed daily, not assembled on Day 7.

### PM7 — The inventory's blind spot was the product

**The evidence:** the inventory missed **157 items, 106 of them LIVE** — 258 anon-executable RPC functions, 76 DB
triggers, prod-only Storage buckets and RLS, pg_cron jobs no migration creates, and **the entire edge Worker**.
Coverage is **69.5%**, not the 100% a green Day-7 report would imply.

The failure story: we report "all features soaked", a customer calls an anon-executable RPC we never tested, or hits
`edge.arkova.ai`, and it breaks. The report was true about its denominator and its denominator was wrong.

- **Control:** §8 states coverage as an explicit fraction with the excluded items named. Day 0 makes a scope decision
  on the 106 — in or out, in writing.
- **Detection mid-soak:** none available. This one is only preventable at Day 0, which is why it is here.

### PM8 — A mid-soak merge invalidated the evidence

**The evidence:** `DEPLOY_WORKER_PAUSED=false` with **20 open PRs** and Mergify auto-merging on green.

- **Control:** B5 — freeze, or per-merge RTE sign-off with evidence re-pinning.
- **Detection mid-soak:** daily `gcloud run revisions list` on prod. A new revision inside the window means R7 fires.

### PM9 — Evidence looked valid and was stale

**The evidence:** this already happened once during runbook preparation — a leftover `curl -o` file made two dead
services read as `healthy`, because `curl` does not truncate on failure.

- **Control:** V1–V6, particularly the fresh file per probe and the daily hash manifest.
- **Detection mid-soak:** the manifests. A file whose hash does not change across days it should have changed on is
  a stale artifact.

### PM10 — The proof gap reached a customer

**The evidence:** 2,967,774 SECURED anchors (85.4%) have no per-document proof. Anchoring is genuinely healthy; the
gap is in **proof materialisation**. A customer — including our flagship partner — asking for an offline proof
bundle for a historical record gets an error.

- **Control:** G8 — a **recorded founder decision**: backfill before launch, or publish the limitation plainly. The
  soak cannot close this; it can only prove the path works for *new* records (BTC7).
- **Detection mid-soak:** none needed. This is a known, quantified gap awaiting a decision, not a discovery.

---

## 11. GO / NO-GO

### 11.1 Day-0 gate — decides whether the clock starts

**All must be PASS. Any single FAIL is NO-GO.**

| # | Criterion | Threshold | Today |
|---|---|---|---|
| D1 | Prod healthy | `/health` = `healthy`, **24 h continuous**, zero `PGRST002` | ❌ **FAIL** — degraded, 503 |
| D2 | Prod verification API serving | `GET /api/v1/verify/{id}` → 200 | ❌ **FAIL** — 503 |
| D3 | Anchor baseline frozen | `anchor-baseline-frozen.csv` committed; fabricated rows deleted or excluded by id | ❌ **FAIL** |
| D4 | Flag matrix applied | 20 soak-critical flags ON **via `get_flag`**; §4.3 confirmed OFF | ❌ **FAIL** — 18 of 20 dark |
| D5 | Evidence gate live | `SOAK_GATE_DISABLED=false` | ❌ **FAIL** — `true` |
| D6 | Change freeze | `DEPLOY_WORKER_PAUSED=true` or signed per-merge protocol | ❌ **FAIL** — `false`, 20 PRs open |
| D7 | Alert baseline quiet | **< 5 alerts / 24 h** | ❌ **FAIL** — ~1,900/day |
| D8 | Ledger parity | Rig = prod = 0405 | ✅ **PASS** |
| D9 | Rig env correct | signet, `USE_MOCKS=false`, `MEMPOOL_API_URL` unset | ✅ **PASS** |
| D10 | Preflight | `environment_type=clean_mirror`, exit 0 | ⚠️ **RE-RUN** after D3 |
| D11 | Cron scope decided | All 105 bound, or the exclusions written down and visible to the founder | ❌ **FAIL** — 24 bound, no written decision |
| D12 | Org B provisioned | Second org holds ≥1 API key; both orgs authenticate | ❌ **FAIL** — all 3 keys on Acme Corp |
| D13 | Coverage scope decided | The 106 unplanned LIVE features ruled in or out in writing | ❌ **FAIL** |
| D14 | Zombie services absent | Only the 4 expected services | ✅ **PASS** |

**Score: 3 PASS / 10 FAIL / 1 RE-RUN → NO-GO.**

### 11.2 Day-7 exit gate — decides whether we launch

The runbook's §10 G1–G12 stand unchanged and remain blocking. Three additions arising from this checklist:

| # | Criterion | GO threshold |
|---|---|---|
| **G13** | Coverage stated honestly | Final report states coverage as a fraction of **400 LIVE features** with every excluded item named. A report implying 100% is an automatic NO-GO |
| **G14** | Every cron job proved an effect | 100% of bound jobs show an observable state change. A job that only ever returned 200 counts as **untested**, not passed |
| **G15** | Prod-environment residual risk recorded | Written statement that the rig did not reproduce prod's B1 fault class, and what that leaves uncovered |

**Automatic NO-GO regardless of everything else** (runbook §10, restated because these are the ones that get argued
about at 2 a.m.):

- Any cross-tenant leak.
- Any anchor SECURED without a materialisable proof in the Day-1 cohort.
- Any credit charged without credits delivered.
- Any claim still asserted publicly or to the auditor while demonstrably false.

---

## 12. Day-0 execution order

Ordered by dependency. Steps 2–5 are independent of step 1 and of each other, and should run in parallel.

| # | Step | Owner | Blocks |
|---|---|---|---|
| 1 | B1 fix lands → **24 h prod stability window** | Assigned engineer | D1, D2 |
| 2 | Delete/freeze the 8 fabricated anchors; commit the baseline | RTE | D3 |
| 3 | Seed 14 missing flag rows; flip 6 to ON; verify via `get_flag` | RTE | D4 |
| 4 | `SOAK_GATE_DISABLED=false` | RTE | D5 |
| 5 | Delete 3 duplicate monitors; fix dead-tuple alert → **24 h quiet window** | RTE | D7 |
| 6 | Founder: approve `DEPLOY_WORKER_PAUSED=true`; triage 20 open PRs | Founder | D6 |
| 7 | Founder/RTE: cron scope — bind all 105, or write the exclusions down | Founder + RTE | D11 |
| 8 | Founder/RTE: scope decision on the 106 unplanned LIVE features | Founder + RTE | D13 |
| 9 | Provision an API key for Org B | RTE | D12 |
| 10 | Re-run preflight → `clean_mirror` | RTE | D10 |
| 11 | Re-run the §11.1 gate; all 14 PASS | RTE | Clock start |

Steps 6, 7 and 8 are **founder decisions**, not engineering tasks, and they are the ones most likely to slip. They
should be put in front of him first, not last.

---

_Prepared 2026-08-11 by the RTE. Every reading in §1.1 was queried live between 16:40 and 17:00 UTC against
production (`vzwyaatejekddvltxyye`), the rig (`gnkuaywlpmsaezwvlvhk`), GCP project `arkova1`, or GitHub — none
carried from a prior document. Items that could not be verified are marked as gaps or as decisions, never asserted._

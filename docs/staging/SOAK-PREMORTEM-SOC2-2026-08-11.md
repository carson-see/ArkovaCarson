# Soak Pre-Mortem, SOC 2 Type 2 Standard — 7-Day Full-Functionality Soak

> **Verdict as of 2026-08-11 21:25 UTC: NO-GO.** Seven blockers open (five agent-owned, two founder-owned).
> **Prepared:** 2026-08-11. **Owner:** RTE. **Not committed, not pushed.**
>
> **Companion documents.** [`FULL-SOAK-2026-08-RUNBOOK.md`](./FULL-SOAK-2026-08-RUNBOOK.md) defines *how the seven days
> are run*. [`PRE-SOAK-CHECKLIST-AND-PREMORTEM.md`](./PRE-SOAK-CHECKLIST-AND-PREMORTEM.md) was the 17:00 UTC Day-0
> gate. **This document supersedes both where they disagree**, and §9 lists every correction explicitly rather than
> silently overwriting. Four of that checklist's six blockers are now closed or void. Four new ones have opened,
> and two of the new ones are worse than anything it listed.
>
> **Every reading in this document was queried live between 21:19 and 21:25 UTC on 2026-08-11** against production
> (`vzwyaatejekddvltxyye`), the rig (`gnkuaywlpmsaezwvlvhk`), GCP project `arkova1`, GitHub, and two independent
> Bitcoin signet explorers. Bounded queries only (`SET statement_timeout='8s'`). Nothing is carried from a prior
> document. Where something could not be verified it is marked as a gap or a decision, never asserted.

---

## 0. Layman's summary

**Are we ready? No. Not today, and not tomorrow morning.**

The test rig is in better shape than it was this morning. The fake anchor records are gone, the database schema now
matches production exactly, the second test company has its own API key, alarms exist and have been proven to ring,
and production itself is healthy again. That is real progress and it should be said plainly.

But five things are still wrong, and two of them are the kind that produce a confident green report about software
that does not work:

1. **The test rig is running last week's software.** Production has moved 140 commits ahead of it, including several
   launch-blocker fixes. Seven days of evidence gathered on the rig would describe a version of Arkova that was never
   in production and never will be.
2. **The Bitcoin half of the product has never once completed on this rig.** One real transaction was broadcast to the
   signet test network at 17:22 today. Nearly five hours and twenty-one blocks later it is still sitting unconfirmed.
   Zero documents have ever reached "secured" status on this rig. If we started the clock today, day seven would show
   a big fat zero on the one thing the company actually sells.
3. **Twenty of the features we most want to test are switched off**, exactly as they were this morning. Nothing has
   been done about it yet.
4. **Nothing watches the rig.** The alarms we built today all watch production. The soak clock is literally "how long
   has the rig been running", so if the rig restarts at three in the morning on day four, nobody finds out and the
   week is void.
5. **Production is still deploying while we test.** A new production version went out seventeen minutes before I
   started writing this.

**How long to fix?** About one working day of engineering, roughly eight to twelve hours, plus two decisions only you
can make (thirty minutes of your time, if you make them today). The one genuinely uncertain item is getting a Bitcoin
test transaction to actually confirm, because that depends partly on a network we do not control.

**The thing you most need to know, and neither previous document says it:** even in the best case the clock starts on
12 August, which means day seven closes on **19 August**. The customer launch is **around 17 August**. **A full
seven-day soak cannot finish before the launch.** That is arithmetic, not engineering, and no amount of overtime
changes it. You have three honest options and they are laid out in §2.3. Picking one is the single highest-value
thing you can do today.

---

## 1. Verdict

### 1.1 NO-GO

| Blocker | Owner | Effort | One-line reason |
|---|---|---|---|
| **BL-1** Rig runs a 140-commit-stale build | agent + founder | ~1 h (+ freeze) | Evidence would certify software that was never in prod |
| **BL-2** Bitcoin confirmation has never succeeded on this rig | agent | 1–4 h (chain-dependent) | Day 7 would report zero SECURED anchors |
| **BL-3** Gate 0 flag reconciliation not started | agent | ~4 h | 20 of 20 soak-critical flags resolve `false` right now |
| **BL-4** `SOAK_GATE_DISABLED=true` | agent | 2 min | No evidence produced during the period is citable |
| **BL-5** Zero monitoring on the rig | agent | ~1 h | A silent rig restart voids the period and pages nobody |
| **BL-6** No change freeze | **founder** | 5 min | Prod deployed a new revision 17 min before this probe |
| **BL-7** Coverage scope undecided | **founder** + agent | ~3 h + decision | §4 of the runbook is still a placeholder; ~106 LIVE features have no plan |

**Five agent-owned, two founder-owned.** The two founder-owned ones are not the slowest to execute; they are the
most likely to slip, because they need a person rather than a command. Put them in front of Carson first.

### 1.2 Shortest honest path to GO

```
T+0h    BL-6 + BL-7 go to the founder  (30 min of his time; everything else can start in parallel)
T+0h    BL-3 flag seeding + behavioural probes        ─┐
T+0h    BL-5 rig monitoring + fire-test each alarm    ─┼─  parallel, agent-owned
T+0h    BL-2 fee-path fix + rebroadcast               ─┘
T+2h    BL-1 rebuild rig on prod's exact digest, redeploy
T+3h    Re-verify boot-time state on the NEW revision (chain client, fee estimator, flag registry snapshot)
T+3h→   BL-2 close-out: one anchor SECURED end-to-end ON THAT REVISION, confirmed on two explorers
        ^^^ irreducible chain latency lives here; budget 1–4 h, it is the only genuinely uncertain item
T+8h    Day-0 gate re-run, all criteria PASS
T+8h    BL-4 flip SOAK_GATE_DISABLED=false  (LAST, see §6.3)
T+8h    Clock starts
```

**Realistic: 8 to 12 hours of agent work, gated on two founder decisions and one empirical unknown.**

What gates it, in order of likelihood to slip:

1. **The founder decisions (BL-6, BL-7).** Thirty minutes of attention. If they slip a day, everything slips a day.
2. **Getting a signet transaction to confirm (BL-2).** This is the only item where effort does not guarantee an
   outcome on a schedule. It is also the one that must be proven *before* the clock starts, because a soak that
   cannot produce a SECURED anchor is not a soak of this product.
3. Everything else is deterministic command execution.

### 1.3 What is NOT blocking, and why that matters

Four items were blocking this morning and are now closed or void. They should not be re-litigated:

- **Production is healthy.** `/health` returns HTTP 200 `healthy`, `git_sha 1d12f0d39`, database/anchoring/kms all
  `ok`, mainnet. The checklist's B1 (prod degraded, 503, `PGRST002`) is **closed**, and with it the 24-hour prod
  stability window it demanded.
- **The alert-fatigue blocker was based on a wrong premise.** The checklist's B6 asserted "~25,000 false alerts in
  13 days across 4 duplicate cron monitors plus a 2-minute dead-tuple alert". Live: `arkova1` holds **exactly four
  alert policies, all enabled, all created today**, all `PAGE —` prefixed, plus one uptime check and two notification
  channels. There is no duplicate cron monitor and no dead-tuple alert. There is therefore **no alert storm and no
  24-hour quiet baseline to wait for**. B6 is **void**, and the 24-hour window it implied is removed from the critical
  path. (The real monitoring gap is the opposite problem: see BL-5.)
- **The fabricated anchor baseline is gone.** Rig `anchors` holds 5 rows: 4 PENDING, 1 SUBMITTED, **0 SECURED**. The
  eight fabricated SECURED rows, including `arkova_org_tx_001`, are deleted. B2 **closed**.
- **Org B holds its own API key.** `Acme Corp` 3 keys / 1 member, `Arkova` 1 key / 2 members. The checklist's K10 and
  D12 are **closed**, so API-layer cross-tenant isolation is now testable in both directions.

Removing the two 24-hour observation windows is what compresses the path from the checklist's "roughly 3 working days"
to roughly one. That compression is real. It is also the only good news in this section.

---

## 2. The three risks that decide this

### 2.1 Risk 1 — The rig is testing software that was never in production

**Measured.** Rig `/health.git_sha` = `2de4e4e344f3749a09c52d7411831b7d2735528c`; rig Cloud Run image digest
`sha256:a5231f21aef77c05b6ce0b9cda306bcacea8a2d2e72f09da5369bbb50612764f`. Prod `/health.git_sha` =
`1d12f0d39f650e634c1a381efe40c2fed5dde39a`; prod image tag `arkova-worker:1d12f0d39…`. `git rev-list --count` between
the two: **140 commits**.

Named commits inside that gap, from `git log 2de4e4e34..1d12f0d39`:

| Commit | What it is |
|---|---|
| `225dbfc04` | `fix(auth): repair recipient account activation (launch blocker) (#2062)` |
| `a3e3d6e26` | `fix(billing): completing a Stripe checkout self-granted KYB verification [T3]` |
| `e3ac0e928` | `fix(worker): treasury-cache queried the MAINNET explorer on every non-mainnet deployment` |
| `b65632054` | `fix(worker,compliance): unblock prod deploys (undici/Node 20) + drop false MFA enforcement claim` |
| `984fd247f` | `fix(worker): resolve CLE submit org from the same principal as user_id` |
| `4a5865825` / `b2817a60f` | supplementary proof anchor (migration 0408) |
| `352e74967` | `feat(observability): first alerting in arkova1 + hot-table DDL lock_timeout guard` |

**A compounding second-order problem.** The rig's migration ledger head is **0409** (111 rows), matching prod. The
rig's *code* predates migrations 0406, 0407, 0408 and 0409. **The rig runs a schema that is ahead of its own binary.**
That configuration exists nowhere else, including production, and any behaviour observed under it is evidence about a
combination we will never ship.

**Why it is a blocker and not a caveat.** CLAUDE.md §1.11A: evidence may not be copied across heads, services, or
projects, and any runtime or migration commit after a soak invalidates exact-head evidence. A seven-day pack pinned to
`2de4e4e34` does not describe the product. Worse, it is *convincingly wrong*: every artifact carries a real head SHA,
a real digest, a real timestamp, and passes every provenance rule in §5.0 of the runbook while describing the wrong
binary.

**And it re-opens by itself.** Prod `/health.uptime` was **1000 seconds** at 21:22 UTC, meaning prod deployed revision
`arkova-worker-01295-xap` at roughly 21:05, seventeen minutes before this probe. `DEPLOY_WORKER_PAUSED=false`. Fixing
BL-1 without BL-6 buys hours.

### 2.2 Risk 2 — Bitcoin confirmation has never once completed on this rig

This is the finding that most deserves the founder's attention, because it is the product.

**Measured, and independently corroborated.**

| Fact | Value | Source |
|---|---|---|
| Rig anchors ever reaching SECURED | **0** | rig SQL |
| Real signet broadcast | txid `81baf563289b377d2612305ac72be811acb60e5420b91dbdcb5b85be962dd2bd` | rig SQL |
| Broadcast at | `updated_at 2026-08-11 17:22:55Z`, tip height 317262 | rig SQL |
| Status at 21:23:53Z | `SUBMITTED`, age **4 h 56 m** | rig SQL |
| mempool.space/signet | `confirmed: false`, `block_height: null`, `fee: 157`, vsize `156.25` | live explorer |
| blockstream.info/signet | `{"confirmed":false}` | live explorer, independent |
| Signet tip at 21:23:39Z | **317283** | live explorer |

Twenty-one blocks elapsed. Two independent explorers agree the transaction is real, relayed, and **unmined**.

**Diagnosis, grounded in the boot log.** The rig's chain client logs at every cold start:

```
2026-08-11T17:54:04Z  network=signet  utxo=Mempool.space REST API  fee=Static
```

`fee=Static` because `services/worker/src/chain/client.ts:245` resolves
`config.forceDynamicFeeEstimation ? 'mempool' : (config.bitcoinFeeStrategy ?? 'static')`, and the rig revision sets
**none** of `FORCE_DYNAMIC_FEE_ESTIMATION`, `BITCOIN_FEE_STRATEGY`, or `BITCOIN_STATIC_FEE_RATE`. Production sets
`BITCOIN_FEE_STRATEGY=mempool`. The observed fee, 157 sat over 156.25 vB, is **1.005 sat/vB**, sitting exactly on the
relay floor.

**Two separate defects, and they must not be conflated:**

1. **The fee path under test is not the fee path in production.** The rig exercises the Static estimator; prod
   exercises the mempool.space estimator, its ceiling, and its fallback. The switch that exists precisely to close
   this gap is unset, and its own code comment says why it exists: *"use mempool.space fee estimator even on
   signet/testnet to validate the full fee path pre-mainnet."*
2. **Confirmation, and therefore proof materialisation, has never executed on this rig at all.** `check-confirmations`
   is bound and fired at 21:21:05Z. `populate-confirmation-proofs` fired at 21:20:08Z. Both ran. Neither had anything
   to promote, because nothing has ever confirmed.

**What that does to the exit gate.** G3 (Day-1 cohort verifiable offline from its proof bundle alone at Day 7), BTC6,
BTC7, BTC8, surface S1 and surface S4 are all downstream of a confirmation that has never happened. Starting the clock
today does not risk a weak result on those criteria; it guarantees a null one.

**A caution about the four PENDING anchors.** Four anchors have sat PENDING for 3 h 28 m. That is **probably correct
behaviour**, not a second stall: the rig's forced flush is `batch-anchors-forced-flush` on `0 */8 * * *`, last fired
16:20Z, and the four rows were created at 17:54Z, so the next flush is 00:20Z. I am recording this as *unexplained but
plausibly by design* rather than asserting either way, because the honest answer is that nobody has yet watched a
flush drain on this rig. **Day 0 must observe one flush end to end before the clock starts.** Note also that the rig's
flush cadence (`0 */8`) is not prod's (`daily-anchor-flush`, `0 3 * * *`), which is a separate divergence recorded in
§4 as DEG-1.

### 2.3 Risk 3 — The schedule does not fit, and no engineering fixes that

Day 0 lands **12 August** in the best case. Seven days of clock closes **19 August**. Customer launch is **~17
August**. Even a heroic Day 0 finishing before midnight tonight closes the soak on 18 August.

**The soak cannot complete before the launch.** Three honest options, and only the founder can pick:

| Option | What it costs | What it preserves |
|---|---|---|
| **A. Move the launch to ~20 August** | Two to three days of calendar | The full seven-day Type 2 period, intact. The only option that yields the evidence originally asked for |
| **B. Launch 17 Aug on a truncated soak (~4 days)** | Type 2 period evidence is 4 days, not 7. Say so in the pack, in those words | Launch date. Still far better than nothing, provided the report never implies seven |
| **C. Launch 17 Aug on the soak-in-progress** | Day 7 criteria (G3 offline proof close-out, G4 7/7 isolation, G5 7/7 safety loops) are unmet at launch | Launch date, at the cost of the two criteria the product is most exposed on |

There is no fourth option where a seven-day period finishes before 17 August. Do not let a plan get written that
implies one. **A report that presents four days of evidence under a seven-day heading is the hollow soak, just at the
calendar layer instead of the code layer.**

---

## 3. Blockers

Each carries an owner, an effort estimate, and a PASS criterion a second person can evaluate without asking me what I
meant. Where a PASS criterion could be satisfied by a false green, the criterion says how that is excluded.

### BL-1 — Rig runs a build 140 commits behind production

- **Owner:** agent (rebuild) plus founder (BL-6, to keep it true)
- **Effort:** ~1 h. Note it resets rig uptime, so it must precede the clock start, not follow it.
- **Evidence:** §2.1.

**PASS criterion.** All four, checked in one pass and recorded as one artifact:

1. Rig `/health.git_sha` string-equals prod `/health.git_sha`.
2. Rig Cloud Run image **digest** equals the digest that prod's tag resolves to (`gcloud artifacts docker tags list`),
   not merely a matching tag string.
3. Rig `max(version)` from `supabase_migrations.schema_migrations` equals prod's.
4. The same three comparisons are re-run and recorded **every soak day**, and any divergence is logged as an
   evidence-invalidating event **on the day it occurs**, not discovered at Day 7.

Criterion 4 is the one that will be skipped. Without it, criterion 1 is a Day-0 snapshot of a moving target.

### BL-2 — Bitcoin confirmation has never succeeded on this rig

- **Owner:** agent
- **Effort:** 1–4 h, partly chain-dependent. The only item on the critical path whose completion is not purely a
  function of effort.
- **Evidence:** §2.2.

**PASS criterion.** One anchor, created **after** the final rig revision is serving, traverses the entire lifecycle
and every stage is evidenced independently of the database that claims it:

1. `anchors.status = 'SECURED'`.
2. Its `chain_tx_id` resolves `confirmed: true` **with a block height** on **two independent signet explorers**
   (mempool.space and blockstream.info). `confirmed: false` is a FAIL regardless of DB status.
3. A matching row exists in `anchor_proofs` whose `block_header` is **80 raw bytes** (`bytea`, `\x` hex), not a text
   encoding of the same.
4. The rig boot log for the serving revision reads `feeEstimator` as the intended estimator, captured from the log,
   not inferred from env.

**Explicitly not acceptable as PASS:** a txid matching `^[0-9a-f]{64}$`. That regex is satisfied by
`MockChainClient` output (`sha256('mock_prepared_tx:' + fingerprint)`), so it certifies nothing. Delete it wherever it
appears as a control. The corollary control is cheap and worth adding: `MockChainClient` seeds `mockBlockHeight = 800000`
while signet's tip is 317,283, so any anchor with `chain_block_height > 400000` on a signet rig is mock output and can
be caught by a single bounded query.

**Recommended fix to try first:** set `FORCE_DYNAMIC_FEE_ESTIMATION=true` on the rig revision. It is one variable, it
is the documented purpose of the flag, and it simultaneously closes DEG-2 by putting the real mempool.space fee
estimator, its ceiling and its fallback under test.

### BL-3 — Gate 0 flag reconciliation has not been started

- **Owner:** agent
- **Effort:** ~4 h including behavioural probes
- **Evidence:** live `get_flag` resolution on the rig at 21:20 UTC. **All twenty** soak-critical flags resolve
  `false`. Six have a row set `false` (`ENABLE_SEMANTIC_SEARCH`, `ENABLE_AI_FRAUD`, `ENABLE_FRAUD_DETECTION`,
  `ENABLE_COMPLIANCE_ENGINE`, `ENABLE_EXPIRY_ALERTS`, `ENABLE_ORG_CREDIT_ENFORCEMENT`). Fourteen have **no row**
  (`ENABLE_RULES_ENGINE`, `ENABLE_RULE_ACTION_DISPATCHER`, `ENABLE_QUEUE_REMINDERS`, `ENABLE_DOCUSIGN_OAUTH`,
  `ENABLE_DOCUSIGN_WEBHOOK`, `ENABLE_DRIVE_OAUTH`, `ENABLE_DRIVE_WEBHOOK`, `ENABLE_DRIVE_CHANGES_RUNNER`,
  `ENABLE_CONNECTOR_ARTIFACT_ENQUEUE`, `ENABLE_CONNECTOR_ARTIFACT_DRAIN`, `ENABLE_WEBHOOK_HMAC`,
  `ENABLE_TREASURY_ALERTS`, `ENABLE_PARTNER_PROVISIONING`, `ENABLE_ADES_SIGNATURES`). The rig is still an exact prod
  mirror: 24 rows, 17 enabled.

**The trap inside the fix.** Seeding rows is not sufficient, and in several cases changes nothing at all. There are
**four** resolution paths, not the two the runbook describes:

| Path | Behaviour | Does seeding a row help? |
|---|---|---|
| `config.X` env-direct | reads the Cloud Run env only | **No.** ~27 flags are env-only |
| `flagRegistry.getFlag()` | boot-time snapshot, **no TTL**, populated once at `init()` | Only if the worker restarts after seeding |
| live `db.rpc('get_flag')` | reads the table per call, fail-closed on missing row | Yes |
| `featureGate` middleware | 60 s TTL cache, gates `ENABLE_VERIFICATION_API` only | Yes, within 60 s |

Migration `0363_g4_enable_org_credit_enforcement_flag.sql:62` states the env-only case in the repo's own words:
*"AUDIT MIRROR ONLY — this row does NOT gate enforcement and the worker never reads it."* And the rig proves the
contradiction live: Cloud Run has `ENABLE_ORG_CREDIT_ENFORCEMENT=true` while the DB row reads `false`.

`ENABLE_RULES_ENGINE` and `ENABLE_RULE_ACTION_DISPATCHER` are env-backed and absent from the rig revision. Their
Scheduler jobs fired at 21:24:09Z and 21:23:07Z. They returned success and did nothing. That is a job that 200s while
doing nothing, live on the rig, right now.

**PASS criterion.**

1. `flag-decision-matrix.csv` exists with one row per flag and a **`resolution_path`** column recording which of the
   four paths that flag's consuming code actually uses, grepped from the call site. That column does not exist today
   and is the single most valuable addition to the artifact.
2. Env-path flags are set on the revision; DB-path flags are seeded in `switchboard_flags`; registry-path flags are
   seeded **and then the worker is restarted**, with the restart ordered before the clock start (§6.3).
3. For each of the six §4.1 flags and each of `rules-engine`, `rule-action-dispatcher`, `drain-connector-artifacts`:
   a forced run produces a **named DB row-count delta**. A 200 is not a PASS. `get_flag` returning `true` is not a
   PASS either, because no table read can distinguish the four paths.
4. Every flag left OFF carries a written rationale.

### BL-4 — `SOAK_GATE_DISABLED=true`

- **Owner:** agent
- **Effort:** 2 minutes, but strictly ordered (§6.3)
- **Evidence:** `gh variable get SOAK_GATE_DISABLED` → `true`, confirmed 21:19 UTC.

**PASS criterion.** `gh variable get SOAK_GATE_DISABLED` echoes `false`, captured with a timestamp, at a moment
**after** the final rig deploy and **before** the recorded clock start; re-verified `false` at Day 7 close. A flip in
either direction inside the period voids the period from the flip. Per
`memory/feedback_soaks_are_off_read_the_check.md`, read the variable; never infer the gate's state from a green check.

### BL-5 — Nothing monitors the rig

- **Owner:** agent
- **Effort:** ~1 h including fire-testing each alarm
- **Evidence:** `arkova1` holds four alert policies, all enabled, two notification channels, one uptime check. Every
  one is scoped to production:

| Policy | Mentions `fullsoak` | Mentions `arkova-worker` |
|---|---|---|
| `PAGE — arkova-worker 5xx burst` | no | yes |
| `PAGE — Prod worker /health not healthy (body assertion)` | no | yes |
| `PAGE — Worker PostgREST schema-cache failure (PGRST002)` | no | yes |
| `PAGE — Postgres lock wait > 60s on a public relation` | no | no |

The single uptime check targets host `arkova-worker-270018525501.us-central1.run.app`. **Zero coverage of the rig.**

**Why this is blocking rather than a caveat.** The soak clock is defined as rig Cloud Run worker uptime
(`memory/feedback_soak_clock_is_worker_uptime.md`, runbook §7, checklist E10/R2). An unobserved rig restart therefore
silently resets or invalidates the period, and R2's "> 1 restart in 24 h restarts the day" cannot be enforced by a
control that does not exist. Separately, for SOC 2 Type 2, monitoring of the soak subject *is itself* the CC7.2
control being evidenced. Running a seven-day operating-effectiveness test with no detection on the system under test
is the finding, not the background.

**PASS criterion.**

1. An enabled uptime check against the rig `/health` with a **body assertion on `status`**, not on the HTTP status
   code. (Status code alone is insufficient here for a specific reason: `/health` returned HTTP 200 with a `degraded`
   body for 11+ minutes during today's production incident.)
2. An enabled alert policy scoped to `arkova-worker-fullsoak-2026-08-staging` for 5xx burst.
3. An enabled alert policy on **rig revision change**, so that R2 and R7 are detected rather than assumed.
4. Each of the three fired at least once via a synthetic trigger, with the notification observed, before the clock
   starts. An untested alarm is not a control.

### BL-6 — No change freeze (founder decision)

- **Owner:** **founder**
- **Effort:** 5 minutes to decide
- **Evidence:** `DEPLOY_WORKER_PAUSED=false`, 5 open PRs, and prod deployed revision `arkova-worker-01295-xap` at
  approximately 21:05 UTC (prod `/health.uptime` = 1000 s at 21:22 UTC). Mergify auto-merges on green.

**PASS criterion.** Either:

- `gh variable get DEPLOY_WORKER_PAUSED` echoes `true` for the whole window, verified at both ends; **or**
- a written per-merge RTE sign-off protocol exists that names who signs, what re-pinning means in practice, and which
  of the 5 open PRs are permitted (docs-only / T0) versus held.

Recorded silence is not a PASS. Note also that `DEPLOY_WORKER_PAUSED` gates `deferred_consolidated_soak`, so flipping
it changes merge semantics and not only deploy timing
(`memory/project_deploy_worker_paused_is_actions_var.md`). Say that out loud when asking, so the decision is made with
its real consequence visible.

### BL-7 — Coverage scope undecided (founder decision)

- **Owner:** **founder** to decide, agent to prepare
- **Effort:** ~3 h to produce the reconciled list; ~30 min of founder time to rule on it
- **Evidence:** runbook §4 is explicitly a placeholder awaiting the feature inventory. The inventory found ~1,151
  features across 7 domains with 389 flagged unreachable-or-findings; the checklist's own reconciliation put planned
  coverage at **278 of 400 LIVE features, 69.5%**, with **106 LIVE features having no test plan at all**, including
  258 anon-executable Postgres RPC functions, 76 DB triggers, prod-only Storage buckets and RLS, pg_cron jobs no
  migration creates, and the **entire `edge.arkova.ai` Cloudflare Worker**, which is a separate deployment target the
  rig does not include and is where the MCP surface actually lives.

**PASS criterion.**

1. Runbook §4 contains the reconciled checklist, not a placeholder, with a row per feature and the reachability
   column populated.
2. Every LIVE feature is in exactly one of two states: **in scope with a named assertion**, or **out of scope with a
   written, founder-visible reason**. Zero features in neither state.
3. The Day-7 report states coverage as an explicit fraction of the true LIVE denominator with every excluded item
   named. Per G13, a report implying 100% is an automatic NO-GO.

---

## 4. Degradations

Real, but not blocking. Each ships with the exact caveat text that must appear in the final evidence pack. Per
CLAUDE.md §1.5 each caveat states what is **measured**, what is **asserted**, and what is **NOT asserted**.

### DEG-1 — The rig's cron topology is not production's

**Measured.** 110 cron route declarations in `services/worker/src/routes/cron.ts` on `origin/main` (108 POST, 2 GET).
The rig binds **24 Scheduler jobs across 23 distinct routes**. Prod binds **60**. Cadences and job identities differ:

| Route | Rig | Prod |
|---|---|---|
| `batch-anchors` | `0-59/5` (every 5 min) | `*/30` |
| `check-confirmations` | `1-59/5` | `*/30` |
| `process-anchors` | `5-59/10` | `*/30` |
| forced flush | `batch-anchors-forced-flush`, `0 */8 * * *` | `daily-anchor-flush`, `0 3 * * *` |
| `anchor-public-records`, `anchor-expiry-sweep` | not bound | bound |

> **Caveat for the evidence pack.** *Measured:* 23 of 110 code-defined cron routes were bound and executed on the rig,
> at cadences 3x to 6x more frequent than production, with a forced flush on an 8-hourly schedule. *Asserted:* those
> 23 handlers execute and produce their named state changes. *NOT asserted:* that the remaining 87 routes operate at
> all; that concurrency, lease/CAS contention, or queue-depth behaviour observed at 5-minute cadence describes
> production at 30-minute cadence; that the 8-hourly rig flush evidences production's 03:00 daily flush. The CLAUDE.md
> §1.12 T3 requirement for a "Daily flush observation" is satisfied against the rig's schedule, not production's.

**Mitigation if cheap:** re-point the rig's anchoring cadences to prod's and rename the flush job to match prod's
semantics. Roughly 20 minutes, and it converts this caveat into coverage.

### DEG-2 — The rig anchors through a different fee strategy and a different UTXO provider than production

**Measured.** Rig: `BITCOIN_UTXO_PROVIDER=mempool`, no `BITCOIN_FEE_STRATEGY`, boot log `fee=Static`,
`utxo=Mempool.space REST API`. Prod: `BITCOIN_UTXO_PROVIDER=getblock`, `BITCOIN_FEE_STRATEGY=mempool`. The rig also
binds `BITCOIN_RPC_URL` / `BITCOIN_RPC_AUTH` from a third rig's Bitcoin Core secrets, which `BITCOIN_UTXO_PROVIDER=mempool`
never dials, so those bindings are inert and could be mistaken for RPC coverage.

> **Caveat for the evidence pack.** *Measured:* anchoring over signet using the Static fee estimator and the
> mempool.space REST UTXO provider. *Asserted:* transaction construction, WIF signing, broadcast and UTXO selection
> operate. *NOT asserted:* the GetBlock broadcast path, the GetBlock UTXO listing path, the mempool.space dynamic fee
> estimator, its fee ceiling, or its fallback rate. Production runs all four of those and none was exercised.

The `FORCE_DYNAMIC_FEE_ESTIMATION=true` fix in BL-2 closes the fee half of this. The GetBlock half cannot be closed on
signet and moves to §5 as DECLARED UNTESTED.

### DEG-3 — `/health` measures the database and nothing else

**Measured.** `services/worker/src/routes/health.ts`: on a non-detailed request `drainVerdict` is `null`, so
`anchoring.status` is the literal constant `'ok'`. The `kms` check tests only for the presence of a config string.
Overall status is `allHealthy = dbCheck.status === 'ok'`, so neither anchoring nor kms can move the status code or the
body verdict. The rig sets no `HEALTH_DETAIL_TOKEN`, so `/health?detailed=true` is unavailable and the batch-drain
dead-man's-switch never evaluates.

> **Caveat for the evidence pack.** *Measured:* worker process liveness and Postgres reachability, sampled hourly.
> *Asserted:* the worker served requests and could reach its database throughout the period. *NOT asserted:* that
> anchoring was operating, that the batch drain was not stalled, or that signing material was present. The
> `checks.anchoring` field in every artifact is a hardcoded constant, not a measurement, and must not be read as
> evidence of anchoring health.

**Mitigation:** set `HEALTH_DETAIL_TOKEN` on the rig and probe `/health?detailed=true` with the header, then assert on
`checks.anchoring.drainStalled`, `pendingCount`, `lastSecuredAt` (must advance daily) and `feeRateSatVb` (must be
non-null). Roughly 30 minutes, and it turns the single most-repeated artifact of the soak from decoration into
evidence. Recommended.

### DEG-4 — `e2e/cross-tenant.spec.ts` passes on a login redirect and injects SECURED anchors

**Measured.** `expectRecordBlocked()` waits for `window.location.pathname !== recordPath` and returns true on any
navigation away from the record URL, including a redirect to `/login`. There is no positive-access precondition
anywhere in the file: nothing asserts Org B can read its *own* data before asserting it cannot read Org A's. Fixture
setup calls `createTestAnchor(serviceClient, { status: 'SECURED' })`, a service-role insert with no chain interaction.

Two consequences. An expired Org B session on Day 4 makes all five tests pass while proving nothing, which is the
vendor's exact failure that runbook §6 exists to prevent. And seven daily runs inject seven or more service-role
SECURED anchors with no txid into the rig, re-creating the fabricated-SECURED class that Gate 0 just finished
deleting, and inflating any Day-7 "N anchors reached SECURED" figure.

> **Caveat for the evidence pack.** If the spec is run unmodified: *Measured:* the UI does not render Org A's data to
> an Org B browser session. *Asserted:* nothing further. *NOT asserted:* that Org B was authenticated at assertion
> time; that RLS blocks direct PostgREST access with Org B's JWT; that the public API or MCP surfaces enforce tenant
> scoping.

**Mitigation:** fix before it is cited for G4. Assert an explicit blocked state (403/404, or the `Record Not Found`
heading specifically) and FAIL on a `/login` redirect. Prepend a positive-access assertion to every isolation test.
Extend to direct PostgREST with Org B's JWT, the public API with Org B's key (now possible, Org B has one), and MCP.
Switch fixtures off `SECURED`, or tag them and add them to the frozen-baseline exclusion list. Roughly 1 hour.

### DEG-5 — `org-queue-scheduler` is failing on the rig right now

**Measured.** Rig Scheduler `org-queue-scheduler`, last attempt 2026-08-11T21:24:10Z, `status.code = 13` (INTERNAL).
All 23 other rig jobs show no error code.

This is a fidelity win and a baseline defect at the same time: it matches open production finding F-1 (org-queue 5xx),
so the rig *is* reproducing a real production defect, which is more than the checklist's C6 hoped for. But it is also
a job that will fail every 5 minutes for seven days.

> **Caveat for the evidence pack.** *Measured:* `org-queue-scheduler` returned INTERNAL on the rig throughout the
> period, matching production finding F-1. *Asserted:* the defect reproduces outside production. *NOT asserted:* that
> org-queue scheduling operated during the soak. Every downstream assertion that depends on org-queue scheduling is
> unevidenced for the period and is listed as such.

Triage it before Day 0 or accept it in writing. Do not let it become background noise, which is how a real regression
hides.

### DEG-6 — Preflight Check 5 fails the moment the soak works

**Measured.** `scripts/ci/staging-honesty-preflight.ts:651` requires `submitted_anchors > 0`; the classifier at :735
returns `clean_mirror` only when **no** check fails. The rig holds exactly one SUBMITTED anchor. When it confirms,
Check 5 fails and the environment reclassifies away from `clean_mirror`. There is precedent in-repo:
`rc-csi04-20260620.json` records the fixture anchor being consumed by the confirmation cron and "re-seeded to restore
Check 5". Re-seeding is now blocked by the DB triggers Gate 0 installed, which is correct and should stay that way.

> **Caveat for the evidence pack.** *Measured:* `environment_type = clean_mirror` at Day 0, hashed into
> `manifest-DAY-0`. *Asserted:* the rig was a clean mirror when the period began. *NOT asserted:* that Check 5 held
> after Day 0. Its failure once anchors begin confirming is expected healthy behaviour and is not contamination.

**Decide the rule in writing at Day 0, not on Day 1 under pressure.** If a Day-7 re-certification is genuinely wanted,
fix the check rather than the environment: `submitted_anchors > 0 OR secured_anchors_created_after_clock_start > 0`
measures the same intent without punishing a working pipeline. Under no circumstance hand-insert a SUBMITTED row.

### DEG-7 — The rig's treasury WIF is an orphaned secret named for a deleted service

**Measured.** The rig binds `BITCOIN_TREASURY_WIF` from secret `treasury-wif-legacy-soak-2026-08-staging`, one enabled
version, created 2026-07-28, with no other live consumer. It is named for `arkova-worker-legacy-soak-2026-08-staging`,
which runbook §0.1 records as deleted at 2026-08-11T15:49Z.

This was assessed as a blocker and **downgraded on verification**, correctly. The feared failure mode, silent
`MockChainClient` fallback producing mock anchors that survive every filter, is refuted: `autoConfirmMockAnchors()` is
gated on `config.useMocks || nodeEnv === 'test'` and cannot fire here, the only real SECURED writer requires an
explorer lookup to succeed, mock anchors would carry `chain_block_height` near 800,000 against a signet tip of
317,283, and the `kms` field in the unauthenticated `/health` body flips to `warning`/`provider: none` if the WIF
disappears. A 14-day log search for `falling back to mock` / `MockChainClient` on the rig returns zero rows.

The residual is an **availability** risk, not an evidence-integrity one: deleting the secret during zombie-teardown
hygiene stops the worker, and since the clock is uptime, that costs soak days.

> **Caveat for the evidence pack.** *Measured:* signing material resolved from `treasury-wif-legacy-soak-2026-08-staging`
> throughout the period. *Asserted:* a real `BitcoinChainClient` was constructed on every observed cold start
> (`Using BitcoinChainClient (signet)`, 8 occurrences, zero mock-fallback lines in 14 days). *NOT asserted:* that the
> secret's naming reflects its ownership.

**Mitigation, 2 minutes, documentation only.** Add one line to runbook §2.1: this secret is named for the deleted
legacy rig but is **load-bearing for the fullsoak rig; do not delete it during teardown hygiene**. Do **not** re-point
it to a new secret before the clock starts: that forces a new revision and a different derived treasury address at
exactly the wrong moment, and requires re-verifying funding.

### DEG-8 — The `kms` health field measures different things on rig and prod

**Measured.** Prod sets `GCP_KMS_KEY_RESOURCE_NAME=projects/arkova1/.../bitcoin-mainnet/cryptoKeyVersions/1`; the rig
sets `KMS_PROVIDER=gcp` with no key resource, so its check falls through to the WIF branch.

> **Caveat for the evidence pack.** *Measured:* `checks.kms = ok` on both. *Asserted:* nothing about key management on
> either. *NOT asserted:* that the two environments resolve signing material through the same provider. The check tests
> for the presence of a configuration string and performs no cryptographic operation.

---

## 5. Declared untested

**This section is what separates an honest soak from a hollow one.** Every item here is a capability that cannot be
exercised in this soak. Each must appear in the Day-7 report as **untested with its reason**. None may be counted as
covered, summarised into a coverage percentage, or left silent.

### 5.1 Cannot be exercised: no reachable entry point or no data

| Capability | Why it cannot be soaked | Advertised? |
|---|---|---|
| **Semantic search** | `credential_embeddings` has **0 rows on the rig** (verified live). Turning `ENABLE_SEMANTIC_SEARCH` on does not create embeddings. Independently, the edge MCP `search_credentials` tool is ungated and falls back to a literal `ILIKE %query%`, so it returns lexical substring matches while six surfaces claim semantic similarity | **Yes, and priced.** `/ai/search`, `$0.010`, "AI semantic search", `src/pages/DevelopersPage.tsx` |
| **Nessie AI assistant** | Founder directive 2026-08-01: Nessie stays OFF, permanently, and no work may plan to activate it | **Yes, and priced.** `/nessie/query`, `$0.010`, "AI assistant query", same file, same price table. **This is a second priced offer for a capability that is deliberately and permanently disabled, and it does not appear in either prior document.** |
| **AI fraud scoring** | `computeIntegrityScore` has no caller | Yes |
| **Fraud detection** | Results are filtered out of all six display surfaces | **Yes, and asserted "Continuous" to the SOC 2 auditor** at `docs/compliance/soc2-type2-evidence-matrix.md:42`, plus six regulator-facing privacy filings |
| **Visual fraud detection** | Returns HTTP 410 unconditionally | Yes |
| **AdES signatures** | Defaults to `aws_kms`; no AWS account exists (`memory/feedback_no_aws.md`). Ships in published npm SDKs, so a false claim needs a corrective release, not a web edit | **Yes**, `sdks/mcp-server`, `sdks/langchain-ts`. Related: `src/lib/copy.ts:3312` renders "qualified trust service provider" with no AdES flag row and a gate that fails open to an env var |
| **Compliance engine** | Gates nothing | Yes |
| **Partner provisioning** | No switchboard row, fail-closed. **This is the HakiChain onboarding path** | Internally |
| **Stripe checkout end-to-end** | Every UI-wired paid plan has `stripe_price_id = NULL` (#2049, founder-blocked). Checkout is 100% dead, so runbook §5.1 S16 cannot run as written | Yes |

**Nine capabilities. Seven of them advertised publicly, in a published package, or to the auditor.** Per runbook §3.5,
no claim may end the soak in the state "not demonstrated and not retracted". Each of these nine needs a KEEP / RETRACT
/ HEDGE decision in `claims-register.csv` **during** the soak, reviewed daily, not assembled on Day 7. The two priced
offers on `/developers` are the most exposed, because a price attached to a disabled capability is a commercial
representation and not merely a marketing claim.

### 5.2 Cannot be exercised: credentials or infrastructure exist only in production

| Capability | Why |
|---|---|
| **Rate limiting** | The rig uses an in-memory limiter; prod uses Upstash. No Upstash management credential exists. Carried forward from the pre-existing DECLARED UNTESTED record |
| **GetBlock broadcast and UTXO listing** | `BITCOIN_UTXO_PROVIDER=getblock` is a mainnet-only configuration; unreachable on a signet rig. Also untested: the loud-fail-on-missing-`BITCOIN_RPC_URL` branch |
| **Mainnet signing and broadcast** | Deliberately out of scope. The rig must never touch mainnet. The mainnet re-anchor backfill (PR #2140, ~149 txs / ~69,881 sats) is separate work and must not run during the window |
| **GCP KMS signing path** | Prod configures a KMS key resource; the rig does not (DEG-8) |
| **The `edge.arkova.ai` Cloudflare Worker** | A separate deployment target that the rig does not include at all. Six route families, and it is where the MCP surface customers actually use is served. The largest single omission in the coverage denominator |
| **Prod-environmental fault class** | Today's production incident (`PGRST002` schema-cache failure, `/health` HTTP 200 with a `degraded` body for 11+ minutes) is environmental to production's PostgREST and connection state. The rig runs a different database and a different PostgREST and is **structurally incapable** of reproducing it |

### 5.3 Cannot be exercised: the flag cannot safely be enabled

| Capability | Why |
|---|---|
| **`ENABLE_ORG_CREDIT_ENFORCEMENT` in production semantics** | The rig can exercise the code path, and credit enforcement was already proven behaviourally at Gate 0 (charge 201s, exhaustion 402 `insufficient_credits`, 3,399,999 credits across 2 orgs). But #2050 records that the flag gates on **balance** while ignoring `anchor_quota`, so enabling it in prod would 402 the live pilot partner HakiChain immediately. The soak cannot resolve that; it is a design defect requiring a code fix and a founder decision |
| **`ENABLE_PROD_NETWORK_ANCHORING` at mainnet scope** | Signet-scoped only, by design |
| **`MAINTENANCE_MODE`, Replicate / QA-only AI providers, `DEMO_INJECTOR`, `SYNTHETIC_DATA`, `ENABLE_NESSIE_RAG_RECOMMENDATIONS`** | Must stay off. Enabling any of them fabricates soak data or tests a maintenance page |

### 5.4 The historical proof gap

Not untestable, but not closeable by this soak, and it must not be quietly folded into a green result.
**2,967,774 SECURED anchors in production, 85.4%, have no per-document proof.** Anchoring is genuinely healthy; the
gap is in proof materialisation. The soak can prove the path works for **new** records (BTC7 / G3). The historical
backlog is a founder decision under G8: backfill before launch, or publish the limitation plainly in customer material
and in the HakiChain conversation. **A recorded decision either way is the PASS. Silence is the FAIL.**

---

## 6. Change-freeze policy

### 6.1 Frozen for the whole period

| Frozen | Why | How verified |
|---|---|---|
| Prod worker deploys | §1.11A: a runtime commit after the soak begins invalidates exact-head evidence | `DEPLOY_WORKER_PAUSED=true`; daily `gcloud run revisions list --service=arkova-worker` |
| Prod migrations | Same, plus rig/prod ledger parity is a daily PASS criterion (BL-1) | Daily `max(version)` on both refs |
| The rig Cloud Run revision | The clock **is** its uptime. Any redeploy resets it | Daily `/health.uptime` monotonic; rig revision-change alert (BL-5) |
| Rig env vars and secrets | Including `treasury-wif-legacy-soak-2026-08-staging` (DEG-7). Do not delete during teardown hygiene | Daily env dump diffed against the Day-0 dump |
| Rig `switchboard_flags` | A mid-period flip changes what the period evidences | Daily table hash into the manifest |
| `SOAK_GATE_DISABLED` | A flip in either direction voids the period from the flip (R11) | Verified at both ends, and daily |
| The mainnet re-anchor backfill (PR #2140) | Must not run in the window (BTC9) | Zero mainnet broadcasts attributable to the rig |

### 6.2 May move

- **Docs-only changes** to `HANDOFF.md`, `docs/**/*.md`, `**/agents.md`, repo-root `*.md`, under the CLAUDE.md §0
  rule 8 carve-out. These do not deploy the worker and do not touch prod state.
- **The soak's own evidence artifacts**, which are append-only under `docs/staging/evidence/<surface>/<UTC-date>/` and
  hashed daily.
- **PRs may open, receive review, and sit green.** What is frozen is the *merge to main that deploys*, not the work.
- **Fixes to defects the soak discovers** may be authored and staged, but land after the window unless the founder
  explicitly re-pins evidence and accepts a residual-risk note per §1.11A. Landing a fix mid-soak is not forbidden; it
  is expensive, and the price must be paid consciously.

### 6.3 Ordering of `SOAK_GATE_DISABLED=false` relative to clock start

The ordering matters and is easy to get wrong in both directions. Flipping it early blocks the board. Flipping it
after the clock starts means the opening hours of the period were ungated.

```
1. Seed every flag (env vars on the revision, rows in switchboard_flags)
2. Apply BL-1 (rebuild rig on prod's exact digest) and BL-2 (fee-path fix) config
3. Deploy the FINAL rig revision            <-- this resets uptime; nothing may deploy after it
4. Capture boot-time truth from THAT revision's logs:
      "Using BitcoinChainClient (signet)", feeEstimator name, flagRegistry snapshot
5. Prove one anchor SECURED end-to-end on that revision (BL-2 PASS criterion)
6. Re-run the Day-0 gate; every criterion PASS
7. gh variable set SOAK_GATE_DISABLED --body false   <-- LAST action before the clock
8. gh variable get SOAK_GATE_DISABLED                <-- capture the echo with a timestamp
9. Record clock start = LATER of (rig revision start time, step 8 timestamp)
```

**Step 3 must precede step 7** because a deploy resets uptime and would strand gated hours outside the period.
**Step 7 must precede step 9** because the whole point is that no hour of the period ran under the bypass. Recording
the clock start as the *later* of the two timestamps is what makes both true simultaneously and is auditable from two
independent artifacts.

Step 4 is not optional bookkeeping. `flagRegistry` is a boot-time snapshot with no TTL, so the flag state that governs
the entire seven days is fixed at the moment of step 3 and can only be read from that revision's logs and behaviour.

---

## 7. Day-0 checklist, in execution order

Ordered by dependency. Items at the same number are independent and should run in parallel. **A** = agent-executable.
**F** = founder-only.

| # | Step | Who | Closes | PASS |
|---|---|---|---|---|
| 1 | Put BL-6 (freeze) and BL-7 (coverage scope) in front of the founder, together, with §2.3's three schedule options | **A** (prepare) | — | Both questions asked in one message, with consequences stated |
| 2 | **Decide the change freeze.** `DEPLOY_WORKER_PAUSED=true`, or a written per-merge protocol. Triage the 5 open PRs | **F** | BL-6 | Variable echoes `true`, or the protocol is written down |
| 3 | **Decide the schedule** (§2.3 option A, B or C) and the coverage scope for the ~106 unplanned LIVE features | **F** | BL-7 | A written decision naming which features are out and why |
| 4 | Seed all DB-path flag rows; set env-path flags on the revision; record `resolution_path` per flag in `flag-decision-matrix.csv` | **A** | BL-3 (part) | Matrix complete, every OFF carries a rationale |
| 5 | Create rig uptime check (body assertion), rig 5xx policy, rig revision-change policy; fire-test each | **A** | BL-5 | Three alarms enabled and each observed to fire once |
| 6 | Set `FORCE_DYNAMIC_FEE_ESTIMATION=true`; optionally set `HEALTH_DETAIL_TOKEN` (DEG-3) and re-point cron cadences to prod's (DEG-1) | **A** | BL-2 (part), DEG-1/2/3 | Values present on the pending revision spec |
| 7 | Fix `e2e/cross-tenant.spec.ts`: fail on `/login` redirect, add positive-access precondition, extend to PostgREST + API + MCP, stop seeding SECURED fixtures | **A** | DEG-4 | Spec fails when Org B's session is deliberately expired |
| 8 | Triage `org-queue-scheduler` INTERNAL on the rig, or accept it in writing | **A** | DEG-5 | Root cause named, or written acceptance referencing F-1 |
| 9 | Add the runbook §2.1 line protecting `treasury-wif-legacy-soak-2026-08-staging` from teardown | **A** | DEG-7 | Line present in the runbook |
| 10 | Write the DEG-6 preflight re-certification rule into the runbook before it is needed | **A** | DEG-6 | Rule written, Check-5 post-clock failure pre-declared as expected |
| 11 | **Rebuild the rig on prod's exact image digest; redeploy.** This is the final revision | **A** | BL-1 | git_sha, digest and ledger head all equal prod's |
| 12 | Capture boot-time truth from the new revision's logs: chain client identity, fee estimator name, absence of any mock-fallback line | **A** | BL-1/2/3 | `Using BitcoinChainClient (signet)` present; zero mock lines |
| 13 | Behavioural flag probes: forced run of each gated job produces a named row-count delta, never a 200 | **A** | BL-3 | Delta recorded per job; any zero-delta job is a FAIL |
| 14 | **Prove one anchor SECURED end-to-end on the final revision**, confirmed on two independent signet explorers, with an 80-raw-byte `anchor_proofs.block_header` | **A** | BL-2 | All four sub-criteria in BL-2 |
| 15 | Observe one forced flush end to end; record queue depth before and after | **A** | §2.2 open question | Flush drains; PENDING count falls |
| 16 | Re-run `staging-honesty-preflight.ts`; capture `clean_mirror` once, hash into `manifest-DAY-0` | **A** | DEG-6 | `environment_type=clean_mirror`, exit 0 |
| 17 | Re-run the full Day-0 gate; every criterion PASS | **A** | all | No FAIL, no "will fix during" |
| 18 | `SOAK_GATE_DISABLED=false`, capture the echo with a timestamp | **A** | BL-4 | Echoes `false` |
| 19 | Record clock start = later of (revision start, step 18 timestamp). Commit `manifest-DAY-0` | **A** | — | Both timestamps in the manifest |

Steps 2 and 3 are founder decisions and are the ones most likely to slip. They are at the top for that reason, not
because they are the hardest.

---

## 8. Rollback triggers

The checklist's R1 to R12 stand. Three are amended by live evidence, and one is added:

| # | Change |
|---|---|
| **R2** (worker restart resets the clock) | Now **enforceable**, but only once BL-5 ships the rig revision-change alarm. Until then R2 is a rule with no detector |
| **R3** (anchor SUBMITTED > 6 h) | **Already at 4 h 56 m before the clock starts.** Reset the counter at clock start and treat the pre-soak stall as the BL-2 finding it is, not as a soak-window event |
| **R8** (> 10 false-positive alerts over 7 days) | Retained, but the premise inverted: there is no alert storm. The realistic failure is now **zero alerts because nothing watches the rig**. Add the inverse assertion: at least one deliberately-triggered synthetic alert must fire and be received during the period, proving the channel still works |
| **R13** *(new)* | **Rig/prod build divergence.** Any daily parity check (BL-1 criterion 4) showing a mismatch in git_sha, image digest, or ledger head is an evidence-invalidating event, logged the day it occurs |

---

## 9. Corrections to the two prior documents

Stated explicitly so nothing is silently overwritten. Both prior documents were accurate when written; the environment
moved.

| Prior claim | Source | Live at 2026-08-11 21:25 UTC |
|---|---|---|
| Prod worker `arkova-worker-01286-dam`, git_sha `2de4e4e34`, ledger 0405 | runbook §0 | `arkova-worker-01295-xap`, git_sha `1d12f0d39`, ledger **0409** |
| Prod `/health` degraded, HTTP 503, `database=error` (**B1**) | checklist §1.1, D1 | **healthy, HTTP 200**, all checks ok. **B1 closed**, and its 24 h stability window with it |
| Rig ledger 0400, 5 behind prod | runbook §0 | **0409, parity with prod.** But see BL-1: the ledger matches and the **binary does not** |
| Rig ledger 0407, parity broken | this session's briefing | **0409.** Stale reading, corrected |
| Rig holds 8 fabricated SECURED anchors (**B2**) | checklist §2 | **0 SECURED.** 4 PENDING, 1 SUBMITTED. **B2 closed** |
| ~25,000 false alerts / 13 days across 4 duplicate cron monitors, dead-tuple alert every 2 min (**B6**) | checklist §2, PM4 | **Void.** Exactly 4 alert policies exist, all enabled, all created today, all `PAGE —` prefixed. No duplicate cron monitor. No dead-tuple alert. The 24 h quiet baseline is removed from the critical path. **The real gap is the inverse: nothing watches the rig (BL-5)** |
| All 3 rig API keys on Acme Corp; Org B has none (**K10**, **D12**) | checklist §6 | **Closed.** Acme 3 keys, Arkova 1 key, both orgs have signed-in members |
| 20 open PRs | checklist §1.1, B5 | **5** |
| 105 cron routes in code | both | **110** on `origin/main` (108 POST, 2 GET) |
| 24 of 105 cron routes bound on the rig = 23% | checklist §5.1 | 24 jobs across **23 distinct routes** of 110 = **21%** |
| 52 of 105 prod cron routes unscheduled; 58 prod-targeted jobs | runbook §2.3 | **60** prod-targeted jobs |
| All 5 Bitcoin safety loops bound on the rig | checklist §5.2 | **Confirmed.** `detect-reorgs`, `monitor-stuck-txs`, `rebroadcast-txs`, `consolidate-utxos`, `monitor-fees` all ENABLED and firing |
| Rig image digest identical to prod's (**E2 PASS**) | checklist §3 | **FAIL.** Rig `a5231f21…` (tag `2de4e4e34`), prod tag `1d12f0d39`, **140 commits apart**. This is BL-1 |
| `chain_tx_id ~ '^[0-9a-f]{64}$'` as an anchoring control (**B2.c**) | checklist §2 | **Delete it.** Mock output is 64 lowercase hex and passes it. Replaced by BL-2's explorer + 80-byte-header criterion, plus the `chain_block_height > 400000` mock detector |

The checklist's headline "**3 PASS / 10 FAIL / 1 RE-RUN**" is superseded. Against this document's gate the count is
different in composition and similar in conclusion: **NO-GO**, with a materially shorter path.

---

## 10. Pre-mortem: it is Day 7, the report is green, and a customer hit a failure in launch week

The runbook's P1 to P15 and the checklist's PM1 to PM10 remain valid. What follows are only the causes that **today's
live evidence makes concrete**, ordered by probability. Each is a thing that is true on 2026-08-11, not a hypothesis.

### PM-A — We soaked last week's build ★ highest probability

**Already true.** The rig is 140 commits behind prod, including the recipient-activation launch blocker, the Stripe
checkout KYB self-grant fix, and the treasury-cache mainnet-explorer fix. The evidence pack would be internally
perfect: real SHAs, real digests, real timestamps, every §5.0 provenance rule satisfied, describing the wrong binary.
**Control:** BL-1, and specifically criterion 4, the *daily* parity re-check. A Day-0 snapshot of a moving target
decays within hours while `DEPLOY_WORKER_PAUSED=false`.

### PM-B — Day 7 reported zero SECURED anchors, and we argued about it instead of shipping ★ already true

**Already true.** Zero anchors have ever reached SECURED on this rig. The one real broadcast has been unconfirmed for
4 h 56 m across 21 blocks at 1.005 sat/vB under the Static fee estimator. **Control:** BL-2, closed *before* the clock
starts, not discovered on Day 3. The failure mode here is not silence; it is a loud null result seven days late, after
the launch date has passed.

### PM-C — The rig restarted on Day 4 at 03:00 and nobody knew ★ high probability, zero detection today

Four alert policies and one uptime check, all scoped to production. The clock is rig uptime. A restart resets it, R2
says "> 1 restart in 24 h restarts the day", and there is no instrument that can observe a restart. **Control:** BL-5,
including fire-testing each alarm. An untested alarm is not a control, which is the lesson production already taught
twice this month.

### PM-D — Seven days of jobs returned 200 and did nothing ★ already true today

`rules-engine` and `rule-action-dispatcher` fired at 21:24:09Z and 21:23:07Z. Their flags are **env-backed**, absent
from the rig revision, and therefore false. They returned success. Nothing happened. The documented remedy, inserting
`switchboard_flags` rows, **cannot reach an env-backed flag**, so applying the fix as written produces a greener
matrix and identical behaviour. This is the false-green-inside-the-fix pattern the founder already caught once.
**Control:** BL-3, specifically the `resolution_path` column and the row-count-delta assertion. Never a status code,
never a `get_flag` read.

### PM-E — Cross-tenant isolation passed for seven days on an expired session

`expectRecordBlocked()` returns true on a `/login` redirect. On Day 4 the seeded session expires, every navigation
redirects, all five tests pass, and the daily artifact records "zero leaks" for the criterion (G4) that is the CC6.1
centrepiece and has never once been genuinely established. Meanwhile each run injects service-role SECURED anchors,
rebuilding the fabricated-anchor class Gate 0 just removed. **Control:** DEG-4's fix, before the spec is cited for
anything.

### PM-F — The report said 100% and the denominator was wrong

Runbook §4 is still a placeholder. The reconciled coverage is ~69.5% of 400 LIVE features, and the largest single
omission, `edge.arkova.ai`, is where the MCP surface customers actually use is served, and is also where the known
ungated `ILIKE %query%` search defect lives. **Control:** BL-7 plus G13. A report implying 100% is an automatic NO-GO,
and the only place that can be prevented is Day 0.

### PM-G — We shipped a priced offer for a capability that is permanently switched off

`/developers` prices `/ai/search` at `$0.010` while `credential_embeddings` has zero rows, and prices `/nessie/query`
at `$0.010` while Nessie is under a standing founder directive to stay off. Two priced commercial representations for
capabilities that will not work on launch day. The second one is not in either prior document. **Control:** the claims
register, reviewed daily, with a KEEP / RETRACT / HEDGE decision per surface. There is no third outcome.

### PM-H — The health artifact was the most-repeated file in the pack and measured one thing

168 hourly `/health` captures across seven days, every one recording `checks.anchoring: "ok"` as a hardcoded constant,
`checks.kms: "ok"` as a config tautology, and an overall status driven solely by the database check. During the same
period the batch drain could stall, the treasury could run dry, and the pack would show an unbroken green line.
Production already demonstrated the failure mode today: HTTP 200 with a `degraded` body for 11+ minutes.
**Control:** DEG-3. Set `HEALTH_DETAIL_TOKEN`, probe `?detailed=true`, and assert on `drainStalled`, `pendingCount`,
`lastSecuredAt` and `feeRateSatVb`.

### PM-I — The seven-day soak finished two days after the customer launched

**Arithmetic, not a defect.** Best-case Day 0 on 12 August closes Day 7 on 19 August; launch is ~17 August.
**Control:** §2.3, decided by the founder, today. The failure mode is not that we run out of time; it is that nobody
decides, the launch happens mid-soak by default, and the Day-7 report is written to look like it covered a launch it
did not precede.

---

## 11. Evidence appendix

Every reading below was captured live on 2026-08-11 between 21:19 and 21:25 UTC, each `curl` to a fresh output file
per §5.0 rule 1, transport status recorded separately from body per rule 2.

### 11.1 Build and health

| Subject | Value | Method |
|---|---|---|
| Prod `/health` | `http=200` `{"status":"healthy","git_sha":"1d12f0d39f650e634c1a381efe40c2fed5dde39a","uptime":1000,"network":"mainnet","checks":{"database":"ok","anchoring":"ok","kms":"ok"}}` | `curl`, fresh file |
| Rig `/health` | `http=200` `{"status":"healthy","git_sha":"2de4e4e344f3749a09c52d7411831b7d2735528c","uptime":12506,"network":"signet","checks":{"database":"ok","anchoring":"ok","kms":"ok"}}` | `curl` with `gcloud auth print-identity-token --audiences=$RIG` |
| Prod revision / image | `arkova-worker-01295-xap`, `arkova-worker:1d12f0d39f650e634c1a381efe40c2fed5dde39a` | `gcloud run services describe` |
| Rig revision / image | `arkova-worker-fullsoak-2026-08-staging-00009-j7r`, `arkova-worker@sha256:a5231f21aef77c05b6ce0b9cda306bcacea8a2d2e72f09da5369bbb50612764f` | `gcloud run services describe` |
| Commits between | **140** | `git rev-list --count 2de4e4e34..1d12f0d39` |
| Migrations in that range | 0401, 0402, 0405, **0406, 0407, 0408, 0409** | `git diff --name-only` |

### 11.2 Rig database (bounded, `SET statement_timeout='8s'`)

```
ledger_head=0409  ledger_rows=111
anchors_total=5   secured=0  submitted=1  pending=4   proofs=1
orgs=2            api_keys=4  flag_rows=24  flags_on=17
credential_embeddings=0        org_credits rows=2   total_credits=3399999
Acme Corp: 3 keys (3 active), 1 member    Arkova: 1 key (1 active), 2 members
```

### 11.3 Bitcoin

```
tx  81baf563289b377d2612305ac72be811acb60e5420b91dbdcb5b85be962dd2bd
    rig:                 status=SUBMITTED, chain_block_height=317262,
                         updated_at=2026-08-11T17:22:55Z, age=04:55:23
    mempool.space/signet http=200  confirmed=False  block_height=None  fee=157  vsize=156.25
    blockstream/signet   http=200  {"confirmed":false}
    signet tip           317283  (21 blocks after broadcast)
    implied fee rate     1.005 sat/vB

rig chain-client boot log, 3 cold starts (16:25:04Z, 17:21:34Z, 17:54:04Z):
    network=signet  utxo=Mempool.space REST API  fee=Static

rig  BITCOIN_NETWORK=signet  BITCOIN_UTXO_PROVIDER=mempool  USE_MOCKS=false  KMS_PROVIDER=gcp
     no BITCOIN_FEE_STRATEGY, no BITCOIN_STATIC_FEE_RATE, no FORCE_DYNAMIC_FEE_ESTIMATION,
     no MEMPOOL_API_URL, no HEALTH_DETAIL_TOKEN, no GCP_KMS_KEY_RESOURCE_NAME
prod BITCOIN_NETWORK=mainnet  BITCOIN_UTXO_PROVIDER=getblock  BITCOIN_FEE_STRATEGY=mempool
     USE_MOCKS=false  GCP_KMS_KEY_RESOURCE_NAME=projects/arkova1/.../bitcoin-mainnet/cryptoKeyVersions/1
```

### 11.4 Flags, live `get_flag` resolution on the rig

All twenty resolve **false**. Six with a row set false: `ENABLE_SEMANTIC_SEARCH`, `ENABLE_AI_FRAUD`,
`ENABLE_FRAUD_DETECTION`, `ENABLE_COMPLIANCE_ENGINE`, `ENABLE_EXPIRY_ALERTS`, `ENABLE_ORG_CREDIT_ENFORCEMENT`.
Fourteen with no row: `ENABLE_RULES_ENGINE`, `ENABLE_RULE_ACTION_DISPATCHER`, `ENABLE_QUEUE_REMINDERS`,
`ENABLE_DOCUSIGN_OAUTH`, `ENABLE_DOCUSIGN_WEBHOOK`, `ENABLE_DRIVE_OAUTH`, `ENABLE_DRIVE_WEBHOOK`,
`ENABLE_DRIVE_CHANGES_RUNNER`, `ENABLE_CONNECTOR_ARTIFACT_ENQUEUE`, `ENABLE_CONNECTOR_ARTIFACT_DRAIN`,
`ENABLE_WEBHOOK_HMAC`, `ENABLE_TREASURY_ALERTS`, `ENABLE_PARTNER_PROVISIONING`, `ENABLE_ADES_SIGNATURES`.
Resolving true: `ENABLE_VERIFICATION_API`, `ENABLE_PROD_NETWORK_ANCHORING`.

### 11.5 Scheduler and monitoring

```
rig jobs   24 (23 distinct routes), all ENABLED
           org-queue-scheduler status.code=13 (INTERNAL) at 2026-08-11T21:24:10Z; all others clean
           5 BTC safety loops all bound: detect-reorgs, monitor-stuck-txs, rebroadcast-txs,
             consolidate-utxos, monitor-fees
prod jobs  60
code       110 cron route declarations in services/worker/src/routes/cron.ts (origin/main)

alert policies      4, all enabled, 2 channels each, all prod-scoped, none mention "fullsoak"
notification chans  2  (Arkova Ops email; Pub/Sub test harness)
uptime checks       1, host arkova-worker-270018525501.us-central1.run.app  (prod only)
```

### 11.6 GitHub

```
SOAK_GATE_DISABLED   = true
DEPLOY_WORKER_PAUSED = false
open PRs             = 5
```

---

_Prepared 2026-08-11 by the RTE. Not committed, not pushed. Every reading in §11 was captured live between 21:19 and
21:25 UTC against production (`vzwyaatejekddvltxyye`), the rig (`gnkuaywlpmsaezwvlvhk`), GCP project `arkova1`,
GitHub, and two independent Bitcoin signet explorers, using bounded queries only. Items that could not be verified are
marked as gaps or as decisions, never asserted. Where this document contradicts the runbook or the pre-soak checklist,
§9 says so explicitly._

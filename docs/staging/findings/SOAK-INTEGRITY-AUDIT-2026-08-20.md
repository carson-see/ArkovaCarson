# SOAK INTEGRITY AUDIT — all four live soaks

**Audited 2026-08-20T18:20Z–18:45Z. Read-only throughout: no rig or prod writes, no redeploy,
no revision or traffic change, no PR mutation, LaunchAgent untouched.**

Method: each soak was audited independently, then adversarially refuted by a second pass that
re-pulled primary sources rather than re-reading the first pass's citations. Where the two
disagree, **the refuter's more conservative verdict wins unless the auditor's evidence is
specific and primary and the refuter's objection is generic**. Every override below is stated
explicitly with its reason, and the four decision-critical disputes were re-verified directly
in this session against Cloud Run logs and the repo (see [Independent
re-verification](#independent-re-verification)).

---

## Bottom line

**Not one of the four soaks will produce merge-grade evidence at its declared close without
intervention.** Three are hollow uptime — chain-pair (54% elapsed of 48h), migration-t3 (10% of
48h) and wave2 (24% of 12h) have all four clocks running cleanly on unchanged revisions while
measuring liveness probes, cron no-ops and rate-limiter rejections rather than the changed
behavior of the PRs they are supposed to soak. wave3 is the only one carrying real in-window
signal (two routes genuinely exercised hundreds of times, plus a real defect surfaced), and its
load driver has been dead since 17:30Z and cannot restart itself. The two soaks discovered
hollow this morning were driven within hours; that fix was necessary and is not sufficient — the
drivers now running still cannot reach the changed code on any of the three worker rigs.
Concretely: **chain-pair must not close on 2026-08-21T16:51:23Z as a 48h T3 window** (its first
3h58m had five other revisions co-executing against the same database and treasury, and its
FD-CHAIN-1 evidence exercises the wrong half of the PR); **migration-t3's RC manifest cites an
evidence file that does not exist and a PR head SHA that was never built**, so it must not go to
the gate as written; **wave2's 12h window has been closed to new evidence since 17:22Z**; and
**wave3 needs a four-variable driver fix before it accrues another minute of anything.** The
defensible move today is to fix the drivers named in each remediation section, restate each
window's effective start honestly, and split each RC to ship only what its window actually
exercised — not to extend clocks over unexercised paths.

| Soak | Declared window | Elapsed @18:45Z | Verdict | Clock intact (FD-CLOCK-1)? | Merge-grade at close? |
|---|---|---|---|---|---|
| **chain-pair** (T3) | 08-19 16:51:23Z → 08-21 16:51:23Z | 25h54m / 48h (54%) | **HOLLOW_UPTIME_ONLY** | Revision axis yes; **integrity conditions NO** | **No** |
| **migration-t3** (T3) | 08-20 14:00:22Z → 08-22 14:00:22Z | 4h45m / 48h (10%) | **HOLLOW_UPTIME_ONLY** | Yes, with caveats | **No** |
| **wave2** (T2) | 08-20 15:51:57Z → 08-21 03:51:57Z | 2h53m / 12h (24%) | **HOLLOW_UPTIME_ONLY** | Yes, with amendments | **No** |
| **wave3** (T2) | 08-20 16:40:21Z → 08-21 04:40:21Z | 2h05m / 12h (17%) | **PARTIALLY_HOLLOW** | Yes | **Partially**, if driver fixed now |

---

## Independent re-verification

Four disputed facts were decision-critical. All four were re-pulled from primary sources in this
session; all four resolved in the refuter's favour.

| Disputed claim | Result |
|---|---|
| chain-pair: five stale revisions ran live inside the clock | **CONFIRMED.** `gcloud logging read` over 2026-08-19T16:51:23Z→20:49:00Z returns 897 entries on head `00022-suy` **and 1,103 on `00017-soz`/`00018-wes`/`00019-bek`/`00020-gag`/`00021-jah`** — six builds co-executing against one rig DB and one treasury for the first 3h58m of a T3 clock. |
| chain-pair: the sole listUnspent degradation observation is off-head | **CONFIRMED.** The only `jsonPayload.operation="GetBlockHybridProvider.listUnspent"` entry in the entire window is 2026-08-19T20:31:30.343460Z on **`00019-bek`**, leg=mempool.space, rpcUtxoCount=1. Zero on-head. |
| chain-pair: "health green" is false | **CONFIRMED.** 312 db-health emissions since clock start carry `Smoke test fail-streak: 3 consecutive failures`, latest 18:42:19Z, alongside a `job_queue` dead-tuple ratio oscillating 0.80 → 10.00. |
| wave2 #2270: the cited "proof" is base code | **CONFIRMED.** `git show 6b4847c0b:services/worker/src/utils/sentry.ts` already contains `PROD_SERVICE_NAME` (l.265), `resolveSentryEnvironment` (l.276) and `console.log('[Sentry] Initialized for …')` (l.354). The startup line prints identically without PR #2270. |
| migration-t3: RC manifest cites a nonexistent evidence file | **CONFIRMED.** `rc-migration-t3-20260820.json` → `soak.evidence_links[1]` = `docs/staging/migration-t3-soak-2026-08/load-harness-launch-evidence.json`. Not on disk, not in git. The directory holds only `FD-RETENTION-1-timeout-inversion.md`, `soak-start-2026-08-20.md`, `load-auto-20260820T180223Z.json`. |
| wave3: in-window container terminations exist | **CONFIRMED, and benign.** `jsonPayload.msg="Received shutdown signal"` returns four in-window events; three are on head `00004-cjk` (17:50:52Z activeOps 0, 18:06:50Z activeOps 2, 18:17:42Z activeOps 0), each followed within milliseconds by `HTTP server closed — all connections drained`, with AUTOSCALING starts at 18:01:45Z/18:02:26Z. The fourth (16:41:49Z) is on prior revision `00001-9t5` draining during rollout. These are recycles, not crashes — but the auditor certified "zero terminations" from a `textPayload` search that structurally cannot see structured-log messages. |

---

## 1. chain-pair — T3, 48h

**Service** `arkova-worker-fullsoak-2026-08-staging` · **revision** `00022-suy` (tag `cp0819rc`) ·
**rig** `gnkuaywlpmsaezwvlvhk` · **BUILD_SHA** `daf3d6056788762ba56da5c328154e50fce03b59` ·
**PRs** #2250, #2216, #2269

### Verdict: HOLLOW_UPTIME_ONLY

**Override stated:** the auditor graded this PARTIALLY_HOLLOW on the strength of two
FD-CHAIN-1 observations at 18:10:19Z and 18:20:15Z. **I am overriding in favour of the
refuter.** The refuter's objections are specific and primary, not generic, and three of them
were re-verified above: five stale revisions co-executed for 15.6% of the clock; the only
degradation observation is off-head; and health was never green. Most decisively, the refuter
distinguishes PR #2250's two halves — round 1 (`c9184bee8`, empty-RPC fall-through) from round 2
(`c2327c156`, the `Promise.allSettled` union with `(txid,vout)` dedupe). The observed state
(utxoCount=1, totalSats=735415, RPC empty at minconf=1) is round 1's behavior, which the
pre-union code handles identically. Round 2's union has never had two rows to merge: **max
utxoCount across all 203 pre-flight observations is 1.** That is a specific, primary, falsifiable
correction, and it removes the only evidence the PARTIALLY_HOLLOW grade rested on.

### What the window genuinely evidences

- **Uptime and revision stability.** 25h54m on one unchanged revision, generation 1, 100% traffic
  under tag `cp0819rc`, `latestCreated == latestReady`. Zero HTTP 5xx across ~13,219 requests.
  Provenance clean: revision `BUILD_SHA` matches the union head exactly and the image digest
  carries the matching Artifact Registry tag.
- **Boot-time configuration.** `BITCOIN_UTXO_PROVIDER=getblock`; every process start on the head
  logs `Creating GetBlock hybrid UTXO provider` and `Using BitcoinChainClient (signet)`; all four
  instances logged `Upstash Redis rate limiting initialized (shared counters via INCR)` with
  `environmentNamespace: arkova-worker-fullsoak-2026-08-staging`, so #2269's new
  `environmentNamespace.ts` path is live on every instance.
- **That the union is in the serving path.** `hasFunds()` (`chain/signet.ts:1157`) calls
  `this.provider.listUnspent(this.address)`, so each `Treasury pre-flight check passed` is a
  union call. This establishes reachability, not exercise.
- **Round 1 of #2250, three times, in the final half hour.** 18:10:19Z / 18:20:15Z (and a third
  at 18:30) read utxoCount=1 totalSats=735415 — unconfirmed change supplied by the mempool leg
  while the minconf=1 RPC leg returned empty.
- **Two real broadcasts**, one of which (03:00:17Z) drained three anchors created 2h14m *before*
  the clock started.

### What it does NOT evidence — never claim these

1. **Head-attributable behavior for the first 3h58m.** Revisions 00017–00021 were executing their
   own in-process crons against the same Supabase rig and the same treasury address until the
   20:49:32–34Z SIGTERM cluster; 00021-jah even cold-started a new instance at 19:39:09Z, inside
   the clock. §1.11A forbids copying evidence across heads; here the head was never alone.
   **Any behavioral claim must start 2026-08-19T20:49:34Z, not 16:51:23Z.**
2. **#2250 round 2 — the union merge.** Never exercised. Max utxoCount = 1 across 203
   observations, so `(txid,vout)` dedupe and RPC-preferred-on-collision have never run. Three of
   four degradation branches never ran, and the fourth (mempool-leg failure) ran once, **off-head**.
   There is **zero on-head evidence the union's RPC leg ever returned a row** — on the head the
   union may have been functionally mempool-only for 25 hours. Note also that
   `refreshTreasuryCache` builds `createUtxoProvider({ type: 'mempool' })`
   (`treasury-cache.ts:155-156`), bypassing the hybrid provider entirely.
3. **#2216's headline behavior.** Zero `BodyReadTimeoutError` in ~16,261 application entries; zero
   abandoned-run-after-deadline events. The 121 "aborted due to timeout" entries are **not**
   request-level `AbortSignal` noise as the auditor said — they are `Reorg detection cron failed`
   TimeoutErrors from `detectReorgs`, 56 on-head, in every hour of the window, last at 18:10:18Z.
   Of the four lease signals the auditor credited, three (`another instance holds the run lease`,
   `already in progress on this instance`, `Run lease bootstrap failed`) are **unchanged code
   already on `origin/main`**. Only the skip-streak warning is new: 44 occurrences, of which
   **exactly one** is on the head, and all 44 carry `reason=lease-held` — none carry the
   same-process reason that commit `bae6a4a32` was written to add. `job_queue` holds five rows
   (four `*:lease`, one permanently-failed 2026-08-12 job) and zero since clock start; there is no
   queue workload for a run-body bound to act on.
4. **#2269 enforcement.** Only 19 of ~13,219 requests could reach rate-limit middleware at all —
   `/health`, `/api/health` and `app.use('/jobs', cronRouter)` mount no limiter. Eleven counter
   increments, all inside one 20-second manual burst. **Do not claim shared-counter enforcement.**
5. **"Health green" as a satisfied integrity condition.** 312 alerts carrying a 3-deep smoke-test
   fail-streak, and the underlying `audit_events` rows are three records from **2026-08-12**,
   eight days stale — no smoke test ran during the window at all. The rig's only health
   instrument is pinned red on dead data and could not have detected a regression.
6. **§1.12 T3 matrix items.** Both batch events log `batchSizeCrossed: false` — **Trigger A never
   fired and structurally cannot** (8 anchors per 30-min cycle vs `BATCH_ANCHOR_MAX_SIZE=10000`).
   The 03:00 event was `/jobs/batch-anchors?force=true` draining pre-clock rows. Per-org isolation
   is untestable: 25,900 of 25,907 anchors belong to one fixture org, and all 8 new anchors went
   to that same org in one batch.

### Clock integrity under FD-CLOCK-1

**Revision axis: INTACT.** Creation 2026-08-19T16:51:23.324226Z matches the declared start;
revision unchanged; 100% traffic; zero 5xx; the two head SIGTERMs (13:43:47Z, 17:48:58Z) are
clean drains at `activeOps:0`, each preceded ~15 min earlier by a `MANUAL_OR_CUSTOMER_MIN_INSTANCE`
replacement start — textbook `minScale=2` recycling, which FD-CLOCK-1 explicitly rules is not a
reset.

**Integrity conditions: NOT ALL MET.** Condition 4 (health green) fails outright — 312 alerts, on
eight-day-stale smoke rows. And cross-version co-execution for the first 3h58m means the window
is not head-attributable end to end even though the head itself never changed. **Do not restart
the clock** (nothing broke); **do amend the evidence block** to declare an effective behavioral
start of 2026-08-19T20:49:34Z and to record the health condition as failed.

### Remediation

1. **Do not close as a uniform 48h T3 window.** State the shape: hours 0–3.97 contaminated by
   five co-running revisions; hours 3.97–25.17 liveness + cron only; chain-lifecycle throughput
   begins 2026-08-20T18:01:51Z. `chainpair-anchor-traffic.sh` already carries a
   `PROVENANCE RULE — DO NOT BACKDATE` header; hold the pack to it.
2. **Give the union two rows to merge, or declare round 2 unproven.** Split the treasury so the
   address holds 2–3 UTXOs:
   ```
   # from the soak driver host, against the signet treasury
   #   tb1qrjarsqj0ewqh3u9fdcu7yfyl0sx78k4savtmv7
   # send a small self-payment creating a second confirmed outpoint, then confirm:
   curl -s https://mempool.space/signet/api/address/tb1qrjarsqj0ewqh3u9fdcu7yfyl0sx78k4savtmv7/utxo | jq length   # must be >= 2
   # then assert on-head:
   gcloud logging read 'resource.labels.revision_name="arkova-worker-fullsoak-2026-08-staging-00022-suy"
     AND jsonPayload.msg="Treasury pre-flight check passed" AND jsonPayload.utxoCount>=2' --limit=20
   ```
   Until `utxoCount>=2` appears on `00022-suy`, `(txid,vout)` dedupe is untested.
3. **Get n≥10 on the unconfirmed-change-only state, on-head.** Signet confirms in ~4 min and the
   batch cron is every 30 min, so the vulnerable state exists for ~4 of every 30 minutes at best.
   Add a `listUnspent` read within ~2 minutes of each broadcast (tighten the treasury-cache
   cadence or add an explicit post-broadcast read) so each of the ~40 remaining driver cycles
   produces an observation rather than one accidental brush per day.
4. **Exercise #2250's remaining branches deliberately or declare them unproven** — RPC-fails →
   mempool-only; both-legs-fail → throw; and especially mempool-fails-while-RPC-succeeded-EMPTY →
   throw, which the code comment itself flags as subtle.
5. **#2216: inject the fault or split the claim.** The run-body deadline requires a provider that
   stalls *after* headers; natural traffic will never produce it. Stand up a stub endpoint that
   sends headers then sleeps past the deadline, or state plainly that the lease/contention half is
   soaked (and even that is mostly stale-revision contention: 607 of 715 lease-held skips fall in
   the six-revision overlap) and the body bound is not.
6. **#2269 cannot accumulate evidence on this rig as configured.** Add a
   `npm run staging:load --mode mixed` driver against the chain-pair base URL in
   `relaunch-wave-load.sh`, matching what wave2/wave3/migration already get; chain-pair currently
   gets only `run_chainpair_anchors` with `ANCHORS_PER_RUN=4`.
7. **Settle the `count:11` vs 7-observed-requests anomaly before shipping #2269.** It resolves
   from source: `rateLimit()` builds `key = scope ? scope:keyGen : keyGen` with `scope` defaulting
   to `''`, so `rateLimiters.api` (60/min) and `rateLimiters.checkout` (10/min) share one per-IP
   Upstash key while enforcing different caps, and `COUNTED_LIMITERS` dedupes per instance — a
   request traversing both increments the shared counter twice. #2269 ships a double-mount guard
   with a dedicated `rateLimitDoubleMount.test.ts`; this is exactly that class of defect, live and
   on-head. Run it down, do not assume.
8. **Fix or explain the rig's own alerts** before calling anything green: the smoke fail-streak
   (312 alerts on 2026-08-12 rows), the `job_queue` dead-tuple ratio, the 121 `detectReorgs`
   TimeoutErrors, 59 Supabase read-transport retries, 6 `recover_stuck_broadcasts` fallbacks, and
   4,977 node-cron "missed execution" warnings (~30% of app log volume — the known throttled-Cloud-Run
   cron gotcha).
9. **Note, do not fix, the stale `lane=pr-2195` / `pr=2195` revision labels.** `BUILD_SHA` and image
   tag are correct. Correct on the next deploy; do not redeploy mid-soak.
10. **At close, the defensible split is:** nothing merge-grade for #2250 round 2 or #2269;
    #2216 lease/contention only, and only post-20:49:34Z. Either extend the clock so the driver
    produces ~40 more broadcast cycles under the fixes above, or split the RC.

---

## 2. migration-t3 — T3, 48h

**Service** `arkova-worker-staging` · **revision** `00300-few` (tag `train-migration-t3`) ·
**rig** `fizyjojbebyalirtjjht` · **BUILD_SHA** `3baf16015ed61b4063daa6e53bead2399657ecd6` ·
**PRs** #2219, #2235, #2248

### Verdict: HOLLOW_UPTIME_ONLY

Both passes agree on the label. **I am carrying the refuter's severity and its two corrections
in the auditor's favour**, because both are specific and primary. This soak is not merely
un-exercised-so-far; exercise is **structurally impossible for the remaining 43 hours**, and the
merge-grade artifact is partly fabricated.

### What the window genuinely evidences

- **Uptime on one revision, one instance.** Creation 2026-08-20T14:00:22.865530Z matches the
  declared start exactly; `latestReady == latestCreated`; 100% traffic; a single instance
  (`00a41e8c1d0481ce`) served all ~13,515 requests; zero container exits, terminations,
  memory-limit events or WARNING+ system events; zero ERROR-severity application entries; heap
  steady at 5.7–6.3% of 1,539MB.
- **That `partnerProvisioningGate` works in both states.** The flag *was* flipped: 
  `switchboard_flag_history` holds three rows (14:14:36Z true→false, 14:24:01Z false→true,
  14:24:02Z true→false) and `pg_stat` shows `switchboard_flags n_tup_upd=4`. Proof it took
  effect: the two `POST /api/partner-provisioning` at 14:09:10Z and 14:10:43Z returned **401, not
  404** — the gate opened and handed off to `requireAuthMw`.
- **Migration apply + destructive rollback rehearsal**, at stand-up: `partner_accounts`
  `n_tup_ins=2, n_tup_del=1, n_live_tup=0, idx_scan=0` — apply → DROP TABLE → re-apply. That is
  schema evidence, not soak-window evidence.
- **#2248's ACL end state, empirically.** `has_function_privilege` over all 16 signatures:
  anon EXECUTE false on all 16; authenticated false on 14 and true on exactly the two prod
  deliberately grants; service_role true on all 16. A one-shot static assertion — a running clock
  neither exercises nor can regress it.

### What it does NOT evidence — never claim these

1. **Any application behavior at all.** **Zero 2xx on any application route across ~13,515
   requests.** Status split: 429=11,472 (84.9%), 503=1,439 (10.6%), 401=494, 200=107 (91 `/jobs/*`
   pokes + 16 health), 404=3.
2. **That more clock will help.** The service is `--no-allow-unauthenticated` (no `allUsers`
   binding), so `load-harness.ts:241` stamps a GCP IAM identity token on every request;
   `requireAuthMw` then tries to parse it as a Supabase user JWT and 401s. And `run_migration()`
   in `relaunch-wave-load.sh` does **not** pass `STAGING_API_KEY` (unlike `run_one()` for wave2).
   No authenticated application request is producible on **any** route for the remaining 43 hours.
3. **PR #2235's two headline migrations.** `/jobs/cleanup-retention` and `/jobs/refresh-stats`
   fired **zero** times and are absent from the harness's hardcoded `CRON_ENDPOINTS`
   (`load-harness.ts:447-451`) and from Cloud Scheduler. Even if fired: `audit_events` has 2 rows
   so `cleanup_expired_data()` deletes nothing; `anchors.last_analyze` is 13:42:26Z (18 min
   *pre*-clock), `last_autoanalyze` NULL, `n_live_tup=1` — the autovacuum threshold (50 + 0.2n)
   will never be crossed, so `reltuples` stays pinned at 1 and the cache reads
   `{"total":1,"total_source":"estimate"}`, the **trusted** path. All three branches 0412 exists
   to fix are untaken; 0411's `lock_not_available` (55P03) branch needs a competing long reader on
   `audit_events` that this rig has no way to produce.
4. **A clean migration ledger as an observation.** The auditor cited `list_migrations` showing
   0410–0414 with no timestamp rows as a positive. The RC manifest's own
   `migration_plan.reapply_proof` states the rehearsal timestamp rows were **deleted** after each
   cycle, and `pg_stat` confirms `supabase_migrations.schema_migrations n_tup_ins=126, n_tup_upd=5,
   n_tup_del=10`. §1.11A: ledger rows may not be repaired/deleted/inserted without explicit
   operator approval of the exact operation; the manifest's `approval_note` enumerates five
   approved asks and ledger-row deletion is not among them. **The clean ledger is a curated
   artifact, not evidence of cleanliness.**
5. **A clean-mirror environment.** `soak-start-2026-08-20.md` records
   `environment_type=fixture_seeded`, **not** `clean_mirror` — a §1.11A evidence-validity
   condition. Worse, the fixture set grew *after* the clock started: `organizations` holds
   "Seed Fixture Org LLC" (pre-clock) and **"Migration T3 Soak Org B" created 2026-08-20T14:15:56Z**,
   15.5 minutes into the window.
6. **"Zero service-attributable 5xx".** All 1,439 5xx are 503. 936 are `featureGate` darkness
   (no `ENABLE_VERIFICATION_API` row → fails closed); **507 are rig misconfiguration**
   (`ADOBE_SIGN_CLIENT_SECRET not set` / `CHECKR_WEBHOOK_SECRET not set` / microsoft-graph, 169
   each) returning 5xx and being counted as expected.
7. **Concurrency or fan-out — half of what T3 means.** `minScale=1`/`maxScale=2`, one instance
   served 100% of traffic for 4h45m, and nothing in the driver plan will make it scale.
8. **§1.12 T3 artifacts.** Trigger A, Trigger B, daily flush and per-org isolation are all
   unproducible: `ENABLE_BATCH_ANCHORING` is off, there is one PENDING anchor
   (`ARK-DOC-BYZYMC`, created 2026-08-19T19:51:01Z — a **day** pre-clock) and two organizations.
9. **Duty cycle.** 172 of 268 elapsed minutes had zero requests; the 16:00Z hour had literally
   none. 32.5% of minutes carried ≥10 req/min.

### Clock integrity under FD-CLOCK-1

**INTACT, with two caveats.** Revision creation matches the declared start to the second; single
revision, single instance, no terminations, no ERROR-severity entries. Caveat one: the "zero
service-attributable 5xx" condition is being met by reclassification, and any automated 5xx-rate
check will trip on a 10.6% error rate. Caveat two — the **soak-integrity hazard**: `SUPABASE_URL`
is bound to secret `supabase-url-staging` at key `latest` (a shared secret name, currently v2).
A rotation mid-window silently repoints the soak's database with **no new revision**, and a
revision-creationTimestamp clock cannot detect it. The clock is intact; what it is counting is
the problem.

### Remediation

1. **Fix the RC manifest before it goes anywhere near the gate.** `soak.evidence_links[1]` names
   `docs/staging/migration-t3-soak-2026-08/load-harness-launch-evidence.json`, which exists
   neither on disk nor in git — verified this session. Either capture that artifact or remove the
   link. A merge-grade manifest citing a file written from a plan rather than captured is the
   exact failure mode the gate exists to catch.
2. **Fix the exact-head binding on #2248.** `git merge-base --is-ancestor 1888515e0666c26e49f0ac7e207660fa53a77512 3baf16015…`
   returns false — the manifest's gate-facing `included_prs[2].head_sha` names a commit that was
   never built or served. The manifest discloses `head_sha_soaked=c993e81cd…` with a residual-risk
   note and the delta is docs-only, **but one of those files is `CLAUDE.md`**, which §8 explicitly
   carves out of the docs fast path, and it landed at 14:45:01Z — 45 min after clock start.
3. **Authenticate the load, or nothing else matters.** Mint a rig API key and pass it:
   ```
   # in scratchpad/soak-load/relaunch-wave-load.sh, run_migration():
   STAGING_API_KEY="$(cat ~/.arkova-soak/migration-api-key)" \
   npm run staging:load -- --mode mixed --duration 25 --evidence-out <abs-path-outside-worktree>
   ```
   matching what `run_one()` already does for wave2.
4. **Add the two missing crons** to `scripts/staging/load-harness.ts:447-451`:
   `'/jobs/cleanup-retention'` and `'/jobs/refresh-stats'`. Without this, #2235's two headline
   migrations are unreachable for the entire remaining 43h — no amount of clock fixes it.
5. **Give 0411 something to time out on.** Seed `audit_events` rows older than the 2-year purge
   horizon so the DELETE is non-trivial, then hold a conflicting lock across a cleanup-retention
   firing (`SELECT … FOR SHARE` or an idle-in-transaction reader on `audit_events`). Assert
   `audit_events_purge_skipped=true` and `audit_events_deleted=-1` in the RPC response **and** that
   `reject_audit_delete` still exists afterward — the subtransaction-rollback guarantee is the
   correctness claim.
6. **Give 0412 a reason to distrust the estimate.** Insert rows without ANALYZE so
   `reltuples < counted buckets` (expect `total_source='exact'`), and exercise the
   `reltuples = -1` never-analysed branch on a rebuilt table. Then fire `/jobs/refresh-stats` and
   assert `total_source` flips.
7. **Turn `ENABLE_PARTNER_PROVISIONING` on and leave it on**, then drive an authenticated
   request → list → detail → approve/reject/cancel/provision sequence and assert
   `partner_accounts` rows land (currently 0 live).
8. **Insert an `ENABLE_VERIFICATION_API=true` row** into `switchboard_flags`, or accept that ~7%
   of load is being spent on a 503-dark API and that the "zero 5xx" condition is unverifiable.
9. **Drop the rate below the anon cap or run authenticated.** ~124 req/min from one IP against a
   documented 100 req/min anon budget (§1.10) means the harness is benchmarking the rate limiter.
10. **Set the three webhook secrets or remove those providers from the harness set** — 507
    self-inflicted 503s at ERROR severity will contaminate any 5xx-based integrity assertion.
11. **Pin `SUPABASE_URL` to secret version 2 explicitly** instead of `latest`, on the next deploy.
12. **Log the `switchboard_flags.updated_at` defect** — 4 physical updates, `updated_at` frozen at
    insert. Small, real, and it is what made the auditor's "never flipped true" inference look sound.
13. **Restate the clock honestly.** The window's useful evidence landed *before* the clock started
    (migration applies, rollback rehearsals, the 13:42Z manual ANALYZE, the 13:49Z cache refresh)
    or in its first 15 minutes. Once the driver is fixed, consider restarting the 48h from the
    moment the changed paths first become reachable. Prod ledger head is still 0409, so nothing has
    shipped — this is catchable.

---

## 3. wave2 — T2, 12h

**Service** `arkova-worker-wave2-2026-08-staging` · **revision** `00001-qir` (tag `train-w2`) ·
**rig** `tkciooifwxwnkoizgalp` · **union head** `6ace61c37370028581bd82e935b6c0bec627bc44` ·
**PRs** #2258, #2270, #2254, #2233, #2267, #2245, #2211

### Verdict: HOLLOW_UPTIME_ONLY

**Override stated:** the auditor graded PARTIALLY_HOLLOW, resting partly on #2270 being
"exercised: true". **I am overriding in favour of the refuter**, and I verified the decisive
point myself: `PROD_SERVICE_NAME`, `resolveSentryEnvironment` and the
`[Sentry] Initialized for ${environment}` log all exist verbatim at base commit `6b4847c0b`. The
union diff never touches them — it only *references* `PROD_SERVICE_NAME` inside the new
`shouldSendCronCheckIns`. The startup line the auditor called "provably live … exactly the PR's
intent" prints identically without PR #2270. That is a specific, primary refutation of the
auditor's strongest positive, and with it removed the grade drops.

### What the window genuinely evidences

- **Uptime on one revision.** Exactly one revision exists; creation 2026-08-20T15:51:57.878019Z
  matches the service's own creation and the declared start; service `generation: 1`; single
  traffic entry at 100% under tag `train-w2`; Ready/ConfigurationsReady/RoutesReady True since
  15:53:15Z. Live `/health` returns `git_sha` equal to the union head exactly. Zero container
  terminations; two instance starts only (15:53:00 DEPLOYMENT_ROLLOUT, 17:59:53 AUTOSCALING).
- **FD-CLOCK-1 applied correctly.** `/health` reports `uptime: 1409` at 18:23Z — that is the
  17:59:53Z autoscaling instance with the revision unchanged. A routine recycle, not a reset.
- **#2211, partially and once.** Clean negative/positive pairs: `/api/v1/org/verify-ein`
  16:12:18.216Z → 403 (ORG_MEMBER) then 16:12:19.004Z → 200 (ORG_ADMIN); `/api/v1/org/confirm-domain`
  16:13:04.950Z → 403 then 16:13:05.507Z → 200. Corroborated in the rig DB: `ORG_EIN_SUBMITTED`
  @16:12:19.661, `EMAIL_SENT` @16:12:45.793, `ORG_VERIFIED` @16:13:06.020, all with `actor_id` set.
- **#2233, partially and once.** `/jobs/fetch-uspto` 502 at 16:03:21 is genuinely the PR's
  `total_failure` branch. `public_records` holds 20 rows with `min(created_at) = max(created_at) =
  16:03:08.279089Z` — a single instant.

### What it does NOT evidence — never claim these

1. **Anything after 17:22:26Z.** Census: not one request to any route outside the fixed harness
   rotation after that timestamp. **The remaining ~9.4h of the 12h window is provably incapable of
   adding evidence for any of the 7 PRs.**
2. **#2270.** The only new code that runs is `shouldSendCronCheckIns()` returning false ~64 times.
   Its positive branch (`kService === 'arkova-worker'`) is structurally unreachable on this rig and
   the `ENABLE_SENTRY_CRON_CHECKINS` escape hatch is unset. The negative assertion has **no
   positive control**: zero Sentry events of any kind from this environment over 24h, so "no cron
   check-ins" is confounded with "cannot deliver to Sentry at all."
3. **#2258.** Zero Sentry events → `scrubExtraValue`/`scrubExtraString` (+144 lines) have never
   executed. The union's own `sentry-extra-scrub.test.ts` is the only thing that has ever run them.
4. **#2233's full contract.** Only 3 of 6 documented rows in `ingestionResponse.ts` ran. The
   16:01:56.758Z 503 on `/jobs/fetch-state-bills` is the **`flag_not_configured`** branch — 
   `ENABLE_PUBLIC_RECORDS_INGESTION` was not inserted until 16:02:23.374970Z — not the headline
   ingestion-failure branch. Zero 207 `partial_failure` in the entire 3,662-row non-429 census;
   no `200 disabled`; no `503 flag_unreadable`. `federalRegisterFetcher.ts`: zero requests, ever.
5. **#2211's full surface.** `/api/v1/org/verify-domain` received exactly one request (200) and
   **never got a 403** — only 2 of the 3 newly gated routes got a negative branch. `MAX_EIN_LENGTH`
   (5–32) never fired: zero 400s window-wide. The documented 500-vs-403 error split never fired:
   zero 500s.
6. **#2254.** One `/jobs/db-health` 200 at 15:59:28, against a DB that was still empty
   (`public_records` 16:03:08, `audit_events` 16:12:19, `api_keys` 17:22:00) — old condition
   (`ratio>0.5`) and new condition (`deadTuples>=500 && ratio>0.5`) both evaluated false, so the
   single invocation was **non-discriminating even in principle**. Meanwhile the rig has since
   drifted into exactly the discriminating state — `job_queue n_live_tup=2 / n_dead_tup=40`
   (ratio 20.0, dead < 500) and `anchors` ratio 1.00 — where old code pages and new code
   suppresses. And `/jobs/db-health` will never be called again: it is not in the rotation.
7. **#2267.** `truncateUtf16Safe` has zero live invocations. All 8 non-test call sites sit on
   paths with no traffic and no rows: `webhook_delivery_logs`=0, `webhook_endpoints`=0, DLQ=0,
   `job_queue` rows with non-empty `last_error`=0, zero requests to webhooks self-service,
   compliance-audit or credentials/ctdl, and Nessie is off by standing directive.
8. **#2245.** `integrations/oauth/drive.ts` has never executed. `org_integrations`=0,
   `member_integrations`=0, `connector_subscriptions`=0, `drive_webhook_nonces`=0,
   `integration_events`=0 — no Google account is linked, so the narrowed scope list is never
   emitted. The 19 × 503 on `/api/v1/webhooks/drive` are the webhook **receiver**, a different
   surface entirely.
9. **"Volume is high and rising."** Ten-minute bucketing shows a ~30-minute total dead zone
   (17:29:50Z–17:59:50Z: 17:30 bucket = 3 requests, 17:40 = 0, 17:50 = 1), and traffic stopped
   again at 18:27:26.998Z. The 429 mass (18,848 of 22,295, 84.54%) is an artifact of **four
   duplicate harness cycles** (17:59:50, 18:00:46, 18:01:42, 18:02:23) racing one 60 req/min
   per-IP limiter, not load.
10. **The 165 cron 200s as coverage.** All five rotation endpoints no-op
    (`Batch anchoring disabled (ENABLE_BATCH_ANCHORING off)`, `Revocation processing disabled via
    switchboard flag`, zero SUBMITTED anchors since 15:56:01, zero rule events/executions), and
    only 2 of the 5 (`check-confirmations`, `process-revocations`) even reach `withCronMonitoring`.
11. **That the minted API key bought anything.** `READ_PATHS` is hardcoded to
    `/api/v1/verify/STG-ANC-DEADBEEF` and `/api/v1/anchors/STG-ANC-DEADBEEF` — a nonexistent
    anchor. Every keyed read 404s (978 of them); `reads: {ok: 0, fail: 1247, errorRate: 1}` in the
    harness's own committed artifact. The 503→404 flip was caused by the **flag insert at
    17:20:38Z**, not the key at 17:22:00Z — proven by 13 logged 404s between 17:20:55Z and
    17:22:00Z with no API key in existence. The rig's one real anchor (`ARK-DOC-E5NTRD`, PENDING)
    is never read.

### Clock integrity under FD-CLOCK-1

**INTACT on the revision axis, with two amendments that must be recorded, not absorbed.**
Revision unchanged, 100% traffic, no terminations, health green, and the low `/health` uptime is
a correctly-diagnosed recycle. But: (a) **1,705 × 503 + 1 × 502** sit inside the window — ~844
pre-17:20:38Z from `verificationApiGate` failing closed on incomplete rig seeding, ~860 from
webhook handlers rejecting on unset provider secrets, and **one unattributed 502 on
`/jobs/fetch-uspto` at 16:03:21.226Z with no corresponding application log** — chase it rather
than waving it through. (b) **Mid-window state mutation:** `INSERT` into `switchboard_flags` at
17:20:38.038598Z materially changed served behavior across the entire `/api/v1` surface, and
`ENABLE_PUBLIC_RECORDS_INGESTION` at 16:02:23Z immediately preceded the one-shot ingestion driver.
No revision or traffic change, so the clock survives — but **the effective start for any `/api/v1`
evidence claim is 2026-08-20T17:20:38Z, not 15:51:57Z.**

### Remediation

1. **Point the reads at a real anchor** — one line, client-side, no rig write, no redeploy:
   ```
   STAGING_READ_PATHS=/api/v1/verify/ARK-DOC-E5NTRD,/api/v1/anchors/ARK-DOC-E5NTRD
   ```
   in the relauncher's env for the wave2 `run_one` call. Converts 100% of authenticated reads from
   404 misses into real serialization of a real anchor row.
2. **Kill the 401-by-design events flood or credential it.** `events` at 100/min unauthenticated
   generates ~85% of all traffic as 429 and starves the one useful mode via the shared per-IP
   limiter. Either drop `events` from `--mode mixed` for this rig or drive it with a real Supabase
   session JWT.
3. **Add a pidfile guard to `relaunch-wave-load.sh`** so a cycle no-ops when a previous wave2
   harness is still alive. `StartInterval=1800` with `--duration 25` plus four launches in three
   minutes yields overlapping instances that add 429s, not coverage.
4. **Make the crons do something or stop counting their 200s.** Seed the preconditions (submit
   anchors via `POST /api/v1/anchor` as chain-pair's driver already does; enable the flags), or
   record explicitly that the 165 × 200 are liveness pokes.
5. **Put #2254's two endpoints into the rotation** — `/jobs/pipeline-throughput-monitor` and
   `/jobs/db-health` at the 5-minute cadence. The discriminating data now exists
   (`job_queue` ratio 20.0 with dead < 500); the endpoint is simply never called. Assert which way
   the new floor decides.
6. **Generate real work for #2267 and #2233.** Enqueue a job that fails with a long-unicode
   `last_error`, or register a webhook endpoint and force a delivery; and put
   `/jobs/fetch-state-bills`, `/jobs/fetch-uspto` **and** `/jobs/fetch-federal-register` on a
   repeating cadence so the non-200 contract fires more than once — and so a 207 `partial_failure`
   can occur at all.
7. **#2258 needs one deliberate Sentry capture.** Trigger a controlled error carrying a nested
   `extra` payload with a sensitive key and a long unicode string, read it back in Sentry, confirm
   `[FILTERED]` at depth. That single event is worth more than the remaining 9.4 hours.
8. **#2245 is unexercisable on this rig as built.** Either complete a real Drive OAuth authorize
   round-trip, or record an explicit Carson-approved residual-risk note that its runtime behavior
   is unit-test-covered only. Do not let 19 × 503 on the unrelated receiver stand in for it.
9. **Correct the evidence block's three claims:** effective `/api/v1` start = 17:20:38Z;
   the "reads flips to fully authenticated" line overstates an observable delta that does not exist
   (404 before and after the key); and disclose that all reads target the nonexistent
   `STG-ANC-DEADBEEF` with `errorRate: 1.0`. The doc is otherwise commendably honest — it already
   refuses to retroactively upgrade the pre-key cycles — so these are corrections, not an indictment.
10. **Attribute the 5xx honestly** rather than asserting "zero service-attributable 5xx", and chase
    the 16:03:21 502 specifically.
11. **File the `api_key_usage.request_count` defect separately.** Counter reads 1 while
    `last_request_at` advances and `pg_stat` shows 512 updates to the row. Unrelated to the 7 PRs,
    but API-key usage metering on this build looks broken.
12. **Whether the window restarts is an RTE/Carson call.** Nothing mechanically forces it. But if
    the fixes above land they change what the rig serves, and the honest move is to restate the
    clock from the last behavioral change rather than claim 12h of coverage for behavior that
    started being exercised in hour 3.

---

## 4. wave3 — T2, 12h

**Service** `arkova-worker-wave3-2026-08-staging` · **revision** `00004-cjk` (no tag, dedicated
service) · **rig** `jiotjhqmedkajdsojsbn` · **union head** `25465f5da` · **11 PRs across 8
logical changes**

### Verdict: PARTIALLY_HOLLOW

**No override.** The refuter attempted refutation and **could not** show this soak is materially
more hollow — it explicitly upheld the grade. But it corrected the auditor in **both** directions,
and those corrections matter more than the label:

- **Too harsh, twice.** The auditor read source from the working tree, which is on
  `soak/day0-fullsoak-2026-08-docs` and does **not** contain union head `25465f5da`
  (`git branch --contains` returns only `rc/wave3-2026-08`). Its citation for #2246
  (`anchor-evidence.ts:81`) is a doc-comment on an unrelated interface in a file the union never
  touches. The caveat is actually emitted from `buildVerificationResult()` in `verify.ts`, keyed
  on `resolveConnectorFetchSource(row.metadata)` — and `ARK-WAVE3-CONN01` carries
  `metadata.connector_source = "docusign"`, which is in `CONNECTOR_FETCH_SOURCE_MARKERS`.
- **Too lenient, once, and it is the material finding.** "Container termination/SIGTERM/OOM
  patterns since clock start: zero results" is **false** — verified this session. The auditor
  searched `textPayload` for messages that are structured `jsonPayload.msg`. A stated clock-integrity
  condition was certified without being tested.

### What the window genuinely evidences

- **#2246, 317 times.** In-window `VERIFICATION_QUERIED` audit rows = 317, exactly equal to the
  317 HTTP-200 `/api/v1/verify/ARK-WAVE3-CONN01` requests, so every request ran the full handler.
  The Redis verify cache is inert (no `UPSTASH_REDIS_REST_URL`/`TOKEN` on the service), so
  `getCachedVerification` returns null and `buildVerificationResult` re-runs each time. **This is
  the strongest single per-PR result across all four soaks.**
- **#2232's BUG-024 half, 191 times.** The union mounts `proofKeysRouter`
  (`app.use(apiIpShadowGuard, didWebRouter, proofKeysRouter)`); `/.well-known/arkova-keys.json`
  took 191 in-window HTTP-200s on a route that 404'd before the fix.
- **#2276, for 10m13s, and it found a real defect.** Three fires (16:40:33Z, 16:45:42Z, 16:50:44Z)
  each wrote `PLATFORM_HEALTH_DIGEST_SENT` → `EMAIL_DELIVERY_FAILED` ('RESEND_API_KEY not
  configured') → `PLATFORM_HEALTH_DIGEST_FAILED`, `attempts` 1→2→3, each with WARN
  `platform health digest reservation release failed` carrying Postgres **23514 'Audit events are
  immutable. DELETE operations are not allowed.'** Then it **wedged** — fires 4–10 wrote nothing.
  Root cause is real: `releaseDelivery()` in `platform-health-digest-cron.ts:445-455` releases its
  reservation via `audit_events.delete()` against an append-only table. This is the identical bug
  `0348_scrum2353_webhook_event_claims.sql` exists to fix for `billing_events`, whose header states
  the DELETE "ALWAYS fails in prod". **One transient send failure permanently loses that day's
  digest.** (The auditor located it in `queue-digest-cron.ts:236-245`; both files carry the bug,
  only the platform-health one fired.)
- **Clock stability.** Revision creation 2026-08-20T16:40:21.746594Z matches the declared start;
  `latestCreated == latestReady`; 100% traffic; zero 5xx in-window; zero severity≥ERROR.

### What it does NOT evidence — never claim these

1. **Anything after 17:30:37Z.** Load ran 16:40:31Z→17:30:37Z (50.1 min) at ~30.5 req/min, then
   stopped dead: 6 requests in the following 45 minutes, and zero since 18:02:26Z. **45 minutes of
   load in a 12-hour window**, and the driver cannot restart itself.
2. **#2272.** 9 in-window fires, every one `{sent:0, alreadySent:1, skippedEmpty:1, failed:0}` — it
   resolved 2 admins, found the day's marker already set, found the queue empty, sent nothing. Zero
   in-window `QUEUE_DIGEST_*` audit rows. The only `QUEUE_DIGEST_SENT`/`FAILED` pair in the entire
   database is 16:39:18.96Z/16:39:19.25Z — **62 seconds pre-clock**, on revision 00001, and it
   failed on `RESEND_API_KEY not configured`. Its entire in-window behavior is the "already sent
   today" short-circuit determined by pre-clock state.
3. **#2232's MCP-audit-P0 half.** Exactly one `MCP_TOOL_CALL` row, 16:41:53.77Z, from a direct
   script invocation; zero MCP HTTP requests all window. And that row carries `api_key_id: null`
   and `ip_hash: null` — it does not demonstrate *attributed* MCP auditing, which is the substance
   of the P0.
4. **#2220.** `api_keys` holds 1 row with `revoked_at = 16:36:08.73Z` — **4m13s pre-clock**. Zero
   in-window `/api/v1/keys` requests. The two pre-clock 503s at 16:28:15Z and 16:29:10Z sit on this
   PR's own surface and are undocumented in the evidence JSON.
5. **#2252/#2274 (SDK).** Deploy nothing to Cloud Run; uptime on this rig is structurally incapable
   of exercising them. These need the documented §1.12 Carson exception, not a worker clock.
6. **#2230→#2236 (7 stacked Drive deny-reason PRs).** Zero signal. Every connector table empty:
   `connector_artifact` 0, `connector_subscriptions` 0, `drive_revision_ledger` 0,
   `drive_watch_state` 0, `drive_webhook_nonces` 0, `connector_alert_state` 0; zero requests to any
   Drive or connector route.
7. **"Fail = 0" and "no 5xx observed" as written.** `wave3-load-loop.sh:71-78` counts any
   `200 <= code < 500` as ok, so all 47–50 edge-rejected 401s were counted as **successes**. And
   `soak-load-chunk1-20260820.json`'s `zeroFailures` field asserts "no 5xx observed" over a
   16:24–17:31Z window that provably contains two 503s (16:28:15Z, 16:29:10Z on
   `/api/v1/keys/…`). Re-running that exact window returns 1,484×200 / 50×401 / 4×403 / **2×503**
   = 1,540, not the JSON's 1,482/49/4 = 1,535 — and 1,535 is in fact the count for a *different*
   window (16:40:21Z→18:09Z). Its `cronDetail` prose ("continuously exercising #2272's and #2276's
   … role-resolution and opt-out logic … for the full duration") is contradicted by the rig's own
   audit rows.
8. **A clean log.** 50 in-window node-cron "missed execution" WARNs starting 16:44:12Z — *during*
   the load chunk, not after it — plus an 18:06:29Z `Supabase read transport failure — retrying
   once on a fresh socket (WH-1 / ARKOVA-WORKER-C)` that retried and so produced no 5xx.
   "Zero 5xx / zero ERROR" is technically true and materially overstates cleanliness.

### Clock integrity under FD-CLOCK-1

**INTACT — and it should not be restarted.** Revision `00004-cjk` unchanged at 100% traffic since
16:40:21.746594Z; zero in-window 5xx; zero severity≥ERROR. The three in-window shutdowns on the
head (17:50:52Z, 18:06:50Z, 18:17:42Z) are **clean drains** — `activeOps` 0/2/0, each followed
within milliseconds by `HTTP server closed — all connections drained`, with AUTOSCALING starts at
18:01:45Z and 18:02:26Z. Under FD-CLOCK-1 those are routine recycles on a min-instances service,
not resets. The conclusion survives; **the method did not** — record in the evidence pack that the
termination condition was re-tested on `jsonPayload.msg` and found three benign recycles, rather
than repeating an untested "zero terminations."

### Remediation

1. **Fix the driver first — nothing else matters until load flows.** `run_wave3()` in
   `relaunch-wave-load.sh` passes only `WAVE3_BASE_URL` and `DURATION_MIN`, while
   `wave3-load-loop.sh:26-30` hard-requires **four** vars via `:?` and reads a differently-named
   duration. Observed failures: `18:02:00Z line 26: WAVE3_BASE_URL: set WAVE3_BASE_URL` rc=1, then
   `18:02:38Z line 27: WAVE3_IDTOKEN_FILE: set WAVE3_IDTOKEN_FILE` rc=1. It will keep dying at
   line 27 every 30 minutes for ~20 more cycles. Pass all four, and rename the duration:
   ```
   WAVE3_BASE_URL="$WAVE3_BASE"
   WAVE3_IDTOKEN_FILE="$HOME/.arkova-soak/wave3-idtoken"      # loop refreshes gcloud auth print-identity-token --audiences=$BASE into it
   WAVE3_CRON_SECRET_FILE="$HOME/.arkova-soak/wave3-cron-secret"   # mode 0600
   WAVE3_EVIDENCE_OUT="$HOME/arkova-soak-evidence/wave3-load-$(date -u +%Y%m%dT%H%M%SZ).json"
   WAVE3_DURATION_SEC=1500
   ```
   `WAVE3_EVIDENCE_OUT` **must** be an absolute path outside the git worktree — a branch switch
   deleting `docs/staging/wave3-2026-08/` out from under the running process is the literal cause
   of the chunk-1 reconstruction incident.
2. **Make the counter honest and the artifact incremental.** Treat any non-2xx as fail (or drop the
   bare "fail=0" headline), carry `status_200` / `status_other_2xx_4xx` through into every summary,
   and write the evidence JSON append-per-minute so a mid-run death degrades to partial real data
   instead of requiring reconstruction from stderr.
3. **Correct `soak-load-chunk1-20260820.json` in place.** The 16:24–17:31Z window is
   1,484/50/4/2×503 = 1,540; strike or scope "no 5xx observed"; state that ~3% of requests were
   edge-401s that never reached the container; soften `cronDetail` to the observed truth (#2276
   wedged after 3 attempts, #2272 no-op'd on all 9); and fix `startedAt`/`endedAt`, which are
   stated as 16:46:03Z/17:31:03Z against a log showing 16:45:40Z and a last request at 17:30:37Z.
   Its self-labelling as a reconstruction is correct and should stay — it is the arithmetic and
   characterisation that fail, not the disclosure.
4. **Set `RESEND_API_KEY` on the rig** (or inject a capturing mail stub). Without it #2272 and
   #2276 can only ever produce failure-path evidence.
5. **File the #2276 reservation-release defect as a real bug.** Apply the 0348 pattern: move the
   digest's idempotency reservation off append-only `audit_events` onto a mutable claims table with
   the same uniqueness, and write the immutable audit row only on success. Note both markers are
   stuck for `digest_date 2026-08-20` and cannot self-clear; `digestDate` rolls at
   2026-08-21T00:00Z (inside the window) but nothing will POST the cron routes by then.
6. **#2272: seed a non-empty queue and clear the day's `alreadySent` marker** before the next
   window so the send path actually runs in-window.
7. **#2232: add a periodic authenticated MCP tool call** to the load mix and assert the audit row
   carries non-null `api_key_id` and `ip_hash`.
8. **#2246: keep it, and extend it.** 317 executions is real. Seed at least one materialized
   `anchor_proofs` row (currently 0) and add `GET /api/v1/anchors/:id/evidence` to the route mix so
   the proof-derived surface is covered too.
9. **#2220: add an in-window create → use → revoke → use-after-revoke cycle**, and explain the two
   pre-clock 503s on `/api/v1/keys/…`.
10. **#2230→#2236: seed connector fixtures and drive deny-reason requests, or route all seven for
    an explicit §1.12 residual-risk decision.** Do not let them ride the wave3 clock as if covered.
11. **#2252/#2274: stop counting SDK PRs against a worker soak** at all.
12. **Do NOT restart the clock.** Fix the driver, let the remaining ~10h run with real load, and
    disclose the exact idle span (16:40:21Z–17:30:37Z carried load; 17:30:37Z–<driver-fix> carried
    none) rather than averaging it away.

---

## Cross-cutting findings

1. **Three of four rigs are measuring their own rate limiter, not their code.** chain-pair: 19 of
   ~13,219 requests can reach rate-limit middleware. migration-t3: 84.9% 429. wave2: 84.54% 429.
   All three drive from a single IP (`187.14.236.159`) against a per-IP anon cap. Either
   authenticate the load or drop below the cap — as configured, offered load and useful work are
   inversely related.
2. **`load-harness.ts` hardcodes its targets and cannot reach most changed code.** `READ_PATHS`
   points at a nonexistent `STG-ANC-DEADBEEF`; `CRON_ENDPOINTS` (lines 447-451) is a fixed
   five-entry list that omits every cron the PRs under soak actually change. This one file is the
   proximate cause of hollowness on two of the four rigs.
3. **Evidence artifacts are drifting from what the systems did.** A merge-grade RC manifest cites a
   file that does not exist (migration-t3); a soak JSON asserts "no 5xx" over a window containing
   two, and reports a total belonging to a different window (wave3); a soak doc claims a
   authentication "flip" whose observable HTTP outcome never changed (wave2). None of these are
   fabrication in bad faith and two are explicitly self-labelled — but the gate reads the artifact,
   not the intent.
4. **Two clock-integrity conditions were certified without being tested.** chain-pair asserted
   "health green" against 312 live alerts; wave3 asserted "zero terminations" from a `textPayload`
   query that cannot see `jsonPayload.msg`. FD-CLOCK-1's conditions need *queries*, not adjectives —
   suggest adding the exact query for each of the four conditions to the FD-CLOCK-1 doc.
5. **Cross-version co-execution is not visible in an HTTP-status census.** chain-pair's five stale
   revisions served zero HTTP traffic and were therefore invisible to every request-log check, while
   running their own crons against the shared rig DB and treasury. Any future soak stand-up should
   assert `gcloud logging read … | group by revision_name` returns **only** the head, for the whole
   window — not just that traffic is 100% to the head.

---

_Audited read-only 2026-08-20T18:20Z–18:45Z. Verdicts: chain-pair HOLLOW_UPTIME_ONLY (override to
refuter, primary evidence re-verified); migration-t3 HOLLOW_UPTIME_ONLY (both agree, refuter's
severity carried); wave2 HOLLOW_UPTIME_ONLY (override to refuter, base-code refutation re-verified);
wave3 PARTIALLY_HOLLOW (refutation attempted and failed; corrections carried in both directions)._

# Chain-pair T3 soak — standup + Day-0 evidence

**Rig: `fullsoak-2026-08` (Supabase `gnkuaywlpmsaezwvlvhk` + Cloud Run
`arkova-worker-fullsoak-2026-08-staging` + bitcoind signet VM
`arkova-s33-rig-b1-bitcoin-core-signet`).** The 7-day SOC2 window that had this
rig FROZEN closed on schedule at 2026-08-19T15:51:30Z
(`docs/staging/fullsoak-2026-08/window-close-2026-08-19.md`,
`docs/staging/fullsoak-2026-08/FINAL-REPORT-2026-08-19.md`). Standup below is
**founder-directed** ("get the new soaks going") — the rig is explicitly
approved for reuse, not a freeze violation.

**Union under soak, mid-standup scope extension:** originally PR #2216 + PR
#2250 (the chain pair). A coordinator instruction mid-session folded PR #2269
(rate-limit cluster, T2) into the same window because the shared staging
project (`ujtlwnoqfhtitcmsnrpq`) it was slated for no longer exists — see
"Scope extension" below. All three PRs are disjoint at the file level (verified,
not assumed) and merge cleanly.

## PRs in this soak

| PR | Branch | Head SHA | Base SHA | Tier | Migration |
|---|---|---|---|---|---|
| [#2216](https://github.com/carson-see/ArkovaCarson/pull/2216) | `claude/intelligent-galileo-a5e54d` | `a664ee847f0efe531a7d2b39747290f694980da9` | `49358d607b47217cfe81caf44d17b5e4a595cc88` | T3 | none |
| [#2250](https://github.com/carson-see/ArkovaCarson/pull/2250) | `fix/fd-chain-1-listunspent-empty-fallback` | `3d8851463e3f81b88ff3f65cccef777c0fa7a51c` | `2283d64054bc22c680f37b57b18c6da63169f628` | T3 | none |
| [#2269](https://github.com/carson-see/ArkovaCarson/pull/2269) | `rc/rate-limit-cluster-2026-08` | `fadc04c927ee4c41966d87bf86c969931b02c97e` | `main` (`f374aca97`) | T2 | none |

None of the three touches `supabase/migrations/`, RLS, or schema — confirmed
by each PR's own body ("Migration applied: none") and by the file lists pulled
via `gh pr view --json files` before merging.

## Union branch

`rc/chain-pair-soak-2026-08`, created from `origin/main` at
`f374aca97df8f569989775347e35f4c5162d3605`, pushed to origin.

Merge order (all clean, zero conflicts — `git merge --no-edit`, ORT strategy):

1. `f374aca97` (main)
2. `+ #2216` → `7c710f7f3`
3. `+ #2250` → `d3a99672a899ff057a613ab5cae66303c4ef5347` (2-PR union head)
4. `+ #2269` → `daf3d6056788762ba56da5c328154e50fce03b59` (**final 3-PR union head**)

**Final union head: `daf3d6056788762ba56da5c328154e50fce03b59`.**

#2216 and #2250 both touch `services/worker/src/chain/utxo-provider.ts` on
non-overlapping hunks (each PR's body says so and names the other); #2269
touches only rate-limit/upstash/middleware/`index.ts`/`sentry.ts` — zero
overlap with the chain files. Verified by diffstat and by the merges
themselves landing with no conflict markers.

## Verification (before building the image)

Repo's own convention for this worktree: `tsc`/`vitest` carry a large
pre-existing baseline (missing optional deps, shallow clone) — never read
absolute counts, always set-diff against a same-environment baseline.

### Typecheck

| Comparison | Result |
|---|---|
| 2-PR union (`d3a99672a`) vs `origin/main` baseline | 1585 lines both sides. Exactly 1 line differs each direction — the same pre-existing `signet.test.ts` implicit-`any` (TS7006) error, shifted from line 1295 to 1362 because #2250 adds 67 lines above it. **0 new errors.** |
| 3-PR union (`daf3d605`) vs #2269's own branch alone | Both **1624** lines. Set-diff: 1 new (the same signet.test.ts shift, expected — #2269 alone doesn't carry the chain PRs), 1 fixed (the pre-shift line). **0 net new beyond the known shift.** The extra ~39 lines vs the 2-PR union are `@types/express` / `supertest` missing-devDependency errors already present on #2269's branch by itself — not introduced by this merge (confirmed by running `tsc` on `origin/rc/rate-limit-cluster-2026-08` in isolation, which independently produces the same 1624 lines). |

### Lint

`npm run lint` (services/worker, the exact command `deploy-worker.yml` and
`ci.yml`'s deploy-gate-parity job both run per CLAUDE.md §0 rule 9) — **clean**
on both the 2-PR and 3-PR union heads.

### Test sweep

Targeted the changed surfaces: `src/chain/`, `src/jobs/`,
`src/utils/body-read-timeout.test.ts` (chain pair) plus `src/utils/rateLimit*`,
`src/utils/upstashRateLimit*`, `src/utils/verifyCache*`,
`src/utils/environmentNamespace*`, `src/middleware/upstashIdempotency*`,
`src/api/v2/rateLimit.test.ts`, `src/rateLimitDoubleMount.test.ts`
(rate-limit cluster).

| Run | Total | Passed | Failed | Skipped |
|---|---|---|---|---|
| `origin/main` baseline (chain+jobs dirs only) | 1760 | 1734 | 14 | 12 |
| 2-PR union (same dirs) | 1814 | 1788 | 14 | 12 |
| 3-PR union (chain+jobs+rate-limit dirs) | 1895 | 1869 | 14 | 12 |

**The same 14 failures on every run**, byte-identical test names each time —
all pre-existing missing-optional-dependency failures in this worktree
(`bitcoinjs-lib`, `@sentry/node`, `unzipper` not installed):
`confirmation-proof-backfill.test.ts` (×4), `n-plus-one-cleanup.test.ts` (×1),
`publicRecordAnchor-load.test.ts` (×3), `publicRecordAnchor-revert-in-filter.test.ts`
(×1), `usptoFetcher.test.ts` (×5). **Zero new failures. Zero rate-limit/upstash
test failures.** The +81 new-passing tests going from the 2-PR to 3-PR run are
#2269's own new suites (`upstashRateLimit.circuitBreaker.test.ts`,
`.consolidated.test.ts`, `.distributed.test.ts`, `.namespace.test.ts`,
`environmentNamespace.test.ts`, `verifyCache.namespace.test.ts`,
`upstashIdempotency.namespace.test.ts`, `rateLimitDoubleMount.test.ts`,
`api/v2/rateLimit.test.ts`), all passing.

## Image + deploy

Built via `gcloud builds submit` (Cloud Build workers are linux/amd64 by
default — no cross-arch step needed), tagged with the full 40-char union head
SHA.

| Build | Cloud Build ID | Status | Image digest |
|---|---|---|---|
| 2-PR union | `473ccea2-239a-4046-877a-202233bf6354` | SUCCESS | `sha256:63045be1735c012c85cf7f217b9eb026f64c6e2389c754ab0549563b28203eb9` |
| **3-PR union (final)** | `325b791a-f0a0-4653-801e-596e4a467264` | SUCCESS | **`sha256:d7a956079729b080a2e654f8014c9fbd270dbfc4392b1000e1a4e0630157ea45`** |

Deployed via `gcloud run deploy` directly against
`arkova-worker-fullsoak-2026-08-staging` (region `us-central1`, project
`arkova1`) — not `scripts/staging/deploy.sh`, which is hard-scoped to the
shared `arkova-worker-staging` service and whose lease table lives in a
different (now-defunct, per the scope-extension note) Supabase project. Same
deviation precedent as `docs/staging/rc-manifests/rc-t2-worker-batch-20260726.json`.

Revision history this session (all same service, chronological):

| Revision | Tag | Purpose | Created |
|---|---|---|---|
| `-00013-mrw` | — | prior frozen 7-day-soak revision | 2026-08-12 (pre-existing) |
| `-00017-soz` | `cp0819` | 2-PR union, first deploy | 2026-08-19T16:24:03Z |
| `-00018-wes` | `cp0819v2` | 3-PR union + real Upstash secrets + `min-instances=2` | 2026-08-19T16:36Z |
| `-00019-bek` | `rmsec1` | transitional (dropped secret-type binding on `UPSTASH_REDIS_REST_URL` so it could be re-set as a plain literal — gcloud refuses to flip a var's type in one `--update-env-vars` call) | 2026-08-19T16:42:12Z |
| `-00020-gag` | `cp0819bh` | **deliberate Upstash-blackhole window** (see below) | 2026-08-19T16:42:20Z |
| `-00021-jah` | `rmenv1` | transitional (dropped the plain-literal `UPSTASH_REDIS_REST_URL` env var so it could be re-bound as a secret — same gcloud type-flip limitation as `-00019`) | 2026-08-19T16:51:04Z |
| **`-00022-suy`** | **`cp0819rc`** | real Upstash secrets restored, `min-instances=2` preserved — **this is the 48h clock-start revision** | **2026-08-19T16:51:23Z** |

`-00017`/`-00018`/`-00019`/`-00020` are pre-clock validation steps, not part of
the 48h window — the clock starts at the final revision's creation timestamp,
consistent with `feedback_soak_clock_is_worker_uptime.md` (clock = Cloud Run
uptime of the revision actually being observed).

### Health (verified live, not asserted)

Both the service URL and every tag URL return the union head as `git_sha`:

```
{"status":"healthy","version":"0.1.0","git_sha":"daf3d6056788762ba56da5c328154e50fce03b59",
 "network":"signet","checks":{"database":"ok","anchoring":"ok","kms":"ok"}}
```

Treasury visible: `POST /jobs/refresh-treasury-cache` →
`{"success":true,"balance":736985,"updated_at":"2026-08-19T16:25:43.166Z"}`
(address `tb1qrjarsqj0ewqh3u9fdcu7yfyl0sx78k4savtmv7` per the original
2026-08-11 rig provisioning record). `BITCOIN_UTXO_PROVIDER=getblock` is bound
on the service — confirms `GetBlockHybridProvider`, the exact class both chain
PRs modify, is the live provider (not a plain mempool-only provider that would
leave FD-CHAIN-1's code path unexercised).

bitcoind VM `arkova-s33-rig-b1-bitcoin-core-signet` (`us-central1-a`,
`e2-standard-2`): **RUNNING** (`gcloud compute instances describe`).

## Preflight — `scripts/ci/staging-honesty-preflight.ts` against `gnkuaywlpmsaezwvlvhk`

Run 2026-08-19T16:21:26Z with `SUPABASE_SERVICE_ROLE_KEY` from
`supabase-service-role-key-fullsoak-2026-08-staging` and
`SUPABASE_ACCESS_TOKEN` from `supabase_access` (per
`docs/reference/STAGING_RIG.md`'s pattern, pointed at this project ref).

```json
{
  "environment_type": "fixture_seeded",
  "checks": [
    {"name": "staging_only_rows", "passed": true},
    {"name": "duplicate_names", "passed": true},
    {"name": "duplicate_versions", "passed": true},
    {"name": "known_artifacts", "passed": true, "details": "No known artifact rows."},
    {"name": "submitted_anchors", "passed": false, "details": "Zero SUBMITTED anchors — environment may lack test fixtures."},
    {"name": "prod_divergence", "passed": true, "details": "Rig ledger reconciles with repo migration files + canonical baseline."}
  ],
  "artifact_rows": []
}
```

**Honest result: `environment_type=fixture_seeded` — NOT `clean_mirror`.** This
differs from the pre-standup prediction ("it will not be clean_mirror — soak
artifacts... will be present" / `soak_artifact`); the actual failure mode is
different and, on inspection, more benign than predicted:

- **`artifact_rows` is empty.** None of the contamination-class checks
  (PR-only rows, duplicate names/versions, known artifact rows) fail. The
  ledger reconciles against the repo + canonical baseline. There is no
  evidence of dirty migration state.
- **The single failing check (`submitted_anchors`) is a fixture-completeness
  heuristic, not a contamination signal.** It requires ≥1 anchor with
  `status='SUBMITTED'` as a proxy for "this rig isn't hollow." At query time
  the rig held **25,896 SECURED + 3 PENDING + 0 SUBMITTED** real anchors
  (2 orgs: `ACC`=25,892, `ARK`=7) — a large, real corpus from the just-closed
  7-day soak, not an empty rig. It reads `0 SUBMITTED` because that window's
  in-flight queue **drained organically before close**
  (`docs/staging/fullsoak-2026-08/window-close-2026-08-19.md`: "the queue
  cleared organically inside the window"), which is the healthy-close case the
  preflight's Check 5 cannot distinguish from a genuinely hollow rig.
- **§1.11A framing.** This is an explicitly founder-approved isolated rig
  standup, not shared-staging evidence — the `clean_mirror`-only rule in
  CLAUDE.md §1.11A is written for `ujtlwnoqfhtitcmsnrpq`. None of the three
  PRs in this union touch migrations, RLS, or schema. Given zero artifact
  rows and a real (not fixture) anchor corpus, `fixture_seeded` here is an
  acceptable evidence basis for a chain/rate-limit-only soak — it is not being
  cited as `clean_mirror`, and this doc says so plainly rather than rounding
  up.
- **Real risk this creates, named plainly:** with 0 SUBMITTED and only 3
  PENDING anchors, and no anchor-traffic generator currently running (the
  7-day soak's synthetic-traffic LaunchAgent was unloaded at close), *new*
  anchor volume during this window may be thin unless something creates
  anchors. Mitigation in place: `batch-anchors-forced-flush` (`0 3 * * *`)
  fires at least twice in the 48h window regardless and will flush whatever
  is PENDING; 3 real PENDING anchors exist right now to seed the first cycle.
  If richer volume is wanted, reinstating anchor-traffic generation is a
  follow-up the soak operator can decide on — not done unilaterally here since
  it's a distinct action with its own blast radius, outside this task's scope.

## Cloud Scheduler (26 jobs, all `ENABLED`)

`batch-anchors` (`*/30`), `check-confirmations` (`*/30`),
`batch-anchors-forced-flush` (`0 3 * * *`), `org-queue-scheduler` (`4-59/5`),
`recover-broadcasts` (`7-59/10`), `anchor-public-records` (`*/10`),
`monitor-fees` (`*/30`), `refresh-treasury-cache` (`9-59/10`),
`populate-confirmation-proofs` (`0-59/5`), `check-stuck-anchors` (`0 * * * *`),
`consolidate-utxos` (`0 5 * * *`), `detect-reorgs` (`3-59/10`),
`monitor-stuck-txs` (`9-59/15`), `rebroadcast-txs` (`14-59/15`),
`grace-expiry-sweep` (`4-59/15`), `nonce-sweep` (`0 4 * * *`),
`anchor-expiry-sweep` (`0 3 * * *`), `refresh-stats` (`2-59/5`),
`rule-action-dispatcher` (`3-59/5`), `anchor-attestations` (`1-59/10`),
`process-anchors` (`*/30`), `process-revocations` (`1-59/5`),
`webhook-retries` (`2-59/10`), `db-health-monitor` (`2-59/5`),
`drain-connector-artifacts` (`3-59/5`), `rules-engine` (`4-59/5`).

`ENABLED` is a config-plane fact, not an execution fact — see PM-C below.

## Switchboard flags (24 rows, live-queried)

`ENABLE_PROD_NETWORK_ANCHORING=true`, `ENABLE_BATCH_ANCHORING=true`,
`ENABLE_ORG_CREDIT_ENFORCEMENT=true`, `ENABLE_VERIFICATION_API=true`,
`ENABLE_AI_EXTRACTION=true`, `MAINTENANCE_MODE=false`,
`ENABLE_COMPLIANCE_ENGINE=false` (only false-that-matters row; matches the
Gate-0 decision matrix from the original 7-day-soak standup). Full list is in
the query output; not reproduced here in full since it is unchanged from the
frozen rig's last known state and nothing in this union touches flags.

---

## CTO pre-mortem — three deltas this soak must specifically cover

The C-cluster review that verified the #2216+#2250 union (clean merge, 2,478
tests green, TLA 4/4, PM-2 defused) named three things generic health-check
evidence would not catch. This section is the executable plan for each —
**observe, do not assume.**

### PM-A — A18 treasury-visibility across a full flush cycle (the PM-2 control)

**Why this is the control, not decoration.** The exact recurrence this union
is meant to defuse already happened *on this rig*, on the frozen pre-fix code,
at **2026-08-19T14:40:01Z**: `docs/staging/fullsoak-2026-08/window-close-2026-08-19.md`
records "the 14:40:01Z health run then recorded the known FD-CHAIN-1
signature — 'worker reported treasury empty' — because the fresh batch's
change output was the treasury's only UTXO and `listUnspent(minconf=1)` hides
unconfirmed change... By 15:00:00Z 'Treasury pre-flight check passed'." That
was the OLD code (round-1 fall-through, not the round-2 union in this soak).

**Plan:** `batch-anchors-forced-flush` (`0 3 * * *`) will fire at least twice
in the 48h window. For each firing:

1. Immediately before and immediately after (±15 min), call
   `POST /jobs/refresh-treasury-cache` and record the returned `balance`.
2. Grep Cloud Run logs for the exact prior-incident signature strings
   (`"Treasury has no UTXOs"`, `"treasury empty"`, `"Treasury pre-flight
   check"`) in the 60 minutes surrounding each flush.
3. **Success condition:** the union's `listUnspentViaRpc` + mempool-leg union
   (round 2 of #2250) means the post-flush unconfirmed change is no longer
   invisible — balance must stay visibly non-zero across the flush, not dip to
   a false-empty read and self-heal an hour later. A false-empty read *would*
   be the recurrence signature; this is what the soak is checking for, not
   assuming away.
4. Record both flush-cycle results (pass/fail + timestamps + log excerpt) in
   a follow-up to this doc before the RC manifest's `soak` block is filled at
   48h.

### PM-B — #2216's token-leak fix: origin-only labels, standing check

**Confirmed in source** (not just cited from the PR body):
`sanitizeRpcUrlForError()` in `services/worker/src/chain/utxo-provider.ts`
returns `new URL(rpcUrl).origin` only — prod's `BITCOIN_RPC_URL` is
`https://go.getblock.io/<ACCESS_TOKEN>`, and the origin-only label strips the
token-bearing path. Commit `a664ee847` message: "rpcCall body-timeout errors
must not carry the token-in-path RPC URL" (§1.4 / S3.3-F1).

**Plan — standing check, not one-shot:** grep Cloud Run logs for the literal
string `go.getblock.io` at least once daily during the 48h window and again
at close. Any hit must be a bare origin (`https://go.getblock.io`) with
**nothing** after it — a path segment or token string after that origin in
any log line is the leak this fix exists to prevent.

**Initial spot-check (2026-08-19T16:25–16:45Z, ~20 min post-deploy):** zero
occurrences of `go.getblock.io` in any log line. **This is necessary but not
sufficient** — the sanitized-label code path only executes on an RPC
*failure/timeout*, and no such failure occurred in that window (the treasury
refresh succeeded cleanly). The meaningful test is what happens on a real
RPC-leg failure; the daily standing check must specifically capture at least
one such event (organic GetBlock hiccup, or a deliberately induced one if the
soak operator wants a forced positive control) and confirm the resulting log
entry carries only the origin-only label, never the full token-bearing URL.

### PM-C — FD-CRON-1: observe cron reliability, do not assume it

**Why this cannot be assumed:** the just-closed 7-day soak's own final report
confirms the defect class is live in prod: "**30+ `[NODE-CRON]` missed
execution warnings** on the prod worker in the trailing 7 days" — the same
in-process node-cron scheduler this rig runs. FD-CRON-1 itself caused Trigger
D's `03:00Z` flush to be silently skipped once during that window (chronic
node-cron event-loop contention; backlog recovered organically ~11.5h later).
`ENABLED` in Cloud Scheduler only proves the HTTP trigger is configured — it
does not prove the in-process handler actually ran to completion.

**Plan — daily, not just at close:**

1. Query Cloud Run logs for the literal signature `[NODE-CRON] missed
   execution` and record a daily count (target: compare against prod's ~4-5/day
   average from the closed window, not a bare zero expectation — the defect is
   chronic, not rare).
2. Separately, for each of the 26 `ENABLED` Scheduler jobs, confirm via Cloud
   Run request logs that it returned **HTTP 200 at least once per calendar
   day** it's scheduled to fire. A job silently not firing (distinct from
   firing-but-erroring) is exactly what "ENABLED ≠ fired" means here.
3. Record both numbers daily in a running log under this directory (not only
   a single reading at 48h) — this is the literal instruction: observe, don't
   assume.

---

## Rate-limit cluster (#2269) — T2 evidence riding inside this 48h window

Folded in mid-standup (see "Scope extension" below). Three required behaviors,
all with live evidence gathered on this rig before the clock start:

### 1. Cross-instance shared counting

`min-instances=2` set on the service for the observation window. Confirmed
live: `Upstash Redis rate limiting initialized (shared counters via INCR)`
logged with `environmentNamespace: "arkova-worker-fullsoak-2026-08-staging"`.
Five sequential `GET /.well-known/did.json` calls (public, `apiIpShadowGuard`,
60/min/IP) returned a **strictly monotonic** `x-ratelimit-remaining`:
`59, 58, 57, 56, 55` with a stable `x-ratelimit-reset` — only possible with a
genuinely shared counter (an unshared in-memory bucket per instance would not show
monotonic decrement across a min-instances=2 service). Direct Upstash `SCAN`
confirmed the actual counter key exists:
`arkova:rl:arkova-worker-fullsoak-2026-08-staging:<client-ip>`.

### 2. Bounded ~10-minute Upstash-blackhole window

Revision `-00020-gag` (tag `cp0819bh`), deployed **2026-08-19T16:42:20Z**,
`UPSTASH_REDIS_REST_URL` overridden to an unreachable literal host
(`https://blackhole-soak-test.invalid.arkova-nonexistent-host.example`),
`UPSTASH_REDIS_REST_TOKEN` unchanged, `min-instances=2` preserved.

Confirmed via logs (repeated, both instances):

```
"Upstash rate limit unavailable — degrading to per-instance bucket
 (limits are NOT shared across instances while this persists)"
caused by: Error: getaddrinfo ENOTFOUND blackhole-soak-test.invalid.arkova-nonexistent-host.example
```

- `X-RateLimit-*` headers continued on **every** response throughout the
  outage — fail-open per §1.10, confirmed, not assumed.
- Per-instance divergence directly observed: repeated calls during the outage
  showed **non-monotonic**, instance-local `remaining`/`reset` values (e.g.
  `59 → 58 → 58` with `reset` jumping backward once) — proof the fallback
  bucket is genuinely local-per-instance during the outage, not a
  false-still-shared counter.
- `/health` stayed `"healthy"` throughout — the rate-limit degradation is
  correctly isolated from the database/anchoring/kms checks. **Residual note:**
  `/health` does not currently surface Upstash circuit-breaker state; an
  operator watching only `/health` would not see this degradation. Not a
  blocker, worth a follow-up ticket.
- Circuit-breaker state machine itself (`open` at 5 consecutive failures,
  `half-open` probe after `RECOVERY_MS=30_000`) is unit-test-proven in
  `upstashRateLimit.circuitBreaker.test.ts` (part of the 0-new-failures sweep
  above). A live half-open-succeeds replay isn't reachable through
  env-var/redeploy tooling — a redeploy restarts the process, which
  constructs a fresh `closed`-state breaker rather than resuming an `open`
  one — so this section documents the real network-unreachable trigger +
  fail-open path live, and cites the unit suite for the transition mechanics.

**Window closed 2026-08-19T16:51:23Z** (revision `-00022-suy` creation time) —
an actual bounded duration of **~9 minutes** (target was "bounded ~10
minutes"; close enough to report as-observed rather than padding to a round
number). Restoring the secret required the same two-step type-flip dance as
setting the literal did (`gcloud run deploy` refuses to change an env var's
type — secret vs. plain literal — in a single call): revision `-00021-jah`
dropped the plain-literal var, then `-00022-suy` re-bound
`UPSTASH_REDIS_REST_URL` (and kept `UPSTASH_REDIS_REST_TOKEN`, which was never
touched) as secrets. **Recovery confirmed live:** both instances of
`-00022-suy` logged `Upstash Redis rate limiting initialized (shared counters
via INCR)` with `environmentNamespace: "arkova-worker-fullsoak-2026-08-staging"`
within 20s of the new revision taking traffic, and a subsequent
`GET /.well-known/did.json` returned a fresh shared-counter reading
(`x-ratelimit-remaining: 59`) — Upstash-backed enforcement resumed cleanly.

### 3. Namespace proof — staging-namespaced keys, zero bare-IP keys

Live Upstash `SCAN` at steady state returned exactly:

```
arkova:rl:arkova-worker-fullsoak-2026-08-staging:<client-ip>
arkova:rl:arkova-worker-fullsoak-2026-08-staging:cron-jobs
```

Both keys carry the `arkova-worker-fullsoak-2026-08-staging` namespace
segment — matches `resolveEnvironmentNamespace()`'s derivation from `K_SERVICE`
(Cloud Run's own service-name env var, not user-controlled), which per the
module's own guarantees can never collide with `prod` (exact-match only
against `PROD_SERVICE_NAME='arkova-worker'`) and is identical across every
instance of this one service (so the shared-counter property in §1 holds).

**One transient exception, disclosed rather than hidden:** a broader `SCAN *`
briefly surfaced one bare-IP key with no namespace prefix
(`74.125.212.37`) — a legacy artifact predating the namespace fix on
*some* service that wrote to this shared Upstash database. Immediate
follow-up (`PTTL`, `GET`, `TYPE`) showed it had **already expired**
(`PTTL -2`, `GET null`, `TYPE none`) and a rescan confirmed it was gone. This
rig's own code cannot produce such a key — `counterKey()` unconditionally
prefixes every write with the namespace — so this was pre-existing decaying
data, not something this soak wrote, and it is gone as of this check.

---

## Scope extension (mid-standup)

A coordinator instruction during this standup folded PR #2269 in: the shared
staging project originally slated for #2269's T2 soak
(`ujtlwnoqfhtitcmsnrpq`) no longer exists, so its evidence now rides inside
this rig's 48h window instead of standing up a second rig. Verified before
merging (not taken on claim): PR #2269 head `fadc04c927ee4c41966d87bf86c969931b02c97e`
matches; its 23 changed files are entirely rate-limit/upstash/middleware code
with zero overlap against the chain PRs' files. The 3-way merge is clean (no
conflict markers), and the full verification sweep (typecheck/lint/tests) was
re-run against the extended union — see above.

---

## T3 evidence requirements (CLAUDE.md §1.12) — status

| Requirement | Status |
|---|---|
| Exact PR head SHA / base SHA (×3) | Recorded above |
| Clean preflight / documented deviation | `fixture_seeded`, documented honestly above per §1.11A |
| Deploy log id | N/A — direct `gcloud run deploy` to isolated single-tenant rig (see Image + deploy) |
| E2E / targeted evidence | Chain+jobs+rate-limit test sweep (0 new failures); live rig checks in PM-A/B/C and rate-limit sections |
| Rollback plan | Revert to the prior stable revision (`-00013-mrw` image digest `sha256:8ace89d4…`, or redeploy `origin/main` alone); no migration to reverse (none of the three PRs carries one) |
| Soak start/end (48h, clock = Cloud Run uptime) | Start: **2026-08-19T16:51:23Z** (revision `arkova-worker-fullsoak-2026-08-staging-00022-suy`, tag `cp0819rc`, image digest `sha256:d7a956079729b080a2e654f8014c9fbd270dbfc4392b1000e1a4e0630157ea45`). End: **2026-08-21T16:51:23Z**. |
| Trigger A fires (10,000-cap batch) | Pending — observe during window |
| Trigger B fires (age-based) | Pending — observe during window |
| Daily flush observation | Pending — PM-A plan above covers this explicitly |
| Per-org isolation check | Plan: 2 real orgs on this rig (`ACC`=25,892 anchors, `ARK`=7 anchors) — snapshot per-org anchor counts + status distributions at start and at 48h, confirm no cross-org anchor/status bleed and no rate-limit-key cross-contamination (namespace is per-service, not per-org, by design — org isolation here means anchor-table RLS/query isolation, unaffected by any PR in this union) |

Do NOT mark either #2216, #2250, or #2269 Ready during this window. This
doc records soak **start**, not soak completion.

---

_Doc written 2026-08-19 during soak standup. Union head, image digests, and
revision/timestamp fields above are live-verified (gcloud/MCP/log query
output), not asserted from PR claims — see the "Verification" and "Preflight"
sections for the exact commands/queries behind each number._

## PM-C observation 1 (2026-08-19T20:5xZ): cron-miss spike root-caused to stale revisions, not the union

Service-wide `[NODE-CRON] missed execution` warnings spiked to ~624-674/hour after standup
(prior revision baseline: 4/hour). Diagnosis (read-only): SIX co-resident warm revisions
from the standup's iterative deploys (00017-00021 + 00022-suy), each independently running
in-process node-cron — the union revision alone accounted for 72/hour, explained by the
DELIBERATE minScale 1→2 (cross-instance rate-limit evidence) times three jobs sharing one
'*/2 * * * *' schedule. No busy loop exists in the union diff (dual-leg listUnspent,
run-lease deadline, and circuit breaker all inspected and cleared). Functional impact:
batch-anchor (30-min) and revocation (5-min) crons showed ZERO gaps; exactly one 2-min
confirmation-check tick (20:32Z) was skipped and the next tick recovered.

Resolution: the five stale revisions were deleted and their tags removed at ~20:55Z
(operator hygiene, not code). The soak revision 00022-suy was untouched — uptime monotonic
across the surgery (14,296s after), traffic 100%, health green at union head. Clock stands.
Residual finding for FD-CRON-1: same-schedule job clustering ('*/2' x3) plus multi-instance
minScale multiplies collision odds — input to the Cloud Scheduler migration design.

# Chain-pair T3 — pre-mortem controls PM-A / PM-B / PM-C, closed from the 48 h log record

**Window:** 2026-08-19T16:51:23Z → 2026-08-21T16:51:23Z (48.00 h)
**Service:** `arkova-worker-fullsoak-2026-08-staging` (project `arkova1`, `us-central1`)
**Clock revision:** `-00022-suy`, image `sha256:d7a95607…7ea45`, `git_sha daf3d6056788762ba56da5c328154e50fce03b59`
**Written:** 2026-08-21T19:05Z, from Cloud Logging only. No writes to the rig.

The soak-start doc (`docs/staging/chain-pair-soak-2026-08/soak-start-2026-08-19.md`)
left PM-A, PM-B and PM-C as `PENDING`. All three are retrospectively checkable
against the log record. Two are now closed with real measurements. **One is closed
as UNEXERCISABLE on this rig, which is a different and more useful answer than
"pass".**

## Method and its integrity

App logs (stdout/stderr, excluding `run.googleapis.com/requests`) were read in
6-hour slices. `gcloud logging read` truncates silently at 20,000 entries per
call, so every slice was checked against that cap:

| Slice | Entries | |
|---|---|---|
| 1 · 16:51:23Z→22:51:23Z (08-19) | 7,317 | |
| 2 · 22:51:23Z→04:51:23Z | 2,661 | |
| 3 · 04:51:23Z→10:51:23Z | 2,687 | |
| 4 · 10:51:23Z→16:51:23Z | 2,750 | |
| 5 · 16:51:23Z→22:51:23Z (08-20) | 9,043 | |
| 6 · 22:51:23Z→04:51:23Z | **20,000** | **CAPPED — re-sliced** |
| 7 · 04:51:23Z→10:51:23Z | 2,739 | |
| 8 · 10:51:23Z→16:51:23Z | 2,510 | |

Slice 6 hit the cap exactly and was **silently truncated**. It was re-pulled as six
1-hour sub-slices (569 / 1,053 / 17,693 / 502 / 1,708 / 457 — none capped). Had
this not been caught, every count below would have been understated across the
Trigger A/B burst, which is precisely the window that matters.

**Total after de-duplication by `insertId`: 51,689 app-log entries**, spanning
2026-08-19T16:51:23.025837Z → 2026-08-21T16:51:03.756661Z.

Request logs were pulled separately in 13 slices (max 12,503, none capped),
totalling **40,675** — an exact match to the independently-derived figure in
`maturity-2026-08-21T1651Z.md`. The two datasets corroborate each other.

---

## PM-A — treasury visibility across flush cycles: **PASSED**

The designated control for PR #2250 / FD-CHAIN-1 ("empty-but-successful
`listunspent`"). The failure signature to look for is a false-empty treasury read
in the minutes after a batch spends the treasury UTXO, when the change output is
still unconfirmed and `listUnspent(minconf=1)` would hide it.

### Recurrence-signature grep — zero hits

```
match over full JSON of all 51,689 in-window entries:
  "Treasury has no UTXOs"        → 0
  "treasury empty"               → 0
  "worker reported treasury empty" → 0
```

The exact string recorded on this rig on the **pre-fix** code at 2026-08-19T14:40:01Z
("worker reported treasury empty") does not appear once in the 48 h window.

### Positive evidence — 649 treasury reads, none empty

| | |
|---|---|
| `Treasury pre-flight check passed` | 360 |
| `Treasury cache refreshed` | 289 |
| **Total balance readings** | **649** |
| **Zero-balance readings** | **0** |
| **Zero-`utxoCount` readings** | **0** (min `utxoCount` = 1 throughout) |
| Balance envelope | 733,060 – 736,985 sats |
| First / last read | 16:52:10Z (08-19) / 16:50:25Z (08-21) |

### Across all six flush cycles

Six batch events fired in-window. Treasury readings bracket every one:

| # | Flush | Anchors | Balance before | Balance after | `utxoCount` after |
|---|---|---|---|---|---|
| 1 | 03:00:16Z 08-20 · daily 3am forced sweep | 3 | 736,985 | 736,043 (+8.9 m) | **1** |
| 2 | 18:04:15Z 08-20 · forced org flush | 8 | 736,043 | 735,415 (+6.1 m) | **1** |
| 3 | 22:00:52Z 08-20 · **Trigger B** (age) | 3,116 | 735,415 | 734,787 (+8.3 m) | **1** |
| 4 | 23:44:07Z 08-20 · forced org flush | 120 | 734,787 | 734,159 (+4.9 m) | **1** |
| 5 | 01:30:00Z 08-21 · **Trigger A** (size 10,000) | 10,000 | 734,159 | 733,531 (+9.1 m) | **1** |
| 6 | 03:00:28Z 08-21 · **Trigger D** (daily sweep) | 2,614 | 733,531 | 733,060 (+18.6 m) | **1** |

Balance steps down monotonically by the batch fee each cycle (628–942 sats) and the
treasury is **continuously visible with exactly one spendable UTXO** after every
spend, including the 10,000-anchor Trigger A batch. That is the union fix
(`listUnspentViaRpc` + mempool-leg union) doing the thing FD-CHAIN-1 was about.

**Sampling honesty.** Reads are on a ~10-minute cadence
(`refresh-treasury-cache` at `9-59/10`, pre-flight at `:00/:10/:20`), so the first
post-spend read lands +4.9 to +9.1 minutes after each batch, not immediately. The
original FD-CHAIN-1 false-empty on this rig persisted from 14:40:01Z to ~15:00:00Z
— roughly 20 minutes. The observation cadence is therefore finer than the known
failure duration, and would have caught a recurrence. It is **not** proof about the
first ~5 minutes after a spend, and this record does not claim that.

**Verdict: PASSED.** Real measurement, six cycles, zero false-empty reads.

---

## PM-B — `go.getblock.io` token-leak grep: **UNEXERCISED, and structurally unexercisable on this rig**

This is the control for PR #2216's `sanitizeRpcUrlForError()`. Reporting it as
"zero leaks found → pass" would be wrong, and here is why.

### The grep result

```
match /getblock/i over full JSON of all 51,689 in-window entries → 36 entries
match literal "go.getblock.io"                                   →  0 entries
```

### Why zero is meaningless here

The 36 hits are all the provider *label*, never a URL with a token. The rig's
actual RPC endpoint, taken from the logs themselves:

```
distinct rpcUrl values logged across the whole 48 h window:
  {'http://10.33.10.10:38332'}
```

That is the private-IP signet `bitcoind` VM (`arkova-s33-rig-b1-bitcoin-core-signet`),
**not** GetBlock's hosted endpoint. `BITCOIN_UTXO_PROVIDER=getblock` selects the
`GetBlockHybridProvider` *class*; it does not mean the rig talks to `go.getblock.io`.

Full inventory of every http(s) URL appearing anywhere in the 48 h of app logs:

```
http://10.33.10.10:38332
https://app.arkova.ai
https://arkova-worker-fullsoak-2026-08-staging-{270018525501.us-central1,kvojbeutfa-uc.a}.run.app
https://cp0819---… https://cp0819v2---… https://cp0819bh---… https://cp0819rc---…
https://rmsec1---… https://rmenv1---…   (Cloud Run tag URLs)
https://console.cloud.google.com/logs/viewer?…   (Cloud Run's own error links)
https://github.com/orgs/supabase/discussions/45715
https://mempool.space/signet/api
```

**No token-bearing URL exists on this rig in any form.** The string the control
greps for cannot appear regardless of whether `sanitizeRpcUrlForError` works. Zero
hits is a tautology, not a result.

### The sanitizer guards a specific path, and the path *was* reached

```ts
// services/worker/src/chain/utxo-provider.ts @ daf3d605
export function sanitizeRpcUrlForError(rpcUrl: string): string {
  try { return new URL(rpcUrl).origin; } catch { return 'bitcoin-rpc'; }
}
...
// origin-only label, never `rpcUrl` — see sanitizeRpcUrlForError.
const rpcUrlLabel = sanitizeRpcUrlForError(rpcUrl);
```

Three RPC/provider-leg failures occurred, two of them **in-window on the clock
revision** — so the error path is not cold:

| Timestamp | Revision | Event |
|---|---|---|
| 2026-08-19T20:31:30Z | `-0019-bek` | `mempool.space UTXO leg failed — degrading to RPC-only listing` · `error: "The operation was aborted due to timeout"` |
| **2026-08-20T22:02:03Z** | **`-0022-suy`** | `GetBlockHybridProvider.getRawTransaction: RPC fallback to mempool.space` · `reason: "RPC getrawtransaction error: No such mempool or blockchain transaction … (code -5)"` |
| **2026-08-20T22:02:16Z** | **`-0022-suy`** | same |

None of the three error payloads carries an RPC URL of any kind. That is
consistent with the fix, but it does **not** demonstrate token-stripping, because
the URL in play (`http://10.33.10.10:38332`) has no token to strip. And the commit
message for `a664ee847` names the guarded path narrowly — "**rpcCall** body-timeout
errors" — which is not the path either in-window failure took.

**Verdict: UNEXERCISED.** The control cannot pass or fail on this rig. To close it
honestly, `sanitizeRpcUrlForError` needs an environment where `BITCOIN_RPC_URL`
actually is `https://go.getblock.io/<TOKEN>` and an induced `rpcCall` body-timeout
against it — i.e. a targeted staging config, not this signet rig. The unit test
`utxo-provider` covers the function in isolation; that remains the only real
evidence for it.

---

## PM-C — `[NODE-CRON]` missed executions: **MEASURED, and materially worse than the plan predicted — but no job actually failed to run**

### The count

```
match "NODE-CRON" AND /missed/i over 51,689 in-window entries
```

| | |
|---|---|
| **Total missed-execution warnings, 48 h** | **7,072** |
| 2026-08-19 (partial, from 16:51Z) | 2,786 |
| 2026-08-20 (full day) | 2,765 |
| 2026-08-21 (partial, to 16:51Z) | 1,521 |
| Distinct hours with ≥1 warning | **49 of 49** — continuous, not bursty |
| Peak hours | 17Z 674 · 18Z 624 · 19Z 596 · 20Z 526 (08-19, post-deploy) |
| Steady state | ~120–133 / hour |
| On the clock revision `-0022-suy` | 4,847 |

Warning text is uniform:
`missed execution at <time>! Possible blocking IO or high CPU user at the same process used by node-cron.`

### Against the stated baseline — the plan's prod number was wrong

The soak-start plan said to "compare against prod's ~4-5/day average" (derived
from "30+ warnings in the trailing 7 days"). That figure does not survive contact
with the raw logs. Measuring **prod over the identical 48 h window**:

```
$ gcloud logging read 'resource.type="cloud_run_revision"
    AND resource.labels.service_name="arkova-worker"
    AND timestamp>="2026-08-19T16:51:23Z" AND timestamp<"2026-08-21T16:51:23Z"
    AND textPayload:"missed execution"' --project=arkova1 --limit=20000 \
    --format='value(timestamp)' | wc -l
242
```

| | 48 h count | per day |
|---|---|---|
| **prod `arkova-worker`** | 242 | ~121 |
| **chain-pair rig** | **7,072** | **~3,536** |

The rig runs at **~29× prod's rate.** The "~4-5/day" baseline in the plan was an
alert-occurrence count, not a log-line count, and should not be reused.

### Root cause — the documented gotcha, confirmed

```
$ GET run.googleapis.com/v2/…/revisions/arkova-worker-fullsoak-2026-08-staging-00022-suy
  resources: {"limits": {"cpu": "2", "memory": "2Gi"}, "cpuIdle": true, "startupCpuBoost": true}
  scaling:   {"minInstanceCount": 2, "maxInstanceCount": 5}
```

`cpuIdle: true` — CPU is throttled between requests. This is exactly
`memory/project_cloudrun_inprocess_cron_gotcha.md`: in-process `node-cron` timers
cannot fire on a throttled instance. **Prod `arkova-worker` is also `cpuIdle: true`**,
so throttling alone does not explain the 29× gap; the rig additionally drove 15,966
anchor submissions and a 10,000-anchor batch through the same 2 vCPU, and the
warning text itself points at event-loop contention.

### The part that actually matters: did the jobs run?

`node-cron` is a redundant in-process scheduler. The real execution path is Cloud
Scheduler over HTTP. Pulling every `/jobs/` request in the window:

| | |
|---|---|
| Total `/jobs/` requests | **7,356** |
| HTTP 200 | **7,355** |
| HTTP 401 | 1 |
| Distinct job endpoints exercised | 25 |

Per-job, per-calendar-day coverage is complete. The only three job/day cells with
zero requests are the daily crons on 08-19:

| Job | Schedule | 08-19 | 08-20 | 08-21 |
|---|---|---|---|---|
| `anchor-expiry-sweep` | `0 3 * * *` | — | 1 | 1 |
| `nonce-sweep` | `0 4 * * *` | — | 1 | 1 |
| `consolidate-utxos` | `0 5 * * *` | — | 1 | 1 |

The window opened at 16:51Z on 08-19, **after** those jobs' 03:00/04:00/05:00Z fire
times, so they had no scheduled firing left that calendar day. That is correct
behaviour, not a miss.

**Verdict: MEASURED — chronic and 29× prod, but not load-bearing.** 7,072 warnings
represent the in-process scheduler failing continuously; the Scheduler-driven HTTP
path delivered 7,355 of 7,356 executions with 200 and full per-job daily coverage.
FD-CRON-1's *symptom* is confirmed live at high volume; its *impact* in this window
was nil because nothing depends on `node-cron` firing. The rig's 29× elevation over
prod is a new number that did not exist before this analysis and is worth a ticket
on its own.

---

## Incidental findings surfaced by the same sweep

Not part of PM-A/B/C, but they fell out of the log record and should not be
dropped on the floor:

| Finding | Count in 48 h | Note |
|---|---|---|
| `Reorg detection cron failed` | **151** | a job erroring ~3×/hour for the entire window, never previously reported |
| `Supabase read transport failure — retrying once on a fresh socket` | 68 | WH-1 / ARKOVA-WORKER-C retry path, firing regularly |
| `Run lease continuously unavailable for longer than a full TTL` | 44 | run-lease orphan/renewal pressure |
| `/jobs/populate-confirmation-proofs` p99 latency | **68.7 s** | vs 521 ms p95 on the same endpoint — a severe tail |
| Max request latency in window | **132.2 s** | |
| Stale Cloud Run labels on the service | — | still carries `lane=pr-2195`, `pr=2195`, `deployed-by-script=deploy-sh` from an unrelated earlier deploy |

`Reorg detection cron failed` at 151 occurrences on a T3 chain/anchor-lifecycle
soak is the one worth acting on first.

---

_All figures derived from Cloud Logging over the stated window, with cap-checking
per slice. Request-log total (40,675) independently reproduces the figure in
`maturity-2026-08-21T1651Z.md`. No write operation was performed against any Cloud
Run service, Supabase project, or Upstash database in producing this document._

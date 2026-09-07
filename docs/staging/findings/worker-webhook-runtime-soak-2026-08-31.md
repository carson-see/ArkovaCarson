# Finding — `worker-webhook-runtime` batch soak is running but its evidence does not yet hold

**Raised:** 2026-08-31 (~15:30Z) by the worker/migration soak lane.
**Status:** window still open — correctable in place, no re-soak required if acted on before it closes.
**Do not treat this as a teardown request.** The rig and driver are healthy and were left untouched.

## What is running

| | |
|---|---|
| Supabase rig | `sawvgrwhgsmxjlwhpsyx` (`arkova-soak-soak-worker-webhook-runtime`, us-east-2) |
| Cloud Run service | `arkova-worker-soak-worker-webhook-runtime-staging` |
| Revision | `arkova-worker-soak-worker-webhook-runtime-staging-00002-krl` (100% traffic) |
| Image | `sha256:11d82631860f9a43d2690bd930a5b860ce3f0a3e0a3cf5415ce12ef32d5cc8e2` |
| Driver | `node scripts/staging/targeted/wwr-batch-driver.mjs` — **PID 22147**, PGID 22142 |
| PRs claiming this window | #2436, #2474, #2485, #2486, #2496, #2499 |

The load is **real and continuous** — ~192 requests/hour with purpose-built `wwr-declared-0001` / `wwr-fetched-0001` fixtures, verified from Cloud Run request logs. This is not a hollow window in the "no driver at all" sense, and an earlier read of mine that suggested otherwise was wrong: an apparent six-hour gap was a 2000-row query-truncation artifact, not a real gap.

Three separate problems remain.

## 1. The declared clock over-claims by 1 h 29 m 29 s

All six PR bodies declare:

```
Soak start: 2026-08-30T22:22:53Z   (clock = Cloud Run revision createTime / worker uptime)
Soak end:   2026-09-01T22:22:53Z
```

The service was created `2026-08-30T22:16:15.876118Z`, and `22:22:53Z` is a revision timestamp. But the **first request the service ever served** is:

```
2026-08-30T23:52:22.843113Z  /api/v1/verify/wwr-declared-0001
```

Anchoring on revision `createTime` rather than LOAD start is the specific practice the launch discipline forbids, and here it claims 89 minutes of soak that had no load in it. For a T3 window the honest anchor is:

```
Soak start: 2026-08-30T23:52:22Z
Soak end:   2026-09-01T23:52:22Z
```

## 2. Four of the six PRs have never had their own behaviour fire

Queried live on the rig at ~2026-08-31T15:20Z:

| Table | Rows | Consequence |
|---|---|---|
| `organization_rule_events` | **0** | #2485 and #2496 change how a rule-event payload is built to stay under the 16 KB CHECK **at max cardinality**. Zero rule events have ever been written, so that code path has not executed once in ~15.5 h. |
| `connector_artifact` | **0** | #2474 changes `connector-artifact-drain` and DocuSign signer capture. No connector artifact has ever been created. |
| `anchors.fingerprint_source` | 186 rows, **all NULL** | #2486 makes the dispatcher write `NULL` instead of a false evidence class. With no row ever carrying a non-NULL value and no negative control, the assertion "all NULL" is true on an untouched rig too — **the probe cannot fail by construction.** |

The traffic that *is* running (`/api/v1/verify/*`, `/api/v1/verify/batch`, `/api/treasury/status`) exercises #2499's declared-vs-fetched fingerprint distinction and gives generic worker-health evidence. It does not touch the changed behaviour of #2474, #2485, #2486 or #2496.

Per CLAUDE.md §1.12 and Carson's 2026-08-27 standard, generic load is supporting worker-health evidence only. Four of these six PRs currently have **no targeted evidence at all**.

## 3. Two anchor-creating feeders are co-located on one rig (§1.11A)

#2474 (`services/worker/src/jobs/connector-artifact-drain.ts`) and #2486 (`services/worker/src/jobs/rule-action-dispatcher.ts`) both **create anchor rows**. §1.11A allows two PRs to share one rig only when they can truthfully share one clean database state; two independent changes to the anchor-creation path cannot. They need serialising, or one needs its own rig.

Both are also **T3**, not T2 — `requiredTierFor()` on `origin/main` puts them on the SCRUM-3802 rule (`anchor-creating feeder / anchor pipeline`). #2474's title still says `[T2]`, which is an under-declaration in the direction that matters.

## 4. `Staging deploy log id` cannot be sourced from this rig

`public.staging_deploy_log` does not exist on `sawvgrwhgsmxjlwhpsyx`, so the T2/T3 required field `Staging deploy log id:` has no truthful value available from it. The deploy did not go through `scripts/staging/deploy.sh`.

## Suggested action while the window is still open

1. Re-anchor `Soak start` / `Soak end` to the real load start (`23:52:22Z` → `2026-09-01T23:52:22Z`) in all six bodies.
2. Add drivers that actually fire the changed paths: write rule events at max cardinality (#2485 DocuSign, #2496 Adobe Sign), drive a connector artifact through the drain (#2474), and give #2486 a **negative control** — a revision without the fix producing the false evidence class on the same input — so the probe can fail.
3. Split #2474 and #2486 onto separate rigs or serialise them.
4. Correct #2474's declared tier to T3.
5. Source a deploy log id, or state plainly that none exists and carry it as a named residual risk.

## Provenance

Every figure above came from `gcloud logging read` against the live service, `gcloud run services describe`, the process table, and read-only SQL against the rig. **No write was made to `sawvgrwhgsmxjlwhpsyx`, to the Cloud Run service, or to any of the six PRs.**

Approved by: Claude Opus 5, acting CTO under delegated technical authority (Carson, 2026-08-28)

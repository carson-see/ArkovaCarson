# Chain-pair T3 — deploy rollback rehearsal: **NOT PERFORMED**

**Status: BLOCKED — not run, not simulated, not waived.**
**Written 2026-08-21T19:05Z. Author: soak-evidence session.**

§1.12 requires a rollback rehearsal for T2/T3. It was never run for the chain-pair
window (clock 2026-08-19T16:51:23Z → 2026-08-21T16:51:23Z) and **it is still not
run.** This document records why, and what is now true instead. It is not a
waiver and must not be cited as one.

## Why it did not run

The rehearsal was scoped as: shift `arkova-worker-fullsoak-2026-08-staging` traffic
to the prior revision `-00013-mrw`, verify health there, shift back to the
clock-start revision `-00022-suy`, re-verify. That plan assumed the rig was idle
after the chain-pair clock closed.

**The rig was not idle. It had already been reclaimed by another soak.**

Observed at 2026-08-21T18:47Z, before any action was taken:

```
$ gcloud run services describe arkova-worker-fullsoak-2026-08-staging \
    --region=us-central1 --project=arkova1 \
    --format='yaml(status.traffic,status.latestReadyRevisionName)'
status:
  latestReadyRevisionName: arkova-worker-fullsoak-2026-08-staging-00024-kaj
  traffic:
  - revisionName: arkova-worker-fullsoak-2026-08-staging-00022-suy
    tag: cp0819rc
    url: https://cp0819rc---arkova-worker-fullsoak-2026-08-staging-kvojbeutfa-uc.a.run.app
  - latestRevision: true
    percent: 100
    revisionName: arkova-worker-fullsoak-2026-08-staging-00024-kaj
    tag: train-5
    url: https://train-5---arkova-worker-fullsoak-2026-08-staging-kvojbeutfa-uc.a.run.app
```

`-00022-suy` — the revision the recorded 48 h evidence is bound to — **no longer
carries any traffic percentage.** It is retained only as a tag route. 100 % of
traffic is on `-00024-kaj`, tagged `train-5`.

Admin-activity audit log for the service:

```
$ gcloud logging read 'logName="projects/arkova1/logs/cloudaudit.googleapis.com%2Factivity"
    AND resource.labels.service_name="arkova-worker-fullsoak-2026-08-staging"' \
    --project=arkova1 --freshness=4h --limit=20 \
    --format='table(timestamp,protoPayload.methodName,protoPayload.authenticationInfo.principalEmail)'

TIMESTAMP                    METHOD_NAME                                  PRINCIPAL_EMAIL
2026-08-21T18:44:16.364235Z  google.cloud.run.v1.Services.ReplaceService  270018525501-compute@developer.gserviceaccount.com
2026-08-21T18:39:17.127025Z  google.cloud.run.v1.Services.ReplaceService  270018525501-compute@developer.gserviceaccount.com
```

Two `ReplaceService` calls, 5 and 10 minutes before the rehearsal would have
started. Revision timeline:

| Revision | Created | Ready | Note |
|---|---|---|---|
| `-00022-suy` | 2026-08-19T16:51:23.324226Z | True | chain-pair clock-start revision |
| `-00024-kaj` | 2026-08-21T18:39:17.404565Z | True | `train-5` standup, now serving 100 % |
| `-00025-rek` | 2026-08-21T18:44:16.604773Z | **False** | `HealthCheckContainerError` — container failed to listen on `PORT=3001` |

A third soak (`train-5`, a 10-PR soak train: #2245, #2251, #2254, #2258, #2266,
#2267, #2270, #2272, #2246, #2276) was mid-standup on this rig, with one revision
already failing to start.

## Why proceeding anyway would have been destructive

`gcloud run services update-traffic --to-revisions=...-00013-mrw=100` does not
merely move traffic. The service's `spec.traffic` currently reads:

```json
[{"latestRevision": true, "percent": 100},
 {"revisionName": "...-00022-suy", "tag": "cp0819rc"},
 {"revisionName": "...-00025-rek", "tag": "train-5"}]
```

Pinning a named revision **replaces the `latestRevision: true` entry**. The next
`gcloud run deploy` from the train-5 session would then produce a revision that
receives **0 % of traffic, silently** — their soak would be measuring an idle
revision while believing it was serving. That is a worse failure than a missing
rehearsal, and it would not be visibly wrong from their side.

Separately, a concurrent read-modify-write `ReplaceService` from this session
races their in-flight deploy sequence and can clobber env-var/secret changes
mid-standup.

The instruction to "restore 100 % traffic to `-00022-suy` at the end" is also no
longer satisfiable as written: `-00022-suy` did not have 100 % traffic to restore
by the time this session began.

**No mutation of any kind was issued against this service. `gcloud run services
update-traffic` was never run. The service generation, traffic split, and all
revisions are exactly as this session found them.** The other two live soaks
(`arkova-worker-wave3-2026-08-staging` rev `00005-rib`;
`arkova-worker-staging` rev `00300-few`) were verified read-only and are untouched.

## What *was* established, read-only

The rehearsal is unrun, but two of its failure modes were checked without touching
the service:

| Check | Result |
|---|---|
| `-00013-mrw` exists and is `Ready` | **Yes** — `status.conditions[Ready]=True`, created 2026-08-12T15:09:42Z |
| Rollback image still in Artifact Registry (not GC'd) | **Yes** — `arkova-worker-images/arkova-worker@sha256:8ace89d4…c1e18` resolves |
| Clock-revision image still present | **Yes** — `…@sha256:d7a95607…7ea45` resolves |

```
$ gcloud artifacts docker images describe \
    us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@sha256:8ace89d483484c40ea2022f7f21361effbfd6e0ab4d61ac4707f54e2ed1c1e18 \
    --project=arkova1 --format='value(image_summary.fully_qualified_digest)'
us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@sha256:8ace89d4...c1e18
```

So the rollback plan is not *dead* — the target revision and its image both still
exist. **What remains unproven is the only thing the rehearsal actually tests:
that `-00013-mrw` serves healthy traffic when promoted, and how long the shift
takes in each direction.** Image existence is not that proof.

### One real config delta worth knowing before any future rollback

`-00013-mrw` predates the rate-limit cluster and **carries no Upstash bindings**:

| | `-00013-mrw` | `-00022-suy` |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | **absent** | secret-bound |
| `UPSTASH_REDIS_REST_TOKEN` | **absent** | secret-bound |
| `minScale` | 1 | 2 |

Rolling back to `-00013-mrw` therefore also drops shared rate-limit counting and
falls back to in-memory per-instance limiting. That is survivable (it fails open
per §1.10) but it is a behavioural change the rollback plan does not currently
name. Worth stating explicitly in whatever rollback note ships with #2269.

## What it would take to close this properly

1. Exclusive use of `arkova-worker-fullsoak-2026-08-staging` — i.e. the `train-5`
   (and any `train-6`) standup finished or moved to another rig.
2. Then, and only then: `update-traffic --to-revisions=…-00013-mrw=100`, health
   probe, `update-traffic --to-latest` **or** an explicit re-pin that restores the
   `latestRevision: true` entry the train-5 soak depends on.
3. Identity tokens minted **without** `--audiences` (tokens carrying
   `--audiences=<tag URL>` are rejected by Cloud Run and 401 every path,
   `/health` included).

Alternatively the rehearsal can be run on a **purpose-built throwaway service**
from the same two image digests, which proves the promote-and-serve path without
contending for a rig anyone is soaking on. That is the cheaper option and does not
block on train-5.

## Bottom line

**A T3 §1.12 rollback rehearsal for the chain-pair union has not happened.** The
evidence-state of the rig it would have been run against no longer exists: the rig
was reclaimed for another soak roughly 1 h 48 m after the chain-pair clock closed.
This gap is open, not closed.

---
_All gcloud output above is live-captured 2026-08-21T18:47Z–19:01Z. No write
operation was performed against any Cloud Run service in producing this document._

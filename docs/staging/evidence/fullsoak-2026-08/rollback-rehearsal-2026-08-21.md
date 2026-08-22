# Chain-pair T3 — deploy rollback rehearsal

**Status: RUN — on a purpose-built throwaway service, 2026-08-21T19:14Z–19:19Z.
The rollback image starts and serves healthy. See the ADDENDUM below for results.**

**The in-place traffic shift on the real rig was, and remains, impossible** — the rig is
hosting a live soak. Part 1 records that in full and is unchanged; it is the reason the
rehearsal took the throwaway-service route rather than a waiver.

---

## Part 1 — why the IN-PLACE rehearsal could not run
_Written 2026-08-21T19:05Z. Author: soak-evidence session. Verbatim; superseded only in
the narrow sense that the ADDENDUM below closes the question Part 1 left open._

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

## Bottom line (of Part 1 — see the ADDENDUM for the current status)

**A T3 §1.12 rollback rehearsal for the chain-pair union has not happened.** The
evidence-state of the rig it would have been run against no longer exists: the rig
was reclaimed for another soak roughly 1 h 48 m after the chain-pair clock closed.
This gap is open, not closed.

---
_All gcloud output above is live-captured 2026-08-21T18:47Z–19:01Z. No write
operation was performed against any Cloud Run service in producing this document._

---

# ADDENDUM — rehearsal PERFORMED on a throwaway service, 2026-08-21T19:14Z–19:19Z

**Status: RUN. The rollback image starts and serves healthy.**
**Author: soak-evidence session, 2026-08-21T19:2xZ. Everything above this line stands
unchanged — the in-place rehearsal was and remains impossible, for the reasons stated.**

This addendum takes the second option the section above proposed ("a purpose-built
throwaway service from the same two image digests"). It answers the one question image
existence could not: **does `-00013-mrw`'s image boot, connect, and serve `/health` at
200 with all three subsystem checks green?** It does. It also proves the forward
direction, and it produced a materially sharper version of the Upstash finding.

**No live soak was touched.** See the audit-log proof at the end.

## Method

A new, private Cloud Run service `arkova-worker-rollback-rehearsal-2026-08-21` was
created in `us-central1` / `arkova1`, then **three** revisions were deployed onto it and
probed, then the service was deleted. Env and secret sets were reconstructed
programmatically from `gcloud run revisions describe --format=json` of the two source
revisions, so the reproduction is exact rather than hand-copied.

Both source-revision configs were replayed in full, not just their images. That matters:
a Cloud Run revision's env/secret set is immutable and travels with the revision, so a
traffic-shift rollback to `-00013-mrw` gets **`-00013-mrw`'s env**, not the service's
current env. Replaying only the image would have tested the wrong thing.

| Rev | Image | Env/secret set replayed | What it models |
|---|---|---|---|
| `-00001-6rg` | `sha256:8ace89d4…c1e18` (rollback) | `-00013-mrw` exactly | **Rollback by traffic-shift** to the prior revision |
| `-00002-kt8` | `sha256:d7a95607…7ea45` (soaked) | `-00022-suy` exactly | **Forward** — the soaked chain-pair image |
| `-00003-66s` | `sha256:8ace89d4…c1e18` (rollback) | `-00022-suy` + BUILD_SHA re-pinned | **Rollback by `deploy --image=<old>`** onto the live service |

Digests were resolved from the revisions themselves, never guessed from a tag — and in
fact neither digest carries a tag in Artifact Registry, so a tag guess was not available:

```
$ gcloud artifacts docker images describe \
    us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@sha256:8ace89d4…c1e18 \
    --project=arkova1 --format='yaml(image_summary.digest,image_summary.tags)'
image_summary:
  digest: sha256:8ace89d483484c40ea2022f7f21361effbfd6e0ab4d61ac4707f54e2ed1c1e18
        # no `tags:` key — untagged, digest-pinned
```

`BUILD_SHA` was set explicitly on every deploy from the env file, never inherited.
`services/worker/src/utils/buildInfo.ts` is `getBuildSha() { return process.env.BUILD_SHA
?? 'unknown' }` — `/health`'s `git_sha` is **only** that env var, so a `gcloud run deploy`
that omits it silently reports the previous revision's SHA. Both SHAs were confirmed to be
real commits with creation times consistent with their revisions:

```
$ git log -1 --format='%H %ci %s' f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58
f5d1070f… 2026-08-12 08:43:02 -0400 Merge pull request #2209 … econ1-fee-ceiling-fail-closed
   (rev -00013-mrw created 2026-08-12T15:09:42Z — 2 h 26 m later)
$ git log -1 --format='%H %ci %s' daf3d6056788762ba56da5c328154e50fce03b59
daf3d605… 2026-08-19 12:30:06 -0400 Merge remote-tracking branch 'origin/rc/rate-limit-cluster-2026-08' …
   (rev -00022-suy created 2026-08-19T16:51:23Z — 21 m later)
```

### Service creation command (direction 1)

```
$ gcloud run deploy arkova-worker-rollback-rehearsal-2026-08-21 \
    --image=us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@sha256:8ace89d483484c40ea2022f7f21361effbfd6e0ab4d61ac4707f54e2ed1c1e18 \
    --region=us-central1 --project=arkova1 \
    --no-allow-unauthenticated \
    --port=3001 --cpu=2 --memory=2Gi --concurrency=160 --timeout=3600 \
    --min-instances=1 --max-instances=2 \
    --service-account=270018525501-compute@developer.gserviceaccount.com \
    --vpc-connector=fullsoak-btc-rpc --vpc-egress=private-ranges-only \
    --env-vars-file=env-00013-mrw.yaml \
    --set-secrets="$(cat secrets-00013-mrw.txt)" \
    --labels=purpose=rollback-rehearsal,ephemeral=true
```

Directions 2 and 3 are the same command with `--image` / `--env-vars-file` /
`--set-secrets` swapped per the table above. `--no-allow-unauthenticated` throughout; no
`allUsers` binding was ever created (proven below by the 403s).

Identity tokens were minted **without** `--audiences`, per the constraint recorded above.

## Result 1 — ROLLBACK direction: the image starts and serves healthy

```
T0 (deploy issued)          2026-08-21T19:14:32Z
gcloud returned Ready       2026-08-21T19:14:51Z   (19.5 s wall)
revision creationTimestamp  2026-08-21T19:14:33.881155Z
startup probe               "Default STARTUP TCP probe succeeded after 1 attempt
                             for container arkova-worker-1 on port 3001"
first HTTP 200 on /health   T0 + 37.6 s   (first attempt — no failed probe preceded it)
```

```
$ curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" .../health
{
    "status": "healthy",
    "version": "0.1.0",
    "git_sha": "f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58",
    "uptime": 32,
    "network": "signet",
    "checks": { "database": "ok", "anchoring": "ok", "kms": "ok" }
}
```

`git_sha` is the **rollback** SHA — the env pin held, and `/health` is not reporting a
stale value.

Five consecutive probes, all `200`: **0.482 s, 0.363 s, 0.373 s, 0.336 s, 0.373 s**
(the 0.482 s first sample is the warm-up).

Detailed view (`?detailed=true` + `X-Health-Token`, secret
`health-detail-token-fullsoak-2026-08-staging`):

```
"database":  { "status": "ok", "latencyMs": 65 }
"anchoring": { "status": "ok", "lastSecuredAt": "2026-08-21T02:16:17.255270+00:00",
               "lastBatchAt": "2026-08-21T18:09:05.067101+00:00", "pendingCount": 0,
               "feeRateSatVb": 1, "drainStalled": false, "drainReason": "ok" }
"kms":       { "status": "ok", "provider": "wif" }
"connection": { "mode": "direct", "url": "https://gnkuaywlpmsaezwvlvhk.supabase.co" }
```

Worth naming: the rollback image reaches the **private signet Bitcoin Core RPC over the
`fullsoak-btc-rpc` VPC connector**, initialises the **WIF signing provider** (`kms.provider
= wif`, log line `Creating WIF signing provider`), and builds the GetBlock hybrid UTXO
provider — `Chain client initialized`, `Using BitcoinChainClient (signet)`. For a
chain/treasury rollback target those three are the checks that actually matter, and all
three passed on the old image.

## Result 2 — FORWARD direction: the soaked image starts and serves healthy

```
T0 (deploy issued)          2026-08-21T19:15:55Z
gcloud returned Ready       2026-08-21T19:16:17Z   (21.9 s wall)
revision creationTimestamp  2026-08-21T19:15:57.391917Z
first HTTP 200 with the new SHA   T0 + 34.6 s   (first attempt)
```

```
{ "status": "healthy", "git_sha": "daf3d6056788762ba56da5c328154e50fce03b59",
  "uptime": 28, "network": "signet",
  "checks": { "database": "ok", "anchoring": "ok", "kms": "ok" } }
```

Five probes, all `200`: **0.392 s, 0.335 s, 0.254 s, 0.281 s, 0.276 s**.
Detailed: `database ok / 71 ms`, `anchoring ok / drainStalled false`, `kms ok / wif`.

### Both directions, side by side

| | Rollback (`8ace89d4…`) | Forward (`d7a95607…`) |
|---|---|---|
| Deploy → revision Ready (gcloud wall) | **19.5 s** | **21.9 s** |
| Deploy → first HTTP 200 | **37.6 s** | **34.6 s** |
| Failed probes before first 200 | **0** | **0** |
| Startup TCP probe attempts | **1** | **1** |
| Steady `/health` latency (4 samples after warm-up) | 0.336–0.373 s | 0.254–0.335 s |
| `checks.database` / `anchoring` / `kms` | ok / ok / ok | ok / ok / ok |
| `kms.provider` | `wif` | `wif` |

The two directions are symmetric to within a few seconds. There is no asymmetric risk
in the rollback direction on this evidence.

## The env/secret delta, computed rather than eyeballed

Full programmatic diff of the two source revisions (31 plain env vars and 13/15 secret
bindings each). **These four rows are the complete delta — every other env var, secret
binding, VPC setting, resource limit and probe setting is identical.**

| Key | `-00013-mrw` (rollback) | `-00022-suy` (soaked) | Consequence of a rollback |
|---|---|---|---|
| `UPSTASH_REDIS_REST_URL` | **absent** | secret `UPSTASH_REDIS_REST_URL:latest` | shared rate-limit counting lost |
| `UPSTASH_REDIS_REST_TOKEN` | **absent** | secret `UPSTASH_REDIS_REST_TOKEN:latest` | as above |
| `BUILD_SHA` | `f5d1070f…4a58` | `daf3d605…3b59` | expected; identity only |
| `autoscaling.knative.dev/minScale` | `1` | `2` | one fewer warm instance |

(`run.googleapis.com/operation-id` also differs; it is a per-deploy identifier and carries
no behaviour.)

Identical across both: all 29 other plain env vars, all 13 shared secret bindings
(Supabase URL + service-role key, Stripe secret + webhook secret, API-key HMAC secret,
cron secret, IP hash pepper, Bitcoin RPC URL + auth, treasury WIF, Gemini key, DocuSign
Connect HMAC, health-detail token), `containerConcurrency: 160`, `cpu: 2`, `memory: 2Gi`,
`timeoutSeconds: 3600`, `containerPort: 3001`, service account,
`vpc-access-connector: fullsoak-btc-rpc`, `vpc-access-egress: private-ranges-only`,
`maxScale: 5`, `startup-cpu-boost: true`.

## Result 3 — the Upstash finding, confirmed AND corrected

**Confirmed:** the previous section's claim is right as far as it goes. Runtime log lines,
one per revision, are unambiguous:

```
rev -00001-6rg (rollback image + rollback revision env):
  "Upstash Redis not configured — using in-memory rate limiting"
  "Upstash Redis not configured — using in-memory stores (rate limit + idempotency)"

rev -00002-kt8 (soaked image + soaked revision env):
  "Upstash Redis rate limiting initialized (shared counters via INCR)"
  "Upstash Redis idempotency store initialized"
```

So a **traffic-shift rollback to `-00013-mrw` does drop shared cross-instance rate-limit
counting**, and drops the Redis-backed idempotency store with it — which the previous
section did not name. Both fall back to per-instance in-memory state.

**Corrected, and this is the part that matters for #2269:** the loss is a property of the
*rollback path*, not of the *image*. The rollback image is fully Upstash-capable. At
commit `f5d1070f`, `services/worker/src/utils/upstashRateLimit.ts` already exists and
reads the bindings directly off `process.env`, bypassing the Zod config object:

```
export function initUpstashRateLimiting(): boolean {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.UPSTASH_REDIS_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.UPSTASH_REDIS_TOKEN;
```

(This is why `grep -i upstash` finds nothing in `config.ts` at that commit and the module
still works.) Revision `-00003-66s` proves it empirically — rollback **image**, current
**service** env/secret set:

```
rev -00003-66s (rollback image + soaked revision env):
  "Upstash Redis rate limiting initialized"
  "Upstash Redis idempotency store initialized"
  git_sha f5d1070f…4a58,  first 200 at T0+42.0 s,  checks db/anchoring/kms all ok
```

### Three rollback postures, three different rate-limiting outcomes

| Rollback method | Upstash bindings | Rate-limit behaviour after rollback |
|---|---|---|
| `update-traffic --to-revisions=…-00013-mrw=100` | **lost** (revision env is immutable) | in-memory, per-instance; idempotency store also in-memory |
| `run deploy --image=<old digest>` onto the live service | **preserved** (service-level config) | shared via Upstash — **but see the caveat below** |
| stay on `-00022-suy` | present | shared counters via atomic `INCR`, namespaced |

**Caveat on the second row, and it is not a small one.** The old image's Upstash store is
not the same store. At `daf3d605` the module imports `resolveEnvironmentNamespace` from
`./environmentNamespace.js` and logs `(shared counters via INCR)`; at `f5d1070f` there is
no namespace import at all and the store is a read-through cache over plain
`GET`/`SET`-with-TTL against `${baseUrl}/get/<key>` and `${baseUrl}/set/<key>/…/ex/<ttl>`.
So a `deploy --image=<old>` rollback would keep talking to the **same Upstash database**
while writing **unnamespaced** keys with **non-atomic** counting. That is a different
failure mode from losing Upstash outright — quieter, and potentially cross-environment if
anything else shares that Redis instance.

**For the #2269 rollback note, the honest statement is therefore:** *"Rolling back past
the rate-limit cluster degrades rate limiting in one of two ways depending on how the
rollback is performed. Traffic-shifting to `-00013-mrw` loses Upstash entirely and falls
back to per-instance in-memory limiting (fails open per §1.10). Re-deploying the old image
onto the current service keeps the bindings, but the pre-#2269 store writes unnamespaced,
non-atomic keys into the same Redis database. Neither is a hard failure; both must be
named before a rollback, and the first is the safer of the two precisely because it is
loud."* That is a finding in its own right, as the section above anticipated.

## Contamination control — and why this was not free

The throwaway service necessarily pointed at the **same Supabase project the TRAIN-5 soak
is running against** (`gnkuaywlpmsaezwvlvhk`, visible in the detailed health `connection`
block). That is unavoidable: a `checks.database` that does not hit the real database
proves nothing. But `routes/scheduled.ts` registers in-process cron that **writes** the
anchors table — `recover-stuck-broadcasts` and `check-submitted-confirmations` every 2 min,
`process-batch-anchors` every 10 min, `process-revoked-anchors` every 5 min,
`drain-connector-artifacts` every 5 min. A second worker on that database could have
corrupted TRAIN-5's window.

Mitigation: **`DISABLE_IN_PROCESS_ANCHOR_CRON=true`** was added to every deploy — the
purpose-built production maintenance switch (`config.ts:156`), which makes
`scheduleInProcess()` skip the entire `ANCHOR_TABLE_IN_PROCESS_JOBS` allowlist. This is a
deliberate divergence from the source revisions and is disclosed as such; it does not touch
the startup path the rehearsal exists to test. The service was also kept alive for under
five minutes, deliberately inside a single clock hour so the unconditional hourly
`drive-subscription-renewal` (`0 * * * *`, which takes a cross-instance run lease and would
have orphaned it on delete) could not fire.

Verified after the fact rather than assumed. Every log line the throwaway emitted, deduped:

```
  30  Skipping in-process anchor cron in production because DISABLE_IN_PROCESS_ANCHOR_CRON=true
   6  Creating mempool fee estimator
   3  Worker service started
   3  Using BitcoinChainClient (signet)
   3  Scheduled jobs configured (including chain maintenance)
   3  Creating WIF signing provider
   3  Creating GetBlock hybrid UTXO provider
   3  Chain client initialized / Bitcoin chain client initialized
   3  Default STARTUP TCP probe succeeded after 1 attempt … on port 3001
   3  Feature flag registry initialized / Heap monitor started
   2  Upstash Redis idempotency store initialized
   2  Received shutdown signal / HTTP server closed — all connections drained
```

30 skips = 10 anchor-table jobs × 3 revisions. **No cron job body executed** — no batch
run, no confirmation check, no revocation pass, no webhook retry, no connector drain, no
run lease taken, no Drive renewal. Nothing was written to the shared soak database.

Every request the service served:

```
  14  GET /health              200
   2  GET /health?detailed=true 200
   1  GET /health              403   <- deliberate no-auth control
   2  GET /                     403   <- unsolicited, rejected at the Cloud Run auth layer
   2  GET /favicon.ico          403   <- ditto
```

The five 403s are also the proof that `--no-allow-unauthenticated` held: three of them are
unsolicited probes that never reached the container.

### Correction to the token guidance above

Tokens were minted **without** `--audiences` as instructed, and worked. But a control run
minted **with** `--audiences=<the service's own default run.app URL>` **also returned 200**.
So the "401 on every path including `/health`" behaviour recorded in the section above is
not caused by `--audiences` as such — it is caused by an audience that does not match the
service's default URL, which is exactly what happens when the audience is set to a **tag**
URL (`https://cp0819rc---….run.app`). The operative rule is: *never mint against a tag URL;
omitting `--audiences` is the reliable way to avoid the question.*

## Teardown, and cost

```
$ gcloud run services delete arkova-worker-rollback-rehearsal-2026-08-21 \
    --region=us-central1 --project=arkova1 --quiet
Deleting [arkova-worker-rollback-rehearsal-2026-08-21]...done.
Deleted service [arkova-worker-rollback-rehearsal-2026-08-21].

$ gcloud run services describe arkova-worker-rollback-rehearsal-2026-08-21 …
ERROR: (gcloud.run.services.describe) Cannot find service
       [arkova-worker-rollback-rehearsal-2026-08-21]

$ gcloud run services list --region=us-central1 --project=arkova1 | grep -i rollback
  (no match)
```

Deleted at **2026-08-21T19:19:05Z**; total service lifetime **4 m 35 s**
(19:14:33Z → 19:19:08Z), three revisions, all `Ready=True`.

**Cost: negligible, and stated plainly rather than waved away.** 2 vCPU / 2 GiB with
`min-instances=1` for ~275 instance-seconds is on the order of 550 vCPU-seconds and 550
GiB-seconds, i.e. **a few cents at most** — under $0.05 including the brief overlap while
revisions swapped. A short-lived Cloud Run service is genuinely the cheap way to run this;
there is no reason a future rollback rehearsal should ever be deferred on cost grounds.
This is also §7's standing hygiene rule honoured on the spot: the rig was torn down in the
same session that created it, not left as a cold spare.

## The four live soaks were untouched — audit-log proof

Service state was captured before the rehearsal and re-captured after teardown
(`metadata.generation`, `metadata.resourceVersion`, `status.latestReadyRevisionName`,
`status.observedGeneration`, and the **complete** `status.traffic` array), then diffed.
The diff is empty:

| Soak | Service | Generation | latestReady | Before vs after |
|---|---|---|---|---|
| TRAIN-5 (closes 08-22T06:39:17Z) | `arkova-worker-fullsoak-2026-08-staging` | 25 | `-00024-kaj` | **identical** |
| TRAIN-4 (closes 08-22T01:57:35Z) | `arkova-worker-wave3-2026-08-staging` | 5 | `-00005-rib` | **identical** |
| migration-T3 (closes 08-22T14:00:22Z) | `arkova-worker-staging` | 301 | `-00300-few` | **identical** |
| TRAIN-6 (closes 08-23T18:54:36Z) | `arkova-worker-wave2-2026-08-staging` | 5 | `-00005-nax` | **identical** |

`resourceVersion` was unchanged on all four as well — no read-modify-write occurred, not
even a no-op one.

Independent confirmation from the admin-activity audit log. Every Cloud Run service
mutation in the hour:

```
$ gcloud logging read 'logName=".../cloudaudit.googleapis.com%2Factivity"
    AND resource.type="cloud_run_revision"
    AND protoPayload.methodName:("ReplaceService" OR "CreateService" OR "DeleteService")' \
    --project=arkova1 --freshness=1h

TIMESTAMP                    RESOURCE_NAME                                METHOD_NAME
2026-08-21T19:19:05.488182Z  arkova-worker-rollback-rehearsal-2026-08-21  DeleteService
2026-08-21T19:17:17.225711Z  arkova-worker-rollback-rehearsal-2026-08-21  ReplaceService
2026-08-21T19:15:57.106302Z  arkova-worker-rollback-rehearsal-2026-08-21  ReplaceService
2026-08-21T19:14:33.613750Z  arkova-worker-rollback-rehearsal-2026-08-21  CreateService
2026-08-21T18:54:36.395587Z  arkova-worker-wave2-2026-08-staging          ReplaceService
2026-08-21T18:44:16.364235Z  arkova-worker-fullsoak-2026-08-staging       ReplaceService
2026-08-21T18:39:17.127025Z  arkova-worker-fullsoak-2026-08-staging       ReplaceService
```

The only four writes in the rehearsal window (19:14:33Z–19:19:05Z) are the throwaway's own
create / replace / replace / delete. The three soak-service writes all **predate** the
rehearsal and belong to the TRAIN-5 and TRAIN-6 standups. `gcloud run services
update-traffic` was never invoked, in this session or the one that wrote the section above.

## What this rehearsal proves — and what it does NOT

**Proven:**

1. The rollback image `sha256:8ace89d4…c1e18` **starts, listens on 3001 on the first
   startup-probe attempt, and serves `/health` 200** with `database`, `anchoring` and
   `kms` all `ok` — against the real soak database, the real private signet Bitcoin RPC
   over the real VPC connector, and the real treasury WIF signer. This was the genuinely
   unknown risk, and it is now closed.
2. It reports the correct `git_sha` (`f5d1070f…`), so post-rollback verification will not
   be reading a stale identity.
3. The forward direction works symmetrically, ~35–38 s deploy-to-first-200 either way, no
   failed probes in either direction.
4. The full env/secret delta between the two revisions is exactly four keys, of which two
   are the Upstash bindings, one is `BUILD_SHA`, one is `minScale`.
5. Losing Upstash on rollback is real, is *path-dependent*, and the old image is
   Upstash-capable — with an unnamespaced, non-atomic store.

**NOT proven — read this before citing the section above as closed:**

1. **This was not an in-place traffic shift on the real rig.** The rig is hosting the
   TRAIN-5 soak and was correctly left alone. The mechanics of
   `update-traffic --to-revisions=…` on `arkova-worker-fullsoak-2026-08-staging`
   specifically — including the `latestRevision: true` replacement hazard described above,
   and the time a real traffic shift takes to drain and re-route on a service under load —
   **remain untested**. A throwaway service tests the image; it does not test the shift.
2. **Cold-start numbers, not shift numbers.** 37.6 s / 34.6 s are *create-service-and-boot*
   timings on a brand-new service with `min-instances=1`. An in-place `update-traffic`
   between two already-warm revisions would be far faster. These figures are an upper
   bound on rollback time, not a measurement of it.
3. **`/health` is not the workload.** No anchor was submitted, no batch drained, no
   confirmation checked, no webhook delivered, no `POST /api/v1/*` exercised on either
   image. In-process anchor cron was **deliberately disabled** on all three revisions, so
   the rollback image's *scheduled-job* behaviour is untested here. This rehearsal proves
   boot-and-serve, not functional equivalence under load.
4. **`minScale` was 1, not the soaked revision's 2**, and `maxScale` 2 rather than 5. The
   throwaway also kept `CRON_OIDC_AUDIENCE` and `WORKER_PUBLIC_URL` pointing at the
   fullsoak service's URL (faithful to the source revisions, unused by `/health`).
5. **No rollback of state.** §1.12's migration rollback/reapply requirement is a separate
   obligation; nothing here touches it. The chain-pair union's `rollback_proof` of
   `N/A — no PR touches supabase/migrations/` is unaffected either way.
6. The `-00022-suy` evidence binding described in the section above is still gone. This
   rehearsal does not restore it and does not claim to.

## Bottom line

**The §1.12 deploy rollback rehearsal for the chain-pair T3 union is now RUN, at the
image level, in both directions, with the rollback image confirmed to boot and serve
healthy.** The residual gap is narrower and different from the one recorded above: it is no
longer "we do not know whether the rollback target works", it is "we have not exercised an
in-place traffic shift on a rig that is currently hosting someone else's soak." That
residual is worth naming in the RC record; it is not worth taking a live soak down for.

---
_All gcloud, curl and logging output above is live-captured 2026-08-21T19:10Z–19:22Z.
The only write operations performed against Cloud Run in this session are the four against
`arkova-worker-rollback-rehearsal-2026-08-21`, which no longer exists._

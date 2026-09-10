# PR #2441 Batch B T2 close capture — 2026-08-30T03:34:50Z

Window 2026-08-29T15:34:50Z -> 2026-08-30T03:34:50Z; tag pr-2441; head 5b5ccea937c4c30363bf2435bdcd4d712c95b905

## 1. Health at close (5x /health, exact-head predicate)
  run 1: HTTP 200 0.302180s git_sha=5b5ccea937c4c30363bf2435bdcd4d712c95b905
  run 2: HTTP 200 0.213467s git_sha=5b5ccea937c4c30363bf2435bdcd4d712c95b905
  run 3: HTTP 200 0.362477s git_sha=5b5ccea937c4c30363bf2435bdcd4d712c95b905
  run 4: HTTP 200 0.205295s git_sha=5b5ccea937c4c30363bf2435bdcd4d712c95b905
  run 5: HTTP 200 0.187452s git_sha=5b5ccea937c4c30363bf2435bdcd4d712c95b905
  -> health fails: 0 (want 0)

## 2. Tag routing / revision identity
  tag pr-2441 -> revision arkova-worker-staging-00365-weh (expected arkova-worker-staging-00365-weh)
  -> REVISION UNCHANGED. PASS
  revision createTime + digest: 2026-08-29T15:14:20.735533Z	us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@sha256:2d1bd68102523ef1fd26a888ac0624b6162df4d85731c6a26b2b39e7e304ae3b
  -> digest matches. PASS
  NOTE: the soak clock is this revision's creationTimestamp / uptime, not the driver loop.

## 3. Serving revisions in-window (2h chunks, 20k cap made visible)
  2026-08-29T15:34:50Z -> 2026-08-29T17:34:50Z : 9908 requests
  2026-08-29T17:34:50Z -> 2026-08-29T19:34:50Z : 8563 requests
  2026-08-29T19:34:50Z -> 2026-08-29T21:34:50Z : 8558 requests
  2026-08-29T21:34:50Z -> 2026-08-29T23:34:50Z : 8460 requests
  2026-08-29T23:34:50Z -> 2026-08-30T01:34:50Z : 8472 requests
  2026-08-30T01:34:50Z -> 2026-08-30T03:34:50Z : 6920 requests
  total sampled requests (whole service, all tags): 50881
  distinct serving revisions:
    20764 arkova-worker-staging-00365-weh
    9817 arkova-worker-staging-batcha-2274
    7202 arkova-worker-staging-00356-qip
    6914 arkova-worker-staging-00355-nup
    1887 arkova-worker-staging-00364-qis
    1794 arkova-worker-staging-00358-yon
     905 arkova-worker-staging-00359-ted
     895 arkova-worker-staging-batcha-2446
     435 arkova-worker-staging-00357-yej
     261 arkova-worker-staging-00354-wod
       7 arkova-worker-staging-00300-few
  -> arkova-worker-staging-00365-weh served in-window. PASS

## 4. Container terminations / OOM / errors in-window
  entries: 0 ; memory/OOM/termination-shaped: 0
  -> none. PASS

## 5. 5xx on arkova-worker-staging-00365-weh in-window
  2026-08-29T15:34:50Z -> 2026-08-29T17:34:50Z : 0 x 5xx
  2026-08-29T17:34:50Z -> 2026-08-29T19:34:50Z : 0 x 5xx
  2026-08-29T19:34:50Z -> 2026-08-29T21:34:50Z : 0 x 5xx
  2026-08-29T21:34:50Z -> 2026-08-29T23:34:50Z : 0 x 5xx
  2026-08-29T23:34:50Z -> 2026-08-30T01:34:50Z : 0 x 5xx
  2026-08-30T01:34:50Z -> 2026-08-30T03:34:50Z : 0 x 5xx
  TOTAL 5xx in-window: 0
  NOTE for PR #2435: intentional 500s from the ATS poison probe are EXPECTED here and are the fix's own signal.

## 6. Driver evidence roll-up (/Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/docs/staging/batch-b-2026-08/evidence/pr-2441)
{
  "artifacts_found": 194,
  "artifacts_parsed": 194,
  "artifacts_UNPARSEABLE": 0,
  "unparseable_files": [],
  "first_cycle": "2026-08-29T15:36:46.334Z",
  "last_cycle": "2026-08-30T03:33:28.662Z",
  "requests_total": 21922,
  "requests_failed_transport": 3,
  "status_429": 0,
  "cycles_with_deviations": 2
}
!!! 2 cycle(s) carry deviations — see driver-rollup.json

  supervisor log:
    rc=0 cycles: 0
    2026-08-29T16:27:33Z !!! cycle 14 exited rc=3 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:59:34Z cycle 118 exited rc=4 — TOLERATED signal (#1 of 12)
    2026-08-30T03:34:50Z supervisor done cycles=194 failed=1 tolerated=1
## 7. At-close staging-honesty preflight
  preflight_at_close: environment_type=clean_mirror ts=2026-08-30T03:36:03.627Z ref=fizyjojbebyalirtjjht checks=8/8


---
Artifacts: /Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/docs/staging/batch-b-2026-08/evidence/pr-2441/close-20260830T033450Z
Next: the rollback rehearsal (it moves the pr-2441 tag, so it must come AFTER this capture and only once THIS window has closed). Use --update-tags, never --set-tags.

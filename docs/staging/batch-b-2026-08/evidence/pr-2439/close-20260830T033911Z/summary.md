# PR #2439 Batch B T2 close capture — 2026-08-30T03:39:11Z

Window 2026-08-29T15:34:50Z -> 2026-08-30T03:34:50Z; tag pr-2439; head 279e276a27cf07ecc9244df63f65c3f6159aafec

## 1. Health at close (5x /health, exact-head predicate)
  run 1: HTTP 200 0.790099s git_sha=279e276a27cf07ecc9244df63f65c3f6159aafec
  run 2: HTTP 200 0.403728s git_sha=279e276a27cf07ecc9244df63f65c3f6159aafec
  run 3: HTTP 200 0.667551s git_sha=279e276a27cf07ecc9244df63f65c3f6159aafec
  run 4: HTTP 200 0.504629s git_sha=279e276a27cf07ecc9244df63f65c3f6159aafec
  run 5: HTTP 200 0.392170s git_sha=279e276a27cf07ecc9244df63f65c3f6159aafec
  -> health fails: 0 (want 0)

## 2. Tag routing / revision identity
  tag pr-2439 -> revision arkova-worker-staging-00364-qis (expected arkova-worker-staging-00364-qis)
  -> REVISION UNCHANGED. PASS
  revision createTime + digest: 2026-08-29T15:07:47.490815Z	us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@sha256:914671b39a5e6bb84a209d21c6643c765ba16b4326daf962f50083d82852e791
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
  -> arkova-worker-staging-00364-qis served in-window. PASS

## 4. Container terminations / OOM / errors in-window
  entries: 0 ; memory/OOM/termination-shaped: 0
  -> none. PASS

## 5. 5xx on arkova-worker-staging-00364-qis in-window
  2026-08-29T15:34:50Z -> 2026-08-29T17:34:50Z : 0 x 5xx
  2026-08-29T17:34:50Z -> 2026-08-29T19:34:50Z : 0 x 5xx
  2026-08-29T19:34:50Z -> 2026-08-29T21:34:50Z : 0 x 5xx
  2026-08-29T21:34:50Z -> 2026-08-29T23:34:50Z : 0 x 5xx
  2026-08-29T23:34:50Z -> 2026-08-30T01:34:50Z : 0 x 5xx
  2026-08-30T01:34:50Z -> 2026-08-30T03:34:50Z : 0 x 5xx
  TOTAL 5xx in-window: 0
  NOTE for PR #2435: intentional 500s from the ATS poison probe are EXPECTED here and are the fix's own signal.

## 6. Driver evidence roll-up (/Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/docs/staging/batch-b-2026-08/evidence/pr-2439)
{
  "artifacts_found": 127,
  "artifacts_parsed": 127,
  "artifacts_UNPARSEABLE": 0,
  "unparseable_files": [],
  "first_cycle": "2026-08-29T15:40:03.519Z",
  "last_cycle": "2026-08-30T03:39:11.432Z",
  "requests_total": 1905,
  "requests_failed_transport": 8,
  "status_429": 0,
  "cycles_with_deviations": 4
}
!!! 4 cycle(s) carry deviations — see driver-rollup.json

  supervisor log:
    rc=0 cycles: 0
    2026-08-29T16:25:42Z cycle 9 exited rc=4 — TOLERATED signal (#1 of 12)
    2026-08-29T16:31:47Z cycle 10 exited rc=4 — TOLERATED signal (#2 of 12)
    2026-08-29T21:23:03Z cycle 61 exited rc=4 — TOLERATED signal (#3 of 12)
    2026-08-29T23:00:43Z cycle 78 exited rc=4 — TOLERATED signal (#4 of 12)
    2026-08-30T03:39:11Z supervisor done cycles=127 failed=0 tolerated=4
## 7. At-close staging-honesty preflight
  preflight_at_close: environment_type=clean_mirror ts=2026-08-30T03:40:34.828Z ref=fizyjojbebyalirtjjht checks=8/8


---
Artifacts: /Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/docs/staging/batch-b-2026-08/evidence/pr-2439/close-20260830T033911Z
Next: the rollback rehearsal (it moves the pr-2439 tag, so it must come AFTER this capture and only once THIS window has closed). Use --update-tags, never --set-tags.

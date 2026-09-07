# PR #2434 Batch B T2 close capture — 2026-08-30T11:04:34Z

Window 2026-08-29T23:04:27Z -> 2026-08-30T11:04:27Z; tag pr-2434; head 1095e647e0d8df02ea38c3b41018b504680ad615

## 1. Health at close (5x /health, exact-head predicate)
  run 1: HTTP 200 0.430688s git_sha=1095e647e0d8df02ea38c3b41018b504680ad615
  run 2: HTTP 200 0.200630s git_sha=1095e647e0d8df02ea38c3b41018b504680ad615
  run 3: HTTP 200 0.195735s git_sha=1095e647e0d8df02ea38c3b41018b504680ad615
  run 4: HTTP 200 0.208849s git_sha=1095e647e0d8df02ea38c3b41018b504680ad615
  run 5: HTTP 200 0.359162s git_sha=1095e647e0d8df02ea38c3b41018b504680ad615
  -> health fails: 0 (want 0)

## 2. Tag routing / revision identity
  tag pr-2434 -> revision arkova-worker-staging-00354-wod (expected arkova-worker-staging-00354-wod)
  -> REVISION UNCHANGED. PASS
  revision createTime + digest: 2026-08-28T13:22:04.204185Z	us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@sha256:28fd519748a590911f4b0402cc4d957846373cf3f4a1c06dadee084cf994b8db
  -> digest matches. PASS
  NOTE: the soak clock is this revision's creationTimestamp / uptime, not the driver loop.

## 3. Serving revisions in-window (2h chunks, 20k cap made visible)
  2026-08-29T23:04:27Z -> 2026-08-30T01:04:27Z : 8526 requests
  2026-08-30T01:04:27Z -> 2026-08-30T03:04:27Z : 7960 requests
  2026-08-30T03:04:27Z -> 2026-08-30T05:04:27Z : 1773 requests
  2026-08-30T05:04:27Z -> 2026-08-30T07:04:27Z : 756 requests
  2026-08-30T07:04:27Z -> 2026-08-30T09:04:27Z : 761 requests
  2026-08-30T09:04:27Z -> 2026-08-30T11:04:27Z : 774 requests
  total sampled requests (whole service, all tags): 20550
  distinct serving revisions:
    8048 arkova-worker-staging-00365-weh
    3292 arkova-worker-staging-batcha-2274
    2305 arkova-worker-staging-00355-nup
    2190 arkova-worker-staging-00359-ted
    1803 arkova-worker-staging-00358-yon
    1524 arkova-worker-staging-00356-qip
     757 arkova-worker-staging-00364-qis
     580 arkova-worker-staging-00354-wod
      23 arkova-worker-staging-00357-yej
      19 arkova-worker-staging-batcha-2446
       9 arkova-worker-staging-00300-few
  -> arkova-worker-staging-00354-wod served in-window. PASS

## 4. Container terminations / OOM / errors in-window
  entries: 0 ; memory/OOM/termination-shaped: 0
  -> none. PASS

## 5. 5xx on arkova-worker-staging-00354-wod in-window
  2026-08-29T23:04:27Z -> 2026-08-30T01:04:27Z : 0 x 5xx
  2026-08-30T01:04:27Z -> 2026-08-30T03:04:27Z : 0 x 5xx
  2026-08-30T03:04:27Z -> 2026-08-30T05:04:27Z : 0 x 5xx
  2026-08-30T05:04:27Z -> 2026-08-30T07:04:27Z : 0 x 5xx
  2026-08-30T07:04:27Z -> 2026-08-30T09:04:27Z : 0 x 5xx
  2026-08-30T09:04:27Z -> 2026-08-30T11:04:27Z : 0 x 5xx
  TOTAL 5xx in-window: 0
  NOTE for PR #2435: intentional 500s from the ATS poison probe are EXPECTED here and are the fix's own signal.

## 6. Driver evidence roll-up (/Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/docs/staging/batch-b-2026-08/evidence/pr-2434)
{
  "artifacts_found": 603,
  "artifacts_parsed": 603,
  "artifacts_UNPARSEABLE": 0,
  "unparseable_files": [],
  "first_cycle": "2026-08-29T14:24:14.726Z",
  "last_cycle": "2026-08-30T11:04:34.747Z",
  "requests_total": 3015,
  "requests_failed_transport": 50,
  "status_429": 0,
  "cycles_with_deviations": 10
}
!!! 10 cycle(s) carry deviations — see driver-rollup.json

  supervisor log:
    rc=0 cycles: 0
    2026-08-29T14:06:54Z !!! cycle 1 exited rc=3 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T14:42:15Z !!! cycle 1 exited rc=3 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T14:43:10Z !!! cycle 2 exited rc=3 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T14:44:02Z !!! cycle 3 exited rc=3 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T14:44:54Z !!! cycle 4 exited rc=3 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T14:45:48Z !!! cycle 5 exited rc=3 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T14:46:40Z !!! cycle 6 exited rc=3 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T14:47:32Z !!! cycle 7 exited rc=3 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T14:48:25Z !!! cycle 8 exited rc=3 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T14:59:19Z !!! cycle 9 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T15:10:12Z !!! cycle 10 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T15:21:09Z !!! cycle 11 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T15:32:03Z !!! cycle 12 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T15:42:57Z !!! cycle 13 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T15:53:52Z !!! cycle 14 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:04:46Z !!! cycle 15 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:15:40Z !!! cycle 16 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:26:33Z !!! cycle 17 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:37:28Z !!! cycle 18 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:48:22Z !!! cycle 19 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:59:16Z !!! cycle 20 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T17:10:11Z !!! cycle 21 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T17:21:06Z !!! cycle 22 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T17:32:00Z !!! cycle 23 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T17:42:54Z !!! cycle 24 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T17:53:48Z !!! cycle 25 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:04:43Z !!! cycle 26 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:15:37Z !!! cycle 27 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:26:32Z !!! cycle 28 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:37:27Z !!! cycle 29 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:48:21Z !!! cycle 30 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:59:17Z !!! cycle 31 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T19:10:11Z !!! cycle 32 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T19:21:05Z !!! cycle 33 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T19:31:59Z !!! cycle 34 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T19:42:53Z !!! cycle 35 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T19:53:47Z !!! cycle 36 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:04:41Z !!! cycle 37 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:15:36Z !!! cycle 38 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:26:30Z !!! cycle 39 exited rc=3 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:37:24Z !!! cycle 40 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:48:19Z !!! cycle 41 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:59:15Z !!! cycle 42 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T21:10:09Z !!! cycle 43 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T21:21:03Z !!! cycle 44 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T21:31:59Z !!! cycle 45 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T21:42:54Z !!! cycle 46 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T21:53:50Z !!! cycle 47 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:04:45Z !!! cycle 48 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:15:40Z !!! cycle 49 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:26:34Z !!! cycle 50 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:37:28Z !!! cycle 51 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:48:23Z !!! cycle 52 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:59:17Z !!! cycle 53 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-30T11:04:34Z supervisor done cycles=580 failed=0 tolerated=0
## 7. At-close staging-honesty preflight
  preflight_at_close: environment_type=clean_mirror ts=2026-08-30T11:05:12.421Z ref=fizyjojbebyalirtjjht checks=8/8


---
Artifacts: /Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/docs/staging/batch-b-2026-08/evidence/pr-2434/close-20260830T110434Z
Next: the rollback rehearsal (it moves the pr-2434 tag, so it must come AFTER this capture and only once THIS window has closed). Use --update-tags, never --set-tags.

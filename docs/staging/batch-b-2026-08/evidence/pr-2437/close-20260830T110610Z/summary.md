# PR #2437 Batch B T2 close capture — 2026-08-30T11:06:10Z

Window 2026-08-29T23:04:17Z -> 2026-08-30T11:04:17Z; tag pr-2437; head 6b7229f4b2d7faeb32bad0a0e3209430bd4c8243

## 1. Health at close (5x /health, exact-head predicate)
  run 1: HTTP 200 0.236481s git_sha=6b7229f4b2d7faeb32bad0a0e3209430bd4c8243
  run 2: HTTP 200 0.199961s git_sha=6b7229f4b2d7faeb32bad0a0e3209430bd4c8243
  run 3: HTTP 200 0.354191s git_sha=6b7229f4b2d7faeb32bad0a0e3209430bd4c8243
  run 4: HTTP 200 0.240000s git_sha=6b7229f4b2d7faeb32bad0a0e3209430bd4c8243
  run 5: HTTP 200 0.193199s git_sha=6b7229f4b2d7faeb32bad0a0e3209430bd4c8243
  -> health fails: 0 (want 0)

## 2. Tag routing / revision identity
  tag pr-2437 -> revision arkova-worker-staging-00358-yon (expected arkova-worker-staging-00358-yon)
  -> REVISION UNCHANGED. PASS
  revision createTime + digest: 2026-08-28T13:43:34.657016Z	us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@sha256:0d49c0e48b90b488007fb5a4eeb844ad126398f1f968a58a8ef6f789fa9ec1cc
  -> digest matches. PASS
  NOTE: the soak clock is this revision's creationTimestamp / uptime, not the driver loop.

## 3. Serving revisions in-window (2h chunks, 20k cap made visible)
  2026-08-29T23:04:17Z -> 2026-08-30T01:04:17Z : 8497 requests
  2026-08-30T01:04:17Z -> 2026-08-30T03:04:17Z : 7997 requests
  2026-08-30T03:04:17Z -> 2026-08-30T05:04:17Z : 1777 requests
  2026-08-30T05:04:17Z -> 2026-08-30T07:04:17Z : 756 requests
  2026-08-30T07:04:17Z -> 2026-08-30T09:04:17Z : 760 requests
  2026-08-30T09:04:17Z -> 2026-08-30T11:04:17Z : 775 requests
  total sampled requests (whole service, all tags): 20562
  distinct serving revisions:
    8048 arkova-worker-staging-00365-weh
    3300 arkova-worker-staging-batcha-2274
    2305 arkova-worker-staging-00355-nup
    2190 arkova-worker-staging-00359-ted
    1804 arkova-worker-staging-00358-yon
    1526 arkova-worker-staging-00356-qip
     758 arkova-worker-staging-00364-qis
     580 arkova-worker-staging-00354-wod
      23 arkova-worker-staging-00357-yej
      19 arkova-worker-staging-batcha-2446
       9 arkova-worker-staging-00300-few
  -> arkova-worker-staging-00358-yon served in-window. PASS

## 4. Container terminations / OOM / errors in-window
  entries: 0 ; memory/OOM/termination-shaped: 0
  -> none. PASS

## 5. 5xx on arkova-worker-staging-00358-yon in-window
  2026-08-29T23:04:17Z -> 2026-08-30T01:04:17Z : 0 x 5xx
  2026-08-30T01:04:17Z -> 2026-08-30T03:04:17Z : 0 x 5xx
  2026-08-30T03:04:17Z -> 2026-08-30T05:04:17Z : 0 x 5xx
  2026-08-30T05:04:17Z -> 2026-08-30T07:04:17Z : 0 x 5xx
  2026-08-30T07:04:17Z -> 2026-08-30T09:04:17Z : 0 x 5xx
  2026-08-30T09:04:17Z -> 2026-08-30T11:04:17Z : 0 x 5xx
  TOTAL 5xx in-window: 0
  NOTE for PR #2435: intentional 500s from the ATS poison probe are EXPECTED here and are the fix's own signal.

## 6. Driver evidence roll-up (/Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/docs/staging/batch-b-2026-08/evidence/pr-2437)
{
  "artifacts_found": 209,
  "artifacts_parsed": 209,
  "artifacts_UNPARSEABLE": 0,
  "unparseable_files": [],
  "first_cycle": "2026-08-29T14:26:49.392Z",
  "last_cycle": "2026-08-30T11:06:10.746Z",
  "requests_total": 1881,
  "requests_failed_transport": 0,
  "status_429": 0,
  "cycles_with_deviations": 0
}

  supervisor log:
    rc=0 cycles: 0
    2026-08-29T14:52:45Z !!! cycle 3 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T14:56:21Z !!! cycle 4 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T14:59:57Z !!! cycle 5 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T15:03:35Z !!! cycle 6 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T15:07:11Z !!! cycle 7 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T15:10:47Z !!! cycle 8 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T15:14:23Z !!! cycle 9 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T15:18:00Z !!! cycle 10 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T15:21:36Z !!! cycle 11 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T15:25:13Z !!! cycle 12 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T15:28:49Z !!! cycle 13 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T15:32:26Z !!! cycle 14 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T15:36:04Z !!! cycle 15 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T15:39:40Z !!! cycle 16 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T15:43:19Z !!! cycle 17 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T15:46:56Z !!! cycle 18 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T15:50:33Z !!! cycle 19 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T15:54:09Z !!! cycle 20 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T15:57:44Z !!! cycle 21 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:01:20Z !!! cycle 22 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:04:56Z !!! cycle 23 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:08:31Z !!! cycle 24 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:12:06Z !!! cycle 25 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:15:42Z !!! cycle 26 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:19:18Z !!! cycle 27 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:22:52Z !!! cycle 28 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:26:50Z !!! cycle 29 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:30:45Z !!! cycle 30 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:34:22Z !!! cycle 31 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:37:57Z !!! cycle 32 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:41:33Z !!! cycle 33 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:45:09Z !!! cycle 34 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:48:45Z !!! cycle 35 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:52:20Z !!! cycle 36 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:55:54Z !!! cycle 37 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T16:59:30Z !!! cycle 38 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T17:03:07Z !!! cycle 39 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T17:06:44Z !!! cycle 40 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T17:10:19Z !!! cycle 41 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T17:13:55Z !!! cycle 42 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T17:17:31Z !!! cycle 43 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T17:21:07Z !!! cycle 44 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T17:24:44Z !!! cycle 45 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T17:28:19Z !!! cycle 46 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T17:31:56Z !!! cycle 47 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T17:35:33Z !!! cycle 48 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T17:39:11Z !!! cycle 49 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T17:42:49Z !!! cycle 50 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T17:46:26Z !!! cycle 51 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T17:50:03Z !!! cycle 52 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T17:53:42Z !!! cycle 53 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T17:57:19Z !!! cycle 54 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:00:59Z !!! cycle 55 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:04:37Z !!! cycle 56 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:08:14Z !!! cycle 57 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:11:52Z !!! cycle 58 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:15:31Z !!! cycle 59 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:19:09Z !!! cycle 60 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:22:46Z !!! cycle 61 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:26:24Z !!! cycle 62 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:30:01Z !!! cycle 63 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:33:40Z !!! cycle 64 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:37:18Z !!! cycle 65 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:40:55Z !!! cycle 66 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:44:33Z !!! cycle 67 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:48:10Z !!! cycle 68 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:51:48Z !!! cycle 69 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:55:24Z !!! cycle 70 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T18:59:02Z !!! cycle 71 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T19:02:39Z !!! cycle 72 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T19:06:17Z !!! cycle 73 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T19:09:54Z !!! cycle 74 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T19:13:31Z !!! cycle 75 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T19:17:08Z !!! cycle 76 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T19:20:44Z !!! cycle 77 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T19:24:19Z !!! cycle 78 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T19:27:55Z !!! cycle 79 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T19:31:30Z !!! cycle 80 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T19:35:08Z !!! cycle 81 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T19:38:44Z !!! cycle 82 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T19:42:21Z !!! cycle 83 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T19:45:56Z !!! cycle 84 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T19:49:32Z !!! cycle 85 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T19:53:08Z !!! cycle 86 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T19:56:44Z !!! cycle 87 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:00:21Z !!! cycle 88 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:03:57Z !!! cycle 89 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:07:33Z !!! cycle 90 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:11:09Z !!! cycle 91 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:14:45Z !!! cycle 92 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:18:23Z !!! cycle 93 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:22:00Z !!! cycle 94 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:25:35Z !!! cycle 95 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:29:12Z !!! cycle 96 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:32:48Z !!! cycle 97 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:36:24Z !!! cycle 98 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:40:00Z !!! cycle 99 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:43:37Z !!! cycle 100 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:47:15Z !!! cycle 101 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:50:51Z !!! cycle 102 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:54:28Z !!! cycle 103 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T20:58:08Z !!! cycle 104 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T21:01:45Z !!! cycle 105 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T21:05:23Z !!! cycle 106 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T21:08:59Z !!! cycle 107 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T21:12:38Z !!! cycle 108 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T21:16:16Z !!! cycle 109 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T21:20:01Z !!! cycle 110 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T21:23:39Z !!! cycle 111 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T21:27:16Z !!! cycle 112 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T21:30:52Z !!! cycle 113 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T21:34:29Z !!! cycle 114 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T21:38:06Z !!! cycle 115 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T21:41:45Z !!! cycle 116 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T21:45:21Z !!! cycle 117 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T21:48:58Z !!! cycle 118 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T21:52:35Z !!! cycle 119 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T21:56:12Z !!! cycle 120 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T21:59:51Z !!! cycle 121 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:03:28Z !!! cycle 122 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:07:06Z !!! cycle 123 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:10:43Z !!! cycle 124 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:14:20Z !!! cycle 125 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:17:58Z !!! cycle 126 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:21:35Z !!! cycle 127 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:25:12Z !!! cycle 128 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:28:48Z !!! cycle 129 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:32:25Z !!! cycle 130 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:36:02Z !!! cycle 131 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:39:41Z !!! cycle 132 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:43:18Z !!! cycle 133 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:46:56Z !!! cycle 134 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:50:31Z !!! cycle 135 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:54:07Z !!! cycle 136 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:57:42Z !!! cycle 137 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-29T22:59:28Z !!! cycle 138 exited rc=1 with UNTOLERATED deviations — see the cycle artifact
    2026-08-30T11:06:10Z supervisor done cycles=201 failed=0 tolerated=0
## 7. At-close staging-honesty preflight
  preflight_at_close: environment_type=clean_mirror ts=2026-08-30T11:06:44.516Z ref=fizyjojbebyalirtjjht checks=8/8


---
Artifacts: /Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/docs/staging/batch-b-2026-08/evidence/pr-2437/close-20260830T110610Z
Next: the rollback rehearsal (it moves the pr-2437 tag, so it must come AFTER this capture and only once THIS window has closed). Use --update-tags, never --set-tags.

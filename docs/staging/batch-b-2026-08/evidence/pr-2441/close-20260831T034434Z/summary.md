# PR #2441 Batch B T2 close capture — 2026-08-31T03:44:34Z

Window 2026-08-30T15:42:49Z -> 2026-08-31T03:42:49Z; tag pr-2441; head 3da7677d73dc0c3ee7baed58ace5633c8e02ea81

## 1. Health at close (5x /health, exact-head predicate)
  run 1: HTTP 200 0.211461s git_sha=3da7677d73dc0c3ee7baed58ace5633c8e02ea81
  run 2: HTTP 200 0.197915s git_sha=3da7677d73dc0c3ee7baed58ace5633c8e02ea81
  run 3: HTTP 200 0.223810s git_sha=3da7677d73dc0c3ee7baed58ace5633c8e02ea81
  run 4: HTTP 200 0.200017s git_sha=3da7677d73dc0c3ee7baed58ace5633c8e02ea81
  run 5: HTTP 200 0.197738s git_sha=3da7677d73dc0c3ee7baed58ace5633c8e02ea81
  -> health fails: 0 (want 0)

## 2. Tag routing / revision identity
  tag pr-2441 -> revision arkova-worker-staging-00376-yuh (expected arkova-worker-staging-00376-yuh)
  -> REVISION UNCHANGED. PASS
  revision createTime + digest: 2026-08-30T15:27:56.113257Z	us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@sha256:2db3d675caefabaaf604f9e1f7c331f7516789a8e7cd56c321334c1c3cef5736
  -> digest matches. PASS
  NOTE: the soak clock is this revision's creationTimestamp / uptime, not the driver loop.

## 3. Serving revisions in-window (2h chunks, 20k cap made visible)
  2026-08-30T15:42:49Z -> 2026-08-30T17:42:49Z : 4489 requests
  2026-08-30T17:42:49Z -> 2026-08-30T19:42:49Z : 4586 requests
  2026-08-30T19:42:49Z -> 2026-08-30T21:42:49Z : 4482 requests
  2026-08-30T21:42:49Z -> 2026-08-30T23:42:49Z : 4346 requests
  2026-08-30T23:42:49Z -> 2026-08-31T01:42:49Z : 4480 requests
  2026-08-31T01:42:49Z -> 2026-08-31T03:42:49Z : 4485 requests
  total sampled requests (whole service, all tags): 26868
  distinct serving revisions:
    26793 arkova-worker-staging-00376-yuh
      27 arkova-worker-staging-00354-wod
      22 arkova-worker-staging-00358-yon
      13 arkova-worker-staging-batcha-2274
       4 arkova-worker-staging-batcha-2446
       2 arkova-worker-staging-00364-qis
       2 arkova-worker-staging-00357-yej
       2 arkova-worker-staging-00355-nup
       2 arkova-worker-staging-00300-few
       1 arkova-worker-staging-00356-qip
  -> arkova-worker-staging-00376-yuh served in-window. PASS

## 4. Container terminations / OOM / errors in-window
  entries: 0 ; memory/OOM/termination-shaped: 0
  -> none. PASS

## 5. 5xx on arkova-worker-staging-00376-yuh in-window
  2026-08-30T15:42:49Z -> 2026-08-30T17:42:49Z : 0 x 5xx
  2026-08-30T17:42:49Z -> 2026-08-30T19:42:49Z : 0 x 5xx
  2026-08-30T19:42:49Z -> 2026-08-30T21:42:49Z : 0 x 5xx
  2026-08-30T21:42:49Z -> 2026-08-30T23:42:49Z : 0 x 5xx
  2026-08-30T23:42:49Z -> 2026-08-31T01:42:49Z : 0 x 5xx
  2026-08-31T01:42:49Z -> 2026-08-31T03:42:49Z : 0 x 5xx
  TOTAL 5xx in-window: 0
  NOTE for PR #2435: intentional 500s from the ATS poison probe are EXPECTED here and are the fix's own signal.

## 6. Driver evidence roll-up (/Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/docs/staging/batch-b-2026-08/evidence/pr-2441)
{
  "artifacts_found": 223,
  "artifacts_parsed": 223,
  "artifacts_UNPARSEABLE": 0,
  "unparseable_files": [],
  "first_cycle": "2026-08-30T15:45:24.420Z",
  "last_cycle": "2026-08-31T03:44:34.810Z",
  "requests_total": 26756,
  "requests_failed_transport": 7,
  "status_429": 0,
  "cycles_with_deviations": 3
}
!!! 3 cycle(s) carry deviations — see driver-rollup.json

  supervisor log:
    rc=0 cycles: 0
    2026-08-30T22:19:49Z !!! cycle 123 exited rc=3 with UNTOLERATED deviations — see the cycle artifact
    2026-08-30T22:27:16Z cycle 125 exited rc=4 — TOLERATED signal (#1 of 12)
    2026-08-31T03:44:34Z !!! cycle 223 exited rc=3 with UNTOLERATED deviations — see the cycle artifact
    2026-08-31T03:44:34Z supervisor done cycles=223 failed=2 tolerated=1
## 7. At-close staging-honesty preflight
  preflight_at_close: environment_type=clean_mirror ts=2026-08-31T03:45:18.072Z ref=fizyjojbebyalirtjjht checks=8/8


---
Artifacts: /Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/docs/staging/batch-b-2026-08/evidence/pr-2441/close-20260831T034434Z
Next: the rollback rehearsal (it moves the pr-2441 tag, so it must come AFTER this capture and only once THIS window has closed). Use --update-tags, never --set-tags.

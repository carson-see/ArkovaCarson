# PR #2437 Batch B T2 close capture — 2026-08-29T01:43:34Z

Window 2026-08-28T13:43:34Z -> 2026-08-29T01:43:34Z; tag pr-2437; head 6b7229f4b2d7faeb32bad0a0e3209430bd4c8243

## 1. Health at close (5x /health, exact-head predicate)
  run 1: HTTP 200 1.591816s git_sha=6b7229f4b2d7faeb32bad0a0e3209430bd4c8243
  run 2: HTTP 200 0.732847s git_sha=6b7229f4b2d7faeb32bad0a0e3209430bd4c8243
  run 3: HTTP 200 0.699840s git_sha=6b7229f4b2d7faeb32bad0a0e3209430bd4c8243
  run 4: HTTP 200 0.629573s git_sha=6b7229f4b2d7faeb32bad0a0e3209430bd4c8243
  run 5: HTTP 200 0.537654s git_sha=6b7229f4b2d7faeb32bad0a0e3209430bd4c8243
  -> health fails: 0 (want 0)

## 2. Tag routing / revision identity
  tag pr-2437 -> revision arkova-worker-staging-00358-yon (expected arkova-worker-staging-00358-yon)
  -> REVISION UNCHANGED. PASS
  revision createTime + digest: 2026-08-28T13:43:34.657016Z	us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@sha256:0d49c0e48b90b488007fb5a4eeb844ad126398f1f968a58a8ef6f789fa9ec1cc
  -> digest matches. PASS
  NOTE: the soak clock is this revision's creationTimestamp / uptime, not the driver loop.

## 3. Serving revisions in-window (2h chunks, 20k cap made visible)
  2026-08-28T13:43:34Z -> 2026-08-28T15:43:34Z : 2345 requests
  2026-08-28T15:43:34Z -> 2026-08-28T17:43:34Z : 1693 requests
  2026-08-28T17:43:34Z -> 2026-08-28T19:43:34Z : 1490 requests
  2026-08-28T19:43:34Z -> 2026-08-28T21:43:34Z : 1493 requests
  2026-08-28T21:43:34Z -> 2026-08-28T23:43:34Z : 1474 requests
  2026-08-28T23:43:34Z -> 2026-08-29T01:43:34Z : 1453 requests
  total sampled requests (whole service, all tags): 9948
  distinct serving revisions:
    7546 arkova-worker-staging-00355-nup
    1161 arkova-worker-staging-00358-yon
    1048 arkova-worker-staging-00357-yej
     192 arkova-worker-staging-00354-wod
       1 arkova-worker-staging-00349-sef
  -> arkova-worker-staging-00358-yon served in-window. PASS

## 4. Container terminations / OOM / errors in-window
  entries: 2 ; memory/OOM/termination-shaped: 0
  -> none. PASS

## 5. 5xx on arkova-worker-staging-00358-yon in-window
  2026-08-28T13:43:34Z -> 2026-08-28T15:43:34Z : 0 x 5xx
  2026-08-28T15:43:34Z -> 2026-08-28T17:43:34Z : 0 x 5xx
  2026-08-28T17:43:34Z -> 2026-08-28T19:43:34Z : 0 x 5xx
  2026-08-28T19:43:34Z -> 2026-08-28T21:43:34Z : 0 x 5xx
  2026-08-28T21:43:34Z -> 2026-08-28T23:43:34Z : 0 x 5xx
  2026-08-28T23:43:34Z -> 2026-08-29T01:43:34Z : 0 x 5xx
  TOTAL 5xx in-window: 0
  NOTE for PR #2435: intentional 500s from the ATS poison probe are EXPECTED here and are the fix's own signal.

## 6. Driver evidence roll-up (/Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/docs/staging/batch-b-2026-08/evidence/pr-2437)
{
  "artifacts_found": 130,
  "artifacts_parsed": 130,
  "artifacts_UNPARSEABLE": 0,
  "unparseable_files": [],
  "first_cycle": "2026-08-28T13:49:42.494Z",
  "last_cycle": "2026-08-29T01:41:16.759Z",
  "requests_total": 1170,
  "requests_failed_transport": 0,
  "status_429": 0,
  "cycles_with_deviations": 0
}

  supervisor log:
    rc=0 cycles: 0
    2026-08-29T01:43:34Z supervisor done cycles=128 failed=0 tolerated=0

---
Artifacts: /Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/docs/staging/batch-b-2026-08/evidence/pr-2437/close-20260829T014334Z
Next: re-run scripts/ci/staging-honesty-preflight.ts against fizyjojbebyalirtjjht and store preflight-at-close.json here, then the rollback rehearsal (it creates a revision, so it must come AFTER this capture).

# PR #2434 Batch B T2 close capture — 2026-08-29T01:22:04Z

Window 2026-08-28T13:22:04Z -> 2026-08-29T01:22:04Z; tag pr-2434; head 1095e647e0d8df02ea38c3b41018b504680ad615

## 1. Health at close (5x /health, exact-head predicate)
  run 1: HTTP 200 0.614703s git_sha=1095e647e0d8df02ea38c3b41018b504680ad615
  run 2: HTTP 200 0.501104s git_sha=1095e647e0d8df02ea38c3b41018b504680ad615
  run 3: HTTP 200 0.302386s git_sha=1095e647e0d8df02ea38c3b41018b504680ad615
  run 4: HTTP 200 0.286747s git_sha=1095e647e0d8df02ea38c3b41018b504680ad615
  run 5: HTTP 200 0.323851s git_sha=1095e647e0d8df02ea38c3b41018b504680ad615
  -> health fails: 0 (want 0)

## 2. Tag routing / revision identity
  tag pr-2434 -> revision arkova-worker-staging-00354-wod (expected arkova-worker-staging-00354-wod)
  -> REVISION UNCHANGED. PASS
  revision createTime + digest: 2026-08-28T13:22:04.204185Z	us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@sha256:28fd519748a590911f4b0402cc4d957846373cf3f4a1c06dadee084cf994b8db
  -> digest matches. PASS
  NOTE: the soak clock is this revision's creationTimestamp / uptime, not the driver loop.

## 3. Serving revisions in-window (2h chunks, 20k cap made visible)
  2026-08-28T13:22:04Z -> 2026-08-28T15:22:04Z : 2239 requests
  2026-08-28T15:22:04Z -> 2026-08-28T17:22:04Z : 1848 requests
  2026-08-28T17:22:04Z -> 2026-08-28T19:22:04Z : 1489 requests
  2026-08-28T19:22:04Z -> 2026-08-28T21:22:04Z : 1492 requests
  2026-08-28T21:22:04Z -> 2026-08-28T23:22:04Z : 1475 requests
  2026-08-28T23:22:04Z -> 2026-08-29T01:22:04Z : 1462 requests
  total sampled requests (whole service, all tags): 10005
  distinct serving revisions:
    7506 arkova-worker-staging-00355-nup
    1128 arkova-worker-staging-00358-yon
    1092 arkova-worker-staging-00357-yej
     256 arkova-worker-staging-00354-wod
      11 arkova-worker-staging-00356-qip
      11 arkova-worker-staging-00300-few
       1 arkova-worker-staging-00349-sef
  -> arkova-worker-staging-00354-wod served in-window. PASS

## 4. Container terminations / OOM / errors in-window
  entries: 2 ; memory/OOM/termination-shaped: 0
  -> none. PASS

## 5. 5xx on arkova-worker-staging-00354-wod in-window
  2026-08-28T13:22:04Z -> 2026-08-28T15:22:04Z : 0 x 5xx
  2026-08-28T15:22:04Z -> 2026-08-28T17:22:04Z : 0 x 5xx
  2026-08-28T17:22:04Z -> 2026-08-28T19:22:04Z : 0 x 5xx
  2026-08-28T19:22:04Z -> 2026-08-28T21:22:04Z : 0 x 5xx
  2026-08-28T21:22:04Z -> 2026-08-28T23:22:04Z : 0 x 5xx
  2026-08-28T23:22:04Z -> 2026-08-29T01:22:04Z : 0 x 5xx
  TOTAL 5xx in-window: 0
  NOTE for PR #2435: intentional 500s from the ATS poison probe are EXPECTED here and are the fix's own signal.

## 6. Driver evidence roll-up (/Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/docs/staging/batch-b-2026-08/evidence/pr-2434)
{
  "artifacts_found": 189,
  "artifacts_parsed": 189,
  "artifacts_UNPARSEABLE": 0,
  "unparseable_files": [],
  "first_cycle": "2026-08-28T13:39:14.583Z",
  "last_cycle": "2026-08-29T01:19:31.632Z",
  "requests_total": 945,
  "requests_failed_transport": 0,
  "status_429": 0,
  "cycles_with_deviations": 0
}

  supervisor log:
    rc=0 cycles: 0
    2026-08-29T01:22:04Z supervisor done cycles=188 failed=0 tolerated=0

---
Artifacts: /Volumes/Extreme/Arkova/_legacy/home-Arkova-2026-05-15/arkova-mvpcopy-main/docs/staging/batch-b-2026-08/evidence/pr-2434/close-20260829T012204Z
Next: re-run scripts/ci/staging-honesty-preflight.ts against fizyjojbebyalirtjjht and store preflight-at-close.json here, then the rollback rehearsal (it creates a revision, so it must come AFTER this capture).

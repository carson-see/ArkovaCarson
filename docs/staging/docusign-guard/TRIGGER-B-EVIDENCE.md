# Trigger B (age-based) — fired 2026-09-03T11:01:4xZ

## What fired
Worker log, rig `arkova-worker-docusign-guard-staging` rev 00003-hwq:
  11:01:46.737570  Claimed anchors for batch processing
  11:01:46.737601  Mock: Preparing fingerprint tx (no broadcast)
  11:01:48.474635  Mock: signed tx broadcast
  11:01:51.057414  Batch anchor processing complete

DB state moved 4,064 PENDING -> 2,072 PENDING, with 1,000 BROADCASTING.

## Why this is Trigger B specifically (by elimination — B is NOT logged)
Only Trigger A logs an explicit "Batch size trigger fired". Trigger B firing falls
through the `else if (!triggerB_shouldFireOnAge(...))` guard and emits nothing, and
the not-met path is logger.debug (not emitted at prod level). So B is established by
closing the alternatives:
  - Trigger D (forced flush) — EXCLUDED: the hold-flush sentinel was in place, and
    every cycle recorded flush = {"skipped":"held-for-trigger-exercise"}.
  - Trigger A (size) — EXCLUDED: requires pendingCount >= BATCH_SIZE (10,000);
    actual pendingCount was 4,064.
  - Trigger B (age) — conditions MET: pendingCount 4,064 >= MIN_BATCH_THRESHOLD
    (3,000) AND oldest pending age 3h03m >= MAX_ANCHOR_AGE_MS (3h).
A non-forced batch that processed work under exactly those conditions can only be B.

This is deduction from a closed set, not a log assertion. Recorded as such.

## Note: it fired via in-process node-cron, not the driver's HTTP call
The driver's own non-forced POST recorded triggerA.processed=0 on cycles 34/35/36,
because the worker's in-process node-cron reached the job first (min-instances=1
keeps an instance alive, so node-cron runs). The trigger firing is genuine either
way; the driver's field is simply not where it shows up.

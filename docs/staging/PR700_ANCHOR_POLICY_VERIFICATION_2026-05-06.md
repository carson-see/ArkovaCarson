# PR #700 Anchor Batch Policy Verification - 2026-05-06

## Status

Not merge-ready until CI, review, and staging/worker soak complete.

This note captures the 2026-05-06 anchor-policy fix added while preparing PR
#700. It is separate from the prod 0295 migration reconciliation evidence.

## Policy Pinned

- Ordinary `PENDING` anchors must not be claimed and broadcast one-by-one.
- `processPendingAnchors()` is a compatibility no-op.
- The in-process one-minute `process-pending-anchors` schedule is removed.
- Batch anchoring owns ordinary `PENDING` anchors.
- Batch trigger rules:
  - 10,000 pending anchors: fire immediately.
  - 3,000 pending anchors: threshold crossed; fire only when oldest pending age reaches 3 hours.
  - Daily forced flush: `force=true` path, documented as the 3am EST sweep.

## Code Changes

- `services/worker/src/jobs/anchor.ts`
  - `processPendingAnchors()` no longer calls `claim_pending_anchors`.
  - It does not move anchors to `BROADCASTING`.
  - It does not submit single-fingerprint chain transactions.
- `services/worker/src/routes/scheduled.ts`
  - Removed in-process `process-pending-anchors` schedule.
- `services/worker/src/jobs/batch-anchor.ts`
  - Replaced exact/fast pending counts in the smart-skip gate with indexed threshold probes:
    - probe offset 2,999 to detect the 3,000 threshold,
    - probe offset 9,999 to detect the 10,000 immediate-fire threshold.
  - This avoids `get_anchor_status_counts_fast()` returning `PENDING: -1` under prod scale and causing the normal batch cron to defer forever.

## Local Verification

Run from `services/worker` on 2026-05-06:

```bash
npm test -- src/jobs/anchor.test.ts src/jobs/anchor-lifecycle.test.ts src/jobs/batch-anchor.test.ts src/jobs/batch-anchor.audit.test.ts src/routes/scheduled.test.ts src/routes/cron.test.ts src/index.test.ts
```

Result:

```text
Test Files  7 passed (7)
Tests       274 passed (274)
```

Additional checks:

```bash
npm run typecheck
npm run lint
```

Results:

- `npm run typecheck`: passed.
- `npm run lint`: passed with existing repo warnings only (`0 errors, 322 warnings`).

## Prod Read-Only Evidence

Prod project: `vzwyaatejekddvltxyye`.

Captured via Supabase Management API read-only SQL on 2026-05-06.

### Pending Count

Captured at approximately `2026-05-06T12:20Z`:

```json
[
  {
    "pending_count": 208067
  }
]
```

### Oldest/Newest Pending Sample

Captured at `2026-05-06T12:20:15.527681+00:00`:

```json
{
  "captured_at": "2026-05-06T12:20:15.527681+00:00",
  "newest_pending": {
    "age_hours": 21.35,
    "created_at": "2026-05-05T14:59:32.546668+00:00",
    "has_pipeline_source": true
  },
  "oldest_pending": {
    "age_hours": 344.50,
    "created_at": "2026-04-22T03:49:59.593477+00:00",
    "has_pipeline_source": true
  },
  "status_counts_fast": {
    "total": 2990851,
    "PENDING": -1,
    "REVOKED": -1,
    "SECURED": 2990851,
    "SUBMITTED": -1,
    "BROADCASTING": -1
  }
}
```

Interpretation:

- The old batch smart-skip path could see an oldest pending row but receive
  `PENDING: -1` from `get_anchor_status_counts_fast()`.
- Because `-1 < 3000`, the non-forced batch cron deferred instead of firing.
- That is why prod could hold a stale pending backlog even though the oldest
  row was far beyond the 3-hour policy clock.

### Threshold Probe Evidence

Captured at `2026-05-06T12:25:34.783052+00:00`:

```json
{
  "captured_at": "2026-05-06T12:25:34.783052+00:00",
  "oldest_pending": {
    "age_hours": 344.59,
    "created_at": "2026-04-22T03:49:59.593477+00:00",
    "has_pipeline_source": true
  },
  "threshold_3k_row": {
    "age_hours": 343.09,
    "created_at": "2026-04-22T05:19:57.041776+00:00",
    "has_pipeline_source": true
  },
  "threshold_10k_row": {
    "age_hours": 342.09,
    "created_at": "2026-04-22T06:20:23.643704+00:00",
    "has_pipeline_source": true
  },
  "pending_threshold_3k_crossed": true,
  "pending_threshold_10k_crossed": true
}
```

Interpretation:

- Prod currently crosses both the 3,000 and 10,000 pending thresholds.
- With the PR #700 worker code, the batch-size trigger fires immediately
  without relying on exact counts.
- The sampled oldest/threshold rows are pipeline-sourced, so pipeline backlog
  validation must be included in staging/worker soak evidence.

## Remaining Required Evidence

- CI rerun on the pushed branch.
- Code review approval / CodeRabbit blocker resolved.
- Worker build and real staging soak evidence.
- Post-merge prod worker deploy and post-deploy verification before closing
  Jira/Confluence.

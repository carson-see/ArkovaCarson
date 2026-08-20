#!/usr/bin/env -S npx tsx
/**
 * Wave 2 T2 soak driver — #2254 (fix/pipeline-monitor-backlog-floor).
 *
 * Two floors ship in this PR:
 *   1. pipelineThroughputMonitor.ts DEFAULT_LINKER_STALL_MIN_BACKLOG (500) —
 *      a stuck-record age condition below this backlog count degrades to
 *      `warning`/`below_backlog_floor:true` instead of paging fatal.
 *   2. db-health-monitor.ts DEAD_RATIO_MIN_DEAD_TUPLES (500) — a dead-tuple
 *      RATIO alert only escalates when the absolute dead-tuple count also
 *      clears 500, so job_queue-shaped low-row-count churn cannot page on
 *      ratio noise alone.
 *
 * Floor #2 was proven LIVE against the deployed wave2-2026-08 rig after a
 * real `ANALYZE` cycle (see soak-start doc): job_queue read ratio=6.0
 * (n_dead_tup=6, n_live_tup=1) and anchors read ratio=1.0 — both would have
 * paged fatal under the pre-fix unfloored check, and both correctly produced
 * alertCount:0 from POST /jobs/db-health on the running service.
 *
 * Floor #1 could not be proven live the same way: the fresh wave2 seed has
 * zero unlinked public_records, so there is no age-stalled backlog to trip
 * condition B on the live rig (confirmed: linkerStallMinBacklog:500 is wired
 * through correctly, but belowBacklogFloor stays false because nothing is
 * stalled at all). This driver proves the escalation BOUNDARY itself — the
 * exact 2026-08 alert-storm shape (a single 388h-old record) — directly
 * against the merged decision function.
 */
import {
  decidePipelineThroughputAlert,
  DEFAULT_LINKER_STALL_MIN_BACKLOG,
  DEFAULT_LINKER_STALL_THRESHOLD_HOURS,
  type ThroughputAlertInput,
} from '../src/jobs/pipelineThroughputMonitor.js';

let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`);
  if (!cond) failures += 1;
}

const baseInput: ThroughputAlertInput = {
  latest_unlinked_age_hours: 388,
  oldest_unlinked_age_hours: 388, // the exact motivating 2026-08 incident figure
  last_secured_age_hours: 1,
  unlinked_total: 1, // sub-floor: a single stuck record
  window_hours: 24,
  linker_stall_threshold_hours: DEFAULT_LINKER_STALL_THRESHOLD_HOURS,
};

const subFloorDecision = decidePipelineThroughputAlert(baseInput);
check(
  '388h-old record, backlog=1 (sub-floor) -> fires but as WARNING, not fatal',
  subFloorDecision.should_fire === true && subFloorDecision.severity === 'warning',
);
check(
  '388h-old record, backlog=1 (sub-floor) -> below_backlog_floor:true',
  subFloorDecision.below_backlog_floor === true,
);

const aboveFloorInput: ThroughputAlertInput = {
  ...baseInput,
  unlinked_total: DEFAULT_LINKER_STALL_MIN_BACKLOG + 1, // 501, clears the floor
};
const aboveFloorDecision = decidePipelineThroughputAlert(aboveFloorInput);
check(
  `388h-old record, backlog=${DEFAULT_LINKER_STALL_MIN_BACKLOG + 1} (clears floor) -> escalates past warning`,
  aboveFloorDecision.should_fire === true && aboveFloorDecision.severity !== 'warning',
);
check(
  `388h-old record, backlog=${DEFAULT_LINKER_STALL_MIN_BACKLOG + 1} (clears floor) -> below_backlog_floor:false`,
  aboveFloorDecision.below_backlog_floor === false,
);

const unknownBacklogInput: ThroughputAlertInput = {
  ...baseInput,
  unlinked_total: null, // cache unavailable
};
const unknownDecision = decidePipelineThroughputAlert(unknownBacklogInput);
check(
  'UNKNOWN backlog (null, cache unavailable) does NOT take the sub-floor branch (fail-quiet guard)',
  unknownDecision.below_backlog_floor === false,
);

const belowThresholdInput: ThroughputAlertInput = {
  ...baseInput,
  oldest_unlinked_age_hours: DEFAULT_LINKER_STALL_THRESHOLD_HOURS - 1, // 47h, under the 48h threshold
};
const belowThresholdDecision = decidePipelineThroughputAlert(belowThresholdInput);
check(
  `record younger than the ${DEFAULT_LINKER_STALL_THRESHOLD_HOURS}h stall threshold does not fire condition B at all`,
  belowThresholdDecision.should_fire === false,
);

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);

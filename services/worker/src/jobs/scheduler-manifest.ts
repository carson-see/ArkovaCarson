/**
 * Config-as-code scheduler manifest (SCRUM-2900).
 *
 * The prod scheduler binding lives in Cloud Scheduler (node-cron is dormant
 * under Cloud Run CPU throttling — see routes/scheduled.ts), so the ONLY
 * durable record of "which jobs should be running, on what cadence, and which
 * are deliberately paused" was, until now, out-of-repo console state. The
 * 2026-06-01 daily-flush 401 blackout drained nothing for ~6 weeks with no
 * alert precisely because a pause was untracked.
 *
 * This manifest is the repo source of truth for the CRITICAL scheduled jobs.
 * Every PAUSED job MUST carry actor attribution (pausedBy / pausedReason /
 * pausedAt) so the dead-man (scheduler-deadman.ts) can name who or what
 * stopped it — the non-negotiable slice. NOTE on the feeders: they are recorded
 * ENABLED here because they are VERIFIED active in prod (§1.5); the D12
 * PI-0.5 feeder-freeze is an undecided ruling (due 2026-07-25), so this manifest
 * does not pre-emptively encode a pause that prod has not applied. When D12 is
 * ruled paused, flip those entries to enabled:false + attribution.
 *
 * NOTE: this is the critical-set source of truth, not an exhaustive mirror of
 * every /jobs/* endpoint. Adding a job here opts it into dead-man monitoring.
 *
 * DRIFT WARNING (Architect review): this manifest is hand-maintained; the
 * repo-side half of reconciliation is now automated (PR #2067:
 * scripts/gcp-setup/cloud-scheduler.test.ts asserts every manifest entry
 * matches the JOBS declaration in cloud-scheduler.sh on schedule, path, and
 * pause state), but there is still NO automated reconciliation against the
 * LIVE Cloud Scheduler API. A new
 * critical scheduler job that is never added here is simply never monitored, and
 * a schedule/enabled value that diverges from Cloud Scheduler is never caught —
 * the same untracked-state failure mode this module exists to prevent, moved up
 * a layer. MITIGATION until a reconciler lands: this manifest MUST be updated in
 * the SAME PR as any Cloud Scheduler change. FOLLOW-UP (post-train, needs a CI
 * wiring change — ci.yml is frozen this window): a periodic/CI reconciler that
 * lists Cloud Scheduler jobs via the API and diffs id/schedule/enabled here,
 * flagging jobs-in-scheduler-not-in-manifest and schedule mismatches.
 *
 * Constitution §1.5: the manifest records what IS (enabled/paused + attribution),
 * never an asserted-but-unverified prod state.
 */

export type SchedulerJobCategory =
  | 'anchor-pipeline'
  | 'feeder'
  | 'maintenance'
  | 'billing';

export interface ScheduledJobSpec {
  /** Stable job id — matches the Cloud Scheduler job name + the /jobs/* leaf. */
  id: string;
  category: SchedulerJobCategory;
  /** Cron expression (UTC) the Cloud Scheduler job is configured with. */
  schedule: string;
  /** Worker HTTP target hit by the scheduler (always under /jobs/). */
  targetPath: string;
  method: 'GET' | 'POST';
  /** Owning lane / role (for escalation routing). */
  owner: string;
  /** Whether the job is intended to be actively scheduled in prod. */
  enabled: boolean;
  /**
   * Max wall-clock a monitored job may go without a successful run before the
   * dead-man considers it overdue. Omitted → derived-conservative default in
   * the evaluator. Only meaningful for enabled jobs.
   */
  maxSilenceMs?: number;
  /** Actor who paused the job (REQUIRED when !enabled). */
  pausedBy?: string;
  /** Human reason for the pause (REQUIRED when !enabled). */
  pausedReason?: string;
  /** ISO date the pause took effect (REQUIRED when !enabled). */
  pausedAt?: string;
}

const HOURS = 60 * 60 * 1000;

/**
 * Critical-set manifest. Enabled entries are the anchoring pipeline + money /
 * integrity maintenance jobs whose silent pause has caused (or would cause) an
 * outage. Feeder entries are codified PAUSED per the PI-0.5 freeze (D12).
 */
export const SCHEDULER_MANIFEST: ScheduledJobSpec[] = [
  // ── Anchoring pipeline (enabled, critical) ────────────────────────────────
  {
    id: 'batch-anchors',
    category: 'anchor-pipeline',
    // Live-verified */30 via `gcloud scheduler jobs list` 2026-08-10 (PR #2067
    // reconciliation); the earlier */10 here predated that read-back.
    schedule: '*/30 * * * *',
    targetPath: '/jobs/batch-anchors',
    method: 'POST',
    owner: 'lane-1',
    enabled: true,
    maxSilenceMs: 1 * HOURS,
  },
  {
    id: 'check-confirmations',
    category: 'anchor-pipeline',
    // Live-verified */30 via gcloud 2026-08-10 (PR #2067 reconciliation).
    schedule: '*/30 * * * *',
    targetPath: '/jobs/check-confirmations',
    method: 'POST',
    owner: 'lane-1',
    enabled: true,
    maxSilenceMs: 1 * HOURS,
  },
  {
    id: 'recover-broadcasts',
    category: 'anchor-pipeline',
    // Live-verified */15 via gcloud 2026-08-10 (PR #2067 reconciliation).
    schedule: '*/15 * * * *',
    targetPath: '/jobs/recover-broadcasts',
    method: 'POST',
    owner: 'lane-1',
    enabled: true,
    maxSilenceMs: 1 * HOURS,
  },
  {
    id: 'check-stuck-anchors',
    category: 'anchor-pipeline',
    schedule: '0 * * * *',
    targetPath: '/jobs/check-stuck-anchors',
    method: 'POST',
    owner: 'lane-1',
    enabled: true,
    maxSilenceMs: 3 * HOURS,
  },
  // ── Money / integrity maintenance (enabled, critical) ─────────────────────
  {
    id: 'anchor-expiry-sweep',
    category: 'maintenance',
    schedule: '0 3 * * *',
    targetPath: '/jobs/anchor-expiry-sweep',
    method: 'POST',
    owner: 'lane-1',
    enabled: true,
    maxSilenceMs: 30 * HOURS,
  },
  {
    id: 'reconcile-credit-conservation',
    category: 'billing',
    schedule: '0 9 * * *',
    targetPath: '/jobs/reconcile-credit-conservation',
    method: 'POST',
    owner: 'lane-2',
    enabled: true,
    maxSilenceMs: 30 * HOURS,
  },
  // GH #1835/#1836 (PR #1944 review round 3): Drive changes.watch channel
  // renewal — also the rotation mechanism for the legacy org-id
  // channel_token security fix. `enabled: true` records INTENT (this SHOULD
  // be scheduled hourly), which is what the dead-man's silence-based
  // alarming needs to catch a forgotten/failed Cloud Scheduler creation —
  // the job is declared in scripts/gcp-setup/cloud-scheduler.sh and was
  // verified LIVE in prod (hourly, ENABLED) via gcloud on 2026-08-10 — the
  // earlier "NOT YET applied" state here is resolved. maxSilenceMs matches
  // check-stuck-anchors (identical hourly cadence).
  //
  // HONESTY NOTE (verified against this exact head — do not assume this
  // note stays accurate without re-checking): registering here makes this
  // job COVERED BY CONSTRUCTION whenever scheduler-deadman.ts /
  // scheduler-pause-attribution.ts's audit actually runs, but that audit
  // has NO live Cloud Scheduler trigger of its own anywhere in this repo as
  // of this PR (`grep -rln 'runSchedulerPauseAudit\|evaluateSchedulerDeadman'
  // services/worker/src/routes services/worker/src/index.ts` returns
  // nothing) — scheduler-pause-attribution.ts's own header comment confirms
  // this is a "deferred post-train T3 slice." So this manifest entry alone
  // does NOT make a forgotten Cloud Scheduler creation page anyone TODAY;
  // it is the correct, scoped, config-as-code step so that the alarm fires
  // automatically once that pre-existing wiring gap (which predates this
  // PR and affects every manifest entry, not just this one) is closed.
  {
    id: 'drive-subscription-renewal',
    category: 'maintenance',
    schedule: '0 * * * *',
    targetPath: '/jobs/drive-subscription-renewal',
    method: 'POST',
    owner: 'lane-3',
    enabled: true,
    maxSilenceMs: 3 * HOURS,
  },
  // ── Public-record FEEDERS ─────────────────────────────────────────────────
  // §1.5 / assert-prod-state-directly: VERIFIED ACTIVE in prod via Cloud Run
  // request logs on 2026-07-20 (fetch-courtlistener every ~15m — and 504-ing at
  // the 3600s timeout, SCRUM-2975; fetch-edgar every 6h; anchor-public-records
  // every ~10-50m). They are therefore recorded ENABLED — the manifest states
  // what IS, not the D12 intent.
  //
  // D12 (PI-0.5 feeder freeze) is a PENDING ruling — decision due 2026-07-25,
  // default codify-as-paused. It is NOT yet applied in prod. When Carson rules
  // paused, flip enabled:false and add actor attribution here; the dead-man
  // (scheduler-deadman.ts) will then treat their silence as EXPECTED+attributed
  // instead of an unattributed stall. Encoding them as paused TODAY would
  // assert a false prod state (they are running) and pre-empt an undecided
  // ruling — so we do not. The paused-attribution machinery is exercised by the
  // synthetic fixtures in the unit tests, not by a fabricated prod claim.
  {
    id: 'fetch-courtlistener',
    category: 'feeder',
    schedule: '*/15 * * * *',
    targetPath: '/jobs/fetch-courtlistener',
    method: 'POST',
    owner: 'lane-3',
    enabled: true,
    // Wide budget: verified SUCCESSFUL runs take 12-51 min. Signal semantics are
    // last-SUCCESSFUL-run, so if every invocation 504s (SCRUM-2975, ~91% today)
    // lastRunAt never advances and this WILL fire as an unattributed stall after
    // 6h — which is correct: a feeder that never completes is genuinely stalled,
    // even though its root cause is a sync-long-run timeout, not silence.
    maxSilenceMs: 6 * HOURS,
  },
  {
    id: 'anchor-public-records',
    category: 'feeder',
    // Live-verified */10 via gcloud 2026-08-10 (PR #2067 reconciliation).
    schedule: '*/10 * * * *',
    targetPath: '/jobs/anchor-public-records',
    method: 'POST',
    owner: 'lane-3',
    enabled: true,
    maxSilenceMs: 3 * HOURS,
  },
  {
    id: 'fetch-edgar',
    category: 'feeder',
    schedule: '0 */6 * * *',
    targetPath: '/jobs/fetch-edgar',
    method: 'POST',
    owner: 'lane-3',
    enabled: true,
    maxSilenceMs: 12 * HOURS,
  },
];

export function getScheduledJob(id: string): ScheduledJobSpec | undefined {
  return SCHEDULER_MANIFEST.find((j) => j.id === id);
}

export function enabledScheduledJobs(
  manifest: ScheduledJobSpec[] = SCHEDULER_MANIFEST,
): ScheduledJobSpec[] {
  return manifest.filter((j) => j.enabled);
}

export function pausedScheduledJobs(
  manifest: ScheduledJobSpec[] = SCHEDULER_MANIFEST,
): ScheduledJobSpec[] {
  return manifest.filter((j) => !j.enabled);
}

/**
 * Structural validation. Returns a list of human-readable errors (empty when
 * valid) so a CI/unit gate can assert the manifest stays honest:
 *   - unique ids
 *   - every paused job carries FULL actor attribution
 *   - no enabled job carries pause fields (a stale pause marker is a lie)
 *   - target path shape
 */
export function validateSchedulerManifest(manifest: ScheduledJobSpec[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const job of manifest) {
    if (seen.has(job.id)) errors.push(`duplicate job id: ${job.id}`);
    seen.add(job.id);

    if (!job.targetPath.startsWith('/jobs/')) {
      errors.push(`${job.id}: targetPath must start with /jobs/`);
    }

    if (job.enabled) {
      if (job.pausedBy || job.pausedReason || job.pausedAt) {
        errors.push(`${job.id}: enabled job must not carry pause attribution (stale pause marker)`);
      }
    } else {
      if (!job.pausedBy || !job.pausedReason || !job.pausedAt) {
        errors.push(
          `${job.id}: paused job missing actor attribution (pausedBy + pausedReason + pausedAt all required)`,
        );
      }
    }
  }

  return errors;
}

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
 * stopped it — the non-negotiable slice. D12: the public-record FEEDER jobs
 * are codified here as paused (the PI-0.5 feeder freeze).
 *
 * NOTE: this is the critical-set source of truth, not an exhaustive mirror of
 * every /jobs/* endpoint. Adding a job here opts it into dead-man monitoring.
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
    schedule: '*/10 * * * *',
    targetPath: '/jobs/batch-anchors',
    method: 'POST',
    owner: 'lane-1',
    enabled: true,
    maxSilenceMs: 1 * HOURS,
  },
  {
    id: 'check-confirmations',
    category: 'anchor-pipeline',
    schedule: '*/2 * * * *',
    targetPath: '/jobs/check-confirmations',
    method: 'POST',
    owner: 'lane-1',
    enabled: true,
    maxSilenceMs: 1 * HOURS,
  },
  {
    id: 'recover-broadcasts',
    category: 'anchor-pipeline',
    schedule: '*/2 * * * *',
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
    // Wide budget: verified successful runs take 12-51 min; the 504s (SCRUM-2975)
    // are a synchronous-long-run problem, not a silence problem.
    maxSilenceMs: 6 * HOURS,
  },
  {
    id: 'anchor-public-records',
    category: 'feeder',
    schedule: '*/30 * * * *',
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

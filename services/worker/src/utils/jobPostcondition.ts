/**
 * Job postcondition assertion (SCRUM-3050 — silent-failure hardening).
 *
 * ── The failure class this exists to end ────────────────────────────────────
 * On 2026-07-29 `fetchAnchorRows` passed 1,000 UUIDs to a PostgREST `.in()`
 * filter, producing a ~38 KB query string that was rejected `400 Bad Request`
 * on every chunk. The handler logged the error, `continue`d, returned an empty
 * set, and the job reported **HTTP 200**. Zero anchors were created for 70
 * hours while every cron dashboard stayed green. Two other silent failures were
 * found the same day. The common shape is not the PostgREST bug — it is that
 * "the handler ran to completion without throwing" was treated as "the handler
 * did its job".
 *
 * ── The contract ───────────────────────────────────────────────────────────
 * A cron handler that CLAIMED N units of work and COMPLETED ZERO of them has
 * not succeeded, and must not answer 200. Throwing turns the silence into a
 * Cloud Scheduler `AttemptFinished` ERROR entry — which is exactly the signal
 * the SCRUM-3050 GCP alert policy
 * (`scripts/gcp-setup/alert-policies/cloud-scheduler-job-failure-page.json`)
 * watches. The two halves of that story are deliberately one system: the
 * postcondition MAKES the failure observable, the alert policy ROUTES it.
 *
 * ── Deliberate non-goals ───────────────────────────────────────────────────
 * - `attempted === 0` is NOT a failure. An idle queue is a legitimate state and
 *   asserting on it would false-page nightly. "No work is arriving at all" is
 *   feeder death, owned by the scheduler dead-man (SCRUM-2900).
 * - Partial failure is NOT a 500. Retrying the whole job would redo the units
 *   that already succeeded; it is reported as `degraded` so the caller can warn
 *   and a monitor can trend it.
 * - This is a helper, not a framework. It is applied narrowly and on purpose;
 *   see `docs/reference/` / the SCRUM-3050 handoff for the audited list of
 *   remaining log-and-continue sites, which are follow-up work rather than a
 *   sweeping refactor.
 */

/** Work accounting for one cron run. */
export interface JobWorkOutcome {
  /** Job id — must match the Cloud Scheduler job name so the log is greppable. */
  jobName: string;
  /** Units of work claimed / selected for processing. */
  attempted: number;
  /** Units that completed successfully. */
  succeeded: number;
  /** Units that failed and were counted as failures. */
  failed: number;
}

export interface JobPostconditionVerdict {
  /** False means the run must NOT report success. */
  ok: boolean;
  /** True when work partially failed; `ok` stays true. */
  degraded: boolean;
  reason: string;
}

export class JobPostconditionError extends Error {
  readonly outcome: JobWorkOutcome;

  constructor(message: string, outcome: JobWorkOutcome) {
    super(message);
    this.name = 'JobPostconditionError';
    this.outcome = outcome;
  }
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/**
 * Pure evaluation — no I/O, no throwing. Callers that want the failing
 * behaviour use `assertJobPostcondition`.
 */
export function evaluateJobPostcondition(outcome: JobWorkOutcome): JobPostconditionVerdict {
  const { jobName, attempted, succeeded, failed } = outcome;

  // Instrumentation that cannot be trusted is itself a finding: a job whose
  // counters do not add up cannot prove it did any work, so it fails closed.
  if (
    !isNonNegativeInteger(attempted) ||
    !isNonNegativeInteger(succeeded) ||
    !isNonNegativeInteger(failed)
  ) {
    return {
      ok: false,
      degraded: false,
      reason:
        `${jobName}: inconsistent work accounting (negative or non-integer counters: ` +
        `attempted=${attempted}, succeeded=${succeeded}, failed=${failed})`,
    };
  }

  if (succeeded + failed > attempted) {
    return {
      ok: false,
      degraded: false,
      reason:
        `${jobName}: inconsistent work accounting — succeeded(${succeeded}) + ` +
        `failed(${failed}) exceeds attempted(${attempted})`,
    };
  }

  if (attempted === 0) {
    return { ok: true, degraded: false, reason: `${jobName}: no work available` };
  }

  if (succeeded === 0) {
    const unaccounted = attempted - failed;
    if (unaccounted > 0) {
      return {
        ok: false,
        degraded: false,
        reason:
          `${jobName}: claimed ${attempted} unit(s), completed 0, and ${unaccounted} ` +
          'were unaccounted for (neither succeeded nor counted as failed) — the run ' +
          'produced nothing while reporting success',
      };
    }
    return {
      ok: false,
      degraded: false,
      reason:
        `${jobName}: claimed ${attempted} unit(s) and completed 0 — every unit failed; ` +
        'reporting success here is the silent-failure shape (SCRUM-3050)',
    };
  }

  if (failed > 0) {
    return {
      ok: true,
      degraded: true,
      reason: `${jobName}: completed ${succeeded} of ${attempted}, ${failed} failed`,
    };
  }

  return {
    ok: true,
    degraded: false,
    reason: `${jobName}: completed ${succeeded} of ${attempted}`,
  };
}

/**
 * Throw when the run produced nothing despite claiming work. The throw is the
 * point: it converts a 200 into a 500, which Cloud Scheduler records as a
 * failed attempt, which the GCP alert policy pages on.
 */
export function assertJobPostcondition(outcome: JobWorkOutcome): JobPostconditionVerdict {
  const verdict = evaluateJobPostcondition(outcome);
  if (!verdict.ok) {
    throw new JobPostconditionError(verdict.reason, outcome);
  }
  return verdict;
}

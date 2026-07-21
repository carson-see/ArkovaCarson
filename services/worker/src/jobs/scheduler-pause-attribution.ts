/**
 * Live-pause audit with actor attribution (SCRUM-2900 dead-man wiring).
 *
 * scheduler-deadman.ts proves a monitored job went SILENT (telemetry layer).
 * This module audits the LIVE Cloud Scheduler state directly and answers the
 * incident question the silence layer cannot: a job is PAUSED — was that
 * sanctioned, and if not, WHO paused it? The motivating incident: prod feeder
 * jobs were silently paused for ~10 weeks in 2026-05 under the
 * carson@arkova.ai identity with no tracked record anywhere. The alert for an
 * unexpected pause therefore MUST carry the acting principal, pulled from the
 * Cloud Scheduler admin-activity audit log (`PauseJob` method), because the
 * Scheduler job resource itself does not record who paused it.
 *
 * Classification per MONITORED job (manifest = the opt-in critical set; live
 * jobs outside the manifest are ignored, mirroring scheduler-manifest.ts):
 *
 *   live PAUSED + manifest enabled:false      → codified-pause     (expected; manifest attribution)
 *   live PAUSED + ACTIVE allowlist entry      → sanctioned-maintenance (expected; allowlist attribution)
 *   live PAUSED + EXPIRED allowlist entry     → expired-sanction   → FIRES (rot is no sanction)
 *   live PAUSED + manifest enabled, no entry  → unexpected-pause   → FIRES + audit-log attribution
 *   live ENABLED + manifest enabled:false     → unsanctioned-resume (reported drift, not paging)
 *   manifest job absent from live listing     → missing-job        → FIRES (deleted is worse than paused)
 *
 * Attribution NEVER gates the page: if the audit-log lookup returns nothing
 * or throws, the finding still fires with the attribution failure noted. A
 * broken lookup must not suppress the alarm the lookup exists to enrich.
 *
 * PII (§1.4): the acting principal is an OPERATOR / service-account identity
 * — operational attribution data, not user PII (same stance as #1571's
 * pipeline-throughput monitor: aggregate/operational context only, never user
 * emails, fingerprints, or keys). It rides in the Sentry `extra` payload,
 * NEVER in the message: the beforeSend scrubber (utils/pii-scrub.ts) redacts
 * email-shaped substrings in messages to [EMAIL], and the message must stay
 * grouping-stable anyway.
 *
 * GCP access follows the established worker convention (bq-export-client.ts):
 * raw fetch + utils/gcp-auth.ts token, no @google-cloud/* SDK. Both sources
 * take injected fetch/token so tests never touch GCP (§1.7).
 *
 * This module performs READS ONLY (jobs.list + entries:list) — it never
 * mutates scheduler state, flags, or any prod resource. Runtime wiring
 * (route/cron binding) is the deferred post-train T3 slice, matching the
 * PR #1604 plan; `runSchedulerPauseAudit` is the injection-ready entry point
 * for it.
 */

import { logger } from '../utils/logger.js';
import { getGcpAccessToken } from '../utils/gcp-auth.js';
import { captureSchedulerPauseAlert } from '../utils/sentry.js';
import {
  MAINTENANCE_PAUSE_ALLOWLIST,
  lookupMaintenancePause,
  structuralAllowlistErrors,
  type MaintenancePauseAllowlistEntry,
} from './scheduler-pause-allowlist.js';
import {
  SCHEDULER_MANIFEST,
  validateSchedulerManifest,
  type ScheduledJobSpec,
} from './scheduler-manifest.js';

// ─── Live-state + attribution source contracts (injected; GCP impls below) ───

/** Cloud Scheduler job states we distinguish. Anything else maps to 'OTHER'. */
export type LiveSchedulerJobState = 'ENABLED' | 'PAUSED' | 'DISABLED' | 'OTHER';

export interface LiveSchedulerJob {
  /** Leaf job id (last segment of the Scheduler resource name). */
  id: string;
  state: LiveSchedulerJobState;
}

export interface SchedulerStateSource {
  listJobs(): Promise<LiveSchedulerJob[]>;
}

export interface PauseActorRecord {
  /** Acting identity from the audit log (user or service account). */
  principal: string;
  /** Audit-log timestamp of the pause, when present. */
  pausedAt: string | null;
}

export interface PauseActorSource {
  /** Newest PauseJob audit entry for the job, or null when none in the lookback. */
  lookupPauseActor(jobId: string): Promise<PauseActorRecord | null>;
}

// ─── Evaluator ───

export type PauseAuditClassification =
  | 'codified-pause'
  | 'sanctioned-maintenance'
  | 'expired-sanction'
  | 'unexpected-pause'
  | 'unexpected-state'
  | 'unsanctioned-resume'
  | 'missing-job';

export interface PauseAuditFinding {
  jobId: string;
  classification: PauseAuditClassification;
  /** True only for the paging classifications. */
  firing: boolean;
  /** The attributed identity, when resolvable; null otherwise. */
  actorPrincipal: string | null;
  /** Where the attribution came from. */
  actorSource: 'cloud-scheduler-audit-log' | 'manifest' | 'allowlist' | null;
  /** When the pause took effect, when known. */
  pausedAt: string | null;
  message: string;
}

export interface SchedulerPauseAuditReport {
  firing: boolean;
  firingJobIds: string[];
  findings: PauseAuditFinding[];
  /** Number of monitored (manifest) jobs evaluated. */
  checkedJobCount: number;
}

/**
 * Resolve the audit-log actor for a firing pause. Failure or absence never
 * suppresses the finding — it degrades to null attribution with the failure
 * noted in the message suffix.
 */
async function resolvePauseActor(
  jobId: string,
  actorSource: PauseActorSource,
): Promise<{ record: PauseActorRecord | null; suffix: string }> {
  try {
    const record = await actorSource.lookupPauseActor(jobId);
    if (!record) {
      return {
        record: null,
        suffix: 'no pause actor found in the audit-log lookback (attribution unavailable)',
      };
    }
    return {
      record,
      suffix: `paused ${record.pausedAt ?? 'at an unknown time'} — acting identity in alert context`,
    };
  } catch (err) {
    logger.error(
      { jobId, error: err instanceof Error ? err.message : String(err) },
      'Scheduler pause audit: actor lookup failed — finding fires without attribution',
    );
    return { record: null, suffix: 'audit-log actor lookup failed (attribution unavailable)' };
  }
}

function pausedFinding(
  job: ScheduledJobSpec,
  entry: MaintenancePauseAllowlistEntry | null,
  lookupStatus: 'codified' | 'active' | 'expired' | 'absent',
): PauseAuditFinding | null {
  switch (lookupStatus) {
    case 'codified':
      return {
        jobId: job.id,
        classification: 'codified-pause',
        firing: false,
        actorPrincipal: job.pausedBy ?? null,
        actorSource: 'manifest',
        pausedAt: job.pausedAt ?? null,
        message:
          `${job.id} is PAUSED as codified in the manifest by ${job.pausedBy ?? 'unknown'} ` +
          `(${job.pausedReason ?? 'no reason recorded'}, since ${job.pausedAt ?? 'unknown date'}) — expected.`,
      };
    case 'active':
      return {
        jobId: job.id,
        classification: 'sanctioned-maintenance',
        firing: false,
        actorPrincipal: entry?.approvedBy ?? null,
        actorSource: 'allowlist',
        pausedAt: null,
        message:
          `${job.id} is PAUSED under an active maintenance sanction by ${entry?.approvedBy} ` +
          `(${entry?.reason}), expires ${entry?.expiresAt} — expected.`,
      };
    default:
      return null; // 'expired' | 'absent' handled by the firing paths (need actor lookup)
  }
}

export interface EvaluateSchedulerPauseAuditOptions {
  manifest: ScheduledJobSpec[];
  liveJobs: LiveSchedulerJob[];
  allowlist: MaintenancePauseAllowlistEntry[];
  nowMs: number;
  actorSource: PauseActorSource;
}

/**
 * Evaluate the live-pause audit over the monitored fleet. Async only because
 * firing pauses spend an audit-log attribution lookup (lazy — sanctioned
 * pauses never do).
 */
export async function evaluateSchedulerPauseAudit(
  opts: EvaluateSchedulerPauseAuditOptions,
): Promise<SchedulerPauseAuditReport> {
  const { manifest, liveJobs, allowlist, nowMs, actorSource } = opts;
  const liveById = new Map(liveJobs.map((j) => [j.id, j]));
  const findings: PauseAuditFinding[] = [];

  for (const job of manifest) {
    const live = liveById.get(job.id);

    // Manifest job absent from the live listing: the Scheduler job does not
    // exist at all — worse than paused. Fires, no pause actor to attribute
    // (a DeleteJob attribution pass is a possible follow-up).
    if (!live) {
      findings.push({
        jobId: job.id,
        classification: 'missing-job',
        firing: true,
        actorPrincipal: null,
        actorSource: null,
        pausedAt: null,
        message: `${job.id} is in the manifest but MISSING from the live Cloud Scheduler listing — job deleted or never created; page a human.`,
      });
      continue;
    }

    if (live.state === 'PAUSED') {
      if (!job.enabled) {
        const finding = pausedFinding(job, null, 'codified');
        if (finding) findings.push(finding);
        continue;
      }

      const lookup = lookupMaintenancePause(job.id, nowMs, allowlist);
      if (lookup.status === 'active') {
        const finding = pausedFinding(job, lookup.entry, 'active');
        if (finding) findings.push(finding);
        continue;
      }

      // Firing pause (expired sanction or none at all) → attribute the actor.
      const { record, suffix } = await resolvePauseActor(job.id, actorSource);
      if (lookup.status === 'expired') {
        findings.push({
          jobId: job.id,
          classification: 'expired-sanction',
          firing: true,
          actorPrincipal: record?.principal ?? null,
          actorSource: record ? 'cloud-scheduler-audit-log' : null,
          pausedAt: record?.pausedAt ?? null,
          message:
            `${job.id} is PAUSED under a maintenance sanction that EXPIRED at ${lookup.entry.expiresAt} ` +
            `(${lookup.entry.reason}, approved by ${lookup.entry.approvedBy}) — a rotted sanction is no sanction; ${suffix}.`,
        });
      } else {
        findings.push({
          jobId: job.id,
          classification: 'unexpected-pause',
          firing: true,
          actorPrincipal: record?.principal ?? null,
          actorSource: record ? 'cloud-scheduler-audit-log' : null,
          pausedAt: record?.pausedAt ?? null,
          message:
            `${job.id} is PAUSED in Cloud Scheduler but the manifest says ENABLED and no maintenance ` +
            `sanction covers it — UNEXPECTED pause; ${suffix}; page a human.`,
        });
      }
      continue;
    }

    // Live non-PAUSED state while the manifest codifies a pause: drift the
    // other way. Reported (the manifest or the console is wrong and must be
    // reconciled) but not paging — the job is not silently stopped.
    if (!job.enabled) {
      findings.push({
        jobId: job.id,
        classification: 'unsanctioned-resume',
        firing: false,
        actorPrincipal: null,
        actorSource: null,
        pausedAt: null,
        message:
          `${job.id} is ${live.state} in Cloud Scheduler but the manifest codifies it PAUSED ` +
          `(by ${job.pausedBy ?? 'unknown'}) — manifest/console drift; reconcile in the next PR.`,
      });
      continue;
    }

    // Manifest-enabled but live state is neither ENABLED nor PAUSED
    // (DISABLED — system-set when the job errors — or an unrecognized state):
    // the job is NOT running and no one codified a stop. Silence here would
    // hide a broken feeder behind "no unexpected pauses" (review fix 2).
    // Pause attribution does not apply — there is no PauseJob audit entry for
    // a system DISABLE.
    if (live.state !== 'ENABLED') {
      findings.push({
        jobId: job.id,
        classification: 'unexpected-state',
        firing: true,
        actorPrincipal: null,
        actorSource: null,
        pausedAt: null,
        message:
          `${job.id} is ${live.state} in Cloud Scheduler but the manifest says ENABLED — ` +
          `the job is not scheduled to run (DISABLED is system-set on error) and no pause was codified; page a human.`,
      });
    }
    // Live ENABLED + manifest enabled → healthy; no finding (silence budget
    // enforcement lives in scheduler-deadman.ts).
  }

  const firingJobIds = findings.filter((f) => f.firing).map((f) => f.jobId);
  return {
    firing: firingJobIds.length > 0,
    firingJobIds,
    findings,
    checkedJobCount: manifest.length,
  };
}

// ─── GCP-backed sources (fetch + gcp-auth, SDK-free per worker convention) ───

/** Minimal fetch-shaped contract so tests can mock at the HTTP boundary. */
export type FetchLike = (
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface GcpSourceOptions {
  projectId: string;
  locationId: string;
  fetchImpl?: FetchLike;
  getToken?: () => Promise<string>;
}

const SCHEDULER_API_BASE = 'https://cloudscheduler.googleapis.com/v1';
const LOGGING_ENTRIES_LIST = 'https://logging.googleapis.com/v2/entries:list';
export const DEFAULT_PAUSE_AUDIT_LOOKBACK_DAYS = 90;

/**
 * entries.list on a narrow filter routinely returns EMPTY pages with a
 * nextPageToken (the backend scans in bounded slices). A single-page read
 * would report "no pause actor" while the real PauseJob entry sits deeper in
 * the scan — silently defeating attribution in the exact 10-week-old-pause
 * incident shape (review fix 3). Follow tokens through empty pages, bounded
 * so a pathological scan cannot walk the whole log.
 */
export const MAX_AUDIT_LOG_PAGES = 10;

/**
 * Cloud Scheduler jobs.list-backed state source. Paginates; maps resource
 * names to leaf ids. Fails LOUD on any non-OK page — a broken listing must
 * never read as "no jobs" (which would fire every manifest job as missing).
 */
export function createCloudSchedulerStateSource(opts: GcpSourceOptions): SchedulerStateSource {
  const { projectId, locationId } = opts;
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const getToken = opts.getToken ?? (() => getGcpAccessToken());

  return {
    async listJobs(): Promise<LiveSchedulerJob[]> {
      const jobs: LiveSchedulerJob[] = [];
      let pageToken: string | undefined;

      do {
        const token = await getToken();
        const params = new URLSearchParams({ pageSize: '500' });
        if (pageToken) params.set('pageToken', pageToken);
        const url = `${SCHEDULER_API_BASE}/projects/${projectId}/locations/${locationId}/jobs?${params.toString()}`;
        const res = await fetchImpl(url, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          throw new Error(`Cloud Scheduler jobs.list failed: ${res.status}`);
        }
        const body = (await res.json()) as {
          jobs?: Array<{ name?: string; state?: string }>;
          nextPageToken?: string;
        };
        for (const j of body.jobs ?? []) {
          if (!j.name) continue;
          const id = j.name.split('/').pop() as string;
          const state: LiveSchedulerJobState =
            j.state === 'ENABLED' || j.state === 'PAUSED' || j.state === 'DISABLED'
              ? j.state
              : 'OTHER';
          jobs.push({ id, state });
        }
        pageToken = body.nextPageToken;
      } while (pageToken);

      return jobs;
    },
  };
}

export interface AuditLogSourceOptions extends GcpSourceOptions {
  /** How far back to search for the PauseJob entry. Default 90 days. */
  lookbackDays?: number;
  /** Injected clock for a deterministic lookback window in tests. */
  nowMs?: number;
}

/**
 * Cloud Logging admin-activity audit-log actor source: newest
 * `CloudScheduler.PauseJob` entry for the job within the lookback. Returns
 * the acting principal (user or service account) + the pause timestamp, or
 * null when none. Fails LOUD on a non-OK response so the evaluator records
 * "lookup failed" instead of a silent no-actor.
 */
export function createAuditLogPauseActorSource(opts: AuditLogSourceOptions): PauseActorSource {
  const { projectId, locationId } = opts;
  const fetchImpl: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const getToken = opts.getToken ?? (() => getGcpAccessToken());
  const lookbackDays = opts.lookbackDays ?? DEFAULT_PAUSE_AUDIT_LOOKBACK_DAYS;

  return {
    async lookupPauseActor(jobId: string): Promise<PauseActorRecord | null> {
      const nowMs = opts.nowMs ?? Date.now();
      const sinceIso = new Date(nowMs - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
      const resourceName = `projects/${projectId}/locations/${locationId}/jobs/${jobId}`;
      // NOT status.code>0: a FAILED PauseJob attempt (permission denied etc.)
      // records the ATTEMPTING principal — attributing them as the pauser
      // would name someone who did not pause anything (review fix 6). A
      // successful call carries no error status (field absent or code 0),
      // which the NOT-comparison matches.
      const filter =
        `resource.type="cloud_scheduler_job" AND ` +
        `protoPayload.methodName="google.cloud.scheduler.v1.CloudScheduler.PauseJob" AND ` +
        `protoPayload.resourceName="${resourceName}" AND ` +
        `NOT protoPayload.status.code>0 AND ` +
        `timestamp>="${sinceIso}"`;

      let pageToken: string | undefined;
      for (let page = 0; page < MAX_AUDIT_LOG_PAGES; page += 1) {
        const token = await getToken();
        const res = await fetchImpl(LOGGING_ENTRIES_LIST, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            resourceNames: [`projects/${projectId}`],
            filter,
            orderBy: 'timestamp desc',
            pageSize: 1,
            ...(pageToken ? { pageToken } : {}),
          }),
        });
        if (!res.ok) {
          throw new Error(`Cloud Logging entries.list failed: ${res.status}`);
        }
        const body = (await res.json()) as {
          entries?: Array<{
            timestamp?: string;
            protoPayload?: { authenticationInfo?: { principalEmail?: string } };
          }>;
          nextPageToken?: string;
        };
        const entry = body.entries?.[0];
        const principal = entry?.protoPayload?.authenticationInfo?.principalEmail;
        if (principal) {
          return { principal, pausedAt: entry?.timestamp ?? null };
        }
        // Empty page: only continue while the API says the scan is unfinished.
        if (!body.nextPageToken) return null;
        pageToken = body.nextPageToken;
      }
      return null; // page cap hit — treat as not found (bounded scan)
    },
  };
}

// ─── Cron-style runner (injection-ready entry point for the post-train wiring) ───

export interface RunSchedulerPauseAuditDeps {
  manifest?: ScheduledJobSpec[];
  allowlist?: MaintenancePauseAllowlistEntry[];
  stateSource: SchedulerStateSource;
  actorSource: PauseActorSource;
  /** Sentry emitter — defaults to the stable-fingerprint helper. */
  emitAlert?: (message: string, extra?: Record<string, unknown>) => void;
  nowMs?: number;
}

export interface SchedulerPauseAuditResult extends SchedulerPauseAuditReport {
  alertFired: boolean;
  checkedAt: string;
}

/**
 * End-to-end audit pass: validate config, list live jobs, evaluate, and on
 * any firing finding emit ONE stable-fingerprint Sentry alert.
 *
 * Failure semantics mirror pipelineThroughputMonitor: invalid config or a
 * broken live listing THROWS (route → 500 → Scheduler retry); a DETECTED
 * unexpected pause is a correct result (the future route returns 200 with
 * firing:true).
 *
 * §1.4: the alert MESSAGE carries job ids + classification only (grouping-
 * stable, survives the email scrub untouched). Acting principals ride in
 * `extra.findings[].actor_principal` — operator/service-account identity is
 * operational attribution data, not user PII.
 */
export async function runSchedulerPauseAudit(
  deps: RunSchedulerPauseAuditDeps,
): Promise<SchedulerPauseAuditResult> {
  const manifest = deps.manifest ?? SCHEDULER_MANIFEST;
  const allowlist = deps.allowlist ?? MAINTENANCE_PAUSE_ALLOWLIST;
  const emitAlert = deps.emitAlert ?? captureSchedulerPauseAlert;
  const nowMs = deps.nowMs ?? Date.now();

  const manifestErrors = validateSchedulerManifest(manifest);
  if (manifestErrors.length > 0) {
    throw new Error(`Scheduler pause audit: invalid manifest — ${manifestErrors.join('; ')}`);
  }
  // STRUCTURAL allowlist errors only (missing reason/approver, tz-less or
  // unparseable expiry, duplicate, unknown jobId): fatal — the config cannot
  // be trusted. EXPIRY is deliberately NOT fatal here (review fix 1): an
  // expired entry with the job still paused is the exact rot scenario this
  // dead-man exists for. If expiry threw, the deployed audit would 500 →
  // Scheduler retry crash-loop and the fingerprinted `expired-sanction` page
  // (with attribution) would NEVER fire. The evaluator classifies it instead;
  // the strict full validation (incl. expiry) remains the CI unit gate.
  const allowlistErrors = structuralAllowlistErrors(
    allowlist,
    manifest.map((j) => j.id),
  );
  if (allowlistErrors.length > 0) {
    throw new Error(`Scheduler pause audit: invalid allowlist — ${allowlistErrors.join('; ')}`);
  }

  // A state-source failure propagates: a broken listing must never report a
  // healthy fleet.
  const liveJobs = await deps.stateSource.listJobs();

  const report = await evaluateSchedulerPauseAudit({
    manifest,
    liveJobs,
    allowlist,
    nowMs,
    actorSource: deps.actorSource,
  });

  const result: SchedulerPauseAuditResult = {
    ...report,
    alertFired: false,
    checkedAt: new Date(nowMs).toISOString(),
  };

  const logContext = {
    checkedJobCount: report.checkedJobCount,
    firingJobIds: report.firingJobIds,
    findings: report.findings.map((f) => ({
      jobId: f.jobId,
      classification: f.classification,
      firing: f.firing,
      // Operator/service-account identity — operational attribution data.
      actorPrincipal: f.actorPrincipal,
      actorSource: f.actorSource,
      pausedAt: f.pausedAt,
    })),
  };

  if (report.firing) {
    logger.error(
      logContext,
      `Scheduler pause dead-man: ${report.firingJobIds.length} firing finding(s) — ${report.firingJobIds.join(', ')}`,
    );
    const byClass = report.findings
      .filter((f) => f.firing)
      .map((f) => `${f.jobId} (${f.classification})`)
      .join(', ');
    try {
      emitAlert(
        `Scheduler pause dead-man: unexpected scheduler state — ${byClass}`,
        {
          source: 'scheduler-pause-audit',
          story: 'SCRUM-2900',
          checked_job_count: report.checkedJobCount,
          firing_job_ids: report.firingJobIds,
          findings: report.findings.map((f) => ({
            job_id: f.jobId,
            classification: f.classification,
            firing: f.firing,
            actor_principal: f.actorPrincipal,
            actor_source: f.actorSource,
            paused_at: f.pausedAt,
          })),
        },
      );
      result.alertFired = true;
    } catch (err) {
      logger.error({ error: err }, 'Scheduler pause dead-man: failed to emit Sentry alert');
    }
  } else {
    logger.info(logContext, 'Scheduler pause dead-man: no unexpected pauses');
  }

  return result;
}

/**
 * Tests for the live-pause audit with actor attribution (SCRUM-2900 wiring).
 *
 * The silence dead-man (scheduler-deadman.ts) proves a job went quiet. This
 * layer looks at the LIVE Cloud Scheduler state and answers the incident
 * question directly: a job is PAUSED — was that sanctioned, and if not, WHO
 * paused it? (The 2026-05 feeder freeze sat untracked for ~10 weeks under the
 * carson@arkova.ai identity; the alert must carry the acting principal.)
 *
 * All GCP surfaces (Cloud Scheduler list, audit-log actor lookup) are
 * injected and mocked here — no real GCP calls (§1.7).
 */

import { describe, it, expect, vi } from 'vitest';

// Config-free logger + Sentry mocks (mirrors pipelineThroughputMonitor.test.ts
// — the real logger pulls config.ts, which demands full worker env).
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockCaptureSchedulerPauseAlert = vi.fn();
vi.mock('../utils/sentry.js', () => ({
  captureSchedulerPauseAlert: (...args: unknown[]) => mockCaptureSchedulerPauseAlert(...args),
}));

import {
  evaluateSchedulerPauseAudit,
  createCloudSchedulerStateSource,
  createAuditLogPauseActorSource,
  runSchedulerPauseAudit,
  type LiveSchedulerJob,
  type PauseActorSource,
} from './scheduler-pause-attribution.js';
import type { ScheduledJobSpec } from './scheduler-manifest.js';
import type { MaintenancePauseAllowlistEntry } from './scheduler-pause-allowlist.js';

const NOW = Date.parse('2026-07-21T12:00:00Z');

const enabledJob: ScheduledJobSpec = {
  id: 'batch-anchors',
  category: 'anchor-pipeline',
  schedule: '*/10 * * * *',
  targetPath: '/jobs/batch-anchors',
  method: 'POST',
  owner: 'lane-1',
  enabled: true,
  maxSilenceMs: 60 * 60 * 1000,
};

const enabledFeeder: ScheduledJobSpec = {
  id: 'fetch-edgar',
  category: 'feeder',
  schedule: '0 */6 * * *',
  targetPath: '/jobs/fetch-edgar',
  method: 'POST',
  owner: 'lane-3',
  enabled: true,
};

const codifiedPausedJob: ScheduledJobSpec = {
  id: 'fetch-courtlistener',
  category: 'feeder',
  schedule: '*/15 * * * *',
  targetPath: '/jobs/fetch-courtlistener',
  method: 'POST',
  owner: 'lane-3',
  enabled: false,
  pausedBy: 'carson',
  pausedReason: 'PI-0.5 feeder freeze (D12)',
  pausedAt: '2026-07-05',
};

const activeAllowlistEntry: MaintenancePauseAllowlistEntry = {
  jobId: 'fetch-edgar',
  reason: 'founder-gated feeder drain rehearsal',
  approvedBy: 'carson (founder)',
  expiresAt: '2026-08-01T00:00:00Z',
};

const expiredAllowlistEntry: MaintenancePauseAllowlistEntry = {
  jobId: 'fetch-edgar',
  reason: 'rig maintenance window',
  approvedBy: 'lane-3',
  expiresAt: '2026-07-01T00:00:00Z',
};

function actorSourceReturning(
  record: { principal: string; pausedAt: string | null } | null,
): PauseActorSource & { lookupPauseActor: ReturnType<typeof vi.fn> } {
  return { lookupPauseActor: vi.fn().mockResolvedValue(record) };
}

describe('evaluateSchedulerPauseAudit — classification matrix', () => {
  it('live ENABLED + manifest enabled → healthy, no finding', async () => {
    const live: LiveSchedulerJob[] = [{ id: 'batch-anchors', state: 'ENABLED' }];
    const report = await evaluateSchedulerPauseAudit({
      manifest: [enabledJob],
      liveJobs: live,
      allowlist: [],
      nowMs: NOW,
      actorSource: actorSourceReturning(null),
    });
    expect(report.firing).toBe(false);
    expect(report.findings).toEqual([]);
  });

  it('live PAUSED + manifest codified pause → expected, attributed from the MANIFEST, not firing', async () => {
    const live: LiveSchedulerJob[] = [{ id: 'fetch-courtlistener', state: 'PAUSED' }];
    const actorSource = actorSourceReturning(null);
    const report = await evaluateSchedulerPauseAudit({
      manifest: [codifiedPausedJob],
      liveJobs: live,
      allowlist: [],
      nowMs: NOW,
      actorSource,
    });
    expect(report.firing).toBe(false);
    const f = report.findings[0];
    expect(f.classification).toBe('codified-pause');
    expect(f.actorPrincipal).toBe('carson');
    expect(f.actorSource).toBe('manifest');
    expect(f.firing).toBe(false);
    // No audit-log spend for a codified pause.
    expect(actorSource.lookupPauseActor).not.toHaveBeenCalled();
  });

  it('live PAUSED + ACTIVE allowlist entry → sanctioned maintenance, not firing, carries reason + approver + expiry', async () => {
    const live: LiveSchedulerJob[] = [{ id: 'fetch-edgar', state: 'PAUSED' }];
    const report = await evaluateSchedulerPauseAudit({
      manifest: [enabledFeeder],
      liveJobs: live,
      allowlist: [activeAllowlistEntry],
      nowMs: NOW,
      actorSource: actorSourceReturning(null),
    });
    expect(report.firing).toBe(false);
    const f = report.findings[0];
    expect(f.classification).toBe('sanctioned-maintenance');
    expect(f.firing).toBe(false);
    expect(f.actorPrincipal).toBe('carson (founder)');
    expect(f.actorSource).toBe('allowlist');
    expect(f.message).toMatch(/founder-gated feeder drain rehearsal/);
    expect(f.message).toMatch(/2026-08-01/);
  });

  it('live PAUSED + EXPIRED allowlist entry → FIRES (a sanction that rotted is no sanction)', async () => {
    const live: LiveSchedulerJob[] = [{ id: 'fetch-edgar', state: 'PAUSED' }];
    const report = await evaluateSchedulerPauseAudit({
      manifest: [enabledFeeder],
      liveJobs: live,
      allowlist: [expiredAllowlistEntry],
      nowMs: NOW,
      actorSource: actorSourceReturning({
        principal: 'carson@arkova.ai',
        pausedAt: '2026-05-02T09:14:00Z',
      }),
    });
    expect(report.firing).toBe(true);
    const f = report.findings[0];
    expect(f.classification).toBe('expired-sanction');
    expect(f.firing).toBe(true);
    expect(f.message).toMatch(/expired/i);
    // Attribution still resolved so the operator knows who to ask.
    expect(f.actorPrincipal).toBe('carson@arkova.ai');
    expect(f.actorSource).toBe('cloud-scheduler-audit-log');
  });

  it('live PAUSED, manifest-enabled, no allowlist → UNEXPECTED PAUSE fires WITH audit-log actor attribution', async () => {
    const live: LiveSchedulerJob[] = [{ id: 'batch-anchors', state: 'PAUSED' }];
    const actorSource = actorSourceReturning({
      principal: 'carson@arkova.ai',
      pausedAt: '2026-05-02T09:14:00Z',
    });
    const report = await evaluateSchedulerPauseAudit({
      manifest: [enabledJob],
      liveJobs: live,
      allowlist: [],
      nowMs: NOW,
      actorSource,
    });
    expect(report.firing).toBe(true);
    expect(report.firingJobIds).toEqual(['batch-anchors']);
    const f = report.findings[0];
    expect(f.classification).toBe('unexpected-pause');
    expect(f.actorPrincipal).toBe('carson@arkova.ai');
    expect(f.pausedAt).toBe('2026-05-02T09:14:00Z');
    expect(f.actorSource).toBe('cloud-scheduler-audit-log');
    expect(actorSource.lookupPauseActor).toHaveBeenCalledWith('batch-anchors');
  });

  it('an unexpected pause STILL fires when the audit log has no actor (attribution unavailable ≠ suppressed page)', async () => {
    const live: LiveSchedulerJob[] = [{ id: 'batch-anchors', state: 'PAUSED' }];
    const report = await evaluateSchedulerPauseAudit({
      manifest: [enabledJob],
      liveJobs: live,
      allowlist: [],
      nowMs: NOW,
      actorSource: actorSourceReturning(null),
    });
    expect(report.firing).toBe(true);
    const f = report.findings[0];
    expect(f.classification).toBe('unexpected-pause');
    expect(f.actorPrincipal).toBeNull();
    expect(f.message).toMatch(/attribution unavailable|no pause actor/i);
  });

  it('an unexpected pause STILL fires when the actor lookup THROWS (lookup outage ≠ suppressed page)', async () => {
    const live: LiveSchedulerJob[] = [{ id: 'batch-anchors', state: 'PAUSED' }];
    const actorSource: PauseActorSource = {
      lookupPauseActor: vi.fn().mockRejectedValue(new Error('logging API 500')),
    };
    const report = await evaluateSchedulerPauseAudit({
      manifest: [enabledJob],
      liveJobs: live,
      allowlist: [],
      nowMs: NOW,
      actorSource,
    });
    expect(report.firing).toBe(true);
    expect(report.findings[0].actorPrincipal).toBeNull();
    expect(report.findings[0].message).toMatch(/lookup failed/i);
  });

  it('live ENABLED but manifest says paused → reported as unsanctioned-resume drift, NOT firing', async () => {
    const live: LiveSchedulerJob[] = [{ id: 'fetch-courtlistener', state: 'ENABLED' }];
    const report = await evaluateSchedulerPauseAudit({
      manifest: [codifiedPausedJob],
      liveJobs: live,
      allowlist: [],
      nowMs: NOW,
      actorSource: actorSourceReturning(null),
    });
    expect(report.firing).toBe(false);
    const f = report.findings[0];
    expect(f.classification).toBe('unsanctioned-resume');
    expect(f.firing).toBe(false);
  });

  it('a manifest job MISSING from the live listing fires (deleted job is worse than a paused one)', async () => {
    const report = await evaluateSchedulerPauseAudit({
      manifest: [enabledJob],
      liveJobs: [],
      allowlist: [],
      nowMs: NOW,
      actorSource: actorSourceReturning(null),
    });
    expect(report.firing).toBe(true);
    const f = report.findings[0];
    expect(f.classification).toBe('missing-job');
    expect(f.firing).toBe(true);
    expect(f.message).toMatch(/missing|not found/i);
  });

  it('manifest-enabled + live DISABLED fires as unexpected-state (system-set on error; silence here would hide a broken feeder) — review FIX 2', async () => {
    const live: LiveSchedulerJob[] = [{ id: 'batch-anchors', state: 'DISABLED' }];
    const actorSource = actorSourceReturning(null);
    const report = await evaluateSchedulerPauseAudit({
      manifest: [enabledJob],
      liveJobs: live,
      allowlist: [],
      nowMs: NOW,
      actorSource,
    });
    expect(report.firing).toBe(true);
    const f = report.findings[0];
    expect(f.classification).toBe('unexpected-state');
    expect(f.firing).toBe(true);
    expect(f.message).toMatch(/DISABLED/);
    // Pause attribution only applies to PAUSED — no audit-log spend here.
    expect(actorSource.lookupPauseActor).not.toHaveBeenCalled();
  });

  it('manifest-enabled + live OTHER (unrecognized state) also fires as unexpected-state', async () => {
    const live: LiveSchedulerJob[] = [{ id: 'batch-anchors', state: 'OTHER' }];
    const report = await evaluateSchedulerPauseAudit({
      manifest: [enabledJob],
      liveJobs: live,
      allowlist: [],
      nowMs: NOW,
      actorSource: actorSourceReturning(null),
    });
    expect(report.firing).toBe(true);
    expect(report.findings[0].classification).toBe('unexpected-state');
  });

  it('live jobs NOT in the manifest are ignored (manifest is the opt-in monitored set)', async () => {
    const live: LiveSchedulerJob[] = [
      { id: 'batch-anchors', state: 'ENABLED' },
      { id: 'some-rig-job', state: 'PAUSED' },
    ];
    const report = await evaluateSchedulerPauseAudit({
      manifest: [enabledJob],
      liveJobs: live,
      allowlist: [],
      nowMs: NOW,
      actorSource: actorSourceReturning(null),
    });
    expect(report.firing).toBe(false);
    expect(report.findings).toEqual([]);
  });

  it('a PAUSED allowlisted job never spends an audit-log lookup (lazy attribution)', async () => {
    const live: LiveSchedulerJob[] = [{ id: 'fetch-edgar', state: 'PAUSED' }];
    const actorSource = actorSourceReturning(null);
    await evaluateSchedulerPauseAudit({
      manifest: [enabledFeeder],
      liveJobs: live,
      allowlist: [activeAllowlistEntry],
      nowMs: NOW,
      actorSource,
    });
    expect(actorSource.lookupPauseActor).not.toHaveBeenCalled();
  });
});

// ─── GCP-backed sources (fetch mocked — no real GCP calls, §1.7) ───

describe('createCloudSchedulerStateSource', () => {
  it('lists jobs, maps resource names to leaf ids + states, and follows pagination', async () => {
    const page1 = {
      jobs: [
        { name: 'projects/arkova1/locations/us-central1/jobs/batch-anchors', state: 'ENABLED' },
        { name: 'projects/arkova1/locations/us-central1/jobs/fetch-edgar', state: 'PAUSED' },
      ],
      nextPageToken: 'tok-2',
    };
    const page2 = {
      jobs: [
        { name: 'projects/arkova1/locations/us-central1/jobs/check-confirmations', state: 'ENABLED' },
      ],
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => page1 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => page2 });

    const source = createCloudSchedulerStateSource({
      projectId: 'arkova1',
      locationId: 'us-central1',
      fetchImpl,
      getToken: async () => 'test-token',
    });
    const jobs = await source.listJobs();

    expect(jobs).toEqual([
      { id: 'batch-anchors', state: 'ENABLED' },
      { id: 'fetch-edgar', state: 'PAUSED' },
      { id: 'check-confirmations', state: 'ENABLED' },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstUrl = fetchImpl.mock.calls[0][0] as string;
    expect(firstUrl).toContain(
      'https://cloudscheduler.googleapis.com/v1/projects/arkova1/locations/us-central1/jobs',
    );
    const secondUrl = fetchImpl.mock.calls[1][0] as string;
    expect(secondUrl).toContain('pageToken=tok-2');
    // Bearer token attached, never logged.
    const init = fetchImpl.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer test-token');
  });

  it('fails LOUD on a non-OK response (a broken probe must not read as "no jobs")', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: 'forbidden' } }),
    });
    const source = createCloudSchedulerStateSource({
      projectId: 'arkova1',
      locationId: 'us-central1',
      fetchImpl,
      getToken: async () => 'test-token',
    });
    await expect(source.listJobs()).rejects.toThrow(/403/);
  });
});

describe('createAuditLogPauseActorSource', () => {
  it('queries the PauseJob audit log for the job and returns the newest principal + timestamp', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        entries: [
          {
            timestamp: '2026-05-02T09:14:00Z',
            protoPayload: {
              methodName: 'google.cloud.scheduler.v1.CloudScheduler.PauseJob',
              authenticationInfo: { principalEmail: 'carson@arkova.ai' },
            },
          },
        ],
      }),
    });
    const source = createAuditLogPauseActorSource({
      projectId: 'arkova1',
      locationId: 'us-central1',
      fetchImpl,
      getToken: async () => 'test-token',
      nowMs: NOW,
    });
    const record = await source.lookupPauseActor('fetch-courtlistener');
    expect(record).toEqual({
      principal: 'carson@arkova.ai',
      pausedAt: '2026-05-02T09:14:00Z',
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('https://logging.googleapis.com/v2/entries:list');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body) as { filter: string; orderBy: string; pageSize: number };
    expect(body.filter).toContain('PauseJob');
    expect(body.filter).toContain(
      'projects/arkova1/locations/us-central1/jobs/fetch-courtlistener',
    );
    // FIX 6: failed PauseJob attempts (permission-denied etc.) must not be
    // attributed as the pauser — the filter excludes entries with an error status.
    expect(body.filter).toContain('NOT protoPayload.status.code>0');
    expect(body.orderBy).toBe('timestamp desc');
    expect(body.pageSize).toBe(1);
  });

  it('follows nextPageToken through EMPTY pages to find the entry (narrow filters return empty pages) — review FIX 3', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ nextPageToken: 'page-2' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ nextPageToken: 'page-3' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          entries: [
            {
              timestamp: '2026-05-02T09:14:00Z',
              protoPayload: {
                authenticationInfo: { principalEmail: 'carson@arkova.ai' },
              },
            },
          ],
        }),
      });
    const source = createAuditLogPauseActorSource({
      projectId: 'arkova1',
      locationId: 'us-central1',
      fetchImpl,
      getToken: async () => 'test-token',
      nowMs: NOW,
    });
    const record = await source.lookupPauseActor('fetch-courtlistener');
    expect(record?.principal).toBe('carson@arkova.ai');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const secondBody = JSON.parse(
      (fetchImpl.mock.calls[1][1] as { body: string }).body,
    ) as { pageToken?: string };
    expect(secondBody.pageToken).toBe('page-2');
    const thirdBody = JSON.parse(
      (fetchImpl.mock.calls[2][1] as { body: string }).body,
    ) as { pageToken?: string };
    expect(thirdBody.pageToken).toBe('page-3');
  });

  it('bounds the empty-page scan (returns null after the page cap instead of walking the log forever)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ nextPageToken: 'again' }),
    });
    const source = createAuditLogPauseActorSource({
      projectId: 'arkova1',
      locationId: 'us-central1',
      fetchImpl,
      getToken: async () => 'test-token',
      nowMs: NOW,
    });
    await expect(source.lookupPauseActor('fetch-edgar')).resolves.toBeNull();
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(10);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
  });

  it('returns null when the lookback window holds no PauseJob entry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    const source = createAuditLogPauseActorSource({
      projectId: 'arkova1',
      locationId: 'us-central1',
      fetchImpl,
      getToken: async () => 'test-token',
      nowMs: NOW,
    });
    await expect(source.lookupPauseActor('fetch-edgar')).resolves.toBeNull();
  });

  it('fails LOUD on a non-OK response so the evaluator records "lookup failed" (never silent-null)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: 'boom' } }),
    });
    const source = createAuditLogPauseActorSource({
      projectId: 'arkova1',
      locationId: 'us-central1',
      fetchImpl,
      getToken: async () => 'test-token',
      nowMs: NOW,
    });
    await expect(source.lookupPauseActor('fetch-edgar')).rejects.toThrow(/500/);
  });
});

// ─── Cron-style runner: composition + Sentry emission (all injected) ───

describe('runSchedulerPauseAudit', () => {
  const pausedLive: LiveSchedulerJob[] = [{ id: 'batch-anchors', state: 'PAUSED' }];

  it('fires ONE stable-fingerprint alert on an unexpected pause; principal rides in extra, NEVER in the message (§1.4 scrub)', async () => {
    const emitAlert = vi.fn();
    const result = await runSchedulerPauseAudit({
      manifest: [enabledJob],
      allowlist: [],
      stateSource: { listJobs: async () => pausedLive },
      actorSource: actorSourceReturning({
        principal: 'carson@arkova.ai',
        pausedAt: '2026-05-02T09:14:00Z',
      }),
      emitAlert,
      nowMs: NOW,
    });

    expect(result.firing).toBe(true);
    expect(result.alertFired).toBe(true);
    expect(emitAlert).toHaveBeenCalledTimes(1);
    const [message, extra] = emitAlert.mock.calls[0] as [string, Record<string, unknown>];
    // The message must survive the beforeSend email scrub intact: no raw
    // principal in it (it would be mangled to [EMAIL] and destabilize review).
    expect(message).not.toContain('carson@arkova.ai');
    expect(message).toMatch(/batch-anchors/);
    expect(message).toMatch(/unexpected/i);
    // The acting identity is OPERATIONAL attribution data (operator /
    // service-account, not user PII) — carried in structured extra.
    const findings = extra.findings as Array<Record<string, unknown>>;
    expect(findings[0].actor_principal).toBe('carson@arkova.ai');
    expect(findings[0].job_id).toBe('batch-anchors');
    expect(findings[0].classification).toBe('unexpected-pause');
  });

  it('does not alert when every pause is sanctioned', async () => {
    const emitAlert = vi.fn();
    const result = await runSchedulerPauseAudit({
      manifest: [enabledFeeder],
      allowlist: [activeAllowlistEntry],
      stateSource: { listJobs: async () => [{ id: 'fetch-edgar', state: 'PAUSED' }] },
      actorSource: actorSourceReturning(null),
      emitAlert,
      nowMs: NOW,
    });
    expect(result.firing).toBe(false);
    expect(result.alertFired).toBe(false);
    expect(emitAlert).not.toHaveBeenCalled();
  });

  it('an EXPIRED-but-structurally-valid allowlist entry does NOT crash the runner — it completes and fires expired-sanction (review FIX 1: the rot scenario must page, not 500-loop)', async () => {
    const emitAlert = vi.fn();
    const result = await runSchedulerPauseAudit({
      manifest: [enabledFeeder],
      allowlist: [expiredAllowlistEntry],
      stateSource: { listJobs: async () => [{ id: 'fetch-edgar', state: 'PAUSED' }] },
      actorSource: actorSourceReturning({
        principal: 'carson@arkova.ai',
        pausedAt: '2026-05-02T09:14:00Z',
      }),
      emitAlert,
      nowMs: NOW,
    });
    expect(result.firing).toBe(true);
    expect(result.alertFired).toBe(true);
    expect(result.findings[0].classification).toBe('expired-sanction');
    expect(result.findings[0].actorPrincipal).toBe('carson@arkova.ai');
    expect(emitAlert).toHaveBeenCalledTimes(1);
  });

  it('an allowlist entry for a job NOT in the manifest is runner-fatal (typo = sanction silently never applies — review FIX 4)', async () => {
    await expect(
      runSchedulerPauseAudit({
        manifest: [enabledJob], // batch-anchors only
        allowlist: [activeAllowlistEntry], // covers fetch-edgar — not monitored here
        stateSource: { listJobs: async () => [] },
        actorSource: actorSourceReturning(null),
        emitAlert: vi.fn(),
        nowMs: NOW,
      }),
    ).rejects.toThrow(/monitored|unknown job/i);
  });

  it('throws on an invalid manifest or allowlist (config error → loud, not a green no-op)', async () => {
    await expect(
      runSchedulerPauseAudit({
        manifest: [enabledJob],
        allowlist: [{ ...activeAllowlistEntry, reason: '' }],
        stateSource: { listJobs: async () => [] },
        actorSource: actorSourceReturning(null),
        emitAlert: vi.fn(),
        nowMs: NOW,
      }),
    ).rejects.toThrow(/allowlist/i);
  });

  it('propagates a state-source failure (broken listing must 500 → Scheduler retry, not report healthy)', async () => {
    await expect(
      runSchedulerPauseAudit({
        manifest: [enabledJob],
        allowlist: [],
        stateSource: {
          listJobs: async () => {
            throw new Error('scheduler API 503');
          },
        },
        actorSource: actorSourceReturning(null),
        emitAlert: vi.fn(),
        nowMs: NOW,
      }),
    ).rejects.toThrow(/503/);
  });
});

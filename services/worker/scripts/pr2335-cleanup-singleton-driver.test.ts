import { describe, expect, it } from 'vitest';

import {
  CHANGED_BEHAVIOR,
  DEFAULT_ARGS,
  MIN_CONCURRENCY,
  NOT_MEASURED,
  PROD_PROJECT_REF,
  SQLSTATE_CHECK_VIOLATION,
  SQLSTATE_DEADLOCK,
  SQLSTATE_LOCK_NOT_AVAILABLE,
  classifyCall,
  computeCycleVerdict,
  counterSegment,
  evaluateDailyFlush,
  evaluatePerOrgIsolation,
  evaluateSoakSummary,
  evaluateTriggerA,
  evaluateTriggerB,
  isAppendOnlyGuardError,
  isDeadlockError,
  isLockNotAvailableError,
  isStagingLikeUrl,
  mergeCounts,
  orgLabel,
  parseArgs,
  parseCleanupResult,
  projectRefFromUrl,
  runSelfTest,
  seedTimestamps,
  summarizeVolley,
  validateLiveArgs,
  workPerformingResult,
  type CallRecord,
  type CleanupRpcResult,
  type PerOrgTableObservation,
  type RetentionTableObservation,
} from './pr2335-cleanup-singleton-driver';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WINNER: CleanupRpcResult = {
  success: true,
  skipped_concurrent_run: false,
  webhook_delivery_logs_deleted: 10,
  verification_events_deleted: 20,
  ai_usage_events_deleted: 30,
  audit_events_deleted: 40,
  audit_events_purge_skipped: false,
};

const LOSER: CleanupRpcResult = {
  success: true,
  skipped_concurrent_run: true,
  webhook_delivery_logs_deleted: NOT_MEASURED,
  verification_events_deleted: NOT_MEASURED,
  ai_usage_events_deleted: NOT_MEASURED,
  audit_events_deleted: NOT_MEASURED,
  audit_events_purge_skipped: true,
};

/** One winner plus `losers` skips, all overlapping in flight. */
function overlappingVolley(losers: number): CallRecord[] {
  const records: CallRecord[] = [
    { outcome: 'worked', dispatchedAtMs: 1_000, settledAtMs: 4_000, result: WINNER },
  ];
  for (let i = 0; i < losers; i += 1) {
    records.push({
      outcome: 'skipped',
      dispatchedAtMs: 1_001 + i,
      settledAtMs: 2_000 + i,
      result: LOSER,
    });
  }
  return records;
}

function liveArgs(overrides: Partial<Parameters<typeof validateLiveArgs>[0]> = {}) {
  return {
    ...DEFAULT_ARGS,
    mode: 'live' as const,
    targetUrl: 'https://arkova-worker-rig-staging-abc.a.run.app',
    admissionJson: '/tmp/admission.json',
    evidenceJsonl: '/tmp/evidence.jsonl',
    durationMin: 2880,
    keepMarginDays: 30,
    concurrency: 8,
    ...overrides,
  };
}

const GOOD_ENV = { supabaseUrl: 'https://rigref123456.supabase.co', serviceRoleKey: 'k' };

// ---------------------------------------------------------------------------

describe('pr2335-cleanup-singleton-driver — arguments', () => {
  it('defaults to self-test mode with a soak-shaped cadence', () => {
    expect(parseArgs([])).toEqual(DEFAULT_ARGS);
    expect(DEFAULT_ARGS.mode).toBe('self-test');
    expect(DEFAULT_ARGS.concurrency).toBeGreaterThanOrEqual(MIN_CONCURRENCY);
  });

  it('parses the full live invocation', () => {
    expect(
      parseArgs([
        '--mode', 'live',
        '--target-url', 'https://worker-staging.example',
        '--admission-json', '/tmp/admission.json',
        '--evidence-jsonl', '/tmp/evidence.jsonl',
        '--duration-min', '2880',
        '--interval-min', '30',
        '--concurrency', '8',
        '--seed-rows', '250',
        '--keep-margin-days', '45',
        '--org-a', 'org-a-id',
        '--org-b', 'org-b-id',
        '--webhook-endpoint-id', 'endpoint-id',
      ]),
    ).toEqual({
      mode: 'live',
      targetUrl: 'https://worker-staging.example',
      admissionJson: '/tmp/admission.json',
      evidenceJsonl: '/tmp/evidence.jsonl',
      durationMin: 2880,
      intervalMin: 30,
      concurrency: 8,
      seedRows: 250,
      keepMarginDays: 45,
      orgA: 'org-a-id',
      orgB: 'org-b-id',
      webhookEndpointId: 'endpoint-id',
    });
  });

  it('accepts the --self-test / --live shorthands', () => {
    expect(parseArgs(['--live']).mode).toBe('live');
    expect(parseArgs(['--self-test']).mode).toBe('self-test');
  });

  it('rejects unknown arguments, bad modes, and missing values', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown argument/);
    expect(() => parseArgs(['--mode', 'prod'])).toThrow(/Invalid --mode/);
    expect(() => parseArgs(['--target-url'])).toThrow(/Missing value/);
    expect(() => parseArgs(['--concurrency', '--live'])).toThrow(/Missing value/);
  });
});

describe('pr2335-cleanup-singleton-driver — live preconditions', () => {
  it('passes on a well-formed isolated-rig invocation', () => {
    expect(validateLiveArgs(liveArgs(), GOOD_ENV)).toEqual([]);
  });

  it('fails closed when credentials or evidence paths are missing', () => {
    const blockers = validateLiveArgs(
      { ...DEFAULT_ARGS, mode: 'live', concurrency: 8, keepMarginDays: 30 },
      {},
    );
    expect(blockers).toContain('missing SUPABASE_URL');
    expect(blockers).toContain('missing SUPABASE_SERVICE_ROLE_KEY');
    expect(blockers).toContain('missing --target-url');
    expect(blockers).toContain('missing --admission-json');
    expect(blockers).toContain('missing --evidence-jsonl');
  });

  it('hard-denies the production project ref — this driver writes and deletes', () => {
    const blockers = validateLiveArgs(liveArgs(), {
      supabaseUrl: `https://${PROD_PROJECT_REF}.supabase.co`,
      serviceRoleKey: 'k',
    });
    expect(blockers).toContain('refusing to run against the PRODUCTION Supabase project ref');
  });

  it('refuses a non-staging target URL (§1.11A)', () => {
    const blockers = validateLiveArgs(
      liveArgs({ targetUrl: 'https://arkova-worker-prod.a.run.app' }),
      GOOD_ENV,
    );
    expect(blockers).toContain(
      '--target-url is not a staging or localhost host (§1.11A isolated rigs only)',
    );
  });

  it('refuses a volley too small to reproduce the prod shape', () => {
    const blockers = validateLiveArgs(liveArgs({ concurrency: 2 }), GOOD_ENV);
    expect(blockers).toContain(`--concurrency must be at least ${MIN_CONCURRENCY} for Trigger A`);
  });

  it('refuses a keep-margin the soak would outlive — retained rows would age out mid-soak', () => {
    // 2880 minutes = 2 days of soak; a 2-day margin leaves no headroom, so the
    // driver would fail itself for a purge that was correct.
    const blockers = validateLiveArgs(liveArgs({ keepMarginDays: 2 }), GOOD_ENV);
    expect(blockers.some((entry) => entry.includes('--keep-margin-days'))).toBe(true);
    expect(validateLiveArgs(liveArgs({ keepMarginDays: 30 }), GOOD_ENV)).toEqual([]);
  });
});

describe('pr2335-cleanup-singleton-driver — URL and identifier hygiene', () => {
  it('extracts the project ref required as §1.11A evidence', () => {
    expect(projectRefFromUrl('https://rigref123456.supabase.co')).toBe('rigref123456');
    expect(projectRefFromUrl('not a url')).toBeUndefined();
  });

  it('recognises staging and local hosts only', () => {
    expect(isStagingLikeUrl('https://arkova-worker-x-staging-y.a.run.app')).toBe(true);
    expect(isStagingLikeUrl('http://localhost:8080')).toBe(true);
    expect(isStagingLikeUrl('https://arkova-worker.a.run.app')).toBe(false);
    expect(isStagingLikeUrl('garbage')).toBe(false);
  });

  it('labels organizations without ever carrying the raw id', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    const label = orgLabel(id);
    expect(label).toHaveLength(12);
    expect(label).toMatch(/^[0-9a-f]{12}$/);
    expect(label).not.toContain(id);
    expect(orgLabel(id)).toBe(label);
  });
});

describe('pr2335-cleanup-singleton-driver — error classification', () => {
  it('detects the 40P01 deadlock by SQLSTATE and by message', () => {
    expect(isDeadlockError({ code: SQLSTATE_DEADLOCK })).toBe(true);
    expect(isDeadlockError({ message: 'deadlock detected' })).toBe(true);
    expect(isDeadlockError({ code: '55P03', message: 'lock timeout' })).toBe(false);
  });

  it('detects 55P03 escaping the function', () => {
    expect(isLockNotAvailableError({ code: SQLSTATE_LOCK_NOT_AVAILABLE })).toBe(true);
    expect(
      isLockNotAvailableError({ message: 'canceling statement due to lock timeout' }),
    ).toBe(true);
    expect(isLockNotAvailableError({ code: SQLSTATE_DEADLOCK })).toBe(false);
  });

  it('recognises the append-only guard firing', () => {
    expect(isAppendOnlyGuardError({ code: SQLSTATE_CHECK_VIOLATION })).toBe(true);
    expect(
      isAppendOnlyGuardError({ message: 'Audit events are immutable. DELETE operations are not allowed.' }),
    ).toBe(true);
    expect(isAppendOnlyGuardError({ code: '42501', message: 'permission denied' })).toBe(false);
  });
});

describe('pr2335-cleanup-singleton-driver — 0417 return-shape contract', () => {
  it('accepts the documented 0417 shape', () => {
    expect(parseCleanupResult({ ...WINNER })).toEqual(WINNER);
    expect(parseCleanupResult({ ...LOSER })).toEqual(LOSER);
  });

  it('REJECTS the pre-0417 (0411) shape — a soak against the wrong definition is worse than none', () => {
    const zeroFourEleven = {
      success: true,
      webhook_delivery_logs_deleted: 0,
      verification_events_deleted: 0,
      ai_usage_events_deleted: 0,
      audit_events_deleted: NOT_MEASURED,
      audit_events_purge_skipped: true,
    };
    expect(parseCleanupResult(zeroFourEleven)).toBeNull();
  });

  it('rejects non-objects and non-numeric counts', () => {
    expect(parseCleanupResult(null)).toBeNull();
    expect(parseCleanupResult('ok')).toBeNull();
    expect(parseCleanupResult([WINNER])).toBeNull();
    expect(parseCleanupResult({ ...WINNER, audit_events_deleted: '40' })).toBeNull();
    expect(parseCleanupResult({ ...WINNER, skipped_concurrent_run: 'false' })).toBeNull();
  });

  it('classifies every outcome the volley can produce', () => {
    expect(classifyCall(WINNER, null)).toBe('worked');
    expect(classifyCall(LOSER, null)).toBe('skipped');
    expect(classifyCall(null, { code: SQLSTATE_DEADLOCK })).toBe('deadlock');
    expect(classifyCall(null, { code: SQLSTATE_LOCK_NOT_AVAILABLE })).toBe('lock_not_available');
    expect(classifyCall(null, { code: '42501' })).toBe('error');
    expect(classifyCall({ success: true }, null)).toBe('contract_violation');
  });
});

describe('pr2335-cleanup-singleton-driver — volley aggregation', () => {
  it('proves overlap from measured timestamps, not from assumption', () => {
    const overlapping = summarizeVolley(overlappingVolley(7));
    expect(overlapping.calls).toBe(8);
    expect(overlapping.worked).toBe(1);
    expect(overlapping.skipped).toBe(7);
    expect(overlapping.overlapConfirmed).toBe(true);
    expect(overlapping.dispatchSpreadMs).toBe(7);
  });

  it('does NOT confirm overlap for calls that merely ran back to back', () => {
    const sequential = summarizeVolley([
      { outcome: 'worked', dispatchedAtMs: 0, settledAtMs: 10 },
      { outcome: 'skipped', dispatchedAtMs: 50, settledAtMs: 60 },
    ]);
    expect(sequential.overlapConfirmed).toBe(false);
  });

  it('never confirms overlap for a single call', () => {
    expect(summarizeVolley([{ outcome: 'worked', dispatchedAtMs: 0, settledAtMs: 1 }]).overlapConfirmed)
      .toBe(false);
  });

  it('returns the work-performing result only when there is exactly one', () => {
    expect(workPerformingResult(overlappingVolley(5))).toEqual(WINNER);
    expect(
      workPerformingResult([
        { outcome: 'worked', dispatchedAtMs: 0, settledAtMs: 1, result: WINNER },
        { outcome: 'worked', dispatchedAtMs: 0, settledAtMs: 1, result: WINNER },
      ]),
    ).toBeNull();
    expect(workPerformingResult([])).toBeNull();
  });
});

describe('Trigger A — concurrency singleton', () => {
  const happy = () =>
    evaluateTriggerA({
      summary: summarizeVolley(overlappingVolley(7)),
      expectedCalls: 8,
      cleanupAuditRowsWritten: 1,
    });

  it('holds when exactly one of eight overlapping calls works and the rest skip', () => {
    const evaluated = happy();
    expect(evaluated.held).toBe(true);
    expect(evaluated.counts).toMatchObject({
      triggerAConcurrentCalls: 8,
      triggerAWorkPerformingRuns: 1,
      triggerASkippedConcurrentRuns: 7,
      triggerADeadlock40P01: 0,
      triggerAOverlapConfirmed: true,
      triggerACleanupAuditRowsWritten: 1,
      triggerASingletonHeld: true,
    });
  });

  it('FAILS on a single 40P01 — the defect under test is never a retry', () => {
    const evaluated = evaluateTriggerA({
      summary: summarizeVolley([
        { outcome: 'worked', dispatchedAtMs: 0, settledAtMs: 100, result: WINNER },
        { outcome: 'deadlock', dispatchedAtMs: 1, settledAtMs: 50, errorCode: SQLSTATE_DEADLOCK },
      ]),
      expectedCalls: 2,
      cleanupAuditRowsWritten: 1,
    });
    expect(evaluated.held).toBe(false);
    expect(evaluated.counts.triggerADeadlock40P01).toBe(1);
  });

  it('FAILS when two calls both did work — that is not a singleton', () => {
    const evaluated = evaluateTriggerA({
      summary: summarizeVolley([
        { outcome: 'worked', dispatchedAtMs: 0, settledAtMs: 100, result: WINNER },
        { outcome: 'worked', dispatchedAtMs: 1, settledAtMs: 100, result: WINNER },
      ]),
      expectedCalls: 2,
      cleanupAuditRowsWritten: 2,
    });
    expect(evaluated.held).toBe(false);
    expect(evaluated.counts.triggerAWorkPerformingRuns).toBe(2);
  });

  it('FAILS a green-looking volley that never actually overlapped', () => {
    const evaluated = evaluateTriggerA({
      summary: summarizeVolley([
        { outcome: 'worked', dispatchedAtMs: 0, settledAtMs: 10, result: WINNER },
        { outcome: 'skipped', dispatchedAtMs: 50, settledAtMs: 60, result: LOSER },
      ]),
      expectedCalls: 2,
      cleanupAuditRowsWritten: 1,
    });
    expect(evaluated.held).toBe(false);
    expect(evaluated.counts.triggerAOverlapConfirmed).toBe(false);
  });

  it('FAILS on duplicate DATA_RETENTION_CLEANUP rows — the other half of the defect', () => {
    expect(
      evaluateTriggerA({
        summary: summarizeVolley(overlappingVolley(7)),
        expectedCalls: 8,
        cleanupAuditRowsWritten: 2,
      }).held,
    ).toBe(false);
  });

  it('FAILS when a skip result does not carry 0417 keys (contract violation)', () => {
    const evaluated = evaluateTriggerA({
      summary: summarizeVolley([
        { outcome: 'worked', dispatchedAtMs: 0, settledAtMs: 100, result: WINNER },
        { outcome: 'contract_violation', dispatchedAtMs: 1, settledAtMs: 50 },
      ]),
      expectedCalls: 2,
      cleanupAuditRowsWritten: 1,
    });
    expect(evaluated.held).toBe(false);
    expect(evaluated.counts.triggerAResultContractViolations).toBe(1);
  });
});

describe('Trigger B — audit_events purge path', () => {
  const base = {
    appendOnlyGuardInstalledBefore: true,
    appendOnlyGuardInstalledAfter: true,
    result: WINNER,
    auditRowsRemovedObserved: 40,
    seededPastAuditRows: 40,
    seededPastAuditRowsRemaining: 0,
    lockNotAvailableEscaped: 0,
  };

  it('holds when the purge ran, the reported count matches, and the guard survived', () => {
    const evaluated = evaluateTriggerB(base);
    expect(evaluated.held).toBe(true);
    expect(evaluated.counts).toMatchObject({
      triggerBAppendOnlyGuardInstalledBefore: true,
      triggerBAppendOnlyGuardInstalledAfter: true,
      triggerBAuditPurgeSkipped: false,
      triggerBAuditDeletedReported: 40,
      triggerBAuditRowsRemovedObserved: 40,
      triggerBReportedMatchesObserved: true,
      triggerBAuditPurgeContractHeld: true,
    });
  });

  it('holds on a 55P03 skip that reports the -1 sentinel and leaves the old rows in place', () => {
    const evaluated = evaluateTriggerB({
      ...base,
      result: { ...WINNER, audit_events_purge_skipped: true, audit_events_deleted: NOT_MEASURED },
      auditRowsRemovedObserved: 0,
      seededPastAuditRowsRemaining: 40,
    });
    expect(evaluated.held).toBe(true);
    expect(evaluated.counts.triggerBSentinelContractHeld).toBe(true);
  });

  it('FAILS a skip that reports 0 instead of -1 — 0 falsely asserts an empty purge', () => {
    const evaluated = evaluateTriggerB({
      ...base,
      result: { ...WINNER, audit_events_purge_skipped: true, audit_events_deleted: 0 },
      auditRowsRemovedObserved: 0,
      seededPastAuditRowsRemaining: 40,
    });
    expect(evaluated.held).toBe(false);
    expect(evaluated.counts.triggerBSentinelContractHeld).toBe(false);
  });

  it('FAILS if reject_audit_delete is not installed before the run', () => {
    expect(evaluateTriggerB({ ...base, appendOnlyGuardInstalledBefore: false }).held).toBe(false);
  });

  it('FAILS if the run leaves reject_audit_delete off — 0411 must restore it on rollback', () => {
    const evaluated = evaluateTriggerB({ ...base, appendOnlyGuardInstalledAfter: false });
    expect(evaluated.held).toBe(false);
    expect(evaluated.counts.triggerBAppendOnlyGuardInstalledAfter).toBe(false);
  });

  it('FAILS when the reported count does not match what actually left the table', () => {
    const evaluated = evaluateTriggerB({ ...base, auditRowsRemovedObserved: 39 });
    expect(evaluated.held).toBe(false);
    expect(evaluated.counts.triggerBReportedMatchesObserved).toBe(false);
  });

  it('FAILS when 55P03 escapes the function instead of being handled', () => {
    expect(evaluateTriggerB({ ...base, lockNotAvailableEscaped: 1 }).held).toBe(false);
  });

  it('FAILS when past-boundary rows survive a purge that claims it ran', () => {
    expect(evaluateTriggerB({ ...base, seededPastAuditRowsRemaining: 5 }).held).toBe(false);
  });

  it('FAILS when the volley produced no single work-performing run to inspect', () => {
    expect(evaluateTriggerB({ ...base, result: null }).held).toBe(false);
  });
});

describe('Daily flush observation', () => {
  function table(overrides: Partial<RetentionTableObservation> = {}): RetentionTableObservation {
    return {
      table: 'verification_events',
      reportedDeleted: 100,
      observedRemoved: 100,
      seededPast: 100,
      seededPastRemaining: 0,
      seededKeep: 100,
      seededKeepRemaining: 100,
      ...overrides,
    };
  }

  const base = {
    elapsedHours: 26,
    cyclesCompleted: 52,
    retentionRunsObserved: 52,
    auditPurgeSkipped: false,
    requiredWindowHours: 24,
  };

  it('builds a counter name per table', () => {
    expect(counterSegment('ai_usage_events')).toBe('AiUsageEvents');
    expect(counterSegment('webhook_delivery_logs')).toBe('WebhookDeliveryLogs');
    expect(counterSegment('audit_events')).toBe('AuditEvents');
  });

  it('holds when only past-boundary rows went and the counts match', () => {
    const evaluated = evaluateDailyFlush({
      ...base,
      tables: [table(), table({ table: 'ai_usage_events' })],
    });
    expect(evaluated.held).toBe(true);
    expect(evaluated.counts).toMatchObject({
      dailyFlushVerificationEventsDeletedReported: 100,
      dailyFlushVerificationEventsRowsRemovedObserved: 100,
      dailyFlushAiUsageEventsPastBoundaryRemaining: 0,
      dailyFlushAiUsageEventsInsideBoundaryRemoved: 0,
      dailyFlushPastBoundaryRowsRemaining: 0,
      dailyFlushInsideBoundaryRowsRemoved: 0,
      dailyFlushReportedVsObservedMismatches: 0,
      dailyFlushWindowSatisfied: true,
      dailyFlushObservationHeld: true,
    });
  });

  it('FAILS when a row inside its retention boundary was removed', () => {
    const evaluated = evaluateDailyFlush({
      ...base,
      tables: [table({ seededKeepRemaining: 99 })],
    });
    expect(evaluated.held).toBe(false);
    expect(evaluated.counts.dailyFlushInsideBoundaryRowsRemoved).toBe(1);
  });

  it('FAILS when a past-boundary row survived', () => {
    const evaluated = evaluateDailyFlush({ ...base, tables: [table({ seededPastRemaining: 3 })] });
    expect(evaluated.held).toBe(false);
    expect(evaluated.counts.dailyFlushPastBoundaryRowsRemaining).toBe(3);
  });

  it('FAILS when the reported count disagrees with what disappeared', () => {
    const evaluated = evaluateDailyFlush({ ...base, tables: [table({ observedRemoved: 97 })] });
    expect(evaluated.held).toBe(false);
    expect(evaluated.counts.dailyFlushReportedVsObservedMismatches).toBe(1);
  });

  it('does not hold a 55P03 sentinel against audit_events — 0411 behaving correctly is not a failure', () => {
    const evaluated = evaluateDailyFlush({
      ...base,
      auditPurgeSkipped: true,
      tables: [
        table(),
        table({
          table: 'audit_events',
          reportedDeleted: NOT_MEASURED,
          observedRemoved: 0,
          seededPastRemaining: 100,
        }),
      ],
    });
    expect(evaluated.held).toBe(true);
    expect(evaluated.counts.dailyFlushReportedVsObservedMismatches).toBe(0);
    // The raw observation is still reported, unmassaged.
    expect(evaluated.counts.dailyFlushAuditEventsPastBoundaryRemaining).toBe(100);
  });

  it('reports the 24h window without letting a single early cycle fail on it', () => {
    const early = evaluateDailyFlush({ ...base, elapsedHours: 0.5, tables: [table()] });
    expect(early.counts.dailyFlushWindowSatisfied).toBe(false);
    expect(early.held).toBe(true);
  });

  it('FAILS when no table was observed at all', () => {
    expect(evaluateDailyFlush({ ...base, tables: [] }).held).toBe(false);
  });
});

describe('Per-org isolation', () => {
  function orgRows(overrides: Partial<PerOrgTableObservation> = {}): PerOrgTableObservation[] {
    return [
      { table: 'verification_events', pastSeeded: 50, pastRemaining: 0, keepSeeded: 50, keepRemaining: 50, ...overrides },
      { table: 'ai_usage_events', pastSeeded: 50, pastRemaining: 0, keepSeeded: 50, keepRemaining: 50 },
    ];
  }

  const reported = { verification_events: 100, ai_usage_events: 100 };

  it('holds when each org lost only its aged rows and kept everything else', () => {
    const evaluated = evaluatePerOrgIsolation({
      orgA: orgRows(),
      orgB: orgRows(),
      reportedDeletedByTable: reported,
      sentinelTables: [],
    });
    expect(evaluated.held).toBe(true);
    expect(evaluated.counts).toMatchObject({
      perOrgOrgsSeeded: 2,
      perOrgTablesObserved: 2,
      perOrgOrgAPastRowsRemoved: 100,
      perOrgOrgBPastRowsRemoved: 100,
      perOrgCrossOrgKeepRowsRemoved: 0,
      perOrgUnattributedDeletedRows: 0,
      perOrgIsolationHeld: true,
      perOrgVerificationEventsOrgAPastRemoved: 50,
      perOrgVerificationEventsOrgBKeepRemoved: 0,
    });
  });

  it('FAILS when one org’s retained rows disappear while the other org is purged', () => {
    const evaluated = evaluatePerOrgIsolation({
      orgA: orgRows(),
      orgB: orgRows({ keepRemaining: 49 }),
      reportedDeletedByTable: reported,
      sentinelTables: [],
    });
    expect(evaluated.held).toBe(false);
    expect(evaluated.counts.perOrgCrossOrgKeepRowsRemoved).toBe(1);
  });

  it('FAILS when the reported count cannot be attributed to the seeded orgs', () => {
    const evaluated = evaluatePerOrgIsolation({
      orgA: orgRows(),
      orgB: orgRows(),
      reportedDeletedByTable: { verification_events: 137, ai_usage_events: 100 },
      sentinelTables: [],
    });
    expect(evaluated.held).toBe(false);
    expect(evaluated.counts.perOrgUnattributedDeletedRows).toBe(37);
  });

  it('exempts a sentinel-reporting table from attribution rather than inventing a mismatch', () => {
    const evaluated = evaluatePerOrgIsolation({
      orgA: [{ table: 'audit_events', pastSeeded: 50, pastRemaining: 50, keepSeeded: 50, keepRemaining: 50 }],
      orgB: [{ table: 'audit_events', pastSeeded: 50, pastRemaining: 50, keepSeeded: 50, keepRemaining: 50 }],
      reportedDeletedByTable: { audit_events: NOT_MEASURED },
      sentinelTables: ['audit_events'],
    });
    expect(evaluated.held).toBe(true);
    expect(evaluated.counts.perOrgUnattributedDeletedRows).toBe(0);
  });

  it('FAILS when nothing was seeded — an empty isolation check proves nothing', () => {
    expect(
      evaluatePerOrgIsolation({
        orgA: [],
        orgB: [],
        reportedDeletedByTable: {},
        sentinelTables: [],
      }).held,
    ).toBe(false);
  });
});

describe('Verdict, summary, and seed timing', () => {
  const held = { held: true, counts: {} };
  const broken = { held: false, counts: {} };

  it('requires all four requirements AND a healthy rig worker', () => {
    expect(
      computeCycleVerdict({
        triggerA: held,
        triggerB: held,
        dailyFlush: held,
        perOrg: held,
        rigWorkerHealthy: true,
      }),
    ).toBe('pass');
    for (const key of ['triggerA', 'triggerB', 'dailyFlush', 'perOrg'] as const) {
      const input = {
        triggerA: held,
        triggerB: held,
        dailyFlush: held,
        perOrg: held,
        rigWorkerHealthy: true,
      };
      expect(computeCycleVerdict({ ...input, [key]: broken })).toBe('fail');
    }
    expect(
      computeCycleVerdict({
        triggerA: held,
        triggerB: held,
        dailyFlush: held,
        perOrg: held,
        rigWorkerHealthy: false,
      }),
    ).toBe('fail');
  });

  it('merges counter maps without losing keys', () => {
    expect(mergeCounts({ a: 1 }, { b: true }, { a: 2 })).toEqual({ a: 2, b: true });
  });

  const summaryBase = {
    cyclesCompleted: 96,
    cyclesPassed: 96,
    elapsedHours: 48,
    requiredWindowHours: 24,
    totalDeadlocks: 0,
    totalConcurrentCalls: 768,
    totalSkippedConcurrentRuns: 672,
    totalWorkPerformingRuns: 96,
    totalContractViolations: 0,
    appendOnlyGuardEverMissing: false,
  };

  it('holds a clean 48h run', () => {
    const evaluated = evaluateSoakSummary(summaryBase);
    expect(evaluated.held).toBe(true);
    expect(evaluated.counts).toMatchObject({
      soakCyclesCompleted: 96,
      soakCyclesPassed: 96,
      triggerADeadlock40P01: 0,
      dailyFlushWindowSatisfied: true,
      soakVerdictHeld: true,
    });
  });

  it('FAILS a run that never reached the observation window', () => {
    const evaluated = evaluateSoakSummary({ ...summaryBase, elapsedHours: 3 });
    expect(evaluated.held).toBe(false);
    expect(evaluated.counts.dailyFlushWindowSatisfied).toBe(false);
  });

  it('FAILS a run with one deadlock, one failed cycle, or a dropped guard', () => {
    expect(evaluateSoakSummary({ ...summaryBase, totalDeadlocks: 1 }).held).toBe(false);
    expect(evaluateSoakSummary({ ...summaryBase, cyclesPassed: 95 }).held).toBe(false);
    expect(evaluateSoakSummary({ ...summaryBase, appendOnlyGuardEverMissing: true }).held).toBe(false);
    expect(evaluateSoakSummary({ ...summaryBase, totalContractViolations: 1 }).held).toBe(false);
    expect(evaluateSoakSummary({ ...summaryBase, cyclesCompleted: 0, cyclesPassed: 0 }).held).toBe(false);
  });

  it('places seeded rows clear of the boundary on both sides', () => {
    const now = Date.UTC(2026, 7, 29);
    const stamps = seedTimestamps(now, 730, 30);
    const day = 24 * 60 * 60 * 1000;
    expect(Date.parse(stamps.pastIso)).toBe(now - 760 * day);
    expect(Date.parse(stamps.keepIso)).toBe(now - 700 * day);
    expect(Date.parse(stamps.pastIso)).toBeLessThan(now - 730 * day);
    expect(Date.parse(stamps.keepIso)).toBeGreaterThan(now - 730 * day);
  });
});

describe('self-test mode', () => {
  const row = runSelfTest();

  it('is explicitly NOT soak evidence', () => {
    expect(row.mode).toBe('self-test');
    expect(row.evidenceForSoak).toBe(false);
  });

  it('passes, and names the behavior 0417 actually changed', () => {
    expect(row.status).toBe('pass');
    expect(row.pr).toBe(2335);
    expect(row.tier).toBe('T3');
    expect(row.changedBehavior).toBe(CHANGED_BEHAVIOR);
    expect(row.changedBehavior).toMatch(/pg_try_advisory_xact_lock\(8675309, 2\)/);
    expect(row.changedBehavior).toMatch(/skipped_concurrent_run/);
  });

  it('emits a counter for each of the four T3 evidence requirements', () => {
    expect(row.counts.triggerASingletonHeld).toBe(true);
    expect(row.counts.triggerBAuditPurgeContractHeld).toBe(true);
    expect(row.counts.dailyFlushObservationHeld).toBe(true);
    expect(row.counts.perOrgIsolationHeld).toBe(true);
  });

  it('proves its own helpers can fail — negative controls, not a tautology', () => {
    expect(row.counts.selfTestDeadlockRejected).toBe(true);
    expect(row.counts.selfTestSequentialVolleyRejected).toBe(true);
    expect(row.counts.selfTestDuplicateAuditRowRejected).toBe(true);
    expect(row.counts.selfTestZeroInsteadOfSentinelRejected).toBe(true);
    expect(row.counts.selfTestDroppedGuardRejected).toBe(true);
    expect(row.counts.selfTestCrossOrgDeletionRejected).toBe(true);
    expect(row.counts.selfTestPre0417ShapeRejected).toBe(true);
  });

  it('emits nothing that could be a secret, a connection string, or an org id', () => {
    const serialized = JSON.stringify(row);
    expect(serialized).not.toMatch(/supabase\.co/);
    expect(serialized).not.toMatch(/SERVICE_ROLE/i);
    expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(serialized).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});

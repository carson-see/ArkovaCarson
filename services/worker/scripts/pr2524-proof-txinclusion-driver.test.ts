import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  PROD_SUPABASE_REF,
  SHARED_STAGING_SUPABASE_REF,
  POSTGREST_CHUNK_CAP_FOR_TESTS,
  evaluateChunkBoundary,
  evaluateCoherence,
  evaluateFoldGuard,
  evaluateSweep,
  healthyTickSequence,
  hollowTickSequence,
  isDeniedTarget,
  cloudRunServiceFromHost,
  assertUuids,
  merkleRootFromHeaderHex,
  parseArgs,
  pinnedTickSequence,
  runDriver,
  runSelfTest,
  supabaseRefFromUrl,
  validateLiveArgs,
  withinDeclaredWindow,
  type AssertionResult,
  type TickObservation,
} from './pr2524-proof-txinclusion-driver';

const ok = (list: AssertionResult[], id: string): boolean =>
  list.find((a) => a.id === id)?.ok === true;

const tick = (o: Partial<TickObservation> & { tick: number }): TickObservation => ({
  httpOk: true,
  httpStatus: 200,
  skipped: false,
  scanned: 0,
  txAttempted: 0,
  txConfirmed: 0,
  txPending: 0,
  txStale: 0,
  anchorsUpdated: 0,
  anchorsMissing: 0,
  anchorsBlockMismatch: 0,
  ...o,
});

const uuid = (n: number) => `5eed2524-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ids = (n: number) => Array.from({ length: n }, (_, i) => uuid(i));

describe('pr2524-proof-txinclusion-driver — CLI contract', () => {
  it('defaults to local self-test mode', () => {
    expect(parseArgs([])).toEqual({ mode: 'self-test' });
  });

  it('parses live admission arguments', () => {
    expect(
      parseArgs([
        '--live',
        '--target-url', 'https://worker.example',
        '--admission-json', '/tmp/admission.json',
        '--evidence-jsonl', '/tmp/evidence.jsonl',
        '--cron-secret', 'secret',
        '--supabase-url', 'https://abcdefghijklmnopqrst.supabase.co',
        '--supabase-service-key', 'key',
        '--rpc-url', 'https://rpc.example/token',
        '--run-id', 'run-1',
        '--max-ticks', '6',
        '--no-rearm',
      ]),
    ).toEqual({
      mode: 'live',
      targetUrl: 'https://worker.example',
      admissionJson: '/tmp/admission.json',
      evidenceJsonl: '/tmp/evidence.jsonl',
      cronSecret: 'secret',
      supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
      supabaseServiceKey: 'key',
      rpcUrl: 'https://rpc.example/token',
      runId: 'run-1',
      maxTicks: 6,
      rearm: false,
    });
  });

  it('rejects an unknown argument rather than silently ignoring it', () => {
    expect(() => parseArgs(['--not-a-flag'])).toThrow(/Unknown argument/);
  });

  it('live mode fails closed when admission inputs are missing', async () => {
    const row = await runDriver({ mode: 'live' });
    expect(row.status).toBe('fail');
    expect(row.evidenceForSoak).toBe(false);
    expect(row.blockers).toEqual([
      'missing --target-url',
      'missing --admission-json',
      'missing --evidence-jsonl',
      'missing --cron-secret or --bearer-token',
      'missing --supabase-url (or RIG_SUPABASE_URL)',
      'missing --supabase-service-key (or RIG_SUPABASE_SERVICE_ROLE_KEY)',
      'missing --rpc-url (or RIG_BITCOIN_RPC_URL) — the B0 fold guard requires real gettxoutproof responses, not fixtures',
    ]);
  });

  it('requires RPC access in live mode — the fold guard may not run on fixtures', () => {
    const blockers = validateLiveArgs({
      mode: 'live',
      targetUrl: 'https://rig.example',
      admissionJson: '/tmp/a.json',
      evidenceJsonl: '/tmp/e.jsonl',
      cronSecret: 's',
      supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
      supabaseServiceKey: 'k',
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/--rpc-url/);
  });
});

describe('K3 — prod and shared-staging hard deny', () => {
  it('extracts a Supabase project ref from a project URL', () => {
    expect(supabaseRefFromUrl(`https://${PROD_SUPABASE_REF}.supabase.co`)).toBe(PROD_SUPABASE_REF);
    expect(supabaseRefFromUrl('https://db.example.com')).toBeNull();
    expect(supabaseRefFromUrl(undefined)).toBeNull();
  });

  it('denies the production Supabase ref', () => {
    const blockers = isDeniedTarget({ supabaseUrl: `https://${PROD_SUPABASE_REF}.supabase.co` });
    expect(blockers.join(' ')).toMatch(/PRODUCTION/);
  });

  it('denies the shared standing-staging ref (not isolated ⇒ not T3 evidence)', () => {
    const blockers = isDeniedTarget({
      supabaseUrl: `https://${SHARED_STAGING_SUPABASE_REF}.supabase.co`,
    });
    expect(blockers.join(' ')).toMatch(/SHARED staging/);
  });

  it('recovers the Cloud Run service name from both URL shapes', () => {
    expect(cloudRunServiceFromHost('arkova-worker-staging-abc123-uc.a.run.app')).toBe('arkova-worker-staging');
    expect(cloudRunServiceFromHost('arkova-worker-abc123-uc.a.run.app')).toBe('arkova-worker');
    expect(cloudRunServiceFromHost('arkova-worker-pr2524-staging-abc123-uc.a.run.app')).toBe(
      'arkova-worker-pr2524-staging',
    );
    expect(cloudRunServiceFromHost('arkova-worker-staging-abc123.us-central1.run.app')).toBe(
      'arkova-worker-staging',
    );
    expect(cloudRunServiceFromHost('rig.example.com')).toBeNull();
  });

  it('denies the shared Cloud Run worker services by EXACT service name, not by prefix', () => {
    // A prefix test double-counts here (`arkova-worker-staging-…` starts with
    // both denied names) and, worse, refuses legitimate isolated rigs.
    expect(isDeniedTarget({ targetUrl: 'https://arkova-worker-abc123-uc.a.run.app' })).toHaveLength(1);
    expect(
      isDeniedTarget({ targetUrl: 'https://arkova-worker-staging-abc123-uc.a.run.app' }),
    ).toHaveLength(1);
  });

  it('refuses a run.app host whose service name cannot be recovered', () => {
    expect(isDeniedTarget({ targetUrl: 'https://something.run.app' }).join(' ')).toMatch(
      /cannot be recovered/,
    );
  });

  it('denies production Arkova hosts, apex and subdomains', () => {
    expect(isDeniedTarget({ targetUrl: 'https://api.arkova.ai' })).toHaveLength(1);
    expect(isDeniedTarget({ targetUrl: 'https://edge.arkova.ai' })).toHaveLength(1);
    expect(isDeniedTarget({ targetUrl: 'https://arkova.ai' })).toHaveLength(1);
  });

  it('refuses a Supabase URL whose ref cannot be identified, rather than assuming it is safe', () => {
    const blockers = isDeniedTarget({ supabaseUrl: 'https://internal-db.corp.example' });
    expect(blockers.join(' ')).toMatch(/cannot be deny-checked/);
  });

  it('allows an isolated rig', () => {
    expect(
      isDeniedTarget({
        supabaseUrl: 'https://abcdefghijklmnopqrst.supabase.co',
        targetUrl: 'https://arkova-worker-pr2524-staging-abc123-uc.a.run.app',
      }),
    ).toEqual([]);
  });
});

describe('filter-value hygiene — ids that reach a PostgREST .in()', () => {
  it('accepts canonical uuids', () => {
    expect(assertUuids([uuid(1), uuid(2)], 'test')).toEqual([uuid(1), uuid(2)]);
  });

  it('refuses a value that could restructure the filter', () => {
    // `,` and `)` are the filter's own syntax; a value carrying either would
    // silently change what the request selects (or patches) rather than fail.
    expect(() => assertUuids(['5eed2524-0000-4000-8000-000000000001),foo'], 'test')).toThrow(
      /not canonical uuids/,
    );
    expect(() => assertUuids([''], 'test')).toThrow(/not canonical uuids/);
    expect(() => assertUuids(['../../etc/passwd'], 'test')).toThrow(/not canonical uuids/);
  });

  it('names the context so the failure says which call site refused', () => {
    expect(() => assertUuids(['nope'], 'fixture re-arm')).toThrow(/^fixture re-arm:/);
  });
});

describe('K4 — cycle rows are bounded to the declared soak window', () => {
  const window = { start: '2026-09-01T00:00:00Z', end: '2026-09-03T00:00:00Z' };

  it('accepts a cycle inside the window', () => {
    expect(withinDeclaredWindow('2026-09-02T12:00:00Z', window)).toBe(true);
  });

  it('rejects a cycle after the window closed', () => {
    expect(withinDeclaredWindow('2026-09-04T12:00:00Z', window)).toBe(false);
  });

  it('rejects a cycle before the window opened', () => {
    expect(withinDeclaredWindow('2026-08-31T23:59:59Z', window)).toBe(false);
  });

  it('refuses to claim window membership when no window was declared', () => {
    expect(withinDeclaredWindow('2026-09-02T12:00:00Z', { start: null, end: null })).toBe(false);
  });

  it('rejects an unparseable timestamp', () => {
    expect(withinDeclaredWindow('not-a-date', window)).toBe(false);
  });
});

describe('A1/A2/A3 — the sweep assertions DISCRIMINATE the broken build', () => {
  it('passes every sweep assertion on a healthy fixed-build cycle', () => {
    const results = evaluateSweep(healthyTickSequence());
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('FAILS A1 on the 22P02 all-zero response (the H1 signature)', () => {
    const results = evaluateSweep(hollowTickSequence());
    expect(ok(results, 'A1_scan_not_hollow')).toBe(false);
    expect(results.find((r) => r.id === 'A1_scan_not_hollow')!.detail).toMatch(/22P02/);
  });

  it('FAILS A2 and A3 on the pre-H1 build that re-returns the same page', () => {
    const results = evaluateSweep(pinnedTickSequence());
    // Its FIRST tick looks perfectly healthy — which is exactly why A1 alone is
    // not enough and the wedge marker exists.
    expect(ok(results, 'A1_scan_not_hollow')).toBe(true);
    expect(ok(results, 'A2_sweep_advances')).toBe(false);
    expect(ok(results, 'A3_sweep_wraps')).toBe(false);
  });

  it('FAILS A1 when the rig answers skipped=true (mock mode / anchoring off)', () => {
    const results = evaluateSweep([tick({ tick: 0, skipped: true, scanned: 0 })]);
    expect(ok(results, 'A1_scan_not_hollow')).toBe(false);
    expect(results.find((r) => r.id === 'A1_scan_not_hollow')!.detail).toMatch(/mock mode/);
  });

  it('FAILS A1 when rows were scanned but nothing was written', () => {
    const results = evaluateSweep([tick({ tick: 0, scanned: 2000, anchorsUpdated: 0, anchorsBlockMismatch: 120 })]);
    expect(ok(results, 'A1_scan_not_hollow')).toBe(false);
  });

  it('FAILS A1 on a non-2xx cron response', () => {
    const results = evaluateSweep([tick({ tick: 0, httpOk: false, httpStatus: 500 })]);
    expect(ok(results, 'A1_scan_not_hollow')).toBe(false);
  });

  it('FAILS A2 when the wedge is absent, rather than passing on a blind cycle', () => {
    // No wedge in the first page ⇒ nothing marks the head of the keyspace ⇒ the
    // cycle cannot tell advance from re-returning the same page, and must say so.
    const results = evaluateSweep([
      tick({ tick: 0, scanned: 2000, anchorsUpdated: 2000 }),
      tick({ tick: 1, scanned: 1000, anchorsUpdated: 1000 }),
      tick({ tick: 2, scanned: 0 }),
      tick({ tick: 3, scanned: 0 }),
    ]);
    expect(ok(results, 'A2_sweep_advances')).toBe(false);
    expect(results.find((r) => r.id === 'A2_sweep_advances')!.detail).toMatch(/wedge cohort was not in the first page/);
  });

  it('FAILS A3 when the sweep never reaches an empty page within the tick budget', () => {
    const results = evaluateSweep([
      tick({ tick: 0, scanned: 2000, anchorsUpdated: 1880, anchorsBlockMismatch: 120 }),
      tick({ tick: 1, scanned: 2000, anchorsUpdated: 2000 }),
    ]);
    expect(ok(results, 'A2_sweep_advances')).toBe(true);
    expect(ok(results, 'A3_sweep_wraps')).toBe(false);
  });

  it('FAILS A3 when the wrap happens but the cursor does not restart at the head', () => {
    const results = evaluateSweep([
      tick({ tick: 0, scanned: 2000, anchorsUpdated: 1880, anchorsBlockMismatch: 120 }),
      tick({ tick: 1, scanned: 1000, anchorsUpdated: 1000 }),
      tick({ tick: 2, scanned: 0 }),
      tick({ tick: 3, scanned: 0 }),
    ]);
    expect(ok(results, 'A3_sweep_wraps')).toBe(false);
  });

  it('FAILS every sweep assertion when no tick ran at all', () => {
    const results = evaluateSweep([]);
    expect(results.every((r) => !r.ok)).toBe(true);
  });
});

describe('A4 — the batched write crossed the .in() chunk boundary', () => {
  it('passes when >200 rows share one payload, split into >=2 chunks, all populated', () => {
    const result = evaluateChunkBoundary({
      cohortSize: 450,
      populatedAnchorIds: ids(450),
      distinctPayloads: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/3 chunks/);
  });

  it('FAILS at or below the chunk cap — no boundary was crossed', () => {
    const result = evaluateChunkBoundary({
      cohortSize: POSTGREST_CHUNK_CAP_FOR_TESTS,
      populatedAnchorIds: ids(POSTGREST_CHUNK_CAP_FOR_TESTS),
      distinctPayloads: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/chunk cap/);
  });

  it('FAILS when a chunk was dropped (fewer rows populated than the cohort holds)', () => {
    const result = evaluateChunkBoundary({
      cohortSize: 450,
      populatedAnchorIds: ids(250),
      distinctPayloads: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/chunk was dropped/);
  });

  it('FAILS when the cohort does not share ONE payload — the row count is then not the .in() width', () => {
    const result = evaluateChunkBoundary({
      cohortSize: 450,
      populatedAnchorIds: ids(450),
      distinctPayloads: 2,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/distinct payloads/);
  });
});

describe('A5/A6 — the B0 fold guard', () => {
  it('passes when a real single-txid proof parses and folds to the header merkleroot', () => {
    const results = evaluateFoldGuard({
      singleTxParsed: true,
      singleTxBranchLength: 12,
      singleTxFoldsToHeaderRoot: true,
      multiTxTargetsTried: 2,
      multiTxRejected: 2,
    });
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('FAILS A5 when the emitted branch does not fold to the header merkleroot', () => {
    const results = evaluateFoldGuard({
      singleTxParsed: true,
      singleTxBranchLength: 13,
      singleTxFoldsToHeaderRoot: false,
      multiTxTargetsTried: 2,
      multiTxRejected: 2,
    });
    expect(ok(results, 'A5_fold_guard_emits_verifiable_branch')).toBe(false);
  });

  it('FAILS A6 when a multi-match proof is NOT rejected — the class B0 exists for', () => {
    const results = evaluateFoldGuard({
      singleTxParsed: true,
      singleTxBranchLength: 12,
      singleTxFoldsToHeaderRoot: true,
      multiTxTargetsTried: 2,
      multiTxRejected: 1,
    });
    expect(ok(results, 'A6_fold_guard_rejects_multi_match')).toBe(false);
  });

  it('FAILS A6 when the negative control never ran', () => {
    const results = evaluateFoldGuard({
      singleTxParsed: true,
      singleTxBranchLength: 12,
      singleTxFoldsToHeaderRoot: true,
      multiTxTargetsTried: 0,
      multiTxRejected: 0,
    });
    expect(ok(results, 'A6_fold_guard_rejects_multi_match')).toBe(false);
    expect(results.find((r) => r.id === 'A6_fold_guard_rejects_multi_match')!.detail).toMatch(
      /negative control did not run/,
    );
  });

  it('FAILS both when the chain step could not run at all — never silently skipped', () => {
    const results = evaluateFoldGuard({
      singleTxParsed: false,
      singleTxBranchLength: null,
      singleTxFoldsToHeaderRoot: false,
      multiTxTargetsTried: 0,
      multiTxRejected: 0,
      error: 'RPC getblockheader failed: HTTP 502',
    });
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results[0].detail).toMatch(/did not run/);
  });

  it('reads the merkleroot out of a raw 80-byte header, byte-reversed', () => {
    // Bytes [36,68) of the header are the merkleroot in internal LE; display hex
    // is that value reversed.
    const header =
      '00'.repeat(36) + 'aabbccdd' + '00'.repeat(28) + '11'.repeat(12);
    expect(header).toHaveLength(160);
    const root = merkleRootFromHeaderHex(header);
    expect(root).toBe('00'.repeat(28) + 'ddccbbaa');
  });

  it('refuses a header that is not exactly 80 bytes', () => {
    expect(merkleRootFromHeaderHex('abcd')).toBeNull();
    expect(merkleRootFromHeaderHex('zz'.repeat(80))).toBeNull();
  });
});

describe('A7/A8/A9 — read/write coherence and the /proof surface', () => {
  const branch = [{ hash: 'a'.repeat(64), position: 'right' as const }];

  it('passes when the stored pair is published unchanged and folds to the published header', () => {
    const results = evaluateCoherence({
      httpStatus: 200,
      dbBranch: branch,
      dbIndex: 0,
      publishedBranch: branch,
      publishedIndex: 0,
      publishedFoldsToHeaderRoot: true,
      bundlePresent: true,
    });
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('FAILS A7 when the reader rejects a pair the writer accepted', () => {
    const results = evaluateCoherence({
      httpStatus: 200,
      dbBranch: branch,
      dbIndex: 0,
      publishedBranch: null,
      publishedIndex: null,
      publishedFoldsToHeaderRoot: false,
      bundlePresent: true,
    });
    expect(ok(results, 'A7_read_write_coherent')).toBe(false);
    expect(results.find((r) => r.id === 'A7_read_write_coherent')!.detail).toMatch(
      /reader rejected what the writer accepted/,
    );
  });

  it('FAILS A7 when the published index disagrees with the stored one', () => {
    const results = evaluateCoherence({
      httpStatus: 200,
      dbBranch: branch,
      dbIndex: 0,
      publishedBranch: branch,
      publishedIndex: 3,
      publishedFoldsToHeaderRoot: true,
      bundlePresent: true,
    });
    expect(ok(results, 'A7_read_write_coherent')).toBe(false);
  });

  it('FAILS A8 when the published branch does not fold to the published header', () => {
    const results = evaluateCoherence({
      httpStatus: 200,
      dbBranch: branch,
      dbIndex: 0,
      publishedBranch: branch,
      publishedIndex: 0,
      publishedFoldsToHeaderRoot: false,
      bundlePresent: true,
    });
    expect(ok(results, 'A8_proof_publishes_verifiable_inclusion')).toBe(false);
  });

  it('FAILS A9 on a NO_BATCH_PROOF 404 for an anchor that HAS a proof row (the B2 class)', () => {
    const results = evaluateCoherence({
      httpStatus: 404,
      errorCode: 'NO_BATCH_PROOF',
      dbBranch: branch,
      dbIndex: 0,
      publishedBranch: null,
      publishedIndex: null,
      publishedFoldsToHeaderRoot: false,
      bundlePresent: false,
    });
    expect(ok(results, 'A9_no_false_back_catalogue_404')).toBe(false);
  });

  it('treats a 500 as honest-but-unserved: A9 fails, and it is not confused with a 404', () => {
    const results = evaluateCoherence({
      httpStatus: 500,
      dbBranch: branch,
      dbIndex: 0,
      publishedBranch: null,
      publishedIndex: null,
      publishedFoldsToHeaderRoot: false,
      bundlePresent: false,
    });
    const a9 = results.find((r) => r.id === 'A9_no_false_back_catalogue_404')!;
    expect(a9.ok).toBe(false);
    expect(a9.detail).toMatch(/B2 fails loudly/);
  });

  it('FAILS A7 when the sweep has not populated the sampled row yet', () => {
    const results = evaluateCoherence({
      httpStatus: 200,
      dbBranch: null,
      dbIndex: null,
      publishedBranch: null,
      publishedIndex: null,
      publishedFoldsToHeaderRoot: false,
      bundlePresent: true,
    });
    expect(ok(results, 'A7_read_write_coherent')).toBe(false);
  });
});

describe('self-test row', () => {
  it('covers #2524 behavior, proves the assertions discriminate, and is explicitly not soak evidence', async () => {
    const row = await runSelfTest();
    expect(row.pr).toBe(2524);
    expect(row.tier).toBe('T3');
    expect(row.mode).toBe('self-test');
    expect(row.evidenceForSoak).toBe(false);
    expect(row.withinDeclaredWindow).toBe(false);
    expect(row.status).toBe('pass');
    expect(row.changedBehavior).toMatch(/sweep cursor advance\/wrap/);

    // The point of the self-test: the broken-build vectors must FAIL.
    expect(row.counts.healthySweepAllPass).toBe(true);
    expect(row.counts.hollowFailsA1).toBe(true);
    expect(row.counts.hollowFailsA2).toBe(true);
    expect(row.counts.pinnedPassesA1).toBe(true);
    expect(row.counts.pinnedFailsA2).toBe(true);
    expect(row.counts.pinnedFailsA3).toBe(true);
    expect(row.counts.chunkWidePasses).toBe(true);
    expect(row.counts.chunkNarrowFails).toBe(true);
    expect(row.counts.chunkDroppedFails).toBe(true);
    expect(row.counts.foldGuardPasses).toBe(true);
    expect(row.counts.foldGuardFailsOnBadFold).toBe(true);
    expect(row.counts.foldGuardFailsOnUnrejectedMultiMatch).toBe(true);
    expect(row.counts.coherentPasses).toBe(true);
    expect(row.counts.readerRejectionFailsA7).toBe(true);
    expect(row.counts.false404FailsA9).toBe(true);
    expect(row.counts.prodRefDenied).toBe(true);
    expect(row.counts.sharedStagingRefDenied).toBe(true);
    expect(row.counts.sharedWorkerDenied).toBe(true);
    expect(row.counts.prodWorkerDenied).toBe(true);
    expect(row.counts.unidentifiableCloudRunDenied).toBe(true);
    expect(row.counts.unknownSupabaseHostDenied).toBe(true);
    expect(row.counts.isolatedRigAllowed).toBe(true);
    expect(row.counts.insideWindowTrue).toBe(true);
    expect(row.counts.afterWindowFalse).toBe(true);
    expect(row.counts.noWindowFalse).toBe(true);
    expect(row.counts.liveRequiresRpc).toBe(true);
  });

  it('states what it does NOT assert, in the row itself', async () => {
    const row = await runSelfTest();
    expect(row.notAsserted.length).toBeGreaterThan(0);
    expect(row.notAsserted.join(' ')).toMatch(/B2 500-not-404 is exercised in self-test only/);
    expect(row.notAsserted.join(' ')).toMatch(/in-process module state/);
  });
});

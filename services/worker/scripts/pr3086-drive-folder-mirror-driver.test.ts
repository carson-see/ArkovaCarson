import { describe, it, expect } from 'vitest';
import {
  ASSERTION,
  classifyTwoFoldersMirrored,
  classifyIdempotentResave,
  classifyTenantIsolationNoCollision,
  classifyPartialFailureIsolation,
  aggregate,
  tally,
  runSelfTest,
  runPartialFailureIsolationProbe,
  driverMirrorFolders,
  driverMirrorFoldersPreFixShape,
  parseArgs,
} from './pr3086-drive-folder-mirror-driver.js';

describe('classifyTwoFoldersMirrored', () => {
  it('passes on exactly 2 distinct rows', () => {
    const result = classifyTwoFoldersMirrored([
      { id: 'f1', org_id: 'o1', connector_source_id: 'd1' },
      { id: 'f2', org_id: 'o1', connector_source_id: 'd2' },
    ]);
    expect(result.status).toBe('pass');
  });

  it('FAILS when only 1 folder mirrored', () => {
    const result = classifyTwoFoldersMirrored([{ id: 'f1', org_id: 'o1', connector_source_id: 'd1' }]);
    expect(result.status).toBe('fail');
    expect(result.name).toBe(ASSERTION.TWO_FOLDERS_MIRRORED);
  });

  it('FAILS when 0 folders mirrored', () => {
    expect(classifyTwoFoldersMirrored([]).status).toBe('fail');
  });

  it('FAILS on a duplicate id (3 rows for 2 folders)', () => {
    const result = classifyTwoFoldersMirrored([
      { id: 'f1', org_id: 'o1', connector_source_id: 'd1' },
      { id: 'f1', org_id: 'o1', connector_source_id: 'd1' },
      { id: 'f2', org_id: 'o1', connector_source_id: 'd2' },
    ]);
    expect(result.status).toBe('fail');
  });
});

describe('classifyIdempotentResave', () => {
  it('passes when the id set is identical before/after', () => {
    expect(classifyIdempotentResave({ idsBeforeResave: ['a', 'b'], idsAfterResave: ['a', 'b'] }).status).toBe('pass');
  });

  it('passes regardless of array order (set comparison, not array equality)', () => {
    expect(classifyIdempotentResave({ idsBeforeResave: ['a', 'b'], idsAfterResave: ['b', 'a'] }).status).toBe('pass');
  });

  it('FAILS when the count grows — a duplicate was inserted', () => {
    const result = classifyIdempotentResave({ idsBeforeResave: ['a', 'b'], idsAfterResave: ['a', 'b', 'c'] });
    expect(result.status).toBe('fail');
  });

  it('FAILS when an id churns even with the same count', () => {
    const result = classifyIdempotentResave({ idsBeforeResave: ['a', 'b'], idsAfterResave: ['a', 'c'] });
    expect(result.status).toBe('fail');
  });

  it('FAILS on an empty precondition (fixture invalid, not a real pass)', () => {
    expect(classifyIdempotentResave({ idsBeforeResave: [], idsAfterResave: [] }).status).toBe('fail');
  });
});

describe('classifyTenantIsolationNoCollision', () => {
  it('passes when the two orgs mirror to distinct rows', () => {
    const result = classifyTenantIsolationNoCollision({ org1FolderId: 'f-org1', org2FolderId: 'f-org2' });
    expect(result.status).toBe('pass');
  });

  it('FAILS when both orgs resolve to the same row — the actual defect surface', () => {
    const result = classifyTenantIsolationNoCollision({ org1FolderId: 'f-shared', org2FolderId: 'f-shared' });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/SAME folders.id/);
  });

  it('FAILS when either org produced no mirror at all', () => {
    expect(classifyTenantIsolationNoCollision({ org1FolderId: '', org2FolderId: 'f-org2' }).status).toBe('fail');
    expect(classifyTenantIsolationNoCollision({ org1FolderId: 'f-org1', org2FolderId: '' }).status).toBe('fail');
  });
});

describe('classifyPartialFailureIsolation', () => {
  it('passes when the faulty folder is marked error and the others succeeded', () => {
    const result = classifyPartialFailureIsolation(
      [
        { driveFolderId: 'ok1', outcome: 'created' },
        { driveFolderId: 'faulty', outcome: 'error', error: 'boom' },
        { driveFolderId: 'ok2', outcome: 'created' },
      ],
      'faulty',
    );
    expect(result.status).toBe('pass');
  });

  it('FAILS when the loop aborted early (pre-fix shape — only 1 of 3 results)', () => {
    const result = classifyPartialFailureIsolation(
      [{ driveFolderId: 'ok1', outcome: 'created' }],
      'faulty',
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/unwound the loop/);
  });

  it('FAILS when the faulty folder is not itself marked error, even if the count matched', () => {
    const result = classifyPartialFailureIsolation(
      [
        { driveFolderId: 'ok1', outcome: 'created' },
        { driveFolderId: 'faulty', outcome: 'skipped_no_connection' },
        { driveFolderId: 'ok2', outcome: 'created' },
      ],
      'faulty',
    );
    expect(result.status).toBe('fail');
  });
});

describe('driverMirrorFolders — the reviewed (fixed) per-item isolation loop', () => {
  it('one folder throwing does not suppress the others', () => {
    const results = driverMirrorFolders(
      [{ folderId: 'ok1' }, { folderId: 'faulty' }, { folderId: 'ok2' }],
      (folderId) => {
        if (folderId === 'faulty') throw new Error('boom');
        return { driveFolderId: folderId, outcome: 'created' };
      },
    );
    expect(results).toHaveLength(3);
    expect(results.find((r) => r.driveFolderId === 'faulty')?.outcome).toBe('error');
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(2);
  });

  it('captures the thrown error message on the faulty result', () => {
    const results = driverMirrorFolders(
      [{ folderId: 'faulty' }],
      () => { throw new Error('specific boom'); },
    );
    expect(results[0].outcome).toBe('error');
    expect(results[0].error).toMatch(/specific boom/);
  });
});

describe('driverMirrorFoldersPreFixShape — the PRE-review defect, for self-test fault-injection proof', () => {
  it('an exception on one folder throws out of the whole call (no per-item isolation)', () => {
    expect(() => driverMirrorFoldersPreFixShape(
      [{ folderId: 'ok1' }, { folderId: 'faulty' }, { folderId: 'ok2' }],
      (folderId) => {
        if (folderId === 'faulty') throw new Error('boom');
        return { driveFolderId: folderId, outcome: 'created' };
      },
    )).toThrow(/boom/);
  });
});

describe('runPartialFailureIsolationProbe — drives the local reimplementation of the fixed loop', () => {
  it('proves per-item isolation against a fault injected for exactly one folder', () => {
    const result = runPartialFailureIsolationProbe();
    expect(result.status).toBe('pass');
    expect(result.name).toBe(ASSERTION.PARTIAL_FAILURE_ISOLATION);
  });
});

describe('aggregate / tally', () => {
  it('one failed probe fails the whole cycle', () => {
    expect(aggregate([
      { name: 'a', status: 'pass', detail: '' },
      { name: 'b', status: 'fail', detail: '' },
    ])).toBe('fail');
  });

  it('tallies all four assertions independently, never collapsed into one boolean', () => {
    const probes = [
      classifyTwoFoldersMirrored([
        { id: 'f1', org_id: 'o1', connector_source_id: 'd1' },
        { id: 'f2', org_id: 'o1', connector_source_id: 'd2' },
      ]),
      classifyIdempotentResave({ idsBeforeResave: ['f1', 'f2'], idsAfterResave: ['f1', 'f2'] }),
      classifyTenantIsolationNoCollision({ org1FolderId: 'f-org1', org2FolderId: 'f-org2' }),
      runPartialFailureIsolationProbe(),
    ];
    const counts = tally(probes);
    for (const name of Object.values(ASSERTION)) {
      expect(counts[`${name}_ran`]).toBe(true);
      expect(counts[`${name}_passed`]).toBe(true);
    }
    expect(counts.probes_total).toBe(4);
    expect(counts.probes_failed).toBe(0);
  });
});

describe('runSelfTest', () => {
  it('is entirely self-consistent (aggregates to pass), and covers all four assertions', () => {
    const probes = runSelfTest();
    expect(aggregate(probes)).toBe('pass');
    for (const name of Object.values(ASSERTION)) {
      expect(probes.some((p) => p.name === name)).toBe(true);
    }
  });
});

describe('parseArgs', () => {
  it('defaults to self-test mode', () => {
    expect(parseArgs([]).mode).toBe('self-test');
  });

  it('parses --live plus flags', () => {
    const args = parseArgs(['--live', '--target-url', 'https://example.invalid', '--duration-min', '240']);
    expect(args.mode).toBe('live');
    expect(args.targetUrl).toBe('https://example.invalid');
    expect(args.durationMin).toBe(240);
  });

  it('throws on an unknown flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
  });
});

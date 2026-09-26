import { describe, it, expect } from 'vitest';
import {
  ASSERTION,
  classifyExactlyThreeAccepted,
  classifyFourRejected,
  classifyCombinedShapeRejected,
  classifyCombinedShapeAtCapAccepted,
  aggregate,
  tally,
  buildTriggerConfig,
  driveFolderEntry,
  runSelfTest,
  parseArgs,
} from './pr3084-drive-folder-cap-driver.js';

describe('classifyExactlyThreeAccepted', () => {
  it('passes on 201/200', () => {
    expect(classifyExactlyThreeAccepted({ httpStatus: 201, body: {} }).status).toBe('pass');
    expect(classifyExactlyThreeAccepted({ httpStatus: 200, body: {} }).status).toBe('pass');
  });

  it('FAILS on 400 — the cap must be inclusive, not exclusive', () => {
    const result = classifyExactlyThreeAccepted({ httpStatus: 400, body: { error: 'too many' } });
    expect(result.status).toBe('fail');
    expect(result.name).toBe(ASSERTION.EXACTLY_THREE_ACCEPTED);
  });
});

describe('classifyFourRejected', () => {
  it('passes on 400', () => {
    expect(classifyFourRejected({ httpStatus: 400, body: {} }).status).toBe('pass');
  });

  it('FAILS on 201 — the basic per-array bound regressed', () => {
    const result = classifyFourRejected({ httpStatus: 201, body: { id: 'x' } });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/regressed/);
  });
});

describe('classifyCombinedShapeRejected — THE ACTUAL DEFECT', () => {
  it('passes on 400', () => {
    expect(classifyCombinedShapeRejected({ httpStatus: 400, body: {} }).status).toBe('pass');
  });

  it('FAILS on 201 — this is the exact pre-fix defect the PR closes', () => {
    const result = classifyCombinedShapeRejected({ httpStatus: 201, body: { id: 'x' } });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/pre-fix defect/);
    expect(result.name).toBe(ASSERTION.COMBINED_SHAPE_REJECTED);
  });
});

describe('classifyCombinedShapeAtCapAccepted', () => {
  it('passes on 201/200', () => {
    expect(classifyCombinedShapeAtCapAccepted({ httpStatus: 201, body: {} }).status).toBe('pass');
  });

  it('FAILS on 400 — the fix must bound the total, not ban the legacy shape', () => {
    const result = classifyCombinedShapeAtCapAccepted({ httpStatus: 400, body: {} });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/over-shot/);
  });
});

describe('driveFolderEntry / buildTriggerConfig fixtures', () => {
  it('produces the drive_folders array shape', () => {
    expect(driveFolderEntry('abc')).toEqual({ type: 'drive_folder', folder_id: 'abc' });
  });

  it('counts array-only totals correctly', () => {
    const cfg = buildTriggerConfig({ driveFoldersCount: 3, includeLegacySingular: false, suffix: 'x' });
    expect(cfg.drive_folders as unknown[]).toHaveLength(3);
    expect(cfg.folder_id).toBeUndefined();
  });

  it('counts combined-shape totals correctly (legacy + array = total)', () => {
    const cfg = buildTriggerConfig({ driveFoldersCount: 2, includeLegacySingular: true, suffix: 'y' });
    expect(cfg.drive_folders as unknown[]).toHaveLength(2);
    expect(cfg.folder_id).toBeDefined();
    expect(cfg.type).toBe('drive_folder');
  });

  it('never produces duplicate folder ids across the array and the legacy singular', () => {
    const cfg = buildTriggerConfig({ driveFoldersCount: 3, includeLegacySingular: true, suffix: 'z' });
    const arrIds = (cfg.drive_folders as Array<{ folder_id: string }>).map((e) => e.folder_id);
    expect(arrIds).not.toContain(cfg.folder_id);
    expect(new Set(arrIds).size).toBe(arrIds.length);
  });
});

describe('aggregate / tally', () => {
  it('one failed probe fails the whole cycle', () => {
    expect(aggregate([
      { name: 'a', status: 'pass', detail: '' },
      { name: 'b', status: 'fail', detail: '' },
    ])).toBe('fail');
  });

  it('tallies all four assertions independently', () => {
    const probes = [
      classifyExactlyThreeAccepted({ httpStatus: 201, body: {} }),
      classifyFourRejected({ httpStatus: 400, body: {} }),
      classifyCombinedShapeRejected({ httpStatus: 400, body: {} }),
      classifyCombinedShapeAtCapAccepted({ httpStatus: 201, body: {} }),
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
  it('is entirely self-consistent (aggregates to pass) with no network or database', () => {
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

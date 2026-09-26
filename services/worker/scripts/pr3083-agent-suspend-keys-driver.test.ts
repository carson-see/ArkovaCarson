import { describe, it, expect } from 'vitest';
import {
  ASSERTION,
  ADMIN_SUSPEND_REASON,
  classifySuspendRejectsKey,
  classifyResumeRestoresKey,
  classifySuspendKeysCommittedSynchronously,
  classifyNegativeControlComputeId,
  classifyNonStatusEditPreservesKeys,
  aggregate,
  tally,
  runSelfTest,
  parseArgs,
} from './pr3083-agent-suspend-keys-driver.js';

describe('classifySuspendRejectsKey', () => {
  it('passes on 401 (the fix)', () => {
    expect(classifySuspendRejectsKey(401).status).toBe('pass');
  });

  it('FAILS on 200 — this is the exact pre-fix defect shape', () => {
    const result = classifySuspendRejectsKey(200);
    expect(result.status).toBe('fail');
    expect(result.name).toBe(ASSERTION.SUSPEND_REJECTS_KEY);
    expect(result.detail).toMatch(/pre-fix defect/);
  });

  it('fails on any other unexpected status too (fails closed, not just != 200)', () => {
    expect(classifySuspendRejectsKey(500).status).toBe('fail');
    expect(classifySuspendRejectsKey(0).status).toBe('fail');
  });
});

describe('classifyResumeRestoresKey', () => {
  it('passes on 200', () => {
    expect(classifyResumeRestoresKey(200).status).toBe('pass');
  });

  it('FAILS on 401 — the key never came back after resume', () => {
    const result = classifyResumeRestoresKey(401);
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/still rejected/);
  });
});

describe('classifySuspendKeysCommittedSynchronously', () => {
  it('passes when the single immediate read already shows deactivated + tagged', () => {
    const result = classifySuspendKeysCommittedSynchronously({
      isActiveImmediatelyAfter: false,
      revocationReasonImmediatelyAfter: ADMIN_SUSPEND_REASON,
    });
    expect(result.status).toBe('pass');
  });

  it('FAILS when the key is still active on the immediate read (fire-and-forget regression shape)', () => {
    const result = classifySuspendKeysCommittedSynchronously({
      isActiveImmediatelyAfter: true,
      revocationReasonImmediatelyAfter: null,
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/not committed synchronously/);
  });

  it('FAILS when deactivated but tagged with the wrong marker', () => {
    const result = classifySuspendKeysCommittedSynchronously({
      isActiveImmediatelyAfter: false,
      revocationReasonImmediatelyAfter: 'something-else',
    });
    expect(result.status).toBe('fail');
  });
});

describe('classifyNegativeControlComputeId', () => {
  const base = {
    reasonBefore: 'computeid:economic_abuse_fixture',
    activeBefore: false,
  };

  it('passes when the for-cause key reads back byte-for-byte unchanged', () => {
    const result = classifyNegativeControlComputeId({
      ...base,
      reasonAfter: 'computeid:economic_abuse_fixture',
      activeAfter: false,
    });
    expect(result.status).toBe('pass');
  });

  it('FAILS when the resume revives the for-cause key — this is the negative control', () => {
    const result = classifyNegativeControlComputeId({
      ...base,
      reasonAfter: 'computeid:economic_abuse_fixture',
      activeAfter: true,
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/REVIVED/);
  });

  it('FAILS when the marker itself is overwritten even though is_active stayed false', () => {
    const result = classifyNegativeControlComputeId({
      ...base,
      reasonAfter: null,
      activeAfter: false,
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toMatch(/changed/);
  });
});

describe('classifyNonStatusEditPreservesKeys', () => {
  it('passes when a rename leaves the key fully untouched', () => {
    const result = classifyNonStatusEditPreservesKeys({
      activeBefore: true, activeAfter: true, reasonBefore: null, reasonAfter: null,
    });
    expect(result.status).toBe('pass');
  });

  it('FAILS when a rename incidentally deactivates the key', () => {
    const result = classifyNonStatusEditPreservesKeys({
      activeBefore: true, activeAfter: false, reasonBefore: null, reasonAfter: ADMIN_SUSPEND_REASON,
    });
    expect(result.status).toBe('fail');
  });

  it('FAILS if the precondition itself was already inactive (fixture invalid, not a real pass)', () => {
    const result = classifyNonStatusEditPreservesKeys({
      activeBefore: false, activeAfter: false, reasonBefore: null, reasonAfter: null,
    });
    expect(result.status).toBe('fail');
  });
});

describe('aggregate / tally', () => {
  it('one failed probe fails the whole cycle', () => {
    expect(aggregate([
      { name: 'a', status: 'pass', detail: '' },
      { name: 'b', status: 'fail', detail: '' },
    ])).toBe('fail');
  });

  it('tallies per-assertion pass/fail independently, never collapsed into one boolean', () => {
    const probes = [
      classifySuspendRejectsKey(401),
      classifyResumeRestoresKey(200),
      classifySuspendKeysCommittedSynchronously({
        isActiveImmediatelyAfter: false, revocationReasonImmediatelyAfter: ADMIN_SUSPEND_REASON,
      }),
      classifyNegativeControlComputeId({
        reasonBefore: 'computeid:x', activeBefore: false, reasonAfter: 'computeid:x', activeAfter: false,
      }),
      classifyNonStatusEditPreservesKeys({
        activeBefore: true, activeAfter: true, reasonBefore: null, reasonAfter: null,
      }),
    ];
    const counts = tally(probes);
    for (const name of Object.values(ASSERTION)) {
      expect(counts[`${name}_ran`]).toBe(true);
      expect(counts[`${name}_passed`]).toBe(true);
    }
    expect(counts.probes_total).toBe(5);
    expect(counts.probes_failed).toBe(0);
  });
});

describe('runSelfTest', () => {
  it('is entirely self-consistent (aggregates to pass) with no network or database', () => {
    const probes = runSelfTest();
    expect(aggregate(probes)).toBe('pass');
    // Every named assertion is exercised at least once, plus its own
    // defect-detection self-tests (multiple entries per family expected).
    for (const name of Object.values(ASSERTION)) {
      expect(probes.some((p) => p.name === name)).toBe(true);
    }
  });
});

describe('parseArgs', () => {
  it('defaults to self-test mode', () => {
    expect(parseArgs([]).mode).toBe('self-test');
  });

  it('parses --live plus target/evidence/duration flags', () => {
    const args = parseArgs([
      '--live', '--target-url', 'https://example.invalid',
      '--evidence-jsonl', '/tmp/x.jsonl',
      '--duration-min', '240', '--interval-sec', '600',
    ]);
    expect(args.mode).toBe('live');
    expect(args.targetUrl).toBe('https://example.invalid');
    expect(args.durationMin).toBe(240);
    expect(args.intervalSec).toBe(600);
  });

  it('throws on an unknown flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
  });
});

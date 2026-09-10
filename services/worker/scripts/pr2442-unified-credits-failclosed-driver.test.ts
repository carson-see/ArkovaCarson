import { describe, expect, it } from 'vitest';

import {
  DAILY_FLUSH,
  ORG_ISOLATION,
  TRIGGER_A,
  TRIGGER_B,
  aggregate,
  classifyDeduct,
  expectedCarryOver,
  isFailClosedMiss,
  parseArgs,
  runSelfTest,
  tally,
} from './pr2442-unified-credits-failclosed-driver.js';

describe('isFailClosedMiss — SCRUM-2538', () => {
  it('accepts the exact (0,0,0,false) shape 0420 returns for a missing row', () => {
    expect(
      isFailClosedMiss({ monthly_allocation: 0, used_this_month: 0, remaining: 0, has_credits: false }),
    ).toBe(true);
  });

  it('REJECTS a phantom allocation even when has_credits is false', () => {
    // This is the assertion that matters: has_credits alone is not the test.
    // A row reporting 50 still shows a phantom 50 on every balance surface.
    expect(
      isFailClosedMiss({ monthly_allocation: 50, used_this_month: 0, remaining: 50, has_credits: false }),
    ).toBe(false);
  });

  it('rejects a real balance', () => {
    expect(
      isFailClosedMiss({ monthly_allocation: 50, used_this_month: 2, remaining: 48, has_credits: true }),
    ).toBe(false);
  });

  it('treats an absent row as not-a-miss so a broken read cannot pass as fail-closed', () => {
    expect(isFailClosedMiss(null)).toBe(false);
  });
});

describe('classifyDeduct — SCRUM-3502', () => {
  it('classifies a literal false as a definitive refusal', () => {
    expect(classifyDeduct(false, null)).toBe('refused');
  });

  it('classifies true as debited', () => {
    expect(classifyDeduct(true, null)).toBe('debited');
  });

  it('classifies an RPC error as error even when data looks successful', () => {
    expect(classifyDeduct(true, new Error('boom'))).toBe('error');
  });

  it('classifies null/undefined as error, not refused', () => {
    // Absent data is an UNKNOWN state. Calling it a definitive no would reopen
    // the leak from the other side: the caller would fall through to a paid
    // tier on a debit that may have committed.
    expect(classifyDeduct(null, null)).toBe('error');
    expect(classifyDeduct(undefined, null)).toBe('error');
  });

  it('does not treat truthy non-boolean data as success', () => {
    expect(classifyDeduct(1, null)).toBe('error');
    expect(classifyDeduct('true', null)).toBe('error');
  });
});

describe('expectedCarryOver', () => {
  it('caps carry-over at 50', () => {
    expect(expectedCarryOver(500, 0)).toBe(50);
  });

  it('carries the unused remainder when it is under the cap', () => {
    expect(expectedCarryOver(30, 10)).toBe(20);
  });

  it('goes negative when usage exceeded the allocation, matching LEAST()', () => {
    expect(expectedCarryOver(10, 25)).toBe(-15);
  });
});

describe('aggregate', () => {
  it('fails a cycle if any probe failed', () => {
    expect(
      aggregate([
        { name: 'a', status: 'pass', detail: '' },
        { name: 'b', status: 'fail', detail: '' },
      ]),
    ).toBe('fail');
  });

  it('passes when every probe passed', () => {
    expect(aggregate([{ name: 'a', status: 'pass', detail: '' }])).toBe('pass');
  });
});

describe('tally', () => {
  it('emits a ran/passed/fired counter for each of the four T3 requirements', () => {
    const counts = tally([
      { name: `${TRIGGER_A}_uncovered_org`, status: 'pass', detail: '' },
      { name: `${TRIGGER_B}_no_row_returns_false`, status: 'fail', detail: '' },
      { name: `${DAILY_FLUSH}_used_reset`, status: 'pass', detail: '' },
      { name: `${ORG_ISOLATION}_neighbour_untouched`, status: 'pass', detail: '' },
    ]);

    for (const family of [TRIGGER_A, TRIGGER_B, DAILY_FLUSH, ORG_ISOLATION]) {
      expect(counts[`${family}_fired`]).toBe(true);
      expect(counts[`${family}_ran`]).toBe(1);
    }
    expect(counts[`${TRIGGER_B}_passed`]).toBe(0);
    expect(counts.probes_failed).toBe(1);
  });

  it('reports a requirement as not fired when no probe covered it', () => {
    const counts = tally([{ name: `${TRIGGER_A}_uncovered_org`, status: 'pass', detail: '' }]);
    expect(counts[`${DAILY_FLUSH}_fired`]).toBe(false);
    expect(counts[`${DAILY_FLUSH}_ran`]).toBe(0);
  });
});

describe('parseArgs', () => {
  it('defaults to self-test so a bare invocation cannot write soak evidence', () => {
    expect(parseArgs([]).mode).toBe('self-test');
  });

  it('parses live mode with a duration and interval', () => {
    const args = parseArgs(['--mode', 'live', '--duration-min', '2880', '--interval-sec', '300']);
    expect(args).toMatchObject({ mode: 'live', durationMin: 2880, intervalSec: 300 });
  });

  it('ignores an unrecognised mode rather than silently going live', () => {
    expect(parseArgs(['--mode', 'production']).mode).toBe('self-test');
  });
});

describe('runSelfTest', () => {
  it('passes every classifier probe', () => {
    const probes = runSelfTest();
    expect(probes.length).toBeGreaterThan(0);
    expect(aggregate(probes)).toBe('pass');
  });

  it('covers all four T3 requirement families', () => {
    const counts = tally(runSelfTest());
    for (const family of [TRIGGER_A, TRIGGER_B, DAILY_FLUSH, ORG_ISOLATION]) {
      expect(counts[`${family}_fired`]).toBe(true);
    }
  });
});

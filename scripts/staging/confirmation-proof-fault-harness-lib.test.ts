import { describe, expect, it } from 'vitest';

import {
  buildFaultPlan,
  isTransientKind,
  verdictFor,
  isBoundedBackoff,
  type RigFaultKind,
} from './confirmation-proof-fault-harness-lib';

describe('buildFaultPlan — every fault maps to its #1408-required status', () => {
  it('covers all seven fault kinds exactly once', () => {
    const plan = buildFaultPlan();
    const kinds = plan.map((p) => p.kind).sort();
    expect(kinds).toEqual(
      (['econnreset', 'http_429', 'http_4xx', 'http_5xx', 'network', 'rpc_application', 'timeout'] as RigFaultKind[]).sort(),
    );
    expect(new Set(kinds).size).toBe(7);
  });

  it('transient faults expect pending; definitive faults expect stale', () => {
    for (const entry of buildFaultPlan()) {
      if (entry.faultClass === 'transient') {
        expect(entry.expectedStatus).toBe('pending');
        expect(isTransientKind(entry.kind)).toBe(true);
      } else {
        expect(entry.expectedStatus).toBe('stale');
        expect(isTransientKind(entry.kind)).toBe(false);
      }
    }
  });

  it('http_429 is transient (rate-limit → retry, not a hard 4xx)', () => {
    const e429 = buildFaultPlan().find((p) => p.kind === 'http_429')!;
    expect(e429.faultClass).toBe('transient');
    expect(e429.expectedStatus).toBe('pending');
    // contrast with a hard 4xx
    const e4xx = buildFaultPlan().find((p) => p.kind === 'http_4xx')!;
    expect(e4xx.expectedStatus).toBe('stale');
  });
});

describe('verdictFor — pass only when observed matches the contract', () => {
  it('passes a transient fault observed as pending', () => {
    const entry = buildFaultPlan().find((p) => p.kind === 'http_5xx')!;
    expect(verdictFor(entry, 'pending').pass).toBe(true);
  });
  it('FAILS a transient fault observed as stale (the exact #1408 regression)', () => {
    const entry = buildFaultPlan().find((p) => p.kind === 'http_5xx')!;
    const v = verdictFor(entry, 'stale');
    expect(v.pass).toBe(false);
    expect(v.expected).toBe('pending');
    expect(v.observed).toBe('stale');
  });
  it('passes a definitive fault observed as stale', () => {
    const entry = buildFaultPlan().find((p) => p.kind === 'rpc_application')!;
    expect(verdictFor(entry, 'stale').pass).toBe(true);
  });
});

describe('isBoundedBackoff — retry telemetry stays within the jittered envelope', () => {
  it('accepts a non-decreasing exponential schedule within [0.5,1]·base·2^n', () => {
    // base=1000, retries: ~[750, 1600, 3200] all within envelope
    expect(isBoundedBackoff([750, 1600, 3200], 1000, 3)).toBe(true);
  });
  it('rejects a schedule with more entries than maxRetries', () => {
    expect(isBoundedBackoff([700, 1500, 3000, 6000], 1000, 3)).toBe(false);
  });
  it('rejects a delay above the 2^n ceiling (unbounded backoff)', () => {
    expect(isBoundedBackoff([2500], 1000, 3)).toBe(false); // > 1·1000
  });
  it('rejects a delay below the 0.5 floor', () => {
    expect(isBoundedBackoff([400], 1000, 3)).toBe(false); // < 0.5·1000
  });
});

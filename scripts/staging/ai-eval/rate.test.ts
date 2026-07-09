import { describe, it, expect } from 'vitest';

import {
  intervalMsForRatePerHour,
  minUsersForRatePerHour,
  planRate,
  pickIdentity,
  PER_USER_LIMIT_PER_MIN,
} from './rate.js';
import type { WorkerIdentity } from './ai-client.js';

function users(n: number): WorkerIdentity[] {
  return Array.from({ length: n }, (_, i) => ({ label: `u${i}`, jwt: `jwt-${i}` }));
}

describe('intervalMsForRatePerHour', () => {
  it('spaces 5000/hr at ~720ms', () => {
    expect(intervalMsForRatePerHour(5000)).toBe(720);
  });
  it('spaces 3600/hr at exactly 1000ms', () => {
    expect(intervalMsForRatePerHour(3600)).toBe(1000);
  });
  it('rejects a non-positive rate', () => {
    expect(() => intervalMsForRatePerHour(0)).toThrow();
  });
});

describe('minUsersForRatePerHour', () => {
  it('needs >= 3 users for 5000/hr at the raw limit (5000/1800=2.78→3)', () => {
    expect(minUsersForRatePerHour(5000, 1)).toBe(3);
  });
  it('needs more users with headroom', () => {
    expect(minUsersForRatePerHour(5000, 1.3)).toBe(4);
  });
});

describe('planRate', () => {
  it('flags an undersized pool for 5000/hr on a single user', () => {
    const plan = planRate(5000, users(1));
    expect(plan.sufficient).toBe(false);
    expect(plan.warning).toMatch(/Undersized identity pool/);
    expect(plan.perUserPerMin).toBeGreaterThan(PER_USER_LIMIT_PER_MIN);
  });

  it('accepts a 4-user pool for 5000/hr (≈20.8 req/min/user, under 30)', () => {
    const plan = planRate(5000, users(4));
    expect(plan.sufficient).toBe(true);
    expect(plan.warning).toBeUndefined();
    expect(plan.perUserPerMin).toBeLessThanOrEqual(PER_USER_LIMIT_PER_MIN);
    expect(plan.intervalMs).toBe(720);
  });

  it('warns loudly on an empty identity pool (every call would 401)', () => {
    const plan = planRate(5000, []);
    expect(plan.sufficient).toBe(false);
    expect(plan.warning).toMatch(/No identities/);
  });
});

describe('pickIdentity', () => {
  it('round-robins deterministically', () => {
    const pool = users(3);
    expect(pickIdentity(pool, 0).label).toBe('u0');
    expect(pickIdentity(pool, 1).label).toBe('u1');
    expect(pickIdentity(pool, 2).label).toBe('u2');
    expect(pickIdentity(pool, 3).label).toBe('u0');
  });
  it('throws on an empty pool rather than picking nothing', () => {
    expect(() => pickIdentity([], 0)).toThrow();
  });
});

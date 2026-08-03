/**
 * Tests for Audit Batch Verification API (COMP-06)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockLogger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
const mockOrgAuth = vi.hoisted(() => ({
  getCallerOrgId: vi.fn(async () => 'org-1'),
  isCallerOrgAdmin: vi.fn(async () => true),
}));

vi.mock('../../../utils/db.js', () => ({ db: { from: vi.fn() } }));
vi.mock('../../../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../../_org-auth.js', () => mockOrgAuth);

import {
  auditBatchVerifyRouter,
  seededRandom,
  seededSample,
  MAX_SAMPLE_SIZE,
  MAX_SAMPLEABLE_POPULATION,
  MAX_POPULATION_PAGES,
} from '../auditBatchVerify.js';
import { db } from '../../../utils/db.js';
import {
  POSTGREST_ROW_LIMIT,
  POSTGREST_URL_FILTER_BUDGET_BYTES,
} from '../../../utils/postgrest-filter.js';
import { encodedInFilterBytesFor } from '../../../test-utils/postgrestWire.js';

describe('Audit Batch Verification', () => {
  // Exercises the REAL `seededRandom`, imported above. This block used to
  // re-declare a local copy of the function under test, so it asserted only
  // that the copy agreed with itself.
  describe('seededRandom', () => {
    it('should produce deterministic results with same seed', () => {
      const rng1 = seededRandom(42);
      const rng2 = seededRandom(42);
      const seq1 = Array.from({ length: 10 }, () => rng1());
      const seq2 = Array.from({ length: 10 }, () => rng2());
      expect(seq1).toEqual(seq2);
    });

    it('should produce different results with different seeds', () => {
      const rng1 = seededRandom(42);
      const rng2 = seededRandom(99);
      const v1 = rng1();
      const v2 = rng2();
      expect(v1).not.toBe(v2);
    });

    it('should produce values in [0, 1) range', () => {
      const rng = seededRandom(12345);
      for (let i = 0; i < 100; i++) {
        const v = rng();
        expect(v).toBeGreaterThanOrEqual(0);
        // STRICTLY below 1. The old divisor was `0xffffffff`, so the maximum
        // draw was exactly 1.0 — and `Math.floor(1.0 * (i + 1))` is `i + 1`,
        // one past the end of the array a shuffle is indexing.
        expect(v).toBeLessThan(1);
      }
    });

    it('never returns exactly 1 for the state that would produce it', () => {
      // The LCG has full period over 2^32, so the state 0xffffffff IS reachable
      // and cannot be dismissed as unreachable in practice.
      const rng = seededRandom(0);
      const seen = new Set<number>();
      for (let i = 0; i < 100_000; i++) seen.add(rng());
      expect([...seen].every((v) => v >= 0 && v < 1)).toBe(true);
    });
  });

  describe('anomaly detection', () => {
    it('should flag anchor delay >24h', () => {
      const submittedAt = '2026-04-01T10:00:00Z';
      const securedAt = '2026-04-03T10:00:00Z';
      const delay = new Date(securedAt).getTime() - new Date(submittedAt).getTime();
      expect(delay).toBeGreaterThan(24 * 3600_000);
    });

    it('should flag stale PENDING >48h', () => {
      const createdAt = new Date(Date.now() - 72 * 3600_000).toISOString();
      const age = Date.now() - new Date(createdAt).getTime();
      expect(age).toBeGreaterThan(48 * 3600_000);
    });

    it('should flag missing fingerprint', () => {
      const anchor = { fingerprint: null, status: 'SECURED' };
      const anomalies: string[] = [];
      if (!anchor.fingerprint) anomalies.push('Missing fingerprint');
      expect(anomalies).toContain('Missing fingerprint');
    });

    it('should flag revoked credentials', () => {
      const anchor = { status: 'REVOKED' };
      const anomalies: string[] = [];
      if (anchor.status === 'REVOKED') anomalies.push('Credential has been revoked');
      expect(anomalies).toContain('Credential has been revoked');
    });
  });

  describe('batch size limits', () => {
    it('should enforce max 1000 credential IDs', () => {
      const ids = Array.from({ length: 1001 }, (_, i) => `ARK-${i}`);
      expect(ids.length).toBeGreaterThan(1000);
    });

    it('should handle empty credential_ids', () => {
      const ids: string[] = [];
      expect(ids.length).toBe(0);
    });
  });
});

/**
 * The anchor lookup behind the audit sample.
 *
 * `const { data: anchors } = await db…in('public_id', targetIds)` had no
 * chunking and discarded the error. The schema allows 1000 ids; 1000 public_ids
 * is roughly twice the PostgREST URL budget, so the request took 400 Bad
 * Request, `anchors` came back null, `anchorMap` was empty, and EVERY id in the
 * sample was reported `NOT_FOUND` — at HTTP 200, with an `AUDIT_BATCH_VERIFY`
 * audit event recording the same wrong answer.
 *
 * On an audit-sampling surface that is worse than an error: an auditor running
 * ISA 530 sampling receives a confident, reproducible, and entirely false
 * "none of these credentials exist" finding.
 */
describe('POST /api/v1/audit/batch-verify — anchor lookup width + failure policy', () => {
  interface InCall { column: string; values: string[] }

  /** Same shape as prod public_ids (12-char lower-case alphanumeric). */
  const PID = (n: number) => `pid${n.toString(36).padStart(9, '0')}`;

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { authUserId: string }).authUserId = 'user-1';
      next();
    });
    app.use('/api/v1/audit/batch-verify', auditBatchVerifyRouter);
    return app;
  }

  function mockDb(state: {
    inCalls: InCall[];
    securedIds?: string[];
    failEveryChunk?: boolean;
    auditEvents?: unknown[];
  }) {
    vi.mocked(db.from).mockImplementation((table: string): never => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: any = {};
      const chain = () => builder;
      builder.select = vi.fn(chain);
      builder.eq = vi.fn(chain);
      builder.insert = vi.fn((payload: unknown) => {
        state.auditEvents?.push(payload);
        return Promise.resolve({ data: null, error: null });
      });
      builder.in = vi.fn((column: string, values: string[]) => {
        state.inCalls.push({ column, values });
        builder.__inValues = values;
        builder.__overBudget =
          state.failEveryChunk ||
          encodedInFilterBytesFor(values) > POSTGREST_URL_FILTER_BUDGET_BYTES;
        return builder;
      });
      // `.is('deleted_at', null)` is the terminal on every anchors read here.
      builder.is = vi.fn(() => {
        if (builder.__inValues === undefined) {
          // The population scan / exact-count query, not an id filter.
          return Promise.resolve({ data: [], error: null, count: 0 });
        }
        if (builder.__overBudget) {
          // postgrest-js RESOLVES a 400 — it does not throw.
          return Promise.resolve({
            data: null,
            error: { code: 'PGRST', message: 'Bad Request', details: null, hint: null },
          });
        }
        const rows = (builder.__inValues as string[])
          .filter((v) => (state.securedIds ?? []).includes(v))
          .map((v) => ({
            public_id: v,
            status: 'SECURED',
            fingerprint: 'f'.repeat(64),
            chain_timestamp: '2026-07-01T00:00:00Z',
            chain_tx_id: 'tx-1',
            created_at: '2026-07-01T00:00:00Z',
          }));
        return Promise.resolve({ data: rows, error: null });
      });
      void table;
      return builder as never;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockOrgAuth.getCallerOrgId.mockResolvedValue('org-1');
    mockOrgAuth.isCallerOrgAdmin.mockResolvedValue(true);
  });

  it('never exceeds the URL filter budget at the schema maximum', async () => {
    const inCalls: InCall[] = [];
    mockDb({ inCalls });
    const credential_ids = Array.from({ length: 1000 }, (_, i) => PID(i));

    await request(buildApp())
      .post('/api/v1/audit/batch-verify')
      .send({ credential_ids })
      .expect(200);

    expect(inCalls.length).toBeGreaterThan(1);
    for (const call of inCalls) {
      expect(encodedInFilterBytesFor(call.values)).toBeLessThanOrEqual(
        POSTGREST_URL_FILTER_BUDGET_BYTES,
      );
    }
    const asked = new Set(inCalls.flatMap((c) => c.values));
    for (const id of credential_ids) expect(asked.has(id)).toBe(true);
  });

  it('does not report a real, SECURED credential as NOT_FOUND in a 1000-id sample', async () => {
    const inCalls: InCall[] = [];
    const auditEvents: unknown[] = [];
    const credential_ids = Array.from({ length: 1000 }, (_, i) => PID(i));
    const real = credential_ids[817];
    mockDb({ inCalls, securedIds: [real], auditEvents });

    const res = await request(buildApp())
      .post('/api/v1/audit/batch-verify')
      .send({ credential_ids })
      .expect(200);

    const hit = res.body.results.find((r: { public_id: string }) => r.public_id === real);
    expect(hit).toMatchObject({ status: 'PASS', anchor_status: 'SECURED' });
    expect(res.body.summary.passed).toBe(1);
    expect(res.body.summary.not_found).toBe(999);
    // The audit event must record the same verdict the caller was given.
    expect(JSON.parse((auditEvents[0] as { details: string }).details)).toMatchObject({
      passed: 1,
      not_found: 999,
    });
  });

  it('500s when a lookup chunk fails instead of answering NOT_FOUND at 200', async () => {
    const inCalls: InCall[] = [];
    const auditEvents: unknown[] = [];
    mockDb({ inCalls, failEveryChunk: true, auditEvents });

    const res = await request(buildApp())
      .post('/api/v1/audit/batch-verify')
      .send({ credential_ids: [PID(1), PID(2)] });

    expect(res.status).toBe(500);
    expect(res.body.results).toBeUndefined();
    // No audit event may claim a verdict that was never established.
    expect(auditEvents).toHaveLength(0);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('answers a small in-budget batch without chunking overhead', async () => {
    const inCalls: InCall[] = [];
    mockDb({ inCalls, securedIds: [PID(2)] });

    const res = await request(buildApp())
      .post('/api/v1/audit/batch-verify')
      .send({ credential_ids: [PID(1), PID(2), PID(3)] })
      .expect(200);

    expect(inCalls).toHaveLength(1);
    expect(res.body.summary).toMatchObject({ passed: 1, not_found: 2 });
  });
});

/**
 * Sampling uniformity.
 *
 * `[...rows].sort(() => rng() - 0.5)` is not a shuffle. A comparator that
 * returns a random sign is not a consistent ordering, so the permutation it
 * produces is a function of the sort algorithm's comparison schedule, not of
 * the randomness — no PRNG quality fixes it. Under V8's TimSort the element
 * that started at index 0 lands in the first slot far more often than chance.
 *
 * For ISA 530 that is the whole ballgame: a sample whose selection probability
 * depends on a row's position in the result set is not a random sample, and the
 * conclusion an auditor draws from it does not generalise to the population.
 */
describe('seededSample', () => {
  it('selects each element into the first slot with near-equal frequency', () => {
    const N = 16;
    const TRIALS = 2000;
    const population = Array.from({ length: N }, (_, i) => i);

    // count = 1 deliberately: it consumes exactly ONE draw per seed, so this
    // also pins the PRNG's FIRST output across sequential seeds. The old LCG
    // failed here (its first draw reached only 14 of 16 buckets over seeds
    // 1..2000, so two elements could never be picked first) — a bias a
    // whole-array shuffle hid by burning thousands of draws first.
    const firstSlotCounts = new Array<number>(N).fill(0);
    for (let seed = 1; seed <= TRIALS; seed += 1) {
      firstSlotCounts[seededSample(population, 1, seededRandom(seed))[0]] += 1;
    }

    // Uniform expectation is 2000/16 = 125, sd ≈ 10.8. These bounds are ~±6 sd
    // — wide enough never to flake, tight enough that the comparator "shuffle"
    // fails them decisively (measured: index 0 selected 340 times, index 1
    // only 77).
    for (let i = 0; i < N; i += 1) {
      expect(firstSlotCounts[i]).toBeGreaterThan(80);
      expect(firstSlotCounts[i]).toBeLessThan(190);
    }
  });

  it('draws without replacement — no element appears twice', () => {
    const population = Array.from({ length: 500 }, (_, i) => `id-${i}`);
    const drawn = seededSample(population, 120, seededRandom(7));

    expect(drawn).toHaveLength(120);
    expect(new Set(drawn).size).toBe(120);
    for (const id of drawn) expect(population).toContain(id);
  });

  it('gives every element an equal chance of appearing in the sample', () => {
    const N = 16;
    const TRIALS = 2000;
    const population = Array.from({ length: N }, (_, i) => i);

    // Membership, not just slot 0: a 4-of-16 sample should include each element
    // in 4/16 of trials (expectation 500 of 2000, sd ~19). Bounds are ~±6 sd.
    const memberCounts = new Array<number>(N).fill(0);
    for (let seed = 1; seed <= TRIALS; seed += 1) {
      for (const v of seededSample(population, 4, seededRandom(seed))) memberCounts[v] += 1;
    }
    for (let i = 0; i < N; i += 1) {
      expect(memberCounts[i]).toBeGreaterThan(385);
      expect(memberCounts[i]).toBeLessThan(615);
    }
  });

  it('returns the whole population when count meets or exceeds it', () => {
    const population = ['a', 'b', 'c'];
    expect([...seededSample(population, 3, seededRandom(1))].sort()).toEqual(['a', 'b', 'c']);
    expect([...seededSample(population, 99, seededRandom(1))].sort()).toEqual(['a', 'b', 'c']);
    expect(seededSample(population, 0, seededRandom(1))).toEqual([]);
  });

  it('stays in bounds when the rng returns exactly 1', () => {
    // Defence in depth: the sampler must not trust its rng's upper bound. An
    // unclamped `Math.floor(rng() * remaining)` indexes one past the end and
    // swaps `undefined` into the array — which the caller then reports as a
    // sampled credential.
    const population = ['a', 'b', 'c', 'd'];
    const drawn = seededSample(population, 4, () => 1);

    expect(drawn).toHaveLength(4);
    expect(drawn.every((v) => typeof v === 'string')).toBe(true);
    expect([...drawn].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not mutate the population it was given', () => {
    const population = ['a', 'b', 'c', 'd', 'e'];
    seededSample(population, 3, seededRandom(3));
    expect(population).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('reproduces the same sample for the same seed', () => {
    const population = Array.from({ length: 200 }, (_, i) => `id-${i}`);
    expect(seededSample(population, 40, seededRandom(99))).toEqual(
      seededSample(population, 40, seededRandom(99)),
    );
  });

  it('costs one draw per selected item, not one per population item', () => {
    // The endpoint samples up to 1,000 from up to 25,000. A whole-array shuffle
    // burns 25,000 draws for the same 1,000 results.
    let draws = 0;
    const rng = seededRandom(5);
    const counting = () => { draws += 1; return rng(); };
    seededSample(Array.from({ length: 25_000 }, (_, i) => i), 1000, counting);
    expect(draws).toBe(1000);
  });
});

/**
 * Where the `sample_percentage` sample actually comes from.
 *
 * The population read was `db.from('anchors').select('public_id').eq('org_id',…)`
 * with no `.range()`, so PostgREST returned its default 1000-row maximum and
 * stopped. The sample was drawn from those 1000 rows — while `total_population`
 * was reported from a SEPARATE `count: 'exact'` over the whole org.
 *
 * On the real DocuSign org (3,151,539 anchors) a 1% request therefore returned
 * 10 credentials drawn from an arbitrary 1000, presented alongside
 * `total_population: 3151539`, with nothing in the response saying otherwise.
 * The auditor is told the sample came from the full population. It did not.
 *
 * This is an audit-validity defect, not a performance one: the endpoint's whole
 * job is to let someone conclude something about the population from the
 * sample, and that inference was unsound.
 */
describe('POST /api/v1/audit/batch-verify — sample population source', () => {
  const PID = (n: number) => `pid${n.toString(36).padStart(9, '0')}`;

  interface DbState {
    /** The org's full active population, in scan order. */
    population: string[];
    /**
     * Rows the SERVER will return for one page, regardless of the width the
     * worker asks for — PostgREST's `db-max-rows`.
     *
     * Deliberately NOT defaulted to `POSTGREST_ROW_LIMIT`. This is a server
     * setting, the worker's constant is a guess at it, and a mock that ties
     * the two together can only ever prove the code agrees with itself. Tests
     * that care about completeness set this to something OTHER than the
     * worker's constant.
     */
    serverPageCap: number;
    /** What a `count: 'exact'` head query would report. Defaults to the truth. */
    exactCount?: number;
    /** 0-based page index whose read fails, modelling a mid-scan DB fault. */
    failPageIndex?: number;
    /** Return the SAME first page for every offset, modelling a lost ordering. */
    repeatFirstPageForever?: boolean;
    /** Populated by the mock. */
    countQueries: number;
    ranges: Array<[number, number]>;
    unpagedPopulationReads: number;
    inCalls: string[][];
    auditEvents: unknown[];
  }

  function newState(overrides: Partial<DbState> & { population: string[] }): DbState {
    return {
      serverPageCap: POSTGREST_ROW_LIMIT,
      countQueries: 0,
      ranges: [],
      unpagedPopulationReads: 0,
      inCalls: [],
      auditEvents: [],
      ...overrides,
    };
  }

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { authUserId: string }).authUserId = 'user-1';
      next();
    });
    app.use('/api/v1/audit/batch-verify', auditBatchVerifyRouter);
    return app;
  }

  function anchorRow(publicId: string) {
    return {
      public_id: publicId,
      status: 'SECURED',
      fingerprint: 'f'.repeat(64),
      chain_timestamp: '2026-07-01T00:00:00Z',
      chain_tx_id: 'tx-1',
      created_at: '2026-07-01T00:00:00Z',
    };
  }

  function mockDb(state: DbState) {
    vi.mocked(db.from).mockImplementation((table: string): never => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builder: any = {};
      let countExact = false;
      let inValues: string[] | undefined;

      builder.select = vi.fn((_columns: string, options?: { count?: string; head?: boolean }) => {
        if (options?.count === 'exact') {
          countExact = true;
          state.countQueries += 1;
        }
        return builder;
      });
      builder.eq = vi.fn(() => builder);
      builder.is = vi.fn(() => builder);
      builder.order = vi.fn(() => builder);
      builder.insert = vi.fn((payload: unknown) => {
        state.auditEvents.push(payload);
        return Promise.resolve({ data: null, error: null });
      });
      builder.in = vi.fn((_column: string, values: string[]) => {
        inValues = values;
        state.inCalls.push(values);
        return builder;
      });

      builder.range = vi.fn((from: number, to: number) => {
        state.ranges.push([from, to]);
        if (state.failPageIndex === state.ranges.length - 1) {
          // postgrest-js RESOLVES a failure — it does not throw.
          return Promise.resolve({
            data: null,
            error: { code: 'PGRST', message: 'Bad Request', details: null, hint: null },
          });
        }
        // The SERVER caps the page at its own row limit, whatever width the
        // caller asked for.
        const width = Math.min(to - from + 1, state.serverPageCap);
        const start = state.repeatFirstPageForever ? 0 : from;
        return Promise.resolve({
          data: state.population.slice(start, start + width).map((id) => ({ public_id: id })),
          error: null,
        });
      });

      // Awaiting the builder without `.range()`.
      builder.then = (
        resolve: (value: unknown) => unknown,
        reject: (reason: unknown) => unknown,
      ) => {
        if (countExact) {
          return Promise.resolve({
            data: null,
            error: null,
            count: state.exactCount ?? state.population.length,
          }).then(resolve, reject);
        }
        if (inValues !== undefined) {
          const known = new Set(state.population);
          return Promise.resolve({
            data: inValues.filter((v) => known.has(v)).map(anchorRow),
            error: null,
          }).then(resolve, reject);
        }
        // The unpaged population read — capped by PostgREST at its row limit.
        // This is the defect under test, modelled exactly.
        state.unpagedPopulationReads += 1;
        return Promise.resolve({
          data: state.population.slice(0, POSTGREST_ROW_LIMIT).map((id) => ({ public_id: id })),
          error: null,
        }).then(resolve, reject);
      };

      void table;
      return builder as never;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockOrgAuth.getCallerOrgId.mockResolvedValue('org-1');
    mockOrgAuth.isCallerOrgAdmin.mockResolvedValue(true);
  });

  it('draws the sample from the whole population, not just the first page', async () => {
    const population = Array.from({ length: 3000 }, (_, i) => PID(i));
    const state = newState({ population });
    mockDb(state);

    const res = await request(buildApp())
      .post('/api/v1/audit/batch-verify')
      .send({ sample_percentage: 10, seed: 20260802 })
      .expect(200);

    // 10% of 3000, not 10% of the 1000 rows PostgREST was willing to hand over.
    expect(res.body.sample_size).toBe(300);
    expect(res.body.total_population).toBe(3000);
    expect(res.body.results).toHaveLength(300);

    // The population beyond the first page must be reachable. With 300 draws
    // from 3000 a correct sample lands ~200 of them past index 999; the old
    // code could never return even one.
    const beyondFirstPage = new Set(population.slice(POSTGREST_ROW_LIMIT));
    const sampled = res.body.results.map((r: { public_id: string }) => r.public_id);
    expect(sampled.filter((id: string) => beyondFirstPage.has(id)).length).toBeGreaterThan(100);

    // And every sampled id is a real member of the population.
    const known = new Set(population);
    expect(sampled.every((id: string) => known.has(id))).toBe(true);
  });

  it('reports the population it actually sampled, never a separate count', async () => {
    const population = Array.from({ length: 2500 }, (_, i) => PID(i));
    // A separate exact count is free to disagree with the scan — rows are
    // inserted between the two queries. Whatever it says, the response may only
    // claim the population the sample was drawn from.
    const state = newState({ population, exactCount: 3_151_539 });
    mockDb(state);

    const res = await request(buildApp())
      .post('/api/v1/audit/batch-verify')
      .send({ sample_percentage: 1, seed: 1 })
      .expect(200);

    expect(res.body.total_population).toBe(2500);
    expect(res.body.sample_size).toBe(25);
    // R0-8 / SCRUM-1254: no `count: 'exact'` may be issued against `anchors`.
    expect(state.countQueries).toBe(0);
    // And the population must be read through a paged scan, not one capped read.
    expect(state.unpagedPopulationReads).toBe(0);
    expect(state.ranges.length).toBeGreaterThan(1);
  });

  it('refuses instead of sampling a population it cannot fully read', async () => {
    const population = Array.from({ length: MAX_SAMPLEABLE_POPULATION + 1 }, (_, i) => PID(i));
    const state = newState({ population });
    mockDb(state);

    const res = await request(buildApp())
      .post('/api/v1/audit/batch-verify')
      .send({ sample_percentage: 0.1, seed: 5 });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('population_too_large');
    expect(res.body.population_at_least).toBe(MAX_SAMPLEABLE_POPULATION);
    expect(res.body.max_sampleable_population).toBe(MAX_SAMPLEABLE_POPULATION);
    // No sample, and no fabricated population figure alongside it.
    expect(res.body.results).toBeUndefined();
    expect(res.body.total_population).toBeUndefined();
    // Nothing may be recorded as a verified audit run.
    expect(state.auditEvents).toHaveLength(0);
  });

  it('refuses a sample larger than one response can carry, and says what fits', async () => {
    const population = Array.from({ length: 20_000 }, (_, i) => PID(i));
    const state = newState({ population });
    mockDb(state);

    const res = await request(buildApp())
      .post('/api/v1/audit/batch-verify')
      .send({ sample_percentage: 50, seed: 5 });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('sample_too_large');
    expect(res.body.requested_sample_size).toBe(10_000);
    expect(res.body.max_sample_size).toBe(MAX_SAMPLE_SIZE);
    // The population IS known here, so reporting it is honest.
    expect(res.body.total_population).toBe(20_000);
    // Actionable: the largest percentage that would have worked.
    expect(res.body.max_sample_percentage).toBe(5);
    expect(state.auditEvents).toHaveLength(0);
  });

  it('500s on a mid-scan population read failure instead of sampling what it got', async () => {
    const population = Array.from({ length: 5000 }, (_, i) => PID(i));
    const state = newState({ population, failPageIndex: 2 });
    mockDb(state);

    const res = await request(buildApp())
      .post('/api/v1/audit/batch-verify')
      .send({ sample_percentage: 5, seed: 5 });

    expect(res.status).toBe(500);
    expect(res.body.results).toBeUndefined();
    expect(state.auditEvents).toHaveLength(0);
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it('answers an empty org with the same response shape as a populated one', async () => {
    const state = newState({ population: [] });
    mockDb(state);

    const res = await request(buildApp())
      .post('/api/v1/audit/batch-verify')
      .send({ sample_percentage: 10, seed: 42 })
      .expect(200);

    // The empty branch used to return a four-field object with no `summary`
    // and no `verified_at`, so a client parsing the response had to handle two
    // different shapes for the same 200.
    expect(res.body).toMatchObject({
      results: [],
      total_population: 0,
      sample_size: 0,
      seed: 42,
    });
    expect(res.body.summary).toEqual({
      total_verified: 0,
      passed: 0,
      failed: 0,
      not_found: 0,
      anomalies_found: 0,
    });
    expect(typeof res.body.verified_at).toBe('string');
  });

  it('honours seed 0 as a seed rather than as "no seed"', async () => {
    const population = Array.from({ length: 400 }, (_, i) => PID(i));

    const run = async () => {
      mockDb(newState({ population }));
      const res = await request(buildApp())
        .post('/api/v1/audit/batch-verify')
        .send({ sample_percentage: 5, seed: 0 })
        .expect(200);
      return res.body;
    };

    const first = await run();
    const second = await run();

    // `seed || Date.now()` made seed 0 fall through to the clock, so the one
    // seed an auditor is most likely to type was the one that could not be
    // reproduced.
    expect(first.seed).toBe(0);
    expect(second.results.map((r: { public_id: string }) => r.public_id)).toEqual(
      first.results.map((r: { public_id: string }) => r.public_id),
    );
  });

  it('returns the seed it generated when the caller supplies none', async () => {
    const population = Array.from({ length: 400 }, (_, i) => PID(i));
    mockDb(newState({ population }));

    const generated = await request(buildApp())
      .post('/api/v1/audit/batch-verify')
      .send({ sample_percentage: 5 })
      .expect(200);

    // ISA 530 reproducibility is only a guarantee if the auditor is told which
    // seed produced the sample. `seed: seed || null` told them nothing.
    expect(typeof generated.body.seed).toBe('number');

    mockDb(newState({ population }));
    const replayed = await request(buildApp())
      .post('/api/v1/audit/batch-verify')
      .send({ sample_percentage: 5, seed: generated.body.seed })
      .expect(200);

    expect(replayed.body.results.map((r: { public_id: string }) => r.public_id)).toEqual(
      generated.body.results.map((r: { public_id: string }) => r.public_id),
    );
  });

  it('reads the whole population when the server page cap is BELOW the worker constant', async () => {
    // `db-max-rows` is a server setting the worker cannot see. Treating "fewer
    // rows than I asked for" as "no more rows" reintroduced the exact defect
    // this endpoint was fixed for: with a 500-row cap the scan stopped after
    // one page and reported a 5,000-anchor org as holding 500 records, at 200.
    const population = Array.from({ length: 5000 }, (_, i) => PID(i));
    const state = newState({ population, serverPageCap: 500 });
    mockDb(state);

    const res = await request(buildApp())
      .post('/api/v1/audit/batch-verify')
      .send({ sample_percentage: 10, seed: 3 })
      .expect(200);

    expect(res.body.total_population).toBe(5000);
    expect(res.body.sample_size).toBe(500);
    // Offsets must advance by rows RETURNED, not by the width requested —
    // otherwise every short page silently skips the rows it withheld.
    expect(state.ranges.map(([from]) => from).slice(0, 4)).toEqual([0, 500, 1000, 1500]);
  });

  it('reads the whole population when the server page cap is ABOVE the worker constant', async () => {
    const population = Array.from({ length: 2500 }, (_, i) => PID(i));
    const state = newState({ population, serverPageCap: 5000 });
    mockDb(state);

    const res = await request(buildApp())
      .post('/api/v1/audit/batch-verify')
      .send({ sample_percentage: 10, seed: 3 })
      .expect(200);

    expect(res.body.total_population).toBe(2500);
    expect(res.body.sample_size).toBe(250);
  });

  it('refuses rather than looping forever when pages stop advancing', async () => {
    // If the result ordering ever stops being total, OFFSET paging can hand
    // back the same rows for every offset. The dedupe then pins `ids.length`
    // so the population ceiling never fires, and the pages stay full so an
    // end-of-population check never fires either. Only an absolute page bound
    // ends this, and it must end it as a refusal, not as a complete read.
    const population = Array.from({ length: 50_000 }, (_, i) => PID(i));
    const state = newState({ population, repeatFirstPageForever: true });
    mockDb(state);

    const res = await request(buildApp())
      .post('/api/v1/audit/batch-verify')
      .send({ sample_percentage: 1, seed: 3 });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('population_too_large');
    // Bounded, and it refuses. The row budget happens to bite first here
    // (26 full pages reach 25,000 rows), but the page ceiling is the guarantee
    // that SOME bound always applies.
    expect(state.ranges.length).toBeLessThanOrEqual(MAX_POPULATION_PAGES);
    expect(state.auditEvents).toHaveLength(0);
  });

  it('refuses when the page budget runs out before the population does', async () => {
    // Tiny server pages: 64 requests never accumulate enough rows for the row
    // budget to bite, so only the page ceiling can end this. It must end it as
    // a refusal — a partial read is never a population figure.
    const population = Array.from({ length: 50_000 }, (_, i) => PID(i));
    const state = newState({ population, serverPageCap: 10 });
    mockDb(state);

    const res = await request(buildApp())
      .post('/api/v1/audit/batch-verify')
      .send({ sample_percentage: 1, seed: 3 });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('population_too_large');
    expect(state.ranges.length).toBe(MAX_POPULATION_PAGES);
    expect(res.body.total_population).toBeUndefined();
    expect(state.auditEvents).toHaveLength(0);
  });

  it('does not record a sampling run when credential_ids won the request', async () => {
    // The Zod refine is an OR, so both may be supplied; `credential_ids` takes
    // precedence. Recording `sampling` off the mere presence of the parameter
    // put a percentage-sample claim into the permanent audit trail for a run
    // that verified the caller's own two hand-picked ids.
    const population = Array.from({ length: 100 }, (_, i) => PID(i));
    const state = newState({ population });
    mockDb(state);

    const res = await request(buildApp())
      .post('/api/v1/audit/batch-verify')
      .send({ credential_ids: [PID(1), PID(2)], sample_percentage: 10, seed: 7 })
      .expect(200);

    expect(state.ranges).toHaveLength(0);
    expect(res.body.total_population).toBe(2);
    const details = JSON.parse((state.auditEvents[0] as { details: string }).details);
    expect(details.sampling).toBeUndefined();
  });

  it('leaves the credential_ids path untouched by the population scan', async () => {
    const population = Array.from({ length: 3000 }, (_, i) => PID(i));
    const state = newState({ population });
    mockDb(state);

    const res = await request(buildApp())
      .post('/api/v1/audit/batch-verify')
      .send({ credential_ids: [PID(1), PID(2)] })
      .expect(200);

    expect(state.ranges).toHaveLength(0);
    expect(state.countQueries).toBe(0);
    expect(res.body.total_population).toBe(2);
    expect(res.body.seed).toBeNull();
  });
});

/**
 * Property sweep over the sampling contract.
 *
 * The hand-written cases above each pin one boundary. This sweeps the whole
 * matrix — population size x server page cap x requested percentage — and
 * asserts the ONE invariant the endpoint exists to uphold:
 *
 *   Either it refuses, or `total_population` is the TRUE population and the
 *   sample is a distinct subset of it of exactly the requested size.
 *
 * Both bugs this endpoint has now had were violations of that single sentence
 * while every individual response still looked well-formed, which is why the
 * check is stated as a property rather than as more examples.
 */
describe('POST /api/v1/audit/batch-verify — sampling contract property sweep', () => {
  const PID = (n: number) => `pid${n.toString(36).padStart(9, '0')}`;

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { authUserId: string }).authUserId = 'user-1';
      next();
    });
    app.use('/api/v1/audit/batch-verify', auditBatchVerifyRouter);
    return app;
  }

  function mockDb(population: string[], serverPageCap: number) {
    vi.mocked(db.from).mockImplementation((): never => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {};
      let inValues: string[] | undefined;
      b.select = vi.fn(() => b);
      b.eq = vi.fn(() => b);
      b.is = vi.fn(() => b);
      b.order = vi.fn(() => b);
      b.insert = vi.fn(() => Promise.resolve({ data: null, error: null }));
      b.in = vi.fn((_c: string, v: string[]) => { inValues = v; return b; });
      b.range = vi.fn((from: number, to: number) =>
        Promise.resolve({
          data: population
            .slice(from, from + Math.min(to - from + 1, serverPageCap))
            .map((id) => ({ public_id: id })),
          error: null,
        }));
      b.then = (res: (v: unknown) => unknown, rej: (v: unknown) => unknown) => {
        const known = new Set(population);
        return Promise.resolve({
          data: (inValues ?? []).filter((v) => known.has(v)).map((v) => ({
            public_id: v, status: 'SECURED', fingerprint: 'f'.repeat(64),
            chain_timestamp: '2026-07-01T00:00:00Z', chain_tx_id: 'tx',
            created_at: '2026-07-01T00:00:00Z',
          })),
          error: null,
        }).then(res, rej);
      };
      return b as never;
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockOrgAuth.getCallerOrgId.mockResolvedValue('org-1');
    mockOrgAuth.isCallerOrgAdmin.mockResolvedValue(true);
  });

  // Sizes chosen around every boundary: empty, sub-page, exact page multiples,
  // page+1, and either side of MAX_SAMPLE_SIZE.
  const POPULATIONS = [0, 1, 999, 1000, 1001, 2000, 3333];
  // Caps deliberately unequal to POSTGREST_ROW_LIMIT in both directions.
  const CAPS = [7, 500, POSTGREST_ROW_LIMIT, 2500];
  const PERCENTAGES = [0.1, 1, 33.3, 100];

  for (const popSize of POPULATIONS) {
    for (const cap of CAPS) {
      for (const pct of PERCENTAGES) {
        it(`pop=${popSize} cap=${cap} pct=${pct}`, async () => {
          const population = Array.from({ length: popSize }, (_, i) => PID(i));
          mockDb(population, cap);

          const res = await request(buildApp())
            .post('/api/v1/audit/batch-verify')
            .send({ sample_percentage: pct, seed: 11 });

          if (res.status === 422) {
            // A refusal must never carry a population figure it did not verify.
            expect(['population_too_large', 'sample_too_large']).toContain(res.body.error);
            expect(res.body.results).toBeUndefined();
            if (res.body.error === 'population_too_large') {
              expect(res.body.total_population).toBeUndefined();
            }
            return;
          }

          expect(res.status).toBe(200);

          // THE invariant: the reported population is the real one.
          expect(res.body.total_population).toBe(popSize);

          const expectedSize = Math.min(
            Math.ceil(popSize * (pct / 100)),
            MAX_SAMPLE_SIZE,
          );
          expect(res.body.sample_size).toBe(expectedSize);

          const sampled = res.body.results.map((r: { public_id: string }) => r.public_id);
          expect(new Set(sampled).size).toBe(sampled.length);
          const known = new Set(population);
          for (const id of sampled) expect(known.has(id)).toBe(true);

          // Reproducible for the same seed.
          mockDb(population, cap);
          const replay = await request(buildApp())
            .post('/api/v1/audit/batch-verify')
            .send({ sample_percentage: pct, seed: 11 })
            .expect(200);
          expect(replay.body.results.map((r: { public_id: string }) => r.public_id)).toEqual(sampled);
        });
      }
    }
  }
});

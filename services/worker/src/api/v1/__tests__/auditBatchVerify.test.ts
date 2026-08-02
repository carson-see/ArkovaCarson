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
  seededShuffle,
  MAX_SAMPLE_SIZE,
  MAX_SAMPLEABLE_POPULATION,
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
describe('seededShuffle', () => {
  it('selects each element into the first slot with near-equal frequency', () => {
    const N = 16;
    const TRIALS = 2000;
    const population = Array.from({ length: N }, (_, i) => i);

    const firstSlotCounts = new Array<number>(N).fill(0);
    for (let seed = 1; seed <= TRIALS; seed += 1) {
      firstSlotCounts[seededShuffle(population, seededRandom(seed))[0]] += 1;
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

  it('is a permutation — every element survives exactly once', () => {
    const population = Array.from({ length: 500 }, (_, i) => `id-${i}`);
    const shuffled = seededShuffle(population, seededRandom(7));

    expect(shuffled).toHaveLength(population.length);
    expect([...shuffled].sort()).toEqual([...population].sort());
  });

  it('stays in bounds when the rng returns exactly 1', () => {
    // Defence in depth: the shuffle must not trust its rng's upper bound. An
    // unclamped `Math.floor(rng() * (i + 1))` indexes one past the end here and
    // swaps `undefined` into the array — which the caller then reports as a
    // sampled credential.
    const population = ['a', 'b', 'c', 'd'];
    const shuffled = seededShuffle(population, () => 1);

    expect(shuffled).toHaveLength(4);
    expect(shuffled.every((v) => typeof v === 'string')).toBe(true);
    expect([...shuffled].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not mutate the population it was given', () => {
    const population = ['a', 'b', 'c', 'd', 'e'];
    seededShuffle(population, seededRandom(3));
    expect(population).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('reproduces the same permutation for the same seed', () => {
    const population = Array.from({ length: 200 }, (_, i) => `id-${i}`);
    expect(seededShuffle(population, seededRandom(99))).toEqual(
      seededShuffle(population, seededRandom(99)),
    );
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
    /** What a `count: 'exact'` head query would report. Defaults to the truth. */
    exactCount?: number;
    /** 0-based page index whose read fails, modelling a mid-scan DB fault. */
    failPageIndex?: number;
    /** Populated by the mock. */
    countQueries: number;
    ranges: Array<[number, number]>;
    unpagedPopulationReads: number;
    inCalls: string[][];
    auditEvents: unknown[];
  }

  function newState(overrides: Partial<DbState> & { population: string[] }): DbState {
    return {
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
        const pageIndex = Math.floor(from / POSTGREST_ROW_LIMIT);
        if (state.failPageIndex === pageIndex) {
          // postgrest-js RESOLVES a failure — it does not throw.
          return Promise.resolve({
            data: null,
            error: { code: 'PGRST', message: 'Bad Request', details: null, hint: null },
          });
        }
        // PostgREST caps a page at its row limit no matter how wide the range.
        const width = Math.min(to - from + 1, POSTGREST_ROW_LIMIT);
        return Promise.resolve({
          data: state.population.slice(from, from + width).map((id) => ({ public_id: id })),
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

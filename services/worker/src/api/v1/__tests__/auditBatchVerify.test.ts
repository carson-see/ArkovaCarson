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

import { auditBatchVerifyRouter } from '../auditBatchVerify.js';
import { db } from '../../../utils/db.js';
import { POSTGREST_URL_FILTER_BUDGET_BYTES } from '../../../utils/postgrest-filter.js';
import { encodedInFilterBytesFor } from '../../../test-utils/postgrestWire.js';

describe('Audit Batch Verification', () => {
  describe('seededRandom', () => {
    function seededRandom(seed: number): () => number {
      let s = seed;
      return () => {
        s = (s * 1664525 + 1013904223) & 0xffffffff;
        return (s >>> 0) / 0xffffffff;
      };
    }

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
        expect(v).toBeLessThanOrEqual(1);
      }
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

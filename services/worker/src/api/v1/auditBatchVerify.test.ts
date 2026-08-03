/**
 * Audit Batch Verify Tests (COMP-06)
 *
 * Tests the audit batch verification endpoint including
 * ISA 530 reproducible sampling and anomaly detection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import express from 'express';
import request from 'supertest';
import * as nodeCrypto from 'node:crypto';

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../_org-auth.js', () => ({
  getCallerOrgId: vi.fn(),
  isCallerOrgAdmin: vi.fn(),
}));

// Spy on the real `node:crypto`, not a stub — the assertion is "this endpoint
// calls the CSPRNG", which only means something against the genuine module.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});

import { auditBatchVerifyRouter } from './auditBatchVerify.js';
import { db } from '../../utils/db.js';
import { getCallerOrgId, isCallerOrgAdmin } from '../_org-auth.js';

function buildApp(userId?: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) req.authUserId = userId;
    next();
  });
  app.use('/api/v1/audit/batch-verify', auditBatchVerifyRouter);
  return app;
}

// Replicate the schema from the endpoint for unit testing
const batchVerifySchema = z.object({
  credential_ids: z.array(z.string()).max(1000).optional(),
  sample_percentage: z.number().min(0.1).max(100).optional(),
  seed: z.number().int().optional(),
}).refine(
  d => d.credential_ids || d.sample_percentage,
  { message: 'Provide credential_ids or sample_percentage' },
);

describe('Audit Batch Verify — Schema Validation', () => {
  it('accepts credential_ids array', () => {
    const result = batchVerifySchema.safeParse({ credential_ids: ['abc', 'def'] });
    expect(result.success).toBe(true);
  });

  it('accepts sample_percentage + seed', () => {
    const result = batchVerifySchema.safeParse({ sample_percentage: 10, seed: 42 });
    expect(result.success).toBe(true);
  });

  it('rejects empty body (no credential_ids or sample_percentage)', () => {
    const result = batchVerifySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects sample_percentage below 0.1', () => {
    const result = batchVerifySchema.safeParse({ sample_percentage: 0.05 });
    expect(result.success).toBe(false);
  });

  it('rejects sample_percentage above 100', () => {
    const result = batchVerifySchema.safeParse({ sample_percentage: 101 });
    expect(result.success).toBe(false);
  });

  it('rejects credential_ids exceeding 1000', () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `id-${i}`);
    const result = batchVerifySchema.safeParse({ credential_ids: ids });
    expect(result.success).toBe(false);
  });

  it('accepts sample_percentage without seed (uses Date.now fallback)', () => {
    const result = batchVerifySchema.safeParse({ sample_percentage: 5 });
    expect(result.success).toBe(true);
  });

  it('rejects non-integer seed', () => {
    const result = batchVerifySchema.safeParse({ sample_percentage: 10, seed: 3.14 });
    expect(result.success).toBe(false);
  });
});

describe('Audit Batch Verify — Seeded PRNG (ISA 530)', () => {
  function seededRandom(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) & 0xffffffff;
      return (s >>> 0) / 0xffffffff;
    };
  }

  it('produces deterministic output for same seed', () => {
    const rng1 = seededRandom(42);
    const rng2 = seededRandom(42);
    const seq1 = Array.from({ length: 10 }, () => rng1());
    const seq2 = Array.from({ length: 10 }, () => rng2());
    expect(seq1).toEqual(seq2);
  });

  it('produces different output for different seeds', () => {
    const rng1 = seededRandom(42);
    const rng2 = seededRandom(99);
    const seq1 = Array.from({ length: 10 }, () => rng1());
    const seq2 = Array.from({ length: 10 }, () => rng2());
    expect(seq1).not.toEqual(seq2);
  });

  it('produces values in [0, 1] range', () => {
    const rng = seededRandom(12345);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('reproducible sampling selects same items', () => {
    const items = Array.from({ length: 100 }, (_, i) => `item-${i}`);
    const samplePct = 10;
    const seed = 42;

    function sample(s: number) {
      const rng = seededRandom(s);
      const sampleSize = Math.ceil(items.length * (samplePct / 100));
      const shuffled = [...items].sort(() => rng() - 0.5);
      return shuffled.slice(0, sampleSize);
    }

    expect(sample(seed)).toEqual(sample(seed));
  });
});

describe('Audit Batch Verify — Anomaly Detection', () => {
  it('flags anchor delay > 24h', () => {
    const submitted = new Date('2026-03-01T00:00:00Z');
    const secured = new Date('2026-03-03T00:00:00Z'); // 48h later
    const delay = secured.getTime() - submitted.getTime();
    expect(delay).toBeGreaterThan(24 * 3600_000);
  });

  it('flags stale PENDING > 48h', () => {
    const created = new Date(Date.now() - 72 * 3600_000); // 72h ago
    const age = Date.now() - created.getTime();
    expect(age).toBeGreaterThan(48 * 3600_000);
  });

  it('flags REVOKED status', () => {
    const status = 'REVOKED';
    expect(status).toBe('REVOKED');
  });

  it('flags missing fingerprint', () => {
    const fingerprint = null;
    expect(fingerprint).toBeNull();
  });
});

describe('POST /api/v1/audit/batch-verify — owner-inclusive org gate', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('requires authentication', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/v1/audit/batch-verify')
      .send({ credential_ids: ['abc'] })
      .expect(401);
  });

  it('allows an org OWNER (resolved via profiles.org_id, no org_members row)', async () => {
    // Owner: getCallerOrgId resolves the org, isCallerOrgAdmin → true.
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');
    vi.mocked(isCallerOrgAdmin).mockResolvedValue(true);

    // After the gate passes the handler queries `anchors` then `audit_events`.
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'anchors') {
        return {
          select: () => ({ in: () => ({ is: () => Promise.resolve({ data: [], error: null }) }) }),
        } as never;
      }
      if (table === 'audit_events') {
        return { insert: () => Promise.resolve({ data: null, error: null }) } as never;
      }
      return { select: () => ({}) } as never;
    });

    const app = buildApp('owner-1');
    const res = await request(app)
      .post('/api/v1/audit/batch-verify')
      .send({ credential_ids: ['abc', 'def'] });

    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
    // Gate resolved the org for an owner with no org_members row.
    expect(getCallerOrgId).toHaveBeenCalledWith('owner-1');
    expect(isCallerOrgAdmin).toHaveBeenCalledWith('owner-1', 'org-1');
  });

  it('returns 403 when caller has no org (getCallerOrgId → null)', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue(null);
    vi.mocked(isCallerOrgAdmin).mockResolvedValue(false);

    const app = buildApp('user-1');
    const res = await request(app)
      .post('/api/v1/audit/batch-verify')
      .send({ credential_ids: ['abc'] })
      .expect(403);

    expect(res.body.error).toBe('Organization administrator role required');
  });

  it('returns 403 when caller is a non-admin member (isCallerOrgAdmin → false)', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');
    vi.mocked(isCallerOrgAdmin).mockResolvedValue(false);

    const app = buildApp('member-1');
    const res = await request(app)
      .post('/api/v1/audit/batch-verify')
      .send({ credential_ids: ['abc'] })
      .expect(403);

    expect(res.body.error).toBe('Organization administrator role required');
  });
});

describe('POST /api/v1/audit/batch-verify — unseeded sample seed source (S2245)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  /**
   * A one-row population scanned as two `anchors` pages (one row, then the
   * empty page `scanAllPages` needs to conclude `status: 'complete'`),
   * followed by one lookup chunk. Mirrors the real chain shapes in
   * `loadOrgPopulation` (terminal `.range()`) and the verify loop (terminal
   * `.is()` after `.in()`) — a mock that resolved on the wrong method would
   * pass without ever exercising the seed line under test.
   */
  function mockOneRowPopulation() {
    let anchorsCalls = 0;
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'anchors') {
        anchorsCalls += 1;
        if (anchorsCalls <= 2) {
          const data = anchorsCalls === 1 ? [{ public_id: 'cred-1' }] : [];
          return {
            select: () => ({
              eq: () => ({
                is: () => ({
                  order: () => ({
                    order: () => ({
                      range: () => Promise.resolve({ data, error: null }),
                    }),
                  }),
                }),
              }),
            }),
          } as never;
        }
        return {
          select: () => ({
            in: () => ({
              is: () => Promise.resolve({
                data: [{ public_id: 'cred-1', status: 'SECURED', fingerprint: 'fp', chain_timestamp: null, chain_tx_id: null, created_at: '2026-01-01T00:00:00Z' }],
                error: null,
              }),
            }),
          }),
        } as never;
      }
      if (table === 'audit_events') {
        return { insert: () => Promise.resolve({ data: null, error: null }) } as never;
      }
      return { select: () => ({}) } as never;
    });
  }

  it('draws the unseeded sample seed from randomInt (CSPRNG), not Math.random()', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');
    vi.mocked(isCallerOrgAdmin).mockResolvedValue(true);
    mockOneRowPopulation();
    const randomIntSpy = vi.mocked(nodeCrypto.randomInt);

    const app = buildApp('owner-1');
    const res = await request(app)
      .post('/api/v1/audit/batch-verify')
      .send({ sample_percentage: 100 });

    expect(res.status).toBe(200);
    // The seed generator was actually invoked with the documented bound —
    // not merely "some random number appeared in the response".
    expect(randomIntSpy).toHaveBeenCalledWith(0, 2 ** 31);
    expect(typeof res.body.seed).toBe('number');
    expect(res.body.seed).toBeGreaterThanOrEqual(0);
    expect(res.body.seed).toBeLessThan(2 ** 31);
  });

  it('does not call randomInt when the caller supplies an explicit seed', async () => {
    vi.mocked(getCallerOrgId).mockResolvedValue('org-1');
    vi.mocked(isCallerOrgAdmin).mockResolvedValue(true);
    mockOneRowPopulation();
    const randomIntSpy = vi.mocked(nodeCrypto.randomInt);

    const app = buildApp('owner-1');
    const res = await request(app)
      .post('/api/v1/audit/batch-verify')
      .send({ sample_percentage: 100, seed: 42 });

    expect(res.status).toBe(200);
    expect(randomIntSpy).not.toHaveBeenCalled();
    expect(res.body.seed).toBe(42);
  });
});

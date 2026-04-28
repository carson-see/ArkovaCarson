/**
 * SCRUM-1171 (HAKI-REQ-02) — bulk + retroactive anchoring tests.
 *
 * Exercises Zod validation, dry-run short-circuit, intra-batch + DB-level
 * duplicate detection across all four strategies, retroactive metadata
 * preservation, and credit-deduction wiring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../utils/orgCredits.js', () => ({
  deductOrgCredit: vi.fn(),
}));

import { anchorBulkRouter, BulkAnchorRequestSchema } from './anchor-bulk.js';
import { db } from '../../utils/db.js';
import { deductOrgCredit } from '../../utils/orgCredits.js';

const FP = (n: number) => n.toString(16).padStart(64, '0');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { apiKey: { orgId: string; userId: string } }).apiKey = {
      orgId: 'org-1',
      userId: 'user-1',
    };
    next();
  });
  app.use('/api/v1/anchor/bulk', anchorBulkRouter);
  return app;
}

interface Builder {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
}

function makeBuilder(state: {
  selectData?: unknown;
  insertedRow?: unknown;
} = {}): Builder {
  const builder = {} as Builder;
  const chain = () => builder;
  // .in() is the terminal of the duplicate-check chain — make it Promise-resolving
  builder.in = vi.fn(() => Promise.resolve({ data: state.selectData ?? [], error: null })) as unknown as Builder['in'];
  builder.select = vi.fn(chain);
  builder.eq = vi.fn(chain);
  builder.insert = vi.fn(chain);
  builder.single = vi.fn(() => Promise.resolve({ data: state.insertedRow ?? null, error: null })) as unknown as Builder['single'];
  return builder;
}

describe('POST /api/v1/anchor/bulk (SCRUM-1171)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(deductOrgCredit).mockResolvedValue({ allowed: true });
  });

  it('400s on schema violation (bad fingerprint)', async () => {
    const res = await request(buildApp())
      .post('/api/v1/anchor/bulk')
      .send({ anchors: [{ fingerprint: 'not-hex' }] })
      .expect(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('dry_run: validates and reports counts but never inserts', async () => {
    vi.mocked(db.from).mockImplementation(() => makeBuilder({ selectData: [] }) as never);
    const res = await request(buildApp())
      .post('/api/v1/anchor/bulk')
      .send({
        dry_run: true,
        anchors: [
          { fingerprint: FP(1), original_document_date: '2024-01-15T00:00:00Z' },
          { fingerprint: FP(2), document_type: 'contract' },
        ],
      })
      .expect(200);
    expect(res.body.dry_run).toBe(true);
    expect(res.body.validated).toBe(2);
    expect(res.body.queued).toBe(2);
    expect(deductOrgCredit).not.toHaveBeenCalled();
  });

  it('detects intra-batch duplicates and surfaces them in the response', async () => {
    vi.mocked(db.from).mockImplementation(() => makeBuilder({ selectData: [] }) as never);
    const res = await request(buildApp())
      .post('/api/v1/anchor/bulk')
      .send({
        dry_run: true,
        duplicate_strategy: 'skip',
        anchors: [
          { fingerprint: FP(1) },
          { fingerprint: FP(2) },
          { fingerprint: FP(1) }, // duplicate
        ],
      })
      .expect(200);
    expect(res.body.duplicates).toHaveLength(1);
    expect(res.body.duplicates[0].scope).toBe('in_batch');
    expect(res.body.duplicates[0].row).toBe(2);
    // skip strategy: only 2 unique rows queue (FP1 first occurrence + FP2)
    expect(res.body.queued).toBe(2);
  });

  it('409s on duplicates when duplicate_strategy=fail (default)', async () => {
    vi.mocked(db.from).mockImplementation(() =>
      makeBuilder({ selectData: [{ fingerprint: FP(1) }] }) as never,
    );
    const res = await request(buildApp())
      .post('/api/v1/anchor/bulk')
      .send({ anchors: [{ fingerprint: FP(1) }] })
      .expect(409);
    expect(res.body.error).toBe('duplicate_fingerprints');
    expect(res.body.duplicates[0].scope).toBe('in_db');
  });

  it('preserves retroactive metadata distinctly from anchored_at (AC2)', async () => {
    const inserted: Array<{ payload: Record<string, unknown> }> = [];
    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'anchors') {
        const builder = makeBuilder({
          selectData: [],
          insertedRow: {
            public_id: 'ARK-001',
            fingerprint: FP(1),
            created_at: '2026-04-28T13:00:00Z',
          },
        });
        builder.insert = vi.fn((payload) => {
          inserted.push({ payload });
          return builder;
        }) as unknown as typeof builder.insert;
        return builder as unknown as never;
      }
      return makeBuilder() as unknown as never;
    });

    const res = await request(buildApp())
      .post('/api/v1/anchor/bulk')
      .send({
        batch_id: 'haki-import-2024-Q1',
        anchors: [
          {
            fingerprint: FP(1),
            credential_type: 'CERTIFICATE',
            original_document_date: '2024-01-15T00:00:00Z',
            document_type: 'engagement_letter',
            matter_or_case_ref: 'MATTER-7421',
            external_id: 'haki:doc:abc123',
          },
        ],
      })
      .expect(201);

    expect(res.body.queued).toBe(1);
    expect(res.body.anchors[0].original_document_date).toBe('2024-01-15T00:00:00Z');
    expect(res.body.anchors[0].anchored_at).toBe('2026-04-28T13:00:00Z');
    expect(res.body.anchors[0].matter_or_case_ref).toBe('MATTER-7421');
    expect(res.body.anchors[0].external_id).toBe('haki:doc:abc123');

    // Verify metadata JSONB on the insert payload
    const meta = inserted[0].payload.metadata as Record<string, unknown>;
    expect(meta.original_document_date).toBe('2024-01-15T00:00:00Z');
    expect(meta.document_type).toBe('engagement_letter');
    expect(meta.matter_or_case_ref).toBe('MATTER-7421');
    expect(meta.batch_id).toBe('haki-import-2024-Q1');
    expect(meta.bulk_source).toBe('haki-req-02');
  });

  it('402s when org credits are insufficient', async () => {
    vi.mocked(deductOrgCredit).mockResolvedValue({
      allowed: false,
      error: 'insufficient_credits',
      balance: 0,
      required: 2,
    });
    vi.mocked(db.from).mockImplementation(() => makeBuilder({ selectData: [] }) as never);
    const res = await request(buildApp())
      .post('/api/v1/anchor/bulk')
      .send({ anchors: [{ fingerprint: FP(1) }, { fingerprint: FP(2) }] })
      .expect(402);
    expect(res.body.error).toBe('insufficient_credits');
    expect(res.body.required).toBe(2);
  });

  it('schema rejects > 1000 rows (DoS guard)', () => {
    const tooMany = Array.from({ length: 1001 }, (_, i) => ({ fingerprint: FP(i) }));
    const r = BulkAnchorRequestSchema.safeParse({ anchors: tooMany });
    expect(r.success).toBe(false);
  });
});

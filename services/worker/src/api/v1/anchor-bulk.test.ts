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

const mockConfig = vi.hoisted(() => ({
  enableProfessionalEducationSchemaReady: true,
}));
const mockSubmitJob = vi.hoisted(() => vi.fn().mockResolvedValue('job-1'));
const mockQuotaDeltas = vi.hoisted((): number[] => []);
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../config.js', () => ({ config: mockConfig }));
vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));
vi.mock('../../utils/logger.js', () => ({
  logger: mockLogger,
}));
vi.mock('../../middleware/perOrgRateLimit.js', () => ({
  requireOrgQuota: (options: { getDelta?: (req: unknown) => number | Promise<number> }) =>
    async (req: unknown, _res: unknown, next: () => void) => {
      mockQuotaDeltas.push(options.getDelta ? await options.getDelta(req) : 1);
      next();
    },
}));
vi.mock('../../utils/orgCredits.js', () => ({
  deductOrgCredit: vi.fn(),
}));
vi.mock('../../utils/jobQueue.js', () => ({
  submitJob: mockSubmitJob,
}));

import { anchorBulkRouter, BulkAnchorRequestSchema } from './anchor-bulk.js';
import { db } from '../../utils/db.js';
import { deductOrgCredit } from '../../utils/orgCredits.js';
import { POSTGREST_URL_FILTER_BUDGET_BYTES } from '../../utils/postgrest-filter.js';
import { encodedInFilterBytesFor } from '../../test-utils/postgrestWire.js';

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
  /**
   * Terminal of the `organization_field_policies` read added by the DPA
   * clause-4.6 guard (migration 0405). Every case in this file is an org with
   * NO policy row, so it resolves empty and the guard is a no-op — which is
   * the point: adding an org-scoped field policy must not change behaviour for
   * any org that does not have one. Rejection cases live in
   * `anchor-field-policy.test.ts`.
   */
  maybeSingle: ReturnType<typeof vi.fn>;
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
  // No org field policy configured — see the Builder docblock.
  builder.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null })) as unknown as Builder['maybeSingle'];
  return builder;
}

describe('POST /api/v1/anchor/bulk (SCRUM-1171)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuotaDeltas.length = 0;
    mockConfig.enableProfessionalEducationSchemaReady = true;
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
    expect(mockQuotaDeltas).toEqual([]);
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

  it('meters only the deduplicated executable rows', async () => {
    vi.mocked(db.from).mockImplementation(() => makeBuilder({
      selectData: [{ fingerprint: FP(1) }],
      insertedRow: {
        public_id: 'ARK-002',
        fingerprint: FP(2),
        created_at: '2026-04-28T13:00:00Z',
      },
    }) as never);

    const res = await request(buildApp())
      .post('/api/v1/anchor/bulk')
      .send({
        duplicate_strategy: 'skip',
        anchors: [
          { fingerprint: FP(1) },
          { fingerprint: FP(2) },
        ],
      })
      .expect(201);

    expect(res.body.queued).toBe(1);
    expect(mockQuotaDeltas).toEqual([1]);
    expect(deductOrgCredit).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      1,
      'anchor.bulk',
      undefined,
    );
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

  // Regression test (SCRUM-2911 W1): `anchors.filename` is NOT NULL at the DB
  // layer. The insert previously omitted `filename` entirely, so every real
  // (non-mocked) call to this route would fail with a Postgres NOT NULL
  // constraint violation — undetectable by this suite's mocked `db`, which
  // doesn't enforce schema constraints. Pins the fix at the insert-payload
  // level: an explicit filename is passed through verbatim, and a caller that
  // omits it (the original HAKI-REQ-02 bare-fingerprint case) gets a
  // synthetic, non-PII placeholder instead of `undefined`.
  it('always includes a non-empty filename on insert (NOT NULL DB constraint)', async () => {
    const inserted: Array<{ payload: Record<string, unknown> }> = [];
    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'anchors') {
        const builder = makeBuilder({
          selectData: [],
          insertedRow: { public_id: 'ARK-003', fingerprint: FP(3), created_at: '2026-07-28T00:00:00Z' },
        });
        builder.insert = vi.fn((payload) => {
          inserted.push({ payload });
          return builder;
        }) as unknown as typeof builder.insert;
        return builder as unknown as never;
      }
      return makeBuilder() as unknown as never;
    });

    await request(buildApp())
      .post('/api/v1/anchor/bulk')
      .send({
        anchors: [
          { fingerprint: FP(3), filename: 'w2-2025.pdf' },
          { fingerprint: FP(4) }, // no filename supplied
        ],
      })
      .expect(201);

    expect(inserted).toHaveLength(2);
    expect(inserted[0].payload.filename).toBe('w2-2025.pdf');
    expect(typeof inserted[1].payload.filename).toBe('string');
    expect((inserted[1].payload.filename as string).length).toBeGreaterThan(0);
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

  it('reports insert failures using the original request row after duplicate filtering', async () => {
    vi.mocked(db.from).mockImplementation(() => {
      const builder = makeBuilder({
        selectData: [{ fingerprint: FP(1) }],
      });
      builder.single = vi.fn(() => Promise.resolve({
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      })) as unknown as Builder['single'];
      return builder as unknown as never;
    });

    const res = await request(buildApp())
      .post('/api/v1/anchor/bulk')
      .send({
        duplicate_strategy: 'skip',
        anchors: [
          { fingerprint: FP(1) },
          { fingerprint: FP(2) },
        ],
      })
      .expect(201);

    expect(res.body.errors).toEqual([
      expect.objectContaining({ row: 1, code: 'insert_failed' }),
    ]);
    const [logPayload] = mockLogger.error.mock.calls.at(-1) as [Record<string, unknown>, string];
    expect(logPayload).toMatchObject({ pgCode: '23505', batchRow: 1 });
    expect(logPayload).not.toHaveProperty('fingerprint');
    expect(logPayload).not.toHaveProperty('error');
  });

  it('503s CPE bulk submissions before duplicate checks or inserts when professional education schema is not ready', async () => {
    mockConfig.enableProfessionalEducationSchemaReady = false;

    const res = await request(buildApp())
      .post('/api/v1/anchor/bulk')
      .send({
        anchors: [
          {
            fingerprint: FP(1),
            credential_type: 'CPE',
            description: 'CPE certificate',
          },
        ],
      });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('professional_education_schema_unavailable');
    expect(vi.mocked(db.from)).not.toHaveBeenCalled();
    expect(deductOrgCredit).not.toHaveBeenCalled();
    expect(mockSubmitJob).not.toHaveBeenCalled();
  });

  it('keeps existing CLE bulk anchoring available but skips extraction enqueue when schema is not ready', async () => {
    mockConfig.enableProfessionalEducationSchemaReady = false;
    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'anchors') {
        return makeBuilder({
          selectData: [],
          insertedRow: {
            id: '550e8400-e29b-41d4-a716-446655440001',
            public_id: 'ARK-001',
            fingerprint: FP(1),
            credential_type: 'CLE',
            metadata: { credential_title: 'Ethics CLE', bulk_source: 'haki-req-02' },
            created_at: '2026-04-28T13:00:00Z',
          },
        }) as unknown as never;
      }
      return makeBuilder() as unknown as never;
    });

    const res = await request(buildApp())
      .post('/api/v1/anchor/bulk')
      .send({
        anchors: [
          {
            fingerprint: FP(1),
            credential_type: 'CLE',
            description: 'CLE certificate',
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.queued).toBe(1);
    expect(deductOrgCredit).toHaveBeenCalledWith(expect.anything(), 'org-1', 1, 'anchor.bulk', undefined);
    expect(mockSubmitJob).not.toHaveBeenCalled();
  });

  it('schema rejects > 1000 rows (DoS guard)', () => {
    const tooMany = Array.from({ length: 1001 }, (_, i) => ({ fingerprint: FP(i) }));
    const r = BulkAnchorRequestSchema.safeParse({ anchors: tooMany });
    expect(r.success).toBe(false);
  });
});

/**
 * The duplicate-check read is the ONLY thing standing between a re-submitted
 * batch and a second set of anchors that are created AND billed.
 *
 * Two defects met here:
 *
 *  1. The whole `inBatchSeen` key set went into one `.in('fingerprint', …)`.
 *     The Zod cap is 1000 rows of 64-char hex; the URL budget is exhausted at
 *     ~122 of them, so any batch past that took 400 Bad Request.
 *  2. `const { data: existing } = await …` discarded the error. PostgREST
 *     RESOLVES on a 400 (it does not throw), so the `catch` never ran, the
 *     empty result read as "no fingerprint exists yet", every row queued, and
 *     `deductOrgCredit` charged the org for the whole batch.
 *
 * The failure is silent and billable: HTTP 201, duplicates created, invoiced.
 */
describe('POST /api/v1/anchor/bulk — DB duplicate check width + failure policy', () => {
  /** A recorded `.in('fingerprint', …)` call. */
  interface InCall { column: string; values: string[] }

  function makeDedupApp(state: {
    /** Fingerprints (lower-case) that already exist in the org. */
    existing?: string[];
    /** Force every dedup chunk to fail, however narrow it is. */
    failEveryChunk?: boolean;
    inCalls: InCall[];
  }) {
    vi.mocked(db.from).mockImplementation((table: string): never => {
      const builder = {} as Builder;
      const chain = () => builder;
      builder.select = vi.fn(chain);
      builder.eq = vi.fn(chain);
      builder.insert = vi.fn(chain);
      // No org field policy configured — see the Builder docblock.
      builder.maybeSingle = vi.fn(() =>
        Promise.resolve({ data: null, error: null })) as unknown as Builder['maybeSingle'];
      builder.single = vi.fn(() => Promise.resolve({
        data: {
          id: '550e8400-e29b-41d4-a716-446655440001',
          public_id: 'ARK-001',
          fingerprint: FP(999),
          created_at: '2026-08-01T00:00:00Z',
        },
        error: null,
      })) as unknown as Builder['single'];
      builder.in = vi.fn((column: string, values: string[]) => {
        state.inCalls.push({ column, values });
        // The real wire behaviour: PostgREST sits behind a proxy that rejects
        // an oversized request line with 400, and postgrest-js RESOLVES that
        // as `{ data: null, error }` rather than throwing.
        if (state.failEveryChunk || encodedInFilterBytesFor(values) > POSTGREST_URL_FILTER_BUDGET_BYTES) {
          return Promise.resolve({
            data: null,
            error: { code: 'PGRST', message: 'Bad Request', details: null, hint: null },
          });
        }
        // Byte-for-byte, like `character(64)` — NOT a case-insensitive match.
        // A forgiving mock here would hide the casing defect entirely.
        const hits = values
          .filter((v) => (state.existing ?? []).includes(v))
          .map((v) => ({ fingerprint: v }));
        return Promise.resolve({ data: hits, error: null });
      }) as unknown as Builder['in'];
      void table;
      return builder as unknown as never;
    });
    return buildApp();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuotaDeltas.length = 0;
    mockConfig.enableProfessionalEducationSchemaReady = true;
    vi.mocked(deductOrgCredit).mockResolvedValue({ allowed: true });
  });

  it('never exceeds the URL filter budget, however many rows the schema allows', async () => {
    const inCalls: InCall[] = [];
    // The schema's own maximum. Unchunked this is ~67KB of query string.
    const anchors = Array.from({ length: 1000 }, (_, i) => ({ fingerprint: FP(i) }));

    await request(makeDedupApp({ inCalls }))
      .post('/api/v1/anchor/bulk')
      .send({ dry_run: true, duplicate_strategy: 'skip', anchors })
      .expect(200);

    expect(inCalls.length).toBeGreaterThan(1);
    for (const call of inCalls) {
      expect(encodedInFilterBytesFor(call.values)).toBeLessThanOrEqual(
        POSTGREST_URL_FILTER_BUDGET_BYTES,
      );
    }
    // Every submitted fingerprint was actually asked about — chunking must not
    // drop the tail.
    const asked = new Set(inCalls.flatMap((c) => c.values.map((v) => v.toLowerCase())));
    for (const a of anchors) expect(asked.has(a.fingerprint.toLowerCase())).toBe(true);
  });

  it('still finds an existing fingerprint in a batch too wide for one filter', async () => {
    const inCalls: InCall[] = [];
    // 200 rows: past the ~122-value budget for 64-char hex, so the pre-fix
    // single filter 400s and the duplicate goes undetected.
    const anchors = Array.from({ length: 200 }, (_, i) => ({ fingerprint: FP(i) }));
    const collidingRow = 173;

    const res = await request(makeDedupApp({ inCalls, existing: [FP(collidingRow)] }))
      .post('/api/v1/anchor/bulk')
      .send({ duplicate_strategy: 'skip', anchors });

    expect(res.status).toBe(201);
    expect(res.body.duplicates).toEqual([
      expect.objectContaining({ row: collidingRow, scope: 'in_db' }),
    ]);
    // The whole point: the duplicate is NOT queued, so it is not billed twice.
    expect(res.body.queued).toBe(199);
    expect(deductOrgCredit).toHaveBeenCalledWith(expect.anything(), 'org-1', 199, 'anchor.bulk', undefined);
  });

  it('matches an upper-case submission against the lower-cased stored row', async () => {
    const inCalls: InCall[] = [];
    // The insert path lower-cases before writing; the dedup filter used the
    // caller's casing verbatim. `character(64)` compares byte-for-byte, so an
    // upper-case resubmission matched nothing and was re-created and re-billed.
    const stored = FP(0xabcdef); // has hex letters, so casing is observable
    expect(stored.toUpperCase()).not.toBe(stored);

    const res = await request(makeDedupApp({ inCalls, existing: [stored] }))
      .post('/api/v1/anchor/bulk')
      .send({ duplicate_strategy: 'skip', anchors: [{ fingerprint: stored.toUpperCase() }] });

    expect(res.status).toBe(201);
    expect(res.body.duplicates).toEqual([
      expect.objectContaining({ row: 0, scope: 'in_db' }),
    ]);
    expect(res.body.queued).toBe(0);
    expect(deductOrgCredit).not.toHaveBeenCalled();
  });

  it('fails CLOSED when the duplicate check errors — no insert, no charge', async () => {
    const inCalls: InCall[] = [];
    const res = await request(makeDedupApp({ inCalls, failEveryChunk: true }))
      .post('/api/v1/anchor/bulk')
      .send({ duplicate_strategy: 'skip', anchors: [{ fingerprint: FP(1) }, { fingerprint: FP(2) }] });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('duplicate_check_unavailable');
    // A read that failed must never be reported as "no duplicates exist".
    expect(deductOrgCredit).not.toHaveBeenCalled();
    expect(mockQuotaDeltas).toEqual([]);
    expect(mockSubmitJob).not.toHaveBeenCalled();
  });

  it('fails closed on dry_run too — a dry run reporting 0 duplicates is the lie', async () => {
    const inCalls: InCall[] = [];
    const res = await request(makeDedupApp({ inCalls, failEveryChunk: true }))
      .post('/api/v1/anchor/bulk')
      .send({ dry_run: true, duplicate_strategy: 'skip', anchors: [{ fingerprint: FP(1) }] });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('duplicate_check_unavailable');
  });

  it('never logs a fingerprint or a raw driver error when the check fails', async () => {
    const inCalls: InCall[] = [];
    await request(makeDedupApp({ inCalls, failEveryChunk: true }))
      .post('/api/v1/anchor/bulk')
      .send({ anchors: [{ fingerprint: FP(1) }] });

    // It must be logged at all — a refusal nobody can see is its own defect...
    expect(mockLogger.error).toHaveBeenCalled();
    // ...but the log must not carry the fingerprint (§1.1) or the raw driver
    // message, which routinely echoes the offending value back verbatim.
    const logged = JSON.stringify(mockLogger.error.mock.calls);
    expect(logged).not.toContain(FP(1));
    expect(logged).not.toContain('Bad Request');
  });
});

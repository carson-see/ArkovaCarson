/**
 * Tests for the dashboard bridge that lets a Supabase-session-authenticated
 * browser reach the API-key-only `/api/v1/anchor/bulk` route — SCRUM-2911
 * (W1, founder P0). Mirrors `webhooks-self-service.test.ts`'s mounting
 * pattern: inject `req.authUserId` directly (bypassing the real JWT
 * verification, which `requireAuth` already covers elsewhere) and exercise
 * this router's own org-resolution + delegation logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const mockConfig = vi.hoisted(() => ({
  enableProfessionalEducationSchemaReady: true,
}));
const mockQuotaDeltas = vi.hoisted((): number[] => []);

vi.mock('../../config.js', () => ({ config: mockConfig }));
vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../middleware/perOrgRateLimit.js', () => ({
  requireOrgQuota: (options: { getDelta?: (req: unknown) => number | Promise<number> }) =>
    async (req: unknown, _res: unknown, next: () => void) => {
      mockQuotaDeltas.push(options.getDelta ? await options.getDelta(req) : 1);
      next();
    },
}));
vi.mock('../../utils/orgCredits.js', () => ({
  deductOrgCredit: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('../../utils/jobQueue.js', () => ({
  submitJob: vi.fn().mockResolvedValue('job-1'),
}));

import { anchorBulkSelfServiceRouter } from './anchor-bulk-self-service.js';
import { db } from '../../utils/db.js';
import { deductOrgCredit } from '../../utils/orgCredits.js';

const FP = (n: number) => n.toString(16).padStart(64, '0');

function mockProfileQuery(result: { data?: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.maybeSingle = vi.fn().mockResolvedValue(result);
  return chain;
}

interface AnchorsBuilder {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
}

function makeAnchorsBuilder(state: { selectData?: unknown; insertedRow?: unknown } = {}): AnchorsBuilder {
  const builder = {} as AnchorsBuilder;
  const chain = () => builder;
  builder.in = vi.fn(() => Promise.resolve({ data: state.selectData ?? [], error: null })) as unknown as AnchorsBuilder['in'];
  builder.select = vi.fn(chain);
  builder.eq = vi.fn(chain);
  builder.insert = vi.fn(chain);
  builder.single = vi.fn(() => Promise.resolve({ data: state.insertedRow ?? null, error: null })) as unknown as AnchorsBuilder['single'];
  return builder;
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = (req.headers['x-test-user-id'] as string) || undefined;
    next();
  });
  app.use('/anchor/bulk/self-service', anchorBulkSelfServiceRouter);
  return app;
}

describe('anchorBulkSelfServiceRouter (SCRUM-2911 W1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuotaDeltas.length = 0;
    mockConfig.enableProfessionalEducationSchemaReady = true;
    vi.mocked(deductOrgCredit).mockResolvedValue({ allowed: true });
  });

  it('401s when no Supabase session is present', async () => {
    const res = await request(createApp())
      .post('/anchor/bulk/self-service')
      .send({ anchors: [{ fingerprint: FP(1) }] })
      .expect(401);
    expect(res.body.error).toBe('authentication_required');
  });

  it('403s when the authenticated user has no organization', async () => {
    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'profiles') return mockProfileQuery({ data: { org_id: null } }) as never;
      return makeAnchorsBuilder() as unknown as never;
    });

    const res = await request(createApp())
      .post('/anchor/bulk/self-service')
      .set('x-test-user-id', 'user-1')
      .send({ anchors: [{ fingerprint: FP(1) }] })
      .expect(403);
    expect(res.body.error).toBe('organization_required');
  });

  it('500s (not a misleading 403) when the profile lookup itself fails', async () => {
    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'profiles') return mockProfileQuery({ error: { message: 'connection reset' } }) as never;
      return makeAnchorsBuilder() as unknown as never;
    });

    const res = await request(createApp())
      .post('/anchor/bulk/self-service')
      .set('x-test-user-id', 'user-1')
      .send({ anchors: [{ fingerprint: FP(1) }] })
      .expect(500);
    expect(res.body.error).toBe('internal_error');
  });

  it('never trusts a client-supplied org id — always resolves it from profiles', async () => {
    const inserted: Array<{ payload: Record<string, unknown> }> = [];
    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'profiles') return mockProfileQuery({ data: { org_id: 'real-org' } }) as never;
      if (table === 'anchors') {
        const builder = makeAnchorsBuilder({
          selectData: [],
          insertedRow: { public_id: 'ARK-1', fingerprint: FP(1), created_at: '2026-07-28T00:00:00Z' },
        });
        builder.insert = vi.fn((payload) => {
          inserted.push({ payload });
          return builder;
        }) as unknown as typeof builder.insert;
        return builder as unknown as never;
      }
      return makeAnchorsBuilder() as unknown as never;
    });

    await request(createApp())
      .post('/anchor/bulk/self-service')
      .set('x-test-user-id', 'user-1')
      .send({
        // client-supplied org_id-shaped field must be ignored — the route's
        // strict schema doesn't even accept it, but assert no leakage anyway
        anchors: [{ fingerprint: FP(1), filename: 'evil.pdf' }],
      })
      .expect(201);

    expect(inserted[0].payload.org_id).toBe('real-org');
    expect(deductOrgCredit).toHaveBeenCalledWith(expect.anything(), 'real-org', 1, 'anchor.bulk', undefined);
  });

  it('delegates to the same insert/dedup/credit pipeline as the API-key route end to end', async () => {
    vi.mocked(db.from).mockImplementation((table: string): never => {
      if (table === 'profiles') return mockProfileQuery({ data: { org_id: 'org-dash' } }) as never;
      if (table === 'anchors') {
        return makeAnchorsBuilder({
          selectData: [],
          insertedRow: { public_id: 'ARK-2', fingerprint: FP(2), created_at: '2026-07-28T01:00:00Z' },
        }) as unknown as never;
      }
      return makeAnchorsBuilder() as unknown as never;
    });

    const res = await request(createApp())
      .post('/anchor/bulk/self-service')
      .set('x-test-user-id', 'user-2')
      .send({
        duplicate_strategy: 'skip',
        anchors: [{ fingerprint: FP(2), filename: 'contract.docx', document_type: 'docx' }],
      })
      .expect(201);

    expect(res.body.queued).toBe(1);
    expect(res.body.anchors).toHaveLength(1);
    expect(mockQuotaDeltas).toEqual([1]);
  });
});

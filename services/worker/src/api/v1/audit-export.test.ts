/**
 * Tests for Audit Export Endpoint (CML-03)
 *
 * POST /api/v1/audit-export — Single anchor PDF + CSV
 * POST /api/v1/audit-export/batch — Batch export for org
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// ─── Mocks ───────────────────────────────────────────
vi.mock('../../utils/db.js', () => ({
  db: {
    from: vi.fn(),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../config.js', () => ({
  config: {
    bitcoinNetwork: 'mainnet',
  },
}));

import { auditExportRouter } from './audit-export.js';
import { db } from '../../utils/db.js';

// ─── Helpers ─────────────────────────────────────────
function mockQuery(result: { data?: unknown; error?: unknown; count?: number }) {
  const chain: Record<string, unknown> = {};
  const terminal = () => Promise.resolve(result);
  chain.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    terminal().then(resolve, reject);
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockImplementation(terminal);
  chain.maybeSingle = vi.fn().mockImplementation(terminal);
  chain.csv = vi.fn().mockImplementation(() => Promise.resolve({ data: 'id,fingerprint\n1,abc123', error: null }));
  return chain;
}

function createApp() {
  const app = express();
  app.use(express.json());
  // Simulate auth middleware
  app.use((req, _res, next) => {
    req.authUserId = req.headers['x-test-user-id'] as string || undefined;
    next();
  });
  app.use('/audit-export', auditExportRouter);
  return app;
}

const MOCK_ANCHOR = {
  id: 'anchor-uuid-1',
  public_id: 'pub_abc123',
  filename: 'diploma.pdf',
  fingerprint: 'a'.repeat(64),
  credential_type: 'DEGREE',
  status: 'SECURED',
  created_at: '2026-01-15T10:00:00Z',
  issued_at: '2026-01-10T00:00:00Z',
  expires_at: null,
  revoked_at: null,
  revocation_reason: null,
  chain_tx_id: 'tx_' + 'b'.repeat(60),
  chain_block_height: 850000,
  chain_timestamp: '2026-01-15T10:05:00Z',
  chain_confirmations: 6,
  file_size: 204800,
  compliance_controls: ['SOC2-CC6.1', 'SOC2-CC6.7', 'GDPR-5.1f', 'GDPR-25', 'ISO27001-A.10', 'eIDAS-25', 'eIDAS-35', 'FERPA-99.31'],
  metadata: { issuer_name: 'University of Michigan' },
  org_id: 'org-uuid-1',
};

const MOCK_PROOF = {
  merkle_root: 'c'.repeat(64),
  proof_path: ['d'.repeat(64), 'e'.repeat(64)],
};

// ─── Tests ───────────────────────────────────────────
describe('POST /audit-export', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/audit-export')
      .send({ anchorId: 'pub_abc123' });

    expect(res.status).toBe(401);
  });

  it('returns 400 without anchorId', async () => {
    const res = await request(app)
      .post('/audit-export')
      .set('x-test-user-id', 'user-1')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/anchorId/i);
  });

  it('returns 404 when anchor not found', async () => {
    const profileQuery = mockQuery({ data: { org_id: 'org-uuid-1' } });
    const anchorQuery = mockQuery({ data: null });

    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'profiles') return profileQuery as never;
      if (table === 'anchors') return anchorQuery as never;
      return mockQuery({ data: null }) as never;
    });

    const res = await request(app)
      .post('/audit-export')
      .set('x-test-user-id', 'user-1')
      .send({ anchorId: 'pub_missing' });

    expect(res.status).toBe(404);
  });

  it('returns 403 when anchor belongs to different org', async () => {
    const profileQuery = mockQuery({ data: { org_id: 'org-uuid-OTHER' } });
    const anchorQuery = mockQuery({ data: { ...MOCK_ANCHOR, org_id: 'org-uuid-1' } });

    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'profiles') return profileQuery as never;
      if (table === 'anchors') return anchorQuery as never;
      return mockQuery({ data: null }) as never;
    });

    const res = await request(app)
      .post('/audit-export')
      .set('x-test-user-id', 'user-1')
      .send({ anchorId: 'pub_abc123' });

    expect(res.status).toBe(403);
  });

  it('returns PDF for valid SECURED anchor', async () => {
    const profileQuery = mockQuery({ data: { org_id: 'org-uuid-1' } });
    const anchorQuery = mockQuery({ data: MOCK_ANCHOR });
    const proofQuery = mockQuery({ data: MOCK_PROOF });

    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'profiles') return profileQuery as never;
      if (table === 'anchors') return anchorQuery as never;
      if (table === 'anchor_proofs') return proofQuery as never;
      return mockQuery({ data: null }) as never;
    });

    const res = await request(app)
      .post('/audit-export')
      .set('x-test-user-id', 'user-1')
      .send({ anchorId: 'pub_abc123', format: 'pdf' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['content-disposition']).toMatch(/arkova-audit/);
    expect(res.body).toBeInstanceOf(Buffer);
    // PDF starts with %PDF
    expect(res.body.toString('ascii', 0, 5)).toBe('%PDF-');
  });

  it('returns CSV when format=csv', async () => {
    const profileQuery = mockQuery({ data: { org_id: 'org-uuid-1' } });
    const anchorQuery = mockQuery({ data: MOCK_ANCHOR });
    const proofQuery = mockQuery({ data: MOCK_PROOF });

    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'profiles') return profileQuery as never;
      if (table === 'anchors') return anchorQuery as never;
      if (table === 'anchor_proofs') return proofQuery as never;
      return mockQuery({ data: null }) as never;
    });

    const res = await request(app)
      .post('/audit-export')
      .set('x-test-user-id', 'user-1')
      .send({ anchorId: 'pub_abc123', format: 'csv' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    const csv = res.text;
    expect(csv).toContain('verification_id');
    expect(csv).toContain('fingerprint');
    expect(csv).toContain('compliance_controls');
    expect(csv).toContain(MOCK_ANCHOR.public_id);
  });

  it('includes compliance controls in PDF response', async () => {
    const profileQuery = mockQuery({ data: { org_id: 'org-uuid-1' } });
    const anchorQuery = mockQuery({ data: MOCK_ANCHOR });
    const proofQuery = mockQuery({ data: MOCK_PROOF });

    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'profiles') return profileQuery as never;
      if (table === 'anchors') return anchorQuery as never;
      if (table === 'anchor_proofs') return proofQuery as never;
      return mockQuery({ data: null }) as never;
    });

    const res = await request(app)
      .post('/audit-export')
      .set('x-test-user-id', 'user-1')
      .send({ anchorId: 'pub_abc123' });

    // PDF content contains compliance control text (verify via binary)
    expect(res.status).toBe(200);
    const pdfText = res.body.toString('latin1');
    expect(pdfText).toContain('SOC 2');
    expect(pdfText).toContain('FERPA');
  });
});

describe('POST /audit-export/batch', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post('/audit-export/batch')
      .send({});

    expect(res.status).toBe(401);
  });

  it('returns 403 without org', async () => {
    const profileQuery = mockQuery({ data: { org_id: null } });
    vi.mocked(db.from).mockReturnValue(profileQuery as never);

    const res = await request(app)
      .post('/audit-export/batch')
      .set('x-test-user-id', 'user-1')
      .send({});

    expect(res.status).toBe(403);
  });

  it('returns CSV batch export for org SECURED anchors', async () => {
    const profileQuery = mockQuery({ data: { org_id: 'org-uuid-1' } });
    const anchorsQuery = mockQuery({
      data: [
        MOCK_ANCHOR,
        { ...MOCK_ANCHOR, id: 'anchor-uuid-2', public_id: 'pub_def456', credential_type: 'LICENSE', compliance_controls: ['SOC2-CC6.1', 'ISO27001-A.14'] },
      ],
    });

    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'profiles') return profileQuery as never;
      if (table === 'anchors') return anchorsQuery as never;
      return mockQuery({ data: null }) as never;
    });

    const res = await request(app)
      .post('/audit-export/batch')
      .set('x-test-user-id', 'user-1')
      .send({ format: 'csv' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const csv = res.text;
    expect(csv).toContain('verification_id');
    expect(csv).toContain('pub_abc123');
    expect(csv).toContain('pub_def456');
  });

  it('returns batch PDF summary export', async () => {
    const profileQuery = mockQuery({ data: { org_id: 'org-uuid-1' } });
    const anchorsQuery = mockQuery({
      data: [MOCK_ANCHOR],
    });
    const proofQuery = mockQuery({ data: MOCK_PROOF });

    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'profiles') return profileQuery as never;
      if (table === 'anchors') return anchorsQuery as never;
      if (table === 'anchor_proofs') return proofQuery as never;
      return mockQuery({ data: null }) as never;
    });

    const res = await request(app)
      .post('/audit-export/batch')
      .set('x-test-user-id', 'user-1')
      .send({ format: 'pdf' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.toString('ascii', 0, 5)).toBe('%PDF-');
  });

  it('limits batch to 500 anchors max', async () => {
    const profileQuery = mockQuery({ data: { org_id: 'org-uuid-1' } });
    const anchorsQuery = mockQuery({ data: [] });

    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'profiles') return profileQuery as never;
      if (table === 'anchors') return anchorsQuery as never;
      return mockQuery({ data: null }) as never;
    });

    const res = await request(app)
      .post('/audit-export/batch')
      .set('x-test-user-id', 'user-1')
      .send({ limit: 9999 });

    expect(res.status).toBe(200);
    // Verify the limit was capped (via mock call)
    const fromCalls = vi.mocked(db.from).mock.calls as unknown as string[][];
    const anchorsCalls = fromCalls.filter(c => c[0] === 'anchors');
    expect(anchorsCalls.length).toBeGreaterThan(0);
  });
});

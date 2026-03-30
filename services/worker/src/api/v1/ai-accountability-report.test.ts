/**
 * VAI-03: AI Accountability Report Tests
 *
 * Tests for POST /api/v1/ai-accountability-report
 * One-click provenance export: Source Hash → AI Model → Human Override → On-Chain Anchor
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock db
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
    debug: vi.fn(),
  },
}));

vi.mock('../../config.js', () => ({
  config: {
    bitcoinNetwork: 'mainnet',
  },
}));

import { aiAccountabilityReportRouter } from './ai-accountability-report.js';
import { db } from '../../utils/db.js';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
const TEST_ORG_ID = '00000000-0000-0000-0000-000000000099';
const VALID_FINGERPRINT = 'a'.repeat(64);
const TEST_ANCHOR_ID = '00000000-0000-0000-0000-000000000042';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = TEST_USER_ID;
    next();
  });
  app.use('/', aiAccountabilityReportRouter);
  return app;
}

/** Build a Supabase-style mock chain */
function mockChain(data: unknown, error: unknown = null) {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'in', 'order', 'limit', 'not', 'single', 'insert', 'update'];
  for (const method of methods) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  Object.defineProperty(chain, 'then', {
    value: (resolve: (v: unknown) => void) => {
      resolve({ data, error });
      return Promise.resolve({ data, error });
    },
  });
  return chain;
}

const MOCK_MANIFEST = {
  id: '00000000-0000-0000-0000-000000000010',
  fingerprint: VALID_FINGERPRINT,
  model_id: 'gemini',
  model_version: 'gemini-2.5-flash',
  extracted_fields: { credentialType: 'DEGREE', issuerName: 'MIT', issuedDate: '2024-06-15' },
  confidence_scores: { overall: 0.87, grounding: 0.92, fields: { issuerName: 0.95 } },
  manifest_hash: 'b'.repeat(64),
  anchor_id: TEST_ANCHOR_ID,
  extraction_timestamp: '2026-03-29T12:00:00.000Z',
  prompt_version: 'abc123',
  created_at: '2026-03-29T12:00:00.000Z',
};

const MOCK_ANCHOR = {
  id: TEST_ANCHOR_ID,
  public_id: 'pub_123',
  fingerprint: VALID_FINGERPRINT,
  status: 'SECURED',
  chain_tx_id: 'tx_abc123def',
  chain_block_height: 887654,
  chain_timestamp: '2026-03-29T13:00:00.000Z',
  credential_type: 'DEGREE',
  filename: 'degree.pdf',
  metadata: { _extraction_manifest_hash: 'b'.repeat(64) },
  created_at: '2026-03-29T11:00:00.000Z',
  compliance_controls: ['SOC2-CC6.1', 'GDPR-5.1f'],
};

const MOCK_AUDIT_EVENTS = [
  { event_type: 'anchor.submitted', details: 'Submitted to Bitcoin', created_at: '2026-03-29T12:30:00Z' },
  { event_type: 'anchor.secured', details: 'Confirmed at block 887654', created_at: '2026-03-29T13:00:00Z' },
];

describe('ai-accountability-report endpoint', () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 without auth', async () => {
    const noAuthApp = express();
    noAuthApp.use(express.json());
    noAuthApp.use('/', aiAccountabilityReportRouter);

    const res = await request(noAuthApp).post('/').send({ anchorId: 'pub_123' });
    expect(res.status).toBe(401);
  });

  it('returns 400 without anchorId', async () => {
    const res = await request(app).post('/').send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 when anchor not found', async () => {
    vi.mocked(db.from).mockImplementation((...args: unknown[]) => {
      if ((args as unknown as string[])[0] === 'profiles') {
        return mockChain({ org_id: TEST_ORG_ID }) as unknown as ReturnType<typeof db.from>;
      }
      // anchors — not found
      return mockChain(null) as unknown as ReturnType<typeof db.from>;
    });

    const res = await request(app).post('/').send({ anchorId: 'pub_nonexistent' });
    expect(res.status).toBe(404);
  });

  it('generates PDF accountability report', async () => {
    vi.mocked(db.from).mockImplementation((...args: unknown[]) => {
      const table = (args as unknown as string[])[0];
      if (table === 'profiles') {
        return mockChain({ org_id: TEST_ORG_ID }) as unknown as ReturnType<typeof db.from>;
      }
      if (table === 'anchors') {
        return mockChain(MOCK_ANCHOR) as unknown as ReturnType<typeof db.from>;
      }
      if (table === 'extraction_manifests') {
        return mockChain([MOCK_MANIFEST]) as unknown as ReturnType<typeof db.from>;
      }
      if (table === 'audit_events') {
        return mockChain(MOCK_AUDIT_EVENTS) as unknown as ReturnType<typeof db.from>;
      }
      return mockChain([]) as unknown as ReturnType<typeof db.from>;
    });

    const res = await request(app)
      .post('/')
      .send({ anchorId: 'pub_123', format: 'pdf' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    // PDF magic bytes
    expect(res.body.toString().startsWith('%PDF')).toBe(true);
  });

  it('generates JSON accountability report', async () => {
    vi.mocked(db.from).mockImplementation((...args: unknown[]) => {
      const table = (args as unknown as string[])[0];
      if (table === 'profiles') {
        return mockChain({ org_id: TEST_ORG_ID }) as unknown as ReturnType<typeof db.from>;
      }
      if (table === 'anchors') {
        return mockChain(MOCK_ANCHOR) as unknown as ReturnType<typeof db.from>;
      }
      if (table === 'extraction_manifests') {
        return mockChain([MOCK_MANIFEST]) as unknown as ReturnType<typeof db.from>;
      }
      if (table === 'audit_events') {
        return mockChain(MOCK_AUDIT_EVENTS) as unknown as ReturnType<typeof db.from>;
      }
      return mockChain([]) as unknown as ReturnType<typeof db.from>;
    });

    const res = await request(app)
      .post('/')
      .send({ anchorId: 'pub_123', format: 'json' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body.provenanceChain).toBeDefined();
    expect(res.body.provenanceChain.sourceHash).toBe(VALID_FINGERPRINT);
    expect(res.body.provenanceChain.aiExtraction.modelId).toBe('gemini');
    expect(res.body.provenanceChain.aiExtraction.manifestHash).toBe('b'.repeat(64));
    expect(res.body.provenanceChain.blockchainAnchor.networkReceipt).toBe('tx_abc123def');
    expect(res.body.provenanceChain.blockchainAnchor.blockHeight).toBe(887654);
    expect(res.body.complianceControls).toContain('SOC2-CC6.1');
  });

  it('includes audit events in report', async () => {
    vi.mocked(db.from).mockImplementation((...args: unknown[]) => {
      const table = (args as unknown as string[])[0];
      if (table === 'profiles') {
        return mockChain({ org_id: TEST_ORG_ID }) as unknown as ReturnType<typeof db.from>;
      }
      if (table === 'anchors') {
        return mockChain(MOCK_ANCHOR) as unknown as ReturnType<typeof db.from>;
      }
      if (table === 'extraction_manifests') {
        return mockChain([MOCK_MANIFEST]) as unknown as ReturnType<typeof db.from>;
      }
      if (table === 'audit_events') {
        return mockChain(MOCK_AUDIT_EVENTS) as unknown as ReturnType<typeof db.from>;
      }
      return mockChain([]) as unknown as ReturnType<typeof db.from>;
    });

    const res = await request(app)
      .post('/')
      .send({ anchorId: 'pub_123', format: 'json' });

    expect(res.status).toBe(200);
    expect(res.body.lifecycleEvents).toHaveLength(2);
    expect(res.body.lifecycleEvents[0].event_type).toBe('anchor.submitted');
  });

  it('handles anchor without extraction manifest', async () => {
    vi.mocked(db.from).mockImplementation((...args: unknown[]) => {
      const table = (args as unknown as string[])[0];
      if (table === 'profiles') {
        return mockChain({ org_id: TEST_ORG_ID }) as unknown as ReturnType<typeof db.from>;
      }
      if (table === 'anchors') {
        return mockChain({ ...MOCK_ANCHOR, metadata: {} }) as unknown as ReturnType<typeof db.from>;
      }
      if (table === 'extraction_manifests') {
        return mockChain([]) as unknown as ReturnType<typeof db.from>;
      }
      if (table === 'audit_events') {
        return mockChain([]) as unknown as ReturnType<typeof db.from>;
      }
      return mockChain([]) as unknown as ReturnType<typeof db.from>;
    });

    const res = await request(app)
      .post('/')
      .send({ anchorId: 'pub_123', format: 'json' });

    expect(res.status).toBe(200);
    expect(res.body.provenanceChain.aiExtraction).toBeNull();
  });
});

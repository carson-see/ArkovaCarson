/**
 * VAI-01: AI Provenance Query Endpoint Tests
 *
 * Tests for GET /api/v1/ai/provenance/:fingerprint
 * Verifies the queryable provenance chain: Source → AI → Anchor.
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

import { aiProvenanceRouter } from './ai-provenance.js';
import { db } from '../../utils/db.js';

const VALID_FINGERPRINT = 'a'.repeat(64);
const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
const TEST_ORG_ID = '00000000-0000-0000-0000-000000000099';
const TEST_ANCHOR_ID = '00000000-0000-0000-0000-000000000042';

function createApp() {
  const app = express();
  app.use(express.json());
  // Inject auth
  app.use((req, _res, next) => {
    req.authUserId = TEST_USER_ID;
    next();
  });
  app.use('/', aiProvenanceRouter);
  return app;
}

/** Helper to build a mock chain for Supabase queries */
function mockChain(data: unknown, error: unknown = null) {
  const chain: Record<string, unknown> = {};
  const methods = ['select', 'eq', 'in', 'order', 'limit', 'not', 'single'];
  for (const method of methods) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  // Terminal: resolve to { data, error }
  chain.then = (resolve: (v: unknown) => void) => {
    resolve({ data, error });
    return { catch: vi.fn() };
  };
  // Make it thenable for await
  Object.defineProperty(chain, 'then', {
    value: (resolve: (v: unknown) => void) => {
      resolve({ data, error });
      return Promise.resolve({ data, error });
    },
  });
  return chain;
}

describe('ai-provenance endpoint', () => {
  const app = createApp();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 without auth', async () => {
    const noAuthApp = express();
    noAuthApp.use(express.json());
    noAuthApp.use('/', aiProvenanceRouter);

    const res = await request(noAuthApp).get(`/${VALID_FINGERPRINT}`);
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid fingerprint', async () => {
    const res = await request(app).get('/not-a-valid-hash');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid fingerprint');
  });

  it('returns 400 for too-short fingerprint', async () => {
    const res = await request(app).get('/abc123');
    expect(res.status).toBe(400);
  });

  it('returns 404 when no manifests found', async () => {
    const fromCalls: unknown[][] = [];
    vi.mocked(db.from).mockImplementation((...args: unknown[]) => {
      fromCalls.push(args);
      if ((args as unknown as string[])[0] === 'profiles') {
        return mockChain({ org_id: TEST_ORG_ID }) as unknown as ReturnType<typeof db.from>;
      }
      // extraction_manifests — empty
      return mockChain([]) as unknown as ReturnType<typeof db.from>;
    });

    const res = await request(app).get(`/${VALID_FINGERPRINT}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('returns provenance chain for valid fingerprint', async () => {
    const mockManifest = {
      id: '00000000-0000-0000-0000-000000000010',
      fingerprint: VALID_FINGERPRINT,
      model_id: 'gemini',
      model_version: 'gemini-2.5-flash',
      extracted_fields: { credentialType: 'DEGREE', issuerName: 'MIT' },
      confidence_scores: { overall: 0.87, grounding: 0.92 },
      manifest_hash: 'b'.repeat(64),
      anchor_id: TEST_ANCHOR_ID,
      extraction_timestamp: '2026-03-29T12:00:00.000Z',
      prompt_version: 'abc123',
      created_at: '2026-03-29T12:00:00.000Z',
    };

    const mockAnchor = {
      id: TEST_ANCHOR_ID,
      public_id: 'pub_123',
      fingerprint: VALID_FINGERPRINT,
      status: 'SECURED',
      chain_tx_id: 'tx_abc',
      chain_block_height: 12345,
      chain_timestamp: '2026-03-29T13:00:00.000Z',
      credential_type: 'DEGREE',
      created_at: '2026-03-29T11:00:00.000Z',
    };

    vi.mocked(db.from).mockImplementation((...args: unknown[]) => {
      if ((args as unknown as string[])[0] === 'profiles') {
        return mockChain({ org_id: TEST_ORG_ID }) as unknown as ReturnType<typeof db.from>;
      }
      if ((args as unknown as string[])[0] === 'extraction_manifests') {
        return mockChain([mockManifest]) as unknown as ReturnType<typeof db.from>;
      }
      if ((args as unknown as string[])[0] === 'anchors') {
        return mockChain([mockAnchor]) as unknown as ReturnType<typeof db.from>;
      }
      return mockChain([]) as unknown as ReturnType<typeof db.from>;
    });

    const res = await request(app).get(`/${VALID_FINGERPRINT}`);
    expect(res.status).toBe(200);
    expect(res.body.fingerprint).toBe(VALID_FINGERPRINT);
    expect(res.body.manifestCount).toBe(1);
    expect(res.body.provenanceChain).toHaveLength(1);

    const chain = res.body.provenanceChain[0];
    expect(chain.sourceHash).toBe(VALID_FINGERPRINT);
    expect(chain.extraction.modelId).toBe('gemini');
    expect(chain.extraction.modelVersion).toBe('gemini-2.5-flash');
    expect(chain.extraction.manifestHash).toBe('b'.repeat(64));
    expect(chain.extraction.extractedFields.issuerName).toBe('MIT');
    expect(chain.extraction.confidenceScores.overall).toBe(0.87);
    expect(chain.anchor).not.toBeNull();
    expect(chain.anchor.status).toBe('SECURED');
    expect(chain.anchor.networkReceipt).toBe('tx_abc');
    expect(chain.anchor.blockHeight).toBe(12345);
  });

  it('returns provenance chain without anchor when not yet linked', async () => {
    const mockManifest = {
      id: '00000000-0000-0000-0000-000000000011',
      fingerprint: VALID_FINGERPRINT,
      model_id: 'nessie',
      model_version: 'nessie-v2',
      extracted_fields: { credentialType: 'LICENSE' },
      confidence_scores: { overall: 0.75 },
      manifest_hash: 'c'.repeat(64),
      anchor_id: null,
      extraction_timestamp: '2026-03-29T12:00:00.000Z',
      prompt_version: null,
      created_at: '2026-03-29T12:00:00.000Z',
    };

    vi.mocked(db.from).mockImplementation((...args: unknown[]) => {
      if ((args as unknown as string[])[0] === 'profiles') {
        return mockChain({ org_id: TEST_ORG_ID }) as unknown as ReturnType<typeof db.from>;
      }
      if ((args as unknown as string[])[0] === 'extraction_manifests') {
        return mockChain([mockManifest]) as unknown as ReturnType<typeof db.from>;
      }
      return mockChain([]) as unknown as ReturnType<typeof db.from>;
    });

    const res = await request(app).get(`/${VALID_FINGERPRINT}`);
    expect(res.status).toBe(200);
    expect(res.body.provenanceChain[0].anchor).toBeNull();
    expect(res.body.provenanceChain[0].extraction.modelId).toBe('nessie');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/db.js', () => ({
  db: {
    from: vi.fn(),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { db } from '../../utils/db.js';
import { Request, Response } from 'express';
import { anchorExtractionManifestRouter } from './anchor-extraction-manifest.js';

function getGetHandler() {
  const layer = (anchorExtractionManifestRouter as { stack: Array<{ route?: { path: string; methods: { get: boolean }; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack
    .find((l) => l.route?.path === '/:publicId/extraction-manifest' && l.route?.methods?.get);
  return layer?.route?.stack[0].handle;
}

function createMockReqRes(params: Record<string, string> = {}) {
  const req = {
    params,
    apiKey: { keyId: 'key-1', orgId: 'org-1', userId: 'user-1', scopes: ['verify'], rateLimitTier: 'paid' as const, keyPrefix: 'ak_' },
  } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

describe('GET /anchor/:publicId/extraction-manifest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 for missing publicId', async () => {
    const handler = getGetHandler();
    const { req, res } = createMockReqRes({ publicId: '' });
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when anchor not found', async () => {
    const handler = getGetHandler();
    const { req, res } = createMockReqRes({ publicId: 'ARK-NONEXIST-001' });

    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } }),
        }),
      }),
    });

    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 404 when no manifest found for anchor fingerprint', async () => {
    const handler = getGetHandler();
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-TEST-001' });

    (db.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'anchors') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { fingerprint: 'a'.repeat(64) },
                error: null,
              }),
            }),
          }),
        };
      }
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          }),
        }),
      };
    });

    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns manifest for valid anchor with extraction manifest', async () => {
    const handler = getGetHandler();
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-TEST-001' });

    const mockManifest = {
      fingerprint: 'a'.repeat(64),
      model_id: 'gemini',
      model_version: 'gemini-3-flash',
      extracted_fields: { credentialType: 'DEGREE', issuerName: 'MIT' },
      confidence_scores: { overall: 0.92 },
      manifest_hash: 'b'.repeat(64),
      prompt_version: 'v6',
      extraction_timestamp: '2026-03-10T08:00:00Z',
      zk_proof: null,
      zk_circuit_version: null,
    };

    (db.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'anchors') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { fingerprint: 'a'.repeat(64) },
                error: null,
              }),
            }),
          }),
        };
      }
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: [mockManifest], error: null }),
            }),
          }),
        }),
      };
    });

    await handler!(req, res);

    expect(res.json).toHaveBeenCalledWith({
      public_id: 'ARK-2026-TEST-001',
      manifest: {
        fingerprint: 'a'.repeat(64),
        model_id: 'gemini',
        model_version: 'gemini-3-flash',
        extracted_fields: { credentialType: 'DEGREE', issuerName: 'MIT' },
        confidence_scores: { overall: 0.92 },
        manifest_hash: 'b'.repeat(64),
        prompt_version: 'v6',
        extraction_timestamp: '2026-03-10T08:00:00Z',
        zk_proof: null,
        zk_circuit_version: null,
      },
    });
  });

  it('does not expose user_id or org_id in response', async () => {
    const handler = getGetHandler();
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-TEST-001' });

    const mockManifest = {
      fingerprint: 'a'.repeat(64),
      model_id: 'gemini',
      model_version: 'gemini-3-flash',
      extracted_fields: {},
      confidence_scores: { overall: 0.5 },
      manifest_hash: 'c'.repeat(64),
      prompt_version: 'v5',
      extraction_timestamp: '2026-03-10T08:00:00Z',
      zk_proof: null,
      zk_circuit_version: null,
      user_id: 'secret-user-id',
      org_id: 'secret-org-id',
      id: 'internal-uuid',
    };

    (db.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === 'anchors') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { fingerprint: 'a'.repeat(64) },
                error: null,
              }),
            }),
          }),
        };
      }
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: [mockManifest], error: null }),
            }),
          }),
        }),
      };
    });

    await handler!(req, res);

    const response = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.manifest.user_id).toBeUndefined();
    expect(response.manifest.org_id).toBeUndefined();
    expect(response.manifest.id).toBeUndefined();
  });

  it('returns 500 on database error', async () => {
    const handler = getGetHandler();
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-TEST-001' });

    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockRejectedValue(new Error('connection refused')),
        }),
      }),
    });

    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

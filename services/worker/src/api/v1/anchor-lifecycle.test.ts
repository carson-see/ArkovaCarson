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
import { anchorLifecycleRouter } from './anchor-lifecycle.js';

function getGetHandler() {
  const layer = (anchorLifecycleRouter as { stack: Array<{ route?: { path: string; methods: { get: boolean }; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack
    .find((l) => l.route?.path === '/:publicId/lifecycle' && l.route?.methods?.get);
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

describe('GET /anchor/:publicId/lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 for missing publicId', async () => {
    const handler = getGetHandler();
    const { req, res } = createMockReqRes({ publicId: '' });
    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns lifecycle events for a valid publicId', async () => {
    const handler = getGetHandler();
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-TEST-001' });

    const mockEvents = [
      {
        event_type: 'ANCHOR_CREATED',
        event_category: 'ANCHOR',
        created_at: '2026-03-10T08:00:00Z',
        actor_id: null,
        details: '{"source":"api"}',
      },
      {
        event_type: 'ANCHOR_SUBMITTED',
        event_category: 'ANCHOR',
        created_at: '2026-03-10T09:00:00Z',
        actor_id: 'user-1',
        details: null,
      },
    ];

    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({ data: mockEvents, error: null }),
        }),
      }),
    });

    await handler!(req, res);

    expect(res.json).toHaveBeenCalledWith({
      public_id: 'ARK-2026-TEST-001',
      lifecycle: [
        {
          event_type: 'ANCHOR_CREATED',
          event_category: 'ANCHOR',
          timestamp: '2026-03-10T08:00:00Z',
          actor_id: null,
          details: { source: 'api' },
        },
        {
          event_type: 'ANCHOR_SUBMITTED',
          event_category: 'ANCHOR',
          timestamp: '2026-03-10T09:00:00Z',
          actor_id: 'user-1',
          details: {},
        },
      ],
      total: 2,
    });
  });

  it('returns empty lifecycle when no events found', async () => {
    const handler = getGetHandler();
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-NONE-001' });

    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
      }),
    });

    await handler!(req, res);

    expect(res.json).toHaveBeenCalledWith({
      public_id: 'ARK-2026-NONE-001',
      lifecycle: [],
      total: 0,
    });
  });

  it('returns 500 on database error', async () => {
    const handler = getGetHandler();
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-TEST-001' });

    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({ data: null, error: { message: 'db error' } }),
        }),
      }),
    });

    await handler!(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('parses details JSON string into object', async () => {
    const handler = getGetHandler();
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-TEST-001' });

    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({
            data: [{
              event_type: 'ANCHOR_SECURED',
              event_category: 'ANCHOR',
              created_at: '2026-03-10T10:00:00Z',
              actor_id: null,
              details: '{"tx_id":"abc123","block_height":12345}',
            }],
            error: null,
          }),
        }),
      }),
    });

    await handler!(req, res);

    const response = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.lifecycle[0].details).toEqual({ tx_id: 'abc123', block_height: 12345 });
  });

  it('handles malformed details JSON gracefully', async () => {
    const handler = getGetHandler();
    const { req, res } = createMockReqRes({ publicId: 'ARK-2026-TEST-001' });

    (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          order: vi.fn().mockResolvedValue({
            data: [{
              event_type: 'ANCHOR_CREATED',
              event_category: 'ANCHOR',
              created_at: '2026-03-10T08:00:00Z',
              actor_id: null,
              details: 'not-valid-json{',
            }],
            error: null,
          }),
        }),
      }),
    });

    await handler!(req, res);

    const response = (res.json as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.lifecycle[0].details).toEqual({});
  });
});

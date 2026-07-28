/**
 * Tests for POST /api/v1/compliance/check.
 *
 * pentest-prep (API contract audit): the `entity.jurisdiction` field echoes
 * caller input. It previously always rendered as `entity: { ..., jurisdiction:
 * null }` when the caller omitted jurisdiction — inconsistent with every
 * other frozen-schema field on the v1 surface, which omits the key rather
 * than emitting a literal null (Constitution 1.8).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/db.js', () => ({ db: { from: vi.fn() } }));
vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { Request, Response } from 'express';
import { db } from '../../utils/db.js';
import { complianceCheckRouter } from './compliance-check.js';

function emptyChain() {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  const methods = ['select', 'eq', 'ilike', 'order', 'limit'];
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  Object.defineProperty(chain, 'then', {
    value: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
    enumerable: false,
  });
  return chain;
}

function getPostHandler() {
  type Layer = {
    route?: {
      path: string;
      methods: { post: boolean };
      stack: Array<{ handle: (...args: unknown[]) => unknown }>;
    };
  };
  const layer = (complianceCheckRouter as unknown as { stack: Layer[] }).stack.find(
    (l) => l.route?.path === '/' && l.route?.methods?.post,
  );
  return layer?.route?.stack[0].handle as (req: Request, res: Response) => Promise<void>;
}

function mockReqRes(body: Record<string, unknown>) {
  const req = { body } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  return { req, res };
}

describe('POST /compliance/check — jurisdiction omission (pentest-prep)', () => {
  it('omits entity.jurisdiction when the caller does not supply one', async () => {
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue(emptyChain());
    const { req, res } = mockReqRes({ entity_name: 'Acme Corp' });

    const handler = getPostHandler();
    expect(handler).toBeDefined();
    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: expect.objectContaining({ name: 'Acme Corp', type: 'organization' }),
      }),
    );
    const [payload] = (res.json as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { entity: Record<string, unknown> },
    ];
    expect(payload.entity).not.toHaveProperty('jurisdiction');
  });

  it('includes entity.jurisdiction when the caller supplies one', async () => {
    (db.from as ReturnType<typeof vi.fn>).mockReturnValue(emptyChain());
    const { req, res } = mockReqRes({ entity_name: 'Acme Corp', jurisdiction: 'DE' });

    const handler = getPostHandler();
    await handler(req, res);

    const [payload] = (res.json as ReturnType<typeof vi.fn>).mock.calls[0] as [
      { entity: Record<string, unknown> },
    ];
    expect(payload.entity.jurisdiction).toBe('DE');
  });
});

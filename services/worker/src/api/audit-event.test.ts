/**
 * SCRUM-1270 (R2-7) — POST /api/audit/event tests.
 *
 * Pin the contract that:
 *   - the body is Zod-validated and unknown keys are rejected (.strict)
 *   - actor_id is forced to the JWT subject (cannot be spoofed via body)
 *   - the row is inserted as service_role
 *   - DB errors return 500 without leaking the underlying error message
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { mockInsert, mockLogger } = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../utils/db.js', () => ({
  db: { from: vi.fn(() => ({ insert: mockInsert })) },
}));

import { auditEventRouter, auditEventBodySchema } from './audit-event.js';

const SUBJECT_USER_ID = '11111111-1111-1111-1111-111111111111';

interface MockResponse {
  statusCode: number;
  body: unknown;
  status(code: number): MockResponse;
  json(payload: unknown): MockResponse;
}

function makeRes(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

interface RouteLayer {
  route?: { stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }> };
}

function getPostHandler(): (req: Request, res: Response) => Promise<void> {
  const stack = (auditEventRouter as unknown as { stack: RouteLayer[] }).stack;
  for (const layer of stack) {
    if (layer.route) return layer.route.stack[0].handle;
  }
  throw new Error('POST handler not found on auditEventRouter');
}

const handler = getPostHandler();

async function invoke(body: unknown, userId: string | null = SUBJECT_USER_ID) {
  const req = { body, userId } as unknown as Request;
  const res = makeRes();
  await handler(req, res as unknown as Response);
  return res;
}

describe('POST /api/audit/event', () => {
  beforeEach(() => {
    mockInsert.mockReset().mockResolvedValue({ error: null });
    mockLogger.error.mockReset();
  });

  it('inserts as service_role with actor_id pinned to JWT subject', async () => {
    const res = await invoke({
      event_type: 'ANCHOR_CREATED',
      event_category: 'ANCHOR',
      target_type: 'anchor',
      target_id: 'arkv_anchor_abc',
    });

    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({ status: 'accepted' });
    expect(mockInsert).toHaveBeenCalledWith({
      event_type: 'ANCHOR_CREATED',
      event_category: 'ANCHOR',
      actor_id: SUBJECT_USER_ID,
      target_type: 'anchor',
      target_id: 'arkv_anchor_abc',
      org_id: null,
      details: null,
    });
  });

  it('refuses spoofed actor_id from the body — strict() rejects unknown keys', async () => {
    const res = await invoke({
      event_type: 'PROFILE_UPDATED',
      event_category: 'PROFILE',
      actor_id: '22222222-2222-2222-2222-222222222222',
    });

    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe('invalid_request');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns 401 without an authenticated user', async () => {
    const res = await invoke({ event_type: 'X', event_category: 'AUTH' }, null);
    expect(res.statusCode).toBe(401);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects unknown event_category enum value', async () => {
    const res = await invoke({ event_type: 'X', event_category: 'SECURITY' });
    expect(res.statusCode).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('rejects malformed org_id', async () => {
    const res = await invoke({
      event_type: 'X',
      event_category: 'AUTH',
      org_id: 'not-a-uuid',
    });
    expect(res.statusCode).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('returns 500 on DB error without leaking the underlying message', async () => {
    mockInsert.mockResolvedValueOnce({ error: { message: 'connection refused' } });
    const res = await invoke({ event_type: 'X', event_category: 'AUTH' });
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'audit_event_insert_failed' });
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    // Verify caller never sees the raw provider message.
    expect(JSON.stringify(res.body)).not.toContain('connection refused');
  });
});

describe('auditEventBodySchema', () => {
  it('caps details at 10000 chars to match audit_events CHECK constraint', () => {
    const result = auditEventBodySchema.safeParse({
      event_type: 'X',
      event_category: 'AUTH',
      details: 'a'.repeat(10_001),
    });
    expect(result.success).toBe(false);
  });

  it('accepts details up to 10000 chars (the DB CHECK ceiling)', () => {
    const result = auditEventBodySchema.safeParse({
      event_type: 'X',
      event_category: 'AUTH',
      details: 'a'.repeat(10_000),
    });
    expect(result.success).toBe(true);
  });

  it('accepts a clean minimal payload', () => {
    const result = auditEventBodySchema.safeParse({
      event_type: 'LOGIN',
      event_category: 'AUTH',
    });
    expect(result.success).toBe(true);
  });
});

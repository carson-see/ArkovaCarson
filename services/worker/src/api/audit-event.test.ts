/**
 * SCRUM-1270 (R2-7) — audit_events worker-only write path tests.
 *
 * Covers Zod validation, actor_id forced from JWT (not body), DB error handling,
 * and the strict() schema rejecting unknown keys.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { handleAuditEvent, auditEventBodySchema } from './audit-event.js';

function buildRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
}

function buildReq(body: unknown): Request {
  return { body } as Request;
}

function buildDb(insertResult: { error: { message: string } | null } = { error: null }) {
  const insert = vi.fn().mockResolvedValue(insertResult);
  const from = vi.fn().mockReturnValue({ insert });
  return { db: { from } as unknown as SupabaseClient, insert };
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handleAuditEvent', () => {
  it('rejects payload missing required fields', async () => {
    const { db } = buildDb();
    const res = buildRes();

    await handleAuditEvent('user-1', { db, logger }, buildReq({}), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'invalid_request' }),
    );
  });

  it('rejects unknown fields (strict schema)', async () => {
    const { db, insert } = buildDb();
    const res = buildRes();

    await handleAuditEvent(
      'user-1',
      { db, logger },
      buildReq({
        event_type: 'X',
        event_category: 'AUTH',
        actor_id: 'attacker-spoof', // forbidden — must come from JWT
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(insert).not.toHaveBeenCalled();
  });

  it('rejects oversized details (>10k chars)', async () => {
    const { db } = buildDb();
    const res = buildRes();

    await handleAuditEvent(
      'user-1',
      { db, logger },
      buildReq({
        event_type: 'X',
        event_category: 'AUTH',
        details: 'a'.repeat(10_001),
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('inserts with actor_id forced from JWT (body cannot override)', async () => {
    const { db, insert } = buildDb();
    const res = buildRes();

    await handleAuditEvent(
      'jwt-user-id',
      { db, logger },
      buildReq({
        event_type: 'LOGIN',
        event_category: 'AUTH',
        target_type: 'session',
        target_id: 'abc',
      }),
      res,
    );

    expect(insert).toHaveBeenCalledWith({
      event_type: 'LOGIN',
      event_category: 'AUTH',
      actor_id: 'jwt-user-id',
      target_type: 'session',
      target_id: 'abc',
      org_id: null,
      details: null,
    });
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('returns 500 on DB error', async () => {
    const { db } = buildDb({ error: { message: 'connection lost' } });
    const res = buildRes();

    await handleAuditEvent(
      'user-1',
      { db, logger },
      buildReq({ event_type: 'X', event_category: 'AUTH' }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'audit_write_failed' });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', eventType: 'X' }),
      'audit event insert failed',
    );
  });

  it('accepts every defined event_category', () => {
    const cats = [
      'AUTH', 'ANCHOR', 'PROFILE', 'ORG', 'ADMIN', 'SYSTEM',
      'SECURITY', 'AI', 'COMPLIANCE', 'NOTIFICATION', 'PLATFORM', 'USER', 'WEBHOOK',
    ];
    for (const cat of cats) {
      const r = auditEventBodySchema.safeParse({ event_type: 'X', event_category: cat });
      expect(r.success).toBe(true);
    }
  });

  it('rejects unknown event_category', () => {
    const r = auditEventBodySchema.safeParse({ event_type: 'X', event_category: 'NOPE' });
    expect(r.success).toBe(false);
  });
});

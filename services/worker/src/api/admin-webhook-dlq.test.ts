/**
 * Unit tests for the inbound webhook DLQ operator visibility + resolve
 * surface (SCRUM-4514).
 *
 * CTO decision (2026-09-13): no raw-body retention, no server-side replay.
 * `GET` surfaces enough per-row detail (id/provider/external_id/reason) for
 * an operator to go trigger redelivery at the partner; `POST /resolve`
 * acknowledges that happened. Covers: platform-admin authz gate, resolve
 * idempotency (second call on the same ids reports already_resolved, not an
 * error or a double count), input bound validation, and that no log call —
 * list or resolve — ever carries payload_hash, the operator's note text, or
 * looks like a raw webhook body.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { mockIsPlatformAdmin, mockFrom, mockLogger } = vi.hoisted(() => ({
  mockIsPlatformAdmin: vi.fn(),
  mockFrom: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/platformAdmin.js', () => ({ isPlatformAdmin: mockIsPlatformAdmin }));
vi.mock('../utils/db.js', () => ({ db: { from: mockFrom } }));
vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));

import { handleWebhookDlqList, handleWebhookDlqResolve } from './admin-webhook-dlq.js';

function mockReq(body: Record<string, unknown> = {}): Request {
  return { body } as unknown as Request;
}

function mockRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = data;
      return res;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

const ADMIN = 'admin-user-id';
const NOTE = 'Resent via DocuSign Connect logs 2026-09-13; delivery confirmed 202.';

beforeEach(() => {
  vi.clearAllMocks();
  mockIsPlatformAdmin.mockResolvedValue(true);
});

describe('SCRUM-4514: platform-admin authz gate', () => {
  it('GET list: 403s a non-admin session user (org admin, not platform admin)', async () => {
    mockIsPlatformAdmin.mockResolvedValue(false);
    const res = mockRes();
    await handleWebhookDlqList('org-admin-user', mockReq(), res);
    expect(res.statusCode).toBe(403);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('POST resolve: 403s a non-admin session user', async () => {
    mockIsPlatformAdmin.mockResolvedValue(false);
    const res = mockRes();
    await handleWebhookDlqResolve('org-admin-user', mockReq({ ids: ['r1'], note: NOTE }), res);
    expect(res.statusCode).toBe(403);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('never queries the DLQ table before the admin check resolves', async () => {
    let adminCheckResolved = false;
    mockIsPlatformAdmin.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      adminCheckResolved = true;
      return true;
    });
    mockFrom.mockImplementation(() => {
      expect(adminCheckResolved).toBe(true);
      return { select: () => ({ is: () => ({ order: () => ({ data: [], error: null }) }) }) };
    });
    await handleWebhookDlqList(ADMIN, mockReq(), mockRes());
  });

});

describe('SCRUM-4514: GET /admin/webhook-dlq (list/counts)', () => {
  it('returns counts by provider + oldest age, and per-row id/provider/external_id/reason — never payload_hash', async () => {
    const old = new Date(Date.now() - 3600_000).toISOString();
    const recent = new Date(Date.now() - 10_000).toISOString();
    mockFrom.mockImplementation((table: string) => {
      expect(table).toBe('webhook_dlq');
      return {
        select: (cols: string) => {
          expect(cols).not.toContain('payload_hash');
          expect(cols).toContain('reason');
          expect(cols).toContain('external_id');
          return {
            is: () => ({
              order: () => ({
                data: [
                  { id: 'r1', provider: 'docusign', external_id: 'env-1', reason: 'invalid_body:json_parse', created_at: old },
                  { id: 'r2', provider: 'docusign', external_id: 'env-2', reason: 'timeout', created_at: recent },
                  { id: 'r3', provider: 'checkr', external_id: 'rep-1', reason: 'unbound_passport', created_at: recent },
                ],
                error: null,
              }),
            }),
          };
        },
      };
    });

    const res = mockRes();
    await handleWebhookDlqList(ADMIN, mockReq(), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      total_unresolved: number;
      by_provider: Record<string, { count: number; oldest_age_seconds: number }>;
      rows: Array<{ id: string; provider: string; external_id: string | null; reason: string; age_seconds: number }>;
    };
    expect(body.total_unresolved).toBe(3);
    expect(body.by_provider.docusign.count).toBe(2);
    expect(body.by_provider.checkr.count).toBe(1);
    expect(body.by_provider.docusign.oldest_age_seconds).toBeGreaterThanOrEqual(3599);
    expect(body.rows.map((r) => r.id).sort()).toEqual(['r1', 'r2', 'r3']);
    const r1 = body.rows.find((r) => r.id === 'r1')!;
    expect(r1.external_id).toBe('env-1');
    expect(r1.reason).toBe('invalid_body:json_parse');
    expect(JSON.stringify(body)).not.toMatch(/payload_hash|[a-f0-9]{64}/);
  });

  it('500s cleanly on a query error', async () => {
    mockFrom.mockReturnValue({
      select: () => ({ is: () => ({ order: () => ({ data: null, error: { message: 'boom' } }) }) }),
    });
    const res = mockRes();
    await handleWebhookDlqList(ADMIN, mockReq(), res);
    expect(res.statusCode).toBe(500);
  });
});

describe('SCRUM-4514: POST /admin/webhook-dlq/resolve — idempotent resolve', () => {
  /** A tiny in-memory `webhook_dlq` stand-in shared across chained mock calls. */
  function makeTable(rows: Array<{ id: string; resolved_at: string | null }>) {
    function chainFor() {
      return {
        update: (patch: { resolved_at: string }) => ({
          in: (_col: string, ids: string[]) => ({
            is: () => {
              const justResolved = rows.filter((r) => ids.includes(r.id) && r.resolved_at === null);
              for (const r of justResolved) r.resolved_at = patch.resolved_at;
              return { select: () => ({ data: justResolved.map((r) => ({ id: r.id })), error: null }) };
            },
          }),
        }),
        select: () => ({
          in: (_col: string, ids: string[]) => ({
            not: (_col2: string, _op: string, _val: unknown) => ({
              data: rows.filter((r) => ids.includes(r.id) && r.resolved_at !== null).map((r) => ({ id: r.id })),
              error: null,
            }),
          }),
        }),
      };
    }
    return chainFor;
  }

  it('resolves unresolved rows and returns resolved count, already_resolved 0', async () => {
    const rows = [
      { id: 'r1', resolved_at: null },
      { id: 'r2', resolved_at: null },
    ];
    mockFrom.mockImplementation(() => makeTable(rows)());

    const res = mockRes();
    await handleWebhookDlqResolve(ADMIN, mockReq({ ids: ['r1', 'r2'], note: NOTE }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ resolved: 2, already_resolved: 0 });
    expect(rows.every((r) => r.resolved_at !== null)).toBe(true);
  });

  it('idempotency: calling resolve twice on the same ids reports already_resolved on the second call, never double-counts', async () => {
    const rows = [
      { id: 'r1', resolved_at: null },
      { id: 'r2', resolved_at: null },
    ];
    mockFrom.mockImplementation(() => makeTable(rows)());

    const first = mockRes();
    await handleWebhookDlqResolve(ADMIN, mockReq({ ids: ['r1', 'r2'], note: NOTE }), first);
    expect(first.body).toEqual({ resolved: 2, already_resolved: 0 });

    const second = mockRes();
    await handleWebhookDlqResolve(ADMIN, mockReq({ ids: ['r1', 'r2'], note: NOTE }), second);
    expect(second.body).toEqual({ resolved: 0, already_resolved: 2 });
  });

  it('mixed batch: some ids already resolved, some not — both counts correct in one call', async () => {
    const rows = [
      { id: 'r1', resolved_at: new Date().toISOString() }, // already resolved
      { id: 'r2', resolved_at: null }, // fresh
    ];
    mockFrom.mockImplementation(() => makeTable(rows)());

    const res = mockRes();
    await handleWebhookDlqResolve(ADMIN, mockReq({ ids: ['r1', 'r2'], note: NOTE }), res);
    expect(res.body).toEqual({ resolved: 1, already_resolved: 1 });
  });

  it('an id that matches no row contributes to neither count', async () => {
    const rows = [{ id: 'r1', resolved_at: null }];
    mockFrom.mockImplementation(() => makeTable(rows)());

    const res = mockRes();
    await handleWebhookDlqResolve(ADMIN, mockReq({ ids: ['r1', 'does-not-exist'], note: NOTE }), res);
    expect(res.body).toEqual({ resolved: 1, already_resolved: 0 });
  });

  it('rejects an empty ids array with 400', async () => {
    const res = mockRes();
    await handleWebhookDlqResolve(ADMIN, mockReq({ ids: [], note: NOTE }), res);
    expect(res.statusCode).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('rejects more than 100 ids with 400', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    const res = mockRes();
    await handleWebhookDlqResolve(ADMIN, mockReq({ ids, note: NOTE }), res);
    expect(res.statusCode).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('rejects a non-array ids field with 400', async () => {
    const res = mockRes();
    await handleWebhookDlqResolve(ADMIN, mockReq({ ids: 'r1', note: NOTE }), res);
    expect(res.statusCode).toBe(400);
  });

  it('rejects a missing note with 400', async () => {
    const res = mockRes();
    await handleWebhookDlqResolve(ADMIN, mockReq({ ids: ['r1'] }), res);
    expect(res.statusCode).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('rejects a note over 500 chars with 400', async () => {
    const res = mockRes();
    await handleWebhookDlqResolve(ADMIN, mockReq({ ids: ['r1'], note: 'x'.repeat(501) }), res);
    expect(res.statusCode).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('accepts a note at exactly 500 chars', async () => {
    const rows = [{ id: 'r1', resolved_at: null }];
    mockFrom.mockImplementation(() => makeTable(rows)());
    const res = mockRes();
    await handleWebhookDlqResolve(ADMIN, mockReq({ ids: ['r1'], note: 'x'.repeat(500) }), res);
    expect(res.statusCode).toBe(200);
  });

  it('never logs the note content, payload_hash, or reason — only ids/counts', async () => {
    const rows = [{ id: 'r1', resolved_at: null }];
    mockFrom.mockImplementation(() => makeTable(rows)());
    const secretishNote = 'contact: jane.doe@example.com re: envelope 12345';
    await handleWebhookDlqResolve(ADMIN, mockReq({ ids: ['r1'], note: secretishNote }), mockRes());

    const allLoggedText = [...mockLogger.info.mock.calls, ...mockLogger.warn.mock.calls, ...mockLogger.error.mock.calls]
      .map((call) => JSON.stringify(call))
      .join('\n');
    expect(allLoggedText).not.toContain(secretishNote);
    expect(allLoggedText).not.toContain('jane.doe@example.com');
    expect(allLoggedText).not.toMatch(/payload_hash/);
  });

  it('de-duplicates repeated ids in the request before claiming', async () => {
    const rows = [{ id: 'r1', resolved_at: null }];
    let capturedIds: string[] = [];
    mockFrom.mockImplementation(() => ({
      update: () => ({
        in: (_col: string, ids: string[]) => {
          capturedIds = ids;
          return {
            is: () => ({
              select: () => ({ data: rows.filter((r) => ids.includes(r.id)).map((r) => ({ id: r.id })), error: null }),
            }),
          };
        },
      }),
      select: () => ({ in: () => ({ not: () => ({ data: [], error: null }) }) }),
    }));
    await handleWebhookDlqResolve(ADMIN, mockReq({ ids: ['r1', 'r1', 'r1'], note: NOTE }), mockRes());
    expect(capturedIds).toEqual(['r1']);
  });
});

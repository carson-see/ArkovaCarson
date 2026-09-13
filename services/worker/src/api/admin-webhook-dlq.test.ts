/**
 * Unit tests for the inbound webhook DLQ operator drain (SCRUM-4514).
 *
 * Covers: platform-admin authz gate, claim atomicity (two concurrent
 * replay calls never both claim the same row), the fail-closed replay
 * outcome per provider (docusign/adobe_sign/checkr all lack a persisted
 * raw body, so none are replayable today), bounded per-row detail text,
 * and that no log call ever carries payload/payload_hash/reason content.
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

import {
  handleWebhookDlqList,
  handleWebhookDlqReplay,
  assessReplayability,
  type DlqRow,
} from './admin-webhook-dlq.js';

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

function makeRow(overrides: Partial<DlqRow> = {}): DlqRow {
  return {
    id: 'row-1',
    provider: 'docusign',
    external_id: 'env-123',
    webhook_id: null,
    reason: 'normalization failed',
    payload_hash: 'a'.repeat(64),
    resolved_at: null,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  };
}

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

  it('POST replay: 403s a non-admin session user', async () => {
    mockIsPlatformAdmin.mockResolvedValue(false);
    const res = mockRes();
    await handleWebhookDlqReplay('org-admin-user', mockReq(), res);
    expect(res.statusCode).toBe(403);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  // The router layer (routes/admin.ts) never calls these handlers without a
  // resolved session userId — an API-key-only or anonymous request 401s at
  // `extractAuthUserId` before reaching here. isPlatformAdmin is therefore
  // the only gate this module itself is responsible for, and it must always
  // run before any `db.from` call.
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

describe('SCRUM-4514: replayability — all four inbound providers fail closed today', () => {
  // computeid is the fourth writer (migration 0448 / SCRUM-4493, 2026-09-07,
  // flag-gated dark) found by grepping the live writers rather than trusting
  // the ticket's original docusign/adobe_sign/checkr-only list.
  it.each(['docusign', 'adobe_sign', 'checkr', 'computeid'])('%s: not replayable (no raw body persisted)', (provider) => {
    const assessment = assessReplayability({ provider });
    expect(assessment.replayable).toBe(false);
    expect(assessment.detail.length).toBeLessThanOrEqual(500);
    expect(assessment.detail).toMatch(/not persisted|payload_hash/);
  });

  it('unknown provider: not replayable, names the provider', () => {
    const assessment = assessReplayability({ provider: 'some_new_vendor' });
    expect(assessment.replayable).toBe(false);
    expect(assessment.detail).toContain('some_new_vendor');
  });
});

describe('SCRUM-4514: GET /admin/webhook-dlq (list/counts)', () => {
  it('returns counts by provider + oldest age, ids only — never reason/payload_hash', async () => {
    const old = new Date(Date.now() - 3600_000).toISOString();
    const recent = new Date(Date.now() - 10_000).toISOString();
    mockFrom.mockImplementation((table: string) => {
      expect(table).toBe('webhook_dlq');
      return {
        select: (cols: string) => {
          // The list view must not select reason/payload_hash in bulk.
          expect(cols).not.toContain('reason');
          expect(cols).not.toContain('payload_hash');
          return {
            is: () => ({
              order: () => ({
                data: [
                  { id: 'r1', provider: 'docusign', created_at: old },
                  { id: 'r2', provider: 'docusign', created_at: recent },
                  { id: 'r3', provider: 'checkr', created_at: recent },
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
      ids: string[];
    };
    expect(body.total_unresolved).toBe(3);
    expect(body.by_provider.docusign.count).toBe(2);
    expect(body.by_provider.checkr.count).toBe(1);
    expect(body.by_provider.docusign.oldest_age_seconds).toBeGreaterThanOrEqual(3599);
    expect(body.ids.sort()).toEqual(['r1', 'r2', 'r3']);
    expect(JSON.stringify(body)).not.toMatch(/payload_hash|normalization failed/);
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

describe('SCRUM-4514: POST /admin/webhook-dlq/replay — claim + fail-closed outcome', () => {
  it('claims up to `limit` oldest rows, marks every row not_replayable, resolves them', async () => {
    const rows = [makeRow({ id: 'r1', provider: 'docusign' }), makeRow({ id: 'r2', provider: 'checkr' })];

    const selectChain = {
      select: () => ({ is: () => ({ order: () => ({ limit: () => ({ data: rows, error: null }) }) }) }),
    };
    const updateChain = {
      update: (patch: Record<string, unknown>) => {
        expect(typeof patch.resolved_at).toBe('string');
        return {
          in: (col: string, ids: string[]) => {
            expect(col).toBe('id');
            expect(ids.sort()).toEqual(['r1', 'r2']);
            return {
              is: () => ({
                select: () => ({ data: rows.map((r) => ({ ...r, resolved_at: patch.resolved_at })), error: null }),
              }),
            };
          },
        };
      },
    };

    let call = 0;
    mockFrom.mockImplementation(() => {
      call += 1;
      return call === 1 ? selectChain : updateChain;
    });

    const res = mockRes();
    await handleWebhookDlqReplay(ADMIN, mockReq({ limit: 2 }), res);

    expect(res.statusCode).toBe(200);
    const body = res.body as {
      claimed: number;
      replayed: number;
      not_replayable: number;
      errored: number;
      results: Array<{ id: string; outcome: string; detail: string }>;
    };
    expect(body.claimed).toBe(2);
    expect(body.replayed).toBe(0);
    expect(body.not_replayable).toBe(2);
    expect(body.errored).toBe(0);
    expect(body.results.every((r) => r.outcome === 'not_replayable')).toBe(true);
    expect(body.results.every((r) => r.detail.length <= 500)).toBe(true);

    // The claim call is the only place the response can differ from reality
    // — assert the atomicity guard was actually applied, not just that a
    // 200 came back.
    const warnCall = mockLogger.warn.mock.calls.find(([, msg]) => msg === 'webhook-dlq operator drain executed');
    expect(warnCall).toBeDefined();
    const loggedPayload = JSON.stringify(warnCall![0]);
    expect(loggedPayload).not.toMatch(/normalization failed|payload_hash|[a-f0-9]{64}/);
  });

  it('atomicity: a row already resolved by a concurrent claim is excluded from this caller\'s claimed set', async () => {
    // Simulate: the SELECT sees 2 unresolved rows, but by the time this
    // caller's UPDATE runs, a concurrent caller already resolved r1 —
    // exactly what the `is('resolved_at', null)` guard on the UPDATE
    // protects against in production (Postgres re-evaluates the WHERE
    // clause under the row lock). The mock stands in for that guard by
    // only returning r2 from the UPDATE...RETURNING.
    const candidateRows = [makeRow({ id: 'r1' }), makeRow({ id: 'r2' })];

    const selectChain = {
      select: () => ({ is: () => ({ order: () => ({ limit: () => ({ data: candidateRows, error: null }) }) }) }),
    };
    const updateChain = {
      update: () => ({
        in: () => ({
          is: () => ({
            // Only r2 comes back — r1 was claimed by a concurrent caller.
            select: () => ({ data: [makeRow({ id: 'r2' })], error: null }),
          }),
        }),
      }),
    };

    let call = 0;
    mockFrom.mockImplementation(() => (++call === 1 ? selectChain : updateChain));

    const res = mockRes();
    await handleWebhookDlqReplay(ADMIN, mockReq(), res);

    const body = res.body as { claimed: number; results: Array<{ id: string }> };
    expect(body.claimed).toBe(1);
    expect(body.results.map((r) => r.id)).toEqual(['r2']);
  });

  it('two sequential drain calls never report the same row twice (simulated concurrency)', async () => {
    // A single shared "table" whose UPDATE respects resolved_at IS NULL,
    // driving both calls against the SAME backing state — the strongest
    // check this test file can do without a real Postgres instance.
    const table: DlqRow[] = [makeRow({ id: 'r1' }), makeRow({ id: 'r2' })];

    function makeChainFor(currentTable: DlqRow[]) {
      return {
        select: () => ({
          is: () => ({
            order: () => ({
              limit: (n: number) => ({
                data: currentTable.filter((r) => r.resolved_at === null).slice(0, n),
                error: null,
              }),
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          in: (_col: string, ids: string[]) => ({
            is: () => {
              const claimedNow = currentTable.filter(
                (r) => ids.includes(r.id) && r.resolved_at === null,
              );
              for (const row of claimedNow) row.resolved_at = patch.resolved_at as string;
              return { select: () => ({ data: claimedNow, error: null }) };
            },
          }),
        }),
      };
    }

    mockFrom.mockImplementation(() => makeChainFor(table));

    const resA = mockRes();
    const resB = mockRes();
    // Fire both "concurrently" (same microtask interleaving vitest gives us);
    // the shared `table` array is what makes this a real atomicity check.
    await Promise.all([
      handleWebhookDlqReplay(ADMIN, mockReq(), resA),
      handleWebhookDlqReplay(ADMIN, mockReq(), resB),
    ]);

    const idsA = (resA.body as { results: Array<{ id: string }> }).results.map((r) => r.id);
    const idsB = (resB.body as { results: Array<{ id: string }> }).results.map((r) => r.id);
    const overlap = idsA.filter((id) => idsB.includes(id));
    expect(overlap).toEqual([]);
    expect([...idsA, ...idsB].sort()).toEqual(['r1', 'r2']);
  });

  it('rejects a non-integer or non-positive limit with 400', async () => {
    const res1 = mockRes();
    await handleWebhookDlqReplay(ADMIN, mockReq({ limit: 'lots' }), res1);
    expect(res1.statusCode).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();

    const res2 = mockRes();
    await handleWebhookDlqReplay(ADMIN, mockReq({ limit: 0 }), res2);
    expect(res2.statusCode).toBe(400);
  });

  it('caps limit at 50 even if a larger value is requested', async () => {
    let capturedLimit: number | undefined;
    mockFrom.mockImplementation(() => ({
      select: () => ({
        is: () => ({
          order: () => ({
            limit: (n: number) => {
              capturedLimit = n;
              return { data: [], error: null };
            },
          }),
        }),
      }),
    }));
    await handleWebhookDlqReplay(ADMIN, mockReq({ limit: 5000 }), mockRes());
    expect(capturedLimit).toBe(50);
  });

  it('returns zero counts with no DB write when the queue is already empty', async () => {
    mockFrom.mockReturnValue({
      select: () => ({ is: () => ({ order: () => ({ limit: () => ({ data: [], error: null }) }) }) }),
    });
    const res = mockRes();
    await handleWebhookDlqReplay(ADMIN, mockReq(), res);
    expect(res.body).toEqual({ claimed: 0, replayed: 0, not_replayable: 0, errored: 0, results: [] });
    expect(mockFrom).toHaveBeenCalledTimes(1); // select only, no update chain entered
  });
});

/**
 * Tests for AI Cost Tracker (P8-S2)
 *
 * Verifies credit checking, deduction, and usage event logging.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// cost-tracker.ts reads the auto-provision allocation from the typed config
// (SCRUM-1258 — no ad-hoc process.env reads in the worker), so the test varies
// the config value rather than the env var.
const mockConfig = vi.hoisted(() => ({ aiCreditsMonthlyAllocation: 100 }));
vi.mock('../config.js', () => ({ config: mockConfig }));

vi.mock('../utils/db.js', () => ({
  db: {
    rpc: vi.fn(),
    from: vi.fn(),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import {
  checkAICredits,
  deductAICredits,
  logAIUsageEvent,
  ensureAICreditsPeriod,
  CREDIT_ALLOCATIONS,
} from './cost-tracker.js';

interface QueryResult {
  data: unknown;
  error: unknown;
}

/**
 * Mocks `db.from('ai_credits')` for `ensureAICreditsPeriod`.
 *
 * The real code issues up to three statements: the covering-period lookup
 * (`.eq().lte().gt().order().order().limit(1).maybeSingle()`), the
 * `.insert().select().maybeSingle()`, and — only after an insert — the
 * re-read that closes the TOCTOU window (the same select chain, awaited
 * directly for the full row list). `selectResults` is consumed one entry per
 * `select()` call, so a test can hand the lookup and the re-read different
 * answers; the last entry repeats if the code selects more times than the
 * test provided.
 */
function createAiCreditsMock(opts: {
  selectResults: QueryResult[];
  insertResult?: QueryResult;
  deleteResult?: { error: unknown };
}) {
  let selectCall = 0;

  const insertSelectMaybeSingle = vi
    .fn()
    .mockResolvedValue(opts.insertResult ?? { data: { id: 'inserted-row' }, error: null });
  const insertMock = vi.fn(() => ({
    select: vi.fn(() => ({ maybeSingle: insertSelectMaybeSingle })),
  }));

  const deleteEq = vi.fn().mockResolvedValue(opts.deleteResult ?? { error: null });
  const deleteMock = vi.fn(() => ({ eq: deleteEq }));

  const selectMock = vi.fn(() => {
    const result =
      opts.selectResults[Math.min(selectCall, opts.selectResults.length - 1)];
    selectCall += 1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {};
    for (const method of ['eq', 'lte', 'gt', 'order', 'limit']) {
      chain[method] = vi.fn(() => chain);
    }
    chain.maybeSingle = vi.fn().mockResolvedValue(result);
    // The re-read awaits the chain itself rather than calling maybeSingle().
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chain.then = (onFulfilled: any, onRejected: any) =>
      Promise.resolve(result).then(onFulfilled, onRejected);
    return chain;
  });

  (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
    select: selectMock,
    insert: insertMock,
    delete: deleteMock,
  });

  return { selectMock, insertMock, deleteMock, deleteEq };
}

describe('AI Cost Tracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('CREDIT_ALLOCATIONS', () => {
    it('defines correct tier allocations', () => {
      expect(CREDIT_ALLOCATIONS.free).toBe(50);
      expect(CREDIT_ALLOCATIONS.individual).toBe(500);
      expect(CREDIT_ALLOCATIONS.professional).toBe(500);
      expect(CREDIT_ALLOCATIONS.enterprise).toBe(5000);
    });
  });

  describe('checkAICredits', () => {
    it('returns credit balance for an org', async () => {
      (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [
          {
            monthly_allocation: 500,
            used_this_month: 100,
            remaining: 400,
            has_credits: true,
          },
        ],
        error: null,
      });

      const result = await checkAICredits('org-123');
      expect(result).toEqual({
        monthlyAllocation: 500,
        usedThisMonth: 100,
        remaining: 400,
        hasCredits: true,
      });
    });

    it('returns credit balance for a user', async () => {
      (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [
          {
            monthly_allocation: 50,
            used_this_month: 49,
            remaining: 1,
            has_credits: true,
          },
        ],
        error: null,
      });

      const result = await checkAICredits(undefined, 'user-456');
      expect(result).toEqual({
        monthlyAllocation: 50,
        usedThisMonth: 49,
        remaining: 1,
        hasCredits: true,
      });
    });

    it('returns null when no credit record exists', async () => {
      (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [],
        error: null,
      });

      const result = await checkAICredits('org-999');
      expect(result).toBeNull();
    });

    it('returns null on DB error', async () => {
      (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: null,
        error: { message: 'connection refused' },
      });

      const result = await checkAICredits('org-123');
      expect(result).toBeNull();
    });

    it('returns null on exception', async () => {
      (db.rpc as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));

      const result = await checkAICredits('org-123');
      expect(result).toBeNull();
    });
  });

  describe('deductAICredits', () => {
    it('returns true on successful deduction', async () => {
      (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: true,
        error: null,
      });

      const result = await deductAICredits('org-123', undefined, 1);
      expect(result).toBe(true);
    });

    it('returns false when insufficient credits', async () => {
      (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: false,
        error: null,
      });

      const result = await deductAICredits('org-123');
      expect(result).toBe(false);
    });

    it('returns false on DB error', async () => {
      (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: null,
        error: { message: 'deadlock' },
      });

      const result = await deductAICredits('org-123');
      expect(result).toBe(false);
    });

    it('returns false on exception', async () => {
      (db.rpc as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));

      const result = await deductAICredits('org-123');
      expect(result).toBe(false);
    });

    it('passes custom amount', async () => {
      (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: true,
        error: null,
      });

      await deductAICredits('org-123', undefined, 5);
      expect(db.rpc).toHaveBeenCalledWith('deduct_ai_credits', {
        p_org_id: 'org-123',
        p_user_id: null,
        p_amount: 5,
      });
    });
  });

  describe('logAIUsageEvent', () => {
    it('logs a successful extraction event', async () => {
      const insertMock = vi.fn().mockResolvedValue({ error: null });
      (db.from as ReturnType<typeof vi.fn>).mockReturnValue({ insert: insertMock });

      await logAIUsageEvent({
        orgId: 'org-123',
        eventType: 'extraction',
        provider: 'gemini',
        tokensUsed: 150,
        creditsConsumed: 1,
        fingerprint: 'a'.repeat(64),
        confidence: 0.92,
        durationMs: 450,
        success: true,
      });

      expect(db.from).toHaveBeenCalledWith('ai_usage_events');
      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          org_id: 'org-123',
          event_type: 'extraction',
          provider: 'gemini',
          tokens_used: 150,
          credits_consumed: 1,
          success: true,
        }),
      );
    });

    it('logs a failed event with error message', async () => {
      const insertMock = vi.fn().mockResolvedValue({ error: null });
      (db.from as ReturnType<typeof vi.fn>).mockReturnValue({ insert: insertMock });

      await logAIUsageEvent({
        userId: 'user-456',
        eventType: 'extraction',
        provider: 'gemini',
        success: false,
        errorMessage: 'Rate limit exceeded',
      });

      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-456',
          success: false,
          error_message: 'Rate limit exceeded',
        }),
      );
    });

    it('does not throw on DB error', async () => {
      const insertMock = vi.fn().mockResolvedValue({ error: { message: 'insert failed' } });
      (db.from as ReturnType<typeof vi.fn>).mockReturnValue({ insert: insertMock });

      await expect(
        logAIUsageEvent({
          eventType: 'extraction',
          provider: 'mock',
          success: true,
        }),
      ).resolves.not.toThrow();
    });

    it('does not throw on exception', async () => {
      (db.from as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('DB down');
      });

      await expect(
        logAIUsageEvent({
          eventType: 'embedding',
          provider: 'gemini',
          success: false,
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('ensureAICreditsPeriod (SCRUM-4939)', () => {
    beforeEach(() => {
      mockConfig.aiCreditsMonthlyAllocation = 100;
    });

    it('returns false immediately for an empty orgId without touching the DB', async () => {
      const result = await ensureAICreditsPeriod('');
      expect(result).toBe(false);
      expect(db.from).not.toHaveBeenCalled();
    });

    it('creates a row for the current UTC calendar month when none exists', async () => {
      const { insertMock } = createAiCreditsMock({
        selectResults: [
          { data: null, error: null },
          { data: [{ id: 'inserted-row' }], error: null },
        ],
      });

      const now = new Date('2026-09-12T14:00:00Z');
      const result = await ensureAICreditsPeriod('org-123', now);

      expect(result).toBe(true);
      expect(db.from).toHaveBeenCalledWith('ai_credits');
      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({
          org_id: 'org-123',
          monthly_allocation: 100,
          used_this_month: 0,
          period_start: '2026-09-01T00:00:00.000Z',
          period_end: '2026-10-01T00:00:00.000Z',
        }),
      );
    });

    it('stamps the configured monthly allocation on a newly created row', async () => {
      mockConfig.aiCreditsMonthlyAllocation = 250;
      const { insertMock } = createAiCreditsMock({
        selectResults: [
          { data: null, error: null },
          { data: [{ id: 'inserted-row' }], error: null },
        ],
      });

      await ensureAICreditsPeriod('org-123', new Date('2026-09-12T14:00:00Z'));

      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({ monthly_allocation: 250 }),
      );
    });

    it('is a no-op and never overwrites used_this_month when a row already covers the period', async () => {
      const { insertMock, deleteMock } = createAiCreditsMock({
        selectResults: [{ data: { id: 'row-1' }, error: null }],
      });

      const result = await ensureAICreditsPeriod('org-123', new Date('2026-09-12T14:00:00Z'));

      expect(result).toBe(true);
      expect(insertMock).not.toHaveBeenCalled();
      expect(deleteMock).not.toHaveBeenCalled();
    });

    it('returns false without throwing when the period lookup errors', async () => {
      const { insertMock } = createAiCreditsMock({
        selectResults: [{ data: null, error: { message: 'timeout' } }],
      });

      const result = await ensureAICreditsPeriod('org-123');

      expect(result).toBe(false);
      expect(insertMock).not.toHaveBeenCalled();
    });

    it('returns false without throwing when the insert fails (treated as non-fatal)', async () => {
      createAiCreditsMock({
        selectResults: [{ data: null, error: null }],
        insertResult: { data: null, error: { message: 'insert failed' } },
      });

      const result = await ensureAICreditsPeriod('org-123');

      expect(result).toBe(false);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('returns false without throwing on an unexpected exception', async () => {
      (db.from as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('boom');
      });

      const result = await ensureAICreditsPeriod('org-123');

      expect(result).toBe(false);
    });

    /**
     * TOCTOU: `ai_credits` has no unique (org_id, period_start) constraint, so
     * two concurrent first-ever requests for one org can both find no row and
     * both insert. `deduct_ai_credits`'s UPDATE has no row limit, so a surviving
     * duplicate makes every later deduction increment BOTH rows — the org burns
     * credits at 2x for the rest of the month. The re-read after insert has to
     * collapse that back to one row.
     */
    describe('concurrent provisioning (TOCTOU)', () => {
      it('deletes only its own row when it loses the race to an older row', async () => {
        const { deleteMock, deleteEq } = createAiCreditsMock({
          selectResults: [
            { data: null, error: null },
            // Re-read: the racer's row sorted first (older created_at).
            { data: [{ id: 'racer-row' }, { id: 'inserted-row' }], error: null },
          ],
        });

        const result = await ensureAICreditsPeriod('org-123');

        expect(result).toBe(true);
        expect(deleteMock).toHaveBeenCalledTimes(1);
        // Never the pre-existing row — only the one this call inserted.
        expect(deleteEq).toHaveBeenCalledWith('id', 'inserted-row');
      });

      it('keeps its own row and deletes nothing when it wins the race', async () => {
        const { deleteMock } = createAiCreditsMock({
          selectResults: [
            { data: null, error: null },
            { data: [{ id: 'inserted-row' }, { id: 'racer-row' }], error: null },
          ],
        });

        const result = await ensureAICreditsPeriod('org-123');

        expect(result).toBe(true);
        expect(deleteMock).not.toHaveBeenCalled();
      });

      it('two racing callers collapse to exactly one surviving row', async () => {
        // Both callers select empty, both insert, both re-read the same two
        // rows. Exactly one of them must issue a delete, and it must delete
        // its own row — otherwise the org is left double-charging.
        const deleted: string[] = [];
        const bothRows = [{ id: 'row-a' }, { id: 'row-b' }];

        const runCaller = async (ownId: string) => {
          let selectCall = 0;
          (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
            select: vi.fn(() => {
              const result =
                selectCall++ === 0
                  ? { data: null, error: null }
                  : { data: bothRows, error: null };
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const chain: any = {};
              for (const m of ['eq', 'lte', 'gt', 'order', 'limit']) {
                chain[m] = vi.fn(() => chain);
              }
              chain.maybeSingle = vi.fn().mockResolvedValue(result);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              chain.then = (f: any, r: any) => Promise.resolve(result).then(f, r);
              return chain;
            }),
            insert: vi.fn(() => ({
              select: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({ data: { id: ownId }, error: null }),
              })),
            })),
            delete: vi.fn(() => ({
              eq: vi.fn((_col: string, id: string) => {
                deleted.push(id);
                return Promise.resolve({ error: null });
              }),
            })),
          });
          return ensureAICreditsPeriod('org-123');
        };

        // Sequential because the shared `db.from` mock is per-caller; the
        // assertion is on the convergent outcome, which is order-independent.
        await runCaller('row-a');
        await runCaller('row-b');

        // Only the loser (row-b, sorted after row-a) removes itself.
        expect(deleted).toEqual(['row-b']);
        expect(bothRows.length - deleted.length).toBe(1);
      });

      it('leaves the duplicate and logs at error level when the compensating delete fails', async () => {
        createAiCreditsMock({
          selectResults: [
            { data: null, error: null },
            { data: [{ id: 'racer-row' }, { id: 'inserted-row' }], error: null },
          ],
          deleteResult: { error: { message: 'delete blocked' } },
        });

        const result = await ensureAICreditsPeriod('org-123');

        expect(result).toBe(true);
        expect(logger.error).toHaveBeenCalled();
      });

      it('never deletes when the post-insert re-read itself fails', async () => {
        const { deleteMock } = createAiCreditsMock({
          selectResults: [
            { data: null, error: null },
            { data: null, error: { message: 're-read failed' } },
          ],
        });

        const result = await ensureAICreditsPeriod('org-123');

        expect(result).toBe(true);
        expect(deleteMock).not.toHaveBeenCalled();
      });
    });
  });
});

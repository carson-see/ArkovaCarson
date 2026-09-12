/**
 * Tests for AI Cost Tracker (P8-S2)
 *
 * Verifies credit checking, deduction, and usage event logging.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  resolveAICreditsMonthlyAllocation,
  CREDIT_ALLOCATIONS,
} from './cost-tracker.js';

/**
 * Builds a chainable mock for the `db.from('ai_credits').select(...)` lookup
 * `ensureAICreditsPeriod` performs before deciding whether to insert. Mirrors
 * the `.eq().lte().gt().maybeSingle()` shape used in `requirePaymentCurrent.ts`.
 */
function createSelectChain(finalResult: { data: unknown; error: unknown }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {};
  chain.eq = vi.fn(() => chain);
  chain.lte = vi.fn(() => chain);
  chain.gt = vi.fn(() => chain);
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult);
  return chain;
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

  describe('resolveAICreditsMonthlyAllocation (SCRUM-4939)', () => {
    const ORIGINAL = process.env.AI_CREDITS_MONTHLY_ALLOCATION;

    afterEach(() => {
      if (ORIGINAL === undefined) {
        delete process.env.AI_CREDITS_MONTHLY_ALLOCATION;
      } else {
        process.env.AI_CREDITS_MONTHLY_ALLOCATION = ORIGINAL;
      }
    });

    it('defaults to 100 when unset', () => {
      delete process.env.AI_CREDITS_MONTHLY_ALLOCATION;
      expect(resolveAICreditsMonthlyAllocation()).toBe(100);
    });

    it('defaults to 100 when blank', () => {
      process.env.AI_CREDITS_MONTHLY_ALLOCATION = '   ';
      expect(resolveAICreditsMonthlyAllocation()).toBe(100);
    });

    it('uses a valid positive integer from the env', () => {
      process.env.AI_CREDITS_MONTHLY_ALLOCATION = '250';
      expect(resolveAICreditsMonthlyAllocation()).toBe(250);
    });

    it.each(['0', '-5', '1.5', 'abc', 'NaN', 'Infinity'])(
      'falls back to 100 for invalid value %s',
      (value) => {
        process.env.AI_CREDITS_MONTHLY_ALLOCATION = value;
        expect(resolveAICreditsMonthlyAllocation()).toBe(100);
        expect(logger.warn).toHaveBeenCalled();
      },
    );
  });

  describe('ensureAICreditsPeriod (SCRUM-4939)', () => {
    const ORIGINAL = process.env.AI_CREDITS_MONTHLY_ALLOCATION;

    afterEach(() => {
      if (ORIGINAL === undefined) {
        delete process.env.AI_CREDITS_MONTHLY_ALLOCATION;
      } else {
        process.env.AI_CREDITS_MONTHLY_ALLOCATION = ORIGINAL;
      }
    });

    it('returns false immediately for an empty orgId without touching the DB', async () => {
      const result = await ensureAICreditsPeriod('');
      expect(result).toBe(false);
      expect(db.from).not.toHaveBeenCalled();
    });

    it('creates a row for the current UTC calendar month when none exists', async () => {
      delete process.env.AI_CREDITS_MONTHLY_ALLOCATION;
      const selectChain = createSelectChain({ data: null, error: null });
      const insertMock = vi.fn().mockResolvedValue({ error: null });
      (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn(() => selectChain),
        insert: insertMock,
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

    it('honors AI_CREDITS_MONTHLY_ALLOCATION when creating a row', async () => {
      process.env.AI_CREDITS_MONTHLY_ALLOCATION = '250';
      const selectChain = createSelectChain({ data: null, error: null });
      const insertMock = vi.fn().mockResolvedValue({ error: null });
      (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn(() => selectChain),
        insert: insertMock,
      });

      await ensureAICreditsPeriod('org-123', new Date('2026-09-12T14:00:00Z'));

      expect(insertMock).toHaveBeenCalledWith(
        expect.objectContaining({ monthly_allocation: 250 }),
      );
    });

    it('is a no-op and never overwrites used_this_month when a row already covers the period', async () => {
      const selectChain = createSelectChain({ data: { id: 'row-1' }, error: null });
      const insertMock = vi.fn();
      (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn(() => selectChain),
        insert: insertMock,
      });

      const result = await ensureAICreditsPeriod('org-123', new Date('2026-09-12T14:00:00Z'));

      expect(result).toBe(true);
      expect(insertMock).not.toHaveBeenCalled();
    });

    it('returns false without throwing when the period lookup errors', async () => {
      const selectChain = createSelectChain({ data: null, error: { message: 'timeout' } });
      const insertMock = vi.fn();
      (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn(() => selectChain),
        insert: insertMock,
      });

      const result = await ensureAICreditsPeriod('org-123');

      expect(result).toBe(false);
      expect(insertMock).not.toHaveBeenCalled();
    });

    it('returns false without throwing when the insert fails (treated as non-fatal race)', async () => {
      const selectChain = createSelectChain({ data: null, error: null });
      const insertMock = vi.fn().mockResolvedValue({ error: { message: 'duplicate key value' } });
      (db.from as ReturnType<typeof vi.fn>).mockReturnValue({
        select: vi.fn(() => selectChain),
        insert: insertMock,
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
  });
});

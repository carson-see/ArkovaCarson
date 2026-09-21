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
  refundAICredits,
  logAIUsageEvent,
  ensureAICreditsPeriod,
  CREDIT_ALLOCATIONS,
  MAX_REFUNDABLE_AMOUNT,
} from './cost-tracker.js';

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

    // Migration 0483: `deduct_ai_credits` gains `SET lock_timeout='5s'`, so a
    // contended `SELECT … FOR UPDATE` now aborts with SQLSTATE 55P03
    // (lock_not_available) instead of blocking to `statement_timeout`. That is
    // an infrastructure failure, NOT "the org is out of credits": no debit was
    // recorded, so the only safe answer is a falsy return that every caller
    // treats as "do not perform the paid work".
    it('fails CLOSED on a 55P03 lock_not_available error from the debit RPC', async () => {
      (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: null,
        error: {
          code: '55P03',
          message: 'canceling statement due to lock timeout',
          details: null,
          hint: null,
        },
      });

      const result = await deductAICredits('org-123', 'user-123', 1);

      expect(result).toBe(false);
    });

    // 0467 added `p_amount <= 0 -> RETURN false` to the RPC, which turned every
    // `deductAICredits(org, user, -1)` refund into a silent no-op for three
    // weeks. Refunds now go through `refundAICredits`; a negative amount here
    // is a caller bug and must be rejected in TypeScript so the mistake cannot
    // recur silently behind an RPC that answers `false` either way.
    it('rejects a non-positive amount without calling the RPC', async () => {
      (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: true, error: null });

      await expect(deductAICredits('org-123', 'user-123', -1)).resolves.toBe(false);
      await expect(deductAICredits('org-123', 'user-123', 0)).resolves.toBe(false);

      expect(db.rpc).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ amount: -1, orgId: 'org-123' }),
        expect.stringContaining('refundAICredits'),
      );
    });

    // The SQLSTATE has to reach the operator: 55P03 means "a stuck holder is
    // sitting on the org's credit row", which is a different page than
    // "connection refused". Flattening every error into a bare message makes
    // the two indistinguishable in the log stream.
    it('logs the SQLSTATE so a lock timeout is greppable', async () => {
      (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: null,
        error: {
          code: '55P03',
          message: 'canceling statement due to lock timeout',
        },
      });

      await deductAICredits('org-123', 'user-123', 1);

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ code: '55P03', orgId: 'org-123', userId: 'user-123' }),
        expect.stringContaining('Failed to deduct AI credits'),
      );
    });
  });

  // Migration 0483 adds `public.refund_ai_credits`, a DEDICATED credit-return
  // RPC. `deduct_ai_credits` deliberately stays closed to negative amounts —
  // a negative debit is an unbounded credit grant.
  describe('refundAICredits', () => {
    it('calls refund_ai_credits with a POSITIVE amount, never deduct_ai_credits', async () => {
      (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: true, error: null });

      const result = await refundAICredits('org-123', 'user-123', 1);

      expect(result).toBe(true);
      expect(db.rpc).toHaveBeenCalledWith('refund_ai_credits', {
        p_org_id: 'org-123',
        p_user_id: 'user-123',
        p_amount: 1,
      });
      expect(db.rpc).not.toHaveBeenCalledWith('deduct_ai_credits', expect.anything());
    });

    it('returns false when the RPC reports no row was credited', async () => {
      (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: false, error: null });

      await expect(refundAICredits('org-123')).resolves.toBe(false);
    });

    it('fails CLOSED and logs the SQLSTATE on a 55P03 lock timeout', async () => {
      (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: null,
        error: { code: '55P03', message: 'canceling statement due to lock timeout' },
      });

      await expect(refundAICredits('org-123', 'user-123', 1)).resolves.toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ code: '55P03', orgId: 'org-123', userId: 'user-123' }),
        expect.stringContaining('Failed to refund AI credits'),
      );
    });

    it('returns false on exception', async () => {
      (db.rpc as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));

      await expect(refundAICredits('org-123')).resolves.toBe(false);
    });

    // The DB caps the amount too; this bound is the TypeScript half so a
    // corrupted caller cannot even attempt to mint an arbitrary balance. It
    // mirrors MAX_RECONCILABLE_AMOUNT, the bound the reconcile job's Zod
    // schema has enforced on the same operation since it shipped.
    it('refuses a non-positive or over-cap amount without calling the RPC', async () => {
      (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: true, error: null });

      expect(MAX_REFUNDABLE_AMOUNT).toBe(1000);
      await expect(refundAICredits('org-123', undefined, 0)).resolves.toBe(false);
      await expect(refundAICredits('org-123', undefined, -5)).resolves.toBe(false);
      await expect(
        refundAICredits('org-123', undefined, MAX_REFUNDABLE_AMOUNT + 1),
      ).resolves.toBe(false);

      expect(db.rpc).not.toHaveBeenCalled();
    });

    it('refuses when neither org nor user is identified', async () => {
      (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: true, error: null });

      await expect(refundAICredits(undefined, undefined, 1)).resolves.toBe(false);
      expect(db.rpc).not.toHaveBeenCalled();
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

  describe('ensureAICreditsPeriod atomic RPC (SCRUM-4939)', () => {
    it('passes owner, configured allocation, and exact time to the atomic RPC', async () => {
      (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: true, error: null });
      const now = new Date('2026-09-12T14:00:00Z');
      mockConfig.aiCreditsMonthlyAllocation = 250;
      await expect(ensureAICreditsPeriod('org-123', now)).resolves.toBe(true);
      expect(db.rpc).toHaveBeenCalledWith('ensure_ai_credits_period', {
        p_org_id: 'org-123', p_monthly_allocation: 250, p_now: now.toISOString(),
      });
      expect(db.from).not.toHaveBeenCalled();
    });

    it('allows concurrent callers to share the database-serialized result', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      (db.rpc as ReturnType<typeof vi.fn>).mockImplementation(async () => { await gate; return { data: true, error: null }; });
      const calls = [ensureAICreditsPeriod('org-123'), ensureAICreditsPeriod('org-123')];
      release();
      await expect(Promise.all(calls)).resolves.toEqual([true, true]);
      expect(db.rpc).toHaveBeenCalledTimes(2);
      expect(db.from).not.toHaveBeenCalled();
    });

    it('fails closed on RPC error and invalid owner', async () => {
      (db.rpc as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null, error: { message: 'lock timeout' } });
      await expect(ensureAICreditsPeriod('org-123')).resolves.toBe(false);
      await expect(ensureAICreditsPeriod('')).resolves.toBe(false);
      expect(logger.warn).toHaveBeenCalled();
    });
  });
});

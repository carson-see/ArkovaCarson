/**
 * Unit tests for Payment Guard (RISK-1)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRpc, mockSelect, mockLogger } = vi.hoisted(() => {
  const mockRpc = vi.fn();
  const mockSelect = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { mockRpc, mockSelect, mockLogger };
});

vi.mock('../utils/db.js', () => ({
  db: {
    rpc: mockRpc,
    from: vi.fn((_table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        in: vi.fn(() => chain),
        order: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        maybeSingle: mockSelect,
        single: mockSelect,
      };
      return chain;
    }),
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: mockLogger,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkPaymentGuard', () => {
  it('returns authorized when beta unlimited is active', async () => {
    mockRpc.mockResolvedValue({ data: null }); // NULL = unlimited
    const { checkPaymentGuard } = await import('./paymentGuard.js');
    const result = await checkPaymentGuard('user-1', 'org-1', 'anchor-1');
    expect(result.authorized).toBe(true);
    expect(result.source?.type).toBe('beta_unlimited');
  });

  it('returns authorized for admin users when beta is off', async () => {
    mockRpc.mockResolvedValue({ data: 3 }); // Non-null = quota active
    mockSelect
      .mockResolvedValueOnce({ data: { is_platform_admin: true } }) // isAdminUser
      .mockResolvedValueOnce({ data: null }); // hasActiveSubscription

    const { checkPaymentGuard } = await import('./paymentGuard.js');
    const result = await checkPaymentGuard('admin-1', null, 'anchor-1');
    expect(result.authorized).toBe(true);
    expect(result.source?.type).toBe('admin_bypass');
  });

  it('returns authorized for users with active subscription', async () => {
    mockRpc.mockResolvedValue({ data: 3 }); // Non-null = quota active
    mockSelect
      .mockResolvedValueOnce({ data: { is_platform_admin: false } }) // isAdminUser
      .mockResolvedValueOnce({ data: { id: 'sub-1', stripe_subscription_id: 'sub_stripe', status: 'active' } }); // hasActiveSubscription

    const { checkPaymentGuard } = await import('./paymentGuard.js');
    const result = await checkPaymentGuard('user-1', 'org-1', 'anchor-1');
    expect(result.authorized).toBe(true);
    expect(result.source?.type).toBe('stripe');
  });

  it('returns unauthorized when no payment source exists', async () => {
    mockRpc.mockResolvedValue({ data: 3 }); // Non-null = quota active
    mockSelect.mockResolvedValue({ data: null }); // All checks return null

    const { checkPaymentGuard } = await import('./paymentGuard.js');
    const result = await checkPaymentGuard('user-1', null, 'anchor-1');
    expect(result.authorized).toBe(false);
    expect(result.reason).toContain('No active subscription');
  });

  // SCRUM-1280 (R3-7): the previous hasX402Payment query had no `org_id`
  // filter — any org's verified payment could authorize an anchor for any
  // other org. This test pins the org-scoped + verified=true query shape so
  // a regression is caught at PR time.
  it('hasX402Payment scopes the lookup by org_id AND verified=true (SCRUM-1280)', async () => {
    const eqCalls: Array<[string, unknown]> = [];

    const { db: dbModule } = await import('../utils/db.js');
    vi.mocked(dbModule.from).mockImplementation((_table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: vi.fn(() => chain),
        eq: vi.fn((col: string, val: unknown) => {
          eqCalls.push([col, val]);
          return chain;
        }),
        in: vi.fn(() => chain),
        order: vi.fn(() => chain),
        limit: vi.fn(() =>
          Promise.resolve({ data: [{ id: 'pay-1', tx_hash: '0xabc' }], error: null }),
        ),
        maybeSingle: vi.fn(),
        single: vi.fn(),
      };
      return chain;
    });

    mockRpc.mockResolvedValue({ data: 3 }); // quota active (not unlimited)
    mockSelect
      .mockResolvedValueOnce({ data: { is_platform_admin: false } }) // not admin
      .mockResolvedValueOnce({ data: null }); // no active subscription

    const { checkPaymentGuard } = await import('./paymentGuard.js');
    const result = await checkPaymentGuard('user-1', 'org-target', 'anchor-1');

    expect(result.authorized).toBe(true);
    expect(result.source?.type).toBe('x402');
    // Both filters must be present: org_id then verified.
    expect(eqCalls).toEqual(
      expect.arrayContaining([
        ['org_id', 'org-target'],
        ['verified', true],
      ]),
    );
  });

  it('hasX402Payment returns null when org has no verified x402 payment (SCRUM-1280 negative path)', async () => {
    const { db: dbModule } = await import('../utils/db.js');
    vi.mocked(dbModule.from).mockImplementation((_table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        in: vi.fn(() => chain),
        order: vi.fn(() => chain),
        limit: vi.fn(() => Promise.resolve({ data: [], error: null })),
        maybeSingle: vi.fn(),
        single: vi.fn(),
      };
      return chain;
    });

    mockRpc.mockResolvedValue({ data: 3 });
    mockSelect
      .mockResolvedValueOnce({ data: { is_platform_admin: false } })
      .mockResolvedValueOnce({ data: null });

    const { checkPaymentGuard } = await import('./paymentGuard.js');
    const result = await checkPaymentGuard('user-1', 'org-empty', 'anchor-1');
    expect(result.authorized).toBe(false);
  });
});

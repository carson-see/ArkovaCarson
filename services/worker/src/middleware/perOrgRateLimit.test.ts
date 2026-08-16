/**
 * Per-org quota contract tests (SCRUM-2703).
 *
 * These tests pin both the pricing shape and the fail-closed middleware
 * behavior. Route-wiring tests live beside the mounted API routers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFrom, mockRpc, mockLogger } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRpc: vi.fn(),
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({ config: {} }));
vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../utils/db.js', () => ({ db: { from: mockFrom, rpc: mockRpc } }));

const { TIER_QUOTAS, evaluateQuota, requireOrgQuota } = await import('./perOrgRateLimit.js');
type OrgTier = 'FREE' | 'PAID' | 'ENTERPRISE';
type QuotaKind = 'anchors_created' | 'rule_drafts' | 'rules_total' | 'connectors_total';

function installDbResponses(args: {
  tier?: OrgTier;
  orgError?: unknown;
  capacityCount?: number | null;
  capacityError?: unknown;
  /** Recorded `org_daily_usage.count` before this request (FD-RL-2 pre-check). */
  dailyCount?: number | null;
  dailyError?: unknown;
} = {}): void {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'organizations') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({
              data: args.orgError ? null : { id: 'org-trusted', tier: args.tier ?? 'FREE' },
              error: args.orgError ?? null,
            }),
          })),
        })),
      };
    }
    if (table === 'org_daily_usage') {
      const row = args.dailyCount == null ? null : { count: args.dailyCount };
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: args.dailyError ? null : row,
                  error: args.dailyError ?? null,
                }),
              })),
            })),
          })),
        })),
      };
    }
    if (table === 'organization_rules' || table === 'webhook_endpoints') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn().mockResolvedValue({
            data: null,
            count: args.capacityCount ?? 0,
            error: args.capacityError ?? null,
          }),
        })),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

function responseDouble(seedHeaders: Record<string, string> = {}) {
  const headers = new Map<string, string>(Object.entries(seedHeaders));
  return {
    headers,
    setHeader: vi.fn((name: string, value: string) => {
      headers.set(name, value);
    }),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
}

/**
 * Headers exactly as `utils/rateLimit.ts` (the per-minute API-key limiter)
 * leaves them when it ALLOWS a request — verbatim from the fullsoak capture in
 * docs/staging/fullsoak-2026-08/FD-RL-quota-headers-and-counter.md.
 */
const PER_MINUTE_ALLOW_HEADERS = {
  'X-RateLimit-Limit': '1000',
  'X-RateLimit-Remaining': '987',
  'X-RateLimit-Reset': '1786897601',
};

beforeEach(() => {
  vi.clearAllMocks();
  installDbResponses();
  mockRpc.mockResolvedValue({ data: 1, error: null });
});

describe('TIER_QUOTAS table — pin the pricing shape', () => {
  it('pins daily and capacity limits without treating webhook traffic as connector capacity', () => {
    expect(TIER_QUOTAS.FREE).toEqual({
      anchors_created: 100,
      rule_drafts: 5,
      rules_total: 10,
      connectors_total: 3,
    });
    expect(TIER_QUOTAS.PAID).toEqual({
      anchors_created: 10_000,
      rule_drafts: Number.POSITIVE_INFINITY,
      rules_total: 100,
      connectors_total: 10,
    });
    expect(TIER_QUOTAS.ENTERPRISE.connectors_total).toBe(Number.POSITIVE_INFINITY);
  });

  it('covers every QuotaKind for every OrgTier', () => {
    const tiers: OrgTier[] = ['FREE', 'PAID', 'ENTERPRISE'];
    const kinds: QuotaKind[] = [
      'anchors_created',
      'rule_drafts',
      'rules_total',
      'connectors_total',
    ];
    for (const tier of tiers) {
      for (const kind of kinds) expect(TIER_QUOTAS[tier][kind]).toBeDefined();
    }
  });
});

describe('evaluateQuota — pure decision', () => {
  it('allows at the limit and rejects one past it', () => {
    expect(evaluateQuota({ tier: 'FREE', kind: 'anchors_created', currentCount: 100 }))
      .toEqual({ allowed: true, limit: 100, remaining: 0 });
    expect(evaluateQuota({ tier: 'FREE', kind: 'anchors_created', currentCount: 101 }))
      .toEqual({ allowed: false, limit: 100, remaining: 0 });
  });

  it('returns -1 limit and remaining for unlimited tiers', () => {
    expect(evaluateQuota({ tier: 'ENTERPRISE', kind: 'rules_total', currentCount: 1_000_000 }))
      .toEqual({ allowed: true, limit: -1, remaining: -1 });
  });
});

describe('requireOrgQuota — daily usage', () => {
  it('increments by validated request cardinality and emits canonical plus compatibility headers', async () => {
    mockRpc.mockResolvedValue({ data: 12, error: null });
    const middleware = requireOrgQuota({
      kind: 'anchors_created',
      mode: 'daily',
      getOrgId: () => 'org-trusted',
      getDelta: () => 3,
    });
    const res = responseDouble();
    const next = vi.fn();

    await middleware({} as never, res as never, next);

    expect(mockRpc).toHaveBeenCalledWith('increment_org_usage', {
      p_org_id: 'org-trusted',
      p_quota_kind: 'anchors_created',
      p_delta: 3,
    });
    expect(res.headers.get('X-Org-Quota-Anchors-Limit')).toBe('100');
    expect(res.headers.get('X-Org-Quota-Anchors-Remaining')).toBe('88');
    expect(res.headers.get('X-Org-Quota-Anchors-Created-Limit')).toBe('100');
    expect(next).toHaveBeenCalledOnce();
  });

  it('does not meter a body that the route schema rejects', async () => {
    const middleware = requireOrgQuota({
      kind: 'anchors_created',
      mode: 'daily',
      getOrgId: () => 'org-trusted',
      getDelta: () => 0,
    });
    const res = responseDouble();
    const next = vi.fn();

    await middleware({} as never, res as never, next);

    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('fails closed when the recorded daily usage cannot be read', async () => {
    installDbResponses({ dailyError: { message: 'usage read failed' } });
    const middleware = requireOrgQuota({
      kind: 'anchors_created',
      mode: 'daily',
      getOrgId: () => 'org-trusted',
    });
    const res = responseDouble();
    const next = vi.fn();

    await middleware({} as never, res as never, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed when organization lookup fails without logging the raw org id', async () => {
    installDbResponses({ orgError: { message: 'db unavailable' } });
    const middleware = requireOrgQuota({
      kind: 'anchors_created',
      getOrgId: () => 'org-sensitive',
    });
    const res = responseDouble();

    await middleware({} as never, res as never, vi.fn());

    expect(res.status).toHaveBeenCalledWith(503);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain('org-sensitive');
  });
});

/**
 * FD-RL-2 — `org_daily_usage.count` for `anchors_created` incremented on every
 * REQUEST, including requests the quota itself denied with 429. Measured on the
 * fullsoak-2026-08 rig: count=3132 on a day the org created 98 anchors (32x).
 * A client with a naive retry loop drove its own counter further past the cap
 * with every rejected retry and could never get back under it before reset.
 *
 * Evidence: docs/staging/fullsoak-2026-08/FD-RL-quota-headers-and-counter.md
 */
describe('FD-RL-2 — a denied request must not consume quota', () => {
  it('does not increment the daily counter when the request is denied', async () => {
    installDbResponses({ dailyCount: 100 });
    const middleware = requireOrgQuota({
      kind: 'anchors_created',
      mode: 'daily',
      getOrgId: () => 'org-trusted',
    });
    const res = responseDouble();
    const next = vi.fn();

    await middleware({} as never, res as never, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('leaves the counter unchanged across a retry storm of denied requests', async () => {
    // The rig saw 3,030 consecutive denials drive the counter to 3,132.
    // Replay the same shape: the recorded count is authoritative and static,
    // so every attempt must observe the SAME `current` and write nothing.
    const RECORDED = 100;
    installDbResponses({ dailyCount: RECORDED });
    const middleware = requireOrgQuota({
      kind: 'anchors_created',
      mode: 'daily',
      getOrgId: () => 'org-trusted',
    });

    const reported: unknown[] = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const res = responseDouble();
      const next = vi.fn();
      await middleware({} as never, res as never, next);
      expect(res.status).toHaveBeenCalledWith(429);
      expect(next).not.toHaveBeenCalled();
      reported.push(
        (res.json.mock.calls[0]?.[0] as { error: { current: number } }).error.current,
      );
    }

    expect(mockRpc).not.toHaveBeenCalled();
    expect(new Set(reported).size).toBe(1);
    expect(reported[0]).toBe(RECORDED + 1);
  });

  it('still atomically increments when the request is allowed', async () => {
    installDbResponses({ dailyCount: 98 });
    mockRpc.mockResolvedValue({ data: 99, error: null });
    const middleware = requireOrgQuota({
      kind: 'anchors_created',
      mode: 'daily',
      getOrgId: () => 'org-trusted',
    });
    const res = responseDouble();
    const next = vi.fn();

    await middleware({} as never, res as never, next);

    expect(mockRpc).toHaveBeenCalledWith('increment_org_usage', {
      p_org_id: 'org-trusted',
      p_quota_kind: 'anchors_created',
      p_delta: 1,
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it('denies without incrementing when a bulk delta would cross the cap', async () => {
    installDbResponses({ dailyCount: 95 });
    const middleware = requireOrgQuota({
      kind: 'anchors_created',
      mode: 'daily',
      getOrgId: () => 'org-trusted',
      getDelta: () => 20,
    });
    const res = responseDouble();
    const next = vi.fn();

    await middleware({} as never, res as never, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('denies a request that loses the atomic increment race, which capacity mode cannot hit', async () => {
    // Pre-check passes, but a concurrent request consumed the last unit first.
    // The reserve-then-evaluate path still denies; this is the ONLY path on
    // which a denial leaves a unit recorded, and it is bounded by in-flight
    // concurrency at the cap boundary rather than by retry volume.
    installDbResponses({ dailyCount: 99 });
    mockRpc.mockResolvedValue({ data: 101, error: null });
    const middleware = requireOrgQuota({
      kind: 'anchors_created',
      mode: 'daily',
      getOrgId: () => 'org-trusted',
    });
    const res = responseDouble();
    const next = vi.fn();

    await middleware({} as never, res as never, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });

  it('records no usage at all when capacity mode denies (capacity mode never had the flaw)', async () => {
    installDbResponses({ capacityCount: 3 });
    const middleware = requireOrgQuota({
      kind: 'connectors_total',
      mode: 'capacity',
      getOrgId: () => 'org-trusted',
    });
    const res = responseDouble();

    await middleware({} as never, res as never, vi.fn());

    expect(res.status).toHaveBeenCalledWith(429);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalledWith('org_daily_usage');
  });
});

/**
 * FD-RL-1 — the org-quota 429 carried the PER-MINUTE limiter's headers.
 * Observed on the rig: `x-ratelimit-remaining: 987` on a DENIED request, while
 * the body correctly said ORG_QUOTA_EXCEEDED. A well-behaved SDK reads 987 and
 * retries immediately against a quota that will not reset for hours.
 *
 * Rule: whichever limiter issues the 429 owns the rate-limit headers on that
 * response. The JSON body contract is unchanged.
 */
describe('FD-RL-1 — the limiter that denies owns the rate-limit headers', () => {
  it('does not advertise remaining headroom on a daily-quota 429', async () => {
    installDbResponses({ dailyCount: 100 });
    const middleware = requireOrgQuota({
      kind: 'anchors_created',
      mode: 'daily',
      getOrgId: () => 'org-trusted',
    });
    const res = responseDouble(PER_MINUTE_ALLOW_HEADERS);

    await middleware({} as never, res as never, vi.fn());

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(res.headers.get('X-RateLimit-Limit')).toBe('100');
    // Reset must describe the quota that actually denied — a UTC-midnight
    // epoch consistent with Retry-After, not the per-minute bucket's epoch.
    const retryAfter = Number(res.headers.get('Retry-After'));
    const reset = Number(res.headers.get('X-RateLimit-Reset'));
    expect(res.headers.get('X-RateLimit-Reset')).not.toBe('1786897601');
    expect(Math.abs(reset - (Math.floor(Date.now() / 1000) + retryAfter))).toBeLessThanOrEqual(1);
  });

  it('does not advertise remaining headroom on a capacity-quota 429', async () => {
    installDbResponses({ capacityCount: 3 });
    const middleware = requireOrgQuota({
      kind: 'connectors_total',
      mode: 'capacity',
      getOrgId: () => 'org-trusted',
    });
    const res = responseDouble(PER_MINUTE_ALLOW_HEADERS);

    await middleware({} as never, res as never, vi.fn());

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(res.headers.get('X-RateLimit-Limit')).toBe('3');
  });

  it('leaves the per-minute limiter headers alone when the quota allows', async () => {
    installDbResponses({ dailyCount: 5 });
    mockRpc.mockResolvedValue({ data: 6, error: null });
    const middleware = requireOrgQuota({
      kind: 'anchors_created',
      mode: 'daily',
      getOrgId: () => 'org-trusted',
    });
    const res = responseDouble(PER_MINUTE_ALLOW_HEADERS);
    const next = vi.fn();

    await middleware({} as never, res as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('987');
    expect(res.headers.get('X-RateLimit-Limit')).toBe('1000');
    expect(res.headers.get('X-RateLimit-Reset')).toBe('1786897601');
  });

  it('keeps the frozen ORG_QUOTA_EXCEEDED body contract intact (CLAUDE.md §1.8)', async () => {
    installDbResponses({ dailyCount: 100 });
    const middleware = requireOrgQuota({
      kind: 'anchors_created',
      mode: 'daily',
      getOrgId: () => 'org-trusted',
    });
    const res = responseDouble(PER_MINUTE_ALLOW_HEADERS);

    await middleware({} as never, res as never, vi.fn());

    const body = res.json.mock.calls[0]?.[0] as {
      error: Record<string, unknown>;
    };
    expect(Object.keys(body.error).sort((a, b) => a.localeCompare(b))).toEqual([
      'code',
      'current',
      'limit',
      'message',
      'quota_type',
      'reset_at',
    ]);
    expect(body.error.code).toBe('ORG_QUOTA_EXCEEDED');
    expect(body.error.quota_type).toBe('anchors_created');
    expect(body.error.limit).toBe(100);
    expect(body.error.message).toBe('Your FREE plan limit for anchors_created is 100');
    expect(String(body.error.reset_at)).toMatch(/T00:00:00\.000Z$/);
  });
});

describe('requireOrgQuota — authoritative capacity', () => {
  it('allows the projected rules total at the limit without calling the daily RPC', async () => {
    installDbResponses({ capacityCount: 9 });
    const middleware = requireOrgQuota({
      kind: 'rules_total',
      mode: 'capacity',
      getOrgId: () => 'org-trusted',
    });
    const res = responseDouble();
    const next = vi.fn();

    await middleware({} as never, res as never, next);

    expect(mockRpc).not.toHaveBeenCalled();
    expect(res.headers.get('X-Org-Quota-Rules-Limit')).toBe('10');
    expect(res.headers.get('X-Org-Quota-Rules-Remaining')).toBe('0');
    expect(res.headers.get('X-Org-Quota-Rules-Reset')).toBe('none');
    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects connector creation above capacity with an integer Retry-After and legacy alias', async () => {
    installDbResponses({ capacityCount: 3 });
    const middleware = requireOrgQuota({
      kind: 'connectors_total',
      mode: 'capacity',
      getOrgId: () => 'org-trusted',
    });
    const res = responseDouble();
    const next = vi.fn();

    await middleware({} as never, res as never, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.headers.get('X-Org-Quota-Connectors-Limit')).toBe('3');
    expect(res.headers.get('X-Org-Quota-Connector-Webhooks-Limit')).toBe('3');
    expect(res.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed when the authoritative capacity count is unavailable', async () => {
    installDbResponses({ capacityError: { message: 'count failed' } });
    const middleware = requireOrgQuota({
      kind: 'rules_total',
      mode: 'capacity',
      getOrgId: () => 'org-trusted',
    });
    const res = responseDouble();

    await middleware({} as never, res as never, vi.fn());

    expect(res.status).toHaveBeenCalledWith(503);
  });
});

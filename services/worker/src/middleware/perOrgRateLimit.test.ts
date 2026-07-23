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

function responseDouble() {
  const headers = new Map<string, string>();
  return {
    headers,
    setHeader: vi.fn((name: string, value: string) => {
      headers.set(name, value);
    }),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
}

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

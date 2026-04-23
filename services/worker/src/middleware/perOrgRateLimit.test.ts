/**
 * Tests for SCALE-01 per-org rate limit decision function.
 *
 * The full middleware roundtrip is exercised by integration tests once
 * migration 0230 is applied; this file covers the pure evaluator + the
 * quota table constants (so a silent change to the pricing tiers fails
 * CI).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config.js', () => ({ config: {} }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/db.js', () => ({ db: { from: vi.fn(), rpc: vi.fn() } }));

const { TIER_QUOTAS, evaluateQuota } = await import('./perOrgRateLimit.js');
type OrgTier = 'FREE' | 'PAID' | 'ENTERPRISE';
type QuotaKind = 'anchors_created' | 'rule_drafts' | 'rules_total' | 'connector_webhooks';

describe('TIER_QUOTAS table — pin the pricing shape', () => {
  it('FREE tier has the documented daily caps', () => {
    expect(TIER_QUOTAS.FREE.anchors_created).toBe(100);
    expect(TIER_QUOTAS.FREE.rule_drafts).toBe(5);
    expect(TIER_QUOTAS.FREE.rules_total).toBe(10);
  });

  it('PAID tier raises anchor cap 100x', () => {
    expect(TIER_QUOTAS.PAID.anchors_created).toBe(10_000);
    expect(TIER_QUOTAS.PAID.rules_total).toBe(100);
  });

  it('ENTERPRISE has unlimited rules + drafts', () => {
    expect(TIER_QUOTAS.ENTERPRISE.rule_drafts).toBe(Number.POSITIVE_INFINITY);
    expect(TIER_QUOTAS.ENTERPRISE.rules_total).toBe(Number.POSITIVE_INFINITY);
    expect(TIER_QUOTAS.ENTERPRISE.connector_webhooks).toBe(Number.POSITIVE_INFINITY);
  });

  it('covers every QuotaKind for every OrgTier (no undefined entries)', () => {
    const tiers: OrgTier[] = ['FREE', 'PAID', 'ENTERPRISE'];
    const kinds: QuotaKind[] = [
      'anchors_created',
      'rule_drafts',
      'rules_total',
      'connector_webhooks',
    ];
    for (const t of tiers) {
      for (const k of kinds) {
        expect(TIER_QUOTAS[t][k]).toBeDefined();
      }
    }
  });
});

describe('evaluateQuota — pure decision', () => {
  it('allows when current count is below limit', () => {
    const r = evaluateQuota({ tier: 'FREE', kind: 'anchors_created', currentCount: 50 });
    expect(r.allowed).toBe(true);
    expect(r.limit).toBe(100);
    expect(r.remaining).toBe(50);
  });

  it('allows exactly at limit (post-increment = limit)', () => {
    const r = evaluateQuota({ tier: 'FREE', kind: 'anchors_created', currentCount: 100 });
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(0);
  });

  it('rejects one past limit', () => {
    const r = evaluateQuota({ tier: 'FREE', kind: 'anchors_created', currentCount: 101 });
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it('returns -1 limit + -1 remaining for unlimited tiers', () => {
    const r = evaluateQuota({
      tier: 'ENTERPRISE',
      kind: 'rule_drafts',
      currentCount: 1_000_000,
    });
    expect(r.allowed).toBe(true);
    expect(r.limit).toBe(-1);
    expect(r.remaining).toBe(-1);
  });

  it('does not return negative remaining when currentCount exceeds limit', () => {
    const r = evaluateQuota({ tier: 'FREE', kind: 'rule_drafts', currentCount: 100 });
    expect(r.remaining).toBe(0);
  });
});

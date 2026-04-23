/**
 * Treasury alerting unit tests (ARK-103 — SCRUM-1013).
 *
 * Focuses on the pure decision function — the dispatcher wrapper is
 * covered by integration tests against a mocked Supabase client.
 */

import { describe, expect, it, vi } from 'vitest';

// Mock the config + db + logger modules so importing the SUT doesn't trip
// loadConfig() (which requires a real .env to be present at test time).
vi.mock('../config.js', () => ({ config: {} }));
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('../utils/db.js', () => ({ db: { from: vi.fn() } }));

const {
  DEFAULT_THRESHOLD_USD,
  buildSlackAlertPayload,
  decideTreasuryAlert,
} = await import('./treasury-alert.js');

const SATS_PER_BTC = 100_000_000;

// Helper: figure out how many sats we need to be at a given USD balance.
function satsForUsd(usd: number, priceUsd: number): number {
  return Math.round((usd / priceUsd) * SATS_PER_BTC);
}

describe('decideTreasuryAlert — threshold behavior', () => {
  const priceUsd = 65000; // stable fixture price

  it('does not fire when balance is above threshold', () => {
    const d = decideTreasuryAlert({
      balance_confirmed_sats: satsForUsd(100, priceUsd),
      btc_price_usd: priceUsd,
    });
    expect(d.should_fire).toBe(false);
    expect(d.below_threshold).toBe(false);
    expect(d.balance_usd).toBeGreaterThan(DEFAULT_THRESHOLD_USD);
  });

  it('fires when balance crosses below threshold for the first time', () => {
    const d = decideTreasuryAlert({
      balance_confirmed_sats: satsForUsd(25, priceUsd),
      btc_price_usd: priceUsd,
      last_alert_at: null,
      last_alert_below_threshold: false,
    });
    expect(d.should_fire).toBe(true);
    expect(d.below_threshold).toBe(true);
    expect(d.reason).toMatch(/crossed/i);
  });

  it('fires when previously above-threshold alert now drops below (fresh crossing)', () => {
    const d = decideTreasuryAlert({
      balance_confirmed_sats: satsForUsd(10, priceUsd),
      btc_price_usd: priceUsd,
      last_alert_at: new Date('2026-04-21T00:00:00Z').toISOString(),
      last_alert_below_threshold: false,
      now: new Date('2026-04-21T00:05:00Z'),
    });
    expect(d.should_fire).toBe(true);
  });

  it('suppresses when already alerted below-threshold within the last hour', () => {
    const d = decideTreasuryAlert({
      balance_confirmed_sats: satsForUsd(10, priceUsd),
      btc_price_usd: priceUsd,
      last_alert_at: new Date('2026-04-21T00:00:00Z').toISOString(),
      last_alert_below_threshold: true,
      now: new Date('2026-04-21T00:30:00Z'), // 30 min after last alert
    });
    expect(d.should_fire).toBe(false);
    expect(d.reason).toMatch(/suppressed/i);
  });

  it('re-fires after an hour while still below threshold', () => {
    const d = decideTreasuryAlert({
      balance_confirmed_sats: satsForUsd(10, priceUsd),
      btc_price_usd: priceUsd,
      last_alert_at: new Date('2026-04-21T00:00:00Z').toISOString(),
      last_alert_below_threshold: true,
      now: new Date('2026-04-21T01:01:00Z'), // 61 min after
    });
    expect(d.should_fire).toBe(true);
    expect(d.reason).toMatch(/hourly re-fire/i);
  });

  it('respects a custom threshold', () => {
    const d = decideTreasuryAlert({
      balance_confirmed_sats: satsForUsd(75, priceUsd),
      btc_price_usd: priceUsd,
      threshold_usd: 100,
    });
    expect(d.should_fire).toBe(true);
    expect(d.below_threshold).toBe(true);
  });
});

describe('decideTreasuryAlert — fail-closed on oracle outage', () => {
  it('fires with "price unknown" when btc_price_usd is null', () => {
    const d = decideTreasuryAlert({
      balance_confirmed_sats: 50_000_000,
      btc_price_usd: null,
      last_alert_at: null,
    });
    expect(d.should_fire).toBe(true);
    expect(d.price_unknown).toBe(true);
    expect(d.balance_usd).toBe(null);
  });

  it('fires with "balance unknown" when balance is null', () => {
    const d = decideTreasuryAlert({
      balance_confirmed_sats: null,
      btc_price_usd: 65000,
      last_alert_at: null,
    });
    expect(d.should_fire).toBe(true);
    expect(d.price_unknown).toBe(true);
  });

  it('suppresses oracle-outage alert if one fired within the last hour', () => {
    const d = decideTreasuryAlert({
      balance_confirmed_sats: null,
      btc_price_usd: null,
      last_alert_at: new Date('2026-04-21T00:00:00Z').toISOString(),
      now: new Date('2026-04-21T00:30:00Z'),
    });
    expect(d.should_fire).toBe(false);
  });
});

describe('buildSlackAlertPayload', () => {
  it('formats a USD balance when the price is known', () => {
    const payload = buildSlackAlertPayload({
      should_fire: true,
      reason: 'Freshly crossed below threshold',
      balance_usd: 24.5,
      below_threshold: true,
      price_unknown: false,
    });
    expect(payload.text).toMatch(/\$24\.50 USD/);
    expect(payload.text).toMatch(/LOW/);
  });

  it('falls back to "unknown" when the price is unknown', () => {
    const payload = buildSlackAlertPayload({
      should_fire: true,
      reason: 'oracle down',
      balance_usd: null,
      below_threshold: true,
      price_unknown: true,
    });
    expect(payload.text).toMatch(/oracle unavailable/);
  });

  it('never emits raw wallet addresses or xpubs', () => {
    const payload = buildSlackAlertPayload({
      should_fire: true,
      reason: 'test',
      balance_usd: 10,
      below_threshold: true,
      price_unknown: false,
    });
    const serialized = JSON.stringify(payload);
    // Bitcoin address pattern (simplified — checks for common prefixes).
    expect(serialized).not.toMatch(/\b(bc1|tb1|1|3)[a-zA-HJ-NP-Z0-9]{25,}\b/);
    expect(serialized).not.toMatch(/\bxpub/i);
  });
});

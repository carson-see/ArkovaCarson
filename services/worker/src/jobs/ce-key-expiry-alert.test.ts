/**
 * SCRUM-2902 — CE API key expiry alarm tests.
 *
 * Covers the fail-LOUD contract: unset/sentinel/unparseable date must FIRE every
 * run (never go quiet); the T-30/T-14/T-7 window boundaries; EXPIRED; the silent
 * OK path; the Sentry dispatch tag shape; and the flag gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sentryCapture = vi.hoisted(() => vi.fn());

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/sentry.js', () => ({
  Sentry: { captureMessage: sentryCapture },
}));

import {
  decideCeKeyExpiryAlert,
  runCeKeyExpiryCheck,
  createSentryCeKeyExpiryDispatcher,
  CE_KEY_EXPIRY_ALERT_SOURCE,
  CE_KEY_EXPIRY_ALERT_STORY,
  CE_KEY_EXPIRY_ALERT_TYPE,
  CE_KEY_EXPIRY_WINDOWS_DAYS,
  type CeKeyExpiryDecision,
} from './ce-key-expiry-alert.js';

const NOW = new Date('2026-08-01T00:00:00Z');

/** Build an ISO date `days` whole days after NOW (plus 1h so floor lands on `days`). */
function isoDaysFromNow(days: number): string {
  return new Date(NOW.getTime() + days * 86_400_000 + 3_600_000).toISOString();
}

beforeEach(() => {
  sentryCapture.mockReset();
});

describe('decideCeKeyExpiryAlert — fail-LOUD sentinel path', () => {
  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace', '   '],
    ['REPLACE_ME', 'REPLACE_ME'],
    ['sentinel (mixed case)', 'Sentinel'],
    ['TBD', 'TBD'],
    ['unparseable garbage', 'not-a-date'],
  ])('FIRES (error) when expiry is %s', (_label, raw) => {
    const d = decideCeKeyExpiryAlert({ expires_at_raw: raw, now: NOW });
    expect(d.should_fire).toBe(true);
    expect(d.window).toBe('SENTINEL');
    expect(d.severity).toBe('error');
    expect(d.days_until_expiry).toBeNull();
  });

  it('never throws on an unparseable date (fails loud, not crash)', () => {
    expect(() =>
      decideCeKeyExpiryAlert({ expires_at_raw: '2026-13-99T99:99:99Z', now: NOW }),
    ).not.toThrow();
  });
});

describe('decideCeKeyExpiryAlert — window boundaries', () => {
  it('OK (no fire) when > 30 days out', () => {
    const d = decideCeKeyExpiryAlert({ expires_at_raw: isoDaysFromNow(31), now: NOW });
    expect(d.should_fire).toBe(false);
    expect(d.window).toBe('OK');
    expect(d.severity).toBe('info');
    expect(d.days_until_expiry).toBe(31);
  });

  it('T-30 (warning) at exactly 30 days', () => {
    const d = decideCeKeyExpiryAlert({ expires_at_raw: isoDaysFromNow(CE_KEY_EXPIRY_WINDOWS_DAYS.T30), now: NOW });
    expect(d.should_fire).toBe(true);
    expect(d.window).toBe('T-30');
    expect(d.severity).toBe('warning');
    expect(d.days_until_expiry).toBe(30);
  });

  it('T-14 (warning) at 14 days, T-30 at 15 days', () => {
    expect(decideCeKeyExpiryAlert({ expires_at_raw: isoDaysFromNow(15), now: NOW }).window).toBe('T-30');
    const d = decideCeKeyExpiryAlert({ expires_at_raw: isoDaysFromNow(14), now: NOW });
    expect(d.window).toBe('T-14');
    expect(d.severity).toBe('warning');
  });

  it('T-7 (error) at 7 days, T-14 at 8 days', () => {
    expect(decideCeKeyExpiryAlert({ expires_at_raw: isoDaysFromNow(8), now: NOW }).window).toBe('T-14');
    const d = decideCeKeyExpiryAlert({ expires_at_raw: isoDaysFromNow(7), now: NOW });
    expect(d.window).toBe('T-7');
    expect(d.severity).toBe('error');
  });

  it('EXPIRED (error) at 0 days and in the past — fires continuously', () => {
    const today = decideCeKeyExpiryAlert({ expires_at_raw: NOW.toISOString(), now: NOW });
    expect(today.window).toBe('EXPIRED');
    expect(today.severity).toBe('error');
    expect(today.should_fire).toBe(true);

    const past = decideCeKeyExpiryAlert({ expires_at_raw: isoDaysFromNow(-5), now: NOW });
    expect(past.window).toBe('EXPIRED');
    expect(past.should_fire).toBe(true);
    expect(past.days_until_expiry).toBeLessThan(0);
  });
});

describe('createSentryCeKeyExpiryDispatcher — tag shape', () => {
  it('emits source/story/alert_type/expiry_window/days_until_expiry tags at the decision severity', () => {
    const decision: CeKeyExpiryDecision = {
      should_fire: true,
      window: 'T-7',
      severity: 'error',
      days_until_expiry: 5,
      reason: 'expires in 5 days',
    };
    createSentryCeKeyExpiryDispatcher().captureAlert(decision);
    expect(sentryCapture).toHaveBeenCalledTimes(1);
    const [msg, opts] = sentryCapture.mock.calls[0];
    expect(msg).toBe('expires in 5 days');
    expect(opts.level).toBe('error');
    expect(opts.tags).toMatchObject({
      source: CE_KEY_EXPIRY_ALERT_SOURCE,
      story: CE_KEY_EXPIRY_ALERT_STORY,
      alert_type: CE_KEY_EXPIRY_ALERT_TYPE,
      expiry_window: 'T-7',
      days_until_expiry: '5',
    });
  });

  it('serializes a null day count as "unknown" (sentinel path)', () => {
    createSentryCeKeyExpiryDispatcher().captureAlert({
      should_fire: true,
      window: 'SENTINEL',
      severity: 'error',
      days_until_expiry: null,
      reason: 'unset',
    });
    expect(sentryCapture.mock.calls[0][1].tags.days_until_expiry).toBe('unknown');
  });
});

describe('runCeKeyExpiryCheck — runner + flag gate', () => {
  it('dispatches when in a window', () => {
    const captureAlert = vi.fn();
    const res = runCeKeyExpiryCheck({ captureAlert }, {
      expiresAtRaw: isoDaysFromNow(10),
      now: NOW,
      enabled: true,
    });
    expect(captureAlert).toHaveBeenCalledTimes(1);
    expect(res.fired).toBe(true);
    expect(res.window).toBe('T-14');
  });

  it('does NOT dispatch on the OK path', () => {
    const captureAlert = vi.fn();
    const res = runCeKeyExpiryCheck({ captureAlert }, {
      expiresAtRaw: isoDaysFromNow(90),
      now: NOW,
      enabled: true,
    });
    expect(captureAlert).not.toHaveBeenCalled();
    expect(res.fired).toBe(false);
  });

  it('fires the SENTINEL path when no date is provided (fail-loud)', () => {
    const captureAlert = vi.fn();
    const res = runCeKeyExpiryCheck({ captureAlert }, { expiresAtRaw: undefined, now: NOW, enabled: true });
    expect(captureAlert).toHaveBeenCalledTimes(1);
    expect(res.window).toBe('SENTINEL');
  });

  it('skips entirely when disabled via flag', () => {
    const captureAlert = vi.fn();
    const res = runCeKeyExpiryCheck({ captureAlert }, { expiresAtRaw: undefined, now: NOW, enabled: false });
    expect(captureAlert).not.toHaveBeenCalled();
    expect(res.fired).toBe(false);
  });
});

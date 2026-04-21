/**
 * Tests for ARK-107 scheduled queue reminders (SCRUM-1019).
 */
import { describe, it, expect, vi } from 'vitest';

// Mock config + db + logger so importing the SUT doesn't trip loadConfig().
vi.mock('../config.js', () => ({ config: {} }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/db.js', () => ({ db: { from: vi.fn() } }));

const { cronMatches } = await import('./queue-reminders.js');

function at(iso: string): Date {
  return new Date(iso);
}

describe('cronMatches', () => {
  it('matches exact minute/hour with wildcards elsewhere', () => {
    expect(cronMatches('0 9 * * *', at('2026-04-21T09:00:00Z'))).toBe(true);
    expect(cronMatches('0 9 * * *', at('2026-04-21T09:01:00Z'))).toBe(false);
  });

  it('matches lists', () => {
    const cron = '0,30 9,16 * * *';
    expect(cronMatches(cron, at('2026-04-21T09:00:00Z'))).toBe(true);
    expect(cronMatches(cron, at('2026-04-21T09:30:00Z'))).toBe(true);
    expect(cronMatches(cron, at('2026-04-21T16:30:00Z'))).toBe(true);
    expect(cronMatches(cron, at('2026-04-21T10:30:00Z'))).toBe(false);
  });

  it('day-of-week field uses 0=Sun..6=Sat', () => {
    // 2026-04-21 is a Tuesday (dow=2)
    expect(cronMatches('0 9 * * 2', at('2026-04-21T09:00:00Z'))).toBe(true);
    expect(cronMatches('0 9 * * 1', at('2026-04-21T09:00:00Z'))).toBe(false);
  });

  it('honors IANA timezone for fixed-time reminders (DST-aware)', () => {
    // 2026-04-21 is EDT (UTC-4). 9 AM local → 13:00 UTC.
    expect(cronMatches('0 9 * * *', at('2026-04-21T13:00:00Z'), 'America/New_York')).toBe(true);
    // Same moment, different tz → should NOT match "9 AM".
    expect(cronMatches('0 9 * * *', at('2026-04-21T13:00:00Z'), 'UTC')).toBe(false);
    // Winter: 2026-01-21 is EST (UTC-5). 9 AM local → 14:00 UTC.
    expect(cronMatches('0 9 * * *', at('2026-01-21T14:00:00Z'), 'America/New_York')).toBe(true);
  });

  it('accepts raw minute offsets for tests / programmatic callers', () => {
    expect(cronMatches('0 9 * * *', at('2026-04-21T13:00:00Z'), -240)).toBe(true);
  });

  it('rejects malformed cron', () => {
    expect(cronMatches('not-a-cron', at('2026-04-21T09:00:00Z'))).toBe(false);
    expect(cronMatches('* * *', at('2026-04-21T09:00:00Z'))).toBe(false);
  });

  it('matches all wildcards', () => {
    expect(cronMatches('* * * * *', at('2026-04-21T00:00:00Z'))).toBe(true);
  });
});

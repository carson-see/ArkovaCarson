import { describe, it, expect } from 'vitest';
import { toBadgeStatus, badgeColors, generateBadgeSvg } from './badgeSvg';

describe('toBadgeStatus', () => {
  it('maps SECURED to verified', () => {
    expect(toBadgeStatus('SECURED')).toBe('verified');
  });

  it('maps CONFIRMED to verified', () => {
    expect(toBadgeStatus('CONFIRMED')).toBe('verified');
  });

  it('maps PENDING to pending', () => {
    expect(toBadgeStatus('PENDING')).toBe('pending');
  });

  it('maps SUBMITTED to pending', () => {
    expect(toBadgeStatus('SUBMITTED')).toBe('pending');
  });

  it('maps BROADCASTING to pending', () => {
    expect(toBadgeStatus('BROADCASTING')).toBe('pending');
  });

  it('maps PENDING_RESOLUTION to pending', () => {
    expect(toBadgeStatus('PENDING_RESOLUTION')).toBe('pending');
  });

  it('maps REVOKED to revoked', () => {
    expect(toBadgeStatus('REVOKED')).toBe('revoked');
  });

  it('maps EXPIRED to expired', () => {
    expect(toBadgeStatus('EXPIRED')).toBe('expired');
  });

  it('maps SUPERSEDED to expired', () => {
    expect(toBadgeStatus('SUPERSEDED')).toBe('expired');
  });

  it('maps unknown statuses to pending', () => {
    expect(toBadgeStatus('SOMETHING_ELSE')).toBe('pending');
  });
});

describe('badgeColors', () => {
  it('has entries for all badge statuses', () => {
    expect(badgeColors.verified).toBeDefined();
    expect(badgeColors.pending).toBeDefined();
    expect(badgeColors.revoked).toBeDefined();
    expect(badgeColors.expired).toBeDefined();
  });

  it('pending uses a blue/gray tone distinct from verified green', () => {
    expect(badgeColors.pending.bg).not.toBe(badgeColors.verified.bg);
  });
});

describe('generateBadgeSvg', () => {
  it('returns a valid SVG string', () => {
    const svg = generateBadgeSvg('verified');
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });

  it('uses the correct background color for each status', () => {
    for (const status of ['verified', 'pending', 'revoked', 'expired'] as const) {
      const svg = generateBadgeSvg(status);
      expect(svg).toContain(badgeColors[status].bg);
    }
  });

  it('includes the status label text', () => {
    expect(generateBadgeSvg('verified')).toContain('Verified');
    expect(generateBadgeSvg('pending')).toContain('Pending');
    expect(generateBadgeSvg('revoked')).toContain('Revoked');
    expect(generateBadgeSvg('expired')).toContain('Expired');
  });

  it('produces different SVGs for pending vs verified', () => {
    const pending = generateBadgeSvg('pending');
    const verified = generateBadgeSvg('verified');
    expect(pending).not.toBe(verified);
  });
});

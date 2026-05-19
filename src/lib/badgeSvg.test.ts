/**
 * Badge SVG Generator Tests (CSI-03 / SCRUM-1599)
 */

import { describe, it, expect } from 'vitest';
import { generateBadgeSvg, toBadgeStatus } from './badgeSvg';

describe('generateBadgeSvg', () => {
  it('returns valid SVG string', () => {
    const svg = generateBadgeSvg('ARK-2026-001');
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('includes Arkova branding', () => {
    const svg = generateBadgeSvg('ARK-2026-001');
    expect(svg).toContain('Arkova');
  });

  it('includes Verified label for verified status', () => {
    const svg = generateBadgeSvg('ARK-2026-001', { status: 'verified' });
    expect(svg).toContain('Verified');
  });

  it('includes Revoked label for revoked status', () => {
    const svg = generateBadgeSvg('ARK-2026-001', { status: 'revoked' });
    expect(svg).toContain('Revoked');
  });

  it('includes Expired label for expired status', () => {
    const svg = generateBadgeSvg('ARK-2026-001', { status: 'expired' });
    expect(svg).toContain('Expired');
  });

  it('uses green color for verified status', () => {
    const svg = generateBadgeSvg('ARK-2026-001', { status: 'verified' });
    expect(svg).toContain('#059669');
  });

  it('uses red color for revoked status', () => {
    const svg = generateBadgeSvg('ARK-2026-001', { status: 'revoked' });
    expect(svg).toContain('#dc2626');
  });

  it('includes accessibility role and aria-label', () => {
    const svg = generateBadgeSvg('ARK-2026-001');
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="Arkova Verified"');
  });

  it('includes title element', () => {
    const svg = generateBadgeSvg('ARK-2026-001');
    expect(svg).toContain('<title>Arkova Verification Badge</title>');
  });

  it('respects custom width', () => {
    const svg = generateBadgeSvg('ARK-2026-001', { width: 200 });
    expect(svg).toContain('width="200"');
  });

  it('does not embed a hostile public ID into SVG IDs or URL references', () => {
    const hostileId = 'ARK-1"><script>alert(1)</script>#';
    const svg = generateBadgeSvg(hostileId);
    expect(svg).not.toContain(hostileId);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('id="bg-ARK-1___script_alert_1___script__"');
    expect(svg).toContain('fill="url(#bg-ARK-1___script_alert_1___script__)"');
  });
});

describe('toBadgeStatus', () => {
  it('maps SECURED to verified', () => {
    expect(toBadgeStatus('SECURED')).toBe('verified');
  });

  it('maps ACTIVE to verified', () => {
    expect(toBadgeStatus('ACTIVE')).toBe('verified');
  });

  it('maps REVOKED to revoked', () => {
    expect(toBadgeStatus('REVOKED')).toBe('revoked');
  });

  it('maps EXPIRED to expired', () => {
    expect(toBadgeStatus('EXPIRED')).toBe('expired');
  });

  it('maps PENDING to pending instead of verified', () => {
    expect(toBadgeStatus('PENDING')).toBe('pending');
  });

  it('maps SUBMITTED to submitted instead of verified', () => {
    expect(toBadgeStatus('SUBMITTED')).toBe('submitted');
  });

  it('maps SUPERSEDED to superseded', () => {
    expect(toBadgeStatus('SUPERSEDED')).toBe('superseded');
  });

  it('fails closed for unknown status', () => {
    expect(toBadgeStatus('unexpected')).toBe('unavailable');
  });
});

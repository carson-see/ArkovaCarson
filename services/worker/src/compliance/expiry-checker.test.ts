/**
 * Expiry Checker Tests (NCE-09)
 */

import { describe, it, expect } from 'vitest';
import { categorizeExpiringDocuments, type ExpiryAnchor } from './expiry-checker.js';

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

const makeAnchor = (overrides: Partial<ExpiryAnchor> = {}): ExpiryAnchor => ({
  id: 'a1',
  org_id: 'org-1',
  credential_type: 'LICENSE',
  title: 'CPA License',
  expiry_date: daysFromNow(15),
  ...overrides,
});

describe('categorizeExpiringDocuments', () => {
  it('categorizes documents into correct urgency windows', () => {
    const anchors: ExpiryAnchor[] = [
      makeAnchor({ id: 'a1', expiry_date: daysFromNow(5) }),   // 7-day window
      makeAnchor({ id: 'a2', expiry_date: daysFromNow(20) }),  // 30-day window
      makeAnchor({ id: 'a3', expiry_date: daysFromNow(45) }),  // 60-day window
      makeAnchor({ id: 'a4', expiry_date: daysFromNow(75) }),  // 90-day window
    ];

    const result = categorizeExpiringDocuments(anchors);
    expect(result.get('7_day')!).toHaveLength(1);
    expect(result.get('30_day')!).toHaveLength(1);
    expect(result.get('60_day')!).toHaveLength(1);
    expect(result.get('90_day')!).toHaveLength(1);
  });

  it('returns empty map for no expiring documents', () => {
    const result = categorizeExpiringDocuments([]);
    expect(result.size).toBe(4);
    for (const [, anchors] of result) {
      expect(anchors).toHaveLength(0);
    }
  });

  it('ignores already-expired documents', () => {
    const anchors: ExpiryAnchor[] = [
      makeAnchor({ id: 'a1', expiry_date: daysFromNow(-5) }),
    ];
    const result = categorizeExpiringDocuments(anchors);
    for (const [, ancs] of result) {
      expect(ancs).toHaveLength(0);
    }
  });

  it('categorizes boundary values correctly', () => {
    const anchors: ExpiryAnchor[] = [
      makeAnchor({ id: 'a1', expiry_date: daysFromNow(7) }),
      makeAnchor({ id: 'a2', expiry_date: daysFromNow(30) }),
      makeAnchor({ id: 'a3', expiry_date: daysFromNow(60) }),
      makeAnchor({ id: 'a4', expiry_date: daysFromNow(90) }),
    ];
    const result = categorizeExpiringDocuments(anchors);
    // 7 is within 7-day window
    expect(result.get('7_day')!).toHaveLength(1);
    expect(result.get('30_day')!).toHaveLength(1);
    expect(result.get('60_day')!).toHaveLength(1);
    expect(result.get('90_day')!).toHaveLength(1);
  });

  it('groups by org_id', () => {
    const anchors: ExpiryAnchor[] = [
      makeAnchor({ id: 'a1', org_id: 'org-1', expiry_date: daysFromNow(5) }),
      makeAnchor({ id: 'a2', org_id: 'org-1', expiry_date: daysFromNow(3) }),
      makeAnchor({ id: 'a3', org_id: 'org-2', expiry_date: daysFromNow(6) }),
    ];
    const result = categorizeExpiringDocuments(anchors);
    expect(result.get('7_day')!).toHaveLength(3);
  });
});

import { describe, expect, it } from 'vitest';
import { getOrganizationFoundedDisplay } from './organizationDates';

describe('getOrganizationFoundedDisplay', () => {
  it('formats the configured founded_date instead of the account creation date', () => {
    expect(getOrganizationFoundedDisplay({
      founded_date: '2012-03-15',
      created_at: '2026-05-01T12:00:00Z',
    })).toBe('March 2012');
  });

  it('keeps date-only first-of-month founded dates in their configured month', () => {
    expect(getOrganizationFoundedDisplay({
      founded_date: '2012-03-01',
      created_at: '2026-05-01T12:00:00Z',
    })).toBe('March 2012');
  });

  it('does not invent a founded date from created_at when founded_date is missing', () => {
    expect(getOrganizationFoundedDisplay({
      founded_date: null,
      created_at: '2026-05-01T12:00:00Z',
    })).toBeNull();
  });
});
